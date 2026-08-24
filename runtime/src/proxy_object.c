#include "proxy_object.h"

#include "array_object.h"
#include "builtin_object.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "property_iter.h"
#include "primordials.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

bool mal_value_is_proxy_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_PROXY_OBJECT);
}

MalProxyObject *mal_value_to_proxy_object(MalValue value) {
    return (MalProxyObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_proxy_object(MalProxyObject *proxy) {
    return mal_value_from_heap((MalHeapHeader *) proxy);
}

MalProxyObject *mal_proxy_object_new(MalVm *vm, MalValue target, MalValue handler) {
    MalProxyObject *proxy = mal_heap_alloc(&vm->heap, sizeof(MalProxyObject), MAL_HEAP_PROXY_OBJECT);
    // The base object fields are unused by proxy MOP, but initialize them so the
    // shared object accessors (and any GC walk) see a well-formed header.
    mal_object_init(&vm->heap, &proxy->object, MAL_HEAP_PROXY_OBJECT, nullptr);
    proxy->target = target;
    proxy->handler = handler;
    // ProxyCreate installs [[Call]]/[[Construct]] from the target once. Revocation
    // clears the target slot but does not change either internal-method presence.
    proxy->callable = mal_value_is_callable(target);
    proxy->constructor = mal_vm_is_constructor(vm, target);
    proxy->revoked = false;
    return proxy;
}

MalValue mal_proxy_unwrap_target(MalValue value) {
    while (mal_value_is_proxy_object(value)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(value);
        if (proxy->revoked) {
            return value;
        }
        value = proxy->target;
    }
    return value;
}

bool mal_proxy_target_is_callable(MalValue value) {
    if (mal_value_is_proxy_object(value)) {
        return mal_value_to_proxy_object(value)->callable;
    }
    return mal_value_is_callable(value);
}

// ---- shared helpers -------------------------------------------------------

// SameValue for the proxy invariant checks. Bit equality is not enough: equal
// strings/BigInts are not interned, so a trap returning an equal-but-distinct
// string/BigInt for a non-configurable non-writable property must not falsely
// trip the invariant.
static bool mal_proxy_same_value(MalValue a, MalValue b) {
    return mal_ops_same_value(a, b);
}

static bool mal_proxy_descriptor_is_data(const MalPropertyDescriptorParse *desc) {
    return desc->has_value || desc->has_writable;
}

static bool mal_proxy_descriptor_is_accessor(const MalPropertyDescriptorParse *desc) {
    return desc->has_get || desc->has_set;
}

static void mal_proxy_complete_property_descriptor(MalPropertyDescriptorParse *desc) {
    if (mal_proxy_descriptor_is_accessor(desc)) {
        desc->has_get = true;
        desc->has_set = true;
    } else {
        desc->has_value = true;
        desc->has_writable = true;
    }
    desc->has_enumerable = true;
    desc->has_configurable = true;
}

static bool mal_proxy_is_compatible_property_descriptor(
    bool extensible, const MalPropertyDescriptorParse *desc, bool current_present,
    MalPropertyDesc current) {
    if (!current_present) {
        return extensible;
    }
    if (!desc->has_value && !desc->has_writable && !desc->has_get && !desc->has_set &&
        !desc->has_enumerable && !desc->has_configurable) {
        return true;
    }

    bool current_configurable = (current.flags & MAL_PROPERTY_CONFIGURABLE) != 0;
    if (!current_configurable) {
        if (desc->has_configurable && (desc->desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            return false;
        }
        if (desc->has_enumerable &&
            ((desc->desc.flags & MAL_PROPERTY_ENUMERABLE) != 0) !=
                ((current.flags & MAL_PROPERTY_ENUMERABLE) != 0)) {
            return false;
        }
    }

    bool desc_data = mal_proxy_descriptor_is_data(desc);
    bool desc_accessor = mal_proxy_descriptor_is_accessor(desc);
    if (!desc_data && !desc_accessor) {
        return true;
    }
    bool current_accessor = (current.flags & MAL_PROPERTY_ACCESSOR) != 0;
    if (desc_accessor != current_accessor) {
        return current_configurable;
    }

    if (!current_accessor) {
        if (!current_configurable && !(current.flags & MAL_PROPERTY_WRITABLE)) {
            if (desc->has_writable && (desc->desc.flags & MAL_PROPERTY_WRITABLE)) {
                return false;
            }
            if (desc->has_value && !mal_proxy_same_value(desc->desc.value, current.value)) {
                return false;
            }
        }
        return true;
    }

    if (!current_configurable) {
        if (desc->has_get && !mal_proxy_same_value(desc->desc.getter, current.getter)) {
            return false;
        }
        if (desc->has_set && !mal_proxy_same_value(desc->desc.setter, current.setter)) {
            return false;
        }
    }
    return true;
}

// A revoked proxy throws on every operation. Returns true (and sets the throw)
// when the proxy is unusable, so callers can bail.
static bool mal_proxy_check_revoked(MalVm *vm, MalProxyObject *proxy) {
    if (proxy->revoked || mal_value_is_null(proxy->handler)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot perform operation on a proxy that has been revoked");
        return true;
    }
    return false;
}

#define MAL_PROXY_DISPATCH_DEPTH_LIMIT 256

static bool mal_proxy_dispatch_enter(MalVm *vm) {
    if (vm->proxy_dispatch_depth >= MAL_PROXY_DISPATCH_DEPTH_LIMIT) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Maximum call stack size exceeded");
        return false;
    }
    vm->proxy_dispatch_depth++;
    return true;
}

static void mal_proxy_dispatch_leave(MalVm *vm) {
    vm->proxy_dispatch_depth--;
}

// GetMethod(handler, trap): reads handler[trap]; undefined/null → trap absent
// (out stays undefined). A non-callable, non-nullish trap is a TypeError.
// Returns false on a throw (pending completion set).
static bool mal_proxy_get_trap_from_handler(
    MalVm *vm, MalValue handler, MalHotIntrinsicKey trap_key, MalValue *out) {
    *out = mal_value_new_undefined();
    MalKey key = mal_intrinsic_hot_string_key(vm, trap_key);
    MalValue trap;
    if (!mal_vm_get_property(vm, handler, key, &trap)) {
        return false;
    }
    if (mal_value_is_nil(trap)) {
        return true;
    }
    if (!mal_value_is_callable(trap)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Proxy handler trap is not a function");
        return false;
    }
    *out = trap;
    return true;
}

static bool mal_proxy_get_trap(
    MalVm *vm, MalProxyObject *proxy, MalHotIntrinsicKey trap_key, MalValue *out
) {
    return mal_proxy_get_trap_from_handler(vm, proxy->handler, trap_key, out);
}

// Forward declaration: target-own probing recurses through a proxy target's
// getOwnPropertyDescriptor trap.
static bool mal_proxy_target_get_own(MalVm *vm, MalValue target, MalKey key, bool *present, MalPropertyDesc *desc);

// Convert a property key to the value passed to a trap (string for indices).
static MalValue mal_proxy_key_to_value(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }
    return key.value;
}

// Target [[GetOwnProperty]], including nested proxies and engine exotics. The
// boolean reports operation success; a clean miss is success with *present=false.
static bool mal_proxy_target_get_own(MalVm *vm, MalValue target, MalKey key, bool *present, MalPropertyDesc *desc) {
    return mal_vm_get_own_property(vm, target, key, present, desc);
}

// ---- get ------------------------------------------------------------------

static bool mal_proxy_get_snapshot(
    MalVm *vm, MalValue *roots, MalKey key, MalValue *out
) {
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_GET, &roots[4])) {
        return false;
    }
    if (mal_value_is_undefined(roots[4])) {
        return mal_vm_get_property_with_receiver(
            vm, roots[0], key, roots[3], out);
    }

    roots[5] = mal_proxy_key_to_value(vm, key);
    MalValue args[3] = {roots[0], roots[5], roots[3]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[4], roots[1], args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    roots[4] = completion.value;

    // Invariant: a non-configurable, non-writable data property must report its
    // exact value; a non-configurable accessor with no getter must report
    // undefined.
    bool present;
    MalPropertyDesc desc;
    if (!mal_proxy_target_get_own(vm, roots[0], key, &present, &desc)) {
        return false;
    }
    if (present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            if (!(desc.flags & MAL_PROPERTY_ACCESSOR) && !(desc.flags & MAL_PROPERTY_WRITABLE)) {
                if (!mal_proxy_same_value(roots[4], desc.value)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy get trap violated invariant on non-configurable non-writable property");
                    return false;
                }
            }
            if ((desc.flags & MAL_PROPERTY_ACCESSOR) && mal_value_is_undefined(desc.getter)) {
                if (!mal_value_is_undefined(roots[4])) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy get trap violated invariant on non-configurable accessor property");
                    return false;
                }
            }
        }
    }

    *out = roots[4];
    return true;
}

