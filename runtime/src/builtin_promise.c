#include "builtin_promise.h"

#include <stdlib.h>

#include "array_object.h"
#include "builtin_array.h"
#include "builtin_error.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "object.h"
#include "object_ops.h"
#include "perf_stats.h"
#include "promise_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "rooted_collection.h"
#include "value_ops.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

// Internal-slot layout for the resolving functions (CreateResolvingFunctions).
// A pair shares one [[AlreadyResolved]] guard: the resolve function owns it in
// slot 1, and the reject function points at the resolve function so both read
// and write the same cell.
enum {
    MAL_PROMISE_RESOLVE_SLOT_PROMISE = 0,
    MAL_PROMISE_RESOLVE_SLOT_ALREADY_RESOLVED = 1,
};
enum {
    MAL_PROMISE_REJECT_SLOT_PROMISE = 0,
    MAL_PROMISE_REJECT_SLOT_RESOLVE_FN = 1,
};

static u64 g_direct_capabilities = 0;
static u64 g_direct_fallback_pairs = 0;
static u64 g_direct_intrinsic_creations = 0;
static u64 g_direct_async_results = 0;

u64 mal_promise_direct_capability_count(void) {
    return g_direct_capabilities;
}

u64 mal_promise_direct_fallback_pair_count(void) {
    return g_direct_fallback_pairs;
}

u64 mal_promise_direct_intrinsic_creation_count(void) {
    return g_direct_intrinsic_creations;
}

u64 mal_promise_direct_async_result_count(void) {
    return g_direct_async_results;
}

void mal_promise_note_direct_async_result(void) {
    g_direct_async_results++;
}

static MalCompletion mal_promise_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static MalObject *mal_promise_function_prototype(MalVm *vm) {
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
}

/** Allocate an anonymous built-in closure with captured slots, correct length/name. */
static MalValue mal_promise_new_closure(
    MalVm *vm,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count,
    i32 length
) {
    MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots_arity_keys(
        &vm->heap, mal_promise_function_prototype(vm),
        mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY), length, callback, slots, slot_count,
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH),
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NAME));
    return mal_value_from_native_function_object(fn);
}

/** Build an error value without leaving the throw pending (for rejecting with it). */
static MalValue mal_promise_take_error(MalVm *vm, MalIntrinsic prototype_slot, const byte *message) {
    mal_vm_throw_error(vm, prototype_slot, message);
    MalValue error = vm->completion.value;
    vm->completion = mal_promise_normal();
    return error;
}

/* An empty own layout, the captured function's realm-exact prototype, and the
 * monotonic protector prove then/constructor/@@species unchanged. */
static bool mal_promise_is_canonical_intrinsic(
    MalVm *vm,
    MalValue value,
    MalValue captured_then
) {
    if (!mal_primitive_method_protector || !mal_value_is_promise_object(value)) {
        return false;
    }

    MalObject *object = &mal_value_to_promise_object(value)->object;
    if (object->shape->inline_count != 0 || object->overflow != nullptr) {
        return false;
    }

#if MAL_REALMS
    MalRealm *realm = mal_vm_callee_realm(vm, captured_then);
    MalObject *promise_prototype =
        mal_value_to_object(realm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]);
#else
    MalObject *promise_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]);
#endif
    return object->prototype == promise_prototype;
}

// --- Resolving functions -----------------------------------------------------

/**
 * The settlement half of CreateResolvingFunctions, after its shared
 * [[AlreadyResolved]] guard has won. Direct intrinsic paths call this without
 * materializing an initial resolving pair. Returns whether thenable callbacks
 * had to be materialized.
 */
static bool mal_promise_settle_internal(
    MalVm *vm,
    MalValue promise_value,
    bool is_reject,
    MalValue argument
) {
    // A direct target is otherwise only a C local here. Property lookup,
    // TypeError creation, and resolving-function materialization may all collect.
    MalValue roots[3] = {promise_value, argument, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);

    MalPromiseObject *promise = mal_value_to_promise_object(roots[0]);
    if (is_reject) {
        mal_promise_reject(vm, promise, roots[1]);
        mal_gc_unroot(&span);
        return false;
    }

    // Resolving a promise with itself is a chaining cycle: reject with TypeError.
    if (roots[1] == roots[0]) {
        MalValue error = mal_promise_take_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Chaining cycle detected for promise");
        mal_promise_reject(vm, promise, error);
        mal_gc_unroot(&span);
        return false;
    }

    if (!mal_value_is_object(roots[1])) {
        mal_promise_fulfill(vm, promise, roots[1]);
        mal_gc_unroot(&span);
        return false;
    }

    // then = Get(resolution, "then"); a throwing getter rejects the promise.
    if (!mal_vm_get_property(
            vm, roots[1], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_THEN),
            &roots[2])) {
        MalValue error = vm->completion.value;
        vm->completion = mal_promise_normal();
        mal_promise_reject(vm, promise, error);
        mal_gc_unroot(&span);
        return false;
    }

    if (mal_value_is_promise_object(roots[1])) {
        if (mal_value_is_callable(roots[2]) &&
            mal_promise_is_canonical_intrinsic(vm, roots[1], roots[2])) {
            MAL_PERF_COUNT(promise_native_adoption_hits);
            mal_vm_enqueue_promise_adoption_job(
                vm,
                roots[2],
                roots[1],
                roots[0],
                vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]);
            mal_gc_unroot(&span);
            return false;
        }
        MAL_PERF_COUNT(promise_native_adoption_guard_fallbacks);
    }

    if (!mal_value_is_callable(roots[2])) {
        mal_promise_fulfill(vm, promise, roots[1]);
        mal_gc_unroot(&span);
        return false;
    }

    // User thenable code must receive real callables. Materialize this fresh
    // CreateResolvingFunctions pair only after observing a callable `then`.
    MalValue job_resolve;
    MalValue job_reject;
    mal_promise_create_resolving(vm, roots[0], &job_resolve, &job_reject);
    mal_vm_enqueue_thenable_job(vm, roots[2], roots[1], job_resolve, job_reject);
    mal_gc_unroot(&span);
    return true;
}

static MalValue mal_promise_resolve_function(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_PROMISE_RESOLVE_SLOT_ALREADY_RESOLVED))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(self, MAL_PROMISE_RESOLVE_SLOT_ALREADY_RESOLVED, mal_value_new_boolean(true));

    MalValue promise_value = mal_native_function_object_get_slot(self, MAL_PROMISE_RESOLVE_SLOT_PROMISE);
    MalValue resolution = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    (void) mal_promise_settle_internal(vm, promise_value, false, resolution);
    return mal_value_new_undefined();
}

static MalValue mal_promise_reject_function(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    // The shared guard lives on the paired resolve function.
    MalValue resolve_value = mal_native_function_object_get_slot(self, MAL_PROMISE_REJECT_SLOT_RESOLVE_FN);
    MalNativeFunctionObject *resolve = mal_value_to_native_function_object(resolve_value);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(resolve, MAL_PROMISE_RESOLVE_SLOT_ALREADY_RESOLVED))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(resolve, MAL_PROMISE_RESOLVE_SLOT_ALREADY_RESOLVED, mal_value_new_boolean(true));

    MalValue promise_value = mal_native_function_object_get_slot(self, MAL_PROMISE_REJECT_SLOT_PROMISE);
    MalValue reason = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    (void) mal_promise_settle_internal(vm, promise_value, true, reason);
    return mal_value_new_undefined();
}

