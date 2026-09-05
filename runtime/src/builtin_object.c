#include "builtin_object.h"

#include "array_object.h"
#include "builtin_error.h"
#include "arguments_object.h"
#include "builtin_iterator.h"
#include "checked_size.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "module_namespace_object.h"
#include "primitive_wrapper_object.h"
#include "primordials.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "rooted_collection.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_builtin_object_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

static MalObject *mal_builtin_object_receiver_holder(MalVm *vm, MalValue this_value);

static bool mal_builtin_object_descriptor_field(
    MalVm *vm, MalValue descriptor, const byte *name, bool *present_out, MalValue *value_out) {
    MalKey key = mal_intrinsic_string_key(vm, name);
    bool present = mal_vm_has_property(vm, descriptor, key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    *present_out = present;
    return !present || mal_vm_get_property(vm, descriptor, key, value_out);
}

bool mal_builtin_object_to_property_descriptor(
    MalVm *vm, MalValue descriptor, MalPropertyDescriptorParse *out) {
    if (!mal_value_is_object(descriptor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Property description must be an object");
        return false;
    }

    *out = (MalPropertyDescriptorParse) {
        .desc = mal_intrinsic_data_desc(mal_value_new_undefined(), MAL_PROPERTY_NONE),
    };
    MalValue roots[5] = {
        descriptor,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 5);

    bool ok = false;
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "enumerable", &out->has_enumerable, &roots[1])) {
        goto done;
    }
    if (out->has_enumerable && mal_value_is_truthy(roots[1])) {
        out->desc.flags |= MAL_PROPERTY_ENUMERABLE;
    }
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "configurable", &out->has_configurable, &roots[1])) {
        goto done;
    }
    if (out->has_configurable && mal_value_is_truthy(roots[1])) {
        out->desc.flags |= MAL_PROPERTY_CONFIGURABLE;
    }
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "value", &out->has_value, &roots[2])) {
        goto done;
    }
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "writable", &out->has_writable, &roots[1])) {
        goto done;
    }
    if (out->has_writable && mal_value_is_truthy(roots[1])) {
        out->desc.flags |= MAL_PROPERTY_WRITABLE;
    }
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "get", &out->has_get, &roots[3])) {
        goto done;
    }
    if (out->has_get && !mal_value_is_callable(roots[3]) && !mal_value_is_undefined(roots[3])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Getter must be a function");
        goto done;
    }
    if (!mal_builtin_object_descriptor_field(
            vm, roots[0], "set", &out->has_set, &roots[4])) {
        goto done;
    }
    if (out->has_set && !mal_value_is_callable(roots[4]) && !mal_value_is_undefined(roots[4])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Setter must be a function");
        goto done;
    }
    if ((out->has_value || out->has_writable) && (out->has_get || out->has_set)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Property descriptors must not mix data and accessor fields");
        goto done;
    }

    out->desc.value = roots[2];
    out->desc.getter = roots[3];
    out->desc.setter = roots[4];
    if (out->has_get || out->has_set) {
        out->desc.flags |= MAL_PROPERTY_ACCESSOR;
    }
    ok = true;

done:
    mal_gc_unroot(&roots_span);
    return ok;
}

