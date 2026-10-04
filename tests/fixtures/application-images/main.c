#include "vm.h"
#include <stdio.h>
#include "gc_process.h"
#include "host.h"
#include "mal_assets.h"
#include "personality.h"
#include "web_host_timer.h"
#include "workers.h"
extern const MalRuntimeImage mal_runtime_image;
int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    if (mal_host_attach(&vm) == nullptr) return 2;
    mal_runtime_personality_install(&vm, true, true);
    const MalHostLaunchContext launch = {.argc = argc, .argv = argv, .script_path = mal_runtime_image.entry_path};
    mal_host_install_maligator(&vm, nullptr, 0, &launch);
    mal_vm_run_host_installs(&vm, &launch);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    mal_host_run_event_loop(&vm);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
    mal_workers_shutdown(&vm);
    mal_vm_free_callable(entry);
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    MalWorkerDomainUsage usage = mal_worker_domain_usage();
    if (usage.live_domains != 0 || usage.wire_bytes != 0 || mal_workers_live_count() != 0 || mal_gc_process_bytes() != 0) return 3;
    return code;
}
