#include "builtin_bigint.h"

#include <math.h>

#include "heap_bigint.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * ToPrimitive(value, hint Number): if `value` is an object, invoke
 * @@toPrimitive("number") when present, else OrdinaryToPrimitive in the
 * valueOf → toString order. Writes the resulting primitive to *out. Returns
 * false (leaving the throw on vm->completion) when a callback threw, when
 * @@toPrimitive is present-but-not-callable, when @@toPrimitive returns an
 * object, or when neither valueOf nor toString yields a primitive. A primitive
 * input is passed through unchanged.
 *
 * Mirrors the ToPrimitive embedded in mal_vm_to_number (vm_ops.c); kept local
 * because ToBigInt needs the *typed* primitive (a String must be parsed, a
 * BigInt accepted), which a ToNumber that collapses everything to f64 loses.
 */
static bool mal_bigint_to_primitive(MalVm *vm, MalValue value, MalValue *out) {
    if (!mal_value_is_object(value)) {
        *out = value;
        return true;
    }

    MalValue exotic;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
        return false;
    }
    if (!mal_value_is_nil(exotic)) {
        if (!mal_value_is_callable(exotic)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
            return false;
        }
        MalValue hint = mal_value_from_string(mal_intrinsic_ascii(vm, "number"));
        MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint, 1);
        if (result.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
        if (mal_value_is_object(result.value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
            return false;
        }
        *out = result.value;
        return true;
    }

    // OrdinaryToPrimitive(value, "number"): valueOf, then toString.
    const byte *methods[2] = {"valueOf", "toString"};
    for (i32 i = 0; i < 2; i++) {
        MalValue method;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
            return false;
        }
        if (mal_value_is_callable(method)) {
            MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return false;
            }
            if (!mal_value_is_object(result.value)) {
                *out = result.value;
                return true;
            }
        }
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
    return false;
}

/**
 * Dispatch a *primitive* through the type-specific tail of ToBigInt: Boolean →
 * 0n/1n, BigInt → itself, String → StringToBigInt (SyntaxError when
 * unparseable). undefined, null, Number, and Symbol all throw TypeError.
 */
static bool mal_bigint_primitive_to_bigint(MalVm *vm, MalValue value, i128 *out) {
    if (mal_value_is_bigint(value)) {
        *out = mal_bigint_value(mal_value_to_bigint(value));
        return true;
    }

    if (mal_value_is_boolean(value)) {
        *out = mal_value_to_boolean(value) ? 1 : 0;
        return true;
    }

    if (mal_value_is_string(value)) {
        bool ok;
        MalString *string = mal_value_to_string(value);
        i128 parsed = mal_bigint_parse(mal_string_code_units(string), mal_string_length(string), &ok);
        if (!ok) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot convert string to a BigInt");
            return false;
        }
        *out = parsed;
        return true;
    }

    // Number, Symbol, undefined, and null all fail ToBigInt.
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert value to a BigInt");
    return false;
}

bool mal_bigint_to_bigint(MalVm *vm, MalValue value, i128 *out) {
    MalValue primitive;
    if (!mal_bigint_to_primitive(vm, value, &primitive)) {
        return false;
    }

    return mal_bigint_primitive_to_bigint(vm, primitive, out);
}

