#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

#if !defined(__wasi__)
struct MalEnv;
/* Native tests can pause workers at a controlled edge-read boundary. */
extern void (*mal_gc_test_trace_env_hook)(struct MalEnv *env);
extern void (*mal_gc_test_trace_snapshot_hook)(MalHeapHeader *cell);
/* Allows a paused test tracer to finish after teardown has stopped the pool. */
extern void (*mal_gc_test_before_worker_join_hook)(void);
/* Tests can select a scheduler capacity before VM initialization. */
extern usize (*mal_gc_test_worker_limit_hook)(void);
/* Tests can make a worker start fail before the first batch is published. */
extern bool (*mal_gc_test_worker_start_failure_hook)(usize index);
#endif

typedef struct MalGcState MalGcState;

#if !defined(__wasi__)
/* Worker capacity reflects CPU availability at VM initialization. */
usize mal_gc_worker_limit(MalVm *vm);
#endif

/* Set during an incremental major mark cycle (init-mark → remark). */
extern bool mal_gc_marking_active;
/* Fresh cells remain live while an incremental sweep is in flight. */
extern bool mal_gc_black_alloc;
/* Bytes promoted immediately by allocation during a major cycle. */
extern usize mal_gc_black_alloc_bytes;

/* Workers can request a mutator safepoint after publishing a completed batch. */
#if defined(__wasi__)
extern bool mal_gc_poll;
#else
extern _Atomic bool mal_gc_poll;
#endif

/* Retain an overwritten heap edge until an incremental major reaches remark. */
void mal_gc_satb_record(MalValue old_value);

typedef struct MalVmFrame MalVmFrame;

/* SATB teardown shade for a coroutine activation whose frame is about to leave the
 * traced graph. At completion the tracer stops following the frame (a COMPLETED
 * generator's frame is skipped) AND the register buffer is freed as the frame is
 * popped, so a value held only by the dying frame would vanish from an in-flight
 * snapshot. Shades exactly what a frame trace keeps. Call BEFORE freeing the
 * buffers, guarded by `mal_gc_marking_active` so the call folds out off-cycle. */
void mal_gc_satb_shade_frame(MalVmFrame *frame);

/* A GC-consistent point where this mutator's roots are enumerable. */
void mal_gc_safepoint(MalVm *vm);

/* Preemption hook (docs/decisions/03-wave-0-host-architecture.md). Null in a plain
 * run; the scheduler installs one so a safepoint can yield the running fiber (a context switch is
 * safe exactly where a collection is — same gate). Called at the end of
 * mal_gc_safepoint. */
extern void (*mal_gc_preempt_hook)(MalVm *vm);

/* Mark a value (and, transitively, everything it reaches) as a live root. The
 * public marking API for external root sources — the host/runtime layers call it
 * from their registered scanner. Safe only during a collection's root scan. */
void mal_gc_mark_value(MalValue value);
void mal_gc_mark_values(const MalValue *values, i32 count);

/* Root-source hook: how the host/runtime layers contribute GC roots the engine
 * cannot see the types of (e.g. pending setTimeout callbacks). The registered fn
 * is invoked during root scanning and marks its live values via mal_gc_mark_value.
 * This keeps the engine's collector free of any host/runtime type knowledge. */
typedef void (*MalGcRootSourceFn)(MalVm *vm, void *data);
void mal_gc_register_root_source(MalGcRootSourceFn fn, void *data);

/* Per-type finalizer hook: the host/runtime layers register a finalizer for a heap
 * type they define (e.g. the fetch Response/Request body buffers), so the engine's
 * sweep frees their owned memory without a compile-time dependency on those types.
 * Invoked once per dead cell of that type, before the common object cleanup; must be
 * idempotent (null-after-free) — it also runs at teardown. A finalizer may release
 * owned resources but must not allocate from MalHeap, publish heap edges, invoke JS,
 * or reenter collection: sweep has selected dead cells, and teardown discards
 * the heap. */
typedef void (*MalGcFinalizer)(MalHeapHeader *cell);
void mal_gc_register_finalizer(MalHeapType type, MalGcFinalizer fn);

/* Per-type tracer hook: for host/runtime types that hold MalValue edges the engine
 * can't see (e.g. the fetch Headers name/value list). Invoked while tracing a live
 * cell of that type, after the common object edges; marks the type's extra
 * references via mal_gc_mark_value (box strings with mal_value_from_string). */
typedef void (*MalGcTracer)(MalHeapHeader *cell);
void mal_gc_register_tracer(MalHeapType type, MalGcTracer fn);

/* The heap of the vm this mutator's collector serves (set once at mal_gc_init, live
 * for the vm's lifetime). Lets mutator code that only has an object in hand — not a
 * heap — reach the allocator for gc_free_raw / gc_realloc_raw of owner buffers (the
 * array dense-element vector's grow/free/deopt paths). */
MalHeap *mal_gc_current_heap(void);

/* Temporarily changes an already-enabled stress cadence and returns the previous
 * interval. A zero current interval is left disabled, so a scoped diagnostic can
 * relax stress but cannot accidentally enable it in a normal execution. */
i32 mal_gc_swap_stress_interval(i32 interval);

/* Run a full stop-the-world mark/sweep collection now: shade roots, drain the
 * grey worklist tracing reachable cells, then finalize and reclaim the rest.
 * Invoked explicitly (the gc() host hook); never from the allocator. */
