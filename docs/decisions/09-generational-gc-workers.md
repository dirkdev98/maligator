# Generational GC workers

Each Maligator isolate has a non-moving generational collector. Native builds can trace on GC
helpers; the `wasm32-wasip1` reactor runs the same collection phases inline because
its embedding has no Wasm threads. Worker capacity is selected from the target and
available CPUs, with no user-selectable collector mode.

## Current ownership boundary

One JavaScript mutator owns a VM from initialization through disposal. The heap and
collector cycle belong to that VM; native workers bind its context before tracing
and join before the VM releases roots or tables. Root frame/span heads, root-source
and type-hook registrations, allocation color, poll and barrier flags, and
diagnostics belong to the mutator thread. Concurrent isolates share no language
heap pointers. Helper attachment binds only the owning collector context; it does
not permit moving a live VM to another mutator thread. Existing fork children
exec or exit without using the inherited VM; fork-and-continue with a live VM is
unsupported.

The collector uses an old-generation bit and remembered set for minor collections.
An alternating major mark color keeps generation age separate from liveness.
Minors park JavaScript and trace inline; measured worker handoff cost exceeded
their short mark work. A minor during a major's marking first joins the major's
workers and never dispatches its own, so native minor mark claims use relaxed atomic
loads and stores under exclusive mutator ownership. Shared major mark claims still
require atomic compare/exchange.
Major roots are scanned at mutator safepoints before background work begins and
again at remark. The compiled root maps and native root spans are read only while
their owner is parked. SATB deletion barriers preserve the initial
major graph, and card barriers preserve old-to-young edges. The SATB buffer holds
at most 4,096 values; a full buffer claims its pending values into the mutator's
grey queue without tracing payloads or scanning roots inside an unrooted native
frame. A major cycle opens with a minor, so its snapshot holds only old cells.
While it marks, new cells carry its color but stay young: the major neither traces
nor records them, and minors settle them, promoting survivors already marked. A
minor runs when the nursery fills and again at remark, before the weak pass, so
garbage born during a long cycle is reclaimed instead of promoted. The sweep
allocates cells old and marked. The opening minor establishes the next nursery
deadline; the major's allocation backstop leaves another nursery increment beyond
it. Reaching that backstop or receiving process pressure completes the cycle
synchronously.

Managed blocks describe their cells with bitmaps: free cells, cells allocated
since the last collection, and cells whose death must run a finalizer.
Allocation claims one bitmap word into a per-class cursor and charges, enrolls
and accounts for its cells at once, so the inline fast path only pops a bit,
clears the cell and writes the header. A minor mark clears each young survivor's
bit, which leaves exactly the dead cells; the minor sweep then reads only dead
cells that own storage. Objects and arrays start without the finalizer bit and
set it when they acquire owned storage, and verification checks every other dead
cell owns nothing. A reclaimed cell keeps its stale header, so the free bitmap
alone decides liveness for conservative roots, heap walks and verification.
Cursors return unused cells before anything reads the bitmaps or changes
allocation color.

Fully empty blocks retain their header and return complete payload pages to the
OS. On Darwin, `MADV_FREE_REUSABLE` marks those pages as idle for physical-footprint
accounting; `MADV_FREE_REUSE` restores active ownership before allocation touches
them again. Unsupported reusable advice falls back to ordinary discard advice.
The mappings remain reserved by the runtime, so logical process reservations do
not fall when payload pages become reusable. This does not reclaim free cells in
blocks that still contain live objects.

Workers append discoveries to private lists and acknowledge completion under the
batch mutex. Only after observing every acknowledgement does the mutator reserve
space for the combined discovery count and copy each list in worker order. The
reservation checks count and byte-size overflow. Workers wait for the next batch
before modifying those lists again, and the batch remains active until the merge
finishes. An empty mutator grey list cannot end a major while a batch remains
active. The mutator may trace other grey cells during a batch. Remark waits for
batch completion, rescans roots, drains SATB and grey work to a fixpoint, and
processes weak references and ephemerons. Batch completion does not stop or join
the worker threads. An explicit `gc()` completes the in-flight cycle and performs
a fresh full collection.

