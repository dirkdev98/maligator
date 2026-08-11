#include "node_worker_threads.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static MalValue node_worker_threads_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Worker threads are not supported by this host");
    return mal_value_new_undefined();
}

static MalValue node_worker_threads_receive(
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

static MalValue node_worker_threads_mark_uncloneable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    return argc > 0 ? args[0] : mal_value_new_undefined();
}

void mal_host_install_node_worker_threads(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[] = {
            mal_value_from_object(mal_intrinsic_new_object(vm)),
            mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_null(), mal_value_new_null(), mal_value_from_i32(0),
            mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_boolean(true),
            mal_value_from_object(mal_intrinsic_new_object(vm)),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        module = roots[0];
        MalObject *function_prototype =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        const char *constructor_names[] = {"Worker", "MessageChannel"};
        for (usize i = 0; i < countof(constructor_names); i++) {
            MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
                &vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) constructor_names[i]), 1,
                node_worker_threads_unavailable);
            mal_native_function_object_set_constructor(constructor);
            roots[i + 1] = mal_value_from_native_function_object(constructor);
        }
        roots[6] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) "receiveMessageOnPort"), 1,
                node_worker_threads_receive));
        roots[7] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) "markAsUncloneable"), 1,
                node_worker_threads_mark_uncloneable));
        const char *names[] = {
            "Worker", "MessageChannel", "parentPort", "workerData", "threadId",
            "receiveMessageOnPort", "markAsUncloneable", "isMainThread", "SHARE_ENV",
        };
        MalValue values[] = {
            roots[1], roots[2], roots[3], roots[4], roots[5], roots[6], roots[7],
            roots[8], roots[9],
        };
        for (usize i = 0; i < countof(names); i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(module),
                (const byte *) names[i], values[i],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                    MAL_PROPERTY_CONFIGURABLE);
        }
        vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
