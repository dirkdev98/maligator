#include "node_os.h"

#if MAL_NODE

#include <string.h>
#include <sys/utsname.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"

static MalValue os_release(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *release = uname(&info) == 0 ? info.release : "";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) release, strlen(release)));
}

static void os_publish(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
        } else {
            MalPropertyLookup found = mal_object_get_own(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name));
            if (found.present) vm->globals[slots[i].slot] = found.desc.value;
        }
    }
}

void mal_host_install_node_os(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "release", 0, os_release);
        vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    os_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
