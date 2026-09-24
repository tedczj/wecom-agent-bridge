import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { SessionRef } from '../types.ts';
import type { Target } from '../routing/catalog.ts';
import type { NativeReadiness } from './verifier.ts';

// Read-only probe of the Codex POSIX flock namespace. Never deletes a stale file,
// acquires a writer lease, or treats lock-file existence as proof of a live writer.
const lockProbe = String.raw`
import os,sys,fcntl
def probe():
    home,thread=sys.argv[1:]
    directory=os.path.join(home,'thread-writer-locks')
    current=os.path.abspath(directory)
    while current != os.path.dirname(current):
        if os.path.islink(current): return 'unknown'
        current=os.path.dirname(current)
    coordination=None
    writer=None
    try:
        coordination=os.open(os.path.join(directory,'.coordination.lock'),os.O_RDONLY|os.O_NOFOLLOW)
        fcntl.flock(coordination,fcntl.LOCK_SH|fcntl.LOCK_NB)
        try:
            writer=os.open(os.path.join(directory,thread+'.lock'),os.O_RDONLY|os.O_NOFOLLOW)
        except FileNotFoundError:
            return 'idle'
        fcntl.flock(writer,fcntl.LOCK_SH|fcntl.LOCK_NB)
        return 'idle'
    except BlockingIOError:
        return 'busy'
    except OSError:
        return 'unknown'
    finally:
        if writer is not None: os.close(writer)
        if coordination is not None: os.close(coordination)
print(probe())
`;

/** Compatibility must be checked against the installed Codex writer-lock implementation by M0. */
export class CodexWriterReadiness implements NativeReadiness {
  async check(target: Target, ref: SessionRef, signal?: AbortSignal): Promise<'idle' | 'busy' | 'unknown'> {
    if (ref.kind !== 'codex' || target.config.backend !== 'codex') return 'unknown';
    return checkCodexWriter(target.config.codex.home, ref.threadId, signal);
  }
}
export async function checkCodexWriter(home: string, threadId: string, signal?: AbortSignal): Promise<'idle' | 'busy' | 'unknown'> {
  if (process.platform === 'win32' || !path.isAbsolute(home) || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(threadId) || signal?.aborted) return 'unknown';
  try {
      const result = await promisify(execFile)('python3', ['-I', '-c', lockProbe, home, threadId], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 3000, maxBuffer: 1024, signal,
      });
      const status = result.stdout.trim(); return status === 'idle' || status === 'busy' ? status : 'unknown';
  } catch { return 'unknown'; }
}
