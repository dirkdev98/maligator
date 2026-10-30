#include "builtin_array.h"

#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_async_iterator.h"
#include "builtin_iterator.h"
#include "builtin_math.h"
#include "builtin_map.h"
#include "builtin_object.h"
#include "builtin_promise.h"
#include "builtin_set.h"
#include "builtin_typed_array.h"
#include "checked_size.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "microtask.h"
#include "perf_stats.h"
#include "primitive_wrapper_object.h"
#include "proxy_object.h"
#include "rooted_collection.h"
#include "typed_array_object.h"
#include "text_buffer.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static bool mal_array_default_species(MalVm *vm, MalValue recv);

typedef struct MalArrayJoinFrame {
    MalObject *receiver;
    struct MalArrayJoinFrame *previous;
} MalArrayJoinFrame;

static bool mal_builtin_array_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static bool mal_builtin_array_numeric_key(MalVm *vm, f64 index, MalKey *key_out) {
    return mal_vm_value_to_property_key(vm, mal_ops_number_value(index), key_out);
}

/**
 * Exact ordinary Array with an index-clean intrinsic prototype chain. While
 * this holds, a dense hole is observably absent and Get may return undefined
 * without walking prototypes. The check is repeated after every user-code seam.
 */
static MalArrayObject *mal_builtin_array_clean_dense(
    MalVm *vm, MalValue value
) {
    if (!mal_vm_array_elements_intact(vm) ||
        !mal_value_is_array_object(value)) {
        return nullptr;
    }
    MalValue prototype = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalArrayObject *array = mal_value_to_array_object(value);
    if (!mal_value_is_array_object(prototype) || array->dense_deopted ||
        mal_object_prototype(&array->object) != mal_value_to_object(prototype)) {
        return nullptr;
    }
    return array;
}

/**
 * Exact ordinary Array result whose unpublished dense tail can be populated
 * without re-entering property machinery. This mirrors the guarded direct
 * CreateDataProperty path below, while additionally requiring the builder's
 * next index to match the vector frontier.
 */
static MalArrayObject *mal_builtin_array_dense_builder(
    MalValue value, u32 start
) {
    if (!mal_value_is_array_object(value)) {
        return nullptr;
    }
    MalArrayObject *array = mal_value_to_array_object(value);
    if (array->dense_deopted || !array->object.extensible ||
        !array->length_writable || array->length != start ||
        array->dense_count != start || array->object.fast_elements_proto ||
        array->object.is_prototype || array->object.watched_method_proto) {
        return nullptr;
    }
    return array;
}

static MalArrayObject *mal_builtin_array_presized_dense_builder(
    MalValue value, u32 length
) {
    if (!mal_value_is_array_object(value)) {
        return nullptr;
    }
    MalArrayObject *array = mal_value_to_array_object(value);
    if (array->dense_deopted || !array->object.extensible ||
        !array->length_writable || array->length != length ||
        array->dense_count != 0 || array->capacity != 0 ||
        array->elements != nullptr || array->object.fast_elements_proto ||
        array->object.is_prototype || array->object.watched_method_proto) {
        return nullptr;
    }
    return array;
}

static bool mal_builtin_array_try_get_wide(MalVm *vm, MalValue this_value, f64 index, MalValue *out) {
    if (mal_value_is_string(this_value)) {
        MalString *string = mal_value_to_string(this_value);
        if (index < 0 || index >= (f64) mal_string_length(string)) {
            return false;
        }

        *out = mal_value_from_string(
            mal_intrinsic_code_unit(vm, mal_string_code_unit_at(string, (usize) index))
        );
        return true;
    }

    if (!mal_value_is_object(this_value)) {
        return false;
    }

    if (mal_value_is_array_object(this_value) && index >= 0 &&
        index < (f64) UINT32_MAX) {
        u32 dense_index = (u32) index;
        if ((f64) dense_index == index) {
            MalArrayObject *array = mal_value_to_array_object(this_value);
            if (mal_array_object_dense_get(array, dense_index, out)) {
                return true;
            }
            if (mal_builtin_array_clean_dense(vm, this_value) != nullptr) {
                return false;
            }
        }
    }

    MalKey index_key;
    if (!mal_builtin_array_numeric_key(vm, index, &index_key)
        || !mal_vm_has_property(vm, this_value, index_key)) {
        return false;
    }

    return mal_vm_get_property(vm, this_value, index_key, out);
}

// Get(O, index): unlike try_get_wide, a missing element is not probed with HasProperty first.
static MalValue mal_builtin_array_get_wide(MalVm *vm, MalValue this_value, f64 index) {
    MalValue element = mal_value_new_undefined();
    if (mal_value_is_array_object(this_value) && index >= 0 && index < (f64) UINT32_MAX &&
        (f64) (u32) index == index) {
        if (mal_array_object_dense_get(mal_value_to_array_object(this_value), (u32) index, &element)) {
            return element;
        }
        if (mal_builtin_array_clean_dense(vm, this_value) != nullptr) {
            return element;
        }
    }
    MalKey index_key;
    if (mal_builtin_array_numeric_key(vm, index, &index_key)) {
        mal_vm_get_property(vm, this_value, index_key, &element);
    }
    return element;
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

        *out = mal_value_from_string(
            mal_intrinsic_code_unit(vm, mal_string_code_unit_at(string, index))
        );
        return true;
    }

    if (!mal_value_is_object(this_value)) {
        return false;
    }

    if (mal_value_is_array_object(this_value)) {
        MalArrayObject *array = mal_value_to_array_object(this_value);
        if (mal_array_object_dense_get(array, index, out)) {
            return true;
        }
        if (mal_builtin_array_clean_dense(vm, this_value) != nullptr) {
            return false;
        }
    }

    // Spec-shaped read: if HasProperty(O, Pk) then Get(O, Pk); otherwise a hole.
    // Going through Has/Get (not the raw property table) observes a TypedArray's
    // exotic indices, a Proxy's traps, a String wrapper's chars, and inherited
    // index accessors — none of which live in O's own table.
    MalKey index_key = mal_key_index(index);
    if (!mal_vm_has_property(vm, this_value, index_key)) {
        return false;
    }

    return mal_vm_get_property(vm, this_value, index_key, out);
}

static MalValue mal_builtin_array_get(MalVm *vm, MalValue this_value, u32 index) {
    return mal_builtin_array_get_wide(vm, this_value, (f64) index);
}

static bool mal_builtin_array_try_store_dense_index(
    MalArrayObject *array, u32 index, MalValue value
) {
    bool grows = index >= array->length;
    if (!array->dense_deopted && array->dense_elements_writable &&
        array->object.extensible &&
        (!grows || array->length_writable) &&
        mal_array_object_dense_store(array, index, value) ==
            MAL_ARRAY_DENSE_APPLIED) {
        if (grows) {
            array->length = index + 1;
        }
        return true;
    }
    return false;
}

static void mal_builtin_array_store_index(MalArrayObject *array, u32 index, MalValue value) {
    if (mal_builtin_array_try_store_dense_index(array, index, value)) {
        return;
    }
    mal_array_object_store(array, mal_key_index(index), value);
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

    // A TypedArray index is an integer-indexed exotic slot, not an ordinary
    // property: route it through the element setter (ToNumber-coerces, then
    // writes or silently drops when out of bounds) per IntegerIndexedElementSet.
    if (mal_value_is_typed_array_object(receiver) && key.kind == MAL_KEY_INDEX) {
        mal_typed_array_object_set(vm, mal_value_to_typed_array_object(receiver), mal_key_index_value(key), value);
        return vm->completion.kind != MAL_COMPLETION_THROW;
    }

    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap,
            mal_value_to_object(receiver),
            key,
            &string_exotic
        )) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        return false;
    }

    if (mal_value_is_proxy_object(receiver)) {
        if (mal_vm_set_property(vm, receiver, key, value, receiver)) {
            return true;
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
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
        ? mal_array_object_set(mal_value_to_array_object(receiver), key, value)
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

    if (mal_value_is_proxy_object(receiver)) {
        if (mal_vm_delete_property(vm, receiver, key)) {
            return true;
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return false;
    }

    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap,
            mal_value_to_object(receiver),
            key,
            &string_exotic
        ) || !mal_object_delete_own(mal_value_to_object(receiver), key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return false;
    }

    return true;
}

static bool mal_builtin_array_set_index_or_throw(MalVm *vm, MalValue receiver, f64 index, MalValue value) {
    MalKey key;
    return mal_builtin_array_numeric_key(vm, index, &key)
        && mal_builtin_array_set_or_throw(vm, receiver, key, value);
}

static bool mal_builtin_array_delete_index_or_throw(MalVm *vm, MalValue receiver, f64 index) {
    MalKey key;
    return mal_builtin_array_numeric_key(vm, index, &key)
        && mal_builtin_array_delete_or_throw(vm, receiver, key);
}

/**
 * Call a (element, index, array) style callback on the given this, propagating
 * abnormal completions to the VM.
 */
static bool mal_builtin_array_invoke_wide(MalVm *vm, MalValue callback, MalValue this_arg, MalValue element, f64 index, MalValue this_value, MalValue *out) {
    MalValue args[] = {element, mal_ops_number_value(index), this_value};
    // The callback can trigger a collection (directly, or via a getter/coercion
    // it performs); `element` may be a fresh getter result the caller no longer
    // roots, so make the argument buffer a scanned root across the call.
    MalRootSpan span;
    mal_gc_root(&span, args, 3);
    MalCompletion completion = mal_vm_call_builtin_callback(
        vm, callback, this_arg, args, 3);
    mal_gc_unroot(&span);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *out = completion.value;
    return true;
}

static bool mal_builtin_array_invoke(MalVm *vm, MalValue callback, MalValue this_arg, MalValue element, u32 index, MalValue this_value, MalValue *out) {
    return mal_builtin_array_invoke_wide(vm, callback, this_arg, element, (f64) index, this_value, out);
}

/**
 * Spec-shaped prologue for the generic Array.prototype methods: any receiver
 * except null and undefined is accepted, and the iteration length is read
 * from its length property through ToLength, clamped to 2^53-1. Strings answer
 * with their code unit count, other primitives carry no elements. The public
 * u32 wrapper below preserves the storage-width contract for unaffected callers.
 */
static bool mal_builtin_array_length_of_array_like(MalVm *vm, MalValue this_value, f64 *length_out) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.prototype method called on null or undefined");
        return false;
    }

    if (mal_value_is_array_object(this_value)) {
        *length_out = (f64) mal_array_object_length(mal_value_to_array_object(this_value));
        return true;
    }

    if (mal_value_is_string(this_value)) {
        *length_out = (f64) mal_string_length(mal_value_to_string(this_value));
        return true;
    }

    if (!mal_value_is_object(this_value)) {
        *length_out = 0;
        return true;
    }

    // A String wrapper's exotic `length` lives outside the property table.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap,
            mal_value_to_object(this_value),
            mal_intrinsic_string_key(vm, "length"),
            &string_exotic
        )) {
        *length_out = (f64) mal_value_to_i32(string_exotic.value);
        return true;
    }

    // Full Get(O, "length") so a TypedArray's exotic length, an inherited
    // accessor, or a Proxy trap is observed (not just own table entries).
    MalValue length_value;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return false;
    }

    // ToLength: ToNumber (full ToPrimitive for objects, throwing on a Symbol or
    // BigInt length), truncate, then clamp to [0, 2^53-1].
    f64 raw;
    if (mal_ops_is_number(length_value)) {
        raw = mal_ops_number_as_f64(length_value);
    } else if (!mal_vm_to_number(vm, length_value, &raw)) {
        return false;
    }
    *length_out = mal_ops_number_to_length(raw);

    return true;
}

bool mal_builtin_array_this_length(MalVm *vm, MalValue this_value, u32 *length_out) {
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return false;
    }
    *length_out = length >= (f64) UINT32_MAX ? UINT32_MAX : (u32) length;
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
 * §23.1.3: the generic Array.prototype methods begin with O = ? ToObject(this
 * value). Throws a TypeError on null/undefined and boxes a primitive into its
 * wrapper so length/index reads consult the wrapper's prototype and the
 * callback receives (and the copy methods return) an object rather than the raw
 * primitive. Leaves an already-object receiver untouched. `*this_value` is
 * updated in place; callers must root it across any collection point (the boxed
 * wrapper is a fresh heap object the call seam does not know about).
 */
static bool mal_builtin_array_to_object(MalVm *vm, MalValue *this_value) {
    if (mal_value_is_nil(*this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.prototype method called on null or undefined");
        return false;
    }
    if (!mal_value_is_object(*this_value)) {
        *this_value = mal_builtin_object_box_primitive(vm, *this_value);
    }
    return true;
}

/**
 * ToIntegerOrInfinity-flavored relative index handling: negative values count
 * back from length, the result is clamped to [0, length].
 */
static f64 mal_builtin_array_clamp_relative_wide(MalVm *vm, MalValue value, f64 fallback, f64 length) {
    // A pending throw from an earlier argument's coercion short-circuits the
    // rest: spec ToIntegerOrInfinity on later arguments never runs once one
    // throws, so callers can compute every index and check the completion once.
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return 0;
    }
    // A present argument goes through ToIntegerOrInfinity (NaN -> 0,
    // truncated toward zero); undefined keeps the caller's fallback so
    // omitted end arguments still mean "to the end". ToNumber throws on a
    // Symbol or BigInt argument (leaving the throw for the caller to detect).
    f64 relative = fallback;
    if (!mal_value_is_undefined(value)) {
        f64 number;
        if (mal_ops_is_number(value)) {
            number = mal_ops_number_as_f64(value);
        } else if (!mal_vm_to_number(vm, value, &number)) {
            return 0;
        }
        relative = mal_ops_number_to_integer_or_infinity(number);
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

    return relative;
}

static u32 mal_builtin_array_clamp_relative(MalVm *vm, MalValue value, f64 fallback, u32 length) {
    return (u32) mal_builtin_array_clamp_relative_wide(vm, value, fallback, (f64) length);
}

static bool mal_builtin_array_same_value_zero(MalValue left, MalValue right) {
    if (mal_value_to_boolean(mal_ops_strict_equal(left, right))) {
        return true;
    }

    return mal_value_is_nan(left) && mal_value_is_nan(right);
}

static bool mal_builtin_array_numeric_search_matches(
    MalValue element,
    MalValue search,
    f64 search_number,
    bool nan_matches
) {
    if (element == search) {
        return nan_matches || !isnan(search_number);
    }
    if (!mal_ops_is_number(element)) {
        return false;
    }
    f64 element_number = mal_ops_number_as_f64(element);
    return element_number == search_number ||
        (nan_matches && isnan(element_number) && isnan(search_number));
}

static bool mal_builtin_array_int32_search_matches(
    MalValue element,
    MalValue search,
    f64 search_number
) {
    if (element == search) {
        return true;
    }
    if (mal_value_is_int32(element)) {
        return false;
    }
    return mal_value_is_f64(element) && mal_value_to_f64(element) == search_number;
}

static bool mal_builtin_array_numeric_search_words(
    MalValue search,
    MalValue *first,
    MalValue *second
) {
    f64 number;
    if (mal_value_is_int32(search)) {
        i32 integer = mal_value_to_i32(search);
        if (integer == 0) return false;
        number = (f64) integer;
    } else if (mal_value_is_f64(search)) {
        number = mal_value_to_f64(search);
        // Zero has two encodings, and NaN never strictly equals its own bits.
        if (number == 0.0 || isnan(number)) return false;
    } else {
        return false;
    }

    *first = mal_value_from_f64(number);
    *second = *first;
    if (number >= INT32_MIN && number <= INT32_MAX) {
        i32 integer = (i32) number;
        if ((f64) integer == number) {
            *second = mal_value_from_i32(integer);
        }
    }
    return true;
}

typedef u64 MalWordLanes __attribute__((vector_size(16)));

static bool mal_builtin_array_block_has_word(
    const MalValue *block, MalWordLanes first, MalWordLanes second
) {
    MalWordLanes a, b, c, d;
    memcpy(&a, block, sizeof(a));
    memcpy(&b, block + 2, sizeof(b));
    memcpy(&c, block + 4, sizeof(c));
    memcpy(&d, block + 6, sizeof(d));
    MalWordLanes hits = (MalWordLanes) (
        (a == first) | (a == second) | (b == first) | (b == second) |
        (c == first) | (c == second) | (d == first) | (d == second));
    return (hits[0] | hits[1]) != 0;
}

// Compilers keep an early-exit scan scalar, so whole blocks of eight elements are
// rejected with vector compares before the scalar scan locates the hit.
static u32 mal_builtin_array_find_word(
    const MalValue *elements, u32 start, u32 end, MalValue first, MalValue second
) {
    MalWordLanes first_lanes = {first, first};
    MalWordLanes second_lanes = {second, second};
    u32 index = start;
    while (end - index >= 8 &&
           !mal_builtin_array_block_has_word(elements + index, first_lanes, second_lanes)) {
        index += 8;
    }
    for (; index < end; index++) {
        if (elements[index] == first || elements[index] == second) return index;
    }
    return UINT32_MAX;
}

// Searches elements [0, last] from `last` down.
static u32 mal_builtin_array_find_word_reverse(
    const MalValue *elements, u32 last, MalValue first, MalValue second
) {
    MalWordLanes first_lanes = {first, first};
    MalWordLanes second_lanes = {second, second};
    u32 bound = last + 1;
    while (bound >= 8 &&
           !mal_builtin_array_block_has_word(elements + bound - 8, first_lanes, second_lanes)) {
        bound -= 8;
    }
    while (bound > 0) {
        bound--;
        if (elements[bound] == first || elements[bound] == second) return bound;
    }
    return UINT32_MAX;
}

static MalValue mal_builtin_array_dense_numeric_index_of(
    const MalArrayObject *array, MalValue search, u32 start
) {
    u32 end = array->dense_count < array->length
        ? array->dense_count
        : array->length;
    MalValue first;
    MalValue second;
    if (mal_builtin_array_numeric_search_words(search, &first, &second)) {
        u32 found = start < end
            ? mal_builtin_array_find_word(array->elements, start, end, first, second)
            : UINT32_MAX;
        return found == UINT32_MAX ? mal_value_from_i32(-1) : mal_value_from_u32(found);
    }

    bool int32_search = mal_value_is_int32(search);
    f64 search_number = mal_ops_number_as_f64(search);
    for (u32 index = start; index < end; index++) {
        MalValue element = array->elements[index];
        bool matches = int32_search
            ? mal_builtin_array_int32_search_matches(
                element, search, search_number)
            : mal_builtin_array_numeric_search_matches(
                element, search, search_number, false);
        if (matches) return mal_value_from_u32(index);
    }
    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_dense_numeric_last_index_of(
    const MalArrayObject *array, MalValue search, u32 start
) {
    u32 end = array->dense_count < array->length
        ? array->dense_count
        : array->length;
    if (end == 0) return mal_value_from_i32(-1);

    u32 index = start < end ? start : end - 1;
    MalValue first;
    MalValue second;
    if (mal_builtin_array_numeric_search_words(search, &first, &second)) {
        u32 found = mal_builtin_array_find_word_reverse(array->elements, index, first, second);
        return found == UINT32_MAX ? mal_value_from_i32(-1) : mal_value_from_u32(found);
    }

    bool int32_search = mal_value_is_int32(search);
    f64 search_number = mal_ops_number_as_f64(search);
    for (;;) {
        MalValue element = array->elements[index];
        bool matches = int32_search
            ? mal_builtin_array_int32_search_matches(
                element, search, search_number)
            : mal_builtin_array_numeric_search_matches(
                element, search, search_number, false);
        if (matches) return mal_value_from_u32(index);
        if (index == 0) break;
        index--;
    }
    return mal_value_from_i32(-1);
}

static bool mal_builtin_array_dense_numeric_includes(
    const MalArrayObject *array, MalValue search, u32 start
) {
    u32 end = array->dense_count < array->length
        ? array->dense_count
        : array->length;
    MalValue first;
    MalValue second;
    if (mal_builtin_array_numeric_search_words(search, &first, &second)) {
        return start < end &&
            mal_builtin_array_find_word(array->elements, start, end, first, second) != UINT32_MAX;
    }

    bool int32_search = mal_value_is_int32(search);
    f64 search_number = mal_ops_number_as_f64(search);
    for (u32 index = start; index < end; index++) {
        MalValue element = array->elements[index];
        if (int32_search
                ? mal_builtin_array_int32_search_matches(
                    element, search, search_number)
                : mal_builtin_array_numeric_search_matches(
                    element, search, search_number, true)) {
            return true;
        }
    }
    return false;
}

static bool mal_builtin_array_dense_range_present(
    const MalArrayObject *array, u32 start, u32 end
) {
    for (u32 index = start; index < end; index++) {
        if (!mal_array_object_dense_has(array, index)) {
            return false;
        }
    }
    return true;
}

static bool mal_builtin_array_dense_shift_compatible(
    const MalArrayObject *array
) {
    if (array->object.extensible) {
        return true;
    }
    for (u32 index = 1; index < array->dense_count; index++) {
        if (mal_array_object_dense_has(array, index) &&
            !mal_array_object_dense_has(array, index - 1)) {
            return false;
        }
    }
    return true;
}

static bool mal_builtin_array_dense_reverse_compatible(
    const MalArrayObject *array
) {
    if (array->object.extensible) {
        return true;
    }
    for (u32 lower = 0; lower < array->length / 2; lower++) {
        u32 upper = array->length - 1 - lower;
        if (mal_array_object_dense_has(array, lower) !=
            mal_array_object_dense_has(array, upper)) {
            return false;
        }
    }
    return true;
}

static bool mal_builtin_array_dense_copy_compatible(
    const MalArrayObject *array, u32 target, u32 start, u32 count
) {
    if (array->object.extensible) {
        return true;
    }
    for (u32 offset = 0; offset < count; offset++) {
        if (mal_array_object_dense_has(array, start + offset) &&
            !mal_array_object_dense_has(array, target + offset)) {
            return false;
        }
    }
    return true;
}

static bool mal_builtin_array_create_data_property_wide(MalVm *vm, MalValue target, f64 index, MalValue value);
static bool mal_builtin_array_create_data_property(MalVm *vm, MalValue target, u32 index, MalValue value);
static bool mal_builtin_array_from_set_length(MalVm *vm, MalValue a, u32 length);

static MalValue mal_builtin_array_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // A single Number argument is the new array's length: ToUint32(len) must
    // round-trip (a fractional, negative or >= 2^32 length is a RangeError).
    if (arg_count == 1 && mal_ops_is_number(args[0])) {
        f64 number = mal_ops_number_as_f64(args[0]);
        u32 length = mal_ops_number_to_uint32(number);
        if ((f64) length != number) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
            return mal_value_new_undefined();
        }
        return mal_value_from_array_object(mal_intrinsic_new_array(vm, length));
    }

    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, (u32) arg_count);
    if (!mal_array_object_dense_build_values(
            array, 0, args, (u32) arg_count)) {
        for (i32 i = 0; i < arg_count; i++) {
            mal_builtin_array_store_index(array, (u32) i, args[i]);
        }
    }

    return mal_value_from_array_object(array);
}

