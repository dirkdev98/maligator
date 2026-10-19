// Portions derived from Node.js lib/dgram.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_dgram.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "ascii.h"
#include "async_context.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "net.h"
#include "node_buffer.h"
#include "node_dns.h"
#include "node_events.h"
#include "node_module.h"
#include "microtask.h"
#include "object.h"
#include "object_ops.h"
#include "posix_fs.h"
#include "promise_object.h"
#include "reactor.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_host_timer.h"

#define DGRAM_VISIBLE (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define DGRAM_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)
#define DGRAM_RECV_TURN 64
#define DGRAM_DATAGRAM_MAX 65536
#define DGRAM_SEGMENTS_MAX 64

typedef struct MalDgramSend {
    byte *bytes;
    usize length;
    struct sockaddr_storage address;
    socklen_t address_length;
    u16 port;
    char address_text[MAL_NET_ADDRESS_MAX];
    MalValue callback;
    struct MalDgramSend *next;
} MalDgramSend;

typedef struct MalDgramSocket {
    MalVm *vm;
    MalHost *host;
    MalValue receiver;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHostHandle operation;
    MalOp read_op;
    int fd;
    int family;
    int recv_buffer_size;
    int send_buffer_size;
    bool reuse_address;
    bool reuse_port;
    bool ipv6_only;
    bool bound;
    /* A named bind address is resolving; sends wait for 'listening' as in lib/dgram.js enqueue. */
    bool binding;
    bool connected;
    bool closed;
    bool unreferenced;
    MalOp write_op;
    MalDgramSend *send_head;
    MalDgramSend *send_tail;
    usize send_queue_bytes;
    u32 send_queue_count;
    struct MalDgramSocket *next;
} MalDgramSocket;

// Sockets, the prototype root and drain registration belong to this mutator's isolate.
static MAL_ISOLATE_LOCAL MalDgramSocket *dgram_sockets;
static MAL_ISOLATE_LOCAL MalValue dgram_prototype;
static MAL_ISOLATE_LOCAL bool dgram_roots_installed;

static void dgram_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value, DGRAM_VISIBLE);
    mal_gc_unroot(&root);
}

static bool dgram_get(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    return mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static MalValue dgram_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) text));
}

static void dgram_call_method(MalVm *vm, MalValue receiver, const char *name, MalValue *args, i32 argc) {
    MalValue roots[] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    if (dgram_get(vm, roots[0], name, &roots[1])) mal_vm_call_value(vm, roots[1], roots[0], args, argc);
    mal_gc_unroot(&root);
}

static void dgram_listen_once(MalVm *vm, MalValue receiver, const char *method, const char *event, MalValue callback) {
    if (!mal_value_is_callable(callback)) return;
    MalValue args[] = {dgram_ascii(vm, event), callback};
    MalRootSpan root;
    mal_gc_root(&root, args, 2);
    dgram_call_method(vm, receiver, method, args, 2);
    mal_gc_unroot(&root);
}

static MalDgramSocket *dgram_find(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    for (MalDgramSocket *state = dgram_sockets; state != nullptr; state = state->next) {
        if (state->receiver == receiver) return state;
    }
    return nullptr;
}

static void dgram_scan_roots(MalVm *vm, void *data) {
    (void) data;
    if (mal_value_is_object(dgram_prototype)) mal_gc_mark_value(dgram_prototype);
    for (MalDgramSocket *state = dgram_sockets; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
        for (MalDgramSend *send = state->send_head; send != nullptr; send = send->next) {
            mal_gc_mark_value(send->callback);
        }
    }
}

static void dgram_unlink(MalDgramSocket *state) {
    MalDgramSocket **link = &dgram_sockets;
    while (*link != nullptr && *link != state) link = &(*link)->next;
    if (*link == state) *link = state->next;
}

static MalValue dgram_take_error(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return error;
}

static bool dgram_throw(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    mal_node_throw_code(vm, prototype, message, code);
    return false;
}

/* Node's ExceptionWithHostPort / ErrnoException: "syscall CODE address:port" or "syscall CODE". */
static MalValue dgram_system_error(MalVm *vm, int error, const char *syscall, const char *address, i32 port) {
    char message[256];
    const char *code = mal_posix_fs_errno_name(error);
    if (address != nullptr && port > 0) snprintf(message, sizeof(message), "%s %s %s:%d", syscall, code, address, port);
    else if (address != nullptr) snprintf(message, sizeof(message), "%s %s %s", syscall, code, address);
    else snprintf(message, sizeof(message), "%s %s", syscall, code);
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, code);
    MalValue value = dgram_take_error(vm);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    dgram_set(vm, value, "errno", mal_value_from_i32(-error));
    dgram_set(vm, value, "syscall", dgram_ascii(vm, syscall));
    if (address != nullptr) dgram_set(vm, value, "address", dgram_ascii(vm, address));
    if (port > 0) dgram_set(vm, value, "port", mal_value_from_i32(port));
    mal_gc_unroot(&root);
    return value;
}

static bool dgram_throw_system(MalVm *vm, int error, const char *syscall) {
    MalValue value = dgram_system_error(vm, error, syscall, nullptr, 0);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = value};
    return false;
}

/* Slots: [function, argument0, argument1]; called with receiver socket. Node's process.nextTick, approximated
 * by a reaction job like node:net. */
static MalValue dgram_tick_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue socket = mal_native_function_object_get_slot(function, 0);
    MalValue target = mal_native_function_object_get_slot(function, 1);
    MalValue call_args[] = {
        mal_native_function_object_get_slot(function, 2), mal_native_function_object_get_slot(function, 3),
    };
    i32 count = mal_value_is_undefined(call_args[1]) ? (mal_value_is_undefined(call_args[0]) ? 0 : 1) : 2;
    if (mal_value_is_string(target)) {
        MalValue emit_args[] = {target, call_args[0], call_args[1]};
        MalRootSpan root;
        mal_gc_root(&root, emit_args, 3);
        dgram_call_method(vm, socket, "emit", emit_args, count + 1);
        mal_gc_unroot(&root);
    } else if (mal_value_is_callable(target)) {
        mal_vm_call_value(vm, target, socket, call_args, count);
    }
    return mal_value_new_undefined();
}

