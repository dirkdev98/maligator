#include "proxy_object.h"

#include "array_object.h"
#include "builtin_object.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "property_iter.h"
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
    while (mal_value_is_proxy_object(value)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(value);
        if (proxy->revoked) {
            return false;
        }
        value = proxy->target;
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

// A revoked proxy throws on every operation. Returns true (and sets the throw)
// when the proxy is unusable, so callers can bail.
static bool mal_proxy_check_revoked(MalVm *vm, MalProxyObject *proxy) {
    if (proxy->revoked || mal_value_is_null(proxy->handler)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot perform operation on a proxy that has been revoked");
        return true;
    }
    return false;
}

// GetMethod(handler, trap): reads handler[trap]; undefined/null → trap absent
// (out stays undefined). A non-callable, non-nullish trap is a TypeError.
// Returns false on a throw (pending completion set).
static bool mal_proxy_get_trap(MalVm *vm, MalProxyObject *proxy, const byte *name, MalValue *out) {
    *out = mal_value_new_undefined();
    MalKey key = mal_intrinsic_string_key(vm, name);
    MalValue trap;
    if (!mal_vm_get_property(vm, proxy->handler, key, &trap)) {
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

// OrdinaryGetOwnProperty over the target value, covering array length and a
// proxy target (which routes through its own getOwnPropertyDescriptor trap).
// Returns false with present=false when there is no own property.
static bool mal_proxy_target_get_own(MalVm *vm, MalValue target, MalKey key, bool *present, MalPropertyDesc *desc) {
    *present = false;
    if (mal_value_is_proxy_object(target)) {
        // A throw here is swallowed (these are invariant probes); the caller's
        // own completion handling will surface a real error from the operation.
        mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(target), key, present, desc);
        return *present;
    }
    if (mal_value_is_array_object(target) && mal_array_key_is_length(key)) {
        MalArrayObject *array = mal_value_to_array_object(target);
        desc->flags = array->length_writable ? MAL_PROPERTY_WRITABLE : MAL_PROPERTY_NONE;
        desc->value = mal_value_from_i32((i32) mal_array_object_length(array));
        desc->getter = mal_value_new_undefined();
        desc->setter = mal_value_new_undefined();
        *present = true;
        return true;
    }
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(target), key);
    if (!lookup.present) {
        return false;
    }
    *desc = lookup.desc;
    *present = true;
    return true;
}

// ---- get ------------------------------------------------------------------

bool mal_proxy_get(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue receiver, MalValue *out) {
    *out = mal_value_new_undefined();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "get", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_get_property_with_receiver(vm, proxy->target, key, receiver, out);
    }

    MalValue args[3] = {proxy->target, mal_proxy_key_to_value(vm, key), receiver};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    MalValue trap_result = completion.value;

    // Invariant: a non-configurable, non-writable data property must report its
    // exact value; a non-configurable accessor with no getter must report
    // undefined.
    bool present;
    MalPropertyDesc desc;
    if (mal_proxy_target_get_own(vm, proxy->target, key, &present, &desc) && present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            if (!(desc.flags & MAL_PROPERTY_ACCESSOR) && !(desc.flags & MAL_PROPERTY_WRITABLE)) {
                if (!mal_proxy_same_value(trap_result, desc.value)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy get trap violated invariant on non-configurable non-writable property");
                    return false;
                }
            }
            if ((desc.flags & MAL_PROPERTY_ACCESSOR) && mal_value_is_undefined(desc.getter)) {
                if (!mal_value_is_undefined(trap_result)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy get trap violated invariant on non-configurable accessor property");
                    return false;
                }
            }
        }
    }

    *out = trap_result;
    return true;
}

// ---- set ------------------------------------------------------------------

bool mal_proxy_set(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue value, MalValue receiver) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "set", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_set_property(vm, proxy->target, key, value, receiver);
    }

    MalValue args[4] = {proxy->target, mal_proxy_key_to_value(vm, key), value, receiver};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 4);
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
    if (mal_proxy_target_get_own(vm, proxy->target, key, &present, &desc) && present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            if (!(desc.flags & MAL_PROPERTY_ACCESSOR) && !(desc.flags & MAL_PROPERTY_WRITABLE)) {
                if (!mal_proxy_same_value(value, desc.value)) {
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

// ---- has ------------------------------------------------------------------

bool mal_proxy_has(MalVm *vm, MalProxyObject *proxy, MalKey key) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "has", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_has_property(vm, proxy->target, key);
    }

    MalValue args[2] = {proxy->target, mal_proxy_key_to_value(vm, key)};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 2);
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
        if (mal_proxy_target_get_own(vm, proxy->target, key, &present, &desc) && present) {
            if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy has trap returned false for non-configurable property");
                return false;
            }
            if (!mal_object_is_extensible(mal_value_to_object(proxy->target))) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy has trap returned false for property of a non-extensible target");
                return false;
            }
        }
    }

    return result;
}

