import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { setup, FakeChannel } from './helpers.ts';
import { parseConfig } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { initializeHierarchy } from '../src/orchestration/schema.ts';
import { ControllerManager } from '../src/controllers/manager.ts';
import type { ControllerRuntime, ControllerRef, ControllerToolHandler, ControllerTurn } from '../src/controllers/runtime.ts';
import { BusinessSessions } from '../src/orchestration/business-sessions.ts';
import { NativeReader } from '../src/history/reader.ts';
import { ResumeVerifier } from '../src/history/verifier.ts';
import { ArtifactStore } from '../src/answers/artifact-store.ts';
import { RecapService } from '../src/answers/recap.ts';
import { MediaStore } from '../src/media.ts';
import { HierarchicalBridge } from '../src/orchestration/engine.ts';
import { OutboxPump } from '../src/reply.ts';
import type { AgentBackend, ImageRef, NormalizedInput, SessionRef } from '../src/types.ts';
import type { TestContext } from 'node:test';

export async function harness(t: TestContext, directoryModel?: Partial<ReturnType<typeof setup>['c']['codex']>,
  beforeStart?: (state: { store: Store; c: ReturnType<typeof parseConfig>; artifacts: ArtifactStore; controllers: ControllerManager; sessions: BusinessSessions }) => Promise<void>) {
  const f = setup(t), second = path.join(f.root, 'second'); mkdirSync(second);
  const example = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/config.hierarchical.example.json', 'utf8'));
  example.orchestration.controllerRuntime.workRoot = path.join(f.c.stateRoot, 'controllers'); example.orchestration.answers.root = path.join(f.c.stateRoot, 'artifacts');
  const c = parseConfig({ ...f.c, codex: { ...f.c.codex, model: 'gpt-6-sol', reasoning: 'high' },
    models: { daily: { model: 'gpt-6-sol', reasoning: 'high', contextWindowTokens: 1000000 }, alternate: { model: 'gpt-6-sol', reasoning: 'low', contextWindowTokens: 1000000 } }, orchestration: example.orchestration,
    routing: { roots: [{ id: 'all', path: f.root, profile: 'read' }], profiles: [{ id: 'read', version: '1', codex: directoryModel }], workspaces: [
      { id: 'test', path: f.workspace, profile: 'read', aliases: ['A', 'term4u'] }, { id: 'second', path: second, profile: 'read', aliases: ['B'] }], history: true } });
  const store = new Store(path.join(c.stateRoot, 'bridge.sqlite'), c); initializeHierarchy(store); f.cleanups.push(() => store.close());
  const controllerInputs: Array<{ role: string; ref: string; text: string; images: readonly ImageRef[] }> = [], parents: unknown[] = [], searches: unknown[] = [];
  class ControllerDouble implements ControllerRuntime {
    ref!: ControllerRef; instructions = ''; turn = 0;
    constructor(private role: 'bridge' | 'route') {}
    async create(generation: number, instructions: string) { this.instructions = instructions; return this.ref = { threadId: randomUUID(), generation }; }
    async resume(ref: ControllerRef, instructions: string) { this.ref = ref; this.instructions = instructions; }
    async run(ref: ControllerRef, text: string, handler: ControllerToolHandler, _signal?: AbortSignal, images: readonly ImageRef[] = []): Promise<ControllerTurn> {
      let answer = 'READY';
      if (!text.startsWith('Initialize this management')) {
        controllerInputs.push({ role: this.role, ref: ref.threadId, text, images });
        if (this.role === 'bridge') {
          const directories = await handler('list_directories', {}, 'list') as { activeWorkspace?: string; forcedDirectoryRef?: string };
          if (text.startsWith('search ')) {
            const [, directoryRef, ...words] = text.split(' ');
            searches.push(await handler('search_interactions', { directoryRef, query: words.join(' ') }, 'search')); answer = 'search completed';
          } else if (text.startsWith('outside ') && !directories.forcedDirectoryRef) {
            await handler('propose_directory', { path: text.slice('outside '.length) }, 'propose'); answer = 'internal approval planning';
          } else if (text === 'ambiguous work' && !directories.forcedDirectoryRef) {
            await handler('clarify_directory', { question: '选 A 还是 B？', option1: 'test', option2: 'second' }, 'clarify'); answer = '选 A 还是 B？';
          } else {
            const selected = directories.forcedDirectoryRef ?? (text.includes('B') ? 'second' : text.includes('A') ? 'test' : directories.activeWorkspace ?? 'test');
            const result = await handler('route_delegate', { directoryRef: selected, intentKind: (text.includes('history') || text.includes('在干啥') || text.includes('续查')) ? 'history_query' : text.includes('switch') ? 'switch' : 'work' }, 'delegate'); parents.push(result);
            answer = 'Bridge must not replace the business original';
          }
        } else if (text.includes('pure switch')) { answer = 'UNVERIFIED: prior business session restored';
        } else if (text.includes('metadata-only work')) { answer = 'UNEXECUTED_PROJECT_NAME';
        } else if ((text.includes('history') || text.includes('在干啥') || text.includes('续查'))) {
          if (text.includes('host-intent')) {
            const options = await handler('resolve_business_options', {}, 'options') as { delegationIntent: string };
            assert.equal(options.delegationIntent, 'history_query');
          }
          await handler('list_interactions', { scope: 'directory' }, 'history'); answer = 'Route read-only history result';
        } else {
          const override = text.includes('alternate') ? { modelProfile: 'alternate', ...(text.includes('persist') ? { persistence: 'session' } : {}) } : {};
          const options = await handler('resolve_business_options', override, 'options') as { options: Array<{ isDefault: boolean; optionToken: string }> };
          const selected = await handler('select_business_session', { optionToken: options.options.find(option => option.isDefault)!.optionToken }, 'select') as { selectionToken: string };
          if (text.includes('duplicate tools')) await Promise.all([
            handler('business_execute', { selectionToken: selected.selectionToken }, 'execute-1'),
            handler('business_execute', { selectionToken: selected.selectionToken }, 'execute-2'),
          ]);
          else await handler('business_execute', { selectionToken: selected.selectionToken }, 'execute');
          answer = 'Route must not replace business original';
        }
      }
      const turnId = 'turn-' + ++this.turn;
      return { turnId, text: answer, usage: { threadId: ref.threadId, turnId, usedTokens: 100, contextWindowTokens: 1000000,
        origin: 'runtime', basis: 'last-completed-request-total', observedAt: Date.now(), validForGeneration: ref.generation } };
    }
    getUsage() { return undefined; }
    async interrupt() {}
    async close() {}
  }
  const managementModels: string[] = [];
  const controllers = new ControllerManager(store, async (actor, model) => { managementModels.push(model.model + '/' + model.reasoning); return new ControllerDouble(actor.role); }, 'management-home', () => {});
  const sessions = new BusinessSessions(store, controllers.registry, new ResumeVerifier(new NativeReader(), { check: async () => 'idle' }));
  const artifacts = new ArtifactStore(store, c.orchestration!.answers.root), media = new MediaStore(c), channel = new FakeChannel();
  const recaps = new RecapService(store, artifacts, { summarize: async () => ({ summary: 'short record', completed: [], pending: [], blockers: [], constraints: [], options: [], questions: [] }) }, 'recap-profile');
  const calls: NormalizedInput[] = [], refs: Array<SessionRef | undefined> = [], memory = new Map<string, string[]>();
  let waitForCancel = false, active = 0, maxActive = 0;
  const backend = (config: typeof c): AgentBackend => ({
    async start() {}, async stop() {},
    async run(input, saved, hooks, signal) {
      calls.push(input); refs.push(saved); active++; maxActive = Math.max(maxActive, active);
      hooks.promptSubmitted?.({ textSha256: createHash('sha256').update(input.text).digest('hex'), attachmentHashes: input.images.map(image => image.sha256) });
      const ref: SessionRef = saved ?? { kind: 'codex', threadId: randomUUID() }; assert.equal(ref.kind, 'codex');
      await hooks.persistSession(ref); const id = (ref as { threadId: string }).threadId;
      const root = path.join(config.codex.home, 'sessions'); mkdirSync(root, { recursive: true }); const file = path.join(root, id + '.jsonl');
      if (!saved) writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: config.workspace.path } }) + '\n');
      appendFileSync(file, JSON.stringify({ type: 'turn_context', payload: { cwd: config.workspace.path, model: config.codex.model, effort: config.codex.reasoning } }) + '\n');
      appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }) + '\n');
      try {
        if (waitForCancel) {
          waitForCancel = false;
          await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
          appendFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'turn_aborted' } }) + '\n');
          return { outcome: 'cancelled', finalText: 'offline backend stopped', sessionRef: ref };
        }
        const history = memory.get(id) ?? []; history.push(input.text); memory.set(id, history);
        const finalText = input.text.trim() === '继续' ? 'continued:' + history[0] : '  business original\r\n' + input.text;
        hooks.captureFinal?.(finalText);
        appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', last_agent_message: finalText } }) + '\n');
        return { outcome: 'success', finalText, sessionRef: ref, finishEvidence: { backend: 'codex', threadStarted: true, turnStarted: true, turnCompleted: true, exitCode: 0, cleanupConfirmed: true } };
      } finally { active--; }
    },
  });
  const bridge = new HierarchicalBridge(c, 'local:codex', store, channel, media, { controllers, sessions, artifacts, recaps, backend });
  await beforeStart?.({ store, c, artifacts, controllers, sessions });
  await bridge.start(); f.cleanups.push(() => bridge.stop());
  const pump = new OutboxPump(store, channel, c.reply);
  const settle = async () => { await bridge.idle(); while (await pump.tick()) await pump.idle(); };
  return { ...f, c, second, store, bridge, media, artifacts, channel, controllerInputs, parents, searches, calls, refs, settle, managementModels,
    waitForCancel: () => { waitForCancel = true; }, maxActive: () => maxActive };
}