/* `target` is an event name to emit or a callback to call with the arguments. */
static void dgram_next_tick(MalVm *vm, MalValue socket, MalValue target, MalValue first, MalValue second) {
    MalValue values[] = {socket, target, first, second};
    MalRootSpan root;
    mal_gc_root(&root, values, 4);
    MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "dgramTick"), dgram_tick_task, values, 4));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static void dgram_emit_later(MalVm *vm, MalValue socket, const char *event, MalValue argument) {
    MalRootSpan root;
    mal_gc_root(&root, &argument, 1);
    dgram_next_tick(vm, socket, dgram_ascii(vm, event), argument, mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static bool dgram_healthy(MalVm *vm, MalDgramSocket *state) {
    if (state != nullptr && !state->closed) return true;
    return dgram_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Not running", "ERR_SOCKET_DGRAM_NOT_RUNNING");
}

static void dgram_read_ready(void *data) {
    MalDgramSocket *state = data;
    if (state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_host_operation_progress(&state->host->tasks, state->operation, nullptr, nullptr);
}

static bool dgram_arm_read(MalDgramSocket *state) {
    state->read_op = (MalOp) {
        .fd = state->fd,
        .interest = MAL_IO_READ,
        .waker = {.fn = dgram_read_ready, .data = state},
    };
    if (!mal_reactor_add_op(&state->host->reactor, &state->read_op)) return false;
    if (state->unreferenced) state->host->reactor.unreferenced_ops++;
    return true;
}

static void dgram_disarm_read(MalDgramSocket *state) {
    if (state->read_op.active && state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_reactor_cancel_op(&state->host->reactor, &state->read_op);
}

static bool dgram_endpoint(const struct sockaddr_storage *address, MalNetEndpoint *out) {
    const void *bytes;
    if (address->ss_family == AF_INET6) {
        const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *) address;
        bytes = &ipv6->sin6_addr;
        out->port = ntohs(ipv6->sin6_port);
        out->family = MAL_NET_ADDRESS_IPV6;
    } else {
        const struct sockaddr_in *ipv4 = (const struct sockaddr_in *) address;
        bytes = &ipv4->sin_addr;
        out->port = ntohs(ipv4->sin_port);
        out->family = MAL_NET_ADDRESS_IPV4;
    }
    return inet_ntop(address->ss_family, bytes, out->address, sizeof(out->address)) != nullptr;
}

static MalValue dgram_endpoint_object(MalVm *vm, const MalNetEndpoint *endpoint, i32 size) {
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    dgram_set(vm, result, "address", dgram_ascii(vm, endpoint->address));
    dgram_set(vm, result, "family", dgram_ascii(vm, endpoint->family == MAL_NET_ADDRESS_IPV6 ? "IPv6" : "IPv4"));
    dgram_set(vm, result, "port", mal_value_from_i32(endpoint->port));
    if (size >= 0) dgram_set(vm, result, "size", mal_value_from_i32(size));
    mal_gc_unroot(&root);
    return result;
}

static void dgram_receive(MalVm *vm, MalDgramSocket *state) {
    for (usize turn = 0; turn < DGRAM_RECV_TURN && !state->closed; turn++) {
        byte *bytes = malloc(DGRAM_DATAGRAM_MAX);
        if (bytes == nullptr) break;
        struct sockaddr_storage from;
        socklen_t from_length = sizeof(from);
        ssize_t received = recvfrom(state->fd, bytes, DGRAM_DATAGRAM_MAX, 0, (struct sockaddr *) &from, &from_length);
        if (received < 0) {
            free(bytes);
            // ICMP refusals surface on connected sockets; Node's handle keeps receiving.
            if (errno == EINTR || errno == ECONNREFUSED) continue;
            break;
        }
        byte *shrunk = received > 0 ? realloc(bytes, (usize) received) : bytes;
        if (shrunk != nullptr) bytes = shrunk;
        MalNetEndpoint endpoint = {0};
        (void) dgram_endpoint(&from, &endpoint);
        MalValue args[] = {dgram_ascii(vm, "message"), mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, args, 3);
        args[1] = mal_node_buffer_from_owned_bytes(vm, bytes, (usize) received);
        if (vm->completion.kind != MAL_COMPLETION_THROW) args[2] = dgram_endpoint_object(vm, &endpoint, (i32) received);
        if (vm->completion.kind != MAL_COMPLETION_THROW) dgram_call_method(vm, state->receiver, "emit", args, 3);
        mal_gc_unroot(&root);
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
    }
    if (!state->closed) (void) dgram_arm_read(state);
}

// Distinguishes a write-readiness task from a read-readiness one on the shared operation.
static byte dgram_writable_marker;

static void dgram_write_ready(void *data) {
    MalDgramSocket *state = data;
    (void) mal_host_operation_progress(&state->host->tasks, state->operation, &dgram_writable_marker, nullptr);
}

static bool dgram_arm_write(MalDgramSocket *state) {
    if (state->write_op.active) return true;
    state->write_op = (MalOp) {
        .fd = state->fd,
        .interest = MAL_IO_WRITE,
        .waker = {.fn = dgram_write_ready, .data = state},
    };
    return mal_reactor_add_op(&state->host->reactor, &state->write_op);
}

static bool dgram_would_block(int error) {
    return error == EAGAIN || error == EWOULDBLOCK || error == ENOBUFS;
}

static void dgram_report_send(MalVm *vm, MalDgramSocket *state, MalValue callback, ssize_t sent, int error,
    const char *address, u16 port) {
    if (!mal_value_is_callable(callback)) return;
    MalRootSpan root;
    mal_gc_root(&root, &callback, 1);
    if (sent >= 0) {
        dgram_next_tick(vm, state->receiver, callback, mal_value_new_null(), mal_value_from_i32((i32) sent));
    } else {
        MalValue exception = dgram_system_error(vm, error, "send", address[0] != '\0' ? address : nullptr, port);
        dgram_next_tick(vm, state->receiver, callback, exception, mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
}

static void dgram_send_free(MalDgramSend *send) {
    free(send->bytes);
    free(send);
}

static void dgram_flush(MalVm *vm, MalDgramSocket *state) {
    while (state->send_head != nullptr && !state->closed) {
        MalDgramSend *send = state->send_head;
        ssize_t sent;
        do {
            sent = sendto(state->fd, send->bytes, send->length, 0,
                send->address_length > 0 ? (const struct sockaddr *) &send->address : nullptr, send->address_length);
        } while (sent < 0 && errno == EINTR);
        int error = errno;
        if (sent < 0 && dgram_would_block(error)) {
            (void) dgram_arm_write(state);
            return;
        }
        state->send_head = send->next;
        if (state->send_head == nullptr) state->send_tail = nullptr;
        state->send_queue_bytes -= send->length;
        state->send_queue_count--;
        MalValue callback = send->callback;
        MalRootSpan root;
        mal_gc_root(&root, &callback, 1);
        dgram_report_send(vm, state, callback, sent, error, send->address_text, send->port);
        mal_gc_unroot(&root);
        dgram_send_free(send);
    }
}

static bool dgram_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr || mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask peek;
    if (!mal_host_peek_task(&host->tasks, &peek)) return false;
    MalDgramSocket *state = dgram_sockets;
    while (state != nullptr && (state->vm != vm || state->operation != peek.operation)) state = state->next;
    if (state == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        dgram_unlink(state);
        free(state);
    } else if (!state->closed) {
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_realm_switch(vm, state->realm);
#endif
        MalAsyncContextScope scope;
        mal_async_context_scope_enter(vm, &scope, state->async_context);
        if (data == &dgram_writable_marker) dgram_flush(vm, state);
        else dgram_receive(vm, state);
        mal_async_context_scope_exit(vm, &scope);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
    }
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static bool dgram_ascii_string(MalVm *vm, MalValue value, char *out, usize capacity) {
    MalString *text = nullptr;
    if (mal_value_is_string(value)) text = mal_value_to_string(value);
    else if (!mal_vm_to_string(vm, value, &text)) return false;
    usize length = 0;
    byte *bytes = mal_string_to_utf8(text, &length);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    if (length >= capacity) length = capacity - 1;
    memcpy(out, bytes, length);
    out[length] = '\0';
    free(bytes);
    return true;
}

/* A non-empty name other than localhost that is not an IP literal resolves through dns.lookup. */
static bool dgram_needs_lookup(MalValue value) {
    if (!mal_value_is_string(value)) return false;
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    if (length == 0 || mal_string_equals_ascii(string, "localhost")) return false;
    if (length > MAL_NET_ADDRESS_MAX) return true;
    char text[MAL_NET_ADDRESS_MAX + 1];
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0x7f) return true;
        text[i] = (char) units[i];
    }
    text[length] = '\0';
    struct sockaddr_storage address;
    socklen_t address_length;
    return !mal_net_parse_ip(text, 0, &address, &address_length);
}

static MalValue dgram_send(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);
static bool dgram_bind_to(MalVm *vm, MalDgramSocket *state, MalValue address_value, u16 port);

typedef enum DgramRetryKind {
    DGRAM_RETRY_BIND = 0,
    DGRAM_RETRY_SEND_LOOKUP = 1,
    DGRAM_RETRY_SEND_LISTENING = 2,
} DgramRetryKind;

#define DGRAM_RETRY_ARGS 6

/* Slots: [socket, kind, port or callback, argc, address index, send arguments...]. */
static MalValue dgram_retry_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[3 + DGRAM_RETRY_ARGS] = {mal_native_function_object_get_slot(self, 0),
        argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined};
    for (i32 i = 0; i < DGRAM_RETRY_ARGS; i++) roots[3 + i] = mal_native_function_object_get_slot(self, 5 + i);
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    DgramRetryKind kind = (DgramRetryKind) mal_ops_number_as_f64(mal_native_function_object_get_slot(self, 1));
    MalValue extra = mal_native_function_object_get_slot(self, 2);
    MalDgramSocket *state = dgram_find(roots[0]);
    if (state == nullptr || state->closed) goto done;
    if (kind == DGRAM_RETRY_BIND) {
        state->binding = false;
        state->bound = false;
        if (!mal_value_is_nil(roots[1])) dgram_emit_later(vm, roots[0], "error", roots[1]);
        else (void) dgram_bind_to(vm, state, roots[2], (u16) mal_ops_number_as_f64(extra));
        goto done;
    }
    if (kind == DGRAM_RETRY_SEND_LOOKUP && !mal_value_is_nil(roots[1])) {
        // lib/dgram.js doSend: a lookup error goes to the callback, else to 'error'.
        if (mal_value_is_callable(extra)) dgram_next_tick(vm, roots[0], extra, roots[1], undefined);
        else dgram_emit_later(vm, roots[0], "error", roots[1]);
        goto done;
    }
    i32 count = (i32) mal_ops_number_as_f64(mal_native_function_object_get_slot(self, 3));
    i32 address_index = (i32) mal_ops_number_as_f64(mal_native_function_object_get_slot(self, 4));
    if (kind == DGRAM_RETRY_SEND_LOOKUP && address_index >= 0) roots[3 + address_index] = roots[2];
    dgram_send(vm, roots[0], roots + 3, count, undefined, undefined);
done:
    mal_gc_unroot(&root);
    return undefined;
}

static MalValue dgram_retry_function(MalVm *vm, MalValue socket, DgramRetryKind kind, MalValue extra,
    const MalValue *args, i32 argc, i32 address_index) {
    MalValue slots[5 + DGRAM_RETRY_ARGS] = {socket, mal_value_from_i32(kind), extra,
        mal_value_from_i32(argc < DGRAM_RETRY_ARGS ? argc : DGRAM_RETRY_ARGS), mal_value_from_i32(address_index)};
    for (i32 i = 0; i < DGRAM_RETRY_ARGS; i++) slots[5 + i] = i < argc ? args[i] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalValue function = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "dgramRetry"), dgram_retry_task, slots, countof(slots)));
    mal_gc_unroot(&root);
    return function;
}

