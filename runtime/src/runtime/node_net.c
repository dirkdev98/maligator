#include "node_net.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"

#define NET_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue net_is_ip(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) return mal_value_from_i32(0);
    MalString *string = mal_value_to_string(args[0]);
    usize length = mal_string_length(string);
    if (length == 0 || length > INET6_ADDRSTRLEN) return mal_value_from_i32(0);
    char text[INET6_ADDRSTRLEN + 1];
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] > 0x7f) return mal_value_from_i32(0);
        text[i] = (char) units[i];
    }
    text[length] = '\0';
    struct in_addr address4;
    if (inet_pton(AF_INET, text, &address4) == 1) return mal_value_from_i32(4);
    struct in6_addr address6;
    return mal_value_from_i32(inet_pton(AF_INET6, text, &address6) == 1 ? 6 : 0);
}

void mal_host_install_node_net(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        MalValue is_ip = mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "isIP", 1, net_is_ip);
        mal_intrinsic_define_data(vm, mal_value_to_object(module),
                                  (const byte *) "isIP", is_ip, NET_VISIBLE);
        vm->intrinsics[MAL_INTRINSIC_NODE_NET_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
