import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import type { Target } from '../routing/catalog.ts';
import { invariant } from '../errors.ts';
import { NativeCatalog, backendHomeKey, directoryIdentity, type CandidateMetadata } from './catalog.ts';

interface HistoryReference { scope: string; directory: string; home: string; profile: string; expiresAt: number; candidate: CandidateMetadata }
/** A displayed reference survives management turns without becoming an execution grant. */
export class HistoryReferences {
  constructor(private store: Store, private now = Date.now) {}
  async list(scope: string, target: Target, cursor?: string, limit?: number) {
    const page = await new NativeCatalog(this.store, scope).listMetadata(target, cursor, limit);
    return { ...page, entries: page.entries.map(candidate => {
      const token = randomUUID();
      this.store.put('history-ref:' + token, { scope, directory: directoryIdentity(target), home: backendHomeKey(target), profile: target.digest,
        expiresAt: this.now() + 900000, candidate } satisfies HistoryReference);
      return { sessionRef: token, nativeId: candidate.ref.kind === 'codex' ? candidate.ref.threadId : candidate.ref.sessionId,
        title: candidate.title, lastCompletedAt: candidate.lastCompletedAt, role: candidate.role };
    }) };
  }
  async get(scope: string, target: Target, token: string): Promise<CandidateMetadata> {
    const value = this.store.value<HistoryReference>('history-ref:' + token);
    invariant(value && value.scope === scope && value.directory === directoryIdentity(target) && value.home === backendHomeKey(target) &&
      value.profile === target.digest && this.now() < value.expiresAt, 'HISTORY_REFERENCE_EXPIRED');
    // Re-resolve the exact native ID; current ownership and scope override old display metadata.
    return new NativeCatalog(this.store, scope).locateExact(target, value.candidate.ref);
  }
}
