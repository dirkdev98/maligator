#include "node_v8.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static MalValue node_v8_set_flags_from_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue flags = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(flags)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The flags argument must be a string");
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(flags);
    if (mal_string_equals(string, mal_intrinsic_ascii(vm, "--expose_gc")) ||
        mal_string_equals(string, mal_intrinsic_ascii(vm, "--expose-gc"))) {
        vm->node_v8_expose_gc = true;
    }
    return mal_value_new_undefined();
}

void mal_host_install_node_v8(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_V8_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module),
            "setFlagsFromString", 1, node_v8_set_flags_from_string);
        vm->intrinsics[MAL_INTRINSIC_NODE_V8_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
