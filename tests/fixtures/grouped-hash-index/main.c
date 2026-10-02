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

static MalValue set_index_key(u32 index) {
    return mal_collection_canonical_value(mal_value_from_u32(index));
}

static int check_churn(MalVm *vm) {
    MalTable *table = mal_table_new();
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
    CHECK(mal_table_reserve(table, 128));
    CHECK(mal_set_object_reserve(set, 128));
    u32 keys[128];
    u32 set_keys[128];
    u32 count = 0;
    for (u32 value = 0; count < countof(keys); value++) {
        if ((mal_key_hash_value(mal_key_index(value).value) & 255) == 255) keys[count++] = value;
    }
    count = 0;
    for (u32 value = 0; count < countof(set_keys); value++) {
        if ((mal_key_hash_value(set_index_key(value)) & 255) == 255) set_keys[count++] = value;
    }
    MalKey anchor_key = mal_key_index(keys[0]);
    void *anchor = mal_table_upsert_entry(table, anchor_key, nullptr);
    mal_table_entry_set_value(table, anchor, MAL_VALUE_TRUE);
    mal_set_object_add(set, set_index_key(set_keys[0]));
    mal_table_pin(table);
    mal_set_storage_pin(set->entries);
    u64 epoch = mal_table_handle_epoch(table);
    bool live[128] = {true};
    u32 random = 42;
    for (u32 operation = 0; operation < 6000; operation++) {
        random = random * 1664525 + 1013904223;
        u32 index = 1 + (random >> 8) % 127;
        MalKey key = mal_key_index(keys[index]);
        MalValue set_key = set_index_key(set_keys[index]);
        if ((random & 3) == 0) {
            CHECK(mal_table_delete(table, key) == live[index]);
            CHECK(mal_set_object_delete(set, set_key) == live[index]);
            live[index] = false;
        } else {
            bool inserted;
            void *entry = mal_table_upsert_entry(table, key, &inserted);
            CHECK(inserted == !live[index]);
            mal_table_entry_set_value(table, entry, mal_value_from_i32((i32) index));
            mal_set_object_add(set, set_key);
            live[index] = true;
        }
        if (operation % 31 != 0) continue;
        CHECK(mal_table_handle_epoch(table) == epoch);
        CHECK(mal_table_entry_matches(table, anchor, epoch, anchor_key));
        CHECK(mal_table_entry_value(table, anchor) == MAL_VALUE_TRUE);
        usize observed_size = 0;
        for (u32 i = 0; i < countof(keys); i++) {
            MalKey query = mal_key_index(keys[i]);
            MalTableLookup lookup = mal_table_lookup(table, query);
            CHECK(lookup.present == live[i]);
            CHECK(mal_set_object_has(set, set_index_key(set_keys[i])) == live[i]);
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
    MalTable *table = mal_table_new();
    for (i32 i = 0; i < 4; i++) mal_table_upsert_entry(table, mal_key_index(i), nullptr);
    for (i32 i = 1; i < 4; i++) CHECK(mal_table_delete(table, mal_key_index(i)));
    mal_table_pin(table);
    CHECK(mal_table_reserve(table, 4));
    u64 rebuilds = mal_perf_stats.hash_index_rebuilds;
    for (i32 i = 4; i < 7; i++) mal_table_upsert_entry(table, mal_key_index(i), nullptr);
    CHECK(mal_perf_stats.hash_index_rebuilds == rebuilds);
    mal_table_unpin(table);
    mal_table_free(table);

    table = mal_table_new();
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr);
    CHECK(mal_table_reserve(table, 28) && mal_set_object_reserve(set, 28));
    MalValue keys[29];
    MalValue set_keys[29];
    for (u32 family = 0; family < 2; family++) {
        MalValue *chosen = family == 0 ? keys : set_keys;
        u32 count = 0;
        for (u32 i = 0; count < 28; i++) {
            MalValue key = family == 0 ? mal_key_index(i).value : set_index_key(i);
            if ((mal_key_hash_value(key) & 31) >= 16) continue;
            chosen[count++] = key;
            if (family == 0) mal_table_upsert_entry(table, mal_key_from_value(key), nullptr);
            else mal_set_object_add(set, key);
        }
        for (u32 i = 0;; i++) {
            MalValue key = family == 0 ? mal_key_index(i).value : set_index_key(i);
            if ((mal_key_hash_value(key) & 31) < 16) continue;
            chosen[28] = key;
            break;
        }
    }
    mal_table_pin(table);
    mal_set_storage_pin(set->entries);
    void *anchor = mal_table_lookup(table, mal_key_from_value(keys[1])).entry;
    u64 epoch = mal_table_handle_epoch(table);
    CHECK(mal_table_delete(table, mal_key_from_value(keys[0])) && mal_set_object_delete(set, set_keys[0]));
    rebuilds = mal_perf_stats.hash_index_rebuilds;
    u64 reuses = mal_perf_stats.hash_index_tombstone_reuses;
    mal_table_upsert_entry(table, mal_key_from_value(keys[0]), nullptr);
    mal_set_object_add(set, set_keys[0]);
    CHECK(mal_perf_stats.hash_index_rebuilds == rebuilds);
    if (mal_perf_stats_enabled) CHECK(mal_perf_stats.hash_index_tombstone_reuses > reuses);
    CHECK(mal_table_delete(table, mal_key_from_value(keys[0])) && mal_set_object_delete(set, set_keys[0]));
    mal_table_upsert_entry(table, mal_key_from_value(keys[28]), nullptr);
    mal_set_object_add(set, set_keys[28]);
    if (mal_perf_stats_enabled) CHECK(mal_perf_stats.hash_index_rebuilds > rebuilds);
    CHECK(mal_table_entry_matches(table, anchor, epoch, mal_key_from_value(keys[1])));
    for (u32 i = 1; i < countof(keys); i++) {
        CHECK(mal_table_lookup(table, mal_key_from_value(keys[i])).present);
        CHECK(mal_set_object_has(set, set_keys[i]));
    }
    for (i32 i = 0; i < 300; i++) {
        MalValue key = mal_key_index(100000 + i).value;
        mal_table_upsert_entry(table, mal_key_from_value(key), nullptr);
        mal_set_object_add(set, key);
    }
    CHECK(mal_table_entry_matches(table, anchor, epoch, mal_key_from_value(keys[1])));
    for (i32 i = 0; i < 300; i++) {
        MalValue key = mal_key_index(100000 + i).value;
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
    if (check_churn(&vm)) return 1;
    if (check_transitions(&vm)) return 1;
    mal_vm_free(&vm);
    puts("grouped-hash-index PASS 3/3");
    return 0;
}
