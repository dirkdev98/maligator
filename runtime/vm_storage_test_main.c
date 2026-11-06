#include "vm.h"
#include "gc.h"
#include "host.h"
#include "personality.h"
#include "web_host_timer.h"
#include "workers.h"

#include <stdlib.h>
#include <string.h>

// Runs the host driver's lifecycle on VM storage filled with a nonzero pattern.
// Drivers keep the VM on the stack, whose prior contents depend on what ran
// before main, such as the initializers of linked libraries. A field read before
// initialization then sees a wild pointer or count instead of a lucky zero.
extern const MalRuntimeImage mal_runtime_image;
__attribute__((weak)) void mal_register_compiled_worker_entries(void) {}

int main(int argc, char **argv) {
    MalVm *vm = malloc(sizeof(MalVm));
    if (vm == nullptr) return 2;
    memset(vm, 0xa5, sizeof(MalVm));
    mal_vm_init(vm, &mal_runtime_image);
    mal_register_compiled_worker_entries();
    if (mal_host_attach(vm) == nullptr) return 2;
    mal_runtime_personality_install(vm, MAL_WEB_PLATFORM != 0, MAL_NODE != 0);
    MalHostLaunchContext launch = {
        .argc = argc,
        .argv = argv,
        .script_path = mal_runtime_image.entry_path,
    };
    mal_vm_run_host_installs(vm, &launch);
    MalCallable *callable = mal_vm_create_callable(vm, 0);
    mal_vm_run(vm, callable);
    mal_host_run_event_loop(vm);
    int code = mal_host_finish_process(vm, vm->completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
    mal_workers_shutdown(vm);
    mal_gc_collect(vm);
    mal_vm_free_callable(callable);
    mal_host_timers_free(vm);
    mal_host_detach(vm);
    mal_vm_free(vm);
    free(vm);
    return code;
}
