#include "node_vm.h"

#if MAL_NODE

#include "builtin_eval.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

#if MAL_REALMS
static MalValue node_vm_collect_garbage(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_gc_collect(vm);
    return mal_value_new_undefined();
}

static void node_vm_install_context(MalVm *vm, void *data) {
    (void) data;
    if (!vm->node_v8_expose_gc) return;
    MalObject *global = mal_value_to_object(mal_realm_global(vm->current_realm));
    mal_intrinsic_define_method_n(
        vm, global, "gc", 0, node_vm_collect_garbage);
}
#endif

static MalValue node_vm_run_in_new_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue source = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(source)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The code argument must be a string");
        return mal_value_new_undefined();
    }
#if MAL_REALMS
    MalRootSpan root;
    mal_gc_root(&root, &source, 1);
    MalRealm *realm = mal_realm_create(vm, node_vm_install_context, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalCompletion completion = mal_realm_eval_script(vm, realm, source);
    mal_gc_unroot(&root);
    return completion.kind == MAL_COMPLETION_NORMAL
        ? completion.value
        : mal_value_new_undefined();
#else
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "node:vm requires engine.realms");
    return mal_value_new_undefined();
#endif
}

void mal_host_install_node_vm(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_VM_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "runInNewContext", 1, node_vm_run_in_new_context);
        vm->intrinsics[MAL_INTRINSIC_NODE_VM_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
