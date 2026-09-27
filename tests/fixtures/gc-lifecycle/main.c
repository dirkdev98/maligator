#include <stdio.h>
#include <sched.h>
#include <time.h>

#include "gc.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    for (int i = 0; i < 2; i++) {
        MalVm vm;
        mal_vm_init(&vm, &mal_runtime_image);
        MalCallable *callable = mal_vm_create_callable(&vm, 0);
        mal_vm_run(&vm, callable);
        if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;
        mal_vm_free_callable(callable);
        mal_gc_collect(&vm);
        if (mal_gc_marking_active) return 1;
        vm.heap.next_gc_at = 1;
        mal_gc_poll = true;
        mal_gc_safepoint(&vm);
        if (!mal_gc_marking_active) return 2;
        if (i == 1) {
            time_t deadline = time(nullptr) + 30;
            while (mal_gc_marking_active && time(nullptr) < deadline) {
                mal_gc_safepoint(&vm);
                sched_yield();
            }
            if (mal_gc_marking_active || !vm.heap.sweeping) return 4;
        }
        mal_vm_free(&vm);
        if (mal_gc_marking_active || mal_gc_black_alloc || mal_gc_poll) return 3;
    }
    puts("gc-lifecycle PASS");
    return 0;
}
