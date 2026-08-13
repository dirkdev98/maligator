# Performance profiles

Maligator uses one `--profile` switch on the commands developers already use. A
profile is always a separately compiled production image: ordinary development
images and production binaries contain neither the sampling runtime nor the
profile-site metadata.

```sh
maligator run src/index.ts --profile -- workload-argument
maligator dev src/index.ts --profile
maligator test tests/store.test.ts --profile --run "large import"
maligator build src/index.ts --profile
```

`run --profile` is the shortest path from a representative workload to a report.
It builds with the full optimizer, runs the program once, prints the five hottest
source findings, and leaves the complete capture under
`.maligator/profiles/<timestamp>-run-<build-id>/`. Set
`MALIGATOR_PROFILE_DIRECTORY` when automation needs a known output directory.

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
`MAL_PROFILE_CAPTURE` path.

## What is recorded

The sampling signal only requests work. The runtime records a bounded logical JS
stack at existing VM safe points, outside the signal handler and without allocating
on the managed heap. It also samples managed allocations and records major/minor GC
begin and end events. This gives compiled and interpreted frames the same source
identity while keeping native implementation frames out of the user-facing result.

Because sampling is cooperative, long native calls or code with sparse safe points
can delay samples. The manifest reports median and p99 delay plus dropped record and
frame counts. Treat `quality: "biased"` as a prompt to change the workload or inspect
the raw evidence; treat `"insufficient"` as a request for a longer run. A hot line
with fewer than 20 combined CPU and allocation samples is labelled low evidence.

The compiler assigns dense capture-local site IDs and a structural logical ID based
on source path, containing function, operation, and normalized source. Exact IDs are
safe within one build. Cross-build matching accepts a unique exact or logical match
and reports duplicates as ambiguous instead of guessing.

## Report layout

The completeness marker, `manifest.json`, is published last. Its absence means the
directory is partial and should not be treated as a finished report.

| File               | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `capture.bin`      | Bounded, versioned raw CPU/allocation/GC records                     |
| `metadata.json`    | Exact build ID, functions, source sites, and compiler remarks        |
| `cpu.cpuprofile`   | Logical JS stacks for Chromium DevTools-compatible viewers           |
| `timeline.json`    | GC begin/end events in trace-event form                              |
| `allocations.json` | Source-ranked sampled allocation evidence                            |
| `remarks.jsonl`    | Structured optimizer decisions for profile sites                     |
| `summary.json`     | Joined hot evidence, source locations, decisions, and confidence     |
| `manifest.json`    | Capture totals, delay/drop quality, build identity, and completeness |

The joined findings explain decisions such as a generic dynamic property access,
a guarded direct call, or an object that remained heap allocated. A retained
generic operation is not automatically a compiler bug: optimize it only when the
same site is hot with adequate evidence and the proposed specialization preserves
JavaScript semantics.

## Scope and overhead

This first slice is designed for local and staging investigations. It does not
provide live attach, continuous production collection, heap snapshots, automatic
profile-guided recompilation, or per-test timeout stack capture. Fatal signals that
cannot safely return to a VM safe point may leave a partial directory.

The sampler is compiled out of ordinary binaries. For an active profile build, the
acceptance target is less than 3% wall-time overhead on a representative CPU lane,
with sample delay and drops reported rather than hidden. Re-measure this contract
when changing the profiler or adding a new event source.

For changes to Maligator itself, use the paired benchmark workflow in
[`testing.md`](testing.md). It alternates base and head runs, retains raw samples,
and distinguishes meaningful regressions from noise; a single benchmark delta is
not sufficient evidence for keeping or reverting an optimization.
