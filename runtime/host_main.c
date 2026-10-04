#include "vm.h"
#include "perf_stats.h"
#include "profile.h"
#ifndef MAL_DEVELOPMENT_API
#define MAL_DEVELOPMENT_API 0
#endif
#if MAL_DEVELOPMENT_API
#include "dev_runner.h"
#endif

#include <stdio.h>  // setvbuf
#include <stdlib.h> // getenv
#include <string.h>

#include "web_events_object.h"
#include "web_fetch.h"
#include "host.h"
#include "node_immediate.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"
#include "web_globals.h"
#include "personality.h"
#include "workers.h"
#include "worker_manifest.h"

// Host entry: run the compiled program's synchronous phase, then drive the event
// loop (setTimeout callbacks + pending I/O, interleaved with microtasks) until the
// isolate is idle. This is the entry a real host program / the Lambda bootstrap
// uses, as opposed to test262_main which only runs the synchronous body.
extern const MalRuntimeImage mal_runtime_image;
// Main images without workers omit this hook; generated registries override it.
__attribute__((weak)) void mal_register_compiled_worker_entries(void) {}

#if MAL_DEVELOPMENT_API
static const char development_wire_command[] = "--maligator-internal-run-wire";
static const char development_wire_assets_command[] = "--maligator-internal-run-wire-assets";

static int run_development_wire(int argc, char **argv, bool has_assets, const char *worker_manifest_path) {
    if (argc < 6 || strlen(argv[2]) != 1 ||
        argv[2][0] < '0' || argv[2][0] > '3') {
        fprintf(stderr, "invalid internal development wire invocation\n");
        return 2;
    }
    int surface_mask = argv[2][0] - '0';
    int wire_count = atoi(argv[3]);
    int entry_offset = has_assets ? 5 : 4;
    int wire_offset = entry_offset + 1;
    if (wire_count < 1 || wire_offset + wire_count > argc) {
        fprintf(stderr, "invalid internal development wire count\n");
        return 2;
    }
    int program_argc = argc - wire_offset - wire_count + 1;
    char **program_argv = malloc((size_t) program_argc * sizeof(char *));
    if (program_argv == nullptr) {
        return 2;
    }
    program_argv[0] = argv[0];
    for (int i = 1; i < program_argc; i++) {
        program_argv[i] = argv[wire_offset + wire_count + i - 1];
    }
    int code = mal_dev_run_wires(
        (const char *const *) &argv[wire_offset], wire_count,
        has_assets ? argv[4] : nullptr,
        argv[entry_offset],
        program_argc, program_argv,
        (surface_mask & 1) != 0, (surface_mask & 2) != 0, worker_manifest_path);
    free(program_argv);
    return code;
}
#endif

int main(int argc, char **argv) {
#if MAL_DEVELOPMENT_API
    const char *worker_manifest_path = nullptr;
    if (argc >= 3 && strcmp(argv[1], "--maligator-internal-workers") == 0) {
        worker_manifest_path = argv[2];
        argv[2] = argv[0];
        argv += 2;
        argc -= 2;
    }
    if (argc >= 2 && strcmp(argv[1], development_wire_command) == 0) {
        return run_development_wire(argc, argv, false, worker_manifest_path);
    }
    if (argc >= 2 && strcmp(argv[1], development_wire_assets_command) == 0) {
        return run_development_wire(argc, argv, true, worker_manifest_path);
    }
#endif
    // Line-buffer stdout: a server logs then blocks in the event loop indefinitely,
    // so fully-buffered output (the default when stdout is a pipe) would never be
    // seen. Line buffering flushes each console.log promptly.
    setvbuf(stdout, nullptr, _IOLBF, 0);

    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    mal_register_compiled_worker_entries();

    // Attach the host context (reactor + timers) — the platform layer the engine
    // runs on. Then install host globals (not in the shared intrinsics, so only
    // host programs see them): setTimeout / clearTimeout on globalThis.
    if (mal_host_attach(&vm) == nullptr) {
        mal_vm_free(&vm);
        return 2;
    }
#if MAL_DEVELOPMENT_API
    if (worker_manifest_path != nullptr && !mal_worker_manifest_register(&vm, worker_manifest_path)) {
        mal_host_detach(&vm);
        mal_vm_free(&vm);
        return 2;
    }
#endif
    mal_runtime_personality_install(&vm, MAL_WEB_PLATFORM != 0, MAL_NODE != 0);

    // Fill the reached host built-in / `process` global slots before execution
    // (a no-op for a program that imports none). After host attach so an installer
    // may lean on the reactor/timers; before run so LOAD_GLOBAL sees the values.
    // The launch context carries the process command line (for `process.argv`).
    MalHostLaunchContext launch = {
        .argc = argc,
        .argv = argv,
        .script_path = mal_runtime_image.entry_path,
    };
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_perf_stats_reset();
    mal_vm_run(&vm, callable);      // synchronous top level + its microtask drain
    mal_host_run_event_loop(&vm);   // timers / I/O + their microtasks, until idle

	int code = mal_host_finish_process(&vm, vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
	mal_profile_finish(&vm);
    mal_workers_shutdown(&vm);

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
#if MAL_NODE
        mal_node_immediates_free(&vm);
#endif
        mal_host_timers_free(&vm); // runtime cleanup (before the host reactor goes)
        mal_host_detach(&vm);
        mal_vm_free(&vm);
    }

    return code;
}
