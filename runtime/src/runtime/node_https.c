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
#include "mal_tls.h"
#include "array_object.h"
#include "node_net.h"
#include "node_tls.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"

#define HTTPS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

bool mal_node_https_validate_options(MalVm *vm, MalValue options, bool agent, MalValue default_agent) {
    if (!mal_value_is_object(options)) return true;
    // Requests honour `ca`, `cert` and `key`; agents are refused outright, so theirs would be ignored.
    static const char *unsupported[] = {
        "ca", "cert", "key", "servername", "rejectUnauthorized", "checkServerIdentity",
        "pfx", "passphrase", "secureContext", "secureProtocol", "secureOptions",
        "minVersion", "maxVersion", "ciphers", "sigalgs", "ecdhCurve", "dhparam",
        "ALPNProtocols", "session", "clientCertEngine", "privateKeyIdentifier",
        "privateKeyEngine", "honorCipherOrder", "crl", "requestOCSP", "createConnection",
        "psk", "pskCallback", "sessionIdContext", "lookup", "localAddress", "localPort", "family", "hints", "defaultPort",
    };
    for (usize i = agent ? 0 : 3; i < countof(unsupported); i++) {
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

static MalValue node_https_server_listen(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue roots[] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (!mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE],
            mal_intrinsic_string_key(vm, (const byte *) "listen"), &roots[1])) {
        goto done;
    }
    MalCompletion listened = mal_vm_call_value(vm, roots[1], roots[0], args, argc);
    if (listened.kind == MAL_COMPLETION_THROW) goto done;
    roots[1] = listened.value;
    // The HTTP listener cannot accept before this call yields, so no plaintext connection slips in.
    MalTlsServerConfig *config = nullptr;
    bool without_cert = false;
    if (!mal_node_net_tls_config(vm, roots[0], &config, &without_cert)) goto done;
    if (config != nullptr && !mal_node_http_server_set_tls(roots[0], config)) {
        mal_tls_server_config_free(&config);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "https.Server: failed to start TLS");
        goto done;
    }
    {
        MalValue callback = mal_value_new_undefined(), contexts = mal_value_new_undefined();
        if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "_malSNICallback"), &callback)
            && mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "_contexts"), &contexts)
            && (mal_value_is_callable(callback)
                || (mal_value_is_array_object(contexts)
                    && mal_array_object_length(mal_value_to_array_object(contexts)) > 0))) {
            mal_node_http_server_enable_sni(roots[0]);
        }
    }
    result = roots[1];
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_https_server_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue options = argc > 0 && !mal_value_is_callable(args[0]) ? args[0] : mal_value_new_undefined();
    MalValue roots[] = {mal_vm_function_prototype(vm, target), options};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalCompletion server = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR], args, argc);
    if (server.kind == MAL_COMPLETION_THROW) goto done;
    if (mal_value_is_object(roots[0])) {
        mal_object_set_prototype(mal_value_to_object(server.value), mal_value_to_object(roots[0]));
    }
    MalValue instance = server.value;
    roots[0] = instance;
    if (mal_node_tls_server_setup(vm, roots[0], roots[1])) result = roots[0];
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_https_create_server(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalValue constructor = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalCompletion constructed = mal_vm_construct_value(vm, constructor, args, argc);
    return constructed.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : constructed.value;
}

static void node_https_install_server(MalVm *vm, MalObject *module) {
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE]))),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "listen", 3,
        node_https_server_listen);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "setSecureContext", 1,
        mal_node_tls_server_set_secure_context);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "addContext", 2,
        mal_node_tls_server_add_context);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Server"), 2, node_https_server_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_object_set_prototype((MalObject *) constructor,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR]));
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, module, (const byte *) "Server", roots[1], HTTPS_VISIBLE);
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "createServer"), 2, node_https_create_server, &roots[1], 1));
    mal_intrinsic_define_data(vm, module, (const byte *) "createServer", roots[2], HTTPS_VISIBLE);
    mal_gc_unroot(&root);
}

void mal_host_install_node_https(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:https", slots, count)) return;
    mal_host_install_node_http(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    mal_host_install_node_net(vm, nullptr, 0, launch);
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
    node_https_install_server(vm, mal_value_to_object(roots[HTTPS_MODULE]));
    mal_node_module_publish(vm, "node:https", slots, count, roots[HTTPS_MODULE]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
