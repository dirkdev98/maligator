// Portions derived from Node.js lib/net.js, lib/_tls_wrap.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_net.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/un.h>
#include <unistd.h>

#include "ascii.h"
#include "async_context.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "mal_tls.h"
#include "intrinsics.h"
#include "net.h"
#include "node_buffer.h"
#include "node_dns.h"
#include "node_http.h"
#include "node_module.h"
#include "node_stream.h"
#include "microtask.h"
#include "object.h"
#include "promise_object.h"
#include "object_ops.h"
#include "property_store.h"
#include "tcp.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "array_object.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_host_timer.h"

#define NET_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define NET_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)
#define NET_WRITE_SEGMENT (64 * 1024)
#define NET_WRITE_HIGH_WATER (256 * 1024)
#define NET_WRITE_LOW_WATER (128 * 1024)

typedef struct MalNodeNetWrite {
    u64 token;
    byte *bytes;
    usize length;
    usize offset;
    MalValue callback;
    MalAsyncContext *async_context;
    struct MalNodeNetWrite *next;
} MalNodeNetWrite;

typedef struct MalNodeNetSocketState {
    MalVm *vm;
    MalValue receiver;
    MalAsyncContext *async_context;
    MalAsyncContext *tls_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHostHandle operation;
    MalValue destroy_error;
    /* The accepting net.Server for server-side sockets, else undefined. */
    MalValue server;
    MalNodeNetWrite *write_head;
    MalNodeNetWrite *write_tail;
    /* Owned UTF-8 Unix socket path for pipe connections, else null. */
    char *path;
    struct sockaddr_storage *addresses;
    socklen_t *address_lengths;
    usize address_count;
    usize address_index;
    usize queued_write_bytes;
    u16 port;
    usize active_segment;
    u64 next_write_token;
    bool connected;
    bool resolving;
    bool write_in_flight;
    bool backpressured;
    bool read_paused;
    bool ending;
    bool destroyed;
    bool tls_server;
    bool secure;
    /* A ClientHello waits for SNICallback to pick its context. */
    bool sni_pending;
    struct MalNodeNetSocketState *next;
} MalNodeNetSocketState;

typedef struct MalNodeNetServerState {
    MalVm *vm;
    MalValue receiver;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHostHandle operation;
    /* Owned; present for tls.Server, whose accepts start the server TLS role. */
    MalTlsServerConfig *tls_config;
    /* Owned UTF-8 path of a Unix socket listener, else null. */
    char *path;
    u32 connections;
    bool listening;
    bool handle_open;
    /* Until its terminal task drains: the head-only drain needs this state to consume it. */
    bool listener_live;
    bool tls_without_cert;
    /* Configs built from SNI-selected SecureContexts, reused while the context object lives. */
    struct {
        MalValue context;
        MalTlsServerConfig *config;
    } sni_cache[4];
    u32 sni_cache_next;
    struct MalNodeNetServerState *next;
} MalNodeNetServerState;

// Sockets and their root registration belong to this mutator's isolate.
static MAL_ISOLATE_LOCAL MalNodeNetSocketState *net_sockets;
static MAL_ISOLATE_LOCAL bool net_roots_installed;

static void net_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_object_set(mal_value_to_object(object),
        mal_intrinsic_string_key(vm, (const byte *) name), value);
}

static bool net_get(
    MalVm *vm, MalValue object, const char *name, MalValue *out) {
    return mal_vm_get_property(
        vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static MalCompletion net_call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[] = {
        receiver, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    if (argc > 3) argc = 3;
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc; i++) roots[2 + i] = args[i];
    if (!net_get(vm, roots[0], name, &roots[1])) {
        MalCompletion completion = vm->completion;
        mal_gc_unroot(&root);
        return completion;
    }
    MalCompletion completion = mal_vm_call_value(
        vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    mal_gc_unroot(&root);
    return completion;
}

static bool net_emit(
    MalVm *vm, MalValue receiver, const char *event, const MalValue *args, i32 argc) {
    MalValue values[] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    for (i32 i = 0; i < argc && i < 2; i++) values[1 + i] = args[i];
    MalCompletion completion = net_call_method(vm, receiver, "emit", values, argc + 1);
    bool ok = completion.kind != MAL_COMPLETION_THROW;
    mal_gc_unroot(&root);
    return ok;
}

static MalNodeNetSocketState *net_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeNetSocketState *state = net_sockets; state != nullptr; state = state->next) {
        if (mal_value_to_object(state->receiver) == object) return state;
    }
    return nullptr;
}

static MalNodeNetSocketState **net_state_link(MalNodeNetSocketState *state) {
    MalNodeNetSocketState **link = &net_sockets;
    while (*link != nullptr && *link != state) link = &(*link)->next;
    return link;
}

static void net_state_free(MalNodeNetSocketState *state) {
    MalNodeNetWrite *write = state->write_head;
    while (write != nullptr) {
        MalNodeNetWrite *next = write->next;
        free(write->bytes);
        free(write);
        write = next;
    }
    free(state->addresses);
    free(state->address_lengths);
    free(state->path);
    free(state);
}

static const char *net_errno_code(int error) {
    switch (error) {
        case ENOENT: return "ENOENT";
        case EACCES: return "EACCES";
        case ENOTSOCK: return "ENOTSOCK";
        case ECONNREFUSED: return "ECONNREFUSED";
        case ECONNRESET: return "ECONNRESET";
        case ETIMEDOUT: return "ETIMEDOUT";
        case EHOSTUNREACH: return "EHOSTUNREACH";
        case ENETUNREACH: return "ENETUNREACH";
        default: return "EIO";
    }
}

static MalValue net_error(MalVm *vm, int error) {
    const char *code = net_errno_code(error);
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) code);
    MalValue value = vm->completion.value;
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    if (mal_value_is_object(value)) {
        MalValue code_value = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) code));
        MalRootSpan root;
        mal_gc_root(&root, &code_value, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(value),
            (const byte *) "code", code_value, NET_VISIBLE);
        mal_gc_unroot(&root);
    }
    return value;
}

static MalValue net_utf8_value(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text)));
}

/* Node's UVExceptionWithHostPort for a pipe: `connect ENOENT /path` with errno, syscall and address. */
static MalValue net_pipe_error(MalVm *vm, int error, const char *syscall, const char *path) {
    MalValue roots[] = {net_error(vm, error), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        const char *code = net_errno_code(error);
        usize capacity = strlen(syscall) + strlen(code) + strlen(path) + 3;
        char *message = malloc(capacity);
        if (message != nullptr) {
            snprintf(message, capacity, "%s %s %s", syscall, code, path);
            roots[1] = net_utf8_value(vm, message);
            free(message);
            net_set(vm, roots[0], "message", roots[1]);
        }
        net_set(vm, roots[0], "errno", mal_value_from_i32(-error));
        roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) syscall));
        net_set(vm, roots[0], "syscall", roots[1]);
        roots[1] = net_utf8_value(vm, path);
        net_set(vm, roots[0], "address", roots[1]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

/* lib/net.js isPipeName: a string that does not convert to a non-negative number. */
static bool net_is_pipe_name(MalVm *vm, MalValue value, bool *is_pipe) {
    *is_pipe = false;
    if (!mal_value_is_string(value)) return true;
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    *is_pipe = !(number >= 0);
    return true;
}

/* Fills a sockaddr_un from a JS path; throws when the path does not fit sun_path. */
static bool net_pipe_address(
    MalVm *vm, MalValue value, struct sockaddr_storage *address, socklen_t *length, char **path_out) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize path_length;
    byte *path = mal_string_to_utf8(string, &path_length);
    if (path == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    struct sockaddr_un *unix_address = (struct sockaddr_un *) address;
    if (path_length >= (usize) sizeof(unix_address->sun_path) || memchr(path, 0, path_length) != nullptr) {
        free(path);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Socket path is too long");
        return false;
    }
    char *text = realloc(path, path_length + 1);
    if (text == nullptr) {
        free(path);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    text[path_length] = '\0';
    memset(address, 0, sizeof(*address));
    unix_address->sun_family = AF_UNIX;
    memcpy(unix_address->sun_path, text, path_length + 1);
    *length = (socklen_t) (offsetof(struct sockaddr_un, sun_path) + path_length + 1);
    *path_out = text;
    return true;
}

static bool net_matches_ipv4_text(const char *text) {
    for (u32 segment = 0; segment < 4; segment++) {
        const char *start = text;
        u32 number = 0;
        while (*text >= '0' && *text <= '9') {
            number = number * 10 + (u32) (*text++ - '0');
            if (text - start > 3) return false;
        }
        if (text == start || number > 255 || (*start == '0' && text - start > 1)) {
            return false;
        }
        if (segment == 3) return *text == '\0';
        if (*text++ != '.') return false;
    }
    return false;
}

static bool net_matches_ip(MalVm *vm, MalValue value, int family, bool *matches) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize length = mal_string_length(string);
    if (family == AF_INET && length >= INET_ADDRSTRLEN) {
        *matches = false;
        return true;
    }
    const c16 *units = mal_string_code_units(string);
    usize address_length = length;
    if (family == AF_INET6) {
        for (usize index = 0; index < length; index++) {
            if (units[index] != '%') continue;
            address_length = index;
            if (index + 1 == length) {
                *matches = false;
                return true;
            }
            for (usize zone = index + 1; zone < length; zone++) {
                c16 unit = units[zone];
                if (!((unit >= '0' && unit <= '9')
                    || (unit >= 'a' && unit <= 'z')
                    || (unit >= 'A' && unit <= 'Z')
                    || unit == '-' || unit == '.' || unit == ':')) {
                    *matches = false;
                    return true;
                }
            }
            break;
        }
    }
    if (address_length == 0 || address_length >= INET6_ADDRSTRLEN) {
        *matches = false;
        return true;
    }
    char address[INET6_ADDRSTRLEN];
    for (usize index = 0; index < address_length; index++) {
        if (units[index] == 0 || units[index] > 0x7f) {
            *matches = false;
            return true;
        }
        address[index] = (char) units[index];
    }
    address[address_length] = '\0';
    if (family == AF_INET) {
        *matches = net_matches_ipv4_text(address);
        return true;
    }
    if (strchr(address, '.') != nullptr) {
        const char *suffix = strrchr(address, ':');
        if (suffix == nullptr || !net_matches_ipv4_text(suffix + 1)) {
            *matches = false;
            return true;
        }
    }
    struct in6_addr parsed;
    *matches = inet_pton(family, address, &parsed) == 1;
    return true;
}

static MalValue net_ip_call(
    MalVm *vm, const MalValue *args, i32 argc, MalValue new_target, int family
) {
    MalValue roots[] = {
        argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        roots[1] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    bool matches;
    int matched_family = 0;
    if (family != AF_INET6) {
        if (!net_matches_ip(vm, roots[0], AF_INET, &matches)) goto failed;
        if (matches) matched_family = 4;
    }
    if (family != AF_INET && matched_family == 0) {
        if (!net_matches_ip(vm, roots[0], AF_INET6, &matches)) goto failed;
        if (matches) matched_family = 6;
    }
    MalValue result = !mal_value_is_undefined(new_target) ? roots[1]
        : family == AF_UNSPEC ? mal_value_from_i32(matched_family)
        : mal_value_new_boolean(matched_family != 0);
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

#define NET_IP_PREDICATE(name, family) \
    static MalValue name( \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        (void) receiver; (void) callee; \
        return net_ip_call(vm, args, argc, new_target, family); \
    }

NET_IP_PREDICATE(net_is_ip, AF_UNSPEC)
NET_IP_PREDICATE(net_is_ipv4, AF_INET)
NET_IP_PREDICATE(net_is_ipv6, AF_INET6)
#undef NET_IP_PREDICATE

// lib/net.js module state behind get/setDefaultAutoSelectFamily(AttemptTimeout).
static MAL_ISOLATE_LOCAL bool net_auto_select_family = true;
static MAL_ISOLATE_LOCAL i32 net_auto_select_family_attempt_timeout = 500;

static MalValue net_get_default_auto_select_family(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_new_boolean(net_auto_select_family);
}

static MalValue net_set_default_auto_select_family(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_boolean(value)) {
        mal_node_throw_invalid_arg_type(vm, "value", "of type boolean", value);
        return mal_value_new_undefined();
    }
    net_auto_select_family = mal_value_to_boolean(value);
    return mal_value_new_undefined();
}

static MalValue net_get_default_auto_select_family_attempt_timeout(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_from_i32(net_auto_select_family_attempt_timeout);
}

/* validateInt32(value, 'value', 1), then values below 10 become 10. */
static MalValue net_set_default_auto_select_family_attempt_timeout(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    f64 value;
    if (!mal_node_validate_integer(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "value", 1,
            2147483647.0, &value)) {
        return mal_value_new_undefined();
    }
    net_auto_select_family_attempt_timeout = value < 10 ? 10 : (i32) value;
    return mal_value_new_undefined();
}

static MalValue net_ip_function(
    MalVm *vm, const byte *name, MalNativeFunctionCallback callback
) {
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name), 1, callback);
    roots[0] = mal_value_from_native_function_object(function);
    mal_native_function_object_set_constructor(function);
    mal_native_function_object_set_handles_new_target_prototype(function);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", roots[1],
        MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "constructor", roots[0],
        NET_METHOD);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue net_socket_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(new_target) && mal_value_is_object(receiver)) {
        mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR],
            receiver, &options, 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        net_set(vm, receiver, "connecting", mal_value_new_boolean(false));
        net_set(vm, receiver, "pending", mal_value_new_boolean(true));
        net_set(vm, receiver, "readyState", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "open")));
        return mal_value_new_undefined();
    }
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_PROTOTYPE]);
    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    net_socket_constructor(vm, instance, &options, 1,
        mal_value_new_undefined(), callee);
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : instance;
}

