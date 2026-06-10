#include "builtin_array.h"

#include <stdlib.h>
#include <string.h>

#include "builtin_iterator.h"
#include "builtin_object.h"
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
bool mal_builtin_array_try_get(MalVm *vm, MalValue this_value, u32 index, MalValue *out) {
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
 * Spec-flavored Set + ReturnIfAbrupt for mutating builtins: accessor setters
 * run with the receiver, rejected writes throw TypeError. Returns false after
 * throwing.
 */
static bool mal_builtin_array_set_or_throw(MalVm *vm, MalValue receiver, MalKey key, MalValue value) {
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        return false;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(receiver), key);
    if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        if (!mal_value_is_callable(resolution.desc.setter)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
            return false;
        }

        MalCompletion completion = mal_vm_call_value(vm, resolution.desc.setter, receiver, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return false;
        }

        return true;
    }

    bool stored = mal_value_is_array_object(receiver)
        ? mal_array_object_store(mal_value_to_array_object(receiver), key, value)
        : mal_object_set(mal_value_to_object(receiver), key, value);
    if (!stored) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        return false;
    }

    return true;
}

/**
 * DeletePropertyOrThrow for mutating builtins. Returns false after throwing.
 */
static bool mal_builtin_array_delete_or_throw(MalVm *vm, MalValue receiver, MalKey key) {
    if (!mal_value_is_object(receiver)) {
        return true;
    }

    if (!mal_object_delete_own(mal_value_to_object(receiver), key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return false;
    }

    return true;
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
bool mal_builtin_array_this_length(MalVm *vm, MalValue this_value, u32 *length_out) {
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
    // A present argument goes through ToIntegerOrInfinity (NaN -> 0,
    // truncated toward zero); undefined keeps the caller's fallback so
    // omitted end arguments still mean "to the end".
    f64 relative = fallback;
    if (!mal_value_is_undefined(value)) {
        f64 number = mal_ops_to_number(value);
        relative = number != number ? 0 : (f64) (i64) number;
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

static MalValue mal_builtin_array_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_is_array(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_value_is_array_object(args[0]));
}

static MalValue mal_builtin_array_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalArrayObject *array = mal_intrinsic_new_array(vm, (u32) arg_count);
    for (i32 i = 0; i < arg_count; i++) {
        mal_object_set((MalObject *) array, mal_builtin_array_index_key((u32) i), args[i]);
    }

    return mal_value_from_array_object(array);
}

/**
 * Apply the Array.from mapFn when present; returns false when it threw.
 */
static bool mal_builtin_array_from_map(MalVm *vm, MalValue map_fn, u32 index, MalValue *element) {
    if (mal_value_is_undefined(map_fn)) {
        return true;
    }

    MalValue mapped_args[] = {*element, mal_value_from_i32((i32) index)};
    MalCompletion completion = mal_vm_call_value(vm, map_fn, mal_value_new_undefined(), mapped_args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *element = completion.value;
    return true;
}

static MalValue mal_builtin_array_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    MalValue map_fn = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_undefined(map_fn) && !mal_value_is_callable(map_fn)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.from mapper is not a function");
        return mal_value_new_undefined();
    }

    // Iterables win over array-likes, per spec (arrays still take the fast
    // indexed path below).
    if (!mal_value_is_array_object(source) && !mal_value_is_nil(source)) {
        MalValue method;
        if (!mal_vm_get_property(vm, source, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_callable(method)) {
            MalIteratorRecord record;
            if (!mal_vm_get_iterator(vm, source, &record)) {
                return mal_value_new_undefined();
            }

            MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
            u32 index = 0;
            while (true) {
                MalValue element;
                bool done;
                if (!mal_vm_iterator_step(vm, &record, &element, &done)) {
                    return mal_value_new_undefined();
                }

                if (done) {
                    return mal_value_from_array_object(result);
                }

                if (!mal_builtin_array_from_map(vm, map_fn, index, &element)) {
                    mal_vm_iterator_close(vm, &record);
                    return mal_value_new_undefined();
                }

                mal_array_object_store(result, mal_builtin_array_index_key(index), element);
                index++;
            }
        }
    }

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

static MalValue mal_builtin_array_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_filter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_reduce_right(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_find(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_find_index(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_some(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_every(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_push(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_pop(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_shift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_unshift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 result_length = 0;

    for (i32 i = -1; i < arg_count; i++) {
        MalValue source = i < 0 ? this_value : args[i];

        // A defined @@isConcatSpreadable overrides the IsArray default.
        bool spreadable = mal_value_is_array_object(source);
        if (mal_value_is_object(source)) {
            MalValue spreadable_value;
            if (!mal_vm_get_property(vm, source, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_IS_CONCAT_SPREADABLE), &spreadable_value)) {
                return mal_value_new_undefined();
            }

            if (!mal_value_is_undefined(spreadable_value)) {
                spreadable = mal_value_is_truthy(spreadable_value);
            }
        }

        if (spreadable) {
            // Spreading non-arrays approximates with the generic array-like
            // length read.
            u32 source_length = 0;
            if (mal_value_is_array_object(source)) {
                source_length = mal_array_object_length(mal_value_to_array_object(source));
            } else if (!mal_builtin_array_this_length(vm, source, &source_length)) {
                return mal_value_new_undefined();
            }
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

static MalValue mal_builtin_array_join(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_reverse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_fill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_array_find_last(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = length; index-- > 0;) {
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

static MalValue mal_builtin_array_find_last_index(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    for (u32 index = length; index-- > 0;) {
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

/**
 * Read a numeric argument as a raw f64, mirroring the pragmatic numeric
 * handling of mal_builtin_array_clamp_relative for non-number values.
 */
static f64 mal_builtin_array_number_arg(const MalValue *args, i32 arg_count, i32 index, f64 fallback) {
    if (index >= arg_count || mal_value_is_undefined(args[index])) {
        return fallback;
    }

    // ToIntegerOrInfinity: NaN -> 0, infinities and out-of-range magnitudes
    // preserved (callers clamp), else truncate toward zero.
    f64 number = mal_ops_to_number(args[index]);
    if (number != number) {
        return 0;
    }
    if (number > (f64) INT64_MAX || number < -(f64) INT64_MAX) {
        return number;
    }

    return (f64) (i64) number;
}

/**
 * Append source's elements to result, recursing into nested arrays up to
 * depth levels deep. Holes are dropped, matching FlattenIntoArray. Leaves any
 * getter throw completion on the vm for the caller to check.
 */
static void mal_builtin_array_flatten_into(MalVm *vm, MalArrayObject *result, u32 *count, MalValue source, f64 depth) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, source, &length)) {
        return;
    }

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, source, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return;
            }
            continue;
        }

        if (depth > 0 && mal_value_is_array_object(element)) {
            mal_builtin_array_flatten_into(vm, result, count, element, depth - 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return;
            }
        } else {
            mal_builtin_array_store_index(result, (*count)++, element);
        }
    }
}

static MalValue mal_builtin_array_flat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;
    mal_builtin_array_flatten_into(vm, result, &count, this_value, mal_builtin_array_number_arg(args, arg_count, 0, 1));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_flat_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue mapped;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &mapped)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_array_object(mapped)) {
            u32 mapped_length = mal_array_object_length(mal_value_to_array_object(mapped));
            for (u32 inner = 0; inner < mapped_length; inner++) {
                MalValue inner_element;
                if (mal_builtin_array_try_get(vm, mapped, inner, &inner_element)) {
                    mal_builtin_array_store_index(result, count++, inner_element);
                }
            }
        } else {
            mal_builtin_array_store_index(result, count++, mapped);
        }
    }

    return mal_value_from_array_object(result);
}

/**
 * SortCompare without the undefined handling: callers partition undefined
 * elements and holes up front. A NaN comparator result counts as equal.
 */
static bool mal_builtin_array_sort_order(MalVm *vm, MalValue comparator, MalValue left, MalValue right, f64 *order_out) {
    if (mal_value_is_callable(comparator)) {
        MalValue args[] = {left, right};
        MalCompletion completion = mal_vm_call_value(vm, comparator, mal_value_new_undefined(), args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return false;
        }

        f64 raw = mal_ops_to_number(completion.value);
        *order_out = raw != raw ? 0 : raw;
        return true;
    }

    *order_out = (f64) mal_string_compare(mal_ops_to_string(&vm->heap, left), mal_ops_to_string(&vm->heap, right));
    return true;
}

/**
 * Stable bottom-up merge sort over a value buffer. Returns false when the
 * comparator threw; the buffer contents are unspecified in that case.
 */
static bool mal_builtin_array_sort_values(MalVm *vm, MalValue *values, u32 count, MalValue comparator) {
    if (count < 2) {
        return true;
    }

    MalValue *scratch = malloc(sizeof(MalValue) * count);
    MalValue *from = values;
    MalValue *to = scratch;
    bool ok = true;

    for (u32 width = 1; ok && width < count; width *= 2) {
        for (u32 low = 0; ok && low < count; low += width * 2) {
            u32 middle = low + width < count ? low + width : count;
            u32 high = low + width * 2 < count ? low + width * 2 : count;
            u32 left = low;
            u32 right = middle;
            u32 out = low;

            while (ok && left < middle && right < high) {
                f64 order;
                ok = mal_builtin_array_sort_order(vm, comparator, from[left], from[right], &order);
                if (ok) {
                    to[out++] = order <= 0 ? from[left++] : from[right++];
                }
            }
            while (left < middle) {
                to[out++] = from[left++];
            }
            while (right < high) {
                to[out++] = from[right++];
            }
        }

        MalValue *swap = from;
        from = to;
        to = swap;
    }

    if (ok && from != values) {
        memcpy(values, from, sizeof(MalValue) * count);
    }

    free(scratch);
    return ok;
}

/**
 * Validate the optional comparator argument, throwing the spec-mandated
 * TypeError for non-callable non-undefined values.
 */
static bool mal_builtin_array_comparator_arg(MalVm *vm, const MalValue *args, i32 arg_count, MalValue *comparator_out) {
    *comparator_out = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(*comparator_out) || mal_value_is_callable(*comparator_out)) {
        return true;
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The comparison function must be either a function or undefined");
    return false;
}

typedef struct MalBuiltinArraySorted {
    bool ok;
    MalValue *values;
    u32 defined_count;
    u32 undefined_count;
} MalBuiltinArraySorted;

/**
 * Collect and sort the receiver's elements: defined values sorted first, with
 * undefined values and holes counted so callers can re-append or trim them.
 * On failure the buffer is already freed and a throw completion is pending.
 */
static MalBuiltinArraySorted mal_builtin_array_sorted_elements(MalVm *vm, MalValue this_value, u32 length, MalValue comparator) {
    MalBuiltinArraySorted sorted = {.values = malloc(sizeof(MalValue) * (length > 0 ? length : 1))};

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                free(sorted.values);
                return sorted;
            }
            continue;
        }

        if (mal_value_is_undefined(element)) {
            sorted.undefined_count++;
        } else {
            sorted.values[sorted.defined_count++] = element;
        }
    }

    if (!mal_builtin_array_sort_values(vm, sorted.values, sorted.defined_count, comparator)) {
        free(sorted.values);
        return sorted;
    }

    sorted.ok = true;
    return sorted;
}

static MalValue mal_builtin_array_sort(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue comparator;
    if (!mal_builtin_array_comparator_arg(vm, args, arg_count, &comparator)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_array_object(this_value)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *array = mal_value_to_array_object(this_value);
    MalObject *object = (MalObject *) array;
    u32 length = mal_array_object_length(array);
    MalBuiltinArraySorted sorted = mal_builtin_array_sorted_elements(vm, this_value, length, comparator);
    if (!sorted.ok) {
        return mal_value_new_undefined();
    }

    // Sorted values first, then undefined values; what remains were holes.
    for (u32 index = 0; index < sorted.defined_count; index++) {
        mal_object_set(object, mal_builtin_array_index_key(index), sorted.values[index]);
    }
    for (u32 index = sorted.defined_count; index < sorted.defined_count + sorted.undefined_count; index++) {
        mal_object_set(object, mal_builtin_array_index_key(index), mal_value_new_undefined());
    }
    for (u32 index = sorted.defined_count + sorted.undefined_count; index < length; index++) {
        mal_object_delete_own(object, mal_builtin_array_index_key(index));
    }

    free(sorted.values);
    return this_value;
}

static MalValue mal_builtin_array_to_sorted(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue comparator;
    u32 length;
    if (!mal_builtin_array_comparator_arg(vm, args, arg_count, &comparator) || !mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    MalBuiltinArraySorted sorted = mal_builtin_array_sorted_elements(vm, this_value, length, comparator);
    if (!sorted.ok) {
        return mal_value_new_undefined();
    }

    // The copy is dense: undefined values and holes both sort to the end as
    // undefined elements.
    MalArrayObject *result = mal_intrinsic_new_array(vm, length);
    for (u32 index = 0; index < length; index++) {
        MalValue element = index < sorted.defined_count ? sorted.values[index] : mal_value_new_undefined();
        mal_object_set((MalObject *) result, mal_builtin_array_index_key(index), element);
    }

    free(sorted.values);
    return mal_value_from_array_object(result);
}

/**
 * Shared splice/toSpliced delete-count handling: absent means "to the end",
 * otherwise the count clamps to [0, length - start].
 */
static u32 mal_builtin_array_delete_count(const MalValue *args, i32 arg_count, u32 start, u32 length) {
    if (arg_count == 0) {
        return 0;
    }
    if (arg_count == 1) {
        return length - start;
    }

    f64 raw = mal_builtin_array_number_arg(args, arg_count, 1, 0);
    if (!(raw > 0)) {
        return 0;
    }
    if (raw > (f64) (length - start)) {
        return length - start;
    }

    return (u32) raw;
}

static MalValue mal_builtin_array_splice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_object(this_value)) {
        // Primitive receivers have nothing to remove or mutate.
        return mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    }

    // ArraySpeciesCreate approximation: a non-object, non-undefined
    // constructor is rejected; object constructors fall back to the default
    // array since Symbol.species is unsupported.
    MalPropertyResolution ctor = mal_object_resolve_property(
        mal_value_to_object(this_value),
        mal_intrinsic_string_key(vm, "constructor")
    );
    if (ctor.found) {
        MalValue ctor_value;
        if (!mal_vm_desc_read(vm, ctor.desc, this_value, &ctor_value)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(ctor_value) && !mal_value_is_object(ctor_value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor is not an object");
            return mal_value_new_undefined();
        }
    }

    u32 start = arg_count >= 1 ? mal_builtin_array_clamp_relative(args[0], 0, length) : 0;
    u32 delete_count = mal_builtin_array_delete_count(args, arg_count, start, length);
    u32 insert_count = arg_count > 2 ? (u32) (arg_count - 2) : 0;
    u32 new_length = length - delete_count + insert_count;

    MalArrayObject *removed = mal_intrinsic_new_array(vm, delete_count);
    for (u32 index = 0; index < delete_count; index++) {
        MalValue element;
        if (mal_builtin_array_try_get(vm, this_value, start + index, &element)) {
            mal_object_set((MalObject *) removed, mal_builtin_array_index_key(index), element);
        } else if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    if (insert_count < delete_count) {
        for (u32 from = start + delete_count; from < length; from++) {
            u32 to = from - delete_count + insert_count;
            MalValue element;
            bool present = mal_builtin_array_try_get(vm, this_value, from, &element);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            if (present
                    ? !mal_builtin_array_set_or_throw(vm, this_value, mal_builtin_array_index_key(to), element)
                    : !mal_builtin_array_delete_or_throw(vm, this_value, mal_builtin_array_index_key(to))) {
                return mal_value_new_undefined();
            }
        }
        for (u32 index = new_length; index < length; index++) {
            if (!mal_builtin_array_delete_or_throw(vm, this_value, mal_builtin_array_index_key(index))) {
                return mal_value_new_undefined();
            }
        }
    } else if (insert_count > delete_count) {
        // Shift the tail upwards back-to-front so sources are read before
        // they are overwritten.
        for (u32 from = length; from-- > start + delete_count;) {
            u32 to = from - delete_count + insert_count;
            MalValue element;
            bool present = mal_builtin_array_try_get(vm, this_value, from, &element);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            if (present
                    ? !mal_builtin_array_set_or_throw(vm, this_value, mal_builtin_array_index_key(to), element)
                    : !mal_builtin_array_delete_or_throw(vm, this_value, mal_builtin_array_index_key(to))) {
                return mal_value_new_undefined();
            }
        }
    }

    for (u32 index = 0; index < insert_count; index++) {
        if (!mal_builtin_array_set_or_throw(vm, this_value, mal_builtin_array_index_key(start + index), args[2 + (i32) index])) {
            return mal_value_new_undefined();
        }
    }

    // The final length write honors non-writable array lengths and plain
    // receivers whose length is a getter-only accessor.
    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_value_from_i32((i32) new_length))) {
        return mal_value_new_undefined();
    }

    return mal_value_from_array_object(removed);
}

static MalValue mal_builtin_array_to_spliced(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    u32 start = arg_count >= 1 ? mal_builtin_array_clamp_relative(args[0], 0, length) : 0;
    u32 skip_count = mal_builtin_array_delete_count(args, arg_count, start, length);
    u32 insert_count = arg_count > 2 ? (u32) (arg_count - 2) : 0;

    MalArrayObject *result = mal_intrinsic_new_array(vm, length - skip_count + insert_count);
    u32 out = 0;

    for (u32 index = 0; index < start; index++) {
        mal_object_set((MalObject *) result, mal_builtin_array_index_key(out++), mal_builtin_array_get(vm, this_value, index));
    }
    for (u32 index = 0; index < insert_count; index++) {
        mal_object_set((MalObject *) result, mal_builtin_array_index_key(out++), args[2 + (i32) index]);
    }
    for (u32 index = start + skip_count; index < length; index++) {
        mal_object_set((MalObject *) result, mal_builtin_array_index_key(out++), mal_builtin_array_get(vm, this_value, index));
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_copy_within(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_object(this_value)) {
        // Primitive receivers have nothing to mutate.
        return this_value;
    }

    u32 target = arg_count >= 1 ? mal_builtin_array_clamp_relative(args[0], 0, length) : 0;
    u32 start = arg_count >= 2 ? mal_builtin_array_clamp_relative(args[1], 0, length) : 0;
    u32 end = arg_count >= 3 && !mal_value_is_undefined(args[2])
        ? mal_builtin_array_clamp_relative(args[2], (f64) length, length)
        : length;

    u32 count = end > start ? end - start : 0;
    if (count > length - target) {
        count = length - target;
    }

    for (u32 step = 0; step < count; step++) {
        // Overlapping regions copy back-to-front so sources are read before
        // they are overwritten.
        u32 moved = target > start ? count - 1 - step : step;

        MalValue element;
        bool present = mal_builtin_array_try_get(vm, this_value, start + moved, &element);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        if (present
                ? !mal_builtin_array_set_or_throw(vm, this_value, mal_builtin_array_index_key(target + moved), element)
                : !mal_builtin_array_delete_or_throw(vm, this_value, mal_builtin_array_index_key(target + moved))) {
            return mal_value_new_undefined();
        }
    }

    return this_value;
}

static MalValue mal_builtin_array_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    f64 relative = mal_builtin_array_number_arg(args, arg_count, 0, 0);
    if (relative < 0) {
        relative += (f64) length;
    }
    if (relative < 0 || relative >= (f64) length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid index");
        return mal_value_new_undefined();
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, length);
    for (u32 index = 0; index < length; index++) {
        MalValue element = index == (u32) relative
            ? (arg_count >= 2 ? args[1] : mal_value_new_undefined())
            : mal_builtin_array_get(vm, this_value, index);
        mal_object_set((MalObject *) result, mal_builtin_array_index_key(index), element);
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_to_reversed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, length);
    for (u32 index = 0; index < length; index++) {
        mal_object_set(
            (MalObject *) result,
            mal_builtin_array_index_key(index),
            mal_builtin_array_get(vm, this_value, length - 1 - index)
        );
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_array_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    // Array.prototype.toString delegates to this.join when callable.
    if (mal_value_is_object(this_value)) {
        MalPropertyResolution resolution = mal_object_resolve_property(
            mal_value_to_object(this_value),
            mal_intrinsic_string_key(vm, "join")
        );

        MalValue join = mal_value_new_undefined();
        if (resolution.found && !mal_vm_desc_read(vm, resolution.desc, this_value, &join)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_callable(join)) {
            MalCompletion completion = mal_vm_call_value(vm, join, this_value, nullptr, 0);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = completion;
                return mal_value_new_undefined();
            }

            return completion.value;
        }
    }

    // No callable join: fall through to Object.prototype.toString, which
    // tags primitives with their wrapper class.
    return mal_builtin_object_prototype_to_string(vm, this_value, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue mal_builtin_array_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    // Pragmatic: elements format through ToString rather than their own
    // toLocaleString methods.
    return mal_builtin_array_join(vm, this_value, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue mal_builtin_array_prototype_iterator(MalVm *vm, MalValue this_value, MalIteratorKind kind) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot iterate null or undefined");
        return mal_value_new_undefined();
    }

    return mal_vm_new_builtin_iterator(vm, kind, this_value);
}

static MalValue mal_builtin_array_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_array_prototype_iterator(vm, this_value, MAL_ITERATOR_ARRAY_VALUES);
}

static MalValue mal_builtin_array_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_array_prototype_iterator(vm, this_value, MAL_ITERATOR_ARRAY_KEYS);
}

static MalValue mal_builtin_array_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_array_prototype_iterator(vm, this_value, MAL_ITERATOR_ARRAY_ENTRIES);
}

