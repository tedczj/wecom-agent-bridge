import type { Store } from '../store.ts';
import { invariant } from '../errors.ts';

export interface InteractionProjection {
  requestId: string; ingressSeq: number; query: string; kind: string; status: string; answerRef: string | null;
  producerRole: 'bridge' | 'route' | 'business' | 'system';
  shortText: string; recapState: string; directoryIdentity: string | null; businessSessionKey: string | null;
}
/** No raw artifact/result_text column is read, even on a failed recap. */
export function listInteractions(store: Store, scope: string, options: { directoryIdentity?: string; limit?: number; beforeSeq?: number; searchQuery?: string } = {}): InteractionProjection[] {
  const limit = options.limit ?? 30;
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 30, 'HISTORY_LIMIT');
  invariant(options.beforeSeq === undefined || Number.isSafeInteger(options.beforeSeq) && options.beforeSeq > 0, 'HISTORY_CURSOR');
  const query = options.searchQuery;
  invariant(query === undefined || query.trim().length > 0 && query.length <= 256 && !query.includes('\0') && Buffer.from(query).toString('utf8') === query, 'HISTORY_QUERY');
  const shortQuery = query !== undefined && Array.from(query).length < 3;
  const search = query === undefined ? '' : shortQuery ?
    'AND EXISTS (SELECT 1 FROM interaction_search s WHERE s.rowid=r.ingress_seq AND (instr(lower(s.query),lower(?))>0 OR instr(lower(s.short_text),lower(?))>0))' :
    'AND r.ingress_seq IN (SELECT rowid FROM interaction_search WHERE interaction_search MATCH ?)';
  const rows = store.db.prepare(`SELECT r.request_id,r.ingress_seq,r.raw_query,r.phase,json_extract(r.route_snapshot_json,'$.controlKind') control_kind,i.kind,i.answer_id,i.directory_identity,
    i.producer_role,i.referenced_business_session_key,a.state recap_state,a.short_text FROM interaction_records i
    JOIN orchestration_requests r ON r.request_id=i.request_id LEFT JOIN answer_recaps a ON a.recap_id=i.recap_id AND a.answer_id=i.answer_id
    WHERE i.conversation_scope=? AND r.conversation_scope=? ${options.directoryIdentity ? 'AND i.directory_identity=?' : ''}
    ${options.beforeSeq ? 'AND r.ingress_seq<?' : ''} ${search} ORDER BY r.ingress_seq DESC LIMIT ?`)
    .all(scope, scope, ...(options.directoryIdentity ? [options.directoryIdentity] : []), ...(options.beforeSeq ? [options.beforeSeq] : []),
      ...(query === undefined ? [] : shortQuery ? [query, query] : ['"' + query.replaceAll('"', '""') + '"']), limit) as Array<Record<string, unknown>>;
  return rows.map(row => ({ requestId: row.request_id as string, ingressSeq: row.ingress_seq as number, query: row.raw_query as string,
    kind: row.kind as string, status: row.phase as string, answerRef: row.answer_id as string | null, producerRole: row.producer_role as InteractionProjection['producerRole'],
    shortText: row.control_kind === 'result-delivery' ? '原件片段已按用户要求投递，正文不提供给 Bridge。' : row.recap_state === 'ready' ? row.short_text as string : '摘要暂不可用；业务状态见 status。',
    recapState: row.control_kind === 'result-delivery' ? 'withheld' : row.recap_state as string ?? 'pending', directoryIdentity: row.directory_identity as string | null,
    businessSessionKey: row.referenced_business_session_key as string | null }));
}
