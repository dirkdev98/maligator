#include "builtin_finalization_registry.h"

#include <stdlib.h>

#include "heap.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static MalFinalizationRegistryObject *mal_finalization_registry_object_new(
    MalHeap *heap, MalObject *prototype, MalValue cleanup_callback
) {
    MalFinalizationRegistryObject *reg = mal_heap_alloc(
        heap, sizeof(MalFinalizationRegistryObject), MAL_HEAP_FINALIZATION_REGISTRY_OBJECT);
    mal_object_init(heap, &reg->object, MAL_HEAP_FINALIZATION_REGISTRY_OBJECT, prototype);
    reg->cleanup_callback = cleanup_callback;
    reg->cells = nullptr;
    return reg;
}

static bool mal_can_be_held_weakly(MalValue value) {
    if (mal_value_is_object(value)) {
        return true;
    }
    return mal_value_is_symbol(value) && !mal_value_to_symbol(value)->registered;
}

static MalObject *mal_fin_reg_resolve_prototype(MalVm *vm, MalValue new_target) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE]);
}

static MalFinalizationRegistryObject *mal_fin_reg_this(MalVm *vm, MalValue this_value) {
    if (!mal_value_is_heap_type(this_value, MAL_HEAP_FINALIZATION_REGISTRY_OBJECT)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry method called on incompatible receiver");
        return nullptr;
    }
    return (MalFinalizationRegistryObject *) mal_value_to_heap(this_value);
}

static MalValue mal_builtin_fin_reg_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) callee;

    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor FinalizationRegistry requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue cleanup = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(cleanup)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry: cleanup callback must be callable");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_fin_reg_resolve_prototype(vm, new_target);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_finalization_registry_object(
        mal_finalization_registry_object_new(&vm->heap, prototype, cleanup));
}

static MalValue mal_builtin_fin_reg_register(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee
) {
    (void) new_target;
    (void) callee;

    MalFinalizationRegistryObject *reg = mal_fin_reg_this(vm, this_value);
    if (reg == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue held = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue token = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    if (!mal_can_be_held_weakly(target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry.register: target must be an object or unregistered symbol");
        return mal_value_new_undefined();
    }
    // SameValue(target, heldValue): the held value may not be the target itself.
    if (target == held) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry.register: target and held value must not be the same");
        return mal_value_new_undefined();
    }
    bool has_token = !mal_value_is_undefined(token);
    if (has_token && !mal_can_be_held_weakly(token)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry.register: unregister token must be an object or unregistered symbol");
        return mal_value_new_undefined();
    }

    MalFinRegCell *cell = malloc(sizeof(MalFinRegCell));
    cell->target = target;
    cell->held_value = held;
    cell->unregister_token = token;
    cell->has_token = has_token;
    cell->next = reg->cells;
    reg->cells = cell;
    return mal_value_new_undefined();
}

static MalValue mal_builtin_fin_reg_unregister(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee
) {
    (void) new_target;
    (void) callee;

    MalFinalizationRegistryObject *reg = mal_fin_reg_this(vm, this_value);
    if (reg == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue token = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_can_be_held_weakly(token)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "FinalizationRegistry.unregister: token must be an object or unregistered symbol");
        return mal_value_new_undefined();
    }

    bool removed = false;
    MalFinRegCell **link = &reg->cells;
    while (*link != nullptr) {
        MalFinRegCell *cell = *link;
        if (cell->has_token && cell->unregister_token == token) {
            *link = cell->next;
            free(cell);
            removed = true;
        } else {
            link = &cell->next;
        }
    }
    return mal_value_new_boolean(removed);
}

void mal_builtin_finalization_registry_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "FinalizationRegistry"),
        1,
        mal_builtin_fin_reg_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR] =
        mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "FinalizationRegistry")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method_n(vm, prototype, "register", 2, mal_builtin_fin_reg_register);
    mal_intrinsic_define_method_n(vm, prototype, "unregister", 1, mal_builtin_fin_reg_unregister);
}
