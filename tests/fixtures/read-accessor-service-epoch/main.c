#include <math.h>
#include <stdio.h>

#include "gc.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    f64 initial = mal_vm_read_service_epoch(&vm);
    if (initial != 0 || !mal_vm_guard_service_epoch(&vm, initial)) return 1;

    vm.gc_native_frames = 1;
    mal_gc_safepoint(&vm);
    if (vm.service_epoch != 1 || mal_vm_guard_service_epoch(&vm, initial)) return 2;
    vm.gc_native_frames = 0;

    vm.service_epoch = 9007199254740990ULL;
    f64 before_saturation = mal_vm_read_service_epoch(&vm);
    if (!mal_vm_guard_service_epoch(&vm, before_saturation)) return 3;
    mal_gc_safepoint(&vm);
    for (int index = 0; index < 3; index++) {
        if (vm.service_epoch != 9007199254740991ULL) return 4;
        if (!isnan(mal_vm_read_service_epoch(&vm))) return 5;
        if (mal_vm_guard_service_epoch(&vm, before_saturation) ||
            mal_vm_guard_service_epoch(&vm, 9007199254740991.0) ||
            mal_vm_guard_service_epoch(&vm, NAN)) return 6;
        mal_gc_safepoint(&vm);
    }
    mal_vm_free(&vm);
    puts("read-accessor-service-epoch PASS");
    return 0;
}
