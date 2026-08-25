#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    int code = vm.completion.kind == MAL_COMPLETION_NORMAL ? 0 : 1;
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return code;
}
