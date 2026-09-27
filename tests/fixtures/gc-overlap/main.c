#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <time.h>

#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static bool worker_entered;
static bool release_worker;
static MalEnv *target_env;
static MalEnv **fixture_envs;
static usize fixture_env_count;
static MalObject *old_target;
static u32 old_finalized;

static void pause_env_trace(MalEnv *env) {
    bool owned = false;
    for (usize i = 0; i < fixture_env_count; ++i) {
        if (fixture_envs[i] == env) owned = true;
    }
    if (!owned) return;
    pthread_mutex_lock(&gate_mutex);
    if (!worker_entered) {
        target_env = env;
        worker_entered = true;
        pthread_cond_signal(&gate_cond);
        while (!release_worker) pthread_cond_wait(&gate_cond, &gate_mutex);
    }
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) old_target) old_finalized++;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_test_trace_env_hook = pause_env_trace;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalValue roots[256];
    MalEnv *envs[256];
    MalObject *targets[256];
    MalRootSpan span;
    fixture_envs = envs;
    fixture_env_count = countof(envs);
    for (usize i = 0; i < countof(roots); ++i) {
        envs[i] = mal_env_new(&vm, nullptr, (i32) i, 1);
        roots[i] = mal_value_from_heap(&envs[i]->header);
        targets[i] = mal_object_new(&vm.heap, nullptr);
        envs[i]->slots[0] = mal_value_from_object(targets[i]);
    }
    mal_gc_root(&span, roots, (i32) countof(roots));

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 1;
    mal_gc_safepoint(&vm);

    pthread_mutex_lock(&gate_mutex);
    struct timespec worker_deadline;
    timespec_get(&worker_deadline, TIME_UTC);
    worker_deadline.tv_sec += 30;
    while (!worker_entered) {
        if (pthread_cond_timedwait(&gate_cond, &gate_mutex, &worker_deadline) != 0) {
            pthread_mutex_unlock(&gate_mutex);
            return 6;
        }
    }
    pthread_mutex_unlock(&gate_mutex);
    for (usize i = 0; i < countof(envs); ++i) {
        if (envs[i] == target_env) old_target = targets[i];
    }
    if (old_target == nullptr) return 5;
    if (mal_heap_mark_is_current(old_target->header.mark, vm.heap.mark_color)) return 4;

    MalObject *replacement = mal_object_new(&vm.heap, nullptr);
    mal_gc_write_barrier(target_env->slots[0]);
    target_env->slots[0] = mal_value_from_object(replacement);
    mal_gc_card(&target_env->header, target_env->slots[0]);

    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);

    time_t deadline = time(nullptr) + 30;
    while (mal_gc_black_alloc && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_black_alloc || old_finalized != 0) return 2;
    mal_gc_collect(&vm);
    if (old_finalized != 1 || target_env->slots[0] != mal_value_from_object(replacement)) return 3;

    mal_gc_unroot(&span);
    mal_gc_test_trace_env_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-overlap PASS");
    return 0;
}
