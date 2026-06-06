#include "builtin_array.h"

#include <stdlib.h>
#include <string.h>

#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalKey mal_builtin_array_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

static u32 mal_builtin_array_length(MalValue this_value) {
    return mal_array_object_length(mal_value_to_array_object(this_value));
}

/**
 * Spec-flavored HasProperty + Get for an element, walking the prototype chain
 * and invoking accessor getters. Strings expose their code units; other
 * primitives have no elements. Returns false for holes and for getters that
 * threw; the latter leaves the throw completion on the vm, which also poisons
 * any follow-up calls until the caller returns.
 */
static bool mal_builtin_array_try_get(MalVm *vm, MalValue this_value, u32 index, MalValue *out) {
    if (mal_value_is_string(this_value)) {
        MalString *string = mal_value_to_string(this_value);
        if (index >= mal_string_length(string)) {
            return false;
        }

        *out = mal_value_from_string(mal_string_new_external(&vm->heap, mal_string_code_units(string) + index, 1));
        return true;
    }

    if (!mal_value_is_object(this_value)) {
        return false;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(this_value),
        mal_builtin_array_index_key(index)
    );
    if (!resolution.found) {
        return false;
    }

    return mal_vm_desc_read(vm, resolution.desc, this_value, out);
}

static MalValue mal_builtin_array_get(MalVm *vm, MalValue this_value, u32 index) {
    MalValue element = mal_value_new_undefined();
    mal_builtin_array_try_get(vm, this_value, index, &element);
    return element;
}

static void mal_builtin_array_store_index(MalArrayObject *array, u32 index, MalValue value) {
    mal_array_object_store(array, mal_builtin_array_index_key(index), value);
}

/**
 * Call a (element, index, array) style callback on the given this, propagating
 * abnormal completions to the VM.
 */
static bool mal_builtin_array_invoke(MalVm *vm, MalValue callback, MalValue this_arg, MalValue element, u32 index, MalValue this_value, MalValue *out) {
    MalValue args[] = {element, mal_value_from_i32((i32) index), this_value};
    MalCompletion completion = mal_vm_call_value(vm, callback, this_arg, args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *out = completion.value;
    return true;
}

/**
 * Spec-shaped prologue for the generic Array.prototype methods: any receiver
 * except null and undefined is accepted, and the iteration length is read
 * from its length property through a u32-clamped ToLength. Strings answer
 * with their code unit count, other primitives carry no elements.
 */
static bool mal_builtin_array_this_length(MalVm *vm, MalValue this_value, u32 *length_out) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.prototype method called on null or undefined");
        return false;
    }

    if (mal_value_is_array_object(this_value)) {
        *length_out = mal_array_object_length(mal_value_to_array_object(this_value));
        return true;
    }

    if (mal_value_is_string(this_value)) {
        *length_out = (u32) mal_string_length(mal_value_to_string(this_value));
        return true;
    }

    if (!mal_value_is_object(this_value)) {
        *length_out = 0;
        return true;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(this_value),
        mal_intrinsic_string_key(vm, "length")
    );
    if (!resolution.found) {
        *length_out = 0;
        return true;
    }

    MalValue length_value;
    if (!mal_vm_desc_read(vm, resolution.desc, this_value, &length_value)) {
        return false;
    }

    f64 raw = mal_ops_to_number(length_value);
    if (!(raw > 0)) {
        // NaN and negative lengths clamp to zero.
        *length_out = 0;
    } else if (raw >= (f64) UINT32_MAX) {
        *length_out = UINT32_MAX;
    } else {
        *length_out = (u32) raw;
    }

    return true;
}

/**
 * Validate the callback argument, throwing the spec-mandated TypeError.
 */
