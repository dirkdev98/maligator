#include "builtin_object.h"

#include <math.h>
#include <stdlib.h>

#include "builtin_error.h"
#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "module_namespace_object.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_builtin_object_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

static bool mal_builtin_object_desc_get_value(MalVm *vm, MalObject *object, const byte *name, MalValue *out) {
    MalPropertyResolution resolution = mal_object_resolve_property(object, mal_intrinsic_string_key(vm, name));
    if (!resolution.found) {
        return false;
    }

    return mal_vm_desc_read(vm, resolution.desc, mal_value_from_object(object), out);
}

static bool mal_builtin_object_desc_get_bool(MalVm *vm, MalObject *object, const byte *name) {
    MalValue value;
    return mal_builtin_object_desc_get_value(vm, object, name, &value) && mal_value_is_truthy(value);
}

/**
 * ToPropertyDescriptor: parsed fields plus which ones the descriptor object
 * actually provided, so defines can merge with the current descriptor.
 */
typedef struct MalBuiltinObjectDescParse {
    bool ok;
    bool has_value, has_writable, has_get, has_set, has_enumerable, has_configurable;
    MalPropertyDesc desc;
} MalBuiltinObjectDescParse;

static MalBuiltinObjectDescParse mal_builtin_object_parse_descriptor(MalVm *vm, MalObject *descriptor) {
    MalBuiltinObjectDescParse parse = {
        .ok = true,
        .desc = mal_intrinsic_data_desc(mal_value_new_undefined(), MAL_PROPERTY_NONE),
    };
    MalValue field = mal_value_new_undefined();

    // ToPropertyDescriptor (6.2.6.5) reads fields in this order: enumerable,
    // configurable, value, writable, get, set — observable when they are getters.
    if (mal_builtin_object_desc_get_value(vm, descriptor, "enumerable", &field)) {
        parse.has_enumerable = true;
        if (mal_value_is_truthy(field)) {
            parse.desc.flags |= MAL_PROPERTY_ENUMERABLE;
        }
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "configurable", &field)) {
        parse.has_configurable = true;
        if (mal_value_is_truthy(field)) {
            parse.desc.flags |= MAL_PROPERTY_CONFIGURABLE;
        }
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "value", &field)) {
        parse.has_value = true;
        parse.desc.value = field;
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "writable", &field)) {
        parse.has_writable = true;
        if (mal_value_is_truthy(field)) {
            parse.desc.flags |= MAL_PROPERTY_WRITABLE;
        }
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "get", &field)) {
        if (!mal_value_is_callable(field) && !mal_value_is_undefined(field)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Getter must be a function");
            parse.ok = false;
            return parse;
        }
        parse.has_get = true;
        parse.desc.flags |= MAL_PROPERTY_ACCESSOR;
        parse.desc.getter = field;
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "set", &field)) {
        if (!mal_value_is_callable(field) && !mal_value_is_undefined(field)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Setter must be a function");
            parse.ok = false;
            return parse;
        }
        parse.has_set = true;
        parse.desc.flags |= MAL_PROPERTY_ACCESSOR;
        parse.desc.setter = field;
    }

    if ((parse.has_value || parse.has_writable) && (parse.has_get || parse.has_set)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Property descriptors must not specify a value or be writable when a getter or setter has been specified");
        parse.ok = false;
        return parse;
    }

    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        // A descriptor field getter threw; don't define from a torn read.
        parse.ok = false;
    }

    return parse;
}

