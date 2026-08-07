#include "node_tls.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>

#include "array_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "node_net.h"
#include "object.h"
#include "object_ops.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

#define TLS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static bool node_tls_get(
    MalVm *vm, MalValue object, const char *name, MalValue *out) {
    return mal_vm_get_property(
        vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static bool node_tls_utf8(
    MalVm *vm, MalValue value, byte **bytes, usize *length) {
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "TLS string option must be a string");
        return false;
    }
    *bytes = mal_string_to_utf8(mal_value_to_string(value), length);
    if (*bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    return true;
}

/*
 * Options this connector does not implement. Accepting one silently would be
 * the worst outcome available: every name below either supplies a credential,
 * chooses what is trusted, or constrains the negotiation, so ignoring it
 * downgrades a connection the caller believes it has configured. Refusing is
 * the only answer that cannot be mistaken for success.
 */
static const char *const NODE_TLS_UNSUPPORTED_OPTIONS[] = {
    "cert", "key", "pfx", "passphrase", "clientCertEngine", "privateKeyEngine",
    "crl", "ciphers", "sigalgs", "ecdhCurve", "dhparam", "minVersion",
    "maxVersion", "secureProtocol", "secureContext", "checkServerIdentity",
    "session", "sessionIdContext", "requestOCSP", "psk", "pskCallback",
};

static bool node_tls_reject_unsupported(MalVm *vm, MalValue options) {
    for (usize i = 0; i < countof(NODE_TLS_UNSUPPORTED_OPTIONS); i++) {
        MalValue value;
        if (!node_tls_get(vm, options, NODE_TLS_UNSUPPORTED_OPTIONS[i], &value)) {
            return false;
        }
        if (mal_value_is_undefined(value)) continue;
        char message[160];
        snprintf(message, sizeof(message),
                 "tls.connect: the \"%s\" option is not supported",
                 NODE_TLS_UNSUPPORTED_OPTIONS[i]);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
        return false;
    }
    return true;
}

/*
 * ALPNProtocols -> the single protocol the host ABI carries. Node accepts a
 * list, a string, and a wire-format buffer; only a one-element list and a bare
 * string can be honoured here, so the rest are refused rather than collapsed to
 * whatever this connector happens to support. `*selected` stays undefined when
 * the option is absent, which is "offer no ALPN".
 */
static bool node_tls_alpn_protocol(MalVm *vm, MalValue value, MalValue *selected) {
    *selected = mal_value_new_undefined();
    if (mal_value_is_undefined(value)) {
        return true;
    }
    if (mal_value_is_string(value)) {
        *selected = value;
    } else if (mal_value_is_array_object(value)
               && mal_array_object_length(mal_value_to_array_object(value)) == 1) {
        MalValue element;
        if (!mal_vm_get_property(vm, value, mal_key_index(0), &element)) {
            return false;
        }
        if (!mal_value_is_string(element)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "tls.connect: ALPNProtocols entries must be strings");
            return false;
        }
        *selected = element;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "tls.connect: ALPNProtocols must be a string or a "
                           "single-element array of strings");
        return false;
    }
    // An empty or oversized name cannot go on the wire: ALPN encodes each
    // protocol with a one-byte length.
    if (mal_string_length(mal_value_to_string(*selected)) == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "tls.connect: ALPNProtocols entries must not be empty");
        return false;
    }
    return true;
}

static MalValue node_tls_connect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "tls.connect options must be an object");
        return mal_value_new_undefined();
    }
    // [0] options [1] socket [2] servername [3] ca [4] rejectUnauthorized
    // [5] ALPNProtocols [6] "secureConnect" [7] the selected ALPN protocol
    MalValue roots[] = {
        args[0], mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!node_tls_get(vm, roots[0], "socket", &roots[1])
        || !node_tls_get(vm, roots[0], "servername", &roots[2])
        || !node_tls_get(vm, roots[0], "ca", &roots[3])
        || !node_tls_get(vm, roots[0], "rejectUnauthorized", &roots[4])
        || !node_tls_get(vm, roots[0], "ALPNProtocols", &roots[5])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_object(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "tls.connect: options.socket must be a socket");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(roots[2])
        && !node_tls_get(vm, roots[1], "host", &roots[2])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!node_tls_reject_unsupported(vm, roots[0])
        || !node_tls_alpn_protocol(vm, roots[5], &roots[7])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    // Only an explicit `false` disables verification, and only a boolean is
    // accepted: a truthy-but-not-true value must not be read as a decision
    // about certificate validation.
    if (!mal_value_is_undefined(roots[4]) && !mal_value_is_boolean(roots[4])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "tls.connect: rejectUnauthorized must be a boolean");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    bool insecure = mal_value_is_boolean(roots[4]) && !mal_value_is_truthy(roots[4]);

    byte *server_name = nullptr;
    usize server_name_length = 0;
    byte *ca_pem = nullptr;
    usize ca_pem_length = 0;
    byte *alpn = nullptr;
    usize alpn_length = 0;
    if (!node_tls_utf8(vm, roots[2], &server_name, &server_name_length)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(roots[3])
        && !node_tls_utf8(vm, roots[3], &ca_pem, &ca_pem_length)) {
        free(server_name);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(roots[7])
        && !node_tls_utf8(vm, roots[7], &alpn, &alpn_length)) {
        free(server_name);
        free(ca_pem);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (alpn_length > 255) {
        free(server_name);
        free(ca_pem);
        free(alpn);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "tls.connect: ALPNProtocols entries must be at most "
                           "255 bytes");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    bool started = mal_node_net_start_tls(vm, roots[1],
        server_name, server_name_length, ca_pem, ca_pem_length,
        alpn, alpn_length, insecure);
    free(server_name);
    free(ca_pem);
    free(alpn);
    if (!started) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start TLS on socket");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (argc > 1 && mal_value_is_callable(args[1])) {
        roots[6] = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "secureConnect"));
        MalValue once;
        if (node_tls_get(vm, roots[1], "once", &once)) {
            MalValue once_args[] = {roots[6], args[1]};
            mal_vm_call_value(vm, once, roots[1], once_args, 2);
        }
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : result;
}

void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }
    MalValue module = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    MalValue connect = mal_intrinsic_define_method_n(
        vm, mal_value_to_object(module), (const byte *) "connect", 1,
        node_tls_connect);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(module), (const byte *) "connect", connect,
        TLS_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE] = module;
    mal_node_module_publish(vm, slots, count, module);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
