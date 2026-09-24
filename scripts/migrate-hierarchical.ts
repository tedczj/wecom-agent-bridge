import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { errorCode, invariant } from '../src/errors.ts';
import { ControllerFactory } from '../src/controllers/factory.ts';
import { maintainV4 } from '../src/migrations/maintenance.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2), flags = new Set<string>(), options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dry-run' || arg === '--apply') { invariant(!flags.has(arg), 'MIGRATION_ARGUMENT'); flags.add(arg); }
    else { invariant(['--config', '--out'].includes(arg) && args[i + 1] && !options.has(arg), 'MIGRATION_ARGUMENT'); options.set(arg, args[++i]!); }
  }
  invariant(flags.size === 1 && options.has('--config') && options.has('--out'), 'MIGRATION_ARGUMENT');
  const c = loadConfig(options.get('--config')!);
  if (flags.has('--apply')) await ControllerFactory.open(c);
  const result = await maintainV4(c, path.resolve(options.get('--out')!), flags.has('--apply'));
  process.stdout.write(JSON.stringify(result) + '\n');
}
main().catch(error => { process.stderr.write(errorCode(error, 'MIGRATION_FAILED') + '\n'); process.exitCode = 1; });
