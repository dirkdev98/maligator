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

The recorder has since moved its sample-delay accounting onto process CPU time,
made stack truncation explicit while retaining the true leaf, and replaced the
64 KiB allocation trigger with 512 KiB Poisson sampling over allocator-charged
bytes. Managed cells, raw payloads, and selected native backing stores now retain
coarse allocation families plus requested and charged sizes. The common sampling
budget decrement is inline, and record/frame buffers grow on demand instead of
eagerly reserving roughly 15 MiB. A five-pair `bench:profile-overhead` recheck on
2026-08-15 measured 1.14% language, 1.46% allocation-heavy, 1.14% GC, and 1.87%
Express median overhead, with identical output, GC verification preflights, and no
dropped records or frames in any lane. Keep these local measurements reproducible
evidence rather than a committed benchmark baseline.

The highest-priority issue is trust in the explanation layer. The current report says
hot `String#split` and `slice` sites stayed generic even though the final generated C
contains `mal_builtin_string_split_projection` and
`mal_builtin_string_slice_to_number_direct` at those sites. Raw samples are useful;
compiler remarks must describe the final emitted path before they guide optimization.
The raw sampler has nevertheless proven useful for target selection: its line-60
`String#search` signal led to the fixed-literal RegExp construction-elision checkpoint.
That checkpoint removed the exact 105,600 targeted executions, cut managed allocation
by about 8 MiB, and produced a paired 6.63% string-lane wall win. Treat this as evidence
that source attribution works, while retaining the quality caveats above and requiring
generated-code inspection plus paired measurement for every optimization claim.

A fresh production profile of `bench/language.js` after the string campaign produced
only 12 CPU samples, so every CPU ranking was low evidence. Its one strong allocation
finding was the whole `JSON.parse(encoded).map(normalize)` expression at line 212 (129
samples), which combines parser output, Array mapping, normalizer calls, object-rest
copying, and result allocation under one source site. That is useful phase-level
attribution but cannot select the object-rest optimization by itself; the existing
exact runtime counters (466,560 exclusion checks in prior instrumented runs) and
generated COPY_DATA_PROPERTIES sites remain the actionable proof. The profiler needs
operation-level allocation attribution or nested logical sites before it can separate
this cluster.

A follow-up at the supported expert interval of 1 ms collected 57 CPU and 150
allocation samples with no dropped records, but was correctly marked biased at 2.7 ms
median / 9.0 ms p99 delay. The same line-212 cluster held 20 CPU samples (35.1%) and
129 allocation samples; dense-array construction at line 86 held 12 CPU samples
(21.1%), while the hottest particle property site had only 3 (5.3%). This is useful
directional evidence for an aggregate/call-region probe, not a precise CPU ranking.
It also exposes a presentation defect: the joined finding is labelled `high`
confidence because CPU and allocation samples are combined, even though the CPU
evidence remains sparse and the whole capture is biased. Confidence must be reported
per evidence kind and capped by capture quality.

An exact allocation census of that cluster provides the missing calibration. Reusing
only the invariant JSON parse result removes 10,900,384 of 27,107,088 managed bytes,
including 186,160 string allocations and 32,936 coallocated objects. Extending the
source-only ceiling through normalized-row reuse reaches 11,723,136 bytes, only a
modest additional managed reduction, and removes 50,120 coallocations in total. The
sampler correctly found the phase, but its
129 line-level allocation samples cannot distinguish parser strings/objects from map
arrays and normalized rows. Add exact event-family counters or nested logical sites
for these composite expressions; use allocation sampling to show hotspot movement,
not to claim which sub-operation supplied the bytes.

The first post-cache 1 ms profile confirms hotspot movement but sharpens the same
trust limits. It was complete with no drops, yet globally biased: 52 CPU and 60
allocation samples at a 2.94 ms median / 11.53 ms p99 effective delay. The dense
range fill at line 86 repeated as the leading CPU signal (11/52, after 12/57 in the
previous capture), while the former parse/map cluster fell from 129/150 to 40/60
allocation samples. Thirteen allocation samples are absent from `allocations.json`;
surface unattributed counts and bytes explicitly. RAW/native backing allocations are
also invisible, so the range Array's roughly 13.1 MB of vector growth traffic appears
as only one 64-byte allocation sample. Sample those families or join exact RAW event
counters to source sites. Finally, emit a final-backend remark for the retained
activation-local parse-template fill/hit/fallback: line 212 still reports only a
generic call and static load, hiding the optimization that moved the profile.

The post-affine 1 ms capture at `8429611e` provides a second useful movement check.
It completed with no drops, but remained biased: 34 CPU and 57 allocation samples at
2.39 ms median / 10.69 ms p99 effective delay. The former dense-range producer no
longer appears as an allocation center after 800 Arrays, 800,000 stores, and
1,600,000 loads were virtualized, while line 212 still carries 9 CPU and 38 allocation
samples. Twelve allocation samples are absent from `allocations.json`. The report
labels line 212 medium confidence even though the CPU evidence is sparse and capture
quality is biased, and the remaining line-88 finding still says `property.dynamic-load`
instead of reporting the final affine substitution. This confirms that final-backend
operation identity plus separate CPU/allocation confidence is the highest-value next
profiler improvement; collecting more samples alone will not repair the explanation.

- [x] Generate optimization remarks from final backend decisions, with exact operation
      identity and stable reason codes such as unknown target set, invalidatable epoch,
      escaping result, unsupported consumer, or representation mismatch. Do not merge
      multiple same-kind operations that share one source position.
