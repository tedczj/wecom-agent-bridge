import type { Store } from '../../src/store.ts';
import type { ToolAuditRecord } from '../../src/orchestration/audit.ts';
import type { ControllerToolResultAudit, ControllerPolicyWireAudit } from '../../src/controllers/factory.ts';
import type { NativeInputAudit } from './native-context.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { recapExecutionEvidence } from './recap-audit.ts';
import path from 'node:path';
import { verifiedMigrationBaseline, type MigrationBaseline } from './migration-baseline.ts';

const localTools = new Set(['search_interactions', 'list_interactions', 'list_directories', 'search_directories', 'remember_alias', 'propose_directory',
  'clarify_directory', 'route_delegate', 'list_business_models', 'resolve_business_options', 'select_business_session',
  'business_execute', 'list_business_sessions', 'read_business_session', 'read_answer_outline', 'read_answer_range']);
type GitState = Record<string, { head: string; status: string; remotes: string }>;

/** Bounded native-record evidence, not a general OS/network isolation claim. */
export function remoteWriteEvidence(store: Store, requestIds: string[], native: NativeInputAudit[], before: GitState | undefined, after: GitState | undefined, baseline?: MigrationBaseline) {
  const baselineValid = baseline === undefined || verifiedMigrationBaseline(store, baseline) && baseline.jobIds.every(id => !requestIds.includes(id));
  const hostControls = new Set(requestIds.filter(id => {
    const request = store.db.prepare('SELECT raw_query,raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id), job = store.get(id);
    if (job.kind !== 'command' || !['succeeded', 'failed'].includes(job.status) || typeof request?.raw_query !== 'string' || sha256(request.raw_query) !== request.raw_query_sha256 ||
      !/^\/(?:route|alias|new|sessions|find|read|resume|more|result|help|status|debug|cancel)(?:\s|$)/.test(request.raw_query.trim())) return false;
    if (['business-wire:', 'business-prompt-admissions:', 'controller-turn:bridge:', 'controller-turn:route:', 'controller-wire:bridge:', 'controller-wire:route:'].some(key => store.value(key + id)) ||
      (store.value<ToolAuditRecord[]>('tool-audit:' + id) ?? []).length) return false;
    const artifacts = store.db.prepare("SELECT finish_evidence_json FROM answer_artifacts WHERE job_task_id=? AND producer_role='system' AND kind='final' AND state='ready'").all(id);
    if (artifacts.length !== 1 || typeof artifacts[0]!.finish_evidence_json !== 'string') return false;
    const finish = JSON.parse(artifacts[0]!.finish_evidence_json);
    return finish.backend === 'system' && finish.requestId === id && finish.completed === true && finish.outcome === job.status &&
      (job.status === 'succeeded' || finish.phase === 'failed' && finish.errorCode === job.error_code);
  }));
  const refusedBeforeBusiness = new Set(requestIds.filter(id => {
    const job = store.get(id), refusal = store.value<{ code: string; nativeRefSha256: string }>('resume-refusal:' + id);
    if (job.kind !== 'command' || job.status !== 'failed' || store.value('business-wire:' + id) || store.value('business-prompt-admissions:' + id)) return false;
    return hostControls.has(id) || job.error_code === 'HISTORY_SCOPE' && refusal?.code === 'HISTORY_SCOPE' && native.some(row => row.nativeRefHash === refusal.nativeRefSha256);
  }));
  const management = requestIds.flatMap(requestId => {
    if (hostControls.has(requestId)) return [];
    const allAudit = store.value<ToolAuditRecord[]>('tool-audit:' + requestId) ?? [];
    const routeUsed = store.get(requestId).kind === 'agent' || allAudit.some(row => row.role === 'route') ||
      !!store.value('controller-wire:route:' + requestId) || !!store.value('controller-turn:route:' + requestId) || !!store.value('controller-policy-wire:route:' + requestId);
    return (routeUsed ? ['bridge', 'route'] as const : ['bridge'] as const).map(role => {
    const turn = store.value<{ controllerId: string; threadId: string; turnId: string; policyVerified: boolean }>('controller-turn:' + role + ':' + requestId);
    const policy = store.value<ControllerPolicyWireAudit>('controller-policy-wire:' + role + ':' + requestId);
    const audit = allAudit.filter(row => row.role === role);
    const returned = audit.filter(row => row.status === 'returned');
    const policyMatches = !!policy && policy.valid && policy.requestId === requestId && policy.role === role &&
      policy.controllerId === turn?.controllerId && policy.threadId === turn.threadId && policy.turnId === turn.turnId &&
      policy.evidence?.threadId === policy.threadId && policy.evidence.turnId === policy.turnId && policy.evidence.dynamicToolsOnly === true &&
      policy.evidence.nativeAutoCompaction === 'disabled' && policy.evidence.toolNames.every(name => localTools.has(name));
    const wire = store.value<ControllerToolResultAudit[]>('controller-tool-wire:' + role + ':' + requestId) ?? (policyMatches && returned.length === 0 ? [] : undefined);
    const complete = !!turn && !!wire && (audit.length > 0 || policyMatches);
    const pass = complete && turn!.policyVerified && (!policy || policyMatches) && audit.every(row => row.status !== 'started' && row.controllerId === turn!.controllerId && localTools.has(row.tool)) &&
      returned.length === wire!.length && new Set(wire!.map(row => row.callId)).size === wire!.length && returned.every(row => wire!.some(sent =>
        sent.requestId === requestId && sent.role === role && sent.controllerId === row.controllerId && sent.controllerId === turn!.controllerId &&
        sent.threadId === turn!.threadId && sent.turnId === turn!.turnId && sent.callId === row.callId && sent.tool === row.tool && sent.resultSha256 === row.resultSha256));
    return { requestId, role, complete, pass };
    });
  });
  const allJobs = store.db.prepare('SELECT task_id,kind,status FROM jobs').all();
  const jobs = allJobs.filter(row => !baselineValid || !baseline?.jobIds.includes(row.task_id as string));
  const requests = requestIds.map(requestId => {
    const request = store.db.prepare(`SELECT COALESCE(s.raw_query_sha256,r.raw_query_sha256) raw_query_sha256,COALESCE(s.raw_query,r.raw_query) raw_query,
      json_extract(r.route_snapshot_json,'$.controlKind') control_kind
      FROM orchestration_requests r LEFT JOIN orchestration_requests s ON s.request_id=r.source_request_id WHERE r.request_id=?`).get(requestId);
    const hash = request?.raw_query_sha256, job = store.get(requestId);
    const images = (JSON.parse(job.input_json).images as Array<{ sha256: string }>).map(image => image.sha256);
    const ref = store.session(job.session_key).agent_ref_json;
    const recap = store.db.prepare(`SELECT r.source,r.state,r.recap_id,r.source_sha256,a.answer_id FROM answer_recaps r JOIN answer_artifacts a ON a.answer_id=r.answer_id
      WHERE a.request_id=? AND a.kind='final' AND a.state='ready'`).all(requestId);
    const inputObserved = hostControls.has(requestId) || typeof hash === 'string' && (job.kind === 'agent' ? !!ref && native.some(row => row.nativeRefHash === sha256(ref) && row.inputs.some(input => input.completed &&
      (images.length ? input.imageInput?.textPartSha256s.includes(hash) && JSON.stringify(input.imageInput.imageSha256s) === JSON.stringify(images) : input.textSha256 === hash)))
      : typeof request?.raw_query === 'string' && !request.raw_query.trim().startsWith('/') && !store.value('business-wire:' + requestId) &&
        store.value<{ textSha256: string }>('controller-wire:bridge:' + requestId)?.textSha256 === hash);
    const recapModelAbsent = recap.length === 1 && recap[0]!.source === 'verbatim-short' && recap[0]!.state === 'ready';
    const directDelivery = hostControls.has(requestId) && request?.control_kind === 'result-delivery' && recap.length === 0 &&
      !store.db.prepare("SELECT 1 FROM routing_state WHERE key LIKE 'recap-call:%' AND json_extract(value,'$.requestId')=?").get(requestId);
    const recapAudit = recap.length === 1 && recap[0]!.source === 'llm-recap' && recap[0]!.state === 'ready' ?
      recapExecutionEvidence(store, requestId, recap[0]!.recap_id as string, recap[0]!.answer_id as string, recap[0]!.source_sha256 as string) : undefined;
    return { requestId, kind: job.kind, inputObserved, recapModelAbsent, directDelivery, recapAudit,
      recapExecutionVerified: directDelivery || recapModelAbsent || recapAudit?.complete === true && recapAudit.pass };
  });
  const complete = baselineValid && requestIds.length > 0 && new Set(requestIds).size === requestIds.length && (native.length > 0 || !jobs.some(row => row.kind === 'agent')) &&
    native.every(row => row.execution.noToolExecution || row.execution.noRemoteActions === true) && management.every(row => row.complete) && requests.every(row => row.recapExecutionVerified);
  // An effect-free complete trace proves this remote-write predicate without historical Git snapshots.
  // Mutation-capable traces still require actual before/after evidence; supplied mismatches always fail.
  const noMutationActions = native.every(row => (row.execution.noToolExecution || row.execution.noRemoteActions === true) &&
    !row.execution.localPatchRecords && !row.execution.localPatches?.length && !row.execution.scopedCommands?.some(command => command.gitWrites || command.files?.length || command.fifoScripts?.length));
  const gitChangesCovered = before === undefined && after === undefined ? noMutationActions : !!before && !!after && Object.keys(before).length > 0 &&
    JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort()) && Object.entries(before).every(([directory, state]) => {
    const next = after[directory]!;
    const audits = native.filter(row => row.workspace?.id === directory);
    if (state.remotes !== next.remotes) return false;
    if (state.head !== next.head || next.remotes !== '') {
      if (!audits.length || !audits.every(row => row.execution.noRemoteActions && row.execution.fixtureGitVerified &&
        row.execution.fixtureGit?.head === next.head && row.execution.fixtureGit.remotes === next.remotes &&
        (!row.execution.fixtureGit.bare || row.execution.fixtureGit.bare.head === next.head))) return false;
      if (state.head !== next.head && !audits.some(row => row.execution.scopedCommands?.some(command => command.gitWrites))) return false;
    }
    if (state.status === next.status) return true;
    const added = new Set(audits.flatMap(row => [
      ...(row.execution.localPatchFilesVerified ? row.execution.localPatches!.flatMap(patch => patch.files) : []),
      ...(row.execution.localCommandFilesVerified ? row.execution.scopedCommands?.flatMap(command => command.files ?? []) ?? [] : []),
      ...(row.execution.fifoScripts?.flatMap(script => [...script.files, ...script.runnerFiles]) ?? []),
    ].map(file => path.relative(row.workspace!.path, file.path))));
    const oldLines = state.status ? state.status.split('\n') : [], nextLines = next.status ? next.status.split('\n') : [];
    return oldLines.every(line => nextLines.includes(line)) && nextLines.every(line => oldLines.includes(line) || line.startsWith('?? ') && added.has(line.slice(3)));
  });
  const pass = complete && management.every(row => row.pass) && requests.every(row => row.inputObserved) &&
    jobs.length === requestIds.length && jobs.every(row => ['agent', 'command'].includes(String(row.kind)) &&
      (row.status === 'succeeded' || refusedBeforeBusiness.has(row.task_id as string)) && requestIds.includes(row.task_id as string)) &&
    gitChangesCovered;
  return { complete, pass, actual: { basis: 'complete native records and paired bounded commands/patches; physical files and effective fixture Git config/local bare remote; restricted native network policy and management returns or archived host controls; audited recap; Git mutations additionally require original snapshots; not arbitrary-shell or OS-wide side-effect proof',
    management, hostControls: [...hostControls], refusedBeforeBusiness: [...refusedBeforeBusiness], requests, jobs, baseline: baselineValid ? baseline : undefined,
    before, after, gitChangesCovered, gitEvidenceBasis: before === undefined && after === undefined ? 'no mutation-capable native actions' : 'original before/after snapshots', native: native.map(row => ({ nativeRefHash: row.nativeRefHash, sourceRevision: row.sourceRevision,
      fileSha256: row.fileSha256, execution: row.execution })) } };
}
