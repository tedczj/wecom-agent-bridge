export interface ImageRef {
  id: string; localPath: string; agentPath?: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string; bytes: number; width: number; height: number;
  source: 'message' | 'quote';
}
/** Local transport identities are supplied by the operator, never by model output. */
export interface Route { channelId: string; kind: 'local' | 'weixin'; targetId: string; senderId: string }
export interface LocalImage { path: string; source: 'message' | 'quote' }
export interface Incoming {
  messageId: string; route: Route; reqId: string; text: string;
  media: LocalImage[]; receivedAt: number;
}
export interface NormalizedInput {
  taskId: string; messageId: string; route: Route; receivedAt: number;
  text: string; images: ImageRef[]; workspaceId: string; sessionKey: string; generation: number;
}
export type SessionRef = {
  kind: 'pi'; sessionId: string; sessionFile: string; hasHistory?: boolean;
} | { kind: 'codex'; threadId: string };
export interface AgentResult {
  outcome: 'success' | 'failed' | 'cancelled' | 'interrupted';
  finalText: string; errorCode?: string; sessionRef?: SessionRef;
}
export interface RunHooks {
  persistSession(ref: SessionRef): Promise<void>;
  progress(event: { type: string; tool?: string }): void;
}
export interface AgentBackend {
  start(): Promise<void>;
  run(input: NormalizedInput, session: SessionRef | undefined, hooks: RunHooks, signal: AbortSignal): Promise<AgentResult>;
  stop(): Promise<void>;
}
export interface Channel {
  readonly ready: boolean;
  receipt(reqId: string, text: string): Promise<void>;
  send(route: Route, text: string, taskId?: string): Promise<void>;
}
export interface MediaProvider {
  prepare(taskId: string, media: LocalImage[], signal?: AbortSignal): Promise<ImageRef[]>;
  validate(images: ImageRef[]): Promise<void>;
}
export type JobStatus = 'preparing' | 'queued' | 'running' | 'cancel_requested' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export interface Job {
  seq: number; task_id: string; message_id: string; channel_id: string; kind: 'agent' | 'command';
  session_key: string; status: JobStatus; route_json: string; input_json: string;
  result_text: string | null; error_code: string | null; reviewed_at: number | null;
  created_at: number; started_at: number | null; finished_at: number | null;
}
export interface Session {
  session_key: string; base_key: string; generation: number; agent_ref_json: string | null;
  state: 'new' | 'ready' | 'tainted';
}
export type DeliveryState = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed';
export interface Delivery {
  delivery_id: string; task_id: string; purpose: string; part_no: number; target_json: string;
  body_json: string; state: DeliveryState; attempts: number;
  next_attempt_at: number | null; last_error_code: string | null;
}
