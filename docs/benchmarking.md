# Benchmarking

Use this reference when measuring a compiler or runtime change. Working authority and
verification policy live in [AGENTS.md](../AGENTS.md); correctness checks live in
[testing.md](testing.md). Inspect the command plan before a costly run and compare
matched workloads, output parity, source/toolchain identity, and repeated interleaved
pairs. A single pair or a zero exit code does not establish performance acceptance.
Replacing `bench/baseline.json` requires an explicitly authorized `--update`.

The `npm run bench` families are `javascript`, `http`, and `self-compile`. Default
runs select the first two; `--full` selects all three. Keep source-hosted DX
measurements (`npm run bench:dx -- --source`) separate from AOT self-compilation.
For application profiling, use [profiling.md](profiling.md).

For an authorized complete baseline refresh on an allocated Linux runner, dispatch
[Full benchmark baseline](../.github/workflows/benchmark-baseline.yml) from `main`.
It measures all three families with the canonical `--full --update` command and
retains the exact revision, runner identity, plan, log, snapshot, and updated baseline.
Download and review the successful run's artifact before committing its baseline;
the workflow does not push changes. A new baseline on a different host does not
establish a performance improvement against the previous host's results.
Snapshots measured on GitHub runners record `source.recorder: "github-actions"`,
and the website's benchmark history leaves them out so its series stays on one
workstation.

## Performance entry points

`bench:compiler-scale` writes `.cache/compiler-scale/report.json` by default.
`bench:performance` is the public performance entrypoint. `gap` compiles each selected
diagnostic case independently, so adding an unselected case does not grow or invalidate
an existing case. Its reports under `.cache/performance/` include per-case compiler
artifact identity, image counts, generated-object measurements, executable size, and
cache outcomes. Use `--plan=json` before execution, `--category` or repeatable `--case`
for focused work, and `--preset confirm --case ID` for deeper selected evidence.

Use `--owner primordial-methods` to select the 50 grouped primordial microbenchmarks.
`bench/runtime-gap/primordial-methods.json` records the selected 200 callable identities.
Their catalog `methods` list records the methods exercised in each measured workload;
the result is a group workload offset, not an individual method cost. Case `features`
enable RegExp or the Intl collator only where required, and plans and reports record
the resolved build configuration for each case. Run the date workloads with `TZ=UTC`.
For a bounded local survey, use
`TZ=UTC npm run bench:performance -- gap --owner primordial-methods --samples 5 --target-node-ms 20 --budget-seconds 3600 --plan=json`,
then remove `--plan=json` to execute the inspected selection.

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
Acceptance uses the fixed-weight geometric aggregate of family median cost ratios.
Its interval comes from deterministic paired resampling within each family, with
families resampled independently because sequential family runs do not share round
identities. Individual inconclusive family classifications therefore do not veto a
supported aggregate result. There is no minimum percentage gain: a positive
aggregate whose interval excludes zero can count, subject to the family regression
guardrails. Reports retain the estimator, seed, iteration count,
family contributions, assumptions, and a warning when the small number of pairs makes
bootstrap calibration weak; bootstrap iterations are not additional measurements.
One-pair runs remain screening evidence and cannot produce an acceptance decision.
Families run independently under their declared budgets. JavaScript uses the
production closed-compiled mode and HTTP uses one-second scenarios. Self-compile
builds each exact revision's production compiler once, then runs the requested
interleaved pairs over one frozen baseline source graph and requires each revision's
native output to match its Node-hosted output. Self-compile cold-start,
instrumentation, owner, and resource samples remain in the specialized command and
are not repeated inside portfolio samples. JavaScript and HTTP still use their full
benchmark snapshots, including their resource probes; their family budgets include
that work. Alternate modes and longer HTTP samples remain specialized diagnostics.
Families run in manifest order, so compiler-app, app-batch, JavaScript, and HTTP
usually provide broad preliminary evidence before the deliberately longer
self-compile acceptance tail. The default whole-portfolio budget includes three
warmed self-compile pairs; a smaller explicit budget may retain earlier family
results but must leave the portfolio incomplete.
The specialized benchmark commands remain available for their owning diagnostics;
the performance entrypoint supersedes them as the normal experiment and acceptance
workflow. None of these commands updates `bench/baseline.json`.

