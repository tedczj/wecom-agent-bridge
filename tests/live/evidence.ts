import path from 'node:path';
import { invariant } from '../../src/errors.ts';
import { readControlled } from '../../src/fsutil.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { caseStatus, type CaseResult } from './report.ts';

/** A PASS references existing files inside this attempt; a filename alone is not evidence. */
export async function verifyCaseEvidence(result: CaseResult, directory: string): Promise<CaseResult> {
  let invalid = false;
  const assertions = [];
  for (const assertion of result.assertions) {
    if (assertion.status !== 'PASS') { assertions.push(assertion); continue; }
    try {
      invariant(assertion.evidence?.length, 'LIVE_PASS_WITHOUT_EVIDENCE');
      const hashes: Record<string, string> = {};
      for (const file of assertion.evidence) {
        invariant(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(file) && file.split('/').every(part => part !== '.' && part !== '..'), 'LIVE_EVIDENCE_PATH');
        const bytes = await readControlled(directory, path.join(directory, file), 4 * 1024 * 1024);
        invariant(bytes.length > 0, 'LIVE_EVIDENCE_EMPTY'); hashes[file] = sha256(bytes);
      }
      assertions.push({ ...assertion, evidenceSha256: hashes });
    } catch {
      invalid = true; assertions.push({ ...assertion, status: 'FAIL' as const, evidenceSha256: undefined, reason: 'LIVE_EVIDENCE_UNVERIFIED' });
    }
  }
  return { ...result, assertions, status: result.status === 'FAIL' ? 'FAIL' : caseStatus(assertions),
    ...(invalid ? { failureCode: result.failureCode ?? 'LIVE_EVIDENCE_UNVERIFIED' } : {}) };
}
