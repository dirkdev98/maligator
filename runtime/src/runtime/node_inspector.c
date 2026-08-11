#include "node_inspector.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm_ops.h"

#define INSPECTOR_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue node_inspector_url(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_new_undefined();
}

static MalValue node_inspector_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_new_undefined();
}

static MalValue node_inspector_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "The inspector is not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_inspector(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const char *names[] = {"Session", "open", "close", "url"};
    MalNativeFunctionCallback bodies[] = {
        node_inspector_unavailable,
        node_inspector_unavailable,
        node_inspector_close,
        node_inspector_url,
    };
    for (usize i = 0; i < countof(names); i++) {
        MalNativeFunctionObject *function = mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) names[i]), 0, bodies[i]);
        if (i == 0) mal_native_function_object_set_constructor(function);
        roots[i + 1] = mal_value_from_native_function_object(function);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) names[i], roots[i + 1], INSPECTOR_VISIBLE);
    }
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[0];
            continue;
        }
        for (usize j = 0; j < countof(names); j++) {
            if (strcmp(slots[i].name, names[j]) == 0) {
                vm->globals[slots[i].slot] = roots[j + 1];
                break;
            }
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
