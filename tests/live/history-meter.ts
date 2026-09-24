import { RoleTools } from '../../src/orchestration/tools.ts';
import { invariant, record } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

export interface HistoryObservation {
  role: 'bridge' | 'route'; callId: string; resultSha256: string;
  tool: string; querySha256?: string; directoryRef?: string;
  scope: unknown; limit: unknown; beforeSeq: unknown; foreignCanarySeen: boolean;
  entries: Array<{ requestId: string; ingressSeq: number; directoryIdentity: string | null; answerRef: string | null; kind: string }>;
}
let installed = false;
/** Match explicit synthetic round labels; ambiguous prose is left for review. */
export function directoryAnswerMatches(answer: string, expectedLabels: string[]): boolean {
  if (!answer.includes('term4u') || answer.includes('doc-ocr-service') || /不属于|不是|没有|无关|并非|不包括|未找到|无法/.test(answer)) return false;
  const allLabels = answer.match(/\bR\d{2}\b/g) ?? [], rows = answer.split('\n').filter(line => /^\s*\|\s*R\d{2}\s*\|/.test(line));
  const labels = rows.length ? rows.map(line => line.match(/^\s*\|\s*(R\d{2})\s*\|/)![1]!) : allLabels;
  if (rows.some((line, index) => (line.match(/\bR\d{2}\b/g) ?? []).some(label => label !== labels[index]))) return false;
  if (allLabels.some(label => !expectedLabels.includes(label))) return false;
  return labels.length > 0 && labels.length === new Set(labels).size &&
    JSON.stringify([...labels].sort()) === JSON.stringify([...expectedLabels].sort());
}
/** Observe real host projections without substituting results or retaining prose. */
export function historyMeter(canary: string) {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const original = RoleTools.prototype.call, observations: HistoryObservation[] = []; let stopped = false;
  const observed: typeof original = async function (this: RoleTools, name, args, callId) {
    const result = await original.call(this, name, args, callId);
    if (name === 'list_interactions' || name === 'search_interactions') {
      const parameters = record(args); invariant(Array.isArray(result), 'LIVE_HISTORY_RESULT');
      const serialized = JSON.stringify(result);
      observations.push({ role: this.definitions.some(tool => tool.name === 'route_delegate') ? 'bridge' : 'route', callId,
        tool: name, ...(typeof parameters.query === 'string' ? { querySha256: sha256(parameters.query) } : {}),
        ...(typeof parameters.directoryRef === 'string' ? { directoryRef: parameters.directoryRef } : {}),
        resultSha256: sha256(serialized), scope: parameters.scope, limit: parameters.limit, beforeSeq: parameters.beforeSeq,
        foreignCanarySeen: serialized.includes(canary), entries: result.map(value => {
          const row = record(value); invariant(typeof row.requestId === 'string' && Number.isSafeInteger(row.ingressSeq), 'LIVE_HISTORY_RESULT');
          return { requestId: row.requestId, ingressSeq: row.ingressSeq as number, directoryIdentity: row.directoryIdentity as string | null,
            answerRef: row.answerRef as string | null, kind: row.kind as string };
        }) });
    }
    return result;
  };
  RoleTools.prototype.call = observed;
  return { snapshot: () => structuredClone(observations), stop() {
    if (stopped) return; invariant(RoleTools.prototype.call === observed, 'LIVE_METER_RESTORE_CONFLICT');
    RoleTools.prototype.call = original; installed = false; stopped = true;
  } };
}
