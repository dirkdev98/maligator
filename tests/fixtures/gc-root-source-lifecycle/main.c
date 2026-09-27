#include <stdio.h>

#include "gc.h"
#include "host.h"
#include "object.h"
#include "vm.h"
#include "web_host_timer.h"

extern const MalRuntimeImage mal_runtime_image;

static u32 witness_scans;

static void witness_root_scan(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    witness_scans++;
}

int main(void) {
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
    mal_vm_free(&hostless);
    puts("gc-root-source-lifecycle PASS");
    return 0;
}