// `subject` names the value in Node's error for a host holding U+0000, which a C string would
// silently cut short.
static bool net_ascii_string(
    MalVm *vm, MalValue value, const char *subject, char **out) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    usize length = mal_string_length(string);
    char *text = malloc(length + 1);
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] == 0) {
            free(text);
            mal_node_dns_throw_null_bytes(vm, subject, value);
            return false;
        }
        if (units[i] > 0x7f) {
            free(text);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Socket host must be ASCII");
            return false;
        }
        text[i] = (char) units[i];
    }
    text[length] = '\0';
    *out = text;
    return true;
}

static bool net_start_next_address(MalNodeNetSocketState *state) {
    while (state->address_index < state->address_count) {
        usize index = state->address_index++;
        if (mal_tcp_connect_address_start(mal_host(state->vm),
                (const struct sockaddr *) &state->addresses[index],
                state->address_lengths[index], &state->operation)) {
            state->resolving = false;
            return true;
        }
    }
    return false;
}

static bool net_store_addresses(
    MalNodeNetSocketState *state, const struct sockaddr_storage *addresses, const socklen_t *lengths, usize count) {
    struct sockaddr_storage *stored = calloc(count, sizeof(*stored));
    socklen_t *stored_lengths = calloc(count, sizeof(*stored_lengths));
    if (stored == nullptr || stored_lengths == nullptr) {
        free(stored);
        free(stored_lengths);
        return false;
    }
    memcpy(stored, addresses, count * sizeof(*stored));
    memcpy(stored_lengths, lengths, count * sizeof(*stored_lengths));
    free(state->addresses);
    free(state->address_lengths);
    state->addresses = stored;
    state->address_lengths = stored_lengths;
    state->address_count = count;
    state->address_index = 0;
    return true;
}

static bool net_pump_writes(MalNodeNetSocketState *state);
static void net_maybe_shutdown_write(MalNodeNetSocketState *state);

static void net_emit_lookup(MalVm *vm, MalValue socket, MalValue error, MalValue address, MalValue family,
    MalValue host) {
    MalValue values[] = {mal_value_new_undefined(),
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "lookup")), error, address, family, host};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    if (net_get(vm, socket, "emit", &values[0])) mal_vm_call_value(vm, values[0], socket, values + 1, 5);
    mal_gc_unroot(&root);
}

/* Slots: [socket, error]; lib/net.js connectErrorNT. */
static MalValue net_destroy_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue error = mal_native_function_object_get_slot(self, 1);
    net_call_method(vm, mal_native_function_object_get_slot(self, 0), "destroy", &error, 1);
    return mal_value_new_undefined();
}

static void net_next_tick(MalVm *vm, MalValue receiver, MalNativeFunctionCallback callback, MalValue *slots, i32 count);
static MalValue net_coded_error(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code);

static bool net_lookup_address(MalValue address, MalValue family, u16 port,
    struct sockaddr_storage *out, socklen_t *length) {
    if (!mal_value_is_string(address) || !mal_ops_is_number(family)) return false;
    f64 number = mal_ops_number_as_f64(family);
    if (number != 4 && number != 6) return false;
    char text[MAL_NET_ADDRESS_MAX + 1];
    MalString *string = mal_value_to_string(address);
    usize count = mal_string_length(string);
    if (count > MAL_NET_ADDRESS_MAX) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < count; i++) {
        if (units[i] > 0x7f) return false;
        text[i] = (char) units[i];
    }
    text[count] = '\0';
    return mal_net_parse_ip(text, port, out, length)
        && out->ss_family == (number == 4 ? AF_INET : AF_INET6);
}

/* Slots: [socket, host, single]; lib/net.js emitLookup for lookupAndConnect and lookupAndConnectMultiple. */
static MalValue net_lookup_done(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue undefined = mal_value_new_undefined();
    // [socket, host, error, addresses, item, address, family]
    MalValue roots[] = {mal_native_function_object_get_slot(self, 0), mal_native_function_object_get_slot(self, 1),
        argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined, undefined, undefined,
        argc > 2 ? args[2] : undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool single = mal_value_is_truthy(mal_native_function_object_get_slot(self, 2));
    struct sockaddr_storage *addresses = nullptr;
    socklen_t *lengths = nullptr;
    usize count = 0;
    MalNodeNetSocketState *state = nullptr;
    if (single) {
        net_emit_lookup(vm, roots[0], roots[2], roots[3], roots[6], roots[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    state = net_state(roots[0]);
    if (state == nullptr || state->destroyed || !state->resolving) goto done;
    if (!mal_value_is_nil(roots[2])) {
        if (!single) {
            net_emit_lookup(vm, roots[0], roots[2], undefined, undefined, roots[1]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
        }
        net_next_tick(vm, roots[0], net_destroy_task, &roots[2], 1);
        goto done;
    }
    f64 total = 1;
    if (!single) {
        MalValue length_value;
        if (!mal_value_is_object(roots[3]) || !net_get(vm, roots[3], "length", &length_value)) goto invalid;
        total = mal_ops_is_number(length_value) ? mal_ops_number_as_f64(length_value) : 0;
        if (!(total >= 0) || total > 4096) total = 0;
    }
    addresses = calloc(total > 0 ? (usize) total : 1, sizeof(*addresses));
    lengths = calloc(total > 0 ? (usize) total : 1, sizeof(*lengths));
    if (addresses == nullptr || lengths == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    for (usize i = 0; i < (usize) total; i++) {
        if (single) {
            roots[5] = roots[3];
        } else {
            if (!mal_vm_get_property(vm, roots[3], mal_key_index((u32) i), &roots[4])
                || !mal_value_is_object(roots[4]) || !net_get(vm, roots[4], "address", &roots[5])
                || !net_get(vm, roots[4], "family", &roots[6])) {
                if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
                continue;
            }
            net_emit_lookup(vm, roots[0], roots[2], roots[5], roots[6], roots[1]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            state = net_state(roots[0]);
            if (state == nullptr || state->destroyed || !state->resolving) goto done;
        }
        if (net_lookup_address(roots[5], roots[6], state->port, &addresses[count], &lengths[count])) count++;
    }
    if (count == 0) goto invalid;
    if (!net_store_addresses(state, addresses, lengths, count) || !net_start_next_address(state)) {
        roots[2] = net_error(vm, EIO);
        net_next_tick(vm, roots[0], net_destroy_task, &roots[2], 1);
        goto done;
    }
    net_pump_writes(state);
    net_maybe_shutdown_write(state);
    goto done;
invalid:
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[2] = net_coded_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid IP address: undefined",
            "ERR_INVALID_IP_ADDRESS");
        net_next_tick(vm, roots[0], net_destroy_task, &roots[2], 1);
    }
done:
    free(addresses);
    free(lengths);
    mal_gc_unroot(&root);
    return undefined;
}

/* lib/net.js lookupAndConnect: `lookup(host, { family, hints[, all] }, emitLookup)`, dns.lookup by default. */
static bool net_socket_lookup(
    MalVm *vm, MalValue socket, MalValue host, MalValue lookup, MalValue family, MalValue hints) {
    MalValue undefined = mal_value_new_undefined();
    // [socket, host, lookup, family, options, callback, slots...]
    MalValue roots[] = {socket, host, lookup, family, undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_string(family)) {
        if (mal_string_equals_ascii(mal_value_to_string(family), "IPv4")) roots[3] = mal_value_from_i32(4);
        else if (mal_string_equals_ascii(mal_value_to_string(family), "IPv6")) roots[3] = mal_value_from_i32(6);
    }
    bool single = mal_ops_is_number(roots[3])
        && (mal_ops_number_as_f64(roots[3]) == 4 || mal_ops_number_as_f64(roots[3]) == 6);
    MalObject *options = mal_intrinsic_new_object(vm);
    roots[4] = mal_value_from_object(options);
    mal_intrinsic_define_data(vm, options, (const byte *) "family", roots[3], NET_VISIBLE);
    MalValue hint_value = mal_value_is_truthy(hints) ? hints : mal_value_from_i32(0);
    if (!single && !mal_value_is_truthy(hints)) hint_value = mal_value_from_i32(AI_ADDRCONFIG);
    mal_intrinsic_define_data(vm, options, (const byte *) "hints", hint_value, NET_VISIBLE);
    // Node's default autoSelectFamily asks for every address when no family is pinned.
    if (!single) mal_intrinsic_define_data(vm, options, (const byte *) "all", mal_value_new_boolean(true), NET_VISIBLE);
    MalValue slots[] = {socket, host, mal_value_new_boolean(single)};
    roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "emitLookup"), net_lookup_done, slots, countof(slots)));
    MalValue call_args[] = {roots[1], roots[4], roots[5]};
    if (mal_value_is_nil(roots[2])) mal_node_dns_lookup(vm, call_args, 3);
    else mal_vm_call_value(vm, roots[2], undefined, call_args, 3);
    mal_gc_unroot(&root);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static MalValue net_socket_connect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (net_state(receiver) != nullptr || argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Socket is already connecting or connected");
        return mal_value_new_undefined();
    }
    MalValue undefined = mal_value_new_undefined();
    // [options, port, host, path, lookup, family, hints]
    MalValue roots[] = {args[0], undefined, undefined, undefined, undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    char *host = nullptr;
    char *path = nullptr;
    // lib/net.js normalizeArgs: an options object, a pipe name, or port[, host].
    if (mal_value_is_object(args[0])) {
        if (!net_get(vm, roots[0], "path", &roots[3]) || !net_get(vm, roots[0], "port", &roots[1])
            || !net_get(vm, roots[0], "host", &roots[2]) || !net_get(vm, roots[0], "lookup", &roots[4])
            || !net_get(vm, roots[0], "family", &roots[5]) || !net_get(vm, roots[0], "hints", &roots[6])) goto done;
        if (!mal_value_is_truthy(roots[3])) roots[3] = undefined;
        if (!mal_value_is_nil(roots[4]) && !mal_value_is_callable(roots[4])) {
            mal_node_throw_invalid_arg_type(vm, "options.lookup", "of type function", roots[4]);
            goto done;
        }
    } else {
        bool is_pipe;
        if (!net_is_pipe_name(vm, args[0], &is_pipe)) goto done;
        if (is_pipe) {
            roots[3] = args[0];
        } else {
            roots[1] = args[0];
            if (argc > 1 && !mal_value_is_callable(args[1])) roots[2] = args[1];
        }
    }
    struct sockaddr_storage pipe_address;
    socklen_t pipe_length = 0;
    f64 port_number = 0;
    if (!mal_value_is_undefined(roots[3])) {
        if (!net_pipe_address(vm, roots[3], &pipe_address, &pipe_length, &path)) goto done;
    } else {
        if (!mal_vm_to_number(vm, roots[1], &port_number)
            || !isfinite(port_number) || floor(port_number) != port_number
            || port_number < 0 || port_number > 65535) {
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                                   "Socket port is out of range");
            }
            goto done;
        }
        if (!mal_value_is_truthy(roots[2])) {
            roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "localhost"));
        }
        if (!net_ascii_string(vm, roots[2], "The property 'options.host'", &host)) goto done;
    }
    MalNodeNetSocketState *state = calloc(1, sizeof(MalNodeNetSocketState));
    if (state == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    state->vm = vm;
    state->receiver = receiver;
    state->async_context = mal_async_context_capture(vm);
    state->destroy_error = undefined;
    state->server = undefined;
    state->next_write_token = 1;
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    bool started = true;
    bool lookup = false;
    if (path != nullptr) {
        state->path = path;
        path = nullptr;
        started = mal_tcp_connect_address_start(mal_host(vm),
            (const struct sockaddr *) &pipe_address, pipe_length, &state->operation);
    } else {
        state->port = (u16) port_number;
        struct sockaddr_storage numeric;
        socklen_t numeric_length;
        // lib/net.js lookupAndConnect: an IP host connects without any lookup.
        if (mal_net_parse_ip(host, state->port, &numeric, &numeric_length)) {
            started = net_store_addresses(state, &numeric, &numeric_length, 1) && net_start_next_address(state);
        } else {
            state->resolving = true;
            lookup = true;
        }
    }
    if (!started) {
        net_state_free(state);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start socket connection");
        goto done;
    }
    state->next = net_sockets;
    net_sockets = state;
    net_set(vm, receiver, "connecting", mal_value_new_boolean(true));
    net_set(vm, receiver, "pending", mal_value_new_boolean(true));
    net_set(vm, receiver, "destroyed", mal_value_new_boolean(false));
    net_set(vm, receiver, "readyState", mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) "opening")));

    if (argc > 1 && mal_value_is_callable(args[argc - 1])) {
        MalValue once_args[] = {
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "connect")),
            args[argc - 1],
        };
        net_call_method(vm, receiver, "once", once_args, 2);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    if (lookup && !net_socket_lookup(vm, receiver, roots[2], roots[4], roots[5], roots[6])) goto done;
    result = receiver;
