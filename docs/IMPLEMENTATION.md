# Implementation choices

## Shared execution and delivery

Both transports use the same Bridge, SQLite Store, MediaStore and durable outbox. Local frames are normalized against the configured actor; Weixin frames are checked against the QR-paired bot/user before they can reach the Bridge. Transport and account identity are pinned before worker startup. v1 state is rejected, and existing tasks are not translated across transports.

Execution completion and message delivery are separate. An uncertain Agent stop blocks future work; an uncertain send becomes `unknown` and is not automatically repeated. `/result` reads saved output without invoking an Agent. Each stateRoot owns a single worker and instance lock; execution additionally uses a canonical workspace device/inode lock shared by same-user bridge instances across state roots. An uncertain execution retains the lock until operator review.

## Personal Weixin

The adapter uses native fetch and the iLink protocol directly. No OpenClaw runtime or enterprise WeCom SDK is installed. Runtime packages are sharp for image validation and qrcode-terminal for local QR rendering.

API requests use restricted HTTPS origins, no redirects, bounded bodies and deadlines. `getupdates` and `sendmessage` accept omitted or numeric-zero success codes, reject malformed or nonzero codes, and handle expired authentication separately. This distinction was verified against an authenticated live response and is covered by W13/W14.

Incoming uint64 message IDs remain strings. Accepted requests are durable before their poll cursor is saved; redelivery passes through deduplication. Image URL/key material stays in memory, while staged private files pass through the existing decode/hash/budget checks. Voice uses only the supplied transcript. Files, video, quotes and voice without transcription receive explicit responses instead of partial execution.

Text replies use the paired owner's latest context token and the durable outbox. Weixin does not send the local transport's preliminary receipt; the persisted final/control result is the reply. No raw frames, auth/context tokens or model output are written to diagnostic logs.

## Agent backends and lifecycle

Codex uses the installed CLI's exec JSONL protocol, with an explicit working directory, sandbox and thread ID on resume. Successful completion requires ordered events, final assistant text, turn.completed, exit 0 and confirmed owned-process-group cleanup. Temporary EPERM during teardown is accepted only after the group actually disappears. Forced cancellation remains interrupted because side effects may exist.

Pi uses the installed RPC executable and waits for agent_settled. Extensions cannot auto-approve UI requests. Pi requires operator-verified external isolation; POSIX process-group control supports macOS/Linux, not Windows process-tree management.

`start.sh` installs missing/mismatched dependencies, builds, validates the previous instance's PID/start time/command/lock token, stops that instance and execs the selected transport. `--backend pi` selects the private Pi Weixin config; `--backend codex` selects the default config. An explicit config must match the requested backend. Cross-config replacement additionally requires explicit backend selection and matching canonical state/workspace paths, workspace ID, actor and transport. Foreign-backend unfinished jobs are checked before stopping and again after shutdown, including when only a stale lock remains. It uses TERM then bounded KILL escalation, without clearing Agent process markers or acknowledging side effects. A mismatching live PID is not killed. Shared Weixin state preserves authentication, cursor and deduplication; backend-specific session keys and homes keep conversations separate.

## Protocol sources and validation boundaries

- Tencent/openclaw-weixin: [`24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`](https://github.com/Tencent/openclaw-weixin/tree/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c), API/auth/media types and [protocol guide](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol_zh_CN.md). Compatibility headers use the inspected 2.4.9 version; bot_agent identifies LocalAgentBridge/0.2.0. These client observations are not an immutable server contract.
- OpenAI Codex protocol baseline: `639d2478cc2e16d6ca715952d2e726a3aecc024e`, sdk/typescript/src/exec.ts, sdk/typescript/src/events.ts and codex-rs/exec/src/cli.rs.
- Adapter code was independently written; upstream implementation source was not copied. Dependency licenses and this repository's LICENSE remain in force.

Offline tests launch deterministic child doubles; they do not establish real model quality, visual correctness or OS sandbox enforcement. Actual evidence and its limits are recorded in [verification.md](verification.md).

## Directory routing implementation

Routing is opt-in through operator roots/profiles/workspaces. The implementation uses one Store and one worker rather than mutable per-request global backend configuration: each job stores a directory identity and configuration digest, and dispatch constructs an immutable backend from the validated target profile. Media and outbox remain shared and retain their original budgets and delivery semantics. Schema v3 adds nullable successful-response timestamps and a scoped routing state table via an atomic v2 migration.

Natural controls use bounded deterministic forms, with an optional HTTPS JSON classifier for other expressions and ambiguous candidate descriptions. The classifier gets no execution capability. Host code performs directory traversal, native history reading, state selection and final authorization. No production fake backend is introduced. Local routing identity is pinned separately from the selected backend; startup validates pending routed profiles before replacing an instance.

Directory pages retain BFS queues and accumulated candidates in private SQLite state. History pages retain pending files and filtered entries. Snapshot/continuation lifetime is 15 minutes, scoped to conversation and configuration digest; matching list results also paginate in tens. Directory metadata reads are capped at 16 KiB/file (8 KiB combined description); native files at 8 MiB/file, 32 MiB/page, 100 entries/page and a cooperative 2-second budget. Directory pages allow 200 entries and depth windows of eight, with cooperative time checks. Very wide trees (>10,000 pending entries) or unsupported files fail explicitly rather than claim absence. Local filesystem syscalls are not an OS-enforced hard deadline.

Native format source inspected locally for this change: OpenAI Codex revision `50d77959bf927293c4b5ddcca81d05331ae582ea`, `codex-rs/protocol/src/protocol.rs` (session_meta, task_started/task_complete aliases, final message) and `openai_models.rs` (reasoning effort); Pi revision `95fbc04997eaee961eb673fa7923e9220609ebd5`, `packages/coding-agent/src/core/session-manager.ts` (v3 header/parentId branch). Source inspection is separate from live compatibility verification. Pi timestamps remain unknown unless this bridge observed a complete successful turn.

Routing aliases record explicit/selected provenance and invalidate on path identity or authorization changes. This is the directory-memory subset; the larger generation/summarization/deletion lifecycle in BRIDGE_MEMORY_DESIGN.md remains a separate design. The untracked external architecture report is not an implementation authority for this patch.
