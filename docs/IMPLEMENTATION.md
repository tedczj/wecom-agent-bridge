# Implementation choices

## Sole service path

`main.ts` always opens `ControllerFactory`, validates its binary/configuration/model proof, initializes v4 and creates `HierarchicalBridge`. It cannot create an old Bridge. Weixin duplicate lookup and staged-media completion use `orchestration_requests` and `mediaReady` exclusively. Restart/review no longer inspect a temporary classifier runtime.

Removed: `bridge.ts`, `debug.ts`, `routing/router.ts`, `routing/intent.ts`, `routing/codex-interpreter.ts`, `routing/history.ts`, and their classifier smoke scripts. Shared `routing/catalog.ts`, `config.ts`, `execution.ts`, `lock.ts`, native `history/`, Codex/Pi adapters, media and outbox remain.

Defaults are `gpt-6-sol / high` for business and Bridge; Route inherits Bridge and recap profile defaults to Bridge. The effective window is required explicitly. Per-request and explicit business-session model overrides preserve management models. Runtime evidence is tied to the actual selected model and effort.

`routing.fallbackWorkspace` optionally references an existing configured workspace; parsing rejects unknown IDs and Catalog retains all normal directory/profile checks. `list_directories` exposes `fallbackDirectoryRef`. Bridge/Route instructions delegate unassigned general questions and image-only messages to business, retaining native session continuity for follow-up text. Intent remains model-selected; offline doubles verify the host path and do not prove live routing semantics. Policy digest changes rotate existing management sessions through the normal handoff path.

The host passes the fallback session policy to `BusinessSessions.resolve` only for work targeting the configured fallback workspace. With no current binding or explicit historical candidate, it returns a default new option with reason `fallback-new` before any native-history scan. Existing bindings and explicit candidates retain their checks; sticky discovery/resume failures cannot be bypassed. This avoids making ordinary fallback conversation depend on unrelated external sessions already present in the same directory.

Session identity is persisted in `native_session_catalog`, keyed by backend home, backend and native ID. Bridge/Route/Recap creation records their management role. Business session persistence atomically records `business` before the first prompt; native discovery records unbound sessions as `external`, preserving `unknown` when present. These role records are metadata, not proof of completion or resumability. Management roles cannot be promoted to business and remain excluded from native listing and exact lookup. Interaction projections and controller handoff retain `producerRole` and business binding references; native message reads return the native ID and persisted role. A Route-written history recap remains Route output, even when it describes a business session.

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

Business Codex web search follows `codex.networkAccess`: true passes `web_search="live"`, false passes `disabled`, for both new and resumed turns. The existing sandbox/permission profile controls command networking separately using the same flag. Management controllers and the legacy routing-only invocation retain disabled web search. No additional configuration field or filesystem permission expansion is introduced.

For image-only Codex requests, exec rejects blank text through its required-stdin (`-`) path before creating a thread. The adapter passes `--` followed by the exact blank/whitespace text as the positional prompt when images are present, on both new and resumed turns; the separator prevents the CLI from parsing blank text as another image value. Nonblank text continues through stdin. No task wording is synthesized, and original query hashes and attachments are unchanged. The subprocess double also rejects blank required stdin and missing image/prompt separators to cover this native behavior.

Pi uses the installed RPC executable and waits for agent_settled. Extensions cannot auto-approve UI requests. Pi requires operator-verified external isolation; POSIX process-group control supports macOS/Linux, not Windows process-tree management.

`start.sh` installs missing/mismatched dependencies, builds, validates the previous instance's PID/start time/command/lock token, stops that instance and starts the stable supervisor with the selected transport worker. `--backend pi` selects the private Pi Weixin config; `--backend codex` selects the default config. An explicit config must match the requested backend. Cross-config replacement additionally requires explicit backend selection and matching canonical state/workspace paths, workspace ID, actor and transport. Foreign-backend unfinished jobs are checked before stopping and again after shutdown, including when only a stale lock remains. It uses TERM then bounded KILL escalation, without clearing Agent process markers or acknowledging side effects. A mismatching live PID is not killed. Shared Weixin state preserves authentication, cursor and deduplication; backend-specific session keys and homes keep conversations separate.

## Protocol sources and validation boundaries

