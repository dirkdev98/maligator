#include "vm.h"
#include "perf_stats.h"

#include <stdio.h>  // setvbuf
#include <stdlib.h> // getenv

#include "web_events_object.h"
#include "web_fetch.h"
#include "host.h"
#include "node_immediate.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"
#include "web_globals.h"

// Host entry: run the compiled program's synchronous phase, then drive the event
// loop (setTimeout callbacks + pending I/O, interleaved with microtasks) until the
// isolate is idle. This is the entry a real host program / the Lambda bootstrap
// uses, as opposed to test262_main which only runs the synchronous body.
extern const MalVmDefinition mal_vm_definition;

int main(int argc, char **argv) {
    // Line-buffer stdout: a server logs then blocks in the event loop indefinitely,
    // so fully-buffered output (the default when stdout is a pipe) would never be
    // seen. Line buffering flushes each console.log promptly.
    setvbuf(stdout, nullptr, _IOLBF, 0);

    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    // Attach the host context (reactor + timers) — the platform layer the engine
    // runs on. Then install host globals (not in the shared intrinsics, so only
    // host programs see them): setTimeout / clearTimeout on globalThis.
    mal_host_attach(&vm);
#if MAL_WEB_PLATFORM || MAL_NODE
    MalObject *global_this = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install(&vm, global_this); // setTimeout / clearTimeout
#endif
#if MAL_NODE
    mal_node_immediates_install(&vm, global_this);
#endif
#if MAL_WEB_PLATFORM
    // The WinterTC web personality (surface.webPlatform). Off → none of these
    // install, so their translation units — and the ada C++ URL parser + `-lc++`
    // they'd pull — are never referenced and drop out at link. `Mal.serve` rides in
    // with mal_fetch_install (web_fetch.c). The reactor (mal_host_attach) is a separate
    // axis and stays: a non-web host program still gets the event loop.
    mal_fetch_install(&vm, global_this);          // fetch / Response / Headers / Mal.serve
    mal_web_globals_install(&vm, global_this);    // TextEncoder / TextDecoder / …
    mal_url_install(&vm, global_this);            // URL / URLSearchParams (ada)
    mal_events_install(&vm, global_this);         // EventTarget / Event
    mal_readable_stream_install(&vm, global_this); // ReadableStream default mode
#endif

    // Fill the reached host built-in / `process` global slots before execution
    // (a no-op for a program that imports none). After host attach so an installer
    // may lean on the reactor/timers; before run so LOAD_GLOBAL sees the values.
    // The launch context carries the process command line (for `process.argv`).
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_perf_stats_reset();
    mal_vm_run(&vm, callable);      // synchronous top level + its microtask drain
    mal_host_run_event_loop(&vm);   // timers / I/O + their microtasks, until idle

    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

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
