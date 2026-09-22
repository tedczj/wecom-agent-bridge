import { existsSync,lstatSync,readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { Job } from './types.ts';
import type { Store } from './store.ts';
import { invariant } from './errors.ts';

export interface Maintenance {
  action:'update'|'restart'; phase:'approval'|'requested'|'running'|'starting'|'succeeded'|'failed';
  taskId:string; requestTaskId:string; route:string; at:number;
  supervisorToken:string; oldHead?:string; newHead?:string; code?:string;
}
export const maintenanceActive=(m?:Maintenance)=>!!m && ['requested','running','starting'].includes(m.phase);
export function supervised(c:Config):boolean {
  const file=path.join(c.stateRoot,'supervisor','instance.lock');
  if(!process.env.BRIDGE_SUPERVISOR_TOKEN || !existsSync(file) || lstatSync(file).isSymbolicLink())return false;
  const lock=JSON.parse(readFileSync(file,'utf8'));
  return lock.pid===process.ppid && lock.token===process.env.BRIDGE_SUPERVISOR_TOKEN;
}
export function proposeMaintenance(c:Config,store:Store,job:Job,action:'update'|'restart'):string {
  invariant(supervised(c),'SUPERVISOR_REQUIRED');
  const old=store.value<Maintenance>('maintenance');
  invariant(!maintenanceActive(old) && !(old?.phase==='approval' && Date.now()-old.at<900000),'MAINTENANCE_BUSY');
  const m:Maintenance={action,phase:'approval',taskId:job.task_id,requestTaskId:job.task_id,route:job.route_json,at:Date.now(),supervisorToken:process.env.BRIDGE_SUPERVISOR_TOKEN!};
  store.put('maintenance',m);
  const installation=JSON.parse(readFileSync(path.join(c.stateRoot,'supervisor','instance.lock'),'utf8')).root;
  return `桥接安装目录：${installation}\n${action==='update'?'将更新当前桥接安装：仅从 origin/dev 快进拉取，安装依赖并运行检查，通过后重启。跟踪文件有改动或无法快进时拒绝更新。':'将重启当前桥接服务，保留会话、登录和消息记录。'}\n确认后停止接收新工作，等待已接收任务完成；恢复后在此对话报告结果。\n请在下一条消息回复 /approve 确认，其他回复取消（15 分钟有效）。`;
}
export function approveMaintenance(c:Config,store:Store,job:Job):string {
  invariant(supervised(c),'SUPERVISOR_REQUIRED');
  const m=store.value<Maintenance>('maintenance');invariant(m?.phase==='approval','NO_PENDING_APPROVAL');
  invariant(m.route===job.route_json,'APPROVAL_OWNER_MISMATCH');
  invariant(Date.now()-m.at<900000 && m.supervisorToken===process.env.BRIDGE_SUPERVISOR_TOKEN,'APPROVAL_EXPIRED');
  invariant(store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND purpose='control' AND state='sent'").get(m.requestTaskId) &&
    !store.db.prepare("SELECT 1 FROM outbox WHERE task_id=? AND purpose='control' AND state!='sent'").get(m.requestTaskId),'APPROVAL_NOT_DELIVERED');
  store.put('maintenance',{...m,phase:'requested',taskId:job.task_id});
  return `已确认${m.action==='update'?'更新':'重启'}。等待当前任务结束；恢复后将发送执行结果。`;
}