void mal_promise_settle_direct(
    MalVm *vm,
    MalValue promise,
    MalValue constructor,
    bool is_reject,
    MalValue argument
) {
#if MAL_REALMS
    // Calling a materialized resolving function would enter its stamped realm.
    // Preserve that behavior while bypassing generic function dispatch.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, constructor));
#else
    (void) constructor;
#endif

    if (mal_promise_settle_internal(vm, promise, is_reject, argument)) {
        g_direct_fallback_pairs++;
    }

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
}

/** Allocate and settle a bare Promise using the current realm's intrinsics. */
static MalValue mal_promise_new_settled_intrinsic(
    MalVm *vm,
    bool is_reject,
    MalValue argument
) {
    // The argument may otherwise live only in a native callback's C locals while
    // allocating the promise and inspecting/assimilating an object resolution.
    MalRootSpan argument_root;
    mal_gc_root(&argument_root, &argument, 1);

    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);
    mal_promise_settle_direct(
        vm,
        promise_value,
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
        is_reject,
        argument);
    g_direct_intrinsic_creations++;

    mal_gc_unroot(&argument_root);
    return promise_value;
}

/** Give a resolving function the spec-mandated name "" and length 1. */
static MalNativeFunctionObject *mal_promise_new_resolving_fn(
    MalVm *vm,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count
) {
    MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots_arity_keys(
        &vm->heap,
        mal_promise_function_prototype(vm),
        mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY),
        1,
        callback,
        slots,
        slot_count,
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH),
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NAME)
    );
    return fn;
}

void mal_promise_create_resolving(MalVm *vm, MalValue promise, MalValue *out_resolve, MalValue *out_reject) {
    MAL_PERF_COUNT(promise_resolving_pairs);
    MalValue resolve_slots[2] = {promise, mal_value_new_boolean(false)};
    MalNativeFunctionObject *resolve = mal_promise_new_resolving_fn(vm, mal_promise_resolve_function, resolve_slots, 2);
    MalValue resolve_value = mal_value_from_native_function_object(resolve);

    // The reject closure's allocation can collect; the just-built resolve function
    // (and the promise) live only in C locals here, so root them across it.
    MalValue roots[2] = {resolve_value, promise};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    MalValue reject_slots[2] = {promise, resolve_value};
    MalNativeFunctionObject *reject = mal_promise_new_resolving_fn(vm, mal_promise_reject_function, reject_slots, 2);
    mal_gc_unroot(&span);

    *out_resolve = resolve_value;
    *out_reject = mal_value_from_native_function_object(reject);
}

// --- NewPromiseCapability ----------------------------------------------------

enum {
    MAL_PROMISE_CAP_EXECUTOR_SLOT_RESOLVE = 0,
    MAL_PROMISE_CAP_EXECUTOR_SLOT_REJECT = 1,
};

static MalValue mal_promise_capabilities_executor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    // GetCapabilitiesExecutor steps 3-4: throw if either slot is already set to
    // anything other than undefined (regardless of callability).
    if (!mal_value_is_undefined(mal_native_function_object_get_slot(self, MAL_PROMISE_CAP_EXECUTOR_SLOT_RESOLVE)) ||
        !mal_value_is_undefined(mal_native_function_object_get_slot(self, MAL_PROMISE_CAP_EXECUTOR_SLOT_REJECT))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise capabilities executor already invoked");
        return mal_value_new_undefined();
    }

    mal_native_function_object_set_slot(self, MAL_PROMISE_CAP_EXECUTOR_SLOT_RESOLVE, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_native_function_object_set_slot(self, MAL_PROMISE_CAP_EXECUTOR_SLOT_REJECT, arg_count >= 2 ? args[1] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

bool mal_promise_new_capability(MalVm *vm, MalValue constructor, MalValue *out_promise, MalValue *out_resolve, MalValue *out_reject) {
    // Fast path: the built-in %Promise% constructor needs no executor round-trip.
    if (constructor == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]) {
        MalPromiseObject *promise = mal_promise_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
        MalValue promise_value = mal_value_from_promise_object(promise);
        mal_promise_create_resolving(vm, promise_value, out_resolve, out_reject);
        *out_promise = promise_value;
        return true;
    }

    if (!mal_value_is_callable(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise constructor is not a constructor");
        return false;
    }

    MalValue executor_slots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalValue executor_value = mal_promise_new_closure(vm, mal_promise_capabilities_executor, executor_slots, 2, 2);
    MalNativeFunctionObject *executor = mal_value_to_native_function_object(executor_value);

    MalCompletion completion = mal_vm_construct_value(vm, constructor, &executor_value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }

    MalValue resolve = mal_native_function_object_get_slot(executor, MAL_PROMISE_CAP_EXECUTOR_SLOT_RESOLVE);
    MalValue reject = mal_native_function_object_get_slot(executor, MAL_PROMISE_CAP_EXECUTOR_SLOT_REJECT);
    if (!mal_value_is_callable(resolve) || !mal_value_is_callable(reject)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise resolve/reject is not callable");
        return false;
    }

    *out_promise = completion.value;
    *out_resolve = resolve;
    *out_reject = reject;
    return true;
}

void mal_promise_new_direct_capability(
    MalVm *vm,
    MalValue *out_promise,
    MalValue *out_resolve,
    MalValue *out_reject
) {
    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    *out_promise = mal_value_from_promise_object(promise);
    *out_resolve = *out_promise;
    *out_reject = vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
    g_direct_capabilities++;
}

// --- Constructor -------------------------------------------------------------

static MalValue mal_promise_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;

    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor Promise requires 'new'");
        return mal_value_new_undefined();
    }

    MalValue executor = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(executor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise executor is not a function");
        return mal_value_new_undefined();
    }

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_PROMISE_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }

    MalPromiseObject *promise = mal_promise_object_new(&vm->heap, prototype);
    MalValue promise_value = mal_value_from_promise_object(promise);

    MalValue resolve;
    MalValue reject;
    mal_promise_create_resolving(vm, promise_value, &resolve, &reject);

    MalValue executor_args[2] = {resolve, reject};
    MalCompletion completion = mal_vm_call_value(vm, executor, mal_value_new_undefined(), executor_args, 2);
    if (completion.kind == MAL_COMPLETION_THROW) {
        // An abrupt executor rejects the promise with the thrown value.
        MalValue error = completion.value;
        vm->completion = mal_promise_normal();
        mal_vm_call_value(vm, reject, mal_value_new_undefined(), &error, 1);
        vm->completion = mal_promise_normal();
    }

    return promise_value;
}

// --- then / catch ------------------------------------------------------------