/* lib/dgram.js lookup4/lookup6: `lookup(address, family, callback)` through dns.lookup. */
static bool dgram_lookup(MalVm *vm, MalDgramSocket *state, MalValue address, MalValue callback) {
    MalValue lookup_args[] = {address, mal_value_from_i32(state->family == AF_INET6 ? 6 : 4), callback};
    MalRootSpan root;
    mal_gc_root(&root, lookup_args, countof(lookup_args));
    mal_node_dns_lookup(vm, lookup_args, 3);
    mal_gc_unroot(&root);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

/* Node resolves the address through dns.lookup; numeric literals and localhost skip the resolver. */
static bool dgram_resolve(MalVm *vm, MalDgramSocket *state, MalValue value, bool wildcard, u16 port,
    char *text, struct sockaddr_storage *address, socklen_t *length) {
    if (mal_value_is_nil(value) || (mal_value_is_string(value) && mal_string_length(mal_value_to_string(value)) == 0)) {
        strcpy(text, state->family == AF_INET6 ? (wildcard ? "::" : "::1") : (wildcard ? "0.0.0.0" : "127.0.0.1"));
    } else {
        if (!mal_value_is_string(value)) {
            mal_node_throw_invalid_arg_type(vm, "address", "of type string", value);
            return false;
        }
        if (!dgram_ascii_string(vm, value, text, MAL_NET_ADDRESS_MAX)) return false;
        if (strcmp(text, "localhost") == 0) strcpy(text, state->family == AF_INET6 ? "::1" : "127.0.0.1");
    }
    if (!mal_net_parse_ip(text, port, address, length) || address->ss_family != state->family) {
        MalValue error = dgram_system_error(vm, EINVAL, "getaddrinfo", text, 0);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = error};
        return false;
    }
    return true;
}

static bool dgram_port(MalVm *vm, MalValue value, bool allow_zero, u16 *out) {
    f64 number = NAN;
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (mal_value_is_string(value) && mal_string_length(mal_value_to_string(value)) > 0) {
        if (!mal_vm_to_number(vm, value, &number)) return false;
    }
    if (!(number >= (allow_zero ? 0 : 1) && number < 65536) || floor(number) != number) {
        char received[128];
        mal_node_describe_received(vm, value, received, sizeof(received));
        char message[192];
        snprintf(message, sizeof(message), "Port should be %s 0 and < 65536. Received %s.", allow_zero ? ">=" : ">",
            received);
        return dgram_throw(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_SOCKET_BAD_PORT");
    }
    *out = (u16) number;
    return true;
}

static int dgram_open(MalDgramSocket *state, const struct sockaddr_storage *address, socklen_t length) {
    int fd = socket(state->family, SOCK_DGRAM, 0);
    if (fd < 0) return errno;
    int one = 1;
    (void) fcntl(fd, F_SETFD, FD_CLOEXEC);
    (void) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    if (state->reuse_address) (void) setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
#ifdef SO_REUSEPORT
    if (state->reuse_port || state->reuse_address) {
        (void) setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one));
    }