Direct tracing during mutation is limited to immutable Symbol descriptions,
immutable AsyncContext links, and Env parent/slot edges whose native slot accesses
are atomic. For ordinary shaped objects and dense arrays, the mutator copies
prototype, shape key/value, and element edges at a safepoint; workers read only
that batch-owned copy. This path excludes overflow tables, host type tracers,
shapes with more than 32 inline properties, and arrays with more than 128 dense
elements. A batch copies at most 2,048 values. All other mutable layouts are
traced by the mutator or while JavaScript is parked. Weak processing, all
finalizers, sweep, allocator bitmaps, and large-object reclamation remain with
the mutator. Sweep starts after all marking and weak processing finish; no worker
can still update a mark. External weak sources remove dead non-owning FFI aliases
at the ephemeron fixpoint. Cleanup-owning handles reserve their resource until
ordinary finalization, and detached native leases preserve that reservation until
their last release. Weak lookups and owner-bound callbacks shade recovered values
during marking; condemned callback owners cannot enter JavaScript during sweep.
Weak-source registrations belong to the isolate and read the current VM, so they
remain safe across sequential VMs without retaining a discarded host subsystem.

Exhausted Map/Set iterators release their storage pin, compact the collection, and
clear their target with an SATB deletion barrier. A retained exhausted iterator
therefore keeps its sticky completion state without retaining its collection.
Finalization only releases the storage pin and never compacts or publishes edges.

Native block sweeping therefore uses relaxed atomic
mark loads and stores, with no read-modify-write claim needed. Moving sweep to workers
would need exclusive block ownership and a separate mutator-affine finalization
handoff; it is deferred unless matched
measurements justify that complexity.
Incremental sweep tags passed blocks and completed chunks. A black cell allocated
behind the cursor contributes to survivor bytes immediately, while a cell ahead
of it is counted when the cursor visits its block; both update the baseline used
by the next minor collection exactly once.

Native storage reserves room for two GC batch records per isolate. A process-owned
executor supplies at most two helper threads across all isolates. Each batch also
acquires a process grant bounded by available CPUs minus currently busy mutators.
Available CPUs account for online CPUs, Linux affinity, and commonly mounted cgroup
v2/v1 CPU quota files. A denied grant runs work inline. Waking mutators never wait
for a helper already running a bounded quantum. Quota discovery is best effort:
nested or nonstandard mounts and hidden
ancestor limits may not be visible, so CPU-constrained deployments need a matched
resource check. The shared pool starts on demand and parks while idle. Disposing an
isolate waits for its own batches; the last client joins the pool. Before the host loop or fiber scheduler waits or
exits with no runnable work, the mutator completes any active cycle and checks
the task queues again. The Wasm reactor completes any active cycle before init
or a call returns to its embedder. Wasm never starts a native pool.
If the executor cannot start, marking runs inline.

Root-source registrations belong to the current isolate thread. Registration
deduplicates identical callbacks and rejects capacity exhaustion. The GC stats
exit handler is registered once per process.

The process coordinator accounts reserved heap mappings, ordinary and shared
backing stores, owned Request/Response body bytes, and queued native serialization
storage once per allocation. Body copies charge independently; stream-backed bodies
charge only the storage they actually own. Server requests transfer their buffer
capacity with ownership. Encoded and copied bodies charge their logical byte length,
which does not claim to measure malloc's reserved capacity. Body adoption also advances
the mutator's allocation clock and requests a poll at its deadline. Replacement and finalization release
the process charge without subtracting from that monotonic clock. The coordinator's
soft budget defaults to 256 MiB and may be changed with
`MAL_GC_PROCESS_BUDGET_BYTES`. Crossing a pressure threshold requests safepoints
and wakes every registered owner. The first collection is a major and establishes
the managed live-set and owned RAW baselines. Without pressure, another major waits
until minors have promoted as much as the previous managed live set, with a 16 MiB
floor. Under pressure, net growth in owned RAW storage since the previous major also
counts toward that threshold, since old objects can acquire side storage without
promoting managed cells. When the previous managed live set is at most the floor,
pressure starts a major without waiting for debt. A stable large live set avoids
futile majors after every few mapped chunks.
`MAL_GC_MAJOR_EVERY` restores a fixed cadence for tests. Another pressure signal
during an active cycle completes that cycle on its owner, so native growth cannot
outrun a heap-only backstop.
Releasing a temporary memory peak lowers the next threshold to match current
reservations. Sweep and finalization still run on each owner. The
registry lock protects poll targets and reactor wakers through teardown. This
budget paces collection rather than rejecting allocations. Shared memory has a
separate hard reservation limit described in [parallel workers](10-parallel-workers.md).

