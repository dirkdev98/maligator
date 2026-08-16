# Performance profiles

Maligator profiles through the commands developers already use. `--profile` builds
a sampling image. `--profile=compiler` adds an exact source-site census for compiler
work: site executions, guarded fallbacks, allocator-charged allocation count/bytes,
boxing, safepoints, and GC starts. Both are separately compiled production images;
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
compiler totals when enabled, and the seven hottest source findings. It leaves the
complete capture under
`.maligator/profiles/<timestamp>-run-<build-id>/`. Set
`MALIGATOR_PROFILE_DIRECTORY` when automation needs a known output directory.

Use `--profile=compiler` when sparse samples identify a phase but cannot explain
which optimized operation executed. This mode builds with `MAL_PERF_STATS`, stores
its dense counter table separately, and is intentionally more intrusive than the
sampling image. It is the machine-readable choice for agents: `compiler.json`
contains stable identities, final-backend decisions and reason codes, and exact
event counts for each tracked site. Do not use its wall time as a production
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
`MAL_PROFILE_CAPTURE` path. A directly launched `--profile=compiler` binary also
needs `MAL_PROFILE_COMPILER=1`; it publishes the exact census at
`$MAL_PROFILE_CAPTURE.compiler`.

## What is recorded

The sampling signal only requests work. `ITIMER_PROF` and delay accounting both use
process CPU time; monotonic wall time remains the artifact timeline. The runtime
records a bounded logical JS stack at existing VM safe points, outside the signal
handler and without allocating
on the managed heap. Multiple delivered ticks handled at one safe point share one
stack walk but retain separate delay records. Stacks deeper than 128 logical frames
retain the leaf-most 128 frames, add an explicit missing-outer-frames node to
`cpu.cpuprofile`, and count every omitted frame. It also samples managed cells, raw
payloads, selected native backing stores, and records major/minor GC begin/end events.
This gives compiled and interpreted frames the same source identity while keeping
native implementation frames out of the user-facing result.

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
safe within one build. Cross-build matching accepts a unique structural match and
reports duplicate origins as ambiguous instead of guessing.

Remarks are emitted only after the final native variant has been selected. Each
remark records the backend phase, operation, stable decision code, outcome, reason
code, opcode details, and exact site ID. Functions that remain in bytecode receive an
explicit `native-backend-not-selected` fallback rather than a guessed native remark.

## Report layout

The completeness marker, `manifest.json`, is published last. Its absence means the
directory is partial and should not be treated as a finished report.

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `capture.bin`          | Bounded v3 raw CPU/Poisson-allocation/GC records                     |
| `capture.bin.compiler` | Exact v2 event and allocation-family census                          |
| `metadata.json`        | Exact build ID, functions, source sites, and compiler remarks        |
| `cpu.cpuprofile`       | Logical JS stacks for Chromium DevTools-compatible viewers           |
| `timeline.json`        | GC begin/end events in trace-event form                              |
| `allocations.json`     | Source-ranked sampled allocation evidence                            |
| `remarks.jsonl`        | Structured optimizer decisions for profile sites                     |
| `compiler.json`        | Source-ranked exact counters and final decisions (compiler mode)     |
| `summary.json`         | Joined hot evidence, source locations, decisions, and confidence     |
| `manifest.json`        | Capture totals, delay/drop quality, build identity, and completeness |

The joined findings keep CPU and allocation confidence separate and use all CPU
records as the percentage denominator. `manifest.json` reports attributed and
unattributed records; Poisson estimates and literal requested/charged sample sums;
storage/family breakdowns; stack truncation; GC totals and pauses; and exact compiler
totals. Consumers can distinguish the estimate from its sampled evidence.

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

The sampler is compiled out of ordinary binaries. Exact counters are additionally
compiled out of sampling-only profile images. Sampling images begin with small
record/frame buffers and grow them only as evidence arrives. For an active sampling
build, the acceptance target is less than 3% median overhead across language,
allocation-heavy, GC, and HTTP lanes, with output parity, GC verification, and zero
capture loss. Run `npm run bench:profile-overhead`; its alternating pairs and raw JSON
make the check reproducible. The 2026-08-15 five-pair check measured 1.14%, 1.46%,
1.14%, and 1.87% respectively. Re-measure this contract when changing the profiler
or adding an event source.

Compiler-census images have a separate cache identity and no low-overhead promise.
Dense totals track at most 65,536 source sites. The storage/family/object-kind
breakdown is a sparse open-addressed table capped at 16,384 slots and 75% occupancy;
new keys beyond that point aggregate into an explicit overflow row, while the dense
global and per-site count/requested/charged totals remain exact.

For changes to Maligator itself, use the paired benchmark workflow in
[`testing.md`](testing.md). It alternates base and head runs, retains raw samples,
and distinguishes meaningful regressions from noise; a single benchmark delta is
not sufficient evidence for keeping or reverting an optimization.
