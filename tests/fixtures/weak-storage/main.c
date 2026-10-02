#include <stdio.h>

#include "gc.h"
#include "hash_index.h"
#include "key.h"
#include "weak_collection.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "weak-storage:%d\n", __LINE__); return 1; } } while (0)

static usize no_workers(void) { return 0; }

static MalValue new_key(MalVm *vm, usize index) {
    return index % 2 == 0
        ? mal_value_from_object(mal_object_new(&vm->heap, nullptr))
        : mal_value_from_symbol(mal_symbol_new(&vm->heap, nullptr));
}

static int check_storage(MalVm *vm) {
    enum { COUNT = 64 };
    MalWeakMapObject *map = mal_weak_map_object_new(&vm->heap, nullptr);
    MalWeakSetObject *set = mal_weak_set_object_new(&vm->heap, nullptr);
    CHECK(map->entries == nullptr && set->entries == nullptr);
    CHECK(!mal_weak_map_object_has(map, MAL_VALUE_TRUE));
    CHECK(mal_weak_map_object_get(map, MAL_VALUE_NAN) == MAL_VALUE_UNDEFINED);
    CHECK(!mal_weak_map_object_delete(map, MAL_VALUE_NULL));
    CHECK(!mal_weak_set_object_has(set, mal_value_from_i32(7)));
    CHECK(!mal_weak_set_object_delete(set, MAL_VALUE_UNDEFINED));
    CHECK(map->entries == nullptr && set->entries == nullptr);
    CHECK(mal_weak_map_object_reserve(map, COUNT));
    CHECK(mal_weak_set_object_reserve(set, COUNT));
    CHECK(mal_weak_storage_allocation_bytes(map->entries) <= 96);
    CHECK(mal_weak_storage_allocation_bytes(set->entries) <= 64);
    CHECK(!mal_weak_map_object_reserve(map, SIZE_MAX));
    CHECK(!mal_weak_set_object_reserve(set, SIZE_MAX));
    MalValue roots[COUNT + 2] = {mal_value_from_object(&map->object), mal_value_from_object(&set->object)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    for (usize i = 0; i < COUNT; i++) {
        roots[i + 2] = new_key(vm, i);
        mal_weak_map_object_set(map, roots[i + 2], mal_value_from_i32((i32) i));
        mal_weak_set_object_add(set, roots[i + 2]);
        if (i == 3) {
            CHECK(mal_weak_storage_capacity(map->entries) == 4);
            CHECK(mal_weak_storage_capacity(set->entries) == 4);
        }
    }
    CHECK(mal_weak_map_object_size(map) == COUNT && mal_weak_set_object_size(set) == COUNT);
    usize initial_raw = mal_heap_usage(&vm->heap).raw_owned_bytes;
    for (usize round = 0; round < COUNT * 64; round++) {
        usize index = round % COUNT;
        CHECK(mal_weak_map_object_delete(map, roots[index + 2]));
        CHECK(mal_weak_set_object_delete(set, roots[index + 2]));
        roots[index + 2] = new_key(vm, round);
        mal_weak_map_object_set(map, roots[index + 2], mal_value_from_i32((i32) index));
        mal_weak_set_object_add(set, roots[index + 2]);
        CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes <= initial_raw + COUNT * 64);
    }
    mal_gc_collect(vm);
    for (usize i = 0; i < COUNT; i++) {
        CHECK(mal_weak_map_object_get(map, roots[i + 2]) == mal_value_from_i32((i32) i));
        CHECK(mal_weak_set_object_has(set, roots[i + 2]));
    }
    for (usize i = 4; i < COUNT; i++) {
        CHECK(mal_weak_map_object_delete(map, roots[i + 2]));
        CHECK(mal_weak_set_object_delete(set, roots[i + 2]));
    }
    CHECK(mal_weak_map_object_size(map) == 4 && mal_weak_set_object_size(set) == 4);
    CHECK(mal_weak_storage_allocation_bytes(map->entries) <= 96);
    CHECK(mal_weak_storage_allocation_bytes(set->entries) <= 64);
    for (usize i = 0; i < 4; i++) {
        CHECK(mal_weak_map_object_get(map, roots[i + 2]) == mal_value_from_i32((i32) i));
        CHECK(mal_weak_set_object_has(set, roots[i + 2]));
    }
    mal_gc_unroot(&span);
    return 0;
}

