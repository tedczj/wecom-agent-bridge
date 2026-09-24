import type { Config } from '../../src/config.ts';
import type { Store } from '../../src/store.ts';
import type { Job, NormalizedInput, SessionRef } from '../../src/types.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { NativeCatalog, historyRevision } from '../../src/history/catalog.ts';
import { NativeReader } from '../../src/history/reader.ts';
import { nativeRoot } from '../../src/history/files.ts';
import { readControlled } from '../../src/fsutil.ts';
import { invariant, record } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { isMetadataQuery } from './metadata-query.ts';
import { pathToFileURL } from 'node:url';
import { readCommand } from './read-command.ts';
import { extractCodeCalls, codeSyntaxRejected } from './code-mode-calls.ts';
import { addedFiles, addedFilesMatch, type AddedFile } from './patch-effects.ts';
import path from 'node:path';
import { inside } from '../../src/fsutil.ts';
import { lstatSync, realpathSync } from 'node:fs';
import { commandEffects, type CommandEffects } from './command-effects.ts';
import { inspectFixtureGit, type FixtureGitEvidence } from './fixture-git.ts';
import { inspectFixtureTest } from './fixture-test.ts';
import { inspectFifoScript, type FifoScript } from './fifo-script.ts';

export interface NativeInputAudit {
  nativeRefHash: string; sourceRevision: string; fileSha256: string; noncePresent: boolean; inheritedContext: boolean;
  toolOutputContainsNonce?: boolean;
  runtimeProfile?: { model?: string; reasoning?: string };
  workspace?: { id: string; path: string };
  observedContextWindows?: number[];
  codeCalls?: Array<{ callId: string; turnId?: string; codeSha256: string; parsed: boolean; actions?: Array<{ tool: string; toolSha256: string; argumentsSha256: string }> }>;
  fixtureTests?: Array<{ commandSha256: string; cwdMatches: boolean; completed: boolean; exitCode: unknown; markerSeen: boolean; outputSha256: string }>;
  execution: { toolRecords: number; unclassifiedRecords: number; noToolExecution: boolean; metadataOnlyRecords?: number; noRemoteActions?: boolean;
    readOnlyCommandRecords?: number; readOnlyCommands?: Array<{ callId: string; turnId: string; commandSha256: string; mirrorId: string }>;
    localPatchRecords?: number; localPatches?: Array<{ callId: string; turnId: string; files: AddedFile[]; mirrorId: string }>;
    classifiedActionsComplete?: boolean; localPatchFilesVerified?: boolean;
    scopedCommandRecords?: number; scopedCommands?: Array<{ callId: string; turnId: string; commandSha256: string; mirrorId: string; git: boolean; gitWrites: boolean; localPush: boolean; fixtureTest?: boolean; files?: AddedFile[]; fifoScripts?: FifoScript[] }>;
    fixtureGitVerified?: boolean; fixtureGit?: FixtureGitEvidence; syntaxRejectedRecords?: number;
    fixtureTest?: { scriptSha256: string; packageSha256: string }; localCommandFilesVerified?: boolean;
    fifoScripts?: Array<NonNullable<ReturnType<typeof inspectFifoScript>>> };
  inputs: Array<{ turnId: string; textSha256: string; completed: boolean; imageInput?: { textPartSha256s: string[]; imageSha256s: string[] } }>;
}
/** Only unambiguous direct answers are automated; other phrasing requires semantic review. */
export function nonceAnswerClaim(answer: string): 'denies' | 'claims' | 'uncertain' {
  const text = answer.trim().replace(/[。.!！]$/, '');
  if (['没有', '没有收到', '没有收到过', '未收到', '未收到过'].includes(text)) return 'denies';
  if (['有', '收到', '收到过', '是', '是的'].includes(text)) return 'claims';
  return 'uncertain';
}
/** Synthetic live fixtures only. Persist hashes/state, never transcript prose or reasoning. */
export function inspectContextRecords(text: string, nonce: string, expectedCwd?: string): Omit<NativeInputAudit, 'nativeRefHash' | 'sourceRevision'> {
  const lines = text.split('\n'); invariant(lines.pop() === '', 'LIVE_NATIVE_PARTIAL');
  const inputs: NativeInputAudit['inputs'] = [], completed = new Set<string>();
  const fixtureTests: NonNullable<NativeInputAudit['fixtureTests']> = [];
  const contextWindows = new Set<number>();
  const codeCalls: NonNullable<NativeInputAudit['codeCalls']> = [];
  let active: string | undefined, noncePresent = false, inheritedContext = false, toolRecords = 0, unclassifiedRecords = 0;
  let metadataOnlyRecords = 0, outputIdentityInvalid = false;
  let readOnlyCommandRecords = 0, readonlyPolicy = false;
  let localPatchRecords = 0, workspacePolicy = false;
  const patchCalls = new Map<string, { files: AddedFile[]; turnId: string; mirrorId?: string; invalid?: boolean }>();
  let scopedCommandRecords = 0;
  let syntaxRejectedRecords = 0;
  const syntaxCalls = new Map<string, { turnId: string; source: string }>(), syntaxTurns: string[] = [];
  const scopedCalls = new Map<string, { turnId: string; commands: Array<CommandEffects & { mirrorId?: string }>; invalid?: boolean }>();
  const scopedCommands: NonNullable<NativeInputAudit['execution']['scopedCommands']> = [];
  const localPatches: NonNullable<NativeInputAudit['execution']['localPatches']> = [];
  const readCalls = new Map<string, { command: string; turnId: string; mirrorId?: string; invalid?: boolean }>(), mirrorIds = new Set<string>();
  const readOnlyCommands: NonNullable<NativeInputAudit['execution']['readOnlyCommands']> = [];
  const metadataCalls = new Map<string, string>(), seenCalls = new Set<string>();
  const outputCalls = new Map<string, { turnId: string; suppliedNonce: boolean; outputType: string }>(), outputIds = new Set<string>(), usedOutputIds = new Set<string>(), outputTurns: string[] = [];
  const contains = (value: unknown): boolean => typeof value === 'string' ? value.includes(nonce) : Array.isArray(value) ? value.some(contains)
    : value !== null && typeof value === 'object' ? Object.values(value).some(contains) : false;
  for (const [index, line] of lines.entries()) {
    const row = record(JSON.parse(line)), payload = record(row.payload ?? {});
    if (index === 0) {
      invariant(row.type === 'session_meta', 'LIVE_NATIVE_HEADER');
      inheritedContext ||= !!payload.forked_from_id || !!payload.forked_from_thread_id;
    }
    noncePresent ||= contains(row);
    if (row.type === 'response_item' && payload.type === 'custom_tool_call' && payload.name === 'exec' && typeof payload.call_id === 'string' && typeof payload.input === 'string') {
      const calls = extractCodeCalls(payload.input);
      codeCalls.push({ callId: payload.call_id, turnId: active, codeSha256: sha256(payload.input), parsed: calls !== undefined,
        actions: calls?.map(call => ({ tool: ['exec_command', 'apply_patch', 'write_stdin'].includes(call.tool) ? call.tool : 'unknown',
          toolSha256: sha256(call.tool), argumentsSha256: sha256(JSON.stringify(call.arguments)) })) });
    }
    if (row.type === 'turn_context') {
      const permission = payload.permission_profile as Record<string, unknown> | undefined, filesystem = permission?.file_system as Record<string, unknown> | undefined;
      const entries = filesystem?.entries;
      readonlyPolicy = !!expectedCwd && payload.cwd === expectedCwd && (payload.sandbox_policy as Record<string, unknown> | undefined)?.type === 'read-only' &&
        permission?.type === 'managed' && permission.network === 'restricted' && filesystem?.type === 'restricted' && Array.isArray(entries) && entries.length > 0 &&
        entries.every(value => value !== null && typeof value === 'object' && ['read', 'deny'].includes(String((value as Record<string, unknown>).access)));
      workspacePolicy = !!expectedCwd && payload.cwd === expectedCwd && permission?.type === 'managed' && permission.network === 'restricted' &&
        filesystem?.type === 'restricted' && Array.isArray(entries) && entries.some(value => {
          const row = value as Record<string, unknown>, location = row?.path as Record<string, unknown> | undefined;
          return row?.access === 'write' && location?.type === 'path' && location.path === expectedCwd;
        }) && entries.every(value => {
          if (!value || typeof value !== 'object') return false;
          const row = value as Record<string, unknown>, location = row.path as Record<string, unknown> | undefined;
          if (['read', 'deny'].includes(String(row.access))) return true;
          if (row.access !== 'write' || !location) return false;
          return location.type === 'path' && typeof location.path === 'string' && path.isAbsolute(location.path) && inside(expectedCwd!, location.path) ||
            location.type === 'special' && ['slash_tmp', 'tmpdir'].includes(String((location.value as Record<string, unknown> | undefined)?.kind));
        });
    }
    if (row.type === 'event_msg' && payload.type === 'token_count') {
      const window = record(payload.info ?? {}).model_context_window;
      if (typeof window === 'number' && Number.isSafeInteger(window) && window > 0) contextWindows.add(window);
    }
    if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(String(payload.type)) && typeof payload.call_id === 'string') {
      if (outputIds.has(payload.call_id)) outputIdentityInvalid = true;
      outputIds.add(payload.call_id);
      const input = payload.type === 'function_call' ? payload.arguments : payload.input;
      if (active && typeof input === 'string') outputCalls.set(payload.call_id, { turnId: active, suppliedNonce: contains(input), outputType: payload.type + '_output' });
    }
    if (row.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(String(payload.type)) && typeof payload.call_id === 'string') {
      if (usedOutputIds.has(payload.call_id)) outputIdentityInvalid = true;
      usedOutputIds.add(payload.call_id);
      const call = outputCalls.get(payload.call_id);
      if (active && call?.turnId === active && call.outputType === payload.type && !call.suppliedNonce && contains(payload.output)) outputTurns.push(active);
      outputCalls.delete(payload.call_id);
    }
    inheritedContext ||= row.type === 'compacted' || row.type === 'event_msg' && payload.type === 'context_compacted';
    // Only the closed README grammar with matching native policy and execution is classified.
    if (row.type === 'response_item') {
      if (payload.type === 'custom_tool_call' && typeof payload.call_id === 'string') {
        if (seenCalls.has(payload.call_id)) unclassifiedRecords++;
        else if (active && payload.name === 'exec' && typeof payload.input === 'string' && isMetadataQuery(payload.input)) metadataCalls.set(payload.call_id, active);
        else if (active && readonlyPolicy && payload.name === 'exec' && typeof payload.input === 'string') {
          const command = readCommand(payload.input, expectedCwd); if (command) readCalls.set(payload.call_id, { command, turnId: active });
        } else if (active && workspacePolicy && expectedCwd && payload.name === 'exec' && typeof payload.input === 'string') {
          const calls = extractCodeCalls(payload.input);
          if (calls?.length === 1 && calls[0]!.tool === 'apply_patch' && typeof calls[0]!.arguments === 'string') {
            const files = addedFiles(calls[0]!.arguments, expectedCwd); if (files) patchCalls.set(payload.call_id, { files, turnId: active });
          }
        }
        if (active && (readonlyPolicy || workspacePolicy) && expectedCwd && !metadataCalls.has(payload.call_id) && !readCalls.has(payload.call_id) &&
          !patchCalls.has(payload.call_id) && payload.name === 'exec' && typeof payload.input === 'string') {
          const calls = extractCodeCalls(payload.input);
          const commands = calls?.map(call => call.tool === 'exec_command' ? commandEffects(call.arguments, expectedCwd) : undefined);
          if (commands?.length && commands.every((command): command is CommandEffects => !!command && ((!command.gitWrites && !command.files?.length && !command.fifoScripts?.length) || workspacePolicy)))
            scopedCalls.set(payload.call_id, { turnId: active, commands });
        }
        if (active && payload.name === 'exec' && typeof payload.input === 'string') syntaxCalls.set(payload.call_id, { turnId: active, source: payload.input });
        seenCalls.add(payload.call_id);
      } else if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string' && metadataCalls.get(payload.call_id) === active && active) {
        metadataOnlyRecords += 2; metadataCalls.delete(payload.call_id);
      }
      if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
        const syntax = syntaxCalls.get(payload.call_id);
        if (active && syntax?.turnId === active && codeSyntaxRejected(syntax.source, payload.output)) { syntaxRejectedRecords += 2; syntaxTurns.push(active); }
        syntaxCalls.delete(payload.call_id);
        const call = readCalls.get(payload.call_id);
        if (active && readonlyPolicy && call?.turnId === active && call.mirrorId && !call.invalid) {
          readOnlyCommandRecords += 2; readOnlyCommands.push({ callId: payload.call_id, turnId: active, commandSha256: sha256(call.command), mirrorId: call.mirrorId });
        }
        readCalls.delete(payload.call_id);
        const patch = patchCalls.get(payload.call_id);
        if (active && workspacePolicy && patch?.turnId === active && patch.mirrorId && !patch.invalid) {
          localPatchRecords += 2; localPatches.push({ callId: payload.call_id, turnId: active, files: patch.files, mirrorId: patch.mirrorId });
        }
        patchCalls.delete(payload.call_id);
        const scoped = scopedCalls.get(payload.call_id);
        if (active && (readonlyPolicy || workspacePolicy) && scoped?.turnId === active && !scoped.invalid && scoped.commands.every(command => !!command.mirrorId)) {
          scopedCommandRecords += 2;
          scopedCommands.push(...scoped.commands.map(command => ({ callId: payload.call_id as string, turnId: active!, commandSha256: sha256(command.command),
            mirrorId: command.mirrorId!, git: command.git, gitWrites: command.gitWrites, localPush: command.localPush,
            ...(command.fixtureTest ? { fixtureTest: true } : {}), ...(command.files ? { files: command.files } : {}), ...(command.fifoScripts ? { fifoScripts: command.fifoScripts } : {}) })));
        }
        scopedCalls.delete(payload.call_id);
      }
      if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call'].includes(String(payload.type))) toolRecords++;
      else if (!['message', 'reasoning'].includes(String(payload.type))) unclassifiedRecords++;
    } else if (row.type === 'event_msg') {
      if (payload.type === 'item_completed') {
        const item = record(payload.item);
        let classifiedRead = false;
        let classifiedPatch = false;
        let classifiedScoped = false;
        if (item.type === 'FileChange' && active && workspacePolicy && patchCalls.size === 1) {
          const patch = [...patchCalls.values()][0]!;
          if (patch.turnId === active && !patch.mirrorId && typeof item.id === 'string' && !mirrorIds.has(item.id) && item.status === 'completed' && addedFilesMatch(patch.files, item.changes)) {
            patch.mirrorId = item.id; mirrorIds.add(item.id); classifiedPatch = true;
          } else patch.invalid = true;
        }
        if (item.type === 'CommandExecution' && active && readonlyPolicy && readCalls.size === 1) {
          const call = [...readCalls.values()][0]!;
          if (call.turnId === active && !call.mirrorId && typeof item.id === 'string' && !mirrorIds.has(item.id) &&
            JSON.stringify(item.command) === JSON.stringify(['/bin/zsh', '-lc', call.command]) && item.cwd === pathToFileURL(expectedCwd!).href &&
            item.status === 'completed' && item.exit_code === 0) {
            call.mirrorId = item.id; mirrorIds.add(item.id); classifiedRead = true;
          } else call.invalid = true;
        }
        if (!classifiedRead && item.type === 'CommandExecution' && active && (readonlyPolicy || workspacePolicy) && typeof item.id === 'string' &&
          !mirrorIds.has(item.id) && item.cwd === pathToFileURL(expectedCwd!).href && ['completed', 'failed'].includes(String(item.status)) && Number.isInteger(item.exit_code)) {
          const matches = [...scopedCalls.values()].filter(call => call.turnId === active).flatMap(call => call.commands.filter(command => !command.mirrorId &&
            JSON.stringify(item.command) === JSON.stringify(['/bin/zsh', '-lc', command.command])));
          if (matches.length === 1) { matches[0]!.mirrorId = item.id; mirrorIds.add(item.id); classifiedScoped = true; }
        }
        if (item.type === 'CommandExecution' && Array.isArray(item.command) && item.command.length === 3 && item.command[0] === '/bin/zsh' && item.command[1] === '-lc' &&
          ['npm test', 'node --test', 'node --test fixture.test.cjs'].includes(String(item.command[2]))) {
          const stdout = typeof item.stdout === 'string' ? item.stdout : '';
          fixtureTests.push({ commandSha256: sha256(JSON.stringify(item.command)), cwdMatches: !!expectedCwd && item.cwd === pathToFileURL(expectedCwd).href,
            completed: item.status === 'completed', exitCode: item.exit_code, outputSha256: sha256(stdout),
            markerSeen: stdout.split(/\r?\n/).some(line => line === 'TEST_RUN_' + nonce || line === '# TEST_RUN_' + nonce) });
        }
        if (!classifiedRead && !classifiedPatch && !classifiedScoped && !['UserMessage', 'AgentMessage', 'Reasoning'].includes(String(item.type))) unclassifiedRecords++;
      } else if (!['task_started', 'turn_started', 'task_complete', 'turn_complete', 'user_message', 'turn_aborted', 'error',
        'thread_settings_applied', 'token_count', 'agent_reasoning', 'agent_message', 'warning', 'agent_reasoning_raw_content',
        'agent_reasoning_section_break'].includes(String(payload.type))) unclassifiedRecords++;
    } else if (!['session_meta', 'world_state', 'turn_context', 'token_usage_record'].includes(String(row.type))) unclassifiedRecords++;
    if (active && row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      invariant(Array.isArray(payload.content), 'LIVE_NATIVE_INPUT');
      const parts = payload.content.map(record).filter(part => ['text', 'input_text', 'output_text'].includes(String(part.type)));
      invariant(parts.every(part => typeof part.text === 'string'), 'LIVE_NATIVE_INPUT');
      const images = payload.content.map(record).filter(part => part.type === 'input_image');
      const imageSha256s = images.map(part => {
        invariant(typeof part.image_url === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url), 'LIVE_NATIVE_IMAGE');
        return sha256(Buffer.from(part.image_url.slice(part.image_url.indexOf(',') + 1), 'base64'));
      });
      // Context/automation can also use role=user; matching the stored request hash,
      // not prose heuristics, identifies the specific input being checked.
      if (parts.length) inputs.push({ turnId: active, textSha256: sha256(parts.map(part => part.text).join('\n')), completed: false,
        ...(images.length ? { imageInput: { textPartSha256s: parts.map(part => sha256(part.text as string)), imageSha256s } } : {}) });
    }
    if (row.type !== 'event_msg') continue;
    if (payload.type === 'task_started' || payload.type === 'turn_started') {
      invariant(typeof payload.turn_id === 'string' && !active, 'LIVE_NATIVE_TURN_ORDER'); active = payload.turn_id; readonlyPolicy = false; workspacePolicy = false;
    } else if (payload.type === 'user_message') {
      invariant(active && typeof payload.message === 'string', 'LIVE_NATIVE_INPUT');
      inputs.push({ turnId: active, textSha256: sha256(payload.message), completed: false });
    } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
      invariant(active && payload.turn_id === active, 'LIVE_NATIVE_TURN_ORDER'); completed.add(active); active = undefined;
    } else if (payload.type === 'turn_aborted' || payload.type === 'error') active = undefined;
  }
  invariant(!active, 'LIVE_NATIVE_NOT_IDLE');
  const classifiedActionsComplete = completed.size > 0 && !inheritedContext && !outputIdentityInvalid && toolRecords === metadataOnlyRecords + readOnlyCommandRecords + localPatchRecords + scopedCommandRecords + syntaxRejectedRecords &&
    [...readOnlyCommands, ...localPatches, ...scopedCommands].every(call => completed.has(call.turnId)) && syntaxTurns.every(turn => completed.has(turn)) && unclassifiedRecords === 0;
  return { fileSha256: sha256(text), noncePresent, inheritedContext, fixtureTests, observedContextWindows: [...contextWindows], codeCalls,
    toolOutputContainsNonce: !outputIdentityInvalid && outputTurns.some(turnId => completed.has(turnId)),
    execution: { toolRecords, unclassifiedRecords, metadataOnlyRecords, readOnlyCommandRecords, readOnlyCommands, localPatchRecords, localPatches, classifiedActionsComplete,
      scopedCommandRecords, scopedCommands, syntaxRejectedRecords,
      noToolExecution: completed.size > 0 && !inheritedContext && toolRecords === 0 && unclassifiedRecords === 0,
      noRemoteActions: classifiedActionsComplete && localPatchRecords === 0 && !scopedCommands.some(command => command.git || command.fixtureTest || command.files?.length || command.fifoScripts?.length) },
    inputs: inputs.map(input => ({ ...input, completed: completed.has(input.turnId) })) };
}

