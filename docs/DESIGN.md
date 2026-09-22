# Local Agent Bridge — current design

## Scope and migration

Personal Weixin ClawBot and local CLI/JSONL share the Codex/Pi execution engine. Enterprise WeCom is not implemented. This document describes the current implementation; historical snapshots remain in Git history.

Supported: personal Weixin ClawBot text/image messages and supplied voice transcripts; CLI single request and persistent stdin JSONL; Codex exec backend; Pi RPC backend; local PNG/JPEG/WebP; durable requests/sessions/results/outbox; bounded single-worker scheduling; explicit cancellation and local review. Not supported: ordinary Weixin friend/group takeover, WeCom, WebSocket/webhooks, standalone ASR, outbound voice/media, file/video/quote handling, OCR, HTTP API, arbitrary remote users, automatic approvals or Windows process management.

The package is `local-agent-bridge` 0.2.0. Old state schema v1 is rejected without modification. New deployments use a fresh stateRoot. Historical chat tasks are not translated or automatically replayed.

## Boundaries and modules

```text
Weixin QR login / HTTPS polling       Local CLI run / stdin JSONL
  -> paired-owner validation           -> fixed local actor + session
  -> bounded image download/decrypt    -> local image paths
                  \                   /
                   reservation / deduplication
                   validated durable image copies
                   FIFO single-worker Bridge
                   Codex exec or Pi RPC
                   atomic terminal result + outbox
                  /                   \
          Weixin text reply        stdout JSONL
```

`weixin-api.ts`, `weixin-login.ts`, `weixin-media.ts`, `weixin.ts`: iLink protocol, account binding, bounded remote media and Weixin transport. `config.ts`: strict schema and environment allowlist. `local.ts`: normalization and stdout channel. `media.ts`: safe local image copies, decoding, hash verification and retention. `store.ts`: SQLite state machine and metadata binding. `bridge.ts`: scheduling and controls. `codex.ts` and `pi.ts`: backend contracts. `rpc-jsonl.ts`: bounded byte framing and Pi RPC. `reply.ts`: Unicode-aware output chunks and delivery state. `main.ts`: resource ownership. `cli.ts`: process lifecycle and operator recovery.

## Input, identity and queue

A local frame has exactly `{id,session,text,images}`; unknown fields are rejected. Session defaults to `default`; images default to empty. IDs are bounded nonempty identifiers. Text is at most 64 KiB, up to four images are accepted, and slash commands cannot carry attachments. The local endpoint accepts trusted operator input only. Weixin input is separately normalized; a remote sender cannot supply arbitrary local file paths.

Session base key hashes channel, backend, local actor, conversation and workspace ID; generation changes on `/new`. SQLite pins workspace path/ID and actor identity, and separately pins each backend's authentication/session root. Reusing a state database under another identity or home is rejected.

`UNIQUE(channel_id,message_id)` plus a request digest protects idempotency. Identical replay returns the original task. A reused ID with different route/text/image paths fails. If a local image file changes, the operator must use a new request ID; old requests retain their copied immutable input reference.

Local requests check capacity at reservation, before MediaStore preparation. The Weixin receiver first performs bounded remote-image download/decryption, then reserves the job and copies validated media before waiting for the Agent worker. Same-session earlier preparing tasks cannot be overtaken by later ready tasks. Each stateRoot has one worker and one instance lock; independent state roots do not share a workspace lock.

## Image processing

Weixin images are downloaded without auth headers from the fixed HTTPS Tencent CDN host, with no redirects, a 20-second timeout and byte limits, then decrypted using the supplied AES-128-ECB key. URL/key material remains in memory. Staged files enter the same local image pipeline. Read local files with O_NOFOLLOW, reject symlink components and non-regular files, and bound actual bytes rather than trusting metadata. Defaults: 10 MiB per image, 20 MiB aggregate, 20 million pixels per image and 40 million aggregate; four images maximum. Decode serially to bound memory. Metadata and full decode must both pass; HTML/SVG/executables, corrupted payloads and animations are rejected.

Copy validated original bytes into a private random task directory, write `.part`, then rename atomically. Record SHA-256, MIME, dimensions and length. Re-read and verify hash immediately before Agent execution. Pi receives native Base64 image blocks; Codex receives controlled absolute files through `--image`, including after `resume`. There is no OCR fallback or task replay after a visual failure.

Only terminal/inactive task media is eligible for retention cleanup. Active inputs survive TTL. Uncommitted partial files are removed after interruption. This controls file transport, not semantic model vision accuracy.

## Personal Weixin transport

`transport` is `local` by default for compatibility, or `weixin` for personal ClawBot. `start.sh` dispatches by this setting. Use separate state roots; a transport binding prevents old local jobs being delivered to Weixin or vice versa. The authenticated bot/user pair is pinned in metadata before starting any worker or outbox pump.

