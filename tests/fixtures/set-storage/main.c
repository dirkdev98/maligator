#include <stdio.h>

#include "gc.h"
#include "weak_collection.h"
#include "iterator_object.h"
#include "map_object.h"
#include "set_object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "set-storage:%d\n", __LINE__); return 1; } } while (0)

static int check_storage(MalVm *vm) {
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
    CHECK(set->entries == nullptr);
    CHECK(!mal_set_object_has(set, MAL_VALUE_UNDEFINED));
    CHECK(!mal_set_object_delete(set, MAL_VALUE_TRUE));
    CHECK(set->entries == nullptr);
    CHECK(mal_set_object_reserve(set, 64));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_EMPTY);
    usize small_bytes = mal_set_storage_allocation_bytes(set->entries);
    CHECK(small_bytes <= 128);
    for (i32 i = 0; i < 4; i++) mal_set_object_add(set, mal_value_from_i32(i));
    CHECK(mal_set_storage_allocation_bytes(set->entries) == small_bytes);
    for (i32 i = 4; i < 64; i++) mal_set_object_add(set, mal_value_from_i32(i));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_INT32);
    CHECK(mal_set_storage_traced_slots(set->entries) == 0);
    usize int_bytes = mal_set_storage_allocation_bytes(set->entries);
    CHECK(!mal_set_object_has(set, MAL_VALUE_TRUE));
    CHECK(!mal_set_object_delete(set, MAL_VALUE_NULL));
    CHECK(mal_set_object_has(set, mal_value_from_f64(17.0)));
    mal_set_object_add(set, mal_value_from_f64(17.0));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_INT32);
    CHECK(mal_set_object_size(set) == 64);
    CHECK(mal_set_storage_allocation_bytes(set->entries) == int_bytes);

    MalSetIter cursor;
    mal_set_iter_init(&cursor, set->entries);
    mal_set_storage_pin(set->entries);
    MalValue key;
    CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == 0.0);
    CHECK(mal_set_object_delete(set, mal_value_from_i32(1)));
    mal_set_object_add(set, mal_value_from_f64(0.5));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_NUMBER);
    CHECK(mal_set_storage_traced_slots(set->entries) == 0);
    CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == 2.0);
    MalValue object = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_set_object_add(set, object);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_GENERIC);
    CHECK(mal_set_object_has(set, mal_value_from_i32(17)));
    CHECK(mal_set_object_has(set, object));
    for (i32 i = 3; i < 64; i++) {
        CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == i);
    }
    CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == 0.5);
    CHECK(mal_set_iter_next(&cursor, &key) && key == object);
    mal_set_object_clear(set);
    CHECK(mal_set_storage_order_length(set->entries) == 66);
    mal_set_object_add(set, MAL_VALUE_TRUE);
    CHECK(mal_set_iter_next(&cursor, &key) && key == MAL_VALUE_TRUE);
    CHECK(!mal_set_iter_next(&cursor, &key));
    mal_set_storage_unpin(set->entries);
    mal_set_object_compact(set);
    CHECK(mal_set_storage_order_length(set->entries) == 1);
    CHECK(mal_set_storage_allocation_bytes(set->entries) == small_bytes);
    mal_set_object_clear(set);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_EMPTY);
    CHECK(!mal_set_object_reserve(set, SIZE_MAX));
    return 0;
}

static int check_clusters(MalVm *vm) {
    for (i32 remove = 0; remove < 48; remove += 7) {
        MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
        CHECK(mal_set_object_reserve(set, 64));
        i32 values[48];
        i32 count = 0;
        for (i32 i = 0; count < 48; i++) {
            MalValue key = mal_collection_key_from_value(mal_value_from_i32(i)).value;
            if ((mal_key_hash_value(key) & 127) != 127) continue;
            values[count++] = i;
            mal_set_object_add(set, mal_value_from_i32(i));
        }
        mal_set_storage_pin(set->entries);
        MalSetIter cursor;
        mal_set_iter_init(&cursor, set->entries);
        for (i32 i = 0; i < remove; i++) CHECK(mal_set_object_delete(set, mal_value_from_i32(values[i])));
        for (i32 i = 0; i < 48; i++) {
            CHECK(mal_set_object_has(set, mal_value_from_i32(values[i])) == (i >= remove));
        }
        for (i32 i = remove; i < 48; i++) {
            MalValue key;
            CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == values[i]);
        }
        mal_set_storage_unpin(set->entries);
        mal_set_object_compact(set);
        mal_set_iter_init(&cursor, set->entries);
        for (i32 i = remove; i < 48; i++) {
            MalValue key;
            CHECK(mal_set_iter_next(&cursor, &key) && mal_value_to_f64(key) == values[i]);
        }
    }
    return 0;
}

