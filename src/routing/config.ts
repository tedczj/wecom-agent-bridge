import path from 'node:path';
import { createHash } from 'node:crypto';
import { invariant, record } from '../errors.ts';
import type { Config } from '../config.ts';
export interface RoutingConfig {
  roots: Array<{id: string; path: string; profile?: string}>;
  profiles: Array<{id: string; version: string; backend?: 'codex' | 'pi'; agent?: Partial<Config['agent']>; codex?: Partial<Config['codex']>}>;
  workspaces: Array<{id: string; path: string; profile: string; aliases: string[]; description: string}>;
  history: boolean;
  fallbackWorkspace?: string;
}
export function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function obj(value: unknown, keys: string[]) { const o = record(value); invariant(Object.keys(o).every(k => keys.includes(k)), 'ROUTING_CONFIG_KEY'); return o; }
function string(value: unknown): string { invariant(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'), 'ROUTING_CONFIG_STRING'); return value; }
function id(value: unknown): string { const s = string(value); invariant(/^[a-zA-Z0-9_-]{1,64}$/.test(s), 'ROUTING_CONFIG_ID'); return s; }
function absolute(value: unknown): string { const s = string(value); invariant(path.isAbsolute(s), 'ROUTING_CONFIG_PATH'); return path.resolve(s); }
function array(value: unknown): unknown[] { invariant(Array.isArray(value) && value.length <= 100, 'ROUTING_CONFIG_LIST'); return value; }
export function parseRouting(value: unknown): RoutingConfig {
  invariant(!Object.hasOwn(record(value), 'interpreter'), 'ROUTING_INTERPRETER_REMOVED');
  const o = obj(value, ['roots','profiles','workspaces','history','fallbackWorkspace']);
  const roots = array(o.roots).map(v => { const r = obj(v,['id','path','profile']); return {id:id(r.id),path:absolute(r.path),profile:r.profile === undefined ? undefined : id(r.profile)}; });
  const profiles = array(o.profiles).map(v => { const r = obj(v,['id','version','backend','agent','codex']); invariant(r.backend === undefined || r.backend === 'codex' || r.backend === 'pi','BACKEND_NOT_IMPLEMENTED'); return {id:id(r.id),version:string(r.version),backend:r.backend as Config['backend'] | undefined,agent:r.agent as Partial<Config['agent']> | undefined,codex:r.codex as Partial<Config['codex']> | undefined}; });
  const workspaces = array(o.workspaces).map(v => { const r = obj(v,['id','path','profile','aliases','description']); return {id:id(r.id),path:absolute(r.path),profile:id(r.profile),aliases:array(r.aliases ?? []).map(string),description:r.description === undefined || r.description === '' ? '' : string(r.description)}; });
  for (const values of [roots,profiles,workspaces]) invariant(new Set(values.map(x => x.id)).size === values.length,'ROUTING_DUPLICATE_ID');
  invariant(roots.length && profiles.length && workspaces.length,'ROUTING_CONFIG_EMPTY');
  for (const w of [...roots,...workspaces]) if (w.profile) invariant(profiles.some(p => p.id === w.profile),'ROUTING_PROFILE_MISSING');
  invariant(o.history === undefined || typeof o.history === 'boolean','CONFIG_BOOLEAN');
  const fallbackWorkspace = o.fallbackWorkspace === undefined ? undefined : id(o.fallbackWorkspace);
  invariant(fallbackWorkspace === undefined || workspaces.some(w => w.id === fallbackWorkspace), 'ROUTING_FALLBACK_MISSING');
  return {roots,profiles,workspaces,history:o.history !== false,...(fallbackWorkspace === undefined ? {} : {fallbackWorkspace})};
}
