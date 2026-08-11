#include "node_readline.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm_ops.h"

static MalValue node_readline_create_interface_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Readline interfaces are not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_readline(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "createInterface"), 1,
            node_readline_create_interface_unavailable));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
        (const byte *) "createInterface", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[0];
        } else if (strcmp(slots[i].name, "createInterface") == 0) {
            vm->globals[slots[i].slot] = roots[1];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
