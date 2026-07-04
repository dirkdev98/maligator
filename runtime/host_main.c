#include "vm.h"

#include <stdlib.h> // getenv

#include "host.h"
#include "host_timer.h"

// Host entry: run the compiled program's synchronous phase, then drive the event
// loop (setTimeout callbacks + pending I/O, interleaved with microtasks) until the
// isolate is idle. This is the entry a real host program / the Lambda bootstrap
// uses, as opposed to test262_main which only runs the synchronous body.
extern const MalVmDefinition mal_vm_definition;

int main(void) {
    mal_gc_init();

    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    // Attach the host context (reactor + timers) — the platform layer the engine
    // runs on. Then install host globals (not in the shared intrinsics, so only
    // host programs see them): setTimeout / clearTimeout on globalThis.
    mal_host_attach(&vm);
    mal_host_timers_install(&vm, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]));

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
