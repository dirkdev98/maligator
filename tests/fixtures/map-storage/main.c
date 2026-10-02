#include <stdio.h>

#include "gc.h"
#include "weak_collection.h"
#include "hash_index.h"
#include "map_object.h"
#include "set_object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "map-storage:%d\n", __LINE__); return 1; } } while (0)

static int check_storage(MalVm *vm) {
    MalMapObject *map = mal_map_object_new(&vm->heap, nullptr);
    CHECK(map->entries == nullptr);
    CHECK(!mal_map_object_has(map, MAL_VALUE_UNDEFINED));
    CHECK(!mal_map_object_delete(map, MAL_VALUE_TRUE));
    CHECK(mal_map_object_get(map, MAL_VALUE_NULL) == MAL_VALUE_UNDEFINED);
    CHECK(map->entries == nullptr);
    CHECK(mal_map_object_reserve(map, 64));
    usize small_bytes = mal_map_storage_allocation_bytes(map->entries);
    CHECK(small_bytes <= 128);
    for (i32 i = 0; i < 2; i++) mal_map_object_set(map, mal_value_from_i32(i), mal_value_from_i32(i + 10));
    CHECK(mal_map_storage_allocation_bytes(map->entries) == small_bytes);
    for (i32 i = 2; i < 64; i++) mal_map_object_set(map, mal_value_from_i32(i), mal_value_from_i32(i + 10));
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_INT32);
    CHECK(mal_map_storage_traced_slots(map->entries) == 64);
    usize int_bytes = mal_map_storage_allocation_bytes(map->entries);
    CHECK(!mal_map_object_has(map, MAL_VALUE_TRUE));
    const MalValue missing_numbers[] = {
        mal_value_from_f64(0.5), mal_value_from_f64(2147483648.0),
        MAL_VALUE_NAN, MAL_VALUE_POSITIVE_INFINITY, MAL_VALUE_NEGATIVE_INFINITY
    };
    for (usize i = 0; i < countof(missing_numbers); i++) {
        CHECK(!mal_map_object_has(map, missing_numbers[i]));
        CHECK(!mal_map_object_delete(map, missing_numbers[i]));
        CHECK(mal_map_object_get(map, missing_numbers[i]) == MAL_VALUE_UNDEFINED);
    }
    CHECK(mal_map_object_get(map, mal_value_from_f64(17.0)) == mal_value_from_i32(27));
    mal_map_object_set(map, mal_value_from_f64(17.0), MAL_VALUE_TRUE);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_INT32);
    CHECK(mal_map_object_size(map) == 64 && mal_map_storage_allocation_bytes(map->entries) == int_bytes);

    MalMapIter cursor;
    mal_map_iter_init(&cursor, map->entries);
    mal_map_storage_pin(map->entries);
    MalValue key, value;
    CHECK(mal_map_iter_next(&cursor, &key, &value) && mal_value_to_f64(key) == 0.0);
    CHECK(mal_map_object_delete(map, mal_value_from_i32(1)));
    mal_map_object_set(map, mal_value_from_f64(0.5), MAL_VALUE_FALSE);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_NUMBER);
    CHECK(mal_map_storage_traced_slots(map->entries) == 64);
    MalValue object = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_map_object_set(map, object, MAL_VALUE_NULL);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_GENERIC);
    CHECK(mal_map_object_get(map, mal_value_from_i32(17)) == MAL_VALUE_TRUE);
    CHECK(mal_map_object_get(map, object) == MAL_VALUE_NULL);
    for (i32 i = 2; i < 64; i++) {
        CHECK(mal_map_iter_next(&cursor, &key, &value) && mal_value_to_f64(key) == i);
        CHECK(value == (i == 17 ? MAL_VALUE_TRUE : mal_value_from_i32(i + 10)));
    }
    CHECK(mal_map_iter_next(&cursor, &key, &value) && mal_value_to_f64(key) == 0.5 && value == MAL_VALUE_FALSE);
    CHECK(mal_map_iter_next(&cursor, &key, &value) && key == object && value == MAL_VALUE_NULL);
    mal_map_object_clear(map);
    CHECK(mal_map_storage_order_length(map->entries) == 66);
    mal_map_object_set(map, MAL_VALUE_TRUE, MAL_VALUE_FALSE);
    CHECK(mal_map_iter_next(&cursor, &key, &value) && key == MAL_VALUE_TRUE && value == MAL_VALUE_FALSE);
    CHECK(!mal_map_iter_next(&cursor, &key, &value));
    mal_map_storage_unpin(map->entries);
    mal_map_object_compact(map);
    CHECK(mal_map_storage_order_length(map->entries) == 1);
    CHECK(mal_map_storage_allocation_bytes(map->entries) == small_bytes);
    mal_map_object_clear(map);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_EMPTY);
    CHECK(!mal_map_object_reserve(map, SIZE_MAX));

    MalMapObject *generic = mal_map_object_new(&vm->heap, nullptr);
    for (i32 i = 0; i < 63; i++) mal_map_object_set(generic, mal_value_from_i32(i), MAL_VALUE_UNDEFINED);
    mal_map_object_set(generic, MAL_VALUE_TRUE, MAL_VALUE_UNDEFINED);
    CHECK(int_bytes < mal_map_storage_allocation_bytes(generic->entries));
    return 0;
}

