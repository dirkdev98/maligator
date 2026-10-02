#include <stdio.h>
#include <string.h>

#include "builtin_map.h"
#include "gc.h"
#include "heap_string.h"
#include "map_object.h"
#include "perf_stats.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "%s:%d: %s\n", __func__, __LINE__, #condition); \
        return false; \
    } \
} while (0)

static usize no_workers(void) { return 0; }

static MalValue flat(MalVm *vm, usize length) {
    char buffer[16384];
    memset(buffer, 'q', length);
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, buffer, length));
}

static MalMapObject *new_map(MalVm *vm, MalValue *root) {
    MalMapObject *map = mal_map_object_new(&vm->heap, nullptr);
    *root = mal_value_from_object(&map->object);
    return map;
}

static void set(MalVm *vm, MalValue map, MalValue key, i32 value) {
    mal_builtin_map_set_key_value(vm, map, key, mal_value_from_i32(value));
}

static MalValue get(MalVm *vm, MalValue map, MalValue key) {
    return mal_builtin_map_get_key(vm, map, key);
}

static MalHeapHeader *searched_cell;
static bool searched_cell_live;

static void find_live_cell(MalHeapHeader *cell) {
    if (cell == searched_cell && !(cell->mark & MAL_MARK_FREE)) searched_cell_live = true;
}

static bool is_live(MalVm *vm, MalValue value) {
    searched_cell = mal_value_to_heap(value);
    searched_cell_live = false;
    mal_heap_walk_cells(&vm->heap, find_live_cell);
    return searched_cell_live;
}

static bool overwritten_key_survives_snapshot(MalVm *vm) {
    MalValue roots[] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = new_map(vm, &roots[0]);
    MalValue old_key = flat(vm, 4096);
    set(vm, roots[0], old_key, 1);
    roots[1] = flat(vm, 4096);
    CHECK(roots[1] != old_key);

    // The first scheduled collection starts a major but has not traced the Map.
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(mal_gc_marking_active);
    CHECK(!mal_heap_mark_is_current(mal_value_to_heap(old_key)->mark, vm->heap.mark_color));
    set(vm, roots[0], roots[1], 2);
    roots[1] = MAL_VALUE_UNDEFINED;
    CHECK(mal_gc_finish_pending_cycle(vm));
    CHECK(is_live(vm, old_key));
    CHECK(mal_map_object_size(map) == 1);
    mal_gc_collect(vm);
    CHECK(!is_live(vm, old_key));
    roots[1] = flat(vm, 4096);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(2));
    mal_gc_unroot(&span);
    puts("Map representative SATB: replaced key survives snapshot then is reclaimed");
    return true;
}