/** PerformPromiseThen: register/schedule reactions against a result capability. */
void mal_promise_perform_then(
    MalVm *vm,
    MalValue promise_value,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
    MalValue fulfill_handler = mal_value_is_callable(on_fulfilled) ? on_fulfilled : mal_value_new_undefined();
    MalValue reject_handler = mal_value_is_callable(on_rejected) ? on_rejected : mal_value_new_undefined();

    promise->is_handled = true;

    switch (promise->state) {
        case MAL_PROMISE_PENDING:
            mal_promise_append_reaction(
                vm, promise, fulfill_handler, reject_handler, cap_resolve, cap_reject);
            break;
        case MAL_PROMISE_FULFILLED:
            mal_vm_enqueue_reaction_job(vm, fulfill_handler, false, cap_resolve, cap_reject, promise->result);
            break;
        case MAL_PROMISE_REJECTED:
            mal_vm_enqueue_reaction_job(vm, reject_handler, true, cap_resolve, cap_reject, promise->result);
            break;
    }
}

bool mal_promise_try_perform_native_adoption(
    MalVm *vm,
    MalValue captured_then,
    MalValue source,
    MalValue target,
    MalValue target_constructor
) {
    if (!mal_promise_is_canonical_intrinsic(vm, source, captured_then)) {
        return false;
    }

    mal_promise_perform_then(
        vm,
        source,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        target,
        target_constructor);
    return true;
}

void mal_promise_perform_await(
    MalVm *vm,
    MalValue promise_value,
    MalGeneratorObject *state
) {
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
    MalValue state_value = mal_value_from_object((MalObject *) state);

    promise->is_handled = true;
    MAL_PERF_COUNT(promise_await_typed_continuations);

    switch (promise->state) {
        case MAL_PROMISE_PENDING:
            mal_promise_append_await_reaction(vm, promise, state_value);
            break;
        case MAL_PROMISE_FULFILLED:
            mal_vm_enqueue_await_job(vm, state_value, false, promise->result);
            break;
        case MAL_PROMISE_REJECTED:
            mal_vm_enqueue_await_job(vm, state_value, true, promise->result);
            break;
    }
}

void mal_promise_perform_async_generator_return(
    MalVm *vm,
    MalValue promise_value,
    MalGeneratorObject *generator
) {
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
    MalValue generator_value = mal_value_from_object((MalObject *) generator);
    MalValue realm_anchor = vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];

    promise->is_handled = true;
    switch (promise->state) {
        case MAL_PROMISE_PENDING:
            mal_promise_append_async_generator_return_reaction(
                vm, promise, generator_value, realm_anchor);
            break;
        case MAL_PROMISE_FULFILLED:
            mal_vm_enqueue_async_generator_return_job(
                vm, generator_value, realm_anchor, false, promise->result);
            break;
        case MAL_PROMISE_REJECTED:
            mal_vm_enqueue_async_generator_return_job(
                vm, generator_value, realm_anchor, true, promise->result);
            break;
    }
}

void mal_promise_perform_async_from_sync(
    MalVm *vm,
    MalValue promise_value,
    MalValue sync_iterator,
    bool done,
    bool close_on_rejection,
    MalValue result_promise,
    MalValue realm_anchor
) {
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
    promise->is_handled = true;

    switch (promise->state) {
        case MAL_PROMISE_PENDING:
            mal_promise_append_async_from_sync_reaction(
                vm,
                promise,
                sync_iterator,
                result_promise,
                realm_anchor,
                done,
                close_on_rejection);
            break;
        case MAL_PROMISE_FULFILLED:
            mal_vm_enqueue_async_from_sync_job(
                vm,
                sync_iterator,
                result_promise,
                realm_anchor,
                done,
                close_on_rejection,
                false,
                promise->result);
            break;
        case MAL_PROMISE_REJECTED:
            mal_vm_enqueue_async_from_sync_job(
                vm,
                sync_iterator,
                result_promise,
                realm_anchor,
                done,
                close_on_rejection,
                true,
                promise->result);
            break;
    }
}

void mal_promise_perform_async_dispose(
    MalVm *vm,
    MalValue promise_value,
    MalValue result_promise,
    MalValue realm_anchor
) {
    MalPromiseObject *promise = mal_value_to_promise_object(promise_value);
    MalValue discard_fulfillment = mal_value_new_empty();
    promise->is_handled = true;

    switch (promise->state) {
        case MAL_PROMISE_PENDING:
            mal_promise_append_reaction(
                vm,
                promise,
                discard_fulfillment,
                mal_value_new_undefined(),
                result_promise,
                realm_anchor);
            break;
        case MAL_PROMISE_FULFILLED:
            mal_vm_enqueue_reaction_job(
                vm,
                discard_fulfillment,
                false,
                result_promise,
                realm_anchor,
                promise->result);
            break;
        case MAL_PROMISE_REJECTED:
            mal_vm_enqueue_reaction_job(
                vm,
                mal_value_new_undefined(),
                true,
                result_promise,
                realm_anchor,
                promise->result);
            break;
    }
}

/** SpeciesConstructor(O, %Promise%) for the result capability of then. */
static MalValue mal_promise_species_constructor(MalVm *vm, MalValue object) {
    MalValue constructor;
    if (!mal_vm_get_property(vm, object, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_CONSTRUCTOR), &constructor)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(constructor)) {
        return vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
    }
    if (!mal_value_is_object(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "constructor is not an object");
        return mal_value_new_undefined();
    }

    MalValue species;
    if (!mal_vm_get_property(vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &species)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_nil(species)) {
        return vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
    }
    if (!mal_value_is_callable(species)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.species is not a constructor");
        return mal_value_new_undefined();
    }
    return species;
}

static MalValue mal_promise_prototype_then(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;

    if (!mal_value_is_promise_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.prototype.then called on non-Promise");
        return mal_value_new_undefined();
    }

    MalValue constructor;
    if (mal_promise_is_canonical_intrinsic(vm, this_value, callee)) {
        constructor = vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
        MAL_PERF_COUNT(promise_intrinsic_species_hits);
    } else {
        MAL_PERF_COUNT(promise_guarded_fallbacks);
        constructor = mal_promise_species_constructor(vm, this_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (constructor == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]) {
        // Direct capability encoding: cap_resolve is the target promise and
        // cap_reject is its exact intrinsic constructor (the realm anchor/tag).
        // Generic capabilities always have two callable fields; capability-less
        // internal reactions have two undefined fields.
        mal_promise_new_direct_capability(
            vm, &cap_promise, &cap_resolve, &cap_reject);
    } else {
        if (!mal_promise_new_capability(
                vm, constructor, &cap_promise, &cap_resolve, &cap_reject)) {
            return mal_value_new_undefined();
        }
    }

    MalValue on_fulfilled = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue on_rejected = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    mal_promise_perform_then(vm, this_value, on_fulfilled, on_rejected, cap_resolve, cap_reject);
    return cap_promise;
}

/** Call an observed current-realm intrinsic `then` without generic native dispatch. */
static MalCompletion mal_promise_call_captured_then(
    MalVm *vm,
    MalValue then,
    MalValue receiver,
    const MalValue *args,
    i32 arg_count
) {
    bool direct = mal_value_is_native_function_object(then) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(then)) ==
            mal_promise_prototype_then;
#if MAL_REALMS
    direct = direct && mal_vm_callee_realm(vm, then) == vm->current_realm;
#endif
    if (!direct) {
        return mal_vm_call_value(vm, then, receiver, args, arg_count);
    }

    MalValue value = mal_promise_prototype_then(
        vm,
        receiver,
        args,
        arg_count,
        mal_value_new_undefined(),
        then);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? vm->completion
        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
}

