# Performance profiles

Maligator profiles through the commands developers already use. `--profile` builds
a sampling image. `--profile=compiler` adds an exact source-site census for compiler
work: site executions, guarded fallbacks, allocator-charged allocation count/bytes,
boxing, safepoints, GC starts, and native dispatch/string/RegExp/host entries. Both
are separately compiled production images;
ordinary development images and production binaries contain neither profile metadata
nor counter increments.

```sh
maligator run src/index.ts --profile -- workload-argument
maligator dev src/index.ts --profile
maligator test tests/store.test.ts --profile --run "large import"
maligator build src/index.ts --profile
maligator run src/index.ts --profile=compiler -- workload-argument
```

`run --profile` is the shortest path from a representative workload to a report.
It builds with the full optimizer, runs the program once, prints capture quality,
sampling delay, attribution coverage, GC pauses, charged allocation families, exact
compiler totals when enabled, exact fallback/allocation leaders, and the seven hottest
mixed source findings. The exact leader lists are independently ranked from the dense
census, so a high-volume site cannot disappear merely because cooperative sampling
missed it. Profiled self-host compiler runs also print deterministic monotonic-wall
totals for graph construction, semantics, IR compilation, optimization, register
allocation, lowering, and serialization. It leaves the complete capture under
`.maligator/profiles/<timestamp>-run-<build-id>/`. Set
`MALIGATOR_PROFILE_DIRECTORY` when automation needs a known output directory.

Use `--profile=compiler` when sparse samples identify a phase but cannot explain
which optimized operation executed. This mode builds with `MAL_PERF_STATS`, stores
its dense counter table separately, and is intentionally more intrusive than the
sampling image. It is the machine-readable choice for agents: `compiler.json`
contains stable identities, final-backend decisions and reason codes, and exact event
counts for every evidence-bearing source site. Its tracked, reported, and omitted
counts make the remaining dense zero-event sites explicit; their identities and
decisions remain in `metadata.json`. Do not use its wall time as a production
performance measurement.

`dev --profile` preserves one capture per generation. Successful restarts,
ordinary exits, `SIGINT`, and `SIGTERM` finalize the previous generation before
the process is replaced. Profile mode deliberately makes the development loop
slower because every generation is a native production build.

`test --profile` keeps the normal filters, shuffle seed, repeat count, bail policy,
and exit status, but compiles the selected test graph into one cold production AOT
image. It is for investigating a representative slow test selection, not for the
ordinary interpreter-backed test loop.

`build --profile` creates an instrumented binary and writes the matching
`<binary>.profile.json` metadata sidecar. With `--artifact`, that sidecar is copied
to `profile.json` and covered by `artifact.json` and `SHA256SUMS`. The turnkey
report finalization currently belongs to `run`, `dev`, and `test`; a directly
launched profiled binary writes its raw capture only when given a
`MAL_PROFILE_CAPTURE` path. Turnkey commands also pass the sidecar's
`MAL_PROFILE_IDENTITY` automatically; direct launchers that intend to finalize the
capture must pass the `captureIdentity` from `<binary>.profile.json`. A directly
launched `--profile=compiler` binary also needs `MAL_PROFILE_COMPILER=1`; it publishes the exact census at
`$MAL_PROFILE_CAPTURE.compiler`.

## What is recorded

The sampling signal only requests work. `ITIMER_PROF` and delay accounting both use
process CPU time; monotonic wall time remains the artifact timeline. The runtime
records a bounded logical JS stack at existing VM safe points, outside the signal
handler and without allocating
on the managed heap. Multiple delivered ticks handled at one safe point share one
stack walk but retain separate delay records. Stacks deeper than 256 logical frames
retain the leaf-most 256 frames, add an explicit missing-outer-frames node to
`cpu.cpuprofile`, and count every omitted frame. It also samples managed cells, raw
payloads, selected native backing stores, and records major/minor GC begin/end events.
This gives compiled and interpreted frames the same source identity while keeping
native implementation frames out of the user-facing result.

