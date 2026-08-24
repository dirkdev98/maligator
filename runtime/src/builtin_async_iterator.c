#include "builtin_async_iterator.h"

#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

// AsyncFromSyncIterator is implemented without a wrapper object: the record's
// next is a native closure over the sync iterator that does the
// AsyncFromSyncIteratorContinuation dance (await the value, repackage).
enum {
    MAL_AFS_NEXT_SLOT_SYNC_ITERATOR = 0,
    MAL_AFS_NEXT_SLOT_SYNC_NEXT = 1,
};
enum {
    MAL_AFS_UNWRAP_SLOT_DONE = 0,
};
enum {
    MAL_AFS_CLOSE_SLOT_SYNC_ITERATOR = 0,
};

static MalCompletion mal_afs_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

typedef struct {
    MalValue promise;
    MalValue resolve;
    MalValue reject;
    MalRootSpan roots;
} MalAfsCapability;

static bool mal_afs_capability(MalVm *vm, MalAfsCapability *capability) {
    mal_promise_new_direct_capability(
        vm,
        &capability->promise,
        &capability->resolve,
        &capability->reject);
    mal_gc_root(&capability->roots, &capability->promise, 3);
    return true;
}

static MalValue mal_afs_finish(MalAfsCapability *capability, MalValue result) {
    mal_gc_unroot(&capability->roots);
    return result;
}

/** onFulfilled for the awaited value: repackage as { value, done }. */
static MalValue mal_async_from_sync_unwrap(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    bool done = mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_AFS_UNWRAP_SLOT_DONE));
    return mal_vm_create_iter_result(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), done);
}

/** Reject a fresh capability with the pending throw and return its promise. */
static MalValue mal_afs_reject_pending(MalVm *vm, MalValue cap_promise, MalValue cap_reject) {
    MalValue error = vm->completion.value;
    vm->completion = mal_afs_normal();
    mal_promise_settle_direct(vm, cap_promise, cap_reject, true, error);
    vm->completion = mal_afs_normal();
    return cap_promise;
}

/** A rejected yielded value closes the underlying sync iterator, preserving it. */
static MalValue mal_async_from_sync_close_rejected(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalIteratorRecord record = {
        .iterator = mal_native_function_object_get_slot(self, MAL_AFS_CLOSE_SLOT_SYNC_ITERATOR),
        .next_method = mal_value_new_undefined(),
    };
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = arg_count >= 1 ? args[0] : mal_value_new_undefined(),
    };
    mal_vm_iterator_close(vm, &record);
    return mal_value_new_undefined();
}

static MalValue mal_async_from_sync_continuation(
    MalVm *vm,
    MalValue result,
    MalValue sync_iterator,
    bool close_on_rejection,
    MalValue cap_promise,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    MalValue roots[5] = {
        result,
        sync_iterator,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);

    if (!mal_value_is_object(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
        MalValue rejected = mal_afs_reject_pending(vm, cap_promise, cap_reject);
        mal_gc_unroot(&span);
        return rejected;
    }

    MalValue done_value;
    MalValue value_value;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_DONE), &done_value) ||
        !mal_vm_get_property(vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_VALUE), &value_value)) {
        MalValue rejected = mal_afs_reject_pending(vm, cap_promise, cap_reject);
        mal_gc_unroot(&span);
        return rejected;
    }
    bool done = mal_value_is_truthy(done_value);

    if (!mal_promise_resolve_value(vm, value_value, &roots[2])) {
        if (!done && close_on_rejection) {
            MalIteratorRecord record = {.iterator = roots[1], .next_method = mal_value_new_undefined()};
            mal_vm_iterator_close(vm, &record);
        }
        MalValue rejected = mal_afs_reject_pending(vm, cap_promise, cap_reject);
        mal_gc_unroot(&span);
        return rejected;
    }

    MalValue unwrap_slots[1] = {mal_value_new_boolean(done)};
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr,
        mal_async_from_sync_unwrap,
        unwrap_slots,
        1
    ));

    if (!done && close_on_rejection) {
        MalValue close_slots[1] = {roots[1]};
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr,
            mal_async_from_sync_close_rejected,
            close_slots,
            1
        ));
    }
    mal_promise_perform_then(vm, roots[2], roots[3], roots[4], cap_resolve, cap_reject);
    mal_gc_unroot(&span);
    return cap_promise;
}

/** AsyncFromSyncIterator next: run the sync step, await its value, repackage. */
static MalValue mal_async_from_sync_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue sync_iterator = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_ITERATOR);
    MalValue sync_next = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_NEXT);

    MalAfsCapability capability;
    if (!mal_afs_capability(vm, &capability)) {
        return mal_value_new_undefined();
    }

    // Forward the received value to the sync iterator's next: spec
    // %AsyncFromSyncIteratorPrototype%.next(value) does IteratorNext with the
    // value present, so `next` is invoked with the value as its sole argument
    // (when absent it is invoked with none). `args` points into the rooted
    // caller arg array, so it stays alive across the call.
    MalCompletion step = arg_count >= 1
        ? mal_vm_call_value(vm, sync_next, sync_iterator, args, 1)
        : mal_vm_call_value(vm, sync_next, sync_iterator, nullptr, 0);
    if (step.kind == MAL_COMPLETION_THROW) {
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    MalValue result = mal_async_from_sync_continuation(
        vm,
        step.value,
        sync_iterator,
        true,
        capability.promise,
        capability.resolve,
        capability.reject);
    return mal_afs_finish(&capability, result);
}