static bool flat_representatives_and_old_keys(MalVm *vm) {
    MalValue roots[] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = new_map(vm, &roots[0]);
    roots[1] = flat(vm, 4096);
    roots[2] = flat(vm, 4096);
    CHECK(roots[1] != roots[2]);
    set(vm, roots[0], roots[1], 7);
    u32 original = mal_map_object_find_canonical(map, mal_collection_key_from_value(roots[1]).value);
    CHECK(original != 0);
    mal_perf_stats_reset();
    mal_perf_stats_enabled = true;
    CHECK(get(vm, roots[0], roots[2]) == mal_value_from_i32(7));
    set(vm, roots[0], roots[2], 9);
    CHECK(mal_map_storage_key(map->entries, original) == roots[2]);
    CHECK(mal_map_object_find_canonical(map, roots[2]) == original);
    CHECK(mal_map_object_size(map) == 1);
    CHECK(mal_perf_stats.string_memcmp_code_units == 8192);
    mal_perf_stats_reset();
    usize checksum = 0;
    for (usize i = 0; i < 1024; i++) {
        checksum += mal_value_to_i32(get(vm, roots[0], roots[2]));
        set(vm, roots[0], roots[2], 9);
        checksum += mal_value_to_i32(get(vm, roots[0], roots[2]));
    }
    CHECK(checksum == 18432);
    CHECK(mal_perf_stats.string_memcmp_code_units == 0);
    CHECK(mal_perf_stats.map_get_set_cache_hits == 3072);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(9));
    CHECK(mal_perf_stats.string_memcmp_code_units == 4096);

    // A fresh Latin-1 query can replace an equal explicitly widened old key.
    mal_string_code_units(mal_value_to_string(roots[1]));
    CHECK(!mal_value_to_string(roots[1])->latin1);
    set(vm, roots[0], roots[1], 11);
    CHECK(mal_map_storage_key(map->entries, original) == roots[2]);
    mal_map_object_clear(map);
    set(vm, roots[0], roots[1], 11);
    original = mal_map_object_find_canonical(map, mal_collection_key_from_value(roots[1]).value);
    set(vm, roots[0], roots[2], 13);
    CHECK(mal_map_storage_key(map->entries, original) == roots[2]);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(13));

    // Keep only the old Map alive when a fresh representative enters it.
    mal_gc_collect(vm);
    CHECK(mal_heap_mark_is_old(map->object.header.mark));
    roots[2] = flat(vm, 4096);
    MalValue young_key = roots[2];
    CHECK(!mal_heap_mark_is_old(mal_value_to_heap(young_key)->mark));
    set(vm, roots[0], roots[2], 17);
    roots[2] = MAL_VALUE_UNDEFINED;
    CHECK(map->object.header.dirty);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(!mal_gc_marking_active);
    CHECK(is_live(vm, young_key));
    CHECK(mal_heap_mark_is_old(mal_value_to_heap(young_key)->mark));
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(17));

    roots[1] = flat(vm, 16);
    roots[2] = flat(vm, 16);
    CHECK(roots[1] != roots[2]);
    CHECK(mal_value_to_string(roots[2])->storage == MAL_STRING_STORAGE_INLINE);
    set(vm, roots[0], roots[1], 19);
    set(vm, roots[0], roots[2], 23);
    u32 small = mal_map_object_find_canonical(map, mal_collection_key_from_value(roots[1]).value);
    CHECK(small != 0 && mal_map_storage_key(map->entries, small) == roots[2]);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(23));
    mal_gc_unroot(&span);
    puts("Map representative flat: checksum=18432 repeated_units=0 old_key_units=4096 young_key=live");
    return true;
}

static bool oversized_owned_queries_are_not_retained(MalVm *vm) {
    MalValue roots[] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = new_map(vm, &roots[0]);
    roots[1] = flat(vm, 17);
    set(vm, roots[0], roots[1], 1);
    u32 original = mal_map_object_find_canonical(map, mal_collection_key_from_value(roots[1]).value);
    mal_gc_collect(vm);
    mal_gc_collect(vm);
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    usize capacities[] = {1024, 32785};
    for (usize i = 0; i < countof(capacities); i++) {
        u8 *buffer = mal_heap_alloc_raw(&vm->heap, capacities[i]);
        memset(buffer, 'q', 17);
        CHECK(mal_heap_raw_capacity(&vm->heap, buffer) == capacities[i]);
        roots[2] = mal_value_from_string(mal_string_new_latin1_owned(&vm->heap, buffer, 17));
        CHECK(mal_value_to_string(roots[2])->storage == MAL_STRING_STORAGE_OWNED);
        set(vm, roots[0], roots[2], (i32) i + 2);
        CHECK(mal_map_storage_key(map->entries, original) == roots[1]);
        CHECK(get(vm, roots[0], roots[2]) == mal_value_from_i32((i32) i + 2));
        roots[2] = MAL_VALUE_UNDEFINED;
        mal_gc_collect(vm);
        mal_gc_collect(vm);
        CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);
    }
    printf("Map representative over-reserved: 17 units, capacities=1024,32785 raw=%zu->%zu\n",
        raw_before, mal_heap_usage(&vm->heap).raw_owned_bytes);
    mal_gc_unroot(&span);
    return true;
}