For authorized queue runs, use `mjq perf.performance`. Queue options select
`mode=gap`, `mode=experiment`, or `mode=portfolio`; the selected mode's budget bounds
the complete driver. Smoke and quick reports are screening evidence, not acceptance.
Headline timing excludes diagnostics. RSS is process-wide; Maligator allocation and
collection deltas cover the measured window, while its GC pause and peak-live values
cover the separate resource process. Node allocation is sampled and is not directly
equivalent to Maligator's charged managed-heap bytes.

## Paired performance comparisons

Use a paired comparison for Maligator changes instead of reading a single delta
against the committed snapshot:

```sh
npm run bench -- javascript --compare HEAD --runs 5
npm run bench -- --changed --compare HEAD
```

The runner exports the requested Git revision to a temporary directory, shares
dependencies when the lockfiles match, and otherwise installs the baseline with
`npm ci` from its own lockfile. It records both lockfile hashes, warms both trees,
and alternates the base/head execution order. A historical comparison includes
dependency changes as part of the revision. `--changed` maps the Git diff to the smallest relevant
benchmark lanes. It starts with the requested number of pairs and may collect up to
15 while a result remains uncertain. The JavaScript family runs one deterministic
ES module through the probed production native plan across the closed/open x
compiled/interpreted matrix and records the exact compiler, target, optimization
flags, LTO, and strip decisions in its snapshot. The HTTP family runs the fully
closed compiled bare and Express servers. `--full` adds the slower fully closed
self-compile family.

Every classified metric reports the paired median change and a bootstrapped 95%
confidence interval. Wall time and throughput have no minimum effect size: a
repeatable small gain can count when the interval excludes zero. p99 latency,
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
The base revision must contain the paired-runner support; use a recent checkpoint
when investigating older history.

For Express JavaScript profiles without sockets or HTTP parsing, run
`bench/http/express-in-process.cjs`. It calls the existing Express fixture through
`app.handle()`, checks response bodies and statuses on every request, and prints
JSON timings and response oracles. The mix is 60% routes, 20% JSON, and 20% forms.

```sh
node src/index.ts build bench/http/express-in-process.cjs --production \
  --config bench/http/express.config.mts --artifact .cache/express-in-process
EXPRESS_REQUESTS=100000 node bench/http/express-in-process.cjs
EXPRESS_REQUESTS=100000 .cache/express-in-process/bin/maligator
EXPRESS_IN_PROCESS_MODE=raw EXPRESS_REQUESTS=100000 .cache/express-in-process/bin/maligator
```

The default `parsed` mode supplies pre-parsed bodies; `raw` feeds JSON and form
payloads through in-memory Readable streams and the real body parsers. Neither
mode opens a listener. `EXPRESS_ADAPTER_CONTROL=1` measures the same request and
response adapters without Express; raw controls drain the body stream. Keep this
control separate rather than subtracting it from Express timings. Runs warm 10,000
requests before timing; alternate repeated production runs and compare identical
response oracles. `EXPRESS_DURATION_MS` extends a run for physical stack sampling.

Inspect all planned work before a time-sensitive experiment:

```sh
npm run bench -- self-compile --compare HEAD --runs 1 --max-pairs 1 --budget-seconds 600 --plan=json
```

