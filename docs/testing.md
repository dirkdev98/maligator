# Testing

Maligator uses three cumulative test tiers. The two-minute check is the normal
developer gate. The smoke tier is primarily an early fuse inside larger runs,
and the full tier is exhaustive rather than interactive.

## DX performance exercise

`npm run bench:dx -- <maligator-binary>` creates an isolated representative
Express, Drizzle, Valibot, SQLite, and TypeScript project. It reports cold and
warm `run` and `test` latency plus cold and cached `dev` readiness and a leaf-edit
restart. Use `--only run`, `--only test`, or `--only dev` for independent lanes,
and `--fresh-cache` to give the selected project a disposable empty user cache.
The generated project and optional fresh cache are removed afterward. Add
`--assets` after the binary to include the deliberately slower 100-file configured-
asset path; this is optional while development assets still require the native
toolchain.

The exercise records measurements rather than enforcing machine-specific timing
thresholds. Performance changes should compare the same binary, host, and cache
scenario before and after the change.

Every tier also writes its latest machine-readable gate report to
`.cache/mal-build/test-suite/report-<tier>.json`. It records exact stage wall times,
exit status, and native fixture spans for frontend work, C/Rust artifacts, generated
objects, linking, and execution, including cache hit/miss counts and the 20 slowest
spans. Vitest forks write process-local JSONL while running, so telemetry does not
serialize the native suite; reports count the contributing processes explicitly.
Test verdicts and program output are still always recomputed.

## Paired performance comparisons

Use a paired comparison for Maligator changes instead of reading a single delta
against the committed snapshot:

```sh
npm run bench -- javascript --compare HEAD --runs 5
npm run bench -- --changed --compare HEAD
```

The runner exports the requested Git revision to a temporary directory, verifies
that its lockfile matches the working tree, warms both trees, and alternates the
base/head execution order. `--changed` maps the Git diff to the smallest relevant
benchmark lanes. It starts with the requested number of pairs and may collect up to
15 while a result remains uncertain. The JavaScript family runs one deterministic
ES module through the probed production native plan across the closed/open x
compiled/interpreted matrix and records the exact compiler, target, optimization
flags, LTO, and strip decisions in its snapshot. The HTTP family runs the fully
closed compiled bare and Express servers. `--full` adds the slower fully closed
self-compile family.

Every classified metric reports the paired median change and a bootstrapped 95%
confidence interval. Wall time and throughput require a 3% effect; p99 latency,
RSS, and GC pause metrics require 5%; binary size requires 0.5% and at least 32 KiB.
The outcomes are `improvement`, `regression`, `unchanged`, and `inconclusive`. Only
a statistically supported practical regression returns nonzero. An inconclusive
result remains evidence to inspect, not a passing performance claim.

Raw reports are retained under `.cache/bench-comparisons/`. They include every
paired sample, metric direction, threshold, interval, source revision, selected
lanes, and environment identity. The comparison refuses different
`package-lock.json` contents rather than silently measuring different dependencies.
The base revision must contain the paired-runner support; use a recent checkpoint
when investigating older history.

## Cache ownership

Maligator bounds its shared user-cache artifacts without touching source,
the pinned Test262 corpus, committed baselines, or user output. Inspect usage
with `maligator cache status`; preview or apply reclamation with
`maligator cache prune --dry-run` and `maligator cache prune`. Explicit prune
targets 5 GiB and normally considers entries unused for at least one day. Above
twice the target it applies the per-family retention floors immediately, which
prevents a burst of content-addressed artifacts from filling the disk.

Build, test, standards, benchmark, and quality commands hold process leases.
Pruning refuses to run while any live lease exists, removes stale lease files
only after confirming their process is gone, and never caches test verdicts.
Cache hits touch their artifact directory so retention follows actual reuse.
Normal commands never inventory or evict the shared cache: a first build, run, dev,
or test therefore cannot inherit the cost of a recursive maintenance scan. Use
`--max-gb`, `--min-age-days`, and `--verbose` to tune or audit an explicit prune.
`maligator cache clear --all` removes every Maligator cache-layout generation
after the same live-command safety check, without retaining readers for old formats.
WPT removes its per-run native scratch tree on exit; pass
`--keep-artifacts` only when debugging generated sources or binaries.

## Tiers

| Tier  | Command              | Policy                   | Intended use                                                                                     |
| ----- | -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Smoke | `npm run test:smoke` | Bail, 20s warm / 4m cold | Minimal compiler, packaged development, Test262, and WPT capability proof                        |
| Check | `npm run test:check` | Bail, about two minutes  | All regular unit tests, curated wire/normal standards, and disjoint normal/UBSan native coverage |
| Full  | `npm run test:full`  | Bail, unbounded          | Self-hosting, remaining partitioned native coverage, standards, collectors, and leaks            |