static MalValue mal_builtin_array_is_array(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    bool is_array;
    if (!mal_vm_is_array(vm, value, &is_array)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(is_array);
}

static MalValue mal_builtin_array_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    u32 length = (u32) arg_count;
    bool plain_mode = !mal_vm_is_constructor(vm, this_value)
        || this_value == vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];

    // The exact active %Array% and the non-constructor fallback both perform an
    // unobservable ArrayCreate. Keep that dense fast path; every other constructor
    // must observe Construct(C, « len »), CreateDataPropertyOrThrow, and Set(length).
    if (plain_mode) {
        MalArrayObject *array = mal_intrinsic_new_dense_array(vm, length);
        if (!mal_array_object_dense_build_values(
                array, 0, args, length)) {
            for (i32 i = 0; i < arg_count; i++) {
                mal_builtin_array_store_index(array, (u32) i, args[i]);
            }
        }
        return mal_value_from_array_object(array);
    }

    MalValue len_arg = mal_value_from_u32(length);
    MalCompletion constructed = mal_vm_construct_value(vm, this_value, &len_arg, 1);
    if (constructed.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = constructed;
        return mal_value_new_undefined();
    }

    MalValue result = constructed.value;
    MalRootSpan span;
    mal_gc_root(&span, &result, 1);
    mal_gc_native_rooted_begin(vm);
    for (u32 index = 0; index < length; index++) {
        if (!mal_builtin_array_create_data_property(vm, result, index, args[index])) {
            goto done;
        }
    }
    if (!mal_builtin_array_from_set_length(vm, result, length)) {
        goto done;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined()
        : result;
}

static bool mal_builtin_array_from_map(
    MalVm *vm,
    MalValue map_fn,
    MalValue this_arg,
    u32 index,
    MalValue *element
) {
    if (mal_value_is_undefined(map_fn)) {
        return true;
    }

    MalValue mapped_args[] = {*element, mal_value_from_i32((i32) index)};
    MalCompletion completion = vm->exact_script_call != nullptr &&
        vm->exact_script_call->callee == map_fn
        ? mal_vm_call_builtin_callback(vm, map_fn, this_arg, mapped_args, 2)
        : mal_vm_call_cached(vm, map_fn, this_arg, mapped_args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *element = completion.value;
    return true;
}

/**
 * Set(A, "length", n, true). Propagates an abrupt setter; a refused ordinary
 * [[Set]] (no pending throw) becomes a TypeError, per the Throw=true argument.
 */
static bool mal_builtin_array_from_set_length(MalVm *vm, MalValue a, u32 length) {
    MalValue len_val = mal_value_from_u32(length);
    if (!mal_vm_set_property(vm, a, mal_intrinsic_string_key(vm, "length"), len_val, a)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set array length");
        }
        return false;
    }
    return true;
}

/**
 * Fill a fresh Array from `source` when `method` is the current realm's
 * Set.prototype.values over a Set and its iterator's next is still the builtin:
 * that iterator visits the live members in insertion order, and appending them
 * runs no code that could observe the skipped iterator.
 */
static bool mal_builtin_array_copy_set_members(
    MalVm *vm, MalValue method, MalValue source, MalArrayObject *fresh
) {
    if (method != vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES] ||
        !mal_value_is_set_object(source) || !mal_vm_primitive_methods_intact(vm)) {
        return false;
    }
    MalSetObject *set = mal_value_to_set_object(source);
    if (!mal_array_object_fresh_dense_reserve_exact(fresh, (u32) mal_set_object_size(set))) {
        return false;
    }
    MalSetIter members;
    mal_set_iter_init(&members, set->entries);
    MalValue member;
    while (mal_set_iter_next(&members, &member)) {
        if (!mal_array_object_fresh_dense_append(fresh, member)) abort();
    }
    return true;
}

static MalValue mal_builtin_array_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue map_fn = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue this_arg = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    if (!mal_value_is_undefined(map_fn) && !mal_value_is_callable(map_fn)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.from mapper is not a function");
        return mal_value_new_undefined();
    }

    // C is the receiver. When it is a constructor (other than %Array% itself),
    // the result A is built with Construct(C) and elements go through
    // CreateDataPropertyOrThrow + a final Set("length"). "plain_mode" is the
    // common case (this=undefined/null or exactly %Array%): A is a fresh plain
    // array, and Construct(%Array%) is observably identical to ArrayCreate.
    MalValue ctor = this_value;
    bool is_ctor = mal_vm_is_constructor(vm, ctor);
    bool plain_mode = !is_ctor || ctor == vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];

    // GetMethod(items, @@iterator) does GetV → ToObject(items); a null/undefined
    // source therefore throws a TypeError before anything else.
    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.from called on null or undefined");
        return mal_value_new_undefined();
    }

    // Always perform GetMethod(items, @@iterator): an own getter or non-callable
    // override is observable. The exact builtin Array iterator can then be elided
    // for a clean dense Array with no mapper/custom constructor; its allocation is
    // unobservable and no user-code seam remains while copying.
    MalValue method;
    if (!mal_vm_get_property(vm, source,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR),
            &method)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(method) && !mal_value_is_callable(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Array.from iterator is not callable");
        return mal_value_new_undefined();
    }
    bool direct_array_copy = plain_mode && mal_value_is_undefined(map_fn) &&
        mal_builtin_array_clean_dense(vm, source) != nullptr &&
        mal_value_is_native_function_object(method) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(method)) ==
            mal_array_values_callback &&
        mal_builtin_array_iterator_protocol_guard(vm);
#if MAL_REALMS
    direct_array_copy = direct_array_copy &&
        mal_value_to_native_function_object(method)->realm == vm->current_realm;
#endif
    MalExactScriptCall runtime_callback;
    bool nominated = false;

    if (mal_value_is_callable(method) && !direct_array_copy) {
        MalRootSpan method_span;
        mal_gc_root(&method_span, &method, 1);
        MalValue a;
        if (plain_mode) {
            a = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
        } else {
            MalCompletion c = mal_vm_construct_value(vm, ctor, nullptr, 0);
            if (c.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = c;
                mal_gc_unroot(&method_span);
                return mal_value_new_undefined();
            }
            a = c.value;
        }

        if (plain_mode && mal_value_is_undefined(map_fn) &&
            mal_builtin_array_copy_set_members(
                vm, method, source, mal_value_to_array_object(a))) {
            mal_gc_unroot(&method_span);
            return a;
        }
        MalIteratorRecord record;
        bool got_iterator = mal_vm_get_iterator_from_method(
            vm, source, method, &record);
        mal_gc_unroot(&method_span);
        if (!got_iterator) {
            return mal_value_new_undefined();
        }

        MalValue roots[2] = {a, mal_value_new_undefined()};
        MalRootSpan rec_span, span;
        mal_gc_root(&rec_span, &record.iterator, 2);
        mal_gc_root(&span, roots, 2);
        mal_gc_native_rooted_begin(vm);

        if (plain_mode && mal_value_is_undefined(map_fn) &&
            mal_vm_iterator_drain_set_values_to_fresh_dense_array(
                &record, mal_value_to_array_object(roots[0]))) {
            mal_gc_native_rooted_end(vm);
            mal_gc_unroot(&span);
            mal_gc_unroot(&rec_span);
            return roots[0];
        }
        if (plain_mode) {
            usize size_hint;
            if (mal_vm_builtin_iterator_size_hint(&record, &size_hint) &&
                size_hint <= UINT32_MAX) {
                (void) mal_array_object_fresh_dense_reserve_exact(
                    mal_value_to_array_object(a), (u32) size_hint);
            }
        }

        nominated = (vm->exact_script_call == nullptr ||
            vm->exact_script_call->callee != map_fn) &&
            mal_vm_prepare_builtin_callback(vm, map_fn, &runtime_callback);
        if (nominated) {
            vm->exact_script_call = &runtime_callback;
            MAL_PERF_COUNT(array_from_runtime_callback_nominations);
        }
        MalValue ret = mal_value_new_undefined();
        u32 index = 0;
        while (true) {
            MalValue element;
            bool done;
            if (!mal_vm_iterator_step_fast(vm, &record, &element, &done)) {
                goto iter_done;
            }

            if (done) {
                // Set(A, "length", index, true) — required for a constructed A
                // (a plain array already tracks length, so skip it there).
                if (!plain_mode && !mal_builtin_array_from_set_length(vm, roots[0], index)) {
                    goto iter_done;
                }
                ret = roots[0];
                goto iter_done;
            }

            roots[1] = element;
            if (!mal_builtin_array_from_map(
                    vm, map_fn, this_arg, index, &element)) {
                mal_vm_iterator_close(vm, &record);
                goto iter_done;
            }
            roots[1] = element;

            bool ok;
            if (plain_mode) {
                MalArrayObject *result_array =
                    mal_value_to_array_object(roots[0]);
                if (!mal_array_object_fresh_dense_append(
                        result_array, element)) {
                    mal_builtin_array_store_index(
                        result_array, index, element);
                }
                ok = true;
            } else {
                ok = mal_builtin_array_create_data_property(vm, roots[0], index, element);
            }
            if (!ok) {
                mal_vm_iterator_close(vm, &record);
                goto iter_done;
            }
            index++;
        }

    iter_done:
        if (nominated) vm->exact_script_call = runtime_callback.previous;
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&span);
        mal_gc_unroot(&rec_span);
        return ret;
    }

    f64 wide_length;
    if (!mal_builtin_array_length_of_array_like(vm, source, &wide_length)) {
        return mal_value_new_undefined();
    }
    u32 length = wide_length > (f64) UINT32_MAX
        ? UINT32_MAX : (u32) wide_length;

    MalValue a;
    if (plain_mode) {
        a = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, length));
    } else {
        MalValue len_arg = mal_value_from_u32(length);
        MalCompletion c = mal_vm_construct_value(vm, ctor, &len_arg, 1);
        if (c.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = c;
            return mal_value_new_undefined();
        }
        a = c.value;
    }

    // The exact Array values iterator materializes holes as undefined. Once its
    // identity and the source's index-clean state have been revalidated, copy
    // the private result in one native builder pass instead of performing a
    // Has/Get/CreateDataProperty round trip per element.
    if (direct_array_copy && plain_mode) {
        MalArrayObject *source_array = mal_builtin_array_clean_dense(vm, source);
        MalArrayObject *result_array = mal_value_to_array_object(a);
        if (source_array != nullptr &&
            source_array->length == length &&
            mal_array_object_dense_build_range(
                result_array, 0, source_array, 0, length, false, true)) {
            return a;
        }
    }

    // The array-like index Get may invoke a getter and the mapfn re-enters JS;
    // both can collect. Root A + the in-flight element and lift GC suppression.
    MalValue roots[2] = {a, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    nominated = (vm->exact_script_call == nullptr ||
        vm->exact_script_call->callee != map_fn) &&
        mal_vm_prepare_builtin_callback(vm, map_fn, &runtime_callback);
    if (nominated) {
        vm->exact_script_call = &runtime_callback;
        MAL_PERF_COUNT(array_from_runtime_callback_nominations);
    }
    MalValue ret = mal_value_new_undefined();
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, source, index);
        roots[1] = element;

        if (!mal_builtin_array_from_map(
                vm, map_fn, this_arg, index, &element)) {
            goto done;
        }
        roots[1] = element;

        bool ok;
        if (plain_mode) {
            mal_builtin_array_store_index(
                mal_value_to_array_object(roots[0]), index, element);
            ok = true;
        } else {
            ok = mal_builtin_array_create_data_property(vm, roots[0], index, element);
        }
        if (!ok) {
            goto done;
        }
    }
    // Set(A, "length", length, true) — see the iterator path.
    if (!plain_mode && !mal_builtin_array_from_set_length(vm, roots[0], length)) {
        goto done;
    }
    ret = roots[0];

done:
    if (nominated) vm->exact_script_call = runtime_callback.previous;
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return ret;
}

/**
 * CreateDataPropertyOrThrow(target, index, value). A fresh Array takes the
 * indexed-element fast path (keeping `length` in step); any other receiver (a
 * species-constructed object) goes through [[DefineOwnProperty]], throwing
 * (returns false with a pending TypeError) when it refuses the property.
 */
static bool mal_builtin_array_create_data_property_wide(MalVm *vm, MalValue target, f64 index, MalValue value) {
    if (mal_value_is_proxy_object(target)) {
        mal_vm_op_define_property(
            vm, target, mal_value_from_f64(index), value, true, true, true);
        return vm->completion.kind != MAL_COMPLETION_THROW;
    }
    if (mal_value_is_array_object(target) && index >= 0 &&
        index < (f64) UINT32_MAX) {
        u32 dense_index = (u32) index;
        MalArrayObject *array = mal_value_to_array_object(target);
        if ((f64) dense_index == index && !array->object.fast_elements_proto &&
            !array->object.is_prototype && !array->object.watched_method_proto &&
            mal_builtin_array_try_store_dense_index(
                array, dense_index, value)) {
            return true;
        }
    }
    // [[DefineOwnProperty]] (not [[Set]]): overwrites a configurable property and
    // ignores the prototype chain, but rejects an incompatible (e.g. non-writable
    // non-configurable) existing one.
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    MalKey key;
    if (!mal_builtin_array_numeric_key(vm, index, &key)) {
        return false;
    }
    if (mal_object_define_own(mal_value_to_object(target), key, &desc) != MAL_DEFINE_OWN_APPLIED) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot define array index property");
        return false;
    }
    // Array exotic [[DefineOwnProperty]]: an index at or past length grows length.
    if (mal_value_is_array_object(target) && index < (f64) UINT32_MAX) {
        MalArrayObject *array = mal_value_to_array_object(target);
        if (index >= (f64) mal_array_object_length(array)) {
            mal_array_object_set_length(array, (u32) index + 1);
        }
    }
    return true;
}

static bool mal_builtin_array_create_data_property(MalVm *vm, MalValue target, u32 index, MalValue value) {
    return mal_builtin_array_create_data_property_wide(vm, target, (f64) index, value);
}

MalValue mal_builtin_array_from_iterable(MalVm *vm, MalValue source) {
    MalValue roots[4] = {
        source,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, countof(roots));
    roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));

    if (!mal_vm_get_property(
            vm, roots[0],
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR),
            &roots[2])) {
        mal_gc_unroot(&roots_span);
        return mal_value_new_undefined();
    }

    MalArrayObject *source_array = mal_builtin_array_clean_dense(vm, roots[0]);
    bool direct_copy = source_array != nullptr &&
        mal_value_is_native_function_object(roots[2]) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(roots[2])) ==
            mal_array_values_callback &&
        mal_builtin_array_iterator_protocol_guard(vm);
#if MAL_REALMS
    direct_copy = direct_copy &&
        mal_value_to_native_function_object(roots[2])->realm == vm->current_realm;
#endif
    if (direct_copy && mal_array_object_dense_build_range(
            mal_value_to_array_object(roots[1]), 0, source_array, 0,
            source_array->length, false, true)) {
        MalValue result = roots[1];
        mal_gc_unroot(&roots_span);
        return result;
    }

    if (mal_builtin_array_copy_set_members(
            vm, roots[2], roots[0], mal_value_to_array_object(roots[1]))) {
        MalValue copied = roots[1];
        mal_gc_unroot(&roots_span);
        return copied;
    }

    MalIteratorRecord record;
    if (!mal_vm_get_iterator_from_method(vm, roots[0], roots[2], &record)) {
        mal_gc_unroot(&roots_span);
        return mal_value_new_undefined();
    }
    MalRootSpan record_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_native_rooted_begin(vm);

    f64 index = 0;
    while (true) {
        bool done;
        if (!mal_vm_iterator_step_fast(vm, &record, &roots[3], &done)) {
            break;
        }
        if (done) {
            MalValue result = roots[1];
            mal_gc_native_rooted_end(vm);
            mal_gc_unroot(&record_span);
            mal_gc_unroot(&roots_span);
            return result;
        }

        bool stored = false;
        if (index < (f64) UINT32_MAX) {
            stored = mal_array_object_fresh_dense_append(
                mal_value_to_array_object(roots[1]), roots[3]);
        }
        if (!stored && !mal_builtin_array_create_data_property_wide(
                vm, roots[1], index, roots[3])) {
            break;
        }
        index += 1;
    }

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&record_span);
    mal_gc_unroot(&roots_span);
    return mal_value_new_undefined();
}

/**
 * ArraySpeciesCreate(originalArray, length) (9.4.2.3): a non-Array original
 * returns a default array without reading `constructor`. Otherwise read
 * `constructor`, then its @@species; undefined/null species defaults to a plain
 * array (ArrayCreate, RangeError on length >= 2^32), a non-constructor species
 * throws TypeError, and any other species is Constructed with the length. The
 * result (a plain array or a species instance) is written into *out; returns
 * false with a pending throw on any abrupt step.
 */
static bool mal_builtin_array_species_create(MalVm *vm, MalValue original, f64 length, MalValue *out) {
    // For an exact current-realm Array whose constructor and @@species remain
    // structurally default, both Get operations and the builtin species getter
    // are effect-free and necessarily select ArrayCreate. Share that guard
    // across every species-producing Array method.
    if (mal_builtin_array_clean_dense(vm, original) != nullptr &&
        mal_array_default_species(vm, original)) {
        if (length > 4294967295.0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
            return false;
        }
        *out = mal_value_from_array_object(
            mal_intrinsic_new_array(vm, (u32) length));
        return true;
    }

    MalValue constructor = mal_value_new_undefined();
    bool is_array;
    if (!mal_vm_is_array(vm, original, &is_array)) {
        return false;
    }
    if (is_array) {
        if (!mal_vm_get_property(vm, original, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_CONSTRUCTOR), &constructor)) {
            return false;
        }
#if MAL_REALMS
        // A foreign realm's intrinsic %Array% defaults to the current realm's
        // ArrayCreate, without observing either realm's @@species property.
        if (constructor != vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR]
            && mal_vm_is_constructor(vm, constructor)) {
            MalRealm *constructor_realm;
            if (!mal_vm_get_function_realm(vm, constructor, &constructor_realm)) {
                return false;
            }
            if (constructor_realm != vm->current_realm
                && constructor == constructor_realm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR]) {
                constructor = mal_value_new_undefined();
            }
        }
#endif
        if (mal_value_is_object(constructor)) {
            if (!mal_vm_get_property(vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &constructor)) {
                return false;
            }
            // A null @@species defaults to ArrayCreate (a null `constructor`
            // itself is left to fail the IsConstructor check below).
            if (mal_value_is_null(constructor)) {
                constructor = mal_value_new_undefined();
            }
        }
    }

    if (mal_value_is_undefined(constructor)) {
        if (length > 4294967295.0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
            return false;
        }
        *out = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) length));
        return true;
    }

    if (!mal_vm_is_constructor(vm, constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array species is not a constructor");
        return false;
    }

    MalValue length_arg = mal_value_from_f64(length);
    MalCompletion constructed = mal_vm_construct_value(vm, constructor, &length_arg, 1);
    if (constructed.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }
    *out = constructed.value;
    return true;
}

