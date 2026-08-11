#include "node_os.h"

#if MAL_NODE

#include <string.h>
#include <sys/utsname.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
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

static MalValue os_hostname(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *hostname = uname(&info) == 0 ? info.nodename : "";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) hostname, strlen(hostname)));
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
            vm, mal_value_to_object(module), (const byte *) "hostname", 0,
            os_hostname);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "release", 0, os_release);
        vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
