#include <stdint.h>
#include <stdio.h>

#include "gc.h"
#include "heap_symbol.h"
#include "map_object.h"
#include "set_object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define ENTRY_COUNT 5000
#define TRACK_CAPACITY 32768

typedef struct TrackedCell {
    MalHeapHeader *cell;
    u8 finalizations;
} TrackedCell;

static TrackedCell tracked[TRACK_CAPACITY];

static usize no_workers(void) {
    return 0;
}

static usize tracked_slot(MalHeapHeader *cell) {
    usize slot = ((uintptr_t) cell >> 4) & (TRACK_CAPACITY - 1);
    while (tracked[slot].cell != nullptr && tracked[slot].cell != cell) {
        slot = (slot + 1) & (TRACK_CAPACITY - 1);
    }
    return slot;
}

static void track(MalObject *object) {
    TrackedCell *entry = &tracked[tracked_slot(&object->header)];
    if (entry->cell != nullptr) __builtin_trap();
    entry->cell = &object->header;
}

static void count_finalized(MalHeapHeader *cell) {
    TrackedCell *entry = &tracked[tracked_slot(cell)];
    if (entry->cell == cell) entry->finalizations++;
}

static MalValue new_weak_key(MalVm *vm, usize index) {
    if (index % 2 == 0) {
        return mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    }
    return mal_value_from_symbol(mal_symbol_new(&vm->heap, nullptr));
}

static i32 retain_minimum;

static bool keep_table_key(MalValue key) {
    return mal_value_to_i32(key) >= retain_minimum;
}

static int check_table_filter(void) {
    // These keys share the last bucket of a 128-slot table, wrapping the probe cluster.
    static const i32 clustered[] = {
        50, 167, 274, 317, 964, 1054, 1247, 1299, 1320, 1398, 1457, 1609,
        1662, 1825, 2106, 2249, 2252, 2255, 2371, 2444, 2535, 2599, 2603,
        2634, 2844, 3215, 3253, 3337, 3615, 3746, 3897, 4145, 4440, 4467,
        4698, 4848, 5170, 5226, 5383, 5413, 5496, 5580, 5589, 5619, 5696,
        5832, 5962, 6132, 6213, 6367, 6642, 6645, 6812, 6817, 6922, 6971,
        6977, 6999, 7090, 7359, 7456, 7577, 7690, 7744
    };
    static const usize removals[] = {0, 1, 16, 17, 32, 64, 17};
    for (usize trial = 0; trial < countof(removals); ++trial) {
        usize count = trial + 1 == countof(removals) ? 256 : countof(clustered);
        MalTable *table = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_ATOMS);
        if (!mal_table_reserve(table, count)) return 20;
        void *handles[256];
        for (usize i = 0; i < count; ++i) {
            i32 number = count == countof(clustered) ? clustered[i] : (i32) i;
            MalKey key = mal_key_index_unsigned((u32) number);
            handles[i] = mal_table_upsert_entry(table, key, nullptr);
            mal_table_entry_set_value(table, handles[i], mal_value_from_i32((i32) i));
        }
        mal_table_pin(table);
        u64 epoch = mal_table_handle_epoch(table);
        MalTableIter iter;
        mal_table_iter_init(&iter, table, MAL_TABLE_ITER_STORAGE);
        usize removed = removals[trial];
        retain_minimum = removed == count ? INT32_MAX
            : count == countof(clustered) ? clustered[removed] : (i32) removed;
        if (mal_table_retain(table, keep_table_key) != removed ||
            mal_table_size(table) != count - removed ||
            mal_table_handle_epoch(table) != epoch) return 21;
        if (mal_table_retain(table, keep_table_key) != 0) return 22;
        for (usize i = 0; i < count; ++i) {
            i32 number = count == countof(clustered) ? clustered[i] : (i32) i;
            MalKey key = mal_key_index_unsigned((u32) number);
            MalTableLookup found = mal_table_lookup(table, key);
            if (found.present != (i >= removed) ||
                mal_table_entry_is_live(table, handles[i]) != (i >= removed)) return 23;
            if (found.present && (found.entry != handles[i] ||
                mal_table_entry_value(table, found.entry) != mal_value_from_i32((i32) i))) return 24;
        }
        for (usize i = removed; i < count; ++i) {
            MalKey key;
            void *entry;
            if (!mal_table_iter_next(&iter, &key, &entry) || entry != handles[i]) return 25;
        }
        MalKey added = mal_key_index_unsigned(100000);
        void *added_entry = mal_table_upsert_entry(table, added, nullptr);
        MalKey next_key;
        void *next_entry;
        if (!mal_table_iter_next(&iter, &next_key, &next_entry) ||
            next_key.value != added.value || next_entry != added_entry ||
            mal_table_iter_next(&iter, &next_key, &next_entry)) return 26;
        mal_table_unpin(table);
        mal_table_compact(table);
        if (!mal_table_lookup(table, added).present) return 27;
        mal_table_free(table);
    }
    return 0;
}

