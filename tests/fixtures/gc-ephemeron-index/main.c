#include <stdio.h>
#include <stdlib.h>

#include "gc.h"
#include "map_object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define FRAGMENTED_COUNT 64

static usize no_workers(void) {
    return 0;
}

int main(void) {
    usize chain_count = 512;
    const char *count_env = getenv("MAL_GC_CHAIN_COUNT");
    if (count_env != nullptr) {
        char *end;
        unsigned long parsed = strtoul(count_env, &end, 10);
        if (*end != '\0' || parsed < 2 || parsed > 4096) abort();
        chain_count = (usize) parsed;
    }
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = (usize) -1;

    MalMapObject *first = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    MalMapObject *second = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    MalObject **keys = malloc(chain_count * sizeof(MalObject *));
    if (keys == nullptr) abort();
    for (usize i = 0; i < chain_count; ++i) {
        keys[i] = mal_object_new(&vm.heap, nullptr);
    }
    for (usize i = chain_count - 1; i > 0; --i) {
        MalMapObject *map = (i - 1) % 2 == 0 ? first : second;
        mal_map_object_set(map, mal_value_from_object(keys[i - 1]),
            mal_value_from_object(keys[i]));
    }

    MalObject **fragmented = malloc(FRAGMENTED_COUNT * sizeof(MalObject *));
    if (fragmented == nullptr) abort();
    for (usize i = 0; i < FRAGMENTED_COUNT; ++i) {
        fragmented[i] = mal_object_new(&vm.heap, nullptr);
        for (usize j = 0; j < 450; ++j) mal_object_new(&vm.heap, nullptr);
    }
    for (usize i = FRAGMENTED_COUNT - 1; i > 0; --i) {
        mal_map_object_set(second, mal_value_from_object(fragmented[i - 1]),
            mal_value_from_object(fragmented[i]));
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

    MalObject *fanout_root = mal_object_new(&vm.heap, nullptr);
    MalObject *fanout_key = mal_object_new(&vm.heap, nullptr);
    MalObject *fanout_holder = mal_object_new(&vm.heap, fanout_key);
    MalObject *fanout_values[2];
    for (usize i = 0; i < countof(fanout_values); ++i) {
        fanout_values[i] = mal_object_new(&vm.heap, nullptr);
    }
    mal_map_object_set(first, mal_value_from_object(fanout_root),
        mal_value_from_object(fanout_holder));
    mal_map_object_set(first, mal_value_from_object(fanout_key),
        mal_value_from_object(fanout_values[0]));
    mal_map_object_set(second, mal_value_from_object(fanout_key),
        mal_value_from_object(fanout_values[1]));

    MalValue roots[] = {
        mal_value_from_object(&first->object),
        mal_value_from_object(&second->object),
        mal_value_from_object(keys[0]),
        mal_value_from_object(sentinel),
        mal_value_from_object(fragmented[0]),
        mal_value_from_object(fanout_root)
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(&vm);

    MalValue current = roots[2];
    for (usize i = 0; i < chain_count - 1; ++i) {
        MalMapObject *map = i % 2 == 0 ? first : second;
        current = mal_map_object_get(map, current);
        if (!mal_value_is_object(current)) return 1;
    }
    if (mal_value_to_object(current) != keys[chain_count - 1]) return 2;
    current = roots[4];
    for (usize i = 0; i < FRAGMENTED_COUNT - 1; ++i) {
        current = mal_map_object_get(second, current);
        if (!mal_value_is_object(current)) return 3;
    }
    if (mal_value_to_object(current) != fragmented[FRAGMENTED_COUNT - 1]) return 4;
    if (mal_map_object_size(first) + mal_map_object_size(second) !=
            chain_count + FRAGMENTED_COUNT + 2) return 5;
    MalValue late_value = mal_map_object_get(first, roots[3]);
    if (!mal_value_is_object(late_value) ||
        mal_value_to_object(late_value) != &late->object) return 6;
    if (mal_map_object_get(late, roots[2]) != mal_value_from_object(marker)) return 7;
    if (mal_map_object_get(first, roots[5]) != mal_value_from_object(fanout_holder) ||
        mal_object_prototype(fanout_holder) != fanout_key ||
        mal_map_object_get(first, mal_value_from_object(fanout_key)) !=
            mal_value_from_object(fanout_values[0]) ||
        mal_map_object_get(second, mal_value_from_object(fanout_key)) !=
            mal_value_from_object(fanout_values[1])) return 10;

    MalObject *young = mal_object_new(&vm.heap, nullptr);
    mal_map_object_set(late, roots[2], mal_value_from_object(young));
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (mal_map_object_get(late, roots[2]) != mal_value_from_object(young)) return 8;

    roots[2] = mal_value_new_undefined();
    roots[3] = mal_value_new_undefined();
    roots[4] = mal_value_new_undefined();
    roots[5] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (mal_map_object_size(first) != 0 || mal_map_object_size(second) != 0) return 9;

    free(keys);
    free(fragmented);
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-ephemeron-index PASS");
    return 0;
}