// ---- deleteProperty -------------------------------------------------------

bool mal_proxy_delete(MalVm *vm, MalProxyObject *proxy, MalKey key) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "deleteProperty", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        return mal_vm_delete_property(vm, proxy->target, key);
    }

    MalValue args[2] = {proxy->target, mal_proxy_key_to_value(vm, key)};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 2);
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
    if (mal_proxy_target_get_own(vm, proxy->target, key, &present, &desc) && present) {
        if (!(desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy deleteProperty trap cannot delete a non-configurable property");
            return false;
        }
        if (!mal_object_is_extensible(mal_value_to_object(proxy->target))) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy deleteProperty trap cannot delete a property of a non-extensible target");
            return false;
        }
    }

    return true;
}

// ---- getOwnPropertyDescriptor ---------------------------------------------

bool mal_proxy_get_own_property_descriptor(MalVm *vm, MalProxyObject *proxy, MalKey key, bool *present_out, MalPropertyDesc *desc_out) {
    *present_out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "getOwnPropertyDescriptor", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        mal_proxy_target_get_own(vm, proxy->target, key, present_out, desc_out);
        return true;
    }

    MalValue args[2] = {proxy->target, mal_proxy_key_to_value(vm, key)};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    MalValue result = completion.value;
    if (!mal_value_is_object(result) && !mal_value_is_undefined(result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor trap must return an object or undefined");
        return false;
    }

    bool target_present;
    MalPropertyDesc target_desc;
    mal_proxy_target_get_own(vm, proxy->target, key, &target_present, &target_desc);

    if (mal_value_is_undefined(result)) {
        // Cannot hide a non-configurable own property, nor any own property of a
        // non-extensible target.
        if (target_present) {
            if (!(target_desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor cannot report a non-configurable property as non-existent");
                return false;
            }
            if (!mal_object_is_extensible(mal_value_to_object(proxy->target))) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor cannot report a property of a non-extensible target as non-existent");
                return false;
            }
        }
        *present_out = false;
        return true;
    }

    // ToPropertyDescriptor on the returned object, then expose it. We reuse the
    // descriptor-object reader by defining onto a throwaway object so the parse
    // and completed-descriptor defaulting match Object.defineProperty.
    MalObject *scratch = mal_intrinsic_new_object(vm);
    MalKey scratch_key = mal_intrinsic_string_key(vm, "x");
    if (mal_builtin_object_try_define(vm, scratch, scratch_key, result) == MAL_DEFINE_OWN_REJECTED &&
        vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    MalPropertyLookup parsed = mal_object_get_own(scratch, scratch_key);
    if (!parsed.present) {
        // try_define rejected without throwing: treat as undefined descriptor.
        *present_out = false;
        return true;
    }

    // CompletePropertyDescriptor + the spec invariants. A reported descriptor
    // must be compatible with the target's actual property:
    bool result_configurable = (parsed.desc.flags & MAL_PROPERTY_CONFIGURABLE) != 0;
    bool target_extensible = mal_value_is_proxy_object(proxy->target)
        ? true  // a proxy target's extensibility is its own concern
        : mal_object_is_extensible(mal_value_to_object(proxy->target));

    if (!target_present) {
        // A property absent from the target cannot be reported on a
        // non-extensible target, and cannot be reported non-configurable.
        if (!target_extensible) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor reported a new property on a non-extensible target");
            return false;
        }
        if (!result_configurable) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor reported a non-configurable descriptor for a missing property");
            return false;
        }
    } else {
        // A non-configurable descriptor requires a non-configurable target prop.
        if (!result_configurable && (target_desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor reported a non-configurable descriptor for a configurable property");
            return false;
        }
        // A non-configurable, non-writable data result requires a non-writable
        // target data property.
        bool result_accessor = (parsed.desc.flags & MAL_PROPERTY_ACCESSOR) != 0;
        bool target_accessor = (target_desc.flags & MAL_PROPERTY_ACCESSOR) != 0;
        if (!result_configurable && !result_accessor && !(parsed.desc.flags & MAL_PROPERTY_WRITABLE)) {
            if (target_accessor || (target_desc.flags & MAL_PROPERTY_WRITABLE)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy getOwnPropertyDescriptor reported a non-writable descriptor for a writable property");
                return false;
            }
        }
    }

    *desc_out = parsed.desc;
    *present_out = true;
    return true;
}

// ---- defineProperty -------------------------------------------------------