static int check_sparse_churn(MalVm *vm) {
    enum { LIVE_COUNT = 256, CHURN_COUNT = LIVE_COUNT * 3 };
    MalValue roots[LIVE_COUNT + 2];
    for (usize i = 0; i < countof(roots); ++i) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = mal_map_object_new(&vm->heap, nullptr, true);
    roots[0] = mal_value_from_object(&map->object);
    MalSetObject *set = mal_set_object_new(&vm->heap, nullptr, true);
    roots[1] = mal_value_from_object(&set->object);
    for (usize i = 0; i < LIVE_COUNT; ++i) {
        roots[i + 2] = new_weak_key(vm, i);
        mal_map_object_set(map, roots[i + 2], mal_value_from_i32((i32) i));
        mal_set_object_add(set, roots[i + 2]);
    }
    mal_gc_collect(vm);
    usize initial_raw = mal_heap_usage(&vm->heap).raw_owned_bytes;
    for (usize round = 0; round < CHURN_COUNT; ++round) {
        usize index = round % LIVE_COUNT;
        roots[index + 2] = mal_value_new_undefined();
        mal_gc_collect(vm);
        if (mal_map_object_size(map) != LIVE_COUNT - 1 ||
            mal_set_object_size(set) != LIVE_COUNT - 1) return 5;
        // Both weak stores may retain one extra buffer's worth of tombstones,
        // but repeated weak deaths must not grow RAW ownership without bound.
        if (mal_heap_usage(&vm->heap).raw_owned_bytes >
            initial_raw + LIVE_COUNT * 64) return 6;
        roots[index + 2] = new_weak_key(vm, index);
        mal_map_object_set(map, roots[index + 2], mal_value_from_i32((i32) index));
        mal_set_object_add(set, roots[index + 2]);
        if (round % 64 == 0 || round + 1 == CHURN_COUNT) {
            for (usize i = 0; i < LIVE_COUNT; ++i) {
                if (mal_map_object_get(map, roots[i + 2]) != mal_value_from_i32((i32) i) ||
                    !mal_set_object_has(set, roots[i + 2])) return 7;
            }
        }
    }
    for (usize round = 0; round < 128; ++round) {
        MalValue transient = new_weak_key(vm, round);
        mal_map_object_set(map, transient, mal_value_from_i32(-1));
        mal_set_object_add(set, transient);
        u64 before = vm->heap.epoch;
        vm->heap.next_gc_at = 1;
        mal_gc_poll = true;
        mal_gc_safepoint(vm);
        mal_gc_finish_pending_cycle(vm);
        if (vm->heap.epoch <= before ||
            mal_map_object_size(map) != LIVE_COUNT ||
            mal_set_object_size(set) != LIVE_COUNT) return 10;
        if (mal_heap_usage(&vm->heap).raw_owned_bytes >
            initial_raw + LIVE_COUNT * 64) return 11;
    }
    for (usize i = 0; i < LIVE_COUNT; ++i) {
        if (mal_map_object_get(map, roots[i + 2]) != mal_value_from_i32((i32) i) ||
            !mal_set_object_has(set, roots[i + 2])) return 12;
    }
    for (usize i = 2; i < countof(roots); ++i) roots[i] = mal_value_new_undefined();
    mal_gc_collect(vm);
    if (mal_map_object_size(map) != 0 || mal_set_object_size(set) != 0) return 8;
    usize empty_raw = mal_heap_usage(&vm->heap).raw_owned_bytes;
    roots[2] = new_weak_key(vm, 0);
    mal_map_object_set(map, roots[2], mal_value_from_i32(1));
    mal_set_object_add(set, roots[2]);
    roots[2] = mal_value_new_undefined();
    mal_gc_collect(vm);
    if (mal_map_object_size(map) != 0 || mal_set_object_size(set) != 0 ||
        mal_heap_usage(&vm->heap).raw_owned_bytes != empty_raw) return 9;
    mal_gc_unroot(&span);
    return 0;
}

int main(void) {
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = (usize) -1;
    int filter_result = check_table_filter();
    if (filter_result != 0) return filter_result;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalMapObject *map = mal_map_object_new(&vm.heap, nullptr, true);
    MalValue root = mal_value_from_object(&map->object);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    for (usize i = 0; i < ENTRY_COUNT; ++i) {
        MalObject *key = mal_object_new(&vm.heap, nullptr);
        MalObject *value = mal_object_new(&vm.heap, nullptr);
        track(key);
        track(value);
        mal_map_object_set(map, mal_value_from_object(key), mal_value_from_object(value));
    }

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active || !mal_gc_finish_pending_cycle(&vm)) return 1;
    if (mal_map_object_size(map) != 0) return 2;
    usize finalized = 0;
    for (usize i = 0; i < countof(tracked); ++i) {
        if (tracked[i].cell == nullptr) continue;
        if (tracked[i].finalizations != 1) return 3;
        finalized++;
    }
    if (finalized != ENTRY_COUNT * 2) return 4;

    mal_gc_unroot(&span);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    int result = check_sparse_churn(&vm);
    if (result != 0) return result;
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-weak-cleanup PASS");
    return 0;
}
