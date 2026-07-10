#pragma once

#include "./defaults.h"
#include "value.h"

/*
 * GC mutator contract; this header defines the flags, hooks, and structures that BOTH
 * backends emit against from day one so enabling the collector later is a
 * runtime/codegen-flag flip, not a re-generation.
 *
 * Until the collector exists everything here is inert: the flags are false, the
 * hooks are no-ops, and (with MAL_GC_CONCURRENT off) the write barrier folds out
 * entirely, so emitting the contract has no observable effect or steady-state
 * cost. Single-threaded for now; the globals become _Thread_local in Phase 5
 * (the codegen references the same symbols, so that switch needs no re-emit).
 */

typedef struct MalVm MalVm;

/* Build-time gates MAL_GC_GENERATIONAL (default ON since 2026-07-10) and
 * MAL_GC_CONCURRENT (default off) are defined in defaults.h — the shared header
 * heap.h also reads, so its `dirty`-byte layout and this file's barrier code can
 * never disagree on the default. Off => the SATB / generational-card halves of the
 * write barrier fold out, so that build pays nothing. */

typedef struct MalGcState MalGcState;

#if MAL_GC_CONCURRENT
/* Set during a concurrent mark cycle (init-mark → remark); gates the SATB barrier. */
extern bool mal_gc_marking_active;
/* Set for the WHOLE concurrent cycle (init-mark → sweep-complete): while true a
 * freshly allocated managed cell is born BLACK (mal_heap_header_init) so it is
 * never swept this cycle. Read by the allocator; folds to a compile-time 0 off. */
extern bool mal_gc_black_alloc;
/* Bytes born BLACK (over-tenured under generational) since process start. */
extern usize mal_gc_black_alloc_bytes;
#else
/* Compile-time false so the SATB barrier / black-allocation path dead-code-eliminate. */
#define mal_gc_marking_active 0
#define mal_gc_black_alloc 0
#endif

/* Raised by the collector to request that mutators reach a safepoint; polled at
 * loop back-edges and call returns. `volatile`, not atomic: a missed read just
 * polls next time. */
extern volatile bool mal_gc_poll;

/* Auto-collection trigger: when the heap's monotonic bytes_allocated reaches this
 * value the allocator raises mal_gc_poll, and the next safepoint collects and
 * advances it past the surviving set. SIZE_MAX disables auto-collection (the
 * default until mal_gc_init enables it, and the state under MAL_GC_STRESS /
 * MAL_GC_OFF). Read by the allocator on every allocation. */
extern usize mal_gc_next_at;

/* SATB (snapshot-at-the-beginning) deletion-barrier record: hands the collector
 * a reference about to be overwritten so it stays in the snapshot. No-op until
 * the concurrent collector (Phase 3/5) drains a real SATB buffer. */
void mal_gc_satb_record(MalValue old_value);

typedef struct MalVmFrame MalVmFrame;

/* SATB teardown shade for a coroutine activation whose frame is about to leave the
 * traced graph. At completion the tracer stops following the frame (a COMPLETED
 * generator's frame is skipped) AND the register buffer is freed as the frame is
 * popped, so a value held only by the dying frame would vanish from an in-flight
 * snapshot. Shades exactly what a frame trace keeps. Call BEFORE freeing the
 * buffers, guarded by `mal_gc_marking_active` so the call folds out off-cycle. */
void mal_gc_satb_shade_frame(MalVmFrame *frame);

/* A GC-consistent point where this mutator's roots are enumerable. No-op until
 * the collector (Phase 3) runs a step here / parks for the handshake (Phase 5). */
void mal_gc_safepoint(MalVm *vm);

/* Preemption hook (isolate_todo.md Phase 0). Null in a plain run; the scheduler
 * installs one so a safepoint can yield the running fiber (a context switch is
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
 * idempotent (null-after-free) — it also runs at teardown. */
typedef void (*MalGcFinalizer)(MalHeapHeader *cell);
void mal_gc_register_finalizer(MalHeapType type, MalGcFinalizer fn);

/* Per-type tracer hook: for host/runtime types that hold MalValue edges the engine
 * can't see (e.g. the fetch Headers name/value list). Invoked while tracing a live
 * cell of that type, after the common object edges; marks the type's extra
 * references via mal_gc_mark_value (box strings with mal_value_from_string). */
