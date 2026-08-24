#include "builtin_bigint.h"

#include "bigint128.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

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
        i128 parsed = mal_bigint128_parse(mal_string_code_units(string), mal_string_length(string), &ok);
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
    if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_NUMBER, &primitive)) {
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
    if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_NUMBER, &primitive)) {
        return mal_value_new_undefined();
    }

    // 3. If prim is a Number, return ? NumberToBigInt(prim): an integral Number
    // becomes the matching BigInt, anything else (NaN, ±Infinity, fractional)
    // is a RangeError.
    if (mal_ops_is_number(primitive)) {
        i128 converted;
        if (!mal_bigint128_from_number(mal_ops_number_as_f64(primitive), &converted)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The number is not a safe integer");
            return mal_value_new_undefined();
        }
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, converted));
    }

    // BigInt primitives are immutable and the abstract conversion returns the
    // input value unchanged. Retain the existing primitive instead of copying
    // its 128-bit payload into a fresh managed BigInt cell.
    if (mal_value_is_bigint(primitive)) {
        return primitive;
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
        f64 integral = mal_ops_number_to_integer_or_infinity(requested);
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

    if (mal_value_is_bigint(this_value)) {
        return this_value;
    }
    if (mal_value_is_primitive_wrapper(this_value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(this_value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_BIGINT) {
            return wrapper->primitive_data;
        }
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a BigInt");
    return mal_value_new_undefined();
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
    f64 index = mal_ops_number_to_integer_or_infinity(number);
    if (index < 0 || index > MAL_NUMBER_MAX_SAFE_INTEGER) {
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

    i128 result = mal_bigint128_as_uint_n(value, (u64) bits);
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

    i128 result = mal_bigint128_as_int_n(value, (u64) bits);
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
