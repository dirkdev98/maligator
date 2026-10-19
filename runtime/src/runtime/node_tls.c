#include "node_tls.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "array_object.h"
#include "ascii.h"
#include "builtin_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "node_net.h"
#include "object.h"
#include "object_ops.h"
#include "posix_fs.h"
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

/* The system bundles the TLS client trusts by default, in its search order. */
static const char *const node_tls_bundles[] = {
    "/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt", "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
};

static MalValue node_tls_string(MalVm *vm, const char *text, usize length) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, length);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

/* Appends every PEM certificate block of `path` to `array`, as Node lists them. */
static void node_tls_append_pem_file(MalVm *vm, const char *path, MalArrayObject *array) {
    byte *content = nullptr;
    usize length = 0;
    if (path == nullptr || mal_posix_fs_read_file(path, &content, &length) != 0) return;
    static const char begin[] = "-----BEGIN CERTIFICATE-----";
    static const char end[] = "-----END CERTIFICATE-----";
    const char *cursor = (const char *) content;
    const char *limit = (const char *) content + length;
    while (cursor < limit && vm->completion.kind != MAL_COMPLETION_THROW) {
        const char *start = memmem(cursor, (usize) (limit - cursor), begin, sizeof begin - 1);
        if (start == nullptr) break;
        const char *stop = memmem(start, (usize) (limit - start), end, sizeof end - 1);
        if (stop == nullptr) break;
        stop += sizeof end - 1;
        MalValue pem = node_tls_string(vm, start, (usize) (stop - start));
        mal_array_object_store(array, mal_key_index(mal_array_object_length(array)), pem);
        cursor = stop;
    }
    free(content);
}

static MalValue node_tls_certificates(MalVm *vm, bool system, bool extra) {
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    if (system) {
        for (usize i = 0; i < countof(node_tls_bundles); i++) {
            if (access(node_tls_bundles[i], R_OK) != 0) continue;
            node_tls_append_pem_file(vm, node_tls_bundles[i], mal_value_to_array_object(result));
            break;
        }
    }
    if (extra) node_tls_append_pem_file(vm, getenv("NODE_EXTRA_CA_CERTS"), mal_value_to_array_object(result));
    mal_builtin_object_set_integrity(vm, result, true);
    mal_gc_unroot(&root);
    return result;
}

/* The runtime trusts the system bundle rather than a compiled-in Mozilla list. */
static MalValue node_tls_root_certificates(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue cached = mal_native_function_object_get_slot(self, 0);
    if (mal_value_is_undefined(cached)) {
        cached = node_tls_certificates(vm, true, false);
        mal_native_function_object_set_slot(self, 0, cached);
    }
    return cached;
}

static MalValue node_tls_get_ca_certificates(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue type = argc > 0 ? args[0] : mal_value_new_undefined();
    bool system = true, extra = true;
    if (!mal_value_is_undefined(type)) {
        MalString *name = mal_value_is_string(type) ? mal_value_to_string(type) : nullptr;
        if (name != nullptr && mal_string_equals_ascii(name, "default")) {
        } else if (name != nullptr && (mal_string_equals_ascii(name, "system") || mal_string_equals_ascii(name, "bundled"))) {
            extra = false;
        } else if (name != nullptr && mal_string_equals_ascii(name, "extra")) {
            system = false;
        } else {
            char received[320];
            mal_node_describe_received(vm, type, received, sizeof received);
            const char *shown = strncmp(received, "type ", 5) == 0 && strchr(received, '(') != nullptr
                ? strchr(received, '(') + 1 : received;
            char message[512];
            snprintf(message, sizeof message,
                "The argument 'type' is invalid. Received %.*s",
                shown != received ? (int) (strlen(shown) - 1) : (int) strlen(shown), shown);
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
            return mal_value_new_undefined();
        }
    }
    return node_tls_certificates(vm, system, extra);
}

