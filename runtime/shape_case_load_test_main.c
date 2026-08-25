#include "vm.h"
#include "value_ops.h"

#include <stdio.h>

extern const MalProgramImage mal_vm_definition;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    MalValue result = vm.globals[0];
    int code = 0;
    if (vm.completion.kind != MAL_COMPLETION_NORMAL ||
        !mal_ops_is_number(result) ||
        mal_ops_number_as_f64(result) != 21.0) {
        fprintf(stderr, "shape-case load produced the wrong result\n");
        code = 1;
    }
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return code;
}