void mal_builtin_array_install(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Array"),
        1,
        mal_builtin_array_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;
    vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, constructor_object, "isArray", 1, mal_builtin_array_is_array);
    mal_intrinsic_define_method_n(vm, constructor_object, "of", 0, mal_builtin_array_of);
    mal_intrinsic_define_method_n(vm, constructor_object, "from", 1, mal_builtin_array_from);

    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_MAP] =
        mal_intrinsic_define_method_n(vm, prototype, "map", 1, mal_builtin_array_map);
    mal_intrinsic_define_method_n(vm, prototype, "forEach", 1, mal_builtin_array_for_each);
    mal_intrinsic_define_method_n(vm, prototype, "filter", 1, mal_builtin_array_filter);
    mal_intrinsic_define_method_n(vm, prototype, "reduce", 1, mal_builtin_array_reduce);
    mal_intrinsic_define_method_n(vm, prototype, "reduceRight", 1, mal_builtin_array_reduce_right);
    mal_intrinsic_define_method_n(vm, prototype, "find", 1, mal_builtin_array_find);
    mal_intrinsic_define_method_n(vm, prototype, "findIndex", 1, mal_builtin_array_find_index);
    mal_intrinsic_define_method_n(vm, prototype, "findLast", 1, mal_builtin_array_find_last);
    mal_intrinsic_define_method_n(vm, prototype, "findLastIndex", 1, mal_builtin_array_find_last_index);
    mal_intrinsic_define_method_n(vm, prototype, "flat", 0, mal_builtin_array_flat);
    mal_intrinsic_define_method_n(vm, prototype, "flatMap", 1, mal_builtin_array_flat_map);
    mal_intrinsic_define_method_n(vm, prototype, "some", 1, mal_builtin_array_some);
    mal_intrinsic_define_method_n(vm, prototype, "every", 1, mal_builtin_array_every);
    mal_intrinsic_define_method_n(vm, prototype, "indexOf", 1, mal_builtin_array_index_of);
    mal_intrinsic_define_method_n(vm, prototype, "lastIndexOf", 1, mal_builtin_array_last_index_of);
    mal_intrinsic_define_method_n(vm, prototype, "includes", 1, mal_builtin_array_includes);
    mal_intrinsic_define_method_n(vm, prototype, "push", 1, mal_builtin_array_push);
    mal_intrinsic_define_method_n(vm, prototype, "pop", 0, mal_builtin_array_pop);
    mal_intrinsic_define_method_n(vm, prototype, "shift", 0, mal_builtin_array_shift);
    mal_intrinsic_define_method_n(vm, prototype, "unshift", 1, mal_builtin_array_unshift);
    mal_intrinsic_define_method_n(vm, prototype, "slice", 2, mal_builtin_array_slice);
    mal_intrinsic_define_method_n(vm, prototype, "concat", 1, mal_builtin_array_concat);
    mal_intrinsic_define_method_n(vm, prototype, "join", 1, mal_builtin_array_join);
    mal_intrinsic_define_method_n(vm, prototype, "reverse", 0, mal_builtin_array_reverse);
    mal_intrinsic_define_method_n(vm, prototype, "fill", 1, mal_builtin_array_fill);
    mal_intrinsic_define_method_n(vm, prototype, "at", 1, mal_builtin_array_at);
    mal_intrinsic_define_method_n(vm, prototype, "sort", 1, mal_builtin_array_sort);
    mal_intrinsic_define_method_n(vm, prototype, "splice", 2, mal_builtin_array_splice);
    mal_intrinsic_define_method_n(vm, prototype, "copyWithin", 2, mal_builtin_array_copy_within);
    mal_intrinsic_define_method_n(vm, prototype, "with", 2, mal_builtin_array_with);
    mal_intrinsic_define_method_n(vm, prototype, "toReversed", 0, mal_builtin_array_to_reversed);
    mal_intrinsic_define_method_n(vm, prototype, "toSorted", 1, mal_builtin_array_to_sorted);
    mal_intrinsic_define_method_n(vm, prototype, "toSpliced", 2, mal_builtin_array_to_spliced);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_array_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_array_to_locale_string);
    mal_intrinsic_define_method_n(vm, prototype, "keys", 0, mal_builtin_array_keys);
    mal_intrinsic_define_method_n(vm, prototype, "entries", 0, mal_builtin_array_entries);
    MalValue values = mal_intrinsic_define_method_n(vm, prototype, "values", 0, mal_builtin_array_values);

    // Array.prototype[Symbol.iterator] === Array.prototype.values
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(values, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_desc);

    mal_intrinsic_define_species(vm, constructor_object);
}
