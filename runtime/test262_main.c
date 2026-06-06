#include "vm.h"

// Harness entry for generated test262 translation units: run the compiled
// program and report uncaught throws through the exit code.
extern const MalVmDefinition mal_vm_definition;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);

    return vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
}
