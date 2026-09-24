export interface ControllerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface ControllerRef { threadId: string; generation: number }
export interface ContextUsageSnapshot {
  threadId: string;
  turnId: string;
  usedTokens: number;
  contextWindowTokens: number;
  origin: 'runtime';
  basis: 'last-completed-request-total';
  observedAt: number;
  validForGeneration: number;
}
export interface ControllerTurn {
  turnId: string;
  text: string;
  usage?: ContextUsageSnapshot;
  policyVerified?: boolean;
}
export type ControllerToolHandler = (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
export interface ControllerRequestIdentity { requestId: string; sourceRequestId: string }
export interface ControllerRuntime {
  create(generation: number, instructions: string, tools: ControllerTool[]): Promise<ControllerRef>;
  resume(ref: ControllerRef, instructions: string, tools: ControllerTool[], expectedTurnId?: string): Promise<void>;
  run(ref: ControllerRef, rawQuery: string, handler: ControllerToolHandler, signal?: AbortSignal, images?: readonly ImageRef[], identity?: ControllerRequestIdentity): Promise<ControllerTurn>;
  getUsage(ref: ControllerRef): ContextUsageSnapshot | undefined;
  interrupt(ref: ControllerRef): Promise<void>;
  close(): Promise<void>;
}
import type { ImageRef } from '../types.ts';