Smoke and check own disjoint unit selections: the small
`tests/test-suite-unit-smoke.txt` manifest is the capability proof and check derives
the complete regular-unit complement. `test:check` excludes every entry in
`tests/test-suite-unit-full-only.txt`. The current
entry, `tests/toolchain.test.ts`, creates fake C/Rust toolchains and repeatedly
exercises subprocess discovery, capability probes, cache invalidation,
corruption recovery, and concurrent publication. It is valuable infrastructure
coverage but costs roughly 25 seconds and belongs in the full gate.

The full gate runs the self-hosted frontend, native-build, and CLI checks before
the broad native and standards matrices. The much slower whole-compiler
differential follows the regular check matrix, before the remaining exhaustive
lanes. This keeps fast self-host transfer failures high in the fail-fast order.

The standalone smoke fuse measures its cumulative stages and fails if they exceed
20 seconds on a warm run. It allows four minutes when the reusable native or
Test262 cache roots are missing. The cumulative check and full gates always allow
that four-minute smoke completion budget because preceding benchmark work can
evict an exact artifact while leaving the coarse cache roots intact. It does not
kill a native build in progress because terminating an npm wrapper can orphan
compiler descendants. Both budgets include cache population rather than silently
excluding it from the measurement.

Smoke and check compile their standards selections to cached MalW and execute
them in reusable standard runtimes. Full reruns the complete Test262 corpus and
curated WPT set through the authoritative compiled/normal path, then applies GC
stress only to representative curated selections. Manifest validation rejects
overlap, unknown paths, omissions from the curated WPT set, and duplicate stage
invocations.

Native coverage is also deliberately non-Cartesian. The explicit
`tests/test-suite-native-sanitizer.txt` manifest owns files with elevated C/Rust UB
risk: allocator and GC lifetime, suspended or re-entrant work, untrusted byte and
buffer boundaries, interpreter memory access, and native FFI services. Those files
run under UBSan on macOS and ASan+UBSan elsewhere; every other authored native test
runs once in the ordinary native dimension. The sanitizer runner uses two Vitest
workers by default while bounding nested native compilation to half the available
CPUs. Files whose dominant check already applies maximal GC stress and verification
remain in the normal dimension instead of multiplying both expensive instruments.
Smoke, check, and full retain a complete disjoint partition, so semantic API
breadth is not recompiled under a sanitizer without an ownership-risk reason. A test
belongs in both dimensions only through an explicit focused command for a
mode-sensitive regression.

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
compiled/normal mode. `test:wpt:matrix-report` remains an explicit diagnostic
that requires normal and GC-stress execution on the compiled and interpreted
backends; it is not part of the routine full gate. `test:full:report` completes
every full-gate stage even if an earlier stage fails. Test262 writes
dimension-specific strict, sloppy, and combined reports under
`.cache/mal-build/test262*/`.

Canonical report commands remove ambient `MAL_*`, `T262_*`, `WPT_ROOT`, Node
injection, sanitizer, allocator, and dynamic-loader dimensions before starting.
Test262 preserves the throughput-only `T262_COMPILE_WORKERS` and `T262_OBJCACHE`
settings. Partial selections cache their compiled batch objects by default. A
complete corpus defaults to bounded per-worker scratch because retaining both
strict and sloppy object sets can consume tens of GiB while the command is active;
set `T262_OBJCACHE=1` explicitly to retain them when sufficient disk is available.
After each partial pass, Maligator trims that strictness/backend object-cache
dimension to 1 GiB by least-recent use, removing an object's manifest and bytes
as one entry. ProgramImages remain in their independently bounded compiler-generation
cache.
Explicit toolchain overrides such as `CC`, `CFLAGS`, and `RUSTFLAGS` remain
supported and are part of native cache identity. Use explicit `--backend` and
`--mode` arguments when requesting non-default Test262 dimensions.

Plain `npm run test262` is the explicit baseline-update command and may rewrite
`scripts/test262.json`. Both it and `npm run test262:report` traverse the full
corpus; ask before running either command, `test:full`, or `test:full:report`.

## Full standards policy

The full gate uses these deliberately non-Cartesian standards dimensions:

| Selection                   | Backend  | Runtime mode                      |
| --------------------------- | -------- | --------------------------------- |
| Complete Test262 corpus     | Compiled | Normal                            |
| GC high-risk strict/default | Wire     | `MAL_GC_STRESS=1 MAL_GC_VERIFY=1` |
| GC sloppy eval/environment  | Wire     | `MAL_GC_STRESS=1 MAL_GC_VERIFY=1` |
| Complete curated WPT set    | Compiled | Normal                            |
| WPT smoke cross-section     | Wire     | `MAL_GC_STRESS=1 MAL_GC_VERIFY=1` |

Wire executions cache compiler artifacts but always execute every selected test
in a fork-isolated standard runtime. The full gate additionally runs the targeted
GC suite under non-generational and concurrent collector builds and the macOS leak
audit. Native sanitizer coverage is already part of the disjoint smoke/check/full
partition. "Full WPT" means every test in the pinned server-runtime curated corpus,
not the complete browser WPT repository.

