#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <time.h>

#include "array_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static _Atomic bool worker_entered;
static bool release_worker;
static MalArrayObject *target_array;
static MalObject *targets[128];
static u32 finalized[128];

static void pause_snapshot_trace(MalHeapHeader *cell) {
    if (cell != &target_array->object.header) return;
    pthread_mutex_lock(&gate_mutex);
    worker_entered = true;
    pthread_cond_signal(&gate_cond);
    while (!release_worker) pthread_cond_wait(&gate_cond, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(targets); ++i) {
        if ((void *) cell == (void *) targets[i]) finalized[i]++;
    }
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    target_array = mal_array_object_new(&vm.heap, nullptr);
    MalValue root = mal_value_from_object((MalObject *) target_array);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    for (usize i = 0; i < countof(targets); ++i) {
        targets[i] = mal_object_new(&vm.heap, nullptr);
        if (!mal_array_object_fresh_dense_append(target_array,
            mal_value_from_object(targets[i]))) return 1;
    }
    mal_gc_test_trace_snapshot_hook = pause_snapshot_trace;

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 2;
    time_t deadline = time(nullptr) + 30;
    while (!worker_entered && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        pthread_mutex_lock(&gate_mutex);
        if (!worker_entered) {
            struct timespec worker_deadline;
            timespec_get(&worker_deadline, TIME_UTC);
            worker_deadline.tv_sec += 1;
            pthread_cond_timedwait(&gate_cond, &gate_mutex, &worker_deadline);
        }
        pthread_mutex_unlock(&gate_mutex);
    }
    if (!worker_entered) return 3;
    if (mal_heap_mark_is_current(targets[1]->header.mark, vm.heap.mark_color)) return 4;

    MalObject *replacement = mal_object_new(&vm.heap, nullptr);
    mal_gc_write_barrier(target_array->elements[0]);
    target_array->elements[0] = mal_value_from_object(replacement);
    mal_gc_card(&target_array->object.header, target_array->elements[0]);
    mal_array_object_dense_delete(target_array, 2);
    mal_array_object_set_length(target_array, 3);

    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);

    deadline = time(nullptr) + 30;
    while (mal_gc_black_alloc && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_black_alloc) return 5;
    for (usize i = 0; i < countof(targets); ++i) {
        if (finalized[i] != 0) return 6;
    }
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 0 || finalized[2] != 1 ||
        finalized[3] != 1 || target_array->elements[0] != mal_value_from_object(replacement) ||
        target_array->elements[1] != mal_value_from_object(targets[1])) return 7;

    mal_gc_unroot(&span);
    mal_gc_test_trace_snapshot_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-snapshot-overlap PASS");
    return 0;
}
