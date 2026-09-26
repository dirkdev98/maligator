# Generational GC workers

Maligator uses one non-moving generational collector. A native isolate has one
JavaScript mutator and may use GC workers; it does not share language objects with
another isolate. The `wasm32-wasip1` reactor executes the same collector work inline
because its embedding has no Wasm threads. Worker availability is a target
capability, not a selectable collector mode.

## Ownership and publication

Each isolate owns its heap, collector cycle, roots, remembered set, weak processing,
and GC statistics. Process-wide type hooks may be shared only after their
registration lifetime is fixed. A worker receives an explicit isolate context and
never discovers one through a mutator global. Work and reclaimed blocks change
owners through a synchronized handoff; an empty queue alone does not end a cycle.

The mutator may run while a major marker runs only after a coordinated initial
pause. It must publish the compiler-certified roots, acknowledge the collection
epoch, and remain parked until the root snapshot is complete. The collector scans
compiled frames, interpreter frames, suspended fibers, C root spans, host roots,
and callback state only while their owner is parked. The same handshake precedes
remark. A worker cannot read changing C stack slots or clear inactive root slots
while JavaScript runs. A native frame that cannot publish roots must keep the
collection request pending until it can reach a certified safepoint.

Heap writes preserve two independent facts: old-to-young reachability for minor
collections and the major snapshot when a reachable edge is deleted. These
barriers do not make ordinary C reads and writes race-free. A type is eligible
for background tracing only when its fields, layout changes, and backing-storage
lifetime have a matching synchronization or deferred-reclamation protocol.
Other types are traced while the mutator is parked. Workers must never see a
partially initialized object.

WeakMap ephemeron closure, WeakRef clearing, FinalizationRegistry jobs, and
native/host finalization remain coordinated with the owning mutator. Cells and
their side storage are not reusable until required cleanup has completed. An
explicit `gc()` finishes an in-flight cycle and performs a fresh complete
collection, so floating snapshot garbage does not change its observable contract.
Shutdown stops work admission, drains or cancels accounted work, joins workers,
and only then releases isolate state.

## Delivery sequence

1. Consolidate the existing generational collector and assign mutable state to
   its isolate. Preserve current safepoint and root semantics while collection
   still runs on the mutator.
2. Trace in parallel on native workers while JavaScript is parked. Wasm executes
   the same work items inline. Keep reclaiming and finalizers on the mutator.
3. Run major marking concurrently after each traceable type has a safe access
   protocol. Keep minor collections and remark coordinated; initially, minors
   wait for an active major to finish.
4. Transfer reclaimable blocks to workers only where ownership and finalization
   rules permit it. Validate lifecycle, memory, pause latency, throughput, and
   Wasm parity before accepting the default.

The first implementation remains non-moving. A copying nursery, simultaneous
minor and major cycles, compaction, and shared-heap mutators require separate
contracts. The draft root-publication and property-storage work in PRs #65 and
#66 must be revalidated against the pause and tracing protocols before integration.
