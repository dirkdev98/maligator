#include <stdio.h>

#include "arguments_object.h"
#include "function_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static MalHeapHeader *tracked[3];
static i32 finalized[3];

static usize no_workers(void) {
    return 0;
}

static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(tracked); i++) {
        if (tracked[i] == cell) finalized[i]++;
    }
}

static MalValue tracked_object(MalVm *vm, usize index) {
    MalObject *object = mal_object_new(&vm->heap, nullptr);
    tracked[index] = &object->header;
    finalized[index] = 0;
    return mal_value_from_object(object);
}

static int check_retention(const MalRuntimeImage *image) {
    MalVm vm;
    mal_vm_init(&vm, image);
    MalValue roots[4] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalEnv *unrelated = mal_env_new(&vm, nullptr, 0, 1);
    unrelated->slots[0] = tracked_object(&vm, 0);
    MalEnv *shared = mal_env_new(&vm, unrelated, 1, 1);
    shared->slots[0] = tracked_object(&vm, 1);
    roots[3] = tracked_object(&vm, 2);
    roots[0] = mal_vm_op_create_function(&vm, 2, shared);
    roots[1] = mal_vm_op_create_function(&vm, 2, shared);
    MalEnv *left = mal_value_to_function_object(roots[0])->creation_env;
    MalEnv *right = mal_value_to_function_object(roots[1])->creation_env;
    if (left->function_index != MAL_ENV_CAPTURE_VECTOR ||
        right->function_index != MAL_ENV_CAPTURE_VECTOR || left == right) return 1;
    if (mal_vm_capture_owner(left, 1) != shared ||
        mal_vm_capture_owner(right, 1) != shared) return 2;
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 0 || finalized[2] != 0) return 3;

    mal_vm_store_captured(left, 1, 0, roots[3]);
    if (mal_vm_load_captured(right, 1, 0) != roots[3]) return 4;
    const i32 parameter_map[] = { 0 };
    MalArgumentsObject *arguments = mal_arguments_object_new(
        &vm.heap, nullptr, shared, parameter_map, 1, 1);
    roots[2] = mal_value_from_object(&arguments->object);
    roots[0] = roots[1] = roots[3] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[1] != 1 || finalized[2] != 0) return 5;
    if (mal_value_to_heap(arguments->env->slots[0]) != tracked[2]) return 6;
    roots[2] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[2] != 1) return 7;

    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalEnv *active_parent = mal_env_new(&vm, nullptr, 0, 1);
    active_parent->slots[0] = tracked_object(&vm, 0);
    MalEnv *active_child = mal_env_new(&vm, active_parent, 1, 0);
    const MalFrameDescriptor descriptor = { .function_index = 1, .slot_count = 0 };
    MalRootFrame frame = {
        .prev = mal_root_frame_head, .desc = &descriptor, .slots = nullptr,
        .inactive_slots = 0, .env = active_child
    };
    mal_root_frame_head = &frame;
    mal_gc_collect(&vm);
    if (finalized[0] != 0) return 8;
    mal_root_frame_head = frame.prev;
    mal_gc_collect(&vm);
    if (finalized[0] != 1) return 9;
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return 0;
}

static int check_snapshot(const MalRuntimeImage *image) {
    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalVm vm;
    mal_vm_init(&vm, image);
    // Keep the initial major cycle open until the teardown barriers run.
    MalEnv *ballast = mal_env_new(&vm, nullptr, 99, 9000);
    for (i32 i = 0; i < ballast->slot_count; i++) {
        ballast->slots[i] = mal_value_from_object(mal_object_new(&vm.heap, nullptr));
    }
    MalValue root = mal_value_from_heap(&ballast->header);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    MalEnv *parent = mal_env_new(&vm, nullptr, 0, 1);
    parent->slots[0] = tracked_object(&vm, 0);
    MalEnv *child = mal_env_new(&vm, parent, 1, 1);
    child->slots[0] = tracked_object(&vm, 1);
    MalValue closure = mal_vm_op_create_function(&vm, 2, child);
    MalVmFrame frame = { .env = mal_value_to_function_object(closure)->creation_env };
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 10;
    mal_gc_satb_shade_frame(&frame);
    mal_gc_write_barrier_env(child);
    if (!mal_gc_finish_pending_cycle(&vm)) return 11;
    if (finalized[0] != 0 || finalized[1] != 0) return 12;
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 1) return 13;
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return 0;
}

int main(void) {
    const i32 empty_layout[] = { 0 };
    const i32 captured_owner[] = { 1 };
    MalFunction functions[3];
    for (usize i = 0; i < countof(functions); i++) {
        functions[i] = mal_runtime_image.functions[0];
        functions[i].closure_capture_owners = i == 2 ? captured_owner : empty_layout;
        functions[i].closure_capture_owner_count = i == 2 ? 1 : 0;
    }
    MalRuntimeImage image = mal_runtime_image;
    image.functions = functions;
    image.function_count = countof(functions);
    mal_gc_test_worker_limit_hook = no_workers;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    int result = check_retention(&image);
    if (result == 0) result = check_snapshot(&image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_test_worker_limit_hook = nullptr;
    if (result != 0) {
        fprintf(stderr, "closure-capture-retention failed at %d\n", result);
        return result;
    }
    puts("closure-capture-retention PASS");
    return 0;
}
