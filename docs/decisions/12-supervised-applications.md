# Supervised application images

The native CLI owns compiler workers and application generations for the lifetime
of a command. Compilation runs in persistent `maligator:workers` executors;
ordinary compatible run, dev and test images execute in fresh application
isolates. Each launch owns its VM, heap, module instances, event loop and child
workers. A new generation never inherits JavaScript state from the previous one.

The source CLI keeps Node support for `build`. Its development build transport
uses a Node worker around the same compilation kernel. The exported synchronous
build API and production build path stay synchronous. Parallel native-function
rendering has not earned a production implementation: adding executors also adds
startup, program cloning and memory costs. Production parallelism requires
matched Node-hosted measurements before a native transport is added.

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