static int check_transitions(MalVm *vm) {
    for (i32 generic = 0; generic < 2; generic++) {
        MalMapObject *map = mal_map_object_new(&vm->heap, nullptr);
        for (i32 i = 0; i < 64; i++) {
            MalValue key = generic && i == 63 ? MAL_VALUE_TRUE : mal_value_from_i32(i);
            mal_map_object_set(map, key, mal_value_from_i32(i + 100));
        }
        mal_map_storage_pin(map->entries);
        for (i32 i = 0; i < 60; i++) CHECK(mal_map_object_delete(map, mal_value_from_i32(i)));
        mal_map_storage_unpin(map->entries);
        mal_map_object_compact(map);
        CHECK(mal_map_storage_order_length(map->entries) == 4);
        CHECK(mal_map_storage_allocation_bytes(map->entries) <= 128);
        for (i32 i = 100; i < 116; i++) mal_map_object_set(map, mal_value_from_i32(i), mal_value_from_i32(i + 100));
        for (i32 i = 60; i < 64; i++) {
            MalValue key = generic && i == 63 ? MAL_VALUE_TRUE : mal_value_from_i32(i);
            CHECK(mal_map_object_get(map, key) == mal_value_from_i32(i + 100));
        }
        for (i32 i = 100; i < 116; i++) CHECK(mal_map_object_get(map, mal_value_from_i32(i)) == mal_value_from_i32(i + 100));
    }
    MalMapObject *strings = mal_map_object_new(&vm->heap, nullptr);
    MalValue first = MAL_VALUE_UNDEFINED;
    for (i32 i = 0; i < 5; i++) {
        char text[32];
        int length = snprintf(text, sizeof(text), "collision-member-%d", i);
        MalValue key = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, (const u8 *) text, (usize) length));
        if (i == 0) first = key;
        mal_map_object_set(strings, key, mal_value_from_i32(i + 1));
    }
    CHECK(mal_map_storage_key_domain(strings->entries) == MAL_MAP_KEYS_STRING);
    for (i32 i = 0;; i++) {
        MalValue query = mal_collection_canonical_value(mal_value_from_i32(i));
        if (mal_hash_tag(mal_key_hash_value(query)) != mal_hash_tag(mal_key_hash_value(first))) continue;
        CHECK(!mal_map_object_has(strings, query));
        CHECK(mal_map_object_get(strings, query) == MAL_VALUE_UNDEFINED);
        CHECK(!mal_map_object_delete(strings, query));
        break;
    }
    CHECK(mal_map_object_get(strings, first) == mal_value_from_i32(1));
    CHECK(mal_map_object_size(strings) == 5);
    return 0;
}

