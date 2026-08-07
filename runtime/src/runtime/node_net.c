#include "node_net.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "async_context.h"
#include "function_object.h"
#include "dns.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "intrinsics.h"
#include "net.h"
#include "node_buffer.h"
#include "node_module.h"
#include "node_stream.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "tcp.h"
#include "typed_array_object.h"
#include "utf8.h"
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
    MalNodeNetWrite *write_head;
    MalNodeNetWrite *write_tail;
    struct sockaddr_storage *addresses;
    socklen_t *address_lengths;
    usize address_count;
    usize address_index;
    usize queued_write_bytes;
    usize active_segment;
    u64 next_write_token;
    bool connected;
    bool resolving;
    bool write_in_flight;
    bool backpressured;
    bool read_paused;
    bool ending;
    bool destroyed;
    struct MalNodeNetSocketState *next;
} MalNodeNetSocketState;

static MalNodeNetSocketState *net_sockets;
static bool net_roots_installed;

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
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 2; i++) roots[2 + i] = args[i];
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
    free(state);
}

static const char *net_errno_code(int error) {
    switch (error) {
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

static MalValue net_is_ip(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) return mal_value_from_i32(0);
    MalString *string = mal_value_to_string(args[0]);
    usize length = mal_string_length(string);
    if (length == 0 || length > INET6_ADDRSTRLEN) return mal_value_from_i32(0);
    char text[INET6_ADDRSTRLEN + 1];
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0x7f) return mal_value_from_i32(0);
        text[i] = (char) units[i];
    }
    text[length] = '\0';
    struct in_addr address4;
    if (inet_pton(AF_INET, text, &address4) == 1) return mal_value_from_i32(4);
    struct in6_addr address6;
    return mal_value_from_i32(inet_pton(AF_INET6, text, &address6) == 1 ? 6 : 0);
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

static bool net_ascii_string(
    MalVm *vm, MalValue value, char **out) {
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
    f64 port_number;
    if (!mal_vm_to_number(vm, args[0], &port_number)
        || !isfinite(port_number) || floor(port_number) != port_number
        || port_number < 0 || port_number > 65535) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Socket port is out of range");
        }
        return mal_value_new_undefined();
    }
    MalValue host_value = argc > 1 && !mal_value_is_callable(args[1])
        ? args[1]
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "127.0.0.1"));
    char *host;
    if (!net_ascii_string(vm, host_value, &host)) return mal_value_new_undefined();
    MalNodeNetSocketState *state = calloc(1, sizeof(MalNodeNetSocketState));
    if (state == nullptr) {
        free(host);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->vm = vm;
    state->receiver = receiver;
    state->async_context = mal_async_context_capture(vm);
    state->destroy_error = mal_value_new_undefined();
    state->next_write_token = 1;
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    char service[6];
    snprintf(service, sizeof(service), "%u", (unsigned int) (u16) port_number);
    state->resolving = true;
    bool started = mal_dns_start(
        mal_host(vm), host, service, &state->operation) == MAL_DNS_START_OK;
    free(host);
    if (!started) {
        free(state);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to start socket connection");
        return mal_value_new_undefined();
    }
    state->next = net_sockets;
    net_sockets = state;
    net_set(vm, receiver, "connecting", mal_value_new_boolean(true));
    net_set(vm, receiver, "pending", mal_value_new_boolean(true));
    net_set(vm, receiver, "destroyed", mal_value_new_boolean(false));
    net_set(vm, receiver, "readyState", mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) "opening")));

    MalValue callback = argc > 1 && mal_value_is_callable(args[argc - 1])
        ? args[argc - 1] : mal_value_new_undefined();
    if (!mal_value_is_undefined(callback)) {
        MalValue once_args[] = {
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "connect")),
            callback,
        };
        net_call_method(vm, receiver, "once", once_args, 2);
    }
    return receiver;
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
        memcpy(*out, array->buffer->data + array->byte_offset, *length);
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
        if (!mal_dns_cancel(mal_host(vm), state->operation)) {
            (void) mal_host_operation_cancel(&mal_host(vm)->tasks, state->operation);
        }
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

static void net_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeNetSocketState *state = net_sockets; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(state->destroy_error);
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