bool mal_proxy_get(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue receiver, MalValue *out) {
    *out = mal_value_new_undefined();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[6] = {
        proxy->target, proxy->handler, key.value, receiver,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 6);
    key.value = roots[2];
    bool ok = mal_proxy_get_snapshot(vm, roots, key, out);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- set ------------------------------------------------------------------

static bool mal_proxy_set_snapshot(
    MalVm *vm, MalValue *roots, MalKey key
) {
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_SET, &roots[5])) {
        return false;
    }
    if (mal_value_is_undefined(roots[5])) {
        return mal_vm_set_property(vm, roots[0], key, roots[2], roots[3]);
    }

    roots[6] = mal_proxy_key_to_value(vm, key);
    MalValue args[4] = {roots[0], roots[6], roots[2], roots[3]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[5], roots[1], args, 4);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    if (!mal_value_is_truthy(completion.value)) {
        return false;
    }

    // Invariant: cannot report success when the target has a non-configurable,
    // non-writable data property with a different value, or a non-configurable
    // accessor with no setter.
    bool present;
    MalPropertyDesc desc;
    if (!mal_proxy_target_get_own(vm, roots[0], key, &present, &desc)) {
        return false;
    }
    if (present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            if (!(desc.flags & MAL_PROPERTY_ACCESSOR) && !(desc.flags & MAL_PROPERTY_WRITABLE)) {
                if (!mal_proxy_same_value(roots[2], desc.value)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy set trap violated invariant on non-configurable non-writable property");
                    return false;
                }
            }
            if ((desc.flags & MAL_PROPERTY_ACCESSOR) && mal_value_is_undefined(desc.setter)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy set trap violated invariant on non-configurable accessor property");
                return false;
            }
        }
    }

    return true;
}