done:
    free(host);
    free(path);
    mal_gc_unroot(&root);
    return result;
}

static bool net_chunk_bytes(
    MalVm *vm, MalValue chunk, byte **out, usize *length) {
    if (mal_value_is_string(chunk)) {
        *out = mal_string_to_utf8(mal_value_to_string(chunk), length);
        if (*out == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        return true;
    }
    if (!mal_value_is_typed_array_object(chunk)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Socket chunk must be a string or byte view");
        return false;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(chunk);
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Socket chunk is out of bounds");
        return false;
    }
    *length = mal_typed_array_object_byte_length(array);
    *out = malloc(*length == 0 ? 1 : *length);
    if (*out == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    if (*length > 0) {
        mal_typed_array_copy_bytes(*out, false, array->buffer->data + array->byte_offset,
                                   array->buffer->shared_memory != nullptr, *length);
    }
    return true;
}

static bool net_pump_writes(MalNodeNetSocketState *state) {
    if (state->resolving || state->write_in_flight || state->write_head == nullptr) {
        return true;
    }
    MalNodeNetWrite *write = state->write_head;
    usize selected = write->length - write->offset;
    if (selected > NET_WRITE_SEGMENT) selected = NET_WRITE_SEGMENT;
    byte *segment = malloc(selected);
    if (segment == nullptr) {
        mal_vm_throw_allocation_error(state->vm);
        return false;
    }
    memcpy(segment, write->bytes + write->offset, selected);
    if (!mal_tcp_write_owned(
            mal_host(state->vm), state->operation, segment, selected, write->token)) {
        free(segment);
        mal_vm_throw_error(state->vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Socket transport rejected an accepted write");
        return false;
    }
    state->active_segment = selected;
    state->write_in_flight = true;
    return true;
}

static void net_maybe_shutdown_write(MalNodeNetSocketState *state) {
    if (state->ending && !state->resolving && !state->write_in_flight
        && state->write_head == nullptr) {
        (void) mal_tcp_shutdown_write(mal_host(state->vm), state->operation);
    }
}

static MalValue net_socket_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    if (state == nullptr || state->destroyed || state->ending) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_boolean(false);
    }
    byte *bytes;
    usize length;
    if (argc < 1 || !net_chunk_bytes(vm, args[0], &bytes, &length)) {
        return mal_value_new_boolean(false);
    }
    MalValue callback = argc > 1 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    if (length == 0) {
        free(bytes);
        if (!mal_value_is_undefined(callback)) {
            mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
        }
        return mal_value_new_boolean(true);
    }
    MalNodeNetWrite *write = calloc(1, sizeof(MalNodeNetWrite));
    if (write == nullptr) {
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_boolean(false);
    }
    write->token = state->next_write_token++;
    write->bytes = bytes;
    write->length = length;
    write->callback = callback;
    write->async_context = mal_async_context_capture(vm);
    if (state->write_tail == nullptr) state->write_head = write;
    else state->write_tail->next = write;
    state->write_tail = write;
    state->queued_write_bytes += length;
    bool below_high_water = state->queued_write_bytes < NET_WRITE_HIGH_WATER;
    if (!below_high_water) state->backpressured = true;
    if (!net_pump_writes(state)) return mal_value_new_boolean(false);
    return mal_value_new_boolean(below_high_water);
}

static MalValue net_socket_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    if (state == nullptr || state->destroyed) return receiver;
    if (argc > 0 && !mal_value_is_undefined(args[0]) && !mal_value_is_callable(args[0])) {
        net_socket_write(vm, receiver, args, argc,
            mal_value_new_undefined(), mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    }
    state->ending = true;
    net_set(vm, receiver, "writable", mal_value_new_boolean(false));
    net_set(vm, receiver, "readyState", mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) "readOnly")));
    net_maybe_shutdown_write(state);
    return receiver;
}

static void net_dispatch_terminal(
    MalVm *vm, MalNodeNetSocketState *state, MalHostTask *task, MalTcpTerminal *terminal);

/* Slots: [socket]; a socket destroyed during its lookup has no host operation to cancel. */
static MalValue net_resolving_close_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue socket = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalNodeNetSocketState *state = net_state(socket);
    if (state == nullptr || !state->resolving) return mal_value_new_undefined();
    MalNodeNetSocketState **link = net_state_link(state);
    if (*link == state) *link = state->next;
    MalRootSpan root;
    mal_gc_root(&root, &socket, 1);
    MalHostTask cancelled = {.kind = MAL_HOST_TASK_TERMINAL, .result = MAL_HOST_TERMINAL_CANCELLED};
    net_dispatch_terminal(vm, state, &cancelled, nullptr);
    net_state_free(state);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue net_socket_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    if (state == nullptr || state->destroyed) return receiver;
    state->destroyed = true;
    state->destroy_error = argc > 0 ? args[0] : mal_value_new_undefined();
    net_set(vm, receiver, "destroyed", mal_value_new_boolean(true));
    if (state->resolving) {
        net_next_tick(vm, receiver, net_resolving_close_task, nullptr, 0);
    } else {
        mal_tcp_cancel(mal_host(vm), state->operation);
    }
    return receiver;
}

static MalValue net_call_readable_method(
    MalVm *vm, MalValue receiver, const char *name) {
    MalValue method;
    MalValue prototype = vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE];
    if (!net_get(vm, prototype, name, &method)) return mal_value_new_undefined();
    MalCompletion completion = mal_vm_call_value(
        vm, method, receiver, nullptr, 0);
    return completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : completion.value;
}

static MalValue net_socket_pause(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    if (state != nullptr && !state->destroyed) {
        state->read_paused = true;
        if (!state->resolving) (void) mal_tcp_read_pause(mal_host(vm), state->operation);
    }
    return net_call_readable_method(vm, receiver, "pause");
}

static MalValue net_socket_resume(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalValue result = net_call_readable_method(vm, receiver, "resume");
    MalNodeNetSocketState *state = net_state(receiver);
    if (state != nullptr && !state->destroyed) {
        state->read_paused = false;
        if (!state->resolving) (void) mal_tcp_read_resume(mal_host(vm), state->operation);
    }
    return result;
}

static MalValue net_socket_set_keep_alive(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    bool enabled = argc > 0 && mal_value_is_truthy(args[0]);
    u32 delay = 0;
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        f64 number;
        if (!mal_vm_to_number(vm, args[1], &number)) return mal_value_new_undefined();
        if (isfinite(number) && number > 0) {
            delay = number > UINT32_MAX ? UINT32_MAX : (u32) number;
        }
    }
    if (state != nullptr && !state->resolving) {
        (void) mal_tcp_set_keep_alive(
            mal_host(vm), state->operation, enabled, delay);
    }
    return receiver;
}

static MalValue net_socket_set_no_delay(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    bool enabled = argc < 1 || mal_value_is_undefined(args[0])
        || mal_value_is_truthy(args[0]);
    if (state != nullptr && !state->resolving) {
        (void) mal_tcp_set_no_delay(mal_host(vm), state->operation, enabled);
    }
    return receiver;
}

