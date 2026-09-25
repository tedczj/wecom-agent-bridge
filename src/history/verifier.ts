import { invariant } from '../errors.ts';
import type { FinishEvidence, SessionRef } from '../types.ts';
import type { Target } from '../routing/catalog.ts';
import { historyRevision, type CandidateMetadata } from './catalog.ts';
import { NativeReader } from './reader.ts';

export interface NativeReadiness {
  /** Must consult runtime/process ownership evidence. A file stat alone is insufficient. */
  check(target: Target, ref: SessionRef, signal?: AbortSignal): Promise<'idle' | 'busy' | 'unknown'>;
}
export interface PiCompletionProof { nativeId: string; sourceRevision: string; profileDigest: string; finish: FinishEvidence }
export interface ResumeCheck { ref: SessionRef; sourceRevision: string; profileDigest: string; lastCompletedAt: number | null }

export class ResumeVerifier {
  constructor(private reader: NativeReader, private readiness: NativeReadiness) {}
  async verify(target: Target, candidate: CandidateMetadata, profileDigest: string, signal?: AbortSignal, piProof?: PiCompletionProof): Promise<ResumeCheck> {
    invariant(target.digest === profileDigest && target.config.backend === candidate.ref.kind, 'PROFILE_CHANGED');
    invariant(await this.readiness.check(target, candidate.ref, signal) === 'idle', 'HISTORY_WRITER_UNVERIFIED');
    const evidence = await this.reader.inspect(target, candidate, undefined, signal);
    invariant(evidence.turnOrderValid, 'HISTORY_TURN_ORDER');
    invariant(!evidence.incomplete && !evidence.unknownEvents, 'HISTORY_UNVERIFIED');
    if (candidate.ref.kind === 'codex') {
      invariant(evidence.activity === 'idle', 'HISTORY_NOT_SETTLED');
      invariant((!target.config.codex.model || evidence.model === target.config.codex.model) &&
        (!target.config.codex.reasoning || evidence.reasoning === target.config.codex.reasoning), 'HISTORY_PROFILE_MISMATCH');
    } else {
      invariant(piProof?.nativeId === candidate.ref.sessionId && piProof.sourceRevision === candidate.sourceRevision && piProof.profileDigest === profileDigest &&
        piProof.finish.backend === 'pi' && piProof.finish.agentSettled && piProof.finish.idle && piProof.finish.cleanupConfirmed, 'PI_SETTLED_UNVERIFIED');
    }
    invariant(historyRevision(candidate.file) === candidate.sourceRevision, 'HISTORY_CHANGED');
    invariant(await this.readiness.check(target, candidate.ref, signal) === 'idle', 'HISTORY_WRITER_UNVERIFIED');
    return { ref: candidate.ref, sourceRevision: candidate.sourceRevision, profileDigest, lastCompletedAt: evidence.lastCompletedAt };
  }
  async revalidate(target: Target, candidate: CandidateMetadata, check: ResumeCheck, signal?: AbortSignal): Promise<void> {
    invariant(target.digest === check.profileDigest && JSON.stringify(candidate.ref) === JSON.stringify(check.ref) &&
      candidate.sourceRevision === check.sourceRevision && historyRevision(candidate.file) === check.sourceRevision, 'HISTORY_CHANGED');
    invariant(await this.readiness.check(target, candidate.ref, signal) === 'idle', 'HISTORY_WRITER_UNVERIFIED');
  }
}
