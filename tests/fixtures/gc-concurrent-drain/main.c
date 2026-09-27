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
static bool teardown_released;
static MalEnv *paused_descendant;
static MalObject *overwritten_target;
static MalObject *tail_target;
static u32 overwritten_finalized;
static u32 tail_finalized;
static MalValue fixture_roots[512];

static usize one_worker(void) { return 1; }

static void scan_fixture_roots(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    mal_gc_mark_values(fixture_roots, (i32) countof(fixture_roots));
}

static void pause_descendant(MalEnv *env) {
    if (env != paused_descendant) return;
    pthread_mutex_lock(&gate_mutex);
    worker_entered = true;
    pthread_cond_signal(&gate_cond);
    while (!release_worker) pthread_cond_wait(&gate_cond, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) overwritten_target) overwritten_finalized++;
    if ((void *) cell == (void *) tail_target) tail_finalized++;
}

static bool wait_for_descendant(MalVm *vm) {
    time_t deadline = time(nullptr) + 30;
    while (time(nullptr) < deadline) {
        mal_gc_safepoint(vm);
        pthread_mutex_lock(&gate_mutex);
        if (worker_entered) {
            pthread_mutex_unlock(&gate_mutex);
            return true;
        }
        struct timespec worker_deadline;
        timespec_get(&worker_deadline, TIME_UTC);
        worker_deadline.tv_sec += 1;
        pthread_cond_timedwait(&gate_cond, &gate_mutex, &worker_deadline);
        bool entered = worker_entered;
        pthread_mutex_unlock(&gate_mutex);
        if (entered) return true;
    }
    return false;
}

static void release_descendant(void) {
    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);
}

static void release_at_teardown(void) {
    teardown_released = true;
    release_descendant();
}

int main(void) {
    mal_gc_test_worker_limit_hook = one_worker;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_root_source(scan_fixture_roots, nullptr);
    mal_gc_test_trace_env_hook = pause_descendant;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalEnv *chain[320];
    for (usize i = 0; i < countof(chain); ++i) {
        chain[i] = mal_env_new(&vm, i == 0 ? nullptr : chain[i - 1], (i32) i, 1);
    }
    paused_descendant = chain[countof(chain) - 2];
    overwritten_target = mal_object_new(&vm.heap, nullptr);
    tail_target = mal_object_new(&vm.heap, nullptr);
    paused_descendant->slots[0] = mal_value_from_object(overwritten_target);
    chain[0]->slots[0] = mal_value_from_object(tail_target);

    for (usize i = 0; i + 1 < countof(fixture_roots); ++i) {
        MalEnv *env = mal_env_new(&vm, nullptr, (i32) i, 1);
        fixture_roots[i] = mal_value_from_heap(&env->header);
    }
    fixture_roots[countof(fixture_roots) - 1] =
        mal_value_from_heap(&chain[countof(chain) - 1]->header);

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 1;
    mal_gc_safepoint(&vm);
    if (!wait_for_descendant(&vm)) return 2;
    if (mal_heap_mark_is_current(overwritten_target->header.mark, vm.heap.mark_color)) return 3;

    MalObject *replacement = mal_object_new(&vm.heap, nullptr);
    mal_gc_write_barrier(paused_descendant->slots[0]);
    paused_descendant->slots[0] = mal_value_from_object(replacement);
    mal_gc_card(&paused_descendant->header, paused_descendant->slots[0]);
    release_descendant();

    time_t deadline = time(nullptr) + 30;
    while (mal_gc_black_alloc && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_black_alloc || overwritten_finalized != 0 || tail_finalized != 0) return 4;
    mal_gc_collect(&vm);
    if (overwritten_finalized != 1 || tail_finalized != 0 ||
        paused_descendant->slots[0] != mal_value_from_object(replacement)) return 5;

    pthread_mutex_lock(&gate_mutex);
    worker_entered = false;
    release_worker = false;
    pthread_mutex_unlock(&gate_mutex);
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 6;
    mal_gc_safepoint(&vm);
    if (!wait_for_descendant(&vm)) return 7;

    mal_gc_test_before_worker_join_hook = release_at_teardown;
    mal_vm_free(&vm);
    mal_gc_test_before_worker_join_hook = nullptr;
    mal_gc_test_trace_env_hook = nullptr;
    mal_gc_test_worker_limit_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    if (!teardown_released || mal_gc_marking_active ||
        mal_gc_black_alloc || mal_gc_poll) return 8;
    puts("gc-concurrent-drain PASS");
    return 0;
}
