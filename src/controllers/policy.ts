import { isDeepStrictEqual } from 'node:util';
import { invariant, record } from '../errors.ts';
import { sha256 } from '../orchestration/requests.ts';
import type { ControllerTool } from './runtime.ts';

export const controllerPolicyPrefix = 'BRIDGE_CONTROLLER_POLICY_V1:';
export interface ControllerPolicyEvidence {
  threadId: string; turnId: string; toolNames: string[]; toolSchemasSha256: string;
  dynamicToolsOnly: true; nativeAutoCompaction: 'disabled';
}
export interface ControllerPolicyAudit {
  threadId: string; turnId: string; requestId?: string; valid: boolean; evidence?: ControllerPolicyEvidence;
}
/** This is a native-runtime diagnostic, never an assistant claim. Its binary must separately pass the capability gate. */
export function controllerPolicyEvidence(value: unknown, threadId: string, turnId: string, tools: ControllerTool[]): ControllerPolicyEvidence {
  const policy = record(value);
  invariant(policy.version === 1 && policy.turnId === turnId && policy.dynamicToolsOnly === true && policy.nativeAutoCompaction === 'disabled' &&
    Array.isArray(policy.tools) && policy.tools.length === tools.length, 'CONTROLLER_POLICY_INVALID');
  // The pinned 0.155.1 JsonSchema codec omits these bounds. RoleTools enforces them
  // at the host boundary; do not claim they survived in the model-visible schema.
  const expected = new Map(tools.map(tool => {
    const schema = structuredClone(tool.inputSchema);
    for (const value of Object.values(record(schema.properties ?? {}))) {
      const field = record(value); delete field.maxLength; delete field.minimum; delete field.maximum;
    }
    return [tool.name, schema];
  })), names: string[] = [];
  for (const value of policy.tools) {
    const spec = record(value);
    invariant(spec.type === 'function' && typeof spec.name === 'string' && expected.has(spec.name) &&
      isDeepStrictEqual(spec.parameters, expected.get(spec.name)), 'CONTROLLER_POLICY_INVALID');
    expected.delete(spec.name); names.push(spec.name);
  }
  invariant(!expected.size, 'CONTROLLER_POLICY_INVALID');
  return { threadId, turnId, toolNames: names.sort(), toolSchemasSha256: sha256(JSON.stringify(policy.tools)), dynamicToolsOnly: true, nativeAutoCompaction: 'disabled' };
}