/* rustls's suites under their OpenSSL names, in Node's lowercase sorted form. */
static const char *const node_tls_ciphers[] = {
    "ecdhe-ecdsa-aes128-gcm-sha256", "ecdhe-ecdsa-aes256-gcm-sha384", "ecdhe-ecdsa-chacha20-poly1305",
    "ecdhe-rsa-aes128-gcm-sha256", "ecdhe-rsa-aes256-gcm-sha384", "ecdhe-rsa-chacha20-poly1305",
    "tls_aes_128_gcm_sha256", "tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256",
};

static MalValue node_tls_get_ciphers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (usize i = 0; i < countof(node_tls_ciphers); i++) {
        mal_array_object_store(mal_value_to_array_object(result), mal_key_index((u32) i),
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) node_tls_ciphers[i])));
    }
    mal_gc_unroot(&root);
    return result;
}

static char *node_tls_c_string(MalVm *vm, MalValue value) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return nullptr;
    usize length = 0;
    byte *utf8 = mal_string_to_utf8(string, &length);
    char *text = utf8 == nullptr ? nullptr : realloc(utf8, length + 1);
    if (text == nullptr) {
        free(utf8);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    text[length] = '\0';
    return text;
}

/* An IP in canonical text form, or "" when `text` is not an address. */
static void node_tls_canonical_ip(const char *text, char *out, usize capacity) {
    unsigned char address[sizeof(struct in6_addr)];
    out[0] = '\0';
    if (inet_pton(AF_INET, text, address) == 1) inet_ntop(AF_INET, address, out, (socklen_t) capacity);
    else if (inet_pton(AF_INET6, text, address) == 1) inet_ntop(AF_INET6, address, out, (socklen_t) capacity);
}

static usize node_tls_split_host(char *host, char **parts, usize capacity) {
    usize length = strlen(host);
    if (length > 0 && host[length - 1] == '.') host[--length] = '\0';
    for (char *c = host; *c != '\0'; c++) {
        if (*c >= 'A' && *c <= 'Z') *c = (char) (*c + 32);
    }
    usize count = 0;
    char *cursor = host;
    for (;;) {
        char *dot = strchr(cursor, '.');
        if (count < capacity) parts[count] = cursor;
        count++;
        if (dot == nullptr) break;
        *dot = '\0';
        cursor = dot + 1;
    }
    return count;
}

/* lib/tls.js check(): RFC 6125 host matching with a single leftmost-label wildcard. */
static bool node_tls_check_host(char *const *host_parts, usize host_count, const char *pattern_text) {
    if (pattern_text == nullptr || pattern_text[0] == '\0') return false;
    char pattern[512];
    snprintf(pattern, sizeof pattern, "%s", pattern_text);
    char *pattern_parts[64];
    usize pattern_count = node_tls_split_host(pattern, pattern_parts, countof(pattern_parts));
    if (pattern_count != host_count || pattern_count > countof(pattern_parts)) return false;
    for (usize i = 0; i < pattern_count; i++) {
        if (pattern_parts[i][0] == '\0') return false;
        for (const unsigned char *c = (const unsigned char *) pattern_parts[i]; *c != '\0'; c++) {
            if (*c < 0x21 || *c > 0x7f) return false;
        }
    }
    for (usize i = host_count - 1; i > 0; i--) {
        if (strcmp(host_parts[i], pattern_parts[i]) != 0) return false;
    }
    const char *host_label = host_parts[0];
    const char *pattern_label = pattern_parts[0];
    const char *star = strchr(pattern_label, '*');
    if (star == nullptr || strstr(pattern_label, "xn--") != nullptr) return strcmp(host_label, pattern_label) == 0;
    if (strchr(star + 1, '*') != nullptr || pattern_count <= 2) return false;
    usize prefix = (usize) (star - pattern_label);
    usize suffix = strlen(star + 1);
    usize host_length = strlen(host_label);
    return prefix + suffix <= host_length && strncmp(host_label, pattern_label, prefix) == 0
        && strcmp(host_label + host_length - suffix, star + 1) == 0;
}