static MalDefineOwnStatus mal_builtin_object_try_define_parsed_impl(
    MalVm *vm, MalObject *target, MalKey key,
    const MalPropertyDescriptorParse *parsed) {
    MalPropertyDescriptorParse parse = *parsed;
    MalArgumentsObject *mapped_arguments = nullptr;
    i32 mapped_slot = -1;
    if (mal_object_is_mapped_arguments(target)) {
        mapped_arguments = (MalArgumentsObject *) target;
        mapped_slot = mal_arguments_object_mapped_slot(mapped_arguments, key);
        if (mapped_slot >= 0) {
            if (!parse.has_value && parse.has_writable &&
                !(parse.desc.flags & MAL_PROPERTY_WRITABLE)) {
                parse.has_value = true;
                parse.desc.value = mapped_arguments->env->slots[mapped_slot];
            }
        }
    }
    // String exotic [[DefineOwnProperty]]: an index/length own property is not
    // in the table. It is non-configurable (and non-writable), so the only
    // permitted redefinition is one compatible with the current exotic
    // descriptor (IsCompatiblePropertyDescriptor with extensible=false). A
    // compatible request is a no-op; an incompatible one is rejected.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, target, key, &string_exotic)) {
        bool current_enumerable = (string_exotic.flags & MAL_PROPERTY_ENUMERABLE) != 0;
        if (parse.has_configurable && (parse.desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        if (parse.has_enumerable && ((parse.desc.flags & MAL_PROPERTY_ENUMERABLE) != 0) != current_enumerable) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        // The current descriptor is a non-writable data property: an accessor
        // request, a writable upgrade, or a different value is incompatible.
        if (parse.has_get || parse.has_set) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        if (parse.has_writable && (parse.desc.flags & MAL_PROPERTY_WRITABLE)) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        if (parse.has_value &&
            !mal_value_is_truthy(mal_ops_strict_equal(parse.desc.value, string_exotic.value))) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        return MAL_DEFINE_OWN_APPLIED;
    }

    if (target->header.type == MAL_HEAP_ARRAY_OBJECT && mal_array_key_is_length(key)) {
        // ArraySetLength (10.4.2.4): length lives in the array header, not the
        // property table. It is non-configurable, non-enumerable, and its
        // writability downgrade is one-way.
        MalArrayObject *array = (MalArrayObject *) target;

        // A new value is validated first: ToUint32 must round-trip ToNumber (a
        // fractional, negative, NaN or >= 2^32 length is a RangeError); ToNumber
        // runs the value's user coercion and may throw.
        u32 new_length = 0;
        if (parse.has_value) {
            f64 uint32_number;
            if (!mal_vm_to_number(vm, parse.desc.value, &uint32_number)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            new_length = mal_ops_number_to_uint32(uint32_number);
            f64 number_length;
            if (!mal_vm_to_number(vm, parse.desc.value, &number_length)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            if ((f64) new_length != number_length) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
                return MAL_DEFINE_OWN_REJECTED;
            }
        }

        bool upgrades_writable =
            !array->length_writable && parse.has_writable && (parse.desc.flags & MAL_PROPERTY_WRITABLE);
        if (parse.has_get || parse.has_set ||
            (parse.has_enumerable && (parse.desc.flags & MAL_PROPERTY_ENUMERABLE)) ||
            (parse.has_configurable && (parse.desc.flags & MAL_PROPERTY_CONFIGURABLE)) ||
            upgrades_writable) {
            return MAL_DEFINE_OWN_REJECTED;
        }

        if (parse.has_value) {
            // A non-writable length only accepts its current value.
            if (!array->length_writable && new_length != mal_array_object_length(array)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            mal_array_object_set_length(array, new_length);
            // A non-configurable element can block the shrink: length is left at
            // that element + 1, the writability downgrade still applies, then the
            // operation reports failure.
            if (mal_array_object_length(array) != new_length) {
                if (parse.has_writable && !(parse.desc.flags & MAL_PROPERTY_WRITABLE)) {
                    array->length_writable = false;
                }
                return MAL_DEFINE_OWN_REJECTED;
            }
        }

        if (parse.has_writable && !(parse.desc.flags & MAL_PROPERTY_WRITABLE)) {
            array->length_writable = false;
        }
        return MAL_DEFINE_OWN_APPLIED;
    }

    // TypedArray [[DefineOwnProperty]] for an integer index (10.4.5.3): an
    // out-of-bounds index is rejected. Immutable-buffer elements are fixed data
    // properties; mutable-buffer elements accept only the standard writable,
    // enumerable, configurable descriptor and write [[Value]] to the buffer.
    if (target->header.type == MAL_HEAP_TYPED_ARRAY_OBJECT) {
        MalTypedArrayObject *typed_array = (MalTypedArrayObject *) target;
        if (key.kind == MAL_KEY_INDEX) {
            u32 index = mal_key_index_value(key);
            if (index >= mal_typed_array_object_length(typed_array)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            if (typed_array->buffer->immutable) {
                if (parse.has_get || parse.has_set ||
                    (parse.has_configurable && (parse.desc.flags & MAL_PROPERTY_CONFIGURABLE)) ||
                    (parse.has_enumerable && !(parse.desc.flags & MAL_PROPERTY_ENUMERABLE)) ||
                    (parse.has_writable && (parse.desc.flags & MAL_PROPERTY_WRITABLE)) ||
                    (parse.has_value && !mal_ops_same_value(
                        parse.desc.value, mal_typed_array_object_get(vm, typed_array, index)))) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
                return MAL_DEFINE_OWN_APPLIED;
            }
            if (parse.has_get || parse.has_set ||
                (parse.has_configurable && !(parse.desc.flags & MAL_PROPERTY_CONFIGURABLE)) ||
                (parse.has_enumerable && !(parse.desc.flags & MAL_PROPERTY_ENUMERABLE)) ||
                (parse.has_writable && !(parse.desc.flags & MAL_PROPERTY_WRITABLE))) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            if (parse.has_value) {
                mal_typed_array_object_set(vm, typed_array, index, parse.desc.value);
            }
            return MAL_DEFINE_OWN_APPLIED;
        }
        // A canonical-numeric string key (e.g. "-1", "1.5", "-0", "NaN") is an
        // integer-index key; since it is not a valid in-bounds index here, the
        // exotic [[DefineOwnProperty]] rejects it rather than creating a table slot.
        if (key.kind == MAL_KEY_STRING &&
            mal_vm_string_is_canonical_numeric_index(vm, mal_value_to_string(key.value))) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        // Any other (ordinary) key falls through to the generic define below.
    }

    // Merge fields the descriptor left out from the current descriptor, so
    // partial updates keep the unmentioned attributes.
    MalPropertyDesc desc = parse.desc;
    MalPropertyLookup existing = mal_object_get_own(target, key);
    if (existing.present) {
        bool existing_accessor = (existing.desc.flags & MAL_PROPERTY_ACCESSOR) != 0;
        if (parse.has_get || parse.has_set) {
            if (existing_accessor) {
                if (!parse.has_get) {
                    desc.getter = existing.desc.getter;
                }
                if (!parse.has_set) {
                    desc.setter = existing.desc.setter;
                }
            }
        } else if (!parse.has_value && !parse.has_writable && existing_accessor) {
            // A generic descriptor keeps the current kind and slots.
            desc.flags |= MAL_PROPERTY_ACCESSOR;
            desc.getter = existing.desc.getter;
            desc.setter = existing.desc.setter;
        } else if (!existing_accessor) {
            if (!parse.has_value) {
                desc.value = existing.desc.value;
            }
            if (!parse.has_writable && (existing.desc.flags & MAL_PROPERTY_WRITABLE)) {
                desc.flags |= MAL_PROPERTY_WRITABLE;
            }
        }

        if (!parse.has_enumerable && (existing.desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            desc.flags |= MAL_PROPERTY_ENUMERABLE;
        }
        if (!parse.has_configurable && (existing.desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            desc.flags |= MAL_PROPERTY_CONFIGURABLE;
        }
        desc.flags |= existing.desc.flags & MAL_PROPERTY_INTERNAL_FLAGS;
    }

    // Array exotic [[DefineOwnProperty]] for an index (10.4.2.1): defining at or
    // past length grows length — or is rejected outright when length is
    // non-writable. (The bytecode define op handles this on its own path.)
    bool grows_array_length = false;
    if (target->header.type == MAL_HEAP_ARRAY_OBJECT && key.kind == MAL_KEY_INDEX) {
        MalArrayObject *array = (MalArrayObject *) target;
        u32 index = mal_key_index_value(key);
        if (index >= mal_array_object_length(array)) {
            if (!array->length_writable) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            grows_array_length = true;
        }
    }

    MalDefineOwnStatus status = mal_object_define_own(target, key, &desc);
    if (status == MAL_DEFINE_OWN_APPLIED && grows_array_length) {
        mal_array_object_set_length((MalArrayObject *) target, mal_key_index_value(key) + 1);
    }
    if (status == MAL_DEFINE_OWN_APPLIED && mapped_slot >= 0) {
        if (parse.has_value) {
            mal_gc_write_barrier(mapped_arguments->env->slots[mapped_slot]);
            mapped_arguments->env->slots[mapped_slot] = parse.desc.value;
            mal_gc_card(&mapped_arguments->env->header, parse.desc.value);
        }
        if ((parse.desc.flags & MAL_PROPERTY_ACCESSOR) ||
            (parse.has_writable && !(parse.desc.flags & MAL_PROPERTY_WRITABLE))) {
            mal_arguments_object_unmap(mapped_arguments, key);
        }
    }
    return status;
}

MalDefineOwnStatus mal_builtin_object_try_define_parsed(
    MalVm *vm, MalObject *target, MalKey key,
    const MalPropertyDescriptorParse *parsed
) {
    MalPropertyLookup before = mal_object_get_own(target, key);
    MalDefineOwnStatus status =
        mal_builtin_object_try_define_parsed_impl(vm, target, key, parsed);
    if (status == MAL_DEFINE_OWN_REJECTED &&
        (mal_object_is_locked_primordial(target) ||
         (before.present && (before.desc.flags & MAL_PROPERTY_PRIMORDIAL))) &&
        vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_primordials_throw_property_mutation(
            vm, "Cannot define locked primordial property '", key);
    }
    return status;
}

MalDefineOwnStatus mal_builtin_object_try_define(
    MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value) {
    MalPropertyDescriptorParse parsed;
    if (!mal_builtin_object_to_property_descriptor(vm, descriptor_value, &parsed)) {
        return MAL_DEFINE_OWN_REJECTED;
    }
    MalValue roots[5] = {
        mal_value_from_object(target), key.value,
        parsed.desc.value, parsed.desc.getter, parsed.desc.setter,
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 5);
    target = mal_value_to_object(roots[0]);
    key.value = roots[1];
    parsed.desc.value = roots[2];
    parsed.desc.getter = roots[3];
    parsed.desc.setter = roots[4];
    MalDefineOwnStatus status;
    if (target->header.type == MAL_HEAP_MODULE_NAMESPACE_OBJECT) {
        status = mal_builtin_object_define_own_property_parsed(
                     vm, roots[0], key, &parsed)
            ? MAL_DEFINE_OWN_APPLIED
            : MAL_DEFINE_OWN_REJECTED;
    } else {
        status = mal_builtin_object_try_define_parsed(vm, target, key, &parsed);
    }
    mal_gc_unroot(&roots_span);
    return status;
}

bool mal_builtin_object_define_own_property_parsed(
    MalVm *vm, MalValue target, MalKey key,
    const MalPropertyDescriptorParse *parsed
) {
    if (mal_value_is_proxy_object(target)) {
        return mal_proxy_define_own_property_parsed(
            vm, mal_value_to_proxy_object(target), key, parsed);
    }

    bool present = false;
    MalPropertyDesc current = {0};
    // Script functions lazily materialize their non-configurable "prototype"
    // property. Module namespace properties are synthetic descriptors.
    if ((mal_value_is_function_object(target) ||
         mal_value_is_module_namespace_object(target)) &&
        !mal_vm_get_own_property(vm, target, key, &present, &current)) {
        return false;
    }
    if (mal_value_is_module_namespace_object(target)) {
        if (!present ||
            (parsed->has_configurable &&
             (parsed->desc.flags & MAL_PROPERTY_CONFIGURABLE)) ||
            (parsed->has_enumerable &&
             !(parsed->desc.flags & MAL_PROPERTY_ENUMERABLE)) ||
            parsed->has_get || parsed->has_set ||
            (parsed->has_writable &&
             !(parsed->desc.flags & MAL_PROPERTY_WRITABLE))) {
            return false;
        }
        return !parsed->has_value ||
            mal_ops_same_value(parsed->desc.value, current.value);
    }

    MalDefineOwnStatus status = mal_builtin_object_try_define_parsed(
        vm, mal_value_to_object(target), key, parsed);
    return vm->completion.kind != MAL_COMPLETION_THROW &&
        status == MAL_DEFINE_OWN_APPLIED;
}

/**
 * Object.defineProperty / .defineProperties / .create define path: like
 * mal_builtin_object_try_define but a plain rejection (rather than a
 * ToPropertyDescriptor throw) raises the "Cannot redefine property" TypeError.
 */
static void mal_builtin_object_define_from_value(MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value) {
    if (mal_builtin_object_try_define(vm, target, key, descriptor_value) == MAL_DEFINE_OWN_REJECTED &&
        vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot redefine property");
    }
}

static bool mal_builtin_object_define_value(
    MalVm *vm, MalValue target, MalKey key, MalValue descriptor
) {
    if (mal_value_is_proxy_object(target)) {
        bool ok = mal_proxy_define_own_property(
            vm, mal_value_to_proxy_object(target), key, descriptor);
        if (!ok && vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot redefine property");
        }
        return ok;
    }
    mal_builtin_object_define_from_value(
        vm, mal_value_to_object(target), key, descriptor);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

/** ObjectDefineProperties: collect and validate every descriptor before defining. */
static bool mal_builtin_object_define_properties_impl(
    MalVm *vm, MalValue target, MalValue properties
) {
    MalValue object_roots[2] = {target, properties};
    MalRootSpan object_span;
    mal_gc_root(&object_span, object_roots, 2);

    MalRootedKeySnapshot own_keys;
    MalRootedKeySnapshot define_keys;
    MalRootedValueList descriptors;
    mal_rooted_key_snapshot_init(&own_keys);
    mal_rooted_key_snapshot_init(&define_keys);
    mal_rooted_value_list_init(&descriptors);

    bool ok = mal_rooted_key_snapshot_own_keys(vm, object_roots[1], &own_keys);
    for (usize i = 0; ok && i < own_keys.count; i++) {
        bool present;
        MalPropertyDesc property_desc;
        if (!mal_vm_get_own_property(
                vm, object_roots[1], own_keys.keys[i], &present, &property_desc)) {
            ok = false;
            break;
        }
        if (!present || !(property_desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            continue;
        }

        MalValue descriptor_value;
        if (!mal_vm_get_property(
                vm, object_roots[1], own_keys.keys[i], &descriptor_value)) {
            ok = false;
            break;
        }
        MalPropertyDescriptorParse parsed;
        if (!mal_builtin_object_to_property_descriptor(vm, descriptor_value, &parsed)) {
            ok = false;
            break;
        }
        MalValue parsed_roots[3] = {
            parsed.desc.value, parsed.desc.getter, parsed.desc.setter,
        };
        MalRootSpan parsed_span;
        mal_gc_root(&parsed_span, parsed_roots, 3);
        MalValue normalized = mal_builtin_object_parsed_descriptor_object(vm, &parsed);
        mal_rooted_key_snapshot_append(&define_keys, own_keys.keys[i]);
        mal_rooted_value_list_append(&descriptors, normalized);
        mal_gc_unroot(&parsed_span);
    }

    for (usize i = 0; ok && i < define_keys.count; i++) {
        ok = mal_builtin_object_define_value(
            vm, object_roots[0], define_keys.keys[i], descriptors.values[i]);
    }

    mal_rooted_value_list_dispose(&descriptors);
    mal_rooted_key_snapshot_dispose(&define_keys);
    mal_rooted_key_snapshot_dispose(&own_keys);
    mal_gc_unroot(&object_span);
    return ok;
}

/**
 * ToObject for the primitive types: box into the matching primitive wrapper
 * with the proper .prototype intrinsic. Returns undefined for non-primitives
 * (caller handles object pass-through and null/undefined separately).
 */
MalValue mal_builtin_object_box_primitive(MalVm *vm, MalValue value) {
    MalPrimitiveWrapperKind kind;
    MalIntrinsic prototype_slot;
    if (mal_value_is_string(value)) {
        kind = MAL_PRIMITIVE_WRAPPER_STRING;
        prototype_slot = MAL_INTRINSIC_STRING_PROTOTYPE;
    } else if (mal_value_is_boolean(value)) {
        kind = MAL_PRIMITIVE_WRAPPER_BOOLEAN;
        prototype_slot = MAL_INTRINSIC_BOOLEAN_PROTOTYPE;
    } else if (mal_value_is_symbol(value)) {
        kind = MAL_PRIMITIVE_WRAPPER_SYMBOL;
        prototype_slot = MAL_INTRINSIC_SYMBOL_PROTOTYPE;
    } else if (mal_value_is_bigint(value)) {
        kind = MAL_PRIMITIVE_WRAPPER_BIGINT;
        prototype_slot = MAL_INTRINSIC_BIGINT_PROTOTYPE;
    } else if (mal_ops_is_number(value)) {
        kind = MAL_PRIMITIVE_WRAPPER_NUMBER;
        prototype_slot = MAL_INTRINSIC_NUMBER_PROTOTYPE;
    } else {
        return mal_value_new_undefined();
    }

    return mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        kind,
        value
    ));
}

static MalValue mal_builtin_object_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // Object(value) and new Object(value) perform ToObject/pass-through, but a
    // derived construction ignores value and starts from a fresh ordinary object.
    // The generic native-construct seam applies the custom new.target prototype to
    // this intrinsic-prototype result exactly once.
    if (!mal_value_is_undefined(new_target) && new_target != callee) {
        return mal_value_from_object(mal_intrinsic_new_object(vm));
    }
    if (arg_count > 0 && mal_value_is_object(args[0])) {
        return args[0];
    }

    // ToObject of a primitive produces the matching wrapper; null/undefined and
    // a missing argument produce a fresh ordinary object.
    if (arg_count > 0 && !mal_value_is_nil(args[0])) {
        MalValue boxed = mal_builtin_object_box_primitive(vm, args[0]);
        if (!mal_value_is_undefined(boxed)) {
            return boxed;
        }
    }

    return mal_value_from_object(mal_intrinsic_new_object(vm));
}

static MalValue mal_builtin_object_define_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.defineProperty called on non-object");
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 1), &key)) {
        return args[0];
    }

    if (mal_value_is_proxy_object(args[0])) {
        bool ok = mal_proxy_define_own_property(vm, mal_value_to_proxy_object(args[0]), key, mal_builtin_object_arg(args, arg_count, 2));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        if (!ok) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot redefine property");
            return mal_value_new_undefined();
        }
        return args[0];
    }

    mal_builtin_object_define_from_value(vm, mal_value_to_object(args[0]), key, mal_builtin_object_arg(args, arg_count, 2));
    return args[0];
}