static MalValue net_create_connection(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalCompletion socket = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_CONSTRUCTOR], nullptr, 0);
    if (socket.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue result = socket.value;
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    net_socket_connect(vm, result, args, argc,
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : result;
}

static void net_scan_servers(MalVm *vm);

static void net_scan_roots(MalVm *vm, void *data) {
    (void) data;
    net_scan_servers(vm);
    for (MalNodeNetSocketState *state = net_sockets; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(state->destroy_error);
        mal_gc_mark_value(state->server);
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) state->async_context));
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) state->tls_context));
        for (MalNodeNetWrite *write = state->write_head;
             write != nullptr; write = write->next) {
            mal_gc_mark_value(write->callback);
            mal_gc_mark_value(
                mal_async_internal_value((MalHeapHeader *) write->async_context));
        }
    }
}

static void net_write_complete(MalVm *vm, MalNodeNetSocketState *state, u64 token) {
    MalNodeNetWrite *write = state->write_head;
    if (write == nullptr || write->token != token || !state->write_in_flight) return;
    write->offset += state->active_segment;
    state->queued_write_bytes -= state->active_segment;
    state->active_segment = 0;
    state->write_in_flight = false;
    if (write->offset == write->length) {
        state->write_head = write->next;
        if (state->write_head == nullptr) state->write_tail = nullptr;
        MalValue callback = write->callback;
        MalAsyncContext *async_context = write->async_context;
        free(write->bytes);
        free(write);
        if (!mal_value_is_undefined(callback)) {
            MalRootSpan root;
            mal_gc_root(&root, &callback, 1);
            MalAsyncContextScope scope;
            mal_async_context_scope_enter(vm, &scope, async_context);
            mal_vm_call_value(vm, callback, mal_value_new_undefined(), nullptr, 0);
            mal_async_context_scope_exit(vm, &scope);
            mal_gc_unroot(&root);
        }
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    if (state->backpressured
        && state->queued_write_bytes <= NET_WRITE_LOW_WATER) {
        state->backpressured = false;
        net_emit(vm, state->receiver, "drain", nullptr, 0);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        net_pump_writes(state);
        net_maybe_shutdown_write(state);
    }
}

static MalNodeNetServerState *net_server_state(MalValue receiver);

static MalValue net_tls_info_value(MalVm *vm, MalNodeNetSocketState *state, int kind) {
    byte text[256];
    i64 length = state->destroyed ? -1
        : mal_tcp_tls_info(mal_host(vm), state->operation, kind, text, sizeof(text));
    if (length < 0 || (usize) length > sizeof(text)) return mal_value_new_undefined();
    MalString *string = mal_string_from_utf8(&vm->heap, text, (usize) length);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static MalValue net_tls_get_protocol(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    MalValue value = state == nullptr ? mal_value_new_undefined()
        : net_tls_info_value(vm, state, MAL_TLS_INFO_PROTOCOL);
    return mal_value_is_undefined(value) ? mal_value_new_null() : value;
}

static MalValue net_tls_get_cipher(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    if (state == nullptr) return mal_value_new_undefined();
    MalValue roots[] = {
        net_tls_info_value(vm, state, MAL_TLS_INFO_CIPHER), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    if (mal_value_is_undefined(roots[0])) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = net_tls_info_value(vm, state, MAL_TLS_INFO_PROTOCOL);
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "name", roots[0], NET_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "standardName", roots[0], NET_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "version", roots[1], NET_VISIBLE);
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

// Node keeps a repeated name attribute (several OU, say) as an array of its values.
static void net_x509_name_add(MalVm *vm, MalValue name, const char *key, MalValue value) {
    MalKey property = mal_intrinsic_string_key(vm, (const byte *) key);
    MalPropertyLookup existing = mal_object_get_own(mal_value_to_object(name), property);
    if (!existing.present) {
        mal_object_set(mal_value_to_object(name), property, value);
        return;
    }
    MalValue roots[] = {value, existing.desc.value, property.value};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_array_object(roots[1])) {
        MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
        (void) mal_array_object_set(array, mal_key_index(0), roots[1]);
        roots[1] = mal_value_from_array_object(array);
        property.value = roots[2];
        mal_object_set(mal_value_to_object(name), property, roots[1]);
    }
    MalArrayObject *array = mal_value_to_array_object(roots[1]);
    (void) mal_array_object_set(array, mal_key_index(mal_array_object_length(array)), roots[0]);
    mal_gc_unroot(&root);
}

/* TLSSocket state Node exposes once the handshake completes. */
// Node's TLSSocket.prototype.getPeerCertificate for the leaf; `{}` without a peer certificate.
static MalValue net_tls_get_peer_certificate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target, (void) callee;
    MalNodeNetSocketState *state = net_state(receiver);
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    i64 length = state == nullptr || state->destroyed ? -1
        : mal_tcp_tls_peer_certificate(mal_host(vm), state->operation, nullptr, 0);
    byte *der = length > 0 ? malloc((usize) length) : nullptr;
    if (der == nullptr
        || mal_tcp_tls_peer_certificate(mal_host(vm), state->operation, der, (usize) length) != length) {
        free(der);
        mal_gc_unroot(&root);
        return roots[0];
    }
    intptr_t records_length = mal_tls_x509_describe(der, (usize) length, nullptr, 0);
    byte *records = records_length > 0 ? malloc((usize) records_length) : nullptr;
    if (records != nullptr && mal_tls_x509_describe(der, (usize) length, records, (usize) records_length) == records_length) {
        roots[1] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        net_set(vm, roots[0], "subject", roots[1]);
        net_set(vm, roots[0], "issuer", roots[2]);
        MalX509Record record;
        for (usize at = 0; mal_x509_record_next(records, (usize) records_length, &at, &record);) {
            roots[3] = mal_value_from_string(mal_string_from_utf8(&vm->heap, record.value, record.value_length));
            if (record.kind == 'S' || record.kind == 'I') {
                net_x509_name_add(vm, record.kind == 'S' ? roots[1] : roots[2], record.key, roots[3]);
            } else {
                net_set(vm, roots[0], record.key, roots[3]);
            }
        }
        roots[3] = mal_node_buffer_from_owned_bytes(vm, der, (usize) length);
        der = nullptr;
        if (vm->completion.kind != MAL_COMPLETION_THROW) net_set(vm, roots[0], "raw", roots[3]);
    }
    free(records);
    free(der);
    mal_gc_unroot(&root);
    return roots[0];
}

static void net_tls_describe(MalVm *vm, MalNodeNetSocketState *state) {
    MalValue value = net_tls_info_value(vm, state, MAL_TLS_INFO_ALPN);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    net_set(vm, state->receiver, "alpnProtocol",
        mal_value_is_undefined(value) ? mal_value_new_boolean(false) : value);
    if (state->tls_server) {
        value = net_tls_info_value(vm, state, MAL_TLS_INFO_SERVER_NAME);
        net_set(vm, state->receiver, "servername",
            mal_value_is_undefined(value) ? mal_value_new_boolean(false) : value);
    }
    value = net_tls_info_value(vm, state, MAL_TLS_INFO_PEER_CERTIFIED);
    net_set(vm, state->receiver, "authorized", mal_value_new_boolean(!mal_value_is_undefined(value)));
    value = net_tls_info_value(vm, state, MAL_TLS_INFO_AUTHORIZATION_ERROR);
    net_set(vm, state->receiver, "authorizationError", mal_value_is_undefined(value) ? mal_value_new_null() : value);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(state->receiver),
        (const byte *) "getProtocol", 0, net_tls_get_protocol);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(state->receiver),
        (const byte *) "getCipher", 0, net_tls_get_cipher);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(state->receiver),
        (const byte *) "getPeerCertificate", 1, net_tls_get_peer_certificate);
    mal_gc_unroot(&root);
}

static bool net_tls_config_from(
    MalVm *vm, MalValue server, MalValue creds, MalTlsServerConfig **config, bool *without_cert);

static bool net_server_uses_sni(MalVm *vm, MalValue server) {
    MalValue value;
    if (!net_get(vm, server, "_malSNICallback", &value)) return false;
    if (mal_value_is_callable(value)) return true;
    return net_get(vm, server, "_contexts", &value) && mal_value_is_array_object(value)
        && mal_array_object_length(mal_value_to_array_object(value)) > 0;
}

// lib/_tls_wrap.js addContext: `*` matches `[^.]*`, everything else literally, ignoring ASCII case.
static bool net_sni_matches(const c16 *pattern, usize pattern_length, const byte *name, usize name_length) {
    if (pattern_length == 0) return name_length == 0;
    if (pattern[0] == '*') {
        for (usize skip = 0;; skip++) {
            if (net_sni_matches(pattern + 1, pattern_length - 1, name + skip, name_length - skip)) return true;
            if (skip == name_length || name[skip] == '.') return false;
        }
    }
    if (name_length == 0) return false;
    c16 a = pattern[0], b = name[0];
    if (a >= 'A' && a <= 'Z') a = (c16) (a + 32);
    if (b >= 'A' && b <= 'Z') b = (c16) (b + 32);
    return a == b && net_sni_matches(pattern + 1, pattern_length - 1, name + 1, name_length - 1);
}

static MalTlsServerConfig *net_sni_config(MalVm *vm, MalNodeNetServerState *server, MalValue context) {
    if (!mal_value_is_object(context)) return server->tls_config;
    for (usize i = 0; i < countof(server->sni_cache); i++) {
        if (server->sni_cache[i].config != nullptr && server->sni_cache[i].context == context) {
            return server->sni_cache[i].config;
        }
    }
    MalTlsServerConfig *config = nullptr;
    bool without_cert = false;
    if (!net_tls_config_from(vm, server->receiver, context, &config, &without_cert) || config == nullptr) {
        return nullptr;
    }
    usize slot = server->sni_cache_next++ % countof(server->sni_cache);
    mal_tls_server_config_free(&server->sni_cache[slot].config);
    server->sni_cache[slot].context = context;
    server->sni_cache[slot].config = config;
    return config;
}

static void net_sni_select(MalVm *vm, MalNodeNetSocketState *state, MalValue context) {
    state->sni_pending = false;
    MalNodeNetServerState *server = net_server_state(state->server);
    MalTlsServerConfig *config = server == nullptr ? nullptr : net_sni_config(vm, server, context);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    (void) mal_tcp_tls_select(mal_host(vm), state->operation, config);
}

static void net_sni_fail(MalVm *vm, MalNodeNetSocketState *state, MalValue error) {
    state->sni_pending = false;
    MalValue roots[] = {error, state->receiver, state->server};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Node destroys the socket first, so tlsClientError listeners see it destroyed.
    (void) net_call_method(vm, roots[1], "destroy", nullptr, 0);
    (void) net_emit(vm, roots[2], "tlsClientError", roots, 2);
    mal_gc_unroot(&root);
}

