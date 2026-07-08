# Object & array access fast paths (the next perf iteration)

## Context

With the numeric-speculation work landed (both-boxed guards, inline box/key
helpers, numeric-index array access), per-section profiling of `bench/language.js`
against Node/V8 shows where the remaining gap is:

| section    | maligator vs V8 | shape of the work                          |
| ---------- | --------------- | ------------------------------------------ |
| `objects`  | ~4.9× slower    | property load/store churn on a hot object  |
| `arrays`   | ~3.5× slower    | dense element read/write                    |
| `loops`    | ~2× slower      | pure numeric (already unboxed)              |
| `alloc`    | **faster**      | arithmetic chains + short-lived objects     |
| `control`  | **faster**      | for-of + try/catch/throw                     |

The arithmetic-chain and allocation paths already beat V8 (the inliner +
scalar-replacement + numeric speculation carry them). The gap is concentrated in
**property and element access**. So the next lever is *not* more scalar-arith
unboxing — it is the object/array access path.

### Where the per-access cost is today

A compiled `p.k` read is `mal_vm_array_fast_load(vm, p, key, ic)` — inline, with a
monomorphic per-site cache (`MalInlineCache { shape, key, slot }`). On a hit it does:

1. `mal_value_is_int32(key) && is_array` dense pre-check (array fast path), then
2. `is_heap_type(p, OBJECT)` — tag test + header type-byte load,
3. `p->shape == ic->shape` — shape-pointer load + compare,
4. `key == ic->key` — compare (a folded constant now),
5. `ic->slot != VALUE_SLOT` — validity check,
6. `p->slots[ic->slot]` — **double indirection** (`slots` is a separate heap array,
   not inline in the object; V8 stores fast properties inline),
7. and the caller then runs a `throwCheck` (`vm->completion.kind == THROW`) branch —
   even though a data-slot hit can never throw.

A store adds the GC write-barrier + card. A dense `arr[i]` access pays the
heap-type test, an integral/range test, a `dense_count` bounds check, an
`elements` pointer load, a hole check, and the same `throwCheck`.

Every one of these is *per access*. V8's JIT, for a monomorphic site, checks the
map once and then issues direct fixed-offset loads with no key compare and no
completion check. That difference — many small guarded steps vs. one guard then
direct access — is the ~4.9×/3.5×.

### The backend's current stance

So far the native backend speculates only where it can prove things statically
(number reps) or with a *guard-free* monomorphic point IC. It has **no
region-level speculation**: each access re-checks the shape independently, and no
access is allowed to assume the previous one's guard. This iteration introduces
the first *deopt-style* speculation into the backend — a shape/dense guard that
covers a straight-line region — which is a genuine direction change, hence this
doc.

## Decision

Introduce **guarded access regions**: within a safepoint-free straight-line window,
check an object's shape (or an array's dense-ness) **once**, then lower every
access in the region that hits that guard to a **direct** slot/element access with
no per-access shape/key/completion check. A guard miss **deopts** the region to the
existing per-access IC codegen (correctness is never on the speculative path).

Three pieces, phased by ROI and risk:

### Phase 1 — Dense-array-guarded regions + throwCheck elision (targets `arrays`)

Array access is the simpler case (no shape slots — just the dense vector). For a
run of `arr[i]` accesses on the same array register with no intervening safepoint:

```c
// once per region:
MalArrayObject *__a;
if (mal_value_is_heap_type(arr, MAL_HEAP_ARRAY_OBJECT)
    && !(__a = (MalArrayObject*) mal_value_to_heap(arr))->dense_deopted) {
    // in-region: each arr[i] read is a bounds+hole check + direct elements[] load,
    // NO heap-type test, NO key boxing, NO throwCheck (a dense data element can't throw).
    // in-region stores keep the existing dense_store fast path (still bounds/grow aware).
} else {
    // deopt: the current mal_vm_array_fast_load_index / _store_index per access.
}
```

The `throwCheck` after a dense read/write is dropped inside the region: a dense
data element access never runs user code. This alone removes a per-access branch
and a heap-type test from the hot element loop.

### Phase 2 — Shape-guarded object regions (targets `objects`)

For a run of `p.k` accesses on the same object register in a safepoint-free window,
hoist one shape guard and resolve each key's slot once (via `mal_shape_find`,
cached per region alongside the shape):