typedef void (*MalGcTracer)(MalHeapHeader *cell);
void mal_gc_register_tracer(MalHeapType type, MalGcTracer fn);

/* Run a full stop-the-world mark/sweep collection now: shade roots, drain the
 * grey worklist tracing reachable cells, then finalize and reclaim the rest.
 * Invoked explicitly (the gc() host hook); never from the allocator. */
void mal_gc_collect(MalVm *vm);

/* Allocate the per-isolate collector state (vm->gc) and read GC environment
 * configuration (MAL_GC_STRESS, MAL_GC_MODE, …). Call once at VM startup. */
void mal_gc_init(MalVm *vm);

/* Free the per-isolate collector state (vm->gc) and its growable buffers. Call
 * once at VM teardown. */
void mal_gc_state_free(MalVm *vm);

/* Free every cell's owned side allocations regardless of liveness, for a clean
 * VM teardown (no shutdown leak of overflow tables, Map entries, ArrayBuffer
 * data, Rust handles, ...). Call once immediately before mal_heap_free; the
 * collector must not run afterwards. Used by mal_vm_free and the leak-audit
 * exit path (MAL_GC_AT_EXIT). */
void mal_gc_finalize_all(MalVm *vm);

/*
 * SATB deletion write barrier: call BEFORE overwriting a heap cell's MalValue
 * field, passing the field's current contents. (The generational card half,
 * which also needs the owning cell + new value, is added in Phase 5/7; it folds
 * out until then.) Stores into root containers — value stack, frame registers,
 * globals — do NOT use this; they are caught by root re-scanning at remark.
 */
static inline void mal_gc_write_barrier(MalValue old_value) {
    if (mal_gc_marking_active) {
        mal_gc_satb_record(old_value);
    }
}

/*
 * Generational card / remembered-set barrier (the "card half" of 5.4), present
 * only under MAL_GC_GENERATIONAL. The collector is a non-moving sticky-mark-bit
 * generational design: a cell that survives a collection keeps its BLACK mark
 * ("old"); fresh allocations are WHITE ("young"). A minor collection scans roots
 * plus the remembered set (it does NOT reset or re-scan the old generation), so
 * any old->young pointer MUST be recorded here or the young target is swept while
 * still reachable. `mal_gc_remember` links an old cell on the remembered set
 * (idempotent via the `dirty` flag); the inline helpers below are the call sites'
 * fast path. When MAL_GC_GENERATIONAL is off the whole thing compiles to nothing,
 * so a non-generational build pays zero per-store cost (the day-one barrier-site
 * contract is preserved; the binary is unchanged).
 */
#if MAL_GC_GENERATIONAL
void mal_gc_remember(MalHeapHeader *owner);

/* Remember `owner` if it is old (sticky-BLACK) and not already on the set. Used
 * for aggregate payloads (a generator frame, a promise's reaction list) where the
 * young target is not a single inspectable value — the minor collector traces the
 * whole cell, so unconditional remembering of an old owner is correct. */
static inline void mal_gc_remember_if_old(MalHeapHeader *owner) {
    if (owner != nullptr && owner->mark == MAL_MARK_BLACK && !owner->dirty) {
        mal_gc_remember(owner);
    }
}

/* The precise card barrier: remember `owner` only when it is old and the value
 * being stored into it is a young heap cell (an old->young edge). Cheapest common
 * case — a non-heap or already-old value never dirties the owner. Call AT or just
 * after the store of `new_value` into a pointer field of `owner`. */
static inline void mal_gc_card(MalHeapHeader *owner, MalValue new_value) {
    if (owner == nullptr || owner->mark != MAL_MARK_BLACK || owner->dirty) {
        return;
    }
    if (mal_value_is_heap(new_value) &&
        mal_value_to_heap(new_value)->mark == MAL_MARK_WHITE) {
        mal_gc_remember(owner);
    }
}
#else
#define mal_gc_remember_if_old(owner) ((void) 0)
#define mal_gc_card(owner, new_value) ((void) 0)
#endif

/*
 * Compiled root frame: a shadow-stack node holding the
 * GC-live MalValues of a compiled function that are live across a safepoint.
 * emit-c declares one per such function, links it on entry, unlinks on every
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