#endif
#ifdef SO_NOSIGPIPE
    (void) setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
#endif
    if (state->family == AF_INET6) {
        int only = state->ipv6_only ? 1 : 0;
        (void) setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only));
    }
    if (bind(fd, (const struct sockaddr *) address, length) != 0) {
        int error = errno;
        close(fd);
        return error;
    }
    if (state->recv_buffer_size > 0) {
        (void) setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &state->recv_buffer_size, sizeof(int));
    }
    if (state->send_buffer_size > 0) {
        (void) setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &state->send_buffer_size, sizeof(int));
    }
    state->fd = fd;
    return 0;
}

static bool dgram_start(MalVm *vm, MalDgramSocket *state) {
    MalHost *host = mal_host(vm);
    state->host = host;
    if (!mal_host_operation_start(&host->tasks, &state->operation)) return false;
    if (!mal_host_operation_bind(&host->tasks, state->operation, state) || !dgram_arm_read(state)
        || !mal_host_operation_activate(&host->tasks, state->operation)) {
        dgram_disarm_read(state);
        mal_host_operation_unbind(&host->tasks, state->operation, state);
        (void) mal_host_operation_abort_start(&host->tasks, state->operation);
        state->operation = 0;
        return false;
    }
    return true;
}

/* Binds synchronously; 'listening' or the bind error is emitted on the next tick as after Node's lookup. */
static bool dgram_bind_to(MalVm *vm, MalDgramSocket *state, MalValue address_value, u16 port) {
    if (dgram_needs_lookup(address_value)) {
        state->bound = true;
        state->binding = true;
        MalValue roots[] = {address_value, dgram_retry_function(vm, state->receiver, DGRAM_RETRY_BIND,
            mal_value_from_i32(port), nullptr, 0, -1)};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        bool ok = dgram_lookup(vm, state, roots[0], roots[1]);
        mal_gc_unroot(&root);
        return ok;
    }
    char text[MAL_NET_ADDRESS_MAX];
    struct sockaddr_storage address;
    socklen_t length;
    if (!dgram_resolve(vm, state, address_value, true, port, text, &address, &length)) return false;
    state->bound = true;
    int error = dgram_open(state, &address, length);
    if (error == 0 && !dgram_start(vm, state)) {
        close(state->fd);
        state->fd = -1;
        error = EIO;
    }
    if (error != 0) {
        state->bound = false;
        MalValue exception = dgram_system_error(vm, error, "bind", text, port);
        dgram_emit_later(vm, state->receiver, "error", exception);
        return true;
    }
    dgram_emit_later(vm, state->receiver, "listening", mal_value_new_undefined());
    return true;
}

static MalValue dgram_bind(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return mal_value_new_undefined();
    if (state->bound) {
        dgram_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Socket is already bound", "ERR_SOCKET_ALREADY_BOUND");
        return mal_value_new_undefined();
    }
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    i32 count = argc;
    if (count > 0 && mal_value_is_callable(args[count - 1])) roots[2] = args[--count];
    if (count > 0 && mal_value_is_object(args[0])) {
        if (!dgram_get(vm, args[0], "port", &roots[0]) || !dgram_get(vm, args[0], "address", &roots[1])) goto done;
    } else {
        roots[0] = count > 0 ? args[0] : undefined;
        roots[1] = count > 1 ? args[1] : undefined;
    }
    u16 port = 0;
    if (!mal_value_is_nil(roots[0]) && !dgram_port(vm, roots[0], true, &port)) goto done;
    dgram_listen_once(vm, receiver, "once", "listening", roots[2]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    (void) dgram_bind_to(vm, state, roots[1], port);
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? undefined : receiver;
}

static bool dgram_ensure_bound(MalVm *vm, MalDgramSocket *state) {
    return state->bound || dgram_bind_to(vm, state, mal_value_new_undefined(), 0);
}

static bool dgram_is_buffer_source(MalValue value) {
    return mal_value_is_typed_array_object(value) || mal_value_is_data_view_object(value);
}

static bool dgram_invalid_buffer(MalVm *vm, const char *name, MalValue value) {
    mal_node_throw_invalid_arg_type(vm, name, "of type string or an instance of Buffer, TypedArray, or DataView",
        value);
    return false;
}

typedef struct DgramSegments {
    struct iovec vectors[DGRAM_SEGMENTS_MAX];
    byte *owned[DGRAM_SEGMENTS_MAX];
    i32 count;
} DgramSegments;

static void dgram_segments_free(DgramSegments *segments) {
    for (i32 i = 0; i < segments->count; i++) free(segments->owned[i]);
    segments->count = 0;
}

static bool dgram_add_segment(MalVm *vm, DgramSegments *segments, MalValue value, f64 offset, f64 length,
    bool sliced) {
    if (segments->count == DGRAM_SEGMENTS_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "Too many buffers");
        return false;
    }
    i32 index = segments->count;
    byte *data = nullptr;
    usize size = 0;
    byte *owned = nullptr;
    if (mal_value_is_string(value)) {
        owned = mal_string_to_utf8(mal_value_to_string(value), &size);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        data = owned;
    } else {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(value, &span) != MAL_BUFFER_SOURCE_SPAN_OK) span = (MalBufferSourceSpan) {0};
        size = span.length;
        data = (byte *) mal_buffer_source_span_private(&span, &owned);
    }
    if (sliced) {
        usize start = offset > 0 ? (usize) fmin(offset, (f64) size) : 0;
        usize end = length >= 0 ? (usize) fmin((f64) start + length, (f64) size) : size;
        data = data == nullptr ? nullptr : data + start;
        size = end > start ? end - start : 0;
    }
    segments->vectors[index] = (struct iovec) {.iov_base = data, .iov_len = size};
    segments->owned[index] = owned;
    segments->count++;
    return true;
}

