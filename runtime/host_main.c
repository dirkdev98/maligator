#include "vm.h"

#include <stdio.h>  // setvbuf
#include <stdlib.h> // getenv

#include "events_object.h"
#include "fetch.h"
#include "host.h"
#include "host_timer.h"
#include "url_object.h"
#include "web_globals.h"

// Host entry: run the compiled program's synchronous phase, then drive the event
// loop (setTimeout callbacks + pending I/O, interleaved with microtasks) until the
// isolate is idle. This is the entry a real host program / the Lambda bootstrap
// uses, as opposed to test262_main which only runs the synchronous body.
extern const MalVmDefinition mal_vm_definition;

int main(void) {
    // Line-buffer stdout: a server logs then blocks in the event loop indefinitely,
    // so fully-buffered output (the default when stdout is a pipe) would never be
    // seen. Line buffering flushes each console.log promptly.
    setvbuf(stdout, nullptr, _IOLBF, 0);

    mal_gc_init();

    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    // Attach the host context (reactor + timers) — the platform layer the engine
    // runs on. Then install host globals (not in the shared intrinsics, so only
    // host programs see them): setTimeout / clearTimeout on globalThis.
    mal_host_attach(&vm);
    MalObject *global_this = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install(&vm, global_this);
    mal_fetch_install(&vm, global_this);
    mal_web_globals_install(&vm, global_this);
    mal_url_install(&vm, global_this);
    mal_events_install(&vm, global_this);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);      // synchronous top level + its microtask drain
    mal_host_run_event_loop(&vm);   // timers / I/O + their microtasks, until idle

    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
        mal_host_timers_free(&vm); // runtime cleanup (before the host reactor goes)
        mal_host_detach(&vm);
        mal_vm_free(&vm);
    }

    return code;
}