Remove `--plan=json` to execute. `--runs` counts measured pairs; each comparison
also warms both sources. A self-compile snapshot includes a native build, three
cold pairs, a warmup pair, the requested measured pairs, phase/counter/owner
instrumentation, and a resource pair. A one-pair comparison can therefore exceed
ten minutes. The plan reports this additional work explicitly. Each snapshot also
records the self-compiler executable and code-section sizes, and static counts from
the warmup pair's emitted C: root publication stores and clears, inactive-mask
publications, register stores of undefined, throw checks, and runtime call sites.

`--budget-seconds` bounds each comparison invocation, including preparation and
warmup. The runner stops its child process group at the deadline and allows a short
shutdown grace period before forcing termination. Exit 2 means failed or incomplete,
never a passing performance claim. Completed snapshots and pairs remain available;
single-family self-compile comparisons also checkpoint between stages. Resume with
the same command plus `--resume <run-directory>` and a fresh time budget. Comparisons
capture the baseline and candidate source, including dirty tracked files and
non-ignored untracked files, under the run directory before warmup. Installed
candidate dependencies are copied there; an identical baseline lockfile shares that
copy, while a different lockfile installs its own dependencies. Checkout edits can
continue during the run. Resume reuses the captured revisions and content, even if
the checkout or named baseline ref has moved; options and host identity must match.
Changes to captured source invalidate the run. Old reports without captured inputs
cannot resume.
Only complete pairs contribute metrics; a partial pair is retained but excluded.

### Bounded native runtime and compiler checks

`node scripts/native-micro-compare.ts --base REF --plan=json` describes a focused
comparison of the baseline compiler and the current checkout. Remove `--plan=json`
to execute, or select canonical kernels with repeated `--case ID` arguments:

```sh
node scripts/native-micro-compare.ts --base REF \
  --case stable-shape-properties --case heap-valued-projection \
  --pairs 7 --target-node-ms 80 --budget-seconds 2400 --plan=json
```

The default set contains six call, record, and allocation controls plus seven
property/root-publication probes. The runner archives the baseline under its new
`.cache/native-micro/` evidence directory and uses the same frozen fixture paths
for both compilers. It requires identical dependency lockfiles and native build
plans, records five in-process warmups per invocation, calibrates the shared work
scale against Node with a native timeout cap, and alternates seven measured pairs.
Each sample must match Node's case ID, scale, checksum, and operation count.

`report.json` preserves every sample and complete pair, paired median reduction
and median absolute deviation, source and fixture digests, native toolchain
identity, generated C and compiler artifact bytes, executable and ELF `.text`
bytes, build phases, and cache reuse. The command requires GNU-compatible `size`
for its section measurement. Build timings are single observations with recorded
cache state. They do not establish a build-time improvement. Logs, generated C,
and fixtures remain in the report directory; the disposable baseline archive and
source export are removed. Exit 2 marks failed or incomplete work, and a completed
report does not classify a performance win.

On Linux, `--diagnostics` also retains the exact timed production ELF, a symbol
companion copied before stripping, generated-function sizes, and disassembly.
It requires `llvm-nm-19` and `llvm-objdump-19`. A unique final-link cache key forces
that copy without changing production flags or discarding reusable generated
objects and runtime archives. Reapplying the recorded strip command must reproduce
the measured executable byte for byte; the companion's `.text` bytes and address
must also match. Function indices map symbols to the captured ProgramImage;
inlined or eliminated functions with no final symbol remain unattributed.

`--perf-pairs 3` adds separate counter samples after the ordinary timing pairs and
requires diagnostics. The runner probes PMU availability without changing kernel
policy or privileges. Unavailable counters are explicit, and every counter process
must pass the same output oracle. Counters include startup and five warmups, so
they are whole-process evidence rather than the timed kernel interval. Reports
preserve ordinary timing completeness separately from counter status. The micro
workflow enables both options and uploads one compressed executable bundle per
case, each capped at 31 MiB, alongside the reports and disassembly.

Same-repository pull requests can opt into the `Native performance` workflow with
these labels. Adding a label starts only that family; pushing a new head starts
every currently labeled family. Remove other family labels before a push when
only one family needs to run:

