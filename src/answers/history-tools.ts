import { invariant } from '../errors.ts';
import { ArtifactStore, type AnswerAccess } from './artifact-store.ts';

export interface AnswerRange { answerRef: string; sha256: string; start: number; end: number; totalBytes: number; text: string; nextStart?: number }
/** Offsets are UTF-8 byte offsets into the immutable original. */
export async function readAnswerRange(artifacts: ArtifactStore, answerRef: string, access: AnswerAccess, start: number, limit = 16384): Promise<AnswerRange> {
  invariant(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(limit) && limit >= 4 && limit <= 16384, 'ANSWER_RANGE');
  const bytes = await artifacts.read(answerRef, access);
  invariant(start <= bytes.length && (start === bytes.length || (bytes[start]! & 0xc0) !== 0x80), 'ANSWER_RANGE');
  let end = Math.min(start + limit, bytes.length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const row = artifacts.get(answerRef);
  return { answerRef, sha256: row.sha256!, start, end, totalBytes: bytes.length,
    text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end)), ...(end < bytes.length ? { nextStart: end } : {}) };
}
export async function readAnswerOutline(artifacts: ArtifactStore, answerRef: string, access: AnswerAccess): Promise<{ answerRef: string; totalBytes: number; headings: Array<{ title: string; start: number }>; truncated: boolean }> {
  const bytes = await artifacts.read(answerRef, access), text = bytes.toString('utf8');
  const headings = []; let offset = 0, visibleBytes = 0, truncated = false;
  for (const line of text.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      const title = Array.from(line).slice(0, 120).join('');
      if (headings.length === 64 || visibleBytes + Buffer.byteLength(title) > 16384) { truncated = true; break; }
      headings.push({ title, start: offset }); visibleBytes += Buffer.byteLength(title);
    }
    offset += Buffer.byteLength(line) + 1;
  }
  return { answerRef, totalBytes: bytes.length, headings, truncated };
}