static bool query_graphs_are_not_retained(MalVm *vm) {
    MalValue roots[] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = new_map(vm, &roots[0]);
    roots[1] = flat(vm, 4096);
    set(vm, roots[0], roots[1], 1);
    u32 original = mal_map_object_find_canonical(map, mal_collection_key_from_value(roots[1]).value);
    mal_gc_collect(vm);
    mal_gc_collect(vm);
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;

    roots[2] = flat(vm, 16384);
    roots[2] = mal_value_from_string(mal_string_new_slice(
        &vm->heap, mal_value_to_string(roots[2]), 4096, 4096));
    CHECK(mal_value_to_string(roots[2])->storage == MAL_STRING_STORAGE_DEPENDENT);
    set(vm, roots[0], roots[2], 2);
    CHECK(mal_map_storage_key(map->entries, original) == roots[1]);
    CHECK(get(vm, roots[0], roots[2]) == mal_value_from_i32(2));

    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap,
        mal_value_to_string(flat(vm, 2048)), mal_value_to_string(flat(vm, 2048)), &rope));
    roots[2] = mal_value_from_string(rope);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    set(vm, roots[0], roots[2], 3);
    CHECK(mal_map_storage_key(map->entries, original) == roots[1]);
    CHECK(get(vm, roots[0], roots[2]) == mal_value_from_i32(3));

    c16 external[4096];
    for (usize i = 0; i < countof(external); i++) external[i] = 'q';
    roots[2] = mal_value_from_string(mal_string_new_external(&vm->heap, external, countof(external)));
    CHECK(mal_value_to_string(roots[2])->storage == MAL_STRING_STORAGE_EXTERNAL);
    set(vm, roots[0], roots[2], 4);
    CHECK(mal_map_storage_key(map->entries, original) == roots[1]);
    roots[2] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    mal_gc_collect(vm);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(4));
    printf("Map representative retention: raw=%zu->%zu\n", raw_before,
        mal_heap_usage(&vm->heap).raw_owned_bytes);
    mal_gc_unroot(&span);
    return true;
}

static bool collisions_growth_and_clear(MalVm *vm) {
    MalValue roots[] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = new_map(vm, &roots[0]);
    char name[64];
    mal_perf_stats_reset();
    for (i32 i = 0; i < 2048; i++) {
        int length = snprintf(name, sizeof(name), "collision-and-growth-key-%d", i);
        roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, name, (usize) length));
        set(vm, roots[0], roots[1], i);
    }
    CHECK(mal_perf_stats.hash_index_groups > 0 && mal_perf_stats.hash_index_rebuilds > 1);
    MalMapIter iter;
    mal_map_storage_pin(map->entries);
    mal_map_iter_init(&iter, map->entries);
    for (i32 i = 0; i < 2048; i++) {
        int length = snprintf(name, sizeof(name), "collision-and-growth-key-%d", i);
        roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, name, (usize) length));
        CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(i));
        set(vm, roots[0], roots[1], i + 1);
        MalValue stored;
        MalValue mapped;
        CHECK(mal_map_iter_next(&iter, &stored, &mapped));
        CHECK(stored == roots[1]);
        CHECK(mapped == mal_value_from_i32(i + 1));
    }
    mal_map_object_clear(map);
    CHECK(get(vm, roots[0], roots[1]) == MAL_VALUE_UNDEFINED);
    set(vm, roots[0], roots[1], 99);
    MalValue stored;
    MalValue mapped;
    CHECK(mal_map_iter_next(&iter, &stored, &mapped));
    CHECK(mapped == mal_value_from_i32(99));
    CHECK(!mal_map_iter_next(&iter, &stored, &mapped));
    mal_map_storage_unpin(map->entries);
    CHECK(mal_map_object_delete(map, roots[1]));
    mal_map_object_compact(map);
    CHECK(get(vm, roots[0], roots[1]) == MAL_VALUE_UNDEFINED);
    set(vm, roots[0], roots[1], 101);
    CHECK(get(vm, roots[0], roots[1]) == mal_value_from_i32(101));
    mal_gc_unroot(&span);
    puts("Map representative order: 2048 colliding/growing entries, clear and reinsert stable");
    return true;
}

int main(int argc, char **argv) {
#if !MAL_PERF_STATS
    fputs("map-string-representative requires MAL_PERF_STATS=1 at build time\n", stderr);
    return 1;
#endif
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool satb = argc == 2 && strcmp(argv[1], "satb") == 0;
    bool ok = satb ? overwritten_key_survives_snapshot(&vm) :
        flat_representatives_and_old_keys(&vm) && query_graphs_are_not_retained(&vm) &&
        oversized_owned_queries_are_not_retained(&vm) &&
        collisions_growth_and_clear(&vm);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL) ok = false;
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    if (ok) puts("map-string-representative PASS");
    return ok ? 0 : 1;
}
