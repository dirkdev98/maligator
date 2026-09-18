# Testing

Maligator uses three cumulative test tiers. Check is the normal developer gate;
its native duration depends on cache warmth and the selected worker budget. The
smoke tier is primarily an early fuse inside larger runs, and the full tier is
exhaustive rather than interactive.

## DX performance exercise

`npm run bench:dx -- <maligator-binary>` creates an isolated representative
Express, Drizzle, Valibot, SQLite, and TypeScript project. It reports cold and
warm `run` and `test` latency plus cold and cached `dev` readiness and a leaf-edit
recompile message. The development measurement currently waits for compiler log
markers; it does not assert that the restarted application serves the edited revision.
Use `--only run`, `--only test`, or `--only dev` for independent lanes,
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
Test verdicts and program output are still always recomputed. Test262 build work and
materialized runners live under `<shared-cache>/work/test262`; repository `.cache`
contains reports and retained failure evidence only. Native fixture, WPT, and
self-hosted gate materializations likewise use process-scoped shared-cache work roots.

Generated-object telemetry records each generated C unit and driver independently:
source bytes, compile wall and CPU time, peak compiler RSS when the host exposes it,
object bytes, and shared-cache hit or miss. The enclosing native phases report the
parallel C-to-object wall time and final-link wall time separately; a cache hit has no
compile-resource sample rather than attributing cached work to the current build.

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
`MAL_BUILD_JOBS` and `CARGO_BUILD_JOBS` can lower a build pool further; neither can
raise it above the inherited allocation. Resource controls survive canonical
environment cleaning without retaining ambient runtime modes.

The allocation limits managed test and build pools; the queue's CPU affinity and
quota remain the operating-system limits. Changing worker counts does not change
artifact identities or permit reuse of previous test verdicts.

## Diagnostic artifacts

Keep run evidence in a task-scoped directory under `.cache/`. Remove disposable
builds and superseded outputs after review; retain only evidence supporting a result
or an unresolved failure. Commit reusable fixtures and tools, not raw profiles,
experiment journals, or historical timing snapshots.

The repository's Vitest and sanitizer wrappers own one temporary directory per
invocation and remove it on success, failure, or handled interruption. Use `--keep-artifacts` to
retain generated sources and binaries for diagnosis; the runner prints the path.
Reports and the shared build cache remain outside that disposable directory.

`bench:compiler-scale` writes `.cache/compiler-scale/report.json` by default.
`bench:performance` is the public performance entrypoint. `gap` compiles each selected
diagnostic case independently, so adding an unselected case does not grow or invalidate
an existing case. Its reports under `.cache/performance/` include per-case compiler
artifact identity, image counts, generated-object measurements, executable size, and
cache outcomes. Use `--plan=json` before execution, `--category` or repeatable `--case`
for focused work, and `--preset confirm --case ID` for deeper selected evidence.

Use `bench:performance -- experiment new ID [--from CASE] [--control CASE]` for ignored
scratch work. `experiment run ID` supports `smoke`, `verify`, and `confirm` presets;
promotion refuses collisions and does not add the new case to a default suite unless
`--preset survey` or `--preset quick` is explicit. `experiment remove ID` deletes only
that experiment. `case.mjs` is the only scratch source file and may import only the
committed runtime-gap case runner; this makes the queue's selected two-file transport
and later promotion exact rather than best-effort.

`bench:performance -- portfolio --baseline REF` is the broad acceptance path. Its
versioned, fixed-weight portfolio delegates to app-batch, compiler-app, JavaScript,
HTTP, and self-compile owners. Missing families remain incomplete and are never
reweighted. A smaller related regression may be outweighed by a larger portfolio win,
but every regression remains visible and explicit per-family guardrails still apply.
One-pair runs remain screening evidence and cannot produce an acceptance decision.
Families run independently under their declared budgets. JavaScript uses the
production closed-compiled mode and HTTP uses one-second scenarios. Self-compile
builds each exact revision's production compiler once, then runs the requested
interleaved pairs over one frozen baseline source graph and requires each revision's
output to remain deterministic.
Cold-start, instrumentation, owner, resource, alternate-mode, and longer HTTP samples
remain in the specialized benchmark commands; they are diagnostics rather than work
silently repeated inside every portfolio sample.
The specialized benchmark commands remain available for their owning diagnostics;
the performance entrypoint supersedes them as the normal experiment and acceptance
workflow. None of these commands updates `bench/baseline.json`.

