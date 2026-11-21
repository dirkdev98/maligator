#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"
#include "vm.h"

/**
 * Generator lifecycle (subset of the spec [[GeneratorState]] values).
 */
typedef enum MalGeneratorState : u8 {
    MAL_GENERATOR_SUSPENDED_START,
    MAL_GENERATOR_SUSPENDED_YIELD,
    MAL_GENERATOR_EXECUTING,
    MAL_GENERATOR_COMPLETED,
} MalGeneratorState;

/**
 * How a generator is resumed. The integer values are a fixed contract with the
 * compiler-emitted post-yield dispatch (see compileYieldExpression): the mode
 * is written into the yield's mode register and compared against these codes.
 */
typedef enum MalGeneratorResumeMode {
    MAL_GENERATOR_RESUME_NEXT = 0,
    MAL_GENERATOR_RESUME_THROW = 1,
    MAL_GENERATOR_RESUME_RETURN = 2,
} MalGeneratorResumeMode;

typedef struct MalGeneratorObject MalGeneratorObject;
typedef struct MalAsyncGeneratorRequest MalAsyncGeneratorRequest;

/**
 * Async generators coallocate their request queue and async stack link after
 * the common generator object. Synchronous generators omit this state.
 */
typedef struct MalGeneratorAsyncData {
    /** Async stack stitching to the function awaiting this result. */
    MalHeapHeader *awaited_by;
    MalAsyncGeneratorRequest *queue_head;
    MalAsyncGeneratorRequest *queue_tail;
} MalGeneratorAsyncData;

/** The owner heap type selects the promise/yield and awaiter/queue link fields. */
typedef struct MalCoroutineActivation {
    MalVmFrame frame;
    i32 resume_value_register;
    i32 resume_mode_register;
    union {
        MalValue yielded_value;
        MalValue promise;
    };
    union {
        MalGeneratorAsyncData *async_data;
        MalHeapHeader *awaited_by;
    };
    MalGeneratorState state;
    bool is_async_generator : 1;
    /** Guards against re-entrant driving while the body is mid-step (awaiting). */
    bool agen_running : 1;
    /** The current call must still package a terminal yield as done:false. */
    bool terminal_yield_pending : 1;
    /** yielded_value is a sync yield*'s inner result object, handed out unchanged. */
    bool yielded_result : 1;
} MalCoroutineActivation;

/**
 * Public generators own their activation and JavaScript object storage. Suspended
 * buffers transfer between the activation and VM frames until completion.
 */
struct MalGeneratorObject {
    MalObject object;
    MalObjectDeferredStorage object_storage;
    MalCoroutineActivation activation;
};

typedef struct MalAsyncFunctionState {
    MalHeapHeader header;
    MalCoroutineActivation activation;
    MalValue registers[2];
} MalAsyncFunctionState;

static_assert(sizeof(MalAsyncFunctionState) <= 192,
              "hidden async state outgrew its compact size class");

static inline MalCoroutineActivation *mal_coroutine_activation(MalHeapHeader *owner) {
    if (owner->type == MAL_HEAP_ASYNC_FUNCTION_STATE) {
        return &((MalAsyncFunctionState *) owner)->activation;
    }
    return &((MalGeneratorObject *) owner)->activation;
}

static inline bool mal_coroutine_is_async(const MalHeapHeader *owner) {
    return owner != nullptr &&
        (owner->type == MAL_HEAP_ASYNC_FUNCTION_STATE ||
         ((const MalGeneratorObject *) owner)->activation.is_async_generator);
}

static inline MalHeapHeader *mal_coroutine_awaited_by(MalHeapHeader *owner) {
    return owner->type == MAL_HEAP_ASYNC_FUNCTION_STATE
        ? ((MalAsyncFunctionState *) owner)->activation.awaited_by
        : ((MalGeneratorObject *) owner)->activation.async_data->awaited_by;
}

static inline void mal_async_function_note_owned_storage(MalAsyncFunctionState *state) {
    if ((state->activation.frame.registers != nullptr && state->activation.frame.registers != state->registers) ||
        state->activation.frame.arguments != nullptr) {
        mal_heap_cell_needs_finalizer(&state->header);
    }
}

static_assert(sizeof(MalGeneratorObject) <= 192,
              "synchronous generator state outgrew its compact size class");
static_assert(sizeof(MalGeneratorObject) + sizeof(MalGeneratorAsyncData) <= 224,
              "coallocated async generator state outgrew its size class");

/**
 * A queued next/throw/return on an async generator: the intrinsic Promise the
 * engine settles directly, its request realm's %Promise% constructor anchor,
 * and the resume mode/value to deliver to the body.
 */
struct MalAsyncGeneratorRequest {
    struct MalAsyncGeneratorRequest *next;
    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue value;
};

/**
 * Allocate a generator instance in the suspended-start state. The caller fills
 * in `frame` (typically by suspending the current activation into it).
 */
MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype);

/** Allocate a generator object with coallocated async-only state. */
MalGeneratorObject *mal_generator_object_new_async(
    MalHeap *heap, MalObject *prototype);

/** A suspended frame or a queued request now holds storage the finalizer releases. */
static inline void mal_generator_note_owned_storage(MalGeneratorObject *generator) {
    if (generator->activation.frame.registers != nullptr ||
        generator->activation.frame.arguments != nullptr || generator->activation.is_async_generator) {
        mal_heap_cell_needs_finalizer(&generator->object.header);
    }
}

/**
 * After a completed coroutine released its frame, its death needs no finalizer unless
 * an async generator still queues requests or ordinary object state owns storage.
 */
static inline void mal_generator_note_released_storage(MalGeneratorObject *generator) {
    if ((!generator->activation.is_async_generator || generator->activation.async_data->queue_head == nullptr) &&
        !mal_object_finalizes(&generator->object)) {
        mal_heap_cell_owns_nothing(&generator->object.header);
    }
}

/** Shade, release, and null all malloc-owned storage in a coroutine frame. */
void mal_generator_release_frame(MalVm *vm, MalGeneratorObject *generator);