The Test262 GC dimensions preserve collection at every gated safepoint in the
selected program. While that program invokes runtime compilation, the self-hosted
compiler uses `MAL_EVAL_GC_STRESS_INTERVAL=1000`; its dedicated native root-safety
test uses the same cadence. This avoids thousands of full heap verifications per
eval without weakening stress once the generated entry starts executing.

Test262 stores one integrity-checked, backend-neutral ProgramImage for each
source, corpus revision, strictness, semantic configuration, and compiler identity.
Compiled batches emit native C from that artifact; wire runs derive MALW from the
same artifact and use the shared runtime-image store. A warm run therefore skips
parsing, semantic analysis, optimization, and lowering without caching a test
verdict or execution output. Corrupt or stale artifacts are removed and rebuilt.

The Test262 GC spine is risk-based rather than a second semantic regression pass.
Its manifest names async/suspended frames, iterator cleanup, eval/private/super
environments, realm wrappers, detachable/resizable backing stores, weak and
finalization edges, re-entrant callbacks, and Rust-backed RegExp/Intl/Temporal
handles. Default cases run once under strict parsing; a separate three-case sloppy
manifest pays for the second frontend only where eval/environment semantics differ.
The former 254-case smoke+check stress matrix remains available on demand as
`npm run test262:gc:broad`; run it after changing the collector or root contracts
and before deliberately revising the spine.

"Complete native coverage" means every authored `tests/native/**/*.test.ts` file
in its owning normal or sanitizer-primary dimension, the Rust runtime unit suite
with `node-zlib` enabled, and the explicitly targeted collector and leak lanes. It
does not mean a Cartesian product of every native file with every backend and GC
build configuration; tests declare or drive their relevant dimensions.

## Direct Lanes

Use direct lanes while developing a focused change:

```sh
npm run test:unit
npm run test:unit:full-only -- --run tests/toolchain.test.ts
npm test run
npm run test:native -- tests/native/example.test.ts
npm run test:sanitize -- tests/native/example.test.ts
npm run test:rust
npm run test262:regressions
npm run test262:prepare
npm run test:wpt -- --test url/url-tojson.any.js --mode normal
```

`npm run test:unit` is the unit-only watch loop. Add `-- --run` for one-shot unit
execution. It excludes application fixtures and the slow tests listed in
`tests/test-suite-unit-full-only.txt`; use `test:unit:full-only` to run one of
those directly. `npm test run` runs both regular Vitest projects once. The Rust lane is
full-only because it compiles the feature-complete crate. `test262:prepare` is
the only Test262 command that clones, fetches, or checks out the pinned full
corpus. All execution commands consume that cached checkout read-only and name
this recovery command when it is absent or stale. The full Test262 corpus
requires explicit approval; targeted filters and manifests do not.

The native harness shares persistent frontend, generated-object, runtime, and
linked-binary caches. `buildBackendPairFromOneProgramImage` goes further: one
in-memory optimized image feeds native emission while its interpreted half runs as
MALW through a reusable development runner, avoiding a second generated object and
link. Use that helper for ordinary compiled/interpreted parity. Custom C drivers,
the `$262` test host, exact embedded-interpreter/link behavior, and other native
boundary tests keep explicit binaries. Script-goal, profiled, and custom-type-stripper
fixtures retain their explicit frontend behavior.

Native tests in `tests/test-suite-native-loopback.txt` require permission to bind
an ephemeral loopback port. The Vitest wrapper probes `127.0.0.1:0` before those
selections and reports a sandbox error early when `listen(0)` is denied.

Use `npm run test:help` for tier policy and
`npm run test:check -- --list` (or another tier) to inspect exact stage commands
without executing them. `--plan=json` adds machine-readable CPU, approval, sandbox,
and user/npm/Cargo cache requirements. `npm run env:check -- --json` probes those
paths and loopback binding, then reports current CPU and active Maligator commands;
heavy work may be deferred when busy, without an execution lock. `-h`/`--help` is
also side-effect-free on the Test262 and WPT runners.

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
- Curate the Test262 regression manifests manually. Baseline updates, full-suite
  reports, and newly passing tests must never add or remove entries automatically.
- `npm run test262:regressions` unions the Test262 smoke and check manifests, so
  the direct lane covers the same curated set as the cumulative check tier.
- Every Test262 manifest path must exist in the pinned corpus; missing paths fail.
- Test262 checkout and cache revisions must match `TEST262_METADATA.revision`.
  Run `npm run test262:prepare` to populate or repair the cached full corpus;
  never vendor upstream Test262 files. To advance the corpus, update that revision
  deliberately, run the approved baseline-update command, and commit the resulting
  `scripts/test262.json` change.
- WPT smoke/check manifests are disjoint curated subsets; the full tier reruns
  compiled/normal across the complete curated set and GC stress on the smoke
  cross-section.
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
