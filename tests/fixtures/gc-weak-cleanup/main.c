#include <stdint.h>
#include <stdio.h>

#include "gc.h"
#include "heap_symbol.h"
#include "map_object.h"
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

static int check_sparse_churn(MalVm *vm) {
    enum { LIVE_COUNT = 256, CHURN_COUNT = LIVE_COUNT * 3 };
    MalValue roots[LIVE_COUNT + 2];
    for (usize i = 0; i < countof(roots); ++i) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalMapObject *map = mal_map_object_new(&vm->heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
    roots[0] = mal_value_from_object(&map->object);
    MalMapObject *set = mal_map_object_new(&vm->heap, MAL_HEAP_SET_OBJECT, nullptr, true);
    roots[1] = mal_value_from_object(&set->object);
    for (usize i = 0; i < LIVE_COUNT; ++i) {
        roots[i + 2] = new_weak_key(vm, i);
        mal_map_object_set(map, roots[i + 2], mal_value_from_i32((i32) i));
        mal_map_object_set(set, roots[i + 2], mal_value_new_undefined());
    }
    mal_gc_collect(vm);
    usize initial_raw = mal_heap_usage(&vm->heap).raw_owned_bytes;
    for (usize round = 0; round < CHURN_COUNT; ++round) {
        usize index = round % LIVE_COUNT;
        roots[index + 2] = mal_value_new_undefined();
        mal_gc_collect(vm);
        if (mal_map_object_size(map) != LIVE_COUNT - 1 ||
            mal_map_object_size(set) != LIVE_COUNT - 1) return 5;
        // Two tables may retain one extra entry buffer's worth of tombstones,
        // but repeated weak deaths must not grow RAW ownership without bound.
        if (mal_heap_usage(&vm->heap).raw_owned_bytes >
            initial_raw + LIVE_COUNT * 64) return 6;
        roots[index + 2] = new_weak_key(vm, index);
        mal_map_object_set(map, roots[index + 2], mal_value_from_i32((i32) index));
        mal_map_object_set(set, roots[index + 2], mal_value_new_undefined());
        if (round % 64 == 0 || round + 1 == CHURN_COUNT) {
            for (usize i = 0; i < LIVE_COUNT; ++i) {
                if (mal_map_object_get(map, roots[i + 2]) != mal_value_from_i32((i32) i) ||
                    !mal_map_object_has(set, roots[i + 2])) return 7;
            }
        }
    }
    for (usize round = 0; round < 128; ++round) {
        MalValue transient = new_weak_key(vm, round);
        mal_map_object_set(map, transient, mal_value_from_i32(-1));
        mal_map_object_set(set, transient, mal_value_new_undefined());
        u64 before = mal_gc_collection_count(vm);
        vm->heap.next_gc_at = 1;
        mal_gc_poll = true;
        mal_gc_safepoint(vm);
        mal_gc_finish_pending_cycle(vm);
        if (mal_gc_collection_count(vm) <= before ||
            mal_map_object_size(map) != LIVE_COUNT ||
            mal_map_object_size(set) != LIVE_COUNT) return 10;
        if (mal_heap_usage(&vm->heap).raw_owned_bytes >
            initial_raw + LIVE_COUNT * 64) return 11;
    }
    for (usize i = 0; i < LIVE_COUNT; ++i) {
        if (mal_map_object_get(map, roots[i + 2]) != mal_value_from_i32((i32) i) ||
            !mal_map_object_has(set, roots[i + 2])) return 12;
    }
    for (usize i = 2; i < countof(roots); ++i) roots[i] = mal_value_new_undefined();
    mal_gc_collect(vm);
    if (mal_map_object_size(map) != 0 || mal_map_object_size(set) != 0) return 8;
    usize empty_raw = mal_heap_usage(&vm->heap).raw_owned_bytes;
    roots[2] = new_weak_key(vm, 0);
    mal_map_object_set(map, roots[2], mal_value_from_i32(1));
    mal_map_object_set(set, roots[2], mal_value_new_undefined());
    roots[2] = mal_value_new_undefined();
    mal_gc_collect(vm);
    if (mal_map_object_size(map) != 0 || mal_map_object_size(set) != 0 ||
        mal_heap_usage(&vm->heap).raw_owned_bytes != empty_raw) return 9;
    mal_gc_unroot(&span);
    return 0;
}

int main(void) {
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = (usize) -1;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalMapObject *map = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, true);
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
