#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define SLOT_COUNT 8192

int main(int argc, char **argv) {
    bool dense = argc == 2 && strcmp(argv[1], "dense") == 0;
    if (argc != 2 || (!dense && strcmp(argv[1], "sparse") != 0)) return 1;

    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalArrayObject *array = mal_array_object_new(&vm.heap, nullptr);
    MalValue root = mal_value_from_array_object(array);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    for (u32 i = 0; i < SLOT_COUNT; ++i) {
        if (!mal_array_object_fresh_dense_append(array, mal_value_from_i32((i32) i))) return 2;
    }
    mal_gc_collect(&vm);

    for (u32 i = 0; i < (dense ? SLOT_COUNT : 1); ++i) {
        MalObject *target = mal_object_new(&vm.heap, nullptr);
        mal_array_object_dense_fill(array, i, i + 1, mal_value_from_object(target));
    }
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    for (u32 i = 0; i < (dense ? SLOT_COUNT : 1); ++i) {
        MalValue value;
        if (!mal_array_object_dense_get(array, i, &value) ||
            !mal_value_is_heap(value) ||
            !mal_heap_mark_is_old(mal_value_to_heap(value)->mark)) return 3;
    }

    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    puts("gc-remembered-scan PASS");
    return 0;
}