static MalValue mal_builtin_array_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    bool dense_default = false;
    MalArrayObject *source_array = nullptr;
    MalArrayObject *result_array = nullptr;
    MalValue result = mal_value_new_undefined();
    if (length <= (f64) UINT32_MAX && mal_vm_array_elements_intact(vm) &&
        mal_value_is_array_object(this_value)) {
        source_array = mal_value_to_array_object(this_value);
        MalValue prototype = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
        dense_default = mal_array_object_is_dense(source_array) &&
            mal_value_is_object(prototype) &&
            mal_object_prototype(&source_array->object) == mal_value_to_object(prototype) &&
            mal_array_default_species(vm, this_value);
        if (dense_default) {
            result_array = mal_intrinsic_new_array(vm, 0);
            dense_default = mal_array_object_try_fresh_dense_reserve_exact(
                result_array, (u32) length);
            if (dense_default) {
                result = mal_value_from_array_object(result_array);
            }
        }
    }
    if (!dense_default &&
        !mal_builtin_array_species_create(vm, this_value, length, &result)) {
        return mal_value_new_undefined();
    }

    // The partial result and the in-flight mapped value live only in C locals
    // across the callback (which can collect); root them, plus a boxed primitive
    // receiver (fresh heap object the call seam does not track).
    MalValue roots[3] = {result, mal_value_new_undefined(), this_value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    if (dense_default) {
        bool dense_source = true;
        MalObject *array_prototype = mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]);
        for (u32 index = 0; index < (u32) length; index++) {
            MalValue element;
            if (dense_source &&
                (!mal_vm_array_elements_intact(vm) ||
                 !mal_array_object_is_dense(source_array) ||
                 mal_object_prototype(&source_array->object) != array_prototype)) {
                dense_source = false;
            }
            bool present = dense_source
                ? mal_array_object_dense_get(source_array, index, &element)
                : mal_builtin_array_try_get(vm, this_value, index, &element);
            if (!present && vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }

            MalValue mapped = mal_value_new_array_hole();
            if (present &&
                !mal_builtin_array_invoke(
                    vm, args[0], mal_builtin_array_this_arg(args, arg_count),
                    element, index, this_value, &mapped)) {
                goto done;
            }
            roots[1] = mapped;
            if (!mal_array_object_fresh_dense_append(result_array, mapped)) {
                abort();
            }
        }
        ret = result;
        goto done;
    }

    for (f64 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get_wide(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
            continue;
        }

        MalValue mapped;
        if (!mal_builtin_array_invoke_wide(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &mapped)) {
            goto done;
        }
        roots[1] = mapped;

        if (!mal_builtin_array_create_data_property_wide(vm, result, index, mapped)) {
            goto done;
        }
    }

    ret = result;

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return ret;
}

static MalValue mal_builtin_array_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    // No persistent scratch survives an iteration (the result is undefined and the
    // per-call element/this are rooted by the invoke helper), except a boxed
    // primitive receiver, which must survive a collection between iterations.
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    mal_gc_native_rooted_begin(vm);
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue ignored;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &ignored)) {
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&this_span);

    return mal_value_new_undefined();
}

/**
 * Structural check backing the compiler's guarded array-iteration inlining. True iff
 * `recv.<method>` is provably the original builtin (callback `expected`), so a
 * compiler-inlined loop is observably identical to calling it. Side-effect-free (no
 * getters run): (1) recv is an Array object, (2) its [[Prototype]] is the intrinsic
 * %Array.prototype%, (3) it has no own `<method>` shadowing it, and (4)
 * %Array.prototype%'s own `<method>` is a data property holding the native function
 * whose callback is `expected`. Any monkey-patch of the method/prototype/an own
 * override breaks one of these → false → slow path.
 */
static bool mal_array_method_is_default_builtin(
    MalVm *vm,
    MalValue recv,
    const byte *method,
    MalNativeFunctionCallback expected
) {
    if (!mal_value_is_array_object(recv)) {
        return false;
    }
    MalValue prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    if (!mal_value_is_object(prototype_value)) {
        return false;
    }
    MalObject *receiver = mal_value_to_object(recv);
    MalObject *array_prototype = mal_value_to_object(prototype_value);
    if (mal_object_prototype(receiver) != array_prototype) {
        return false;
    }
    MalKey key = mal_intrinsic_string_key(vm, method);
    if (mal_object_get_own(receiver, key).present) {
        return false; // own method shadows the builtin
    }
    MalPropertyLookup proto_lookup = mal_object_get_own(array_prototype, key);
    if (!proto_lookup.present || (proto_lookup.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        return false;
    }
    if (!mal_value_is_native_function_object(proto_lookup.desc.value)) {
        return false;
    }
    return mal_native_function_object_callback(mal_value_to_native_function_object(proto_lookup.desc.value)) == expected;
}

static MalValue mal_builtin_array_filter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalValue result;
    if (!mal_builtin_array_species_create(vm, this_value, 0, &result)) {
        return mal_value_new_undefined();
    }
    u32 result_length = 0;

    // roots[0] = result, roots[1] = the current element (held across the callback
    // and the subsequent CreateDataProperty store), roots[2] = a boxed primitive
    // receiver the call seam does not track.
    MalValue roots[3] = {result, mal_value_new_undefined(), this_value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
            continue;
        }
        roots[1] = element;

        MalValue selected;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &selected)) {
            goto done;
        }

        if (mal_value_is_truthy(selected)) {
            if (!mal_builtin_array_create_data_property(vm, result, result_length++, element)) {
                goto done;
            }
        }
    }

    ret = result;

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return ret;
}

static MalValue mal_builtin_array_reduce_impl(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool right
) {
    if (!mal_builtin_array_to_object(vm, &this_value)) return MAL_VALUE_UNDEFINED;
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length) ||
        !mal_builtin_array_callback_arg(vm, args, arg_count)) return MAL_VALUE_UNDEFINED;

    bool has_accumulator = arg_count >= 2;
    MalValue roots[] = {has_accumulator ? args[1] : MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, this_value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = MAL_VALUE_UNDEFINED;
    const MalExactScriptCall *exact = vm->exact_script_call;
    if (exact == nullptr || exact->callee != args[0] || exact->numeric_reduce_callback == nullptr)
        exact = nullptr;
    bool numeric = exact != nullptr && mal_ops_is_number(roots[0]);
    f64 accumulator = numeric ? mal_ops_number_as_f64(roots[0]) : 0;

    for (f64 cursor = 0; cursor < length; cursor++) {
        f64 index = right ? length - cursor - 1 : cursor;
        MalValue element;
        if (!mal_builtin_array_try_get_wide(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            continue;
        }
        roots[1] = element;
        if (!has_accumulator) {
            roots[0] = element;
            has_accumulator = true;
        } else if (numeric && mal_ops_is_number(element)) {
            if (!mal_vm_call_numeric_reduce_callback(
                    vm, exact, accumulator, mal_ops_number_as_f64(element), index,
                    this_value, &accumulator)) goto done;
            continue;
        } else {
            // Resume with the current accumulator and element; neither the getter nor callback is replayed.
            MalValue callback_args[] = {
                numeric ? mal_ops_number_value(accumulator) : roots[0],
                element, mal_ops_number_value(index), this_value,
            };
            MalCompletion completion = mal_vm_call_builtin_callback(
                vm, args[0], MAL_VALUE_UNDEFINED, callback_args, 4);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = completion;
                goto done;
            }
            roots[0] = completion.value;
        }
        numeric = exact != nullptr && mal_ops_is_number(roots[0]);
        if (numeric) {
            accumulator = mal_ops_number_as_f64(roots[0]);
            roots[0] = MAL_VALUE_UNDEFINED;
        }
    }
    if (!has_accumulator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty array with no initial value");
        goto done;
    }
    ret = numeric ? mal_ops_number_value(accumulator) : roots[0];

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return ret;
}

static MalValue mal_builtin_array_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_array_reduce_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_array_reduce_right(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_array_reduce_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_array_find(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    // No own scratch survives an iteration: the per-call element/receiver are
    // rooted by the invoke helper and the call seam, and a found element is
    // returned with no intervening allocation. Lifting GC suppression suffices,
    // plus rooting a boxed primitive receiver the call seam does not track.
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto done;
        }

        if (mal_value_is_truthy(matched)) {
            ret = element;
            goto done;
        }
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_find_index(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto done;
        }

        if (mal_value_is_truthy(matched)) {
            ret = mal_value_from_i32((i32) index);
            goto done;
        }
    }

    ret = mal_value_from_i32(-1);

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_some(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto done;
        }

        if (mal_value_is_truthy(matched)) {
            ret = mal_value_new_boolean(true);
            goto done;
        }
    }

    ret = mal_value_new_boolean(false);

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_every(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            continue;
        }

        MalValue matched;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto done;
        }

        if (!mal_value_is_truthy(matched)) {
            ret = mal_value_new_boolean(false);
            goto done;
        }
    }

    ret = mal_value_new_boolean(true);

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_ops_is_number(search)) {
        MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
        if (dense != nullptr) {
            u32 length = dense->length;
            if (length == 0) return mal_value_from_i32(-1);
            if (arg_count < 2 || mal_value_is_undefined(args[1]) ||
                mal_ops_is_number(args[1])) {
                u32 start = arg_count >= 2
                    ? mal_builtin_array_clamp_relative(vm, args[1], 0, length)
                    : 0;
                return mal_builtin_array_dense_numeric_index_of(
                    dense, search, start);
            }
        }
    }

    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    // Spec returns -1 for an empty array *before* ToIntegerOrInfinity(fromIndex),
    // so a side-effecting or throwing fromIndex is never coerced here.
    if (length == 0) {
        return mal_value_from_i32(-1);
    }
    f64 start = arg_count >= 2 ? mal_builtin_array_clamp_relative_wide(vm, args[1], 0, length) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && length == (f64) dense->length) {
        if (mal_ops_is_number(search)) {
            return mal_builtin_array_dense_numeric_index_of(
                dense, search, (u32) start);
        }
        for (u32 index = (u32) start; index < dense->length; index++) {
            MalValue element;
            if (mal_array_object_dense_get(dense, index, &element) &&
                mal_ops_strict_equal_bool(element, search)) {
                return mal_value_from_u32(index);
            }
        }
        return mal_value_from_i32(-1);
    }

    for (f64 index = start; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get_wide(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            continue;
        }

        if (mal_value_to_boolean(mal_ops_strict_equal(element, search))) {
            return mal_ops_number_value(index);
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_ops_is_number(search)) {
        MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
        if (dense != nullptr) {
            u32 length = dense->length;
            if (length == 0) return mal_value_from_i32(-1);
            if (arg_count < 2 || mal_value_is_undefined(args[1]) ||
                mal_ops_is_number(args[1])) {
                f64 relative = length - 1;
                if (arg_count >= 2) {
                    f64 number = mal_value_is_undefined(args[1])
                        ? NAN
                        : mal_ops_number_as_f64(args[1]);
                    relative = mal_ops_number_to_integer_or_infinity(number);
                    if (relative < 0) relative += (f64) length;
                    if (relative < 0) return mal_value_from_i32(-1);
                    if (relative >= (f64) length) relative = length - 1;
                }
                return mal_builtin_array_dense_numeric_last_index_of(
                    dense, search, (u32) relative);
            }
        }
    }

    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    if (length == 0) {
        return mal_value_from_i32(-1);
    }

    f64 start = length - 1;
    if (arg_count >= 2) {
        // fromIndex present (even as undefined) goes through ToIntegerOrInfinity;
        // ToNumber throws on a Symbol/BigInt. A present-but-undefined fromIndex
        // coerces to 0, not len-1 (that default only applies when it is absent).
        f64 number;
        if (!mal_vm_to_number(vm, args[1], &number)) {
            return mal_value_new_undefined();
        }
        f64 relative = mal_ops_number_to_integer_or_infinity(number);
        if (relative < 0) {
            relative += (f64) length;
        }
        if (relative < 0) {
            return mal_value_from_i32(-1);
        }

        start = relative >= length - 1 ? length - 1 : relative;
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && length == (f64) dense->length) {
        if (mal_ops_is_number(search)) {
            return mal_builtin_array_dense_numeric_last_index_of(
                dense, search, (u32) start);
        }
        for (u32 index = (u32) start;; index--) {
            MalValue element;
            if (mal_array_object_dense_get(dense, index, &element) &&
                mal_ops_strict_equal_bool(element, search)) {
                return mal_value_from_u32(index);
            }
            if (index == 0) break;
        }
        return mal_value_from_i32(-1);
    }

    for (f64 index = start;; index--) {
        MalValue element;
        if (mal_builtin_array_try_get_wide(vm, this_value, index, &element) &&
            mal_value_to_boolean(mal_ops_strict_equal(element, search))) {
            return mal_ops_number_value(index);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        if (index == 0) {
            break;
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_array_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_ops_is_number(search)) {
        MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
        if (dense != nullptr) {
            u32 length = dense->length;
            if (length == 0) return mal_value_new_boolean(false);
            if (arg_count < 2 || mal_value_is_undefined(args[1]) ||
                mal_ops_is_number(args[1])) {
                u32 start = arg_count >= 2
                    ? mal_builtin_array_clamp_relative(vm, args[1], 0, length)
                    : 0;
                return mal_value_new_boolean(
                    mal_builtin_array_dense_numeric_includes(
                        dense, search, start));
            }
        }
    }

    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    // Spec returns false for an empty array *before* ToIntegerOrInfinity(fromIndex),
    // so a side-effecting or throwing fromIndex is never coerced here.
    if (length == 0) {
        return mal_value_new_boolean(false);
    }
    f64 start = arg_count >= 2 ? mal_builtin_array_clamp_relative_wide(vm, args[1], 0, length) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && (f64) dense->length == length) {
        if (mal_ops_is_number(search)) {
            return mal_value_new_boolean(
                mal_builtin_array_dense_numeric_includes(
                    dense, search, (u32) start));
        }
        for (u32 index = (u32) start; index < dense->length; index++) {
            MalValue element;
            if (!mal_array_object_dense_get(dense, index, &element)) {
                element = mal_value_new_undefined();
            }
            if (mal_builtin_array_same_value_zero(element, search)) {
                return mal_value_new_boolean(true);
            }
        }
        return mal_value_new_boolean(false);
    }

    // An array-like's length can exceed 2^32, up to 2^53-1.
    for (f64 index = start; index < length; index++) {
        // Holes compare as undefined for includes.
        MalValue element = mal_builtin_array_get_wide(vm, this_value, index);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        if (mal_builtin_array_same_value_zero(element, search)) {
            return mal_value_new_boolean(true);
        }
    }

    return mal_value_new_boolean(false);
}

static MalValue mal_builtin_array_push(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // Intentionally generic: Set each new index then Set("length", new length) —
    // a non-writable length (e.g. on a TypedArray) makes the final Set throw.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }
    f64 new_length = length + (f64) arg_count;
    if (new_length > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }
    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && new_length <= (f64) UINT32_MAX &&
        mal_array_object_dense_append_many(dense, args, (u32) arg_count)) {
        ret = mal_ops_number_value(new_length);
        goto done;
    }
    for (i32 i = 0; i < arg_count; i++) {
        if (!mal_builtin_array_set_index_or_throw(vm, this_value, length + (f64) i, args[i])) {
            goto done;
        }
    }
    // ArraySetLength rejects values outside the uint32 Array-length domain. Keep
    // this after the indexed writes: push can have observable partial effects before
    // the final length Set throws (for example at length 2^32 - 1).
    if (mal_value_is_array_object(this_value) && new_length > (f64) UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }
    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(new_length))) {
        goto done;
    }
    ret = mal_ops_number_value(new_length);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

MalValue mal_builtin_array_push_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
) {
    if (arg_count >= 0 && mal_value_is_array_object(this_value) &&
        mal_vm_array_elements_intact(vm)) {
        MalValue prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
        MalArrayObject *array = mal_value_to_array_object(this_value);
        if (mal_value_is_array_object(prototype_value) &&
            mal_object_prototype(&array->object) == mal_value_to_object(prototype_value) &&
            mal_array_object_dense_append_many(array, args, (u32) arg_count)) {
            MAL_PERF_COUNT(array_push_direct_hits);
            return mal_ops_number_value((f64) array->length);
        }
    }
    MAL_PERF_COUNT(array_push_direct_fallbacks);
    return mal_builtin_array_push(
        vm, this_value, args, arg_count, MAL_VALUE_UNDEFINED,
        vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH]);
}

MalValue mal_builtin_array_push_contained(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
) {
    assert(arg_count >= 0);
    MalArrayObject *array = mal_value_to_array_object(this_value);
    if (mal_array_object_contained_dense_push(array, args, (u32) arg_count)) {
        MAL_PERF_COUNT(array_contained_pushes);
        return mal_ops_number_value((f64) array->length);
    }

    // The only rejected exact state is the uint32 Array-length boundary. Run the
    // intrinsic algorithm directly to preserve its partial writes and RangeError;
    // property resolution and dynamic call dispatch remain statically erased.
    MAL_PERF_COUNT(array_contained_push_overflows);
    return mal_builtin_array_push(
        vm, this_value, args, arg_count, MAL_VALUE_UNDEFINED,
        vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH]);
}

bool mal_builtin_array_push_virtual_guard(MalVm *vm) {
    MalValue callee = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH];
    MalValue prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    if (!mal_value_is_native_function_object(callee) ||
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) !=
            mal_builtin_array_push ||
        !mal_value_is_array_object(prototype_value) ||
        !mal_vm_array_elements_intact(vm)) {
        return false;
    }
#if MAL_PRIMORDIALS_LOCKED
    // The locked primordial graph cannot replace Array.prototype.push.
    return true;
#else
    // Array.prototype is watched: any redefinition of its push clears the protector.
    if (mal_vm_primitive_methods_intact(vm)) return true;
    MalPropertyLookup live = mal_object_get_own(
        mal_value_to_object(prototype_value), mal_intrinsic_string_key(vm, "push"));
    return live.present && !(live.desc.flags & MAL_PROPERTY_ACCESSOR) &&
        live.desc.value == callee;
#endif
}

bool mal_builtin_array_push_try_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
) {
    if (arg_count < 0 || !mal_value_is_array_object(this_value) ||
        callee != vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH] ||
        !mal_builtin_array_push_virtual_guard(vm)) {
        return false;
    }
    MalValue prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalArrayObject *array = mal_value_to_array_object(this_value);
    // An empty own-property layout cannot shadow the inherited method.
    bool may_shadow =
        (array->object.shape != nullptr && array->object.shape->inline_count != 0) ||
        mal_object_has_public_overflow(&array->object);
    if (!mal_value_is_array_object(prototype_value) ||
        mal_object_prototype(&array->object) != mal_value_to_object(prototype_value) ||
        (may_shadow && mal_object_get_own(
            &array->object, mal_intrinsic_string_key(vm, "push")).present) ||
        !mal_array_object_dense_append_many(array, args, (u32) arg_count)) {
        return false;
    }
    *result_out = mal_ops_number_value((f64) array->length);
    return true;
}

bool mal_builtin_array_iterator_protocol_guard(MalVm *vm) {
#if MAL_PRIMORDIALS_LOCKED
    (void) vm;
    return true;
#else
    MalValue array_prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue iterator_prototype_value =
        vm->intrinsics[MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE];
    if (!mal_value_is_array_object(array_prototype_value) ||
        !mal_value_is_object(iterator_prototype_value)) {
        return false;
    }
    MalPropertyLookup values = mal_object_get_own(
        mal_value_to_object(array_prototype_value),
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR));
    if (!values.present || (values.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        !mal_value_is_native_function_object(values.desc.value) ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(values.desc.value)) !=
            mal_array_values_callback) {
        return false;
    }
#if MAL_REALMS
    if (mal_value_to_native_function_object(values.desc.value)->realm != vm->current_realm) return false;
#endif
    MalPropertyLookup next = mal_object_get_own(
        mal_value_to_object(iterator_prototype_value),
        mal_intrinsic_string_key(vm, "next"));
    return next.present && !(next.desc.flags & MAL_PROPERTY_ACCESSOR) &&
        mal_value_is_native_function_object(next.desc.value) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(next.desc.value)) ==
            mal_array_iterator_next_callback;
#endif
}

bool mal_builtin_array_pair_destructure_try(
    MalVm *vm, MalValue source,
    MalValue *first_out, bool *first_done_out,
    MalValue *second_out, bool *second_done_out
) {
    // The protector covers Array.prototype @@iterator and ArrayIterator next/return.
    if (!mal_vm_primitive_methods_intact(vm) || !mal_value_is_array_object(source)) {
        return false;
    }
    MalArrayObject *array = mal_value_to_array_object(source);
    MalObject *object = &array->object;
    // An empty own-property layout cannot hold an @@iterator override.
    if (mal_object_prototype(object) !=
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]) ||
        ((object->shape->inline_count != 0 || mal_object_overflow(object) != nullptr) &&
         mal_object_get_own(
             object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR)).present)) {
        return false;
    }

    *first_out = MAL_VALUE_UNDEFINED;
    *second_out = MAL_VALUE_UNDEFINED;
    *first_done_out = array->length == 0;
    *second_done_out = array->length <= 1;
    if (array->length > 0 && !mal_array_object_dense_get(array, 0, first_out)) {
        return false;
    }
    if (array->length > 1 && !mal_array_object_dense_get(array, 1, second_out)) {
        return false;
    }
    return true;
}

