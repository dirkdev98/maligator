#include "builtin_bigint.h"

#include <math.h>

#include "heap_bigint.h"
#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"

bool mal_bigint_to_bigint(MalVm *vm, MalValue value, i128 *out) {
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

static MalValue mal_builtin_bigint_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "BigInt is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    // BigInt(number) requires an integral Number (NumberToBigInt); other inputs
    // go through ToBigInt.
    if (mal_value_is_int32(value) || mal_value_is_f64_or_nan(value) ||
        value == MAL_VALUE_NEGATIVE_ZERO || value == MAL_VALUE_POSITIVE_INFINITY ||
        value == MAL_VALUE_NEGATIVE_INFINITY) {
        f64 number = mal_ops_to_number(value);
        if (isnan(number) || isinf(number) || trunc(number) != number) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The number is not a safe integer");
            return mal_value_new_undefined();
        }
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) number));
    }

    i128 result;
    if (!mal_bigint_to_bigint(vm, value, &result)) {
        return mal_value_new_undefined();
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

/**
 * Unwrap the BigInt receiver shared by the prototype methods. With no wrapper
 * objects only BigInt primitives are accepted.
 */
static bool mal_builtin_bigint_this(MalVm *vm, MalValue this_value, i128 *out) {
    if (!mal_value_is_bigint(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a BigInt");
        return false;
    }

    *out = mal_bigint_value(mal_value_to_bigint(this_value));
    return true;
}

static MalValue mal_builtin_bigint_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) new_target;

    i128 value;
    if (!mal_builtin_bigint_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }

    i32 radix = 10;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        f64 requested = mal_ops_to_number(args[0]);
        if (isnan(requested) || requested < 2 || requested > 36) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toString() radix must be between 2 and 36");
            return mal_value_new_undefined();
        }
        radix = (i32) requested;
    }

    return mal_value_from_string(mal_bigint_to_string(&vm->heap, value, radix));
}

static MalValue mal_builtin_bigint_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) args;
    (void) arg_count;
    (void) new_target;

    i128 value;
    if (!mal_builtin_bigint_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }

    return this_value;
}

// ToIndex-ish: a non-negative integer bit count.
static bool mal_builtin_bigint_bits_arg(MalVm *vm, const MalValue *args, i32 arg_count, i64 *out) {
    f64 bits = mal_ops_to_number(arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (isnan(bits)) {
        bits = 0;
    }
    if (bits < 0 || isinf(bits)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid bit count");
        return false;
    }
    *out = (i64) bits;
    return true;
}

static MalValue mal_builtin_bigint_as_uint_n(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    (void) new_target;

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

static MalValue mal_builtin_bigint_as_int_n(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    (void) new_target;

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
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "BigInt"),
        mal_builtin_bigint_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_BIGINT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_BIGINT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method(vm, (MalObject *) constructor, "asUintN", mal_builtin_bigint_as_uint_n);
    mal_intrinsic_define_method(vm, (MalObject *) constructor, "asIntN", mal_builtin_bigint_as_int_n);

    mal_intrinsic_define_method(vm, prototype, "toString", mal_builtin_bigint_prototype_to_string);
    mal_intrinsic_define_method(vm, prototype, "toLocaleString", mal_builtin_bigint_prototype_to_string);
    mal_intrinsic_define_method(vm, prototype, "valueOf", mal_builtin_bigint_prototype_value_of);

    // BigInt.prototype[Symbol.toStringTag] = "BigInt"
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "BigInt")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);
}