static bool dgram_collect(MalVm *vm, DgramSegments *segments, MalValue message, MalValue offset, MalValue length,
    bool sliced) {
    f64 start = 0, count = -1;
    if (sliced) {
        if (!mal_ops_is_number(offset)) {
            mal_node_throw_invalid_arg_type(vm, "offset", "of type number", offset);
            return false;
        }
        if (!mal_ops_is_number(length)) {
            mal_node_throw_invalid_arg_type(vm, "length", "of type number", length);
            return false;
        }
        start = mal_ops_number_as_f64(offset);
        count = mal_ops_number_as_f64(length);
    }
    if (mal_value_is_string(message) || dgram_is_buffer_source(message)) {
        return dgram_add_segment(vm, segments, message, start, count, sliced);
    }
    if (!mal_value_is_array_object(message)) return dgram_invalid_buffer(vm, "buffer", message);
    MalValue item = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &item, 1);
    MalValue length_value;
    bool ok = dgram_get(vm, message, "length", &length_value);
    i32 total = ok ? (i32) mal_ops_number_as_f64(length_value) : 0;
    for (i32 i = 0; ok && i < total; i++) {
        ok = mal_vm_get_property(vm, message, mal_key_from_value(mal_value_from_i32(i)), &item);
        if (ok && !mal_value_is_string(item) && !dgram_is_buffer_source(item)) {
            ok = dgram_invalid_buffer(vm, "buffer list arguments", item);
        }
        if (ok) ok = dgram_add_segment(vm, segments, item, 0, -1, false);
    }
    mal_gc_unroot(&root);
    return ok;
}

/* A nonblocking send that would block keeps the datagram, in order, until write readiness. */
static bool dgram_enqueue(MalVm *vm, MalDgramSocket *state, const DgramSegments *segments,
    const struct msghdr *header, MalValue callback, const char *text, u16 port) {
    usize length = 0;
    for (i32 i = 0; i < segments->count; i++) length += segments->vectors[i].iov_len;
    MalDgramSend *send = calloc(1, sizeof(MalDgramSend));
    byte *bytes = malloc(length == 0 ? 1 : length);
    if (send == nullptr || bytes == nullptr || !dgram_arm_write(state)) {
        free(send);
        free(bytes);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize offset = 0;
    for (i32 i = 0; i < segments->count; i++) {
        if (segments->vectors[i].iov_len > 0) memcpy(bytes + offset, segments->vectors[i].iov_base, segments->vectors[i].iov_len);
        offset += segments->vectors[i].iov_len;
    }
    send->bytes = bytes;
    send->length = length;
    if (header->msg_name != nullptr) memcpy(&send->address, header->msg_name, header->msg_namelen);
    send->address_length = header->msg_name != nullptr ? header->msg_namelen : 0;
    send->port = port;
    snprintf(send->address_text, sizeof(send->address_text), "%s", text);
    send->callback = mal_value_is_callable(callback) ? callback : mal_value_new_undefined();
    if (state->send_tail != nullptr) state->send_tail->next = send;
    else state->send_head = send;
    state->send_tail = send;
    state->send_queue_bytes += length;
    state->send_queue_count++;
    return true;
}

static MalValue dgram_send(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue arg[6];
    for (i32 i = 0; i < 6; i++) arg[i] = i < argc ? args[i] : undefined;
    MalDgramSocket *state = dgram_find(receiver);
    MalValue message = arg[0], offset = arg[1], length = arg[2], port = arg[3], address = arg[4];
    MalValue callback = arg[5];
    bool sliced = false;
    if (state == nullptr || !state->connected) {
        if (mal_value_is_truthy(address) || (mal_value_is_truthy(port) && !mal_value_is_callable(port))) {
            sliced = true;
        } else {
            callback = port;
            port = offset;
            address = length;
        }
    } else {
        if (mal_ops_is_number(length)) {
            sliced = true;
            if (mal_value_is_callable(port)) {
                callback = port;
                port = undefined;
            }
        } else {
            callback = offset;
            port = undefined;
            address = undefined;
        }
        if (mal_value_is_truthy(port) || mal_value_is_truthy(address)) {
            dgram_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Already connected", "ERR_SOCKET_DGRAM_IS_CONNECTED");
            return undefined;
        }
    }
    DgramSegments segments = {0};
    if (!dgram_collect(vm, &segments, message, offset, length, sliced)) {
        dgram_segments_free(&segments);
        return undefined;
    }
    if (!mal_value_is_callable(callback)) callback = undefined;
    if (!dgram_healthy(vm, state)) {
        dgram_segments_free(&segments);
        return undefined;
    }
    MalValue roots[] = {message, callback, address};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    u16 port_number = 0;
    char text[MAL_NET_ADDRESS_MAX] = {0};
    struct sockaddr_storage target;
    socklen_t target_length = 0;
    if (!state->connected) {
        if (!dgram_port(vm, port, false, &port_number)) goto done;
        if (state->binding) {
            MalValue once_args[] = {dgram_ascii(vm, "listening"), undefined};
            MalRootSpan once_root;
            mal_gc_root(&once_root, once_args, countof(once_args));
            once_args[1] = dgram_retry_function(vm, receiver, DGRAM_RETRY_SEND_LISTENING, undefined, args, argc, -1);
            dgram_call_method(vm, receiver, "once", once_args, 2);
            mal_gc_unroot(&once_root);
            goto done;
        }
        if (dgram_needs_lookup(roots[2])) {
            if (!dgram_ensure_bound(vm, state) || vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            MalValue retry = dgram_retry_function(vm, receiver, DGRAM_RETRY_SEND_LOOKUP, roots[1], args, argc,
                sliced ? 4 : 2);
            (void) dgram_lookup(vm, state, roots[2], retry);
            goto done;
        }
        if (!dgram_resolve(vm, state, roots[2], false, port_number, text, &target, &target_length)) goto done;
    }
    if (!dgram_ensure_bound(vm, state) || vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    if (state->fd < 0) {
        if (mal_value_is_callable(roots[1])) {
            MalValue error = dgram_system_error(vm, EBADF, "send", text, port_number);
            dgram_next_tick(vm, receiver, roots[1], error, undefined);
        }
        goto done;
    }
    struct msghdr header = {
        .msg_name = state->connected ? nullptr : &target,
        .msg_namelen = state->connected ? 0 : target_length,
        .msg_iov = segments.vectors,
        .msg_iovlen = segments.count,
    };
    ssize_t sent = -1;
    int error = EAGAIN;
    if (state->send_head == nullptr) {
        do {
            sent = sendmsg(state->fd, &header, 0);
        } while (sent < 0 && errno == EINTR);
        error = errno;
    }
    if (sent < 0 && dgram_would_block(error)) {
        if (!dgram_enqueue(vm, state, &segments, &header, roots[1], text, port_number)) goto done;
    } else {
        dgram_report_send(vm, state, roots[1], sent, error, text, port_number);
    }
done:
    dgram_segments_free(&segments);
    mal_gc_unroot(&root);
    return undefined;
}

static MalValue dgram_connect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalDgramSocket *state = dgram_find(receiver);
    MalValue port_value = argc > 0 ? args[0] : undefined;
    MalValue address = argc > 1 && !mal_value_is_callable(args[1]) ? args[1] : undefined;
    MalValue callback = argc > 0 && mal_value_is_callable(args[argc - 1]) ? args[argc - 1] : undefined;
    u16 port;
    if (!dgram_port(vm, port_value, false, &port) || !dgram_healthy(vm, state)) return undefined;
    if (state->connected) {
        dgram_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Already connected", "ERR_SOCKET_DGRAM_IS_CONNECTED");
        return undefined;
    }
    MalValue roots[] = {address, callback};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    char text[MAL_NET_ADDRESS_MAX];
    struct sockaddr_storage target;
    socklen_t length;
    dgram_listen_once(vm, receiver, "once", "connect", roots[1]);
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && dgram_resolve(vm, state, roots[0], false, port, text, &target, &length)
        && dgram_ensure_bound(vm, state) && vm->completion.kind != MAL_COMPLETION_THROW) {
        if (state->fd >= 0 && connect(state->fd, (const struct sockaddr *) &target, length) == 0) {
            state->connected = true;
            dgram_emit_later(vm, receiver, "connect", undefined);
        } else {
            MalValue error = dgram_system_error(vm, state->fd < 0 ? EBADF : errno, "connect", text, port);
            dgram_emit_later(vm, receiver, "error", error);
        }
    }
    mal_gc_unroot(&root);
    return undefined;
}

static MalDgramSocket *dgram_connected_state(MalVm *vm, MalValue receiver) {
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return nullptr;
    if (!state->connected) {
        dgram_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Not connected", "ERR_SOCKET_DGRAM_NOT_CONNECTED");
        return nullptr;
    }
    return state;
}

static MalValue dgram_disconnect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_connected_state(vm, receiver);
    if (state == nullptr) return mal_value_new_undefined();
    struct sockaddr unspecified = {0};
    unspecified.sa_family = AF_UNSPEC;
    // An AF_UNSPEC connect dissolves the association but reports EAFNOSUPPORT (and EINVAL on BSD), as libuv tolerates.
    if (connect(state->fd, &unspecified, sizeof(unspecified)) != 0 && errno != EAFNOSUPPORT && errno != EINVAL) {
        dgram_throw_system(vm, errno, "disconnect");
        return mal_value_new_undefined();
    }
    state->connected = false;
    return mal_value_new_undefined();
}