static MalValue net_sni_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue socket = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalNodeNetSocketState *state = net_state(socket);
    if (state == nullptr || state->destroyed) return mal_value_new_undefined();
    MalValue roots[] = {socket, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!state->sni_pending) {
        roots[1] = net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Callback called multiple times",
            "ERR_MULTIPLE_CALLBACK");
        (void) net_call_method(vm, roots[0], "destroy", &roots[1], 1);
    } else if (mal_value_is_truthy(roots[1])) {
        net_sni_fail(vm, state, roots[1]);
    } else {
        net_sni_select(vm, state, roots[2]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

MalValue mal_node_net_sni_match(MalVm *vm, MalValue server, const byte *name, usize length) {
    MalValue contexts_value;
    if (!net_get(vm, server, "_contexts", &contexts_value) || !mal_value_is_array_object(contexts_value)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *contexts = mal_value_to_array_object(contexts_value);
    for (u32 i = mal_array_object_length(contexts); i-- > 0;) {
        MalValue entry;
        if (!mal_array_object_dense_get(contexts, i, &entry) || !mal_value_is_array_object(entry)) continue;
        MalValue pattern, context;
        if (!mal_array_object_dense_get(mal_value_to_array_object(entry), 0, &pattern)
            || !mal_array_object_dense_get(mal_value_to_array_object(entry), 1, &context)
            || !mal_value_is_string(pattern)) {
            continue;
        }
        MalString *text = mal_value_to_string(pattern);
        if (net_sni_matches(mal_string_code_units(text), mal_string_length(text), name, length)) return context;
    }
    return mal_value_new_undefined();
}

MalTlsServerConfig *mal_node_net_context_config(MalVm *vm, MalValue server, MalValue context) {
    MalTlsServerConfig *config = nullptr;
    bool without_cert = false;
    if (!net_tls_config_from(vm, server, context, &config, &without_cert)) return nullptr;
    return config;
}

static void net_sni_hello(MalVm *vm, MalNodeNetSocketState *state, MalTcpProgress *progress) {
    state->sni_pending = true;
    if (progress->bytes == nullptr) {
        net_sni_select(vm, state, mal_value_new_undefined());
        return;
    }
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), state->receiver,
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!net_get(vm, state->server, "_malSNICallback", &roots[0])) goto done;
    if (mal_value_is_callable(roots[0])) {
        roots[1] = mal_value_from_string(mal_string_from_utf8(&vm->heap, progress->bytes, progress->length));
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) ""), 2, net_sni_callback, &roots[3], 1));
        MalValue call_args[] = {roots[1], roots[2]};
        MalCompletion called = mal_vm_call_value(vm, roots[0], state->server, call_args, 2);
        // Node catches an SNICallback that throws and fails the connection with that error;
        // dropping it would leave the handshake waiting forever.
        if (called.kind == MAL_COMPLETION_THROW) {
            roots[1] = called.value;
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
            if (!state->destroyed) net_sni_fail(vm, state, roots[1]);
        }
        goto done;
    }
    roots[2] = mal_node_net_sni_match(vm, state->server, progress->bytes, progress->length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    net_sni_select(vm, state, roots[2]);
done:
    mal_gc_unroot(&root);
}

static void net_set_endpoints(MalVm *vm, MalValue socket, MalHostHandle operation);

static void net_dispatch_progress_in_context(
    MalVm *vm, MalNodeNetSocketState *state, MalTcpProgress *progress) {
    if (progress->kind == MAL_TCP_TLS_CLIENT_HELLO) {
        net_sni_hello(vm, state, progress);
        return;
    }
    if (progress->kind == MAL_TCP_SECURE_CONNECTED) {
        state->secure = true;
        net_set(vm, state->receiver, "encrypted", mal_value_new_boolean(true));
        net_tls_describe(vm, state);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        if (state->tls_server) {
            MalValue socket = state->receiver;
            net_emit(vm, state->server, "secureConnection", &socket, 1);
        } else {
            net_emit(vm, state->receiver, "secureConnect", nullptr, 0);
        }
        return;
    }
    if (progress->kind == MAL_TCP_CONNECTED) {
        state->connected = true;
        net_set(vm, state->receiver, "connecting", mal_value_new_boolean(false));
        net_set(vm, state->receiver, "pending", mal_value_new_boolean(false));
        net_set(vm, state->receiver, "readyState", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "open")));
        net_set_endpoints(vm, state->receiver, state->operation);
        if (state->read_paused) {
            (void) mal_tcp_read_pause(mal_host(vm), state->operation);
        }
        net_pump_writes(state);
        net_maybe_shutdown_write(state);
        net_emit(vm, state->receiver, "connect", nullptr, 0);
        return;
    }
    if (progress->kind == MAL_TCP_WRITE_COMPLETE) {
        net_write_complete(vm, state, progress->write_token);
        return;
    }
    if (progress->kind == MAL_TCP_DATA) {
        byte *bytes = progress->bytes;
        usize length = progress->length;
        progress->bytes = nullptr;
        MalValue buffer = mal_node_buffer_from_owned_bytes(vm, bytes, length);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            net_call_method(vm, state->receiver, "push", &buffer, 1);
        }
    }
}

static void net_dispatch_progress(
    MalVm *vm, MalNodeNetSocketState *state, MalTcpProgress *progress) {
    MalAsyncContext *context =
        state->tls_context != nullptr
            && (progress->kind == MAL_TCP_SECURE_CONNECTED
                || progress->kind == MAL_TCP_DATA)
        ? state->tls_context
        : state->async_context;
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    net_dispatch_progress_in_context(vm, state, progress);
    mal_async_context_scope_exit(vm, &scope);
}

bool mal_node_net_start_tls(
    MalVm *vm, MalValue socket,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, const MalTlsClientIdentity *identity, bool insecure) {
    MalNodeNetSocketState *state = net_state(socket);
    if (state == nullptr || state->vm != vm || !state->connected
        || state->destroyed || state->resolving
        || !mal_tcp_start_tls(mal_host(vm), state->operation,
            server_name, server_name_length, ca_pem, ca_pem_length,
            alpn, alpn_length, identity, insecure)) {
        return false;
    }
    /* TLSWrap is a new async resource even though this adapter reuses the
     * JavaScript socket object. TLS handshake/data progress inherits the context
     * active at tls.connect(); the underlying handle still owns terminal events,
     * and queued writes retain their per-write captures. */
    state->tls_context = mal_async_context_capture(vm);
    return true;
}

static void net_dispatch_terminal(
    MalVm *vm, MalNodeNetSocketState *state, MalHostTask *task,
    MalTcpTerminal *terminal) {
    bool had_error = task->result == MAL_HOST_TERMINAL_ERROR
        || !mal_value_is_nil(state->destroy_error);
    MalValue error = state->destroy_error;
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    bool tls_client_error = state->tls_server && !state->secure
        && task->result == MAL_HOST_TERMINAL_ERROR && mal_value_is_nil(error);
    if (tls_client_error) {
        MalNodeNetServerState *server = net_server_state(state->server);
        int code = terminal == nullptr ? EIO : terminal->error;
        char failure_code[64];
        if (code == EPROTO && terminal->tls_failure[0] != '\0') {
            usize length = (usize) snprintf(failure_code, sizeof(failure_code), "ERR_SSL_%s", terminal->tls_failure);
            for (usize i = 8; i < length && i < sizeof(failure_code); i++) {
                char c = failure_code[i];
                failure_code[i] = c == ' ' ? '_' : c >= 'a' && c <= 'z' ? (char) (c - 32) : c;
            }
        }
        error = code != EPROTO ? net_error(vm, code)
            : terminal->tls_failure[0] != '\0'
            ? net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, terminal->tls_failure, failure_code)
            : server != nullptr && server->tls_without_cert
            ? net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "no suitable signature algorithm",
                "ERR_SSL_NO_SUITABLE_SIGNATURE_ALGORITHM")
            : net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "TLS handshake failed",
                "ERR_SSL_SSL_HANDSHAKE_FAILURE");
        MalValue args[] = {error, state->receiver};
        net_emit(vm, state->server, "tlsClientError", args, 2);
        error = mal_value_new_undefined();
    } else if (task->result == MAL_HOST_TERMINAL_ERROR && mal_value_is_nil(error)) {
        int code = terminal == nullptr ? EIO : terminal->error;
        error = state->path != nullptr && !state->connected
            ? net_pipe_error(vm, code, "connect", state->path) : net_error(vm, code);
    }
    if (!mal_value_is_nil(error)) net_emit(vm, state->receiver, "error", &error, 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        MalValue end = mal_value_new_null();
        net_call_method(vm, state->receiver, "push", &end, 1);
        if (task->result == MAL_HOST_TERMINAL_OK
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_stream_end_readable(vm, state->receiver);
        }
    }
    net_set(vm, state->receiver, "connecting", mal_value_new_boolean(false));
    net_set(vm, state->receiver, "pending", mal_value_new_boolean(false));
    net_set(vm, state->receiver, "destroyed", mal_value_new_boolean(true));
    net_set(vm, state->receiver, "readable", mal_value_new_boolean(false));
    net_set(vm, state->receiver, "writable", mal_value_new_boolean(false));
    net_set(vm, state->receiver, "readyState", mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) "closed")));
    MalValue close_arg = mal_value_new_boolean(had_error);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        net_emit(vm, state->receiver, "close", &close_arg, 1);
    }
    mal_gc_unroot(&root);
}

static MAL_ISOLATE_LOCAL MalNodeNetServerState *net_servers;

/* Accepted connections refused before adoption still post a cancellation terminal;
 * the head-only drain must consume it or it would block every later net task. */
typedef struct MalNodeNetDropped {
    MalVm *vm;
    MalHostHandle operation;
    struct MalNodeNetDropped *next;
} MalNodeNetDropped;

static MAL_ISOLATE_LOCAL MalNodeNetDropped *net_dropped;

static void net_drop_connection(MalVm *vm, MalHostHandle operation) {
    MalNodeNetDropped *dropped = calloc(1, sizeof(MalNodeNetDropped));
    if (dropped != nullptr) {
        dropped->vm = vm;
        dropped->operation = operation;
        dropped->next = net_dropped;
        net_dropped = dropped;
    }
    (void) mal_tcp_cancel(mal_host(vm), operation);
}

static bool net_drain_dropped(MalVm *vm, MalHost *host, const MalHostTask *peek) {
    MalNodeNetDropped **link = &net_dropped;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != peek->operation)) link = &(*link)->next;
    if (*link == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        mal_tcp_terminal_free(data);
        MalNodeNetDropped *dropped = *link;
        *link = dropped->next;
        free(dropped);
    } else {
        mal_tcp_progress_free(data);
    }
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static MAL_ISOLATE_LOCAL MalValue net_server_prototype;

static void net_scan_servers(MalVm *vm) {
    if (mal_value_is_object(net_server_prototype)) mal_gc_mark_value(net_server_prototype);
    for (MalNodeNetServerState *state = net_servers; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
        for (usize i = 0; i < countof(state->sni_cache); i++) {
            if (state->sni_cache[i].config != nullptr) mal_gc_mark_value(state->sni_cache[i].context);
        }
    }
}

static MalNodeNetServerState *net_server_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    for (MalNodeNetServerState *state = net_servers; state != nullptr; state = state->next) {
        if (state->receiver == receiver) return state;
    }
    return nullptr;
}

static MalValue net_coded_error(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    mal_node_throw_code(vm, prototype, message, code);
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return error;
}

/* Node's process.nextTick ordering is approximated by a reaction job. */
static void net_next_tick(MalVm *vm, MalValue receiver, MalNativeFunctionCallback callback, MalValue *slots, i32 count) {
    MalValue values[3] = {receiver, count > 0 ? slots[0] : mal_value_new_undefined(),
        count > 1 ? slots[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, 3);
    MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "serverTick"), callback, values, 3));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    mal_gc_unroot(&root);
}

