#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <time.h>

#include "gc.h"
#include "map_object.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define GRAPH_WIDTH 1024
#define FANOUT_ROOTS 2
#define FANOUT_WIDTH 4096

static usize forced_workers;
static usize failed_worker_index;
static u32 worker_start_attempts;
static MalEnv *envs[GRAPH_WIDTH];
static MalObject *targets[GRAPH_WIDTH];
static MalObject *map_target;
static u32 map_target_finalized;
static MalValue *scan_values;
static i32 scan_value_count;
static MalVm *scan_vm;
static u32 finalized[GRAPH_WIDTH];
static _Atomic u32 worker_env_traces;
static pthread_t mutator_thread;
static _Atomic bool wrong_finalizer_thread;

static usize worker_limit(void) {
    return forced_workers;
}

static bool fail_worker_start(usize index) {
    worker_start_attempts++;
    return index == failed_worker_index;
}

static void scan_fixture_roots(MalVm *vm, void *data) {
    (void) data;
    if (vm == scan_vm && scan_values != nullptr) {
        mal_gc_mark_values(scan_values, scan_value_count);
    }
}

static void count_worker_trace(MalEnv *env) {
    for (usize i = 0; i < countof(envs); ++i) {
        if (envs[i] == env) {
            atomic_fetch_add_explicit(&worker_env_traces, 1, memory_order_relaxed);
            return;
        }
    }
}

static void count_finalized(MalHeapHeader *cell) {
    if (!pthread_equal(pthread_self(), mutator_thread)) {
        atomic_store_explicit(&wrong_finalizer_thread, true, memory_order_relaxed);
    }
    for (usize i = 0; i < countof(targets); ++i) {
        if ((void *) cell == (void *) targets[i]) finalized[i]++;
    }
    if ((void *) cell == (void *) map_target) map_target_finalized++;
}

static int check_capacity(usize capacity, usize failure_index, bool start_parked,
                          usize effective_capacity, u32 expected_attempts) {
    mutator_thread = pthread_self();
    forced_workers = capacity;
    failed_worker_index = failure_index;
    worker_start_attempts = 0;
    mal_gc_test_worker_limit_hook = worker_limit;
    mal_gc_test_worker_start_failure_hook = failure_index == SIZE_MAX ? nullptr : fail_worker_start;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_gc_worker_limit(&vm) != capacity) return 1;
    mal_gc_register_root_source(scan_fixture_roots, nullptr);
    mal_gc_test_trace_env_hook = count_worker_trace;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalValue roots[GRAPH_WIDTH + 1 + FANOUT_ROOTS];
    for (usize i = 0; i < GRAPH_WIDTH; ++i) {
        MalEnv *env = mal_env_new(&vm, nullptr, (i32) i, 1);
        envs[i] = env;
        targets[i] = mal_object_new(&vm.heap, nullptr);
        env->slots[0] = mal_value_from_object(targets[i]);
        roots[i] = mal_value_from_heap(&env->header);
    }
    MalMapObject *map = mal_map_object_new(&vm.heap, MAL_HEAP_MAP_OBJECT, nullptr, false);
    map_target = mal_object_new(&vm.heap, nullptr);
    mal_map_object_set(map, mal_value_new_undefined(), mal_value_from_object(map_target));
    roots[GRAPH_WIDTH] = mal_value_from_map_object(map);
    MalEnv *fanouts[FANOUT_ROOTS];
    // A single batch can discover more children than the root worklist reserved.
    for (usize root = 0; root < FANOUT_ROOTS; ++root) {
        fanouts[root] = mal_env_new(&vm, nullptr, 0, FANOUT_WIDTH);
        for (usize i = 0; i < FANOUT_WIDTH; ++i) {
            MalObject *child = mal_object_new(&vm.heap, targets[i % GRAPH_WIDTH]);
            fanouts[root]->slots[i] = mal_value_from_object(child);
        }
        roots[GRAPH_WIDTH + 1 + root] = mal_value_from_heap(&fanouts[root]->header);
    }
    scan_values = roots;
    scan_value_count = (i32) countof(roots);
    scan_vm = &vm;

    if (start_parked) mal_gc_collect(&vm);

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 2;
    time_t deadline = time(nullptr) + 30;
    while (mal_gc_black_alloc && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_black_alloc) return 3;
    if (mal_gc_worker_limit(&vm) != effective_capacity ||
        worker_start_attempts != expected_attempts) return 4;
    if (effective_capacity > 0 &&
        atomic_load_explicit(&worker_env_traces, memory_order_relaxed) == 0) return 5;
    if (effective_capacity == 0 &&
        atomic_load_explicit(&worker_env_traces, memory_order_relaxed) != 0) return 6;
    for (usize i = 0; i < countof(targets); ++i) {
        if (finalized[i] != 0) return 7;
    }
    if (map_target_finalized != 0) return 11;
    for (usize root = 0; root < FANOUT_ROOTS; ++root) {
        for (usize i = 0; i < FANOUT_WIDTH; ++i) {
            MalObject *child = mal_value_to_object(fanouts[root]->slots[i]);
            if (!mal_heap_mark_is_old(child->header.mark) ||
                child->prototype != targets[i % GRAPH_WIDTH]) return 13;
        }
    }

    scan_values = nullptr;
    scan_vm = nullptr;
    mal_gc_collect(&vm);
    for (usize i = 0; i < countof(targets); ++i) {
        if (finalized[i] != 1) return 8;
        targets[i] = nullptr;
    }
    if (map_target_finalized != 1) return 12;
    map_target = nullptr;
    if (worker_start_attempts != expected_attempts) return 9;
    finalized[0] = 0;
    targets[0] = mal_object_new(&vm.heap, nullptr);
    mal_gc_test_trace_env_hook = nullptr;
    mal_vm_free(&vm);
    if (finalized[0] != 1 || atomic_load_explicit(&wrong_finalizer_thread, memory_order_relaxed)) return 10;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_test_worker_limit_hook = nullptr;
    mal_gc_test_worker_start_failure_hook = nullptr;
    return 0;
}

int main(void) {
    const struct {
        usize requested;
        usize failure_index;
        bool start_parked;
        usize effective;
        u32 attempts;
    } cases[] = {
        {0, SIZE_MAX, false, 0, 0},
        {2, 0, false, 0, 1},
        {2, 0, true, 0, 1},
        {2, 1, false, 1, 2},
        {1, SIZE_MAX, false, 1, 0},
        {2, SIZE_MAX, false, 2, 0},
    };
    for (usize scenario = 0; scenario < countof(cases); ++scenario) {
        for (usize i = 0; i < countof(targets); ++i) {
            envs[i] = nullptr;
            targets[i] = nullptr;
            finalized[i] = 0;
        }
        map_target = nullptr;
        map_target_finalized = 0;
        atomic_store_explicit(&worker_env_traces, 0, memory_order_relaxed);
        atomic_store_explicit(&wrong_finalizer_thread, false, memory_order_relaxed);
        int result = check_capacity(cases[scenario].requested, cases[scenario].failure_index,
            cases[scenario].start_parked, cases[scenario].effective, cases[scenario].attempts);
        if (result != 0) return (int) (scenario * 20) + result;
    }
    puts("gc-worker-capacity PASS");
    return 0;
}
