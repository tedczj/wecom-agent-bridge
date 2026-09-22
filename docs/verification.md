# Connected macOS verification follow-up

- Imported bundle commit: `92b38c3aa40ce86cd099f5e49dd4cc5aa9e69532`, fast-forwarded from `5d882cbbd6906678ca8f0728b3a1b0a14734d361` on `dev`.
- Bundle SHA-256: `58a041d9bed9d9c28398fd68d013599d1efa3b1d31e6690299ae53d416fba19e`; `git bundle verify` succeeded. All 31 entries in the original source manifest matched before local changes.
- Environment: macOS / Darwin arm64, Node v25.1.0, npm 11.6.2. This is separate from the original Linux evidence below and does not establish the CI Node 22.16 result.
- Fresh `npm ci --no-audit --no-fund`: exit 0, 14 packages installed from the committed lockfile. `npm ls --depth=0` confirmed sharp 0.34.1, TypeScript 5.8.3 and @types/node 22.15.33. See `evidence/macos-clean-install.txt`.
- Initial `npm run check`: exit 1, 90/91 passed. C06 truncated output returned `BACKEND_STATE_UNKNOWN` instead of `RPC_TRUNCATED_FRAME`. A targeted rerun reproduced the failure; temporary generated-code diagnostics identified `kill EPERM` during process-group termination. See `evidence/macos-check-initial.txt`.
- Fix: on a denied termination signal, wait within the existing cleanup grace period and require the process group to disappear. If it remains alive or cannot be confirmed absent, retain the marker and return `BACKEND_STATE_UNKNOWN`. No uncertain work is replayed, and permission errors are not treated as proof of cleanup.
- Added C19 regression cases for both group disappearance and persistent uncertainty after a synthetic signal permission denial. The latter must retain the process marker. The fake child exits naturally, and both cases confirm it has gone before test cleanup.
- Final `npm run check`: exit 0; typecheck, build and **93 tests passed, 0 failed/cancelled/skipped**. Includes the six real SIGKILL recovery stages and CLI/contract tests using offline doubles. See `evidence/macos-check-final.txt`.
- `npm run smoke:codex` without `--live`: expected exit 1 with `LIVE_OPT_IN_REQUIRED`; no model call. See `evidence/macos-smoke-opt-in.txt`.
- Final tested source snapshot: `source-manifest-macos.sha256`. The original `source-manifest.sha256` remains the immutable manifest of the delivered bundle and does not describe the local fix.
- No authenticated live Codex/Pi model calls, semantic vision checks, actual CLI sandbox enforcement or detached-daemon cleanup were tested in this follow-up. Offline test doubles do not establish those capabilities.

The following report is historical evidence from the bundle-producing environment; its installation, macOS and network limitations apply to that run.

---

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
