#include "node_diagnostics_channel.h"

#if MAL_NODE

#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static MalValue node_diagnostics_undefined(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_new_undefined();
}

static MalValue node_diagnostics_false(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_new_boolean(false);
}

static MalValue node_diagnostics_channel(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalValue channel = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &channel, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(channel),
        "hasSubscribers", mal_value_new_boolean(false), MAL_PROPERTY_NONE);
    static const char *undefined_methods[] = {
        "bindStore", "runStores", "subscribe", "unbindStore", "unsubscribe",
    };
    for (usize i = 0; i < countof(undefined_methods); i++) {
        mal_intrinsic_define_method_n(vm, mal_value_to_object(channel),
            (const byte *) undefined_methods[i], 1, node_diagnostics_undefined);
    }
    mal_intrinsic_define_method_n(vm, mal_value_to_object(channel),
        "publish", 1, node_diagnostics_false);
    mal_gc_unroot(&root);
    return channel;
}

static MalValue node_diagnostics_trace_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue callback = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "traceSync callback must be callable");
        return mal_value_new_undefined();
    }
    MalValue this_value = argc >= 3 ? args[2] : mal_value_new_undefined();
    MalCompletion completion = mal_vm_call_value(
        vm, callback, this_value, argc > 3 ? args + 3 : nullptr,
        argc > 3 ? argc - 3 : 0);
    return completion.kind == MAL_COMPLETION_NORMAL
        ? completion.value
        : mal_value_new_undefined();
}

static MalValue node_diagnostics_tracing_channel(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue name = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(name)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TracingChannel name must be a string");
        return mal_value_new_undefined();
    }
    MalValue channel = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &channel, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(channel),
        "hasSubscribers", mal_value_new_boolean(false), MAL_PROPERTY_NONE);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(channel),
        "traceSync", 2, node_diagnostics_trace_sync);
    mal_gc_unroot(&root);
    return channel;
}

void mal_host_install_node_diagnostics_channel(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module =
        vm->intrinsics[MAL_INTRINSIC_NODE_DIAGNOSTICS_CHANNEL_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "tracingChannel", 1, node_diagnostics_tracing_channel);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "channel", 1, node_diagnostics_channel);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "subscribe", 2, node_diagnostics_undefined);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "unsubscribe", 2, node_diagnostics_false);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "hasSubscribers", 1, node_diagnostics_false);
        vm->intrinsics[MAL_INTRINSIC_NODE_DIAGNOSTICS_CHANNEL_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
