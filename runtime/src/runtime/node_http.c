#include "node_http.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_stream.h"
#include "object.h"
#include "object_ops.h"
#include "server.h"
#include "value_ops.h"
#include "vm_ops.h"

#define HTTP_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define HTTP_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

typedef struct MalNodeHttpServerState {
    MalVm *vm;
    MalValue receiver;
    MalHttpServer *native;
    u16 port;
    char host[16];
    bool listening_pending;
    bool closing;
    bool close_ready;
    struct MalNodeHttpServerState *next;
} MalNodeHttpServerState;

static MalNodeHttpServerState *http_servers;
static bool http_roots_installed;

static MalNodeHttpServerState *http_server_state(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return nullptr;
    MalObject *object = mal_value_to_object(receiver);
    for (MalNodeHttpServerState *state = http_servers; state != nullptr;
         state = state->next) {
        if (mal_value_to_object(state->receiver) == object) return state;
    }
    return nullptr;
}

static bool http_call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[] = {receiver, mal_value_new_undefined(),
                        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 2; i++) roots[i + 2] = args[i];
    bool found = mal_vm_get_property(
        vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) name), &roots[1]);
    if (found) {
        mal_vm_call_value(vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    }
    bool ok = found && vm->completion.kind != MAL_COMPLETION_THROW;
    mal_gc_unroot(&root);
    return ok;
}

static bool http_emit(MalVm *vm, MalValue receiver, const char *event) {
    MalValue name = mal_value_from_string(
        mal_intrinsic_ascii(vm, (const byte *) event));
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    bool ok = http_call_method(vm, receiver, "emit", &name, 1);
    mal_gc_unroot(&root);
    return ok;
}

static bool http_once(
    MalVm *vm, MalValue receiver, const char *event, MalValue callback) {
    MalValue args[] = {
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)), callback,
    };
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    bool ok = http_call_method(vm, receiver, "once", args, 2);
    mal_gc_unroot(&root);
    return ok;
}

static void http_native_close_complete(void *data) {
    MalNodeHttpServerState *state = data;
    state->native = nullptr;
    state->close_ready = true;
}

static void http_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalNodeHttpServerState *state = http_servers; state != nullptr;
         state = state->next) {
        if (state->vm == vm) mal_gc_mark_value(state->receiver);
    }
}

bool mal_node_http_drain(MalVm *vm) {
    MalNodeHttpServerState **link = &http_servers;
    while (*link != nullptr) {
        MalNodeHttpServerState *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        if (state->listening_pending) {
            state->listening_pending = false;
            http_emit(vm, state->receiver, "listening");
            return true;
        }
        if (state->close_ready) {
            MalValue receiver = state->receiver;
            MalRootSpan root;
            mal_gc_root(&root, &receiver, 1);
            *link = state->next;
            free(state);
            http_emit(vm, receiver, "close");
            mal_gc_unroot(&root);
            return true;
        }
        link = &state->next;
    }
    return false;
}

static bool http_ipv4_host(MalValue value, char out[16]) {
    if (!mal_value_is_string(value)) return false;
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    if (length == 0 || length >= 16) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0x7f) return false;
        out[i] = (char) units[i];
    }
    out[length] = '\0';
    return true;
}

static MalValue http_server_listen(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(receiver) || argc < 1 || !mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The port argument must be a number");
        return mal_value_new_undefined();
    }
    f64 number = mal_ops_number_as_f64(args[0]);
    if (!isfinite(number) || number < 0 || number > 65535 || floor(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The port argument must be between 0 and 65535");
        return mal_value_new_undefined();
    }
    if (http_server_state(receiver) != nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Listen method has been called more than once");
        return mal_value_new_undefined();
    }

    char host[16] = "0.0.0.0";
    MalValue callback = mal_value_new_undefined();
    if (argc > 1 && mal_value_is_string(args[1])) {
        if (!http_ipv4_host(args[1], host)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The host argument must be a numeric IPv4 address");
            return mal_value_new_undefined();
        }
        if (argc > 2) callback = args[2];
    } else if (argc > 1) {
        callback = args[1];
    }
    if (!mal_value_is_undefined(callback) && !mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The callback argument must be a function");
        return mal_value_new_undefined();
    }

    MalHttpServer *native = mal_http_server_start_unhandled(vm, host, (u16) number);
    if (native == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to listen on the requested address");
        return mal_value_new_undefined();
    }
    MalNodeHttpServerState *state = calloc(1, sizeof(MalNodeHttpServerState));
    if (state == nullptr) {
        mal_http_server_stop(native);
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Failed to allocate server state");
        return mal_value_new_undefined();
    }
    state->vm = vm;
    state->receiver = receiver;
    state->native = native;
    state->port = mal_http_server_port(native);
    memcpy(state->host, host, sizeof(state->host));
    state->listening_pending = true;
    state->next = http_servers;
    http_servers = state;

    if (!mal_value_is_undefined(callback)
        && !http_once(vm, receiver, "listening", callback)) {
        mal_http_server_close(native, http_native_close_complete, state);
        return mal_value_new_undefined();
    }
    return receiver;
}

static MalValue http_server_address(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr || state->native == nullptr || state->closing) {
        return mal_value_new_null();
    }
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *object = mal_value_to_object(roots[0]);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(
        vm, (const byte *) state->host));
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(
        vm, (const byte *) "IPv4"));
    mal_intrinsic_define_data(vm, object, (const byte *) "address", roots[1], HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "family", roots[2], HTTP_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "port",
                              mal_value_from_i32((i32) state->port), HTTP_VISIBLE);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_server_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalNodeHttpServerState *state = http_server_state(receiver);
    if (state == nullptr || state->native == nullptr || state->closing) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "Server is not running");
        return mal_value_new_undefined();
    }
    if (argc > 0 && !mal_value_is_undefined(args[0])) {
        if (!mal_value_is_callable(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The callback argument must be a function");
            return mal_value_new_undefined();
        }
        if (!http_once(vm, receiver, "close", args[0])) {
            return mal_value_new_undefined();
        }
    }
    state->closing = true;
    mal_http_server_close(state->native, http_native_close_complete, state);
    return receiver;
}