static MalValue dgram_remote_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_connected_state(vm, receiver);
    MalNetEndpoint endpoint;
    if (state == nullptr) return mal_value_new_undefined();
    if (!mal_net_remote_endpoint(state->fd, &endpoint)) {
        dgram_throw_system(vm, errno, "getpeername");
        return mal_value_new_undefined();
    }
    return dgram_endpoint_object(vm, &endpoint, -1);
}

static MalValue dgram_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return mal_value_new_undefined();
    MalNetEndpoint endpoint;
    if (state->fd < 0 || !mal_net_local_endpoint(state->fd, &endpoint)) {
        dgram_throw_system(vm, state->fd < 0 ? EBADF : errno, "getsockname");
        return mal_value_new_undefined();
    }
    return dgram_endpoint_object(vm, &endpoint, -1);
}

static void dgram_close_handle(MalVm *vm, MalDgramSocket *state) {
    state->closed = true;
    state->connected = false;
    if (state->operation == 0) {
        dgram_unlink(state);
        free(state);
        return;
    }
    dgram_disarm_read(state);
    (void) mal_reactor_cancel_op(&state->host->reactor, &state->write_op);
    while (state->send_head != nullptr) {
        MalDgramSend *send = state->send_head;
        state->send_head = send->next;
        dgram_send_free(send);
    }
    state->send_tail = nullptr;
    state->send_queue_bytes = 0;
    state->send_queue_count = 0;
    mal_host_operation_unbind(&state->host->tasks, state->operation, state);
    (void) mal_host_operation_complete(&state->host->tasks, state->operation, MAL_HOST_TERMINAL_OK, nullptr, nullptr);
    close(state->fd);
    state->fd = -1;
    (void) vm;
}

static MalValue dgram_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return mal_value_new_undefined();
    if (argc > 0) dgram_listen_once(vm, receiver, "on", "close", args[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    dgram_close_handle(vm, state);
    dgram_emit_later(vm, receiver, "close", mal_value_new_undefined());
    return receiver;
}

static MalValue dgram_set_ref(MalVm *vm, MalValue receiver, bool referenced) {
    MalDgramSocket *state = dgram_find(receiver);
    (void) vm;
    if (state == nullptr || state->closed || state->unreferenced == !referenced) return receiver;
    if (state->operation != 0 && state->read_op.active) state->host->reactor.unreferenced_ops += referenced ? -1 : 1;
    state->unreferenced = !referenced;
    return receiver;
}

static MalValue dgram_ref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return dgram_set_ref(vm, receiver, true);
}

static MalValue dgram_unref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return dgram_set_ref(vm, receiver, false);
}

typedef enum DgramOption {
    DGRAM_BROADCAST,
    DGRAM_TTL,
    DGRAM_MULTICAST_TTL,
    DGRAM_MULTICAST_LOOP,
    DGRAM_RECV_BUFFER,
    DGRAM_SEND_BUFFER,
} DgramOption;

static const char *const dgram_option_names[] = {
    "setBroadcast", "setTTL", "setMulticastTTL", "setMulticastLoopback", "setRecvBufferSize", "setSendBufferSize",
};

static bool dgram_option_target(DgramOption option, int family, int *level, int *name) {
    bool ipv6 = family == AF_INET6;
    switch (option) {
        case DGRAM_BROADCAST: *level = SOL_SOCKET; *name = SO_BROADCAST; return true;
        case DGRAM_TTL: *level = ipv6 ? IPPROTO_IPV6 : IPPROTO_IP; *name = ipv6 ? IPV6_UNICAST_HOPS : IP_TTL; return true;
        case DGRAM_MULTICAST_TTL:
            *level = ipv6 ? IPPROTO_IPV6 : IPPROTO_IP;
            *name = ipv6 ? IPV6_MULTICAST_HOPS : IP_MULTICAST_TTL;
            return true;
        case DGRAM_MULTICAST_LOOP:
            *level = ipv6 ? IPPROTO_IPV6 : IPPROTO_IP;
            *name = ipv6 ? IPV6_MULTICAST_LOOP : IP_MULTICAST_LOOP;
            return true;
        case DGRAM_RECV_BUFFER: *level = SOL_SOCKET; *name = SO_RCVBUF; return true;
        case DGRAM_SEND_BUFFER: *level = SOL_SOCKET; *name = SO_SNDBUF; return true;
    }
    return false;
}

