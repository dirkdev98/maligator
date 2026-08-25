#include "vm.h"
#include "test262_host.h"
#include "perf_stats.h"
#include "profile.h"

#include <stdlib.h> // getenv

// Harness entry for generated test262 translation units: run the compiled
// program and report uncaught throws through the exit code.
extern const MalProgramImage mal_vm_definition;

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    // Fill any reached host built-in / `process` global slots before execution.
    // A no-op for test262 (no node surface), kept uniform with the other entries;
    // the launch context is still constructed so the call site matches the ABI.
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);
    if (getenv("MAL_TEST262") != nullptr) {
        mal_test262_install(&vm);
    }

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_perf_stats_reset();
    mal_vm_run(&vm, callable);

	int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;
	mal_profile_finish(&vm);

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
