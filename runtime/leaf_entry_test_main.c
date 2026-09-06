#include "vm.h"
#include "gc.h"
#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    MalRuntimeImage image = mal_runtime_image;
    MalVm vm;
    mal_vm_init(&vm, &image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;
    for (int observed = 0; observed < 2; observed++) {
        vm.live_runtime_image.file_count = observed;
        i32 rows = vm.native_frame_count;
        if (!mal_vm_enter_compiled(&vm, 0)) return 2;
        i32 parent_rows = vm.native_frame_count;
        i32 depth = vm.native_call_depth;
        if (!mal_vm_enter_leaf_checked(&vm, 0)) return 3;
        if (vm.native_call_depth != depth + 1 ||
            vm.native_frame_count != parent_rows + (mal_vm_leaf_unobserved(&vm) ? 0 : observed)) return 4;
        mal_vm_leave_leaf_checked(&vm);
        if (vm.native_call_depth != depth || vm.native_frame_count != parent_rows) return 5;
        mal_vm_leave_compiled(&vm);
        if (vm.native_frame_count != rows) return 6;
        vm.native_call_depth = MAL_NATIVE_CALL_DEPTH_LIMIT;
        if (mal_vm_enter_leaf_checked(&vm, 0) || vm.completion.kind != MAL_COMPLETION_THROW ||
            vm.native_call_depth != MAL_NATIVE_CALL_DEPTH_LIMIT) return 7;
        vm.completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };
        vm.native_call_depth = 0;
        uptr limit = vm.stack_limit;
        vm.stack_limit = (uptr) -1;
        if (mal_vm_enter_leaf_checked(&vm, 0) || vm.completion.kind != MAL_COMPLETION_THROW ||
            vm.native_call_depth != 0) return 8;
        vm.stack_limit = limit;
        vm.completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };
    }
    vm.live_runtime_image.file_count = image.file_count;
    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    puts("checked-leaf-entry PASS");
    return 0;
}