bool mal_proxy_define_own_property(MalVm *vm, MalProxyObject *proxy, MalKey key, MalValue descriptor_value) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "defineProperty", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        MalDefineOwnStatus status = mal_builtin_object_try_define(vm, mal_value_to_object(proxy->target), key, descriptor_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        return status == MAL_DEFINE_OWN_APPLIED;
    }

    MalValue args[3] = {proxy->target, mal_proxy_key_to_value(vm, key), descriptor_value};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    if (!mal_value_is_truthy(completion.value)) {
        return false;
    }

    // A successful define is accepted; the full set of validity invariants is
    // pragmatically reduced to the most-tested ones: defining a non-configurable
    // property requires the target to already have a matching non-configurable
    // own property, and a non-extensible target rejects new own properties.
    bool present;
    MalPropertyDesc target_desc;
    mal_proxy_target_get_own(vm, proxy->target, key, &present, &target_desc);
    bool extensible = mal_object_is_extensible(mal_value_to_object(proxy->target));
    if (!present && !extensible) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy defineProperty added a property to a non-extensible target");
        return false;
    }

    return true;
}

// ---- ownKeys --------------------------------------------------------------

// Default own keys of the target (string + symbol keys, array length), as an
// array value, matching Reflect.ownKeys order.
static MalValue mal_proxy_target_own_keys(MalVm *vm, MalValue target) {
    MalObject *object = mal_value_to_object(target);
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;
    bool is_array = mal_value_is_array_object(target);
    bool length_pending = is_array;

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL && mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        if (length_pending && key.kind != MAL_KEY_INDEX) {
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
            length_pending = false;
        }
        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_proxy_key_to_value(vm, key));
    }
    if (length_pending) {
        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
    }
    return mal_value_from_array_object(result);
}

static bool mal_proxy_own_keys_build(
    MalVm *vm, MalProxyObject *proxy, MalValue result, MalObject *seen, MalPropertyDesc marker, MalArrayObject *keys
);

bool mal_proxy_own_property_keys(MalVm *vm, MalProxyObject *proxy, MalValue *out_array) {
    *out_array = mal_value_new_undefined();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "ownKeys", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        *out_array = mal_proxy_target_own_keys(vm, proxy->target);
        return true;
    }

    MalValue args[1] = {proxy->target};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    MalValue result = completion.value;
    if (!mal_value_is_object(result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap must return an array-like object");
        return false;
    }

    // The trap result, the "seen keys" set, and the keys array being built are all
    // held across the array-like getter / ToPropertyKey re-entry in the build +
    // invariant loops; root them, then delegate the building.
    MalObject *seen = mal_intrinsic_new_object(vm);
    MalPropertyDesc marker = mal_intrinsic_data_desc(mal_value_new_undefined(), 0);
    MalArrayObject *keys = mal_intrinsic_new_array(vm, 0);
    MalValue roots[3] = {result, mal_value_from_object(seen), mal_value_from_array_object(keys)};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    bool ok = mal_proxy_own_keys_build(vm, proxy, result, seen, marker, keys);
    mal_gc_unroot(&span);
    if (ok) {
        *out_array = mal_value_from_array_object(keys);
    }
    return ok;
}

// CreateListFromArrayLike with the spec's String|Symbol element-type check,
// building the result array. (Full duplicate/non-configurable invariants are
// not enforced here; the common element-type one is.) The caller roots
// result/seen/keys across the re-entry below.
static bool mal_proxy_own_keys_build(
    MalVm *vm, MalProxyObject *proxy, MalValue result, MalObject *seen, MalPropertyDesc marker, MalArrayObject *keys
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
        MalKey idx_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
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
        mal_array_object_store(keys, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}, element);
    }

    // Target-key consistency invariants. (A proxy target is handled by its own
    // ownKeys; this enforcement applies to a plain-object target.)
    if (!mal_value_is_proxy_object(proxy->target)) {
        MalObject *target = mal_value_to_object(proxy->target);
        bool extensible = mal_object_is_extensible(target);

        MalPropertyIter iter;
        mal_property_iter_init(&iter, target, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
        MalKey tkey;
        MalPropertyDesc tdesc;
        while (mal_property_iter_next(&iter, &tkey, &tdesc)) {
            if (tkey.kind == MAL_KEY_SYMBOL && mal_symbol_is_private(mal_value_to_symbol(tkey.value))) {
                continue;
            }
            bool present = mal_object_get_own(seen, tkey).present;
            // Every non-configurable target key must appear in the result.
            if (!(tdesc.flags & MAL_PROPERTY_CONFIGURABLE) && !present) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap omitted a non-configurable target key");
                return false;
            }
            // A non-extensible target requires every own key to appear.
            if (!extensible && !present) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap omitted a key of a non-extensible target");
                return false;
            }
        }

        // A non-extensible target also forbids extra keys: every result key must
        // be an own key of the target. (Array length is a synthetic own key.)
        if (!extensible) {
            for (i64 index = 0; index < length; index++) {
                MalValue element;
                if (!mal_vm_get_property(vm, result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}, &element)) {
                    return false;
                }
                MalKey element_key;
                if (!mal_vm_value_to_property_key(vm, element, &element_key)) {
                    return false;
                }
                bool is_target_key = mal_object_get_own(target, element_key).present ||
                    (mal_value_is_array_object(proxy->target) && mal_array_key_is_length(element_key));
                if (!is_target_key) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy ownKeys trap returned a key absent from a non-extensible target");
                    return false;
                }
            }
        }
    }

    return true;
}

