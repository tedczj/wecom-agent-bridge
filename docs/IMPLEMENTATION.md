# Implementation choices

## Shared execution and delivery

Both transports use the same Bridge, SQLite Store, MediaStore and durable outbox. Local frames are normalized against the configured actor; Weixin frames are checked against the QR-paired bot/user before they can reach the Bridge. Transport and account identity are pinned before worker startup. v1 state is rejected, and existing tasks are not translated across transports.

Execution completion and message delivery are separate. An uncertain Agent stop blocks future work; an uncertain send becomes `unknown` and is not automatically repeated. `/result` reads saved output without invoking an Agent. Each stateRoot owns a single worker and lock; there is no cross-stateRoot filesystem mutex.

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
