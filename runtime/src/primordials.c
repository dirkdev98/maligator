#include "primordials.h"

#include <stdlib.h>

#include "builtin_object.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "rooted_collection.h"
#include "value_ops.h"
#include "vm_ops.h"

void mal_primordials_throw_mutation(MalVm *vm, const byte *operation) {
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        operation != nullptr ? operation : "Cannot mutate locked primordial");
}

void mal_primordials_throw_property_mutation(
    MalVm *vm, const byte *operation, MalKey key
) {
    if (key.kind != MAL_KEY_STRING && key.kind != MAL_KEY_INDEX) {
        mal_primordials_throw_mutation(vm, operation);
        return;
    }

    MalValue roots[4] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, operation)),
        key.kind == MAL_KEY_STRING
            ? key.value
            : mal_value_from_string(mal_ops_to_string(&vm->heap, key.value)),
        mal_value_from_string(mal_intrinsic_ascii(vm, "'")),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    roots[3] = mal_vm_add(vm, roots[0], roots[1]);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[3] = mal_vm_add(vm, roots[3], roots[2]);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error_value(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, roots[3]);
    }
    mal_gc_unroot(&span);
}

#if MAL_PRIMORDIALS_LOCKED
static void mal_primordials_lock_value(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) return;
    MalObject *object = mal_value_to_object(value);
    if (object->primordial_locked || object->primordial_locking) return;

    object->primordial_locking = true;

    MalObject *prototype = mal_object_get_prototype(object);
    if (prototype != nullptr) {
        mal_primordials_lock_value(vm, mal_value_from_object(prototype));
    }

    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    if (!mal_rooted_key_snapshot_own_keys(vm, value, &keys)) abort();
    for (usize i = 0; i < keys.count; i++) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, value, keys.keys[i], &present, &desc)) abort();
        if (!present) continue;
        if (desc.flags & MAL_PROPERTY_ACCESSOR) {
            mal_primordials_lock_value(vm, desc.getter);
            mal_primordials_lock_value(vm, desc.setter);
        } else {
            mal_primordials_lock_value(vm, desc.value);
        }
    }
    mal_rooted_key_snapshot_dispose(&keys);

    if (!mal_builtin_object_set_integrity(vm, value, true)) abort();
    object->immutable_prototype = true;
    object->primordial_locked = true;
    object->primordial_locking = false;
}

static void mal_primordials_protect_global(
    MalVm *vm, MalObject *global, const byte *name
) {
    MalKey key = mal_intrinsic_string_key(vm, name);
    MalPropertyLookup own = mal_object_get_own(global, key);
    if (!own.present) return;

    own.desc.flags &= ~(MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    own.desc.flags |= MAL_PROPERTY_PRIMORDIAL;
    if (mal_object_define_own(global, key, &own.desc) != MAL_DEFINE_OWN_APPLIED) abort();

    // globalThis itself stays extensible. Every other object-valued registered
    // binding is a root of the ECMAScript primordial graph.
    if (own.desc.value != vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]) {
        mal_primordials_lock_value(vm, own.desc.value);
    }
}

static bool mal_primordials_intrinsic_excluded(i32 slot) {
    switch (slot) {
#define MAL_PRIMORDIAL_EXCLUDED_INTRINSIC(intrinsic) case intrinsic: return true;
#include "generated/primordial_registry.inc"
        default: return false;
    }
}
#endif

void mal_primordials_lock(MalVm *vm) {
#if MAL_PRIMORDIALS_LOCKED
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
#define MAL_PRIMORDIAL_GLOBAL(name, intrinsic) \
    mal_primordials_protect_global(vm, global, (const byte *) name);
#include "generated/primordial_registry.inc"

    // The descriptor registry declares the roots; this pass also covers internal
    // intrinsic objects that are not exposed as globals. Host slots are still
    // undefined here and registry exclusions stay outside the language graph.
    for (i32 slot = 0; slot < MAL_INTRINSIC_COUNT; slot++) {
        if (mal_primordials_intrinsic_excluded(slot)) continue;
        mal_primordials_lock_value(vm, vm->intrinsics[slot]);
    }
#else
    (void) vm;
#endif
}
