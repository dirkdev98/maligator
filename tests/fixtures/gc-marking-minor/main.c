#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

#include "gc.h"
#include "heap_string.h"
#include "intern_store.h"
#include "object.h"
#include "vm.h"
#include "weak_collection.h"

extern const MalRuntimeImage mal_runtime_image;

#define GRAPH_WIDTH 512

static usize forced_workers;
static MalVm *fixture_vm;
static MalObject *tracked[4];
static u32 finalized[4];
static bool reclaimed_before_remark;
static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_changed = PTHREAD_COND_INITIALIZER;
static bool worker_entered;
static bool release_worker;

static usize worker_limit(void) {
    return forced_workers;
}

static void pause_worker(MalEnv *env) {
    (void) env;
    pthread_mutex_lock(&gate_mutex);
    worker_entered = true;
    pthread_cond_broadcast(&gate_changed);
    while (!release_worker) pthread_cond_wait(&gate_changed, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(tracked); i++) {
        if (cell == (MalHeapHeader *) tracked[i]) finalized[i]++;
    }
    if (cell == (MalHeapHeader *) tracked[1]) {
        reclaimed_before_remark = mal_gc_cycle_active(fixture_vm) && !fixture_vm->heap.sweeping &&
            !mal_heap_mark_is_current(tracked[0]->header.mark, fixture_vm->heap.mark_color);
    }
}

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "gc-marking-minor:%d failed: %s\n", __LINE__, #condition); \
            return 1; \
        } \
    } while (0)

int main(int argc, char **argv) {
    forced_workers = argc > 1 ? (usize) strtoul(argv[1], nullptr, 10) : 0;
    mal_gc_test_worker_limit_hook = worker_limit;
    // Every retained value has a root span or a heap owner; stale C locals are not roots.
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    fixture_vm = &vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalValue roots[GRAPH_WIDTH + 2];
    MalEnv *envs[GRAPH_WIDTH];
    for (usize i = 0; i < countof(envs); i++) {
        envs[i] = mal_env_new(&vm, nullptr, 0, 1);
        roots[i] = mal_value_from_heap(&envs[i]->header);
    }
    roots[countof(envs)] = MAL_VALUE_UNDEFINED;
    roots[countof(envs) + 1] = MAL_VALUE_UNDEFINED;
    tracked[0] = mal_object_new(&vm.heap, nullptr);
    envs[0]->slots[0] = mal_value_from_object(tracked[0]);
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
    mal_gc_collect(&vm);

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    CHECK(mal_gc_marking_active);
    CHECK(!mal_heap_mark_is_current(tracked[0]->header.mark, vm.heap.mark_color));

    MalObject *replacement = mal_object_new(&vm.heap, nullptr);
    mal_gc_write_barrier(envs[0]->slots[0]);
    envs[0]->slots[0] = mal_value_from_object(replacement);
    mal_gc_card(&envs[0]->header, envs[0]->slots[0]);

    if (forced_workers != 0) {
        mal_gc_test_trace_env_hook = pause_worker;
        mal_gc_safepoint(&vm);
        pthread_mutex_lock(&gate_mutex);
        struct timespec deadline;
        timespec_get(&deadline, TIME_UTC);
        deadline.tv_sec += 10;
        while (!worker_entered) {
            int waited = pthread_cond_timedwait(&gate_changed, &gate_mutex, &deadline);
            CHECK(waited == 0);
        }
        pthread_mutex_unlock(&gate_mutex);
    }

    MalWeakMapObject *map = mal_weak_map_object_new(&vm.heap, nullptr);
    roots[countof(envs)] = mal_value_from_object(&map->object);
    MalValue live_key = mal_value_from_object(mal_object_new(&vm.heap, nullptr));
    roots[countof(envs) + 1] = live_key;
    tracked[1] = mal_object_new(&vm.heap, nullptr);
    tracked[2] = mal_object_new(&vm.heap, nullptr);
    tracked[3] = mal_object_new(&vm.heap, nullptr);
    mal_weak_map_object_set(map, mal_value_from_object(tracked[1]),
        mal_value_from_object(tracked[2]));
    mal_weak_map_object_set(map, live_key, mal_value_from_object(tracked[3]));
    static const byte atom_text[] = "marking-minor-atom";
    MalString *atom = mal_atom_store_intern(&vm.atoms,
        mal_string_new_ascii(&vm.heap, atom_text, sizeof(atom_text) - 1));

    usize grow = vm.heap.live_bytes * 2;
    if (grow < (usize) 4 * 1024 * 1024) grow = (usize) 4 * 1024 * 1024;
    usize allocated = vm.heap.bytes_allocated;
    while (vm.heap.bytes_allocated - allocated < grow + grow / 4) {
        (void) mal_object_new(&vm.heap, nullptr);
    }
    // The batch stays unmerged until this safepoint; the minor must settle it first.
    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_changed);
    pthread_mutex_unlock(&gate_mutex);
    mal_gc_safepoint(&vm);
    CHECK(finalized[1] == 1 && finalized[2] == 1);
    CHECK(reclaimed_before_remark);
    CHECK(finalized[0] == 0 && finalized[3] == 0);
    CHECK(mal_weak_map_object_size(map) == 1);
    CHECK(mal_weak_map_object_get(map, live_key) == mal_value_from_object(tracked[3]));
    CHECK(mal_atom_store_find(&vm.atoms, atom) == atom);
    CHECK(mal_heap_mark_is_old(atom->header.mark));
    CHECK(envs[0]->slots[0] == mal_value_from_object(replacement));

    (void) mal_gc_finish_pending_cycle(&vm);
    CHECK(finalized[0] == 0);
    mal_gc_collect(&vm);
    CHECK(finalized[0] == 1 && finalized[3] == 0);
    mal_gc_unroot(&span);
    mal_gc_collect(&vm);
    CHECK(finalized[1] == 1 && finalized[2] == 1 && finalized[3] == 1);
    mal_gc_test_trace_env_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    puts("gc-marking-minor PASS");
    return 0;
}