static MalValue mal_promise_prototype_catch(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    // catch(onRejected) === this.then(undefined, onRejected) through the real
    // (possibly overridden) then, so Get it rather than calling perform_then.
    MalValue then;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_THEN), &then)) {
        return mal_value_new_undefined();
    }
    MalValue then_args[2] = {mal_value_new_undefined(), arg_count >= 1 ? args[0] : mal_value_new_undefined()};
    MalCompletion completion = mal_promise_call_captured_then(
        vm, then, this_value, then_args, 2);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

// --- Promise.resolve / Promise.reject ----------------------------------------

static MalValue mal_promise_resolve_static(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.resolve called on non-object");
        return mal_value_new_undefined();
    }

    MalValue x = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_promise_object(x)) {
        if (this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR] &&
            mal_promise_is_canonical_intrinsic(vm, x, this_value)) {
            MAL_PERF_COUNT(promise_resolve_identity_hits);
            return x;
        }
        MalValue x_constructor;
        if (!mal_vm_get_property(vm, x, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_CONSTRUCTOR), &x_constructor)) {
            return mal_value_new_undefined();
        }
        if (x_constructor == this_value) {
            return x;
        }
    }

    if (this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]) {
        return mal_promise_new_settled_intrinsic(vm, false, x);
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, this_value, &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &x, 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return cap_promise;
}

static MalValue mal_promise_reject_static(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.reject called on non-object");
        return mal_value_new_undefined();
    }

    MalValue reason = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]) {
        return mal_promise_new_settled_intrinsic(vm, true, reason);
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, this_value, &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &reason, 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return cap_promise;
}

bool mal_promise_resolve_value(MalVm *vm, MalValue value, MalValue *out_promise) {
    // Root `value` for the whole operation: creating the promise capability (and the
    // constructor read on the short-circuit path) allocates, and `value` is consumed
    // afterwards — an unrooted heap value would be freed under GC pressure.
    MalRootSpan value_root;
    mal_gc_root(&value_root, &value, 1);

    // Short-circuit a value that is already a native %Promise% (no extra wrap,
    // matching the current spec's single-tick await on a native promise).
    if (mal_value_is_promise_object(value)) {
        MalValue constructor;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_CONSTRUCTOR), &constructor)) {
            mal_gc_unroot(&value_root);
            return false;
        }
        if (constructor == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR]) {
            *out_promise = value;
            mal_gc_unroot(&value_root);
            return true;
        }
    }

    MalValue promise = mal_promise_new_settled_intrinsic(vm, false, value);
    mal_gc_unroot(&value_root);
    *out_promise = promise;
    return true;
}

// --- Combinators (all / race / allSettled) -----------------------------------

/**
 * CreateDataProperty(values, index, value): define an own data property
 * directly, bypassing any inherited setter (the result arrays of all/
 * allSettled/any are built with CreateArrayFromList, not [[Set]]). Grows the
 * array length to cover the index.
 */
static void mal_promise_array_create_data(MalValue array_value, i32 index, MalValue value) {
    MalArrayObject *array = mal_value_to_array_object(array_value);
    if ((u32) index >= mal_array_object_length(array)) {
        mal_array_object_set_length(array, (u32) index + 1);
    }
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(&array->object, mal_key_index(index), &desc);
}

// These internal cells back spec Records ([[value]] / alreadyCalled), so reads
// and writes must use own data properties via CreateDataProperty, never
// [[Set]] (which would consult an inherited indexed accessor on
// Array.prototype, e.g. does-not-invoke-array-setters).

/** Build a private one-element dense Array used only as an internal spec cell. */
static MalValue mal_promise_cell_new(MalVm *vm, MalValue initial) {
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, 1);
    if (!mal_array_object_dense_build_values(array, 0, &initial, 1)) {
        MalValue array_value = mal_value_from_array_object(array);
        mal_promise_array_create_data(array_value, 0, initial);
        return array_value;
    }
    return mal_value_from_array_object(array);
}

static MalValue mal_promise_cell_get(MalVm *vm, MalValue cell) {
    MalValue out;
    MalArrayObject *array = mal_value_to_array_object(cell);
    if (!mal_array_object_dense_get(array, 0, &out)) {
        mal_builtin_array_try_get(vm, cell, 0, &out);
    }
    return out;
}

static void mal_promise_cell_set(MalValue cell, MalValue value) {
    MalArrayObject *array = mal_value_to_array_object(cell);
    if (mal_array_object_dense_store(array, 0, value) != MAL_ARRAY_DENSE_APPLIED) {
        mal_promise_array_create_data(cell, 0, value);
    }
}

/** A shared mutable integer cell (1-element array), for the remaining counter. */
static MalValue mal_promise_counter_new(MalVm *vm, i32 initial) {
    return mal_promise_cell_new(vm, mal_value_from_i32(initial));
}
static i32 mal_promise_counter_get(MalVm *vm, MalValue counter) {
    return mal_value_to_i32(mal_promise_cell_get(vm, counter));
}
static void mal_promise_counter_set(MalValue counter, i32 value) {
    mal_promise_cell_set(counter, mal_value_from_i32(value));
}

/** A shared boolean cell; test_set returns the prior value and sets it true. */
static MalValue mal_promise_flag_new(MalVm *vm) {
    return mal_promise_cell_new(vm, mal_value_new_boolean(false));
}
static bool mal_promise_flag_test_set(MalVm *vm, MalValue flag) {
    MalValue out = mal_promise_cell_get(vm, flag);
    if (mal_value_is_truthy(out)) {
        return true;
    }
    mal_promise_cell_set(flag, mal_value_new_boolean(true));
    return false;
}

/** IfAbruptRejectPromise: reject the capability with the pending error, return its promise. */
static MalValue mal_promise_reject_abrupt(MalVm *vm, MalValue cap_reject, MalValue cap_promise) {
    MalValue error = vm->completion.value;
    vm->completion = mal_promise_normal();
    mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &error, 1);
    vm->completion = mal_promise_normal();
    return cap_promise;
}

/** Invoke nextPromise.then(onFulfilled, onRejected). When discard_safe is true,
 * both runtime-owned handlers are proven to complete normally with undefined,
 * so a canonical current-realm Promise needs neither the protected intrinsic
 * property lookup nor its otherwise-unobservable dependent. */
static bool mal_promise_invoke_then(
    MalVm *vm,
    MalValue promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    bool discard_safe
) {
    MalValue roots[4] = {promise, on_fulfilled, on_rejected, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    if (discard_safe) {
        if (mal_promise_is_canonical_intrinsic(
                vm,
                roots[0],
                vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR])) {
            mal_promise_perform_then(
                vm,
                roots[0],
                roots[1],
                roots[2],
                mal_value_new_undefined(),
                mal_value_new_undefined());
            MAL_PERF_COUNT(promise_discarded_dependent_registrations);
            mal_gc_unroot(&span);
            return true;
        }
        MAL_PERF_COUNT(promise_guarded_fallbacks);
    }
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_THEN), &roots[3])) {
        mal_gc_unroot(&span);
        return false;
    }
    MalValue then_args[2] = {roots[1], roots[2]};
    MalCompletion completion = mal_promise_call_captured_then(
        vm, roots[3], roots[0], then_args, 2);
    mal_gc_unroot(&span);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    return true;
}

