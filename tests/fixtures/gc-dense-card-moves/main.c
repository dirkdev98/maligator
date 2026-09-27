#include <stdio.h>

#include "array_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static MalObject *targets[6];
static u32 finalized[6];

static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(targets); i++) {
        if ((void *) cell == (void *) targets[i]) finalized[i]++;
    }
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    MalArrayObject *arrays[4];
    MalValue roots[4];
    for (usize i = 0; i < countof(arrays); i++) {
        arrays[i] = mal_array_object_new(&vm.heap, nullptr);
        roots[i] = mal_value_from_array_object(arrays[i]);
        for (u32 index = 0; index < 4; index++) {
            if (!mal_array_object_fresh_dense_append(
                arrays[i], mal_value_from_i32((i32) index))) return 1;
        }
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
    mal_gc_collect(&vm);
    for (usize i = 0; i < countof(arrays); i++) {
        if (!mal_heap_mark_is_old(arrays[i]->object.header.mark)) return 2;
    }
    if (arrays[2]->object.header.dirty || arrays[3]->object.header.dirty) return 2;
    for (usize i = 0; i < countof(targets); i++) {
        targets[i] = mal_object_new(&vm.heap, nullptr);
    }

    mal_array_object_dense_fill(arrays[0], 1, 2, mal_value_from_object(targets[0]));
    mal_array_object_dense_shift(arrays[0]);
    mal_array_object_dense_fill(arrays[1], 1, 2, mal_value_from_object(targets[1]));
    mal_array_object_dense_copy_within(arrays[1], 0, 1, 2);
    MalValue unshifted[] = {
        mal_value_from_i32(99),
        mal_value_from_object(targets[2]),
        mal_value_from_object(targets[3]),
    };
    if (!mal_array_object_dense_unshift_many(arrays[2], unshifted, countof(unshifted))) return 3;
    MalValue spliced[] = {
        mal_value_from_i32(99),
        mal_value_from_object(targets[4]),
        mal_value_from_object(targets[5]),
    };
    if (!mal_array_object_dense_splice(arrays[3], 1, 1, spliced, countof(spliced)) ||
        !mal_array_object_dense_splice(arrays[3], 5, 1, nullptr, 0)) return 4;
    MalArrayObject *owners[] = {
        arrays[0], arrays[1], arrays[2], arrays[2], arrays[3], arrays[3],
    };
    const u32 positions[] = {0, 0, 1, 2, 2, 3};
    for (usize i = 0; i < countof(targets); i++) {
        if (owners[i]->elements[positions[i]] != mal_value_from_object(targets[i])) return 5;
    }

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    for (usize i = 0; i < countof(targets); i++) {
        if (finalized[i] != 0 ||
            owners[i]->elements[positions[i]] != mal_value_from_object(targets[i])) return 6;
    }

    mal_gc_unroot(&span);
    mal_gc_collect(&vm);
    for (usize i = 0; i < countof(targets); i++) {
        if (finalized[i] != 1) return 7;
    }
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-dense-card-moves PASS");
    return 0;
}
