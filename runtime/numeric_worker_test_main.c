#include "vm.h"
#include "gc.h"
#include "intrinsics.h"
#include "vm_ops.h"
#include "ascii.h"
#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

static i32 spin_function_index = -1;
static bool saw_spin_poll;

static void terminate_at_spin_poll(MalVm *vm) {
    // SpinCaller has one nested compiled call; stripped images retain depth, not frame rows.
    bool spinning = vm->native_call_depth >= 2;
    if (vm->runtime_image->file_count > 0) {
        spinning = vm->native_frame_count > 0 &&
            vm->native_frames[vm->native_frame_count - 1].function_index == spin_function_index;
    }
    if (spinning) {
        saw_spin_poll = true;
        mal_gc_preempt_hook = nullptr;
        mal_gc_request_termination(mal_gc_current_termination_target(), mal_gc_current_poll_target());
    } else {
        mal_gc_request_safepoint(mal_gc_current_poll_target());
    }
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;
    MalValue callback = MAL_VALUE_UNDEFINED;
    MalRootSpan root;
    mal_gc_root(&root, &callback, 1);
    MalKey key = mal_key_from_value(mal_value_from_string(
        mal_intrinsic_ascii(&vm, "numericWorkerSpinCaller")));
    if (!mal_vm_get_property(&vm, vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS], key, &callback))
        return 2;
    for (i32 index = 0; index < vm.runtime_image->function_count; index++) {
        i32 name = vm.runtime_image->functions[index].name_string_index;
        if (name >= 0 && mal_string_equals_ascii(&vm.runtime_image->string_constants[name], "numericWorkerSpin"))
            spin_function_index = index;
    }
    if (spin_function_index < 0) return 3;
    mal_gc_preempt_hook = terminate_at_spin_poll;
    mal_gc_request_safepoint(mal_gc_current_poll_target());
    MalCompletion completion = mal_vm_call_value(
        &vm, callback, MAL_VALUE_UNDEFINED, nullptr, 0);
    if (!saw_spin_poll || completion.kind != MAL_COMPLETION_THROW || vm.native_call_depth != 0 || vm.native_frame_count != 0)
        return 4;
    mal_gc_unroot(&root);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    puts("numeric-worker-termination PASS");
    return 0;
}