bool mal_proxy_set(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue value, MalValue receiver) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[7] = {
        proxy->target, proxy->handler, value, receiver, key.value,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 7);
    key.value = roots[4];
    bool ok = mal_proxy_set_snapshot(vm, roots, key);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- has ------------------------------------------------------------------

static bool mal_proxy_has_snapshot(
    MalVm *vm, MalValue *roots, MalKey key
) {
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_HAS, &roots[3])) {
        return false;
    }
    if (mal_value_is_undefined(roots[3])) {
        return mal_vm_has_property(vm, roots[0], key);
    }

    roots[4] = mal_proxy_key_to_value(vm, key);
    MalValue args[2] = {roots[0], roots[4]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[3], roots[1], args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);

    // Invariant: a property cannot be reported absent if it is a
    // non-configurable own property of the target, or if the target is
    // non-extensible and the property is an own property.
    if (!result) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_proxy_target_get_own(vm, roots[0], key, &present, &desc)) {
            return false;
        }
        if (present) {
            if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy has trap returned false for non-configurable property");
                return false;
            }
            bool extensible;
            if (!mal_vm_is_extensible_object(vm, roots[0], &extensible)) {
                return false;
            }
            if (!extensible) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy has trap returned false for property of a non-extensible target");
                return false;
            }
        }
    }

    return result;
}

bool mal_proxy_has(MalVm *vm, MalProxyObject *proxy, MalKey key) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[5] = {
        proxy->target, proxy->handler, key.value,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 5);
    key.value = roots[2];
    bool result = mal_proxy_has_snapshot(vm, roots, key);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return result;
}

// ---- deleteProperty -------------------------------------------------------

static bool mal_proxy_delete_snapshot(
    MalVm *vm, MalValue *roots, MalKey key
) {
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_DELETE_PROPERTY, &roots[3])) {
        return false;
    }
    if (mal_value_is_undefined(roots[3])) {
        return mal_vm_delete_property(vm, roots[0], key);
    }

    roots[4] = mal_proxy_key_to_value(vm, key);
    MalValue args[2] = {roots[0], roots[4]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[3], roots[1], args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    if (!mal_value_is_truthy(completion.value)) {
        return false;
    }

    // Invariant: a non-configurable own property of the target cannot be
    // reported as deleted; nor any own property of a non-extensible target.
    bool present;
    MalPropertyDesc desc;
    if (!mal_proxy_target_get_own(vm, roots[0], key, &present, &desc)) {
        return false;
    }
    if (present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy deleteProperty trap cannot delete a non-configurable property");
            return false;
        }
        bool extensible;
        if (!mal_vm_is_extensible_object(vm, roots[0], &extensible)) {
            return false;
        }
        if (!extensible) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy deleteProperty trap cannot delete a property of a non-extensible target");
            return false;
        }
    }

    return true;
}

