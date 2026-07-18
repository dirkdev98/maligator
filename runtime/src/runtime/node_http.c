#include "node_http.h"

#if MAL_NODE

#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_stream.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"

#define HTTP_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define HTTP_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

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
    http_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
