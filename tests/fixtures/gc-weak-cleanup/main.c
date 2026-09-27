#include <stdint.h>
#include <stdio.h>

#include "gc.h"
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
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-weak-cleanup PASS");
    return 0;
}
