#include "vm.h"
#include "vm_ops.h"
#include "value_ops.h"

#include <stdio.h>

extern const MalVmDefinition mal_vm_definition;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    if (vm.literal_shape_cache[0] == nullptr ||
        vm.literal_shape_cache[0][1] == nullptr ||
        vm.literal_shape_cache[0][2] == nullptr ||
        vm.property_cache[0].sites != nullptr) {
        fprintf(stderr, "known literal shape was not selectively pre-instantiated\n");
        mal_vm_free(&vm);
        return 1;
    }
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    MalValue result = vm.globals[0];
    int code = 0;
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
