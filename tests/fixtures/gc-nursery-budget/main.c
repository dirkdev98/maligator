#include <stdio.h>
#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "line %d: %s\n", __LINE__, #condition); return 1; } } while (0)

int main(void) {
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    MalValue roots[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    for (int i = 0; i < 2; i++) {
        MalObject *object = mal_heap_alloc(&vm.heap, 8 * 1024 * 1024, MAL_HEAP_OBJECT);
        mal_object_init(&vm.heap, object, MAL_HEAP_OBJECT, nullptr);
        roots[i] = mal_value_from_object(object);
        CHECK(mal_object_set(object, mal_key_index_unsigned(0), mal_value_from_i32(i)));
    }
    vm.heap.next_gc_at = 1;
    mal_gc_collect(&vm);
    usize headroom = vm.heap.next_gc_at - vm.heap.bytes_allocated;
    u64 before = vm.heap.epoch;
    for (int i = 0; i < 12; i++) {
        MalObject *temporary = mal_heap_alloc(&vm.heap, 1024 * 1024, MAL_HEAP_OBJECT);
        mal_object_init(&vm.heap, temporary, MAL_HEAP_OBJECT, nullptr);
        mal_gc_safepoint(&vm);
    }
    mal_gc_finish_pending_cycle(&vm);
    printf("nursery headroom=%zu collections=%llu\n", headroom,
        (unsigned long long) (vm.heap.epoch - before));
    vm.heap.next_gc_at = SIZE_MAX;
    mal_gc_collect(&vm);
    CHECK(vm.heap.next_gc_at == SIZE_MAX);
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return 0;
}