static MalValue mal_builtin_object_define_properties(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.defineProperties called on non-object");
        return mal_value_new_undefined();
    }
    // props = ToObject(Properties): null/undefined throw, other primitives box
    // (a Boolean/Number/etc. box simply has no enumerable own properties).
    MalValue props = mal_builtin_object_arg(args, arg_count, 1);
    if (!mal_value_is_object(props)) {
        if (mal_value_is_nil(props)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        props = mal_builtin_object_box_primitive(vm, props);
    }

    if (!mal_builtin_object_define_properties_impl(vm, args[0], props)) {
        return mal_value_new_undefined();
    }
    return args[0];
}

/**
 * FromPropertyDescriptor: build the plain descriptor object for a property.
 */
MalValue mal_builtin_object_descriptor_object(MalVm *vm, MalPropertyDesc desc) {
    MalValue roots[4] = {
        mal_value_new_undefined(),
        desc.value,
        desc.getter,
        desc.setter,
    };
    MalRootSpan roots_span;
    // Most standalone descriptor calls still run under their native frame's
    // no-GC suppression and need no root-list traffic. The bulk descriptors
    // path deliberately lifts that suppression around Proxy/exotic callbacks;
    // there, publish descriptor fields before allocating the result object.
    bool rooted = vm->gc_native_frames == 0;
    if (rooted) {
        mal_gc_root(&roots_span, roots, countof(roots));
    }
    roots[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *result = mal_value_to_object(roots[0]);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    if (desc.flags & MAL_PROPERTY_ACCESSOR) {
        mal_intrinsic_define_data(vm, result, "get", roots[2], flags);
        mal_intrinsic_define_data(vm, result, "set", roots[3], flags);
    } else {
        mal_intrinsic_define_data(vm, result, "value", roots[1], flags);
        mal_intrinsic_define_data(vm, result, "writable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_WRITABLE), flags);
    }

    mal_intrinsic_define_data(vm, result, "enumerable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_ENUMERABLE), flags);
    mal_intrinsic_define_data(vm, result, "configurable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_CONFIGURABLE), flags);

    MalValue value = roots[0];
    if (rooted) {
        mal_gc_unroot(&roots_span);
    }
    return value;
}

MalValue mal_builtin_object_parsed_descriptor_object(
    MalVm *vm, const MalPropertyDescriptorParse *parsed
) {
    MalValue roots[4] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        parsed->desc.value,
        parsed->desc.getter,
        parsed->desc.setter,
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 4);
    MalObject *object = mal_value_to_object(roots[0]);
    MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    if (parsed->has_enumerable) {
        mal_intrinsic_define_data(vm, object, "enumerable",
            mal_value_new_boolean(parsed->desc.flags & MAL_PROPERTY_ENUMERABLE), flags);
    }
    if (parsed->has_configurable) {
        mal_intrinsic_define_data(vm, object, "configurable",
            mal_value_new_boolean(parsed->desc.flags & MAL_PROPERTY_CONFIGURABLE), flags);
    }
    if (parsed->has_value) {
        mal_intrinsic_define_data(vm, object, "value", roots[1], flags);
    }
    if (parsed->has_writable) {
        mal_intrinsic_define_data(vm, object, "writable",
            mal_value_new_boolean(parsed->desc.flags & MAL_PROPERTY_WRITABLE), flags);
    }
    if (parsed->has_get) {
        mal_intrinsic_define_data(vm, object, "get", roots[2], flags);
    }
    if (parsed->has_set) {
        mal_intrinsic_define_data(vm, object, "set", roots[3], flags);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&roots_span);
    return result;
}

// FromPropertyDescriptor over the VM's single [[GetOwnProperty]] implementation.
// Keeping reflection on this shared path avoids duplicating exotic-object logic
// and lets predicate callers inspect the compact descriptor without allocating a
// temporary JavaScript descriptor object.
static bool mal_builtin_object_get_own(
    MalVm *vm, MalValue target, MalKey key,
    bool *present_out, MalPropertyDesc *desc_out
) {
    if (mal_value_heap_type(target) == MAL_HEAP_OBJECT) {
        MalPropertyLookup lookup =
            mal_object_get_own(mal_value_to_object(target), key);
        *present_out = lookup.present;
        if (lookup.present) *desc_out = lookup.desc;
        return true;
    }
    return mal_vm_get_own_property(
        vm, target, key, present_out, desc_out);
}

static MalValue mal_builtin_object_own_descriptor(MalVm *vm, MalValue target, MalKey key) {
    bool present;
    MalPropertyDesc desc;
    if (!mal_builtin_object_get_own(
            vm, target, key, &present, &desc) || !present) {
        return mal_value_new_undefined();
    }
    return mal_builtin_object_descriptor_object(vm, desc);
}

static MalValue mal_builtin_object_get_own_property_descriptor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // ToObject(O) first: null/undefined throw, other primitives box.
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
        if (mal_value_is_undefined(target)) {
            return mal_value_new_undefined();
        }
    }

    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    return mal_builtin_object_own_descriptor(vm, target, key);
}

// Compute target.[[GetOwnProperty]](key) and, when present, CreateDataProperty
// it onto the descriptors result. Returns false on an abrupt completion.
static bool mal_builtin_object_descriptors_put(
    MalVm *vm, MalValue result_value, MalValue target, MalKey key
) {
    MalValue descriptor = mal_builtin_object_own_descriptor(vm, target, key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    if (mal_value_is_undefined(descriptor)) {
        return true;
    }
    MalRootSpan descriptor_span;
    mal_gc_root(&descriptor_span, &descriptor, 1);
    MalPropertyDesc entry = mal_intrinsic_data_desc(
        descriptor,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(mal_value_to_object(result_value), key, &entry);
    mal_gc_unroot(&descriptor_span);
    return true;
}

static MalValue mal_builtin_object_get_own_property_descriptors(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // ToObject(O): null/undefined throw, other primitives box.
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
    }

    // Plain ordinary objects have no observable own-key or descriptor hooks.
    // Walk their storage directly under the native frame's existing GC
    // suppression, avoiding a rooted key snapshot and per-descriptor root-list
    // traffic on this overwhelmingly common reflection path.
    if (mal_value_heap_type(target) == MAL_HEAP_OBJECT) {
        MalObject *result = mal_intrinsic_new_object(vm);
        MalPropertyIter iter;
        mal_property_iter_init(
            &iter, mal_value_to_object(target), MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL &&
                mal_symbol_is_private(mal_value_to_symbol(key.value))) {
                continue;
            }
            MalPropertyDesc result_desc = mal_intrinsic_data_desc(
                mal_builtin_object_descriptor_object(vm, desc),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                    MAL_PROPERTY_CONFIGURABLE);
            mal_object_define_own(result, key, &result_desc);
        }
        return mal_value_from_object(result);
    }

    MalValue roots[2] = {
        target,
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, countof(roots));
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    mal_gc_native_rooted_begin(vm);

    bool ok = mal_rooted_key_snapshot_own_keys(vm, roots[0], &keys);
    for (usize i = 0; ok && i < keys.count; i++) {
        ok = mal_builtin_object_descriptors_put(
            vm, roots[1], roots[0], keys.keys[i]);
    }

    MalValue result = ok ? roots[1] : mal_value_new_undefined();
    mal_gc_native_rooted_end(vm);
    mal_rooted_key_snapshot_dispose(&keys);
    mal_gc_unroot(&roots_span);
    return result;
}

typedef enum MalBuiltinObjectCollect {
    MAL_BUILTIN_OBJECT_COLLECT_KEYS,
    MAL_BUILTIN_OBJECT_COLLECT_VALUES,
    MAL_BUILTIN_OBJECT_COLLECT_ENTRIES,
} MalBuiltinObjectCollect;

static MalValue mal_builtin_object_key_to_string(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }

    return key.value;
}

