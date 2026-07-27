#include "node_perf_hooks.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "monotonic_clock.h"
#include "node_module.h"
#include "object.h"

#define PERF_HOOKS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static i64 node_perf_hooks_origin_ns;

static MalValue node_performance_now(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_from_f64(
        (f64) (mal_monotonic_now_ns() - node_perf_hooks_origin_ns) / 1.0e6);
}

void mal_host_install_node_perf_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }
    if (node_perf_hooks_origin_ns == 0) {
        node_perf_hooks_origin_ns = mal_monotonic_now_ns();
    }
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[1]), (const byte *) "now", 0,
        node_performance_now);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "performance",
        roots[1], PERF_HOOKS_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE] = roots[0];
    mal_node_module_publish(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