MalCompletion mal_builtin_array_push_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool *exact_hit_out
) {
    if (exact_hit_out != nullptr) *exact_hit_out = false;
    MalValue result;
    if (mal_builtin_array_push_try_direct(
            vm, callee, this_value, args, arg_count, &result)) {
        if (exact_hit_out != nullptr) *exact_hit_out = true;
        MAL_PERF_COUNT(array_push_direct_hits);
        return (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = result,
        };
    }

    MAL_PERF_COUNT(array_push_direct_fallbacks);
    return mal_vm_call_cached(
        vm, callee, this_value, args, arg_count);
}

static MalValue mal_builtin_array_pop(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    // Intentionally generic: read the last element, delete it, shrink length.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }
    if (length == 0) {
        if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_value_from_i32(0))) {
            goto done;
        }
        goto done;
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->length_writable &&
        dense->dense_elements_configurable &&
        length == (f64) dense->length) {
        MalValue element = mal_value_new_undefined();
        mal_array_object_dense_get(dense, dense->length - 1, &element);
        mal_array_object_set_length(dense, dense->length - 1);
        ret = element;
        goto done;
    }

    MalValue element = mal_builtin_array_get_wide(vm, this_value, length - 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    if (!mal_builtin_array_delete_index_or_throw(vm, this_value, length - 1)) {
        goto done;
    }
    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(length - 1))) {
        goto done;
    }
    ret = element;
done:
    mal_gc_unroot(&this_span);
    return ret;
}

MalValue mal_builtin_array_pop_contained(MalVm *vm, MalValue this_value) {
    (void) vm;
    MalArrayObject *array = mal_value_to_array_object(this_value);
    MalValue result = MAL_VALUE_UNDEFINED;
    if (mal_array_object_contained_dense_pop(array, &result)) {
        MAL_PERF_COUNT(array_contained_pops);
    } else {
        MAL_PERF_COUNT(array_contained_empty_pops);
    }
    return result;
}

static MalValue mal_builtin_array_shift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    // Intentionally generic (ArrayShift): O = ToObject(this), len =
    // LengthOfArrayLike(O), shift elements down by one via Has/Get/Set/Delete.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        goto done;
    }
    if (length == 0) {
        if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_value_from_i32(0))) {
            goto done;
        }
        goto done;
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->length_writable &&
        dense->dense_elements_writable &&
        dense->dense_elements_configurable &&
        length == dense->length &&
        mal_builtin_array_dense_shift_compatible(dense)) {
        MalValue first = mal_value_new_undefined();
        mal_array_object_dense_get(dense, 0, &first);
        mal_array_object_dense_shift(dense);
        ret = first;
        goto done;
    }

    MalValue first = mal_builtin_array_get(vm, this_value, 0);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    for (u32 index = 1; index < length; index++) {
        MalValue element;
        bool present = mal_builtin_array_try_get(vm, this_value, index, &element);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto done;
        }
        if (present) {
            if (!mal_builtin_array_set_or_throw(vm, this_value, mal_key_index(index - 1), element)) {
                goto done;
            }
        } else {
            if (!mal_builtin_array_delete_or_throw(vm, this_value, mal_key_index(index - 1))) {
                goto done;
            }
        }
    }

    if (!mal_builtin_array_delete_or_throw(vm, this_value, mal_key_index(length - 1))) {
        goto done;
    }
    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_value_from_i32((i32) (length - 1)))) {
        goto done;
    }
    ret = first;
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_unshift(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    // Intentionally generic (ArrayUnshift): O = ToObject(this), len =
    // LengthOfArrayLike(O), shift elements up by argCount then prepend the args.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }
    f64 new_length = length + (f64) arg_count;
    if (new_length > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->length_writable &&
        new_length <= (f64) UINT32_MAX &&
        (arg_count == 0 || dense->object.extensible) &&
        mal_array_object_dense_unshift_many(dense, args, (u32) arg_count)) {
        ret = mal_ops_number_value(new_length);
        goto done;
    }

    if (arg_count > 0) {
        for (f64 moved = length; moved > 0; moved--) {
            f64 from = moved - 1;
            f64 to = from + (f64) arg_count;

            MalValue element;
            bool present = mal_builtin_array_try_get_wide(vm, this_value, from, &element);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
            if (present) {
                if (!mal_builtin_array_set_index_or_throw(vm, this_value, to, element)) {
                    goto done;
                }
            } else {
                if (!mal_builtin_array_delete_index_or_throw(vm, this_value, to)) {
                    goto done;
                }
            }
        }

        for (i32 i = 0; i < arg_count; i++) {
            if (!mal_builtin_array_set_index_or_throw(vm, this_value, (f64) i, args[i])) {
                goto done;
            }
        }
    }

    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(new_length))) {
        goto done;
    }
    ret = mal_ops_number_value(new_length);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static bool mal_builtin_array_is_method(MalValue callee, MalNativeFunctionCallback method) {
    return mal_value_is_native_function_object(callee) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) == method;
}

// Each arm repeats its builtin's dense fast path; an empty Array with a writable length is unchanged.
bool mal_builtin_array_deque_try_direct(
    MalVm *vm,
    MalGuardedBuiltinCallOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
) {
    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense == nullptr || !dense->length_writable) return false;
    switch (operation) {
        case MAL_GUARDED_BUILTIN_ARRAY_POP: {
            if (!mal_builtin_array_is_method(callee, mal_builtin_array_pop) ||
                !dense->dense_elements_configurable) {
                return false;
            }
            MalValue element = mal_value_new_undefined();
            if (dense->length != 0) {
                mal_array_object_dense_get(dense, dense->length - 1, &element);
                mal_array_object_set_length(dense, dense->length - 1);
            }
            *result_out = element;
            return true;
        }
        case MAL_GUARDED_BUILTIN_ARRAY_SHIFT: {
            if (!mal_builtin_array_is_method(callee, mal_builtin_array_shift) ||
                !dense->dense_elements_writable || !dense->dense_elements_configurable) {
                return false;
            }
            MalValue first = mal_value_new_undefined();
            if (dense->length != 0) {
                if (!mal_builtin_array_dense_shift_compatible(dense)) return false;
                mal_array_object_dense_get(dense, 0, &first);
                mal_array_object_dense_shift(dense);
            }
            *result_out = first;
            return true;
        }
        case MAL_GUARDED_BUILTIN_ARRAY_UNSHIFT: {
            u64 new_length = (u64) dense->length + (u64) arg_count;
            if (arg_count < 0 || !mal_builtin_array_is_method(callee, mal_builtin_array_unshift) ||
                new_length > UINT32_MAX || (arg_count != 0 && !dense->object.extensible) ||
                !mal_array_object_dense_unshift_many(dense, args, (u32) arg_count)) {
                return false;
            }
            *result_out = mal_ops_number_value((f64) new_length);
            return true;
        }
        default:
            return false;
    }
}

MalCompletion mal_builtin_array_deque_direct(
    MalVm *vm,
    MalGuardedBuiltinCallOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalValue result;
    if (mal_builtin_array_deque_try_direct(
            vm, operation, callee, this_value, args, arg_count, &result)) {
        MAL_PERF_COUNT(array_deque_direct_hits);
        return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = result};
    }
    MAL_PERF_COUNT(array_deque_direct_fallbacks);
    return mal_vm_call_cached(vm, callee, this_value, args, arg_count);
}

static MalValue mal_builtin_array_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // Intentionally generic: O = ToObject(this), len = LengthOfArrayLike(O).
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    f64 start = arg_count >= 1 ? mal_builtin_array_clamp_relative_wide(vm, args[0], 0, length) : 0;
    f64 end = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_array_clamp_relative_wide(vm, args[1], length, length)
        : length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    f64 result_length = end > start ? end - start : 0;
    MalValue result;
    if (!mal_builtin_array_species_create(vm, this_value, result_length, &result)) {
        return mal_value_new_undefined();
    }

    if (result_length <= (f64) UINT32_MAX && start <= (f64) UINT32_MAX) {
        MalArrayObject *source_array =
            mal_builtin_array_clean_dense(vm, this_value);
        u32 source_start = (u32) start;
        u32 copy_count = (u32) result_length;
        MalArrayObject *result_array =
            mal_builtin_array_presized_dense_builder(result, copy_count);
        if (source_array != nullptr && result_array != nullptr &&
            (f64) source_start == start &&
            (f64) copy_count == result_length &&
            mal_array_object_dense_build_range(
                result_array, 0, source_array, source_start, copy_count,
                false, false)) {
            return result;
        }
    }

    for (f64 index = 0; index < result_length; index++) {
        MalValue element;
        if (mal_builtin_array_try_get_wide(vm, this_value, start + index, &element)) {
            if (!mal_builtin_array_create_data_property_wide(vm, result, index, element)) {
                return mal_value_new_undefined();
            }
        } else if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    if (!mal_builtin_array_set_or_throw(
            vm, result, mal_intrinsic_string_key(vm, "length"),
            mal_ops_number_value(result_length))) {
        return mal_value_new_undefined();
    }

    return result;
}

static MalValue mal_builtin_array_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // Intentionally generic: O = ToObject(this), which is just the first concat
    // source (i == -1); a primitive receiver becomes a non-spreadable wrapper.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalValue result;
    if (!mal_builtin_array_species_create(vm, this_value, 0, &result)) {
        return mal_value_new_undefined();
    }
    f64 result_length = 0;

    for (i32 i = -1; i < arg_count; i++) {
        MalValue source = i < 0 ? this_value : args[i];

        // A defined @@isConcatSpreadable overrides the IsArray fallback.
        bool spreadable = false;
        if (mal_value_is_object(source)) {
            MalKey spreadable_key = mal_intrinsic_symbol_key(
                vm, MAL_INTRINSIC_SYMBOL_IS_CONCAT_SPREADABLE);
            bool default_array_spread = mal_vm_primitive_methods_intact(vm) &&
                mal_builtin_array_clean_dense(vm, source) != nullptr &&
                !mal_object_get_own(
                    mal_value_to_object(source), spreadable_key).present;
            if (default_array_spread) {
                // The watched intrinsic prototype chain contains no
                // @@isConcatSpreadable property, so this exact Array follows
                // the IsArray fallback without a generic property lookup.
                spreadable = true;
            } else {
                MalValue spreadable_value;
                if (!mal_vm_get_property(
                        vm, source, spreadable_key, &spreadable_value)) {
                    return mal_value_new_undefined();
                }
                if (!mal_value_is_undefined(spreadable_value)) {
                    spreadable = mal_value_is_truthy(spreadable_value);
                } else if (!mal_vm_is_array(vm, source, &spreadable)) {
                    return mal_value_new_undefined();
                }
            }
        }

        if (spreadable) {
            // Spreading non-arrays approximates with the generic array-like
            // length read.
            f64 source_length = 0;
            if (mal_value_is_array_object(source)) {
                source_length = (f64) mal_array_object_length(mal_value_to_array_object(source));
            } else if (!mal_builtin_array_length_of_array_like(vm, source, &source_length)) {
                return mal_value_new_undefined();
            }
            if (result_length + source_length > MAL_NUMBER_MAX_SAFE_INTEGER) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
                return mal_value_new_undefined();
            }

            if (result_length <= (f64) UINT32_MAX &&
                source_length <= (f64) UINT32_MAX &&
                result_length + source_length <= (f64) UINT32_MAX) {
                MalArrayObject *source_array =
                    mal_builtin_array_clean_dense(vm, source);
                MalArrayObject *result_array = mal_builtin_array_dense_builder(
                    result, (u32) result_length);
                if (source_array != nullptr && result_array != nullptr &&
                    source_array->length == (u32) source_length &&
                    mal_array_object_dense_build_range(
                        result_array, (u32) result_length,
                        source_array, 0, (u32) source_length,
                        false, false)) {
                    result_length += source_length;
                    continue;
                }
            }
            for (f64 index = 0; index < source_length; index++) {
                MalValue element;
                if (mal_builtin_array_try_get_wide(vm, source, index, &element)) {
                    if (!mal_builtin_array_create_data_property_wide(vm, result, result_length + index, element)) {
                        return mal_value_new_undefined();
                    }
                } else if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    return mal_value_new_undefined();
                }
            }

            result_length += source_length;
        } else {
            if (result_length >= MAL_NUMBER_MAX_SAFE_INTEGER) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
                return mal_value_new_undefined();
            }
            if (!mal_builtin_array_create_data_property_wide(vm, result, result_length, source)) {
                return mal_value_new_undefined();
            }
            result_length++;
        }
    }

    if (!mal_builtin_array_set_or_throw(vm, result, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(result_length))) {
        return mal_value_new_undefined();
    }
    return result;
}

static bool mal_builtin_array_join_remaining_primitives(
    MalArrayObject *array, u32 start, bool strings
) {
    for (u32 index = start; index < array->length; index++) {
        MalValue value;
        bool present = mal_array_object_dense_get(array, index, &value);
        if (strings && (!present || mal_value_is_nil(value))) continue;
        if (!present || !(strings ? mal_value_is_string(value) : mal_value_is_int32(value))) return false;
    }
    return true;
}

static usize mal_builtin_array_join_i32_digits(i32 value, u8 digits[11], usize *start) {
    usize cursor = 11;
    bool negative = value < 0;
    u32 magnitude = negative ? (u32) -(i64) value : (u32) value;
    do {
        digits[--cursor] = (u8) ('0' + magnitude % 10);
        magnitude /= 10;
    } while (magnitude != 0);
    if (negative) digits[--cursor] = '-';
    *start = cursor;
    return 11 - cursor;
}

/** Write a validated dense join into one exact allocation. Strings, int32s and
 * holes or nullish elements (empty) were sized by the caller; `latin1` holds
 * when the separator and every string part have compact content. Returns null
 * with a pending allocation error. Writing allocates nothing until the result
 * string itself, so element storage stays stable throughout. */
static MalString *mal_builtin_array_join_write(
    MalVm *vm, MalArrayObject *array, MalString *separator, usize result_length, bool latin1
) {
    usize separator_length = mal_string_length(separator);
    void *units = mal_heap_try_alloc_raw_profiled(
        &vm->heap, result_length * (latin1 ? sizeof(u8) : sizeof(c16)),
        MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (units == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    u8 *bytes = units;
    c16 *wide = units;
    u8 separator_unit = separator_length == 1 && latin1
        ? (u8) mal_string_code_unit_at(separator, 0) : 0;
    usize position = 0;
    for (u32 index = 0; index < array->length; index++) {
        if (index != 0 && separator_length != 0) {
            if (separator_length == 1 && latin1) bytes[position] = separator_unit;
            else if (latin1) mal_string_copy_latin1_to(separator, bytes + position);
            else mal_string_copy_range_to(separator, 0, separator_length, wide + position);
            position += separator_length;
        }
        MalValue element;
        if (!mal_array_object_dense_get(array, index, &element) || mal_value_is_nil(element)) continue;
        if (mal_value_is_string(element)) {
            MalString *part = mal_value_to_string(element);
            if (latin1) mal_string_copy_latin1_to(part, bytes + position);
            else mal_string_copy_range_to(part, 0, mal_string_length(part), wide + position);
            position += mal_string_length(part);
        } else {
            u8 digits[11];
            usize start;
            usize count = mal_builtin_array_join_i32_digits(mal_value_to_i32(element), digits, &start);
            for (usize i = 0; i < count; i++) {
                if (latin1) bytes[position + i] = digits[start + i];
                else wide[position + i] = digits[start + i];
            }
            position += count;
        }
    }
    if (position != result_length) abort();
    return latin1
        ? mal_string_new_latin1_owned(&vm->heap, bytes, result_length)
        : mal_string_new_owned(&vm->heap, wide, result_length);
}

/** Join an exact clean dense Array when every present non-nullish element is
 * already a string primitive. Returns 1 with *out set, 0 for the observable
 * generic fallback, and -1 with a pending length/allocation throw. */
static i32 mal_builtin_array_join_dense_strings(
    MalVm *vm,
    MalArrayObject *array,
    MalString *separator,
    MalValue *out
) {
    usize length = array->length;
    usize separator_length = mal_string_length(separator);
    usize result_length;
    if (!mal_checked_size_multiply(
            separator_length, length == 0 ? 0 : length - 1,
            MAL_STRING_MAX_CODE_UNITS, &result_length)) {
        if (!mal_builtin_array_join_remaining_primitives(array, 0, true)) return 0;
        mal_builtin_array_throw_string_length(vm);
        return -1;
    }
    MalString *sole_part = nullptr;
    usize nonempty_parts = 0;
    bool latin1 = separator->latin1;
    for (u32 index = 0; index < array->length; index++) {
        MalValue element;
        if (!mal_array_object_dense_get(array, index, &element) ||
            mal_value_is_nil(element)) {
            continue;
        }
        if (!mal_value_is_string(element)) return 0;
        MalString *part = mal_value_to_string(element);
        usize part_length = mal_string_length(part);
        latin1 &= part->latin1;
        if (!mal_checked_size_add(
                result_length, part_length, MAL_STRING_MAX_CODE_UNITS,
                &result_length)) {
            if (!mal_builtin_array_join_remaining_primitives(array, index + 1, true)) return 0;
            mal_builtin_array_throw_string_length(vm);
            return -1;
        }
        if (part_length != 0) {
            sole_part = part;
            nonempty_parts++;
        }
    }
    if (result_length == 0) {
        *out = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        return 1;
    }
    if (separator_length == 0 && nonempty_parts == 1 &&
        mal_string_length(sole_part) == result_length) {
        *out = mal_value_from_string(sole_part);
        return 1;
    }

    MalValue roots[] = {mal_value_from_array_object(array), mal_value_from_string(separator)};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    MalString *result = mal_builtin_array_join_write(vm, array, separator, result_length, latin1);
    if (result != nullptr) *out = mal_value_from_string(result);
    mal_gc_unroot(&span);
    return result != nullptr ? 1 : -1;
}

static usize mal_builtin_array_i32_decimal_length(i32 value) {
    usize length = value < 0 ? 1 : 0;
    u32 magnitude = value < 0 ? (u32) -(i64) value : (u32) value;
    do {
        length++;
        magnitude /= 10;
    } while (magnitude != 0);
    return length;
}

static i32 mal_builtin_array_join_dense_int32s(
    MalVm *vm,
    MalArrayObject *array,
    MalString *separator,
    MalValue *out
) {
    u32 length = array->length;
    usize separator_length = mal_string_length(separator);
    usize result_length;
    if (!mal_checked_size_multiply(
            separator_length, length - 1,
            MAL_STRING_MAX_CODE_UNITS, &result_length)) {
        if (!mal_builtin_array_join_remaining_primitives(array, 0, false)) return 0;
        mal_builtin_array_throw_string_length(vm);
        return -1;
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_array_object_dense_get(array, index, &element) ||
            !mal_value_is_int32(element)) {
            return 0;
        }
        if (!mal_checked_size_add(
                result_length,
                mal_builtin_array_i32_decimal_length(mal_value_to_i32(element)),
                MAL_STRING_MAX_CODE_UNITS, &result_length)) {
            if (!mal_builtin_array_join_remaining_primitives(array, index + 1, false)) return 0;
            mal_builtin_array_throw_string_length(vm);
            return -1;
        }
    }

    MalValue roots[2] = {
        mal_value_from_array_object(array),
        mal_value_from_string(separator),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalString *result = mal_builtin_array_join_write(
        vm, array, separator, result_length, separator->latin1);
    if (result != nullptr) *out = mal_value_from_string(result);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
    return result != nullptr ? 1 : -1;
}

static i32 mal_builtin_array_join_dense_primitives(
    MalVm *vm,
    MalArrayObject *array,
    MalString *separator,
    MalValue *out
) {
    usize length = array->length;
    usize separator_length = mal_string_length(separator);
    usize result_length;
    bool overflow = !mal_checked_size_multiply(
        separator_length, length == 0 ? 0 : length - 1,
        MAL_STRING_MAX_CODE_UNITS, &result_length);
    MalString *sole_part = nullptr;
    usize nonempty_parts = 0;
    bool latin1 = separator->latin1;
    for (u32 index = 0; index < array->length; index++) {
        MalValue element;
        if (!mal_array_object_dense_get(array, index, &element) ||
            mal_value_is_nil(element)) {
            continue;
        }
        MalString *part = nullptr;
        usize part_length;
        if (mal_value_is_string(element)) {
            part = mal_value_to_string(element);
            part_length = mal_string_length(part);
            latin1 &= part->latin1;
        } else if (mal_value_is_int32(element)) {
            part_length = mal_builtin_array_i32_decimal_length(mal_value_to_i32(element));
        } else return 0;
        if (!overflow) overflow = !mal_checked_size_add(
            result_length, part_length, MAL_STRING_MAX_CODE_UNITS, &result_length);
        if (part_length != 0) {
            sole_part = part;
            nonempty_parts++;
        }
    }
    // A later object conversion must remain observable even if earlier lengths overflow.
    if (overflow) {
        mal_builtin_array_throw_string_length(vm);
        return -1;
    }
    if (result_length == 0) {
        *out = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        return 1;
    }
    if (separator_length == 0 && nonempty_parts == 1 && sole_part != nullptr &&
        mal_string_length(sole_part) == result_length) {
        *out = mal_value_from_string(sole_part);
        return 1;
    }

    MalValue roots[] = {mal_value_from_array_object(array), mal_value_from_string(separator)};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalString *result = mal_builtin_array_join_write(vm, array, separator, result_length, latin1);
    if (result != nullptr) *out = mal_value_from_string(result);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    return result != nullptr ? 1 : -1;
}

static MalValue mal_builtin_array_join_active(
    MalVm *vm, MalValue this_value, u32 length, MalString *separator) {
    if (length == 0) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->length == length) {
        MalValue dense_result;
        i32 dense_status = mal_builtin_array_join_dense_strings(
            vm, dense, separator, &dense_result);
        if (dense_status != 0) {
            return dense_status > 0
                ? dense_result
                : mal_value_new_undefined();
        }
        dense_status = mal_builtin_array_join_dense_int32s(
            vm, dense, separator, &dense_result);
        if (dense_status != 0) {
            return dense_status > 0
                ? dense_result
                : mal_value_new_undefined();
        }
        dense_status = mal_builtin_array_join_dense_primitives(vm, dense, separator, &dense_result);
        if (dense_status != 0) return dense_status > 0 ? dense_result : mal_value_new_undefined();
    }

    MalRootedStringParts parts;
    if (!mal_rooted_string_parts_init(&parts, separator, length)) {
        mal_builtin_array_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    MalValue this_root = this_value;
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, &this_root, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    for (u32 index = 0; index < length; index++) {
        // Holes, undefined and null join as empty strings; other elements go
        // through ToString, whose user code may throw.
        MalValue element = mal_builtin_array_get(vm, this_value, index);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto done;
        }
        if (mal_value_is_nil(element)) {
            if (!mal_rooted_string_parts_append(&parts, nullptr)) {
                mal_builtin_array_throw_string_length(vm);
                goto done;
            }
            continue;
        }
        MalString *part;
        if (!mal_vm_to_string(vm, element, &part)) {
            goto done;
        }
        if (!mal_rooted_string_parts_append(&parts, part)) {
            mal_builtin_array_throw_string_length(vm);
            goto done;
        }
    }

    MalString *result;
    if (!mal_rooted_string_parts_flatten(vm, &parts, &result)) {
        mal_builtin_array_throw_string_length(vm);
        goto done;
    }
    ret = mal_value_from_string(result);

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
    mal_rooted_string_parts_dispose(&parts);
    return ret;
}

static MalValue mal_builtin_array_join(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // Intentionally generic: O = ToObject(this), len = LengthOfArrayLike(O).
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    // ToString(separator) (throwing on a Symbol/abrupt toString), default ",".
    MalString *separator;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        if (!mal_vm_to_string(vm, args[0], &separator)) {
            return mal_value_new_undefined();
        }
    } else {
        separator = mal_intrinsic_ascii(vm, ",");
    }

    MalObject *receiver = mal_value_to_object(this_value);
    for (MalArrayJoinFrame *active = vm->array_join_frames;
         active != nullptr; active = active->previous) {
        if (active->receiver == receiver) {
            return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        }
    }

    MalArrayJoinFrame frame = {
        .receiver = receiver,
        .previous = vm->array_join_frames,
    };
    vm->array_join_frames = &frame;
    MalValue result = mal_builtin_array_join_active(
        vm, this_value, length, separator);
    assert(vm->array_join_frames == &frame);
    vm->array_join_frames = frame.previous;
    return result;
}

