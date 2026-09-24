import type { Store } from '../store.ts';
import type { Job, NormalizedInput } from '../types.ts';
import { invariant } from '../errors.ts';
import { conversationScope, sha256 } from '../orchestration/requests.ts';
import { schemaV4 } from './v4-schema.ts';
import { ensureInteractionSearch } from '../answers/search-index.ts';

export interface LegacyBinding {
  conversationScope: string; directoryIdentity: string; backendHomeKey: string; profileDigest: string;
}
function markLegacyResults(store: Store): void {
  for (const row of store.db.prepare(`SELECT j.task_id,j.error_code FROM jobs j JOIN orchestration_requests r ON r.job_task_id=j.task_id
    WHERE r.hash_version='legacy-v3' AND j.result_text IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM routing_state s WHERE s.key='legacy-result:'||j.task_id)`).iterate()) {
    store.put('legacy-result:' + row.task_id, { completeness: row.error_code === 'OUTPUT_TRUNCATED' ? 'legacy-truncated' : 'unknown',
      retainedIn: 'jobs.result_text', originalArchived: false });
  }
}
/** Explicit maintenance operation; caller must hold the service lock and a consistent backup. */
export function migrateV4(store: Store, resolveBinding?: (baseKey: string, sessionKey: string) => LegacyBinding): { requests: number; bindings: number } {
  return store.atomic(() => {
    const version = (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version === 4) { ensureInteractionSearch(store); markLegacyResults(store); return { requests: 0, bindings: 0 }; }
    invariant(version === 3, 'MIGRATION_SOURCE_VERSION');
    invariant(!store.db.prepare("SELECT 1 FROM jobs WHERE status IN ('preparing','queued','running','cancel_requested') LIMIT 1").get(), 'MIGRATION_REQUIRES_DRAIN');
    invariant(!store.db.prepare("SELECT 1 FROM outbox WHERE state='sending' LIMIT 1").get(), 'MIGRATION_DELIVERY_UNCERTAIN');
    const oldBindings = store.db.prepare("SELECT key,value FROM routing_state WHERE key LIKE 'binding:%'").all() as { key: string; value: string }[];
    const bindings = oldBindings.filter(row => JSON.parse(row.value) !== null).map(row => {
      invariant(resolveBinding, 'MIGRATION_BINDING_REVIEW_REQUIRED');
      const sessionKey = JSON.parse(row.value) as string;
      const session = store.session(sessionKey);
      invariant(session.base_key === row.key.slice('binding:'.length), 'MIGRATION_BINDING_MISMATCH');
      const identity = resolveBinding(row.key.slice('binding:'.length), sessionKey);
      invariant(Object.values(identity).every(value => typeof value === 'string' && value.length > 0), 'MIGRATION_BINDING_MISMATCH');
      return { sessionKey, identity };
    });
    store.db.exec(schemaV4);
    let requests = 0;
    // Read input, never the potentially large legacy result_text into a management projection.
    const rows = store.db.prepare('SELECT task_id,channel_id,message_id,request_hash,route_json,input_json,status,created_at FROM jobs ORDER BY seq').iterate();
    for (const value of rows) {
      const job = value as unknown as Job & { request_hash: string };
      const input = JSON.parse(job.input_json) as NormalizedInput;
      const raw = input.originalText ?? input.text;
      const phase = job.status === 'succeeded' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'interrupted' ? 'interrupted' : 'failed';
      store.db.prepare(`INSERT INTO orchestration_requests(request_id,channel_id,message_id,conversation_scope,route_json,raw_query,raw_query_sha256,
        request_hash,hash_version,input_provenance,attachments_json,job_task_id,phase,received_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'legacy-v3','legacy-normalized',?,?,?,?,?)`).run(job.task_id, job.channel_id, job.message_id,
        conversationScope(input.route), job.route_json, raw, sha256(raw), job.request_hash, JSON.stringify(input.images), job.task_id, phase, input.receivedAt, job.created_at);
      requests++;
    }
    for (const { sessionKey, identity } of bindings) store.db.prepare(`INSERT INTO business_bindings(conversation_scope,directory_identity,backend_home_key,
      profile_digest,session_key,selection_source,version,updated_at) VALUES (?,?,?,?,?,'legacy-v3',1,?)`).run(identity.conversationScope,
      identity.directoryIdentity, identity.backendHomeKey, identity.profileDigest, sessionKey, Date.now());
    store.db.exec('PRAGMA user_version=4;');
    ensureInteractionSearch(store);
    markLegacyResults(store);
    return { requests, bindings: bindings.length };
  });
}
