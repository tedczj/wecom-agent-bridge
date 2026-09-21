# Development rules

Use README.md for actual commands/config, docs/DESIGN.md for the complete original contract, and docs/IMPLEMENTATION.md for explicit implementation choices. Record real evidence in docs/verification.md.

- Work on dev; never force-push or update main without an explicit request.
- Run npm ci and npm run check. Default tests must stay offline and model-free.
- Keep 58 original test IDs traceable. Never weaken ACL, dedup, image limits, session ownership or crash recovery to make a test pass.
- Agent completion is agent_settled, not prompt ACK or agent_end. Never auto-rerun uncertain work.
- Keep executing and delivering separate. ACK timeout is unknown, not a reason to replay the task or blindly resend.
- Never commit .env, live frames, real media URLs/keys, auth files or runtime state. Only synthetic fixtures belong in tests.
- Do not inherit process.env wholesale into Agent processes; never auto-approve extension UI.
- Cancellation must stop actual execution or block the workspace. Filesystem isolation and detached-daemon cleanup are not proven by cwd or process-group exit.
- Pi is the only implemented backend. Codex and OCR need their own contract/live tests; do not add placeholders claiming support.
- Preserve upstream license attribution when copying code; prefer narrow protocol interfaces and installed SDKs.
