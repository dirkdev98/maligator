# GC and allocation roadmap

The collector is a non-moving, precise mark-sweep collector with generational
collection enabled by default. `MAL_GC_CONCURRENT` provides incremental SATB
marking on the mutator thread. This file contains only unfinished work.

## Active safety

- [ ] Complete recoverable allocation failure for CELL, RAW, LOS, GC-internal, and
      direct native allocations. Extend the existing nullable CELL foundation,
      emergency exception, and fault injection so OOM remains catchable without GC
      corruption or recursive allocation.

## Queued allocation elimination

Stack-object emission, partial escape, and region-allocation experiments are owned
by the compiler/runtime performance checklist in [`TODO.md`](../../TODO.md).

- [ ] Deterministically release non-escaping RegExp and ICU handles at compiled
      scope end after the escape work can prove ownership.

## Triggered work

- C2 marker thread and C3 parallel workers are workload-triggered research, not
  active tasks. The current state layout, mark transition helper, SATB queue, and
  pause boundaries preserve that option.
- Move compiled-call arguments through a rootable runtime seam only if an operand-
  rooting audit supports switching root frames from `liveOrUsedAtSafepoint` to pure
  `liveAcrossSafepoint`.
- SATB write-barrier elision remains closed unless concurrent GC becomes the default
  and a store-heavy realistic workload makes the barrier material.
