#include "node_domain.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm_ops.h"

static MalValue node_domain_create_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Domains are not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_domain(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
        mal_value_new_null(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "create"), 0,
            node_domain_create_unavailable));
    static const char *names[] = {"create", "active"};
    MalValue values[] = {roots[1], roots[2]};
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) names[i], values[i],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[0];
            continue;
        }
        for (usize j = 0; j < countof(names); j++) {
            if (strcmp(slots[i].name, names[j]) == 0) {
                vm->globals[slots[i].slot] = values[j];
                break;
            }
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