static bool mal_builtin_array_callback_arg(MalVm *vm, const MalValue *args, i32 arg_count) {
    if (arg_count >= 1 && mal_value_is_callable(args[0])) {
        return true;
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
    return false;
}

static MalValue mal_builtin_array_this_arg(const MalValue *args, i32 arg_count) {
    return arg_count >= 2 ? args[1] : mal_value_new_undefined();
}

/**
 * ToIntegerOrInfinity-flavored relative index handling: negative values count
 * back from length, the result is clamped to [0, length].
 */
static u32 mal_builtin_array_clamp_relative(MalValue value, f64 fallback, u32 length) {
    f64 relative = fallback;
    if (mal_value_is_int32(value)) {
        relative = (f64) mal_value_to_i32(value);
    } else if (mal_value_is_f64(value)) {
        relative = mal_value_to_f64(value);
    }

    if (relative < 0) {
        relative += (f64) length;
    }
    if (relative < 0) {
        return 0;
    }
    if (relative > (f64) length) {
        return length;
    }

    return (u32) relative;
}

static bool mal_builtin_array_same_value_zero(MalValue left, MalValue right) {
    if (mal_value_to_boolean(mal_ops_strict_equal(left, right))) {
        return true;
    }

    return mal_value_is_nan(left) && mal_value_is_nan(right);
}

static MalValue mal_builtin_array_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    if (arg_count == 1 && mal_value_is_int32(args[0]) && mal_value_to_i32(args[0]) >= 0) {
        return mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) mal_value_to_i32(args[0])));
    }

    MalArrayObject *array = mal_intrinsic_new_array(vm, (u32) arg_count);
    for (i32 i = 0; i < arg_count; i++) {
        mal_object_set((MalObject *) array, mal_builtin_array_index_key((u32) i), args[i]);
    }

    return mal_value_from_array_object(array);
}

static MalValue mal_builtin_array_is_array(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_value_is_array_object(args[0]));
}

static MalValue mal_builtin_array_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    MalArrayObject *array = mal_intrinsic_new_array(vm, (u32) arg_count);
    for (i32 i = 0; i < arg_count; i++) {
        mal_object_set((MalObject *) array, mal_builtin_array_index_key((u32) i), args[i]);
    }

    return mal_value_from_array_object(array);
}

static MalValue mal_builtin_array_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue map_fn = arg_count >= 2 && mal_value_is_callable(args[1]) ? args[1] : mal_value_new_undefined();

    u32 length = 0;
    if (mal_value_is_array_object(source)) {
        length = mal_array_object_length(mal_value_to_array_object(source));
    } else if (mal_value_is_object(source)) {
        // Array-like: read a numeric length property.
        MalPropertyResolution resolution = mal_object_resolve_property(
            mal_value_to_object(source),
            mal_intrinsic_string_key(vm, "length")
        );
        if (resolution.found) {
            f64 raw = mal_ops_to_number(resolution.desc.value);
            if (raw > 0) {
                length = raw > (f64) UINT32_MAX ? UINT32_MAX : (u32) raw;
            }
        }
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, length);
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, source, index);

        if (!mal_value_is_undefined(map_fn)) {
            MalValue mapped_args[] = {element, mal_value_from_i32((i32) index)};
            MalCompletion completion = mal_vm_call_value(vm, map_fn, mal_value_new_undefined(), mapped_args, 2);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = completion;
                return mal_value_new_undefined();
            }

            element = completion.value;
        }

        mal_object_set((MalObject *) result, mal_builtin_array_index_key(index), element);
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *result = mal_intrinsic_new_array(vm, length);

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue mapped;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &mapped)) {
            return mal_value_new_undefined();
        }

        mal_object_set((MalObject *) result, mal_builtin_array_index_key(index), mapped);
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue ignored;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &ignored)) {
            return mal_value_new_undefined();
        }
    }

    return mal_value_new_undefined();
}

static MalValue mal_builtin_array_filter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 result_length = 0;

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue selected;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &selected)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_truthy(selected)) {
            mal_builtin_array_store_index(result, result_length++, element);
        }
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalValue accumulator = mal_value_new_undefined();
    bool has_accumulator = false;

    if (arg_count >= 2) {
        accumulator = args[1];
        has_accumulator = true;
    }

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        if (!has_accumulator) {
            accumulator = element;
            has_accumulator = true;
            continue;
        }

        MalValue callback_args[] = {accumulator, element, mal_value_from_i32((i32) index), this_value};
        MalCompletion completion = mal_vm_call_value(vm, args[0], mal_value_new_undefined(), callback_args, 4);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return mal_value_new_undefined();
        }

        accumulator = completion.value;
    }

    if (!has_accumulator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty array with no initial value");
        return mal_value_new_undefined();
    }

    return accumulator;
}