static MalValue mal_builtin_array_reverse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    // Intentionally generic (ArrayReverse): O = ToObject(this), len =
    // LengthOfArrayLike(O), then swap mirrored slots via Has/Get/Set/Delete so a
    // TypedArray's exotic indices, inherited accessors, holes, and Proxies are
    // all observed. Boxing up front also makes the returned O a wrapper object
    // for a primitive receiver, per step 1.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->dense_elements_writable &&
        length <= (f64) UINT32_MAX &&
        dense->dense_count == (u32) length &&
        mal_builtin_array_dense_reverse_compatible(dense)) {
        mal_array_object_dense_reverse(dense);
        return this_value;
    }

    for (f64 lower = 0; length > 1 && lower < length - 1 - lower; lower++) {
        f64 upper = length - 1 - lower;

        MalValue lower_value;
        bool lower_exists = mal_builtin_array_try_get_wide(vm, this_value, lower, &lower_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        MalValue upper_value;
        bool upper_exists = mal_builtin_array_try_get_wide(vm, this_value, upper, &upper_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        // Lower slot receives the upper value (or is deleted when upper is a hole).
        if (upper_exists) {
            if (!mal_builtin_array_set_index_or_throw(vm, this_value, lower, upper_value)) {
                return mal_value_new_undefined();
            }
        } else if (lower_exists) {
            if (!mal_builtin_array_delete_index_or_throw(vm, this_value, lower)) {
                return mal_value_new_undefined();
            }
        }

        // Upper slot receives the lower value (or is deleted when lower is a hole).
        if (lower_exists) {
            if (!mal_builtin_array_set_index_or_throw(vm, this_value, upper, lower_value)) {
                return mal_value_new_undefined();
            }
        } else if (upper_exists) {
            if (!mal_builtin_array_delete_index_or_throw(vm, this_value, upper)) {
                return mal_value_new_undefined();
            }
        }
    }

    return this_value;
}

static MalValue mal_builtin_array_fill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // Intentionally generic: O = ToObject(this), len = LengthOfArrayLike(O), then
    // Set each index. A Symbol/abrupt length or a read-only target index throws.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    f64 start = arg_count >= 2 ? mal_builtin_array_clamp_relative_wide(vm, args[1], 0, length) : 0;
    f64 end = arg_count >= 3 && !mal_value_is_undefined(args[2])
        ? mal_builtin_array_clamp_relative_wide(vm, args[2], length, length)
        : length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->dense_elements_writable &&
        length == (f64) dense->length &&
        dense->dense_count == dense->length &&
        (dense->object.extensible ||
            mal_builtin_array_dense_range_present(
                dense, (u32) start, (u32) end))) {
        mal_array_object_dense_fill(
            dense, (u32) start, (u32) end, value);
        return this_value;
    }

    for (f64 index = start; index < end; index++) {
        if (!mal_builtin_array_set_index_or_throw(vm, this_value, index, value)) {
            return mal_value_new_undefined();
        }
    }

    return this_value;
}

static MalValue mal_builtin_array_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    // Intentionally generic: O = ToObject(this), len = LengthOfArrayLike(O) read
    // before ToIntegerOrInfinity(index).
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        return mal_value_new_undefined();
    }
    f64 relative = 0;
    if (arg_count >= 1) {
        f64 number;
        if (!mal_vm_to_number(vm, args[0], &number)) {
            return mal_value_new_undefined();
        }
        // ToIntegerOrInfinity: NaN -> 0, else truncate toward zero (trunc keeps
        // infinities intact, which the range check below rejects).
        relative = mal_ops_number_to_integer_or_infinity(number);
    }
    if (relative < 0) {
        relative += (f64) length;
    }
    if (relative < 0 || relative >= (f64) length) {
        return mal_value_new_undefined();
    }

    return mal_builtin_array_get(vm, this_value, (u32) relative);
}

bool mal_builtin_array_at_try_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
) {
    if (arg_count < 0 || !mal_value_is_array_object(this_value) ||
        (arg_count >= 1 && !mal_ops_is_number(args[0])) ||
        !mal_value_is_native_function_object(callee) ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(callee)) != mal_builtin_array_at) {
        return false;
    }
    f64 relative = arg_count == 0 ? 0 :
        mal_ops_number_to_integer_or_infinity(mal_ops_number_as_f64(args[0]));
    u32 length = mal_value_to_array_object(this_value)->length;
    if (relative < 0) relative += (f64) length;
    *result_out = relative < 0 || relative >= (f64) length
        ? mal_value_new_undefined()
        : mal_builtin_array_get(vm, this_value, (u32) relative);
    return true;
}

MalCompletion mal_builtin_array_at_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalValue result;
    if (mal_builtin_array_at_try_direct(
            vm, callee, this_value, args, arg_count, &result)) {
        return (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = result,
        };
    }
    return mal_vm_call_cached(
        vm, callee, this_value, args, arg_count);
}

static MalValue mal_builtin_array_find_last(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        goto done;
    }
    mal_gc_native_rooted_begin(vm);
    // The length can exceed 2^32 for an array-like, up to 2^53-1.
    for (f64 index = length - 1; index >= 0; index--) {
        MalValue element = mal_builtin_array_get_wide(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke_wide(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto loop_done;
        }

        if (mal_value_is_truthy(matched)) {
            ret = element;
            goto loop_done;
        }
    }
loop_done:
    mal_gc_native_rooted_end(vm);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_find_last_index(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        goto done;
    }
    mal_gc_native_rooted_begin(vm);
    // The length can exceed 2^32 for an array-like, up to 2^53-1.
    for (f64 index = length - 1; index >= 0; index--) {
        MalValue element = mal_builtin_array_get_wide(vm, this_value, index);

        MalValue matched;
        if (!mal_builtin_array_invoke_wide(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &matched)) {
            goto loop_done;
        }

        if (mal_value_is_truthy(matched)) {
            ret = mal_ops_number_value(index);
            goto loop_done;
        }
    }
    ret = mal_value_from_i32(-1);
loop_done:
    mal_gc_native_rooted_end(vm);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

/**
 * Read a numeric argument as a raw f64, mirroring the pragmatic numeric
 * handling of mal_builtin_array_clamp_relative for non-number values.
 */
static f64 mal_builtin_array_number_arg(MalVm *vm, const MalValue *args, i32 arg_count, i32 index, f64 fallback) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return 0;
    }
    if (index >= arg_count || mal_value_is_undefined(args[index])) {
        return fallback;
    }

    // ToIntegerOrInfinity: NaN -> 0, infinities and out-of-range magnitudes
    // preserved (callers clamp), else truncate toward zero. ToNumber throws on
    // a Symbol or BigInt argument (leaving the throw for the caller to detect).
    f64 number;
    if (mal_ops_is_number(args[index])) {
        number = mal_ops_number_as_f64(args[index]);
    } else if (!mal_vm_to_number(vm, args[index], &number)) {
        return 0;
    }
    return mal_ops_number_to_integer_or_infinity(number);
}

/**
 * Append source's elements to result, recursing into nested arrays up to
 * depth levels deep. Holes are dropped, matching FlattenIntoArray. Leaves any
 * getter throw completion on the vm for the caller to check.
 */
static void mal_builtin_array_flatten_into(MalVm *vm, MalValue result, u32 *count, MalValue source, f64 depth) {
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

        bool should_flatten = false;
        if (depth > 0 && !mal_vm_is_array(vm, element, &should_flatten)) {
            return;
        }
        if (should_flatten) {
            mal_builtin_array_flatten_into(vm, result, count, element, depth - 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return;
            }
        } else if (!mal_builtin_array_create_data_property(vm, result, (*count)++, element)) {
            return;
        }
    }
}

/**
 * Flatten exact clean dense Arrays at depth one into a fresh dense result. The
 * eligibility pass observes no user code and completes before reserving or
 * publishing output, so any exotic or differently represented child can fall
 * back to the generic FlattenIntoArray loop without duplicated effects.
 */
static bool mal_builtin_array_flat_dense_depth_one(
    MalVm *vm,
    MalArrayObject *source,
    u32 source_length,
    MalArrayObject *result
) {
    if (source->length != source_length) return false;
    u32 result_length = 0;
    for (u32 index = 0; index < source->dense_count; index++) {
        MalValue element;
        if (!mal_array_object_dense_get(source, index, &element)) continue;
        bool should_flatten;
        if (!mal_vm_is_array(vm, element, &should_flatten)) return false;
        if (!should_flatten) {
            if (result_length == UINT32_MAX) return false;
            result_length++;
            continue;
        }
        MalArrayObject *nested = mal_builtin_array_clean_dense(vm, element);
        if (nested == nullptr) return false;
        for (u32 nested_index = 0;
             nested_index < nested->dense_count;
             nested_index++) {
            if (!mal_array_object_dense_has(nested, nested_index)) continue;
            if (result_length == UINT32_MAX) return false;
            result_length++;
        }
    }

    if (!mal_array_object_try_fresh_dense_reserve_exact(
            result, result_length)) {
        return false;
    }
    for (u32 index = 0; index < source->dense_count; index++) {
        MalValue element;
        if (!mal_array_object_dense_get(source, index, &element)) continue;
        if (!mal_value_is_array_object(element)) {
            if (!mal_array_object_fresh_dense_append(result, element)) abort();
            continue;
        }
        MalArrayObject *nested = mal_value_to_array_object(element);
        for (u32 nested_index = 0;
             nested_index < nested->dense_count;
             nested_index++) {
            MalValue nested_element;
            if (!mal_array_object_dense_get(
                    nested, nested_index, &nested_element)) {
                continue;
            }
            if (!mal_array_object_fresh_dense_append(
                    result, nested_element)) {
                abort();
            }
        }
    }
    return true;
}

static MalValue mal_builtin_array_flat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        goto done;
    }
    // ToIntegerOrInfinity(depth) follows LengthOfArrayLike and precedes
    // ArraySpeciesCreate. FlattenIntoArray receives the snapped source length.
    f64 depth = mal_builtin_array_number_arg(vm, args, arg_count, 0, 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    MalValue result;
    if (!mal_builtin_array_species_create(vm, this_value, 0, &result)) {
        goto done;
    }
    MalRootSpan result_span;
    mal_gc_root(&result_span, &result, 1);
    if (depth == 1) {
        MalArrayObject *source_array =
            mal_builtin_array_clean_dense(vm, this_value);
        MalArrayObject *result_array =
            mal_builtin_array_dense_builder(result, 0);
        if (source_array != nullptr && result_array != nullptr) {
            bool flattened = mal_builtin_array_flat_dense_depth_one(
                vm, source_array, length, result_array);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&result_span);
                goto done;
            }
            if (flattened) {
                ret = result;
                mal_gc_unroot(&result_span);
                goto done;
            }
        }
    }
    u32 count = 0;
    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                break;
            }
            continue;
        }
        bool should_flatten = false;
        if (depth > 0 && !mal_vm_is_array(vm, element, &should_flatten)) {
            break;
        }
        if (should_flatten) {
            mal_builtin_array_flatten_into(vm, result, &count, element, depth - 1);
        } else {
            mal_builtin_array_create_data_property(vm, result, count++, element);
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            break;
        }
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&result_span);
        goto done;
    }
    ret = result;
    mal_gc_unroot(&result_span);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

/**
 * flatMap's per-element flatten-append: spread `mapped` into `result` at `*count`
 * (depth-1 flatten). If `mapped` is an array, its present elements are appended one
 * by one (holes skipped, no further recursion — flatMap is FlattenIntoArray depth 1);
 * otherwise `mapped` itself is appended. `*count` is advanced past the new elements.
 * Returns false (leaving the throw completion on the vm) if a property op aborts.
 * Shared by `mal_builtin_array_flat_map` and the guarded-inlining append intrinsic.
 */
static bool mal_array_flat_map_append_dense(
    MalVm *vm, MalValue result, u32 *count, MalValue mapped
) {
    MalArrayObject *mapped_array =
        mal_builtin_array_clean_dense(vm, mapped);
    MalArrayObject *result_array =
        mal_builtin_array_dense_builder(result, *count);
    if (mapped_array == nullptr || result_array == nullptr) {
        return false;
    }

    // Snapshot the mapped extent before reserving. A custom species can expose
    // the result to the callback and return that same Array as `mapped`.
    u32 mapped_dense_count = mapped_array->dense_count;
    if (mapped_dense_count > UINT32_MAX - *count) return false;
    u32 needed = *count + mapped_dense_count;
    bool reserved = needed > UINT32_MAX / 2
        ? mal_array_object_dense_reserve_exact(result_array, needed)
        : mal_array_object_dense_reserve(result_array, needed);
    if (!reserved) {
        return false;
    }

    u32 appended = 0;
    for (u32 inner = 0; inner < mapped_dense_count; inner++) {
        MalValue inner_element;
        if (!mal_array_object_dense_get(
                mapped_array, inner, &inner_element)) {
            continue;
        }
        if (!mal_array_object_fresh_dense_append(
                result_array, inner_element)) {
            abort();
        }
        appended++;
    }
    *count += appended;
    return true;
}

static bool mal_array_flat_map_append(MalVm *vm, MalValue result, u32 *count, MalValue mapped) {
    bool should_flatten;
    if (!mal_vm_is_array(vm, mapped, &should_flatten)) {
        return false;
    }
    if (should_flatten) {
        if (mal_array_flat_map_append_dense(
                vm, result, count, mapped)) {
            return true;
        }
        u32 mapped_length;
        if (!mal_builtin_array_this_length(vm, mapped, &mapped_length)) {
            return false;
        }
        for (u32 inner = 0; inner < mapped_length; inner++) {
            MalValue inner_element;
            if (mal_builtin_array_try_get(vm, mapped, inner, &inner_element)) {
                if (!mal_builtin_array_create_data_property(vm, result, (*count)++, inner_element)) {
                    return false;
                }
            }
        }
        return true;
    }
    return mal_builtin_array_create_data_property(vm, result, (*count)++, mapped);
}

static MalValue mal_builtin_array_flat_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length) || !mal_builtin_array_callback_arg(vm, args, arg_count)) {
        goto done;
    }
    MalValue result;
    if (!mal_builtin_array_species_create(vm, this_value, 0, &result)) {
        goto done;
    }
    u32 count = 0;
    MalValue roots[2] = {result, mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    mal_gc_native_rooted_begin(vm);

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto loop_done;
            }
            continue;
        }

        MalValue mapped;
        if (!mal_builtin_array_invoke(vm, args[0], mal_builtin_array_this_arg(args, arg_count), element, index, this_value, &mapped)) {
            goto loop_done;
        }
        roots[1] = mapped;

        if (!mal_array_flat_map_append(vm, result, &count, mapped)) {
            goto loop_done;
        }
    }
    ret = result;
loop_done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

/**
 * SortCompare without the undefined handling: callers partition undefined
 * elements and holes up front. A NaN comparator result counts as equal.
 */
static bool mal_builtin_array_sort_order(
    MalVm *vm, MalValue comparator, MalValue left, MalValue right,
    f64 *order_out
) {
    // Both sort entry points validate the comparator once before collecting elements.
    if (!mal_value_is_undefined(comparator)) {
        MalNumericSortComparison direct = mal_vm_try_numeric_sort_comparison(
            vm, comparator, left, right, order_out);
        if (direct != MAL_NUMERIC_SORT_FALLBACK) return direct == MAL_NUMERIC_SORT_COMPLETE;
        MalValue args[] = {left, right};
        MalRootSpan args_span;
        mal_gc_root(&args_span, args, 2);
        MalExactScriptCall *exact = vm->exact_script_call;
        MalCompletion completion = exact != nullptr && exact->callee == comparator
            ? mal_vm_call_builtin_callback(vm, comparator, mal_value_new_undefined(), args, 2)
            : mal_vm_call_cached(
                vm, comparator, mal_value_new_undefined(), args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_gc_unroot(&args_span);
            vm->completion = completion;
            return false;
        }

        args[0] = completion.value;
        f64 raw;
        if (!mal_vm_to_number(vm, completion.value, &raw)) {
            mal_gc_unroot(&args_span);
            return false;
        }
        mal_gc_unroot(&args_span);
        *order_out = raw != raw ? 0 : raw;
        return true;
    }

    // The default comparator's ToString steps are identity and non-observable
    // when both values are already string primitives. Compare their native
    // representations directly instead of publishing three temporary roots and
    // entering the generic VM coercion path for every merge comparison.
    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        *order_out = (f64) mal_string_compare(
            mal_value_to_string(left), mal_value_to_string(right));
        return true;
    }

    MalValue roots[] = {left, right, mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 3);
    MalString *left_string;
    if (!mal_vm_to_string(vm, left, &left_string)) {
        mal_gc_unroot(&roots_span);
        return false;
    }
    roots[2] = mal_value_from_string(left_string);
    MalString *right_string;
    if (!mal_vm_to_string(vm, right, &right_string)) {
        mal_gc_unroot(&roots_span);
        return false;
    }
    *order_out = (f64) mal_string_compare(left_string, right_string);
    mal_gc_unroot(&roots_span);
    return true;
}

static bool mal_builtin_array_sort_pair_order(
    MalVm *vm, MalValue comparator, bool keyed,
    MalValue left, MalValue left_key, MalValue right, MalValue right_key, f64 *order_out
) {
    if (keyed) {
        *order_out = (f64) mal_string_compare(
            mal_value_to_string(left_key), mal_value_to_string(right_key));
        return true;
    }
    return mal_builtin_array_sort_order(vm, comparator, left, right, order_out);
}

/**
 * Stable merge sort over a value buffer: insertion within blocks, then bottom-up
 * merges that skip already ordered halves. Returns false when the comparator threw;
 * the buffer contents are unspecified in that case.
 */