Run native cases and portfolios through `mjq perf.performance`. Queue options select
`mode=gap`, `mode=experiment`, or `mode=portfolio`; the selected mode's budget bounds
the complete driver. Smoke and quick reports are screening evidence, not acceptance.
Headline timing excludes diagnostics. RSS is process-wide; Maligator allocation and
collection deltas cover the measured window, while its GC pause and peak-live values
cover the separate resource process. Node allocation is sampled and is not directly
equivalent to Maligator's charged managed-heap bytes.

`node ./src/index.ts cache prune --dry-run` previews pruning the managed user cache
to its default 15 GiB target; omit `--dry-run` to apply it. Live commands block
pruning, and per-family minimums and recent-entry protection can keep the cache
above the target. Repository `.cache/` reports require a separate ownership and
activity audit before removal.

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
confidence interval. Wall time and throughput require a 2% effect; p99 latency,
RSS, and GC pause metrics require 5%; binary size requires 0.5% and at least 32 KiB.
The outcomes are `improvement`, `regression`, `unchanged`, and `inconclusive`.
Exit 1 flags a classified regression; exit 2 means execution failed or was incomplete.
The classifier also operates on a single pair, whose bootstrap interval cannot
estimate run-to-run variability. Use repeated matched pairs before making a
performance claim. An inconclusive result remains evidence to inspect, not a passing
performance claim.

Raw reports are retained under `.cache/bench-comparisons/`. They include every
completed source snapshot and its checksums, configuration, native plan, resource
counters, and numeric samples. Each run has a directory containing `report.json`,
the original snapshots, and a log per snapshot. The report is written before work
starts and after each pair; `status` distinguishes `running`, `complete`,
`incomplete`, and `failed`. Failed and interrupted runs retain their evidence.
The comparison refuses different
`package-lock.json` contents rather than silently measuring different dependencies.
The base revision must contain the paired-runner support; use a recent checkpoint
when investigating older history.

Inspect all planned work before a time-sensitive experiment:

```sh
npm run bench -- self-compile --compare HEAD --runs 1 --max-pairs 1 --budget-seconds 600 --plan=json
```

Remove `--plan=json` to execute. `--runs` counts measured pairs; each comparison
also warms both sources. A self-compile snapshot includes a native build, three
cold pairs, a warmup pair, the requested measured pairs, phase/counter/owner
instrumentation, and a resource pair. A one-pair comparison can therefore exceed
ten minutes. The plan reports this additional work explicitly.

`--budget-seconds` bounds each comparison invocation, including preparation and
warmup. The runner stops its child process group at the deadline and allows a short
shutdown grace period before forcing termination. Exit 2 means failed or incomplete,
never a passing performance claim. Completed snapshots and pairs remain available;
single-family self-compile comparisons also checkpoint between stages. Resume with
the same command plus `--resume <run-directory>` and a fresh time budget. Source
content (including untracked files), revision, options, and host identity must match.
Only complete pairs contribute metrics; a partial pair is retained but excluded.
Classified metrics absent from any source/sample, such as native-build RSS on cache hits,
are listed under `unpairedMetrics` and excluded rather than treated as zero.
Source changes during execution invalidate resumption, even if later reverted.
Run `env:check` and inspect cache activity before each resume, since power and CPU
load can change between invocations.

On completion the runner removes its exported baseline source while retaining the
reports and snapshots. Interrupted runs retain that source and self-compile scratch
inside the run directory for resumption. After confirming the run has stopped,
removing its directory discards only that run's evidence and scratch. Shared native
artifacts remain under normal cache management.

