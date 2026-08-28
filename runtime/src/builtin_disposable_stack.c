#include "builtin_disposable_stack.h"

#include <stdlib.h>

#include "builtin_error.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"
#include "vm.h"
#include "vm_ops.h"

#define MAL_DISPOSABLE_ADOPT_SLOT_VALUE 0
#define MAL_DISPOSABLE_ADOPT_SLOT_CALLBACK 1

static MalDisposableStackObject *mal_disposable_stack_new(
    MalVm *vm, MalObject *prototype, bool async
) {
    MalDisposableStackObject *stack = mal_heap_alloc(
        &vm->heap,
        sizeof(MalDisposableStackObject),
        MAL_HEAP_DISPOSABLE_STACK_OBJECT
    );
    mal_object_init(
        &vm->heap, &stack->object, MAL_HEAP_DISPOSABLE_STACK_OBJECT, prototype);
    stack->resources = nullptr;
    stack->resource_count = 0;
    stack->resource_capacity = 0;
    stack->disposed = false;
    stack->async = async;
    return stack;
}

static bool mal_value_is_disposable_stack(MalValue value, bool async) {
    return mal_value_is_heap_type(value, MAL_HEAP_DISPOSABLE_STACK_OBJECT) &&
        ((MalDisposableStackObject *) mal_value_to_heap(value))->async == async;
}

static MalDisposableStackObject *mal_disposable_stack_require(
    MalVm *vm, MalValue value, bool async
) {
    if (!mal_value_is_disposable_stack(value, async)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            async
                ? "Receiver is not an AsyncDisposableStack"
                : "Receiver is not a DisposableStack"
        );
        return nullptr;
    }
    return (MalDisposableStackObject *) mal_value_to_heap(value);
}

static void mal_disposable_stack_trace(MalHeapHeader *cell) {
    MalDisposableStackObject *stack = (MalDisposableStackObject *) cell;
    for (usize i = 0; i < stack->resource_count; i++) {
        mal_gc_mark_value(stack->resources[i].resource_value);
        mal_gc_mark_value(stack->resources[i].dispose_method);
    }
}

static void mal_disposable_stack_finalize(MalHeapHeader *cell) {
    MalDisposableStackObject *stack = (MalDisposableStackObject *) cell;
    if (stack->resources != nullptr) {
        gc_free_raw(mal_gc_current_heap(), stack->resources);
        stack->resources = nullptr;
        stack->resource_count = 0;
        stack->resource_capacity = 0;
    }
}

static void mal_disposable_stack_append(
    MalVm *vm,
    MalDisposableStackObject *stack,
    MalValue resource_value,
    MalDisposeKind kind,
    MalValue dispose_method
) {
    if (stack->resource_count == stack->resource_capacity) {
        usize capacity = stack->resource_capacity == 0
            ? 4
            : stack->resource_capacity * 2;
        if (capacity < stack->resource_capacity ||
            capacity > SIZE_MAX / sizeof(MalDisposableResource)) {
            abort();
        }
        stack->resources = gc_realloc_raw(
            &vm->heap,
            stack->resources,
            capacity * sizeof(MalDisposableResource)
        );
        stack->resource_capacity = capacity;
    }

    stack->resources[stack->resource_count++] = (MalDisposableResource) {
        .resource_value = resource_value,
        .dispose_method = dispose_method,
        .kind = kind,
    };
    mal_gc_card(&stack->object.header, resource_value);
    mal_gc_card(&stack->object.header, dispose_method);
}

static bool mal_disposable_stack_add_value(
    MalVm *vm,
    MalDisposableStackObject *stack,
    MalValue value,
    MalDisposeKind kind
) {
    if (mal_value_is_nil(value)) return true;
    if (!mal_value_is_object(value)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Disposable resource is not an object"
        );
        return false;
    }
    if (kind != MAL_DISPOSE_SYNC) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Async disposal is not available in this context"
        );
        return false;
    }

    MalValue method;
    if (!mal_vm_get_property(
            vm,
            value,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_DISPOSE),
            &method)) {
        return false;
    }
    if (!mal_value_is_callable(method)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Symbol.dispose method is not callable"
        );
        return false;
    }

    mal_disposable_stack_append(vm, stack, value, kind, method);
    return true;
}

static MalValue mal_disposable_stack_adopt_closure(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalNativeFunctionObject *function =
        mal_value_to_native_function_object(callee);
    MalValue value = mal_native_function_object_get_slot(
        function, MAL_DISPOSABLE_ADOPT_SLOT_VALUE);
    MalValue callback = mal_native_function_object_get_slot(
        function, MAL_DISPOSABLE_ADOPT_SLOT_CALLBACK);
    MalCompletion completion = mal_vm_call_value(
        vm, callback, mal_value_new_undefined(), &value, 1);
    return completion.kind == MAL_COMPLETION_NORMAL
        ? mal_value_new_undefined()
        : completion.value;
}

