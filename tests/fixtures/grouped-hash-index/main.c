#include <stdio.h>

#include "hash_index.h"
#include "set_object.h"
#include "table.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "grouped-hash-index:%d\n", __LINE__); return 1; } } while (0)

static int check_masks(void) {
    u8 controls[MAL_HASH_GROUP_WIDTH];
    for (u32 pattern = 0; pattern < 65536; pattern++) {
        for (u32 i = 0; i < MAL_HASH_GROUP_WIDTH; i++) controls[i] = (pattern & (1u << i)) ? 73 : MAL_HASH_EMPTY;
        MalHashMask matches = mal_hash_group_match(controls, 73);
        CHECK(matches == mal_hash_group_match_scalar(controls, 73));
        u32 remaining = pattern;
        while (matches != 0) {
            CHECK(mal_hash_mask_first(matches) == (u32) __builtin_ctz(remaining));
            matches &= matches - 1;
            remaining &= remaining - 1;
        }
        CHECK(remaining == 0);
        CHECK(mal_hash_group_match(controls, MAL_HASH_EMPTY) ==
            mal_hash_group_match_scalar(controls, MAL_HASH_EMPTY));
    }
    for (u32 capacity = 16; capacity <= 4096; capacity *= 2) {
        bool seen[256] = {false};
        MalHashProbe probe = mal_hash_probe(capacity - 1, capacity);
        for (u32 i = 0; i < capacity / MAL_HASH_GROUP_WIDTH; i++) {
            CHECK(!seen[probe.group / MAL_HASH_GROUP_WIDTH]);
            seen[probe.group / MAL_HASH_GROUP_WIDTH] = true;
            if (i + 1 < capacity / MAL_HASH_GROUP_WIDTH) mal_hash_probe_next(&probe);
        }
    }
    return 0;
}

static int check_churn(MalVm *vm, MalTableRole role) {
    MalTable *table = mal_table_new(role == MAL_TABLE_ROLE_OBJECT ? MAL_TABLE_MODE_OBJECT : MAL_TABLE_MODE_GENERAL, role);
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr, false);
    CHECK(mal_table_reserve(table, 128));
    CHECK(mal_set_object_reserve(set, 128));
    i32 keys[128];
    u32 count = 0;
    for (i32 value = 0; count < countof(keys); value++) {
        MalValue key = mal_collection_key_from_value(mal_value_from_i32(value)).value;
        if ((mal_key_hash_value(key) & 255) != 255) continue;
        keys[count++] = value;
    }
    MalKey anchor_key = mal_collection_key_from_value(mal_value_from_i32(keys[0]));
    void *anchor = mal_table_upsert_entry(table, anchor_key, nullptr);
    mal_table_entry_set_value(table, anchor, MAL_VALUE_TRUE);
    mal_set_object_add(set, anchor_key.value);
    mal_table_pin(table);
    mal_set_storage_pin(set->entries);
    u64 epoch = mal_table_handle_epoch(table);
    bool live[128] = {true};
    u32 random = 42;
    for (u32 operation = 0; operation < 6000; operation++) {
        random = random * 1664525 + 1013904223;
        u32 index = 1 + (random >> 8) % 127;
        MalKey key = mal_collection_key_from_value(mal_value_from_i32(keys[index]));
        if ((random & 3) == 0) {
            CHECK(mal_table_delete(table, key) == live[index]);
            CHECK(mal_set_object_delete(set, key.value) == live[index]);
            live[index] = false;
        } else {
            bool inserted;
            void *entry = mal_table_upsert_entry(table, key, &inserted);
            CHECK(inserted == !live[index]);
            mal_table_entry_set_value(table, entry, mal_value_from_i32((i32) index));
            mal_set_object_add(set, key.value);
            live[index] = true;
        }
        if (operation % 31 != 0) continue;
        CHECK(mal_table_handle_epoch(table) == epoch);
        CHECK(mal_table_entry_matches(table, anchor, epoch, anchor_key));
        CHECK(mal_table_entry_value(table, anchor) == MAL_VALUE_TRUE);
        usize observed_size = 0;
        for (u32 i = 0; i < countof(keys); i++) {
            MalKey query = mal_collection_key_from_value(mal_value_from_i32(keys[i]));
            MalTableLookup lookup = mal_table_lookup(table, query);
            CHECK(lookup.present == live[i]);
            CHECK(mal_set_object_has(set, query.value) == live[i]);
            if (lookup.present && i != 0) CHECK(mal_value_to_i32(mal_table_entry_value(table, lookup.entry)) == (i32) i);
            observed_size += live[i];
        }
        CHECK(mal_table_size(table) == observed_size && mal_set_object_size(set) == observed_size);
    }
    MalTableIter cursor;
    mal_table_iter_init(&cursor, table, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    CHECK(mal_table_iter_next(&cursor, &key, &entry) && key.value == anchor_key.value);
    mal_table_clear(table);
    CHECK(mal_table_handle_epoch(table) == epoch);
    mal_table_upsert_entry(table, anchor_key, nullptr);
    CHECK(mal_table_iter_next(&cursor, &key, &entry) && key.value == anchor_key.value);
    CHECK(!mal_table_iter_next(&cursor, &key, &entry));
    mal_table_unpin(table);
    mal_set_storage_unpin(set->entries);
    mal_table_compact(table);
    CHECK(!mal_table_entry_matches(table, anchor, epoch, anchor_key));
    CHECK(mal_table_lookup(table, anchor_key).present);
    mal_table_free(table);
    return 0;
}