static MalValue node_tls_altname_error(MalVm *vm, const char *reason, const char *host, MalValue cert) {
    usize capacity = strlen(reason) + 64;
    char *message = malloc(capacity);
    if (message == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    snprintf(message, capacity, "Hostname/IP does not match certificate's altnames: %s", reason);
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_TLS_CERT_ALTNAME_INVALID");
    free(message);
    MalValue roots[] = {vm->completion.value, cert};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "reason",
            node_tls_string(vm, reason, strlen(reason)), TLS_VISIBLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "host",
            node_tls_string(vm, host, strlen(host)), TLS_VISIBLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "cert", roots[1], TLS_VISIBLE);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

/* tls.checkServerIdentity(hostname, cert): undefined when the cert names the host, else the error. */
static MalValue node_tls_check_server_identity(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue cert = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue roots[] = {cert, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *host = node_tls_c_string(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    char *alt_names = nullptr;
    char *cn = nullptr;
    MalValue result = mal_value_new_undefined();
    if (host == nullptr) goto done;
    if (!node_tls_get(vm, roots[0], "subject", &roots[1]) || !node_tls_get(vm, roots[0], "subjectaltname", &roots[2])) {
        goto done;
    }
    if (mal_value_is_truthy(roots[2]) && (alt_names = node_tls_c_string(vm, roots[2])) == nullptr) goto done;
    if (mal_value_is_object(roots[1])) {
        if (!node_tls_get(vm, roots[1], "CN", &roots[3])) goto done;
        if (mal_value_is_truthy(roots[3]) && !mal_value_is_array_object(roots[3])
            && (cn = node_tls_c_string(vm, roots[3])) == nullptr) {
            goto done;
        }
    }
    usize host_length = strlen(host);
    if (host_length > 0 && host[host_length - 1] == '.') host[--host_length] = '\0';
    char dns[64][256];
    char ips[64][INET6_ADDRSTRLEN];
    usize dns_count = 0, ip_count = 0;
    if (alt_names != nullptr) {
        char *copy = strdup(alt_names);
        for (char *entry = copy, *next; copy != nullptr && entry != nullptr; entry = next) {
            next = strstr(entry, ", ");
            if (next != nullptr) {
                *next = '\0';
                next += 2;
            }
            if (strncmp(entry, "DNS:", 4) == 0 && dns_count < countof(dns)) {
                snprintf(dns[dns_count++], sizeof dns[0], "%s", entry + 4);
            } else if (strncmp(entry, "IP Address:", 11) == 0 && ip_count < countof(ips)) {
                node_tls_canonical_ip(entry + 11, ips[ip_count++], sizeof ips[0]);
            }
        }
        free(copy);
    }
    bool valid = false;
    char *reason = nullptr;
    char canonical_host[INET6_ADDRSTRLEN];
    node_tls_canonical_ip(host, canonical_host, sizeof canonical_host);
    if (canonical_host[0] != '\0') {
        for (usize i = 0; i < ip_count && !valid; i++) valid = strcmp(ips[i], canonical_host) == 0;
        if (!valid) {
            usize capacity = 64 + host_length + ip_count * (INET6_ADDRSTRLEN + 2);
            reason = malloc(capacity);
            if (reason != nullptr) {
                usize used = (usize) snprintf(reason, capacity, "IP: %s is not in the cert's list: ", host);
                for (usize i = 0; i < ip_count; i++) {
                    used += (usize) snprintf(reason + used, capacity - used, "%s%s", i > 0 ? ", " : "", ips[i]);
                }
            }
        }
    } else if (dns_count > 0 || cn != nullptr || mal_value_is_array_object(roots[3])) {
        char host_copy[512];
        snprintf(host_copy, sizeof host_copy, "%s", host);
        char *host_parts[64];
        usize host_count = node_tls_split_host(host_copy, host_parts, countof(host_parts));
        if (host_count <= countof(host_parts)) {
            if (dns_count > 0) {
                for (usize i = 0; i < dns_count && !valid; i++) valid = node_tls_check_host(host_parts, host_count, dns[i]);
            } else if (cn != nullptr) {
                valid = node_tls_check_host(host_parts, host_count, cn);
            } else {
                u32 length = mal_array_object_length(mal_value_to_array_object(roots[3]));
                for (u32 i = 0; i < length && !valid; i++) {
                    MalValue item;
                    mal_array_object_dense_get(mal_value_to_array_object(roots[3]), i, &item);
                    char *text = node_tls_c_string(vm, item);
                    valid = text != nullptr && node_tls_check_host(host_parts, host_count, text);
                    free(text);
                }
            }
        }
        if (!valid) {
            const char *source = dns_count > 0 ? alt_names : cn != nullptr ? cn : "";
            usize capacity = strlen(source) + host_length + 64;
            reason = malloc(capacity);
            if (reason != nullptr) {
                snprintf(reason, capacity, dns_count > 0 ? "Host: %s. is not in the cert's altnames: %s"
                    : "Host: %s. is not cert's CN: %s", host, source);
            }
        }
    } else {
        reason = strdup("Cert does not contain a DNS name");
    }
    if (!valid) {
        result = reason == nullptr ? mal_value_new_undefined() : node_tls_altname_error(vm, reason, host, roots[0]);
        if (reason == nullptr) mal_vm_throw_allocation_error(vm);
    }
    free(reason);
done:
    free(host);
    free(alt_names);
    free(cn);
    mal_gc_unroot(&root);
    return result;
}

static void node_tls_install_extras(MalVm *vm, MalObject *module) {
    mal_intrinsic_define_method_n(vm, module, (const byte *) "getCiphers", 0, node_tls_get_ciphers);
    mal_intrinsic_define_method_n(vm, module, (const byte *) "getCACertificates", 1, node_tls_get_ca_certificates);
    mal_intrinsic_define_method_n(vm, module, (const byte *) "checkServerIdentity", 2, node_tls_check_server_identity);
    static const struct {
        const char *name;
        const char *value;
    } strings[] = {
        {"DEFAULT_MIN_VERSION", "TLSv1.2"},
        {"DEFAULT_MAX_VERSION", "TLSv1.3"},
        {"DEFAULT_ECDH_CURVE", "auto"},
        {"DEFAULT_CIPHERS",
            "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:"
            "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:"
            "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-CHACHA20-POLY1305"},
    };
    for (usize i = 0; i < countof(strings); i++) {
        mal_intrinsic_define_data(vm, module, (const byte *) strings[i].name,
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) strings[i].value)), TLS_VISIBLE);
    }
    mal_intrinsic_define_data(vm, module, (const byte *) "CLIENT_RENEG_LIMIT", mal_value_from_i32(3), TLS_VISIBLE);
    mal_intrinsic_define_data(vm, module, (const byte *) "CLIENT_RENEG_WINDOW", mal_value_from_i32(600), TLS_VISIBLE);
    MalValue cache = mal_value_new_undefined();
    MalValue getter = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "get"), 0, node_tls_root_certificates, &cache, 1));
    MalRootSpan root;
    mal_gc_root(&root, &getter, 1);
    MalPropertyDesc desc = mal_intrinsic_accessor_desc(getter, mal_value_new_undefined(),
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(module, mal_intrinsic_string_key(vm, (const byte *) "rootCertificates"), &desc);
    mal_gc_unroot(&root);
}

void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:tls", slots, count)) return;
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:tls", slots, count, cached);
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
    node_tls_install_extras(vm, mal_value_to_object(module));
    vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE] = module;
    mal_node_module_publish(vm, "node:tls", slots, count, module);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
