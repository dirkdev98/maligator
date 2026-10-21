#include "vm.h"
#include "gc.h"
#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

__attribute__((noinline)) static bool rejects_large_caller_frame(MalVm *vm) {
    volatile byte locals[32 * 1024];
    for (usize i = 0; i < sizeof(locals); i++) locals[i] = (byte) i;
    uptr saved_limit = vm->stack_limit;
    vm->stack_limit = (uptr) &locals[sizeof(locals) / 2];
    mal_vm_sync_entry_stack_limit(vm);
    i32 rows = vm->native_frame_count;
    bool leaf = mal_vm_leaf_stack_available(vm);
    bool entered = mal_vm_enter_compiled(vm, 0);
    bool rejected = !leaf && !entered && vm->completion.kind == MAL_COMPLETION_THROW &&
        vm->native_frame_count == rows;
    vm->stack_limit = saved_limit;
    mal_vm_sync_entry_stack_limit(vm);
    vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };
    return rejected && locals[0] == 0;
}

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
        if (vm.native_frame_count != rows + 1) return 3;
        if (!mal_vm_leaf_stack_available(&vm)) return 4;
        mal_vm_leave_compiled(&vm);
        if (vm.native_frame_count != rows) return 5;
        uptr limit = vm.stack_limit;
        vm.stack_limit = (uptr) -1;
        if (mal_vm_leaf_stack_available(&vm)) return 6;
        vm.stack_limit = limit;
        if (!rejects_large_caller_frame(&vm)) return 7;
    }
    vm.live_runtime_image.file_count = image.file_count;
    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    puts("checked-leaf-entry PASS");
    return 0;
}
