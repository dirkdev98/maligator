#include "vm.h"

#include <stdlib.h>
#include "ascii.h"
#include "gc.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

// Harness fixtures are wrapped as modules, so nested functions have no fixed index.
static i32 fixture_function_index(const char *name) {
    for (i32 index = 0; index < mal_runtime_image.function_count; index++) {
        i32 name_index = mal_runtime_image.functions[index].name_string_index;
        if (name_index >= 0 &&
            mal_string_equals_ascii(&mal_runtime_image.string_constants[name_index], name)) {
            return index;
        }
    }
    abort();
}

static bool result_is_object(MalCompletion completion) {
    return completion.kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_object(completion.value);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;

    // Exercise the helper directly so the same checks cover compiled and
    // interpreter-only runtime images.
    i32 probe = fixture_function_index("Probe");
    MalValue callee = mal_vm_op_create_function(&vm, probe, nullptr);
    if (!result_is_object(mal_vm_construct_direct(
            &vm, probe, callee, nullptr, 0))) {
        return 2;
    }

    // A wrong expected index must guard-miss into unchanged generic construction.
    MalValue fallback_callee =
        mal_vm_op_create_function(&vm, fixture_function_index("FallbackProbe"), nullptr);
    if (!result_is_object(mal_vm_construct_direct(
            &vm, probe, fallback_callee, nullptr, 0))) {
        return 3;
    }

    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return 0;
}
