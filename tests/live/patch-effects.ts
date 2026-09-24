import path from 'node:path';
import { inside } from '../../src/fsutil.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

export interface AddedFile { path: string; contentSha256: string }
/** Closed add-file patch grammar. Updates, moves, deletes and metadata edits need separate evidence. */
export function addedFiles(patch: string, cwd: string): AddedFile[] | undefined {
  if (patch.length > 131072 || patch.includes('\0') || !path.isAbsolute(cwd)) return;
  const lines = patch.replace(/\r\n/g, '\n').split('\n'); if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return;
  const files: AddedFile[] = [], names = new Set<string>(); let current: string | undefined, content: string[] = [];
  const finish = () => { if (current) files.push({ path: current, contentSha256: sha256(content.length ? content.join('\n') + '\n' : '') }); };
  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      finish(); const name = line.slice('*** Add File: '.length), file = path.resolve(cwd, name), relative = path.relative(cwd, file);
      if (!name || !relative || !inside(cwd, file) || relative.split(path.sep).some(part => ['.git', '.codex', '.agents'].includes(part)) || names.has(file.toLowerCase())) return;
      current = file; content = []; names.add(file.toLowerCase());
    } else if (current && line.startsWith('+')) content.push(line.slice(1));
    else return;
  }
  finish(); return files.length > 0 && files.length <= 64 ? files : undefined;
}

/** Match the native file-change result, not an assistant's description of a patch. */
export function addedFilesMatch(files: AddedFile[], changes: unknown): boolean {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false;
  const rows = Object.entries(changes);
  return rows.length === files.length && rows.every(([file, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>, expected = files.find(item => item.path === file);
    return !!expected && row.type === 'add' && typeof row.content === 'string' && sha256(row.content) === expected.contentSha256;
  });
}