MalDefineOwnStatus mal_builtin_object_try_define(MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value) {
    if (!mal_value_is_object(descriptor_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Property description must be an object");
        return MAL_DEFINE_OWN_REJECTED;
    }

    MalBuiltinObjectDescParse parse = mal_builtin_object_parse_descriptor(vm, mal_value_to_object(descriptor_value));
    if (!parse.ok) {
        return MAL_DEFINE_OWN_REJECTED;
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
            f64 number_length;
            if (!mal_vm_to_number(vm, parse.desc.value, &number_length)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            new_length = (u32) number_length;
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
    // out-of-bounds index is rejected; a valid one is a writable, enumerable,
    // configurable data property (narrowing any attribute, or an accessor, is
    // incompatible), and a [[Value]] writes the element — never the table.
    if (target->header.type == MAL_HEAP_TYPED_ARRAY_OBJECT) {
        MalTypedArrayObject *typed_array = (MalTypedArrayObject *) target;
        if (key.kind == MAL_KEY_INDEX) {
            i32 index = mal_value_to_i32(key.value);
            if (index < 0 || (u32) index >= mal_typed_array_object_length(typed_array)) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            if (parse.has_get || parse.has_set ||
                (parse.has_configurable && !(parse.desc.flags & MAL_PROPERTY_CONFIGURABLE)) ||
                (parse.has_enumerable && !(parse.desc.flags & MAL_PROPERTY_ENUMERABLE)) ||
                (parse.has_writable && !(parse.desc.flags & MAL_PROPERTY_WRITABLE))) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            if (parse.has_value) {
                mal_typed_array_object_set(vm, typed_array, (u32) index, parse.desc.value);
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
    }

    // Array exotic [[DefineOwnProperty]] for an index (10.4.2.1): defining at or
    // past length grows length — or is rejected outright when length is
    // non-writable. (The bytecode define op handles this on its own path.)
    bool grows_array_length = false;
    if (target->header.type == MAL_HEAP_ARRAY_OBJECT && key.kind == MAL_KEY_INDEX) {
        MalArrayObject *array = (MalArrayObject *) target;
        i32 index = mal_value_to_i32(key.value);
        if (index >= 0 && (u32) index >= mal_array_object_length(array)) {
            if (!array->length_writable) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            grows_array_length = true;
        }
    }

    MalDefineOwnStatus status = mal_object_define_own(target, key, &desc);
    if (status == MAL_DEFINE_OWN_APPLIED && grows_array_length) {
        mal_array_object_set_length((MalArrayObject *) target, (u32) mal_value_to_i32(key.value) + 1);
    }
    return status;
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

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(props), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        // Read each descriptor entry with Get, so an accessor descriptor source
        // (e.g. `{ get x() {…} }`) invokes its getter rather than seeing a raw slot.
        MalValue descriptor;
        if (!mal_vm_get_property(vm, props, key, &descriptor)) {
            return mal_value_new_undefined();
        }
        mal_builtin_object_define_from_value(vm, mal_value_to_object(args[0]), key, descriptor);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    return args[0];
}

/**
 * FromPropertyDescriptor: build the plain descriptor object for a property.
 */
MalValue mal_builtin_object_descriptor_object(MalVm *vm, MalPropertyDesc desc) {
    MalObject *result = mal_intrinsic_new_object(vm);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    if (desc.flags & MAL_PROPERTY_ACCESSOR) {
        mal_intrinsic_define_data(vm, result, "get", desc.getter, flags);
        mal_intrinsic_define_data(vm, result, "set", desc.setter, flags);
    } else {
        mal_intrinsic_define_data(vm, result, "value", desc.value, flags);
        mal_intrinsic_define_data(vm, result, "writable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_WRITABLE), flags);
    }

    mal_intrinsic_define_data(vm, result, "enumerable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_ENUMERABLE), flags);
    mal_intrinsic_define_data(vm, result, "configurable", mal_value_new_boolean(desc.flags & MAL_PROPERTY_CONFIGURABLE), flags);

    return mal_value_from_object(result);
}

// [[GetOwnProperty]] → a descriptor object (or undefined), routing through a
// Proxy's getOwnPropertyDescriptor trap, module-namespace exports, TypedArray /
// String-wrapper exotics, then the ordinary property table. `target` must
// already be an object (ToObject the caller's argument first).
static MalValue mal_builtin_object_own_descriptor(MalVm *vm, MalValue target, MalKey key) {
    if (mal_value_is_proxy_object(target)) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(target), key, &present, &desc)) {
            return mal_value_new_undefined();
        }
        return present ? mal_builtin_object_descriptor_object(vm, desc) : mal_value_new_undefined();
    }

    // Module namespace descriptors: exports are { value: live, writable: true,
    // enumerable: true, configurable: false }; @@toStringTag is the non-writable,
    // non-enumerable, non-configurable "Module".
    if (mal_value_is_module_namespace_object(target)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(target);
        MalKey tag = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG);
        if (key.kind == MAL_KEY_SYMBOL && key.value == tag.value) {
            MalPropertyDesc desc = {
                .value = mal_value_from_string(mal_intrinsic_ascii(vm, "Module")),
                .flags = 0,
            };
            return mal_builtin_object_descriptor_object(vm, desc);
        }
        if (key.kind == MAL_KEY_STRING) {
            MalString *name = mal_value_to_string(key.value);
            for (i32 i = 0; i < ns->export_count; i++) {
                if (mal_string_equals(name, ns->exports[i].name)) {
                    MalValue live = vm->globals[ns->exports[i].slot];
                    if (mal_value_is_empty(live)) {
                        mal_vm_throw_error(
                            vm,
                            MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                            "Cannot access module export before initialization"
                        );
                        return mal_value_new_undefined();
                    }
                    MalPropertyDesc desc = {
                        .value = live,
                        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE,
                    };
                    return mal_builtin_object_descriptor_object(vm, desc);
                }
            }
        }
        return mal_value_new_undefined();
    }

    // TypedArray integer indices are exotic data properties { writable, enumerable,
    // configurable }; an out-of-bounds numeric index has no descriptor (and is
    // never an ordinary table property).
    if (mal_value_is_typed_array_object(target) && key.kind == MAL_KEY_INDEX) {
        MalTypedArrayObject *typed_array = mal_value_to_typed_array_object(target);
        i32 index = mal_value_to_i32(key.value);
        if (index >= 0 && (u32) index < mal_typed_array_object_length(typed_array)) {
            MalPropertyDesc desc = {
                .value = mal_typed_array_object_get(vm, typed_array, (u32) index),
                .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
            };
            return mal_builtin_object_descriptor_object(vm, desc);
        }
        return mal_value_new_undefined();
    }
    // A canonical-numeric string key on a TypedArray that is not a valid index
    // has no own property (and is never table-backed).
    if (mal_value_is_typed_array_object(target) && key.kind == MAL_KEY_STRING &&
        mal_vm_string_is_canonical_numeric_index(vm, mal_value_to_string(key.value))) {
        return mal_value_new_undefined();
    }

    // An Array's `length` is an exotic own data property kept in the array header
    // (not the table): non-enumerable, non-configurable, writable per the array.
    if (mal_value_is_array_object(target) && mal_array_key_is_length(key)) {
        MalArrayObject *array = mal_value_to_array_object(target);
        MalPropertyDesc desc = {
            .value = mal_ops_number_value((f64) mal_array_object_length(array)),
            .flags = array->length_writable ? MAL_PROPERTY_WRITABLE : 0,
        };
        return mal_builtin_object_descriptor_object(vm, desc);
    }

    // String wrapper exotic index/length own properties are not in the table.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, mal_value_to_object(target), key, &string_exotic)) {
        return mal_builtin_object_descriptor_object(vm, string_exotic);
    }

    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(target), key);
    if (!lookup.present) {
        return mal_value_new_undefined();
    }

    return mal_builtin_object_descriptor_object(vm, lookup.desc);
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
static bool mal_builtin_object_descriptors_put(MalVm *vm, MalObject *result, MalValue target, MalKey key) {
    MalValue descriptor = mal_builtin_object_own_descriptor(vm, target, key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    if (mal_value_is_undefined(descriptor)) {
        return true;
    }
    MalPropertyDesc entry = mal_intrinsic_data_desc(
        descriptor,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(result, key, &entry);
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

    MalObject *result = mal_intrinsic_new_object(vm);

    // Enumerate own keys via [[OwnPropertyKeys]] and call [[GetOwnProperty]] on
    // each (Proxy traps, TypedArray / String-wrapper exotics, then the table).
    if (mal_value_is_proxy_object(target)) {
        MalValue keys_value;
        if (!mal_proxy_own_property_keys(vm, mal_value_to_proxy_object(target), &keys_value)) {
            return mal_value_new_undefined();
        }
        u32 key_count = mal_array_object_length(mal_value_to_array_object(keys_value));
        for (u32 i = 0; i < key_count; i++) {
            MalValue key_value;
            if (!mal_vm_get_property(vm, keys_value, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &key_value)) {
                return mal_value_new_undefined();
            }
            MalKey key;
            if (!mal_vm_to_property_key(vm, key_value, &key)) {
                return mal_value_new_undefined();
            }
            if (!mal_builtin_object_descriptors_put(vm, result, target, key)) {
                return mal_value_new_undefined();
            }
        }
        return mal_value_from_object(result);
    }

    MalObject *object = mal_value_to_object(target);

    // TypedArray exotic integer indices precede the ordinary table keys.
    if (mal_value_is_typed_array_object(target)) {
        u32 ta_length = mal_typed_array_object_length(mal_value_to_typed_array_object(target));
        for (u32 i = 0; i < ta_length; i++) {
            if (!mal_builtin_object_descriptors_put(vm, result, target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)})) {
                return mal_value_new_undefined();
            }
        }
    }

    // String wrapper exotic index data properties, then its `length`.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, object, mal_intrinsic_string_key(vm, "length"), &string_exotic)) {
        u32 string_length = (u32) mal_value_to_i32(string_exotic.value);
        for (u32 i = 0; i < string_length; i++) {
            if (!mal_builtin_object_descriptors_put(vm, result, target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)})) {
                return mal_value_new_undefined();
            }
        }
        if (!mal_builtin_object_descriptors_put(vm, result, target, mal_intrinsic_string_key(vm, "length"))) {
            return mal_value_new_undefined();
        }
    }

    // An Array's exotic `length` is an own (non-enumerable) string key right after
    // the integer indices; getOwnPropertyDescriptors must report its descriptor.
    bool length_pending = mal_value_is_array_object(target);

    // Ordinary table keys (string and symbol, including non-enumerable).
    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        // Private-member symbols never surface through reflection.
        if (key.kind == MAL_KEY_SYMBOL && mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        if (length_pending && key.kind != MAL_KEY_INDEX) {
            if (!mal_builtin_object_descriptors_put(vm, result, target, mal_intrinsic_string_key(vm, "length"))) {
                return mal_value_new_undefined();
            }
            length_pending = false;
        }
        if (!mal_builtin_object_descriptors_put(vm, result, target, key)) {
            return mal_value_new_undefined();
        }
    }

    if (length_pending) {
        if (!mal_builtin_object_descriptors_put(vm, result, target, mal_intrinsic_string_key(vm, "length"))) {
            return mal_value_new_undefined();
        }
    }

    return mal_value_from_object(result);
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

