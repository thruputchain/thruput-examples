# Examples repository review

Reviewed on October 13, 2026, at commit `1359bed`.

## Overall assessment

There is good example code here, but the repository currently serves maintainers
better than newcomers. The strongest parts are the small Rust contracts,
meaningful tests, and realistic applications. The weakest parts are the learning
path, the distinction between examples and maintenance tooling, and documentation
that mixes current instructions with historical development records.

Improve organization and teaching material before doing a broad code refactor.
Much of the larger apps' complexity has a real purpose.

The review covered root and app documentation, small contracts and tests,
scripts, CI, the historical harness, and representative transaction and seeding
code. Fibonacci, Counter, and Events native tests passed: 12 tests, with the
separate Counter RV32 test correctly skipped. This used the existing development
environment, not a clean-machine installation.

## 1. The first-success path is buried — high priority

The root README starts with useful links and a contract catalog, then spends
most of its early sections on application dependencies, migration details,
hosting authentication, and acceptance tests. Rust prerequisites start at line
172 of the reviewed README; the first contract-build command is at line 215.

A new developer should quickly learn:

1. What must I install?
2. Which example should I start with?
3. What command do I run?
4. What result should I expect?
5. What should I change next?

The suggested reading order also jumps from Fibonacci into cross-contract calls
before the basic storage example.

Recommendation: make the main path **test a small contract → build it → interact
with it from TypeScript → try an app**. Offer three entry points: learn contracts,
learn the TypeScript SDK, and explore complete apps. Keep CI, hosting, migration,
and exhaustive test instructions below this path or in dedicated documents.

## 2. Small Rust examples need teaching material — high priority

There are 22 contract directories but only three contract READMEs: Speedex,
Stellar Account, and Swap Router. The complex examples have dedicated
explanations; the beginner examples generally do not.

The small examples are promising: Fibonacci has 49 source lines, Counter's
implementation has 51, and Events has 102. Their tests demonstrate actual calls,
state changes, errors, and events.

Recommendation: give each beginner example a short README with what it teaches,
prerequisites, an exact test command, expected results, source/test links, one
exercise, and the next example. Counter should teach initialize/read/increment
before introducing its concurrent browser app.

## 3. The step between Rust tests and full apps is missing — high priority

There is no clearly identified collection of small runnable TypeScript examples.
Developers instead encounter provisioning scripts, seed orchestration, or React
applications. The sibling SDK repository already has `chain-tip`,
`view-hog-balance`, `transfer-hog`, and `deploy-counter`, but these import SDK
source to exercise that checkout.

Recommendation: add a deliberate collection here using published packages,
coordinating with the SDK repository to avoid competing tutorials:

| Example | Teaches |
| --- | --- |
| Read chain information | Connect and make a read-only request |
| Read a balance | Addresses, typed views, token units |
| Transfer test HOG | Signer, funding, submission, receipt |
| Deploy and call Counter | Build, bindings, deployment, write, readback |
| Read emitted events | Query and decode events |
| Submit an atomic batch | Multiple calls and rollback |

Use direct scripts with explicit steps, not a new example-runner framework.

## 4. The scripts folder mixes audiences — medium/high priority

| Reviewed scripts | Actual purpose |
| --- | --- |
| `build-guest.sh` | Build all guest contracts |
| `check-contracts.sh` | Broad maintainer verification |
| `integration-tests.sh` | Counter/ERC20 RPC tests |
| `check-thruput-version*` | Tooling compatibility checks |
| `swap-test-guest.sh` | Swap guest tests |
| `swap-sim.sh`, `permit-live.sh` | Advanced live demonstrations/tests |
| `swap-gas-calibrate.sh` | Maintainer gas calibration |
| `speedex-bench.sh`, `speedex-plot.py` | Benchmarking and graphing |
| `seed/` | Shared Launchpad/Swap data provisioning and recovery |

These are mostly repository tools, not beginner example scripts. There is no
script index. Some scripts have useful headers, but working-directory and CLI
selection conventions differ. Calibration replaces normal artifacts with
instrumented ones. The Speedex benchmark temporarily edits a Cargo manifest and
leaves a specially configured artifact.

Recommendation: distinguish small client examples in `examples/`, app-specific
tools in `apps/*/scripts/`, and maintenance/build/benchmark scripts in `scripts/`.
Give shared app seeding an explicitly app-related location or label. Add a script
index with prerequisites, commands, and side effects. Avoid moving files merely
for visual symmetry.

## 5. Preserve useful complexity; review the seeder separately

