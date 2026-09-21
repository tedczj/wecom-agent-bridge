import { constants, lstatSync, mkdirSync, chmodSync, realpathSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, invariant } from './errors.ts';
export function inside(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
/** Walk existing components, rejecting symlinks rather than following them. */
export function privateDirectory(dir: string): string {
    invariant(path.isAbsolute(dir), 'PATH_NOT_ABSOLUTE');
    let current = path.parse(dir).root;
    for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try {
            mkdirSync(current, { mode: 0o700 });
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
                throw e;
        }
        const stat = lstatSync(current);
        invariant(!stat.isSymbolicLink() && stat.isDirectory(), 'UNSAFE_DIRECTORY');
    }
    chmodSync(dir, 0o700);
    return realpathSync(dir);
}
export async function readControlled(root: string, file: string, maxBytes: number): Promise<Buffer> {
    invariant(path.isAbsolute(file) && inside(root, file), 'MEDIA_PATH');
    let parent = path.dirname(file);
    while (inside(root, parent)) {
        invariant(!(await lstat(parent)).isSymbolicLink(), 'MEDIA_SYMLINK');
        if (parent === root)
            break;
        parent = path.dirname(parent);
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        invariant(stat.isFile() && stat.size <= maxBytes, 'MEDIA_SIZE');
        // Read a bounded buffer, including one sentinel byte in case a file grows.
        const buffer = Buffer.alloc(maxBytes + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const n = (await handle.read(buffer, bytes, buffer.length - bytes, null)).bytesRead;
            if (!n)
                break;
            bytes += n;
        }
        invariant(bytes <= maxBytes, 'MEDIA_SIZE');
        return buffer.subarray(0, bytes);
    }
    finally {
        await handle.close();
    }
}
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}
export function acquireLock(root: string): () => void {
    privateDirectory(root);
    const file = path.join(root, 'instance.lock');
    const token = randomUUID();
    try {
        writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST')
            throw new BridgeError('INSTANCE_LOCKED');
        throw e;
    }
    return () => {
        try {
            if (JSON.parse(readFileSync(file, 'utf8')).token === token)
                unlinkSync(file);
        }
        catch { /* Already removed. */ }
    };
}
/** Only invoked by explicit local recovery after the operator has reviewed processes/diff. */
export function clearStaleLock(root: string): void {
    const file = path.join(root, 'instance.lock');
    try {
        invariant(!lstatSync(file).isSymbolicLink(), 'UNSAFE_LOCK');
        const data = JSON.parse(readFileSync(file, 'utf8'));
        invariant(Number.isSafeInteger(data.pid) && data.pid > 0 && !processAlive(data.pid), 'INSTANCE_RUNNING');
        rmSync(file);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
            throw e;
    }
}