bool mal_proxy_delete(MalVm *vm, MalProxyObject *proxy, MalKey key) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[5] = {
        proxy->target, proxy->handler, key.value,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 5);
    key.value = roots[2];
    bool ok = mal_proxy_delete_snapshot(vm, roots, key);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- getOwnPropertyDescriptor ---------------------------------------------

bool mal_proxy_get_own_property_descriptor(MalVm *vm, MalProxyObject *proxy, MalKey key, bool *present_out, MalPropertyDesc *desc_out) {
    *present_out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }

    // Snapshot and root the internal slots before GetMethod: its property getter
    // can revoke this proxy and can collect. The trap result and target descriptor
    // fields remain rooted across ToPropertyDescriptor and IsExtensible re-entry.
    MalValue roots[9] = {
        proxy->target,
        proxy->handler,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        key.value,
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 9);
    key.value = roots[7];

    bool ok = false;
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_GET_OWN_PROPERTY_DESCRIPTOR,
            &roots[2])) {
        goto done;
    }
    if (mal_value_is_undefined(roots[2])) {
        ok = mal_vm_get_own_property(vm, roots[0], key, present_out, desc_out);
        goto done;
    }

    roots[8] = mal_proxy_key_to_value(vm, key);
    MalValue args[2] = {roots[0], roots[8]};
    MalCompletion completion = mal_vm_call_value(vm, roots[2], roots[1], args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        goto done;
    }
    roots[3] = completion.value;
    if (!mal_value_is_object(roots[3]) && !mal_value_is_undefined(roots[3])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy getOwnPropertyDescriptor trap must return an object or undefined");
        goto done;
    }

    bool target_present;
    MalPropertyDesc target_desc = {0};
    if (!mal_vm_get_own_property(vm, roots[0], key, &target_present, &target_desc)) {
        goto done;
    }
    if (target_present) {
        roots[4] = target_desc.value;
        roots[5] = target_desc.getter;
        roots[6] = target_desc.setter;
    }

    if (mal_value_is_undefined(roots[3])) {
        if (!target_present) {
            ok = true;
            goto done;
        }
        if (!(target_desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy getOwnPropertyDescriptor hid a non-configurable property");
            goto done;
        }
        bool extensible;
        if (!mal_vm_is_extensible_object(vm, roots[0], &extensible)) {
            goto done;
        }
        if (!extensible) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy getOwnPropertyDescriptor hid a property of a non-extensible target");
            goto done;
        }
        ok = true;
        goto done;
    }

    bool extensible;
    if (!mal_vm_is_extensible_object(vm, roots[0], &extensible)) {
        goto done;
    }
    MalPropertyDescriptorParse parsed;
    if (!mal_builtin_object_to_property_descriptor(vm, roots[3], &parsed)) {
        goto done;
    }
    mal_proxy_complete_property_descriptor(&parsed);
    if (!mal_proxy_is_compatible_property_descriptor(
            extensible, &parsed, target_present, target_desc)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy getOwnPropertyDescriptor returned an incompatible descriptor");
        goto done;
    }

    bool result_configurable = (parsed.desc.flags & MAL_PROPERTY_CONFIGURABLE) != 0;
    if (!result_configurable) {
        if (!target_present || (target_desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy getOwnPropertyDescriptor reported an invalid non-configurable property");
            goto done;
        }
        if (parsed.has_writable && !(parsed.desc.flags & MAL_PROPERTY_WRITABLE) &&
            (target_desc.flags & MAL_PROPERTY_WRITABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy getOwnPropertyDescriptor reported an invalid non-writable property");
            goto done;
        }
    }

    *desc_out = parsed.desc; // CompletePropertyDescriptor defaults are already present.
    *present_out = true;
    ok = true;

done:
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- defineProperty -------------------------------------------------------

static bool mal_proxy_define_own_property_snapshot(
    MalVm *vm, MalValue target, MalValue handler, MalKey key,
    const MalPropertyDescriptorParse *parsed, MalValue descriptor_value) {
    MalValue trap;
    if (!mal_proxy_get_trap_from_handler(
            vm, handler, MAL_HOT_KEY_PROXY_DEFINE_PROPERTY, &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_builtin_object_define_own_property_parsed(
            vm, target, key, parsed);
    }

    MalValue call_roots[4] = {trap, target, key.value, descriptor_value};
    MalRootSpan call_span;
    mal_gc_root(&call_span, call_roots, 4);
    call_roots[2] = mal_proxy_key_to_value(vm, key);
    MalCompletion completion = mal_vm_call_value(
        vm, call_roots[0], handler, &call_roots[1], 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        mal_gc_unroot(&call_span);
        return false;
    }
    if (!mal_value_is_truthy(completion.value)) {
        mal_gc_unroot(&call_span);
        return false;
    }
    mal_gc_unroot(&call_span);

    bool present;
    MalPropertyDesc target_desc = {0};
    if (!mal_proxy_target_get_own(vm, target, key, &present, &target_desc)) {
        return false;
    }
    MalValue target_roots[3] = {
        target_desc.value,
        target_desc.getter,
        target_desc.setter,
    };
    MalRootSpan target_span;
    mal_gc_root(&target_span, target_roots, 3);
    bool ok = false;
    bool extensible;
    if (!mal_vm_is_extensible_object(vm, target, &extensible)) {
        goto done;
    }
    bool setting_config_false = parsed->has_configurable &&
        !(parsed->desc.flags & MAL_PROPERTY_CONFIGURABLE);
    if (!present) {
        if (!extensible) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy defineProperty added a property to a non-extensible target");
            goto done;
        }
        if (setting_config_false) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy defineProperty added a non-configurable property");
            goto done;
        }
        ok = true;
        goto done;
    }

    if (!mal_proxy_is_compatible_property_descriptor(
            extensible, parsed, true, target_desc)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy defineProperty returned an incompatible descriptor");
        goto done;
    }
    if (setting_config_false && (target_desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy defineProperty made a configurable property non-configurable");
        goto done;
    }
    if (!(target_desc.flags & MAL_PROPERTY_ACCESSOR) &&
        !(target_desc.flags & MAL_PROPERTY_CONFIGURABLE) &&
        (target_desc.flags & MAL_PROPERTY_WRITABLE) && parsed->has_writable &&
        !(parsed->desc.flags & MAL_PROPERTY_WRITABLE)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy defineProperty made a fixed writable property non-writable");
        goto done;
    }
    ok = true;

done:
    mal_gc_unroot(&target_span);
    return ok;
}

bool mal_proxy_define_own_property_parsed(
    MalVm *vm, MalProxyObject *proxy, MalKey key,
    const MalPropertyDescriptorParse *parsed) {
    MalValue roots[8] = {
        mal_value_from_proxy_object(proxy),
        key.value,
        parsed->desc.value,
        parsed->desc.getter,
        parsed->desc.setter,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 8);
    key.value = roots[1];
    MalPropertyDescriptorParse rooted = *parsed;
    rooted.desc.value = roots[2];
    rooted.desc.getter = roots[3];
    rooted.desc.setter = roots[4];
    proxy = mal_value_to_proxy_object(roots[0]);
    bool ok = !mal_proxy_check_revoked(vm, proxy) && mal_proxy_dispatch_enter(vm);
    if (ok) {
        roots[5] = proxy->target;
        roots[6] = proxy->handler;
        roots[7] = mal_builtin_object_parsed_descriptor_object(vm, &rooted);
        ok = mal_proxy_define_own_property_snapshot(
            vm, roots[5], roots[6], key, &rooted, roots[7]);
        mal_proxy_dispatch_leave(vm);
    }
    mal_gc_unroot(&roots_span);
    return ok;
}

bool mal_proxy_define_own_property(
    MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue descriptor_value) {
    MalValue roots[2] = {descriptor_value, key.value};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    key.value = roots[1];
    MalPropertyDescriptorParse parsed;
    bool ok = mal_builtin_object_to_property_descriptor(vm, roots[0], &parsed);
    if (ok) {
        ok = mal_proxy_define_own_property_parsed(vm, proxy, key, &parsed);
    }
    mal_gc_unroot(&roots_span);
    return ok;
}

// ---- ownKeys --------------------------------------------------------------

static bool mal_proxy_own_keys_build(
    MalVm *vm, MalValue target, MalValue result, MalObject *seen,
    MalPropertyDesc marker, MalArrayObject *keys
);

bool mal_proxy_own_property_keys(MalVm *vm, MalProxyObject *proxy, MalValue *out_array) {
    *out_array = mal_value_new_undefined();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }

    // Snapshot and root internal slots before the observable GetMethod. Either
    // the trap getter or trap itself can revoke the proxy and collect.
    MalValue roots[6] = {
        proxy->target,
        proxy->handler,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 6);

    bool ok = false;
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_OWN_KEYS, &roots[2])) {
        goto done;
    }
    if (mal_value_is_undefined(roots[2])) {
        ok = mal_vm_own_property_keys(vm, roots[0], out_array);
        goto done;
    }

    MalValue args[1] = {roots[0]};
    MalCompletion completion = mal_vm_call_value(vm, roots[2], roots[1], args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        goto done;
    }
    roots[3] = completion.value;
    if (!mal_value_is_object(roots[3])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy ownKeys trap must return an array-like object");
        goto done;
    }

    MalObject *seen = mal_intrinsic_new_object(vm);
    MalPropertyDesc marker = mal_intrinsic_data_desc(mal_value_new_undefined(), 0);
    MalArrayObject *keys = mal_intrinsic_new_array(vm, 0);
    roots[4] = mal_value_from_object(seen);
    roots[5] = mal_value_from_array_object(keys);
    ok = mal_proxy_own_keys_build(vm, roots[0], roots[3], seen, marker, keys);
    if (ok) {
        *out_array = mal_value_from_array_object(keys);
    }