static MalValue mal_builtin_bigint_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "BigInt is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    // 2. Let prim be ? ToPrimitive(value, number).
    MalValue primitive;
    if (!mal_bigint_to_primitive(vm, value, &primitive)) {
        return mal_value_new_undefined();
    }

    // 3. If prim is a Number, return ? NumberToBigInt(prim): an integral Number
    // becomes the matching BigInt, anything else (NaN, ±Infinity, fractional)
    // is a RangeError.
    if (mal_ops_is_number(primitive)) {
        f64 number = mal_ops_number_as_f64(primitive);
        if (isnan(number) || isinf(number) || trunc(number) != number) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The number is not a safe integer");
            return mal_value_new_undefined();
        }
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) number));
    }

    // 4. Otherwise, return ? ToBigInt(prim).
    i128 result;
    if (!mal_bigint_primitive_to_bigint(vm, primitive, &result)) {
        return mal_value_new_undefined();
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

/**
 * thisBigIntValue(value): the BigInt receiver shared by the prototype methods.
 * A BigInt primitive answers directly; a BigInt wrapper object answers with its
 * [[BigIntData]] (e.g. Object(1n), or a sloppy method whose primitive `this` was
 * boxed by OrdinaryCallBindThis). Anything else is a TypeError.
 */
static bool mal_builtin_bigint_this(MalVm *vm, MalValue this_value, i128 *out) {
    if (mal_value_is_bigint(this_value)) {
        *out = mal_bigint_value(mal_value_to_bigint(this_value));
        return true;
    }

    if (mal_value_is_primitive_wrapper(this_value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(this_value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_BIGINT) {
            *out = mal_bigint_value(mal_value_to_bigint(wrapper->primitive_data));
            return true;
        }
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a BigInt");
    return false;
}

static MalValue mal_builtin_bigint_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;

    i128 value;
    if (!mal_builtin_bigint_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }

    i32 radix = 10;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        // ToIntegerOrInfinity(radix) starts with ToNumber, which throws a
        // TypeError on a Symbol or BigInt radix (rather than a RangeError).
        f64 requested;
        if (!mal_vm_to_number(vm, args[0], &requested)) {
            return mal_value_new_undefined();
        }
        // ToIntegerOrInfinity truncates toward zero (NaN → 0) before the range
        // check, so e.g. 10.9 is a valid radix.
        f64 integral = isnan(requested) ? 0 : trunc(requested);
        if (integral < 2 || integral > 36) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toString() radix must be between 2 and 36");
            return mal_value_new_undefined();
        }
        radix = (i32) integral;
    }

    return mal_value_from_string(mal_bigint_to_string(&vm->heap, value, radix));
}

static MalValue mal_builtin_bigint_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    i128 value;
    if (!mal_builtin_bigint_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }

    // Return the [[BigIntData]] as a BigInt primitive — re-box rather than return
    // this_value, which is the wrapper object when called on Object(1n).
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, value));
}

/**
 * ToIndex(value) for the asIntN/asUintN `bits` argument: ToNumber (with full
 * ToPrimitive for objects), truncate toward zero, NaN → 0, then require a
 * non-negative integer no greater than 2^53 - 1, else RangeError. Returns false
 * (with the throw pending) on a coercion throw or out-of-range index.
 */
static bool mal_builtin_bigint_bits_arg(MalVm *vm, const MalValue *args, i32 arg_count, i64 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return false;
    }
    f64 index = isnan(number) ? 0 : trunc(number);
    if (index < 0 || index > 9007199254740991.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid bit count");
        return false;
    }
    *out = (i64) index;
    return true;
}

static MalValue mal_builtin_bigint_as_uint_n(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    // 1. Let bits be ? ToIndex(bits). 2. Let bigint be ? ToBigInt(bigint).
    i64 bits;
    if (!mal_builtin_bigint_bits_arg(vm, args, arg_count, &bits)) {
        return mal_value_new_undefined();
    }

    i128 value;
    if (!mal_bigint_to_bigint(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &value)) {
        return mal_value_new_undefined();
    }

    i128 result;
    if (bits == 0) {
        result = 0;
    } else if (bits >= 128) {
        // TODO(bigint): widths beyond the 128-bit backing are approximated.
        result = value;
    } else {
        u128 mask = ((u128) 1 << bits) - 1;
        result = (i128) ((u128) value & mask);
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

static MalValue mal_builtin_bigint_as_int_n(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    // 1. Let bits be ? ToIndex(bits). 2. Let bigint be ? ToBigInt(bigint).
    i64 bits;
    if (!mal_builtin_bigint_bits_arg(vm, args, arg_count, &bits)) {
        return mal_value_new_undefined();
    }

    i128 value;
    if (!mal_bigint_to_bigint(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &value)) {
        return mal_value_new_undefined();
    }

    i128 result;
    if (bits == 0) {
        result = 0;
    } else if (bits >= 128) {
        result = value;
    } else {
        u128 mask = ((u128) 1 << bits) - 1;
        u128 masked = (u128) value & mask;
        // Sign-extend if the top bit of the bit-width is set.
        if ((masked >> (bits - 1)) & 1) {
            masked |= ~mask;
        }
        result = (i128) masked;
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

void mal_builtin_bigint_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "BigInt"),
        1,
        mal_builtin_bigint_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_BIGINT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_BIGINT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "asUintN", 2, mal_builtin_bigint_as_uint_n);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "asIntN", 2, mal_builtin_bigint_as_int_n);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_bigint_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_bigint_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_bigint_prototype_value_of);

    // BigInt.prototype[Symbol.toStringTag] = "BigInt"
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "BigInt")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);
}