Keep network/account checks, exact transaction-hash tracking, recovery after
uncertain submission, receipt/event verification, public-read/wallet-signing
boundaries, and generated bindings. Launchpad's provider write boundary already
delegates execution to the SDK rather than rebuilding it.

The shared seeder deserves closer scrutiny: `scripts/seed/seed.ts` is 651 lines,
imports both apps' internals, depends on Launchpad's registry, and uses signed
transaction journals, scoped state, locking, and durable filesystem writes.
`seed-journal.ts` recursively synchronizes directory ancestry.

First decide its promise. Disposable demo-data creation can be simpler; safe
resumption needs some of this machinery. Do not remove recovery while retaining
that promise. Narrow its purpose or classify it as advanced app infrastructure.

The Counter contract is introductory. The Counter app is a concurrent
transaction demo with workers, queues, signing policy, and observation. Label
that distinction rather than treating both as equally basic.

## 6. Separate current guidance from historical documentation

The reviewed `docs/` inventory contains 23 design/development records under
`docs/specs/` and `docs/superpowers/`, without a comparable beginner-guide
collection or documentation index. Some contain old branch instructions,
package versions, proposed architecture, and superseded commands.

Specific accuracy issues found:

- Events source describes non-32-byte topics as hashed; its test correctly
  distinguishes hashed strings from padded integer topics.
- The root test matrix omits Speedex even though later sections run its tests.
- The root README still names `groundhog-testkit`.
- App READMEs put architectural detail before setup and include long recorded
  Devnet deployments.

Recommendation: make current guides authoritative and visibly separate history.
Keep durable explanations; archive or remove completed plans that no longer help.

## 7. The historical TypeScript harness is misleading

`tests/token-factory-ts` documents client 0.4.0, CLI 0.10.4, and an older runtime.
Its generator builds contracts from the current workspace, then checks fixed
historical artifact hashes. It is not a self-contained historical snapshot and
its documented flow is not aligned with the current releases.

Recommendation: modernize it into a maintained integration example or archive it
with its matching source revision. A warning in the root README alone does not
make it a useful current example.

## 8. Agent instructions are missing — high priority

Neither `AGENTS.md` nor `CLAUDE.md` exists in the reviewed repository. Instructions
from the reviewer's global environment do not accompany a fresh clone.

Recommendation: use `AGENTS.md` as the concise source of truth, with `CLAUDE.md`
referring to it. Cover teaching goals, beginner/advanced entry points,
authentication, toolchain setup, focused commands, node/browser requirements,
generated files, state and signer files, and historical-document boundaries.
Explicitly discourage introducing a shared framework just to remove small
duplication.

## What to preserve

- Small contracts with readable tests.
- Native/RV32/RPC test distinctions.
- Simulation fixtures separated from teaching contracts.
- Consistent app commands and layouts.
- Realistic applications beyond happy-path transactions.
- Published SDK usage and reproducible dependency pins.

## Recommended order

1. Create the newcomer path and agent instructions.
2. Add short READMEs to the existing small examples.
3. Add a handful of published-SDK client examples.
4. Separate app tooling, maintainer scripts, and historical documentation.
5. Resolve the old harness and assess the seeder's scope.
6. Pursue specific app simplifications supported by evidence.

The repository needs smaller entry points, clearer labels, and a predictable
progression—not simply more examples or fewer lines of code.

## Agreed follow-up scope

Implement findings 1–4 and add agent guidance. Save this review as a historical
record. Defer findings 5–7 (complexity changes, historical-document cleanup, and
the old harness) for discussion. Review, test, and commit the work, then pause.

## Implementation record — October 13, 2026

- Added a shorter root learning path, `docs/getting-started.md`, and
  `docs/development.md`.
- Added `AGENTS.md` and a `CLAUDE.md` reference to the same instructions.
- Added guides for ten small contracts and the larger ERC20 example, with
  commands, expected results, source links, and exercises.
- Added six published-SDK client scripts under `examples/typescript/`, a
  generated Counter binding, and an isolated live runner used by CI.
- Documented repository tools and shared app seeding without moving or rewriting
  the seeder.
- Verified typechecking, 1,340 app/seed tests and three process-cleanup tests,
  all app builds, 64 native tests across the documented contracts, live client
  examples including rollback, repeatable binding generation, CLI version
  checks, formatting, and 150 local documentation links.

Findings 5–7 remain discussion topics. Historical records and the legacy
TypeScript harness have not been reorganized in this pass.
