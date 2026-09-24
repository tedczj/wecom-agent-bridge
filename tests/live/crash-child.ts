import { Writable } from 'node:stream';
import { parseConfig } from '../../src/config.ts';
import { openService, type LocalService } from '../../src/main.ts';
import { errorCode, invariant, record } from '../../src/errors.ts';

invariant(process.argv.includes('--live') && process.send, 'LIVE_OPT_IN_REQUIRED');
let service: LocalService | undefined;
const stop = async () => { try { await service?.stop(); } finally { process.exit(130); } };
process.once('SIGTERM', () => void stop()); process.once('disconnect', () => void stop());
process.once('message', value => void (async () => {
  try {
    const input = record(value), c = parseConfig(input.config);
    invariant(c.transport === 'local' && c.orchestration, 'LIVE_CONFIG_REQUIRED');
    service = await openService(c, new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    const accepted = await service.accept(input.frame); process.send!({ type: 'accepted', ...accepted });
  } catch (error) {
    process.send?.({ type: 'failed', code: errorCode(error, 'LIVE_CHILD_FAILED') });
    try { await service?.stop(); } finally { process.exitCode = 1; process.disconnect(); }
  }
})());
