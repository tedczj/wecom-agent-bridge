# Local Agent Bridge — current design

## Scope and migration

The current user request replaces the enterprise-chat transport with a trusted local interface and adds Codex. This document supersedes the original transport-first design at base commit `5d882cbbd6906678ca8f0728b3a1b0a14734d361`.

Supported: CLI single request and persistent stdin JSONL; Codex exec backend; Pi RPC backend; local PNG/JPEG/WebP; durable requests/sessions/results/outbox; bounded single-worker scheduling; explicit cancellation and local review. Not supported: chat accounts, WebSocket/webhooks, remote media fetching/decryption, OCR, HTTP API, multi-user remote authentication, automatic approvals, Windows process management.

The repository name remains unchanged to avoid moving the user's repository. The package is `local-agent-bridge` 0.2.0. Old state schema v1 is rejected without modification. New deployments use a fresh stateRoot. Historical chat tasks are not translated or automatically replayed.

## Boundaries and modules

```text
CLI run / stdin JSONL
  -> Local normalizer (fixed actor + named local conversation + request ID)
  -> transactional request reservation / dedup / capacity check
  -> bounded local image preparation and validated durable references
  -> FIFO single-worker Bridge
  -> selected AgentBackend: Codex exec JSONL or Pi RPC JSONL
  -> atomic terminal result + outbox
  -> LocalChannel stdout JSONL
```

`config.ts`: strict schema and environment allowlist. `local.ts`: normalization and stdout channel. `media.ts`: safe local image copies, decoding, hash verification and retention. `store.ts`: SQLite state machine and metadata binding. `bridge.ts`: scheduling and controls. `codex.ts` and `pi.ts`: backend contracts. `rpc-jsonl.ts`: bounded byte framing and Pi RPC. `reply.ts`: Unicode-aware output chunks and delivery state. `main.ts`: resource ownership. `cli.ts`: process lifecycle and operator recovery.

## Input, identity and queue

A frame has exactly `{id,session,text,images}`; unknown fields are rejected. Session defaults to `default`; images default to empty. IDs are bounded nonempty identifiers. Text is at most 64 KiB, up to four images are accepted, and slash commands cannot carry attachments. Only trusted local input is allowed; arbitrary local paths are therefore authorized by the local operator, not an untrusted remote caller.

Session base key hashes channel, backend, local actor, conversation and workspace ID; generation changes on `/new`. SQLite pins workspace path/ID and actor identity, and separately pins each backend's authentication/session root. Reusing a state database under another identity or home is rejected.

`UNIQUE(channel_id,message_id)` plus a request digest protects idempotency. Identical replay returns the original task. A reused ID with different route/text/image paths fails. If a local image file changes, the operator must use a new request ID; old requests retain their copied immutable input reference.

Capacity is checked before preparation. Media is copied before waiting for the Agent worker, preventing later expiry/deletion of the original file from silently changing queued input. Same-session earlier preparing tasks cannot be overtaken by later ready tasks. Global Agent concurrency is one; no cross-session concurrency on the same working tree.

## Image processing

No network downloader exists. Read local files with O_NOFOLLOW, reject symlink components and non-regular files, and bound actual bytes rather than trusting metadata. Defaults: 10 MiB per image, 20 MiB aggregate, 20 million pixels per image and 40 million aggregate; four images maximum. Decode serially to bound memory. Metadata and full decode must both pass; HTML/SVG/executables, corrupted payloads and animations are rejected.

Copy validated original bytes into a private random task directory, write `.part`, then rename atomically. Record SHA-256, MIME, dimensions and length. Re-read and verify hash immediately before Agent execution. Pi receives native Base64 image blocks; Codex receives controlled absolute files through `--image`, including after `resume`. There is no OCR fallback or task replay after a visual failure.

Only terminal/inactive task media is eligible for retention cleanup. Active inputs survive TTL. Uncommitted partial files are removed after interruption. This controls file transport, not semantic model vision accuracy.

## Codex contract

Use a reviewed installed official Codex executable, not a shell string. Flags are owned by the adapter: `exec --json`, explicit working directory and sandbox, `approval_policy="never"`, disabled web search, restricted tool-network setting, optional model. No `--last`, `--yolo`, full-access sandbox or arbitrary argument passthrough. Prompt is sent through stdin, never interpolated into a shell command.

