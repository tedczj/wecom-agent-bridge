#!/usr/bin/env node
// Offline protocol double. It never invokes a model or production backend.
import { createInterface } from 'node:readline';
const mode = process.env.CONTROLLER_FAKE_MODE;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let turns = 0, current, request, tools = [];
const event = (method, params) => send({ method, params });
const finish = () => {
  if (mode !== 'no-usage') event('thread/tokenUsage/updated', { threadId: 'controller-thread', turnId: current,
    tokenUsage: { last: { totalTokens: 71 }, total: { totalTokens: 9000000 }, modelContextWindow: mode === 'wrong-window' ? 950000 : 1000000 } });
  event('item/completed', { threadId: 'controller-thread', turnId: current, item: { type: 'agentMessage', phase: 'final_answer', text: mode === 'empty-delegation' || mode === 'empty-final' ? '' : '  final\r\n' } });
  event('turn/completed', { threadId: 'controller-thread', turn: { id: current, status: 'completed', error: null } });
};
for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.id === 'host-tool-request') {
    if (mode === 'unexpected-tool' && !frame.error) process.exit(20);
    if (mode === 'tool-arguments-error' && (frame.error?.code !== -32602 || frame.error?.message !== 'CONTROLLER_TOOL_ARGUMENTS')) process.exit(21);
    if (mode === 'tool-private-error' && (frame.error?.message !== 'CONTROLLER_TOOL_DENIED' || JSON.stringify(frame).includes('FAKE_SECRET'))) process.exit(22);
    finish(); continue;
  }
  if (!frame.id) continue;
  let result = {};
  if (frame.method === 'config/read') result = { config: {} };
  else if (frame.method === 'thread/turns/list') result = { data: [{ id: current, status: 'completed' }], nextCursor: null };
  else if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
    if (frame.params.dynamicTools) tools = frame.params.dynamicTools;
    result = { thread: { id: 'controller-thread' }, model: frame.params.model, modelProvider: 'offline-double',
      reasoningEffort: frame.params.config.model_reasoning_effort, instructionSources: mode === 'global-instructions' ? [process.env.CONTROLLER_FAKE_INSTRUCTION_SOURCE ?? '/fake/AGENTS.md'] : [] };
  } else if (frame.method === 'turn/start') {
    request = frame.params; current = 'turn-' + ++turns;
    event('turn/started', { threadId: 'controller-thread', turn: { id: current } });
    send({ id: frame.id, result: { turn: { id: current } } });
    if (mode?.startsWith('policy-') && !(mode === 'policy-first-only' && turns > 1)) {
      const visible = tools.map(tool => ({ type: 'function', name: tool.name, parameters: tool.inputSchema }));
      if (mode === 'policy-extra') visible.push({ type: 'function', name: 'exec_command', parameters: {} });
      event('warning', { threadId: 'controller-thread', message: 'BRIDGE_CONTROLLER_POLICY_V1:' + JSON.stringify({ version: 1,
        turnId: mode === 'policy-stale' ? 'old-turn' : current, dynamicToolsOnly: true, nativeAutoCompaction: 'disabled', tools: visible }) });
      if (mode === 'policy-conflict') event('warning', { threadId: 'controller-thread', message: 'BRIDGE_CONTROLLER_POLICY_V1:' + JSON.stringify({ version: 1,
        turnId: current, dynamicToolsOnly: true, nativeAutoCompaction: 'disabled', tools: [...visible, { type: 'function', name: 'exec_command', parameters: {} }] }) });
    }
    if (mode === 'hang') continue;
    if (mode === 'tool' || mode === 'tool-arguments-error' || mode === 'tool-private-error' || mode === 'policy-tool' || mode === 'policy-conflict' || mode === 'empty-delegation' || mode === 'unexpected-tool') send({ id: 'host-tool-request', method: mode !== 'unexpected-tool' ? 'item/tool/call' : 'item/commandExecution/requestApproval',
      params: { threadId: 'controller-thread', turnId: current, callId: 'call', tool: mode === 'empty-delegation' ? 'business_execute' : 'probe_read', arguments: {} } });
    else finish();
    continue;
  } else if (frame.method === 'turn/interrupt') {
    send({ id: frame.id, result: {} });
    event('turn/completed', { threadId: 'controller-thread', turn: { id: current, status: 'interrupted' } }); continue;
  }
  send({ id: frame.id, result });
}