static bool mal_builtin_object_plain_capacity(
    MalObject *object, u32 *capacity_out
) {
    usize capacity = object->shape->inline_count;
    if (object->overflow != nullptr &&
        !mal_checked_size_add(
            capacity, mal_table_size(object->overflow), UINT32_MAX,
            &capacity)) {
        return false;
    }
    *capacity_out = (u32) capacity;
    return true;
}

/** Object.keys / getOwnPropertyNames over an exact ordinary object cannot
 * invoke user code. Iterate its shape/table storage directly while the native
 * frame still suppresses collection, avoiding the generic rooted key snapshot
 * and a second descriptor lookup for every property. */
static bool mal_builtin_object_collect_plain_keys(
    MalVm *vm,
    MalValue target,
    MalPropertyIterKind iter_kind,
    MalArrayObject *result
) {
    MalObject *object = mal_value_to_object(target);
    u32 capacity;
    if (!mal_builtin_object_plain_capacity(object, &capacity)) return false;
    (void) mal_array_object_fresh_dense_reserve_exact(result, capacity);

    bool enumerable_only =
        iter_kind == MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER;
    u32 count = 0;
    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL ||
            (enumerable_only && !(desc.flags & MAL_PROPERTY_ENUMERABLE))) {
            continue;
        }
        mal_array_object_store(
            result, mal_key_index(count++),
            mal_builtin_object_key_to_string(vm, key));
    }
    return true;
}

/** Exact ordinary objects expose symbol keys without an ownKeys trap. Copy them
 * in one pass so Object.getOwnPropertySymbols avoids a rooted snapshot containing
 * every string and index key as well. */
static MalValue mal_builtin_object_collect_plain_symbols(
    MalVm *vm,
    MalObject *object
) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 capacity;
    if (!mal_builtin_object_plain_capacity(object, &capacity)) {
        return mal_value_new_undefined();
    }
    (void) mal_array_object_fresh_dense_reserve_exact(result, capacity);
    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    u32 index = 0;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL &&
            !mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            mal_array_object_store(result, mal_key_index(index++), key.value);
        }
    }
    return mal_value_from_array_object(result);
}

/** Object.values / entries can likewise bypass the observable generic path
 * when every enumerable string-key property is a plain data descriptor. Build
 * during that eligibility scan; a late accessor discards this private result
 * and lets the caller restart on the observable generic path. */
static bool mal_builtin_object_collect_plain_data(
    MalVm *vm,
    MalValue target,
    MalBuiltinObjectCollect collect,
    MalArrayObject *result
) {
    MalObject *object = mal_value_to_object(target);
    u32 capacity;
    if (!mal_builtin_object_plain_capacity(object, &capacity)) return false;
    (void) mal_array_object_fresh_dense_reserve_exact(result, capacity);
    MalPropertyIter iter;
    mal_property_iter_init(
        &iter, object,
        MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    u32 index = 0;
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL ||
            !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            continue;
        }
        if (desc.flags & MAL_PROPERTY_ACCESSOR) return false;
        MalValue value = desc.value;
        if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
            MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
            mal_array_object_store(
                entry, mal_key_index(0),
                mal_builtin_object_key_to_string(vm, key));
            mal_array_object_store(entry, mal_key_index(1), value);
            value = mal_value_from_array_object(entry);
        }
        mal_array_object_store(result, mal_key_index(index++), value);
    }
    return true;
}

// Fills `result` with the collected keys/values/entries; returns false with a
// pending throw on an abrupt step. `result` is rooted by the caller wrapper
// (mal_builtin_object_collect) across the getter/trap re-entry below.
static bool mal_builtin_object_collect_impl(MalVm *vm, MalValue target, MalPropertyIterKind iter_kind, MalBuiltinObjectCollect collect, MalArrayObject *result) {
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return false;
        }
        MalValue boxed = mal_builtin_object_box_primitive(vm, target);
        if (mal_value_is_undefined(boxed)) {
            return true;
        }
        target = boxed;
    }

    MalValue live[3] = {
        mal_value_new_undefined(), // current key string
        mal_value_new_undefined(), // current property value
        mal_value_new_undefined(), // current output / entry array
    };
    MalRootSpan target_span, live_span;
    mal_gc_root(&target_span, &target, 1);
    mal_gc_root(&live_span, live, countof(live));
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, target, &keys);
    if (ok && keys.count <= UINT32_MAX) {
        // Every result mode contributes at most one element per snapshotted key.
        // Exact reservation avoids geometric reallocations without changing the
        // required second-phase descriptor/getter observations.
        (void) mal_array_object_fresh_dense_reserve_exact(result, (u32) keys.count);
    }
    bool enumerable_only = iter_kind == MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER;
    i32 count = 0;
    for (usize i = 0; ok && i < keys.count; i++) {
        MalKey key = keys.keys[i];
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }
        if (enumerable_only) {
            bool present;
            MalPropertyDesc desc;
            if (!mal_vm_get_own_property(vm, target, key, &present, &desc)) {
                ok = false;
                break;
            }
            if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }
        }

        live[0] = mal_builtin_object_key_to_string(vm, key);
        live[2] = live[0];
        if (collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
            if (!mal_vm_get_property(vm, target, key, &live[1])) {
                ok = false;
                break;
            }
            live[2] = live[1];
            if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
                MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                live[2] = mal_value_from_array_object(entry);
                mal_array_object_store(entry, mal_key_index(0), live[0]);
                mal_array_object_store(entry, mal_key_index(1), live[1]);
            }
        }
        mal_array_object_store(result, mal_key_index(count++), live[2]);
    }

    mal_rooted_key_snapshot_dispose(&keys);
    mal_gc_unroot(&live_span);
    mal_gc_unroot(&target_span);
    return ok;
}

// Object.keys/values/entries (+ getOwnPropertyNames) collector. The result array
// is held across getter / proxy-trap re-entry that the body performs, so root it
// and lift this builtin's GC suppression around the collection.
static MalValue mal_builtin_object_collect(MalVm *vm, MalValue target, MalPropertyIterKind iter_kind, MalBuiltinObjectCollect collect) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    MalValue result_box = mal_value_from_array_object(result);
    if (mal_value_is_heap_type(target, MAL_HEAP_OBJECT) &&
        collect == MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
        return mal_builtin_object_collect_plain_keys(
                vm, target, iter_kind, result)
            ? result_box
            : mal_value_new_undefined();
    }
    if (mal_value_is_heap_type(target, MAL_HEAP_OBJECT) &&
        collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
        if (mal_builtin_object_collect_plain_data(
                vm, target, collect, result)) {
            return result_box;
        }
        result = mal_intrinsic_new_array(vm, 0);
        result_box = mal_value_from_array_object(result);
    }
    MalRootSpan result_span;
    mal_gc_root(&result_span, &result_box, 1);
    mal_gc_native_rooted_begin(vm);
    bool ok = mal_builtin_object_collect_impl(vm, target, iter_kind, collect, result);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&result_span);
    return ok ? result_box : mal_value_new_undefined();
}