static MalValue mal_builtin_disposable_stack_constructor(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor DisposableStack requires 'new'"
        );
        return mal_value_new_undefined();
    }

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm,
            new_target,
            MAL_INTRINSIC_DISPOSABLE_STACK_PROTOTYPE,
            &prototype)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_object(
        &mal_disposable_stack_new(vm, prototype, false)->object);
}

static MalValue mal_builtin_disposable_stack_disposed(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    return stack == nullptr
        ? mal_value_new_undefined()
        : mal_value_new_boolean(stack->disposed);
}

static bool mal_disposable_stack_require_pending(
    MalVm *vm, MalDisposableStackObject *stack
) {
    if (!stack->disposed) return true;
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, "DisposableStack is disposed");
    return false;
}

static MalValue mal_builtin_disposable_stack_use(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    if (stack == nullptr || !mal_disposable_stack_require_pending(vm, stack)) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    return mal_disposable_stack_add_value(vm, stack, value, MAL_DISPOSE_SYNC)
        ? value
        : mal_value_new_undefined();
}

static MalValue mal_builtin_disposable_stack_adopt(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    if (stack == nullptr || !mal_disposable_stack_require_pending(vm, stack)) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue callback = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "onDispose is not callable"
        );
        return mal_value_new_undefined();
    }

    MalValue slots[2] = {value, callback};
    MalNativeFunctionObject *closure =
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""),
            mal_disposable_stack_adopt_closure,
            slots,
            2
        );
    mal_disposable_stack_append(
        vm,
        stack,
        mal_value_new_undefined(),
        MAL_DISPOSE_SYNC,
        mal_value_from_native_function_object(closure)
    );
    return value;
}

static MalValue mal_builtin_disposable_stack_defer(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    if (stack == nullptr || !mal_disposable_stack_require_pending(vm, stack)) {
        return mal_value_new_undefined();
    }

    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "onDispose is not callable"
        );
        return mal_value_new_undefined();
    }
    mal_disposable_stack_append(
        vm,
        stack,
        mal_value_new_undefined(),
        MAL_DISPOSE_SYNC,
        callback
    );
    return mal_value_new_undefined();
}

static MalValue mal_builtin_disposable_stack_move(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    if (stack == nullptr || !mal_disposable_stack_require_pending(vm, stack)) {
        return mal_value_new_undefined();
    }

    MalDisposableStackObject *moved = mal_disposable_stack_new(
        vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DISPOSABLE_STACK_PROTOTYPE]),
        false
    );
    moved->resources = stack->resources;
    moved->resource_count = stack->resource_count;
    moved->resource_capacity = stack->resource_capacity;
    if (mal_gc_marking_active) {
        for (usize i = 0; i < stack->resource_count; i++) {
            mal_gc_write_barrier(stack->resources[i].resource_value);
            mal_gc_write_barrier(stack->resources[i].dispose_method);
        }
    }
    stack->resources = nullptr;
    stack->resource_count = 0;
    stack->resource_capacity = 0;
    stack->disposed = true;
    return mal_value_from_object(&moved->object);
}

static MalValue mal_disposable_stack_dispose_resources(
    MalVm *vm,
    MalValue stack_value,
    MalDisposableStackObject *stack,
    bool has_error,
    MalValue error
) {
    stack->disposed = true;

    MalValue roots[4] = {
        stack_value,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        error,
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    while (stack->resource_count > 0) {
        MalDisposableResource resource =
            stack->resources[--stack->resource_count];
        roots[1] = resource.resource_value;
        roots[2] = resource.dispose_method;
        mal_gc_write_barrier(resource.resource_value);
        mal_gc_write_barrier(resource.dispose_method);

        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        mal_gc_native_rooted_begin(vm);
        MalCompletion completion = mal_vm_call_value(
            vm, roots[2], roots[1], nullptr, 0);
        mal_gc_native_rooted_end(vm);
        if (completion.kind != MAL_COMPLETION_THROW) continue;

        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        if (!has_error) {
            roots[3] = completion.value;
            has_error = true;
        } else {
            roots[3] = mal_builtin_new_suppressed_error(
                vm, completion.value, roots[3]);
        }
    }

    if (stack->resources != nullptr) {
        gc_free_raw(&vm->heap, stack->resources);
        stack->resources = nullptr;
        stack->resource_capacity = 0;
    }

    if (has_error) {
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_THROW,
            .value = roots[3],
        };
    }
    mal_gc_unroot(&root_span);
    return mal_value_new_undefined();
}

