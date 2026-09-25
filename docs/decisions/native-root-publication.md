# Native root publication

The native backend can keep eligible property receivers and results in private
`MalValue` locals between collecting edges. The ordinary static property cache
probe is unchanged. A successful probe assigns the private result directly;
only its collecting/reentrant miss publishes incoming roots. Numeric operator
guards and TDZ checks likewise publish inside their generic or throwing edge.
Dense Array-values iteration uses its existing noncalling probe and publishes
only before the generic step. Length and storage are read afresh on each probe;
holes and nonstandard iterators retain the complete JavaScript protocol.
Ordinary static stores likewise publish before their generic miss. A successful
store may grow slots and invalidate assumptions without collecting or reentering
JavaScript; its existing barriers remain in place.

## Effects and root maps

Native edge effects distinguish allocation, collection, JavaScript reentry,
throwing, and invalidation. An allocation can request a later poll without
collecting at the allocation itself. Only audited creation helpers receive that
classification; unknown operations conservatively retain every effect.

Execution lowering owns three exact register maps at each safepoint:

- `incomingRootRegisters`: values needed while the operation runs, including its
  operands and exceptional continuations, excluding output-only old values.
- `outgoingRootRegisters`: values needed after the operation, including returned
  outputs before a call-return poll.
- `rootRegisters`: their union, used by continuously rooted storage and the
  portable VM root map.

The native backend consumes these maps without reconstructing liveness. The
compiler artifact stores the union once and each phase's sorted exclusions,
then reconstructs independent exact phase arrays. The VM wire format retains
its union map. Verification checks both phases independently and their union;
the artifact reader also rejects invalid exclusions.

## Storage obligations

Private locals and their published shadow slots are different storage. A dead
private local can still contain a reclaimed pointer. Before a helper, publication
copies only incoming values and empties any active output-only private slots.
Unmasked slots beyond the first 64 are also emptied when dead. The existing
union mask keeps continuously rooted helper outputs visible during execution.

A returned private value is published inside a later collecting poll. Ordinary
noncollecting code does not need to copy it to the shadow frame. Collection does
not move objects, so a live private `MalValue` does not need reloading afterward.

Private parameters are published at function entry. If no instruction writes
their physical register, later live publications omit the redundant copy.
Exact liveness still controls their masks and dead-slot clearing: after a
collection clears a dead entry value, that unchanged value cannot become live
again along the same continuation. Reassigned parameters and all helper outputs
keep the ordinary publication path. This does not retain borrowed pointers.

Some instructions expose intermediate or out-parameter storage. Their selected
outputs temporarily alias shadow slots for the entire operation, with explicit
reloads into private locals on both normal and throwing exits. The iterator-step
emitter already uses runtime-owned temporary results and assigns its final VM
outputs after success, so those final assignments can remain private.

Register reuse does not erase these obligations. Selection audits every
definition of a physical register. Virtual field-call materializations,
unmodeled target-region intermediates, and boxed writes elided by numeric
projections retain continuously rooted storage. Resumable functions retain
their heap register frames. Private selection is bounded to 32 registers per
ordinary function to limit native register pressure and slow-edge code size.

## Extending native regions

Keeping a live `MalValue` private does not permit retaining a borrowed slots
pointer or prototype-derived assumption across arbitrary effects. Getters and
proxies can mutate them. A collecting poll can also yield to another fiber.
Storage/prototype admissions must therefore end at an invalidating operation,
or leave through a generic continuation and obtain a new admission afterward.

Tests exercise cache-hit emission, distinct phase maps, artifact round trips,
collecting and throwing getters, Proxy traps, callback mutation, returned heap
values, and more than 64 live roots. A root optimization must also demonstrate
that the relevant hot generated code uses private results before its timing is
interpreted as evidence for the mechanism.

Binary numeric guards leave the root mask untouched on their noncollecting
path. The original union mask is published with incoming private roots inside
the coercing operator expression, before it can call user code. A conditional
publication invalidates the emitter's known-mask state for the next operation;
pure specialized operators need no mask update at all.