static MalValue mal_builtin_object_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_KEYS
    );
}

MalValue mal_builtin_object_keys_known(
    MalVm *vm, const MalValue *args, i32 arg_count
) {
    return mal_builtin_object_keys(
        vm, MAL_VALUE_UNDEFINED, args, arg_count, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_object_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_VALUES
    );
}

MalValue mal_builtin_object_values_known(
    MalVm *vm, const MalValue *args, i32 arg_count
) {
    return mal_builtin_object_values(
        vm, MAL_VALUE_UNDEFINED, args, arg_count, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_object_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_ENTRIES
    );
}

static MalValue mal_builtin_object_get_own_property_names(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_KEYS
    );
}

// Store one snapshotted Object.assign value, rooting it while target property
// resolution invokes a setter or Proxy trap.
static bool mal_builtin_object_assign_store(
    MalVm *vm, MalValue target, MalKey key, MalValue value
) {
    MalRootSpan value_span;
    mal_gc_root(&value_span, &value, 1);
    bool stored = mal_vm_set_property(vm, target, key, value, target);
    mal_gc_unroot(&value_span);
    if (!stored) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        }
        return false;
    }
    return true;
}

// Copy one own enumerable key from source to target: Get (invoking a getter /
// Proxy trap) then Set(to, key, value, true) (invoking a target setter and
// throwing on a failed write), per the Object.assign copy step.
static bool mal_builtin_object_assign_copy(
    MalVm *vm, MalValue target, MalKey key, MalValue source
) {
    MalValue value;
    if (!mal_vm_get_property(vm, source, key, &value)) {
        return false;
    }
    return mal_builtin_object_assign_store(vm, target, key, value);
}

// CopyDataProperties from one (already ToObject'd) source: enumerate own keys
// via the source's [[OwnPropertyKeys]] / [[GetOwnProperty]] so Proxy traps fire,
// a TypedArray's / String wrapper's exotic indices are seen, and both string and
// symbol keys are copied (Object.assign copies symbol-keyed properties too).
static bool mal_builtin_object_assign_from(MalVm *vm, MalValue target, MalValue source) {
    // [[OwnPropertyKeys]] is snapshotted before any descriptor/Get/Set effects.
    // Each key's current [[GetOwnProperty]] controls whether it is copied.
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, source, &keys);
    bool ordinary_source = mal_value_heap_type(source) == MAL_HEAP_OBJECT;
    for (usize i = 0; ok && i < keys.count; i++) {
        bool present;
        MalPropertyDesc desc;
        if (ordinary_source) {
            MalPropertyLookup lookup =
                mal_object_get_own(mal_value_to_object(source), keys.keys[i]);
            present = lookup.present;
            if (present) desc = lookup.desc;
        } else {
            if (!mal_vm_get_own_property(
                    vm, source, keys.keys[i], &present, &desc)) {
                ok = false;
                break;
            }
        }
        if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            continue;
        }
        // An ordinary data property has no observable operation between the
        // descriptor query and Get, so its current descriptor value is exactly
        // what Get would return. Accessors retain the generic Get path so their
        // user code and receiver semantics stay intact.
        bool copied = ordinary_source &&
                !(desc.flags & MAL_PROPERTY_ACCESSOR)
            ? mal_builtin_object_assign_store(
                vm, target, keys.keys[i], desc.value)
            : mal_builtin_object_assign_copy(
                vm, target, keys.keys[i], source);
        if (!copied) {
            ok = false;
            break;
        }
    }
    mal_rooted_key_snapshot_dispose(&keys);
    return ok;
}

static MalValue mal_builtin_object_assign(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // to = ? ToObject(target): null/undefined (or no target) throw; other
    // primitives box.
    if (arg_count < 1 || mal_value_is_nil(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }
    MalValue target_value = args[0];
    if (!mal_value_is_object(target_value)) {
        target_value = mal_builtin_object_box_primitive(vm, target_value);
    }

    // The target is held across every source's copy (getters/setters re-enter and
    // can collect); a boxed primitive source is a fresh object not on the value
    // stack. Root both and lift GC suppression for the loop.
    MalValue roots[2] = {target_value, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    bool ok = true;

    for (i32 i = 1; i < arg_count; i++) {
        // Only undefined and null sources are skipped; other primitives ToObject.
        if (mal_value_is_nil(args[i])) {
            continue;
        }
        MalValue source_value = args[i];
        if (!mal_value_is_object(source_value)) {
            source_value = mal_builtin_object_box_primitive(vm, source_value);
        }
        roots[1] = source_value;
        if (!mal_builtin_object_assign_from(vm, target_value, source_value)) {
            ok = false;
            break;
        }
    }
    if (ok) {
        ret = target_value;
    }

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return ret;
}

static MalValue mal_builtin_object_create(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue prototype_value = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(prototype_value) && !mal_value_is_null(prototype_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object prototype may only be an Object or null");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value) : nullptr;

    // 3. If Properties is not undefined: ObjectDefineProperties(obj, Properties),
    // whose first step is ToObject(Properties). undefined is skipped, null still
    // throws, and any other primitive boxes (its wrapper has no enumerable own
    // properties). Coerce before allocating result so the fresh object is never
    // live across the wrapper allocation.
    MalValue properties = mal_builtin_object_arg(args, arg_count, 1);
    if (!mal_value_is_undefined(properties) && !mal_value_is_object(properties)) {
        if (mal_value_is_null(properties)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        properties = mal_builtin_object_box_primitive(vm, properties);
    }

    MalValue result = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    if (!mal_value_is_undefined(properties)) {
        if (!mal_builtin_object_define_properties_impl(vm, result, properties)) {
            return mal_value_new_undefined();
        }
    }

    return result;
}

static MalValue mal_builtin_object_get_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // ToObject(O): null/undefined throw. A primitive's transient wrapper can be
    // elided because its [[Prototype]] is the corresponding intrinsic directly.
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        MalObject *holder = mal_builtin_object_receiver_holder(vm, target);
        return holder != nullptr ? mal_value_from_object(holder) : mal_value_new_null();
    }

    if (mal_value_is_proxy_object(target)) {
        MalValue proto;
        if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(target), &proto)) {
            return mal_value_new_undefined();
        }
        return proto;
    }

    MalObject *prototype = mal_object_get_prototype(mal_value_to_object(target));
    return prototype != nullptr ? mal_value_from_object(prototype) : mal_value_new_null();
}

static MalValue mal_builtin_object_set_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // 1. RequireObjectCoercible(O): null/undefined throw.
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (mal_value_is_nil(target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.setPrototypeOf called on null or undefined");
        return mal_value_new_undefined();
    }

    // 2. The proto argument must be an Object or null (checked even for a
    // primitive target).
    MalValue proto_value = mal_builtin_object_arg(args, arg_count, 1);
    if (!mal_value_is_object(proto_value) && !mal_value_is_null(proto_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object prototype may only be an Object or null");
        return mal_value_new_undefined();
    }

    // 3. A non-object (already-coercible) target is returned unchanged.
    if (!mal_value_is_object(target)) {
        return target;
    }

    MalObject *prototype = mal_value_is_object(proto_value) ? mal_value_to_object(proto_value) : nullptr;

    if (mal_value_is_proxy_object(target)) {
        bool success;
        if (!mal_proxy_set_prototype_of(vm, mal_value_to_proxy_object(target), proto_value, &success)) {
            return mal_value_new_undefined();
        }
        if (!success) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set prototype of object");
        }
        return target;
    }

    // A failed [[SetPrototypeOf]] (non-extensible target or a cycle) throws.
    if (!mal_object_set_prototype(mal_value_to_object(target), prototype)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set prototype of non-extensible object");
    }

    return target;
}

static MalValue mal_builtin_object_prevent_extensions(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    if (mal_value_is_proxy_object(args[0])) {
        bool success;
        if (!mal_proxy_prevent_extensions(vm, mal_value_to_proxy_object(args[0]), &success)) {
            return mal_value_new_undefined();
        }
        if (!success) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.preventExtensions on a proxy that returned false");
        }
        return args[0];
    }

    mal_object_set_extensible(mal_value_to_object(args[0]), false);
    return args[0];
}

static MalValue mal_builtin_object_is_extensible(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(false);
    }

    if (mal_value_is_proxy_object(args[0])) {
        bool extensible;
        if (!mal_proxy_is_extensible(vm, mal_value_to_proxy_object(args[0]), &extensible)) {
            return mal_value_new_undefined();
        }
        return mal_value_new_boolean(extensible);
    }

    return mal_value_new_boolean(mal_object_is_extensible(mal_value_to_object(args[0])));
}

