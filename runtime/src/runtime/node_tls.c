#include "node_tls.h"

#if MAL_NODE

#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"

#define TLS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue node_tls_connect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                       "node:tls.connect is not implemented");
    return mal_value_new_undefined();
}

void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
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
    vm->intrinsics[MAL_INTRINSIC_NODE_TLS_MODULE] = module;
    mal_node_module_publish(vm, slots, count, module);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