static MalValue mal_builtin_disposable_stack_dispose(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, this_value, false);
    if (stack == nullptr || stack->disposed) return mal_value_new_undefined();
    return mal_disposable_stack_dispose_resources(
        vm, this_value, stack, false, mal_value_new_undefined());
}

static MalValue mal_builtin_new_dispose_capability(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_value_from_object(
        &mal_disposable_stack_new(
            vm,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
            false
        )->object);
}

static MalValue mal_builtin_add_disposable_resource(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue stack_value = arg_count >= 1
        ? args[0]
        : mal_value_new_undefined();
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, stack_value, false);
    if (stack == nullptr || !mal_disposable_stack_require_pending(vm, stack)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    bool async = arg_count >= 3 && mal_value_is_boolean(args[2]) &&
        mal_value_to_boolean(args[2]);
    return mal_disposable_stack_add_value(
               vm,
               stack,
               value,
               async ? MAL_DISPOSE_ASYNC : MAL_DISPOSE_SYNC)
        ? value
        : mal_value_new_undefined();
}

static MalValue mal_builtin_dispose_resources(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue stack_value = arg_count >= 1
        ? args[0]
        : mal_value_new_undefined();
    MalDisposableStackObject *stack =
        mal_disposable_stack_require(vm, stack_value, false);
    if (stack == nullptr) return mal_value_new_undefined();
    bool has_error = arg_count >= 2 && mal_value_is_boolean(args[1]) &&
        mal_value_to_boolean(args[1]);
    MalValue error = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    return mal_disposable_stack_dispose_resources(
        vm, stack_value, stack, has_error, error);
}

void mal_builtin_disposable_stack_install(MalVm *vm) {
    mal_gc_register_tracer(
        MAL_HEAP_DISPOSABLE_STACK_OBJECT, mal_disposable_stack_trace);
    mal_gc_register_finalizer(
        MAL_HEAP_DISPOSABLE_STACK_OBJECT, mal_disposable_stack_finalize);

    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    vm->intrinsics[MAL_INTRINSIC_NEW_DISPOSE_CAPABILITY] =
        mal_value_from_native_function_object(
            mal_native_function_object_new(
                &vm->heap,
                function_prototype,
                mal_intrinsic_ascii(vm, "__newDisposeCapability"),
                mal_builtin_new_dispose_capability
            ));
    vm->intrinsics[MAL_INTRINSIC_ADD_DISPOSABLE_RESOURCE] =
        mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                function_prototype,
                mal_intrinsic_ascii(vm, "__addDisposableResource"),
                3,
                mal_builtin_add_disposable_resource
            ));
    vm->intrinsics[MAL_INTRINSIC_DISPOSE_RESOURCES] =
        mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                function_prototype,
                mal_intrinsic_ascii(vm, "__disposeResources"),
                3,
                mal_builtin_dispose_resources
            ));

    MalObject *prototype = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    MalNativeFunctionObject *constructor =
        mal_native_function_object_new_arity(
            &vm->heap,
            function_prototype,
            mal_intrinsic_ascii(vm, "DisposableStack"),
            0,
            mal_builtin_disposable_stack_constructor
        );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    vm->intrinsics[MAL_INTRINSIC_DISPOSABLE_STACK_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_DISPOSABLE_STACK_PROTOTYPE] =
        mal_value_from_object(prototype);

    mal_intrinsic_define_data(
        vm,
        (MalObject *) constructor,
        "prototype",
        vm->intrinsics[MAL_INTRINSIC_DISPOSABLE_STACK_PROTOTYPE],
        MAL_PROPERTY_NONE
    );
    mal_intrinsic_define_data(
        vm,
        prototype,
        "constructor",
        vm->intrinsics[MAL_INTRINSIC_DISPOSABLE_STACK_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE
    );
    mal_intrinsic_define_getter(
        vm,
        prototype,
        "disposed",
        "get disposed",
        mal_builtin_disposable_stack_disposed,
        MAL_PROPERTY_CONFIGURABLE
    );
    MalValue dispose = mal_intrinsic_define_method(
        vm, prototype, "dispose", mal_builtin_disposable_stack_dispose);
    MalPropertyDesc dispose_symbol = mal_intrinsic_data_desc(
        dispose, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        prototype,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_DISPOSE),
        &dispose_symbol
    );
    mal_intrinsic_define_method_n(
        vm, prototype, "use", 1, mal_builtin_disposable_stack_use);
    mal_intrinsic_define_method_n(
        vm, prototype, "adopt", 2, mal_builtin_disposable_stack_adopt);
    mal_intrinsic_define_method_n(
        vm, prototype, "defer", 1, mal_builtin_disposable_stack_defer);
    mal_intrinsic_define_method(
        vm, prototype, "move", mal_builtin_disposable_stack_move);

    MalPropertyDesc tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "DisposableStack")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(
        prototype,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG),
        &tag
    );
}