done:
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// CreateListFromArrayLike plus the complete target-key consistency phase. Each
// trap-result index is read exactly once while building `keys`; invariants only
// inspect that native snapshot.
static bool mal_proxy_own_keys_build(
    MalVm *vm, MalValue target, MalValue result, MalObject *seen,
    MalPropertyDesc marker, MalArrayObject *keys
) {
    MalValue length_value;
    if (!mal_vm_get_property(vm, result, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return false;
    }
    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) {
        return false;
    }
    i64 length = 0;
    if (length_number >= 1.0) {
        length = length_number > 4294967295.0 ? 4294967295 : (i64) length_number;
    }

    // `seen` is the duplicate/coverage set; `keys` is the result being built (both
    // created and rooted by the caller).
    for (i64 index = 0; index < length; index++) {
        MalKey idx_key = mal_key_index(index);
        MalValue element;
        if (!mal_vm_get_property(vm, result, idx_key, &element)) {
            return false;
        }
        if (!mal_value_is_string(element) && !mal_value_is_symbol(element)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap returned a non-string non-symbol key");
            return false;
        }
        MalKey element_key;
        if (!mal_vm_value_to_property_key(vm, element, &element_key)) {
            return false;
        }
        // Invariant: the trap result must not contain duplicate entries.
        if (mal_object_get_own(seen, element_key).present) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap returned duplicate keys");
            return false;
        }
        mal_object_define_own(seen, element_key, &marker);
        mal_array_object_store(keys, mal_key_index(index), element);
    }

    MalValue invariant_roots[2] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan invariant_span;
    mal_gc_root(&invariant_span, invariant_roots, 2);
    bool ok = false;
    if (!mal_vm_own_property_keys(vm, target, &invariant_roots[0])) {
        goto invariant_done;
    }
    bool extensible;
    if (!mal_vm_is_extensible_object(vm, target, &extensible)) {
        goto invariant_done;
    }
    MalObject *target_seen = mal_intrinsic_new_object(vm);
    invariant_roots[1] = mal_value_from_object(target_seen);
    MalArrayObject *target_keys = mal_value_to_array_object(invariant_roots[0]);
    u32 target_key_count = mal_array_object_length(target_keys);
    for (u32 i = 0; i < target_key_count; i++) {
        MalValue target_key_value;
        mal_array_object_dense_get(target_keys, i, &target_key_value);
        MalKey target_key;
        if (!mal_vm_value_to_property_key(vm, target_key_value, &target_key)) {
            goto invariant_done;
        }
        mal_object_define_own(target_seen, target_key, &marker);

        bool target_present;
        MalPropertyDesc target_desc;
        if (!mal_vm_get_own_property(
                vm, target, target_key, &target_present, &target_desc)) {
            goto invariant_done;
        }
        bool in_result = mal_object_get_own(seen, target_key).present;
        if (target_present && !(target_desc.flags & MAL_PROPERTY_CONFIGURABLE) &&
            !in_result) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy ownKeys trap omitted a non-configurable target key");
            goto invariant_done;
        }
        if (!extensible && !in_result) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy ownKeys trap omitted a key of a non-extensible target");
            goto invariant_done;
        }
    }

    if (!extensible) {
        u32 result_count = mal_array_object_length(keys);
        for (u32 i = 0; i < result_count; i++) {
            MalValue result_key_value;
            mal_array_object_dense_get(keys, i, &result_key_value);
            MalKey result_key;
            if (!mal_vm_value_to_property_key(vm, result_key_value, &result_key)) {
                goto invariant_done;
            }
            if (!mal_object_get_own(target_seen, result_key).present) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "proxy ownKeys trap returned an extra key for a non-extensible target");
                goto invariant_done;
            }
        }
    }
    ok = true;