/** Shared combinator prologue: capability + promiseResolve + GetIterator, with IfAbruptRejectPromise. */
typedef struct {
    bool ok;
    bool direct_resolve;
    MalValue result_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    MalValue promise_resolve;
    MalIteratorRecord iterator;
} MalPromiseCombinator;

static MalPromiseCombinator mal_promise_combinator_begin(MalVm *vm, MalValue constructor, const MalValue *args, i32 arg_count) {
    MalPromiseCombinator ctx = {0};
    ctx.result_promise = mal_value_new_undefined();

    // Capability creation (its executor), the `resolve` get, reject_abrupt, and
    // GetIterator all re-enter JS and can collect; root ctx's capability fields
    // (the 4 contiguous MalValues from result_promise) across them. The zero-init
    // leaves not-yet-set fields as +0.0 (non-heap), which the scan safely skips.
    MalRootSpan span;
    mal_gc_root(&span, &ctx.result_promise, 4);

    if (!mal_value_is_object(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise combinator called on non-object");
        goto done;
    }
    if (!mal_promise_new_capability(vm, constructor, &ctx.result_promise, &ctx.cap_resolve, &ctx.cap_reject)) {
        goto done; // pending throw, no promise to reject
    }
    if (!mal_vm_get_property(vm, constructor, mal_intrinsic_string_key(vm, "resolve"), &ctx.promise_resolve)) {
        mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
        goto done;
    }
    if (!mal_value_is_callable(ctx.promise_resolve)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.resolve is not callable");
        mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
        goto done;
    }
    ctx.direct_resolve =
        constructor == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR] &&
        mal_value_is_native_function_object(ctx.promise_resolve) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(ctx.promise_resolve)) ==
            mal_promise_resolve_static;
#if MAL_REALMS
    ctx.direct_resolve = ctx.direct_resolve &&
        mal_vm_callee_realm(vm, ctx.promise_resolve) == vm->current_realm;
#endif
    MalValue iterable = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_vm_get_iterator(vm, iterable, &ctx.iterator)) {
        mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
        goto done;
    }
    ctx.ok = true;

done:
    mal_gc_unroot(&span);
    return ctx;
}

/** promiseResolve.call(C, value) → the wrapped element promise. */
static bool mal_promise_resolve_element(MalVm *vm, const MalPromiseCombinator *ctx, MalValue constructor, MalValue value, MalValue *out) {
    if (ctx->direct_resolve) {
        *out = mal_promise_resolve_static(
            vm,
            constructor,
            &value,
            1,
            mal_value_new_undefined(),
            ctx->promise_resolve);
        return vm->completion.kind != MAL_COMPLETION_THROW;
    }
    MalCompletion completion = mal_vm_call_value(vm, ctx->promise_resolve, constructor, &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    *out = completion.value;
    return true;
}

// Element-closure internal-slot layout shared by all / allSettled.
enum {
    MAL_PROMISE_ELEMENT_SLOT_FLAG = 0,     // already-called (bool for all; cell for allSettled)
    MAL_PROMISE_ELEMENT_SLOT_INDEX = 1,
    MAL_PROMISE_ELEMENT_SLOT_VALUES = 2,
    MAL_PROMISE_ELEMENT_SLOT_COUNTER = 3,
    MAL_PROMISE_ELEMENT_SLOT_RESOLVE = 4,
};

static MalValue mal_promise_all_element(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG, mal_value_new_boolean(true));

    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_INDEX));
    MalValue values = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_VALUES);
    MalValue counter = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_COUNTER);
    MalValue cap_resolve = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_RESOLVE);

    mal_promise_array_create_data(values, index, arg_count >= 1 ? args[0] : mal_value_new_undefined());

    i32 remaining = mal_promise_counter_get(vm, counter) - 1;
    mal_promise_counter_set(counter, remaining);
    if (remaining == 0) {
        mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &values, 1);
    }
    return mal_value_new_undefined();
}

static MalValue mal_promise_all(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    MalPromiseCombinator ctx = mal_promise_combinator_begin(vm, this_value, args, arg_count);
    if (!ctx.ok) {
        return ctx.result_promise;
    }
    bool discard_safe = this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];

    MalValue values = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue counter = mal_promise_counter_new(vm, 1);
    i32 index = 0;

    // The iterator step, promiseResolve, and .then all re-enter JS and can collect;
    // root ctx (its 6 contiguous MalValues: caps + iterator record) + the values
    // array + counter, and lift GC suppression for the drain loop.
    MalValue vc[2] = {values, counter};
    MalRootSpan ctx_span, vc_span;
    mal_gc_root(&ctx_span, &ctx.result_promise, 6);
    mal_gc_root(&vc_span, vc, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = ctx.result_promise;

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &ctx.iterator, &next_value, &done)) {
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        if (done) {
            i32 remaining = mal_promise_counter_get(vm, counter) - 1;
            mal_promise_counter_set(counter, remaining);
            if (remaining == 0) {
                mal_vm_call_value(vm, ctx.cap_resolve, mal_value_new_undefined(), &values, 1);
                // Call(resolve) abrupt → IfAbruptRejectPromise.
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
                    goto done;
                }
            }
            ret = ctx.result_promise;
            goto done;
        }

        MalValue next_promise;
        if (!mal_promise_resolve_element(vm, &ctx, this_value, next_value, &next_promise)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }

        mal_promise_array_create_data(values, index, mal_value_new_undefined());
        mal_promise_counter_set(counter, mal_promise_counter_get(vm, counter) + 1);

        MalValue element_slots[5] = {mal_value_new_boolean(false), mal_value_from_i32(index), values, counter, ctx.cap_resolve};
        MalValue on_fulfilled = mal_promise_new_closure(vm, mal_promise_all_element, element_slots, 5, 1);

        if (!mal_promise_invoke_then(vm, next_promise, on_fulfilled, ctx.cap_reject, discard_safe)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        index++;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&vc_span);
    mal_gc_unroot(&ctx_span);
    return ret;
}

static MalValue mal_promise_race(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    MalPromiseCombinator ctx = mal_promise_combinator_begin(vm, this_value, args, arg_count);
    if (!ctx.ok) {
        return ctx.result_promise;
    }
    bool discard_safe = this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];

    // ctx (caps + iterator record) is held across the step / promiseResolve / .then
    // re-entry; root its 6 contiguous MalValues and lift GC suppression.
    MalRootSpan ctx_span;
    mal_gc_root(&ctx_span, &ctx.result_promise, 6);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = ctx.result_promise;

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &ctx.iterator, &next_value, &done)) {
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        if (done) {
            ret = ctx.result_promise;
            goto done;
        }

        MalValue next_promise;
        if (!mal_promise_resolve_element(vm, &ctx, this_value, next_value, &next_promise)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }

        // First settlement of any element wins; capability ignores the rest.
        if (!mal_promise_invoke_then(vm, next_promise, ctx.cap_resolve, ctx.cap_reject, discard_safe)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&ctx_span);
    return ret;
}

