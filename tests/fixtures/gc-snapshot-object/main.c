#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <time.h>

#include "gc.h"
#include "heap_string.h"
#include "object.h"
#include "object_ops.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static _Atomic bool worker_entered;
static bool release_worker;
static MalObject *paused_owner;
static MalObject *overwritten_target;
static MalObject *untouched_target;
static u32 overwritten_finalized;
static u32 untouched_finalized;

static void pause_snapshot_trace(MalHeapHeader *cell) {
    if ((void *) cell != (void *) paused_owner) return;
    pthread_mutex_lock(&gate_mutex);
    worker_entered = true;
    pthread_cond_signal(&gate_cond);
    while (!release_worker) pthread_cond_wait(&gate_cond, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) overwritten_target) overwritten_finalized++;
    if ((void *) cell == (void *) untouched_target) untouched_finalized++;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    MalKey first = mal_key_from_value(mal_value_from_string(
        mal_string_new_ascii(&vm.heap, (const byte *) "first", 5)));
    MalKey second = mal_key_from_value(mal_value_from_string(
        mal_string_new_ascii(&vm.heap, (const byte *) "second", 6)));
    MalValue roots[40];
    MalObject *owners[40];
    for (usize i = 0; i < countof(roots); ++i) {
        owners[i] = mal_object_new(&vm.heap, nullptr);
        MalObject *first_child = mal_object_new(&vm.heap, nullptr);
        MalObject *second_child = mal_object_new(&vm.heap, nullptr);
        if (i == 0) {
            paused_owner = owners[i];
            overwritten_target = first_child;
            untouched_target = second_child;
        }
        if (!mal_object_set(owners[i], first, mal_value_from_object(first_child)) ||
            !mal_object_set(owners[i], second, mal_value_from_object(second_child))) return 1;
        roots[i] = mal_value_from_object(owners[i]);
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
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
    if (mal_heap_mark_is_current(untouched_target->header.mark, vm.heap.mark_color)) return 4;

    MalObject *replacement = mal_object_new(&vm.heap, nullptr);
    MalObject *new_property = mal_object_new(&vm.heap, nullptr);
    MalObject *indexed = mal_object_new(&vm.heap, nullptr);
    MalKey third = mal_key_from_value(mal_value_from_string(
        mal_string_new_ascii(&vm.heap, (const byte *) "third", 5)));
    if (!mal_object_set(paused_owner, first, mal_value_from_object(replacement)) ||
        !mal_object_set(paused_owner, third, mal_value_from_object(new_property)) ||
        !mal_object_set(paused_owner, mal_key_index(0), mal_value_from_object(indexed))) return 5;

    pthread_mutex_lock(&gate_mutex);
    release_worker = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);

    deadline = time(nullptr) + 30;
    while (mal_gc_black_alloc && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_black_alloc || overwritten_finalized != 0 || untouched_finalized != 0) return 6;
    mal_gc_collect(&vm);
    MalPropertyLookup kept = mal_object_get_own(paused_owner, second);
    MalPropertyLookup new_first = mal_object_get_own(paused_owner, first);
    MalPropertyLookup new_third = mal_object_get_own(paused_owner, third);
    MalPropertyLookup new_index = mal_object_get_own(paused_owner, mal_key_index(0));
    if (overwritten_finalized != 1 || untouched_finalized != 0 ||
        !kept.present || kept.desc.value != mal_value_from_object(untouched_target) ||
        !new_first.present || new_first.desc.value != mal_value_from_object(replacement) ||
        !new_third.present || new_third.desc.value != mal_value_from_object(new_property) ||
        !new_index.present || new_index.desc.value != mal_value_from_object(indexed)) return 7;

    mal_gc_unroot(&span);
    mal_gc_test_trace_snapshot_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-snapshot-object PASS");
    return 0;
}
