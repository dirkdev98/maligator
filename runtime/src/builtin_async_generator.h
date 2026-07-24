#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalGeneratorObject MalGeneratorObject;
typedef struct MalAsyncGeneratorRequest MalAsyncGeneratorRequest;

/**
 * Install the async-iteration intrinsic chain: %AsyncIteratorPrototype% →
 * %AsyncGeneratorPrototype% (next/throw/return) → %AsyncGenerator%
 * (=AsyncGeneratorFunction.prototype) → %AsyncGeneratorFunction%. Requires the
 * well-known symbols, %Function.prototype%, and %Promise%.
 */
void mal_builtin_async_generator_install(MalVm *vm);

/**
 * Drive the async generator's request queue: while a request is pending and the
 * body isn't already running, resume it (or settle directly when completed).
 * Called when a request is enqueued and after each yield/return/throw.
 */
void mal_async_generator_resume_next(MalVm *vm, MalGeneratorObject *agen);

/**
 * Run-loop hooks for an async-generator body activation:
 *  - yield: resolve the front request with { value, done: false }.
 *  - return: complete and resolve the front request with { value, done: true }.
 *  - throw_done: complete and reject the front request with the thrown reason.
 * Each then drives the next queued request.
 */
void mal_async_generator_yield(MalVm *vm, MalGeneratorObject *agen);
void mal_async_generator_return(MalVm *vm, MalGeneratorObject *agen, MalValue value);
void mal_async_generator_throw_done(MalVm *vm, MalGeneratorObject *agen, MalValue reason);

/** Complete the front return request after AsyncGeneratorAwaitReturn settles. */
void mal_async_generator_await_return_complete(
    MalVm *vm,
    MalGeneratorObject *agen,
    bool is_reject,
    MalValue value
);

/** Release pending requests and the VM's cleared request-node pool. */
void mal_async_generator_free_requests(MalVm *vm, MalAsyncGeneratorRequest *requests);
void mal_async_generator_free_request_pool(MalVm *vm);

/** Native request-node allocation counters used by benchmark telemetry. */
u64 mal_async_generator_request_allocation_count(void);
u64 mal_async_generator_request_reuse_count(void);