| Label                         | Work per distinct baseline                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `native-performance`          | Separate closed-compiled and open-compiled JavaScript comparisons, five initial pairs, up to seven pairs, 45-minute comparison budgets         |
| `native-micro-performance`    | The 13 frozen micro kernels above, seven pairs, a 40-minute total build/run budget                                                             |
| `native-compiler-performance` | One source-only compiler program, two native captures built with `--program` pointing to it, then parser and shape slices with five pairs each |

Every family compares the candidate with `git merge-base HEAD PR_BASE_SHA` and,
when different, with `git merge-base HEAD origin/main` for cumulative stacked-PR
evidence. JavaScript and micro jobs have 55-minute ceilings; compiler jobs have a
70-minute ceiling. Compiler captures use 15-minute build budgets, the parser slice
has an eight-minute comparison budget, and the shape slice has a 25-minute budget.
The compiler lane uses `self-compile-experiment.ts`'s frozen Node output oracle and retains its build
events, captured source identities, output digests, resource logs, and partial reports. The
workflow uploads evidence even on failure, preserves failing exit codes, and
does not update benchmark baselines. These checks complement the ordinary test
gate; use the raw variability and completeness records when assessing a change.
Classified metrics absent from any source/sample, such as native-build RSS on cache hits,
are listed under `unpairedMetrics` and excluded rather than treated as zero.
Captured source changes during execution invalidate resumption, even if later reverted.
Run `env:check` and inspect cache activity before each resume, since power and CPU
load can change between invocations.

On completion the runner removes both source copies and their dependencies while
retaining reports and snapshots. Interrupted runs, including incomplete HTTP GC
diagnostics, retain the source copies and self-compile scratch inside the run
directory for resumption. After confirming the run has stopped,
removing its directory discards only that run's evidence and scratch. Shared native
artifacts remain under normal cache management.

`npm run bench -- javascript --compare HEAD --ablate-core-family guarded-direct-call`
compares the normal compiler with a candidate that skips guarded direct-call
emission after plan selection. Discovery, admission, and budget charges stay fixed.

## Short compiler macro-benchmarks

On battery, extract a few seconds of compiler work without running a full
self-compile. Both `--baseline` and optional `--candidate` accept a Git revision or an existing
source checkout; the candidate defaults to the current working tree:

```sh
npm run bench:compiler-macros -- --baseline HEAD --plan=json
npm run bench:compiler-macros -- --baseline HEAD --seconds 2 --pairs 3 --output .cache/compiler-macros
```

The runner exports both sources into temporary directories, overlays identical
benchmark fixtures, and removes the exports in `finally`. `roots` replays the 24
largest execution graphs captured by compiling the baseline accessor fixture;
`backedges` runs native backedge discovery on those same graphs. `accessors` walks
real Core storage, kernel columns, and opcode registry entries. `optimizer` runs
the Node compiler on the frozen baseline accessor graph, through runtime-image
serialization. `lowering` replays both backend realizations from sealed optimized Core;
its timer includes shared preparation and backend verification, with C and wire
checksums computed outside the timer. `flow` replays six analysis engines and four consumers per engine over unchanged Core functions,
starting each replay with cold transfer state. `flow-membership` warms stable
transfers, then appends unrelated functions between repeated consumer queries.
`constants` compacts a captured
compiler image with an unused trailing constant; `emission` renders that image.
Every case except `optimizer` and `lowering` runs on Node and compiled native binaries.
Use `--cases roots,backedges` or `--hosts node` to narrow the selection.

Calibration runs only on the baseline and fixes the iteration count for both
revisions. One warmup per revision precedes alternating pairs. Timed regions
exclude startup and input parsing; native checks also match the Node checksum.
The executable macros require the same checksum across revisions; optimizer
output must remain deterministic within each revision because code-generation
decisions can change runtime-image bytes. The report records source and fixture
hashes, power state, raw samples, and output checksums. Preparation counts against `--budget-seconds` (default 600).
These slices diagnose mechanisms; full self-compile and CI acceptance remain
separate. No saved benchmark baseline is replaced.