/* Slots: [server, event, argument]. */
static MalValue net_server_emit_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue server = mal_native_function_object_get_slot(function, 0);
    MalValue event = mal_native_function_object_get_slot(function, 1);
    MalValue argument = mal_native_function_object_get_slot(function, 2);
    if (mal_value_is_string(event) && mal_string_equals_ascii(mal_value_to_string(event), "listening")) {
        MalNodeNetServerState *state = net_server_state(server);
        if (state != nullptr && state->handle_open) state->listening = true;
    }
    MalValue emit_args[] = {event, argument};
    net_call_method(vm, server, "emit", emit_args, mal_value_is_undefined(argument) ? 1 : 2);
    return mal_value_new_undefined();
}

static void net_server_emit_later(MalVm *vm, MalValue server, const char *event, MalValue argument) {
    MalValue slots[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)), argument};
    MalRootSpan root;
    mal_gc_root(&root, slots, 2);
    net_next_tick(vm, server, net_server_emit_task, slots, 2);
    mal_gc_unroot(&root);
}

static void net_server_unlink(MalNodeNetServerState *state) {
    MalNodeNetServerState **link = &net_servers;
    while (*link != nullptr && *link != state) link = &(*link)->next;
    if (*link == state) *link = state->next;
}

/* Node's _emitCloseIfDrained: 'close' once the handle is gone and no socket remains. */
static void net_server_maybe_close(MalVm *vm, MalNodeNetServerState *state) {
    if (state->handle_open || state->listener_live || state->connections > 0) return;
    MalValue server = state->receiver;
    MalRootSpan root;
    mal_gc_root(&root, &server, 1);
    net_server_unlink(state);
    mal_tls_server_config_free(&state->tls_config);
    for (usize i = 0; i < countof(state->sni_cache); i++) mal_tls_server_config_free(&state->sni_cache[i].config);
    free(state->path);
    free(state);
    net_server_emit_later(vm, server, "close", mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static void net_socket_server_release(MalVm *vm, MalNodeNetSocketState *socket) {
    if (!mal_value_is_object(socket->server)) return;
    MalNodeNetServerState *server = net_server_state(socket->server);
    socket->server = mal_value_new_undefined();
    if (server == nullptr || server->connections == 0) return;
    server->connections--;
    net_set(vm, server->receiver, "_connections", mal_value_from_i32((i32) server->connections));
    net_server_maybe_close(vm, server);
}

static MalValue net_endpoint_family(MalVm *vm, const MalNetEndpoint *endpoint) {
    return mal_value_from_string(mal_intrinsic_ascii(vm,
        (const byte *) (endpoint->family == MAL_NET_ADDRESS_IPV6 ? "IPv6" : "IPv4")));
}

/* Unix sockets have no IP endpoints, so their address properties stay undefined as in Node. */
static void net_set_endpoints(MalVm *vm, MalValue socket, MalHostHandle operation) {
    MalNetEndpoint local, remote;
    if (!mal_tcp_connection_endpoints(mal_host(vm), operation, &local, &remote)) return;
    MalValue roots[] = {socket, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) remote.address));
    net_set(vm, roots[0], "remoteAddress", roots[1]);
    net_set(vm, roots[0], "remotePort", mal_value_from_i32(remote.port));
    roots[1] = net_endpoint_family(vm, &remote);
    net_set(vm, roots[0], "remoteFamily", roots[1]);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) local.address));
    net_set(vm, roots[0], "localAddress", roots[1]);
    net_set(vm, roots[0], "localPort", mal_value_from_i32(local.port));
    roots[1] = net_endpoint_family(vm, &local);
    net_set(vm, roots[0], "localFamily", roots[1]);
    mal_gc_unroot(&root);
}

static void net_server_accept(MalVm *vm, MalNodeNetServerState *server, MalHostHandle accepted) {
    MalValue roots[] = {server->receiver, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue max_connections;
    if (net_get(vm, roots[0], "maxConnections", &max_connections) && mal_ops_is_number(max_connections)
        && (f64) server->connections >= mal_ops_number_as_f64(max_connections)) {
        // Node closes the surplus connection and reports both endpoints through 'drop'.
        MalNetEndpoint local, remote;
        bool known = mal_tcp_connection_endpoints(mal_host(vm), accepted, &local, &remote);
        net_drop_connection(vm, accepted);
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        if (known) {
            const MalNetEndpoint *sides[] = {&local, &remote};
            static const char *const names[][3] = {
                {"localAddress", "localPort", "localFamily"}, {"remoteAddress", "remotePort", "remoteFamily"}};
            for (usize i = 0; i < 2; i++) {
                roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) sides[i]->address));
                mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) names[i][0], roots[2], NET_VISIBLE);
                mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) names[i][1],
                    mal_value_from_i32(sides[i]->port), NET_VISIBLE);
                roots[2] = net_endpoint_family(vm, sides[i]);
                mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) names[i][2], roots[2], NET_VISIBLE);
            }
        }
        net_emit(vm, roots[0], "drop", &roots[1], 1);
        mal_gc_unroot(&root);
        return;
    }
    MalNodeNetSocketState *state = calloc(1, sizeof(MalNodeNetSocketState));
    if (state == nullptr) {
        net_drop_connection(vm, accepted);
        mal_gc_unroot(&root);
        return;
    }
    MalCompletion constructed = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_CONSTRUCTOR],
        nullptr, 0);
    if (constructed.kind == MAL_COMPLETION_THROW) {
        free(state);
        net_drop_connection(vm, accepted);
        mal_gc_unroot(&root);
        return;
    }
    roots[1] = constructed.value;
    state->vm = vm;
    state->receiver = roots[1];
    state->async_context = mal_async_context_capture(vm);
    state->destroy_error = mal_value_new_undefined();
    state->server = roots[0];
    state->next_write_token = 1;
    state->operation = accepted;
    state->connected = true;
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    state->next = net_sockets;
    net_sockets = state;
    server->connections++;
    net_set(vm, roots[0], "_connections", mal_value_from_i32((i32) server->connections));
    net_set(vm, roots[1], "connecting", mal_value_new_boolean(false));
    net_set(vm, roots[1], "pending", mal_value_new_boolean(false));
    net_set(vm, roots[1], "destroyed", mal_value_new_boolean(false));
    net_set(vm, roots[1], "readyState", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "open")));
    net_set(vm, roots[1], "server", roots[0]);
    net_set_endpoints(vm, roots[1], accepted);
    if (server->tls_config != nullptr) {
        if (!(net_server_uses_sni(vm, roots[0])
                ? mal_tcp_start_tls_server_sni(mal_host(vm), accepted)
                : mal_tcp_start_tls_server(mal_host(vm), accepted, server->tls_config))) {
            (void) mal_tcp_cancel(mal_host(vm), accepted);
            mal_gc_unroot(&root);
            return;
        }
        state->tls_server = true;
        state->tls_context = mal_async_context_capture(vm);
    }
    MalValue pause_on_connect;
    bool paused = net_get(vm, roots[0], "pauseOnConnect", &pause_on_connect) && mal_value_is_truthy(pause_on_connect);
    if (paused) {
        state->read_paused = true;
        net_call_readable_method(vm, roots[1], "pause");
    } else {
        (void) mal_tcp_read_resume(mal_host(vm), accepted);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) net_emit(vm, roots[0], "connection", &roots[1], 1);
    mal_gc_unroot(&root);
}

static void net_server_dispatch(MalVm *vm, MalNodeNetServerState *state, MalHostTask *task, void *data) {
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, state->async_context);
    if (task->kind == MAL_HOST_TASK_PROGRESS) {
        MalTcpProgress *progress = data;
        if (progress != nullptr && progress->kind == MAL_TCP_ACCEPTED) net_server_accept(vm, state, progress->accepted);
        mal_tcp_progress_free(progress);
    } else {
        MalTcpTerminal *terminal = data;
        state->handle_open = false;
        state->listener_live = false;
        state->listening = false;
        if (task->result == MAL_HOST_TERMINAL_ERROR) {
            MalValue error = net_error(vm, terminal == nullptr ? EIO : terminal->error);
            MalRootSpan root;
            mal_gc_root(&root, &error, 1);
            net_emit(vm, state->receiver, "error", &error, 1);
            mal_gc_unroot(&root);
        }
        mal_tcp_terminal_free(terminal);
        if (vm->completion.kind != MAL_COMPLETION_THROW) net_server_maybe_close(vm, state);
    }
    mal_async_context_scope_exit(vm, &scope);
}

static bool net_server_drain(MalVm *vm, MalHost *host, const MalHostTask *peek) {
    MalNodeNetServerState *state = net_servers;
    while (state != nullptr && (state->vm != vm || state->operation != peek->operation)) state = state->next;
    if (state == nullptr) return net_drain_dropped(vm, host, peek);
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    net_server_dispatch(vm, state, &task, data);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static const char *net_listen_description(int error) {
    switch (error) {
        case EADDRINUSE: return "address already in use";
        case EACCES: return "permission denied";
        case EADDRNOTAVAIL: return "address not available";
        default: return "listen failed";
    }
}

static const char *net_listen_code(int error) {
    switch (error) {
        case EADDRINUSE: return "EADDRINUSE";
        case EACCES: return "EACCES";
        case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
        case EINVAL: return "EINVAL";
        default: return "EIO";
    }
}

/* A pipe listener passes port -1, which Node reports as `port: -1` without the `:port` suffix. */
static MalValue net_listen_error(MalVm *vm, int error, const char *host, i32 port) {
    const char *code = net_listen_code(error);
    const char *description = net_listen_description(error);
    usize capacity = strlen(code) + strlen(description) + strlen(host) + 32;
    char *message = malloc(capacity);
    if (message == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (port < 0) snprintf(message, capacity, "listen %s: %s %s", code, description, host);
    else snprintf(message, capacity, "listen %s: %s %s:%d", code, description, host, (int) port);
    MalValue roots[] = {net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, code), mal_value_new_undefined()};
    free(message);
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    net_set(vm, roots[0], "errno", mal_value_from_i32(-error));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "listen"));
    net_set(vm, roots[0], "syscall", roots[1]);
    roots[1] = net_utf8_value(vm, host);
    net_set(vm, roots[0], "address", roots[1]);
    net_set(vm, roots[0], "port", mal_value_from_i32(port));
    mal_gc_unroot(&root);
    return roots[0];
}

static bool net_utf8_property(MalVm *vm, MalValue object, const char *name, byte **bytes, usize *length) {
    *bytes = nullptr;
    *length = 0;
    MalValue value;
    if (!net_get(vm, object, name, &value)) return false;
    if (!mal_value_is_string(value)) return true;
    *bytes = mal_string_to_utf8(mal_value_to_string(value), length);
    if (*bytes == nullptr) mal_vm_throw_allocation_error(vm);
    return *bytes != nullptr;
}

static bool net_tls_config_from(
    MalVm *vm, MalValue server, MalValue creds, MalTlsServerConfig **config, bool *without_cert);

bool mal_node_net_tls_config(
    MalVm *vm, MalValue server, MalTlsServerConfig **config, bool *without_cert) {
    *config = nullptr;
    *without_cert = false;
    MalValue creds;
    if (!net_get(vm, server, "_sharedCreds", &creds)) return false;
    return net_tls_config_from(vm, server, creds, config, without_cert);
}

