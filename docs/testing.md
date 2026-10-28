# Testing

Start with the [direct lanes](#direct-lanes) for the behavior you changed and
[test placement](#test-placement) when adding coverage.
[AGENTS.md](../AGENTS.md#verification) owns when to use focused checks, local gates,
and CI. This reference owns runner selection, flags, and evidence formats.
Performance commands live in [benchmarking.md](benchmarking.md); application
profiling lives in [profiling.md](profiling.md).

## Direct Lanes

Run the command that observes your change; these are independent examples:

```sh
npm run test:unit -- tests/platform-catalog.test.ts
npm run test:unit:full-only -- tests/toolchain.test.ts
npm run test:native -- tests/native/rest-forwarding.test.ts
npm run test:sanitize -- tests/native/gc.test.ts
npm run test:tsan -- tests/native/gc.test.ts
npm run test262:regressions
npm run test:wpt -- --test url/url-tojson.any.js --mode normal
```

Unit commands run once by default; add `--watch` for an explicit watch loop.
The regular unit project excludes application fixtures and the slow tests listed in
`tests/test-suite-unit-full-only.txt`; use `test:unit:full-only` to run one of
those directly. Bare `npm run test:unit` selects every regular unit file, and bare
`npm test` selects both unit and native projects; neither is a focused check.
The existing `run` and `--run` forms also work. `npm run test:rust` compiles the
feature-complete crate and belongs to the full tier. `npm run test262:prepare` is
the only Test262 command that clones, fetches, or checks out the pinned full
corpus. All execution commands consume that shared snapshot read-only and name
this preparation command when it is absent. A modified snapshot must be restored
before it can be used. The full Test262 corpus runs on CI after every push to `main`;
run targeted filters and manifests locally.

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

Optimization regressions must establish that their fixture selects or executes the
intended path, then verify observable behavior and relevant fallback cases. Prefer
named function/plan identities and executed-path counters over incidental function
indices or generated text. Require a counter to be positive when it proves coverage;
assert exact counts only when the count itself is the contract, such as a handcrafted
cache probe sequence. Semantic output checks already verify loop results.

Native global setup prepares the shared eval runtimes before timed hooks, including
the web-disabled variant only when its fixture is selected. Specialized runtimes
belong in preparation rather than consuming an execution timeout. Native Vitest tests
and hooks default to a 20-minute cold-build budget, because which file first builds a
runtime variant depends on scheduling and sharding. Child execution deadlines stay
bounded and scale for sanitizer and GC stress; distinguish runtime preparation,
fixture compilation, and execution in failure reports.

Do not guess when a regression plausibly belongs in more than one lane, such as
Test262 versus native or WPT versus native. Ask the user which acceptance boundary
they want before adding the test.

## Focused optimizer verification

When adding or changing a Core pass, check its integration contracts before the
normal gate:

```sh
npm run test:unit -- --run tests/core-pass-contracts.test.ts tests/core-optimizer-infrastructure.test.ts
```

Add the affected pass's existing unit file to that command, such as
`tests/core-memory-passes.test.ts` or `tests/rest-forwarding.test.ts`. These checks
cover registration uniqueness, analysis admission, profitability ownership, and
analysis invalidation without requiring a native build.

Then run the fixture that observes the affected behavior. For example:

```sh
npm run test:native -- tests/native/rest-forwarding.test.ts
npm run test:native -- tests/native/stack-object.test.ts tests/native/allocation-sinking.test.ts
```

Choose the relevant command, rather than running every example. Those fixtures
exercise backend parity and GC stress themselves. Add a focused
`npm run test:sanitize -- <file>` when changing C memory ownership or root lifetime.
`rest-forwarding` and `stack-object` currently belong to the full-tier native
complement; a successful `test:check` alone does not exercise them. Use
`npm run test:check -- --plan=json` or a tier's `--list` to inspect actual selection.
After cohesive work, batch type-check and lint, then rely on CI's complete check result
for the pushed checkpoint instead of running the gate locally. Without push authority,
report which focused lanes ran and what remains for CI. Focused full-tier fixtures
still run when relevant; a check pass does not replace them.

For a compiler representation failure, use the product CLI with `MAL_DEBUG=true`
and a self-contained fixture. A raw Test262 file may require harness includes;
reproduce it through `scripts/test262.ts --filter <path> --variant strict --policy bail`
instead of assuming it can be built as a standalone program. Add an explicit
backend/mode only when that dimension matters to the failure.

## Tiers

| Tier  | Command              | Policy                                 | Intended use                                                                                     |
| ----- | -------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Smoke | `npm run test:smoke` | Bail, 20s warm / 15m cold at 4 workers | Minimal compiler, packaged development, Test262, and WPT capability proof                        |
| Check | `npm run test:check` | Bail                                   | All regular unit tests, curated wire/normal standards, and disjoint normal/UBSan native coverage |
| Full  | `npm run test:full`  | Bail, unbounded                        | Self-hosting, remaining partitioned native coverage, standards, collectors, and leaks            |

Smoke and check own disjoint unit selections: the small
`tests/test-suite-unit-smoke.txt` manifest is the capability proof and check derives
the complete regular-unit complement. `test:check` excludes every entry in
`tests/test-suite-unit-full-only.txt`; select those slower tests explicitly when
relevant, or through the full gate.

The full gate runs the self-hosted frontend, native-build, and CLI checks before
the broad native and standards matrices. The native-build check requires the
self-hosted compiler's serialized native plans and emitted C to match the Node-hosted
compiler byte for byte, then runs each self-hosted binary normally and under GC stress. The much slower whole-compiler
differential follows the regular check matrix, before the remaining exhaustive
lanes. This keeps fast self-host transfer failures high in the fail-fast order.

The standalone smoke fuse measures its cumulative stages and fails if they exceed
20 seconds on a warm four-worker run. It allows fifteen minutes when the reusable
native or Test262 cache roots are missing. Cold CI must build separate development
and eval-enabled Test262 runtimes before reaching WPT.
Both limits scale inversely when fewer than four workers are selected and stay
fixed above four workers. The cumulative
check and full gates always use the scaled cold smoke completion budget because
preceding benchmark work can evict an exact artifact while leaving the coarse cache
roots intact. The fuse does not kill a native build in progress because terminating
an npm wrapper can orphan compiler descendants. Both budgets include cache
population rather than silently excluding it from the measurement.

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
run under UBSan on macOS and ASan+UBSan elsewhere. Sanitizer runs enable
`MAL_GC_AT_EXIT=1` so VM teardown is exercised and leak detection checks allocations
that survive cleanup. Every other authored native test runs once in the ordinary
native dimension. The standalone sanitizer runner defaults to at most two Vitest
workers; gates cap the test-process pool and divide child build jobs across the files
that can run concurrently. Files whose dominant check already
applies maximal GC stress and verification remain in the normal dimension instead
of multiplying both expensive instruments.
Smoke, check, and full retain a complete disjoint partition, so semantic API
breadth is not recompiled under a sanitizer without an ownership-risk reason. A test
belongs in both dimensions only through an explicit focused command for a
mode-sensitive regression. Compiler-semantic native matrices run in the normal
dimension, and exhaustive call-profile matrices run in the full normal lane; focused
Core suites and smaller native fixtures cover those operations in the developer gate.

Native GC worker races use a separate focused ThreadSanitizer lane on supported
macOS/Linux toolchains: `npm run test:tsan -- tests/native/gc.test.ts`. It instruments
the C runtime with `MAL_TSAN=1` and has a distinct build identity. TSan cannot be
combined with ASan or UBSan, and the ordinary sanitizer manifest does not replace
this race check.

`runToStdout` starts with a 20-second default child deadline. Sanitizer
instrumentation and maximal GC stress (`MAL_GC_STRESS=1`) each multiply it by three;
combined runs receive 180 seconds because both costs apply. An explicit child
deadline uses the same factors. Outer test and queue job budgets remain separate.

## GitHub Actions

Pull requests and pushes to `main` run the canonical check tier on Linux x64 and the
smoke tier on macOS ARM. The active `main` gate finishes while the newest push waits;
newer pushes replace its pending successor. Pull request updates cancel superseded
runs. Linux runs seven jobs in parallel using the runner's own four-worker budget,
splitting the native dimensions into shards:

```sh
npm run test:check -- --workers 4 --lane quality
npm run test:check -- --workers 4 --lane standards
npm run test:check -- --workers 4 --lane native --shard 1/2     # and 2/2
npm run test:check -- --workers 4 --lane sanitizer --shard 1/3  # and 2/3, 3/3
```

`quality` includes type-check, lint, and both unit selections. `native` and `sanitizer`
run their owning dimensions; `standards` includes Test262 and WPT. Each lane records
its excluded coverage and cannot stand in for the complete gate. `--shard INDEX/COUNT`
divides a selected lane's test files by the recorded wall time in
`tests/test-suite-durations.json` and keeps files that need the same optional
prepared runtime (perf counters, disabled web or realms) together, so only one shard
pays for that preparation. Stages without test files, such as the macOS leak audit,
stay whole and carry their own recorded duration. The table holds separate Linux and
macOS weights because the hosts differ in relative cost, and separate sanitizer
weights because the sanitizers slow files unevenly; a file takes its weight from the
most specific table that recorded it, and other hosts use Linux's. It only affects
balance; refresh it from downloaded run logs of recent passing runs with
`node scripts/test-suite-durations.ts <log>...`, which keeps each median. The
`Linux check` job requires all jobs to succeed, then combines their retained reports only when source, environment,
selections, and executed stages match the current canonical plan exactly. A sharded
lane must contribute every shard, each matching the planner's shard selection, and
their files must partition each canonical stage. Missing, duplicate, failed, or
incomplete reports fail aggregation.
`--lane compiler` and `--lane rust` select those full-tier dimensions when authorized;
selecting a lane absent from a tier fails before execution. Partial smoke selections
never publish the full smoke cache stamp.

The native-remainder workflow runs on pushes to `main`, Saturdays at 02:43 UTC,
and manual dispatch. Its nine independent jobs cover Linux x64 (three normal and two
sanitizer shards) and macOS ARM (two of each), with a three-hour limit per job:

```sh
npm run test:native:remainder -- --workers 4 --lane native --shard 1/3
npm run test:native:remainder -- --workers 4 --lane sanitizer --shard 1/2
```

This derives the remaining native files from the same manifests as the full gate,
without repeating check's fixtures, quality, or standards. macOS also runs its leak
audit in the normal dimension. The runner completes every selected stage to collect
failures and retains source-bound reports for fourteen days. These reports remain
partial full-tier evidence. Optional external-service tests retain their prerequisites:
the Linux shards of both dimensions start a PostgreSQL 17 container and set the
`MAL_POSTGRES_*LIVE` opt-ins, which canonical runners keep, so the live postgres.js
suites run there (the large-types suite under the sanitizers); macOS shards skip them.

Extended CI also runs on pushes to `main` and manual dispatch. Its slow-unit job
prepares the compiled Test262 runtime before Vitest, keeping cold native compiler
builds outside the execution-contract hook budget. The contract still exercises
compiled, interpreted and wire backends. Independent Linux jobs exercise the full-only unit manifest, Wasm build and parity, the self-hosted
native-build and CLI checks, the self-hosted compiler differential, and compiled WPT. One job runs the
short checks in sequence: the self-hosted frontend, strip and wire differentials,
Rust runtime tests, and the focused Test262 and WPT GC dimensions. The slow-unit and
Wasm jobs install WASI SDK 34. Compiler logs, CLI acceptance records, parity output, and
standards reports remain tied to the tested revision. The full Test262 corpus runs in
its own workflow after CI; these jobs do not update either baseline.

The **Primordial catalog** workflow runs on pushes to `main` and manual dispatch. Four
Linux shards capture every descriptor inventory mode of the newest `main` and compare the
digests with the recorded Linux audit. A changed graph, or a dispatch with `force`, adds
four macOS shards and a job that regenerates the catalog and its generated files from
both captures, runs the catalog unit tests, commits the refresh to `main` and dispatches
CI for it. Runs queue instead of cancelling each other. A refresh of an older revision
is rebased onto `main`, and the queued run captures whatever changed since. Captures are
retained for fourteen days. See the
[inventory workflow](decisions/static-value-foundations.md#native-inventory-and-coverage)
for local captures and imports.

Linux jobs run on Ubuntu 26.04 with its Clang 21, the compiler the remote verification
host uses. The workflows use four workers per Linux job and three macOS workers
to match the hosted CPU allocations. External actions are pinned to immutable commit
SHAs; local setup actions install Node 26, the repository-pinned Rust toolchain, and
the platform compiler before running `env:check`.

CI caches npm downloads, the pinned Test262 corpus, and the content-addressed native
actions a job built: Rust runtime libraries, eval-compiler overlay objects, runtime C
objects and the archives linked from them, generated C objects, the Wasm runtime's Rust library, objects, archive
and link, and the Test262 input index. Eval-compiler bakes travel with them: a bake
is keyed by its compiler sources and costs about a minute per job to redo, so a
commit that leaves the compiler alone reuses it. The ThinLTO cache rides along after
them, newest entries first, because a production link otherwise recompiles every
module. The Rust sources rarely change
while every native job otherwise rebuilds each Cargo feature set with fat LTO. The
overlay is quite large (about 370 translation units), but each unit only holds its own
functions: image indices live in separate link-table units, so a compiler edit
recompiles the units it touches. Test fixtures emit the same C until the compiler
changes what they compile to, so their objects survive most commits as well.
`scripts/ci-native-cache.ts` moves only those entries. The Rust libraries, runtime
objects and archives, overlay objects and bakes are the same for every job of a lane,
so each lane (sanitizer or ordinary, per platform) keeps them in one shared snapshot:
every job restores it, and one job per lane saves it (the first Linux native and
sanitizer check shards, the macOS smoke job, and the first macOS remainder sanitizer
shard). Each job also restores the newest snapshot of its own line, which holds only
what the shared snapshot lacks: fixture objects, Wasm stages, ThinLTO entries, and
the library variants peculiar to that job. On `main`, a job saves its line when the
set changed, within 3 GiB, keeping the bakes and then what the job itself read first,
then ThinLTO entries, then older entries, each in the order Rust, overlay, runtime,
fixture objects; the export log breaks the bytes down. Snapshots compress about 3.5
times, and the newest snapshot of every line and lane has to fit the repository's 10 GB
allowance: when it does not, GitHub evicts whole lines and their jobs start cold.
After saving, a job deletes the snapshot it restored: GitHub evicts the least recently
used entries, and that superseded snapshot counts as just used, so keeping it would
evict the newest snapshot of a line that runs less often. Cancelled runs save nothing.
A restored action that no longer matches is simply never read; the weekly
native-remainder run stays cold so cache identity defects still surface. Native linked binaries, frontend artifacts, Zig outputs, and
the managed cache are not stored: a test binary is tens of megabytes, and a developer
cache can exceed the repository's 10 GB Actions allowance.
Gate reports are retained on success and failure for seven days,
including their tested source identity. The standards lane alone prepares the
Test262 corpus. Release workflows remain separate.

Every push to `main` whose CI run passes also runs the complete compiled/normal
Test262 corpus in the Test262 workflow, started after CI so its jobs never queue the
gate. Four jobs each run both language variants over an interleaved quarter of the
corpus (`scripts/test262.ts --shard INDEX/COUNT`) and check it against the committed
baseline. A report job then merges the four combined reports with
`scripts/test262-merge.ts`, which refuses a missing, repeated or overlapping quarter,
into the same complete report a full run writes, and retains it for fourteen days.
The shard jobs restore the standards lane's native cache line without saving their
own, because that lane prepares the same eval-enabled runtime, and use every runner
core instead of the default half. For push-triggered runs the report job maintains
one issue named `Automated Test262 regressions`, creating or reopening it while
regressions remain and closing it after the next regression-free run, and commits
`scripts/test262.json` when the complete report has no regressions and newly passing
tests, as long as the tested revision is still `main`. Regressions are never accepted
into the baseline. Manually dispatched runs check the existing baseline without
changing it or touching the issue.

## Worker budgets

Use `npm run test:check -- --workers 4` to set a total allocation, or set
`MALIGATOR_WORKERS=4` for focused commands and queue jobs. The default is half the
CPUs reported by `os.availableParallelism()`, with a minimum of one; explicit
allocations are capped at the available CPUs. `--workers` overrides the environment
default for the gate. Plans and reports record the effective budget and each stage's
test workers, child build jobs and preparation build jobs.

Unit Vitest uses up to the full test-worker budget. Build-heavy native selections
reserve at least two build jobs for each concurrent test process when the budget
allows it: a four-worker selection runs two test processes with two build jobs each,
while one selected file can use all four build jobs. This prevents the process that
owns a shared runtime build from compiling on one core while every other core waits
on its artifact lock. Native global setup and Test262 runtime preparation can use
the full budget. Serial WPT and self-hosted checks can also use the full build
allocation. Cargo compiles Rust tests before running the Rust test pool.
Native global setup prepares both default Node surface variants before timed
fixture builds, including their shared eval compiler and Rust dependencies.
It also prepares the instrumented default runtime without Node when a selected
file is listed in `tests/test-suite-native-perf.txt`. Keep that manifest in sync
with tests using the default internal feature profile and `MAL_PERF_STATS=1`:
compiling the shared native eval compiler belongs in preparation, before timed
fixture hooks. Focused selections outside the manifest keep ordinary preparation.
`MAL_BUILD_JOBS` and `CARGO_BUILD_JOBS` can lower a build pool further; neither can
raise it above the inherited allocation. Resource controls survive canonical
environment cleaning without retaining ambient runtime modes.

The allocation limits managed test and build pools; the queue's CPU affinity and
quota remain the operating-system limits. Changing worker counts does not change
artifact identities or permit reuse of previous test verdicts.

## Reports

Each test-suite execution prints a retained machine-readable report at
`.cache/mal-build/test-suite/runs/<run-id>/report.json`. In-progress reports are updated
in that run directory; completed reports are retained across subsequent runs. The
latest report is also published atomically at `report-<tier>[-<lane>].json` for discovery.
Native-remainder runs use `report-full-native-remainder[-<lane>].json` so they never
replace the latest complete full-gate report.
Reports record the Git revision, dirty state, a content digest of tracked and
non-ignored untracked files, host/Node/compiler versions, exact selection, completion,
and verdict. The source is captured before and after execution; changed content
returns a failure and cannot establish acceptance. Git checkout roots are required.
Reports record exact stage wall times,
exit status, and native fixture spans for frontend work, C/Rust artifacts, generated
objects, linking, and execution, including cache hit/miss counts and the 20 slowest
spans. Vitest forks write process-local JSONL while running, so telemetry does not
serialize the native suite; reports count the contributing processes explicitly.
Test verdicts and program output are still always recomputed. Test262 build work and
materialized runners live under `<shared-cache>/work/test262`; repository `.cache`
contains reports and retained failure evidence only. Native fixture, WPT, and
self-hosted gate materializations likewise use process-scoped shared-cache work roots.

Generated-object telemetry records each generated C unit and driver independently:
source bytes, compile wall and CPU time, peak compiler RSS when the host exposes it,
object bytes, and shared-cache hit or miss. The enclosing native phases report the
parallel C-to-object wall time and final-link wall time separately; a cache hit has no
compile-resource sample rather than attributing cached work to the current build.

## Policies

The suite and standards runners accept two policies:

- `bail` stops scheduling work after the first unexpected failure and is the
  default for `test:smoke`, `test:check`, and `test:full`.
- `complete` traverses the selected corpus, writes complete reports, and returns
  nonzero after reporting failures.

Use completion commands when coverage numbers matter. They run complete selections
and belong on CI, where the Test262 workflow runs the authoritative corpus after every
push to `main`; run them locally only when explicitly asked:

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

`npm run test262:prepare` publishes the pinned corpus under
`<shared-cache>/test262-corpora/<revision>` and its parsed metadata in the shared
artifact store. All Maligator checkouts using that revision share the corpus;
metadata reuse also requires matching parser code, YAML dependency contents, and
index format. The index contains source digests and frontmatter, with no test
results or source-text copies. Workers load and verify only their assigned batches.
Every selected test still executes on every run. Modified corpus snapshots are
rejected, and an existing snapshot is never reset underneath another reader.
The normal cache lease and pruning rules protect these inputs during execution.

Canonical report commands remove ambient runtime overrides from `MAL_*` and
`T262_*`, plus `WPT_ROOT`, Node injection, sanitizer, allocator and dynamic-loader
dimensions before starting. Resource allocations remain: `MALIGATOR_WORKERS`,
`MAL_BUILD_JOBS`, `MAL_SANITIZER_WORKERS`, Cargo and other worker-pool limits.
Test262 also preserves `T262_COMPILE_WORKERS` and `T262_OBJCACHE`.
Partial selections cache their compiled batch objects by default. A
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

Plain `npm run test262` and `npm run test262:report` are non-mutating gates. They
load `scripts/test262.json` from the resolved HEAD commit, so an uncommitted baseline
update cannot hide regressions on the next run. Reports record that commit and the
baseline content digest. `--baseline <file>` explicitly selects a frozen comparison
file for reproductions. Single-variant checks return nonzero on regressions under
both `bail` and `complete`; intentional variant skips are not regressions.

The Test262 workflow commits improvement-only baseline refreshes itself.
`npm run test262:update-baseline` explicitly replaces `scripts/test262.json` for an
intentional change. It requires a full canonical compiled/normal run with complete
policy; partial, single-variant, custom-baseline, and instrumented updates are rejected
before work. Take that run from CI instead of running the corpus locally: download the
workflow's combined report (the `test262-report-<run>` artifact), confirm the run's
tested revision, and apply the report with:

```bash
npm run test262:update-baseline -- --from-report .cache/results/report-compiled-normal-combined.json
```

This prepares the pinned corpus index without compiling or executing tests. Import
requires complete compiled/normal results for every pinned test, a matching HEAD
baseline digest, consistent totals and skip reasons, and no regressions. The combined
report does not record the compiler revision, so take the source identity from the
run that produced it.

### Test262 verdicts and counts

The combined verdict counts test files, not executions. A default script must pass
both strict and sloppy execution; `onlyStrict`, `noStrict`, and module tests require
their designated execution only. Raw scripts run once without forced strictness or
source changes; raw modules retain the module parse goal. A failed required variant
makes the file fail. Intentional variant omissions do not count as failures.

Normal Test262 execution has a two-minute per-test deadline. GC-stress and Guard Malloc use
independent 20-minute and six-minute deadlines. Batch process deadlines include
the per-test budgets and a fixed shutdown allowance.

Harness files execute in order as separate global scripts in the test's realm before
the test is instantiated. Their declarations and directives do not become part of
the test's source or module scope. This contract is the same for compiled,
interpreted, wire, cached-batch, and single-test fallback execution.

Negative tests require the declared error type at the declared semantic phase.
Entry parsing and early errors are `parse`; loading invalid dependencies and
linking errors are `resolution`. Compiler implementation errors are failures, not
expected language rejections. Runtime exception types come from native completion
records containing the thrown object's constructor name, not its printed stack or
message. Async success additionally requires normal completion and the success
sentinel; an uncaught throw still fails after `$DONE()`.

The Atomics tests need more of a host than a single VM. `$262.agent` starts every
agent as a thread with its own VM, and the drivers run an event loop after the test
body so timers and `Atomics.waitAsync` deadlines settle. Like the d8 and SpiderMonkey
shells, the main agent can block, except in `CanBlockIsFalse` tests, where the driver
sets its `[[CanBlock]]` to false. Skipped tests carry their reason in `skips`, and
combined skips remain visible in the total inventory. The site's percentage is
`PASSED / (PASSED + FAILED + SKIPPED)`; it does not remove skips from the denominator.
An ordinary check exits nonzero for regressions from previously passing files;
known baseline failures can therefore coexist with a successful gate.

Pure runner contracts run in the unit lane. The native runner integration contract
is full-only and can be selected with
`npm run test:unit:full-only -- --run tests/test262-execution.test.ts`.

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
in a fork-isolated standard runtime. The full gate additionally runs the macOS leak
audit. Native sanitizer coverage is already part of the disjoint smoke/check/full
partition. "Full WPT" means every test in the pinned server-runtime curated corpus,
not the complete browser WPT repository.

The Test262 GC dimensions preserve collection at every gated safepoint in the
selected program. While that program invokes runtime compilation, the self-hosted
compiler uses `MAL_EVAL_GC_STRESS_INTERVAL=1000`; native fixtures inherit the same
cadence from the harness `STRESS_ENV`, and the dedicated native root-safety test
uses it too. This avoids thousands of full heap verifications per eval without
weakening stress once the generated entry starts executing.

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
The broader smoke+check stress matrix remains available on demand as
`npm run test262:gc:broad`; run it after changing the collector or root contracts
and before deliberately revising the spine.

"Complete native coverage" means every authored `tests/native/**/*.test.ts` file
in its owning normal or sanitizer-primary dimension, the Rust runtime unit suite
with `node-zlib` enabled, and the explicitly targeted collector and leak lanes. It
does not mean a Cartesian product of every native file with every backend and GC
build configuration; tests declare or drive their relevant dimensions.

## Maintaining Selections

- Smoke and check manifests must be deterministic, duplicate-free, and disjoint.
- Curate the Test262 regression manifests manually. Baseline updates, full-suite
  reports, and newly passing tests must never add or remove entries automatically.
- `npm run test262:regressions` unions the Test262 smoke and check manifests, so
  the direct lane covers the same curated set as the cumulative check tier.
- Every Test262 manifest path must exist in the pinned corpus; missing paths fail.
- Test262 checkout and cache revisions must match `TEST262_METADATA.revision`.
  Run `npm run test262:prepare` to populate the shared pinned corpus and input index;
  never vendor upstream Test262 files. To advance the corpus, update that revision
  deliberately, import a complete CI report for it with the approved baseline-update
  command, and commit the resulting `scripts/test262.json` change.
- WPT smoke/check manifests are disjoint curated subsets; the full tier reruns
  compiled/normal across the complete curated set and GC stress on the smoke
  cross-section.
- Keep smoke to a broad semantic cross-section. Add a Test262 path to check only
  when the failure mode is costly, cross-cutting, recurrent, or otherwise more
  valuable than ordinary full-corpus coverage; novelty alone is not a reason.
- Keep expected failures out of smoke unless the expectation mechanism itself is under test.
- Inspect the changed tier's plan and measure its affected stages when changing
  manifests; confirm the complete tier budget at the acceptance checkpoint.

Unit and native discovery are recursive. New `selfhost-*-check.ts` and
`eval-*-check.ts` scripts must be registered in `scripts/test-suite.ts`; suite
startup fails when one is present but unregistered, so a full-gate check cannot
be added silently. Test262 manifests reject empty or unknown selections. WPT
expectations and the committed fixture tree are validated against the complete
curated manifest before partial selections are applied.

## Supervisor integration

`npm run selfhost:cli` builds and exercises the packaged compiler outside the
checkout with Node absent from its PATH. It covers build/cache restoration, run,
dev replacement, application tests and native worker packaging. For focused
supervisor checks against an explicitly selected existing binary, use
`npm run selfhost:cli -- --cli /absolute/path/maligator --supervisor-only`.
This skips the bootstrap/native-build checks and exercises toolchain-free run,
served dev revisions, last-good behavior, cached test-watch reruns, failed-file
selection and concurrent isolated tests. It prints the selected binary's digest
and saves command/watch evidence under `.cache/selfhost-cli/<pid>`; the caller
must establish which source produced that binary.

## Diagnostic artifacts

Keep run evidence in a task-scoped directory under `.cache/`. Remove disposable
builds and superseded outputs after review; retain only evidence supporting a result
or an unresolved failure. Commit reusable fixtures and tools, not raw profiles,
experiment journals, or historical timing snapshots.

The repository's Vitest and sanitizer wrappers own one temporary directory per
invocation and remove it on success, failure, or handled interruption. Locally it lives
under `test-tmp/` in the Maligator cache base directory, beside the layout generations
`cache clear --all` removes, so a crashed run leaves its scratch in one known place; on
CI it uses the runner's temporary directory. Fixtures stay outside every project so
module resolution cannot reach the repository's `package.json` or `node_modules`. Use `--keep-artifacts` to retain generated
sources and binaries for diagnosis; the runner prints the path.
Reports and the shared build cache remain outside that disposable directory.

## Cache ownership

Maligator bounds its shared user-cache artifacts without touching project source,
committed baselines, or user output. Shared Test262 snapshots are rebuildable cache
entries; pruning retains the two most recently used corpus revisions.

Commands keep the cache within a budget on their own. When a command ends it compares
the last measured size plus the bytes it published since against the budget, which
costs a free-space query and two small reads, never a scan. When the cache is over
budget, was last measured a day ago, or its volume has less than 10 GiB free, the
command starts `maligator cache maintain` detached and at low priority, so nobody waits
for the scan. A volume short of space also starts maintenance when a command begins.
The budget is 20 GiB, pruned back to 15 GiB. With at least 200 GiB available to the
cache (free space plus its own size) it is 100 GiB, pruned back to 40 GiB.
`MALIGATOR_CACHE_MAX_GB` fixes the limit and prunes back to three quarters of it;
`MALIGATOR_CACHE_MAINTENANCE=off` turns automatic maintenance off. CI runners
(`CI=true`) skip it, since they are discarded after each job and save their cache
explicitly.

Maintenance runs beside other commands, including long-running `dev` and `run`
processes in other projects. It never removes an entry used in the last hour (ten
minutes on a nearly full volume) or scratch that belongs to a running process, and a
read that races a removal sees an ordinary cache miss. Scratch left behind by a
finished process is removed regardless of the budget. The linker's ThinLTO cache is a
managed family like the others.

Inspect usage, the budget and the last maintenance with `maligator cache status`;
preview or apply reclamation with `maligator cache prune --dry-run` and
`maligator cache prune`. Explicit prune targets the budget's prune-back size and
normally considers entries unused for at least one day. Above twice the target it
applies the per-family retention floors immediately, which prevents a burst of
content-addressed artifacts from filling the disk. Eligible Rust work and Rust library
artifacts are pruned after compiler work and other action artifacts, so stable Cargo
products survive when the target can be met from shorter-lived entries. Use
`--max-gb`, `--min-age-days`, and `--verbose` to tune or audit an explicit prune.

Build, test, standards, benchmark, and quality commands hold process leases, which
`maligator cache status` lists. Stale lease files are removed only after confirming
their process is gone, and test verdicts are never cached. Cache hits touch their
artifact directory so retention follows actual reuse. `maligator cache clear --all`
removes every Maligator cache-layout generation, refuses to run while a command holds
a lease, and retains no readers for old formats.
WPT removes its per-run native scratch tree on exit; pass
`--keep-artifacts` only when debugging generated sources or binaries.

## Manual Diagnostics

These investigation tools are intentionally not gates because they require a
fixture, answer an exploratory question, or analyze an existing cache:

```sh
node scripts/diff-compiled.ts tests/local/constant_fold.js --stress
node scripts/diff-script.ts tests/local/constant_fold.js --strict --stress
node scripts/test262-code-stats.ts --variant both --limit 30
```