/** Build a {status, value|reason} record for allSettled. */
static MalValue mal_promise_settled_record(MalVm *vm, const byte *status, const byte *field, MalValue value) {
    MalString *shape_keys[2] = {
        mal_intrinsic_ascii(vm, "status"),
        mal_intrinsic_ascii(vm, field),
    };
    MalValue shape_values[2] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, status)),
        value,
    };
    MalRootSpan span;
    mal_gc_root(&span, shape_values, 2);
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, shape_keys, 2);
    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *object = mal_object_new_shaped(
        &vm->heap, prototype, shape, shape_values, 2);
    mal_gc_unroot(&span);
    return mal_value_from_object(object);
}

static void mal_promise_settled_finish(MalVm *vm, MalNativeFunctionObject *self, MalValue record) {
    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_INDEX));
    MalValue values = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_VALUES);
    MalValue counter = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_COUNTER);
    MalValue cap_resolve = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_RESOLVE);

    mal_promise_array_create_data(values, index, record);
    i32 remaining = mal_promise_counter_get(vm, counter) - 1;
    mal_promise_counter_set(counter, remaining);
    if (remaining == 0) {
        mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &values, 1);
    }
}

static MalValue mal_promise_settled_fulfill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_promise_flag_test_set(vm, mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    MalValue record = mal_promise_settled_record(vm, "fulfilled", "value", arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_promise_settled_finish(vm, self, record);
    return mal_value_new_undefined();
}

static MalValue mal_promise_settled_reject(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_promise_flag_test_set(vm, mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    MalValue record = mal_promise_settled_record(vm, "rejected", "reason", arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_promise_settled_finish(vm, self, record);
    return mal_value_new_undefined();
}

static MalValue mal_promise_all_settled(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    MalPromiseCombinator ctx = mal_promise_combinator_begin(vm, this_value, args, arg_count);
    if (!ctx.ok) {
        return ctx.result_promise;
    }
    bool discard_safe = this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];

    MalValue values = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue counter = mal_promise_counter_new(vm, 1);
    i32 index = 0;

    MalValue vc[2] = {values, counter};
    MalRootSpan ctx_span, vc_span;
    mal_gc_root(&ctx_span, &ctx.result_promise, 6);
    mal_gc_root(&vc_span, vc, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = ctx.result_promise;

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &ctx.iterator, &next_value, &done)) {
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        if (done) {
            i32 remaining = mal_promise_counter_get(vm, counter) - 1;
            mal_promise_counter_set(counter, remaining);
            if (remaining == 0) {
                mal_vm_call_value(vm, ctx.cap_resolve, mal_value_new_undefined(), &values, 1);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
                    goto done;
                }
            }
            ret = ctx.result_promise;
            goto done;
        }

        MalValue next_promise;
        if (!mal_promise_resolve_element(vm, &ctx, this_value, next_value, &next_promise)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }

        mal_promise_array_create_data(values, index, mal_value_new_undefined());
        mal_promise_counter_set(counter, mal_promise_counter_get(vm, counter) + 1);

        // Fulfill and reject element closures share one already-called cell.
        MalValue flag = mal_promise_flag_new(vm);
        MalValue element_slots[5] = {flag, mal_value_from_i32(index), values, counter, ctx.cap_resolve};
        MalValue on_fulfilled = mal_promise_new_closure(vm, mal_promise_settled_fulfill, element_slots, 5, 1);
        MalValue on_rejected = mal_promise_new_closure(vm, mal_promise_settled_reject, element_slots, 5, 1);

        if (!mal_promise_invoke_then(vm, next_promise, on_fulfilled, on_rejected, discard_safe)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        index++;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&vc_span);
    mal_gc_unroot(&ctx_span);
    return ret;
}

// --- any ---------------------------------------------------------------------

// Reuses the element-slot layout, with the RESOLVE slot holding cap.reject and
// the VALUES slot holding the collected errors.
static MalValue mal_promise_any_reject_element(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG, mal_value_new_boolean(true));

    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_INDEX));
    MalValue errors = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_VALUES);
    MalValue counter = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_COUNTER);
    MalValue cap_reject = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_RESOLVE);

    mal_promise_array_create_data(errors, index, arg_count >= 1 ? args[0] : mal_value_new_undefined());

    i32 remaining = mal_promise_counter_get(vm, counter) - 1;
    mal_promise_counter_set(counter, remaining);
    if (remaining == 0) {
        // Every input promise rejected: reject with an AggregateError of reasons.
        MalValue aggregate = mal_builtin_new_aggregate_error(vm, errors);
        mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &aggregate, 1);
    }
    return mal_value_new_undefined();
}

static MalValue mal_promise_any(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    MalPromiseCombinator ctx = mal_promise_combinator_begin(vm, this_value, args, arg_count);
    if (!ctx.ok) {
        return ctx.result_promise;
    }

    MalValue errors = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue counter = mal_promise_counter_new(vm, 1);
    i32 index = 0;

    MalValue ec[2] = {errors, counter};
    MalRootSpan ctx_span, ec_span;
    mal_gc_root(&ctx_span, &ctx.result_promise, 6);
    mal_gc_root(&ec_span, ec, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = ctx.result_promise;

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &ctx.iterator, &next_value, &done)) {
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        if (done) {
            i32 remaining = mal_promise_counter_get(vm, counter) - 1;
            mal_promise_counter_set(counter, remaining);
            if (remaining == 0) {
                MalValue aggregate = mal_builtin_new_aggregate_error(vm, errors);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
                    goto done;
                }
                mal_vm_call_value(vm, ctx.cap_reject, mal_value_new_undefined(), &aggregate, 1);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
                    goto done;
                }
            }
            ret = ctx.result_promise;
            goto done;
        }

        MalValue next_promise;
        if (!mal_promise_resolve_element(vm, &ctx, this_value, next_value, &next_promise)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }

        mal_promise_array_create_data(errors, index, mal_value_new_undefined());
        mal_promise_counter_set(counter, mal_promise_counter_get(vm, counter) + 1);

        MalValue element_slots[5] = {mal_value_new_boolean(false), mal_value_from_i32(index), errors, counter, ctx.cap_reject};
        MalValue on_rejected = mal_promise_new_closure(vm, mal_promise_any_reject_element, element_slots, 5, 1);

        // First fulfillment wins (cap.resolve directly); rejections collect.
        if (!mal_promise_invoke_then(vm, next_promise, ctx.cap_resolve, on_rejected, false)) {
            mal_vm_iterator_close(vm, &ctx.iterator);
            ret = mal_promise_reject_abrupt(vm, ctx.cap_reject, ctx.result_promise);
            goto done;
        }
        index++;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&ec_span);
    mal_gc_unroot(&ctx_span);
    return ret;
}

// --- finally -----------------------------------------------------------------

enum {
    MAL_PROMISE_FINALLY_SLOT_ON_FINALLY = 0,
    MAL_PROMISE_FINALLY_SLOT_CONSTRUCTOR = 1,
};