static void net_dispatch_progress_in_context(
    MalVm *vm, MalNodeNetSocketState *state, MalTcpProgress *progress) {
    if (progress->kind == MAL_TCP_SECURE_CONNECTED) {
        net_set(vm, state->receiver, "encrypted", mal_value_new_boolean(true));
        net_emit(vm, state->receiver, "secureConnect", nullptr, 0);
        return;
    }
    if (progress->kind == MAL_TCP_CONNECTED) {
        state->connected = true;
        net_set(vm, state->receiver, "connecting", mal_value_new_boolean(false));
        net_set(vm, state->receiver, "pending", mal_value_new_boolean(false));
        net_set(vm, state->receiver, "readyState", mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "open")));
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
    const byte *alpn, usize alpn_length, bool insecure) {
    MalNodeNetSocketState *state = net_state(socket);
    if (state == nullptr || state->vm != vm || !state->connected
        || state->destroyed || state->resolving
        || !mal_tcp_start_tls(mal_host(vm), state->operation,
            server_name, server_name_length, ca_pem, ca_pem_length,
            alpn, alpn_length, insecure)) {
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
    if (task->result == MAL_HOST_TERMINAL_ERROR && mal_value_is_nil(error)) {
        error = net_error(vm, terminal == nullptr ? EIO : terminal->error);
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

static bool net_store_dns_addresses(
    MalNodeNetSocketState *state, const MalDnsResult *result) {
    usize count = mal_dns_result_address_count(result);
    if (count == 0) return false;
    struct sockaddr_storage *addresses = calloc(count, sizeof(*addresses));
    socklen_t *lengths = calloc(count, sizeof(*lengths));
    if (addresses == nullptr || lengths == nullptr) {
        free(addresses);
        free(lengths);
        return false;
    }
    for (usize i = 0; i < count; i++) {
        socklen_t length;
        const struct sockaddr *address = mal_dns_result_address(result, i, &length);
        if (address == nullptr || length > sizeof(addresses[i])) {
            free(addresses);
            free(lengths);
            return false;
        }
        memcpy(&addresses[i], address, length);
        lengths[i] = length;
    }
    state->addresses = addresses;
    state->address_lengths = lengths;
    state->address_count = count;
    state->address_index = 0;
    return true;
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
    if (state == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    void *data = mal_host_task_take_data(&host->tasks, &task);
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, state->async_context);
    if (state->resolving) {
        bool resolved = !state->destroyed && task.kind == MAL_HOST_TASK_TERMINAL
            && task.result == MAL_HOST_TERMINAL_OK && data != nullptr
            && net_store_dns_addresses(state, data);
        mal_dns_result_release(data);
        mal_host_task_release(&host->tasks, &task);
        if (resolved && net_start_next_address(state)) {
            net_pump_writes(state);
            net_maybe_shutdown_write(state);
#if MAL_REALMS
            mal_realm_switch(vm, saved_realm);
#endif
            mal_async_context_scope_exit(vm, &async_scope);
            return true;
        }
        MalHostTask failed = {
            .kind = MAL_HOST_TASK_TERMINAL,
            .result = task.result == MAL_HOST_TERMINAL_CANCELLED
                ? MAL_HOST_TERMINAL_CANCELLED : MAL_HOST_TERMINAL_ERROR,
        };
        MalTcpTerminal terminal = {.error = EHOSTUNREACH};
        MalNodeNetSocketState **link = net_state_link(state);
        if (*link == state) *link = state->next;
        net_dispatch_terminal(vm, state, &failed, &terminal);
        net_state_free(state);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
        mal_async_context_scope_exit(vm, &async_scope);
        return true;
    }
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
        net_dispatch_terminal(vm, state, &task, data);
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
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE];
    if (!mal_value_is_undefined(module)) {
        mal_node_module_publish(vm, slots, count, module);
        return;
    }
    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
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
    roots[3] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "isIP"), 1, net_is_ip));
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
    static const char *names[] = {"Socket", "isIP", "connect", "createConnection"};
    MalValue values[] = {roots[2], roots[3], roots[4], roots[5]};
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) names[i], values[i], NET_VISIBLE);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_CONSTRUCTOR] = roots[2];
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_SOCKET_PROTOTYPE] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE] = roots[0];
    if (!net_roots_installed) {
        mal_gc_register_root_source(net_scan_roots, nullptr);
        mal_host_register_macrotask_drain(mal_node_net_drain, false);
        net_roots_installed = true;
    }
    mal_node_module_publish(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