- [x] Split CPU and allocation evidence quality. Report CPU sample counts or intervals
      beside percentages, and never upgrade a one-sample CPU claim to high confidence
      because the same site has many allocation samples.
- [x] Make allocation evidence physically meaningful: preserve heap/cell kind, include
      raw payload and native backing allocations where practical, and either estimate
      bytes using the sampling interval and an unbiased sampling scheme or rename the
      current sum of triggering allocation sizes. State clearly that this is neither
      retained memory nor RSS.
- [ ] Add a repeat, warmup, or minimum-duration mode for short commands and a CLI to
      render/open an existing capture. Document the interval override as an expert
      diagnostic whose overhead and bias must be rechecked.
- [x] Add an optional deterministic phase/function timer for benchmark target selection.
      The post-affine 34-sample capture cannot distinguish unattributed native loops
      from helper-visible sites, so inexpensive entry/exit wall totals for the seven
      language phases would replace modeled ceilings without pretending sparse samples
      can rank them. Profile-enabled self-host images now record strictly nested phase
      boundaries for graph, semantics, IR compilation, optimization, register
      allocation, lowering, and serialization. Reports publish monotonic-wall inclusive
      and self time in `phases.json` and `timeline.json`; unmatched boundaries bias the
      capture. The marker methods are absent from ordinary product images.
- [ ] Add real `--help`/unknown-option handling to `scripts/bench.ts`. Today `--help`
      is treated as no lane selection and starts the full benchmark suite, including
      an expensive Rust rebuild; help and invalid flags must exit before any build.
- [x] Use one clock domain for sampling and delay quality. `ITIMER_PROF` advances in
      process CPU time while the current expected timestamp uses monotonic wall time,
      so descheduling or I/O can be misreported as delayed safepoint sampling.
- [x] Count per-stack depth/capacity truncation as omitted frames, preserve the true
      leaf in the retained tail, render missing outer frames explicitly, report
      unattributed CPU/allocation records, and use all CPU records as the share
      denominator. Any dropped record, omitted frame, or unmatched GC event biases
      the capture.
- [x] Fingerprint the exact metadata/build in `capture.bin` so a raw capture cannot be
      finalized against a structurally plausible but incorrect sidecar. Current raw
      sampling and exact-counter artifacts carry the same SHA-256 identity over the
      binary hash and canonical metadata; finalization verifies all three before
      publishing derived reports, while legacy captures are explicitly unbound.
- [x] Add optional native/runtime attribution so a hot logical site can be separated
      into dispatch, string scan, allocation, GC, regexp, and host work without raising
      the default profile above its current overhead envelope. Exact compiler images
      now count native dispatch plus tagged String, RegExp, and reached host-module
      entries per source site, alongside the existing exact allocation and GC rows;
      direct specialized String/RegExp helpers are instrumented in generated code.
      Reports rank these runtime entries independently and expose them in schema-4
      exact artifacts. These are boundary-entry counts, not synthetic CPU durations.
      Ordinary and sampling images compile the fields and increments out.
- [x] Add an exact event census keyed by final-backend logical site or
      region ID. Attribute load-region, store-region, watched-load, call, boxing,
      allocation count, and allocation bytes to the final emitted operation so the
      report can expose facts such as the particle region's 13.5 million loads and
      4.5 million stores or the reduce region's roughly 2.4 million watched Math
      operations without reconstructing them from global counters and sparse samples.
      Keep the table compiler-profile-only so ordinary product images remain unchanged;
      exact images cover every emitted source site and report attribution explicitly.
- [ ] Improve paired-benchmark turnaround: show adaptive pair progress, avoid treating a
      redundant derived ratio as decisive when both component timings are unchanged,
      and make the maximum-pair/inconclusive outcome explicit. A no-op module comparison
      needed all 15 pairs and still left the ratio inconclusive. Preserve distinct
      policies for elapsed-time ratios, where lower is better, and HTTP throughput
      ratios, where higher is better. The general wall/throughput confidence threshold
      is 2%: require a central change of at least 2% and a confidence interval that
      excludes zero. Retain the win when representative controls do not regress. An
      independently substantial, repeatable allocation/RSS reduction is also retainable
      when semantics are exact and representative wall-time controls show no credible
      slowdown; do not force memory wins to manufacture a CPU headline. An expert
      `--max-pairs` override now permits a longer exact comparison when the
      default 15-pair ceiling cannot resolve a small change; progress reporting remains.
- [x] Recheck profiler overhead on language, allocation-heavy, GC, and HTTP workloads.
      Keep ordinary images free of profiling instrumentation, target less than 3%
      median CPU overhead for profiled images, and reject regressions in output, GC
      verification, or capture completeness. `npm run bench:profile-overhead` now
      builds both images, alternates pairs, parses every capture, and gates all four
      lanes; the 2026-08-15 five-pair medians were 1.14%, 1.46%, 1.14%, and 1.87%
      respectively, with complete captures. After the v4 phase/runtime attribution
      work, the 2026-08-16 medians were 0.38%, 0.99%, 2.21%, and 0.09%; all captures
      again had zero record or frame loss.
- [ ] Harden the authenticated Claude/Fable review harness. The host keychain/session
      path now completes long read-only repository audits through the 30-minute alarm
      wrapper without exposing the cookie, including the affine/provider reviews on
      2026-08-14. Keep the tiny read-only smoke and exact timeout/process cleanup because
      earlier `plan`, `dontAsk`, and stdin invocations hung silently. The external-call
      safety layer still requires fresh explicit approval before sending internal
      architecture and benchmark payloads to Claude.ai; keep that disclosure separate
      from authentication.

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