export async function nativeContextAudit(store: Store, c: Config, job: Job, nonce: string): Promise<NativeInputAudit> {
  const input = JSON.parse(job.input_json) as NormalizedInput;
  invariant(input.routing && job.status === 'succeeded', 'LIVE_NATIVE_JOB');
  const scope = store.db.prepare('SELECT conversation_scope FROM orchestration_requests WHERE request_id=?').get(job.task_id)!.conversation_scope as string;
  const target = new Catalog(c).target(input.routing.directory, input.routing.execution);
  invariant(target.digest === input.routing.digest && target.config.backend === 'codex', 'LIVE_NATIVE_PROFILE');
  const ref = JSON.parse(store.session(job.session_key).agent_ref_json!) as SessionRef;
  const candidate = await new NativeCatalog(store, scope).locateExact(target, ref);
  const evidence = await new NativeReader().inspect(target, candidate);
  invariant(!evidence.incomplete && !evidence.unknownEvents && evidence.activity === 'idle', 'LIVE_NATIVE_UNVERIFIED');
  const bytes = await readControlled(nativeRoot(target), candidate.file, 4 * 1024 * 1024);
  const audit = inspectContextRecords(new TextDecoder('utf-8', { fatal: true }).decode(bytes), nonce, target.directory.path);
  await verifyPhysicalNativeEffects(audit, c, target.directory.path);
  invariant(historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
  return { nativeRefHash: sha256(JSON.stringify(ref)), sourceRevision: candidate.sourceRevision, ...audit,
    runtimeProfile: { model: evidence.model, reasoning: evidence.reasoning }, workspace: { id: target.directory.id, path: target.directory.path } };
}

/** Verify physical fixture facts after parsing; shared by live capture and read-only reevaluation. */
export async function verifyPhysicalNativeEffects(audit: Pick<NativeInputAudit, 'execution'>, c: Config, cwd: string): Promise<void> {
  const commandFiles = audit.execution.scopedCommands?.flatMap(command => command.files ?? []) ?? [];
  if (audit.execution.localPatchRecords || commandFiles.length) {
    let verified = true;
    for (const file of [...audit.execution.localPatches!.flatMap(patch => patch.files), ...commandFiles]) {
      try {
        const stat = lstatSync(file.path);
        invariant(stat.isFile() && !stat.isSymbolicLink() && realpathSync(file.path) === file.path, 'LIVE_PATCH_PATH');
        invariant(sha256(await readControlled(cwd, file.path, 524288)) === file.contentSha256, 'LIVE_PATCH_BYTES');
      } catch { verified = false; }
    }
    if (audit.execution.localPatchRecords) audit.execution.localPatchFilesVerified = verified;
    if (commandFiles.length) audit.execution.localCommandFilesVerified = verified;
  }
  if (audit.execution.scopedCommands?.some(command => command.git)) {
    audit.execution.fixtureGit = inspectFixtureGit(c, cwd, audit.execution.scopedCommands.some(command => command.localPush));
    audit.execution.fixtureGitVerified = !!audit.execution.fixtureGit;
  }
  if (audit.execution.scopedCommands?.some(command => command.fixtureTest)) audit.execution.fixtureTest = inspectFixtureTest(cwd);
  const scripts = [...new Set(audit.execution.scopedCommands?.flatMap(command => command.fifoScripts ?? []) ?? [])];
  audit.execution.fifoScripts = scripts.flatMap(name => { const inspected = inspectFifoScript(cwd, name); return inspected ? [inspected] : []; });
  audit.execution.noRemoteActions = audit.execution.classifiedActionsComplete === true &&
    (!audit.execution.localPatchRecords || audit.execution.localPatchFilesVerified === true) &&
    (!commandFiles.length || audit.execution.localCommandFilesVerified === true) &&
    (!audit.execution.scopedCommands?.some(command => command.git) || audit.execution.fixtureGitVerified === true) &&
    (!audit.execution.scopedCommands?.some(command => command.fixtureTest) || !!audit.execution.fixtureTest) && audit.execution.fifoScripts.length === scripts.length;
}
