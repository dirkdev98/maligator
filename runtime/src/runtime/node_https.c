#include "node_https.h"
#include "node_http.h"
#include "node_module.h"
#include "http_client.h"
#include "host.h"

#if MAL_NODE

#include <string.h>
#include <stdio.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"

#define HTTPS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

bool mal_node_https_validate_options(MalVm *vm, MalValue options, bool agent, MalValue default_agent) {
    if (!mal_value_is_object(options)) return true;
    static const char *unsupported[] = {
        "ca", "servername", "rejectUnauthorized", "checkServerIdentity", "cert", "key",
        "pfx", "passphrase", "secureContext", "secureProtocol", "secureOptions",
        "minVersion", "maxVersion", "ciphers", "sigalgs", "ecdhCurve", "dhparam",
        "ALPNProtocols", "session", "clientCertEngine", "privateKeyIdentifier",
        "privateKeyEngine", "honorCipherOrder", "crl", "requestOCSP", "createConnection",
        "psk", "pskCallback", "sessionIdContext", "lookup", "localAddress", "localPort", "family", "hints", "defaultPort",
    };
    for (usize i = 0; i < countof(unsupported); i++) {
        MalValue value;
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, unsupported[i]), &value)) return false;
        if (!mal_value_is_undefined(value)) {
            char message[128];
            snprintf(message, sizeof(message), "HTTPS option %s is not supported", unsupported[i]);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
            return false;
        }
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "agent"), &value)) return false;
    if (!mal_value_is_undefined(value) && !(mal_value_is_boolean(value) && !mal_value_to_boolean(value))) {
        if (agent || !mal_ops_same_value(value, default_agent)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Custom HTTPS agents are not supported");
            return false;
        }
    }
    if (agent) {
        static const char *pool_options[] = {"keepAlive", "keepAliveMsecs", "maxSockets", "maxTotalSockets", "maxFreeSockets", "scheduling", "timeout"};
        for (usize i=0;i<countof(pool_options);i++) {
            if (!mal_vm_get_property(vm,options,mal_intrinsic_string_key(vm,pool_options[i]),&value)) return false;
            if (!mal_value_is_undefined(value)) {
                mal_vm_throw_error(vm,MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,"HTTPS Agent connection pooling options are not supported"); return false;
            }
        }
    }
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static MalValue node_https_agent(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (argc > 0 && !mal_node_https_validate_options(vm, args[0], true, mal_value_new_undefined())) return mal_value_new_undefined();
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
    mal_http_client_close_idle(mal_host(vm));
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return receiver;
}

void mal_host_install_node_https(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:https", slots, count)) return;
    mal_host_install_node_http(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
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
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "request"), 3,
            mal_node_https_request, roots + HTTPS_GLOBAL_AGENT, 1));
    roots[HTTPS_GET] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "get"), 3,
            mal_node_https_get, roots + HTTPS_GLOBAL_AGENT, 1));

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
    mal_node_module_publish(vm, "node:https", slots, count, roots[HTTPS_MODULE]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