## Focused compiler execution experiments

For a small compiler or runtime execution experiment, preserve a compiler before
editing and compare it with a later capture on the same frozen input:

```sh
npm run bench:self-compile-experiment -- capture .cache/compiler-base
# Edit the compiler or runtime, then capture the candidate.
npm run bench:self-compile-experiment -- capture .cache/compiler-candidate
npm run bench:self-compile-experiment -- compare .cache/compiler-base .cache/compiler-candidate --output .cache/compiler-pairs --workload parser --pairs 5 --budget-seconds 600 --plan=json
```

Remove `--plan=json` to execute. Select `--workload shape` or `--workload full`
for larger inputs, and `--host node` for a separate Node-hosted comparison.
Both Node compiler snapshots use the same source preparation. Native captures use
a fresh explicit module frontend because cached artifacts deliberately lose trusted
precise VM root maps on deserialization. This keeps their GC policy consistent.
The actual module graph must certify whole-program source closure; the certificate
is recorded with the capture rather than inferred from runtime settings.
They use closed development O2/no-LTO builds without instrumentation; this is an inner
loop, not the production-plan JavaScript/HTTP benchmark matrix.

Capture records HEAD plus a digest of pending changes, the tracked patch, exact
prepared source and binary hashes, lockfile, Node/host identity, and native build
plan/toolchain. Comparison refuses modified captures or different preparation,
dependencies, hosts, and native plans. Every run compiles the baseline capture's
input and must exactly match its Node output oracle.

To measure code-generation changes, first capture `.cache/compiler-program`, then
capture both baseline and candidate with `--program .cache/compiler-program`.
Both host compilers compile that same frozen JavaScript source at the same path,
so the resulting native executables can still be checked against an exact Node
oracle. Each capture preserves the frozen source and its original manifest digest.
This isolates the speed of the generated native program; measuring a changed
compiler's own output still requires semantic benchmarks when emitted C differs.

The budget includes the oracle, two warmups, and all measured pairs. Only complete
pairs enter the elapsed-time summary; individual peak-RSS readings and raw resource
logs are retained on macOS/Linux. The time covers JavaScript input through C
emission, excluding capture/build and output-digest verification. A timeout stops
the worker process group and exits 2, retaining partial outputs and `report.json`
with `status: incomplete`. Other failures also exit 2. A completed run records
samples and variability without declaring a performance win. Output directories
must be new, and evidence remains until explicitly removed.

For current-tree diagnostics, `npm run bench:self-compile-profile -- --quick`
profiles the shape-analysis cone; omit `--quick` for full self-compilation.
Add `--compiler-profile` for source-site counters or `--timing-only` for an
uninstrumented run. Every mode uses a fresh certified whole-program frontend
and development O2/no-LTO code. The report records its closure certificate,
native plan, and toolchain. Native builds and child runs clear ambient `MAL_*`
and `NODE_*` overrides before applying the selected instrumentation. Completed
runs must match Node on the same prepared input, outside the timed interval.
Failed runs retain their scratch directory for diagnosis. Profile runs are diagnostics;
use the matched experiment workflow above for performance conclusions.

## Cache ownership

Maligator bounds its shared user-cache artifacts without touching project source,
committed baselines, or user output. Shared Test262 snapshots are rebuildable cache
entries; pruning retains the two most recently used corpus revisions. Inspect usage
with `maligator cache status`; preview or apply reclamation with
`maligator cache prune --dry-run` and `maligator cache prune`. Explicit prune
targets 15 GiB and normally considers entries unused for at least one day. Above
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

