# Testing

Maligator uses three cumulative test tiers. The two-minute check is the normal
developer gate. The smoke tier is primarily an early fuse inside larger runs,
and the full tier is exhaustive rather than interactive.

## Tiers

| Tier  | Command              | Policy                  | Intended use                                                                                  |
| ----- | -------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| Smoke | `npm run test:smoke` | Bail, 30-second fuse    | Fast compiler/native/Test262/WPT cross-section                                                |
| Check | `npm run test:check` | Bail, about two minutes | Default local and pre-push gate                                                               |
| Full  | `npm run test:full`  | Bail, unbounded         | Self-hosting, complete native coverage, standards matrices, sanitizers, collectors, and leaks |

`test:check` excludes every entry in `tests/test-suite-unit-full-only.txt`. The current
entry, `tests/toolchain.test.ts`, creates fake C/Rust toolchains and repeatedly
exercises subprocess discovery, capability probes, cache invalidation,
corruption recovery, and concurrent publication. It is valuable infrastructure
coverage but costs roughly 25 seconds and belongs in the full gate.

The full gate runs the self-hosted frontend, native-build, and CLI checks before
the broad native and standards matrices. The much slower whole-compiler
differential follows the two-minute matrix, before the remaining exhaustive
lanes. This keeps fast self-host transfer failures high in the fail-fast order.

The smoke fuse measures its cumulative stages and fails if they exceed 30
seconds. It does not kill a native build in progress because terminating an npm
wrapper can orphan compiler descendants. The budget is a warm developer target;
a cacheless native or Test262 bootstrap can exceed it and is reported as a fuse
failure rather than being silently excluded from the measurement.

## Policies

The suite and standards runners accept two policies:

- `bail` stops scheduling work after the first unexpected failure and is the
  default for `test:smoke`, `test:check`, and `test:full`.
- `complete` traverses the selected corpus, writes complete reports, and returns
  nonzero after reporting failures.

Use completion commands when coverage numbers matter:

```sh
npm run test262:report
npm run test:wpt:report
npm run test:wpt:matrix-report
npm run test:full:report
```

`test262:report` runs the authoritative compiled/normal corpus without updating
the committed baseline. `test:wpt:report` runs every currently curated WPT in
compiled/normal mode. `test:wpt:matrix-report` explicitly requires normal and
GC-stress execution on both backends, rather than relying on each manifest
entry's defaults. `test:full:report` completes every full-gate stage and all
backend/GC correctness dimensions even if an earlier stage fails. Test262 writes
dimension-specific strict, sloppy, and combined reports under
`.cache/mal-build/test262*/`.

Canonical report commands remove ambient `MAL_*`, `T262_*`, `WPT_ROOT`, Node
injection, sanitizer, allocator, and dynamic-loader dimensions before starting.
Test262 preserves the throughput-only `T262_COMPILE_WORKERS` and `T262_OBJCACHE`
settings. Explicit toolchain overrides such as `CC`, `CFLAGS`, and `RUSTFLAGS`
remain supported and are part of native cache identity. Use explicit `--backend`
and `--mode` arguments when requesting non-default Test262 dimensions.

Plain `npm run test262` is the explicit baseline-update command and may rewrite
`scripts/test262.json`. Both it and `npm run test262:report` traverse the full
corpus; ask before running either command, `test:full`, or `test:full:report`.

## Full Matrix

The exhaustive standards matrix is:

| Backend     | Runtime mode                      |
| ----------- | --------------------------------- |
| Compiled    | Normal                            |
| Interpreted | Normal                            |
| Compiled    | `MAL_GC_STRESS=1 MAL_GC_VERIFY=1` |
| Interpreted | `MAL_GC_STRESS=1 MAL_GC_VERIFY=1` |

Normal and GC-verification executions reuse the same backend binary. The full
gate additionally runs the targeted GC suite under non-generational and
concurrent collector builds, the platform sanitizer lane, and the macOS leak
audit. "Full WPT" means every test in the pinned server-runtime curated corpus,
not the complete browser WPT repository.

"Complete native coverage" means every authored `tests/native/**/*.test.ts`
file, the Rust runtime unit suite with `node-zlib` enabled, and the explicitly
targeted collector, sanitizer, and leak lanes. It does not mean a Cartesian
product of every native file with every backend and GC build configuration;
tests declare or drive their relevant dimensions.

## Direct Lanes

Use direct lanes while developing a focused change:

```sh
npm run test:unit
npm test run
npm run test:native -- tests/native/example.test.ts
npm run test:sanitize -- tests/native/example.test.ts
npm run test:rust
npm run test262:regressions
npm run test262:regressions -- --backend interpreted --mode gc-stress
npm run test:wpt -- --test url/url-tojson.any.js --mode normal
```

