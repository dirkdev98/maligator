#include "vm.h"

#include "gc.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

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

    // Probe is the fixture's first nested function. Exercise the helper directly
    // so the same checks cover compiled and interpreter-only target definitions.
    MalValue callee = mal_vm_op_create_function(&vm, 1, nullptr);
    if (!result_is_object(mal_vm_construct_direct(
            &vm, 1, callee, nullptr, 0))) {
        return 2;
    }

    // FallbackProbe is the fixture's second nested function. A wrong expected
    // index must guard-miss into unchanged generic construction.
    MalValue fallback_callee = mal_vm_op_create_function(&vm, 2, nullptr);
    if (!result_is_object(mal_vm_construct_direct(
            &vm, 1, fallback_callee, nullptr, 0))) {
        return 3;
    }

    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return 0;
}