/** PromiseResolve(C, value) via Invoke C.resolve. */
static bool mal_promise_resolve_through(MalVm *vm, MalValue constructor, MalValue value, MalValue *out) {
    MalValue resolve_fn;
    if (!mal_vm_get_property(vm, constructor, mal_intrinsic_string_key(vm, "resolve"), &resolve_fn)) {
        return false;
    }
    MalCompletion completion = mal_vm_call_value(vm, resolve_fn, constructor, &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    *out = completion.value;
    return true;
}

/** Thunk returning its single captured value, ignoring its argument. */
static MalValue mal_promise_finally_value_thunk(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
}

/** Thunk throwing its single captured value. */
static MalValue mal_promise_finally_thrower(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0)};
    return mal_value_new_undefined();
}

/** Shared body for thenFinally/catchFinally: run onFinally, wrap result, chain a passthrough/rethrow thunk. */
static MalValue mal_promise_finally_react(MalVm *vm, MalValue callee, MalValue passed, bool is_catch) {
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue on_finally = mal_native_function_object_get_slot(self, MAL_PROMISE_FINALLY_SLOT_ON_FINALLY);
    MalValue constructor = mal_native_function_object_get_slot(self, MAL_PROMISE_FINALLY_SLOT_CONSTRUCTOR);

    MalCompletion result = mal_vm_call_value(vm, on_finally, mal_value_new_undefined(), nullptr, 0);
    if (result.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined(); // propagates as the chained promise's rejection
    }

    MalValue inner;
    if (!mal_promise_resolve_through(vm, constructor, result.value, &inner)) {
        return mal_value_new_undefined();
    }

    // Chain a thunk that restores the original value (or rethrows the reason).
    MalValue thunk_slots[1] = {passed};
    MalValue thunk = mal_promise_new_closure(
        vm,
        is_catch ? mal_promise_finally_thrower : mal_promise_finally_value_thunk,
        thunk_slots,
        1,
        0
    );

    MalValue then_fn;
    if (!mal_vm_get_property(vm, inner, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_THEN), &then_fn)) {
        return mal_value_new_undefined();
    }
    MalCompletion completion = mal_promise_call_captured_then(
        vm, then_fn, inner, &thunk, 1);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

static MalValue mal_promise_then_finally(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    return mal_promise_finally_react(vm, callee, arg_count >= 1 ? args[0] : mal_value_new_undefined(), false);
}

static MalValue mal_promise_catch_finally(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    return mal_promise_finally_react(vm, callee, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue mal_promise_prototype_finally(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.prototype.finally called on non-object");
        return mal_value_new_undefined();
    }

    MalValue constructor = mal_promise_species_constructor(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalValue on_finally = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue then_finally;
    MalValue catch_finally;
    if (!mal_value_is_callable(on_finally)) {
        then_finally = on_finally;
        catch_finally = on_finally;
    } else {
        MalValue slots[2] = {on_finally, constructor};
        then_finally = mal_promise_new_closure(vm, mal_promise_then_finally, slots, 2, 1);
        catch_finally = mal_promise_new_closure(vm, mal_promise_catch_finally, slots, 2, 1);
    }

    MalValue then_fn;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_THEN), &then_fn)) {
        return mal_value_new_undefined();
    }
    MalValue then_args[2] = {then_finally, catch_finally};
    MalCompletion completion = mal_promise_call_captured_then(
        vm, then_fn, this_value, then_args, 2);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

// --- withResolvers / try -----------------------------------------------------

static MalValue mal_promise_with_resolvers(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.withResolvers called on non-object");
        return mal_value_new_undefined();
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, this_value, &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    MalString *shape_keys[3] = {
        mal_intrinsic_ascii(vm, "promise"),
        mal_intrinsic_ascii(vm, "resolve"),
        mal_intrinsic_ascii(vm, "reject"),
    };
    MalValue shape_values[3] = {cap_promise, cap_resolve, cap_reject};
    MalRootSpan span;
    mal_gc_root(&span, shape_values, 3);
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, shape_keys, 3);
    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *result = mal_object_new_shaped(
        &vm->heap, prototype, shape, shape_values, 3);
    mal_gc_unroot(&span);
    return mal_value_from_object(result);
}

static MalValue mal_promise_try(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.try called on non-object");
        return mal_value_new_undefined();
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, this_value, &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    const MalValue *call_args = arg_count > 1 ? &args[1] : nullptr;
    i32 call_arg_count = arg_count > 1 ? arg_count - 1 : 0;
    MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), call_args, call_arg_count);

    if (result.kind == MAL_COMPLETION_THROW) {
        MalValue error = result.value;
        vm->completion = mal_promise_normal();
        mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &error, 1);
    } else {
        mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &result.value, 1);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return cap_promise;
}

// --- allKeyed / allSettledKeyed (await-dictionary proposal) ------------------

// The keyed element closures reuse the all/allSettled slot layout plus a KEYS
// slot holding the parallel array of (string/symbol) property keys.
enum { MAL_PROMISE_KEYED_SLOT_KEYS = 5 };

/** CreateKeyedPromiseCombinatorResultObject: a null-prototype object mapping
 * each collected key to its settled value via CreateDataPropertyOrThrow. */
static MalValue mal_promise_create_keyed_result(MalVm *vm, MalValue keys, MalValue values) {
    MalObject *result = mal_object_new(&vm->heap, nullptr);
    u32 count = mal_array_object_length(mal_value_to_array_object(keys));
    for (u32 i = 0; i < count; i++) {
        MalValue key_value;
        MalValue value;
        mal_builtin_array_try_get(vm, keys, i, &key_value);
        mal_builtin_array_try_get(vm, values, i, &value);
        MalKey key;
        mal_vm_value_to_property_key(vm, key_value, &key);
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(result, key, &desc);
    }
    return mal_value_from_object(result);
}

/** Shared tail for a keyed element settle: store into values[index], decrement
 * the remaining counter, and resolve with the keyed result object at zero. */
static void mal_promise_keyed_finish(MalVm *vm, MalNativeFunctionObject *self, MalValue record) {
    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_INDEX));
    MalValue values = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_VALUES);
    MalValue counter = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_COUNTER);
    MalValue cap_resolve = mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_RESOLVE);
    MalValue keys = mal_native_function_object_get_slot(self, MAL_PROMISE_KEYED_SLOT_KEYS);

    mal_promise_array_create_data(values, index, record);
    i32 remaining = mal_promise_counter_get(vm, counter) - 1;
    mal_promise_counter_set(counter, remaining);
    if (remaining == 0) {
        MalValue result = mal_promise_create_keyed_result(vm, keys, values);
        mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &result, 1);
    }
}

