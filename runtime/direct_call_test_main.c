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

static bool result_is_277(MalCompletion completion) {
    return completion.kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_int32(completion.value) &&
        mal_value_to_i32(completion.value) == 277;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;

    i32 target = fixture_function_index("directTarget");
    MalValue callee = mal_vm_op_create_function(&vm, target, nullptr);
    // The same function object is reused across calls that may collect. C locals are
    // not implicit GC roots, so keep this host-held value live for the whole probe.
    MalRootSpan callee_root;
    mal_gc_root(&callee_root, &callee, 1);
    MalValue args[] = {mal_value_from_i32(1), callee};
    if (!result_is_277(mal_vm_call_direct(
            &vm, target, callee, mal_value_new_undefined(), args, 2))) {
        return 2;
    }

    // A wrong expected index must guard-miss and preserve behavior via call_cached.
    if (!result_is_277(mal_vm_call_direct(
            &vm, 0, callee, mal_value_new_undefined(), args, 2))) {
        return 3;
    }

    // Flattened Function.prototype.call reaches the same exact target in both
    // compiled and interpreted definitions, with thisArg removed from its args.
    MalValue call_args[] = {mal_value_new_undefined(), args[0], args[1]};
    if (!result_is_277(mal_vm_call_function_call_direct(
            &vm, target,
            vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL], callee,
            call_args, 3))) {
        return 4;
    }

    mal_gc_unroot(&callee_root);
    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return 0;
}