`npm run test:unit` is the unit-only watch loop. Add `-- --run` for one-shot unit
execution; `npm test run` runs both Vitest projects once. The Rust lane is
full-only because it compiles the feature-complete crate. The full Test262 corpus
requires explicit approval; targeted filters and manifests do not.

Use `npm run test:help` for tier policy and
`npm run test:check -- --list` (or another tier) to inspect exact stage commands
without executing them. `-h`/`--help` is also side-effect-free on the Test262 and
WPT runners.

## Test Placement

| Behavior under test                                                                | Add coverage here                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure compiler, optimizer, serializer, planner, runner policy, or harness logic     | `tests/**/*.test.ts` outside `tests/native/`, in the Vitest `unit` project                                                                  |
| Generated C, VM/runtime behavior, host integration, backend parity, or GC lifetime | `tests/native/**/*.test.ts` with source fixtures in `tests/local/` or a named `tests/fixtures/` subtree                                     |
| ECMAScript behavior already represented upstream                                   | Rely on the full Test262 corpus; add the exact path to the check manifest only when it is a durable, high-signal regression                 |
| Small Test262 fuse coverage                                                        | Move a durable check path to `tests/test-suite-test262-smoke.txt`; smoke and check must remain disjoint                                     |
| Applicable upstream web behavior                                                   | Pin it in `tests/wpt/curated.json`, add exact expectations when necessary, and commit the unmodified source under `tests/wpt/fixtures/wpt/` |
| Host behavior not expressible by the curated WPT adapter                           | Add a native test, even when related WPT coverage also exists                                                                               |
| Sanitizer-sensitive native bug                                                     | Add a native fixture that can run through `npm run test:sanitize -- <file>`                                                                 |
| Shutdown, finalizer, or process leak                                               | Add focused opt-in coverage to `tests/native/leak.test.ts`                                                                                  |
| Product/compiler self-host transfer                                                | Add a `scripts/selfhost-*-check.ts` check and a fixture under `tests/fixtures/selfhost-*`                                                   |
| Slow milestone differential                                                        | Add or extend a focused `scripts/eval-*-check.ts` leaf command                                                                              |

Pure tests belong under `tests/`, not beside `src/`; unit and native discovery are
recursive and non-overlapping. A new native test enters the full tier by default.
Add it to a smoke or check manifest only when its signal and runtime fit that
tier's fixed budget. Add an unusually slow unit or subprocess integration test to
`tests/test-suite-unit-full-only.txt`; ordinary unit tests run in smoke/check.

Do not guess when a regression plausibly belongs in more than one lane, such as
Test262 versus native or WPT versus native. Ask the user which acceptance boundary
they want before adding the test.

## Maintaining Selections

- Smoke and check manifests must be deterministic, duplicate-free, and disjoint.
- `npm run test262:regressions` unions the Test262 smoke and check manifests, so
  the direct lane covers the same curated set as the cumulative check tier.
- Every Test262 manifest path must exist in the pinned corpus; missing paths fail.
- Test262 checkout and cache revisions must match `TEST262_METADATA.revision`.
  To advance the corpus, update that revision deliberately, run the approved
  baseline-update command, and commit the resulting `scripts/test262.json` change.
- WPT smoke/check manifests are disjoint curated subsets; the full tier reruns
  the complete curated backend/GC matrix in one report-producing invocation.
- Keep smoke to a broad semantic cross-section. Add a Test262 path to check only
  when the failure mode is costly, cross-cutting, recurrent, or otherwise more
  valuable than ordinary full-corpus coverage; novelty alone is not a reason.
- Keep expected failures out of smoke unless the expectation mechanism itself is under test.
- Benchmark `test:smoke` and `test:check` after changing their manifests.

Unit and native discovery are recursive. New `selfhost-*-check.ts` and
`eval-*-check.ts` scripts must be registered in `scripts/test-suite.ts`; suite
startup fails when one is present but unregistered, so a full-gate check cannot
be added silently. Test262 manifests reject empty or unknown selections. WPT
expectations and the committed fixture tree are validated against the complete
curated manifest before partial selections are applied.

## Manual Diagnostics

These investigation tools are intentionally not gates because they require a
fixture, answer an exploratory question, or analyze an existing cache:

```sh
node scripts/diff-compiled.ts tests/local/constant_fold.js --stress
node scripts/diff-script.ts tests/local/constant_fold.js --strict --stress
node scripts/test262-code-stats.ts --variant both --limit 30
```
