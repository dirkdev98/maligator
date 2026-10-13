#include "builtin_string.h"
#include "gc.h"
#include "heap_string.h"
#include "vm.h"
#include "vm_ops.h"
#include <stdio.h>
#include <stdlib.h>

extern const MalRuntimeImage mal_runtime_image;
static usize polls;
static void observe_safe_point(MalVm *vm) {
    if (vm->gc_native_frames != 0) abort();
    polls++;
}
#define CHECK(x) do { if (!(x)) { \
    fprintf(stderr, "repeat frames: route=%s outer=%d frames=%d polls=%zu collections=%llu->%llu line=%d: %s\n", \
        route_name, outer, vm.gc_native_frames, polls, (unsigned long long) before, \
        (unsigned long long) mal_gc_collection_count(&vm), __LINE__, #x); \
    goto cleanup; \
} } while (0)

int main(void) {
    MalVm vm;
    i32 status = 1, outer = -1;
    const char *route_name = "setup";
    u64 before = 0;
    mal_vm_init(&vm, &mal_runtime_image);
    MalValue roots[3] = {mal_value_from_string(mal_intrinsic_ascii(&vm, "xaby")), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    CHECK(mal_vm_get_property(&vm, roots[0], mal_intrinsic_string_key(&vm, "repeat"), &roots[1]));
    mal_gc_preempt_hook = observe_safe_point;
    for (outer = 0; outer <= 1; outer++) {
        for (i32 route = 0; route < 3; route++) {
            route_name = route == 0 ? "direct-full" : route == 1 ? "direct-span" : "native-wrapper";
            vm.gc_native_frames = outer;
            polls = 0;
            before = mal_gc_collection_count(&vm);
            if (route == 0) roots[2] = mal_builtin_string_repeat_numeric(&vm, mal_value_to_string(roots[0]), 32768);
            else if (route == 1) CHECK(mal_builtin_string_span_repeat(&vm, roots[1], false, roots[0], 1, 3, mal_value_from_i32(32768), &roots[2]));
            else {
                MalValue count = mal_value_from_i32(32768);
                MalCompletion result = mal_vm_call_value(&vm, roots[1], roots[0], &count, 1);
                CHECK(result.kind == MAL_COMPLETION_NORMAL);
                roots[2] = result.value;
            }
            CHECK(vm.gc_native_frames == outer);
            CHECK((polls > 0) == (outer == 0));
            CHECK((mal_gc_collection_count(&vm) > before) == (outer == 0));
            CHECK(mal_value_is_string(roots[2]));
            CHECK(mal_string_length(mal_value_to_string(roots[2])) == (route == 1 ? 65536 : 131072));
            vm.gc_native_frames = 0;
            mal_gc_collect(&vm);
            CHECK(mal_string_code_unit_at(mal_value_to_string(roots[2]), 0) == (route == 1 ? 'a' : 'x'));
        }
    }
    status = 0;
cleanup:
    mal_gc_preempt_hook = nullptr;
    vm.gc_native_frames = 0;
    mal_gc_unroot(&span);
    mal_vm_free(&vm);
    if (status == 0) puts("string-repeat-frames PASS");
    return status;
}
