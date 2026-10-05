# Supervised application images

The native CLI owns compiler workers and application generations for the lifetime
of a command. Ordinary development compilation runs in persistent
`maligator:workers` executors;
ordinary compatible run, dev and test images execute in fresh application
isolates. Each launch owns its VM, heap, module instances, event loop and child
workers. A new generation never inherits JavaScript state from the previous one.

The source CLI keeps Node support for `build`. Its development build transport
uses a Node worker around the same compilation kernel. The exported synchronous
build API remains serial. Production CLI builds can opt into independent root
compilation with `--compile-concurrency 1..3`, a total CPU-job budget including the
owner. The default is one. Two helpers overlap worker-image compilation with the
owner's unchanged full optimizer, then join before ordered publication. Cache hits
and graphs without worker roots admit no helpers. Native-function rendering stays
serial: that finer seam did not earn its startup and program-cloning costs.

Three interleaved Node CLI pairs per workload on October 5, 2026, on an M3 Pro
measured mean whole build wall time of 19.87 to 14.89 seconds for a dependency-heavy
Express worker application and 112.53 to 66.51 seconds for the compiler holdout,
reductions of 25.0% and 40.9%. Median compiler time was 112.83 to 59.46 seconds;
the first parallel sample's longer cached native-binary phase remains included in
the mean. All 88 application and 400 compiler translation units, native binaries
and executed output matched. These were forced frontend compilations with seeded
warm native runtime, object and binary caches behind identical lexical paths,
not cold native builds or ordinary frontend cache hits.

Mean whole-command CPU increased 48.5% for the application and 16.5% for the
compiler. Application mean Node peak RSS increased 9.5%; compiler median Node
peak RSS increased 32%. Node process peak RSS includes helper threads and excludes
external native compiler children. It is separate from whole-command CPU and is
not an aggregate process-tree memory peak. Ordinary unchanged builds reused the
frontend cache and admitted no helpers; that path has no demonstrated root-overlap
gain. Default and explicit-budget-one controls retained serial timing.

Three interleaved pairs using the rebuilt native CLI on the worker application
measured mean whole build wall time of 107.87 to 69.65 seconds with budgets one
and three, a 35.4% reduction. Mean CPU increased 15.4% and Darwin maximum RSS
increased 2.9%. All 89 generated translation units, eight compiler/runtime images,
native binaries, ordered worker roots, diagnostics and executed output matched.
These runs also forced the full frontend with identical seeded warm native caches;
they compare budgets within the same current binary. Darwin maximum RSS is a
command resource statistic, not a simultaneous aggregate process-tree peak.

The rebuilt package passes the full build/run/dev/test command checks, including
production root parity and cache reuse, actual profiling captures, thread/process
selection, served development revisions and test-watch cancellation. Native
transport lifetime and large-message checks also pass Linux ASan/UBSan. Adding the
root compiler entry increased the packaged executable from 261.1 to 317.4 MB
(21.5%); the budget comparison does not measure this package-size cost.

Root overlap applies only to this opt-in production build. Non-production builds
prepare in a background compiler; run joins preparation before a fresh application;
dev overlaps compilation with its last good application and responsive watcher.
Test file isolation uses separate bounded compile and execution queues while the
default suite remains one shared application. Roots inside those existing service
and test jobs stay serial to avoid unmeasured nested oversubscription. Parallel
frontend diagnostics label owner parse counts separately; the overlapping root
window includes owner work and must not be added to owner compile time.

## Image and registry ownership

The development host loads a descriptor containing digest-checked runtime wires,
an optional static worker manifest, an asset snapshot and the required runtime
policy. Loading copies immutable artifact bytes; launching decodes and splices
private mutable image state into a fresh VM. Files may change or disappear after
loading without changing that loaded image.

Every bundle has a retained worker domain. Compiler workers and different
application generations can register the same canonical worker URL without
replacing each other's code. Worker URLs and messages carrying them retain their
originating domain, including its asset snapshot. Releasing the supervisor's
image handle prevents further launches through that handle; existing applications,
children and escaped URLs retain the resources they still need.

