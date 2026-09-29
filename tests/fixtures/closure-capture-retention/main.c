#include <stdio.h>

#include "arguments_object.h"
#include "function_object.h"
#include "gc.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static MalHeapHeader *tracked[4];
static i32 finalized[4];
static MalHeapHeader *borrowed_vector_owner;
static i32 borrowed_vector_finalizations;

static usize no_workers(void) {
    return 0;
}

static void count_finalized(MalHeapHeader *cell) {
    for (usize i = 0; i < countof(tracked); i++) {
        if (tracked[i] == cell) finalized[i]++;
    }
}

static void count_vector_finalized(MalHeapHeader *cell) {
    if (cell == borrowed_vector_owner) borrowed_vector_finalizations++;
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
    MalValue roots[6] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
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
    MalEnv *extra = mal_env_new(&vm, shared, 4, 1);
    extra->slots[0] = tracked_object(&vm, 3);
    roots[4] = mal_vm_op_create_function(&vm, 3, extra);
    MalEnv *left = mal_value_to_function_object(roots[0])->creation_env;
    MalEnv *right = mal_value_to_function_object(roots[1])->creation_env;
    if (!mal_env_is_single_owner(left) || left != right ||
        mal_env_untag_single_owner(left) != shared || roots[0] == roots[1]) return 1;
    MalFunctionObject *multiple_function = mal_value_to_function_object(roots[4]);
    MalEnv *multiple = multiple_function->creation_env;
    if (mal_env_is_single_owner(multiple) ||
        multiple->function_index != MAL_ENV_CAPTURE_VECTOR || multiple->slot_count != 2 ||
        multiple != (MalEnv *) ((MalValue *) (multiple_function + 1) + 2) ||
        multiple->parent != (MalEnv *) multiple_function) return 14;
    if (mal_vm_capture_owner(left, 1) != shared ||
        mal_vm_capture_owner(right, 1) != shared ||
        mal_vm_capture_owner(left, 0) != nullptr ||
        mal_vm_capture_owner(multiple, 1) != shared ||
        mal_vm_capture_owner(multiple, 4) != extra ||
        mal_vm_capture_owner(multiple, 0) != nullptr) return 2;
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 0 ||
        finalized[2] != 0 || finalized[3] != 0) return 3;

    mal_vm_store_captured(left, 1, 0, roots[3]);
    if (mal_vm_load_captured(right, 1, 0) != roots[3] ||
        mal_vm_load_captured(multiple, 1, 0) != roots[3]) return 4;
    const i32 parameter_map[] = { 0 };
    MalArgumentsObject *arguments = mal_arguments_object_new(
        &vm.heap, nullptr, shared, parameter_map, 1, 1);
    roots[2] = mal_value_from_object(&arguments->object);
    // A zero-parameter mapped arguments object can carry its caller's display.
    MalArgumentsObject *empty_arguments = mal_arguments_object_new(
        &vm.heap, nullptr, left, nullptr, 0, 0);
    roots[5] = mal_value_from_object(&empty_arguments->object);
    roots[0] = roots[1] = roots[3] = roots[4] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[1] != 1 || finalized[2] != 0 || finalized[3] != 1) return 5;
    if (mal_value_to_heap(arguments->env->slots[0]) != tracked[2]) return 6;
    roots[2] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[2] != 0) return 15;
    if (mal_value_to_heap(mal_vm_load_captured(empty_arguments->env, 1, 0)) != tracked[2]) {
        return 16;
    }
    roots[5] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[2] != 1) return 7;

    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalEnv *discarded = mal_env_new(&vm, nullptr, 0, 1);
    discarded->slots[0] = tracked_object(&vm, 0);
    MalEnv *selected = mal_env_new(&vm, discarded, 1, 1);
    selected->slots[0] = tracked_object(&vm, 1);
    roots[0] = mal_vm_op_create_function(&vm, 2, selected);
    MalEnv *tagged = mal_value_to_function_object(roots[0])->creation_env;
    MalEnv *exact = mal_env_new(&vm, tagged, 4, 1);
    exact->slots[0] = tracked_object(&vm, 2);
    roots[1] = mal_vm_op_create_function(&vm, 3, exact);
    if (mal_value_to_function_object(roots[1])->creation_env != exact) return 28;
    MalEnv *duplicate = mal_env_new(&vm, exact, 4, 1);
    duplicate->slots[0] = mal_value_from_i32(64);
    roots[2] = mal_vm_op_create_function(&vm, 3, duplicate);
    MalEnv *deduplicated = mal_value_to_function_object(roots[2])->creation_env;
    if (mal_env_is_single_owner(deduplicated) ||
        deduplicated->function_index != MAL_ENV_CAPTURE_VECTOR ||
        mal_vm_capture_owner(deduplicated, 4) != duplicate) return 29;
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 0 || finalized[2] != 0) return 30;
    roots[1] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[1] != 0 || finalized[2] != 1 ||
        mal_vm_load_captured(deduplicated, 4, 0) != mal_value_from_i32(64)) return 31;
    roots[2] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[1] != 0 || mal_vm_capture_owner(tagged, 4) != nullptr) return 32;
    roots[0] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (finalized[1] != 1) return 33;

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

