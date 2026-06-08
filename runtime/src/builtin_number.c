#include "builtin_number.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"

static bool mal_builtin_number_is_whitespace(c16 code_unit) {
    return (code_unit >= 0x09 && code_unit <= 0x0D) ||
        code_unit == 0x20 ||
        code_unit == 0xA0 ||
        code_unit == 0x2028 ||
        code_unit == 0x2029 ||
        code_unit == 0xFEFF;
}

static f64 mal_builtin_parse_int_units(const c16 *code_units, usize length, f64 raw_radix) {
    usize i = 0;
    while (i < length && mal_builtin_number_is_whitespace(code_units[i])) {
        i++;
    }

    f64 sign = 1;
    if (i < length && (code_units[i] == '+' || code_units[i] == '-')) {
        sign = code_units[i] == '-' ? -1 : 1;
        i++;
    }

    i32 radix = isnan(raw_radix) ? 0 : (i32) raw_radix;
    bool strip_prefix = true;
    if (radix != 0) {
        if (radix < 2 || radix > 36) {
            return NAN;
        }
        strip_prefix = radix == 16;
    } else {
        radix = 10;
    }

    if (strip_prefix && i + 1 < length && code_units[i] == '0' &&
        (code_units[i + 1] == 'x' || code_units[i + 1] == 'X')) {
        i += 2;
        radix = 16;
    }

    f64 value = 0;
    bool any_digit = false;
    for (; i < length; i++) {
        c16 code_unit = code_units[i];
        i32 digit;
        if (code_unit >= '0' && code_unit <= '9') {
            digit = code_unit - '0';
        } else if (code_unit >= 'a' && code_unit <= 'z') {
            digit = code_unit - 'a' + 10;
        } else if (code_unit >= 'A' && code_unit <= 'Z') {
            digit = code_unit - 'A' + 10;
        } else {
            break;
        }

        if (digit >= radix) {
            break;
        }

        value = value * radix + digit;
        any_digit = true;
    }

    return any_digit ? sign * value : NAN;
}

static f64 mal_builtin_parse_float_units(const c16 *code_units, usize length) {
    usize start = 0;
    while (start < length && mal_builtin_number_is_whitespace(code_units[start])) {
        start++;
    }

    // Collect the ASCII prefix and let strtod handle the float grammar.
    byte *buffer = malloc(length - start + 1);
    usize buffer_length = 0;
    for (usize i = start; i < length; i++) {
        if (code_units[i] > 0x7F) {
            break;
        }
        buffer[buffer_length++] = (byte) code_units[i];
    }
    buffer[buffer_length] = '\0';

    // JS parseFloat has no hex or "inf" forms; strtod would accept both.
    usize digits_start = buffer_length > 0 && (buffer[0] == '+' || buffer[0] == '-') ? 1 : 0;
    if (buffer_length >= digits_start + 2 && buffer[digits_start] == '0' &&
        (buffer[digits_start + 1] == 'x' || buffer[digits_start + 1] == 'X')) {
        buffer[digits_start + 1] = '\0';
    }
    // parseFloat accepts a leading "Infinity" (exact spelling, after an optional
    // sign); strtod would otherwise also accept "inf"/"infinity"/"nan", which
    // the StrDecimalLiteral grammar does not.
    if (buffer_length >= digits_start + 8 && memcmp(buffer + digits_start, "Infinity", 8) == 0) {
        bool negative = digits_start == 1 && buffer[0] == '-';
        free(buffer);
        return negative ? -INFINITY : INFINITY;
    }
    if (buffer_length > digits_start && (buffer[digits_start] == 'i' || buffer[digits_start] == 'I' || buffer[digits_start] == 'n' || buffer[digits_start] == 'N')) {
        buffer[digits_start] = '\0';
    }

    byte *end = buffer;
    f64 value = strtod(buffer, (char **) &end);
    bool parsed = end != buffer;
    free(buffer);
    return parsed ? value : NAN;
}

static MalValue mal_builtin_number_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    if (arg_count == 0) {
        return mal_value_from_i32(0);
    }

    if (mal_value_is_int32(args[0])) {
        return args[0];
    }

    // TODO(numbers): no wrapper objects, constructing also returns the primitive.
    return mal_ops_number_value(mal_ops_to_number(args[0]));
}

static MalValue mal_builtin_number_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(
        mal_value_is_nan(args[0]) || (mal_value_is_f64(args[0]) && isnan(mal_value_to_f64(args[0])))
    );
}

static bool mal_builtin_number_value_is_finite(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && isfinite(mal_value_to_f64(value));
}

static MalValue mal_builtin_number_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_finite(args[0]));
}

