import { ArtifactStore } from '../../src/answers/artifact-store.ts';
import { RoleTools } from '../../src/orchestration/tools.ts';
import { invariant, record } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

let installed = false;
/** Observe actual capture and tool boundaries without changing their arguments or results. */
export function answerMeter() {
  invariant(!installed, 'LIVE_METER_ALREADY_INSTALLED'); installed = true;
  const capture = ArtifactStore.prototype.capture, call = RoleTools.prototype.call;
  const captures: Array<{ answerId: string; sha256: string; bytes: number }> = [];
  const tools: Array<{ role: string; tool: string; resultSha256: string; markerSeen: boolean; rawBodySeen: boolean;
    answerRef?: string; start?: number; end?: number }> = [];
  const rawBodies: string[] = []; let marker = '', stopped = false;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings)
    : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  const captured: typeof capture = function (this: ArtifactStore, id, text) {
    capture.call(this, id, text);
    if (this.get(id).producer_role === 'business') {
      captures.push({ answerId: id, sha256: sha256(text), bytes: Buffer.byteLength(text) });
      if (Array.from(text).length > 1200) rawBodies.push(text);
    }
  };
  const called: typeof call = async function (this: RoleTools, name, args, id) {
    const result = await call.call(this, name, args, id), values = strings(result), parameters = record(args);
    const range = name === 'read_answer_range' ? record(result) : undefined;
    tools.push({ role: this.definitions.some(tool => tool.name === 'route_delegate') ? 'bridge' : 'route', tool: name,
      resultSha256: sha256(JSON.stringify(result)), markerSeen: !!marker && values.some(value => value.includes(marker)),
      rawBodySeen: values.some(value => rawBodies.some(raw => value.includes(raw) || value.includes(Array.from(raw).slice(-256).join('')))),
      ...(typeof parameters.answerRef === 'string' ? { answerRef: parameters.answerRef } : {}),
      ...(range ? { start: range.start as number, end: range.end as number } : {}) });
    return result;
  };
  ArtifactStore.prototype.capture = captured; RoleTools.prototype.call = called;
  return { setMarker: (value: string) => { marker = value; }, snapshot: () => structuredClone({ captures, tools }), stop() {
    if (stopped) return;
    invariant(ArtifactStore.prototype.capture === captured && RoleTools.prototype.call === called, 'LIVE_METER_RESTORE_CONFLICT');
    ArtifactStore.prototype.capture = capture; RoleTools.prototype.call = call; installed = false; stopped = true;
  } };
}