// Fills `result` with the collected keys/values/entries; returns false with a
// pending throw on an abrupt step. `result` is rooted by the caller wrapper
// (mal_builtin_object_collect) across the getter/trap re-entry below.
static bool mal_builtin_object_collect_impl(MalVm *vm, MalValue target, MalPropertyIterKind iter_kind, MalBuiltinObjectCollect collect, MalArrayObject *result) {
    // A proxy's keys come from its ownKeys trap; only string keys participate in
    // these string-keyed collections, and for-key collections that filter to
    // enumerable own properties (Object.keys/values/entries) re-check each key's
    // descriptor through the getOwnPropertyDescriptor trap.
    if (mal_value_is_proxy_object(target)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(target);
        MalValue keys_value;
        if (!mal_proxy_own_property_keys(vm, proxy, &keys_value)) {
            return mal_value_new_undefined();
        }
        MalArrayObject *keys = mal_value_to_array_object(keys_value);
        u32 key_count = mal_array_object_length(keys);
        bool enumerable_only = iter_kind == MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER;
        // keys_value (the ownKeys array) is held across the trap/getter re-entry
        // below; root it (result is rooted by the wrapper).
        MalRootSpan keys_span;
        mal_gc_root(&keys_span, &keys_value, 1);
        u32 out = 0;
        bool ok = true;
        for (u32 i = 0; i < key_count; i++) {
            MalValue key_value;
            if (!mal_vm_get_property(vm, keys_value, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &key_value)) {
                ok = false;
                break;
            }
            if (!mal_value_is_string(key_value)) {
                continue;
            }
            MalKey key;
            if (!mal_vm_to_property_key(vm, key_value, &key)) {
                ok = false;
                break;
            }
            bool present;
            MalPropertyDesc desc;
            if (enumerable_only || collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
                if (!mal_proxy_get_own_property_descriptor(vm, proxy, key, &present, &desc)) {
                    ok = false;
                    break;
                }
                if (enumerable_only && (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE))) {
                    continue;
                }
            }
            MalValue element = key_value;
            if (collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
                MalValue value;
                if (!mal_vm_get_property(vm, target, key, &value)) {
                    ok = false;
                    break;
                }
                element = value;
                if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
                    MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, key_value);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, value);
                    element = mal_value_from_array_object(entry);
                }
            }
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) out++)}, element);
        }
        mal_gc_unroot(&keys_span);
        return ok;
    }

    // A module namespace's own keys are its sorted string exports (all
    // enumerable); values/entries read each export live (which may throw on a
    // binding still in its TDZ).
    if (mal_value_is_module_namespace_object(target)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(target);
        for (i32 i = 0; i < ns->export_count; i++) {
            MalValue name = mal_value_from_string(ns->exports[i].name);
            MalValue element = name;
            if (collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS) {
                MalValue value;
                if (!mal_vm_get_property(vm, target, (MalKey) {.kind = MAL_KEY_STRING, .value = name}, &value)) {
                    return false;
                }
                element = value;
                if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
                    MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, name);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, value);
                    element = mal_value_from_array_object(entry);
                }
            }
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)}, element);
        }
        return true;
    }

    if (!mal_value_is_object(target)) {
        // ToObject: null/undefined throw; other primitives box (a String box
        // contributes its index chars + length via the exotic path below).
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

    MalObject *object = mal_value_to_object(target);

    // EnumerableOwnProperties snapshots the key list first; for value/entry
    // collection a getter may mutate the object while we read, but only the
    // snapshotted keys are visited (and re-checked for own-enumerability).
    bool reads_values = collect != MAL_BUILTIN_OBJECT_COLLECT_KEYS;
    MalKey *keys = nullptr;
    usize key_count = 0;
    usize key_capacity = 0;

    u32 count = 0;

    // A String wrapper's exotic own keys are its indices, then the
    // non-enumerable `length`; they precede the ordinary table keys and are
    // never table-backed. Object.keys/values/entries see only the enumerable
    // indices; Object.getOwnPropertyNames (the non-enumerable view) also lists
    // `length`.
    bool enumerable_only = iter_kind == MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER;

    // A TypedArray's own keys begin with its canonical integer indices (each an
    // enumerable, writable, configurable data property — so they show in every
    // view), ahead of the ordinary table keys. They are exotic, never table-backed.
    if (mal_value_is_typed_array_object(target)) {
        MalTypedArrayObject *typed_array = mal_value_to_typed_array_object(target);
        u32 typed_length = mal_typed_array_object_length(typed_array);
        for (u32 i = 0; i < typed_length; i++) {
            MalKey index_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
            MalValue index_string = mal_builtin_object_key_to_string(vm, index_key);
            MalValue element = index_string;
            if (reads_values) {
                MalValue value = mal_typed_array_object_get(vm, typed_array, i);
                element = value;
                if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
                    MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, index_string);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, value);
                    element = mal_value_from_array_object(entry);
                }
            }
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)}, element);
        }
    }

    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap, object, mal_intrinsic_string_key(vm, "length"), &string_exotic
        )) {
        u32 string_length = (u32) mal_value_to_i32(string_exotic.value);
        for (u32 i = 0; i < string_length; i++) {
            MalKey index_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
            MalValue index_string = mal_builtin_object_key_to_string(vm, index_key);
            MalValue element = index_string;
            if (reads_values) {
                MalPropertyDesc index_desc;
                mal_primitive_wrapper_string_exotic_own(&vm->heap, object, index_key, &index_desc);
                element = index_desc.value;
                if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
                    MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, index_string);
                    mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, index_desc.value);
                    element = mal_value_from_array_object(entry);
                }
            }
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)}, element);
        }
        // `length` is non-enumerable, so only the key-listing non-enumerable
        // view (getOwnPropertyNames) reports it.
        if (!enumerable_only && !reads_values) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(mal_intrinsic_ascii(vm, "length"))
            );
        }
    }

    // An Array's exotic `length` is a non-enumerable own string key that sits
    // right after the integer-index keys in own-key order, so only the key-listing
    // non-enumerable view (getOwnPropertyNames) reports it — emit it before the
    // first non-index table key (or after the indices if there are none).
    bool length_pending = mal_value_is_array_object(target) && !enumerable_only && !reads_values;

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, iter_kind);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        // Symbol keys are excluded from string-keyed property collections.
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }

        if (reads_values) {
            // Defer value reads until the key list is fully snapshotted.
            if (key_count == key_capacity) {
                key_capacity = key_capacity == 0 ? 8 : key_capacity * 2;
                keys = realloc(keys, sizeof(MalKey) * key_capacity);
            }
            keys[key_count++] = key;
            continue;
        }

        if (length_pending && key.kind != MAL_KEY_INDEX) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(mal_intrinsic_ascii(vm, "length"))
            );
            length_pending = false;
        }

        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)},
            mal_builtin_object_key_to_string(vm, key)
        );
        count++;
    }

    // An array with only integer-index keys still lists `length` after them.
    if (length_pending) {
        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_value_from_string(mal_intrinsic_ascii(vm, "length"))
        );
        length_pending = false;
    }

    // A getter during the value reads can delete a sibling key, dropping it from
    // the object's table — its only other root. MalKey isn't a MalValue, so mirror
    // the snapshotted key values into a parallel array and root that across the
    // loop. (Symbol keys were skipped above; remaining keys are STRING/INDEX.)
    MalValue *key_values = key_count > 0 ? malloc(sizeof(MalValue) * key_count) : nullptr;
    for (usize i = 0; i < key_count; i++) {
        key_values[i] = keys[i].value;
    }
    MalRootSpan keys_span;
    mal_gc_root(&keys_span, key_values, (i32) key_count);
    bool ok = true;

    for (usize i = 0; i < key_count; i++) {
        // Re-resolve: a property deleted or made non-enumerable mid-read is
        // skipped, matching the spec's "still has the key" check.
        MalPropertyLookup lookup = mal_object_get_own(object, keys[i]);
        if (!lookup.present || !(lookup.desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            continue;
        }

        MalValue value;
        if (!mal_vm_desc_read(vm, lookup.desc, target, &value)) {
            ok = false;
            break;
        }

        MalValue element = value;
        if (collect == MAL_BUILTIN_OBJECT_COLLECT_ENTRIES) {
            MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
            mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_builtin_object_key_to_string(vm, keys[i]));
            mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, value);
            element = mal_value_from_array_object(entry);
        }

        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)}, element);
        count++;
    }

    mal_gc_unroot(&keys_span);
    free(key_values);
    free(keys);
    return ok;
}

