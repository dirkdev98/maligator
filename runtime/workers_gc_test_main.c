#include "vm.h"
#include "gc_process.h"
#include "host.h"
#include "personality.h"
#include "web_host_timer.h"
#include <stdio.h>
#include <stdlib.h>

extern const MalRuntimeImage mal_runtime_image;
extern void mal_register_compiled_worker_entries(void) __attribute__((weak));

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_register_compiled_worker_entries != nullptr) mal_register_compiled_worker_entries();
    if (mal_host_attach(&vm) == nullptr) abort();
    mal_runtime_personality_install(&vm, false, false);
    const MalHostLaunchContext launch = {.script_path = mal_runtime_image.entry_path};
    mal_vm_run_host_installs(&vm, &launch);
    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);
    mal_gc_collect(&vm);
    mal_host_run_event_loop(&vm);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
    mal_vm_free_callable(callable);
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    if (mal_gc_process_bytes() != 0) abort();
    return code;
}