A new turn records `thread.started.thread_id` immediately. Resume passes that exact UUID and rejects a returned mismatch; it never quietly starts another conversation. Await persistence before processing further events. Since exec may already have begun running when the thread event arrives, a persistence failure is conservatively interrupted, not proof that nothing ran.

Accept only the current process's events. Framing handles arbitrary pipe chunking, UTF-8 boundaries, CRLF and Unicode separators inside strings, with per-frame and total-stream limits. Retain only the final agent_message, not reasoning/tool output or duplicate item updates. Success requires a correctly ordered turn, nonempty final text, `turn.completed`, exit code 0 and no remaining owned process group. Explicit failure, malformed stream, output limits, incomplete exit, unexpected thread or persistence failure never become success.

On interruption/timeout, stop the actual owned POSIX process group with bounded TERM/KILL escalation. Forced termination is recorded as interrupted and blocks the workspace because effects may already exist; no automatic retry. Keep the process marker if cleanup cannot be confirmed. Child process exit is not a proof about detached daemons, remote jobs or external transactions.

Contract source baseline: OpenAI Codex `639d2478cc2e16d6ca715952d2e726a3aecc024e`, specifically `sdk/typescript/src/exec.ts`, `sdk/typescript/src/events.ts`, and `codex-rs/exec/src/cli.rs`. This is the inspected protocol source, not a claim that the user's installed version or a real binary was tested.

## Pi contract

Keep the existing RPC adapter behind the same AgentBackend. Each turn uses a fresh process and a persisted disk session, avoiding reuse after uncertain protocol failures. New/switch session must explicitly succeed; missing historical files fail, while a genuinely unsaved new session may be recreated. Persist references before prompt submission.

Wait for `agent_settled` plus idle state, not prompt success or `agent_end`; retries/compaction may still run after agent_end. Extract the current turn's final assistant message and stop reason. Cancel interactive extension UI requests rather than approving them. A cancellation without confirmed settlement is interrupted. Pi requires real external isolation supplied by the operator; `cwd` is not sufficient.

## Persistence, crashes and output

SQLite WAL + synchronous FULL + foreign keys + bounded busy timeout. One stateRoot instance lock. Schema version 2 contains metadata, sessions, jobs and outbox. Atomic transactions cover reserve/dedup/capacity, worker claim, and terminal status/result/outbox creation.

```text
preparing -> queued -> running -> succeeded | failed
preparing/queued -> cancelled
running -> cancel_requested -> cancelled | timed_out | interrupted
running/cancel_requested at restart -> interrupted + tainted + workspace blocked
```

Restart behavior: preparing fails explicitly; complete queued inputs may run once; running tasks never rerun; committed results only deliver; sending outbox entries become unknown. `/new` cannot bypass a blocked workspace. Local `review` requires explicit acknowledgment and dead process checks, then `/new` creates a clean logical session; no reset, deletion or task replay.

Execution and output are separate. stdout callback success means the local stream accepted bytes, not downstream exactly-once delivery. Explicit unsent/retryable errors may retry finitely; uncertainty never retries automatically. Full bounded result remains queryable locally. Chunks are UTF-8 byte bounded; default automatic cap is 20 parts. `/result` only reads saved output and never invokes an Agent.

## Security and operational limitations

Local-only trusted operator, no network authentication claim. Dedicated HOME/CODEX_HOME and state outside the project reduce accidental leakage; inherited environment is an explicit allowlist. Use default read-only first, then restricted workspace-write for reviewed tasks. Agent profiles/extensions/MCP, filesystem read policy, external process side effects and operator-supplied wrappers remain in the local trust domain. No full OS-isolation guarantee is asserted.

Logs contain bounded error codes and task states, not raw errors, secrets, prompts, tool output or thought content. Private directories and state use 0700/0600. Review validates process liveness conservatively; PID reuse may require additional operator diagnosis.

## Verification and completion levels

1. Offline deterministic unit, protocol, CLI, image and real-child/SIGKILL recovery tests.
2. Fresh dependency installation on supported platforms and CI of the exact committed version.
3. Opt-in real installed Codex/Pi text, session resume, image meaning, code modification and cancellation tests.

These are separate levels. Passing (1) does not imply (2) or (3). Actual observed results, environment/network limitations and remote push status belong in `verification.md` rather than being inferred from implemented code.