invariant_done:
    mal_gc_unroot(&invariant_span);
    return ok;
}

// ---- getPrototypeOf -------------------------------------------------------

bool mal_proxy_get_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue *out) {
    *out = mal_value_new_null();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, MAL_HOT_KEY_PROXY_GET_PROTOTYPE_OF, &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(proxy->target)) {
            return mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(proxy->target), out);
        }
        MalObject *proto = mal_object_get_prototype(mal_value_to_object(proxy->target));
        *out = proto != nullptr ? mal_value_from_object(proto) : mal_value_new_null();
        return true;
    }

    MalValue args[1] = {proxy->target};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    MalValue result = completion.value;
    if (!mal_value_is_object(result) && !mal_value_is_null(result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getPrototypeOf trap must return an object or null");
        return false;
    }

    // Invariant: for a non-extensible (non-proxy) target the reported prototype
    // must equal the target's actual prototype.
    if (!mal_value_is_proxy_object(proxy->target) && !mal_object_is_extensible(mal_value_to_object(proxy->target))) {
        MalObject *proto = mal_object_get_prototype(mal_value_to_object(proxy->target));
        MalValue actual = proto != nullptr ? mal_value_from_object(proto) : mal_value_new_null();
        if (!mal_proxy_same_value(result, actual)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getPrototypeOf trap returned a different prototype for a non-extensible target");
            return false;
        }
    }

    *out = result;
    return true;
}