static bool net_tls_config_from(
    MalVm *vm, MalValue server, MalValue creds, MalTlsServerConfig **config, bool *without_cert) {
    *config = nullptr;
    *without_cert = false;
    if (!mal_value_is_object(creds)) return true;
    MalRootSpan root;
    mal_gc_root(&root, &creds, 1);
    byte *pem[4] = {nullptr, nullptr, nullptr, nullptr};
    usize lengths[4] = {0, 0, 0, 0};
    static const char *const names[] = {"_malCert", "_malKey", "_malCa", "_malAlpn"};
    bool ok = true;
    for (usize i = 0; ok && i < 3; i++) ok = net_utf8_property(vm, creds, names[i], &pem[i], &lengths[i]);
    if (ok) ok = net_utf8_property(vm, server, names[3], &pem[3], &lengths[3]);
    MalValue request_cert = mal_value_new_undefined(), reject = mal_value_new_undefined();
    if (ok) ok = net_get(vm, server, "requestCert", &request_cert) && net_get(vm, server, "rejectUnauthorized", &reject);
    if (ok) {
        int status = mal_tls_server_config_create(pem[0], lengths[0], pem[1], lengths[1], pem[2], lengths[2],
            pem[3], lengths[3], mal_value_is_truthy(request_cert), mal_value_is_truthy(reject), config);
        *without_cert = lengths[0] == 0 || lengths[1] == 0;
        if (status != MAL_TLS_STATUS_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) "Failed to create TLS server context");
            ok = false;
        }
    }
    for (usize i = 0; i < countof(pem); i++) free(pem[i]);
    mal_gc_unroot(&root);
    return ok;
}

bool mal_node_net_server_refresh_tls(MalVm *vm, MalValue server) {
    MalNodeNetServerState *state = net_server_state(server);
    if (state != nullptr && state->tls_config != nullptr) {
        MalTlsServerConfig *config = nullptr;
        bool without_cert = false;
        if (!mal_node_net_tls_config(vm, server, &config, &without_cert)) return false;
        if (config == nullptr) return true;
        mal_tls_server_config_free(&state->tls_config);
        state->tls_config = config;
        state->tls_without_cert = without_cert;
        return true;
    }
    MalTlsServerConfig *config = nullptr;
    bool without_cert = false;
    if (!mal_node_net_tls_config(vm, server, &config, &without_cert)) return false;
    if (config != nullptr && !mal_node_http_server_replace_tls(server, config)) {
        mal_tls_server_config_free(&config);
    }
    return true;
}

static bool net_server_tls_config(MalVm *vm, MalValue server, MalNodeNetServerState *state) {
    return mal_node_net_tls_config(vm, server, &state->tls_config, &state->tls_without_cert);
}

static bool net_listen_port(MalVm *vm, MalValue value, u16 *port) {
    if (mal_value_is_nil(value)) {
        *port = 0;
        return true;
    }
    f64 number = NAN;
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (mal_value_is_string(value) && mal_string_length(mal_value_to_string(value)) > 0) {
        if (!mal_vm_to_number(vm, value, &number)) return false;
    }
    if (!(number >= 0 && number < 65536) || floor(number) != number) {
        char received[96];
        if (mal_ops_is_number(value)) snprintf(received, sizeof(received), "type number (%.17g)", number);
        else snprintf(received, sizeof(received), "type %s", mal_value_is_string(value) ? "string" : "object");
        char message[160];
        snprintf(message, sizeof(message), "options.port should be >= 0 and < 65536. Received %s.", received);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_SOCKET_BAD_PORT");
        return false;
    }
    *port = (u16) number;
    return true;
}

/* lib/net.js setupListenHandle; a numeric host keeps `listening` false until the event, as after Node's lookup. */
static bool net_server_bind(MalVm *vm, MalValue receiver, struct sockaddr_storage *address, socklen_t length,
    int backlog, bool ipv6_only, bool default_host, bool listening, const char *host, i32 port, char **path) {
    MalHostHandle operation = 0;
    int error = mal_tcp_listen_start(mal_host(vm), (const struct sockaddr *) address, length, backlog,
        ipv6_only, &operation);
    if (error == EAFNOSUPPORT && default_host) {
        // No IPv6 on this host: Node falls back to the IPv4 wildcard.
        (void) mal_net_parse_ip("0.0.0.0", (u16) port, address, &length);
        error = mal_tcp_listen_start(mal_host(vm), (const struct sockaddr *) address, length, backlog, false,
            &operation);
    }
    if (error != 0) {
        MalValue failure = net_listen_error(vm, error, host, port);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
        MalRootSpan root;
        mal_gc_root(&root, &failure, 1);
        net_server_emit_later(vm, receiver, "error", failure);
        mal_gc_unroot(&root);
        return true;
    }
    MalNodeNetServerState *state = calloc(1, sizeof(MalNodeNetServerState));
    if (state == nullptr) {
        (void) mal_tcp_listen_close(mal_host(vm), operation);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    state->vm = vm;
    state->receiver = receiver;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    state->operation = operation;
    state->path = *path;
    *path = nullptr;
    if (!net_server_tls_config(vm, receiver, state)) {
        (void) mal_tcp_listen_close(mal_host(vm), operation);
        if (state->path != nullptr) (void) unlink(state->path);
        free(state->path);
        free(state);
        return false;
    }
    state->listening = listening;
    state->handle_open = true;
    state->listener_live = true;
    state->next = net_servers;
    net_servers = state;
    MalValue unref;
    if (net_get(vm, receiver, "_unref", &unref) && mal_value_is_truthy(unref)) {
        (void) mal_tcp_listen_set_referenced(mal_host(vm), operation, false);
    }
    net_server_emit_later(vm, receiver, "listening", mal_value_new_undefined());
    return true;
}

/* Slots: [server, port, backlog, ipv6Only]; lib/net.js lookupAndListen's doListen. */
static MalValue net_server_lookup_done(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue server = mal_native_function_object_get_slot(self, 0);
    MalValue error = argc > 0 ? args[0] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &server, 1);
    if (!mal_value_is_nil(error)) {
        net_emit(vm, server, "error", &error, 1);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    u16 port = (u16) mal_ops_number_as_f64(mal_native_function_object_get_slot(self, 1));
    int backlog = (int) mal_ops_number_as_f64(mal_native_function_object_get_slot(self, 2));
    bool ipv6_only = mal_value_is_truthy(mal_native_function_object_get_slot(self, 3));
    char *ip = nullptr;
    struct sockaddr_storage address;
    socklen_t length;
    if (argc > 1 && net_ascii_string(vm, args[1], "The argument 'hostname'", &ip)) {
        if (mal_net_parse_ip(ip, port, &address, &length)) {
            (void) net_server_bind(vm, server, &address, length, backlog, ipv6_only, false, true, ip, port, &(char *) {nullptr});
        } else {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid IP address from lookup");
        }
    }
    free(ip);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue net_server_listen(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    // [server, callback, options, port, host, path]
    MalValue roots[] = {receiver, undefined, undefined, undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    char *host = nullptr;
    char *path = nullptr;
    if (net_server_state(receiver) != nullptr) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Listen method has been called more than once without closing.", "ERR_SERVER_ALREADY_LISTEN");
        goto done;
    }
    i32 count = argc;
    if (count > 0 && mal_value_is_callable(args[count - 1])) {
        roots[1] = args[count - 1];
        count--;
    }
    MalValue port_value = undefined, host_value = undefined, backlog_value = undefined;
    bool ipv6_only = false;
    if (count > 0 && mal_value_is_object(args[0])) {
        roots[2] = args[0];
        if (!net_get(vm, roots[2], "port", &roots[3]) || !net_get(vm, roots[2], "host", &roots[4])
            || !net_get(vm, roots[2], "backlog", &backlog_value)) goto done;
        MalValue only;
        if (!net_get(vm, roots[2], "ipv6Only", &only) || !net_get(vm, roots[2], "path", &roots[5])) goto done;
        ipv6_only = mal_value_is_truthy(only);
        if (!mal_value_is_truthy(roots[5])) roots[5] = undefined;
        port_value = roots[3];
        host_value = roots[4];
    } else {
        bool is_pipe = false;
        if (count > 0 && !net_is_pipe_name(vm, args[0], &is_pipe)) goto done;
        if (is_pipe) roots[5] = args[0];
        port_value = count > 0 && !is_pipe ? args[0] : undefined;
        if (count > 1 && mal_ops_is_number(args[1])) {
            backlog_value = args[1];
        } else {
            host_value = count > 1 ? args[1] : undefined;
            backlog_value = count > 2 ? args[2] : undefined;
        }
        roots[3] = port_value;
        roots[4] = host_value;
    }
    u16 port = 0;
    bool default_host = false;
    bool lookup = false;
    struct sockaddr_storage address;
    socklen_t length;
    if (!mal_value_is_undefined(roots[5])) {
        if (!net_pipe_address(vm, roots[5], &address, &length, &path)) goto done;
    } else {
        if (!net_listen_port(vm, port_value, &port)) goto done;
        default_host = mal_value_is_nil(host_value);
        if (default_host) {
            host = strdup("::");
        } else if (!net_ascii_string(vm, host_value, "The argument 'hostname'", &host)) {
            goto done;
        }
        if (host == nullptr) { mal_vm_throw_allocation_error(vm); goto done; }
        lookup = !mal_net_parse_ip(host, port, &address, &length);
    }
    int backlog = mal_ops_is_number(backlog_value) ? (int) mal_ops_number_as_f64(backlog_value) : 511;
    if (!mal_value_is_undefined(roots[1])) {
        MalValue once_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "listening")), roots[1]};
        net_call_method(vm, receiver, "once", once_args, 2);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    if (lookup) {
        MalValue slots[] = {receiver, mal_value_from_i32(port), mal_value_from_i32(backlog),
            mal_value_new_boolean(ipv6_only)};
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "doListen"), net_server_lookup_done, slots, countof(slots)));
        MalValue lookup_args[] = {roots[4], roots[2]};
        mal_node_dns_lookup(vm, lookup_args, 2);
        if (vm->completion.kind != MAL_COMPLETION_THROW) result = receiver;
        goto done;
    }
    if (net_server_bind(vm, receiver, &address, length, backlog, ipv6_only, default_host,
            default_host || path != nullptr, path != nullptr ? path : host, path != nullptr ? -1 : port, &path)) {
        result = receiver;
    }
done:
    free(host);
    free(path);
    mal_gc_unroot(&root);
    return result;
}

static MalValue net_server_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalNodeNetServerState *state = net_server_state(receiver);
    if (state != nullptr && state->handle_open && state->path != nullptr) return net_utf8_value(vm, state->path);
    MalNetEndpoint endpoint;
    if (state == nullptr || !state->handle_open || !mal_tcp_listen_endpoint(mal_host(vm), state->operation, &endpoint)) {
        return mal_value_new_null();
    }
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) endpoint.address));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "address", roots[1], NET_VISIBLE);
    roots[1] = net_endpoint_family(vm, &endpoint);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "family", roots[1], NET_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "port",
        mal_value_from_i32(endpoint.port), NET_VISIBLE);
    mal_gc_unroot(&root);
    return roots[0];
}