void mal_gc_collect(MalVm *vm);

/* Complete an in-flight cycle before the mutator idles; never starts a new one. */
bool mal_gc_finish_pending_cycle(MalVm *vm);

u64 mal_gc_allocated_bytes(MalVm *vm);
u64 mal_gc_collection_count(MalVm *vm);

/* Allocate the per-isolate collector state and read diagnostic/pacing settings. */
void mal_gc_init(MalVm *vm);
/* Install the collector policy after mal_heap_init has reset the heap fields. */
void mal_gc_configure_heap(MalVm *vm);
/* Stop collection before VM teardown releases roots and program tables. */
void mal_gc_begin_teardown(MalVm *vm);

/* Free the collector state after workers join and live cells are finalized, but
 * before mal_heap_free resets heap-backed statistics. */
void mal_gc_state_free(MalVm *vm);

/* Free every cell's owned side allocations regardless of liveness, for a clean
 * VM teardown (no shutdown leak of overflow tables, Map entries, ArrayBuffer
 * data, Rust handles, ...). Call once immediately before mal_heap_free; the
 * collector must not run afterwards. Used by mal_vm_free and the leak-audit
 * exit path (MAL_GC_AT_EXIT). Call mal_gc_begin_teardown first so no worker can
 * still read the VM while live cells are finalized. */
void mal_gc_finalize_all(MalVm *vm);

/*
 * SATB deletion write barrier: call BEFORE overwriting a heap cell's MalValue
 * field, passing the field's current contents. Stores into root containers — value stack, frame registers,
 * globals — do NOT use this; they are caught by root re-scanning at remark.
 */
static inline void mal_gc_write_barrier(MalValue old_value) {
    if (mal_gc_marking_active) {
        mal_gc_satb_record(old_value);
    }
}

/*
 * Generational card / remembered-set barrier. A cell that survives a collection
 * gains the OLD bit; fresh allocations are young. A minor scans roots plus the
 * remembered set without re-tracing the whole old generation, so
 * any old->young pointer MUST be recorded here or the young target is swept while
 * still reachable. `mal_gc_remember` links an old cell on the remembered set
 * (idempotent via the `dirty` flag); the inline helpers below are the call sites'
 * fast path.
 */
void mal_gc_remember(MalHeapHeader *owner);

/* Remember `owner` if it is old and not already on the set. Used
 * for aggregate payloads (a generator frame, a promise's reaction list) where the
 * young target is not a single inspectable value — the minor collector traces the
 * whole cell, so unconditional remembering of an old owner is correct. */
static inline void mal_gc_remember_if_old(MalHeapHeader *owner) {
    if (owner != nullptr && mal_heap_mark_is_old(owner->mark) && !owner->dirty) {
        mal_gc_remember(owner);
    }
}

/* The precise card barrier: remember `owner` only when it is old and the value
 * being stored into it is a young heap cell (an old->young edge). Cheapest common
 * case — a non-heap or already-old value never dirties the owner. Call AT or just
 * after the store of `new_value` into a pointer field of `owner`. */
static inline void mal_gc_card(MalHeapHeader *owner, MalValue new_value) {
    if (owner == nullptr || !mal_heap_mark_is_old(owner->mark) || owner->dirty) {
        return;
    }
    if (mal_value_is_heap(new_value) &&
        !mal_heap_mark_is_old(mal_value_to_heap(new_value)->mark)) {
        mal_gc_remember(owner);
    }
}

/*
 * Compiled root frame: a shadow-stack node holding the
 * GC-live MalValues of a compiled function that are live across a safepoint.
 * render-native-c declares one per such function, links it on entry, unlinks on every
 * exit; the collector walks the chain. The interpreter's MalVmFrame is the
 * sibling representation. `desc` is baked, static program-image data.
 */
typedef struct MalFrameDescriptor {
    i32 function_index;
    i32 slot_count;
} MalFrameDescriptor;

typedef struct MalEnv MalEnv;

typedef struct MalRootFrame {
    struct MalRootFrame *prev;
    const MalFrameDescriptor *desc;
    /* slot_count MalValues, owned by the compiled frame (a stack local there). */
    MalValue *slots;
    /* The first 64 slots whose values are dead at the current compiler-certified
     * safepoint. Zero deliberately means scan everything, preserving safety for
     * frames that do not publish exact liveness. */
    u64 inactive_slots;
    /* This activation's own captured-slot env (the compiled analogue of the
     * interpreter frame's env), or null when the function captures nothing. Its
     * slots hold values not yet reachable through any live closure, so the
     * collector must trace it while the function runs. */
    MalEnv *env;
} MalRootFrame;

extern MalRootFrame *mal_root_frame_head;

/*
 * Root span: makes a transient C buffer of live MalValues
 * (held across a GC-able call) a scanned root. Reachability != pointer stability,
 * so even a non-moving collector needs these or the values get swept.
 */
typedef struct MalRootSpan {
    struct MalRootSpan *prev;
    MalValue *slots;
    i32 count;
} MalRootSpan;

extern MalRootSpan *mal_root_span_head;

static inline void mal_gc_root(MalRootSpan *span, MalValue *slots, i32 count) {
    span->slots = slots;
    span->count = count;
    span->prev = mal_root_span_head;
    mal_root_span_head = span;
}

static inline void mal_gc_unroot(MalRootSpan *span) {
    mal_root_span_head = span->prev;
}