- Tencent/openclaw-weixin: [`24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`](https://github.com/Tencent/openclaw-weixin/tree/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c), API/auth/media types and [protocol guide](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol_zh_CN.md). Compatibility headers use the inspected 2.4.9 version; bot_agent identifies LocalAgentBridge/0.2.0. These client observations are not an immutable server contract.
- OpenAI Codex protocol baseline: `639d2478cc2e16d6ca715952d2e726a3aecc024e`, sdk/typescript/src/exec.ts, sdk/typescript/src/events.ts and codex-rs/exec/src/cli.rs.
- Adapter code was independently written; upstream implementation source was not copied. Dependency licenses and this repository's LICENSE remain in force.

Offline tests launch deterministic child doubles; they do not establish real model quality, visual correctness or OS sandbox enforcement. Actual evidence and its limits are recorded in [verification.md](verification.md).

## Directory and history implementation

`Directories` owns exact-path grants, scoped aliases and persisted directory-search progress. `Catalog` intersects configured authorization roots with `~/workspace` for ordinary discovery. Exact names/aliases return before recursive metadata scanning. Explicit external paths retain authorization and private-path checks; model-proposed external paths absent from the raw query are refused. Grant approval requires every question part to be sent and rejects expiry, changed configuration or changed physical identity.

`ControllerManager` preserves Route native identity across same-directory progress queries. `route_delegate` forwards stored text without rewriting; history intent cannot authorize `business_execute`. `src/history/` reads metadata and bounded native pages on demand, separate from business execution. Read-only queries do not refresh business completion clocks. Controller tool results and prompts have scoped audit hashes.

Route interprets the original query using generic native-session pages; the host does not implement query-specific summary or reply extraction. Its read tool defaults to newest-first and also supports oldest-first, with direction- and revision-bound cursors; both orders retain the 10-message/16-KiB page budget. Same-directory queries retain their session reference in `queryFocus`, exposed by `list_business_sessions`; changing directories clears that reference. Native turn-order anomalies are reported on read-only pages without discarding visible messages. `ResumeVerifier` still rejects those histories before any execution, while path, scope, format and revision checks apply to both reading and resuming.

The former router/classifier tests were replaced with catalog/authority regressions and the shared hierarchical harness. CLI, Weixin, startup, cancellation and maintenance tests now use a deterministic three-layer controller executable plus offline business doubles. Synthetic capability files in test helpers apply only to those fake executables and do not prove live model capability.

## Approved service management

`/approve` is limited to the existing directory proposal and service-management proposals; Codex exec retains approval_policy=never and the configured sandbox. `/update` and `/restart` bypass model interpretation, persist an owner-bound question, and require a separate next-message `/approve` after confirmed question delivery. Confirmation and the queued management job commit together. Commands accept no shell arguments. Expired, ambiguous, foreign and undelivered approvals do not act; duplicate message IDs cannot repeat a restart.

`cli start` owns a persistent supervisor process. Its worker verifies the parent PID and private token; the token is not forwarded through agentEnvironment. After approval the worker rejects new work and drains existing FIFO tasks. The parent stops only the worker, performs fixed maintenance steps, waits for IPC readiness from the replacement, then records the final result in the normal outbox. Accepted acknowledgements and final results have distinct purposes. Unexpected manager loss closes worker IPC; abandoned management jobs fail on recovery instead of being replayed. Existing uncertain-Agent/review gates remain in force. Restart preflight validates the matching parent/child pair and accounts for an exited worker waiting to be reaped by a stopped parent.

Updates target the running installation and origin/dev only, preserve non-conflicting untracked files, and refuse tracked changes or non-fast-forward pulls. Generated runtime artifacts are saved privately before dependency installation/checks; failure restores these artifacts and leaves source history untouched. The running supervisor is a stable lifecycle controller across worker replacement; a complete external stop/start loads a newer controller implementation. Step failures report restricted codes rather than raw package/network output. Host subprocess environment is allowlisted, and model API credentials are forwarded only to the bridge worker as explicitly configured.

Design reference: NousResearch/hermes-agent revision [`42c1a93417fa588e735736a0740787ce37381ffd`](https://github.com/NousResearch/hermes-agent/tree/42c1a93417fa588e735736a0740787ce37381ffd), `gateway/slash_commands.py` (restart request ownership, update handoff and result notifications), `gateway/restart.py` (supervisor-aware lifecycle). This TypeScript implementation was written independently; it does not copy Hermes Python code, automatic agent continuation, or general shell approval behavior.

## Diagnostic command

`orchestration/debug.ts` exposes saved request metadata only, including controller tool names, execution, answer/recap and delivery status. It excludes original bodies, private paths and credentials and performs no native-history scan or model call.

### Hierarchical native project trust

Codex business execution in hierarchical mode passes a transient `projects={"<cwd>"={trust_level="untrusted"}}` override. This prevents the native workspace-write startup from persisting implicit project trust and loading project-local `.codex` configuration. The host sandbox/profile remains authoritative. The override is passed explicitly after Catalog removes management configuration, and its policy version participates in the business profile digest. CLI dotted keys do not parse quoted path components, so the path is encoded as a TOML inline-table key. Hierarchical initialization requires empty state; existing legacy bindings are not rekeyed or imported.
