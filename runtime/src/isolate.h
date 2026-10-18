#pragma once

#include "./defaults.h"
#include "value.h"

struct MalVm;
struct MalObject;
struct MalRootSpan;

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
#endif
    /* Set during an incremental major mark cycle (init-mark → remark). */
    bool gc_marking_active;
    /* True while a default-prototype array's inherited chain has no integer-index
     * property, so a fresh-index store cannot hit an inherited setter. */
    bool array_elements_protector;
    /* Holds while no watched built-in prototype/lookup object has been mutated; gates
     * primitive, intrinsic-own, and inherited-method value caches. */
    bool primitive_method_protector;
} MalIsolateLocals;

extern MAL_ISOLATE_LOCAL MalIsolateLocals mal_isolate;

#define mal_root_span_head (mal_isolate.root_span_head)
#define mal_prototype_chain_epoch (mal_isolate.prototype_chain_epoch)
#define mal_array_prototype_object (mal_isolate.array_prototype_object)
#define mal_array_values_callback (mal_isolate.array_values_callback)
#define mal_array_iterator_next_callback (mal_isolate.array_iterator_next_callback)
#define mal_gc_poll (mal_isolate.gc_poll)
#define mal_gc_termination (mal_isolate.gc_termination)
#define mal_gc_marking_active (mal_isolate.gc_marking_active)
#define mal_array_elements_protector (mal_isolate.array_elements_protector)
#define mal_primitive_method_protector (mal_isolate.primitive_method_protector)