// Object.keys/values/entries (+ getOwnPropertyNames) collector. The result array
// is held across getter / proxy-trap re-entry that the body performs, so root it
// and lift this builtin's GC suppression around the collection.
static MalValue mal_builtin_object_collect(MalVm *vm, MalValue target, MalPropertyIterKind iter_kind, MalBuiltinObjectCollect collect) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    MalValue result_box = mal_value_from_array_object(result);
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

static MalValue mal_builtin_object_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_VALUES
    );
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

// Copy one own enumerable key from source to target: Get (invoking a getter /
// Proxy trap) then Set(to, key, value, true) (invoking a target setter and
// throwing on a failed write), per the Object.assign copy step.
static bool mal_builtin_object_assign_copy(MalVm *vm, MalValue target, MalKey key, MalValue source) {
    MalValue value;
    if (!mal_vm_get_property(vm, source, key, &value)) {
        return false;
    }
    if (!mal_vm_set_property(vm, target, key, value, target)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        }
        return false;
    }
    return true;
}

// CopyDataProperties from one (already ToObject'd) source: enumerate own keys
// via the source's [[OwnPropertyKeys]] / [[GetOwnProperty]] so Proxy traps fire,
// a TypedArray's / String wrapper's exotic indices are seen, and both string and
// symbol keys are copied (Object.assign copies symbol-keyed properties too).
static bool mal_builtin_object_assign_from(MalVm *vm, MalValue target, MalValue source) {
    if (mal_value_is_proxy_object(source)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(source);
        MalValue keys_value;
        if (!mal_proxy_own_property_keys(vm, proxy, &keys_value)) {
            return false;
        }
        // keys_value (the ownKeys array) is held across the trap/getter re-entry of
        // the copy loop; root it. (target/source are rooted by the assign wrapper.)
        MalRootSpan keys_span;
        mal_gc_root(&keys_span, &keys_value, 1);
        u32 key_count = mal_array_object_length(mal_value_to_array_object(keys_value));
        bool ok = true;
        for (u32 i = 0; i < key_count; i++) {
            MalValue key_value;
            if (!mal_vm_get_property(vm, keys_value, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &key_value)) {
                ok = false;
                break;
            }
            MalKey key;
            if (!mal_vm_to_property_key(vm, key_value, &key)) {
                ok = false;
                break;
            }
            bool present;
            MalPropertyDesc desc;
            if (!mal_proxy_get_own_property_descriptor(vm, proxy, key, &present, &desc)) {
                ok = false;
                break;
            }
            if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }
            if (!mal_builtin_object_assign_copy(vm, target, key, source)) {
                ok = false;
                break;
            }
        }
        mal_gc_unroot(&keys_span);
        return ok;
    }

    MalObject *object = mal_value_to_object(source);

    // A TypedArray's exotic integer indices come first and are all enumerable.
    if (mal_value_is_typed_array_object(source)) {
        u32 ta_length = mal_typed_array_object_length(mal_value_to_typed_array_object(source));
        for (u32 i = 0; i < ta_length; i++) {
            if (!mal_builtin_object_assign_copy(vm, target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, source)) {
                return false;
            }
        }
    }

    // A String wrapper exposes its code units as enumerable indexed own data
    // properties (its `length` is non-enumerable, so it is not copied).
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, object, mal_intrinsic_string_key(vm, "length"), &string_exotic)) {
        u32 string_length = (u32) mal_value_to_i32(string_exotic.value);
        for (u32 i = 0; i < string_length; i++) {
            if (!mal_builtin_object_assign_copy(vm, target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, source)) {
                return false;
            }
        }
    }

    // Ordinary table keys (strings then symbols). Snapshot the enumerable own
    // keys before copying, since a target setter may mutate the source mid-copy.
    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey *keys = nullptr;
    usize key_count = 0;
    usize key_capacity = 0;
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key_count == key_capacity) {
            key_capacity = key_capacity == 0 ? 8 : key_capacity * 2;
            keys = realloc(keys, sizeof(MalKey) * key_capacity);
        }
        keys[key_count++] = key;
    }
    // A target setter (or source getter) during the copy can collect; root the
    // snapshotted keys (parallel MalValue array — these may be string or symbol)
    // across the loop so a deleted key's name cannot dangle.
    MalValue *key_values = key_count > 0 ? malloc(sizeof(MalValue) * key_count) : nullptr;
    for (usize i = 0; i < key_count; i++) {
        key_values[i] = keys[i].value;
    }
    MalRootSpan keys_span;
    mal_gc_root(&keys_span, key_values, (i32) key_count);
    bool ok = true;
    for (usize i = 0; i < key_count; i++) {
        if (!mal_builtin_object_assign_copy(vm, target, keys[i], source)) {
            ok = false;
            break;
        }
    }
    mal_gc_unroot(&keys_span);
    free(key_values);
    free(keys);
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
    MalObject *result = mal_object_new(&vm->heap, prototype);

    MalValue properties = mal_builtin_object_arg(args, arg_count, 1);
    if (mal_value_is_object(properties)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(properties), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            // ObjectDefineProperties reads each descriptor entry with Get.
            MalValue descriptor;
            if (!mal_vm_get_property(vm, properties, key, &descriptor)) {
                return mal_value_new_undefined();
            }
            mal_builtin_object_define_from_value(vm, result, key, descriptor);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
        }
    }

    return mal_value_from_object(result);
}

