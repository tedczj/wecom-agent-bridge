import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import { invariant, record } from '../errors.ts';

export interface Execution {
  backend?: 'codex' | 'pi';
  model?: string;
  reasoning?: NonNullable<Config['codex']['reasoning']>;
}
export function validateExecution(value: unknown): Execution {
  const o=Object.fromEntries(Object.entries(record(value)).filter(([,v])=>v!==null));
  invariant(Object.keys(o).every(k=>['backend','model','reasoning'].includes(k)),'EXECUTION_SCHEMA');
  invariant(o.backend===undefined || ['codex','pi'].includes(String(o.backend)),'EXECUTION_BACKEND');
  invariant(o.model===undefined || typeof o.model==='string' && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,127}$/.test(o.model),'EXECUTION_MODEL');
  invariant(o.reasoning===undefined || ['minimal','low','medium','high','xhigh'].includes(String(o.reasoning)),'EXECUTION_REASONING');
  return o as Execution;
}
export function availableModels(c: Config): string[] {
  const models=new Set<string>(c.codex.model?[c.codex.model]:[]);
  const file=path.join(c.codex.home,'models_cache.json');
  try {
    if(existsSync(file) && statSync(file).size<=2*1024*1024) {
      const cache=JSON.parse(readFileSync(file,'utf8'));
      for(const m of cache.models??[])if(typeof m.slug==='string')models.add(m.slug);
    }
  } catch { /* A cache is advisory; the backend remains authoritative. */ }
  return [...models];
}
export function resolveModel(request: string,c: Config): string {
  const models=availableModels(c),norm=(s:string)=>s.toLowerCase().replace(/[\s_-]/g,'');
  const exact=models.filter(m=>norm(m)===norm(request));
  const matches=exact.length?exact:models.filter(m=>norm(m).endsWith(norm(request)));
  invariant(matches.length<=1,'MODEL_AMBIGUOUS');
  if(matches[0])return matches[0];
  // Without a local catalog, only an exact CLI model ID can be submitted. Never guess an alias.
  invariant(!models.length && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(request),'MODEL_NOT_FOUND');
  return request;
}
export function executable(c: Config): void {
  try { accessSync(c.agent.command,constants.X_OK); } catch { invariant(false,'BACKEND_UNAVAILABLE'); }
}
export function executionLabel(c: Config,execution?:Execution): string {
  return `${c.workspace.path}\nAgent：${c.backend}；模型：${c.backend==='codex'?c.codex.model??'后端默认':execution?.model??'后端配置'}；推理：${c.backend==='codex'?c.codex.reasoning??'后端默认':execution?.reasoning??'后端配置'}`;
}