static int check_single_owner_frame(const MalRuntimeImage *image) {
    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalVm vm;
    mal_vm_init(&vm, image);
    MalEnv *unrelated = mal_env_new(&vm, nullptr, 0, 1);
    unrelated->slots[0] = tracked_object(&vm, 0);
    MalEnv *selected = mal_env_new(&vm, unrelated, 1, 1);
    selected->slots[0] = tracked_object(&vm, 1);
    MalEnv *tagged = mal_env_tag_single_owner(selected);
    MalVmFrame scope_frame = { .vm = &vm, .env = tagged };
    const MalInstruction scope = {
        .opcode = MAL_OP_ENV_PUSH, .as.env_scope = { .scope_id = -2, .slot_count = 1 }
    };
    mal_op_env_push(&scope_frame, &scope);
    MalEnv *first_loop = scope_frame.env;
    first_loop->slots[0] = mal_value_from_i32(7);
    mal_op_env_copy(&scope_frame, &scope);
    if (scope_frame.env == first_loop || scope_frame.env->parent != tagged ||
        scope_frame.env->slots[0] != mal_value_from_i32(7)) return 21;
    mal_op_env_pop(&scope_frame);
    if (scope_frame.env != tagged) return 22;
    mal_op_env_push(&scope_frame, &scope);
    MalEnv *loop = scope_frame.env;
    const MalFrameDescriptor descriptor = { .function_index = 4, .slot_count = 0 };
    MalRootFrame frame = {
        .prev = mal_root_frame_head, .desc = &descriptor, .slots = nullptr,
        .inactive_slots = 0, .env = loop
    };
    mal_root_frame_head = &frame;
    mal_gc_collect(&vm);
    if (finalized[0] != 1 || finalized[1] != 0) return 17;
    if (mal_value_to_heap(mal_vm_load_captured(loop, 1, 0)) != tracked[1]) return 18;
    mal_root_frame_head = frame.prev;
    mal_gc_collect(&vm);
    if (finalized[1] != 1) return 19;
    mal_vm_free(&vm);
    return 0;
}