// ---- setPrototypeOf -------------------------------------------------------

static bool mal_proxy_set_prototype_of_snapshot(
    MalVm *vm, MalValue target, MalValue handler, MalValue proto,
    bool *success_out) {
    MalValue trap;
    if (!mal_proxy_get_trap_from_handler(
            vm, handler, MAL_HOT_KEY_PROXY_SET_PROTOTYPE_OF, &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(target)) {
            return mal_proxy_set_prototype_of(
                vm, mal_value_to_proxy_object(target), proto, success_out);
        }
        MalObject *proto_object = mal_value_is_object(proto) ? mal_value_to_object(proto) : nullptr;
        MalObject *target_object = mal_value_to_object(target);
        *success_out = mal_object_set_prototype(target_object, proto_object);
        if (!*success_out && mal_object_is_locked_primordial(target_object)) {
            mal_primordials_throw_mutation(
                vm, "Cannot set prototype of locked primordial");
            return false;
        }
        return true;
    }

    MalValue call_roots[3] = {trap, target, proto};
    MalRootSpan call_span;
    mal_gc_root(&call_span, call_roots, 3);
    MalCompletion completion = mal_vm_call_value(
        vm, call_roots[0], handler, &call_roots[1], 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        mal_gc_unroot(&call_span);
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);
    mal_gc_unroot(&call_span);
    if (!result) {
        return true;
    }

    bool extensible;
    if (!mal_vm_is_extensible_object(vm, target, &extensible)) {
        return false;
    }
    if (extensible) {
        *success_out = true;
        return true;
    }

    MalValue target_proto;
    if (mal_value_is_proxy_object(target)) {
        if (!mal_proxy_get_prototype_of(
                vm, mal_value_to_proxy_object(target), &target_proto)) {
            return false;
        }
    } else {
        MalObject *current = mal_object_get_prototype(mal_value_to_object(target));
        target_proto = current != nullptr
            ? mal_value_from_object(current)
            : mal_value_new_null();
    }
    if (!mal_proxy_same_value(proto, target_proto)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "proxy setPrototypeOf trap changed the prototype of a non-extensible target");
        return false;
    }

    *success_out = true;
    return true;
}

bool mal_proxy_set_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue proto, bool *success_out) {
    *success_out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[3] = {proxy->target, proxy->handler, proto};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 3);
    bool ok = mal_proxy_set_prototype_of_snapshot(
        vm, roots[0], roots[1], roots[2], success_out);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- isExtensible ---------------------------------------------------------

