#include "node_timers_promises.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "promise_object.h"
#include "value_ops.h"
#include "web_host_timer.h"
#include "vm_ops.h"

static MalValue node_timers_promises_fulfill(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    MalNativeFunctionObject *callback =
        mal_value_to_native_function_object(callee);
    MalPromiseObject *promise = mal_value_to_promise_object(
        mal_native_function_object_get_slot(callback, 0));
    mal_promise_fulfill(
        vm, promise, mal_native_function_object_get_slot(callback, 1));
    return mal_value_new_undefined();
}

static MalValue node_timers_promises_set_timeout(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    f64 delay_number = argc > 0 ? mal_ops_to_number(args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    i64 delay = delay_number == delay_number && delay_number > 0
        ? (i64) delay_number : 0;
    MalValue roots[] = {
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "timeout"),
            node_timers_promises_fulfill, roots, 2));
    mal_host_set_timeout(vm, roots[2], delay, nullptr, 0);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

void mal_host_install_node_timers_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalObject *global_this = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install(vm, global_this);

    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) "setTimeout"), 2,
                node_timers_promises_set_timeout)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
        (const byte *) "setTimeout", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[0];
        } else if (strcmp(slots[i].name, "setTimeout") == 0) {
            vm->globals[slots[i].slot] = roots[1];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
