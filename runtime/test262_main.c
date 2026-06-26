#include "vm.h"

#include <stdlib.h> // getenv

// Harness entry for generated test262 translation units: run the compiled
// program and report uncaught throws through the exit code.
extern const MalVmDefinition mal_vm_definition;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);

    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    // Leak-audit teardown (MAL_GC_AT_EXIT): force a final full collection, then
    // tear the VM down so it frees every reclaimable allocation. A `leaks` /
    // Guard Malloc run then reports only genuinely-static residue. Off by
    // default — a normal run lets the OS reclaim everything on exit (faster).
    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
        mal_vm_free(&vm);
    }

    return code;
}
