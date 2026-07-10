#include "builtin_proxy.h"

#include "function_object.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "proxy_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

// Slot carried by a revocation function: the proxy it revokes (set to undefined
// after the first call so a re-invocation is a no-op).
#define MAL_PROXY_REVOKE_SLOT_PROXY 0

static MalValue mal_builtin_proxy_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

// ProxyCreate(target, handler): both must be objects. Returns the proxy value,
// or undefined with a pending TypeError.
static MalValue mal_builtin_proxy_create(MalVm *vm, MalValue target, MalValue handler) {
    if (!mal_value_is_object(target) || !mal_value_is_object(handler)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create proxy with a non-object as target or handler");
        return mal_value_new_undefined();
    }
    return mal_value_from_proxy_object(mal_proxy_object_new(vm, target, handler));
}

static MalValue mal_builtin_proxy_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor Proxy requires 'new'");
        return mal_value_new_undefined();
    }
    return mal_builtin_proxy_create(vm, mal_builtin_proxy_arg(args, arg_count, 0), mal_builtin_proxy_arg(args, arg_count, 1));
}

static MalValue mal_builtin_proxy_revoke(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue proxy_value = mal_native_function_object_get_slot(self, MAL_PROXY_REVOKE_SLOT_PROXY);
    if (mal_value_is_proxy_object(proxy_value)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(proxy_value);
        proxy->revoked = true;
        // SATB: revoke drops the traced target/handler edges; shade the old values.
        mal_gc_write_barrier(proxy->target);
        mal_gc_write_barrier(proxy->handler);
        proxy->target = mal_value_new_null();
        proxy->handler = mal_value_new_null();
        mal_native_function_object_set_slot(self, MAL_PROXY_REVOKE_SLOT_PROXY, mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue mal_builtin_proxy_revocable(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue proxy_value = mal_builtin_proxy_create(vm, mal_builtin_proxy_arg(args, arg_count, 0), mal_builtin_proxy_arg(args, arg_count, 1));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalValue revoke_slots[1] = {proxy_value};
    MalNativeFunctionObject *revoke = mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, ""),
        mal_builtin_proxy_revoke,
        revoke_slots,
        1
    );

    MalObject *result = mal_intrinsic_new_object(vm);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, result, "proxy", proxy_value, flags);
    mal_intrinsic_define_data(vm, result, "revoke", mal_value_from_native_function_object(revoke), flags);
    return mal_value_from_object(result);
}

void mal_builtin_proxy_install(MalVm *vm) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Proxy"),
        2,
        mal_builtin_proxy_constructor
    );
    mal_native_function_object_set_constructor(constructor);
    vm->intrinsics[MAL_INTRINSIC_PROXY_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    // Proxy.revocable(target, handler).
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "revocable", 2, mal_builtin_proxy_revocable);
}
