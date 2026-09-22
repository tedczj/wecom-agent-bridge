# Verification report — local Codex/Pi bridge

## Scope and exact baseline

- User request: remove enterprise-chat transport, add Codex, self-test, commit and push on dev.
- Remote base: `5d882cbbd6906678ca8f0728b3a1b0a14734d361`.
- Original Git tree: `40225e53f716a9b5b78e1627c7a13dd27a8a45e3`.
- Source and metadata were read through the connected GitHub API because direct Git networking fails in this runtime. The original tree and commit object hashes were independently reconstructed and matched exactly, preserving the true parent for the local development commit. This is not a claim of a full network clone.
- Inspected Codex protocol revision: `639d2478cc2e16d6ca715952d2e726a3aecc024e` in `openai/codex`; not an installed binary version.

## Actual executed results

| Check | Observed result |
|---|---|
| First final `npm run check` | Exit 0; typecheck, build, 91 tests passed; 0 failed, 0 cancelled, 0 skipped |
| Second final `npm run check` | Exit 0; same 91 tests passed; 0 failed, 0 cancelled, 0 skipped |
| Real child-process CLI tests | Included: Codex/Pi doubles, run/serve, images, thread resume, request dedup, read-only status/result, Ctrl-C and manual review |
| Real process crash tests | Included: six SIGKILL stages R01–R06, SQLite rollback, existing filesystem side effect, no automatic replay |
| `npm run smoke:codex` without --live | Expected exit 1, LIVE_OPT_IN_REQUIRED; no Agent call |
| Fresh `npm ci --offline --ignore-scripts` in empty install directory | Exit 1, ENOTCACHED; fresh installation was NOT completed |
| Git networking | `git ls-remote origin refs/heads/dev` exited 128: Could not resolve host: github.com |

Logs are in `docs/evidence/`. These are observed commands/results, not inferred from source presence or a prior CI green check.

## Dependency and environment provenance

Linux x86_64, Node v22.16.0, npm 10.9.2, TypeScript 5.8.3, @types/node 22.15.33, sharp 0.34.1. The exact pinned dependency versions used for the final two test runs came from this repository's existing Actions artifact, not a newly successful npm installation:

- Workflow run `35625256077`, artifact `10651677147`, name `pinned-dependencies`.
- Downloaded artifact SHA-256: `38584d7e8d9f6eebc60d3880084d8e5b95a702765712aa75078be0ed75301297`.
- The new lockfile is a dependency-graph pruning of the artifact's original lockfile, keeping only sharp, TypeScript, Node types and their required/optional dependencies. All 34 retained dependency entries preserve registry resolved URLs and integrity hashes, including macOS sharp variants.
- Runtime enterprise-chat SDK and its dependency graph were removed. No dependency archive, node_modules or binary package is included in the source commit.
- A new CI workflow runs npm ci and the offline suite on Linux and macOS. It has not run for this local commit because remote publication is unavailable here.

## Explicitly not verified

No real Codex or Pi executable was installed in this runtime. No authenticated model call, real model visual understanding, real code-generation quality, actual CLI sandbox enforcement, remote service side effect cleanup, detached-daemon cleanup or macOS execution was tested. No enterprise-chat tests were performed because that feature was removed by request.

The executable files under tests/fakes are deterministic offline protocol doubles. They create real child processes and controlled filesystem effects, but they are not Codex/Pi binaries and cannot validate those products' internal behavior. Native image byte transport was tested; semantic visual correctness was not.

The offline dependency cache is empty and direct Git/npm networking is unavailable. The failed clean-install command is retained rather than reported as a successful npm ci. A connected CI/local machine must verify a fresh installation from the committed lockfile.

Remote push is not established by this report. The separate delivery record must state the actual local commit and actual push attempt; no remote success should be inferred from the existence of a local bundle or Git commit.

## Safety and migration checks

No chat SDK, WebSocket, network media fetch/decrypt module, chat credentials template or chat smoke script remains. The original source paths src/wecom.ts and scripts/smoke-wecom.ts are deleted in the new tree. Legacy DB schema v1 is rejected, never migrated/replayed. Actor/session ownership, bounded image decoding, deduplication, one worker, atomic results/outbox, conservative interruption and explicit review remain enforced. Original 58 acceptance IDs are explicitly mapped or retired in TEST_MATRIX.md.

The immutable source manifest for the tested src/tests/scripts/package/configuration build inputs is `docs/source-manifest.sha256`; its SHA-256 is `8aa643e861c1684056499d22af329597a33027faae0ced651ff39602874bf7f9`. Documentation/evidence are excluded from that manifest to avoid self-referential hashes. Tests were not rerun against a different source snapshot after the final two successful runs.
