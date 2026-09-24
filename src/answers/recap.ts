import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { errorCode, invariant, record } from '../errors.ts';
import { ArtifactStore } from './artifact-store.ts';

export interface RecapContent {
  summary: string; completed: string[]; pending: string[]; blockers: string[]; constraints: string[];
  options: { label: string; meaning: string }[]; questions: string[];
}
export interface RecapModel {
  summarize(input: { query: string; text: string; stage: 'map' | 'reduce'; outcome: string;
    audit?: { callId: string; requestId: string; answerId: string; recapId: string; sourceSha256: string; attempt: number } }, signal?: AbortSignal): Promise<unknown>;
}
export interface AnswerRecap {
  recap_id: string; answer_id: string; source_sha256: string; source: 'verbatim-short' | 'llm-recap';
  state: 'pending' | 'ready' | 'failed'; short_text: string | null; structured_json: string | null;
  failure_code: string | null; source_ranges_json: string;
}
export interface RecapAttempt { ordinal: number; startedAt: number; completedAt?: number; state: 'pending' | 'ready' | 'failed'; failureCode?: string; modelCallIds?: string[] }
export const codepoints = (text: string): number => Array.from(text).length;
export function validateRecap(value: unknown, maxChars: number): { content: RecapContent; shortText: string } {
  const o = record(value), keys = ['summary', 'completed', 'pending', 'blockers', 'constraints', 'options', 'questions'];
  invariant(Object.keys(o).length === keys.length && Object.keys(o).every(key => keys.includes(key)), 'RECAP_SCHEMA');
  invariant(typeof o.summary === 'string', 'RECAP_SCHEMA');
  const list = (value: unknown): string[] => { invariant(Array.isArray(value) && value.every(x => typeof x === 'string'), 'RECAP_SCHEMA'); return value as string[]; };
  const content: RecapContent = { summary: o.summary, completed: list(o.completed), pending: list(o.pending), blockers: list(o.blockers), constraints: list(o.constraints), questions: list(o.questions), options: [] };
  invariant(Array.isArray(o.options), 'RECAP_SCHEMA');
  content.options = o.options.map(value => {
    const option = record(value); invariant(Object.keys(option).length === 2 && typeof option.label === 'string' && typeof option.meaning === 'string', 'RECAP_SCHEMA');
    return { label: option.label, meaning: option.meaning };
  });
  // One canonical visible string; no second copy of the structured fields in projections.
  const shortText = [content.summary, ...content.completed.map(x => `完成: ${x}`), ...content.pending.map(x => `未完成: ${x}`),
    ...content.blockers.map(x => `阻塞: ${x}`), ...content.constraints.map(x => `限制: ${x}`),
    ...content.options.map(x => `${x.label}: ${x.meaning}`), ...content.questions.map(x => `问题: ${x}`)].filter(Boolean).join('\n');
  invariant(codepoints(shortText) <= maxChars && shortText.length > 0, 'RECAP_BUDGET');
  return { content, shortText };
}
export function utf8Windows(bytes: Buffer, limit: number): Array<{ start: number; end: number; text: string }> {
  invariant(Number.isSafeInteger(limit) && limit >= 4, 'RECAP_WINDOW');
  const windows = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    windows.push({ start, end, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end)) }); start = end;
  }
  return windows;
}