static MalValue mal_builtin_object_get_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // ToObject(O): null/undefined throw, other primitives box (so
    // Object.getPrototypeOf("x") is String.prototype, etc.).
    MalValue target = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(target)) {
        if (mal_value_is_nil(target)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
            return mal_value_new_undefined();
        }
        target = mal_builtin_object_box_primitive(vm, target);
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

/**
 * SetIntegrityLevel: clear CONFIGURABLE (and for freeze WRITABLE on data
 * properties) on every own property, then make the object non-extensible.
 */
static MalValue mal_builtin_object_set_integrity(const MalValue *args, i32 arg_count, bool clear_writable) {
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    MalObject *object = mal_value_to_object(args[0]);
    // Seal/freeze clears configurable (and writable) per element — attributes the
    // dense vector cannot express. Demote a dense array's elements into the table
    // first so the loop below can rewrite their descriptors.
    if (mal_value_is_array_object(args[0])) {
        mal_object_array_deoptimize(mal_value_to_array_object(args[0]));
    }
    MalTable *table = mal_object_properties(object);
    usize count = mal_table_size(table);
    MalKey *keys = malloc(sizeof(MalKey) * count);
    usize key_count = 0;

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (key_count < count && mal_property_iter_next(&iter, &key, &desc)) {
        keys[key_count++] = key;
    }

    for (usize i = 0; i < key_count; i++) {
        MalPropertyLookup lookup = mal_object_get_own(object, keys[i]);
        if (!lookup.present) {
            continue;
        }

        MalPropertyDesc frozen = lookup.desc;
        frozen.flags &= ~MAL_PROPERTY_CONFIGURABLE;
        if (clear_writable && !(frozen.flags & MAL_PROPERTY_ACCESSOR)) {
            frozen.flags &= ~MAL_PROPERTY_WRITABLE;
        }

        mal_property_write_entry(table, lookup.entry, &frozen);
    }

    free(keys);

    // An Array's exotic `length` lives in the header, not the table: freezing
    // (clear_writable) makes it non-writable. It is already non-configurable, so
    // sealing needs no change.
    if (clear_writable && mal_value_is_array_object(args[0])) {
        mal_value_to_array_object(args[0])->length_writable = false;
    }

    mal_object_set_extensible(object, false);
    return args[0];
}

/**
 * TestIntegrityLevel: non-extensible with no configurable (and for frozen no
 * writable data) own properties.
 */
static MalValue mal_builtin_object_test_integrity(const MalValue *args, i32 arg_count, bool check_writable) {
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(true);
    }

    MalObject *object = mal_value_to_object(args[0]);
    if (mal_object_is_extensible(object)) {
        return mal_value_new_boolean(false);
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (desc.flags & MAL_PROPERTY_CONFIGURABLE) {
            return mal_value_new_boolean(false);
        }
        if (check_writable && !(desc.flags & MAL_PROPERTY_ACCESSOR) && (desc.flags & MAL_PROPERTY_WRITABLE)) {
            return mal_value_new_boolean(false);
        }
    }

    // An Array with a writable exotic `length` is not frozen (its length is
    // always non-configurable, so it does not affect sealing).
    if (check_writable && mal_value_is_array_object(args[0]) &&
        mal_value_to_array_object(args[0])->length_writable) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(true);
}