static bool mal_proxy_is_extensible_snapshot(
    MalVm *vm, MalValue target, MalValue handler, bool *out) {
    MalValue trap;
    if (!mal_proxy_get_trap_from_handler(
            vm, handler, MAL_HOT_KEY_PROXY_IS_EXTENSIBLE, &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(target)) {
            return mal_proxy_is_extensible(vm, mal_value_to_proxy_object(target), out);
        }
        *out = mal_object_is_extensible(mal_value_to_object(target));
        return true;
    }

    MalValue args[1] = {target};
    MalCompletion completion = mal_vm_call_value(vm, trap, handler, args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);

    // Invariant: trap result must match the target's actual extensibility.
    bool target_extensible;
    if (mal_value_is_proxy_object(target)) {
        if (!mal_proxy_is_extensible(vm, mal_value_to_proxy_object(target), &target_extensible)) {
            return false;
        }
    } else {
        target_extensible = mal_object_is_extensible(mal_value_to_object(target));
    }
    if (result != target_extensible) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy isExtensible trap result does not match the target's extensibility");
        return false;
    }

    *out = result;
    return true;
}

bool mal_proxy_is_extensible(MalVm *vm, MalProxyObject *proxy, bool *out) {
    *out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[2] = {proxy->target, proxy->handler};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    bool ok = mal_proxy_is_extensible_snapshot(vm, roots[0], roots[1], out);
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- preventExtensions ----------------------------------------------------

bool mal_proxy_prevent_extensions(MalVm *vm, MalProxyObject *proxy, bool *out) {
    *out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    if (!mal_proxy_dispatch_enter(vm)) {
        return false;
    }
    MalValue roots[3] = {
        proxy->target, proxy->handler, mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 3);
    bool ok = false;
    if (!mal_proxy_get_trap_from_handler(
            vm, roots[1], MAL_HOT_KEY_PROXY_PREVENT_EXTENSIONS, &roots[2])) {
        goto done;
    }
    if (mal_value_is_undefined(roots[2])) {
        if (mal_value_is_proxy_object(roots[0])) {
            ok = mal_proxy_prevent_extensions(
                vm, mal_value_to_proxy_object(roots[0]), out);
        } else {
            mal_object_set_extensible(mal_value_to_object(roots[0]), false);
            *out = true;
            ok = true;
        }
        goto done;
    }

    MalValue args[1] = {roots[0]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[2], roots[1], args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        goto done;
    }
    *out = mal_value_is_truthy(completion.value);
    if (*out) {
        bool target_extensible;
        if (!mal_vm_is_extensible_object(vm, roots[0], &target_extensible)) {
            goto done;
        }
        if (target_extensible) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "proxy preventExtensions trap reported success but the target is still extensible");
            goto done;
        }
    }
    ok = true;

done:
    mal_gc_unroot(&roots_span);
    mal_proxy_dispatch_leave(vm);
    return ok;
}

// ---- apply / construct ----------------------------------------------------

// Set a TypeError and return it as a throw completion. vm->completion is LEFT
// set to the throw (mal_vm_call_value's contract: the throw stays pending so the
// compiled CALL/CONSTRUCT site and the dispatchers observe it).
static MalCompletion mal_proxy_throw_completion(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
    return vm->completion;
}

// Pack arguments into a fresh Array (the argList passed to apply/construct traps).
static MalValue mal_proxy_args_array(MalVm *vm, const MalValue *args, i32 arg_count) {
    u32 count = (u32) arg_count;
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, count);
    (void) mal_array_object_dense_build_values(array, 0, args, count);
    return mal_value_from_array_object(array);
}

MalCompletion mal_proxy_apply(MalVm *vm, MalProxyObject *proxy, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return vm->completion;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, MAL_HOT_KEY_PROXY_APPLY, &trap)) {
        return vm->completion;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_call_value(vm, proxy->target, this_value, args, arg_count);
    }

    MalValue trap_args[3] = {proxy->target, this_value, mal_proxy_args_array(vm, args, arg_count)};
    return mal_vm_call_value(vm, trap, proxy->handler, trap_args, 3);
}

MalCompletion mal_proxy_construct(MalVm *vm, MalProxyObject *proxy, const MalValue *args, i32 arg_count, MalValue new_target) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return vm->completion;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, MAL_HOT_KEY_PROXY_CONSTRUCT, &trap)) {
        return vm->completion;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_construct_value_with_target(vm, proxy->target, args, arg_count, new_target);
    }

    MalValue trap_args[3] = {proxy->target, mal_proxy_args_array(vm, args, arg_count), new_target};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, trap_args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return completion;
    }
    // Invariant: the construct trap must return an object.
    if (!mal_value_is_object(completion.value)) {
        return mal_proxy_throw_completion(vm, "proxy construct trap must return an object");
    }
    return completion;
}