bool mal_builtin_object_set_integrity(
    MalVm *vm, MalValue target, bool clear_writable
) {
    if ((mal_value_heap_type(target) == MAL_HEAP_OBJECT ||
         mal_value_heap_type(target) == MAL_HEAP_ARRAY_OBJECT) &&
        !mal_object_is_locked_primordial(mal_value_to_object(target))) {
        mal_object_set_integrity_level(
            mal_value_to_object(target), clear_writable);
        return true;
    }

    bool prevented;
    if (mal_value_is_proxy_object(target)) {
        if (!mal_proxy_prevent_extensions(
                vm, mal_value_to_proxy_object(target), &prevented)) {
            return false;
        }
    } else {
        mal_object_set_extensible(mal_value_to_object(target), false);
        prevented = true;
    }
    if (!prevented) {
        return false;
    }

    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, target, &keys);
    for (usize i = 0; ok && i < keys.count; i++) {
        MalPropertyDescriptorParse update = {
            .has_configurable = true,
            .desc = mal_intrinsic_data_desc(
                mal_value_new_undefined(), MAL_PROPERTY_NONE),
        };
        if (clear_writable) {
            bool present;
            MalPropertyDesc current;
            if (!mal_vm_get_own_property(
                    vm, target, keys.keys[i], &present, &current)) {
                ok = false;
                break;
            }
            if (!present) {
                continue;
            }
            if (!(current.flags & MAL_PROPERTY_ACCESSOR)) {
                update.has_writable = true;
            }
        }
        if (!mal_builtin_object_define_own_property_parsed(
                vm, target, keys.keys[i], &update)) {
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot set object integrity level");
            }
            ok = false;
        }
    }
    mal_rooted_key_snapshot_dispose(&keys);
    return ok;
}

/**
 * TestIntegrityLevel: non-extensible with no configurable (and for frozen no
 * writable data) own properties.
 */
static bool mal_builtin_object_test_integrity(
    MalVm *vm, MalValue target, bool check_writable, bool *result
) {
    bool extensible;
    if (!mal_vm_is_extensible_object(vm, target, &extensible)) {
        return false;
    }
    if (extensible) {
        *result = false;
        return true;
    }

    if (mal_value_heap_type(target) == MAL_HEAP_OBJECT) {
        *result = true;
        MalPropertyIter iter;
        mal_property_iter_init(
            &iter, mal_value_to_object(target),
            MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL &&
                mal_symbol_is_private(mal_value_to_symbol(key.value))) {
                continue;
            }
            if ((desc.flags & MAL_PROPERTY_CONFIGURABLE) ||
                (check_writable &&
                 !(desc.flags & MAL_PROPERTY_ACCESSOR) &&
                 (desc.flags & MAL_PROPERTY_WRITABLE))) {
                *result = false;
                break;
            }
        }
        return true;
    }

    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, target, &keys);
    *result = true;
    for (usize i = 0; ok && *result && i < keys.count; i++) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(
                vm, target, keys.keys[i], &present, &desc)) {
            ok = false;
            break;
        }
        if (!present) {
            continue;
        }
        if ((desc.flags & MAL_PROPERTY_CONFIGURABLE) ||
            (check_writable && !(desc.flags & MAL_PROPERTY_ACCESSOR) &&
             (desc.flags & MAL_PROPERTY_WRITABLE))) {
            *result = false;
        }
    }
    mal_rooted_key_snapshot_dispose(&keys);
    return ok;
}

static MalValue mal_builtin_object_freeze(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }
    if (!mal_builtin_object_set_integrity(vm, args[0], true) &&
        vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Object.freeze could not prevent extensions");
    }
    return args[0];
}

static MalValue mal_builtin_object_seal(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }
    if (!mal_builtin_object_set_integrity(vm, args[0], false) &&
        vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Object.seal could not prevent extensions");
    }
    return args[0];
}

static MalValue mal_builtin_object_is_frozen(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(true);
    }
    bool result;
    if (!mal_builtin_object_test_integrity(vm, args[0], true, &result)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(result);
}

static MalValue mal_builtin_object_is_sealed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(true);
    }
    bool result;
    if (!mal_builtin_object_test_integrity(vm, args[0], false, &result)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(result);
}

static MalValue mal_builtin_object_is(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    MalValue left = mal_builtin_object_arg(args, arg_count, 0);
    MalValue right = mal_builtin_object_arg(args, arg_count, 1);
    return mal_value_new_boolean(mal_ops_same_value(left, right));
}

MalValue mal_builtin_object_is_known(const MalValue *args, i32 arg_count) {
    MalValue left = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue right = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    return mal_value_new_boolean(mal_ops_same_value(left, right));
}

// HasOwnProperty(O, key): O.[[GetOwnProperty]](key) is not undefined. `object`
// must already be an object; routes through Proxy traps and TypedArray / String
// exotics via [[GetOwnProperty]].
static MalValue mal_builtin_object_has_own_resolved(MalVm *vm, MalValue object, MalKey key) {
    bool present;
    MalPropertyDesc desc;
    if (!mal_builtin_object_get_own(
            vm, object, key, &present, &desc)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(present);
}

static MalValue mal_builtin_object_has_own(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // Object.hasOwn(O, P): ToObject(O) before ToPropertyKey(P).
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
    }
    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }
    return mal_builtin_object_has_own_resolved(vm, target, key);
}

MalValue mal_builtin_object_has_own_known(
    MalVm *vm, const MalValue *args, i32 arg_count
) {
    return mal_builtin_object_has_own(
        vm, MAL_VALUE_UNDEFINED, args, arg_count, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_object_prototype_has_own_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    // Object.prototype.hasOwnProperty(V): ToPropertyKey(V) before ToObject(this).
    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 0), &key)) {
        return mal_value_new_undefined();
    }
    MalValue target = this_value;
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
    }
    return mal_builtin_object_has_own_resolved(vm, target, key);
}

static MalValue mal_builtin_object_prototype_is_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    // 1. If V is not an Object, return false (before any this coercion).
    MalValue v = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(v)) {
        return mal_value_new_boolean(false);
    }
    // 2. Let O be ? ToObject(this value): null/undefined throw, a primitive boxes.
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.prototype.isPrototypeOf called on null or undefined");
        return mal_value_new_undefined();
    }
    MalValue o = mal_value_is_object(this_value) ? this_value : mal_builtin_object_box_primitive(vm, this_value);

    // 3. Walk V's prototype chain via [[GetPrototypeOf]] (proxy-aware).
    while (true) {
        MalValue prototype;
        if (mal_value_is_proxy_object(v)) {
            if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(v), &prototype)) {
                return mal_value_new_undefined();
            }
        } else {
            MalObject *p = mal_object_get_prototype(mal_value_to_object(v));
            prototype = p == nullptr ? mal_value_new_null() : mal_value_from_object(p);
        }
        if (mal_value_is_null(prototype)) {
            return mal_value_new_boolean(false);
        }
        if (mal_ops_same_value(prototype, o)) {
            return mal_value_new_boolean(true);
        }
        v = prototype;
    }
}

static MalValue mal_builtin_object_prototype_property_is_enumerable(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    // propertyIsEnumerable(V): ToPropertyKey(V), then ToObject(this); the result
    // is desc.[[Enumerable]] of O.[[GetOwnProperty]](P) (false when absent).
    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 0), &key)) {
        return mal_value_new_undefined();
    }
    MalValue target = this_value;
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
    }

    bool present;
    MalPropertyDesc desc;
    if (!mal_builtin_object_get_own(
            vm, target, key, &present, &desc)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(present && (desc.flags & MAL_PROPERTY_ENUMERABLE));
}

static MalValue mal_builtin_object_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    // Returns ? ToObject(this value): null/undefined throw, a primitive boxes
    // into its wrapper, an object passes through.
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.prototype.valueOf called on null or undefined");
        return mal_value_new_undefined();
    }
    if (mal_value_is_object(this_value)) {
        return this_value;
    }
    return mal_builtin_object_box_primitive(vm, this_value);
}

MalValue mal_builtin_object_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    const byte *tag = "[object Object]";
    // IsArray (step 4) is proxy-aware and runs before the @@toStringTag Get; a
    // revoked Proxy throws a TypeError here.
    bool is_array;
    if (!mal_vm_is_array(vm, this_value, &is_array)) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_undefined(this_value)) {
        tag = "[object Undefined]";
    } else if (mal_value_is_null(this_value)) {
        tag = "[object Null]";
    } else if (is_array) {
        tag = "[object Array]";
    } else if (mal_value_is_object(this_value) && mal_value_to_object(this_value)->is_arguments) {
        tag = "[object Arguments]";
    } else if (mal_value_is_callable(this_value)) {
        tag = "[object Function]";
    } else if (mal_value_is_date_object(this_value)) {
        // The spec's builtin tag tracks the [[DateValue]] internal slot.
        tag = "[object Date]";
    } else if (mal_value_is_regexp_object(this_value)) {
        // The builtin tag tracks the [[RegExpMatcher]] internal slot.
        tag = "[object RegExp]";
    } else if (mal_builtin_value_has_error_data(vm, this_value)) {
        // The builtin tag tracks the [[ErrorData]] internal slot.
        tag = "[object Error]";
    } else if (mal_value_is_primitive_wrapper(this_value)) {
        // The builtin tag tracks the wrapper's [[PrimitiveData]] internal slot.
        switch (mal_value_to_primitive_wrapper(this_value)->kind) {
            case MAL_PRIMITIVE_WRAPPER_STRING:
                tag = "[object String]";
                break;
            case MAL_PRIMITIVE_WRAPPER_NUMBER:
                tag = "[object Number]";
                break;
            case MAL_PRIMITIVE_WRAPPER_BOOLEAN:
                tag = "[object Boolean]";
                break;
            case MAL_PRIMITIVE_WRAPPER_SYMBOL:
            case MAL_PRIMITIVE_WRAPPER_BIGINT:
                // Symbol and BigInt get their usual tags from their prototypes'
                // string-valued @@toStringTag. Their spec built-in tag is Object,
                // so a missing or non-string override must fall back to Object.
                tag = "[object Object]";
                break;
            default:
                tag = "[object Object]";
                break;
        }
    } else if (mal_value_is_string(this_value)) {
        tag = "[object String]";
    } else if (mal_value_is_boolean(this_value)) {
        tag = "[object Boolean]";
    } else if (mal_value_is_int32(this_value) || mal_value_is_f64_or_nan(this_value)) {
        tag = "[object Number]";
    }

    // A string-valued @@toStringTag overrides the built-in tag.
    if (!mal_value_is_nil(this_value)) {
        MalValue tag_value;
        if (!mal_vm_get_property(vm, this_value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_value)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_string(tag_value)) {
            MalString *text;
            if (!mal_string_new_cons_checked(
                    &vm->heap, mal_intrinsic_ascii(vm, "[object "),
                    mal_value_to_string(tag_value), &text) ||
                !mal_string_new_cons_checked(
                    &vm->heap, text, mal_intrinsic_ascii(vm, "]"), &text)) {
                mal_vm_throw_error(
                    vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Invalid string length");
                return mal_value_new_undefined();
            }
            return mal_value_from_string(text);
        }
    }

    return mal_value_from_string(mal_intrinsic_ascii(vm, tag));
}