static int check_value_tombstones(MalVm *vm) {
    MalMapObject *map = mal_map_object_new(&vm->heap, nullptr);
    bool inserted = false;
    u32 entry = mal_map_object_upsert_canonical(map, mal_value_from_f64(0.0), &inserted);
    CHECK(inserted && mal_map_object_size(map) == 1);
    CHECK(mal_map_object_has(map, mal_value_from_i32(0)));
    CHECK(mal_map_storage_value(map->entries, entry) == MAL_VALUE_UNDEFINED);
    mal_map_object_set(map, mal_value_from_i32(1), MAL_VALUE_NULL);
    mal_map_object_set(map, mal_value_from_i32(2), MAL_VALUE_UNDEFINED);
    mal_map_object_set(map, mal_value_from_i32(3), MAL_VALUE_TRUE);
    usize inline_bytes = mal_map_storage_allocation_bytes(map->entries);
    CHECK(inline_bytes <= 128);
    entry = mal_map_object_find_canonical(map, mal_value_from_f64(1.0));
    mal_map_object_remember_entry(map, entry);
    CHECK(mal_map_object_entry_hint(map, mal_value_from_f64(1.0)) == entry);

    MalMapIter cursor;
    MalValue key, value;
    mal_map_iter_init(&cursor, map->entries);
    mal_map_storage_pin(map->entries);
    CHECK(mal_map_iter_next(&cursor, &key, &value));
    CHECK(key == mal_value_from_f64(0.0) && value == MAL_VALUE_UNDEFINED);
    CHECK(mal_map_object_delete(map, mal_value_from_i32(1)));
    CHECK(mal_map_object_entry_hint(map, mal_value_from_f64(1.0)) == 0);
    CHECK(!mal_map_object_has(map, mal_value_from_i32(1)));
    CHECK(mal_map_object_has(map, mal_value_from_i32(2)));
    mal_map_object_set(map, mal_value_from_i32(4), MAL_VALUE_UNDEFINED);
    CHECK(mal_map_storage_order_length(map->entries) == 5);
    CHECK(mal_map_storage_allocation_bytes(map->entries) > inline_bytes);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_INT32);
    CHECK(mal_map_object_reserve(map, 32));
    for (i32 i = 5; i < 16; i++) mal_map_object_set(map, mal_value_from_i32(i), MAL_VALUE_UNDEFINED);
    CHECK(mal_map_iter_next(&cursor, &key, &value));
    CHECK(key == mal_value_from_f64(2.0) && value == MAL_VALUE_UNDEFINED);

    mal_map_object_set(map, mal_value_from_f64(0.5), MAL_VALUE_UNDEFINED);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_NUMBER);
    CHECK(!mal_map_object_has(map, mal_value_from_i32(1)));
    mal_map_object_set(map, MAL_VALUE_TRUE, MAL_VALUE_UNDEFINED);
    CHECK(mal_map_storage_key_domain(map->entries) == MAL_MAP_KEYS_GENERIC);
    CHECK(mal_map_object_reserve(map, 64));
    CHECK(mal_map_object_size(map) == 17);
    CHECK(mal_map_storage_order_length(map->entries) == 18);
    MalMapIter from_start;
    mal_map_iter_init(&from_start, map->entries);
    for (i32 i = 0; i < 16; i++) {
        if (i == 1) continue;
        CHECK(mal_map_iter_next(&from_start, &key, &value));
        CHECK(key == mal_value_from_f64((f64) i));
        CHECK(value == (i == 3 ? MAL_VALUE_TRUE : MAL_VALUE_UNDEFINED));
    }
    CHECK(mal_map_iter_next(&from_start, &key, &value));
    CHECK(key == mal_value_from_f64(0.5) && value == MAL_VALUE_UNDEFINED);
    CHECK(mal_map_iter_next(&from_start, &key, &value));
    CHECK(key == MAL_VALUE_TRUE && value == MAL_VALUE_UNDEFINED);
    CHECK(!mal_map_iter_next(&from_start, &key, &value));
    for (i32 i = 3; i < 16; i++) {
        CHECK(mal_map_iter_next(&cursor, &key, &value));
        CHECK(key == mal_value_from_f64((f64) i));
        CHECK(value == (i == 3 ? MAL_VALUE_TRUE : MAL_VALUE_UNDEFINED));
    }
    CHECK(mal_map_iter_next(&cursor, &key, &value));
    CHECK(key == mal_value_from_f64(0.5) && value == MAL_VALUE_UNDEFINED);
    CHECK(mal_map_iter_next(&cursor, &key, &value));
    CHECK(key == MAL_VALUE_TRUE && value == MAL_VALUE_UNDEFINED);

    mal_map_object_clear(map);
    CHECK(mal_map_object_size(map) == 0 && mal_map_storage_order_length(map->entries) == 18);
    CHECK(!mal_map_object_has(map, mal_value_from_i32(2)));
    mal_map_object_set(map, mal_value_from_i32(2), MAL_VALUE_UNDEFINED);
    mal_map_object_set(map, mal_value_from_f64(0.5), MAL_VALUE_UNDEFINED);
    mal_map_object_set(map, MAL_VALUE_NULL, MAL_VALUE_FALSE);
    mal_map_object_set(map, MAL_VALUE_TRUE, MAL_VALUE_UNDEFINED);
    const MalValue survivors[] = {
        mal_value_from_f64(2.0), mal_value_from_f64(0.5), MAL_VALUE_NULL, MAL_VALUE_TRUE
    };
    for (usize i = 0; i < countof(survivors); i++) {
        CHECK(mal_map_iter_next(&cursor, &key, &value));
        CHECK(key == survivors[i] && value == (i == 2 ? MAL_VALUE_FALSE : MAL_VALUE_UNDEFINED));
    }
    CHECK(!mal_map_iter_next(&cursor, &key, &value));
    mal_map_iter_init(&from_start, map->entries);
    for (usize i = 0; i < countof(survivors); i++) {
        CHECK(mal_map_iter_next(&from_start, &key, &value));
        CHECK(key == survivors[i] && value == (i == 2 ? MAL_VALUE_FALSE : MAL_VALUE_UNDEFINED));
    }
    CHECK(!mal_map_iter_next(&from_start, &key, &value));
    entry = mal_map_object_find_canonical(map, survivors[0]);
    mal_map_object_remember_entry(map, entry);
    CHECK(mal_map_object_entry_hint(map, survivors[0]) == entry);
    mal_map_storage_unpin(map->entries);
    mal_map_object_compact(map);
    CHECK(mal_map_storage_order_length(map->entries) == 4);
    CHECK(mal_map_storage_allocation_bytes(map->entries) == inline_bytes);
    CHECK(mal_map_object_entry_hint(map, survivors[0]) == 0);
    for (usize i = 0; i < countof(survivors); i++) {
        CHECK(mal_map_object_has(map, survivors[i]));
        CHECK(mal_map_object_get(map, survivors[i]) == (i == 2 ? MAL_VALUE_FALSE : MAL_VALUE_UNDEFINED));
    }

    for (i32 i = 100; i < 113; i++) mal_map_object_set(map, mal_value_from_i32(i), MAL_VALUE_UNDEFINED);
    CHECK(mal_map_storage_allocation_bytes(map->entries) > inline_bytes);
    CHECK(mal_map_object_size(map) == 17 && mal_map_storage_order_length(map->entries) == 17);
    mal_map_iter_init(&cursor, map->entries);
    for (usize i = 0; i < countof(survivors); i++) {
        CHECK(mal_map_iter_next(&cursor, &key, &value));
        CHECK(key == survivors[i] && value == (i == 2 ? MAL_VALUE_FALSE : MAL_VALUE_UNDEFINED));
    }
    for (i32 i = 100; i < 113; i++) {
        CHECK(mal_map_iter_next(&cursor, &key, &value));
        CHECK(key == mal_value_from_f64((f64) i) && value == MAL_VALUE_UNDEFINED);
    }
    CHECK(!mal_map_iter_next(&cursor, &key, &value));
    CHECK(!mal_map_object_has(map, mal_value_from_i32(1)));
    CHECK(!mal_map_object_has(map, mal_value_from_i32(3)));
    inserted = true;
    entry = mal_map_object_upsert_canonical(map, MAL_VALUE_TRUE, &inserted);
    CHECK(!inserted && mal_map_storage_value(map->entries, entry) == MAL_VALUE_UNDEFINED);
    return 0;
}