static MalValue dgram_set_option(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, DgramOption option) {
    MalValue undefined = mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : undefined;
    int number;
    if (option == DGRAM_BROADCAST || option == DGRAM_MULTICAST_LOOP) {
        number = mal_value_is_truthy(value) ? 1 : 0;
    } else {
        if (!mal_ops_is_number(value)) {
            mal_node_throw_invalid_arg_type(vm, option == DGRAM_TTL ? "ttl" : option == DGRAM_MULTICAST_TTL
                ? "ttl" : "size", "of type number", value);
            return undefined;
        }
        number = (int) mal_ops_number_as_f64(value);
    }
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return undefined;
    int level, name;
    (void) dgram_option_target(option, state->family, &level, &name);
    unsigned char small = (unsigned char) number;
    bool byte_sized = state->family == AF_INET && (option == DGRAM_MULTICAST_TTL || option == DGRAM_MULTICAST_LOOP);
    int result = state->fd < 0 ? (errno = EBADF, -1) : byte_sized
        ? setsockopt(state->fd, level, name, &small, sizeof(small))
        : setsockopt(state->fd, level, name, &number, sizeof(number));
    if (result != 0) {
        dgram_throw_system(vm, errno, dgram_option_names[option]);
        return undefined;
    }
    return option == DGRAM_BROADCAST || option == DGRAM_MULTICAST_LOOP ? undefined : value;
}

#define DGRAM_SETTER(function, option) \
    static MalValue function( \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) { \
        (void) new_target; (void) callee; \
        return dgram_set_option(vm, receiver, args, argc, option); \
    }

DGRAM_SETTER(dgram_set_broadcast, DGRAM_BROADCAST)
DGRAM_SETTER(dgram_set_ttl, DGRAM_TTL)
DGRAM_SETTER(dgram_set_multicast_ttl, DGRAM_MULTICAST_TTL)
DGRAM_SETTER(dgram_set_multicast_loopback, DGRAM_MULTICAST_LOOP)
DGRAM_SETTER(dgram_set_recv_buffer_size, DGRAM_RECV_BUFFER)
DGRAM_SETTER(dgram_set_send_buffer_size, DGRAM_SEND_BUFFER)

static MalValue dgram_get_buffer_size(MalVm *vm, MalValue receiver, int name, const char *syscall) {
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return mal_value_new_undefined();
    int buffer_size = 0;
    socklen_t length = sizeof(buffer_size);
    if (state->fd < 0 || getsockopt(state->fd, SOL_SOCKET, name, &buffer_size, &length) != 0) {
        dgram_throw_system(vm, state->fd < 0 ? EBADF : errno, syscall);
        return mal_value_new_undefined();
    }
    return mal_value_from_i32(buffer_size);
}

static MalValue dgram_get_recv_buffer_size(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return dgram_get_buffer_size(vm, receiver, SO_RCVBUF, "uv_recv_buffer_size");
}

static MalValue dgram_get_send_buffer_size(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return dgram_get_buffer_size(vm, receiver, SO_SNDBUF, "uv_send_buffer_size");
}

static MalValue dgram_send_queue_size(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_find(receiver);
    return mal_value_from_i32(state == nullptr ? 0 : (i32) state->send_queue_bytes);
}

static MalValue dgram_send_queue_count(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    MalDgramSocket *state = dgram_find(receiver);
    return mal_value_from_i32(state == nullptr ? 0 : (i32) state->send_queue_count);
}

static MalValue dgram_set_multicast_interface(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(value)) {
        mal_node_throw_invalid_arg_type(vm, "interfaceAddress", "of type string", value);
        return mal_value_new_undefined();
    }
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return mal_value_new_undefined();
    char text[MAL_NET_ADDRESS_MAX];
    if (!dgram_ascii_string(vm, value, text, sizeof(text))) return mal_value_new_undefined();
    int result = -1;
    errno = EINVAL;
    if (state->family == AF_INET) {
        struct in_addr address;
        if (inet_pton(AF_INET, text, &address) == 1) {
            result = setsockopt(state->fd, IPPROTO_IP, IP_MULTICAST_IF, &address, sizeof(address));
        }
    } else {
        char *scope = strchr(text, '%');
        unsigned int index = scope == nullptr ? 0 : (unsigned int) strtoul(scope + 1, nullptr, 10);
        result = setsockopt(state->fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, &index, sizeof(index));
    }
    if (result != 0) dgram_throw_system(vm, errno, "setMulticastInterface");
    return mal_value_new_undefined();
}

static MalValue dgram_membership(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, bool add) {
    MalValue undefined = mal_value_new_undefined();
    const char *syscall = add ? "addMembership" : "dropMembership";
    MalValue group = argc > 0 ? args[0] : undefined;
    MalValue interface = argc > 1 ? args[1] : undefined;
    MalDgramSocket *state = dgram_find(receiver);
    if (!dgram_healthy(vm, state)) return undefined;
    if (mal_value_is_undefined(group)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"multicastAddress\" argument must be specified",
            "ERR_MISSING_ARGS");
        return undefined;
    }
    char group_text[MAL_NET_ADDRESS_MAX], interface_text[MAL_NET_ADDRESS_MAX] = {0};
    if (!dgram_ascii_string(vm, group, group_text, sizeof(group_text))) return undefined;
    if (mal_value_is_string(interface) && !dgram_ascii_string(vm, interface, interface_text, sizeof(interface_text))) {
        return undefined;
    }
    int result = -1;
    errno = EINVAL;
    if (state->family == AF_INET) {
        struct ip_mreq request = {0};
        if (inet_pton(AF_INET, group_text, &request.imr_multiaddr) == 1) {
            if (interface_text[0] != '\0') (void) inet_pton(AF_INET, interface_text, &request.imr_interface);
            result = setsockopt(state->fd, IPPROTO_IP, add ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP, &request,
                sizeof(request));
        }
    } else {
        struct ipv6_mreq request = {0};
        if (inet_pton(AF_INET6, group_text, &request.ipv6mr_multiaddr) == 1) {
            result = setsockopt(state->fd, IPPROTO_IPV6, add ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP, &request,
                sizeof(request));
        }
    }
    if (result != 0) dgram_throw_system(vm, errno, syscall);
    return undefined;
}

static MalValue dgram_add_membership(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    return dgram_membership(vm, receiver, args, argc, true);
}

static MalValue dgram_drop_membership(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    return dgram_membership(vm, receiver, args, argc, false);
}