static MalValue mal_builtin_array_reduce_right(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }

    MalValue accumulator = mal_value_new_undefined();
    bool has_accumulator = false;

    if (arg_count >= 2) {
        accumulator = args[1];
        has_accumulator = true;
    }

    for (u32 index = length; index-- > 0;) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            continue;
        }

        if (!has_accumulator) {
            accumulator = element;
            has_accumulator = true;
            continue;
        }

        MalValue callback_args[] = {accumulator, element, mal_value_from_i32((i32) index), this_value};
        MalCompletion completion = mal_vm_call_value(vm, args[0], mal_value_new_undefined(), callback_args, 4);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return mal_value_new_undefined();
        }

        accumulator = completion.value;
    }

    if (!has_accumulator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty array with no initial value");
        return mal_value_new_undefined();
    }

    return accumulator;
}

static MalValue mal_builtin_array_find(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_truthy(matched)) {
            return element;
        }
    }

    return mal_value_new_undefined();
}

static MalValue mal_builtin_array_find_index(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_truthy(matched)) {
            return mal_value_from_i32((i32) index);
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_some(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_truthy(matched)) {
            return mal_value_new_boolean(true);
        }
    }

    return mal_value_new_boolean(false);
}

static MalValue mal_builtin_array_every(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            return mal_value_new_undefined();
        }

        if (!mal_value_is_truthy(matched)) {
            return mal_value_new_boolean(false);
        }
    }

    return mal_value_new_boolean(true);
}

static MalValue mal_builtin_array_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    u32 start = arg_count >= 2 ? mal_builtin_array_clamp_relative(args[1], 0, length) : 0;

    for (u32 index = start; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        if (mal_value_to_boolean(mal_ops_strict_equal(element, search))) {
            return mal_value_from_i32((i32) index);
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    if (length == 0) {
        return mal_value_from_i32(-1);
    }

    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    u32 start = length - 1;
    if (arg_count >= 2) {
        f64 relative = mal_value_is_int32(args[1]) ? (f64) mal_value_to_i32(args[1])
            : mal_value_is_f64(args[1])           ? mal_value_to_f64(args[1])
                                                  : (f64) (length - 1);
        if (relative < 0) {
            relative += (f64) length;
        }
        if (relative < 0) {
            return mal_value_from_i32(-1);
        }

        start = relative >= (f64) (length - 1) ? length - 1 : (u32) relative;
    }

    for (u32 index = start;; index--) {
        MalValue element;
        if (mal_builtin_array_try_get(vm, this_value, index, &element) &&
            mal_value_to_boolean(mal_ops_strict_equal(element, search))) {
            return mal_value_from_i32((i32) index);
        }

        if (index == 0) {
            break;
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    u32 start = arg_count >= 2 ? mal_builtin_array_clamp_relative(args[1], 0, length) : 0;

    for (u32 index = start; index < length; index++) {
        // Holes compare as undefined for includes.
        if (mal_builtin_array_same_value_zero(mal_builtin_array_get(vm, this_value, index), search)) {
            return mal_value_new_boolean(true);
        }
    }

    return mal_value_new_boolean(false);
}

static MalValue mal_builtin_array_push(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    u32 length = mal_array_object_length(array);
    for (i32 i = 0; i < arg_count; i++) {
        mal_builtin_array_store_index(array, length + (u32) i, args[i]);
    }

    return mal_value_from_i32((i32) mal_array_object_length(array));
}

static MalValue mal_builtin_array_pop(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) args;
    (void) arg_count;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    u32 length = mal_array_object_length(array);
    if (length == 0) {
        return mal_value_new_undefined();
    }

    MalValue element = mal_builtin_array_get(vm, this_value, length - 1);
    mal_object_delete_own((MalObject *) array, mal_builtin_array_index_key(length - 1));
    mal_array_object_set_length(array, length - 1);
    return element;
}

static MalValue mal_builtin_array_shift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) args;
    (void) arg_count;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    u32 length = mal_array_object_length(array);
    if (length == 0) {
        return mal_value_new_undefined();
    }

    MalValue first = mal_builtin_array_get(vm, this_value, 0);
    for (u32 index = 1; index < length; index++) {
        MalValue element;
        if (mal_builtin_array_try_get(vm, this_value, index, &element)) {
            mal_object_set((MalObject *) array, mal_builtin_array_index_key(index - 1), element);
        } else {
            mal_object_delete_own((MalObject *) array, mal_builtin_array_index_key(index - 1));
        }
    }

    mal_object_delete_own((MalObject *) array, mal_builtin_array_index_key(length - 1));
    mal_array_object_set_length(array, length - 1);
    return first;
}

