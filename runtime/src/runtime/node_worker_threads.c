#include "node_worker_threads.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "intern_store.h"
#include "intrinsics.h"
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
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        module = roots[0];
        // SHARE_ENV must be published before workerData decoding or Worker use.
        vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE] = module;
        roots[2] = mal_workers_worker_data(vm);
        MalObject *function_prototype =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        roots[3] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) "markAsUncloneable"), 1,
                node_worker_threads_mark_uncloneable));
        bool main_thread = !mal_workers_is_worker();
        const char *names[] = {
            "Worker", "MessageChannel", "MessagePort", "parentPort", "workerData",
            "threadId", "receiveMessageOnPort", "markAsUncloneable", "isMainThread",
            "SHARE_ENV",
        };
        MalValue values[] = {
            mal_workers_node_worker_constructor(vm),
            mal_workers_node_message_channel_constructor(vm),
            mal_workers_node_message_port_constructor(vm),
            mal_workers_parent_port(vm),
            roots[2],
            mal_value_from_i32((i32) mal_workers_thread_id()),
            mal_workers_receive_message_function(vm),
            roots[3],
            mal_value_new_boolean(main_thread),
            node_worker_threads_share_env(vm),
        };
        for (usize i = 0; i < countof(names); i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(module),
                (const byte *) names[i], values[i],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                    MAL_PROPERTY_CONFIGURABLE);
        }
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:worker_threads", slots, count, module);
}

#endif /* MAL_NODE */