static MalValue http_construct(
    MalVm *vm, MalValue receiver, MalValue new_target, MalValue callee,
    MalIntrinsic parent_slot) {
    MalValue roots[] = {
        receiver, new_target, callee, vm->intrinsics[parent_slot],
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    if (mal_value_is_undefined(roots[1]) && mal_value_is_object(roots[0])) {
        mal_vm_call_value(vm, roots[3], roots[0], nullptr, 0);
        MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
            ? mal_value_new_undefined() : roots[0];
        mal_gc_unroot(&root);
        return result;
    }

    MalValue target = mal_value_is_undefined(roots[1]) ? roots[2] : roots[1];
    roots[4] = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(roots[4])
        ? mal_value_to_object(roots[4])
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_vm_call_value(vm, roots[3], roots[0], nullptr, 0);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_incoming_message_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    return http_construct(vm, receiver, new_target, callee,
                          MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR);
}

static MalValue http_server_response_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    return http_construct(vm, receiver, new_target, callee,
                          MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR);
}

static MalValue http_server_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue listener = mal_value_new_undefined();
    if (argc > 0 && mal_value_is_callable(args[0])) {
        listener = args[0];
    } else {
        if (argc > 0 && !mal_value_is_undefined(args[0])
            && !mal_value_is_null(args[0]) && !mal_value_is_object(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The options argument must be an object");
            return mal_value_new_undefined();
        }
        if (argc > 1) listener = args[1];
    }
    if (!mal_value_is_undefined(listener) && !mal_value_is_callable(listener)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The listener argument must be a function");
        return mal_value_new_undefined();
    }

    MalValue roots[] = {
        new_target, callee, listener, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue target = mal_value_is_undefined(roots[0]) ? roots[1] : roots[0];
    roots[3] = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(roots[3])
        ? mal_value_to_object(roots[3])
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    roots[4] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_vm_call_value(vm,
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR],
        roots[4], nullptr, 0);
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && !mal_value_is_undefined(roots[2])) {
        roots[5] = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) "request"));
        MalPropertyLookup on = mal_object_get_own(
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE]),
            mal_intrinsic_string_key(vm, (const byte *) "on"));
        MalValue on_args[] = {roots[5], roots[2]};
        mal_vm_call_value(vm, on.desc.value, roots[4], on_args, 2);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : roots[4];
    mal_gc_unroot(&root);
    return result;
}

static MalValue http_create_server(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR], args, argc);
    return completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined() : completion.value;
}

static MalValue http_constructor(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
                              prototype, MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype),
                              (const byte *) "constructor", value, HTTP_METHOD);
    return value;
}

static MalValue http_methods(MalVm *vm) {
    static const char *methods[] = {
        "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD",
        "LINK", "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL",
        "MOVE", "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH",
        "PURGE", "PUT", "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE",
        "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
    };
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, countof(methods));
    MalValue value = mal_value_from_array_object(array);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    for (u32 i = 0; i < countof(methods); i++) {
        MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
        MalValue method = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) methods[i]));
        mal_array_object_store(array, key, method);
    }
    mal_gc_unroot(&root);
    return value;
}

static void http_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalPropertyLookup lookup = mal_object_get_own(
            mal_value_to_object(module),
            mal_intrinsic_string_key(vm, (const byte *) slots[i].name));
        if (lookup.present) vm->globals[slots[i].slot] = lookup.desc.value;
    }
}

void mal_host_install_node_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE];
    if (!mal_value_is_undefined(cached)) {
        http_install_exports(vm, slots, count, cached);
        return;
    }

    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return;
    }
    MalValue roots[9] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE])));
    roots[2] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROTOTYPE])));
    roots[3] = http_constructor(vm, "IncomingMessage", 1,
                                http_incoming_message_constructor, roots[1]);
    roots[4] = http_constructor(vm, "ServerResponse", 2,
                                http_server_response_constructor, roots[2]);
    mal_object_set_prototype(mal_value_to_object(roots[3]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR]));
    roots[5] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "listen", 3,
        http_server_listen);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "address", 0,
        http_server_address);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[5]), (const byte *) "close", 1,
        http_server_close);
    roots[6] = http_constructor(vm, "Server", 2,
                                http_server_constructor, roots[5]);
    mal_object_set_prototype(mal_value_to_object(roots[6]), mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR]));
    roots[7] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "createServer"), 2,
            http_create_server));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "createServer", roots[7], HTTP_VISIBLE);
    roots[8] = http_methods(vm);

    static const char *names[] = {
        "METHODS", "IncomingMessage", "ServerResponse", "Server",
    };
    MalValue values[] = {roots[8], roots[3], roots[4], roots[6]};
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                                  (const byte *) names[i], values[i], HTTP_VISIBLE);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_CONSTRUCTOR] = roots[3];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_INCOMING_MESSAGE_PROTOTYPE] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_CONSTRUCTOR] = roots[4];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_RESPONSE_PROTOTYPE] = roots[2];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_CONSTRUCTOR] = roots[6];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_SERVER_PROTOTYPE] = roots[5];
    vm->intrinsics[MAL_INTRINSIC_NODE_HTTP_MODULE] = roots[0];
    if (!http_roots_installed) {
        mal_gc_register_root_source(http_scan_roots, nullptr);
        http_roots_installed = true;
    }
    http_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