static bool mal_builtin_number_value_is_integer(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    if (!mal_value_is_f64(value)) {
        return false;
    }

    f64 number = mal_value_to_f64(value);
    return isfinite(number) && trunc(number) == number;
}

static MalValue mal_builtin_number_is_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_integer(args[0]));
}

static MalValue mal_builtin_number_is_safe_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_builtin_number_value_is_integer(args[0])) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(fabs(mal_ops_to_number(args[0])) <= 9007199254740991.0);
}

static MalValue mal_builtin_parse_int(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    MalString *string = mal_ops_to_string(&vm->heap, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    f64 radix = arg_count >= 2 ? mal_ops_to_number(args[1]) : 0;
    return mal_ops_number_value(mal_builtin_parse_int_units(mal_string_code_units(string), mal_string_length(string), radix));
}

static MalValue mal_builtin_parse_float(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    MalString *string = mal_ops_to_string(&vm->heap, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    return mal_ops_number_value(mal_builtin_parse_float_units(mal_string_code_units(string), mal_string_length(string)));
}

static MalValue mal_builtin_global_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(isnan(mal_ops_to_number(arg_count >= 1 ? args[0] : mal_value_new_undefined())));
}

static MalValue mal_builtin_global_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(isfinite(mal_ops_to_number(arg_count >= 1 ? args[0] : mal_value_new_undefined())));
}

static MalValue mal_builtin_number_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    // TODO(numbers): the radix argument is not supported yet.
    (void) args;
    (void) arg_count;
    return mal_value_from_string(mal_ops_to_string(&vm->heap, this_value));
}

static MalValue mal_builtin_number_prototype_to_fixed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    f64 digits = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(digits)) {
        digits = 0;
    }
    if (digits < 0 || digits > 100) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toFixed() digits argument must be between 0 and 100");
        return mal_value_new_undefined();
    }

    byte buffer[160];
    snprintf(buffer, sizeof(buffer), "%.*f", (i32) digits, mal_ops_to_number(this_value));
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, buffer, strlen(buffer)));
}

static MalValue mal_builtin_number_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return mal_ops_number_value(mal_ops_to_number(this_value));
}

void mal_builtin_number_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Number"),
        mal_builtin_number_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_data(vm, constructor_object, "MAX_SAFE_INTEGER", mal_value_from_f64(9007199254740991.0), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MIN_SAFE_INTEGER", mal_value_from_f64(-9007199254740991.0), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "EPSILON", mal_value_from_f64(DBL_EPSILON), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MAX_VALUE", mal_value_from_f64(DBL_MAX), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MIN_VALUE", mal_value_from_f64(5e-324), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "POSITIVE_INFINITY", mal_value_from_f64_convert_nan(INFINITY), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "NEGATIVE_INFINITY", mal_value_from_f64_convert_nan(-INFINITY), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "NaN", mal_value_new_nan(), MAL_PROPERTY_NONE);

    mal_intrinsic_define_method(vm, constructor_object, "isNaN", mal_builtin_number_is_nan);
    mal_intrinsic_define_method(vm, constructor_object, "isFinite", mal_builtin_number_is_finite);
    mal_intrinsic_define_method(vm, constructor_object, "isInteger", mal_builtin_number_is_integer);
    mal_intrinsic_define_method(vm, constructor_object, "isSafeInteger", mal_builtin_number_is_safe_integer);
    vm->intrinsics[MAL_INTRINSIC_PARSE_INT] = mal_intrinsic_define_method(vm, constructor_object, "parseInt", mal_builtin_parse_int);
    vm->intrinsics[MAL_INTRINSIC_PARSE_FLOAT] = mal_intrinsic_define_method(vm, constructor_object, "parseFloat", mal_builtin_parse_float);

    mal_intrinsic_define_method(vm, prototype, "toString", mal_builtin_number_prototype_to_string);
    mal_intrinsic_define_method(vm, prototype, "toFixed", mal_builtin_number_prototype_to_fixed);
    mal_intrinsic_define_method(vm, prototype, "valueOf", mal_builtin_number_prototype_value_of);

    // The global function flavors coerce their argument, unlike the statics.
    MalNativeFunctionObject *global_is_nan = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isNaN"),
        mal_builtin_global_is_nan
    );
    MalNativeFunctionObject *global_is_finite = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isFinite"),
        mal_builtin_global_is_finite
    );
    vm->intrinsics[MAL_INTRINSIC_IS_NAN] = mal_value_from_native_function_object(global_is_nan);
    vm->intrinsics[MAL_INTRINSIC_IS_FINITE] = mal_value_from_native_function_object(global_is_finite);
}
