# Local Agent Bridge — implementation modes

## Hierarchical implementation in progress

`main.ts` selects `HierarchicalBridge` only for explicit `orchestration.mode=hierarchical` and a complete, matching controller capability proof. An independent [compatibility candidate](THREE_LAYER_RUNTIME_COMPATIBILITY.md) has passed M0 for the observed model/window; the unchanged installed binary has no matching successful proof. Production has not been switched. [Implementation status](THREE_LAYER_IMPLEMENTATION_STATUS.md) identifies implemented components, live observations and remaining acceptance gaps. The [frozen design](THREE_LAYER_AGENT_BRIDGE.md) remains the target contract, not evidence of completion.

The hierarchical path uses v4 raw requests, durable host-bound delegation, separate management sessions and one business worker, immutable answer artifacts, safe recap projections, and runtime-only usage telemetry. Model/effort/window values retain individual sources. No historical text or images are injected into business prompts. Populated v3 state cannot be converted to hierarchical mode; use a separate empty stateRoot. There is no automatic replay or fallback to legacy execution after a capability failure.

The remaining sections describe the existing non-hierarchical implementation. Their history-injection, schema-v3 and interpreter rules do not describe the new path.

## Scope and state

Personal Weixin ClawBot and local CLI/JSONL share the Codex/Pi execution engine. Enterprise WeCom is not implemented. This document describes the current implementation; historical snapshots remain in Git history.

Supported: personal Weixin ClawBot text/image messages and supplied voice transcripts; CLI single request and persistent stdin JSONL; Codex exec backend; Pi RPC backend; local PNG/JPEG/WebP; durable requests/sessions/results/outbox; bounded single-worker scheduling; explicit cancellation and local review. Not supported: ordinary Weixin friend/group takeover, WeCom, WebSocket/webhooks, standalone ASR, outbound voice/media, file/video/quote handling, OCR, HTTP API, arbitrary remote users, automatic approvals or Windows process management.

The package is `local-agent-bridge` 0.2.0. Existing v3/v4 state is supported in its corresponding mode; v1/v2 is rejected without modification. New deployments use a fresh stateRoot. Historical chat tasks are not translated or automatically replayed.

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

Local requests check capacity at reservation, before MediaStore preparation. The Weixin receiver first performs bounded remote-image download/decryption, then reserves the job and copies validated media before waiting for the Agent worker. Same-session earlier preparing tasks cannot be overtaken by later ready tasks. Each stateRoot has one worker and one instance lock. Execution also acquires a same-host, same-user lock keyed by the canonical workspace device/inode, independent of stateRoot. Interrupted execution retains this lock for explicit review. Routing mode uses global reservation FIFO, including earlier preparing inputs; legacy mode retains per-session preparation ordering.

## Directory routing and native history

Optional `routing` configuration enables the host-controlled directory/session router described in [BRIDGE_ROUTING_SESSION_RULES.md](BRIDGE_ROUTING_SESSION_RULES.md). Its confirmed R-* rules and BR-01..BR-22 matrix are the authoritative behavior contract. Without this explicit authorization the legacy single-workspace path remains available.

`routing/config.ts` validates roots, profiles, workspaces and optional HTTPS JSON interpreter settings. `catalog.ts` revalidates canonical path and device/inode, separates discovery from execution, searches bounded pages, and treats project metadata as untrusted data. `intent.ts` gives a configured Agent priority for natural language; explicit slash controls bypass inference. Without an interpreter it supports bounded Chinese forms. `codex-interpreter.ts` runs an ephemeral structured-output Codex classifier in a separate empty read-only workspace, using the existing authentication home while ignoring user config/rules and project documents, disabling execution tool configuration and rejecting tool events. HTTP classification remains optional. Interpreter failure never falls back to worker execution. `history.ts` scopes Codex discovery through the native state_5.sqlite threads index when available, validates rollout headers before streaming matching bodies, and reads Pi v3 branches without invoking either backend. Legacy no-cwd records are not assignable to a workspace; unrelated bodies are not parsed. Active/incomplete or profile-mismatched sessions remain readable but are not resumable. Damaged files produce explicit incomplete-list notices and prevent automatic new-session decisions. `router.ts` maintains sticky conversation bindings, versioned aliases, continuation state and historical list snapshots. It also holds pending absolute-path authorization questions and exact-directory grants scoped to the verified conversation. The next explicit consent after confirmed question delivery is required before reading candidate metadata or dispatching work; grants never modify global roots. Request identity, physical identity and profile validation continue at dispatch and restart. `routing/lock.ts` implements the physical workspace mutex; it does not implement OS isolation.

Conversation scope comes only from normalized transport identity. Local routing channel identity is pinned on first enablement rather than changing with the default backend. Session keys additionally bind the complete trusted execution profile digest. Routing preparation is serialized before reservation. A single SQLite transaction commits message identity, selected session, immutable target/profile, conversation state and control reply. Original request identity is preserved; approved work carries a source task reference, and explicitly selected recent materials may be added as marked context. Duplicate requests return before interpretation; failed switches and history failures persist a control result and run no Agent. Profile drift or path replacement at dispatch fails the queued job.