static int check_gc(MalVm *vm) {
    MalMapObject *numeric = mal_map_object_new(&vm->heap, nullptr);
    MalWeakMapObject *weak = mal_weak_map_object_new(&vm->heap, nullptr);
    MalValue roots[3] = {
        mal_value_from_map_object(numeric), mal_value_from_weak_map_object(weak),
        mal_value_from_object(mal_object_new(&vm->heap, nullptr))
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    for (i32 i = 0; i < 64; i++) {
        MalObject *object = mal_object_new(&vm->heap, nullptr);
        mal_map_object_set(numeric, mal_value_from_i32(i), mal_value_from_object(object));
    }
    mal_weak_map_object_set(weak, roots[2], roots[0]);
    mal_gc_collect(vm);
    CHECK(mal_map_storage_key_domain(numeric->entries) == MAL_MAP_KEYS_INT32);
    for (i32 i = 0; i < 64; i++) {
        CHECK(mal_value_is_object(mal_map_object_get(numeric, mal_value_from_i32(i))));
    }
    MalValue young = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_map_object_set(numeric, mal_value_from_i32(17), young);
    MalValue young_weak = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_weak_map_object_set(weak, roots[2], young_weak);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    mal_gc_finish_pending_cycle(vm);
    CHECK(mal_map_object_get(numeric, mal_value_from_i32(17)) == young);
    CHECK(mal_weak_map_object_get(weak, roots[2]) == young_weak);
    roots[2] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(mal_weak_map_object_size(weak) == 0);
    mal_gc_unroot(&span);
    return 0;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    if (check_storage(&vm) || check_transitions(&vm) || check_value_tombstones(&vm) || check_gc(&vm)) return 1;
    mal_vm_free(&vm);
    puts("map-storage ABI PASS");
    return 0;
}
