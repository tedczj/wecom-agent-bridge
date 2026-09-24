import { invariant } from '../errors.ts';

export interface ProjectedRecord { value: Record<string, unknown>; omittedPaths: string[] }
type ObjectFrame = { kind: 'object'; value: Record<string, unknown>; path: string; state: 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end'; key?: string };
type ArrayFrame = { kind: 'array'; value: unknown[]; path: string; state: 'value-or-end' | 'value' | 'comma-or-end' };
type Frame = ObjectFrame | ArrayFrame;
const metadataKeys = new Set(['type', 'id', 'cwd', 'role', 'timestamp', 'model', 'effort', 'reasoning_effort', 'phase', 'parentId', 'turn_id', 'thread_id', 'session_id', 'source', 'stopReason']);

/** Validates every JSON token, retaining bounded strings regardless of object key order. */
export class JsonlProjection {
  private stack: Frame[] = [];
  private root: unknown;
  private hasRoot = false;
  private mode: 'none' | 'string' | 'scalar' = 'none';
  private token = '';
  private key = false;
  private escape = false;
  private unicode: string | undefined;
  private omitted = false;
  private paths: string[] = [];
  private nodes = 0;
  private textChars = 0;
  private metadataChars = 0;
  private critical = false;
  private tokenPath = '';
  constructor(private emit: (row: ProjectedRecord) => void) {}

  private valuePath(): string {
    const parent = this.stack.at(-1);
    if (!parent) return '$';
    return parent.kind === 'object' ? parent.path + '.' + parent.key : parent.path + '[' + parent.value.length + ']';
  }
  private accept(value: unknown): void {
    invariant(++this.nodes <= 10000, 'HISTORY_STRUCTURE_LIMIT');
    const parent = this.stack.at(-1);
    if (!parent) { invariant(!this.hasRoot, 'HISTORY_FORMAT'); this.root = value; this.hasRoot = true; return; }
    if (parent.kind === 'object') {
      invariant(parent.state === 'value' && parent.key !== undefined, 'HISTORY_FORMAT');
      parent.value[parent.key] = value; parent.key = undefined; parent.state = 'comma-or-end';
    } else {
      invariant(parent.state === 'value' || parent.state === 'value-or-end', 'HISTORY_FORMAT');
      parent.value.push(value); parent.state = 'comma-or-end';
    }
  }
  private addString(character: string): void {
    if (this.key) {
      invariant(this.token.length + character.length <= 256, 'HISTORY_STRUCTURE_LIMIT'); this.token += character; return;
    }
    if (this.critical) {
      invariant(this.token.length + character.length <= 4096 && this.metadataChars + character.length <= 65536, 'HISTORY_STRUCTURE_LIMIT');
      this.token += character; this.metadataChars += character.length;
    } else if (!this.omitted && this.token.length + character.length <= 16384 && this.textChars + character.length <= 65536) {
      this.token += character; this.textChars += character.length;
    } else this.omitted = true;
  }
  private finishString(): void {
    if (this.key) {
      const parent = this.stack.at(-1);
      invariant(parent?.kind === 'object' && !Object.hasOwn(parent.value, this.token), 'HISTORY_FORMAT');
      parent.key = this.token; parent.state = 'colon';
    } else {
      if (this.omitted) {
        invariant(this.paths.length < 1000, 'HISTORY_STRUCTURE_LIMIT'); this.paths.push(this.tokenPath);
        if (/[\uD800-\uDBFF]$/.test(this.token)) this.token = this.token.slice(0, -1);
      }
      this.accept(this.token);
    }
    this.mode = 'none'; this.token = '';
  }
  private finishScalar(): void {
    invariant(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.token), 'HISTORY_FORMAT');
    const value: unknown = JSON.parse(this.token);
    invariant(typeof value !== 'number' || Number.isFinite(value), 'HISTORY_FORMAT');
    this.accept(value); this.mode = 'none'; this.token = '';
  }
  push(text: string): void {
    for (const character of text) {
      if (this.mode === 'string') {
        if (this.unicode !== undefined) {
          invariant(/^[0-9a-f]$/i.test(character), 'HISTORY_FORMAT'); this.unicode += character;
          if (this.unicode.length === 4) { this.addString(String.fromCharCode(parseInt(this.unicode, 16))); this.unicode = undefined; }
        } else if (this.escape) {
          this.escape = false;
          if (character === 'u') this.unicode = '';
          else {
            const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            invariant(Object.hasOwn(escapes, character), 'HISTORY_FORMAT'); this.addString(escapes[character]!);
          }
        } else if (character === '\\') this.escape = true;
        else if (character === '"') this.finishString();
        else { invariant(character.charCodeAt(0) >= 32, 'HISTORY_FORMAT'); this.addString(character); }
        continue;
      }
      if (this.mode === 'scalar') {
        if (!/[\s,\]}]/.test(character)) { invariant(this.token.length < 128, 'HISTORY_STRUCTURE_LIMIT'); this.token += character; continue; }
        this.finishScalar();
      }
      if (character === '\n') {
        invariant(this.stack.length === 0, 'HISTORY_FORMAT');
        if (this.hasRoot) {
          invariant(this.root !== null && typeof this.root === 'object' && !Array.isArray(this.root), 'HISTORY_FORMAT');
          this.emit({ value: this.root as Record<string, unknown>, omittedPaths: this.paths });
        }
        this.root = undefined; this.hasRoot = false; this.paths = []; this.nodes = 0; this.textChars = 0; this.metadataChars = 0;
        continue;
      }
      if (character === ' ' || character === '\t' || character === '\r') continue;
      const parent = this.stack.at(-1);
      if (parent?.kind === 'object' && (parent.state === 'key' || parent.state === 'key-or-end')) {
        if (character === '}' && parent.state === 'key-or-end') { this.stack.pop(); continue; }
        invariant(character === '"', 'HISTORY_FORMAT'); this.key = true; this.token = ''; this.mode = 'string'; continue;
      }
      if (parent?.kind === 'object' && parent.state === 'colon') {
        invariant(character === ':', 'HISTORY_FORMAT'); parent.state = 'value'; continue;
      }
      if (parent?.state === 'comma-or-end') {
        if (character === (parent.kind === 'object' ? '}' : ']')) { this.stack.pop(); continue; }
        invariant(character === ',', 'HISTORY_FORMAT'); parent.state = parent.kind === 'object' ? 'key' : 'value'; continue;
      }
      if (parent?.kind === 'array' && parent.state === 'value-or-end' && character === ']') { this.stack.pop(); continue; }
      invariant(!this.hasRoot || this.stack.length > 0, 'HISTORY_FORMAT');
      const currentPath = this.valuePath();
      if (character === '{' || character === '[') {
        invariant(this.stack.length < 64, 'HISTORY_STRUCTURE_LIMIT');
        if (character === '{') {
          const value: Record<string, unknown> = Object.create(null); this.accept(value);
          this.stack.push({ kind: 'object', value, path: currentPath, state: 'key-or-end' });
        } else {
          const value: unknown[] = []; this.accept(value); this.stack.push({ kind: 'array', value, path: currentPath, state: 'value-or-end' });
        }
      } else if (character === '"') {
        this.mode = 'string'; this.key = false; this.token = ''; this.omitted = false; this.tokenPath = currentPath;
        this.critical = parent?.kind === 'object' && metadataKeys.has(parent.key!);
      } else {
        invariant(/[tfn\d-]/.test(character), 'HISTORY_FORMAT'); this.mode = 'scalar'; this.token = character;
      }
    }
  }
  /** A non-newline-terminated record is partial, even if its last byte happens to be a brace. */
  end(): { incomplete: boolean } { return { incomplete: this.hasRoot || this.mode !== 'none' || this.stack.length > 0 }; }
}
