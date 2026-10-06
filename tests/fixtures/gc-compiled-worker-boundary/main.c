#include <pthread.h>
#include <sched.h>
#include <stdio.h>
#include <time.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static pthread_mutex_t gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t gate_cond = PTHREAD_COND_INITIALIZER;
static _Atomic bool worker_entered;
static bool worker_released;
static MalObject *receiver;
static MalObject *old_first;
static MalObject *returned_object;
static MalValue returned_token;
static i32 getter_index;
static bool expect_return_poll;
static bool observed_return_poll;
static bool observed_publication;
static bool worker_requested_poll;
static u32 old_first_finalized;
static u32 returned_finalized;

static MalValue global_property(MalVm *vm, const byte *name) {
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    MalPropertyLookup found = mal_object_get_own(global, mal_intrinsic_string_key(vm, name));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

static void pause_worker_snapshot(MalHeapHeader *cell) {
    (void) cell;
    pthread_mutex_lock(&gate_mutex);
    worker_entered = true;
    pthread_cond_signal(&gate_cond);
    while (!worker_released) pthread_cond_wait(&gate_cond, &gate_mutex);
    pthread_mutex_unlock(&gate_mutex);
}

static void release_snapshot_worker(void) {
    pthread_mutex_lock(&gate_mutex);
    worker_released = true;
    pthread_cond_broadcast(&gate_cond);
    pthread_mutex_unlock(&gate_mutex);
}

static void observe_return_poll(MalVm *vm) {
    (void) vm;
    if (!expect_return_poll || observed_return_poll) return;
    observed_return_poll = true;
    for (MalRootFrame *frame = mal_root_frame_head; frame != nullptr; frame = frame->prev) {
        for (i32 slot = 0; slot < frame->desc->slot_count; ++slot) {
            bool active = !mal_gc_root_frame_slot_is_inactive(frame, slot);
            if (active && frame->slots[slot] == returned_token) {
                observed_publication = true;
            }
        }
    }
}

static void count_finalized(MalHeapHeader *cell) {
    if ((void *) cell == (void *) old_first) old_first_finalized++;
    if ((void *) cell == (void *) returned_object) returned_finalized++;
}

static MalValue release_worker(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalObject *token = mal_object_new(&vm->heap, nullptr);
    if (!mal_object_set(token, mal_intrinsic_string_key(vm, "marker"),
                        mal_value_from_i32(101))) return mal_value_new_undefined();
    returned_object = token;
    returned_token = mal_value_from_object(token);
    release_snapshot_worker();
    time_t deadline = time(nullptr) + 30;
    while (!mal_gc_poll && time(nullptr) < deadline) sched_yield();
    worker_requested_poll = mal_gc_poll;
    expect_return_poll = true;
    return returned_token;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_gc_worker_limit(&vm) == 0) {
        mal_vm_free(&vm);
        puts("gc-compiled-worker-boundary SKIP");
        return 0;
    }
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_method(&vm, global, "__gcReleaseWorker", release_worker);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_vm_free_callable(callable);
    if (vm.completion.kind == MAL_COMPLETION_THROW) return 1;

    MalValue roots[42];
    roots[0] = global_property(&vm, "__gcReceiver");
    roots[40] = global_property(&vm, "__gcRun");
    roots[41] = global_property(&vm, "__gcGetter");
    if (!mal_value_is_object(roots[0]) ||
        !mal_value_is_function_object(roots[40]) ||
        !mal_value_is_function_object(roots[41])) return 2;
    MalKey child_key = mal_intrinsic_string_key(&vm, "child");
    for (usize i = 1; i < 40; ++i) {
        MalObject *owner = mal_object_new(&vm.heap, nullptr);
        MalObject *child = mal_object_new(&vm.heap, nullptr);
        if (!mal_object_set(owner, child_key, mal_value_from_object(child))) return 2;
        roots[i] = mal_value_from_object(owner);
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, (i32) countof(roots));
    receiver = mal_value_to_object(roots[0]);
    getter_index = mal_function_object_function_index(
        mal_value_to_function_object(roots[41]));
    if (getter_index < 0 || getter_index >= vm.runtime_image->function_count ||
        vm.runtime_image->functions[getter_index].compiled == nullptr) return 3;
    MalPropertyLookup first = mal_object_get_own(
        receiver, mal_intrinsic_string_key(&vm, "first"));
    if (!first.present || !mal_value_is_object(first.desc.value)) return 4;
    old_first = mal_value_to_object(first.desc.value);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    mal_gc_test_trace_snapshot_hook = pause_worker_snapshot;

    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 5;
    time_t deadline = time(nullptr) + 30;
    while (!worker_entered && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (!worker_entered) return 6;
    vm.heap.next_gc_at = SIZE_MAX;
    mal_gc_poll = false;
    void (*previous_preempt_hook)(MalVm *) = mal_gc_preempt_hook;
    mal_gc_preempt_hook = observe_return_poll;
    MalCompletion result = mal_vm_call_value(
        &vm, roots[40], mal_value_new_undefined(), nullptr, 0);
    mal_gc_preempt_hook = previous_preempt_hook;
    release_snapshot_worker();
    if (result.kind != MAL_COMPLETION_NORMAL || !mal_value_is_int32(result.value) ||
        mal_value_to_i32(result.value) != 305) return 8;
    if (!worker_requested_poll || !observed_return_poll || !observed_publication) return 9;

    deadline = time(nullptr) + 30;
    while ((mal_gc_marking_active || vm.heap.sweeping) && time(nullptr) < deadline) {
        mal_gc_safepoint(&vm);
        sched_yield();
    }
    if (mal_gc_marking_active || vm.heap.sweeping ||
        old_first_finalized != 0 || returned_finalized != 0) return 10;
    mal_gc_collect(&vm);
    if (old_first_finalized != 1 || returned_finalized != 1) return 11;

    mal_gc_unroot(&span);
    mal_gc_test_trace_snapshot_hook = nullptr;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_vm_free(&vm);
    puts("gc-compiled-worker-boundary PASS");
    return 0;
}