Profile-enabled images may additionally emit explicitly nested phase boundaries.
The self-host compiler wraps its seven existing synchronous phase callbacks with
these markers. Finalization validates strict nesting, reports inclusive and self
monotonic-wall time, and attributes CPU samples, estimated charged allocation, and
GC pauses to the innermost active phase. Innermost attribution keeps nested-phase
evidence additive while inclusive wall time still exposes the whole span. A missing
entry or exit marks the capture biased rather than inventing a duration, and evidence
recorded outside every measured span remains explicit as `unphased`. Phase timing is
deterministic event instrumentation, but its CPU and allocation evidence remains
sampled; it is not a replacement for paired production benchmarks. Use it to select a
target for measurement.

Allocation sampling uses independent Poisson inclusion over allocator-charged bytes
with a 512 KiB mean interval. Each sample preserves requested bytes, charged bytes,
storage (`managed-cell`, `raw-payload`, or `native-backing`), a coarse stable family,
and the exact managed object kind when available. The report applies the sample's
inclusion probability to estimate requested and charged allocation traffic. Charged
means managed size-class capacity, or requested size where an external allocator's
usable size is unavailable. It is allocation traffic—not retained memory, live heap,
peak RSS, or an OS page commitment.

Because sampling is cooperative, long native calls or code with sparse safe points
can delay samples. The manifest reports median and p99 process-CPU delay, dropped
records, per-stack omitted frames, unmatched GC events, and attributed/unattributed
counts. Any loss or truncation marks the capture biased. Treat `quality: "biased"`
as a prompt to change the workload or inspect the raw evidence; treat
`"insufficient"` as a request for a longer run. CPU and
allocation evidence are graded independently; either kind with fewer than 20 samples
is labelled low, and a biased capture caps both labels at low.

The compiler assigns one dense capture-local ID per optimized instruction instance;
same-kind operations at the same source position are never coalesced. Every site has
an `originId` for its syntactic origin, an `instanceId` that includes the inline
caller chain, and a `regionId` for explicitly coarse aggregation. Exact dense IDs are
safe within one build. When a printed ranking contains otherwise identical source
coordinates and operations, it appends that dense site ID so the rows remain visibly
distinct. Cross-build matching accepts a unique structural match and reports duplicate
origins as ambiguous instead of guessing.

Remarks are emitted only after the final native variant has been selected. Each
remark records the backend phase, operation, stable decision code, outcome, reason
code, opcode details, and exact site ID. Functions that remain in bytecode receive an
explicit `native-backend-not-selected` fallback rather than a guessed native remark.

Exact compiler mode also attributes native/runtime boundaries to the current source
site. Every native callback entry counts as dispatch; functions created by the String,
RegExp, or reached host-module installers carry a stable subsystem tag, and direct
specialized String/RegExp helpers are counted in generated code. These are exact
entry counts, not sampled or modeled CPU time. Use them to distinguish what kind of
runtime work a hot site requested, then use phase timing and paired benchmarks for
elapsed-time claims. Allocation count/bytes and GC starts remain separate per-site
events in the same census.

Profile metadata also carries a stable pass trace. Each executed, feature-gated, or
ablated pass records its stage/fixpoint round and before/after deltas for allocation
sites, dynamic calls, boxed operations, property helpers, world guards, and
safepoints. Counter collection is profile-only; ordinary builds do not create a
trace or scan the IR for these metrics.

Compiler benchmark investigations can produce a production ablation build with a
repeatable internal option:

```sh
maligator build bench/case.js --production --profile \
  --ablate-optimization inlining \
  --ablate-optimization static-properties
```

The bounded groups are `constant-folding`, `escape`, `inlining`, and
`static-properties`. Ablations receive distinct frontend cache identities. Compare
one group at a time against the same source, build config, workload, and warmed
measurement protocol; combined ablations are useful for interaction checks but do
not assign an individual transform's effect.

## Report layout

