#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"
#include "vm.h"

/**
 * Generator lifecycle (subset of the spec [[GeneratorState]] values).
 */
typedef enum MalGeneratorState {
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

/**
 * A generator instance owning its suspended activation. The frame's
 * registers/arguments buffers live with the generator while suspended
 * (transferred off the VM frame stack on suspend, pushed back on resume) and
 * are freed when the generator completes.
 */
typedef struct MalGeneratorObject {
    MalObject object;
    MalGeneratorState state;
    MalVmFrame frame;

    /**
     * Registers in `frame` where a resume writes the sent value and the resume
     * mode code; recorded by the most recent YIELD.
     */
    i32 resume_value_register;
    i32 resume_mode_register;

    /**
     * The value handed out by the current suspension (gen -> caller).
     */
    MalValue yielded_value;

    /**
     * Async-function activations reuse this same suspendable-frame machinery
     * (an async function is, in effect, a generator driven by an internal
     * promise driver). When is_async is set, this object is the async
     * function's hidden state: AWAIT suspends here, and async_resolve /
     * async_reject are the result promise's resolving functions, invoked when
     * the body returns or throws. Such an object is never exposed to user code.
     */
    bool is_async;
    MalValue async_resolve;
    MalValue async_reject;

    /**
     * Async stack stitching: for a suspended async function, the async state
     * that is `await`ing this one's result promise (set by mal_async_function_await
     * when the awaited value is another async function's result promise). A stack
     * capture taken inside this function follows the chain to splice in the
     * awaiting ancestors' frames. Null when nothing awaits it (or the awaiter is
     * not an async function — e.g. a plain `.then`, which is not stitched).
     */
    struct MalGeneratorObject *awaited_by;

    /**
     * Async generators (`async function*`) set is_async_generator (and is_async,
     * so await works). Each next/throw/return call enqueues a request here and
     * gets a promise back; the driver (builtin_async_generator.c) resolves the
     * front request when the body yields/returns/throws. agen_running guards
     * against re-entrant driving while the body is mid-step (e.g. awaiting).
     */
    bool is_async_generator;
    bool agen_running;
    struct MalAsyncGeneratorRequest *agen_queue_head;
    struct MalAsyncGeneratorRequest *agen_queue_tail;
} MalGeneratorObject;

/**
 * A queued next/throw/return on an async generator: the capability to settle
 * and the resume mode/value to deliver to the body.
 */
typedef struct MalAsyncGeneratorRequest {
    struct MalAsyncGeneratorRequest *next;
    MalValue resolve;
    MalValue reject;
    i32 mode;
    MalValue value;
} MalAsyncGeneratorRequest;

/**
 * Allocate a generator instance in the suspended-start state. The caller fills
 * in `frame` (typically by suspending the current activation into it).
 */
MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype);
