# Maligator roadmap

This is the committed cross-project index. Each task has one owning roadmap;
completed work belongs in commits, tests, and benchmark baselines rather than in
active checklists. Test262 verdict counts live only in `scripts/test262.json`.

## Current priorities

1. Alpha release stabilization.
2. Safety and bounded resource use.
3. AOT throughput and allocation elimination.
4. Outbound I/O and server-runtime APIs.
5. ECMAScript correctness and runtime usability.
6. Actors, SMP, GUI embedding, and freestanding targets.

## Alpha release stabilization

The alpha channel is ready for broader use when a user on every supported host can
install Maligator from npm, run the prebuilt product CLI outside this checkout, and
use it to produce and run a production application binary.

### Production build creation

- [x] Smoke-test the production CLI without the repository or Node.js on `PATH`,
      including `--help`, `--version`, `doctor`, `init`, `build --production`, and
      running the resulting application.

### Cross-platform native binaries

- [ ] Validate and document minimum macOS and glibc-based Linux host versions for
      the published arm64/x64 support matrix. Windows remains deferred.
- [ ] Build the product CLI natively for every supported target in CI.
- [ ] Run the release smoke test on every artifact, including a clean host with the
      documented C/C++ and Rust toolchain requirements.

### Release gates and operations

All prereleases must use SemVer alpha versions and publish explicitly under the npm
`alpha` dist-tag. The local release process does not attempt to change or remove the
registry's `latest` tag.

- [ ] Move publishing to a tag-driven workflow with npm trusted publishing after
      the local alpha process has stabilized.
- [ ] Run `npm run test:full:report` for a release candidate and resolve or record
      every failure; this remains approval-only.
- [x] Write concise release notes with the supported matrix, required application
      build toolchains, known limitations, and an issue-reporting path.
- [ ] Define the failed-release procedure: stop the workflow, deprecate a broken npm
      version rather than reusing it, fix forward, and publish a new alpha.

## Queued cross-cutting runtime work

- [ ] Implement or reject `host.scheduler: "multiprocessing"`.
- [ ] Add Intl locale subsetting.

Compiler optimization and analysis are owned by the
[compiler roadmap](docs/roadmaps/compiler.md). Test262 compiler and suite throughput
is owned by the [Test262 performance roadmap](test262-perf-todo.md).

## Performance profiling follow-up

The integrated production profiler is useful now: one `--profile` switch preserves
ordinary production builds, publishes complete self-describing artifacts, attributes
logical JavaScript stacks, reports capture delay and drops, and the paired benchmark
runner retains exact revisions and raw samples. On `bench/string.js`, a default run
collected 17 CPU and 1,387 allocation samples with no drops and 4.2 ms p99 sampling
delay; a 2 ms interval collected 77 CPU samples but correctly marked the capture
biased after six dropped records and 8.0 ms p99 delay. A 31-run product A/B measured
the profile image about 3.0% slower than the ordinary image, leaving little overhead
margin. These measurements are diagnostic evidence, not a committed benchmark
baseline.

The highest-priority issue is trust in the explanation layer. The current report says
hot `String#split` and `slice` sites stayed generic even though the final generated C
contains `mal_builtin_string_split_projection` and
`mal_builtin_string_slice_to_number_direct` at those sites. Raw samples are useful;
compiler remarks must describe the final emitted path before they guide optimization.

- [ ] Generate optimization remarks from final backend decisions, with exact operation
      identity and stable reason codes such as unknown target set, invalidatable epoch,
      escaping result, unsupported consumer, or representation mismatch. Do not merge
      multiple same-kind operations that share one source position.
- [ ] Split CPU and allocation evidence quality. Report CPU sample counts or intervals
      beside percentages, and never upgrade a one-sample CPU claim to high confidence
      because the same site has many allocation samples.
- [ ] Make allocation evidence physically meaningful: preserve heap/cell kind, include
      raw payload and native backing allocations where practical, and either estimate
      bytes using the sampling interval and an unbiased sampling scheme or rename the
      current sum of triggering allocation sizes. State clearly that this is neither
      retained memory nor RSS.
- [ ] Add a repeat, warmup, or minimum-duration mode for short commands and a CLI to
      render/open an existing capture. Document the interval override as an expert
      diagnostic whose overhead and bias must be rechecked.
- [ ] Use one clock domain for sampling and delay quality. `ITIMER_PROF` advances in
      process CPU time while the current expected timestamp uses monotonic wall time,
      so descheduling or I/O can be misreported as delayed safepoint sampling.
- [ ] Make capture integrity explicit: fingerprint the metadata/build in `capture.bin`,
      count per-stack depth truncation as dropped frames, report unattributed CPU
      records, and use all CPU records rather than only mapped leaves as the share
      denominator.
- [ ] Add optional native/runtime attribution so a hot logical site can be separated
      into dispatch, string scan, allocation, GC, regexp, and host work without raising
      the default profile above its current overhead envelope.
- [ ] Improve paired-benchmark turnaround: show adaptive pair progress, avoid treating a
      redundant derived ratio as decisive when both component timings are unchanged,
      and make the maximum-pair/inconclusive outcome explicit. A no-op module comparison
      needed all 15 pairs and still left the ratio inconclusive. Preserve distinct
      policies for elapsed-time ratios, where lower is better, and HTTP throughput
      ratios, where higher is better.
- [ ] Recheck profiler overhead on language, allocation-heavy, GC, and HTTP workloads.
      Keep ordinary images free of profiling instrumentation, target less than 3%
      median CPU overhead for profiled images, and reject regressions in output, GC
      verification, or capture completeness.

## Domain roadmaps

- [Compiler optimization and analysis](docs/roadmaps/compiler.md)
- [GC, allocation, and recoverable OOM](docs/roadmaps/gc.md)
- [Isolates, reactor, actors, and hosts](docs/roadmaps/isolate-reactor.md)
- [WinterTC server profile](docs/roadmaps/wintertc.md)
- [Node and Express compatibility](docs/roadmaps/node-compat.md)
- [eval, Function, and realms](docs/roadmaps/eval-realms.md)
- [Test262 correctness](docs/roadmaps/test262.md)

## Triggered work

These are not active tasks:

- Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- Revisit concurrent GC marker threads and parallel marking when a real big-heap
  workload shows mutator marking is a top cost.
