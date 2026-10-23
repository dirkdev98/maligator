#pragma once

#include <stdatomic.h>

#include "./defaults.h"
#include "value.h"

struct MalVm;
struct MalObject;
struct MalRootSpan;
struct MalObjectSetSite;

/**
 * Isolate-local state that generated code and hot runtime paths read on nearly every
 * call. On macOS every thread-local is reached through its own lookup call, so these
 * share one record and a function that touches several pays one lookup.
 */
typedef struct MalIsolateLocals {
    /* Innermost explicit root span; see mal_gc_root. */
    struct MalRootSpan *root_span_head;
    /* Current prototype-chain validity epoch. Zero permanently disables exact-chain
     * caching after the theoretical u64 version space is exhausted. */
    u64 prototype_chain_epoch;
    /* %Array.prototype%, set at intrinsics init, so the inline array index store fast
     * path can confirm an array is on the default prototype without a vm handle. */
    struct MalObject *array_prototype_object;
    MalValue (*array_values_callback)(
        struct MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
        MalValue new_target, MalValue callee);
    MalValue (*array_iterator_next_callback)(
        struct MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
        MalValue new_target, MalValue callee);
    /* The mutator's safepoint request. Helpers and process signal handlers set the owning
     * mutator's flag through mal_gc_request_safepoint, never through their own copy. */
    /* Sticky cooperative termination of the owning isolate (worker terminate/process.exit).
     * Never cleared while the isolate runs. A safepoint re-arms gc_poll while it is set,
     * so every later poll observes it; loop/call poll sites then raise an uncatchable
     * throw through mal_gc_poll_termination. */
#if defined(__wasi__)
    bool gc_poll;
    bool gc_termination;
#else
    _Atomic bool gc_poll;
    _Atomic bool gc_termination;
    /* The compiled-entry stack limit of a VM whose calls skip return polls. A request
     * raises it to UINTPTR_MAX so the next compiled entry services the safepoint. */
    _Atomic(uptr) entry_stack_limit;
#endif
    /* Set during an incremental major mark cycle (init-mark → remark). */
    bool gc_marking_active;
    /* True while a default-prototype array's inherited chain has no integer-index
     * property, so a fresh-index store cannot hit an inherited setter. */
    bool array_elements_protector;
    /* Holds while no watched built-in prototype/lookup object has been mutated; gates
     * primitive, intrinsic-own, and inherited-method value caches. */
    bool primitive_method_protector;
    /* This thread's mal_object_set site table, bound on first use. */
    struct MalObjectSetSite *object_set_sites;
    /* Object slot storage statistics that every shaped allocation bumps, reported by
     * MAL_GC_STATS. */
    u64 object_slot_coallocations;
    u64 object_slot_grow_migrations;
    u64 object_slot_dictionary_migrations;
    /* Suspendable-frame buffer, microtask, and promise statistics that every generator,
     * job, and capability bumps, reported by MAL_COROUTINE_STATS and MAL_GC_STATS. */
    u64 coroutine_buffer_requests;
    u64 coroutine_buffer_allocations;
    u64 coroutine_buffer_reuses;
    u64 coroutine_buffer_releases;
    u64 coroutine_buffer_pooled;
    u64 coroutine_buffer_dropped;
    u64 coroutine_buffer_peak_retained_bytes;
    u64 job_allocations;
    u64 reaction_allocations;
    u64 job_reuses;
    u64 reaction_reuses;
    u64 promise_direct_capabilities;
    u64 promise_direct_fallback_pairs;
    u64 promise_direct_intrinsic_creations;
    u64 promise_direct_async_results;
} MalIsolateLocals;

extern MAL_ISOLATE_LOCAL MalIsolateLocals mal_isolate;

#if defined(__APPLE__) && !defined(__wasi__)
/* Even one record costs a lookup call per function on macOS. Until a second isolate
 * thread starts, the only isolate's record is also published here. */
extern _Atomic(MalIsolateLocals *) mal_sole_isolate;

/* Out of line, so a select cannot compute the thread-local address on every access. */
MalIsolateLocals *mal_isolate_locals_of_thread(void);

static inline __attribute__((always_inline)) MalIsolateLocals *mal_isolate_locals(void) {
    MalIsolateLocals *sole = atomic_load_explicit(&mal_sole_isolate, memory_order_relaxed);
    return __builtin_expect(sole != nullptr, 1) ? sole : mal_isolate_locals_of_thread();
}
#else
#define mal_isolate_locals() (&mal_isolate)
#endif

/** Publish the calling thread's record unless another isolate thread was ever started. */
void mal_isolate_claim_sole(void);
/** Call before starting another isolate thread; afterwards each isolate reads its own record. */
void mal_isolate_release_sole(void);

#define mal_root_span_head (mal_isolate_locals()->root_span_head)
#define mal_prototype_chain_epoch (mal_isolate_locals()->prototype_chain_epoch)
#define mal_array_prototype_object (mal_isolate_locals()->array_prototype_object)
#define mal_array_values_callback (mal_isolate_locals()->array_values_callback)
#define mal_array_iterator_next_callback (mal_isolate_locals()->array_iterator_next_callback)
#define mal_gc_poll (mal_isolate_locals()->gc_poll)

/* Async-signal-safe: request the isolate's next safepoint at a poll or compiled entry. */
static inline void mal_isolate_request_poll(MalIsolateLocals *isolate) {
#if defined(__wasi__)
    isolate->gc_poll = true;
#else
    atomic_store_explicit(&isolate->gc_poll, true, memory_order_release);
    atomic_store_explicit(&isolate->entry_stack_limit, UINTPTR_MAX, memory_order_relaxed);
#endif
}
#define mal_gc_termination (mal_isolate_locals()->gc_termination)
#define mal_gc_marking_active (mal_isolate_locals()->gc_marking_active)
#define mal_array_elements_protector (mal_isolate_locals()->array_elements_protector)
#define mal_primitive_method_protector (mal_isolate_locals()->primitive_method_protector)
#define mal_object_slot_coallocations (mal_isolate_locals()->object_slot_coallocations)
#define mal_object_slot_grow_migrations (mal_isolate_locals()->object_slot_grow_migrations)
#define mal_object_slot_dictionary_migrations \
    (mal_isolate_locals()->object_slot_dictionary_migrations)
