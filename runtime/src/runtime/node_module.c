#include "node_module.h"

#if MAL_NODE

#include <string.h>

#include "intrinsics.h"
#include "object_ops.h"

void mal_node_module_publish(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
        } else {
            MalPropertyLookup found = mal_object_get_own(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name));
            if (found.present) {
                vm->globals[slots[i].slot] = found.desc.value;
            }
        }
    }
}

#endif