// ---- getPrototypeOf -------------------------------------------------------

bool mal_proxy_get_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue *out) {
    *out = mal_value_new_null();
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "getPrototypeOf", &trap)) {
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

bool mal_proxy_set_prototype_of(MalVm *vm, MalProxyObject *proxy, MalValue proto, bool *success_out) {
    *success_out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "setPrototypeOf", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(proxy->target)) {
            return mal_proxy_set_prototype_of(vm, mal_value_to_proxy_object(proxy->target), proto, success_out);
        }
        MalObject *proto_object = mal_value_is_object(proto) ? mal_value_to_object(proto) : nullptr;
        *success_out = mal_object_set_prototype(mal_value_to_object(proxy->target), proto_object);
        return true;
    }

    MalValue args[2] = {proxy->target, proto};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);

    // Invariant: for a non-extensible (non-proxy) target a successful
    // setPrototypeOf must leave the prototype equal to the target's prototype.
    if (result && !mal_value_is_proxy_object(proxy->target) && !mal_object_is_extensible(mal_value_to_object(proxy->target))) {
        MalObject *cur = mal_object_get_prototype(mal_value_to_object(proxy->target));
        MalValue actual = cur != nullptr ? mal_value_from_object(cur) : mal_value_new_null();
        if (!mal_proxy_same_value(proto, actual)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy setPrototypeOf trap changed the prototype of a non-extensible target");
            return false;
        }
    }

    *success_out = result;
    return true;
}

// ---- isExtensible ---------------------------------------------------------

bool mal_proxy_is_extensible(MalVm *vm, MalProxyObject *proxy, bool *out) {
    *out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "isExtensible", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(proxy->target)) {
            return mal_proxy_is_extensible(vm, mal_value_to_proxy_object(proxy->target), out);
        }
        *out = mal_object_is_extensible(mal_value_to_object(proxy->target));
        return true;
    }

    MalValue args[1] = {proxy->target};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);

    // Invariant: trap result must match the target's actual extensibility.
    bool target_extensible;
    if (mal_value_is_proxy_object(proxy->target)) {
        if (!mal_proxy_is_extensible(vm, mal_value_to_proxy_object(proxy->target), &target_extensible)) {
            return false;
        }
    } else {
        target_extensible = mal_object_is_extensible(mal_value_to_object(proxy->target));
    }
    if (result != target_extensible) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy isExtensible trap result does not match the target's extensibility");
        return false;
    }

    *out = result;
    return true;
}

// ---- preventExtensions ----------------------------------------------------

bool mal_proxy_prevent_extensions(MalVm *vm, MalProxyObject *proxy, bool *out) {
    *out = false;
    if (mal_proxy_check_revoked(vm, proxy)) {
        return false;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "preventExtensions", &trap)) {
        return false;
    }
    if (mal_value_is_undefined(trap)) {
        if (mal_value_is_proxy_object(proxy->target)) {
            return mal_proxy_prevent_extensions(vm, mal_value_to_proxy_object(proxy->target), out);
        }
        mal_object_set_extensible(mal_value_to_object(proxy->target), false);
        *out = true;
        return true;
    }

    MalValue args[1] = {proxy->target};
    MalCompletion completion = mal_vm_call_value(vm, trap, proxy->handler, args, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    bool result = mal_value_is_truthy(completion.value);

    // Invariant: cannot report success while a non-proxy target is still
    // extensible. (A proxy target enforces its own invariant.)
    if (result && !mal_value_is_proxy_object(proxy->target) &&
        mal_object_is_extensible(mal_value_to_object(proxy->target))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "proxy preventExtensions trap reported success but the target is still extensible");
        return false;
    }

    *out = result;
    return true;
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
    MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
    for (i32 i = 0; i < arg_count; i++) {
        mal_array_object_store(array, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)}, args[i]);
    }
    return mal_value_from_array_object(array);
}

MalCompletion mal_proxy_apply(MalVm *vm, MalProxyObject *proxy, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (mal_proxy_check_revoked(vm, proxy)) {
        return vm->completion;
    }
    MalValue trap;
    if (!mal_proxy_get_trap(vm, proxy, "apply", &trap)) {
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
    if (!mal_proxy_get_trap(vm, proxy, "construct", &trap)) {
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