static MalValue mal_builtin_object_freeze(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_object_set_integrity(args, arg_count, true);
}

static MalValue mal_builtin_object_seal(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_object_set_integrity(args, arg_count, false);
}

static MalValue mal_builtin_object_is_frozen(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_object_test_integrity(args, arg_count, true);
}

static MalValue mal_builtin_object_is_sealed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_object_test_integrity(args, arg_count, false);
}

static bool mal_builtin_object_is_negative_zero(MalValue value) {
    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && mal_value_to_f64(value) == 0.0 && signbit(mal_value_to_f64(value));
}

static MalValue mal_builtin_object_is(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    MalValue left = mal_builtin_object_arg(args, arg_count, 0);
    MalValue right = mal_builtin_object_arg(args, arg_count, 1);

    if (mal_value_is_nan(left) && mal_value_is_nan(right)) {
        return mal_value_new_boolean(true);
    }

    if (mal_builtin_object_is_negative_zero(left) != mal_builtin_object_is_negative_zero(right)) {
        return mal_value_new_boolean(false);
    }

    return mal_ops_strict_equal(left, right);
}

// HasOwnProperty(O, key): O.[[GetOwnProperty]](key) is not undefined. `object`
// must already be an object; routes through Proxy traps and TypedArray / String
// exotics via [[GetOwnProperty]].
static MalValue mal_builtin_object_has_own_resolved(MalVm *vm, MalValue object, MalKey key) {
    MalValue descriptor = mal_builtin_object_own_descriptor(vm, object, key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(!mal_value_is_undefined(descriptor));
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

    MalValue descriptor = mal_builtin_object_own_descriptor(vm, target, key);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(descriptor)) {
        return mal_value_new_boolean(false);
    }
    MalValue enumerable;
    if (!mal_vm_get_property(vm, descriptor, mal_intrinsic_string_key(vm, "enumerable"), &enumerable)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(mal_value_is_truthy(enumerable));
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
    bool proxy_is_array = false;
    if (mal_value_is_proxy_object(this_value)) {
        MalValue unwrapped = this_value;
        while (mal_value_is_proxy_object(unwrapped)) {
            MalValue inner = mal_proxy_unwrap_target(unwrapped);
            if (mal_value_is_proxy_object(inner) && inner == unwrapped) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot perform IsArray on a revoked Proxy");
                return mal_value_new_undefined();
            }
            unwrapped = inner;
        }
        proxy_is_array = mal_value_is_array_object(unwrapped);
    }

    if (mal_value_is_undefined(this_value)) {
        tag = "[object Undefined]";
    } else if (mal_value_is_null(this_value)) {
        tag = "[object Null]";
    } else if (mal_value_is_array_object(this_value) || proxy_is_array) {
        tag = "[object Array]";
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
            MalValue text = mal_value_from_string(mal_intrinsic_ascii(vm, "[object "));
            text = mal_ops_add(&vm->heap, text, tag_value);
            return mal_ops_add(&vm->heap, text, mal_value_from_string(mal_intrinsic_ascii(vm, "]")));
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

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    if (!mal_value_is_object(target)) {
        return mal_value_from_array_object(result);
    }

    // A proxy's keys come from its ownKeys trap; filter to the symbol keys.
    if (mal_value_is_proxy_object(target)) {
        MalValue keys_value;
        if (!mal_proxy_own_property_keys(vm, mal_value_to_proxy_object(target), &keys_value)) {
            return mal_value_new_undefined();
        }
        u32 key_count = mal_array_object_length(mal_value_to_array_object(keys_value));
        u32 out = 0;
        for (u32 i = 0; i < key_count; i++) {
            MalValue key_value;
            if (!mal_vm_get_property(vm, keys_value, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &key_value)) {
                return mal_value_new_undefined();
            }
            if (!mal_value_is_symbol(key_value)) {
                continue;
            }
            mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) out++)}, key_value);
        }
        return mal_value_from_array_object(result);
    }

    // A module namespace's only symbol key is @@toStringTag.
    if (mal_value_is_module_namespace_object(target)) {
        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)},
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG).value
        );
        return mal_value_from_array_object(result);
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(target), MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

    u32 count = 0;
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) {
            continue;
        }

        // Private-member symbols are an implementation detail and stay hidden
        // from reflection.
        if (mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }

        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)}, key.value);
        count++;
    }

    return mal_value_from_array_object(result);
}