static bool mal_builtin_array_sort_values(
    MalVm *vm,
    MalValue *values,
    u32 count,
    MalValue comparator,
    MalValue *default_keys
) {
    if (count < 2) {
        return true;
    }

    MalValue *scratch = malloc(sizeof(MalValue) * count);
    if (scratch == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    MalValue *key_scratch = default_keys == nullptr
        ? nullptr
        : malloc(sizeof(MalValue) * count);
    if (default_keys != nullptr && key_scratch == nullptr) {
        free(scratch);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (u32 index = 0; index < count; index++) {
        scratch[index] = mal_value_new_undefined();
        if (key_scratch != nullptr) {
            key_scratch[index] = mal_value_new_undefined();
        }
    }
    MalRootSpan values_span, scratch_span, keys_span, key_scratch_span;
    mal_gc_root(&values_span, values, (i32) count);
    mal_gc_root(&scratch_span, scratch, (i32) count);
    if (default_keys != nullptr) {
        mal_gc_root(&keys_span, default_keys, (i32) count);
        mal_gc_root(&key_scratch_span, key_scratch, (i32) count);
    }
    bool ok = true;
    bool keyed = default_keys != nullptr;
    // Compiled comparators dispatch directly; every other callable keeps generic [[Call]].

    MalExactScriptCall runtime_callback;
    bool nominated = (vm->exact_script_call == nullptr ||
        vm->exact_script_call->callee != comparator) &&
        mal_vm_prepare_builtin_callback(vm, comparator, &runtime_callback);
    if (nominated) {
        vm->exact_script_call = &runtime_callback;
        MAL_PERF_COUNT(array_sort_runtime_callback_nominations);
    }
    MalExactScriptCall *numeric_leaf = vm->exact_script_call;
    if (numeric_leaf == nullptr || numeric_leaf->callee != comparator ||
        numeric_leaf->numeric_sort_kernel == nullptr) {
        numeric_leaf = nullptr;
    }
#if MAL_PROFILE
    numeric_leaf = nullptr;
#endif
    for (u32 index = 0; numeric_leaf != nullptr && index < count; index++) {
        if (!mal_ops_is_number(values[index])) numeric_leaf = nullptr;
    }
    // Without key storage the generic merge still reaches the compiled comparator per pair.
    f64 *keys = numeric_leaf == nullptr ? nullptr : malloc(sizeof(f64) * 2 * (usize) count);
    if (keys == nullptr) numeric_leaf = nullptr;
    // A bounded scalar leaf cannot re-enter JS; one depth guard covers the entire merge.
    if (numeric_leaf != nullptr && !mal_vm_enter_compiled(vm, numeric_leaf->function_index)) {
        ok = false;
        numeric_leaf = nullptr;
    }

    if (numeric_leaf != nullptr) {
        MAL_PERF_COUNT(numeric_sort_kernel_runs);
        numeric_leaf->numeric_sort_kernel(values, scratch, keys, count);
        mal_vm_leave_compiled(vm);
    } else {
        // The decisions mirror mal_numeric_leaf_merge_sort, so a leaf comparator orders
        // the same way on either path. An element awaiting its place stays in its rooted
        // scratch slot while comparators run.
        for (u32 low = 0, high; ok && low < count; low = high) {
            high = count - low < MAL_SORT_INSERTION_BLOCK ? count : low + MAL_SORT_INSERTION_BLOCK;
            u32 sorted = low + 1;
            if (sorted == high) continue;
            f64 order;
            ok = mal_builtin_array_sort_pair_order(
                vm, comparator, keyed, values[low],
                keyed ? default_keys[low] : mal_value_new_undefined(), values[sorted],
                keyed ? default_keys[sorted] : mal_value_new_undefined(), &order);
            if (!ok) break;
            bool descending = order > 0;
            for (sorted++; sorted < high; sorted++) {
                ok = mal_builtin_array_sort_pair_order(
                    vm, comparator, keyed, values[sorted - 1],
                    keyed ? default_keys[sorted - 1] : mal_value_new_undefined(), values[sorted],
                    keyed ? default_keys[sorted] : mal_value_new_undefined(), &order);
                if (!ok || (order > 0) != descending) break;
            }
            if (!ok) break;
            // A descending run must be strict so reversing it cannot reorder equal elements.
            if (descending) {
                for (u32 left = low, right = sorted - 1; left < right; left++, right--) {
                    MalValue value = values[left];
                    values[left] = values[right];
                    values[right] = value;
                    if (keyed) {
                        MalValue key = default_keys[left];
                        default_keys[left] = default_keys[right];
                        default_keys[right] = key;
                    }
                }
            }
            for (u32 index = sorted; ok && index < high; index++) {
                scratch[index] = values[index];
                if (keyed) key_scratch[index] = default_keys[index];
                u32 hole = index;
                while (hole > low) {
                    f64 order;
                    ok = mal_builtin_array_sort_pair_order(
                        vm, comparator, keyed, values[hole - 1],
                        keyed ? default_keys[hole - 1] : mal_value_new_undefined(), scratch[index],
                        keyed ? key_scratch[index] : mal_value_new_undefined(), &order);
                    if (!ok || order <= 0) break;
                    values[hole] = values[hole - 1];
                    if (keyed) default_keys[hole] = default_keys[hole - 1];
                    hole--;
                }
                values[hole] = scratch[index];
                if (keyed) default_keys[hole] = key_scratch[index];
            }
        }
        for (u32 width = MAL_SORT_INSERTION_BLOCK; ok && width < count; width *= 2) {
            for (u32 low = 0, high; ok && count - low > width; low = high) {
                u32 middle = low + width;
                high = count - middle > width ? middle + width : count;
                f64 order;
                ok = mal_builtin_array_sort_pair_order(
                    vm, comparator, keyed, values[middle - 1],
                    keyed ? default_keys[middle - 1] : mal_value_new_undefined(), values[middle],
                    keyed ? default_keys[middle] : mal_value_new_undefined(), &order);
                if (!ok || order <= 0) continue;
                u32 length = middle - low;
                memcpy(scratch, values + low, sizeof(MalValue) * length);
                if (keyed) memcpy(key_scratch, default_keys + low, sizeof(MalValue) * length);
                u32 left = 0;
                u32 right = middle;
                u32 out = low;
                while (left < length && right < high) {
                    ok = mal_builtin_array_sort_pair_order(
                        vm, comparator, keyed, scratch[left],
                        keyed ? key_scratch[left] : mal_value_new_undefined(), values[right],
                        keyed ? default_keys[right] : mal_value_new_undefined(), &order);
                    if (!ok) break;
                    if (order <= 0) {
                        values[out] = scratch[left];
                        if (keyed) default_keys[out] = key_scratch[left];
                        left++;
                    } else {
                        values[out] = values[right];
                        if (keyed) default_keys[out] = default_keys[right];
                        right++;
                    }
                    out++;
                }
                // A throwing comparator leaves the rest of the left half in rooted scratch.
                if (!ok) break;
                memcpy(values + out, scratch + left, sizeof(MalValue) * (length - left));
                if (keyed) {
                    memcpy(default_keys + out, key_scratch + left, sizeof(MalValue) * (length - left));
                }
            }
            if (width > count / 2) break;
        }
    }

    free(keys);
    if (nominated) vm->exact_script_call = runtime_callback.previous;

    if (default_keys != nullptr) {
        mal_gc_unroot(&key_scratch_span);
        mal_gc_unroot(&keys_span);
    }
    mal_gc_unroot(&scratch_span);
    mal_gc_unroot(&values_span);
    free(key_scratch);
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
    if (sorted.values == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return sorted;
    }
    for (u32 index = 0; index < length; index++) {
        sorted.values[index] = mal_value_new_undefined();
    }
    MalRootSpan values_span;
    mal_gc_root(&values_span, sorted.values, (i32) length);
    mal_gc_native_rooted_begin(vm);

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_builtin_array_try_get(vm, this_value, index, &element)) {
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_native_rooted_end(vm);
                mal_gc_unroot(&values_span);
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

    // Primitive ToString is deterministic and cannot invoke user code. For a
    // default sort containing only non-Symbol primitives, compute those keys
    // once instead of allocating/coercing again for every merge comparison.
    MalValue *default_keys = nullptr;
    MalRootSpan default_keys_span;
    bool primitive_default = mal_value_is_undefined(comparator) &&
        sorted.defined_count >= 2;
    for (u32 index = 0; primitive_default && index < sorted.defined_count; index++) {
        if (mal_value_is_object(sorted.values[index]) ||
            mal_value_is_symbol(sorted.values[index])) {
            primitive_default = false;
        }
    }
    if (primitive_default) {
        default_keys = malloc(sizeof(MalValue) * sorted.defined_count);
        if (default_keys == nullptr) {
            mal_vm_throw_allocation_error(vm);
            mal_gc_native_rooted_end(vm);
            mal_gc_unroot(&values_span);
            free(sorted.values);
            sorted.values = nullptr;
            return sorted;
        }
        for (u32 index = 0; index < sorted.defined_count; index++) {
            default_keys[index] = mal_value_new_undefined();
        }
        mal_gc_root(
            &default_keys_span, default_keys, (i32) sorted.defined_count);
        for (u32 index = 0; index < sorted.defined_count; index++) {
            default_keys[index] = mal_value_from_string(
                mal_ops_to_string(&vm->heap, sorted.values[index]));
        }
    }

    bool sort_ok = mal_builtin_array_sort_values(
        vm, sorted.values, sorted.defined_count, comparator, default_keys);
    if (default_keys != nullptr) {
        mal_gc_unroot(&default_keys_span);
        free(default_keys);
    }
    if (!sort_ok) {
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&values_span);
        free(sorted.values);
        sorted.values = nullptr;
        return sorted;
    }

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&values_span);
    sorted.ok = true;
    return sorted;
}

MalValue mal_builtin_array_sort(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue comparator;
    if (!mal_builtin_array_comparator_arg(vm, args, arg_count, &comparator)) {
        return mal_value_new_undefined();
    }
    // Intentionally generic: O = ToObject(this), len = LengthOfArrayLike(O). The
    // sorted-list build already reads through Has/Get; the write-back goes through
    // Set/Delete so array-likes and TypedArrays are handled. Boxing also makes the
    // returned O a wrapper object for a primitive receiver, per step 2.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        goto done;
    }
    MalBuiltinArraySorted sorted = mal_builtin_array_sorted_elements(vm, this_value, length, comparator);
    if (!sorted.ok) {
        goto done;
    }
    MalRootSpan sorted_span;
    mal_gc_root(&sorted_span, sorted.values, (i32) sorted.defined_count);
    mal_gc_native_rooted_begin(vm);

    u32 present_count = sorted.defined_count + sorted.undefined_count;
    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->dense_elements_writable &&
        dense->length == length &&
        (dense->object.extensible ||
            mal_builtin_array_dense_range_present(
                dense, 0, present_count))) {
        for (u32 index = 0; index < sorted.defined_count; index++) {
            mal_array_object_dense_store(dense, index, sorted.values[index]);
        }
        for (u32 index = sorted.defined_count;
             index < present_count; index++) {
            mal_array_object_dense_store(
                dense, index, mal_value_new_undefined());
        }
        for (u32 index = present_count; index < length; index++) {
            mal_array_object_dense_delete(dense, index);
        }
        ret = this_value;
        goto sorted_done;
    }

    // Sorted values first, then undefined values; what remains were holes.
    for (u32 index = 0; index < sorted.defined_count; index++) {
        if (!mal_builtin_array_set_or_throw(vm, this_value, mal_key_index(index), sorted.values[index])) {
            goto sorted_done;
        }
    }
    for (u32 index = sorted.defined_count; index < sorted.defined_count + sorted.undefined_count; index++) {
        if (!mal_builtin_array_set_or_throw(vm, this_value, mal_key_index(index), mal_value_new_undefined())) {
            goto sorted_done;
        }
    }
    for (u32 index = sorted.defined_count + sorted.undefined_count; index < length; index++) {
        if (!mal_builtin_array_delete_or_throw(vm, this_value, mal_key_index(index))) {
            goto sorted_done;
        }
    }

    ret = this_value;
sorted_done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&sorted_span);
    free(sorted.values);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

MalValue mal_builtin_array_to_sorted(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue comparator;
    if (!mal_builtin_array_comparator_arg(vm, args, arg_count, &comparator)) {
        return mal_value_new_undefined();
    }
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 wide_length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &wide_length)) {
        goto done;
    }
    if (wide_length > (f64) UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }
    u32 length = (u32) wide_length;
    MalBuiltinArraySorted sorted = mal_builtin_array_sorted_elements(vm, this_value, length, comparator);
    if (!sorted.ok) {
        goto done;
    }
    MalRootSpan sorted_span;
    mal_gc_root(&sorted_span, sorted.values, (i32) sorted.defined_count);
    mal_gc_native_rooted_begin(vm);

    // The copy is dense: undefined values and holes both sort to the end as
    // undefined elements.
    MalArrayObject *result = mal_intrinsic_new_dense_array(vm, length);
    if (mal_array_object_dense_build_values(
            result, 0, sorted.values, sorted.defined_count) &&
        mal_array_object_dense_build_fill(
            result, sorted.defined_count,
            length - sorted.defined_count,
            mal_value_new_undefined())) {
        ret = mal_value_from_array_object(result);
        goto sorted_done;
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element = index < sorted.defined_count ? sorted.values[index] : mal_value_new_undefined();
        if (!mal_builtin_array_create_data_property_wide(vm, mal_value_from_array_object(result), (f64) index, element)) {
            goto sorted_done;
        }
    }

    ret = mal_value_from_array_object(result);
sorted_done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&sorted_span);
    free(sorted.values);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

/**
 * Shared splice/toSpliced delete-count handling: absent means "to the end",
 * otherwise the count clamps to [0, length - start].
 */
static f64 mal_builtin_array_delete_count(MalVm *vm, const MalValue *args, i32 arg_count, f64 start, f64 length) {
    if (arg_count == 0) {
        return 0;
    }
    if (arg_count == 1) {
        return length - start;
    }

    f64 raw = mal_builtin_array_number_arg(vm, args, arg_count, 1, 0);
    if (!(raw > 0)) {
        return 0;
    }
    if (raw > (f64) (length - start)) {
        return length - start;
    }

    return raw;
}

static MalValue mal_builtin_array_splice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }

    f64 start = arg_count >= 1 ? mal_builtin_array_clamp_relative_wide(vm, args[0], 0, length) : 0;
    f64 delete_count = mal_builtin_array_delete_count(vm, args, arg_count, start, length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    f64 insert_count = arg_count > 2 ? (f64) (arg_count - 2) : 0;
    f64 new_length = length - delete_count + insert_count;
    if (new_length > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }

    // ArraySpeciesCreate(O, deleteCount) for the removed-elements array.
    MalValue removed;
    if (!mal_builtin_array_species_create(vm, this_value, delete_count, &removed)) {
        goto done;
    }
    MalRootSpan removed_span;
    mal_gc_root(&removed_span, &removed, 1);
    bool removed_built_dense = false;
    if (delete_count <= (f64) UINT32_MAX && start <= (f64) UINT32_MAX) {
        MalArrayObject *source_array =
            mal_builtin_array_clean_dense(vm, this_value);
        u32 source_start = (u32) start;
        u32 copy_count = (u32) delete_count;
        MalArrayObject *removed_array =
            mal_builtin_array_presized_dense_builder(removed, copy_count);
        removed_built_dense = source_array != nullptr && removed_array != nullptr &&
            (f64) source_start == start && (f64) copy_count == delete_count &&
            mal_array_object_dense_build_range(
                removed_array, 0, source_array, source_start, copy_count,
                false, false);
    }
    if (!removed_built_dense) {
        for (f64 index = 0; index < delete_count; index++) {
            MalValue element;
            if (mal_builtin_array_try_get_wide(vm, this_value, start + index, &element)) {
                if (!mal_builtin_array_create_data_property_wide(vm, removed, index, element)) {
                    goto removed_done;
                }
            } else if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto removed_done;
            }
        }

        // Set the removed array's length before mutating O. This is observable when
        // a species constructor returns a Proxy or an object with an inherited setter.
        if (!mal_builtin_array_set_or_throw(vm, removed, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(delete_count))) {
            goto removed_done;
        }
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->object.extensible &&
        dense->length_writable && length == (f64) dense->length &&
        dense->dense_count == dense->length &&
        new_length <= (f64) UINT32_MAX &&
        mal_array_object_dense_splice(
            dense, (u32) start, (u32) delete_count,
            insert_count > 0 ? args + 2 : nullptr,
            (u32) insert_count)) {
        ret = removed;
        goto removed_done;
    }

    if (insert_count < delete_count) {
        for (f64 from = start + delete_count; from < length; from++) {
            f64 to = from - delete_count + insert_count;
            MalValue element;
            bool present = mal_builtin_array_try_get_wide(vm, this_value, from, &element);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto removed_done;
            }
            if (present
                    ? !mal_builtin_array_set_index_or_throw(vm, this_value, to, element)
                    : !mal_builtin_array_delete_index_or_throw(vm, this_value, to)) {
                goto removed_done;
            }
        }
        for (f64 index = new_length; index < length; index++) {
            if (!mal_builtin_array_delete_index_or_throw(vm, this_value, index)) {
                goto removed_done;
            }
        }
    } else if (insert_count > delete_count) {
        // Shift the tail upwards back-to-front so sources are read before
        // they are overwritten.
        for (f64 from = length; from-- > start + delete_count;) {
            f64 to = from - delete_count + insert_count;
            MalValue element;
            bool present = mal_builtin_array_try_get_wide(vm, this_value, from, &element);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                goto removed_done;
            }
            if (present
                    ? !mal_builtin_array_set_index_or_throw(vm, this_value, to, element)
                    : !mal_builtin_array_delete_index_or_throw(vm, this_value, to)) {
                goto removed_done;
            }
        }
    }

    for (i32 index = 0; (f64) index < insert_count; index++) {
        if (!mal_builtin_array_set_index_or_throw(vm, this_value, start + (f64) index, args[2 + index])) {
            goto removed_done;
        }
    }

    // The final length write honors non-writable array lengths and plain
    // receivers whose length is a getter-only accessor.
    if (!mal_builtin_array_set_or_throw(vm, this_value, mal_intrinsic_string_key(vm, "length"), mal_ops_number_value(new_length))) {
        goto removed_done;
    }

    ret = removed;
removed_done:
    mal_gc_unroot(&removed_span);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_to_spliced(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }

    f64 start = arg_count >= 1 ? mal_builtin_array_clamp_relative_wide(vm, args[0], 0, length) : 0;
    f64 skip_count = mal_builtin_array_delete_count(vm, args, arg_count, start, length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    u32 insert_count = arg_count > 2 ? (u32) (arg_count - 2) : 0;
    f64 new_length = length - skip_count + (f64) insert_count;
    if (new_length > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }
    if (new_length > (f64) UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }

    MalArrayObject *result = mal_intrinsic_new_dense_array(vm, (u32) new_length);
    MalValue result_value = mal_value_from_array_object(result);
    MalRootSpan result_span;
    mal_gc_root(&result_span, &result_value, 1);
    u32 out = 0;

    MalArrayObject *source_array =
        mal_builtin_array_clean_dense(vm, this_value);
    if (source_array != nullptr &&
        source_array->length == (u32) length &&
        (f64) (u32) start == start &&
        (f64) (u32) skip_count == skip_count) {
        u32 prefix_count = (u32) start;
        u32 suffix_start = prefix_count + (u32) skip_count;
        u32 suffix_count = (u32) length - suffix_start;
        if (mal_array_object_dense_build_range(
                result, 0, source_array, 0, prefix_count,
                false, true) &&
            mal_array_object_dense_build_values(
                result, prefix_count,
                insert_count == 0 ? nullptr : args + 2, insert_count) &&
            mal_array_object_dense_build_range(
                result, prefix_count + insert_count,
                source_array, suffix_start, suffix_count,
                false, true)) {
            ret = result_value;
            goto result_done;
        }
    }

    for (f64 index = 0; index < start; index++) {
        MalValue element = mal_builtin_array_get_wide(vm, this_value, index);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !mal_builtin_array_create_data_property_wide(vm, result_value, (f64) out++, element)) {
            goto result_done;
        }
    }
    for (u32 index = 0; index < insert_count; index++) {
        if (!mal_builtin_array_create_data_property_wide(vm, result_value, (f64) out++, args[2 + (i32) index])) {
            goto result_done;
        }
    }
    for (f64 index = start + skip_count; index < length; index++) {
        MalValue element = mal_builtin_array_get_wide(vm, this_value, index);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !mal_builtin_array_create_data_property_wide(vm, result_value, (f64) out++, element)) {
            goto result_done;
        }
    }

    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        ret = result_value;
    }
