#include "vm.h"
#include <stdio.h>
#include "host.h"
#include "intrinsics.h"
#include "personality.h"
#include "web_host_timer.h"
#include "workers.h"

extern const MalRuntimeImage mal_runtime_image;
static bool passed;

static MalValue arm_failure(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    i32 mode = argc == 0 ? 0 : mal_value_to_i32(args[0]);
    vm->heap.fail_next_cell_allocation = mode == 1;
    vm->heap.fail_next_raw_allocation = mode == 2;
    return mal_value_new_undefined();
}

static MalValue opaque(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) nt; (void) callee;
    return argc == 0 ? mal_value_new_undefined() : args[0];
}

static MalValue console_mode(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    vm->host_node = argc != 0 && mal_value_is_truthy(args[0]);
    return mal_value_new_undefined();
}

static MalValue complete(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    passed = true;
    return mal_value_new_undefined();
}

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_host_attach(&vm) == nullptr) return 2;
    mal_runtime_personality_install(&vm, true, true);
    const MalHostLaunchContext launch = {.argc = argc, .argv = argv, .script_path = mal_runtime_image.entry_path};
    mal_vm_run_host_installs(&vm, &launch);
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_method_n(&vm, global, "armFailure", 1, arm_failure);
    mal_intrinsic_define_method_n(&vm, global, "opaque", 1, opaque);
    mal_intrinsic_define_method_n(&vm, global, "consoleMode", 1, console_mode);
    mal_intrinsic_define_method_n(&vm, global, "complete", 0, complete);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    vm.heap.fail_next_cell_allocation = false;
    vm.heap.fail_next_raw_allocation = false;
    int code = passed && vm.completion.kind != MAL_COMPLETION_THROW ? 0 : 1;
    mal_workers_shutdown(&vm);
    mal_vm_free_callable(entry);
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    if (code == 0) puts("bigint-allocation PASS");
    return code;
}
