#include "node_module.h"

#if MAL_NODE

#include <string.h>

#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "gc.h"
#include "heap_string.h"

MalValue mal_node_module_get_cached(MalVm *vm, const char *id) {
    MalValue registry = vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES];
    if (mal_value_is_undefined(registry)) return mal_value_new_undefined();
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(registry),
        mal_intrinsic_string_key(vm, (const byte *) id));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

/* Process exports inherit EventEmitter data properties; installation must not invoke accessors. */
static bool mal_node_module_lookup(MalObject *object, MalKey key, MalValue *out) {
    for (; object != nullptr; object = mal_object_prototype(object)) {
        MalPropertyLookup found = mal_object_get_own(object, key);
        if (found.present) {
            if ((found.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
                return false;
            }
            *out = found.desc.value;
            return true;
        }
    }
    return false;
}

void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES])) {
        vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES] = mal_value_from_object(
            mal_object_new(&vm->heap, nullptr));
    }
    mal_intrinsic_define_data(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES]),
        (const byte *) id, module, MAL_PROPERTY_NONE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalValue found;
        if (mal_node_module_lookup(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name), &found)) {
            vm->globals[slots[i].slot] = found;
        }
    }
    mal_gc_unroot(&root);
}

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count) {
    MalValue module = mal_node_module_get_cached(vm, id);
    if (mal_value_is_undefined(module)) return false;
    mal_node_module_publish(vm, id, slots, count, module);
    return true;
}


#endif
