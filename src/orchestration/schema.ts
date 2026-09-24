import type { Store } from '../store.ts';
import { invariant } from '../errors.ts';
import { ensureInteractionSearch } from '../answers/search-index.ts';

/** Create hierarchical tables only in empty state; populated v3 databases are not converted. */
export function initializeHierarchy(store: Store): void {
  store.atomic(() => {
    const version = store.db.prepare('PRAGMA user_version').get()!.user_version;
    if (version !== 4) {
      invariant(version === 3 && !store.db.prepare('SELECT 1 FROM jobs LIMIT 1').get() &&
        !store.db.prepare('SELECT 1 FROM sessions LIMIT 1').get() && !store.db.prepare('SELECT 1 FROM routing_state LIMIT 1').get(),
        'HIERARCHICAL_REQUIRES_EMPTY_STATE');
      store.db.exec(schemaV4);
      store.db.exec('PRAGMA user_version=4;');
    }
    ensureInteractionSearch(store);
  });
}

// Hierarchical schema derived from design 1.0 schema-v4-reference.sql.
const schemaV4 = `
CREATE TABLE IF NOT EXISTS orchestration_requests (
  ingress_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_scope TEXT NOT NULL,
  route_json TEXT NOT NULL CHECK(json_valid(route_json)),
  raw_query TEXT NOT NULL,
  raw_query_sha256 TEXT NOT NULL CHECK(length(raw_query_sha256)=64),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  hash_version TEXT NOT NULL CHECK(hash_version IN ('legacy-v3','raw-v4')),
  input_provenance TEXT NOT NULL CHECK(input_provenance IN ('decoded-original','legacy-normalized')),
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json)),
  source_request_id TEXT REFERENCES orchestration_requests(request_id),
  job_task_id TEXT UNIQUE REFERENCES jobs(task_id),
  phase TEXT NOT NULL CHECK(phase IN ('accepted','media_preparing','bridge_planning','route_planning','awaiting_business','result_processing','completed','failed','cancelled','interrupted')),
  route_snapshot_json TEXT CHECK(route_snapshot_json IS NULL OR json_valid(route_snapshot_json)),
  failure_code TEXT,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(channel_id,message_id)
);
CREATE INDEX IF NOT EXISTS request_scope_seq ON orchestration_requests(conversation_scope,ingress_seq);
CREATE INDEX IF NOT EXISTS request_phase_seq ON orchestration_requests(phase,ingress_seq);

CREATE TABLE IF NOT EXISTS controller_sessions (
  controller_id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL,
  conversation_scope TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('bridge','route')),
  directory_identity TEXT,
  generation INTEGER NOT NULL CHECK(generation>=0),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK(is_current IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('creating','ready','running','rotate_pending','retired','usage_unknown','failed')),
  runtime_kind TEXT NOT NULL,
  native_ref_json TEXT CHECK(native_ref_json IS NULL OR json_valid(native_ref_json)),
  model_profile_digest TEXT NOT NULL,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  handoff_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((role='bridge' AND directory_identity IS NULL) OR (role='route' AND directory_identity IS NOT NULL)),
  CHECK(is_current=0 OR state<>'retired'),
  UNIQUE(logical_key,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_controller ON controller_sessions(logical_key) WHERE is_current=1;

CREATE TABLE IF NOT EXISTS business_bindings (
  conversation_scope TEXT NOT NULL,
  directory_identity TEXT NOT NULL,
  backend_home_key TEXT NOT NULL,
  profile_digest TEXT NOT NULL,
  session_key TEXT NOT NULL REFERENCES sessions(session_key),
  selection_source TEXT NOT NULL,
  selection_request_id TEXT REFERENCES orchestration_requests(request_id),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_scope,directory_identity,backend_home_key,profile_digest)
);

CREATE TABLE IF NOT EXISTS controller_effects (
  effect_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES orchestration_requests(request_id),
  controller_id TEXT NOT NULL REFERENCES controller_sessions(controller_id),
  stage TEXT NOT NULL CHECK(stage IN ('bridge','route')),
  effect_key TEXT NOT NULL,
  arguments_sha256 TEXT NOT NULL CHECK(length(arguments_sha256)=64),
  state TEXT NOT NULL CHECK(state IN ('planned','submitting','submitted','completed','uncertain','failed')),
  job_task_id TEXT REFERENCES jobs(task_id),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(request_id,stage,effect_key)
);
-- result_json for a Bridge effect MUST contain only permitted short metadata, never raw answer.

CREATE TABLE IF NOT EXISTS answer_artifacts (
  answer_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES orchestration_requests(request_id),
  job_task_id TEXT REFERENCES jobs(task_id),
  producer_role TEXT NOT NULL CHECK(producer_role IN ('bridge','route','business','system')),
  business_session_key TEXT REFERENCES sessions(session_key),
  kind TEXT NOT NULL CHECK(kind IN ('final','deliverable','partial')),
  state TEXT NOT NULL CHECK(state IN ('staging','ready','failed')),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','legacy-truncated','unknown')),
  relative_path TEXT NOT NULL,
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
  bytes INTEGER CHECK(bytes IS NULL OR bytes>=0),
  finish_evidence_json TEXT CHECK(finish_evidence_json IS NULL OR json_valid(finish_evidence_json)),
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  CHECK(state<>'ready' OR (sha256 IS NOT NULL AND bytes IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_ready_final ON answer_artifacts(request_id) WHERE kind='final' AND state='ready';

CREATE TABLE IF NOT EXISTS answer_recaps (
  recap_id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL REFERENCES answer_artifacts(answer_id),
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64),
  source TEXT NOT NULL CHECK(source IN ('verbatim-short','llm-recap')),
  model_profile_digest TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('pending','ready','failed')),
  short_text TEXT,
  structured_json TEXT CHECK(structured_json IS NULL OR json_valid(structured_json)),
  source_ranges_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(source_ranges_json)),
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(answer_id,source_sha256,prompt_version,model_profile_digest)
);

CREATE TABLE IF NOT EXISTS interaction_records (
  request_id TEXT PRIMARY KEY REFERENCES orchestration_requests(request_id),
  conversation_scope TEXT NOT NULL,
  directory_identity TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('work','history_query','control','failure')),
  producer_role TEXT NOT NULL CHECK(producer_role IN ('bridge','route','business','system')),
  answer_id TEXT REFERENCES answer_artifacts(answer_id),
  recap_id TEXT REFERENCES answer_recaps(recap_id),
  referenced_business_session_key TEXT REFERENCES sessions(session_key),
  executed_business_session_key TEXT REFERENCES sessions(session_key),
  completed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS interaction_scope_directory ON interaction_records(conversation_scope,directory_identity,completed_at);

CREATE TABLE IF NOT EXISTS native_session_catalog (
  native_ref_key TEXT PRIMARY KEY,
  backend_home_key TEXT NOT NULL,
  backend TEXT NOT NULL,
  native_id TEXT NOT NULL,
  directory_identity TEXT,
  native_ref_json TEXT NOT NULL CHECK(json_valid(native_ref_json)),
  role TEXT NOT NULL CHECK(role IN ('bridge','route','recap','business','external','unknown')),
  source_revision TEXT,
  created_at INTEGER,
  last_completed_at INTEGER,
  last_completed_basis TEXT,
  observed_model_json TEXT CHECK(observed_model_json IS NULL OR json_valid(observed_model_json)),
  verification_state TEXT NOT NULL CHECK(verification_state IN ('metadata-only','verified','partial','invalid','unknown')),
  observed_at INTEGER NOT NULL,
  UNIQUE(backend_home_key,backend,native_id)
);
CREATE INDEX IF NOT EXISTS native_scope_recent ON native_session_catalog(backend_home_key,directory_identity,last_completed_at DESC);
`;
