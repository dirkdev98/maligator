#include "node_module.h"

#include <string.h>
#include "ascii.h"
#include "heap_string.h"
#include "vm_ops.h"

/*
 * A complete module this isolate installed, named by its `node:` id or the bare spelling Node
 * also accepts. Node loads its newer modules only by their `node:` id; the compiler's
 * NODE_PREFIX_ONLY_BUILTIN_IDS names the same ones.
 */
MalValue mal_node_module_get_linked(MalVm *vm, MalString *name) {
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
    if (strncmp(spelled, "node:", 5) == 0) {
        MalValue cached = mal_node_module_get_complete(vm, spelled);
        if (!mal_value_is_undefined(cached)) return cached;
        return mal_node_module_get_source_builtin(vm, name);
    }
    if (strcmp(spelled, "sea") == 0 || strcmp(spelled, "sqlite") == 0
        || strcmp(spelled, "test") == 0 || strncmp(spelled, "test/", 5) == 0)
        return mal_value_new_undefined();
    return mal_node_module_get_complete(vm, id);
}

MalValue mal_node_module_get_source_builtin(MalVm *vm, MalString *name) {
    const MalRuntimeImage *image = vm->runtime_image;
    for (i32 i = 0; i < image->source_builtin_provider_count; i++) {
        const MalSourceBuiltinProvider provider = image->source_builtin_providers[i];
        if (!mal_string_equals_ascii(name, provider.id)) continue;
        MalValue cached = mal_node_module_get_cached(vm, provider.id);
        if (!mal_value_is_undefined(cached)) return cached;
        for (i32 entry = 0; entry < provider.import_count; entry++) {
            const MalSourceBuiltinImport *import = &provider.imports[entry];
            MalValue dependency = vm->node_builtin_loader == nullptr ? mal_value_new_undefined()
                : vm->node_builtin_loader(vm, mal_intrinsic_ascii(vm, (const byte *) import->module_id));
            if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
            if (mal_value_is_undefined(dependency)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "source builtin dependency is unavailable");
                return mal_value_new_undefined();
            }
            MalHostInstallSlot slot = {.name = import->name, .slot = import->slot};
            mal_node_module_publish(vm, import->module_id, &slot, 1, dependency);
        }
        // Function creation stamps the active realm; module state lives in that realm's globals.
        MalValue factory = mal_vm_op_create_function(vm, provider.function_index, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, &factory, 1);
        MalCompletion result = mal_vm_call_value(vm, factory, mal_value_new_undefined(), nullptr, 0);
        mal_gc_unroot(&root);
        if (result.kind == MAL_COMPLETION_THROW) {
            vm->completion = result;
            return mal_value_new_undefined();
        }
        mal_node_module_publish(vm, provider.id, nullptr, 0, result.value);
        return result.value;
    }
    return mal_value_new_undefined();
}