The adapter uses Tencent's documented iLink HTTP JSON contract, inspected at `24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`, version 2.4.9. It implements QR polling/verification/approved-host redirects and private credential persistence, long-poll updates, and text sends. No OpenClaw runtime dependency is required. These are client protocol observations, not a claim of an immutable server API.

Accept only paired-user completed messages for the matching bot, and reject group IDs. Preserve uint64 message IDs as strings. Build routes from authenticated identity, never model output. Bot/context tokens and media keys are not passed to the Agent. Voice uses the supplied transcript; absent transcripts produce an explicit response and no Agent invocation. Unsupported files, videos and quotes likewise produce a persisted failure reply.

Reserve/deduplicate each accepted message in the existing Store. Stage images with bounded download/decryption, then wait only for preparation to finish before deleting staging files; Agent execution continues independently. Persist the next poll cursor only after processing the batch. A crash before cursor persistence replays server IDs through the same deduplication rules, never rerunning an existing task. Validated queued images are already in the MediaStore. Uncommitted staging is removed on startup.

Replies use the durable outbox and the latest private context token for the paired user. Authenticated getupdates/sendmessage responses may omit zero-valued return codes; absent or numeric zero ret/errcode fields are accepted, while malformed or nonzero codes are rejected. HTTP failures and invalid/truncated JSON remain failures. Send network errors/timeout/ambiguous ACK become `unknown`, never automatic resend. Poll transport failures retry with delay; authentication expiry or persistence failures stop intake. Ctrl-C aborts polling and the Agent, preserving the existing interrupted/tainted review requirements.

## Codex contract

Use a reviewed installed official Codex executable, not a shell string. Flags are owned by the adapter: `exec --json`, explicit working directory and sandbox, `approval_policy="never"`, disabled web search, restricted tool-network setting, optional model. No `--last`, `--yolo`, full-access sandbox or arbitrary argument passthrough. Prompt is sent through stdin, never interpolated into a shell command.

A new turn records `thread.started.thread_id` immediately. Resume passes that exact UUID and rejects a returned mismatch; it never quietly starts another conversation. Await persistence before processing further events. Since exec may already have begun running when the thread event arrives, a persistence failure is conservatively interrupted, not proof that nothing ran.

Accept only the current process's events. Framing handles arbitrary pipe chunking, UTF-8 boundaries, CRLF and Unicode separators inside strings, with per-frame and total-stream limits. Retain only the final agent_message, not reasoning/tool output or duplicate item updates. Success requires a correctly ordered turn, nonempty final text, `turn.completed`, exit code 0 and no remaining owned process group. Explicit failure, malformed stream, output limits, incomplete exit, unexpected thread or persistence failure never become success.

On interruption/timeout, stop the actual owned POSIX process group with bounded TERM/KILL escalation. Forced termination is recorded as interrupted and blocks the workspace because effects may already exist; no automatic retry. Keep the process marker if cleanup cannot be confirmed. Child process exit is not a proof about detached daemons, remote jobs or external transactions.

Contract source baseline: OpenAI Codex `639d2478cc2e16d6ca715952d2e726a3aecc024e`, specifically `sdk/typescript/src/exec.ts`, `sdk/typescript/src/events.ts`, and `codex-rs/exec/src/cli.rs`. This is the inspected protocol source. Live installed-binary evidence is recorded separately in verification.md.

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

Local input is trusted operator input. Weixin accepts only the exact paired bot/user identity from QR login; groups, bot echoes and other senders are rejected before media downloads. Dedicated HOME/CODEX_HOME and state outside the project reduce accidental leakage; inherited environment is an explicit allowlist. Use default read-only first, then restricted workspace-write for reviewed tasks. Agent profiles/extensions/MCP, filesystem read policy, external process side effects and operator-supplied wrappers remain in the local trust domain. No full OS-isolation guarantee is asserted.

Diagnostic logs contain bounded error codes, numeric API return codes and task states, not raw errors, tokens, prompts, tool output or thought content. Interactive login renders a temporary QR and startup prints the configured workspace path; keep captured terminal output private. Local JSONL results deliberately contain model answers. Private directories and state use 0700/0600. Review validates process liveness conservatively; PID reuse may require additional operator diagnosis.

## Verification and completion levels

1. Offline deterministic unit, protocol, CLI, image and real-child/SIGKILL recovery tests.
2. Fresh dependency installation on supported platforms and CI of the exact committed version.
3. Opt-in real installed Codex/Pi text, session resume, image meaning, code modification and cancellation tests.

These are separate levels. Passing (1) does not imply (2) or (3). Actual observed results, environment/network limitations and remote push status belong in `verification.md` rather than being inferred from implemented code.