These host launch APIs are development capabilities. Public `createWorkerUrl`
continues to require a statically resolved entry graph; loading arbitrary runtime
source is not part of that API. Required primordial policy must match the host,
and requested runtime features must be available. Profiled or incompatible
applications use an explicitly selected process runner.

## Lifecycle and failure

Application entry wires evaluate in order, waiting for each entry's top-level
await before proceeding. Module evaluation readiness and application readiness
are separate. `maligator:application.ready()` signals that the application has
completed its own startup work; it is idempotent and returns false outside a
supervised application. The signal does not reserve sockets or establish health.

An application is logically a main thread to `node:worker_threads`, while the
native host still owns it as a cancellable thread. Launch arguments belong to
that application. `process.exit()` ends the application isolate. A thrown value,
including `undefined`, is retained as an error outcome. A test result is a native
snapshot retained until join, so publishing a result cannot race a final message
against thread teardown or hide a later entry failure.

Closing joins descendants and disposes native resources before freeing the
reactor and heap. Evaluation and readiness waiters settle even when an
application fails or exits early. Compiler cancellation is cooperative at phase
boundaries and compiler shutdown drains accepted work; forcibly terminating a
compiler inside a filesystem action lock is outside this recovery contract.

## Command semantics

Dev watches while compilation runs. Changes coalesce into a newest requested
generation. Compilation records the identities of the source and asset files it
actually consumed; publication validates those identities before and after
awaited shutdown/evaluation boundaries. A failed compilation leaves the last
successful application running. A superseded replacement cannot become current.
Applications that need exclusive resources currently use joined stop/start.
Dev does not yet track directory topology for configured assets: adding a new
asset path requires another watched input change to trigger compilation.

Run waits for preparation, launches a fresh application and returns its terminal
outcome. Tests preserve the selected application as one shared module graph by
default. Explicit file isolation creates independent application graphs, with
separate bounded compilation and execution budgets. Results merge in selection
order; bail stops new admissions and joins already admitted applications.
Concurrency changes state-sharing semantics only when isolation is requested.

Test watch retains validated compilation results and loaded images. An unchanged
POSIX SIGHUP rerun creates fresh module state from the retained image. Optional
failed-file selection is a dynamic test invocation mask over the original graph;
it does not remove imports or replace compiled execution options. Source/config
edits return to the original selection, invalidate affected compiler inputs and
discard superseded reports. Shutdown drains compilation, joins applications and
then releases image handles.

`maligator:process.execution` remains a compiled execution snapshot. A cached
rerun keeps its original filter, repeat, bail, timeout and shuffle seed. Changing
those options selects a new compiler identity; live supervisor controls must not
silently override specialized values.

Dev and test watch expose bounded generation and compiler-phase histories with
`--status`. Resource snapshots count owned loaded image handles, unjoined
application threads and direct ordinary workers, plus process-wide worker/domain
counts and retained worker wire bytes. These counters are independent samples;
wire bytes exclude application roots, assets and JavaScript heaps. Application
stdout/stderr still use shared process streams.

## Limits and extensions

Threads share the process working directory, OS file descriptors and native
address space. OS signals remain owned by the supervisor. This is lifecycle
isolation, not crash containment or a security boundary. Environment snapshots
must not become process-global mutation, and
per-application working directories would require a filesystem-wide contract.
More compiler executors multiply retained frontend and program memory; the
default compiler service uses one executor and explicit budgets remain bounded.

Standalone runtime eval currently requires RegExp support for the baked compiler
itself. Supervised execution does not fix that existing feature dependency;
production acceptance exercises eval with RegExp enabled and separately checks
disabled features with eval disabled. The capability separation is tracked in
the [runtime capability backlog](../../TODO.md#realm-correctness-and-runtime-capabilities).

Stable supervisor-owned network ingress, draining traffic handoff, AOT library
loading/unloading, heap snapshots and debugger replay require additional
contracts. Fresh interpreted application launch does not imply any of them.