static MalValue mal_builtin_array_unshift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    u32 length = mal_array_object_length(array);

    for (u32 moved = length; moved > 0; moved--) {
        u32 from = moved - 1;
        u32 to = from + (u32) arg_count;

        MalValue element;
        if (mal_builtin_array_try_get(vm, this_value, from, &element)) {
            mal_object_set((MalObject *) array, mal_builtin_array_index_key(to), element);
        } else {
            mal_object_delete_own((MalObject *) array, mal_builtin_array_index_key(to));
        }
    }

    for (i32 i = 0; i < arg_count; i++) {
        mal_object_set((MalObject *) array, mal_builtin_array_index_key((u32) i), args[i]);
    }

    mal_array_object_set_length(array, length + (u32) arg_count);
    return mal_value_from_i32((i32) (length + (u32) arg_count));
}

static MalValue mal_builtin_array_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    u32 length = mal_builtin_array_length(this_value);
    u32 start = arg_count >= 1 ? mal_builtin_array_clamp_relative(args[0], 0, length) : 0;
    u32 end = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_array_clamp_relative(args[1], (f64) length, length)
        : length;

    u32 result_length = end > start ? end - start : 0;
    MalArrayObject *result = mal_intrinsic_new_array(vm, result_length);

    for (u32 index = 0; index < result_length; index++) {
        MalValue element;
        if (mal_builtin_array_try_get(vm, this_value, start + index, &element)) {
            mal_object_set((MalObject *) result, mal_builtin_array_index_key(index), element);
        }
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 result_length = 0;

    for (i32 i = -1; i < arg_count; i++) {
        MalValue source = i < 0 ? this_value : args[i];

        if (mal_value_is_array_object(source)) {
            u32 source_length = mal_array_object_length(mal_value_to_array_object(source));
            for (u32 index = 0; index < source_length; index++) {
                MalValue element;
                if (mal_builtin_array_try_get(vm, source, index, &element)) {
                    mal_object_set((MalObject *) result, mal_builtin_array_index_key(result_length + index), element);
                }
            }

            result_length += source_length;
        } else {
            mal_object_set((MalObject *) result, mal_builtin_array_index_key(result_length), source);
            result_length++;
        }
    }

    mal_array_object_set_length(result, result_length);
    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_join(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    u32 length = mal_builtin_array_length(this_value);
    if (length == 0) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    }

    MalString *separator = arg_count >= 1 && !mal_value_is_undefined(args[0])
        ? mal_ops_to_string(&vm->heap, args[0])
        : mal_intrinsic_ascii(vm, ",");

    MalString **parts = malloc(sizeof(MalString *) * length);
    usize total_length = mal_string_length(separator) * (length - 1);

    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);
        // Holes, undefined and null join as empty strings.
        parts[index] = mal_value_is_nil(element) ? nullptr : mal_ops_to_string(&vm->heap, element);
        total_length += parts[index] != nullptr ? mal_string_length(parts[index]) : 0;
    }

    c16 *code_units = malloc(sizeof(c16) * total_length);
    usize offset = 0;
    for (u32 index = 0; index < length; index++) {
        if (index > 0 && mal_string_length(separator) > 0) {
            memcpy(code_units + offset, mal_string_code_units(separator), (usize) sizeof(c16) * mal_string_length(separator));
            offset += mal_string_length(separator);
        }

        if (parts[index] != nullptr && mal_string_length(parts[index]) > 0) {
            memcpy(code_units + offset, mal_string_code_units(parts[index]), (usize) sizeof(c16) * mal_string_length(parts[index]));
            offset += mal_string_length(parts[index]);
        }
    }

    MalString *result = mal_string_new_copy(&vm->heap, code_units, total_length);
    free(code_units);
    free(parts);
    return mal_value_from_string(result);
}