Only successful complete Agent turns update last_response_at, in the result/outbox transaction. Automatic reuse is inclusive at 24 hours; unknown/future timestamps do not qualify. Active/new-unsent sessions remain bound. Explicit selection is recorded separately so an old session survives until the next work submission without falsifying its response time. Existing bindings take precedence over native discovery. Native entries already claimed by another conversation/profile in this Store are excluded; the operator must separate account session roots across independent bridge installations. No global account ownership database is inferred from native UUIDs.

Control reads never alter activeWorkspace. List ordinals use a stored, scoped 15-minute snapshot; search and result pages continue through `下一页` / `/more`. Explicit resume rechecks ownership, directory/profile and native availability. A missing bound session confirmed before prompt submission creates a new session with an explicit result notice; other discovery errors block. Pi native assistant messages do not prove `agent_settled`, so only bridge-verified successes supply an automatic-reuse timestamp for Pi.

Global interruption blocking remains conservative across configured workspaces. Creating a new session never clears it. `/cancel taskId` and `/result taskId` in routing mode may address another workspace's task in the same authenticated conversation, preserving cross-user denial. Pure routing controls reject attachments. No message aggregation, implicit task replay, arbitrary shell, new listener or permission escalation is introduced.

## Image processing

Weixin images are downloaded without auth headers from the fixed HTTPS Tencent CDN host, with no redirects, a 20-second timeout and byte limits, then decrypted using the supplied AES-128-ECB key. URL/key material remains in memory. Staged files enter the same local image pipeline. Read local files with O_NOFOLLOW, reject symlink components and non-regular files, and bound actual bytes rather than trusting metadata. Defaults: 10 MiB per image, 20 MiB aggregate, 20 million pixels per image and 40 million aggregate; four images maximum. Decode serially to bound memory. Metadata and full decode must both pass; HTML/SVG/executables, corrupted payloads and animations are rejected.

Copy validated original bytes into a private random task directory, write `.part`, then rename atomically. Record SHA-256, MIME, dimensions and length. Re-read and verify hash immediately before Agent execution. Pi receives native Base64 image blocks; Codex receives controlled absolute files through `--image`, including after `resume`. There is no OCR fallback or task replay after a visual failure.

Only terminal/inactive task media is eligible for retention cleanup. Active inputs survive TTL. Uncommitted partial files are removed after interruption. This controls file transport, not semantic model vision accuracy.

## Personal Weixin transport

`transport` is `local` by default for compatibility, or `weixin` for personal ClawBot. `start.sh` dispatches by this setting. Use separate state roots; a transport binding prevents old local jobs being delivered to Weixin or vice versa. The authenticated bot/user pair is pinned in metadata before starting any worker or outbox pump.

The same Weixin state may switch between configured Codex and Pi backends through `start.sh --backend codex|pi`. This preserves transport/account identity, the receive cursor and message deduplication while retaining separate backend conversations. Explicit backend selection is required to replace an instance using a different configuration file; state, workspace and actor must match. Unfinished jobs belonging to another backend prevent switching both before and after shutdown. A switch never transfers or reruns those jobs.

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

SQLite WAL + synchronous FULL + foreign keys + bounded busy timeout. One stateRoot instance lock. Schema version 3 contains metadata, sessions (including last_response_at), jobs, outbox and routing_state. New state creates the current tables directly; no data migration is provided. Atomic transactions cover reserve/dedup/capacity, worker claim, and terminal status/result/outbox creation.

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

## Host management commands

The verified paired user (or trusted local operator) may propose `/update` or `/restart`, then confirm with `/approve` in the same conversation. These are fixed host operations, not Agent shell tools or sandbox escalation. A stable parent supervises `cli start`, drains admitted work, retains a durable operation record and replaces the bridge child. The child reports readiness through an inherited IPC pipe; no network listener is added. Result delivery remains in the existing outbox and unknown delivery remains unknown. Runtime artifacts have a private backup during update; source state is not reset and interrupted operations never auto-rerun. Directory approval remains scoped and accepts `/approve` as an alias for explicit consent.

## Remote diagnostics

`/debug [task-id-or-prefix]` bypasses the planner and worker. It reads only tasks owned by the normalized conversation, returns bounded routing diagnostics and delivery aggregates through the existing outbox, and performs one bounded native scan per distinct current/listed workspace after catalog revalidation. It never changes bindings, resumes work or retries delivery. As the next message it consumes pending consent without granting it. Request-time diagnostics are persisted in job input, including failed routing; old jobs explicitly have no snapshot. Current observations cannot establish historical causes. Files are identified only by truncated SHA-256 fingerprints, with at most eight error samples per scan and six recent scan records per request. Original history verification and fail-closed execution rules are unchanged.
