#include "vm.h"
#include "vm_ops.h"
#include "value_ops.h"

#include <stdio.h>

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (vm.literal_shape_cache[0] == nullptr ||
        vm.literal_shape_cache[0][1] == nullptr ||
        vm.literal_shape_cache[0][2] == nullptr ||
        vm.property_cache[0].sites != nullptr) {
        fprintf(stderr, "known literal shape was not selectively pre-instantiated\n");
        mal_vm_free(&vm);
        return 1;
    }
    mal_vm_ensure_function_caches(&vm, 0);
    MalInlineCache *preseeded = vm.property_cache[0].sites;
    if (preseeded == nullptr ||
        preseeded[0].mode != MAL_IC_MODE_SHAPE ||
        preseeded[0].shape != vm.literal_shape_cache[0][1] ||
        preseeded[0].slot != 0 ||
        preseeded[2].shape != vm.literal_shape_cache[0][1] ||
        preseeded[2].poly_count != 1 ||
        preseeded[2].poly_shape[0] != vm.literal_shape_cache[0][2] ||
        mal_ic_poly_slot(&preseeded[2], 0) != 1) {
        fprintf(stderr, "known own-slot IC was not preseeded at cache creation\n");
        mal_vm_free(&vm);
        return 1;
    }
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    MalValue result = vm.globals[0];
    int code = 0;
    MalInlineCache *property_cache = vm.property_cache[0].sites;
    if (property_cache == nullptr ||
        property_cache[0].mode != MAL_IC_MODE_SHAPE ||
        property_cache[0].shape != vm.literal_shape_cache[0][1] ||
        property_cache[0].slot != 0 ||
        property_cache[2].shape != vm.literal_shape_cache[0][1] ||
        property_cache[2].poly_count != 1 ||
        property_cache[2].poly_shape[0] != vm.literal_shape_cache[0][2] ||
        mal_ic_poly_slot(&property_cache[2], 0) != 1) {
        fprintf(stderr, "known own-slot IC was not preseeded\n");
        code = 1;
    }
    if (vm.completion.kind != MAL_COMPLETION_NORMAL ||
        !mal_ops_is_number(result) ||
        mal_ops_number_as_f64(result) != 266.0) {
        fprintf(
            stderr,
            "known-own-slot result kind=%d numeric=%d value=%g\n",
            vm.completion.kind,
            mal_ops_is_number(result),
            mal_ops_is_number(result)
                ? mal_ops_number_as_f64(result)
                : 0.0);
        code = 1;
    }
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return code;
}
