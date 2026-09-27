# Generational GC workers

Maligator has one non-moving generational collector. Native builds can trace on GC
workers; the `wasm32-wasip1` reactor runs the same collection phases inline because
its embedding has no Wasm threads. Worker capacity is selected from the target and
available CPUs, with no user-selectable collector mode.

## Current ownership boundary

One JavaScript mutator owns a VM from initialization through disposal. The heap and
collector cycle belong to that VM; native workers bind its context before tracing
and join before the VM releases roots or tables. The process still has global root
frame/span heads, root-source and type-hook registrations, allocation color, poll
and barrier flags, and diagnostics. Thus only one active VM/mutator per process is
supported. Thread-local worker attachment does not permit moving a live VM to
another mutator thread or running multiple active isolates. Existing fork children
exec or exit without using the inherited VM; fork-and-continue with a live VM is
unsupported.

The collector uses an old-generation bit and remembered set for minor collections.
An alternating major mark color keeps generation age separate from liveness.
Minors park JavaScript and may parallelize safe trace batches; they do not overlap
an active major. Major roots are scanned at mutator safepoints before background
work begins and again at remark. The compiled root maps and native root spans are
read only while their owner is parked. SATB deletion barriers preserve the initial
major graph, and card barriers preserve old-to-young edges. New allocations are
marked live while a major is in flight.

Workers claim marks atomically, append discoveries to private lists, and transfer
those lists to the mutator only after every worker in a batch acknowledges
completion. An empty mutator grey list cannot end a major while a batch remains
active. The mutator may trace other grey cells during a batch. Remark joins the
batch, rescans roots, drains SATB and grey work to a fixpoint, and processes weak
references and ephemerons. An explicit `gc()` completes the in-flight cycle and
performs a fresh full collection.

Direct tracing during mutation is limited to immutable Symbol descriptions,
immutable AsyncContext links, and Env parent/slot edges whose native slot accesses
are atomic. For ordinary shaped objects and dense arrays, the mutator copies
prototype, shape key/value, and element edges at a safepoint; workers read only
that batch-owned copy. This path excludes overflow tables, host type tracers,
shapes with more than 32 inline properties, and arrays with more than 128 dense
elements. A batch copies at most 2,048 values. All other mutable layouts are
traced by the mutator or while JavaScript is parked. Weak processing, all
finalizers, sweep, allocator free lists, and large-object reclamation remain with
the mutator. Moving sweep to workers would need exclusive block ownership and a
separate mutator-affine finalization handoff; it is deferred unless matched
measurements justify that complexity.

Native storage reserves room for two GC workers. At VM initialization, the active
count is capped by online CPUs, Linux affinity, and commonly mounted cgroup v2/v1
CPU quota files, reserving one visible CPU for the mutator. Zero capacity runs work
inline. Quota discovery is best effort: nested or nonstandard mounts and hidden
ancestor limits may not be visible, so CPU-constrained deployments need a matched
resource check. The pool starts on the first qualifying batch, parks while idle,
and stops before VM teardown. Before the host loop or fiber scheduler waits or
exits with no runnable work, the mutator completes any active cycle and checks
the task queues again. Wasm never starts a native pool.

Root-source registrations remain process-wide across sequential VMs. Registration
deduplicates identical callbacks, rejects capacity exhaustion, and callbacks
tolerate a VM without the subsystem that originally installed them. The GC stats
exit handler is registered once per process.

## Validation boundary

Native overlap fixtures pause a worker after publication but before it reads an
Env slot or copied object/array edges. They check snapshot survival, current
reachability, later reclamation, and completion. One fixture also disposes and
reinitializes a VM while a worker is paused in tracing. ThreadSanitizer covers
those overlap cases. A separate fixture checks idle completion before host exit,
reactor wait, and scheduler exit. GC statistics separate mutator pause time,
worker CPU, copied values and heap values, worker discoveries, and remark join
time. These counters describe work distribution; they do not alone establish an
application speedup.
Large root scans, mutator-only traces, finalization, and synchronous completion
can still create long pauses. Wasm parity and broad performance acceptance are
tracked in [TODO.md](../../TODO.md).

A copying nursery, simultaneous minor and major cycles, compaction, shared-heap
mutators, and multiple active isolates require separate contracts. Draft PRs #65
and #66 must be checked against root publication and property-storage lifetime
before integration.