/** Recap work has no business executor or delivery dependency and cannot replay either. */
export class RecapService {
  constructor(private store: Store, private artifacts: ArtifactStore, private model: RecapModel | undefined,
    private modelDigest: string, private shortMaxChars = 1200, private recapMaxChars = 1000) {}
  async run(answerId: string, scope: string, signal?: AbortSignal): Promise<AnswerRecap> {
    const answer = this.artifacts.get(answerId);
    invariant(answer.state === 'ready' && answer.sha256, 'ANSWER_NOT_READY');
    const query = this.store.db.prepare('SELECT raw_query,phase FROM orchestration_requests WHERE request_id=? AND conversation_scope=?').get(answer.request_id, scope) as { raw_query: string; phase: string } | undefined;
    invariant(query, 'ANSWER_RAW_ACCESS_DENIED');
    const bytes = await this.artifacts.read(answerId, { role: 'recap', requestId: answer.request_id, scope }), raw = bytes.toString('utf8');
    const short = codepoints(raw) <= this.shortMaxChars, source = short ? 'verbatim-short' : 'llm-recap', promptVersion = 'recap-v1';
    const existing = this.store.db.prepare('SELECT * FROM answer_recaps WHERE answer_id=? AND source_sha256=? AND prompt_version=? AND model_profile_digest=?')
      .get(answerId, answer.sha256, promptVersion, this.modelDigest) as AnswerRecap | undefined;
    if (existing?.state === 'ready') return existing;
    invariant(existing?.state !== 'pending', 'RECAP_IN_PROGRESS');
    const id = existing?.recap_id ?? randomUUID();
    const attemptKey = 'recap-attempts:' + id, recordedAttempts = this.store.value<RecapAttempt[]>(attemptKey), attempts = recordedAttempts ?? [];
    if (existing && recordedAttempts === undefined || attempts.length >= 3) {
      invariant(existing?.state === 'failed', 'RECAP_RETRY_STATE');
      this.store.db.prepare("UPDATE answer_recaps SET failure_code=? WHERE recap_id=? AND state='failed'")
        .run(recordedAttempts === undefined ? 'RECAP_ATTEMPTS_UNVERIFIED' : 'RECAP_RETRY_LIMIT', id);
      return this.store.db.prepare('SELECT * FROM answer_recaps WHERE recap_id=?').get(id) as unknown as AnswerRecap;
    }
    const attempt: RecapAttempt = { ordinal: attempts.length + 1, startedAt: Date.now(), state: 'pending', modelCallIds: [] };
    this.store.atomic(() => {
      this.store.db.prepare(`INSERT INTO answer_recaps(recap_id,answer_id,source_sha256,source,model_profile_digest,prompt_version,version,state,created_at)
      VALUES (?,?,?,?,?,?,1,'pending',?) ON CONFLICT(answer_id,source_sha256,prompt_version,model_profile_digest)
      DO UPDATE SET state='pending',failure_code=NULL,completed_at=NULL`).run(id, answerId, answer.sha256, source, this.modelDigest, promptVersion, Date.now());
      this.store.put(attemptKey, [...attempts, attempt]);
    });
    try {
      let shortText = raw, structured: RecapContent | null = null;
      const ranges = utf8Windows(bytes, 16384).map(({ start, end }) => ({ start, end }));
      if (!short) {
        const outcome = answer.job_task_id ? this.store.get(answer.job_task_id).status : query.phase;
        let calls = 0;
        const summarize = async (text: string, stage: 'map' | 'reduce') => {
          invariant(!signal?.aborted, 'RECAP_CANCELLED'); invariant(++calls <= 2048, 'RECAP_CALL_LIMIT');
          invariant(this.model, 'RECAP_MODEL_UNAVAILABLE');
          const callId = randomUUID(); attempt.modelCallIds!.push(callId); this.store.put(attemptKey, [...attempts, attempt]);
          return validateRecap(await this.model.summarize({ query: query.raw_query, text, stage, outcome,
            audit: { callId, requestId: answer.request_id, answerId, recapId: id, sourceSha256: answer.sha256!, attempt: attempt.ordinal } }, signal), this.recapMaxChars);
        };
        let summaries = [];
        for (const window of utf8Windows(bytes, 16384)) summaries.push(await summarize(window.text, 'map'));
        while (summaries.length > 1) {
          const next = [];
          for (let i = 0; i < summaries.length; i += 4) next.push(await summarize(JSON.stringify(summaries.slice(i, i + 4).map(s => s.content)), 'reduce'));
          summaries = next;
        }
        invariant(summaries[0], 'RECAP_EMPTY');
        shortText = summaries[0].shortText; structured = summaries[0].content;
      }
      this.artifacts.writeRecap(answerId, { answerId, answerSha256: answer.sha256, source, modelProfileDigest: this.modelDigest,
        promptVersion, shortText, content: structured, sourceRanges: ranges });
      attempt.state = 'ready'; attempt.completedAt = Date.now();
      this.store.atomic(() => {
        this.store.db.prepare("UPDATE answer_recaps SET state='ready',short_text=?,structured_json=?,source_ranges_json=?,completed_at=? WHERE recap_id=? AND state='pending'")
          .run(shortText, structured ? JSON.stringify(structured) : null, JSON.stringify(ranges), attempt.completedAt!, id);
        this.store.put(attemptKey, [...attempts, attempt]);
      });
    } catch (e) {
      attempt.state = 'failed'; attempt.failureCode = errorCode(e, 'RECAP_FAILED'); attempt.completedAt = Date.now();
      this.store.atomic(() => {
        this.store.db.prepare("UPDATE answer_recaps SET state='failed',failure_code=?,completed_at=? WHERE recap_id=? AND state='pending'")
          .run(attempt.failureCode!, attempt.completedAt!, id);
        this.store.put(attemptKey, [...attempts, attempt]);
      });
    }
    return this.store.db.prepare('SELECT * FROM answer_recaps WHERE recap_id=?').get(id) as unknown as AnswerRecap;
  }
}