/**
 * Read an indexed element through the prototype chain and accessor getters.
 * Absent elements and getter throws both read as undefined.
 */
static MalValue mal_builtin_object_indexed(MalVm *vm, MalValue target, u32 index) {
    if (!mal_value_is_object(target)) {
        return mal_value_new_undefined();
    }

    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(target),
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}
    );
    if (!resolution.found) {
        return mal_value_new_undefined();
    }

    MalValue out = mal_value_new_undefined();
    mal_vm_desc_read(vm, resolution.desc, target, &out);
    return out;
}

static MalValue mal_builtin_object_from_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    // A missing argument throws through GetIterator on undefined.
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    MalObject *result = mal_intrinsic_new_object(vm);
    while (true) {
        MalValue entry;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &entry, &done)) {
            return mal_value_new_undefined();
        }

        if (done) {
            return mal_value_from_object(result);
        }

        if (!mal_value_is_object(entry)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator value is not an entry object");
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalValue key_value;
        MalValue value;
        if (!mal_vm_get_property(vm, entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, &key_value) ||
            !mal_vm_get_property(vm, entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, &value)) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalKey key;
        if (!mal_vm_to_property_key(vm, key_value, &key)) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        mal_object_set(result, key, value);
    }
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

    // Groups live on a null-prototype object.
    MalObject *result = mal_object_new(&vm->heap, nullptr);
    i32 index = 0;
    while (true) {
        MalValue element;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &element, &done)) {
            return mal_value_new_undefined();
        }

        if (done) {
            return mal_value_from_object(result);
        }

        MalValue callback_args[] = {element, mal_value_from_i32(index)};
        index++;
        MalCompletion completion = mal_vm_call_value(vm, args[1], mal_value_new_undefined(), callback_args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalKey key;
        if (!mal_vm_to_property_key(vm, completion.value, &key)) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalPropertyLookup existing = mal_object_get_own(result, key);
        MalArrayObject *group;
        if (existing.present) {
            group = mal_value_to_array_object(existing.desc.value);
        } else {
            group = mal_intrinsic_new_array(vm, 0);
            mal_object_set(result, key, mal_value_from_array_object(group));
        }

        mal_array_object_store(
            group,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) mal_array_object_length(group))},
            element
        );
    }
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

    return nullptr;
}

static MalValue mal_builtin_object_prototype_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Object.prototype.toLocaleString called on null or undefined");
        return mal_value_new_undefined();
    }

    MalObject *holder = mal_builtin_object_receiver_holder(vm, this_value);
    MalValue to_string = mal_value_new_undefined();
    if (holder != nullptr) {
        MalPropertyResolution resolution = mal_object_resolve_property(holder, mal_intrinsic_string_key(vm, "toString"));
        if (resolution.found && !mal_vm_desc_read(vm, resolution.desc, this_value, &to_string)) {
            return mal_value_new_undefined();
        }
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
        if (mal_value_is_proxy_object(object)) {
            if (!mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(object), key, &present, &desc)) {
                return mal_value_new_undefined();
            }
        } else {
            MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object), key);
            present = lookup.present;
            desc = lookup.desc;
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
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc proto_desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            function_prototype,
            mal_intrinsic_ascii(vm, "get __proto__"),
            mal_builtin_object_proto_getter
        )),
        .setter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            function_prototype,
            mal_intrinsic_ascii(vm, "set __proto__"),
            mal_builtin_object_proto_setter
        )),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "__proto__"), &proto_desc);
}