static int check_members(MalSetObject *set, const MalValue *expected, usize expected_count) {
    CHECK(mal_set_object_size(set) == expected_count);
    MalSetIter cursor;
    mal_set_iter_init(&cursor, set->entries);
    MalValue key;
    for (usize i = 0; i < expected_count; i++) {
        CHECK(mal_set_object_has(set, expected[i]));
        CHECK(mal_set_iter_next(&cursor, &key) && key == expected[i]);
    }
    CHECK(!mal_set_iter_next(&cursor, &key));
    return 0;
}

static int check_tagged_tombstones(MalVm *vm) {
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
    for (i32 i = 0; i < 4; i++) mal_set_object_add(set, mal_value_from_i32(i));
    usize inline_bytes = mal_set_storage_allocation_bytes(set->entries);
    MalSetIter cursor;
    MalValue key;
    mal_set_iter_init(&cursor, set->entries);
    mal_set_storage_pin(set->entries);
    CHECK(mal_set_iter_next(&cursor, &key) && key == mal_value_from_f64(0.0));
    CHECK(mal_set_object_delete(set, mal_value_from_i32(1)));
    CHECK(!mal_set_object_has(set, mal_value_from_i32(1)));
    CHECK(mal_set_storage_order_length(set->entries) == 4);
    mal_set_object_add(set, mal_value_from_i32(4));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_INT32);
    CHECK(mal_set_storage_allocation_bytes(set->entries) > inline_bytes);
    CHECK(mal_set_object_reserve(set, 32));
    for (i32 i = 5; i < 16; i++) mal_set_object_add(set, mal_value_from_i32(i));
    mal_set_object_add(set, mal_value_from_i32(INT32_MIN));
    mal_set_object_add(set, mal_value_from_i32(INT32_MAX));
    mal_set_object_add(set, mal_value_from_i32(INT32_MIN));
    mal_set_object_add(set, mal_value_from_i32(INT32_MAX));
    CHECK(mal_set_object_size(set) == 17 && mal_set_storage_order_length(set->entries) == 18);
    CHECK(mal_set_object_has(set, mal_value_from_i32(INT32_MIN)));
    CHECK(mal_set_object_has(set, mal_value_from_i32(INT32_MAX)));
    CHECK(mal_set_iter_next(&cursor, &key) && key == mal_value_from_f64(2.0));

    mal_set_object_add(set, mal_value_from_f64(0.5));
    mal_set_object_add(set, MAL_VALUE_NAN);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_NUMBER);
    CHECK(mal_set_storage_traced_slots(set->entries) == 0);
    mal_set_object_add(set, MAL_VALUE_UNDEFINED);
    mal_set_object_add(set, MAL_VALUE_NULL);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_GENERIC);
    mal_set_object_add(set, MAL_VALUE_NAN);
    mal_set_object_add(set, MAL_VALUE_UNDEFINED);
    usize tagged_bytes = mal_set_storage_allocation_bytes(set->entries);
    CHECK(mal_set_object_reserve(set, 64));
    CHECK(mal_set_storage_allocation_bytes(set->entries) > tagged_bytes);
    MalValue expected[22];
    usize expected_count = 0;
    for (i32 i = 0; i < 16; i++) {
        if (i != 1) expected[expected_count++] = mal_value_from_f64((f64) i);
    }
    expected[expected_count++] = mal_value_from_f64((f64) INT32_MIN);
    expected[expected_count++] = mal_value_from_f64((f64) INT32_MAX);
    expected[expected_count++] = mal_value_from_f64(0.5);
    expected[expected_count++] = MAL_VALUE_NAN;
    expected[expected_count++] = MAL_VALUE_UNDEFINED;
    expected[expected_count++] = MAL_VALUE_NULL;
    CHECK(mal_set_storage_order_length(set->entries) == expected_count + 1);
    CHECK(mal_set_storage_traced_slots(set->entries) == expected_count);
    CHECK(!mal_set_object_has(set, mal_value_from_i32(1)));
    if (check_members(set, expected, expected_count)) return 1;
    for (usize i = 2; i < expected_count; i++) {
        CHECK(mal_set_iter_next(&cursor, &key) && key == expected[i]);
    }

    mal_set_object_clear(set);
    CHECK(mal_set_storage_order_length(set->entries) == expected_count + 1);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_GENERIC);
    if (check_members(set, nullptr, 0)) return 1;
    const MalValue survivors[] = {
        MAL_VALUE_UNDEFINED, MAL_VALUE_NULL, MAL_VALUE_NAN,
        mal_value_from_f64((f64) INT32_MIN)
    };
    for (usize i = 0; i < countof(survivors); i++) mal_set_object_add(set, survivors[i]);
    for (usize i = 0; i < countof(survivors); i++) {
        CHECK(mal_set_iter_next(&cursor, &key) && key == survivors[i]);
    }
    CHECK(!mal_set_iter_next(&cursor, &key));
    if (check_members(set, survivors, countof(survivors))) return 1;
    mal_set_storage_unpin(set->entries);
    mal_set_object_compact(set);
    CHECK(mal_set_storage_order_length(set->entries) == countof(survivors));
    CHECK(mal_set_storage_allocation_bytes(set->entries) == inline_bytes);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_GENERIC);
    if (check_members(set, survivors, countof(survivors))) return 1;

    expected_count = 0;
    for (usize i = 0; i < countof(survivors); i++) expected[expected_count++] = survivors[i];
    for (i32 i = 100; i < 116; i++) {
        mal_set_object_add(set, mal_value_from_i32(i));
        expected[expected_count++] = mal_value_from_f64((f64) i);
    }
    CHECK(mal_set_storage_allocation_bytes(set->entries) > inline_bytes);
    CHECK(mal_set_storage_order_length(set->entries) == expected_count);
    if (check_members(set, expected, expected_count)) return 1;

    mal_set_object_clear(set);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_EMPTY);
    for (i32 i = 0; i < 32; i++) mal_set_object_add(set, mal_value_from_i32(i));
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_INT32);
    mal_set_iter_init(&cursor, set->entries);
    mal_set_storage_pin(set->entries);
    CHECK(mal_set_iter_next(&cursor, &key) && key == mal_value_from_f64(0.0));
    mal_set_object_clear(set);
    CHECK(mal_set_storage_order_length(set->entries) == 32);
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_INT32);
    mal_set_object_add(set, mal_value_from_i32(INT32_MAX));
    mal_set_object_add(set, MAL_VALUE_NAN);
    expected[0] = mal_value_from_f64((f64) INT32_MAX);
    expected[1] = MAL_VALUE_NAN;
    CHECK(mal_set_storage_key_domain(set->entries) == MAL_SET_KEYS_NUMBER);
    CHECK(mal_set_storage_order_length(set->entries) == 34);
    if (check_members(set, expected, 2)) return 1;
    for (usize i = 0; i < 2; i++) CHECK(mal_set_iter_next(&cursor, &key) && key == expected[i]);
    CHECK(!mal_set_iter_next(&cursor, &key));
    mal_set_storage_unpin(set->entries);
    mal_set_object_compact(set);
    CHECK(mal_set_storage_allocation_bytes(set->entries) == inline_bytes);
    if (check_members(set, expected, 2)) return 1;
    return 0;
}

