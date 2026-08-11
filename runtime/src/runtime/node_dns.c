#include "node_dns.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "vm_ops.h"

#define DNS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue node_dns_resolver(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

static MalValue node_dns_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "DNS resolution is not supported by this host");
    return mal_value_new_undefined();
}

void mal_host_install_node_dns(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    enum {
        DNS_MODULE,
        DNS_RESOLVER_PROTOTYPE,
        DNS_RESOLVER,
        DNS_RESOLVE,
        DNS_RESOLVE4,
        DNS_RESOLVE6,
        DNS_LOOKUP,
        DNS_NODATA,
        DNS_NOTFOUND,
        DNS_NOTIMP,
        DNS_SERVFAIL,
        DNS_CONNREFUSED,
        DNS_REFUSED,
        DNS_ROOT_COUNT,
    };
    MalValue roots[DNS_ROOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    roots[DNS_MODULE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[DNS_RESOLVER_PROTOTYPE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const char *method_names[] = {"resolve", "resolve4", "resolve6"};
    for (usize i = 0; i < countof(method_names); i++) {
        mal_intrinsic_define_method_n(vm,
            mal_value_to_object(roots[DNS_RESOLVER_PROTOTYPE]),
            (const byte *) method_names[i], 2, node_dns_unavailable);
    }

    MalNativeFunctionObject *resolver = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Resolver"), 1, node_dns_resolver);
    mal_native_function_object_set_constructor(resolver);
    roots[DNS_RESOLVER] = mal_value_from_native_function_object(resolver);
    mal_intrinsic_define_data(vm, (MalObject *) resolver, (const byte *) "prototype",
        roots[DNS_RESOLVER_PROTOTYPE], MAL_PROPERTY_NONE);

    const i32 function_slots[] = {DNS_RESOLVE, DNS_RESOLVE4, DNS_RESOLVE6, DNS_LOOKUP};
    const char *function_names[] = {"resolve", "resolve4", "resolve6", "lookup"};
    for (usize i = 0; i < countof(function_slots); i++) {
        roots[function_slots[i]] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) function_names[i]), 3,
                node_dns_unavailable));
    }

    const i32 error_slots[] = {
        DNS_NODATA, DNS_NOTFOUND, DNS_NOTIMP,
        DNS_SERVFAIL, DNS_CONNREFUSED, DNS_REFUSED,
    };
    const char *error_names[] = {
        "NODATA", "NOTFOUND", "NOTIMP", "SERVFAIL", "CONNREFUSED", "REFUSED",
    };
    for (usize i = 0; i < countof(error_slots); i++) {
        roots[error_slots[i]] = mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) error_names[i]));
    }

    const char *names[] = {
        "Resolver", "resolve", "resolve4", "resolve6", "lookup",
        "NODATA", "NOTFOUND", "NOTIMP", "SERVFAIL", "CONNREFUSED", "REFUSED",
    };
    MalValue values[] = {
        roots[DNS_RESOLVER], roots[DNS_RESOLVE], roots[DNS_RESOLVE4],
        roots[DNS_RESOLVE6], roots[DNS_LOOKUP], roots[DNS_NODATA],
        roots[DNS_NOTFOUND], roots[DNS_NOTIMP], roots[DNS_SERVFAIL],
        roots[DNS_CONNREFUSED], roots[DNS_REFUSED],
    };
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[DNS_MODULE]),
            (const byte *) names[i], values[i], DNS_VISIBLE);
    }
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[DNS_MODULE];
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
