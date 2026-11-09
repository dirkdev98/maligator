#include <stdio.h>

#include "gc.h"
#include "host.h"
#include "object.h"
#include "vm.h"
#include "web_host_timer.h"

extern const MalRuntimeImage mal_runtime_image;

static u32 witness_scans;
static u32 witness_weak_cleanups;

static void witness_weak_cleanup(MalVm *vm, void *data, bool (*is_live)(MalValue)) {
    (void) vm;
    (void) data;
    if (!is_live(mal_value_new_undefined())) __builtin_trap();
    witness_weak_cleanups++;
}

static void witness_root_scan(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    witness_scans++;
}

int main(void) {
    // Every value here is rooted explicitly; stale C locals must not retain cells.
    mal_gc_test_precise_stack_roots = true;
    for (int i = 0; i < 32; ++i)
        mal_gc_register_weak_source(witness_weak_cleanup, nullptr);
    for (int i = 0; i < 16; ++i) {
        MalVm vm;
        mal_vm_init(&vm, &mal_runtime_image);
        mal_host_attach(&vm);
        MalObject *global_this = mal_object_new(&vm.heap, nullptr);
        MalValue root = mal_value_from_object(global_this);
        MalRootSpan span;
        mal_gc_root(&span, &root, 1);
        mal_host_timers_install(&vm, global_this);
        mal_gc_collect(&vm);
        mal_gc_unroot(&span);
        mal_host_detach(&vm);
        mal_vm_free(&vm);
    }

    mal_gc_register_root_source(witness_root_scan, nullptr);
    MalVm hostless;
    mal_vm_init(&hostless, &mal_runtime_image);
    mal_gc_collect(&hostless);
    if (witness_scans == 0) return 1;
    if (witness_weak_cleanups != 17) return 2;
    mal_vm_free(&hostless);
    puts("gc-root-source-lifecycle PASS");
    return 0;
}