| Tier  | Command              | Policy                                | Intended use                                                                                     |
| ----- | -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Smoke | `npm run test:smoke` | Bail, 20s warm / 5m cold at 4 workers | Minimal compiler, packaged development, Test262, and WPT capability proof                        |
| Check | `npm run test:check` | Bail                                  | All regular unit tests, curated wire/normal standards, and disjoint normal/UBSan native coverage |
| Full  | `npm run test:full`  | Bail, unbounded                       | Self-hosting, remaining partitioned native coverage, standards, collectors, and leaks            |

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
20 seconds on a warm four-worker run. It allows five minutes when the reusable
native or Test262 cache roots are missing. Both limits scale inversely when fewer
than four workers are selected and stay fixed above four workers. The cumulative
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

`runToStdout` starts with a 20-second default child deadline. Sanitizer
instrumentation and maximal GC stress (`MAL_GC_STRESS=1`) each multiply it by three;
combined runs receive 180 seconds because both costs apply. An explicit child
deadline uses the same factors. Outer test and queue job budgets remain separate.

## GitHub Actions

Pull requests and pushes to `main` run the canonical check tier on Linux x64 and the
smoke tier on macOS ARM. The workflows use four Linux workers and three macOS workers
to match the hosted CPU allocations. External actions are pinned to immutable commit
SHAs; local setup actions install Node 24, the repository-pinned Rust toolchain, and
the platform compiler before running `env:check`.

CI caches npm downloads and the pinned Test262 corpus only. The generated Maligator
blob store, native objects, Zig outputs, and whole managed cache are deliberately not
stored because a normal developer cache can exceed the repository's 10 GB Actions
cache allowance. Test reports are retained only on failure.

The weekly and manually dispatched Test262 workflow runs the complete canonical
compiled/normal report on `main`. It commits `scripts/test262.json` only when the
complete report has no regressions and the baseline changed. Regressions are never
accepted into the baseline; one issue named `Automated Test262 regressions` is
created or reopened and updated from the complete report, then closed by the next
regression-free run.

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

`npm run test262:update-baseline` explicitly replaces `scripts/test262.json`. It
requires a full canonical compiled/normal run with complete policy; partial,
single-variant, custom-baseline, and instrumented updates are rejected before work.
All three full-corpus commands are expensive; ask before running them, `test:full`,
or `test:full:report`. Filtered diagnostic selections remain focused commands.

For an authorized baseline refresh measured on another host, first verify the
queue's captured source and retain its combined, strict, and sloppy reports. Apply
the combined report locally with:

```bash
npm run test262:update-baseline -- --from-report .cache/results/report-compiled-normal-combined.json
```

This prepares the pinned corpus index without compiling or executing tests. Import
requires complete compiled/normal results for every pinned test, a matching HEAD
baseline digest, consistent totals and skip reasons, and no regressions. Source
identity must be verified from the queue receipt; the combined report does not
record the compiler revision.

### Test262 verdicts and counts

The combined verdict counts test files, not executions. A default script must pass
both strict and sloppy execution; `onlyStrict`, `noStrict`, and module tests require
their designated execution only. Raw scripts run once without forced strictness or
source changes; raw modules retain the module parse goal. A failed required variant
makes the file fail. Intentional variant omissions do not count as failures.

Normal Test262 execution has a two-minute per-test deadline: eval-heavy upstream
cases take 32–44 seconds on the Linux queue host. GC-stress and Guard Malloc use
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

The current host has `CanBlock=false`. Tests requiring `CanBlockIsTrue` are reported
as `SKIPPED`, with an explicit host-applicability reason in `skips`. Combined skips
remain visible in the total inventory. The site's percentage is
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
corpus. All execution commands consume that shared snapshot read-only and name
this preparation command when it is absent. A modified snapshot must be restored
before it can be used. Running the full Test262 corpus
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
Finish with `npm run test:check` once the focused behavior passes.

For a compiler representation failure, use the product CLI with `MAL_DEBUG=true`
and a self-contained fixture. A raw Test262 file may require harness includes;
reproduce it through `scripts/test262.ts --filter <path> --variant strict --policy bail`
instead of assuming it can be built as a standalone program. Add an explicit
backend/mode only when that dimension matters to the failure.

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
