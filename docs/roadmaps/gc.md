# GC and allocation roadmap

The collector is a non-moving, precise mark-sweep collector with generational
collection enabled by default. `MAL_GC_CONCURRENT` provides incremental SATB
marking on the mutator thread. This file contains only unfinished work.

## Allocation elimination

Stack-object emission, partial escape, and region-allocation experiments are owned
by the compiler/runtime performance checklist in [`TODO.md`](../../TODO.md).

- [ ] Deterministically release non-escaping RegExp and ICU handles at compiled
      scope end after the escape work can prove ownership.
- [ ] Presize dense vectors created by `mal_intrinsic_new_array(len)` where the final
      length is known.
- [ ] Move compiled-call arguments through a rootable runtime seam only if required
      to switch root frames from `liveOrUsedAtSafepoint` to pure
      `liveAcrossSafepoint`.

## Correctness

- [ ] Re-resolve suspended fiber frame functions by `function_index` after eval
      definition splices; cached function pointers can become stale.

## Deferred by evidence

- C2 marker thread and C3 parallel workers are workload-triggered research, not
  active tasks. The current state layout, mark transition helper, SATB queue, and
  pause boundaries preserve that option.
- Write-barrier elision remains closed unless concurrent GC becomes the default and
  a store-heavy realistic workload makes the barrier material.
