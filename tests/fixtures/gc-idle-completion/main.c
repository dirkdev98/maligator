#include <stdio.h>

#include "gc.h"
#include "host.h"
#include "object.h"
#include "scheduler.h"
#include "vm.h"
#include "web_host_timer.h"

extern const MalRuntimeImage mal_runtime_image;

static MalObject *dead_target;
static u32 finalized;

static usize one_worker(void) {
    return 1;
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) dead_target) finalized++;
}

typedef struct TimerObservation {
    MalVm *vm;
    bool fired;
    bool gc_finished;
} TimerObservation;

static void observe_timer(void *data) {
    TimerObservation *observation = data;
    observation->fired = true;
    observation->gc_finished = !mal_gc_marking_active && !observation->vm->heap.sweeping;
}

static int check_idle_boundary(int boundary) {
    mal_gc_test_worker_limit_hook = one_worker;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_host_attach(&vm);
    if (mal_gc_worker_limit(&vm) != 1) return 1;
    finalized = 0;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);

    MalValue roots[1024];
    for (usize i = 0; i < countof(roots); ++i) {
        MalEnv *env = mal_env_new(&vm, nullptr, (i32) i, 1);
        env->slots[0] = mal_value_from_object(mal_object_new(&vm.heap, nullptr));
        roots[i] = mal_value_from_heap(&env->header);
    }
    dead_target = mal_object_new(&vm.heap, nullptr);
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 2;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 3;

    TimerObservation observation = {.vm = &vm};
    MalTimer timer = {
        .deadline_ns = mal_reactor_now_ns() + 50000000,
        .waker = {.fn = observe_timer, .data = &observation},
        .heap_index = -1,
    };
    if (boundary == 1) mal_reactor_add_timer(&mal_host(&vm)->reactor, &timer);
    if (boundary == 2) {
        MalScheduler scheduler;
        mal_sched_init(&scheduler, &vm);
        mal_sched_run(&scheduler);
        mal_sched_shutdown();
    } else {
        mal_host_run_event_loop(&vm);
    }

    if (mal_gc_marking_active || vm.heap.sweeping || finalized != 1) return 4;
    if (boundary == 1 && (!observation.fired || !observation.gc_finished)) return 5;
    mal_gc_unroot(&span);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    return 0;
}

int main(void) {
    for (int boundary = 0; boundary < 3; ++boundary) {
        int result = check_idle_boundary(boundary);
        if (result != 0) return 10 * boundary + result;
    }
    puts("gc-idle-completion PASS");
    return 0;
}
