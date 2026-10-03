# Worker and process-resource benchmarks

These workloads measure direct MessagePort delivery, the source task pool,
unmodified Tinypool, blocking filesystem work, allocation, memory accounting and
process GC accounting. Every JavaScript workload checks its result, including
transfer detachment and shared-memory task counts. Observed worker participation
is retained for interpreting pool scaling. A worker-free compute case and a
channel with a web event listener provide controls.

First run `npm run env:check -- --json` and inspect CPU activity and
`node src/index.ts cache status`. Build each revision into a separate directory:

```sh
node scripts/build-worker-bench.ts /path/to/baseline .cache/worker-bench/baseline
node scripts/build-worker-bench.ts . .cache/worker-bench/candidate
node scripts/bench-workers.ts --baseline .cache/worker-bench/baseline --candidate .cache/worker-bench/candidate --out .cache/worker-bench/report --runs 3 --budget-seconds 360 --plan=json
node scripts/bench-workers.ts --baseline .cache/worker-bench/baseline --candidate .cache/worker-bench/candidate --out .cache/worker-bench/report --runs 3 --budget-seconds 360
```

The baseline directory must contain the intended source revision and its
dependencies. Builds use the invoking checkout's benchmark inputs for both
revisions. The builder records source and input hashes, production build options,
toolchain identity and binary hashes. The runner rejects mismatched inputs or
build configurations and verifies the current inputs before running Node as a
semantic oracle. It removes ambient `MAL_*` overrides and fixes the process GC
budget for both sides.

The default plan contains 29 cases. `--cases` accepts comma-separated case names
from the plan. One warmup pair precedes alternating measured pairs; `--runs 1` is
a diagnostic screen, while repeated pairs support a performance conclusion.
`report.json` and `samples.json` retain checksums, measured windows, startup and
teardown, wall and CPU time, maximum RSS, identities and completeness. A failed or
unfinished comparison exits unsuccessfully and retains its evidence.

The channel timer case reports five deadline delays during a finite message
flood; those samples do not establish a latency percentile. The native GC cases
isolate accounting contention and do not measure complete collection throughput.
RSS is process-wide and cannot attribute memory to individual workers. These
benchmarks do not count native threads or measure idle CPU. Node's Tinypool
workload supplies the source-pool checksum oracle, without implying identical
admission, cancellation or scheduling contracts.