The completeness marker, `manifest.json`, is published last. Its absence means the
directory is partial and should not be treated as a finished report.
Current raw captures embed a SHA-256 identity over the linked binary hash and the
canonical complete metadata sidecar. Finalization recomputes and verifies that
identity before reading source sites, and requires the separate exact-counter file
to carry the same identity. Legacy v1-v3 captures remain readable but are marked
`legacy-unbound`; new captures fail closed when files from different builds are mixed.

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `capture.bin`          | Bounded v4 raw evidence, bound to its build and metadata             |
| `capture.bin.compiler` | Exact v4 census carrying the same capture identity                   |
| `metadata.json`        | Exact build ID, functions, source sites, and compiler remarks        |
| `cpu.cpuprofile`       | Logical JS stacks for Chromium DevTools-compatible viewers           |
| `timeline.json`        | GC and phase begin/end events in trace-event form                    |
| `phases.json`          | Nested phase spans with inclusive, self, and maximum wall time       |
| `allocations.json`     | Source-ranked sampled allocation evidence                            |
| `remarks.jsonl`        | Structured optimizer decisions for profile sites                     |
| `compiler.json`        | Source-ranked nonzero exact counters and final decisions             |
| `summary.json`         | Joined hot evidence, source locations, decisions, and confidence     |
| `manifest.json`        | Capture totals, delay/drop quality, build identity, and completeness |

The potentially large `metadata.json`, `compiler.json`, and `summary.json` tables use
compact JSON to avoid spending profile time and disk space on indentation; all other
artifacts remain human-formatted, and every JSON file is directly parseable.

The joined findings keep CPU and allocation confidence separate and use all CPU
records as the percentage denominator. `manifest.json` reports attributed and
unattributed records; Poisson estimates and literal requested/charged sample sums;
storage/family breakdowns; stack truncation; GC totals and pauses; and exact compiler
totals. It also carries phase span completeness and aggregates when a workload emits
phase markers. Consumers can distinguish the estimate from its sampled evidence.

The findings explain decisions such as a dynamic property cache, a guarded direct
call, or an object that retained observable heap identity. A retained
generic operation is not automatically a compiler bug: optimize it only when the
same site is hot with adequate evidence and the proposed specialization preserves
JavaScript semantics.

## Scope and overhead

This first slice is designed for local and staging investigations. It does not
provide live attach, continuous production collection, heap snapshots, automatic
profile-guided recompilation, or per-test timeout stack capture. Fatal signals that
cannot safely return to a VM safe point may leave a partial directory.

The sampler and private phase-marker runtime methods are compiled out of ordinary
binaries. Exact counters are additionally
compiled out of sampling-only profile images. Sampling images begin with small
record/frame buffers, grow them only as evidence arrives, and allow up to 262,144
records before reporting explicit loss. For an active sampling
build, the acceptance target is less than 3% median overhead across language,
allocation-heavy, GC, and HTTP lanes, with output parity, GC verification, and zero
capture loss. Run `npm run bench:profile-overhead`; its alternating pairs and raw JSON
make the check reproducible. The 2026-08-15 five-pair check measured 1.14%, 1.46%,
1.14%, and 1.87% respectively. Re-measure this contract when changing the profiler
or adding an event source.

Compiler-census images have a separate cache identity and no low-overhead promise.
Dense totals cover every emitted source site and are allocated only when exact
profiling is active. Its twelve rows cover execution, fallback, allocation, boxing,
safepoint, GC, and runtime subsystem entries. The storage/family/object-kind breakdown is a sparse
open-addressed table capped at 16,384 slots and 75% occupancy;
new keys beyond that point aggregate into an explicit overflow row, while the dense
global and per-site count/requested/charged totals remain exact.

For changes to Maligator itself, use the paired benchmark workflow in
[`testing.md`](testing.md). It alternates base and head runs, retains raw samples,
and distinguishes meaningful regressions from noise; a single benchmark delta is
not sufficient evidence for keeping or reverting an optimization.
