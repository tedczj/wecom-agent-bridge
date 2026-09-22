# Development rules

This bridge supports personal Weixin ClawBot via Tencent iLink and local CLI/JSONL, with Codex and Pi backends. Enterprise WeCom is not implemented. README.md and docs/DESIGN.md define current behavior. docs/IMPLEMENTATION.md records implementation choices; docs/verification.md records actual evidence; docs/PRIVACY.md records publication boundaries.

- Work on dev. Never force-push or update main without an explicit request.
- Run npm ci and npm run check when installation is available. Record failures and offline dependency provenance honestly.
- Default tests are offline and model-free. Tests/fakes are not production backends. Never label fake tests as live Agent, visual, OS-isolation, or macOS verification.
- Codex exec success requires valid thread/turn events, final assistant text, turn.completed, successful process exit and cleanup. Pi completion is agent_settled, not prompt ACK or agent_end.
- Never auto-rerun interrupted work. Cancellation must stop execution or block the workspace. Keep execution and output delivery separate.
- Keep session ownership, deduplication, image budgets, FIFO and crash recovery. Trace all original 58 IDs using docs/TEST_MATRIX.md; retired channel-specific cases must remain explicit.
- Preserve local request identity. Do not introduce a network listener, arbitrary shell arguments, automatic approvals or full-access sandbox flags.
- Keep current documentation consistent; replace superseded claims instead of stacking contradictory follow-up reports. Preserve all original 58 acceptance IDs and distinguish offline doubles, live Agent checks, and live Weixin delivery.
- Weixin accepts only the QR-paired user and bot, using HTTPS long polling. Never log bot/context tokens, raw frames or media URLs/keys. Keep cursor persistence, deduplication and unknown-delivery semantics; no blind retries of sends.
- Never commit authentication, local config, images, runtime state, model output or API keys. Do not inherit process.env wholesale.
- Process-group exit does not prove detached daemons or external side effects disappeared. cwd and prompt instructions are not OS isolation.
- Keep LICENSE attribution and upstream revision citations. Smoke scripts require --live and report unverified capabilities explicitly.
