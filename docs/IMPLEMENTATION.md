# Implementation choices

- The local normalizer and stdout channel replace the removed SDK-specific transport, not emulate enterprise-chat frames. Old credentials, remote URLs/AES descriptors and network smoke are absent.
- Codex uses the official CLI exec JSONL wire contract directly. This avoids adding an SDK dependency only to wrap the same executable and gives this adapter explicit process-group ownership, framing limits and sanitized stderr handling. No upstream source was copied verbatim into the new Codex implementation.
- Pi remains selectable with `backend: "pi"`; production factory no longer hardcodes Pi.
- Existing queue/session/outbox concepts are retained. Database version is intentionally incremented to 2; old tasks are never automatically migrated from a removed transport.
- Codex forced cancellation normally becomes `interrupted`, not `cancelled`, even when group termination succeeds. This is deliberate: exec has no acknowledged RPC cancel/settled handshake here, and prior effects or detached work cannot be assumed absent.
- The supported execution platform is POSIX (macOS/Linux). Windows fails explicitly; no false claim that killing one PID terminates the Windows process tree.
- Runtime dependency is only sharp. TypeScript and Node type definitions are development dependencies. The lockfile is pruned from the repository's original pinned-dependencies artifact, preserving registry URLs, integrity hashes and cross-platform optional sharp packages.
- Offline tests launch executable deterministic doubles under `tests/fakes/`; normal production code never selects a fake on its own. These validate protocol/process behavior, not the Codex binary's own sandbox or live model behavior.
- CLI examples and strict configuration are in README. Live smoke is opt-in and rejects invocation without `--live` before creating an Agent service.
- Original scope-specific tests are explicitly retired or mapped in TEST_MATRIX.md. Test success counts are execution evidence, not a percentage of production readiness.
