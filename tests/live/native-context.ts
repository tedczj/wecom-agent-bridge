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
import { pathToFileURL } from 'node:url';

export interface NativeInputAudit {
  nativeRefHash: string; sourceRevision: string; fileSha256: string; noncePresent: boolean; inheritedContext: boolean;
  toolOutputContainsNonce?: boolean;
  runtimeProfile?: { model?: string; reasoning?: string };
  workspace?: { id: string; path: string };
  observedContextWindows?: number[];
  fixtureTests?: Array<{ commandSha256: string; cwdMatches: boolean; completed: boolean; exitCode: unknown; markerSeen: boolean; outputSha256: string }>;
  execution: { toolRecords: number; unclassifiedRecords: number; noToolExecution: boolean };
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
  let active: string | undefined, noncePresent = false, inheritedContext = false, toolRecords = 0, unclassifiedRecords = 0;
  let outputIdentityInvalid = false;
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
    if (row.type === 'response_item') {
      if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'local_shell_call', 'web_search_call'].includes(String(payload.type))) toolRecords++;
      else if (!['message', 'reasoning'].includes(String(payload.type))) unclassifiedRecords++;
    } else if (row.type === 'event_msg') {
      if (payload.type === 'item_completed') {
        const item = record(payload.item);
        if (item.type === 'CommandExecution' && Array.isArray(item.command) && item.command.length === 3 && item.command[0] === '/bin/zsh' && item.command[1] === '-lc' &&
          ['npm test', 'node --test', 'node --test fixture.test.cjs'].includes(String(item.command[2]))) {
          const stdout = typeof item.stdout === 'string' ? item.stdout : '';
          fixtureTests.push({ commandSha256: sha256(JSON.stringify(item.command)), cwdMatches: !!expectedCwd && item.cwd === pathToFileURL(expectedCwd).href,
            completed: item.status === 'completed', exitCode: item.exit_code, outputSha256: sha256(stdout),
            markerSeen: stdout.split(/\r?\n/).some(line => line === 'TEST_RUN_' + nonce || line === '# TEST_RUN_' + nonce) });
        }
        if (!['UserMessage', 'AgentMessage', 'Reasoning'].includes(String(item.type))) unclassifiedRecords++;
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
      invariant(typeof payload.turn_id === 'string' && !active, 'LIVE_NATIVE_TURN_ORDER'); active = payload.turn_id;
    } else if (payload.type === 'user_message') {
      invariant(active && typeof payload.message === 'string', 'LIVE_NATIVE_INPUT');
      inputs.push({ turnId: active, textSha256: sha256(payload.message), completed: false });
    } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
      invariant(active && payload.turn_id === active, 'LIVE_NATIVE_TURN_ORDER'); completed.add(active); active = undefined;
    } else if (payload.type === 'turn_aborted' || payload.type === 'error') active = undefined;
  }
  invariant(!active, 'LIVE_NATIVE_NOT_IDLE');
  return { fileSha256: sha256(text), noncePresent, inheritedContext, fixtureTests, observedContextWindows: [...contextWindows],
    toolOutputContainsNonce: !outputIdentityInvalid && outputTurns.some(turnId => completed.has(turnId)),
    execution: { toolRecords, unclassifiedRecords,
      noToolExecution: completed.size > 0 && !inheritedContext && toolRecords === 0 && unclassifiedRecords === 0 },
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
  invariant(historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
  return { nativeRefHash: sha256(JSON.stringify(ref)), sourceRevision: candidate.sourceRevision, ...audit,
    runtimeProfile: { model: evidence.model, reasoning: evidence.reasoning }, workspace: { id: target.directory.id, path: target.directory.path } };
}