For ordinary full self-compilation without the comparison workflow's diagnostic
passes, use `scripts/bench-quick.ts`. It accepts immutable Git revisions or existing
checkouts and records each revision's Node output oracle before native timing:

```sh
node scripts/bench-quick.ts --baseline REF --candidate HEAD --workload self-compile-node --pairs 3 --budget-seconds 900 --output .cache/self-node --plan=json
node scripts/bench-quick.ts --baseline REF --candidate HEAD --workload self-compile --pairs 3 --budget-seconds 1800 --output .cache/self-native
```

`self-compile-node` needs no native toolchain. Both modes freeze the same baseline
input, alternate fresh processes, and check every output against its revision's
oracle. The native mode builds production compilers once. Git exports retain their
exact source identity without creating worktrees. Preparation, oracles and warmups
count against the budget; reports and exports remain under the requested output.

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
input and must exactly match its revision's Node output oracle in both emitted C and stripped
runtime-image bytes. Runtime serialization and file writes count toward `writeMs`;
raw byte hashing happens after the measured compiler process exits. Capture schema 5
requires fresh captures using this protocol; its timings include serialization and
cannot be compared directly with historical C-only timings.

To measure code-generation changes, first capture `.cache/compiler-program`, then
capture both baseline and candidate with `--program .cache/compiler-program`.
Both host compilers compile that same frozen JavaScript source at the same path,
so the resulting native executables can still be checked against an exact Node
oracle. Each capture preserves the frozen source and its original manifest digest.
This isolates the speed of the generated native program; measuring a changed
compiler's own output still requires semantic benchmarks when emitted C differs.

Warm comparisons require each capture's native output to match its own Node
output on the same frozen baseline input.
Different revisions may generate different code; semantic fixtures establish
observable behavior across revisions. This protocol adds a second Node oracle and
retains it in `oracle-candidate.json`. Use `--shared-oracle` only when identical
generated output across revisions is part of the experiment's contract.

For a guarded direct-call ablation, capture both compilers from one frozen program
source and pass `--ablate-core-family guarded-direct-call` only to the candidate
`capture`. This omits already selected guarded call plans during target lowering;
the timed compilers use the same ordinary evaluation policy and output oracle.
Use `--ablate-core-family priority-scheduling` to build a compiler with the
previous global-priority candidate order while leaving its timed evaluation
policy and budget limits unchanged.

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

## DX performance exercise

`npm run bench:dx -- <maligator-binary>` creates an isolated representative
Express, Drizzle, Valibot, SQLite, and TypeScript project. It reports cold and
warm `run` and `test` latency plus cold and cached `dev` startup and a leaf-edit
restart. Development measurements check the application's served revision before
and after the edit; a compiler restart message alone cannot satisfy the check.
Use `--only run`, `--only test`, or `--only dev` for independent lanes,
and `--fresh-cache` to give the selected project a disposable empty user cache.
The generated project and optional fresh cache are removed afterward. Add
`--assets` after the binary to include the deliberately slower 100-file configured-
asset path; this is optional while development assets still require the native
toolchain.

The exercise records measurements rather than enforcing machine-specific timing
thresholds. Performance changes should compare the same binary, host, and cache
scenario before and after the change.

The development driver rejects child exits while waiting for readiness and checks
the complete HTTP response body. Readiness is bounded to two minutes; shutdown
allows 1.5 seconds for SIGTERM before SIGKILL and waits for stdio to close within
five seconds. Retained diagnostics include final stdout and stderr. Run
`npm run test:unit:full-only -- --run tests/development-driver.test.ts` for the
controlled stale-revision, unfinished-response, early-exit, and ignored-SIGTERM cases.