static MalValue mal_builtin_array_reverse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) args;
    (void) arg_count;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    MalObject *object = (MalObject *) array;
    u32 length = mal_array_object_length(array);

    for (u32 low = 0; length > 1 && low < length - 1 - low; low++) {
        u32 high = length - 1 - low;
        MalKey low_key = mal_builtin_array_index_key(low);
        MalKey high_key = mal_builtin_array_index_key(high);

        MalPropertyLookup low_lookup = mal_object_get_own(object, low_key);
        MalPropertyLookup high_lookup = mal_object_get_own(object, high_key);

        if (high_lookup.present) {
            mal_object_set(object, low_key, high_lookup.desc.value);
        } else {
            mal_object_delete_own(object, low_key);
        }

        if (low_lookup.present) {
            mal_object_set(object, high_key, low_lookup.desc.value);
        } else {
            mal_object_delete_own(object, high_key);
        }
    }

    return this_value;
}

static MalValue mal_builtin_array_fill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    u32 length = mal_array_object_length(array);
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    u32 start = arg_count >= 2 ? mal_builtin_array_clamp_relative(args[1], 0, length) : 0;
    u32 end = arg_count >= 3 && !mal_value_is_undefined(args[2])
        ? mal_builtin_array_clamp_relative(args[2], (f64) length, length)
        : length;

    for (u32 index = start; index < end; index++) {
        mal_object_set((MalObject *) array, mal_builtin_array_index_key(index), value);
    }

    return this_value;
}

static MalValue mal_builtin_array_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    u32 length = mal_builtin_array_length(this_value);
    f64 relative = arg_count >= 1 && mal_value_is_int32(args[0]) ? (f64) mal_value_to_i32(args[0])
        : arg_count >= 1 && mal_value_is_f64(args[0])            ? mal_value_to_f64(args[0])
                                                                 : 0;
    if (relative < 0) {
        relative += (f64) length;
    }
    if (relative < 0 || relative >= (f64) length) {
        return mal_value_new_undefined();
    }

    return mal_builtin_array_get(vm, this_value, (u32) relative);
}

void mal_builtin_array_install(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Array"),
        mal_builtin_array_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;
    vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method(vm, constructor_object, "isArray", mal_builtin_array_is_array);
    mal_intrinsic_define_method(vm, constructor_object, "of", mal_builtin_array_of);
    mal_intrinsic_define_method(vm, constructor_object, "from", mal_builtin_array_from);

    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_MAP] =
        mal_intrinsic_define_method(vm, prototype, "map", mal_builtin_array_map);
    mal_intrinsic_define_method(vm, prototype, "forEach", mal_builtin_array_for_each);
    mal_intrinsic_define_method(vm, prototype, "filter", mal_builtin_array_filter);
    mal_intrinsic_define_method(vm, prototype, "reduce", mal_builtin_array_reduce);
    mal_intrinsic_define_method(vm, prototype, "reduceRight", mal_builtin_array_reduce_right);
    mal_intrinsic_define_method(vm, prototype, "find", mal_builtin_array_find);
    mal_intrinsic_define_method(vm, prototype, "findIndex", mal_builtin_array_find_index);
    mal_intrinsic_define_method(vm, prototype, "some", mal_builtin_array_some);
    mal_intrinsic_define_method(vm, prototype, "every", mal_builtin_array_every);
    mal_intrinsic_define_method(vm, prototype, "indexOf", mal_builtin_array_index_of);
    mal_intrinsic_define_method(vm, prototype, "lastIndexOf", mal_builtin_array_last_index_of);
    mal_intrinsic_define_method(vm, prototype, "includes", mal_builtin_array_includes);
    mal_intrinsic_define_method(vm, prototype, "push", mal_builtin_array_push);
    mal_intrinsic_define_method(vm, prototype, "pop", mal_builtin_array_pop);
    mal_intrinsic_define_method(vm, prototype, "shift", mal_builtin_array_shift);
    mal_intrinsic_define_method(vm, prototype, "unshift", mal_builtin_array_unshift);
    mal_intrinsic_define_method(vm, prototype, "slice", mal_builtin_array_slice);
    mal_intrinsic_define_method(vm, prototype, "concat", mal_builtin_array_concat);
    mal_intrinsic_define_method(vm, prototype, "join", mal_builtin_array_join);
    mal_intrinsic_define_method(vm, prototype, "reverse", mal_builtin_array_reverse);
    mal_intrinsic_define_method(vm, prototype, "fill", mal_builtin_array_fill);
    mal_intrinsic_define_method(vm, prototype, "at", mal_builtin_array_at);
}
