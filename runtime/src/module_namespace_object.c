#include "module_namespace_object.h"

#include "intrinsics.h"
#include "array_object.h"
#include "builtin_promise.h"
#include "gc.h"
#include "function_object.h"
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
    ns->record_slot = -1;
    ns->context_slot = -1;
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
    i32 error_slot,
    i32 record_slot,
    i32 context_slot
) {
    ns->init_fn = init_fn;
    ns->status_slot = status_slot;
    ns->error_slot = error_slot;
    ns->record_slot = record_slot;
    ns->context_slot = context_slot;
    ns->deferred = true;
}

enum {
    MODULE_STATE, MODULE_ERROR, MODULE_BODY, MODULE_PARENTS, MODULE_PENDING,
    MODULE_ORDER, MODULE_ROOT, MODULE_INDEX, MODULE_LOW, MODULE_PROMISE,
    MODULE_STATUS_SLOT, MODULE_ERROR_SLOT, MODULE_HAS_TLA,
    MODULE_FIELD_COUNT
};
enum { CONTEXT_ORDER, CONTEXT_INDEX, CONTEXT_STACK, CONTEXT_FIELD_COUNT };
enum { MODULE_LINKED, MODULE_EVALUATING, MODULE_EVALUATED, MODULE_ERRORED, MODULE_ASYNC };

/* Private dense arrays keep evaluation metadata in the ordinary traced heap. */
static MalValue module_field(MalValue record, i32 field) {
    return mal_value_to_array_object(record)->elements[field];
}
static i32 module_number(MalValue record, i32 field) {
    return mal_value_to_i32(module_field(record, field));
}
static void module_store(MalValue record, i32 field, MalValue value) {
    mal_array_object_store(mal_value_to_array_object(record),
        mal_key_from_value(mal_value_from_i32(field)), value);
}
static void module_store_number(MalValue record, i32 field, i32 value) {
    module_store(record, field, mal_value_from_i32(value));
}
static MalValue module_array(MalVm *vm, i32 size) {
    MalValue fields[MODULE_FIELD_COUNT];
    for (i32 i = 0; i < size; i++) fields[i] = mal_value_new_undefined();
    return mal_value_from_array_object(mal_array_object_new_from_values(
        &vm->heap, nullptr, fields, (u32) size));
}
static void module_append(MalValue array, MalValue value) {
    if (!mal_array_object_fresh_dense_append(mal_value_to_array_object(array), value)) abort();
}
static bool module_contains(MalValue list, MalValue value) {
    MalArrayObject *array = mal_value_to_array_object(list);
    for (u32 i = 0; i < array->length; i++) if (array->elements[i] == value) return true;
    return false;
}
static void module_set_state(MalVm *vm, MalValue record, i32 state) {
    module_store_number(record, MODULE_STATE, state);
    vm->globals[module_number(record, MODULE_STATUS_SLOT)] =
        mal_value_from_i32(state == MODULE_ASYNC ? MODULE_EVALUATING : state);
}
static void module_complete(MalVm *vm, MalValue record) {
    module_set_state(vm, record, MODULE_EVALUATED);
    module_store_number(record, MODULE_ORDER, -1);
    mal_promise_fulfill(vm, mal_value_to_promise_object(module_field(record, MODULE_PROMISE)),
        mal_value_new_undefined());
}
static void module_reject(MalVm *vm, MalValue record, MalValue reason) {
    if (module_number(record, MODULE_STATE) == MODULE_ERRORED) return;
    module_store(record, MODULE_ERROR, reason);
    vm->globals[module_number(record, MODULE_ERROR_SLOT)] = reason;
    module_set_state(vm, record, MODULE_ERRORED);
    module_store_number(record, MODULE_ORDER, -1);
    mal_promise_reject(vm, mal_value_to_promise_object(module_field(record, MODULE_PROMISE)), reason);
    MalArrayObject *parents = mal_value_to_array_object(module_field(record, MODULE_PARENTS));
    for (u32 i = 0; i < parents->length; i++) module_reject(vm, parents->elements[i], reason);
}
static void module_gather(MalValue record, MalValue ready) {
    MalArrayObject *parents = mal_value_to_array_object(module_field(record, MODULE_PARENTS));
    for (u32 i = 0; i < parents->length; i++) {
        MalValue parent = parents->elements[i];
        if (module_number(parent, MODULE_STATE) == MODULE_ERRORED ||
            module_contains(ready, parent) ||
            module_number(module_field(parent, MODULE_ROOT), MODULE_STATE) == MODULE_ERRORED)
            continue;
        i32 pending = module_number(parent, MODULE_PENDING) - 1;
        module_store_number(parent, MODULE_PENDING, pending);
        if (pending == 0) {
            module_append(ready, parent);
            if (!mal_value_to_boolean(module_field(parent, MODULE_HAS_TLA)))
                module_gather(parent, ready);
        }
    }
}
static MalCompletion module_call_body(MalVm *vm, MalValue record) {
    MalValue body = module_field(record, MODULE_BODY);
    if (!mal_value_is_callable(body))
        return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return mal_vm_call_value(vm, body, mal_value_new_undefined(), nullptr, 0);
}
static void module_execute_async(MalVm *vm, MalValue record);
static void module_fulfilled(MalVm *vm, MalValue record) {
    if (module_number(record, MODULE_STATE) == MODULE_ERRORED) return;
    module_complete(vm, record);
    MalValue ready = module_array(vm, 0);
    MalRootSpan span;
    mal_gc_root(&span, &ready, 1);
    module_gather(record, ready);
    MalArrayObject *list = mal_value_to_array_object(ready);
    for (u32 i = 1; i < list->length; i++) {
        for (u32 j = i; j > 0 &&
             module_number(list->elements[j - 1], MODULE_ORDER) >
             module_number(list->elements[j], MODULE_ORDER); j--) {
            MalValue previous = list->elements[j - 1];
            module_store(ready, (i32) j - 1, list->elements[j]);
            module_store(ready, (i32) j, previous);
        }
    }
    for (u32 i = 0; i < list->length; i++) {
        MalValue parent = list->elements[i];
        if (module_number(parent, MODULE_STATE) == MODULE_ERRORED) continue;
        if (mal_value_to_boolean(module_field(parent, MODULE_HAS_TLA))) {
            module_execute_async(vm, parent);
        } else {
            MalCompletion completion = module_call_body(vm, parent);
            if (completion.kind == MAL_COMPLETION_NORMAL) module_complete(vm, parent);
            else module_reject(vm, parent, completion.value);
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
                .value = mal_value_new_undefined()};
        }
    }
    mal_gc_unroot(&span);
}
static MalValue module_body_settled(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[2] = {mal_native_function_object_get_slot(function, 0),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    bool rejected = mal_value_to_boolean(mal_native_function_object_get_slot(function, 1));
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    // Fulfilling a dependency can execute synchronous ancestor bodies in this callback.
    mal_gc_native_rooted_begin(vm);
    if (rejected) module_reject(vm, roots[0], roots[1]);
    else module_fulfilled(vm, roots[0]);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}
static void module_execute_async(MalVm *vm, MalValue record) {
    MalValue roots[4] = {record, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalCompletion completion = module_call_body(vm, record);
    roots[1] = completion.value;
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        module_reject(vm, record, roots[1]);
    } else if (!mal_value_is_promise_object(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Async module body did not return its evaluation promise");
        module_reject(vm, record, vm->completion.value);
    } else {
        MalValue slots[2] = {record, mal_value_new_boolean(false)};
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), module_body_settled, slots, 2));
        slots[1] = mal_value_new_boolean(true);
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), module_body_settled, slots, 2));
        /* Even an already settled TLA body resumes ancestors through its reaction job. */
        mal_promise_perform_then(vm, roots[1], roots[2], roots[3],
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined()};
    mal_gc_unroot(&span);
}

