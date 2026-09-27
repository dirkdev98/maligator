#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "gc.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static usize no_workers(void) {
    return 0;
}

int main(int argc, char **argv) {
    u32 count = 0;
    if (argc == 2 && strcmp(argv[1], "small") == 0) count = 8192;
    if (argc == 2 && strcmp(argv[1], "large") == 0) count = 262144;
    if (count == 0) return 1;

    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_gc_worker_limit(&vm) != 0) return 2;
    MalArrayObject *array = mal_array_object_new(&vm.heap, nullptr);
    MalValue root = mal_value_from_array_object(array);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    if (!mal_array_object_fresh_dense_reserve_exact(array, count)) return 3;
    for (u32 i = 0; i < count; ++i) {
        mal_array_object_fresh_dense_append_reserved(array, mal_value_from_i32((i32) i));
    }

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 4;
    for (u32 step = 0; step < 100000 && mal_gc_black_alloc; ++step) {
        mal_gc_safepoint(&vm);
    }
    if (mal_gc_black_alloc) return 5;
    MalValue first;
    MalValue last;
    if (!mal_array_object_dense_get(array, 0, &first) || first != mal_value_from_i32(0) ||
        !mal_array_object_dense_get(array, count - 1, &last) ||
        last != mal_value_from_i32((i32) count - 1)) return 6;

    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-mark-step-scaling PASS");
    return 0;
}
