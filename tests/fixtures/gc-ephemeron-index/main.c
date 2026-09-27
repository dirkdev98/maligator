#include <stdio.h>
#include <stdlib.h>

#include "gc.h"
#include "map_object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHAIN_COUNT 512

static usize no_workers(void) {
    return 0;
}

int main(void) {
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = (usize) -1;

    MalMapObject *first = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    MalMapObject *second = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    MalObject **keys = malloc(CHAIN_COUNT * sizeof(MalObject *));
    if (keys == nullptr) abort();
    for (usize i = 0; i < CHAIN_COUNT; ++i) {
        keys[i] = mal_object_new(&vm.heap, nullptr);
    }
    for (usize i = CHAIN_COUNT - 1; i > 0; --i) {
        MalMapObject *map = (i - 1) % 2 == 0 ? first : second;
        mal_map_object_set(map, mal_value_from_object(keys[i - 1]),
            mal_value_from_object(keys[i]));
    }

    MalObject *cycle_first = mal_object_new(&vm.heap, nullptr);
    MalObject *cycle_second = mal_object_new(&vm.heap, nullptr);
    mal_map_object_set(first, mal_value_from_object(cycle_first),
        mal_value_from_object(cycle_second));
    mal_map_object_set(second, mal_value_from_object(cycle_second),
        mal_value_from_object(cycle_first));

    MalObject *sentinel = mal_object_new(&vm.heap, nullptr);
    MalObject *marker = mal_object_new(&vm.heap, nullptr);
    MalMapObject *late = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    mal_map_object_set(first, mal_value_from_object(sentinel),
        mal_value_from_object(&late->object));
    mal_map_object_set(late, mal_value_from_object(keys[0]),
        mal_value_from_object(marker));

    MalValue roots[] = {
        mal_value_from_object(&first->object),
        mal_value_from_object(&second->object),
        mal_value_from_object(keys[0]),
        mal_value_from_object(sentinel)
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(&vm);

    MalValue current = roots[2];
    for (usize i = 0; i < CHAIN_COUNT - 1; ++i) {
        MalMapObject *map = i % 2 == 0 ? first : second;
        current = mal_map_object_get(map, current);
        if (!mal_value_is_object(current)) return 1;
    }
    if (mal_value_to_object(current) != keys[CHAIN_COUNT - 1]) return 2;
    if (mal_map_object_size(first) + mal_map_object_size(second) != CHAIN_COUNT) return 3;
    MalValue late_value = mal_map_object_get(first, roots[3]);
    if (!mal_value_is_object(late_value) ||
        mal_value_to_object(late_value) != &late->object) return 4;
    if (mal_map_object_get(late, roots[2]) != mal_value_from_object(marker)) return 5;

    free(keys);
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-ephemeron-index PASS");
    return 0;
}
