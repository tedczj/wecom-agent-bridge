# Local Agent Bridge — three-layer runtime

Both personal Weixin ClawBot and local CLI/JSONL use `HierarchicalBridge` exclusively. Enterprise WeCom is not implemented. There is no legacy Bridge, Router, intent interpreter or history scanner fallback. Missing configuration and incompatible controller capability evidence refuse startup.

## Requests and roles

`RequestStore` persists decoded original text and attachment identity before planning. The Bridge controller resolves an authorized directory, then delegates that exact stored request to its persistent Route controller. Route decides whether to read history or submit business execution. Controllers have host-defined tools and cannot execute commands. Slash controls use the same durable host state without invoking a model.

Project names and aliases take priority over recursive discovery. Discovery is confined to `~/workspace`, intersected with authorized roots. Directory search pages are scoped to conversation, query and configuration and resume across requests. An external directory proposal must appear as an absolute path in the original request. A grant requires explicit same-conversation consent after complete delivery of the question, with expiry, physical identity and profile revalidation.

Optional `routing.fallbackWorkspace` names a configured, authorized workspace for requests without a resolved project or applicable active business conversation. Bridge receives its reference from `list_directories` and delegates general questions and image-only inputs as work; Route executes them in the selected business session. Later text retains image context through native session continuation, without copying historical attachments. Explicit targets, forced selections and business continuations take priority. Fallback does not bypass genuine directory ambiguity, authorization or specific-project history lookup. Unconfigured fallback retains directory clarification.

Progress queries such as “看下 term4u 项目里在干啥” reach that directory's Route verbatim. Route reads native business session messages progressively and reports coverage limits; it need not scan all native history before answering. Session follow-ups refer to that native session unless the user explicitly asks about Weixin management chat. Session roles are persisted in the Bridge catalog; interaction summaries and handoff records preserve the reply's producer role. A Route recap cannot serve as a native Agent reply. Query focus and active execution workspace remain distinct. No business job or successful-response clock update is caused by reading history.

## Models and sessions

The fallback business profile and Bridge default to `gpt-6-sol / high`; Route inherits Bridge and recap defaults to the same profile. Window capacity remains explicitly configured and verified by runtime evidence. Business model precedence is request > explicit session preference > directory > daily, tracked per field. Business overrides never mutate management profiles.

Business networking uses the configured `codex.networkAccess` flag: enabling it selects live native web search and permits networking in the workspace-write execution profile. Disabling it removes native web search and retains restricted command networking. Bridge/Route management tools remain restricted, with web search disabled. The live search setting follows the [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference#web_search).

`ControllerManager` owns separate Bridge/Route generations, native references and runtime usage. Usage at 80% requests a new session with a bounded handoff; raw answers are not exposed to Bridge. Unknown usage or incomplete capability evidence blocks rather than enabling a fallback. Controller initialization is lazy.

`BusinessSessions` validates native ownership, directory/profile identity, completion and writer readiness. Binding takes priority over discovery; automatic reuse requires a successful response within 24 hours. Explicitly selected older history is verified before use. Historical text and images are never injected into the current business prompt.

## State and queue

SQLite v4 stores original requests, controller sessions, business bindings/effects, answer artifacts, summaries and scoped query cursors. Only an empty store can initialize v4; a populated old store is rejected unchanged. There is no conversion or import path. A deliberate fresh start deletes instance history after intake stops and pending tasks/deliveries are resolved, preserving Weixin pairing and transport receive position separately.

Ingress is deduplicated by authenticated transport identity. One FIFO business worker owns each instance. Global and conversation queue limits are checked before media preparation. Cancellation interrupts the actual runtime; uncertain cleanup blocks further work. Restart revalidates persisted directory/profile/selection/effect snapshots before running queued work and never reruns interrupted work.

Immutable answer artifacts carry completion evidence. Recaps and delivery are separate stages; summary failure cannot fabricate successful completion. Unknown send acknowledgement is never blindly retried. Same-user physical-directory locks supplement per-instance locking but are not OS isolation.

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

`orchestration/debug.ts` reads scoped saved requests, tool audits, execution, artifacts, recap and outbox metadata. It never reads native history, invokes models or retries work. Query/answer bodies, paths and transport credentials are excluded.
