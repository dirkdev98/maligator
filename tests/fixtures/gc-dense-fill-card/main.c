#include <stdio.h>

#include "array_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static MalObject *fill_target;
static MalObject *build_target;
static u32 fill_finalized;
static u32 build_finalized;

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) fill_target) fill_finalized++;
    if ((void *) cell == (void *) build_target) build_finalized++;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    MalArrayObject *filled = mal_array_object_new(&vm.heap, nullptr);
    MalArrayObject *built = mal_array_object_new(&vm.heap, nullptr);
    MalValue roots[] = {
        mal_value_from_array_object(filled),
        mal_value_from_array_object(built),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
    for (u32 i = 0; i < 128; ++i) {
        if (!mal_array_object_fresh_dense_append(filled, mal_value_from_i32((i32) i))) return 1;
    }
    mal_gc_collect(&vm);
    if (!mal_heap_mark_is_old(filled->object.header.mark) ||
        !mal_heap_mark_is_old(built->object.header.mark)) return 2;

    fill_target = mal_object_new(&vm.heap, nullptr);
    build_target = mal_object_new(&vm.heap, nullptr);
    mal_array_object_dense_fill(filled, 0, 0, mal_value_from_object(fill_target));
    if (!mal_array_object_dense_build_fill(built, 0, 0,
            mal_value_from_object(build_target)) ||
        filled->object.header.dirty || built->object.header.dirty) return 3;
    mal_array_object_dense_fill(filled, 0, 128, mal_value_from_object(fill_target));
    if (!mal_array_object_dense_build_fill(built, 0, 128,
            mal_value_from_object(build_target)) ||
        !filled->object.header.dirty || !built->object.header.dirty) return 3;

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (fill_finalized != 0 || build_finalized != 0 ||
        filled->elements[0] != mal_value_from_object(fill_target) ||
        filled->elements[127] != mal_value_from_object(fill_target) ||
        built->elements[0] != mal_value_from_object(build_target) ||
        built->elements[127] != mal_value_from_object(build_target)) return 4;

    mal_gc_unroot(&span);
    mal_gc_collect(&vm);
    if (fill_finalized != 1 || build_finalized != 1) return 5;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-dense-fill-card PASS");
    return 0;
}