/* Slots: [promise]. */
static MalValue dgram_dispose_settle(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalPromiseObject *promise = mal_value_to_promise_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue dgram_async_dispose(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalDgramSocket *state = dgram_find(receiver);
    if (state == nullptr || state->closed) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), mal_value_new_undefined());
    } else {
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "disposeClosed"), dgram_dispose_settle, roots, 1));
        dgram_close(vm, receiver, &roots[1], 1, mal_value_new_undefined(), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static bool dgram_option_int(MalVm *vm, MalValue options, const char *name, int *out) {
    MalValue value;
    if (!dgram_get(vm, options, name, &value)) return false;
    if (mal_value_is_undefined(value)) return true;
    f64 number;
    if (!mal_node_validate_integer(vm, value, name, 0, 2147483647.0, &number)) return false;
    *out = (int) number;
    return true;
}

/* Slots: [socket]; options.signal's abort listener. */
static MalValue dgram_signal_aborted(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue socket = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalDgramSocket *state = dgram_find(socket);
    if (state != nullptr && !state->closed) {
        dgram_close(vm, socket, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static bool dgram_watch_signal(MalVm *vm, MalValue socket, MalValue options) {
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {socket, options, undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = dgram_get(vm, roots[1], "signal", &roots[2]);
    if (ok && !mal_value_is_undefined(roots[2])) {
        if (!mal_value_is_object(roots[2])) {
            mal_node_throw_invalid_arg_type(vm, "options.signal", "an instance of AbortSignal", roots[2]);
            ok = false;
        }
        if (ok) ok = dgram_get(vm, roots[2], "aborted", &roots[3]);
        roots[4] = ok ? mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "onAborted"), dgram_signal_aborted, roots, 1)) : undefined;
        if (ok && mal_value_is_truthy(roots[3])) {
            mal_vm_call_value(vm, roots[4], undefined, nullptr, 0);
        } else if (ok) {
            MalValue once = mal_value_from_object(mal_intrinsic_new_object(vm));
            MalRootSpan once_root;
            mal_gc_root(&once_root, &once, 1);
            dgram_set(vm, once, "once", mal_value_new_boolean(true));
            MalValue listen_args[] = {dgram_ascii(vm, "abort"), roots[4], once};
            MalRootSpan args_root;
            mal_gc_root(&args_root, listen_args, 3);
            dgram_call_method(vm, roots[2], "addEventListener", listen_args, 3);
            mal_gc_unroot(&args_root);
            mal_gc_unroot(&once_root);
        }
        ok = ok && vm->completion.kind != MAL_COMPLETION_THROW;
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalValue dgram_new(MalVm *vm, MalObject *prototype, const MalValue *args, i32 argc) {
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = undefined;
    MalDgramSocket *state = calloc(1, sizeof(MalDgramSocket));
    if (state == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    state->fd = -1;
    roots[2] = roots[0];
    if (mal_value_is_object(roots[0])) {
        if (!dgram_get(vm, roots[0], "type", &roots[2])) goto fail;
        MalValue flag;
        if (!dgram_get(vm, roots[0], "reuseAddr", &flag)) goto fail;
        state->reuse_address = mal_value_is_truthy(flag);
        if (!dgram_get(vm, roots[0], "reusePort", &flag)) goto fail;
        state->reuse_port = mal_value_is_truthy(flag);
        if (!dgram_get(vm, roots[0], "ipv6Only", &flag)) goto fail;
        state->ipv6_only = mal_value_is_truthy(flag);
        if (!dgram_option_int(vm, roots[0], "recvBufferSize", &state->recv_buffer_size)
            || !dgram_option_int(vm, roots[0], "sendBufferSize", &state->send_buffer_size)) goto fail;
    }
    if (mal_value_is_string(roots[2]) && mal_string_equals_ascii(mal_value_to_string(roots[2]), "udp4")) {
        state->family = AF_INET;
    } else if (mal_value_is_string(roots[2]) && mal_string_equals_ascii(mal_value_to_string(roots[2]), "udp6")) {
        state->family = AF_INET6;
    } else {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Bad socket type specified. Valid types are: udp4, udp6", "ERR_SOCKET_BAD_TYPE");
        goto fail;
    }
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR], roots[3], nullptr, 0);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    dgram_set(vm, roots[3], "type", roots[2]);
    dgram_listen_once(vm, roots[3], "on", "message", roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    state->vm = vm;
    state->receiver = roots[3];
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    state->next = dgram_sockets;
    dgram_sockets = state;
    if (mal_value_is_object(roots[0]) && !dgram_watch_signal(vm, roots[3], roots[0])) goto done;
    result = roots[3];
    goto done;
fail:
    free(state);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue dgram_socket_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype = mal_vm_function_prototype(vm, target);
    return dgram_new(vm, mal_value_is_object(prototype) ? mal_value_to_object(prototype)
        : mal_value_to_object(dgram_prototype), args, argc);
}

static MalValue dgram_create_socket(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return dgram_new(vm, mal_value_to_object(dgram_prototype), args, argc);
}

void mal_host_install_node_dgram(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:dgram", slots, count)) return;
    mal_host_install_node_events(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]))),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    dgram_prototype = roots[1];
    MalObject *prototype = mal_value_to_object(roots[1]);
    static const struct {
        const char *name;
        i32 length;
        MalNativeFunctionCallback callback;
    } methods[] = {
        {"bind", 3, dgram_bind},
        {"connect", 3, dgram_connect},
        {"disconnect", 0, dgram_disconnect},
        {"send", 6, dgram_send},
        {"close", 1, dgram_close},
        {"address", 0, dgram_address},
        {"remoteAddress", 0, dgram_remote_address},
        {"ref", 0, dgram_ref},
        {"unref", 0, dgram_unref},
        {"setBroadcast", 1, dgram_set_broadcast},
        {"setTTL", 1, dgram_set_ttl},
        {"setMulticastTTL", 1, dgram_set_multicast_ttl},
        {"setMulticastLoopback", 1, dgram_set_multicast_loopback},
        {"setMulticastInterface", 1, dgram_set_multicast_interface},
        {"addMembership", 2, dgram_add_membership},
        {"dropMembership", 2, dgram_drop_membership},
        {"setRecvBufferSize", 1, dgram_set_recv_buffer_size},
        {"setSendBufferSize", 1, dgram_set_send_buffer_size},
        {"getRecvBufferSize", 0, dgram_get_recv_buffer_size},
        {"getSendBufferSize", 0, dgram_get_send_buffer_size},
        {"getSendQueueSize", 0, dgram_send_queue_size},
        {"getSendQueueCount", 0, dgram_send_queue_count},
    };
    for (usize i = 0; i < countof(methods); i++) {
        mal_intrinsic_define_method_n(vm, prototype, (const byte *) methods[i].name, methods[i].length,
            methods[i].callback);
    }
    MalValue dispose_key = vm->intrinsics[MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE];
    if (mal_value_is_symbol(dispose_key)) {
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "[Symbol.asyncDispose]"), 0, dgram_async_dispose));
        MalPropertyDesc descriptor = {.value = roots[2], .flags = DGRAM_METHOD};
        mal_object_define_own(prototype, mal_key_from_value(dispose_key), &descriptor);
    }
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Socket"), 2, dgram_socket_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[2] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[1], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[2], DGRAM_METHOD);
    mal_object_set_prototype((MalObject *) constructor,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "Socket", roots[2], DGRAM_VISIBLE);
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "createSocket"), 2, dgram_create_socket));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "createSocket", roots[3],
        DGRAM_VISIBLE);
    if (!dgram_roots_installed) {
        mal_gc_register_root_source(dgram_scan_roots, nullptr);
        mal_host_register_macrotask_drain(dgram_drain, false);
        dgram_roots_installed = true;
    }
    mal_node_module_publish(vm, "node:dgram", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
