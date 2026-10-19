#include "node_worker_threads.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "intern_store.h"
#include "intrinsics.h"
#include "map_object.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"
#include "workers.h"

static MalValue node_worker_threads_mark_uncloneable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc > 0) mal_workers_mark_uncloneable(vm, args[0]);
    return mal_value_new_undefined();
}

static MalValue node_worker_threads_mark_untransferable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc > 0) mal_workers_mark_untransferable(vm, args[0]);
    return mal_value_new_undefined();
}

static MalValue node_worker_threads_is_marked_untransferable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return mal_value_new_boolean(argc > 0 && mal_workers_is_marked_untransferable(vm, args[0]));
}

static MalValue node_worker_threads_set_environment_data(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue key = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue value = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue map = mal_workers_environment_data(vm);
    if (!mal_value_is_map_object(map)) return mal_value_new_undefined();
    if (mal_value_is_undefined(value)) mal_map_object_delete(mal_value_to_map_object(map), key);
    else mal_map_object_set(mal_value_to_map_object(map), key, value);
    return mal_value_new_undefined();
}

static MalValue node_worker_threads_get_environment_data(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue map = mal_workers_environment_data(vm);
    if (!mal_value_is_map_object(map)) return mal_value_new_undefined();
    return mal_map_object_get(mal_value_to_map_object(map), argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue node_worker_threads_function(MalVm *vm, const char *name, i32 length,
    MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
}

// Node publishes SHARE_ENV as this registered symbol, so it is identical across isolates
// and module copies.
static MalValue node_worker_threads_share_env(MalVm *vm) {
    MalString *key = mal_intrinsic_ascii(vm, (const byte *) "nodejs.worker_threads.SHARE_ENV");
    MalSymbol *symbol = mal_symbol_registry_find(&vm->symbol_registry, key);
    if (symbol == nullptr) {
        symbol = mal_symbol_registry_insert(&vm->symbol_registry, mal_symbol_new(&vm->heap, key));
    }
    return mal_value_from_symbol(symbol);
}

void mal_host_install_node_worker_threads(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:worker_threads", slots, count)) return;
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE];
    if (mal_value_is_undefined(module)) {
        if (!mal_workers_install(vm)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "node:worker_threads requires a host event loop");
            return;
        }
        MalValue roots[] = {
            mal_value_from_object(mal_intrinsic_new_object(vm)),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        module = roots[0];
        // SHARE_ENV must be published before workerData decoding or Worker use.
        vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE] = module;
        roots[2] = mal_workers_is_application() ? mal_value_new_undefined() : mal_workers_worker_data(vm);
        MalObject *function_prototype =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        roots[3] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) "markAsUncloneable"), 1,
                node_worker_threads_mark_uncloneable));
        roots[4] = node_worker_threads_function(vm, "markAsUntransferable", 1,
            node_worker_threads_mark_untransferable);
        roots[5] = node_worker_threads_function(vm, "isMarkedAsUntransferable", 1,
            node_worker_threads_is_marked_untransferable);
        roots[6] = node_worker_threads_function(vm, "setEnvironmentData", 2,
            node_worker_threads_set_environment_data);
        roots[7] = node_worker_threads_function(vm, "getEnvironmentData", 1,
            node_worker_threads_get_environment_data);
        bool main_thread = !mal_workers_is_worker() || mal_workers_is_application();
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        const char *names[] = {
            "Worker", "MessageChannel", "MessagePort", "parentPort", "workerData",
            "threadId", "receiveMessageOnPort", "markAsUncloneable", "isMainThread",
            "SHARE_ENV", "isInternalThread", "threadName", "resourceLimits", "BroadcastChannel",
            "markAsUntransferable", "isMarkedAsUntransferable", "setEnvironmentData", "getEnvironmentData",
        };
        MalValue values[] = {
            mal_workers_node_worker_constructor(vm),
            mal_workers_node_message_channel_constructor(vm),
            mal_workers_node_message_port_constructor(vm),
            main_thread ? mal_value_new_null() : mal_workers_parent_port(vm),
            roots[2],
            mal_value_from_i32(main_thread ? 0 : (i32) mal_workers_thread_id()),
            mal_workers_receive_message_function(vm),
            roots[3],
            mal_value_new_boolean(main_thread),
            node_worker_threads_share_env(vm),
            mal_value_new_boolean(false),
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "")),
            roots[1],
            mal_workers_node_broadcast_channel_constructor(vm),
            roots[4],
            roots[5],
            roots[6],
            roots[7],
        };
        for (usize i = 0; i < countof(names); i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(module),
                (const byte *) names[i], values[i],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                    MAL_PROPERTY_CONFIGURABLE);
        }
        // Node 26 bootstraps these as globals that are the module's own constructors.
        MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
        if (mal_value_is_object(global)) {
            const char *globals[] = {"BroadcastChannel", "MessageChannel", "MessagePort"};
            MalValue constructors[] = {
                mal_workers_node_broadcast_channel_constructor(vm),
                mal_workers_node_message_channel_constructor(vm),
                mal_workers_node_message_port_constructor(vm),
            };
            for (usize i = 0; i < countof(globals); i++) {
                mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) globals[i],
                    constructors[i], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
            }
        }
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:worker_threads", slots, count, module);
}

#endif /* MAL_NODE */
