import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { invariant, BridgeError } from '../../src/errors.ts';
import { inside, readControlled } from '../../src/fsutil.ts';

const appendFault = String.raw`
import os,sys,json,hashlib,fcntl,stat
home,file,thread,cwd,expected,wrong=sys.argv[1:]
assert os.path.realpath(home)==home and os.path.realpath(file)==file
assert os.path.commonpath([os.path.join(home,'sessions'),file])==os.path.join(home,'sessions')
coord=os.open(os.path.join(home,'thread-writer-locks','.coordination.lock'),os.O_RDONLY|os.O_NOFOLLOW)
try:
 fcntl.flock(coord,fcntl.LOCK_EX|fcntl.LOCK_NB)
 writer=None
 try:
  try:
   writer=os.open(os.path.join(home,'thread-writer-locks',thread+'.lock'),os.O_RDONLY|os.O_NOFOLLOW)
   fcntl.flock(writer,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except FileNotFoundError: pass
  fd=os.open(file,os.O_RDWR|os.O_NOFOLLOW)
  with os.fdopen(fd,'r+b') as f:
   info=os.fstat(f.fileno());assert stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<4194304
   before=f.read();assert hashlib.sha256(before).hexdigest()==expected and before.endswith(b'\n')
   header=json.loads(before.splitlines()[0]);assert header['type']=='session_meta' and header['payload']['id']==thread and header['payload']['cwd']==cwd
   fault=(json.dumps({'type':'turn_context','payload':{'cwd':wrong}},separators=(',',':'))+'\n').encode()
   f.write(fault);f.flush();os.fsync(f.fileno())
   print(json.dumps({'beforeSha256':expected,'afterSha256':hashlib.sha256(before+fault).hexdigest(),'appendedBytes':len(fault),'writerIdleLease':True}))
 finally:
  if writer is not None:os.close(writer)
finally:os.close(coord)
`;

/** Only a marked isolated home is mutable. The native coordination lock prevents a concurrent writer. */
export async function corruptPrivateHistory(home: string, file: string, threadId: string, cwd: string, expected: string, wrongCwd: string) {
  const marker = JSON.parse((await readControlled(home, path.join(home, 'bridge-fixture-home.json'), 4096)).toString('utf8'));
  invariant(marker.purpose === 'native-history-fault' && inside(path.join(home, 'sessions'), file) && /^[0-9a-f-]{36}$/.test(threadId) && /^[0-9a-f]{64}$/.test(expected), 'LIVE_CORRUPTION_SCOPE');
  try {
    const result = await promisify(execFile)('python3', ['-I', '-c', appendFault, home, file, threadId, cwd, expected, wrongCwd],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 5000, maxBuffer: 4096 });
    return JSON.parse(result.stdout) as { beforeSha256: string; afterSha256: string; appendedBytes: number; writerIdleLease: boolean };
  } catch { throw new BridgeError('LIVE_CORRUPTION_REFUSED'); }
}