```c
static MalObjectRegionCache __rc_51; // { const MalShape *shape; u32 slot[K]; }
MalObject *__o;
if (mal_value_is_heap_type(p, MAL_HEAP_OBJECT)
    && (__o = (MalObject*) mal_value_to_heap(p))->shape == __rc_51.shape) {
    // direct data-slot access, no per-access shape/key/slot-valid/throw checks:
    //   read  p.vy  ->  __o->slots[__rc_51.slot[0]]
    //   write p.vy  ->  barrier; __o->slots[slot0] = v; card
    ...the region body...
} else {
    ...the region body, lowered with the current per-access ICs (deopt)...
}
```

Soundness constraints (why the guard is enough):

- **Region = one safepoint-free window.** A call/allocation/back-edge between two
  accesses could reshape or move `p`, so a safepoint ends the region (the next
  access re-guards). The particle body (`p.vy = p.vy + 0.01*p.mass; p.x = ...`) is
  call-free, so the whole body is one region.
- **Only existing-key accesses.** A store to a key already in the cached shape is a
  slot overwrite (no reshape); a store that *adds* a key reshapes and must not be
  in-region (it stays a per-access store, which also ends/splits the region). A
  load of a key absent from the shape is a prototype walk — also excluded (deopt).
- **The shape guard subsumes the per-key checks.** A shape is immutable and its
  slot assignment fixed, so `shape == cached` implies every cached key's slot is
  valid — no per-access key compare or slot-valid test needed.
- **Data slots only.** An accessor/`__proto__` key is resolved by the IC to a
  non-plain-slot; such keys are excluded from the region (deopt), so in-region
  access is always a plain data slot that cannot run user code → **no throwCheck**.

The fast and slow branches share the region's *arithmetic* but differ in the
accesses, so the region body is duplicated (fast = direct, slow = ICs). To bound
the code growth (size is priority #2), only form a region when it amortizes: ≥ a
threshold of accesses to the same object (e.g. ≥3), else keep the current
per-access IC.

### Phase 3 — Follow-ons (separate, larger)

- **Polymorphic IC** (small N-way shape→slot) for sites that see >1 shape, and a
  region guard that admits a handful of shapes. Real code is often polymorphic;
  the monomorphic point IC thrashes there.
- **Inline object slots** — fold the `slots` array into the object allocation to
  kill the double indirection (variable-size `MalObject`; a bigger object-model
  change, orthogonal to regions but compounding with them).
- **Value type-feedback on loads** — speculate a loaded property/element is a
  number and keep it unboxed through the following arithmetic (connects to the
  deferred "chained numeric unboxing": a shape-guarded region makes the loaded
  values' provenance known, so the region can also carry them as doubles).

## Alternatives considered

- **Full JIT-style type feedback + bailout.** Record shapes at runtime, recompile
  hot regions. Far more machinery than an AOT engine wants; the guarded-region
  approach gets most of the monomorphic win with static region formation and a
  runtime shape cache, no recompilation.
- **Inline slots first (skip regions).** Removes one indirection per access but
  leaves the per-access shape/key/throw checks — the bulk of the gap. Regions
  remove more, and the two compose; do regions first.
- **Do nothing / rely on the C compiler.** clang cannot hoist the shape check or
  elide the completion check across the opaque runtime calls; this must be done in
  emit-c where the accesses and their object provenance are visible.

## Consequences

- The backend gains its first region-level speculation with a deopt path. The
  speculative branch is never trusted for correctness — a guard miss runs the
  identical region through the existing per-access ICs — so the risk is confined to
  region-formation logic, not to numeric/observable semantics.
- Code growth: each region is emitted twice (direct + deopt). Gated behind an
  access-count threshold so only hot multi-access regions pay it; single accesses
  keep today's codegen. Acceptable under speed-first; revisit if a size profile
  needs it.
- Region formation needs: safepoint-free-window detection (already implicit in
  the existing safepoint model), grouping accesses by object register, and
  excluding reshaping/accessor/absent-key accesses (which deopt/split). The
  runtime side reuses `mal_shape_find` and the dense-array primitives unchanged.
- Ordering: Phase 1 (arrays) is the smaller, lower-risk first step and validates
  the region/deopt machinery before Phase 2 (objects) builds on it. Phase 3 items
  are independent follow-ons.
- Validation: the test262 regression gate plus differential checksums on the
  object/array benchmark sections; a guard-miss stress (force deopt) to exercise
  the slow branch.
