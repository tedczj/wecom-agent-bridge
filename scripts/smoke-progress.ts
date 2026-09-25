import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { invariant, errorCode } from '../src/errors.ts';
import { privateDirectory } from '../src/fsutil.ts';
import { sha256 } from '../src/orchestration/requests.ts';
import { liveFixture } from '../tests/live/fixture.ts';

/** Real models, synthetic projects and separate state; never sends Weixin messages. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  invariant(args.length === 5 && args[0] === '--live' && args[1] === '--config' && args[3] === '--out', 'LIVE_ARGUMENT');
  const c = loadConfig(args[2]!), root = privateDirectory(path.join(path.resolve(args[4]!), randomUUID()));
  const f = await liveFixture(c, root), store = f.service.store;
  const evidence: Record<string, unknown> = { tier: 'LIVE_LOCAL', status: 'FAIL', models: c.models, weixinTested: false, largeContextTested: false, requests: [] };
  try {
    const send = async (text: string) => {
      const result = await f.service.accept({ id: randomUUID(), session: 'progress', text }); await f.service.settle();
      invariant(result.taskId && !result.rejected, 'PROGRESS_REQUEST_REJECTED');
      const job = store.get(result.taskId), rows = evidence.requests as unknown[];
      rows.push({ requestId: result.taskId, querySha256: sha256(text), status: job.status, errorCode: job.error_code, answerSha256: sha256(job.result_text ?? '') });
      invariant(job.status === 'succeeded', job.error_code ?? 'PROGRESS_REQUEST_FAILED');
      return result.taskId;
    };
    await send('在 term4u 新建一个业务会话。请记住本次合成项目进展：HIGH_PROGRESS_OK，已完成只读启动验证，待办是人工检查。只回复这段进展，不调用工具。');
    const jobs = () => store.db.prepare("SELECT count(*) n FROM jobs WHERE kind='agent'").get()!.n;
    const clocks = () => JSON.stringify(store.db.prepare("SELECT session_key,last_response_at FROM sessions WHERE agent_ref_json IS NOT NULL ORDER BY session_key").all());
    const before = jobs(), beforeClocks = clocks();
    const first = await send('看下 term4u 项目里在干啥');
    const routes = () => store.db.prepare("SELECT controller_id,native_ref_json FROM controller_sessions WHERE role='route' AND is_current=1").all();
    const firstRoutes = JSON.stringify(routes());
    const second = await send('继续查询刚才 term4u 的进展和待办，不执行业务任务。');
    invariant(jobs() === before && before === 1, 'PROGRESS_STARTED_BUSINESS');
    invariant(clocks() === beforeClocks, 'PROGRESS_CHANGED_RESPONSE_CLOCK');
    invariant(routes().length === 1 && JSON.stringify(routes()) === firstRoutes, 'PROGRESS_ROUTE_NOT_REUSED');
    for (const id of [first, second]) {
      const bridge = store.value<{ textSha256: string }>('controller-wire:bridge:' + id), route = store.value<{ textSha256: string }>('controller-wire:route:' + id);
      const original = store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!;
      invariant(bridge?.textSha256 === original.raw_query_sha256 && route?.textSha256 === original.raw_query_sha256, 'PROGRESS_QUERY_REWRITTEN');
      invariant(store.get(id).result_text?.includes('HIGH_PROGRESS_OK'), 'PROGRESS_EVIDENCE_NOT_READ');
    }
    evidence.status = 'PASS'; evidence.businessJobs = before; evidence.routeReused = true; evidence.queriesVerbatim = true; evidence.responseClocksUnchanged = true;
    evidence.controllerSessions = store.db.prepare('SELECT role,generation,state,model_profile_digest,usage_json FROM controller_sessions').all();
  } catch (error) { evidence.error = errorCode(error, 'PROGRESS_SMOKE_FAILED'); process.exitCode = 1; }
  finally {
    try { await f.close(); evidence.cleanupConfirmed = true; } catch { evidence.cleanupConfirmed = false; evidence.status = 'FAIL'; process.exitCode = 1; }
    writeFileSync(path.join(root, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: evidence.status, error: evidence.error, evidence: root }));
  }
}
main().catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