result_done:
    mal_gc_unroot(&result_span);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_copy_within(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }

    f64 target = arg_count >= 1 ? mal_builtin_array_clamp_relative_wide(vm, args[0], 0, length) : 0;
    f64 start = arg_count >= 2 ? mal_builtin_array_clamp_relative_wide(vm, args[1], 0, length) : 0;
    f64 end = arg_count >= 3 && !mal_value_is_undefined(args[2])
        ? mal_builtin_array_clamp_relative_wide(vm, args[2], length, length)
        : length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }

    f64 count = end > start ? end - start : 0;
    if (count > length - target) {
        count = length - target;
    }

    MalArrayObject *dense = mal_builtin_array_clean_dense(vm, this_value);
    if (dense != nullptr && dense->dense_elements_writable &&
        dense->dense_elements_configurable &&
        length == (f64) dense->length &&
        dense->dense_count == dense->length &&
        mal_builtin_array_dense_copy_compatible(
            dense, (u32) target, (u32) start, (u32) count)) {
        mal_array_object_dense_copy_within(
            dense, (u32) target, (u32) start, (u32) count);
        ret = this_value;
        goto done;
    }

    // Disjoint ranges must retain ascending observable property accesses.
    bool backward = start < target && target < start + count;
    for (f64 step = 0; step < count; step++) {
        f64 moved = backward ? count - 1 - step : step;

        MalValue element;
        bool present = mal_builtin_array_try_get_wide(vm, this_value, start + moved, &element);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto done;
        }
        if (present
                ? !mal_builtin_array_set_index_or_throw(vm, this_value, target + moved, element)
                : !mal_builtin_array_delete_index_or_throw(vm, this_value, target + moved)) {
            goto done;
        }
    }
    ret = this_value;
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &length)) {
        goto done;
    }

    f64 relative = mal_builtin_array_number_arg(vm, args, arg_count, 0, 0);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    if (relative < 0) {
        relative += length;
    }
    if (relative < 0 || relative >= length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid index");
        goto done;
    }
    if (length > (f64) UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }

    MalArrayObject *result = mal_intrinsic_new_dense_array(vm, (u32) length);
    MalArrayObject *source_array =
        mal_builtin_array_clean_dense(vm, this_value);
    if (source_array != nullptr && source_array->length == (u32) length) {
        u32 index = (u32) relative;
        MalValue replacement =
            arg_count >= 2 ? args[1] : mal_value_new_undefined();
        if (mal_array_object_dense_build_range(
                result, 0, source_array, 0, index, false, true) &&
            mal_array_object_dense_build_values(
                result, index, &replacement, 1) &&
            mal_array_object_dense_build_range(
                result, index + 1, source_array, index + 1,
                (u32) length - index - 1, false, true)) {
            ret = mal_value_from_array_object(result);
            goto done;
        }
    }
    for (u32 index = 0; (f64) index < length; index++) {
        MalValue element = (f64) index == relative
            ? (arg_count >= 2 ? args[1] : mal_value_new_undefined())
            : mal_builtin_array_get_wide(vm, this_value, (f64) index);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !mal_builtin_array_create_data_property_wide(vm, mal_value_from_array_object(result), (f64) index, element)) {
            goto done;
        }
    }

    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        ret = mal_value_from_array_object(result);
    }
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_to_reversed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    f64 wide_length;
    if (!mal_builtin_array_length_of_array_like(vm, this_value, &wide_length)) {
        goto done;
    }
    if (wide_length > (f64) UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        goto done;
    }
    u32 length = (u32) wide_length;

    MalArrayObject *result = mal_intrinsic_new_dense_array(vm, length);
    MalArrayObject *source_array =
        mal_builtin_array_clean_dense(vm, this_value);
    if (source_array != nullptr && source_array->length == length &&
        mal_array_object_dense_build_range(
            result, 0, source_array, 0, length, true, true)) {
        ret = mal_value_from_array_object(result);
        goto done;
    }
    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get_wide(vm, this_value, (f64) length - 1 - (f64) index);
        if (vm->completion.kind == MAL_COMPLETION_THROW
            || !mal_builtin_array_create_data_property_wide(
                vm,
                mal_value_from_array_object(result),
                (f64) index,
                element
            )) {
            goto done;
        }
    }

    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        ret = mal_value_from_array_object(result);
    }
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    // Array.prototype.toString delegates to this.join when callable.
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    if (mal_vm_primitive_methods_intact(vm) &&
        mal_array_method_is_default_builtin(
            vm, this_value, (const byte *) "join",
            mal_builtin_array_join)) {
        return mal_builtin_array_join(
            vm, this_value, nullptr, 0,
            mal_value_new_undefined(),
            mal_value_new_undefined());
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    MalValue join;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "join"), &join)) {
        goto done;
    }
    if (mal_value_is_callable(join)) {
        MalCompletion completion = mal_vm_call_value(vm, join, this_value, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            goto done;
        }
        ret = completion.value;
        goto done;
    }

    ret = mal_builtin_object_prototype_to_string(vm, this_value, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    // Intentionally generic (Array.prototype.toLocaleString): O = ToObject(this),
    // len = LengthOfArrayLike(O); each non-nullish element formats through
    // ? ToString(? Invoke(element, "toLocaleString")) joined with ",".
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue ret = mal_value_new_undefined();
    u32 length;
    if (!mal_builtin_array_this_length(vm, this_value, &length)) {
        goto done;
    }

    MalString *separator = mal_intrinsic_ascii(vm, ",");
    if (length == 0) {
        ret = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        goto done;
    }

    MalKey to_locale_key = mal_intrinsic_string_key(vm, "toLocaleString");
    MalRootedStringParts parts;
    if (!mal_rooted_string_parts_init(&parts, separator, length)) {
        mal_builtin_array_throw_string_length(vm);
        goto done;
    }
    mal_gc_native_rooted_begin(vm);

    for (u32 index = 0; index < length; index++) {
        MalValue element = mal_builtin_array_get(vm, this_value, index);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto parts_done;
        }
        if (mal_value_is_nil(element)) {
            if (!mal_rooted_string_parts_append(&parts, nullptr)) {
                mal_builtin_array_throw_string_length(vm);
                goto parts_done;
            }
            continue;
        }

        // ? ToString(? Invoke(element, "toLocaleString")).
        MalValue method;
        if (!mal_vm_get_property(vm, element, to_locale_key, &method)) {
            goto parts_done;
        }
        MalCompletion completion = mal_vm_call_value(vm, method, element, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            goto parts_done;
        }
        MalString *part;
        if (!mal_vm_to_string(vm, completion.value, &part)) {
            goto parts_done;
        }
        if (!mal_rooted_string_parts_append(&parts, part)) {
            mal_builtin_array_throw_string_length(vm);
            goto parts_done;
        }
    }

    MalString *result;
    if (!mal_rooted_string_parts_flatten(vm, &parts, &result)) {
        mal_builtin_array_throw_string_length(vm);
        goto parts_done;
    }
    ret = mal_value_from_string(result);
parts_done:
    mal_gc_native_rooted_end(vm);
    mal_rooted_string_parts_dispose(&parts);
done:
    mal_gc_unroot(&this_span);
    return ret;
}

static MalValue mal_builtin_array_prototype_iterator(MalVm *vm, MalValue this_value, MalIteratorKind kind) {
    if (!mal_builtin_array_to_object(vm, &this_value)) {
        return mal_value_new_undefined();
    }
    MalRootSpan this_span;
    mal_gc_root(&this_span, &this_value, 1);
    MalValue iterator = mal_vm_new_builtin_iterator(vm, kind, this_value);
    mal_gc_unroot(&this_span);
    return iterator;
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

// Promise reactions retain the step closure's traced slots; stack state never spans an Await.

enum {
    MAL_FROM_ASYNC_SLOT_RESULT = 0,
    MAL_FROM_ASYNC_SLOT_K,
    MAL_FROM_ASYNC_SLOT_ITERATOR,
    MAL_FROM_ASYNC_SLOT_NEXT,
    MAL_FROM_ASYNC_SLOT_MAPFN,
    MAL_FROM_ASYNC_SLOT_THIS_ARG,
    MAL_FROM_ASYNC_SLOT_RESOLVE,
    MAL_FROM_ASYNC_SLOT_REJECT,
    MAL_FROM_ASYNC_SLOT_LEN,
    MAL_FROM_ASYNC_SLOT_ARRAY_LIKE,
    MAL_FROM_ASYNC_SLOT_MAPPING,
    MAL_FROM_ASYNC_SLOT_PHASE,
    MAL_FROM_ASYNC_SLOT_FAIL,
    MAL_FROM_ASYNC_SLOT_CALLBACK_INDEX,
    MAL_FROM_ASYNC_SLOT_CLOSE_ERROR,
    MAL_FROM_ASYNC_SLOT_COUNT,
};

enum {
    MAL_FROM_ASYNC_PHASE_ITER_NEXT = 0, // awaiting iterator.next()'s result
    MAL_FROM_ASYNC_PHASE_ITER_MAP,      // awaiting a mapped value (iterator path)
    MAL_FROM_ASYNC_PHASE_AL_GET,        // awaiting arrayLike[k]
    MAL_FROM_ASYNC_PHASE_AL_MAP,        // awaiting a mapped value (array-like path)
    MAL_FROM_ASYNC_PHASE_ITER_CLOSE,
};

static MalCompletion mal_array_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static f64 mal_from_async_slot_number(MalNativeFunctionObject *self, i32 slot) {
    return mal_ops_to_number(mal_native_function_object_get_slot(self, slot));
}

static void mal_from_async_call1(MalVm *vm, MalValue fn, MalValue arg) {
    vm->completion = mal_array_normal();
    mal_vm_call_value(vm, fn, mal_value_new_undefined(), &arg, 1);
    vm->completion = mal_array_normal();
}

static void mal_from_async_await(MalVm *vm, MalValue value, MalValue step, MalValue fail) {
    // The PromiseResolve wrapper for a primitive cannot escape this Await.
    // Resume through the same reaction job without allocating that Promise.
    if (!mal_value_is_object(value)) {
        mal_vm_enqueue_reaction_job(
            vm,
            step,
            false,
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            value);
        return;
    }

    MalValue promise;
    if (!mal_promise_resolve_value(vm, value, &promise)) {
        MalValue error = vm->completion.value;
        mal_from_async_call1(vm, fail, error);
        return;
    }
    mal_promise_perform_then(vm, promise, step, fail, mal_value_new_undefined(), mal_value_new_undefined());
}

static void mal_from_async_reject_close(MalVm *vm, MalNativeFunctionObject *self) {
    MalValue error = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_CLOSE_ERROR);
    mal_from_async_call1(vm, mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_REJECT), error);
    mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_CLOSE_ERROR, mal_value_new_undefined());
}

static void mal_from_async_close(MalVm *vm, MalNativeFunctionObject *self, MalValue error) {
    // AsyncIteratorClose preserves the original throw even when return lookup, Call, or Await fails.
    mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_CLOSE_ERROR, error);
    mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_PHASE, mal_value_from_f64(MAL_FROM_ASYNC_PHASE_ITER_CLOSE));
    vm->completion = mal_array_normal();
    MalValue iterator = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_ITERATOR);
    MalValue return_method;
    if (!mal_vm_get_property(vm, iterator, mal_intrinsic_string_key(vm, "return"), &return_method) ||
        !mal_value_is_callable(return_method)) {
        mal_from_async_reject_close(vm, self);
        return;
    }
    MalCompletion returned = mal_vm_call_value(vm, return_method, iterator, nullptr, 0);
    if (returned.kind != MAL_COMPLETION_NORMAL) {
        mal_from_async_reject_close(vm, self);
        return;
    }
    mal_from_async_await(vm, returned.value, mal_value_from_native_function_object(self),
        mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_FAIL));
}

// Iterator path: Call(next, iterator) then Await the result at PHASE_ITER_NEXT.
static void mal_from_async_iter_next(MalVm *vm, MalNativeFunctionObject *self, MalValue step, MalValue fail) {
    if (mal_from_async_slot_number(self, MAL_FROM_ASYNC_SLOT_K) >= MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.fromAsync exceeded maximum safe index");
        mal_from_async_close(vm, self, vm->completion.value);
        return;
    }
    MalValue iterator = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_ITERATOR);
    MalValue next = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_NEXT);
    MalValue reject = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_REJECT);
    MalCompletion completion = mal_vm_call_value(vm, next, iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        mal_from_async_call1(vm, reject, completion.value);
        return;
    }
    mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_PHASE, mal_value_from_f64(MAL_FROM_ASYNC_PHASE_ITER_NEXT));
    mal_from_async_await(vm, completion.value, step, fail);
}

// Array-like path: Get(arrayLike, k) then Await it at PHASE_AL_GET; if the index
// is past the end, finalize the length and resolve.
static void mal_from_async_al_get(MalVm *vm, MalNativeFunctionObject *self, MalValue step, MalValue fail) {
    MalValue reject = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_REJECT);
    MalValue resolve = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_RESOLVE);
    MalValue result = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_RESULT);
    f64 k = mal_from_async_slot_number(self, MAL_FROM_ASYNC_SLOT_K);
    f64 len = mal_ops_to_number(mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_LEN));
    if (k >= len) {
        if (!mal_builtin_array_set_or_throw(vm, result, mal_intrinsic_string_key(vm, "length"), mal_value_from_f64(len))) {
            mal_from_async_call1(vm, reject, vm->completion.value);
            return;
        }
        mal_from_async_call1(vm, resolve, result);
        return;
    }
    MalValue array_like = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_ARRAY_LIKE);
    MalValue k_value;
    MalKey key;
    if (!mal_builtin_array_numeric_key(vm, k, &key) ||
        !mal_vm_get_property(vm, array_like, key, &k_value)) {
        mal_from_async_call1(vm, reject, vm->completion.value);
        return;
    }
    mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_PHASE, mal_value_from_f64(MAL_FROM_ASYNC_PHASE_AL_GET));
    mal_from_async_await(vm, k_value, step, fail);
}

static MalValue mal_array_from_async_fail(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *fail_self = mal_value_to_native_function_object(callee);
    MalNativeFunctionObject *self = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(fail_self, 0));
    MalValue error = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    i32 phase = (i32) mal_from_async_slot_number(self, MAL_FROM_ASYNC_SLOT_PHASE);
    if (phase == MAL_FROM_ASYNC_PHASE_ITER_MAP) {
        mal_from_async_close(vm, self, error);
        return mal_value_new_undefined();
    }
    if (phase == MAL_FROM_ASYNC_PHASE_ITER_CLOSE) {
        mal_from_async_reject_close(vm, self);
        return mal_value_new_undefined();
    }
    mal_from_async_call1(vm, mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_REJECT), error);
    return mal_value_new_undefined();
}

static MalCompletion mal_from_async_map(
    MalVm *vm, MalNativeFunctionObject *self, MalValue value, f64 index
) {
    MalValue mapper = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_MAPFN);
    MalValue map_args[2] = {value, mal_value_from_f64(index)};
    MalRootSpan args_span;
    mal_gc_root(&args_span, map_args, 2);
    i32 function_index = mal_value_to_i32(
        mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_CALLBACK_INDEX));
    MalExactScriptCall callback;
    bool resumed = false;
    if (function_index >= 0 && function_index < vm->runtime_image->function_count &&
        (vm->exact_script_call == nullptr || vm->exact_script_call->callee != mapper)
#if MAL_REALMS
        && mal_vm_owns_realm(vm, mal_value_to_function_object(mapper)->realm)
#endif
    ) {
        // Only the stable index survives Await; runtime compilation can relocate the table.
        MalCompiledFunction compiled = vm->runtime_image->functions[function_index].compiled;
        if (compiled != nullptr) {
            callback = (MalExactScriptCall) {
                .previous = vm->exact_script_call,
                .callee = mapper,
                .function_index = function_index,
                .compiled_callback = compiled,
                .numeric_sort_comparator = nullptr,
                .numeric_sort_kernel = nullptr,
                .env = mal_value_to_function_object(mapper)->creation_env,
                .numeric_reduce_callback = nullptr,
            };
            vm->exact_script_call = &callback;
            resumed = true;
            MAL_PERF_COUNT(array_from_async_callback_resumes);
        }
    }
    MalCompletion completion = mal_vm_call_builtin_callback(
        vm, mapper, mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_THIS_ARG),
        map_args, 2);
    if (resumed) vm->exact_script_call = callback.previous;
    mal_gc_unroot(&args_span);
    return completion;
}

// onFulfilled: resume the loop from the phase recorded before the Await.
static MalValue mal_array_from_async_step(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue step = callee;
    MalValue fail = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_FAIL);
    MalValue reject = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_REJECT);
    MalValue resolve = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_RESOLVE);
    MalValue result = mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_RESULT);
    bool mapping = mal_value_is_truthy(mal_native_function_object_get_slot(self, MAL_FROM_ASYNC_SLOT_MAPPING));
    f64 k = mal_from_async_slot_number(self, MAL_FROM_ASYNC_SLOT_K);
    i32 phase = (i32) mal_from_async_slot_number(self, MAL_FROM_ASYNC_SLOT_PHASE);
    MalValue resumed = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    switch (phase) {
        case MAL_FROM_ASYNC_PHASE_ITER_NEXT: {
            // `resumed` is the awaited iterator result object.
            if (!mal_value_is_object(resumed)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
                mal_from_async_call1(vm, reject, vm->completion.value);
                return mal_value_new_undefined();
            }
            MalValue done_value;
            if (!mal_vm_get_property(vm, resumed, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_DONE), &done_value)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                return mal_value_new_undefined();
            }
            if (mal_value_is_truthy(done_value)) {
                if (!mal_builtin_array_set_or_throw(vm, result, mal_intrinsic_string_key(vm, "length"), mal_value_from_f64(k))) {
                    mal_from_async_call1(vm, reject, vm->completion.value);
                    return mal_value_new_undefined();
                }
                mal_from_async_call1(vm, resolve, result);
                return mal_value_new_undefined();
            }
            MalValue next_value;
            if (!mal_vm_get_property(vm, resumed, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_VALUE), &next_value)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                return mal_value_new_undefined();
            }
            if (mapping) {
                MalCompletion mapped = mal_from_async_map(vm, self, next_value, k);
                if (mapped.kind != MAL_COMPLETION_NORMAL) {
                    mal_from_async_close(vm, self, mapped.value);
                    return mal_value_new_undefined();
                }
                mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_PHASE, mal_value_from_f64(MAL_FROM_ASYNC_PHASE_ITER_MAP));
                mal_from_async_await(vm, mapped.value, step, fail);
                return mal_value_new_undefined();
            }
            if (!mal_builtin_array_create_data_property_wide(vm, result, k, next_value)) {
                mal_from_async_close(vm, self, vm->completion.value);
                return mal_value_new_undefined();
            }
            mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_K, mal_value_from_f64(k + 1));
            mal_from_async_iter_next(vm, self, step, fail);
            return mal_value_new_undefined();
        }
        case MAL_FROM_ASYNC_PHASE_ITER_MAP: {
            if (!mal_builtin_array_create_data_property_wide(vm, result, k, resumed)) {
                mal_from_async_close(vm, self, vm->completion.value);
                return mal_value_new_undefined();
            }
            mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_K, mal_value_from_f64(k + 1));
            mal_from_async_iter_next(vm, self, step, fail);
            return mal_value_new_undefined();
        }
        case MAL_FROM_ASYNC_PHASE_AL_GET: {
            if (mapping) {
                MalCompletion mapped = mal_from_async_map(vm, self, resumed, k);
                if (mapped.kind != MAL_COMPLETION_NORMAL) {
                    mal_from_async_call1(vm, reject, mapped.value);
                    return mal_value_new_undefined();
                }
                mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_PHASE, mal_value_from_f64(MAL_FROM_ASYNC_PHASE_AL_MAP));
                mal_from_async_await(vm, mapped.value, step, fail);
                return mal_value_new_undefined();
            }
            if (!mal_builtin_array_create_data_property_wide(vm, result, k, resumed)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                return mal_value_new_undefined();
            }
            mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_K, mal_value_from_f64(k + 1));
            mal_from_async_al_get(vm, self, step, fail);
            return mal_value_new_undefined();
        }
        case MAL_FROM_ASYNC_PHASE_AL_MAP: {
            if (!mal_builtin_array_create_data_property_wide(vm, result, k, resumed)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                return mal_value_new_undefined();
            }
            mal_native_function_object_set_slot(self, MAL_FROM_ASYNC_SLOT_K, mal_value_from_f64(k + 1));
            mal_from_async_al_get(vm, self, step, fail);
            return mal_value_new_undefined();
        }
        case MAL_FROM_ASYNC_PHASE_ITER_CLOSE:
            mal_from_async_reject_close(vm, self);
            return mal_value_new_undefined();
        default:
            return mal_value_new_undefined();
    }
}