static MalValue mal_builtin_object_get_own_property_symbols(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (mal_value_is_nil(target)) {
        // ToObject rejects null and undefined.
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }

    if (!mal_value_is_object(target)) {
        return mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    }
    if (mal_value_heap_type(target) == MAL_HEAP_OBJECT) {
        return mal_builtin_object_collect_plain_symbols(
            vm, mal_value_to_object(target));
    }

    MalValue roots[2] = {
        target,
        mal_value_from_array_object(mal_intrinsic_new_array(vm, 0)),
    };

    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, countof(roots));
    MalRootedKeySnapshot keys;
    mal_rooted_key_snapshot_init(&keys);
    mal_gc_native_rooted_begin(vm);
    bool ok = mal_rooted_key_snapshot_own_keys(vm, roots[0], &keys);
    MalArrayObject *result = mal_value_to_array_object(roots[1]);
    if (ok && keys.count <= UINT32_MAX) {
        (void) mal_array_object_fresh_dense_reserve_exact(
            result, (u32) keys.count);
    }
    u32 count = 0;
    for (usize i = 0; ok && i < keys.count; i++) {
        if (keys.keys[i].kind == MAL_KEY_SYMBOL) {
            mal_array_object_store(
                result, mal_key_index(count++), keys.keys[i].value);
        }
    }

    MalValue value = ok ? roots[1] : mal_value_new_undefined();
    mal_gc_native_rooted_end(vm);
    mal_rooted_key_snapshot_dispose(&keys);
    mal_gc_unroot(&roots_span);
    return value;
}

static MalValue mal_builtin_object_from_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    // A missing argument throws through GetIterator on undefined.
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    MalValue roots[5] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), // current entry
        mal_value_new_undefined(), // entry key
        mal_value_new_undefined(), // entry value
        mal_value_new_undefined(), // canonical property-key value
    };
    MalRootSpan record_span, roots_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_root(&roots_span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    while (true) {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &roots[1], &done)) {
            goto done;
        }

        if (done) {
            ret = roots[0];
            goto done;
        }

        if (!mal_value_is_object(roots[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator value is not an entry object");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }

        bool dense_pair = mal_value_is_array_object(roots[1]) &&
            mal_array_object_dense_pair(
                mal_value_to_array_object(roots[1]), &roots[2], &roots[3]);
        if (!dense_pair) {
            if (!mal_vm_get_property(
                    vm, roots[1], mal_key_index(0), &roots[2]) ||
                !mal_vm_get_property(
                    vm, roots[1], mal_key_index(1), &roots[3])) {
                mal_vm_iterator_close(vm, &record);
                goto done;
            }
        }

        MalKey key;
        if (!mal_vm_to_property_key(vm, roots[2], &key)) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        roots[4] = key.value;

        // CreateDataPropertyOrThrow: in particular, "__proto__" is an own data
        // property and must not invoke Object.prototype's legacy setter.
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            roots[3],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
        if (mal_object_define_own(mal_value_to_object(roots[0]), key, &desc) !=
            MAL_DEFINE_OWN_APPLIED) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Cannot create property on result object");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&record_span);
    return ret;
}

static MalValue mal_builtin_object_group_by(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    if (arg_count < 2 || !mal_value_is_callable(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }

    MalIteratorRecord record;
    if (arg_count < 1 || !mal_vm_get_iterator(vm, args[0], &record)) {
        return mal_value_new_undefined();
    }

    // Groups live on a null-prototype object. The iterator, callback, result,
    // current value/key, and new group are all live across user re-entry.
    MalValue roots[5] = {
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        args[1],
        mal_value_new_undefined(), // current element
        mal_value_new_undefined(), // callback result / property key
        mal_value_new_undefined(), // current group
    };
    MalRootSpan record_span, roots_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_root(&roots_span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    f64 index = 0.0;
    while (true) {
        if (index >= MAL_NUMBER_MAX_SAFE_INTEGER) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Object.groupBy exceeded the maximum safe index");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }

        bool done;
        if (!mal_vm_iterator_step(vm, &record, &roots[2], &done)) {
            goto done;
        }

        if (done) {
            ret = roots[0];
            goto done;
        }

        MalValue callback_args[] = {roots[2], mal_ops_number_value(index)};
        MalCompletion completion = mal_vm_call_value(
            vm, roots[1], mal_value_new_undefined(), callback_args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        roots[3] = completion.value;

        MalKey key;
        if (!mal_vm_to_property_key(vm, roots[3], &key)) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        roots[3] = key.value;

        MalObject *result = mal_value_to_object(roots[0]);
        MalPropertyLookup existing = mal_object_get_own(result, key);
        MalArrayObject *group;
        if (existing.present) {
            group = mal_value_to_array_object(existing.desc.value);
            roots[4] = existing.desc.value;
        } else {
            group = mal_intrinsic_new_array(vm, 0);
            roots[4] = mal_value_from_array_object(group);
            MalPropertyDesc desc = mal_intrinsic_data_desc(
                roots[4],
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                    MAL_PROPERTY_CONFIGURABLE);
            if (mal_object_define_own(result, key, &desc) != MAL_DEFINE_OWN_APPLIED) {
                mal_vm_throw_error(
                    vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot create Object.groupBy result property");
                mal_vm_iterator_close(vm, &record);
                goto done;
            }
        }

        if (!mal_array_object_fresh_dense_append(group, roots[2])) {
            mal_array_object_store(
                group,
                mal_key_index(mal_array_object_length(group)),
                roots[2]);
        }
        index += 1.0;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&record_span);
    return ret;
}

/**
 * Resolve the object whose chain serves property lookups for this receiver:
 * the object itself, or the wrapper prototype for primitives.
 */
static MalObject *mal_builtin_object_receiver_holder(MalVm *vm, MalValue this_value) {
    if (mal_value_is_object(this_value)) {
        return mal_value_to_object(this_value);
    }
    if (mal_value_is_string(this_value)) {
        return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE]);
    }
    if (mal_value_is_boolean(this_value)) {
        return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE]);
    }
    if (mal_value_is_int32(this_value) || mal_value_is_f64_or_nan(this_value)) {
        return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE]);
    }
    if (mal_value_is_symbol(this_value)) {
        return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SYMBOL_PROTOTYPE]);
    }
    if (mal_value_is_bigint(this_value)) {
        return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_BIGINT_PROTOTYPE]);
    }

    return nullptr;
}

static MalValue mal_builtin_object_prototype_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.prototype.toLocaleString called on null or undefined");
        return mal_value_new_undefined();
    }

    MalValue to_string = mal_value_new_undefined();
    if (!mal_vm_get_property(
            vm, this_value, mal_intrinsic_string_key(vm, "toString"), &to_string)) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_callable(to_string)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "this.toString is not a function");
        return mal_value_new_undefined();
    }

    MalCompletion completion = mal_vm_call_value(vm, to_string, this_value, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }

    return completion.value;
}

static MalValue mal_builtin_object_proto_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }

    if (mal_value_is_object(this_value)) {
        // get __proto__ is O.[[GetPrototypeOf]](): a proxy runs its trap (which
        // may throw — propagate it).
        if (mal_value_is_proxy_object(this_value)) {
            MalValue prototype;
            if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(this_value), &prototype)) {
                return mal_value_new_undefined();
            }
            return prototype;
        }
        MalObject *prototype = mal_object_get_prototype(mal_value_to_object(this_value));
        return prototype != nullptr ? mal_value_from_object(prototype) : mal_value_new_null();
    }

    // Primitive receivers answer with their wrapper prototype.
    MalObject *holder = mal_builtin_object_receiver_holder(vm, this_value);
    return holder != nullptr ? mal_value_from_object(holder) : mal_value_new_null();
}