static int check_collisions(MalVm *vm) {
    enum { COUNT = 28 };
    MalWeakMapObject *map = mal_weak_map_object_new(&vm->heap, nullptr);
    MalWeakSetObject *set = mal_weak_set_object_new(&vm->heap, nullptr);
    CHECK(mal_weak_map_object_reserve(map, COUNT) && mal_weak_set_object_reserve(set, COUNT));
    MalValue roots[COUNT + 2] = {mal_value_from_object(&map->object), mal_value_from_object(&set->object)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    for (usize i = 0; i < COUNT; i++) {
        MalValue key;
        do { key = new_key(vm, 0); } while ((mal_key_hash_mix(key) & 31) >= MAL_HASH_GROUP_WIDTH);
        roots[i + 2] = key;
        mal_weak_map_object_set(map, key, mal_value_from_i32((i32) i));
        mal_weak_set_object_add(set, key);
    }
    for (usize round = 0; round < 64; round++) {
        usize index = round % 2;
        CHECK(mal_weak_map_object_delete(map, roots[index + 2]));
        CHECK(mal_weak_set_object_delete(set, roots[index + 2]));
        mal_weak_map_object_set(map, roots[index + 2], mal_value_from_i32((i32) index));
        mal_weak_set_object_add(set, roots[index + 2]);
        for (usize i = 0; i < COUNT; i++) {
            CHECK(mal_weak_map_object_get(map, roots[i + 2]) == mal_value_from_i32((i32) i));
            CHECK(mal_weak_set_object_has(set, roots[i + 2]));
        }
    }
    mal_gc_collect(vm);
    CHECK(mal_weak_map_object_size(map) == COUNT && mal_weak_set_object_size(set) == COUNT);
    mal_gc_unroot(&span);
    return 0;
}

static MalHeapHeader *tracked[5];
static u8 finalizations[5];
static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(tracked); i++) if (cell == tracked[i]) finalizations[i]++;
}

static int check_gc(MalVm *vm) {
    for (usize i = 0; i < countof(tracked); i++) {
        tracked[i] = nullptr;
        finalizations[i] = 0;
    }
    MalWeakMapObject *map = mal_weak_map_object_new(&vm->heap, nullptr);
    MalWeakMapObject *key_map = mal_weak_map_object_new(&vm->heap, nullptr);
    MalWeakSetObject *set = mal_weak_set_object_new(&vm->heap, nullptr);
    MalValue roots[5] = {mal_value_from_object(&map->object), mal_value_from_object(&set->object), new_key(vm, 0), MAL_VALUE_UNDEFINED, mal_value_from_object(&key_map->object)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalValue live_value = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_weak_map_object_set(map, roots[2], live_value);
    mal_weak_set_object_add(set, roots[2]);
    for (usize i = 0; i < countof(tracked); i++) tracked[i] = &mal_object_new(&vm->heap, nullptr)->header;
    mal_weak_map_object_set(map, mal_value_from_object((MalObject *) tracked[0]), mal_value_from_object((MalObject *) tracked[1]));
    mal_object_set_prototype_pointer((MalObject *) tracked[3], (MalObject *) tracked[2]);
    mal_weak_map_object_set(map, mal_value_from_object((MalObject *) tracked[2]), mal_value_from_object((MalObject *) tracked[3]));
    mal_weak_set_object_add(set, mal_value_from_object((MalObject *) tracked[4]));
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    mal_gc_collect(vm);
    for (usize i = 0; i < countof(tracked); i++) CHECK(finalizations[i] == 1);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    CHECK(mal_weak_map_object_size(map) == 1 && mal_weak_set_object_size(set) == 1);
    CHECK(mal_weak_map_object_get(map, roots[2]) == live_value);
    MalValue young = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_weak_map_object_set(map, roots[2], young);
    roots[3] = new_key(vm, 0);
    mal_weak_map_object_set(key_map, roots[3], MAL_VALUE_TRUE);
    mal_weak_set_object_add(set, roots[3]);
    MalValue dead_young = new_key(vm, 0);
    mal_weak_map_object_set(key_map, dead_young, MAL_VALUE_FALSE);
    mal_weak_set_object_add(set, dead_young);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    mal_gc_finish_pending_cycle(vm);
    CHECK(mal_weak_map_object_get(map, roots[2]) == young);
    CHECK(mal_weak_map_object_get(key_map, roots[3]) == MAL_VALUE_TRUE && mal_weak_set_object_has(set, roots[3]));
    CHECK(mal_weak_map_object_size(map) == 1 && mal_weak_map_object_size(key_map) == 1 && mal_weak_set_object_size(set) == 2);
    roots[2] = MAL_VALUE_UNDEFINED;
    roots[3] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(mal_weak_map_object_size(map) == 0 && mal_weak_map_object_size(key_map) == 0 && mal_weak_set_object_size(set) == 0);
    mal_gc_unroot(&span);
    return 0;
}

static int check_delete_barrier(MalVm *vm) {
    MalWeakSetObject *set = mal_weak_set_object_new(&vm->heap, nullptr);
    MalValue root = mal_value_from_object(&set->object);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    MalObject *key = mal_object_new(&vm->heap, nullptr);
    for (usize i = 0; i < countof(tracked); i++) {
        tracked[i] = nullptr;
        finalizations[i] = 0;
    }
    tracked[0] = &key->header;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    mal_weak_set_object_add(set, mal_value_from_object(key));
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(mal_gc_marking_active);
    CHECK(mal_weak_set_object_delete(set, mal_value_from_object(key)));
    CHECK(mal_gc_finish_pending_cycle(vm));
    CHECK(finalizations[0] == 1);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_unroot(&span);
    return 0;
}

int main(void) {
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    if (check_delete_barrier(&vm)) return 1;
    mal_vm_free(&vm);
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    if (check_storage(&vm) || check_collisions(&vm) || check_gc(&vm)) return 1;
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("weak-storage ABI PASS");
    return 0;
}
