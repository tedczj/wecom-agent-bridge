#!/usr/bin/env node
// OFFLINE deterministic controller protocol double, never a model or capability proof.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread = randomUUID(), turn, tools = [], window = 828400, step = '', calls = 0;
const event = (method, params) => send({ method, params });
const savedFile = () => path.join(process.env.CODEX_HOME, 'offline-controller-' + thread + '.json');
const finish = (text = 'offline delegated') => {
  writeFileSync(savedFile(), JSON.stringify({tools,turn,window}));
  event('thread/tokenUsage/updated', { threadId: thread, turnId: turn, tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: window } });
  event('item/completed', { threadId: thread, turnId: turn, item: { type: 'agentMessage', phase: 'final_answer', text } });
  event('turn/completed', { threadId: thread, turn: { id: turn, status: 'completed', error: null } });
};
const tool = (name, args) => { step = name; send({ id: 'tool-' + ++calls, method: 'item/tool/call', params: { threadId: thread, turnId: turn, callId: 'call-' + calls, tool: name, arguments: args } }); };
for await (const line of createInterface({ input: process.stdin })) {
  const f = JSON.parse(line);
  if (String(f.id).startsWith('tool-')) {
    if (f.error) { finish('offline error: ' + f.error.message); continue; }
    const result = JSON.parse(f.result.contentItems[0].text);
    if (step === 'list_directories') tool('route_delegate', { directoryRef: result.forcedDirectoryRef ?? result.activeWorkspace ?? result.directories[0].directoryRef, intentKind: 'work' });
    else if (step === 'resolve_business_options') tool('select_business_session', { optionToken: result.options.find(o => o.isDefault).optionToken });
    else if (step === 'select_business_session') tool('business_execute', { selectionToken: result.selectionToken });
    else finish();
    continue;
  }
  if (!f.id) continue;
  let result = {};
  if (f.method === 'config/read') result = { config: {} };
  else if (f.method === 'thread/turns/list') result = {data:[{id:turn,status:'completed'}]};
  else if (f.method === 'thread/start' || f.method === 'thread/resume') {
    thread = f.params.threadId ?? thread;
    if (f.method === 'thread/resume') ({tools,turn,window} = JSON.parse(readFileSync(savedFile())));
    tools = f.params.dynamicTools ?? tools;
    window = f.params.config.model_context_window ?? window;
    result = { thread: { id: thread }, model: f.params.model, modelProvider: 'offline-double', reasoningEffort: f.params.config.model_reasoning_effort, instructionSources: [] };
  } else if (f.method === 'turn/start') {
    turn = randomUUID(); event('turn/started', { threadId: thread, turn: { id: turn } });
    send({ id: f.id, result: { turn: { id: turn } } });
    event('warning', { threadId: thread, message: 'BRIDGE_CONTROLLER_POLICY_V1:' + JSON.stringify({ version: 1, turnId: turn, dynamicToolsOnly: true, nativeAutoCompaction: 'disabled', tools: tools.map(t => ({ type: 'function', name: t.name, parameters: (() => { const schema = structuredClone(t.inputSchema); for (const field of Object.values(schema.properties ?? {})) { delete field.maxLength; delete field.minimum; delete field.maximum; } return schema; })() })) }) });
    const text = f.params.input.find(i => i.type === 'text').text;
    if (text.startsWith('Initialize this management')) finish('READY');
    else if (tools.some(t => t.name === 'route_delegate')) tool('list_directories', {});
    else if (tools.some(t => t.name === 'business_execute')) tool('resolve_business_options', {});
    else finish(JSON.stringify({ summary: 'Offline summary', completed: [], pending: [], blockers: [], constraints: [], options: [], questions: [] }));
    continue;
  } else if (f.method === 'turn/interrupt') { send({ id: f.id, result: {} }); event('turn/completed', { threadId: thread, turn: { id: turn, status: 'interrupted' } }); continue; }
  send({ id: f.id, result });
}
