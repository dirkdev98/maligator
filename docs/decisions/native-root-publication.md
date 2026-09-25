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

## Bounded property read regions

A property read region contains 2–8 static loads from the same receiver within
at most 24 instructions. Gaps admit only numeric/Boolean constants, copies with
compatible representations, and audited arithmetic, comparisons, or unary
operations with proven numeric inputs. Control-flow entries, receiver writes,
and competing native plans end selection. The final load may replace the
receiver after reading it. Existing numeric projections take precedence;
exactly two adjacent loads retain the existing paired-load path.

On each visit, the first load admits an ordinary object and captures its shape,
slots pointer, first prototype, and absence of public overflow. Each site then
checks its current cache row against that admission. A primary own-slot row
needs a matching shape and real slot. An inherited-value row needs a matching
shape, an ordinary receiver, the exact first prototype, no public overflow, and
dependencies registered from the first prototype through the property holder.
In this mode, `ic.poly_count > 0` marks successful dependency registration.
Mutations eagerly invalidate the cached value through those dependencies.

Eligible receivers and loaded values remain in private locals. Later mutation
does not replace values already read. The admission's raw pointers are not GC
roots and do not extend any object's lifetime. Before an actual collecting or
reentrant miss, incoming publication roots the receiver and all earlier values
needed by normal or exceptional continuations. Returned heap values are
published before a later collecting poll; intermediate and out-parameter
storage retains its existing continuous-root obligations.

The first declined region probe deactivates the admission before executing the
original ordinary property probe and its miss path. The remainder of the region
uses that generic continuation, even if an ordinary probe succeeds. It never
replays completed reads or readmits storage midway through the sequence. Every
load retains its original position and throw handler. An inactive probe returns
before dereferencing captured storage, so a getter may replace slots, mutate a
prototype, or invalidate a later cache without reviving stale pointers.

## Extending native regions

Keeping a live `MalValue` private does not permit retaining a borrowed slots
pointer or prototype-derived assumption across arbitrary effects. Getters and
proxies can mutate them. A collecting poll can also yield to another fiber.
A collecting poll is a hard admission boundary even when collection does not
move objects. The bounded property region excludes calls, stores, polls,
branches, allocation, and unknown coercions. An allocation-only effect does not
by itself license retaining borrowed storage. Future extensions must end the
admission at an invalidating operation or use a generic continuation; fresh
admission belongs to a subsequent region, after the invalidation.

Tests exercise cache-hit emission, distinct phase maps, artifact round trips,
collecting and throwing getters, Proxy traps, callback mutation, returned heap
values, and more than 64 live roots. A root optimization must also demonstrate
that the relevant hot generated code uses private results before its timing is
interpreted as evidence for the mechanism.