MalValue mal_module_evaluate(MalVm *vm, MalValue init_fn, i32 status_slot,
    i32 error_slot, i32 record_slot, i32 context_slot, i32 parent_slot) {
    i32 slots[4] = {status_slot, error_slot, record_slot, context_slot};
    for (i32 i = 0; i < 4; i++) {
        if (slots[i] < 0 || slots[i] >= vm->runtime_image->global_count) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Invalid module evaluation cells");
            return mal_value_new_undefined();
        }
    }
    MalValue roots[4] = {init_fn, vm->globals[record_slot], vm->globals[context_slot],
        mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    if (!mal_value_is_array_object(roots[2])) {
        roots[2] = module_array(vm, CONTEXT_FIELD_COUNT);
        vm->globals[context_slot] = roots[2];
        module_store_number(roots[2], CONTEXT_ORDER, 0);
        module_store_number(roots[2], CONTEXT_INDEX, 0);
        module_store(roots[2], CONTEXT_STACK, module_array(vm, 0));
    }
    if (!mal_value_is_array_object(roots[1])) {
        roots[1] = module_array(vm, MODULE_FIELD_COUNT);
        vm->globals[record_slot] = roots[1];
        module_store_number(roots[1], MODULE_STATE, MODULE_LINKED);
        module_store_number(roots[1], MODULE_PENDING, 0);
        module_store_number(roots[1], MODULE_ORDER, -1);
        module_store_number(roots[1], MODULE_STATUS_SLOT, status_slot);
        module_store_number(roots[1], MODULE_ERROR_SLOT, error_slot);
        module_store(roots[1], MODULE_ROOT, roots[1]);
        module_store(roots[1], MODULE_PARENTS, module_array(vm, 0));
        MalValue capability = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
        mal_value_to_promise_object(capability)->is_handled = true;
        module_store(roots[1], MODULE_PROMISE, capability);
    }
    MalValue record = roots[1];
    MalValue context = roots[2];
    MalValue stack = module_field(context, CONTEXT_STACK);
    u32 stack_start = mal_value_to_array_object(stack)->length;
    if (module_number(record, MODULE_STATE) == MODULE_LINKED) {
        module_set_state(vm, record, MODULE_EVALUATING);
        i32 index = module_number(context, CONTEXT_INDEX);
        module_store_number(context, CONTEXT_INDEX, index + 1);
        module_store_number(record, MODULE_INDEX, index);
        module_store_number(record, MODULE_LOW, index);
        module_append(stack, record);
        MalCompletion completion = mal_value_is_callable(init_fn)
            ? mal_vm_call_value(vm, init_fn, mal_value_new_undefined(), nullptr, 0)
            : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        roots[3] = completion.value;
        if (completion.kind != MAL_COMPLETION_NORMAL) goto failed;
        module_store(record, MODULE_BODY, roots[3]);
        bool has_tla = mal_value_is_function_object(roots[3]) &&
            vm->runtime_image->functions[mal_value_to_function_object(roots[3])->function_index].kind == MAL_FUNCTION_KIND_ASYNC;
        module_store(record, MODULE_HAS_TLA, mal_value_new_boolean(has_tla));
        if (has_tla || module_number(record, MODULE_PENDING) > 0) {
            i32 order = module_number(context, CONTEXT_ORDER);
            module_store_number(context, CONTEXT_ORDER, order + 1);
            module_store_number(record, MODULE_ORDER, order);
            if (module_number(record, MODULE_PENDING) == 0) {
                module_execute_async(vm, record);
                if (module_number(record, MODULE_STATE) == MODULE_ERRORED) {
                    roots[3] = module_field(record, MODULE_ERROR);
                    goto failed;
                }
            }
        } else {
            completion = module_call_body(vm, record);
            roots[3] = completion.value;
            if (completion.kind != MAL_COMPLETION_NORMAL) goto failed;
        }
        if (module_number(record, MODULE_LOW) == index) {
            MalValue member;
            do {
                mal_array_object_contained_dense_pop(mal_value_to_array_object(stack), &member);
                module_store(member, MODULE_ROOT, record);
                if (module_number(member, MODULE_ORDER) < 0) module_complete(vm, member);
                else module_set_state(vm, member, MODULE_ASYNC);
            } while (member != record);
        }
    }
    if (parent_slot >= 0) {
        if (parent_slot >= vm->runtime_image->global_count ||
            !mal_value_is_array_object(vm->globals[parent_slot])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid module parent");
            goto done;
        }
        MalValue parent = vm->globals[parent_slot];
        if (module_number(record, MODULE_STATE) == MODULE_EVALUATING) {
            i32 low = module_number(record, MODULE_LOW);
            if (low < module_number(parent, MODULE_LOW)) module_store_number(parent, MODULE_LOW, low);
        } else record = module_field(record, MODULE_ROOT);
        if (module_number(record, MODULE_STATE) == MODULE_ERRORED) {
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW,
                .value = module_field(record, MODULE_ERROR)};
        } else if (module_number(record, MODULE_ORDER) >= 0) {
            module_store_number(parent, MODULE_PENDING, module_number(parent, MODULE_PENDING) + 1);
            module_append(module_field(record, MODULE_PARENTS), parent);
        }
        roots[3] = mal_value_new_undefined();
        goto done;
    }
    record = module_field(record, MODULE_ROOT);
    roots[3] = module_field(record, MODULE_PROMISE);
    if (parent_slot <= -2) {
        if (module_number(record, MODULE_STATE) == MODULE_ERRORED)
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW,
                .value = module_field(record, MODULE_ERROR)};
        else if (module_number(record, MODULE_STATE) != MODULE_EVALUATED && parent_slot != -3)
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Module is not ready for synchronous evaluation");
        roots[3] = mal_value_new_undefined();
    }
    goto done;
failed:
    module_reject(vm, record, roots[3]);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
    if (parent_slot < 0) {
        MalArrayObject *pending = mal_value_to_array_object(stack);
        while (pending->length > stack_start) {
            MalValue member;
            mal_array_object_contained_dense_pop(pending, &member);
            module_reject(vm, member, roots[3]);
        }
        if (parent_slot == -1) {
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
                .value = mal_value_new_undefined()};
            roots[3] = module_field(record, MODULE_PROMISE);
        }
    }
done:
    MalValue result = roots[3];
    mal_gc_unroot(&span);
    return result;
}

bool mal_module_namespace_ensure_evaluated(MalVm *vm, MalModuleNamespaceObject *ns) {
    if (!ns->deferred) return true;
    mal_module_evaluate(vm, ns->init_fn, ns->status_slot, ns->error_slot,
        ns->record_slot, ns->context_slot, -2);
    return vm->completion.kind == MAL_COMPLETION_NORMAL;
}