/* Slots: [server, callback]; reports ERR_SERVER_NOT_RUNNING through close(cb). */
static MalValue net_server_not_running_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue callback = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalValue error = net_coded_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Server is not running.",
        "ERR_SERVER_NOT_RUNNING");
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    if (mal_value_is_callable(callback)) mal_vm_call_value(vm, callback, mal_value_new_undefined(), &error, 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue net_server_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue callback = argc > 0 && mal_value_is_callable(args[0]) ? args[0] : mal_value_new_undefined();
    MalNodeNetServerState *state = net_server_state(receiver);
    if (state == nullptr || !state->handle_open) {
        if (!mal_value_is_undefined(callback)) net_next_tick(vm, receiver, net_server_not_running_task, &callback, 1);
        if (state == nullptr) net_server_emit_later(vm, receiver, "close", mal_value_new_undefined());
        return receiver;
    }
    if (!mal_value_is_undefined(callback)) {
        MalValue once_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "close")), callback};
        net_call_method(vm, receiver, "once", once_args, 2);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    }
    state->listening = false;
    state->handle_open = false;
    (void) mal_tcp_listen_close(mal_host(vm), state->operation);
    // libuv removes a bound pipe's path when its handle closes.
    if (state->path != nullptr) (void) unlink(state->path);
    return receiver;
}

/* Slots: [server, callback]. */
static MalValue net_server_connections_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalNodeNetServerState *state = net_server_state(mal_native_function_object_get_slot(function, 0));
    MalValue callback = mal_native_function_object_get_slot(function, 1);
    MalValue call_args[] = {mal_value_new_null(), mal_value_from_i32(state == nullptr ? 0 : (i32) state->connections)};
    if (mal_value_is_callable(callback)) mal_vm_call_value(vm, callback, mal_value_new_undefined(), call_args, 2);
    return mal_value_new_undefined();
}

static MalValue net_server_get_connections(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_callable(callback)) net_next_tick(vm, receiver, net_server_connections_task, &callback, 1);
    return receiver;
}

static MalValue net_server_set_ref(MalVm *vm, MalValue receiver, bool referenced) {
    net_set(vm, receiver, "_unref", mal_value_new_boolean(!referenced));
    MalNodeNetServerState *state = net_server_state(receiver);
    if (state != nullptr && state->handle_open) {
        (void) mal_tcp_listen_set_referenced(mal_host(vm), state->operation, referenced);
    }
    return receiver;
}

static MalValue net_server_ref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return net_server_set_ref(vm, receiver, true);
}

static MalValue net_server_unref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return net_server_set_ref(vm, receiver, false);
}

static MalValue net_server_listening_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    MalNodeNetServerState *state = net_server_state(receiver);
    return mal_value_new_boolean(state != nullptr && state->listening);
}

/* Slots: [promise]. */
static MalValue net_server_dispose_settle(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalPromiseObject *promise = mal_value_to_promise_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    if (argc > 0 && !mal_value_is_nil(args[0])) mal_promise_reject(vm, promise, args[0]);
    else mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue net_server_async_dispose(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeNetServerState *state = net_server_state(receiver);
    if (state == nullptr || !state->handle_open) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), mal_value_new_undefined());
    } else {
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "disposeClosed"), net_server_dispose_settle, roots, 1));
        net_server_close(vm, receiver, &roots[1], 1, mal_value_new_undefined(), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return roots[0];
}

bool mal_node_net_server_init(MalVm *vm, MalValue server, MalValue options, MalValue listener) {
    MalValue roots[] = {server, options, listener};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR], roots[0], nullptr, 0);
    bool ok = vm->completion.kind != MAL_COMPLETION_THROW;
    static const char *const flags[] = {"allowHalfOpen", "pauseOnConnect", "noDelay", "keepAlive"};
    for (usize i = 0; ok && i < countof(flags); i++) {
        MalValue value = mal_value_new_boolean(false);
        if (mal_value_is_object(roots[1])) ok = net_get(vm, roots[1], flags[i], &value);
        if (ok) net_set(vm, roots[0], flags[i], mal_value_new_boolean(mal_value_is_truthy(value)));
    }
    if (ok) net_set(vm, roots[0], "_connections", mal_value_from_i32(0));
    if (ok) net_set(vm, roots[0], "_unref", mal_value_new_boolean(false));
    if (ok && mal_value_is_callable(roots[2])) {
        MalValue on_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "connection")), roots[2]};
        net_call_method(vm, roots[0], "on", on_args, 2);
        ok = vm->completion.kind != MAL_COMPLETION_THROW;
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalValue net_server_new(MalVm *vm, MalObject *prototype, const MalValue *args, i32 argc) {
    MalValue options = argc > 0 && !mal_value_is_callable(args[0]) ? args[0] : mal_value_new_undefined();
    MalValue listener = argc > 0 && mal_value_is_callable(args[0]) ? args[0]
        : argc > 1 && mal_value_is_callable(args[1]) ? args[1] : mal_value_new_undefined();
    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    bool ok = mal_node_net_server_init(vm, instance, options, listener);
    mal_gc_unroot(&root);
    return ok ? instance : mal_value_new_undefined();
}

static MalValue net_server_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    return net_server_new(vm, mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value)
        : mal_value_to_object(net_server_prototype), args, argc);
}

MalValue mal_node_net_server_prototype(void) {
    return net_server_prototype;
}

static MalValue net_create_server(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return net_server_new(vm, mal_value_to_object(net_server_prototype), args, argc);
}

bool mal_node_net_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr || mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask peek;
    if (!mal_host_peek_task(&host->tasks, &peek)) return false;
    MalNodeNetSocketState *state = net_sockets;
    while (state != nullptr
           && (state->vm != vm || state->operation != peek.operation)) {
        state = state->next;
    }
    if (state == nullptr) return net_server_drain(vm, host, &peek);
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, state->async_context);
    if (task.kind == MAL_HOST_TASK_TERMINAL
        && task.result == MAL_HOST_TERMINAL_ERROR && !state->connected
        && state->address_index < state->address_count && !state->destroyed) {
        mal_tcp_terminal_free(data);
        mal_host_task_release(&host->tasks, &task);
        if (net_start_next_address(state)) {
            net_pump_writes(state);
            net_maybe_shutdown_write(state);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            mal_async_context_scope_exit(vm, &async_scope);
            return true;
        }
        MalTcpTerminal terminal = {.error = EHOSTUNREACH};
        MalNodeNetSocketState **link = net_state_link(state);
        if (*link == state) *link = state->next;
        net_dispatch_terminal(vm, state, &task, &terminal);
        net_state_free(state);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
        mal_async_context_scope_exit(vm, &async_scope);
        return true;
    }
    if (task.kind == MAL_HOST_TASK_PROGRESS) {
        net_dispatch_progress(vm, state, data);
    } else {
        MalNodeNetSocketState **link = net_state_link(state);
        if (*link == state) *link = state->next;
        MalValue server = state->server;
        MalRootSpan server_root;
        mal_gc_root(&server_root, &server, 1);
        net_dispatch_terminal(vm, state, &task, data);
        net_socket_server_release(vm, state);
        mal_gc_unroot(&server_root);
        net_state_free(state);
    }
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_async_context_scope_exit(vm, &async_scope);
    mal_tcp_progress_free(task.kind == MAL_HOST_TASK_PROGRESS ? data : nullptr);
    mal_tcp_terminal_free(task.kind == MAL_HOST_TASK_TERMINAL ? data : nullptr);
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static MalValue net_constructor(
    MalVm *vm, const char *name, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), 1, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor,
        (const byte *) "prototype", prototype, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype),
        (const byte *) "constructor", value, NET_METHOD);
    return value;
}

void mal_host_install_node_net(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:net", slots, count)) return;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE];
    if (!mal_value_is_undefined(module)) {
        mal_node_module_publish(vm, "node:net", slots, count, module);
        return;
    }
    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_PROTOTYPE])));
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "connect", 2, net_socket_connect);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "write", 3, net_socket_write);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "end", 3, net_socket_end);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "destroy", 1, net_socket_destroy);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "pause", 0, net_socket_pause);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "resume", 0, net_socket_resume);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "setKeepAlive", 2, net_socket_set_keep_alive);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[1]),
        (const byte *) "setNoDelay", 1, net_socket_set_no_delay);
    roots[2] = net_constructor(vm, "Socket", net_socket_constructor, roots[1]);
    mal_object_set_prototype(mal_value_to_object(roots[2]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR]));
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
    net_server_prototype = roots[3];
    {
        MalObject *prototype = mal_value_to_object(roots[3]);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "listen", 0, net_server_listen);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "address", 0, net_server_address);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "getConnections", 1, net_server_get_connections);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "close", 1, net_server_close);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "ref", 0, net_server_ref);
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) "unref", 0, net_server_unref);
        mal_intrinsic_define_accessor_n(vm, prototype, mal_intrinsic_string_key(vm, (const byte *) "listening"),
            (const byte *) "get listening", 0, net_server_listening_getter, nullptr, 0, nullptr,
            MAL_PROPERTY_CONFIGURABLE);
        MalValue dispose_key = vm->intrinsics[MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE];
        if (mal_value_is_symbol(dispose_key)) {
            MalValue dispose = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) "[Symbol.asyncDispose]"), 0, net_server_async_dispose));
            MalRootSpan dispose_root;
            mal_gc_root(&dispose_root, &dispose, 1);
            MalPropertyDesc descriptor = {.value = dispose, .flags = NET_METHOD};
            mal_object_define_own(prototype, mal_key_from_value(dispose_key), &descriptor);
            mal_gc_unroot(&dispose_root);
        }
        MalValue constructor = net_constructor(vm, "Server", net_server_constructor, roots[3]);
        MalRootSpan constructor_root;
        mal_gc_root(&constructor_root, &constructor, 1);
        mal_object_set_prototype(mal_value_to_object(constructor), mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR]));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "Server", constructor, NET_VISIBLE);
        MalValue create = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "createServer"), 2, net_create_server));
        MalRootSpan create_root;
        mal_gc_root(&create_root, &create, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "createServer", create, NET_VISIBLE);
        mal_gc_unroot(&create_root);
        mal_gc_unroot(&constructor_root);
    }
    roots[3] = net_ip_function(vm, "isIP", net_is_ip);
    roots[6] = net_ip_function(vm, "isIPv4", net_is_ipv4);
    roots[7] = net_ip_function(vm, "isIPv6", net_is_ipv6);
    roots[4] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "connect"), 2,
            net_create_connection));
    roots[5] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "createConnection"), 2,
            net_create_connection));
    static const char *names[] = {"Socket", "isIP", "connect", "createConnection", "isIPv4", "isIPv6"};
    MalValue values[] = {roots[2], roots[3], roots[4], roots[5], roots[6], roots[7]};
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) names[i], values[i], NET_VISIBLE);
    }
    static const struct {
        const char *name;
        i32 length;
        MalNativeFunctionCallback callback;
    } state_functions[] = {
        {"getDefaultAutoSelectFamily", 0, net_get_default_auto_select_family},
        {"setDefaultAutoSelectFamily", 1, net_set_default_auto_select_family},
        {"getDefaultAutoSelectFamilyAttemptTimeout", 0, net_get_default_auto_select_family_attempt_timeout},
        {"setDefaultAutoSelectFamilyAttemptTimeout", 1, net_set_default_auto_select_family_attempt_timeout},
    };
    for (usize i = 0; i < countof(state_functions); i++) {
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) state_functions[i].name), state_functions[i].length,
            state_functions[i].callback));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) state_functions[i].name,
            roots[3], NET_VISIBLE);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_CONSTRUCTOR] = roots[2];
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_PROTOTYPE] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE] = roots[0];
    if (!net_roots_installed) {
        mal_gc_register_root_source(net_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_net_drain, false);
        net_roots_installed = true;
    }
    mal_node_module_publish(vm, "node:net", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
