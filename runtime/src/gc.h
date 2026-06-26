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

/* Build-time gates. Off => the SATB / generational-card halves
 * of the write barrier fold out, so a non-concurrent build pays nothing. */
#ifndef MAL_GC_CONCURRENT
#define MAL_GC_CONCURRENT 0
#endif
#ifndef MAL_GC_GENERATIONAL
#define MAL_GC_GENERATIONAL 0
#endif

#if MAL_GC_CONCURRENT
/* Set during a concurrent mark cycle; gates the SATB barrier. */
extern bool mal_gc_marking_active;
#else
/* Compile-time false so the SATB barrier dead-code-eliminates. */
#define mal_gc_marking_active 0
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

/* A GC-consistent point where this mutator's roots are enumerable. No-op until
 * the collector (Phase 3) runs a step here / parks for the handshake (Phase 5). */
void mal_gc_safepoint(MalVm *vm);

/* Run a full stop-the-world mark/sweep collection now: shade roots, drain the
 * grey worklist tracing reachable cells, then finalize and reclaim the rest.
 * Invoked explicitly (the gc() host hook); never from the allocator. */
void mal_gc_collect(MalVm *vm);

/* Read GC environment configuration (MAL_GC_STRESS). Call once at VM startup. */
void mal_gc_init(void);

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