static MalValue mal_builtin_array_from_async(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalValue constructor = this_value;
    MalValue async_items = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue mapfn = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue this_arg = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    MalValue promise;
    MalValue resolve;
    MalValue reject;
    if (!mal_promise_new_capability(vm, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], &promise, &resolve, &reject)) {
        return mal_value_new_undefined();
    }

    MalValue roots[6] = {
        promise, resolve, reject, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalIteratorRecord record = {
        .iterator = mal_value_new_undefined(),
        .next_method = mal_value_new_undefined(),
    };
    MalRootSpan roots_span, record_span;
    mal_gc_root(&roots_span, roots, countof(roots));
    mal_gc_root(&record_span, &record.iterator, 2);

    // Setup getters and constructors can collect before any reaction retains this state.
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue empty_slots[MAL_FROM_ASYNC_SLOT_COUNT];
    for (i32 i = 0; i < MAL_FROM_ASYNC_SLOT_COUNT; i++) {
        empty_slots[i] = mal_value_new_undefined();
    }
    MalNativeFunctionObject *step = mal_native_function_object_new_with_slots(
        &vm->heap, function_prototype, nullptr, mal_array_from_async_step, empty_slots, MAL_FROM_ASYNC_SLOT_COUNT);
    MalValue step_value = roots[3] = mal_value_from_native_function_object(step);
    MalValue fail_slot[1] = {step_value};
    MalValue fail_value = roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, function_prototype, nullptr, mal_array_from_async_fail, fail_slot, 1));

    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_FAIL, fail_value);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_MAPFN, mapfn);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_THIS_ARG, this_arg);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_RESOLVE, resolve);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_REJECT, reject);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_K, mal_value_from_f64(0));

    bool mapping = false;
    if (!mal_value_is_undefined(mapfn)) {
        if (!mal_value_is_callable(mapfn)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.fromAsync mapper is not a function");
            mal_from_async_call1(vm, reject, vm->completion.value);
            goto done;
        }
        mapping = true;
    }
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_MAPPING, mal_value_new_boolean(mapping));
    MalExactScriptCall candidate;
    bool nominated = mapping && mal_vm_prepare_builtin_callback(vm, mapfn, &candidate);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_CALLBACK_INDEX,
        mal_value_from_i32(nominated ? candidate.function_index : -1));
    if (nominated) MAL_PERF_COUNT(array_from_async_callback_nominations);

    // GetMethod(@@asyncIterator); on undefined, GetMethod(@@iterator); each at
    // most once, then dispatch to the iterator or array-like path.
    bool have_iterator = false;
    if (!mal_value_is_nil(async_items)) {
        MalValue async_method;
        if (!mal_vm_get_property(vm, async_items, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &async_method)) {
            mal_from_async_call1(vm, reject, vm->completion.value);
            goto done;
        }
        if (mal_value_is_callable(async_method)) {
            if (!mal_vm_async_iterator_from_method(vm, async_items, async_method, true, &record)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                goto done;
            }
            have_iterator = true;
        } else if (!mal_value_is_undefined(async_method) && !mal_value_is_nil(async_method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.asyncIterator is not callable");
            mal_from_async_call1(vm, reject, vm->completion.value);
            goto done;
        } else {
            MalValue sync_method;
            if (!mal_vm_get_property(vm, async_items, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &sync_method)) {
                mal_from_async_call1(vm, reject, vm->completion.value);
                goto done;
            }
            if (mal_value_is_callable(sync_method)) {
                if (!mal_vm_async_iterator_from_method(vm, async_items, sync_method, false, &record)) {
                    mal_from_async_call1(vm, reject, vm->completion.value);
                    goto done;
                }
                have_iterator = true;
            } else if (!mal_value_is_undefined(sync_method) && !mal_value_is_nil(sync_method)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.iterator is not callable");
                mal_from_async_call1(vm, reject, vm->completion.value);
                goto done;
            }
        }
    }

    bool is_constructor = mal_vm_is_constructor(vm, constructor);

    if (have_iterator) {
        MalValue result;
        if (is_constructor) {
            MalCompletion constructed = mal_vm_construct_value(vm, constructor, nullptr, 0);
            if (constructed.kind != MAL_COMPLETION_NORMAL) {
                mal_from_async_call1(vm, reject, constructed.value);
                goto done;
            }
            result = constructed.value;
        } else {
            result = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
        }
        mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_RESULT, result);
        mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_ITERATOR, record.iterator);
        mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_NEXT, record.next_method);
        mal_from_async_iter_next(vm, step, step_value, fail_value);
        goto done;
    }

    // Array-like path. ToObject(asyncItems): null/undefined reject; other
    // primitives are read through auto-boxing Get (so an inherited `length` and
    // indexed properties on, e.g., Number.prototype are honored).
    if (mal_value_is_nil(async_items)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Array.fromAsync called on null or undefined");
        mal_from_async_call1(vm, reject, vm->completion.value);
        goto done;
    }
    // LengthOfArrayLike = ToLength(Get(O, "length")): clamp to [0, 2^53-1].
    if (!mal_vm_get_property(vm, async_items, mal_intrinsic_string_key(vm, "length"), &roots[5])) {
        mal_from_async_call1(vm, reject, vm->completion.value);
        goto done;
    }
    f64 length_number;
    if (!mal_vm_to_number(vm, roots[5], &length_number)) {
        mal_from_async_call1(vm, reject, vm->completion.value);
        goto done;
    }
    f64 len = mal_ops_number_to_length(length_number);

    MalValue result;
    if (is_constructor) {
        MalValue len_arg = mal_value_from_f64(len);
        MalCompletion constructed = mal_vm_construct_value(vm, constructor, &len_arg, 1);
        if (constructed.kind != MAL_COMPLETION_NORMAL) {
            mal_from_async_call1(vm, reject, constructed.value);
            goto done;
        }
        result = constructed.value;
    } else {
        // ArrayCreate(len): an array length must fit in a u32 (< 2^32).
        if (len > 4294967295.0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
            mal_from_async_call1(vm, reject, vm->completion.value);
            goto done;
        }
        result = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) len));
    }
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_RESULT, result);
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_LEN, mal_value_from_f64(len));
    mal_native_function_object_set_slot(step, MAL_FROM_ASYNC_SLOT_ARRAY_LIKE, async_items);
    // mal_from_async_al_get finalizes (Set length + resolve) when len == 0.
    mal_from_async_al_get(vm, step, step_value, fail_value);
done:
    mal_gc_unroot(&record_span);
    mal_gc_unroot(&roots_span);
    return promise;
}

/**
 * Whether `recv`'s ArraySpeciesCreate would yield a plain Array — i.e. its species is
 * the default. Side-effect-free structural check (assumes the caller already verified
 * recv's [[Prototype]] is %Array.prototype%): recv has no own "constructor",
 * %Array.prototype%.constructor is the intrinsic Array constructor, and that
 * constructor's own @@species is the default getter. Used by guarded map/filter
 * inlining, whose fast path creates a plain result array.
 */
static bool mal_array_default_species(MalVm *vm, MalValue recv) {
    MalValue array_proto_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue array_ctor_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    if (!mal_value_is_object(array_proto_value) || !mal_value_is_object(array_ctor_value)) {
        return false;
    }
    MalObject *receiver = mal_value_to_object(recv);
    MalObject *array_prototype = mal_value_to_object(array_proto_value);
    MalObject *array_constructor = mal_value_to_object(array_ctor_value);

    // Callers have matched the receiver's prototype to %Array.prototype%. An empty
    // own layout holds no `constructor` that could redirect species.
    bool may_shadow = (receiver->shape != nullptr && receiver->shape->inline_count != 0) ||
        mal_object_has_public_overflow(receiver);
    MalKey ctor_key = mal_intrinsic_string_key(vm, (const byte *) "constructor");
    if (may_shadow && mal_object_get_own(receiver, ctor_key).present) {
        return false;
    }
#if MAL_PRIMORDIALS_LOCKED
    // The locked primordial graph keeps %Array.prototype%.constructor and %Array%[@@species].
    (void) array_prototype;
    (void) array_constructor;
    return true;
#else
    MalPropertyLookup ctor_lookup = mal_object_get_own(array_prototype, ctor_key);
    if (!ctor_lookup.present || (ctor_lookup.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        !mal_value_is_object(ctor_lookup.desc.value) ||
        mal_value_to_object(ctor_lookup.desc.value) != array_constructor) {
        return false;
    }
    MalKey species_key = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES);
    MalPropertyLookup species_lookup = mal_object_get_own(array_constructor, species_key);
    if (!species_lookup.present || !(species_lookup.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        !mal_value_is_native_function_object(species_lookup.desc.getter)) {
        return false;
    }
    return mal_native_function_object_callback(mal_value_to_native_function_object(species_lookup.desc.getter)) ==
           mal_intrinsic_species_getter;
#endif
}

bool mal_builtin_array_exact_map_guard(
    MalVm *vm, MalValue callee, MalValue receiver
) {
    if (!mal_vm_primitive_methods_intact(vm) || !mal_vm_array_elements_intact(vm) ||
        !mal_value_is_native_function_object(callee) ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(callee)) != mal_builtin_array_map ||
        !mal_array_method_is_default_builtin(
            vm, receiver, (const byte *) "map", mal_builtin_array_map) ||
        !mal_array_default_species(vm, receiver)) {
        return false;
    }
#if MAL_REALMS
    return mal_vm_callee_realm(vm, callee) == vm->current_realm;
#else
    return true;
#endif
}

bool mal_builtin_array_default_map_guard(MalVm *vm, MalValue receiver) {
    return mal_vm_primitive_methods_intact(vm) && mal_vm_array_elements_intact(vm) &&
        mal_array_method_is_default_builtin(
            vm, receiver, (const byte *) "map", mal_builtin_array_map) &&
        mal_array_default_species(vm, receiver);
}

static MalCompletion mal_builtin_array_iteration_direct_impl(
    MalVm *vm,
    MalBuiltinArrayIterationOp operation,
    i32 callback_function_index,
    MalCompiledFunction compiled_callback,
    MalNumericReduceCallback numeric_reduce_callback,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalNativeFunctionCallback expected = nullptr;
    MalNativeFunctionCallback alternate = nullptr;
    switch (operation) {
        case MAL_BUILTIN_MAP_FOR_EACH:
            expected = mal_builtin_map_prototype_for_each;
            break;
        case MAL_BUILTIN_SET_FOR_EACH:
            expected = mal_builtin_set_prototype_for_each;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FOR_EACH:
            expected = mal_builtin_array_for_each;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_SOME:
            expected = mal_builtin_array_some;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_EVERY:
            expected = mal_builtin_array_every;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FIND:
            expected = mal_builtin_array_find;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FIND_INDEX:
            expected = mal_builtin_array_find_index;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_MAP:
            expected = mal_builtin_array_map;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FILTER:
            expected = mal_builtin_array_filter;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_REDUCE:
            expected = mal_builtin_array_reduce;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_REDUCE_RIGHT:
            expected = mal_builtin_array_reduce_right;
            break;
        case MAL_BUILTIN_TYPED_ARRAY_FOR_EACH:
        case MAL_BUILTIN_TYPED_ARRAY_SOME:
        case MAL_BUILTIN_TYPED_ARRAY_EVERY:
        case MAL_BUILTIN_TYPED_ARRAY_FIND:
        case MAL_BUILTIN_TYPED_ARRAY_FIND_INDEX:
        case MAL_BUILTIN_TYPED_ARRAY_MAP:
        case MAL_BUILTIN_TYPED_ARRAY_FILTER:
        case MAL_BUILTIN_TYPED_ARRAY_FIND_LAST:
        case MAL_BUILTIN_TYPED_ARRAY_FIND_LAST_INDEX:
        case MAL_BUILTIN_TYPED_ARRAY_REDUCE:
        case MAL_BUILTIN_TYPED_ARRAY_REDUCE_RIGHT:
            expected = mal_builtin_typed_array_iteration_callback(operation);
            break;
        case MAL_BUILTIN_COLLECTION_FOR_EACH:
            expected = mal_builtin_array_for_each;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FOR_EACH);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_SOME:
            expected = mal_builtin_array_some;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_SOME);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_EVERY:
            expected = mal_builtin_array_every;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_EVERY);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND:
            expected = mal_builtin_array_find;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FIND);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_INDEX:
            expected = mal_builtin_array_find_index;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FIND_INDEX);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_MAP:
            expected = mal_builtin_array_map;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_MAP);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FILTER:
            expected = mal_builtin_array_filter;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FILTER);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST:
            expected = mal_builtin_array_find_last;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FIND_LAST);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST_INDEX:
            expected = mal_builtin_array_find_last_index;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_FIND_LAST_INDEX);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE:
            expected = mal_builtin_array_reduce;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_REDUCE);
            break;
        case MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE_RIGHT:
            expected = mal_builtin_array_reduce_right;
            alternate = mal_builtin_typed_array_iteration_callback(MAL_BUILTIN_TYPED_ARRAY_REDUCE_RIGHT);
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST:
            expected = mal_builtin_array_find_last;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST_INDEX:
            expected = mal_builtin_array_find_last_index;
            break;
        case MAL_BUILTIN_ARRAY_ITERATION_FLAT_MAP:
            expected = mal_builtin_array_flat_map;
            break;
        default:
            abort();
    }

    MalNativeFunctionCallback actual = mal_value_is_native_function_object(callee)
        ? mal_native_function_object_callback(mal_value_to_native_function_object(callee))
        : nullptr;
    if (operation == MAL_BUILTIN_COLLECTION_FOR_EACH &&
        (actual == mal_builtin_map_prototype_for_each ||
         actual == mal_builtin_set_prototype_for_each)) {
        expected = actual;
    }
    if (alternate != nullptr && actual == alternate) expected = alternate;
    bool exact = arg_count >= 0 && actual != nullptr && actual == expected;
#if MAL_REALMS
    exact = exact && mal_vm_callee_realm(vm, callee) == vm->current_realm;
#endif
    if (exact) {
        MAL_PERF_COUNT(array_iteration_direct_hits);
        MalExactScriptCall callback_call = {
            .previous = vm->exact_script_call,
            .callee = arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED,
            .function_index = callback_function_index,
            .compiled_callback = compiled_callback,
            .numeric_reduce_callback = numeric_reduce_callback,
            .env = nullptr,
        };
        if (callback_function_index >= 0 && compiled_callback != nullptr) {
            callback_call.env =
                mal_value_to_function_object(callback_call.callee)->creation_env;
        }
        if (callback_function_index < 0 &&
            mal_vm_prepare_builtin_callback(vm, callback_call.callee, &callback_call)) {
            MAL_PERF_COUNT(array_iteration_runtime_callback_nominations);
        }
        if (callback_call.function_index >= 0) {
            vm->exact_script_call = &callback_call;
        }
        MalCompletion completion = mal_vm_call_exact_native(
            vm, expected, callee, this_value, args, arg_count);
        if (callback_call.function_index >= 0) {
            vm->exact_script_call = callback_call.previous;
        }
        return completion;
    }

    MAL_PERF_COUNT(array_iteration_direct_fallbacks);
    return mal_vm_call_cached(
        vm, callee, this_value, args, arg_count);
}

MalCompletion mal_builtin_array_iteration_direct(
    MalVm *vm, MalBuiltinArrayIterationOp operation,
    i32 callback_function_index, MalCompiledFunction compiled_callback,
    MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count
) {
    return mal_builtin_array_iteration_direct_impl(
        vm, operation, callback_function_index, compiled_callback,
        nullptr, callee, this_value, args, arg_count);
}

MalCompletion mal_builtin_array_numeric_reduce_direct(
    MalVm *vm, MalBuiltinArrayIterationOp operation,
    i32 callback_function_index, MalCompiledFunction compiled_callback,
    MalNumericReduceCallback numeric_reduce_callback,
    MalValue callee, MalValue this_value, const MalValue *args, i32 arg_count
) {
    return mal_builtin_array_iteration_direct_impl(
        vm, operation, callback_function_index, compiled_callback,
        numeric_reduce_callback, callee, this_value, args, arg_count);
}

/**
 * Eligibility predicate for the compiler's guarded array-iteration inlining
 * (intrinsic slot MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE, invoked via
 * LOAD_INTRINSIC + call). args[0] = the method value captured by the ordinary
 * property Get, args[1] = receiver, args[2] = a compiler-baked method id. Validating
 * that already-loaded value preserves Get-before-arguments evaluation order and
 * avoids a second property lookup. map/filter/flatMap additionally require a default
 * @@species because their fast paths build a plain Array. Side-effect-free.
 */
bool mal_builtin_array_iteration_eligible_values(MalVm *vm, const MalValue *args) {
    if (!mal_value_is_array_object(args[1]) ||
		!mal_value_is_native_function_object(args[0]) ||
		!mal_value_is_callable(args[3])) {
        return false;
    }
    MalValue loaded_method = args[0];
    MalValue recv = args[1];
    i32 method_id = (i32) mal_ops_number_as_f64(args[2]);
    MalObject *receiver = (MalObject *) mal_value_to_array_object(recv);
    MalValue prototype_value = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    if (!mal_value_is_object(prototype_value) ||
        mal_object_prototype(receiver) != mal_value_to_object(prototype_value)) {
        return false;
    }

    MalNativeFunctionCallback expected = nullptr;
    switch (method_id) {
        case 0: expected = mal_builtin_array_for_each; break;
        case 1: expected = mal_builtin_array_some; break;
        case 2: expected = mal_builtin_array_every; break;
        case 3: expected = mal_builtin_array_find; break;
        case 4: expected = mal_builtin_array_find_index; break;
        case 5: expected = mal_builtin_array_map; break;
        case 6: expected = mal_builtin_array_filter; break;
        case 7: expected = mal_builtin_array_reduce; break;
        case 8: expected = mal_builtin_array_reduce_right; break;
        case 9: expected = mal_builtin_array_find_last; break;
        case 10: expected = mal_builtin_array_find_last_index; break;
        case 11: expected = mal_builtin_array_flat_map; break;
        default: return false;
    }
    bool eligible =
        mal_native_function_object_callback(
            mal_value_to_native_function_object(loaded_method)) == expected;
#if MAL_REALMS
    eligible = eligible && mal_vm_callee_realm(vm, loaded_method) == vm->current_realm;
#endif
    if (eligible && (method_id == 5 || method_id == 6 || method_id == 11)) {
        eligible = mal_array_default_species(vm, recv);
    }
    return eligible;
}

static MalValue mal_builtin_array_iteration_eligible(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_value_new_boolean(
        arg_count >= 4 && mal_builtin_array_iteration_eligible_values(vm, args));
}

/**
 * flatMap append helper for the compiler's guarded inlining (intrinsic slot
 * MAL_INTRINSIC_ARRAY_FLAT_MAP_APPEND, invoked via LOAD_INTRINSIC + call once per
 * source element). args[0] = the result array being built, args[1] = the mapped
 * value. Flattens `mapped` into `result` one level deep (see mal_array_flat_map_append)
 * starting at the result's current length (flatMap never leaves holes, so length is
 * the append cursor). Returns undefined; a property-op throw is left on the vm.
 */
static MalValue mal_builtin_array_flat_map_append_intrinsic(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count < 2 || !mal_value_is_array_object(args[0])) {
        return mal_value_new_undefined();
    }
    u32 count = mal_array_object_length(mal_value_to_array_object(args[0]));
    mal_array_flat_map_append(vm, args[0], &count, args[1]);
    return mal_value_new_undefined();
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

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, constructor_object, "isArray", 1, mal_builtin_array_is_array);
    mal_intrinsic_define_method_n(vm, constructor_object, "of", 0, mal_builtin_array_of);
    mal_intrinsic_define_method_n(vm, constructor_object, "from", 1, mal_builtin_array_from);
    mal_intrinsic_define_method_n(vm, constructor_object, "fromAsync", 1, mal_builtin_array_from_async);

    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_MAP] =
        mal_intrinsic_define_method_n(vm, prototype, "map", 1, mal_builtin_array_map);
    mal_intrinsic_define_method_n(vm, prototype, "forEach", 1, mal_builtin_array_for_each);
    // Internal helper for guarded array-iteration inlining (not attached to any object).
    vm->intrinsics[MAL_INTRINSIC_ARRAY_ITERATION_ELIGIBLE] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "__arrayIterationEligible"),
            2,
            mal_builtin_array_iteration_eligible
        )
    );
    // Internal flatMap append helper for guarded inlining (not attached to any object).
    vm->intrinsics[MAL_INTRINSIC_ARRAY_FLAT_MAP_APPEND] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "__arrayFlatMapAppend"),
            2,
            mal_builtin_array_flat_map_append_intrinsic
        )
    );
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
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_PUSH] =
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
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_VALUES] = values;
    mal_array_values_callback = mal_builtin_array_values;

    // Array.prototype[Symbol.iterator] === Array.prototype.values
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(values, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_desc);

    // Array.prototype[Symbol.unscopables]: a null-prototype object listing the
    // post-ES5 method names (each value `true`) so a sloppy `with (array)` block
    // does not shadow those identifiers via the array. The property itself is
    // { writable: false, enumerable: false, configurable: true }.
    MalObject *unscopables = mal_object_new(&vm->heap, nullptr);
    static const char *const unscopable_names[] = {
        "at", "copyWithin", "entries", "fill", "find", "findIndex", "findLast",
        "findLastIndex", "flat", "flatMap", "includes", "keys", "toReversed",
        "toSorted", "toSpliced", "values",
    };
    for (usize i = 0; i < sizeof(unscopable_names) / sizeof(unscopable_names[0]); i++) {
        MalPropertyDesc name_desc = mal_intrinsic_data_desc(mal_value_new_boolean(true),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(unscopables, mal_intrinsic_string_key(vm, unscopable_names[i]), &name_desc);
    }
    MalPropertyDesc unscopables_desc =
        mal_intrinsic_data_desc(mal_value_from_object(unscopables), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_UNSCOPABLES), &unscopables_desc);

    mal_intrinsic_define_species(vm, constructor_object);
}

#include "generated/known_native_builtin_array_c.inc"
