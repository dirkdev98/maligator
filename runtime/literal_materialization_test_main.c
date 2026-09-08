#include "vm.h"
#include "vm_ops.h"
#include "array_object.h"
#include "gc.h"
#include "value_ops.h"

#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

static bool failed_mid_graph;

static void fail_after_collection(MalVm *vm) {
    mal_gc_preempt_hook = nullptr;
    mal_gc_collect(vm);
    vm->heap.fail_next_cell_allocation = true;
    failed_mid_graph = true;
}

static bool contains(MalValue value, i32 expected) {
    MalValue element;
    return mal_value_is_array_object(value) &&
        mal_array_object_dense_get(mal_value_to_array_object(value), 0, &element) &&
        mal_ops_is_number(element) && mal_ops_number_as_f64(element) == expected;
}

static int exercise(MalVm *vm, i32 first_slot, i32 deep_offset) {
    if (vm->literal_cache_count != 0 || !mal_value_is_undefined(vm->globals[first_slot])) return 1;
    MalValue live[3] = { MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED };
    MalRootSpan roots;
    mal_gc_root(&roots, live, 3);
    live[0] = mal_vm_instantiate_literal_template(vm, 0, first_slot);
    if (!contains(live[0], 42) || mal_vm_instantiate_literal_template(vm, 0, first_slot) != live[0]) return 2;
    live[1] = mal_vm_instantiate_literal_template(vm, 0, -1);
    live[2] = mal_vm_instantiate_literal_template(vm, 0, -1);
    if (live[1] == live[2] || !contains(live[1], 42) || !contains(live[2], 42)) return 3;
    for (i32 index = 1; index <= MAL_LITERAL_CACHE_CAPACITY; index++) {
        MalValue value = mal_vm_instantiate_literal_template(vm, 0, first_slot + index);
        if (!contains(value, 42)) return 4;
    }
    if (!mal_value_is_undefined(vm->globals[first_slot]) ||
        vm->literal_cache_count != MAL_LITERAL_CACHE_CAPACITY) return 5;
    mal_gc_collect(vm);
    if (!contains(live[0], 42)) return 6;
    live[1] = mal_vm_instantiate_literal_template(vm, 0, first_slot);
    if (live[0] == live[1] || !contains(live[1], 42)) return 7;

    i32 failure_slot = first_slot + MAL_LITERAL_CACHE_CAPACITY + 1;
    vm->heap.fail_next_cell_allocation = true;
    MalValue failed = mal_vm_instantiate_literal_template(vm, 0, failure_slot);
    if (!mal_value_is_undefined(failed) || vm->completion.kind != MAL_COMPLETION_THROW ||
        vm->completion.value != vm->allocation_error ||
        !mal_value_is_undefined(vm->globals[failure_slot])) return 8;
    vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };
    mal_gc_preempt_hook = fail_after_collection;
    mal_gc_poll = true;
    failed = mal_vm_instantiate_literal_template(vm, deep_offset, failure_slot);
    if (!failed_mid_graph || !mal_value_is_undefined(failed) ||
        vm->completion.kind != MAL_COMPLETION_THROW ||
        vm->completion.value != vm->allocation_error ||
        !mal_value_is_undefined(vm->globals[failure_slot])) return 9;
    vm->completion = (MalCompletion) { .kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED };
    live[2] = mal_vm_instantiate_literal_template(vm, deep_offset, failure_slot);
    if (!mal_value_is_array_object(live[2]) ||
        mal_array_object_length(mal_value_to_array_object(live[2])) != 1025 ||
        vm->globals[failure_slot] != live[2]) return 10;
    mal_gc_collect(vm);
    if (!contains(live[0], 42)) return 11;
#if MAL_REALMS
    MalRealm *original = vm->current_realm;
    MalRealm *other = mal_realm_create(vm, nullptr, nullptr);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) return 12;
    mal_realm_switch(vm, other);
    live[2] = mal_vm_instantiate_literal_template(vm, 0, first_slot);
    if (live[2] == live[1] ||
        mal_value_to_object(live[2])->prototype !=
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])) return 13;
    for (i32 index = 1; index <= MAL_LITERAL_CACHE_CAPACITY; index++)
        mal_vm_instantiate_literal_template(vm, 0, first_slot + index);
    if (!mal_value_is_undefined(original->globals[first_slot]) ||
        !mal_value_is_undefined(other->globals[first_slot])) return 14;
    mal_gc_collect(vm);
    if (!contains(live[1], 42) || !contains(live[2], 42)) return 15;
    mal_realm_switch(vm, original);
#endif
    mal_gc_unroot(&roots);
    return 0;
}

int main(void) {
    u32 data[4 + 2 + 1025 * 2] = { 8, 1, 3, 42, 8, 1025 };
    for (i32 index = 0; index < 1025; index++) data[6 + 2 * index] = 9;
    MalRuntimeImage image = mal_runtime_image;
    i32 first_slot = image.global_count;
    image.global_count += MAL_LITERAL_CACHE_CAPACITY + 2;
    image.literal_template_data = data;
    image.literal_template_data_count = sizeof(data) / sizeof(data[0]);
    for (i32 iteration = 0; iteration < 2; iteration++) {
        MalVm vm;
        mal_vm_init(&vm, &image);
        failed_mid_graph = false;
        int code = exercise(&vm, first_slot, 4);
        if (code != 0) {
            fprintf(stderr, "literal-materialization failure %d in VM %d\n", code, iteration);
            return code;
        }
        mal_vm_free(&vm);
    }
    puts("literal-materialization PASS 2/2");
    return 0;
}