## Weak collection storage

Weak cleanup filters every dead key after the ephemeron fixpoint, with SATB
marking disabled so deletion cannot revive a dead edge. WeakMap and WeakSet use
[unordered direct buckets](specialized-weak-storage.md); property tables contain
strong entries. Filtering erases dead buckets in place and performs at most one
demotion, shrink or tombstone rebuild after the scan.

Persistent strong Map/Set iterators pin order positions across growth, widening,
deletion and clear. Their owners compact only after the pins permit renumbering.
Map entry hints mirror a live stored key and are invalidated before removing or
renumbering its row. Finalizers release ownership and pins without inspecting
member cells. Layout and transition contracts live in
[specialized Map storage](specialized-map-storage.md) and
[specialized Set storage](specialized-set-storage.md).

## Validation boundary

Native overlap fixtures pause a worker after publication but before it reads an
Env slot or copied object/array edges. They check snapshot survival, current
reachability, later reclamation, and completion. One fixture also disposes and
reinitializes a VM while a worker is paused in tracing. ThreadSanitizer covers
those overlap cases. A separate fixture checks idle completion before host exit,
reactor wait, and scheduler exit. The worker-capacity fixture discovers more
children than the initial grey reservation and checks zero, one, and two workers,
including partial startup failure. Weak-cleanup fixtures cover sparse object and
symbol key churn through major and minor collections, surviving values, empty
storage release, and bounded RAW ownership. Map tests cover cached hints after
compaction and iterator pins during growth. GC statistics separate mutator pause
time, worker CPU, copied values and heap values, worker discoveries, and remark join
time. A pause is one uninterrupted mutator stop; an incremental major can have
several pauses while still counting as one collection. Profile manifest schema 7
labels these events as pauses, while the raw capture layout remains schema 6.
These counters describe work distribution; they do not alone establish an
application speedup.
Large root scans, mutator-only traces, finalization, and synchronous completion
can still create long pauses. Wasm parity and broad performance acceptance are
tracked in [TODO.md](../../TODO.md).

A copying nursery, minors during a major's sweep, compaction, and shared-heap
mutators require separate contracts. The compiled worker-boundary fixture pauses a
snapshot worker that requests the next poll while a getter changes property storage.
That first poll sees the native callback's result in an active compiled root slot. It also
checks the region's first, middle, and final values and later reclamation.
The generator-overlap fixture holds the only worker before it reaches a rooted
suspended generator, completes that generator while the worker is paused, and
checks snapshot survival followed by reclamation in a fresh major.
Synchronous GC stress alone cannot establish this overlap.

## Ownership diagnostics

`MAL_GC_MEMORY_TRACE=1` records synchronized ownership samples before and after
collector pauses. A larger positive value samples every N pauses and each major
pause ending with an idle collector. Each row keeps managed occupancy, RAW ownership, partly occupied
block capacity, mapped chunks, ArrayBuffer ownership, snapshot reserve and process
reserve together. High-water summaries retain the complete row for each selected
sampled peak. They do not establish uncaptured peaks or add peaks from different moments. RAW warm reserve overlaps
other capacity fields; process reserve overlaps heap mappings and backing stores.
Neither is resident memory. Survivor bytes are the collector's last accounting
baseline, including floating garbage, rather than an exact reachability census.

`MAL_GC_NURSERY_MAX_BYTES` optionally bounds the allocation increment after a
collection, with a 4 MiB minimum. Without it, the increment follows the existing
live-set policy. It leaves explicit collection disabling and major-cycle debt
accounting intact. An incremental major's synchronous backstop sits one increment
past the next nursery deadline, so a cap also brings that backstop closer. A cap
trades retained block capacity for more frequent collections and collector CPU time;
on a large compiler heap the saved page reclamation can outweigh that and shorten
elapsed time. Its effect on pauses, promotion and worker processes depends on the
workload, and it applies per isolate, so it remains an explicit footprint choice.
Tracing perturbs execution, so ordinary time and peak RSS comparisons run
separately from ownership diagnostics.
