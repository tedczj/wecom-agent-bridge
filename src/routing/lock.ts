import os from 'node:os';
import path from 'node:path';
import { existsSync, realpathSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateDirectory, processAlive } from '../fsutil.ts';
import { invariant } from '../errors.ts';
import { hash } from './config.ts';
import { physical } from './catalog.ts';
function location(workspace: string,identity?:string): string {
  return path.join(realpathSync(os.tmpdir()),`local-agent-bridge-locks-${process.getuid?.() ?? 'user'}`,hash(identity??physical(workspace))+'.json');
}
export function workspaceLock(workspace: string,stateRoot: string): () => void {
  const file=location(workspace),token=randomUUID(); privateDirectory(path.dirname(file));
  try { writeFileSync(file,JSON.stringify({pid:process.pid,token,stateRoot}),{flag:'wx',mode:0o600}); }
  catch { invariant(false,'WORKSPACE_LOCKED'); }
  return ()=>{invariant(!lstatSync(file).isSymbolicLink(),'UNSAFE_LOCK');if(JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file);};
}
export function reviewWorkspaceLock(workspace: string,stateRoot: string,identity?:string): void {
  const file=location(workspace,identity); if(!existsSync(file))return;
  invariant(!lstatSync(file).isSymbolicLink(),'UNSAFE_LOCK');const data=JSON.parse(readFileSync(file,'utf8'));
  // The owning bridge must have stopped; review also checks the persisted agent marker.
  if(data.stateRoot!==stateRoot)return;
  invariant(Number.isSafeInteger(data.pid) && !processAlive(data.pid),'WORKSPACE_LOCK_REVIEW_REQUIRED');
  unlinkSync(file);
}
