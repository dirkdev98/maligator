#include "builtin_async_iterator.h"

#include "builtin_promise.h"
#include "function_object.h"
#include "intrinsics.h"
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

static MalCompletion mal_afs_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
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
    mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &error, 1);
    vm->completion = mal_afs_normal();
    return cap_promise;
}

/** AsyncFromSyncIterator next: run the sync step, await its value, repackage. */
static MalValue mal_async_from_sync_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) args;
    (void) arg_count;

    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue sync_iterator = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_ITERATOR);
    MalValue sync_next = mal_native_function_object_get_slot(self, MAL_AFS_NEXT_SLOT_SYNC_NEXT);

    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    MalCompletion step = mal_vm_call_value(vm, sync_next, sync_iterator, nullptr, 0);
    if (step.kind == MAL_COMPLETION_THROW) {
        return mal_afs_reject_pending(vm, cap_promise, cap_reject);
    }
    if (!mal_value_is_object(step.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
        return mal_afs_reject_pending(vm, cap_promise, cap_reject);
    }

    MalValue done_value;
    MalValue value_value;
    if (!mal_vm_get_property(vm, step.value, mal_intrinsic_string_key(vm, "done"), &done_value) ||
        !mal_vm_get_property(vm, step.value, mal_intrinsic_string_key(vm, "value"), &value_value)) {
        return mal_afs_reject_pending(vm, cap_promise, cap_reject);
    }
    bool done = mal_value_is_truthy(done_value);

    // Promise.resolve(value).then(v => { value: v, done })
    MalValue value_promise;
    if (!mal_promise_resolve_value(vm, value_value, &value_promise)) {
        return mal_afs_reject_pending(vm, cap_promise, cap_reject);
    }

    MalValue unwrap_slots[1] = {mal_value_new_boolean(done)};
    MalValue on_fulfilled = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr,
        mal_async_from_sync_unwrap,
        unwrap_slots,
        1
    ));
    mal_promise_perform_then(vm, value_promise, on_fulfilled, mal_value_new_undefined(), cap_resolve, cap_reject);
    return cap_promise;
}

bool mal_vm_get_async_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out) {
    MalValue method;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &method)) {
        return false;
    }

    if (mal_value_is_callable(method)) {
        MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
        if (!mal_value_is_object(completion.value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Async iterator is not an object");
            return false;
        }
        MalValue next;
        if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_string_key(vm, "next"), &next)) {
            return false;
        }
        record_out->iterator = completion.value;
        record_out->next_method = next;
        return true;
    }

    // No @@asyncIterator: wrap the sync iterator. The record's iterator is the
    // sync one (so IteratorClose calls its return), and next is a closure that
    // awaits each value before repackaging.
    MalIteratorRecord sync_record;
    if (!mal_vm_get_iterator(vm, value, &sync_record)) {
        return false;
    }
    MalValue slots[2] = {sync_record.iterator, sync_record.next_method};
    MalValue wrapped_next = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        nullptr,
        mal_async_from_sync_next,
        slots,
        2
    ));
    record_out->iterator = sync_record.iterator;
    record_out->next_method = wrapped_next;
    return true;
}
