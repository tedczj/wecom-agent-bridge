import type { Store } from '../store.ts';

/** Derived query/visible-recap index. Raw artifacts and result_text never enter it. */
export function ensureInteractionSearch(store: Store): void {
  if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='interaction_search'").get()) return;
  store.atomic(() => {
    store.db.exec(`CREATE VIEW IF NOT EXISTS interaction_search_projection AS
      SELECT r.ingress_seq rowid,r.request_id,r.raw_query query,
        CASE WHEN json_extract(r.route_snapshot_json,'$.controlKind')='result-delivery' THEN ''
          WHEN a.state='ready' THEN a.short_text ELSE '' END short_text
      FROM interaction_records i JOIN orchestration_requests r ON r.request_id=i.request_id
      LEFT JOIN answer_recaps a ON a.recap_id=i.recap_id AND a.answer_id=i.answer_id;
      CREATE VIRTUAL TABLE interaction_search USING fts5(query,short_text,tokenize='trigram');`);
    const refresh = (rows: string) => `DELETE FROM interaction_search WHERE rowid IN (${rows});
      INSERT INTO interaction_search(rowid,query,short_text) SELECT rowid,query,short_text FROM interaction_search_projection WHERE rowid IN (${rows});`;
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = event === 'DELETE' ? 'OLD' : 'NEW';
      store.db.exec(`CREATE TRIGGER IF NOT EXISTS interaction_search_interaction_${event.toLowerCase()} AFTER ${event} ON interaction_records BEGIN
        ${refresh(`SELECT ingress_seq FROM orchestration_requests WHERE request_id=${ref}.request_id`)} END;
        CREATE TRIGGER IF NOT EXISTS interaction_search_recap_${event.toLowerCase()} AFTER ${event} ON answer_recaps BEGIN
        ${refresh(`SELECT r.ingress_seq FROM orchestration_requests r JOIN interaction_records i ON i.request_id=r.request_id WHERE i.recap_id=${ref}.recap_id`)} END;`);
    }
    store.db.exec(`CREATE TRIGGER IF NOT EXISTS interaction_search_request_update AFTER UPDATE OF raw_query,route_snapshot_json ON orchestration_requests BEGIN
      ${refresh('SELECT NEW.ingress_seq')} END;
      CREATE TRIGGER IF NOT EXISTS interaction_search_request_delete AFTER DELETE ON orchestration_requests BEGIN
      DELETE FROM interaction_search WHERE rowid=OLD.ingress_seq; END;
      INSERT INTO interaction_search(rowid,query,short_text) SELECT rowid,query,short_text FROM interaction_search_projection;`);
  });
}