static MalValue mal_builtin_object_proto_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }

    if (!mal_value_is_object(this_value) || arg_count < 1) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_object(args[0]) && !mal_value_is_null(args[0])) {
        return mal_value_new_undefined();
    }

    // B.2.2.1.2: O.[[SetPrototypeOf]](V). A proxy runs its trap (which may throw,
    // and reports success/failure); a failed set (non-extensible target, a cycle,
    // or a refusing trap) throws.
    if (mal_value_is_proxy_object(this_value)) {
        bool success;
        if (!mal_proxy_set_prototype_of(vm, mal_value_to_proxy_object(this_value), args[0], &success)) {
            return mal_value_new_undefined();
        }
        if (!success) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set prototype of object");
        }
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_is_object(args[0]) ? mal_value_to_object(args[0]) : nullptr;
    if (!mal_object_set_prototype(mal_value_to_object(this_value), prototype)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set prototype of non-extensible object");
    }

    return mal_value_new_undefined();
}

/**
 * Annex B __defineGetter__/__defineSetter__: define one accessor slot,
 * keeping the other slot when redefining over an existing accessor.
 */
static MalValue mal_builtin_object_prototype_define_accessor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool is_setter) {
    // 1. Let O be ? ToObject(this value): null/undefined throw, primitives box.
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.prototype.__defineGetter__/__defineSetter__ called on null or undefined");
        return mal_value_new_undefined();
    }
    MalValue object_value = mal_value_is_object(this_value) ? this_value : mal_builtin_object_box_primitive(vm, this_value);

    // 2. If the getter/setter is not callable, throw.
    if (arg_count < 2 || !mal_value_is_callable(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, is_setter ? "Setter must be a function" : "Getter must be a function");
        return mal_value_new_undefined();
    }

    // 3. key = ? ToPropertyKey(P).
    MalKey key;
    if (!mal_vm_to_property_key(vm, args[0], &key)) {
        return mal_value_new_undefined();
    }

    // 4. DefinePropertyOrThrow on a Proxy routes through its defineProperty trap.
    if (mal_value_is_proxy_object(object_value)) {
        MalObject *descriptor = mal_intrinsic_new_object(vm);
        MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
        mal_intrinsic_define_data(vm, descriptor, is_setter ? "set" : "get", args[1], flags);
        mal_intrinsic_define_data(vm, descriptor, "enumerable", mal_value_new_boolean(true), flags);
        mal_intrinsic_define_data(vm, descriptor, "configurable", mal_value_new_boolean(true), flags);
        mal_proxy_define_own_property(vm, mal_value_to_proxy_object(object_value), key, mal_value_from_object(descriptor));
        return mal_value_new_undefined();
    }

    MalObject *object = mal_value_to_object(object_value);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };

    MalPropertyLookup existing = mal_object_get_own(object, key);
    if (existing.present && (existing.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        desc.getter = existing.desc.getter;
        desc.setter = existing.desc.setter;
    }

    if (is_setter) {
        desc.setter = args[1];
    } else {
        desc.getter = args[1];
    }

    if (mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_REJECTED) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot redefine property");
    }

    return mal_value_new_undefined();
}

static MalValue mal_builtin_object_prototype_define_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_object_prototype_define_accessor(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_object_prototype_define_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_object_prototype_define_accessor(vm, this_value, args, arg_count, true);
}

/**
 * Annex B __lookupGetter__/__lookupSetter__: walk the prototype chain for an
 * accessor property and answer with the requested slot.
 */
static MalValue mal_builtin_object_prototype_lookup_accessor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool is_setter) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }

    MalValue object = mal_value_is_object(this_value) ? this_value : mal_builtin_object_box_primitive(vm, this_value);
    MalKey key;
    if (!mal_vm_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 0), &key)) {
        return mal_value_new_undefined();
    }

    // Walk the prototype chain via [[GetOwnProperty]]/[[GetPrototypeOf]]
    // (proxy-aware): an abrupt completion from a trap propagates.
    while (true) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, object, key, &present, &desc)) {
            return mal_value_new_undefined();
        }
        if (present) {
            if (!(desc.flags & MAL_PROPERTY_ACCESSOR)) {
                return mal_value_new_undefined();
            }
            return is_setter ? desc.setter : desc.getter;
        }

        MalValue prototype;
        if (mal_value_is_proxy_object(object)) {
            if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(object), &prototype)) {
                return mal_value_new_undefined();
            }
        } else {
            MalObject *p = mal_object_get_prototype(mal_value_to_object(object));
            prototype = p == nullptr ? mal_value_new_null() : mal_value_from_object(p);
        }
        if (mal_value_is_null(prototype)) {
            return mal_value_new_undefined();
        }
        object = prototype;
    }
}

static MalValue mal_builtin_object_prototype_lookup_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_object_prototype_lookup_accessor(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_object_prototype_lookup_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_object_prototype_lookup_accessor(vm, this_value, args, arg_count, true);
}

void mal_builtin_object_install(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    // %Object.prototype% is an immutable-prototype exotic object: its [[Prototype]]
    // (null) can never be reassigned.
    prototype->immutable_prototype = true;
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Object"),
        1,
        mal_builtin_object_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;
    vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_DEFINE_PROPERTY] =
        mal_intrinsic_define_method_n(vm, constructor_object, "defineProperty", 3, mal_builtin_object_define_property);
    mal_intrinsic_define_method_n(vm, constructor_object, "defineProperties", 2, mal_builtin_object_define_properties);
    mal_intrinsic_define_method_n(vm, constructor_object, "getOwnPropertyDescriptor", 2, mal_builtin_object_get_own_property_descriptor);
    mal_intrinsic_define_method_n(vm, constructor_object, "getOwnPropertyDescriptors", 1, mal_builtin_object_get_own_property_descriptors);
    mal_intrinsic_define_method_n(vm, constructor_object, "getOwnPropertyNames", 1, mal_builtin_object_get_own_property_names);
    mal_intrinsic_define_method_n(vm, constructor_object, "getOwnPropertySymbols", 1, mal_builtin_object_get_own_property_symbols);
    mal_intrinsic_define_method_n(vm, constructor_object, "keys", 1, mal_builtin_object_keys);
    mal_intrinsic_define_method_n(vm, constructor_object, "values", 1, mal_builtin_object_values);
    mal_intrinsic_define_method_n(vm, constructor_object, "entries", 1, mal_builtin_object_entries);
    mal_intrinsic_define_method_n(vm, constructor_object, "assign", 2, mal_builtin_object_assign);
    mal_intrinsic_define_method_n(vm, constructor_object, "create", 2, mal_builtin_object_create);
    mal_intrinsic_define_method_n(vm, constructor_object, "getPrototypeOf", 1, mal_builtin_object_get_prototype_of);
    mal_intrinsic_define_method_n(vm, constructor_object, "setPrototypeOf", 2, mal_builtin_object_set_prototype_of);
    mal_intrinsic_define_method_n(vm, constructor_object, "preventExtensions", 1, mal_builtin_object_prevent_extensions);
    mal_intrinsic_define_method_n(vm, constructor_object, "isExtensible", 1, mal_builtin_object_is_extensible);
    mal_intrinsic_define_method_n(vm, constructor_object, "freeze", 1, mal_builtin_object_freeze);
    mal_intrinsic_define_method_n(vm, constructor_object, "isFrozen", 1, mal_builtin_object_is_frozen);
    mal_intrinsic_define_method_n(vm, constructor_object, "seal", 1, mal_builtin_object_seal);
    mal_intrinsic_define_method_n(vm, constructor_object, "isSealed", 1, mal_builtin_object_is_sealed);
    mal_intrinsic_define_method_n(vm, constructor_object, "is", 2, mal_builtin_object_is);
    mal_intrinsic_define_method_n(vm, constructor_object, "hasOwn", 2, mal_builtin_object_has_own);
    mal_intrinsic_define_method_n(vm, constructor_object, "fromEntries", 1, mal_builtin_object_from_entries);
    mal_intrinsic_define_method_n(vm, constructor_object, "groupBy", 2, mal_builtin_object_group_by);

    mal_intrinsic_define_method_n(vm, prototype, "hasOwnProperty", 1, mal_builtin_object_prototype_has_own_property);
    mal_intrinsic_define_method_n(vm, prototype, "isPrototypeOf", 1, mal_builtin_object_prototype_is_prototype_of);
    mal_intrinsic_define_method_n(vm, prototype, "propertyIsEnumerable", 1, mal_builtin_object_prototype_property_is_enumerable);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_object_prototype_value_of);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_object_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_object_prototype_to_locale_string);
    mal_intrinsic_define_method_n(vm, prototype, "__defineGetter__", 2, mal_builtin_object_prototype_define_getter);
    mal_intrinsic_define_method_n(vm, prototype, "__defineSetter__", 2, mal_builtin_object_prototype_define_setter);
    mal_intrinsic_define_method_n(vm, prototype, "__lookupGetter__", 1, mal_builtin_object_prototype_lookup_getter);
    mal_intrinsic_define_method_n(vm, prototype, "__lookupSetter__", 1, mal_builtin_object_prototype_lookup_setter);

    // Annex B __proto__ is an accessor pair on Object.prototype.
    mal_intrinsic_define_accessor_n(
        vm, prototype, mal_intrinsic_string_key(vm, "__proto__"),
        "get __proto__", 0, mal_builtin_object_proto_getter,
        "set __proto__", 1, mal_builtin_object_proto_setter,
        MAL_PROPERTY_CONFIGURABLE);
}