static MalValue mal_async_from_sync_return(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalAfsCapability capability;
    if (!mal_afs_capability(vm, &capability)) return mal_value_new_undefined();

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue iterator = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_ITERATOR);
    MalValue return_method;
    if (!mal_vm_get_property(vm, iterator, mal_intrinsic_string_key(vm, "return"), &return_method)) {
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    if (mal_value_is_nil(return_method)) {
        MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
        MalValue result = mal_vm_create_iter_result(vm, value, true);
        MalValue continued = mal_async_from_sync_continuation(
            vm,
            result,
            iterator,
            false,
            capability.promise,
            capability.resolve,
            capability.reject);
        return mal_afs_finish(&capability, continued);
    }
    if (!mal_value_is_callable(return_method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator return is not a function");
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    MalCompletion completion = arg_count >= 1
        ? mal_vm_call_value(vm, return_method, iterator, args, 1)
        : mal_vm_call_value(vm, return_method, iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    MalValue continued = mal_async_from_sync_continuation(
        vm,
        completion.value,
        iterator,
        false,
        capability.promise,
        capability.resolve,
        capability.reject);
    return mal_afs_finish(&capability, continued);
}

static MalValue mal_async_from_sync_throw(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalAfsCapability capability;
    if (!mal_afs_capability(vm, &capability)) return mal_value_new_undefined();

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue iterator = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_ITERATOR);
    MalValue throw_method;
    if (!mal_vm_get_property(vm, iterator, mal_intrinsic_string_key(vm, "throw"), &throw_method)) {
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    if (mal_value_is_nil(throw_method)) {
        MalIteratorRecord record = {.iterator = iterator, .next_method = mal_value_new_undefined()};
        if (!mal_vm_iterator_close_normal(vm, &record)) {
            MalValue rejected = mal_afs_reject_pending(
                vm, capability.promise, capability.reject);
            return mal_afs_finish(&capability, rejected);
        }
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The iterator does not provide a 'throw' method");
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    if (!mal_value_is_callable(throw_method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator throw is not a function");
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    MalCompletion completion = arg_count >= 1
        ? mal_vm_call_value(vm, throw_method, iterator, args, 1)
        : mal_vm_call_value(vm, throw_method, iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        MalValue rejected = mal_afs_reject_pending(
            vm, capability.promise, capability.reject);
        return mal_afs_finish(&capability, rejected);
    }
    MalValue continued = mal_async_from_sync_continuation(
        vm,
        completion.value,
        iterator,
        true,
        capability.promise,
        capability.resolve,
        capability.reject);
    return mal_afs_finish(&capability, continued);
}

// Wrap an already-acquired sync iterator record with promise-returning
// next/return/throw methods. The closures retain the underlying sync record.
static void mal_async_from_sync_wrap(MalVm *vm, const MalIteratorRecord *sync_record, MalIteratorRecord *record_out) {
    MalValue roots[6] = {
        sync_record->iterator,
        sync_record->next_method,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 6);
    roots[2] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    MalValue slots[2] = {roots[0], roots[1]};
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr,
        mal_async_from_sync_next,
        slots,
        2
    ));
    roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr, mal_async_from_sync_return, slots, 2));
    roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr, mal_async_from_sync_throw, slots, 2));
    MalObject *wrapper = mal_value_to_object(roots[2]);
    mal_object_set(wrapper, mal_intrinsic_string_key(vm, "next"), roots[3]);
    mal_object_set(wrapper, mal_intrinsic_string_key(vm, "return"), roots[4]);
    mal_object_set(wrapper, mal_intrinsic_string_key(vm, "throw"), roots[5]);
    record_out->iterator = roots[2];
    record_out->next_method = roots[3];
    mal_gc_unroot(&span);
}

bool mal_vm_async_iterator_from_method(
    MalVm *vm,
    MalValue value,
    MalValue method,
    bool method_is_async,
    MalIteratorRecord *record_out
) {
    MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }
    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            method_is_async ? "Async iterator is not an object" : "Iterator is not an object");
        return false;
    }
    MalValue next;
    if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT), &next)) {
        return false;
    }
    if (method_is_async) {
        record_out->iterator = completion.value;
        record_out->next_method = next;
        return true;
    }

    MalIteratorRecord sync_record = {.iterator = completion.value, .next_method = next};
    mal_async_from_sync_wrap(vm, &sync_record, record_out);
    return true;
}

bool mal_vm_get_async_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out) {
    MalValue method;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &method)) {
        return false;
    }

    if (mal_value_is_callable(method)) {
        return mal_vm_async_iterator_from_method(vm, value, method, true, record_out);
    }

    // GetMethod: a @@asyncIterator that is present but not callable is a TypeError
    // — do NOT fall back to @@iterator (the sync method is never even looked up).
    if (!mal_value_is_nil(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.asyncIterator is not a function");
        return false;
    }

    // Undefined/null @@asyncIterator: wrap the sync iterator (async-from-sync).
    MalIteratorRecord sync_record;
    if (!mal_vm_get_iterator(vm, value, &sync_record)) {
        return false;
    }
    mal_async_from_sync_wrap(vm, &sync_record, record_out);
    return true;
}
