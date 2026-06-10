#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalVmFrame MalVmFrame;
typedef struct MalGeneratorObject MalGeneratorObject;

/**
 * The async/await driver. An async function reuses the generator suspendable-
 * frame machinery: ASYNC_START sets up a hidden state object + result promise
 * and hands the promise back to the caller, the body runs until its first
 * AWAIT (or return/throw), and the runtime resumes it when each awaited promise
 * settles — fulfilled resumes with NEXT(value), rejected with THROW(reason),
 * reusing the same resume-mode dispatch the compiler emits for yield.
 */

/**
 * MAL_OP_ASYNC_START: create the result promise and hidden async state, attach
 * the state to `frame`, and write the promise into the caller's return slot
 * (the body then keeps running in the same frame).
 */
void mal_async_function_start(MalVm *vm, MalVmFrame *frame);

/**
 * MAL_OP_AWAIT tail: resolve `awaited` to a promise and schedule resumption of
 * the suspended async `state` when it settles. The frame must already have been
 * saved into `state` and popped.
 */
void mal_async_function_await(MalVm *vm, MalGeneratorObject *state, MalValue awaited);

/** Resolve the async function's result promise (its body returned `value`). */
void mal_async_function_settle_return(MalVm *vm, MalGeneratorObject *state, MalValue value);

/** Reject the async function's result promise (its body threw `reason`). */
void mal_async_function_settle_throw(MalVm *vm, MalGeneratorObject *state, MalValue reason);
