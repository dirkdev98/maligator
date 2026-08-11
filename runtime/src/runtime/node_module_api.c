#include "node_module_api.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static MalValue node_module_dynamic_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Dynamic CommonJS loading is unavailable in an ahead-of-time image");
    return mal_value_new_undefined();
}

static MalValue node_module_create_require(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "createRequire filename must be a string");
        return mal_value_new_undefined();
    }

    MalValue require = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "require"), 1,
            node_module_dynamic_unavailable));
    MalRootSpan root;
    mal_gc_root(&root, &require, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(require),
        "resolve", 1, node_module_dynamic_unavailable);
    mal_gc_unroot(&root);
    return require;
}

void mal_host_install_node_module(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_MODULE_API_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "createRequire", 1, node_module_create_require);
        vm->intrinsics[MAL_INTRINSIC_NODE_MODULE_API_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
