#include "node_module.h"

#if MAL_NODE

#include <string.h>

#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"

/* A named export is a plain property read of the module object, so it must see
 * inherited data properties too — `node:process` reaches its EventEmitter
 * methods that way. Walked directly rather than through mal_vm_get_property so
 * publishing stays allocation-free and cannot run JS during install. */
static bool mal_node_module_lookup(MalObject *object, MalKey key, MalValue *out) {
    for (; object != nullptr; object = object->prototype) {
        MalPropertyLookup found = mal_object_get_own(object, key);
        if (found.present) {
            if ((found.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
                return false; // no host module exports an accessor; never fake a value
            }
            *out = found.desc.value;
            return true;
        }
    }
    return false;
}

void mal_node_module_publish(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
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
}

#endif
