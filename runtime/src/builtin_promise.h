#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalGeneratorObject MalGeneratorObject;

/**
 * Install the Promise constructor and prototype. Requires the well-known
 * symbols (@@species, @@toStringTag) and %Function.prototype%.
 */
void mal_builtin_promise_install(MalVm *vm);

/**
 * NewPromiseCapability(C): create a promise via constructor C and capture its
 * resolving functions. For the built-in Promise this allocates directly; for a
 * subclass it constructs C with a capabilities executor. Returns false with a
 * pending throw on failure (C not a constructor, or resolve/reject not
 * callable after construction).
 *
 * Exposed for the async/await driver, which builds a result capability per
 * async function activation.
 */
bool mal_promise_new_capability(
    MalVm *vm,
    MalValue constructor,
    MalValue *out_promise,
    MalValue *out_resolve,
    MalValue *out_reject
);

/**
 * Create a resolving-function pair (CreateResolvingFunctions) for an existing
 * promise value: the two functions share one [[AlreadyResolved]] guard.
 */
void mal_promise_create_resolving(
    MalVm *vm,
    MalValue promise,
    MalValue *out_resolve,
    MalValue *out_reject
);

/**
 * Settle a bare exact-intrinsic Promise without first materializing its
 * resolving functions. `constructor` is the target realm's %Promise%
 * constructor; direct .then capabilities retain it in their reaction/job
 * payload, while intrinsic statics/await/async results pass the current one.
 */
void mal_promise_settle_direct(
    MalVm *vm,
    MalValue promise,
    MalValue constructor,
    bool is_reject,
    MalValue argument
);

/** Process-wide counters exposed through MAL_PROMISE_STATS. */
u64 mal_promise_direct_capability_count(void);
u64 mal_promise_direct_fallback_pair_count(void);
u64 mal_promise_direct_intrinsic_creation_count(void);
u64 mal_promise_direct_async_result_count(void);

/** Record creation of a bare async-function result Promise. */
void mal_promise_note_direct_async_result(void);

/**
 * PromiseResolve(%Promise%, value): if value is already a native Promise return
 * it, otherwise wrap it in a resolved promise. Returns false with a pending
 * throw on failure. Used by the async/await driver to normalize an awaited
 * value before attaching resumption reactions.
 */
bool mal_promise_resolve_value(MalVm *vm, MalValue value, MalValue *out_promise);

/**
 * Register a typed async-function continuation against an intrinsic Promise.
 * The caller must first normalize the awaited value with
 * mal_promise_resolve_value. Settlement queues a direct await job rather than
 * allocating callable fulfillment/rejection closures.
 */
void mal_promise_perform_await(
    MalVm *vm,
    MalValue promise,
    MalGeneratorObject *state
);

/**
 * PerformPromiseThen on a Promise value: register on_fulfilled / on_rejected
 * (callables, or undefined for the default pass-through/rethrow) against an
 * optional result capability (pass undefined cap functions for none).
 */
void mal_promise_perform_then(
    MalVm *vm,
    MalValue promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
);
