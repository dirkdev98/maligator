#include <sched.h>
#include <stdio.h>
#include <stdatomic.h>
#include <time.h>

#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define GRAPH_WIDTH 1024

static usize forced_workers;
static MalEnv *envs[GRAPH_WIDTH];
static MalObject *targets[GRAPH_WIDTH];
static u32 finalized[GRAPH_WIDTH];
static _Atomic u32 worker_env_traces;

static usize worker_limit(void) {
    return forced_workers;
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
    for (usize i = 0; i < countof(targets); ++i) {
        if ((void *) cell == (void *) targets[i]) finalized[i]++;
    }
}

static int check_capacity(usize capacity) {
    forced_workers = capacity;
    mal_gc_test_worker_limit_hook = worker_limit;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_gc_worker_limit(&vm) != capacity) return 1;
    mal_gc_test_trace_env_hook = count_worker_trace;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalValue roots[GRAPH_WIDTH];
    for (usize i = 0; i < countof(roots); ++i) {
        MalEnv *env = mal_env_new(&vm, nullptr, (i32) i, 1);
        envs[i] = env;
        targets[i] = mal_object_new(&vm.heap, nullptr);
        env->slots[0] = mal_value_from_object(targets[i]);
        roots[i] = mal_value_from_heap(&env->header);
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));

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
    if (capacity == 1 && atomic_load_explicit(&worker_env_traces, memory_order_relaxed) == 0) return 4;
    if (capacity == 0 && atomic_load_explicit(&worker_env_traces, memory_order_relaxed) != 0) return 5;
    for (usize i = 0; i < countof(targets); ++i) {
        if (finalized[i] != 0) return 6;
    }

    mal_gc_unroot(&span);
    mal_gc_collect(&vm);
    for (usize i = 0; i < countof(targets); ++i) {
        if (finalized[i] != 1) return 7;
    }
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_test_trace_env_hook = nullptr;
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    return 0;
}

int main(void) {
    int inline_result = check_capacity(0);
    if (inline_result != 0) return inline_result;
    for (usize i = 0; i < countof(targets); ++i) {
        envs[i] = nullptr;
        targets[i] = nullptr;
        finalized[i] = 0;
    }
    atomic_store_explicit(&worker_env_traces, 0, memory_order_relaxed);
    int worker_result = check_capacity(1);
    if (worker_result != 0) return worker_result + 10;
    puts("gc-worker-capacity PASS");
    return 0;
}
