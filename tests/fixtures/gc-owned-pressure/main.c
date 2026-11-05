#include <stdio.h>
#include <stdlib.h>
#include "array_object.h"
#include "gc.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static void grow_and_drop(MalValue *value) {
    MalArrayObject *array = mal_value_to_array_object(*value);
    if (!mal_array_object_dense_reserve_exact(array, (4u << 20) / sizeof(MalValue))) abort();
    *value = mal_value_new_undefined();
}

int main(void) {
    // Explicit roots keep stale native pointers from masking owner reclamation.
    mal_gc_test_precise_stack_roots = true;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalValue values[17];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalEnv *env = mal_env_new(&vm, nullptr, -1, (40u << 20) / sizeof(MalValue));
    values[0] = mal_value_from_heap(&env->header);
    for (usize i = 1; i < countof(values); i++) {
        values[i] = mal_value_from_array_object(mal_array_object_new(&vm.heap, nullptr));
    }
    mal_gc_collect(&vm);
    usize baseline_live = vm.heap.live_bytes;
    usize baseline_raw = vm.heap.current_usage.raw_owned_bytes;
    if (baseline_live <= (32u << 20)) abort();
    for (usize i = 1; i < countof(values); i++) {
        grow_and_drop(&values[i]);
        vm.heap.next_gc_at = 1;
        mal_gc_poll = true;
        mal_gc_safepoint(&vm);
        mal_gc_finish_pending_cycle(&vm);
    }
    usize automatic_raw = vm.heap.current_usage.raw_owned_bytes;
    mal_gc_collect(&vm);
    usize explicit_raw = vm.heap.current_usage.raw_owned_bytes;
    bool reclaimed = automatic_raw < baseline_raw + (32u << 20) &&
        explicit_raw <= baseline_raw;
    mal_gc_unroot(&root);
    mal_vm_free(&vm);
    if (!reclaimed) {
        fprintf(stderr, "RAW baseline=%zu automatic=%zu explicit=%zu\n",
            baseline_raw, automatic_raw, explicit_raw);
        return 1;
    }
    puts("gc-owned-pressure PASS");
    return 0;
}
