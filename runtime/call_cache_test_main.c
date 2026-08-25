#include "vm.h"

#include "gc.h"

extern const MalRuntimeImage mal_runtime_image;

static bool run_once(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    bool passed = vm.completion.kind != MAL_COMPLETION_THROW;
    mal_gc_collect(&vm);
    mal_vm_free_callable(callable);
    mal_vm_free(&vm);
    return passed;
}

int main(void) {
    return run_once() && run_once() ? 0 : 1;
}
