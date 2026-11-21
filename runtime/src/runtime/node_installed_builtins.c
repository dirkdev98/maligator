#include "node_module.h"

#if MAL_NODE

#include <string.h>
#include "heap_string.h"

/*
 * A module this isolate installed, named by its `node:` id or the bare spelling Node
 * also accepts. Node loads its newer modules only by their `node:` id; the compiler's
 * NODE_PREFIX_ONLY_BUILTIN_IDS names the same ones.
 */
static MalValue node_installed_builtin(MalVm *vm, MalString *name) {
    char id[64] = "node:";
    char *spelled = id + 5;
    usize length = mal_string_length(name);
    if (length >= sizeof(id) - 5) return mal_value_new_undefined();
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < length; i++) {
        if (units[i] == 0 || units[i] > 0x7f) return mal_value_new_undefined();
        spelled[i] = (char) units[i];
    }
    spelled[length] = '\0';
    if (strncmp(spelled, "node:", 5) == 0) return mal_node_module_get_cached(vm, spelled);
    if (strcmp(spelled, "sea") == 0 || strcmp(spelled, "sqlite") == 0
        || strcmp(spelled, "test") == 0 || strncmp(spelled, "test/", 5) == 0)
        return mal_value_new_undefined();
    return mal_node_module_get_cached(vm, id);
}

void mal_host_install_node_installed_builtins(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    // The full loader answers every name this lookup does; install order must not matter.
    if (vm->node_builtin_loader == nullptr) vm->node_builtin_loader = node_installed_builtin;
}

#endif
