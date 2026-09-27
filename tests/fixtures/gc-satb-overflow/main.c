#include <stdint.h>
#include <stdio.h>

#include "gc.h"
#include "object.h"
#include "object_ops.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define EDGE_COUNT 9000
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
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    MalEnv *env = mal_env_new(&vm, nullptr, 0, EDGE_COUNT);
    for (i32 i = 0; i < EDGE_COUNT; ++i) {
        MalObject *parent = mal_object_new(&vm.heap, nullptr);
        MalObject *child = mal_object_new(&vm.heap, nullptr);
        track(parent);
        track(child);
        if (!mal_object_set(parent, mal_key_index(0), mal_value_from_object(child))) return 1;
        env->slots[i] = mal_value_from_object(parent);
    }
    MalValue root = mal_value_from_heap(&env->header);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 2;

    vm.gc_native_frames++;
    MalValue repeated = env->slots[0];
    for (i32 i = 0; i < 5000; ++i) {
        mal_gc_write_barrier(env->slots[0]);
        env->slots[0] = repeated;
    }
    for (i32 i = 0; i < EDGE_COUNT; ++i) {
        mal_gc_write_barrier(env->slots[i]);
        env->slots[i] = mal_value_new_undefined();
    }
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active || mal_gc_finish_pending_cycle(&vm)) return 3;
    vm.gc_native_frames--;
    if (!mal_gc_finish_pending_cycle(&vm)) return 4;
    if (mal_gc_marking_active || vm.heap.sweeping) return 5;
    for (usize i = 0; i < countof(tracked); ++i) {
        if (tracked[i].finalizations != 0) return 6;
    }

    mal_gc_collect(&vm);
    usize reclaimed = 0;
    for (usize i = 0; i < countof(tracked); ++i) {
        if (tracked[i].cell == nullptr) continue;
        if (tracked[i].finalizations != 1) return 7;
        reclaimed++;
    }
    if (reclaimed != EDGE_COUNT * 2) return 8;
    mal_gc_unroot(&span);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-satb-overflow PASS");
    return 0;
}
