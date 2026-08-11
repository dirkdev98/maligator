#include "node_https.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"

#define HTTPS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue node_https_agent(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

static MalValue node_https_agent_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return receiver;
}

static MalValue node_https_request_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "HTTPS requests are not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_https(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    enum {
        HTTPS_MODULE,
        HTTPS_AGENT_PROTOTYPE,
        HTTPS_AGENT,
        HTTPS_GLOBAL_AGENT,
        HTTPS_REQUEST,
        HTTPS_GET,
        HTTPS_ROOT_COUNT,
    };
    MalValue roots[HTTPS_ROOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    roots[HTTPS_MODULE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[HTTPS_AGENT_PROTOTYPE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[HTTPS_AGENT_PROTOTYPE]),
        (const byte *) "destroy", 0, node_https_agent_destroy);

    MalNativeFunctionObject *agent = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Agent"), 1, node_https_agent);
    mal_native_function_object_set_constructor(agent);
    roots[HTTPS_AGENT] = mal_value_from_native_function_object(agent);
    mal_intrinsic_define_data(vm, (MalObject *) agent, (const byte *) "prototype",
        roots[HTTPS_AGENT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[HTTPS_AGENT_PROTOTYPE]),
        (const byte *) "constructor", roots[HTTPS_AGENT],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[HTTPS_GLOBAL_AGENT] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(roots[HTTPS_AGENT_PROTOTYPE])));
    roots[HTTPS_REQUEST] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "request"), 3,
            node_https_request_unavailable));
    roots[HTTPS_GET] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "get"), 3,
            node_https_request_unavailable));

    static const char *names[] = {"Agent", "globalAgent", "request", "get"};
    MalValue values[] = {
        roots[HTTPS_AGENT], roots[HTTPS_GLOBAL_AGENT],
        roots[HTTPS_REQUEST], roots[HTTPS_GET],
    };
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[HTTPS_MODULE]),
            (const byte *) names[i], values[i], HTTPS_VISIBLE);
    }
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[HTTPS_MODULE];
            continue;
        }
        for (usize j = 0; j < countof(names); j++) {
            if (strcmp(slots[i].name, names[j]) == 0) {
                vm->globals[slots[i].slot] = values[j];
                break;
            }
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