static int check_transitions(MalVm *vm) {
    MalTable *table = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_ATOMS);
    for (i32 i = 0; i < 4; i++) mal_table_upsert_entry(table, mal_collection_key_from_value(mal_value_from_i32(i)), nullptr);
    for (i32 i = 1; i < 4; i++) CHECK(mal_table_delete(table, mal_collection_key_from_value(mal_value_from_i32(i))));
    mal_table_pin(table);
    CHECK(mal_table_reserve(table, 4));
    u64 rebuilds = mal_perf_stats.hash_index_rebuilds;
    for (i32 i = 4; i < 7; i++) mal_table_upsert_entry(table, mal_collection_key_from_value(mal_value_from_i32(i)), nullptr);
    CHECK(mal_perf_stats.hash_index_rebuilds == rebuilds);
    mal_table_unpin(table);
    mal_table_free(table);

    table = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_ATOMS);
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr, false);
    CHECK(mal_table_reserve(table, 28) && mal_set_object_reserve(set, 28));
    MalValue keys[29];
    u32 count = 0;
    for (i32 i = 0; count < 28; i++) {
        MalValue key = mal_collection_key_from_value(mal_value_from_i32(i)).value;
        if ((mal_key_hash_value(key) & 31) >= 16) continue;
        keys[count++] = key;
        mal_table_upsert_entry(table, mal_key_from_value(key), nullptr);
        mal_set_object_add(set, key);
    }
    for (i32 i = 0;; i++) {
        MalValue key = mal_collection_key_from_value(mal_value_from_i32(i)).value;
        if ((mal_key_hash_value(key) & 31) < 16) continue;
        keys[28] = key;
        break;
    }
    mal_table_pin(table);
    mal_set_storage_pin(set->entries);
    void *anchor = mal_table_lookup(table, mal_key_from_value(keys[1])).entry;
    u64 epoch = mal_table_handle_epoch(table);
    CHECK(mal_table_delete(table, mal_key_from_value(keys[0])) && mal_set_object_delete(set, keys[0]));
    rebuilds = mal_perf_stats.hash_index_rebuilds;
    u64 reuses = mal_perf_stats.hash_index_tombstone_reuses;
    mal_table_upsert_entry(table, mal_key_from_value(keys[0]), nullptr);
    mal_set_object_add(set, keys[0]);
    CHECK(mal_perf_stats.hash_index_rebuilds == rebuilds);
    if (mal_perf_stats_enabled) CHECK(mal_perf_stats.hash_index_tombstone_reuses > reuses);
    CHECK(mal_table_delete(table, mal_key_from_value(keys[0])) && mal_set_object_delete(set, keys[0]));
    mal_table_upsert_entry(table, mal_key_from_value(keys[28]), nullptr);
    mal_set_object_add(set, keys[28]);
    if (mal_perf_stats_enabled) CHECK(mal_perf_stats.hash_index_rebuilds > rebuilds);
    CHECK(mal_table_entry_matches(table, anchor, epoch, mal_key_from_value(keys[1])));
    for (u32 i = 1; i < countof(keys); i++) {
        CHECK(mal_table_lookup(table, mal_key_from_value(keys[i])).present);
        CHECK(mal_set_object_has(set, keys[i]));
    }
    for (i32 i = 0; i < 300; i++) {
        MalValue key = mal_collection_key_from_value(mal_value_from_i32(-i - 1)).value;
        mal_table_upsert_entry(table, mal_key_from_value(key), nullptr);
        mal_set_object_add(set, key);
    }
    CHECK(mal_table_entry_matches(table, anchor, epoch, mal_key_from_value(keys[1])));
    for (i32 i = 0; i < 300; i++) {
        MalValue key = mal_collection_key_from_value(mal_value_from_i32(-i - 1)).value;
        CHECK(mal_table_lookup(table, mal_key_from_value(key)).present && mal_set_object_has(set, key));
    }
    mal_table_unpin(table);
    mal_set_storage_unpin(set->entries);
    mal_table_free(table);
    return 0;
}

int main(void) {
    if (check_masks()) return 1;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    for (MalTableRole role = 0; role < MAL_TABLE_ROLE_COUNT; role++) {
        if (check_churn(&vm, role)) return 1;
    }
    if (check_transitions(&vm)) return 1;
    mal_vm_free(&vm);
    printf("grouped-hash-index PASS %d/%d\n", MAL_TABLE_ROLE_COUNT + 2, MAL_TABLE_ROLE_COUNT + 2);
    return 0;
}