static int check_lookup_and_reexport(const MalRuntimeImage *image) {
    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalVm vm;
    mal_vm_init(&vm, image);
    MalValue roots[3] = {
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalEnv *base = mal_env_new(&vm, nullptr, 0, 1);
    base->slots[0] = mal_value_from_i32(100);
    MalEnv *original = mal_env_new(&vm, base, 1, 1);
    original->slots[0] = mal_value_from_i32(11);
    MalEnv *unselected = mal_env_new(&vm, original, 3, 0);
    MalEnv *forwarded = mal_env_new(&vm, unselected, 4, 1);
    forwarded->slots[0] = mal_value_from_i32(44);
    roots[0] = mal_vm_op_create_function(&vm, 5, forwarded);
    MalEnv *source = mal_value_to_function_object(roots[0])->creation_env;
    if (mal_env_is_single_owner(source) ||
        source->function_index != MAL_ENV_CAPTURE_VECTOR) return 34;
    // The same lexical owner can occur in a nearer recursive activation.
    MalEnv *nearest = mal_env_new(&vm, source, 1, 1);
    nearest->slots[0] = mal_value_from_i32(22);
    MalEnv *prefix = mal_env_new(&vm, nearest, 0, 1);
    prefix->slots[0] = mal_value_from_i32(200);
    if (mal_vm_capture_owner_at(prefix, 1, 0) != nearest ||
        mal_vm_capture_owner_at(prefix, 4, 1) != forwarded ||
        mal_vm_capture_owner_at(source, 1, 1) != original ||
        mal_vm_capture_owner_at(source, 4, 2) != forwarded) return 23;
    // Ordinals belong to the requested layout, not necessarily the incoming display.
    if (mal_vm_capture_owner_at(source, 4, 0) != forwarded ||
        mal_vm_capture_owner_at(source, 1, 8) != original ||
        mal_vm_capture_owner_at(source, 2, 1) != nullptr) return 24;
    roots[1] = mal_vm_op_create_function(&vm, 3, prefix);
    roots[2] = mal_vm_op_create_function(&vm, 2, prefix);
    MalEnv *selected = mal_value_to_function_object(roots[1])->creation_env;
    MalEnv *single = mal_value_to_function_object(roots[2])->creation_env;
    if (mal_vm_capture_owner_at(selected, 1, 0) != nearest ||
        mal_vm_capture_owner_at(selected, 4, 1) != forwarded ||
        mal_vm_capture_owner(selected, 0) != nullptr ||
        mal_vm_capture_owner_at(single, 1, 0) != nearest ||
        mal_vm_capture_owner_at(single, 1, 8) != nearest ||
        mal_vm_capture_owner_at(single, 4, 0) != nullptr) return 25;
    mal_vm_store_captured(selected, 1, 0, mal_value_from_i32(33));
    mal_vm_store_captured(selected, 4, 0, mal_value_from_i32(55));
    if (mal_vm_load_captured(source, 1, 0) != mal_value_from_i32(11) ||
        mal_vm_load_captured(single, 1, 0) != mal_value_from_i32(33) ||
        mal_vm_load_captured(source, 4, 0) != mal_value_from_i32(55)) return 26;
    roots[0] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (mal_vm_capture_owner_at(selected, 1, 1) != nearest ||
        mal_vm_capture_owner_at(selected, 4, 0) != forwarded ||
        mal_vm_capture_owner_at(single, 4, 0) != nullptr ||
        mal_vm_load_captured(selected, 1, 0) != mal_value_from_i32(33) ||
        mal_vm_load_captured(selected, 4, 0) != mal_value_from_i32(55)) return 27;
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return 0;
}

static int check_fallback_vector_ownership(const MalRuntimeImage *image) {
    for (usize i = 0; i < countof(tracked); i++) tracked[i] = nullptr;
    MalVm vm;
    mal_vm_init(&vm, image);
    MalValue roots[2] = { mal_value_new_undefined(), mal_value_new_undefined() };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalEnv *base = mal_env_new(&vm, nullptr, 0, 1);
    base->slots[0] = tracked_object(&vm, 0);
    MalEnv *middle = mal_env_new(&vm, base, 1, 1);
    middle->slots[0] = tracked_object(&vm, 1);
    MalEnv *unselected = mal_env_new(&vm, middle, 3, 0);
    MalEnv *last = mal_env_new(&vm, unselected, 4, 1);
    last->slots[0] = tracked_object(&vm, 2);
    MalValue source = mal_vm_op_create_function(&vm, 5, last);
    MalFunctionObject *source_function = mal_value_to_function_object(source);
    MalEnv *display = source_function->creation_env;
    if (mal_env_is_single_owner(display) ||
        display->function_index != MAL_ENV_CAPTURE_VECTOR) return 36;
    borrowed_vector_owner = &source_function->object.header;
    borrowed_vector_finalizations = 0;
    roots[0] = mal_vm_op_create_function(&vm, 6, display);
    if (mal_value_to_function_object(roots[0])->creation_env != display) return 37;
    mal_gc_collect(&vm);
    if (borrowed_vector_finalizations != 0) return 38;
    if (mal_value_to_heap(mal_vm_load_captured(display, 1, 0)) != tracked[1]) return 39;

    roots[1] = mal_vm_op_create_function(&vm, 7, display);
    if (mal_value_to_function_object(roots[1])->creation_env != display) return 40;
    roots[0] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (borrowed_vector_finalizations != 0) return 41;
    if (mal_value_to_heap(mal_vm_load_captured(display, 4, 0)) != tracked[2] ||
        !mal_value_is_undefined(mal_vm_load_captured(display, 6, 0))) return 42;
    roots[1] = mal_value_new_undefined();
    mal_gc_collect(&vm);
    if (borrowed_vector_finalizations != 1 ||
        finalized[0] != 1 || finalized[1] != 1 || finalized[2] != 1) return 43;
    borrowed_vector_owner = nullptr;
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
    MalEnv *single = mal_env_new(&vm, nullptr, 1, 1);
    single->slots[0] = tracked_object(&vm, 0);
    MalValue single_closure = mal_vm_op_create_function(&vm, 2, single);
    MalVmFrame single_frame = {
        .env = mal_value_to_function_object(single_closure)->creation_env
    };
    MalEnv *first = mal_env_new(&vm, nullptr, 1, 1);
    first->slots[0] = tracked_object(&vm, 1);
    MalEnv *unselected = mal_env_new(&vm, first, 0, 0);
    MalEnv *second = mal_env_new(&vm, unselected, 4, 1);
    second->slots[0] = tracked_object(&vm, 2);
    MalValue multiple_closure = mal_vm_op_create_function(&vm, 3, second);
    MalVmFrame multiple_frame = {
        .env = mal_value_to_function_object(multiple_closure)->creation_env
    };
    if (mal_env_is_single_owner(multiple_frame.env) ||
        multiple_frame.env->function_index != MAL_ENV_CAPTURE_VECTOR) return 35;
    MalEnv *parent = mal_env_new(&vm, nullptr, 0, 1);
    parent->slots[0] = tracked_object(&vm, 3);
    MalEnv *child = mal_env_new(&vm, parent, 1, 0);
    vm.heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(&vm);
    if (!mal_gc_marking_active) return 10;
    mal_gc_satb_shade_frame(&single_frame);
    mal_gc_satb_shade_frame(&multiple_frame);
    mal_gc_write_barrier_env(child);
    if (!mal_gc_finish_pending_cycle(&vm)) return 11;
    for (usize i = 0; i < countof(tracked); i++) {
        if (finalized[i] != 0) return 12;
    }
    if (mal_value_to_heap(mal_vm_load_captured(single_frame.env, 1, 0)) != tracked[0] ||
        mal_value_to_heap(mal_vm_load_captured(multiple_frame.env, 1, 0)) != tracked[1] ||
        mal_value_to_heap(mal_vm_load_captured(multiple_frame.env, 4, 0)) != tracked[2]) return 20;
    mal_gc_collect(&vm);
    for (usize i = 0; i < countof(tracked); i++) {
        if (finalized[i] != 1) return 13;
    }
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    return 0;
}

int main(void) {
    const i32 empty_layout[] = { 0 };
    const i32 captured_owner[] = { 1 };
    const i32 captured_owners[] = { 1, 4 };
    const i32 all_owners[] = { 0, 1, 4 };
    const i32 incomplete_owners[] = { 0, 1, 4, 6 };
    MalFunction functions[8];
    for (usize i = 0; i < countof(functions); i++) {
        functions[i] = mal_runtime_image.functions[0];
        functions[i].closure_capture_owners = i == 2 ? captured_owner
            : i == 3 ? captured_owners : i == 5 ? all_owners : empty_layout;
        functions[i].closure_capture_owner_count = i == 2 ? 1 : i == 3 ? 2 : i == 5 ? 3 : 0;
    }
    functions[6].closure_capture_owners = nullptr;
    functions[6].closure_capture_owner_count = -1;
    functions[7].closure_capture_owners = incomplete_owners;
    functions[7].closure_capture_owner_count = countof(incomplete_owners);
    MalRuntimeImage image = mal_runtime_image;
    image.functions = functions;
    image.function_count = countof(functions);
    mal_gc_test_worker_limit_hook = no_workers;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_finalized);
    mal_gc_register_finalizer(MAL_HEAP_FUNCTION_OBJECT, count_vector_finalized);
    int result = check_retention(&image);
    if (result == 0) result = check_single_owner_frame(&image);
    if (result == 0) result = check_lookup_and_reexport(&image);
    if (result == 0) result = check_fallback_vector_ownership(&image);
    if (result == 0) result = check_snapshot(&image);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_register_finalizer(MAL_HEAP_FUNCTION_OBJECT, nullptr);
    mal_gc_test_worker_limit_hook = nullptr;
    if (result != 0) {
        fprintf(stderr, "closure-capture-retention failed at %d\n", result);
        return result;
    }
    puts("closure-capture-retention PASS");
    return 0;
}