static MalValue mal_promise_keyed_all_element(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG, mal_value_new_boolean(true));
    mal_promise_keyed_finish(vm, self, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_promise_keyed_settled_fulfill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_promise_flag_test_set(vm, mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    MalValue record = mal_promise_settled_record(vm, "fulfilled", "value", arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_promise_keyed_finish(vm, self, record);
    return mal_value_new_undefined();
}

static MalValue mal_promise_keyed_settled_reject(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    if (mal_promise_flag_test_set(vm, mal_native_function_object_get_slot(self, MAL_PROMISE_ELEMENT_SLOT_FLAG))) {
        return mal_value_new_undefined();
    }
    MalValue record = mal_promise_settled_record(vm, "rejected", "reason", arg_count >= 1 ? args[0] : mal_value_new_undefined());
    mal_promise_keyed_finish(vm, self, record);
    return mal_value_new_undefined();
}

/** Collect [[OwnPropertyKeys]] of `promises` into a rooted MalKey snapshot
 * (proxy-aware). Returns false with a pending throw on an abrupt completion. */
static bool mal_promise_keyed_own_keys(
    MalVm *vm, MalValue promises, MalRootedKeySnapshot *keys
) {
    if (mal_value_is_proxy_object(promises)) {
        MalValue keys_array;
        if (!mal_proxy_own_property_keys(vm, mal_value_to_proxy_object(promises), &keys_array)) {
            return false;
        }
        u32 length = mal_array_object_length(mal_value_to_array_object(keys_array));
        for (u32 i = 0; i < length; i++) {
            MalValue key_value;
            mal_builtin_array_try_get(vm, keys_array, i, &key_value);
            MalKey key;
            mal_vm_value_to_property_key(vm, key_value, &key);
            mal_rooted_key_snapshot_append(keys, key);
        }
        return true;
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(promises), MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        mal_rooted_key_snapshot_append(keys, key);
    }
    return true;
}

/** [[GetOwnProperty]](promises, key) -> present + enumerable (proxy-aware). */
static bool mal_promise_keyed_enumerable(MalVm *vm, MalValue promises, MalKey key, bool *present, bool *enumerable) {
    if (mal_value_is_proxy_object(promises)) {
        MalPropertyDesc desc;
        if (!mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(promises), key, present, &desc)) {
            return false;
        }
        *enumerable = *present && (desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
        return true;
    }
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(promises), key);
    *present = lookup.present;
    *enumerable = lookup.present && (lookup.desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
    return true;
}

/** Promise.allKeyed / Promise.allSettledKeyed shared body. */
static MalValue mal_promise_all_keyed_impl(MalVm *vm, bool settled, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise combinator called on non-object");
        return mal_value_new_undefined();
    }

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, this_value, &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }
    bool discard_safe = this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];

    MalValue promise_resolve;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "resolve"), &promise_resolve)) {
        return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
    }
    if (!mal_value_is_callable(promise_resolve)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.resolve is not callable");
        return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
    }
    bool direct_resolve =
        this_value == vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR] &&
        mal_value_is_native_function_object(promise_resolve) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(promise_resolve)) ==
            mal_promise_resolve_static;
#if MAL_REALMS
    direct_resolve = direct_resolve &&
        mal_vm_callee_realm(vm, promise_resolve) == vm->current_realm;
#endif

    MalValue promises = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(promises)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Promise.allKeyed argument is not an object");
        return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
    }

    MalRootedKeySnapshot own_keys;
    mal_rooted_key_snapshot_init(&own_keys);
    if (!mal_promise_keyed_own_keys(vm, promises, &own_keys)) {
        mal_rooted_key_snapshot_dispose(&own_keys);
        return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
    }

    MalValue values = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue keys = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue counter = mal_promise_counter_new(vm, 1);
    i32 index = 0;

    for (usize i = 0; i < own_keys.count; i++) {
        MalKey key = own_keys.keys[i];
        bool present;
        bool enumerable;
        if (!mal_promise_keyed_enumerable(vm, promises, key, &present, &enumerable)) {
            mal_rooted_key_snapshot_dispose(&own_keys);
            return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
        }
        if (!enumerable) {
            continue;
        }

        MalValue next_value;
        if (!mal_vm_get_property(vm, promises, key, &next_value)) {
            mal_rooted_key_snapshot_dispose(&own_keys);
            return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
        }

        // Record the key as a value (an integer index becomes its string form).
        MalValue key_value = key.kind == MAL_KEY_INDEX
            ? mal_value_from_string(mal_ops_to_string(&vm->heap, key.value))
            : key.value;
        mal_promise_array_create_data(keys, index, key_value);
        mal_promise_array_create_data(values, index, mal_value_new_undefined());

        MalValue resolved_value;
        if (direct_resolve) {
            resolved_value = mal_promise_resolve_static(
                vm,
                this_value,
                &next_value,
                1,
                mal_value_new_undefined(),
                promise_resolve);
        } else {
            MalCompletion resolved = mal_vm_call_value(
                vm, promise_resolve, this_value, &next_value, 1);
            resolved_value = resolved.value;
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_rooted_key_snapshot_dispose(&own_keys);
            return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
        }

        mal_promise_counter_set(counter, mal_promise_counter_get(vm, counter) + 1);

        MalValue flag = settled ? mal_promise_flag_new(vm) : mal_value_new_boolean(false);
        MalValue element_slots[6] = {flag, mal_value_from_i32(index), values, counter, cap_resolve, keys};
        bool ok;
        if (settled) {
            MalValue on_fulfilled = mal_promise_new_closure(vm, mal_promise_keyed_settled_fulfill, element_slots, 6, 1);
            MalValue on_rejected = mal_promise_new_closure(vm, mal_promise_keyed_settled_reject, element_slots, 6, 1);
            ok = mal_promise_invoke_then(vm, resolved_value, on_fulfilled, on_rejected, discard_safe);
        } else {
            MalValue on_fulfilled = mal_promise_new_closure(vm, mal_promise_keyed_all_element, element_slots, 6, 1);
            ok = mal_promise_invoke_then(vm, resolved_value, on_fulfilled, cap_reject, discard_safe);
        }
        if (!ok) {
            mal_rooted_key_snapshot_dispose(&own_keys);
            return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
        }
        index++;
    }
    mal_rooted_key_snapshot_dispose(&own_keys);

    i32 remaining = mal_promise_counter_get(vm, counter) - 1;
    mal_promise_counter_set(counter, remaining);
    if (remaining == 0) {
        MalValue result = mal_promise_create_keyed_result(vm, keys, values);
        mal_vm_call_value(vm, cap_resolve, mal_value_new_undefined(), &result, 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_promise_reject_abrupt(vm, cap_reject, cap_promise);
        }
    }
    return cap_promise;
}

static MalValue mal_promise_all_keyed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_promise_all_keyed_impl(vm, false, this_value, args, arg_count);
}

static MalValue mal_promise_all_settled_keyed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_promise_all_keyed_impl(vm, true, this_value, args, arg_count);
}

// --- Install -----------------------------------------------------------------

void mal_builtin_promise_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_promise_function_prototype(vm),
        mal_intrinsic_ascii(vm, "Promise"),
        1,
        mal_promise_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Promise")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method_n(vm, prototype, "then", 2, mal_promise_prototype_then);
    mal_intrinsic_define_method_n(vm, prototype, "catch", 1, mal_promise_prototype_catch);
    mal_intrinsic_define_method_n(vm, prototype, "finally", 1, mal_promise_prototype_finally);

    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "resolve", 1, mal_promise_resolve_static);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "reject", 1, mal_promise_reject_static);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "all", 1, mal_promise_all);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "race", 1, mal_promise_race);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "allSettled", 1, mal_promise_all_settled);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "allKeyed", 1, mal_promise_all_keyed);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "allSettledKeyed", 1, mal_promise_all_settled_keyed);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "any", 1, mal_promise_any);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "withResolvers", 0, mal_promise_with_resolvers);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "try", 1, mal_promise_try);
    mal_intrinsic_define_species(vm, (MalObject *) constructor);
}
