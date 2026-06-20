#include "builtin_weak_ref.h"

#include "heap.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

/** Allocate a WeakRef wrapping target (held weakly until the next collection). */
static MalWeakRefObject *mal_weak_ref_object_new(MalHeap *heap, MalObject *prototype, MalValue target) {
    MalWeakRefObject *ref = mal_heap_alloc(heap, sizeof(MalWeakRefObject), MAL_HEAP_WEAK_REF_OBJECT);
    mal_object_init(heap, &ref->object, MAL_HEAP_WEAK_REF_OBJECT, prototype);
    ref->target = target;
    return ref;
}

/** A WeakRef/FinalizationRegistry may only target a value that can be held
 * weakly: an object, or an unregistered (non-Symbol.for) symbol. */
static bool mal_can_be_held_weakly(MalValue value) {
    if (mal_value_is_object(value)) {
        return true;
    }
    return mal_value_is_symbol(value) && !mal_value_to_symbol(value)->registered;
}

static MalObject *mal_weak_ref_resolve_prototype(MalVm *vm, MalValue new_target) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_WEAK_REF_PROTOTYPE]);
}

static MalValue mal_builtin_weak_ref_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) callee;

    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor WeakRef requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_can_be_held_weakly(target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WeakRef: target must be an object or an unregistered symbol");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_weak_ref_resolve_prototype(vm, new_target);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    // AddToKeptObjects: a freshly constructed WeakRef must not see its target die
    // before the current turn ends.
    mal_vm_add_kept_object(vm, target);
    return mal_value_from_weak_ref_object(mal_weak_ref_object_new(&vm->heap, prototype, target));
}

static MalValue mal_builtin_weak_ref_prototype_deref(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    if (!mal_value_is_weak_ref_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WeakRef.prototype.deref called on incompatible receiver");
        return mal_value_new_undefined();
    }
    // The collector sets target to undefined once it has been reclaimed. A live
    // target is kept for the rest of the turn so repeated derefs stay consistent.
    MalValue target = mal_value_to_weak_ref_object(this_value)->target;
    if (!mal_value_is_undefined(target)) {
        mal_vm_add_kept_object(vm, target);
    }
    return target;
}

void mal_builtin_weak_ref_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "WeakRef"),
        1,
        mal_builtin_weak_ref_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_WEAK_REF_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype",
        vm->intrinsics[MAL_INTRINSIC_WEAK_REF_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor",
        vm->intrinsics[MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "WeakRef")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method_n(vm, prototype, "deref", 0, mal_builtin_weak_ref_prototype_deref);
}
