#include "module_namespace_object.h"

#include "intrinsics.h"
#include "promise_object.h"
#include "vm.h"

void mal_module_namespace_object_init(
    MalHeap *heap,
    MalModuleNamespaceObject *ns,
    MalModuleNamespaceExport *exports,
    i32 export_count
) {
    // Null [[Prototype]] and non-extensible remain the baseline; deferred
    // namespaces layer evaluation triggers ahead of the ordinary rejection.
    mal_object_init(heap, &ns->object, MAL_HEAP_MODULE_NAMESPACE_OBJECT, nullptr);
    ns->object.extensible = false;
    ns->exports = exports;
    ns->export_count = export_count;
    ns->init_fn = mal_value_new_undefined();
    ns->status_slot = -1;
    ns->error_slot = -1;
    ns->deferred = false;
}

MalModuleNamespaceObject *mal_module_namespace_object_new(
    MalHeap *heap,
    MalModuleNamespaceExport *exports,
    i32 export_count
) {
    MalModuleNamespaceObject *ns = mal_heap_alloc(
        heap,
        sizeof(MalModuleNamespaceObject),
        MAL_HEAP_MODULE_NAMESPACE_OBJECT
    );
    mal_module_namespace_object_init(heap, ns, exports, export_count);
    return ns;
}

void mal_module_namespace_configure_deferred(
    MalModuleNamespaceObject *ns,
    MalValue init_fn,
    i32 status_slot,
    i32 error_slot
) {
    ns->init_fn = init_fn;
    ns->status_slot = status_slot;
    ns->error_slot = error_slot;
    ns->deferred = true;
}

bool mal_module_evaluate_sync(
    MalVm *vm,
    MalValue init_fn,
    i32 status_slot,
    i32 error_slot,
    bool throw_on_evaluating
) {
    if (status_slot < 0) return true;

    MalValue status = vm->globals[status_slot];
    if (mal_value_is_boolean(status) && mal_value_to_boolean(status)) return true;
    if (mal_value_is_int32(status)) {
        i32 state = mal_value_to_i32(status);
        if (state == 2) return true;
        if (state == 3) {
            vm->completion = (MalCompletion) {
                .kind = MAL_COMPLETION_THROW,
                .value = vm->globals[error_slot],
            };
            return false;
        }
        if (state == 1) {
            if (!throw_on_evaluating) return true;
            mal_vm_throw_error(
                vm,
                MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Cannot synchronously re-enter module evaluation"
            );
            return false;
        }
    }
    if (!mal_value_is_callable(init_fn)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Module is not ready for synchronous evaluation"
        );
        return false;
    }

    vm->globals[status_slot] = mal_value_from_i32(1);
    MalCompletion completion = mal_vm_call_value(
        vm, init_fn, mal_value_new_undefined(), nullptr, 0);
    if (completion.kind == MAL_COMPLETION_NORMAL &&
        !mal_value_is_promise_object(completion.value)) {
        vm->globals[status_slot] = mal_value_from_i32(2);
        return true;
    }
    if (completion.kind == MAL_COMPLETION_NORMAL) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Asynchronous module cannot be evaluated synchronously"
        );
        completion = vm->completion;
    } else {
        vm->completion = completion;
    }
    vm->globals[error_slot] = completion.value;
    vm->globals[status_slot] = mal_value_from_i32(3);
    return false;
}

bool mal_module_namespace_ensure_evaluated(
    MalVm *vm,
    MalModuleNamespaceObject *ns
) {
    return !ns->deferred || mal_module_evaluate_sync(
        vm, ns->init_fn, ns->status_slot, ns->error_slot, true);
}