static int check_gc(MalVm *vm) {
    MalSetObject *strong = mal_set_object_new(&vm->heap, nullptr);
    MalWeakSetObject *weak = mal_weak_set_object_new(&vm->heap, nullptr);
    MalWeakMapObject *map = mal_weak_map_object_new(&vm->heap, nullptr);
    MalValue roots[4] = {
        mal_value_from_set_object(strong), mal_value_from_weak_set_object(weak),
        mal_value_from_weak_map_object(map), mal_value_from_object(mal_object_new(&vm->heap, nullptr))
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalValue last = roots[3];
    for (i32 i = 0; i < 64; i++) {
        MalValue next = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        mal_weak_map_object_set(map, last, next);
        mal_weak_set_object_add(weak, next);
        last = next;
    }
    MalWeakSetObject *late = mal_weak_set_object_new(&vm->heap, nullptr);
    mal_weak_set_object_add(late, last);
    mal_weak_set_object_add(late, mal_value_from_object(mal_object_new(&vm->heap, nullptr)));
    mal_weak_map_object_set(map, last, mal_value_from_weak_set_object(late));
    mal_gc_collect(vm);
    CHECK(mal_weak_set_object_size(weak) == 64);
    CHECK(mal_weak_set_object_size(late) == 1);
    CHECK(mal_weak_set_object_has(late, last));

    MalValue young = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    mal_set_object_add(strong, young);
    mal_weak_set_object_add(weak, young);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(mal_set_object_has(strong, young));
    CHECK(mal_weak_set_object_has(weak, young));
    if (mal_gc_marking_active) CHECK(mal_gc_finish_pending_cycle(vm));
    roots[3] = MAL_VALUE_UNDEFINED;
    mal_gc_collect(vm);
    CHECK(mal_weak_map_object_size(map) == 0);
    CHECK(mal_weak_set_object_size(weak) == 1);
    mal_set_object_clear(strong);
    mal_gc_collect(vm);
    CHECK(mal_weak_set_object_size(weak) == 0);

    for (i32 trial = 0; trial < 128; trial++) {
        MalSetObject *abandoned = mal_set_object_new(&vm->heap, nullptr);
        MalIteratorObject *iterator = mal_iterator_object_new(
            &vm->heap, nullptr, MAL_ITERATOR_SET_VALUES, mal_value_from_set_object(abandoned));
        MalValue members[8];
        for (i32 i = 0; i < 8; i++) {
            char text[64];
            int length = snprintf(text, sizeof(text), "member-string-not-interned-%d-%d", trial, i);
            members[i] = mal_value_from_string(mal_string_new_latin1_copy(
                &vm->heap, (const u8 *) text, (usize) length));
            mal_set_object_add(abandoned, members[i]);
        }
        for (i32 i = 1; i < 7; i++) CHECK(mal_set_object_delete(abandoned, members[i]));
        if (trial % 2 == 0) {
            roots[3] = mal_value_from_set_object(abandoned);
            mal_gc_collect(vm);
            CHECK(mal_set_object_size(abandoned) == 2);
            roots[3] = MAL_VALUE_UNDEFINED;
        } else {
            (void) iterator;
        }
        mal_gc_collect(vm);
    }
    mal_gc_unroot(&span);
    return 0;
}

static int check_bytes(MalVm *vm) {
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
    for (i32 i = 0; i < 64; i++) mal_set_object_add(set, mal_value_from_i32(i));
    usize set_bytes = mal_set_storage_allocation_bytes(set->entries);
    MalHeapUsage before = mal_heap_usage(&vm->heap);
    MalTable *table = mal_table_new();
    for (i32 i = 0; i < 64; i++) {
        mal_table_upsert_entry(table, mal_key_from_value(mal_collection_canonical_value(mal_value_from_i32(i))), nullptr);
    }
    usize table_bytes = mal_heap_usage(&vm->heap).raw_owned_bytes - before.raw_owned_bytes;
    mal_table_free(table);
    CHECK(set_bytes * 3 < table_bytes * 2);
    MalSetObject *generic = mal_set_object_new(&vm->heap, nullptr);
    for (i32 i = 0; i < 63; i++) mal_set_object_add(generic, mal_value_from_i32(i));
    mal_set_object_add(generic, MAL_VALUE_TRUE);
    usize generic_bytes = mal_set_storage_allocation_bytes(generic->entries);
    CHECK(set_bytes < generic_bytes && generic_bytes < table_bytes);
    printf("set-storage bytes int32=%zu generic=%zu property-table=%zu\n", set_bytes, generic_bytes, table_bytes);
    return 0;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = (usize) -1;
    if (check_storage(&vm) || check_clusters(&vm) || check_tagged_tombstones(&vm) ||
        check_bytes(&vm) || check_gc(&vm)) return 1;
    mal_vm_free(&vm);
    puts("set-storage ABI PASS");
    return 0;
}
