#include <stdio.h>
#include <string.h>

#include "gc.h"
#include "heap.h"
#include "host.h"
#include "object.h"
#include "scheduler.h"
#include "vm.h"
#include "web_host_timer.h"

extern const MalRuntimeImage mal_runtime_image;

static MalObject *dead_target;
static u32 finalized;
static u32 idle_calls;

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

static bool start_major_on_idle(MalVm *vm) {
    idle_calls++;
    if (idle_calls != 1) return false;
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    return true;
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
    if (boundary != 3) {
        vm.heap.next_gc_at = 1;
        mal_gc_poll = true;
        mal_gc_safepoint(&vm);
        if (!mal_gc_marking_active) return 2;
        mal_gc_safepoint(&vm);
        if (!mal_gc_marking_active) return 3;
    } else {
        idle_calls = 0;
        mal_host_register_idle_notify(start_major_on_idle);
    }

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
    if (boundary == 3) mal_host_register_idle_notify(nullptr);

    if (mal_gc_marking_active || vm.heap.sweeping || finalized != 1) return 4;
    if (boundary == 1 && (!observation.fired || !observation.gc_finished)) return 5;
    if (boundary == 3 && idle_calls != 1) return 6;
    mal_gc_collect(&vm);
    mal_gc_unroot(&span);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    mal_gc_test_worker_limit_hook = nullptr;
    return 0;
}

static int check_backstop(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 1;
    void *raw = mal_heap_alloc_raw(&vm.heap, 8 * 1024 * 1024);
    mal_gc_safepoint(&vm);
    if (mal_gc_marking_active || vm.heap.sweeping) return 2;
    gc_free_raw(&vm.heap, raw);
    mal_vm_free(&vm);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "backstop") == 0) {
        if (check_backstop() != 0) return 1;
        puts("gc-idle-completion PASS");
        return 0;
    }
    int first = 0;
    int last = 4;
    if (argc == 2) {
        if (argv[1][0] < '0' || argv[1][0] > '3' || argv[1][1] != '\0') return 1;
        first = argv[1][0] - '0';
        last = first + 1;
    }
    for (int boundary = first; boundary < last; ++boundary) {
        int result = check_idle_boundary(boundary);
        if (result != 0) return 10 * boundary + result;
    }
    puts("gc-idle-completion PASS");
    return 0;
}
