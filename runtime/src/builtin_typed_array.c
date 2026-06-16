#include "builtin_typed_array.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_bigint.h"
#include "builtin_iterator.h"
#include "heap_bigint.h"
#include "object_ops.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalObject *mal_ta_kind_prototype(MalVm *vm, MalTypedArrayKind kind) {
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind]);
}

// Allocate a fresh same-kind view backed by a new exact-size buffer.
static MalValue mal_ta_create(MalVm *vm, MalTypedArrayKind kind, u32 length) {
    u32 element_size = mal_typed_array_element_size(kind);
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        length * element_size, length * element_size, false, false);
    MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap, mal_ta_kind_prototype(vm, kind), buffer, kind, 0, length, false);
    return mal_value_from_typed_array_object(array);
}

// TypedArraySpeciesCreate(exemplar, «length»): construct via the exemplar's
// constructor's @@species (defaulting to the matching %TypedArray% intrinsic),
// then require the result to be a non-out-of-bounds TypedArray at least `length`
// long. Returns false with a pending throw on any abrupt step (used by the
// methods that build a new same-kind array: slice/map/filter/with/toReversed/
// toSorted).
// SpeciesConstructor(exemplar, defaultCtor): exemplar.constructor, then its
// @@species (defaulting to the matching %TypedArray% intrinsic when either is
// undefined/null; a non-object constructor or non-constructor @@species throws).
static bool mal_ta_species_constructor(MalVm *vm, MalTypedArrayObject *exemplar, MalValue *out) {
    MalValue species = vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + exemplar->kind];

    MalValue constructor;
    if (!mal_vm_get_property(vm, mal_value_from_typed_array_object(exemplar), mal_intrinsic_string_key(vm, "constructor"), &constructor)) {
        return false;
    }
    if (!mal_value_is_undefined(constructor)) {
        if (!mal_value_is_object(constructor)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "constructor is not an object");
            return false;
        }
        MalValue species_value;
        if (!mal_vm_get_property(vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &species_value)) {
            return false;
        }
        if (!mal_value_is_nil(species_value)) {
            if (!mal_vm_is_constructor(vm, species_value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol(Symbol.species) is not a constructor");
                return false;
            }
            species = species_value;
        }
    }
    *out = species;
    return true;
}

// Construct via the species constructor and require the result to be a
// non-out-of-bounds TypedArray (TypedArrayCreate's ValidateTypedArray). When a
// minimum length is given (>= 0; pass -1 to skip, as subarray does), the result
// must be at least that long.
static bool mal_ta_species_construct(MalVm *vm, MalValue species, const MalValue *args, i32 arg_count, i64 min_length, MalValue *out) {
    MalCompletion completion = mal_vm_construct_value(vm, species, args, arg_count);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    if (!mal_value_is_typed_array_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray species constructor did not return a TypedArray");
        return false;
    }
    MalTypedArrayObject *result = mal_value_to_typed_array_object(completion.value);
    if (mal_typed_array_object_is_out_of_bounds(result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray is out of bounds");
        return false;
    }
    if (min_length >= 0 && (i64) mal_typed_array_object_length(result) < min_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Derived TypedArray is too small");
        return false;
    }
    *out = completion.value;
    return true;
}

// TypedArraySpeciesCreate(exemplar, «length»).
static bool mal_ta_species_create(MalVm *vm, MalTypedArrayObject *exemplar, u32 length, MalValue *out) {
    MalValue species;
    if (!mal_ta_species_constructor(vm, exemplar, &species)) {
        return false;
    }
    MalValue length_arg = mal_value_from_f64((f64) length);
    return mal_ta_species_construct(vm, species, &length_arg, 1, (i64) length, out);
}

// RequireInternalSlot([[TypedArrayName]]) only — used by the getters and by
// `subarray`/`set`, which tolerate an out-of-bounds view.
static MalTypedArrayObject *mal_ta_this_raw(MalVm *vm, MalValue this_value) {
    if (!mal_value_is_typed_array_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a TypedArray");
        return nullptr;
    }
    return mal_value_to_typed_array_object(this_value);
}

// ValidateTypedArray: RequireInternalSlot, then throw if the view is out of
// bounds (detached buffer, or a resizable buffer shrunk past its extent). Most
// prototype methods begin with this.
static MalTypedArrayObject *mal_ta_this(MalVm *vm, MalValue this_value) {
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    if (array == nullptr) {
        return nullptr;
    }
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray is out of bounds");
        return nullptr;
    }
    return array;
}

// ToIndex: ToIntegerOrInfinity, then require an integer in [0, 2^53-1] (we cap
// at u32 range for practicality). Runs user coercion (may throw). On a throw
// leaves vm->completion set and returns false.
static bool mal_ta_to_index(MalVm *vm, MalValue value, u32 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    if (isnan(number)) {
        number = 0;
    }
    number = trunc(number);
    if (number < 0 || isinf(number) || number > 4294967295.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid length");
        return false;
    }
    *out = (u32) number;
    return true;
}

// ToIntegerOrInfinity for a TypedArray index argument, running user coercion
// (ToPrimitive → ToNumber, which may throw). On a throw returns false with
// vm->completion set; otherwise writes the truncated integer (NaN → 0).
static bool mal_ta_to_integer(MalVm *vm, MalValue value, f64 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    *out = isnan(number) ? 0 : trunc(number);
    return true;
}

// Resolve a relative index (negative counts from the end) clamped into
// [0, length], running ToIntegerOrInfinity on the argument. On a throw returns
// false with vm->completion set.
static bool mal_ta_relative(MalVm *vm, MalValue value, u32 length, u32 fallback, u32 *out) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    f64 number;
    if (!mal_ta_to_integer(vm, value, &number)) {
        return false;
    }
    if (number < 0) {
        number += length;
        *out = number < 0 ? 0 : (u32) number;
    } else {
        *out = number > length ? length : (u32) number;
    }
    return true;
}

static MalObject *mal_ta_resolve_prototype(MalVm *vm, MalValue new_target, MalTypedArrayKind kind) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    return mal_value_is_object(prototype) ? mal_value_to_object(prototype) : mal_ta_kind_prototype(vm, kind);
}

// Copy `count` elements from src[src_start..] into dst[dst_start..], converting
// through boxed values so cross-kind copies coerce. Returns false on a throw.
static bool mal_ta_copy_elements(MalVm *vm, MalTypedArrayObject *dst, u32 dst_start, MalTypedArrayObject *src, u32 src_start, u32 count) {
    for (u32 i = 0; i < count; i++) {
        MalValue element = mal_typed_array_object_get(vm, src, src_start + i);
        mal_typed_array_object_set(vm, dst, dst_start + i, element);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
    }
    return true;
}

static MalValue mal_typed_array_construct(MalVm *vm, MalTypedArrayKind kind, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor TypedArray requires 'new'");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_ta_resolve_prototype(vm, new_target, kind);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }

    u32 element_size = mal_typed_array_element_size(kind);
    MalValue arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    // new T(arrayBuffer, byteOffset, length): a view over an existing buffer.
    if (mal_value_is_array_buffer_object(arg)) {
        MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(arg);
        u32 byte_offset = 0;
        if (arg_count >= 2 && !mal_ta_to_index(vm, args[1], &byte_offset)) {
            return mal_value_new_undefined();
        }
        if (byte_offset % element_size != 0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "byteOffset must be a multiple of element size");
            return mal_value_new_undefined();
        }
        if (buffer->detached) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot construct over a detached ArrayBuffer");
            return mal_value_new_undefined();
        }

        bool length_tracking = false;
        u32 length = 0;
        if (arg_count < 3 || mal_value_is_undefined(args[2])) {
            if (buffer->resizable) {
                length_tracking = true;
            } else {
                if (byte_offset > buffer->byte_length || (buffer->byte_length - byte_offset) % element_size != 0) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer length minus offset is not a multiple of element size");
                    return mal_value_new_undefined();
                }
                length = (buffer->byte_length - byte_offset) / element_size;
            }
        } else {
            if (!mal_ta_to_index(vm, args[2], &length)) {
                return mal_value_new_undefined();
            }
            if ((u64) byte_offset + (u64) length * element_size > buffer->byte_length) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid typed array length");
                return mal_value_new_undefined();
            }
        }

        MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap, prototype, buffer, kind, byte_offset, length, length_tracking);
        return mal_value_from_typed_array_object(array);
    }

    // new T(typedArray): copy converting elements.
    if (mal_value_is_typed_array_object(arg)) {
        MalTypedArrayObject *source = mal_value_to_typed_array_object(arg);
        if (mal_typed_array_is_bigint(kind) != mal_typed_array_is_bigint(source->kind)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot mix BigInt and non-BigInt typed arrays");
            return mal_value_new_undefined();
        }
        u32 length = mal_typed_array_object_length(source);
        MalValue result = mal_ta_create(vm, kind, length);
        MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
        mal_object_set_prototype(&array->object, prototype);
        if (!mal_ta_copy_elements(vm, array, 0, source, 0, length)) {
            return mal_value_new_undefined();
        }
        return result;
    }

    // new T(object): an iterable or array-like.
    if (mal_value_is_object(arg)) {
        MalValue iterator_method;
        if (!mal_vm_get_property(vm, arg, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_method)) {
            return mal_value_new_undefined();
        }

        // GetMethod(@@iterator): a present-but-non-callable value is a TypeError.
        if (!mal_value_is_nil(iterator_method) && !mal_value_is_callable(iterator_method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.iterator is not a function");
            return mal_value_new_undefined();
        }

        if (mal_value_is_callable(iterator_method)) {
            // Collect the iterated values, then build a view of that length.
            MalValue *values = nullptr;
            usize count = 0;
            usize capacity = 0;
            MalIteratorRecord record;
            if (!mal_vm_get_iterator(vm, arg, &record)) {
                return mal_value_new_undefined();
            }
            while (true) {
                MalValue item;
                bool done;
                if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
                    free(values);
                    return mal_value_new_undefined();
                }
                if (done) {
                    break;
                }
                if (count == capacity) {
                    capacity = capacity == 0 ? 8 : capacity * 2;
                    values = realloc(values, sizeof(MalValue) * capacity);
                }
                values[count++] = item;
            }

            MalValue result = mal_ta_create(vm, kind, (u32) count);
            MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
            mal_object_set_prototype(&array->object, prototype);
            for (usize i = 0; i < count; i++) {
                mal_typed_array_object_set(vm, array, (u32) i, values[i]);
                if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
                    free(values);
                    return mal_value_new_undefined();
                }
            }
            free(values);
            return result;
        }

        // Array-like: ? ToLength(? Get(arrayLike, "length")) then read indices.
        MalValue length_value;
        if (!mal_vm_get_property(vm, arg, mal_intrinsic_string_key(vm, "length"), &length_value)) {
            return mal_value_new_undefined();
        }
        f64 length_number;
        if (!mal_vm_to_number(vm, length_value, &length_number)) {
            return mal_value_new_undefined();
        }
        length_number = isnan(length_number) ? 0 : trunc(length_number);
        if (length_number < 0) {
            length_number = 0;
        }
        // AllocateTypedArrayBuffer rejects a length that overflows a valid
        // buffer with a RangeError (e.g. 2^53).
        if (length_number > 4294967295.0 || (u64) length_number * element_size > 4294967295u) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid typed array length");
            return mal_value_new_undefined();
        }
        u32 length = (u32) length_number;

        MalValue result = mal_ta_create(vm, kind, length);
        MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
        mal_object_set_prototype(&array->object, prototype);
        for (u32 i = 0; i < length; i++) {
            MalValue element;
            if (!mal_vm_get_property(vm, arg, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &element)) {
                return mal_value_new_undefined();
            }
            mal_typed_array_object_set(vm, array, i, element);
            if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
                return mal_value_new_undefined();
            }
        }
        return result;
    }

    // new T(length)
    u32 length = 0;
    if (!mal_value_is_undefined(arg)) {
        if (!mal_ta_to_index(vm, arg, &length)) {
            return mal_value_new_undefined();
        }
    }
    MalValue result = mal_ta_create(vm, kind, length);
    mal_object_set_prototype(&mal_value_to_typed_array_object(result)->object, prototype);
    return result;
}

static MalValue mal_builtin_typed_array_abstract_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Abstract class TypedArray not directly constructable");
    return mal_value_new_undefined();
}

#define MAL_TA_CONSTRUCTOR(fn_name, kind_value) \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) this_value; \
        return mal_typed_array_construct(vm, kind_value, args, arg_count, new_target, callee); \
    }

MAL_TA_CONSTRUCTOR(mal_ta_ctor_int8, MAL_TA_INT8)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_uint8, MAL_TA_UINT8)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_uint8_clamped, MAL_TA_UINT8_CLAMPED)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_int16, MAL_TA_INT16)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_uint16, MAL_TA_UINT16)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_int32, MAL_TA_INT32)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_uint32, MAL_TA_UINT32)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_float32, MAL_TA_FLOAT32)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_float64, MAL_TA_FLOAT64)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_bigint64, MAL_TA_BIGINT64)
MAL_TA_CONSTRUCTOR(mal_ta_ctor_biguint64, MAL_TA_BIGUINT64)

static MalNativeFunctionCallback mal_ta_constructor_callbacks[MAL_TA_KIND_COUNT] = {
    [MAL_TA_INT8] = mal_ta_ctor_int8,
    [MAL_TA_UINT8] = mal_ta_ctor_uint8,
    [MAL_TA_UINT8_CLAMPED] = mal_ta_ctor_uint8_clamped,
    [MAL_TA_INT16] = mal_ta_ctor_int16,
    [MAL_TA_UINT16] = mal_ta_ctor_uint16,
    [MAL_TA_INT32] = mal_ta_ctor_int32,
    [MAL_TA_UINT32] = mal_ta_ctor_uint32,
    [MAL_TA_FLOAT32] = mal_ta_ctor_float32,
    [MAL_TA_FLOAT64] = mal_ta_ctor_float64,
    [MAL_TA_BIGINT64] = mal_ta_ctor_bigint64,
    [MAL_TA_BIGUINT64] = mal_ta_ctor_biguint64,
};

// ---- getters -------------------------------------------------------------

static MalValue mal_ta_get_length(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    return array == nullptr ? mal_value_new_undefined() : mal_value_from_i32((i32) mal_typed_array_object_length(array));
}

static MalValue mal_ta_get_byte_length(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    return array == nullptr ? mal_value_new_undefined() : mal_value_from_i32((i32) mal_typed_array_object_byte_length(array));
}

static MalValue mal_ta_get_byte_offset(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    // An out-of-bounds view reports a 0 offset.
    u32 offset = mal_typed_array_object_length(array) == 0 && array->buffer->detached ? 0 : array->byte_offset;
    return mal_value_from_i32((i32) offset);
}

static MalValue mal_ta_get_buffer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    return array == nullptr ? mal_value_new_undefined() : mal_value_from_array_buffer_object(array->buffer);
}

static MalValue mal_ta_get_to_string_tag(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    if (!mal_value_is_typed_array_object(this_value)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_intrinsic_ascii(vm, mal_typed_array_name(mal_value_to_typed_array_object(this_value)->kind)));
}

// ---- prototype methods ---------------------------------------------------

static MalValue mal_ta_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    f64 relative;
    if (!mal_ta_to_integer(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &relative)) {
        return mal_value_new_undefined();
    }
    i64 index = relative < 0 ? (i64) length + (i64) relative : (i64) relative;
    if (index < 0 || (u64) index >= length) {
        return mal_value_new_undefined();
    }
    return mal_typed_array_object_get(vm, array, (u32) index);
}

static MalValue mal_ta_fill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    // The fill value is coerced (ToNumber / ToBigInt, may throw) exactly once,
    // before the start/end indices, matching the spec ordering. The coerced
    // primitive (not the original) is what gets written, so the per-element
    // mal_typed_array_object_set never re-runs user coercion.
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
        value = mal_value_from_bigint(mal_bigint_new(&vm->heap, big));
    } else {
        f64 number;
        if (!mal_vm_to_number(vm, value, &number)) {
            return mal_value_new_undefined();
        }
        value = mal_ops_number_value(number);
    }

    u32 start;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_ta_relative(vm, arg_count >= 3 ? args[2] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    // The view length is re-read after coercion (a resizable buffer may have
    // shrunk); clamp start/end so we never write past the current extent.
    u32 current = mal_typed_array_object_length(array);
    if (start > current) {
        start = current;
    }
    if (end > current) {
        end = current;
    }
    for (u32 i = start; i < end; i++) {
        mal_typed_array_object_set(vm, array, i, value);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            return mal_value_new_undefined();
        }
    }
    return this_value;
}

static MalValue mal_ta_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    // ToIntegerOrInfinity(offset), then a negative offset is a RangeError.
    f64 offset_number;
    if (!mal_ta_to_integer(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &offset_number)) {
        return mal_value_new_undefined();
    }
    if (offset_number < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Start offset is negative");
        return mal_value_new_undefined();
    }
    u32 offset = offset_number > 4294967295.0 ? UINT32_MAX : (u32) offset_number;
    u32 length = mal_typed_array_object_length(array);

    if (mal_value_is_typed_array_object(source)) {
        MalTypedArrayObject *src = mal_value_to_typed_array_object(source);
        // A BigInt/non-BigInt mismatch is a TypeError (cannot coerce across).
        if (mal_typed_array_is_bigint(array->kind) != mal_typed_array_is_bigint(src->kind)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot mix BigInt and non-BigInt typed arrays");
            return mal_value_new_undefined();
        }
        u32 src_length = mal_typed_array_object_length(src);
        if ((u64) offset + src_length > length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Source is too large");
            return mal_value_new_undefined();
        }
        mal_ta_copy_elements(vm, array, offset, src, 0, src_length);
        return mal_value_new_undefined();
    }

    // Array-like source: ToObject then ? ToLength(? Get(src, "length")).
    MalValue length_value;
    if (!mal_vm_get_property(vm, source, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return mal_value_new_undefined();
    }
    f64 src_length_number;
    if (!mal_vm_to_number(vm, length_value, &src_length_number)) {
        return mal_value_new_undefined();
    }
    src_length_number = isnan(src_length_number) ? 0 : trunc(src_length_number);
    u32 src_length = (src_length_number > 0)
        ? (src_length_number > 4294967295.0 ? UINT32_MAX : (u32) src_length_number)
        : 0;
    if ((u64) offset + src_length > length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Source is too large");
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < src_length; i++) {
        MalValue element;
        if (!mal_vm_get_property(vm, source, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &element)) {
            return mal_value_new_undefined();
        }
        mal_typed_array_object_set(vm, array, offset + i, element);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            return mal_value_new_undefined();
        }
    }
    return mal_value_new_undefined();
}

static MalValue mal_ta_subarray(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 start;
    if (!mal_ta_relative(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    u32 element_size = mal_typed_array_element_size(array->kind);
    // A length-tracking view re-derives its length from the buffer, so subarray
    // over one without an explicit end passes undefined (no count) to species.
    bool length_tracking_to_end = array->length_tracking && (arg_count < 2 || mal_value_is_undefined(args[1]));
    u32 new_length = end > start ? end - start : 0;

    // subarray builds a new view over the SAME buffer via TypedArraySpeciesCreate
    // with «buffer, beginByteOffset[, newLength]».
    MalValue species;
    if (!mal_ta_species_constructor(vm, array, &species)) {
        return mal_value_new_undefined();
    }
    MalValue ctor_args[3] = {
        mal_value_from_array_buffer_object(array->buffer),
        mal_value_from_f64((f64) (array->byte_offset + start * element_size)),
        mal_value_from_f64((f64) new_length),
    };
    MalValue result;
    if (!mal_ta_species_construct(vm, species, ctor_args, length_tracking_to_end ? 2 : 3, -1, &result)) {
        return mal_value_new_undefined();
    }
    return result;
}

static MalValue mal_ta_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 start;
    if (!mal_ta_relative(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    u32 new_length = end > start ? end - start : 0;

    MalValue result;
    if (!mal_ta_species_create(vm, array, new_length, &result)) {
        return mal_value_new_undefined();
    }
    mal_ta_copy_elements(vm, mal_value_to_typed_array_object(result), 0, array, start, new_length);
    return result;
}

static MalValue mal_ta_copy_within(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 target;
    if (!mal_ta_relative(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &target)) {
        return mal_value_new_undefined();
    }
    u32 start;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_ta_relative(vm, arg_count >= 3 ? args[2] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    // Re-read the current length after coercion; clamp indices to the live
    // extent so a buffer that shrank during ToInteger can't drive an OOB move.
    u32 current = mal_typed_array_object_length(array);
    if (target > current) {
        target = current;
    }
    if (start > current) {
        start = current;
    }
    if (end > current) {
        end = current;
    }
    u32 count = end > start ? end - start : 0;
    if (count > current - target) {
        count = current - target;
    }
    u32 element_size = mal_typed_array_element_size(array->kind);
    // memmove handles overlap; the element bits move verbatim.
    memmove(array->buffer->data + array->byte_offset + (usize) target * element_size,
        array->buffer->data + array->byte_offset + (usize) start * element_size,
        (usize) count * element_size);
    return this_value;
}

// ToString that runs user coercion: for an object, ToPrimitive(string) via
// @@toPrimitive else toString → valueOf, then ToString of the primitive.
// Throws (vm->completion) and returns nullptr on an abrupt completion.
static MalString *mal_ta_to_string_value(MalVm *vm, MalValue value) {
    if (mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
        return nullptr;
    }
    if (mal_value_is_object(value)) {
        MalValue exotic;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
            return nullptr;
        }
        if (!mal_value_is_nil(exotic)) {
            if (!mal_value_is_callable(exotic)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
                return nullptr;
            }
            MalValue hint = mal_value_from_string(mal_intrinsic_ascii(vm, "string"));
            MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint, 1);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return nullptr;
            }
            if (mal_value_is_object(result.value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return nullptr;
            }
            value = result.value;
        } else {
            // OrdinaryToPrimitive with hint string: toString → valueOf.
            const byte *methods[2] = {"toString", "valueOf"};
            bool converted = false;
            for (i32 i = 0; i < 2 && !converted; i++) {
                MalValue method;
                if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
                    return nullptr;
                }
                if (mal_value_is_callable(method)) {
                    MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
                    if (result.kind != MAL_COMPLETION_NORMAL) {
                        return nullptr;
                    }
                    if (!mal_value_is_object(result.value)) {
                        value = result.value;
                        converted = true;
                    }
                }
            }
            if (!converted) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return nullptr;
            }
        }
        if (mal_value_is_symbol(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
            return nullptr;
        }
    }
    return mal_ops_to_string(&vm->heap, value);
}

static MalValue mal_ta_join(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalString *separator;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        separator = mal_ta_to_string_value(vm, args[0]);
        if (separator == nullptr) {
            return mal_value_new_undefined();
        }
    } else {
        separator = mal_intrinsic_ascii(vm, ",");
    }

    MalValue result = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    for (u32 i = 0; i < length; i++) {
        if (i > 0) {
            result = mal_ops_add(&vm->heap, result, mal_value_from_string(separator));
        }
        MalValue element = mal_typed_array_object_get(vm, array, i);
        result = mal_ops_add(&vm->heap, result, mal_value_from_string(mal_ops_to_string(&vm->heap, element)));
    }
    return result;
}

static MalValue mal_ta_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_ta_join(vm, this_value, args, arg_count, new_target, callee);
}

// %TypedArray%.prototype.toLocaleString: each element formats through
// ? ToString(? Invoke(element, "toLocaleString")), joined with ",".
static MalValue mal_ta_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalKey to_locale_key = mal_intrinsic_string_key(vm, "toLocaleString");
    MalString *separator = mal_intrinsic_ascii(vm, ",");

    MalValue result = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    for (u32 i = 0; i < length; i++) {
        if (i > 0) {
            result = mal_ops_add(&vm->heap, result, mal_value_from_string(separator));
        }
        MalValue element = mal_typed_array_object_get(vm, array, i);
        MalValue method;
        if (!mal_vm_get_property(vm, element, to_locale_key, &method)) {
            return mal_value_new_undefined();
        }
        MalCompletion completion = mal_vm_call_value(vm, method, element, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return mal_value_new_undefined();
        }
        MalString *part;
        if (!mal_vm_to_string(vm, completion.value, &part)) {
            return mal_value_new_undefined();
        }
        result = mal_ops_add(&vm->heap, result, mal_value_from_string(part));
    }
    return result;
}

static MalValue mal_ta_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (length == 0) {
        return mal_value_from_i32(-1);
    }
    u32 from;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, 0, &from)) {
        return mal_value_new_undefined();
    }
    // indexOf consults HasProperty: an index past the current (possibly shrunk
    // or detached) extent is "not present" and never matches. Clamp the bound.
    u32 current = mal_typed_array_object_length(array);
    for (u32 i = from; i < length && i < current; i++) {
        if (mal_value_is_truthy(mal_ops_strict_equal(mal_typed_array_object_get(vm, array, i), target))) {
            return mal_value_from_i32((i32) i);
        }
    }
    return mal_value_from_i32(-1);
}

static MalValue mal_ta_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (length == 0) {
        return mal_value_from_i32(-1);
    }
    // fromIndex defaults to length-1; a negative value counts from the end.
    i64 from = (i64) length - 1;
    if (arg_count >= 2) {
        f64 number;
        if (!mal_ta_to_integer(vm, args[1], &number)) {
            return mal_value_new_undefined();
        }
        if (isinf(number) && number > 0) {
            from = (i64) length - 1;
        } else if (number < 0) {
            f64 adjusted = (f64) length + number;
            if (adjusted < 0) {
                return mal_value_from_i32(-1);
            }
            from = (i64) adjusted;
        } else {
            from = number > (f64) (length - 1) ? (i64) length - 1 : (i64) number;
        }
    }
    // lastIndexOf consults HasProperty: indices past the current (possibly
    // shrunk or detached) extent are "not present" and never match.
    u32 current = mal_typed_array_object_length(array);
    if (current == 0) {
        return mal_value_from_i32(-1);
    }
    if (from > (i64) current - 1) {
        from = (i64) current - 1;
    }
    for (i64 i = from; i >= 0; i--) {
        if (mal_value_is_truthy(mal_ops_strict_equal(mal_typed_array_object_get(vm, array, (u32) i), target))) {
            return mal_value_from_i32((i32) i);
        }
    }
    return mal_value_from_i32(-1);
}

static MalValue mal_ta_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue target = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (length == 0) {
        return mal_value_new_boolean(false);
    }
    u32 from;
    if (!mal_ta_relative(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, 0, &from)) {
        return mal_value_new_undefined();
    }
    bool target_nan = mal_value_is_nan(target);
    for (u32 i = from; i < length; i++) {
        MalValue element = mal_typed_array_object_get(vm, array, i);
        // includes uses SameValueZero, so NaN matches NaN.
        if (mal_value_is_truthy(mal_ops_strict_equal(element, target)) || (target_nan && mal_value_is_nan(element))) {
            return mal_value_new_boolean(true);
        }
    }
    return mal_value_new_boolean(false);
}

static MalValue mal_ta_reverse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    for (u32 i = 0; i < length / 2; i++) {
        MalValue a = mal_typed_array_object_get(vm, array, i);
        MalValue b = mal_typed_array_object_get(vm, array, length - 1 - i);
        mal_typed_array_object_set(vm, array, i, b);
        mal_typed_array_object_set(vm, array, length - 1 - i, a);
    }
    return this_value;
}

// Iteration helpers: forEach/map/filter/reduce/find/some/every share the
// element walk. callback signature is (value, index, array).
typedef enum MalTaIterOp {
    MAL_TA_FOR_EACH,
    MAL_TA_MAP,
    MAL_TA_FILTER,
    MAL_TA_FIND,
    MAL_TA_FIND_INDEX,
    MAL_TA_FIND_LAST,
    MAL_TA_FIND_LAST_INDEX,
    MAL_TA_SOME,
    MAL_TA_EVERY,
} MalTaIterOp;

static MalValue mal_ta_iterate(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalTaIterOp op) {
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }
    MalValue this_arg = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);

    MalValue mapped = mal_value_new_undefined();
    MalTypedArrayObject *map_result = nullptr;
    if (op == MAL_TA_MAP) {
        // TypedArraySpeciesCreate(O, «len») runs before the callbacks.
        if (!mal_ta_species_create(vm, array, length, &mapped)) {
            return mal_value_new_undefined();
        }
        map_result = mal_value_to_typed_array_object(mapped);
    }
    // filter collects matching elements first, then builds the result.
    MalValue *kept = nullptr;
    usize kept_count = 0;
    if (op == MAL_TA_FILTER) {
        kept = malloc(sizeof(MalValue) * (length == 0 ? 1 : length));
    }

    bool last = op == MAL_TA_FIND_LAST || op == MAL_TA_FIND_LAST_INDEX;
    for (u32 step = 0; step < length; step++) {
        u32 i = last ? length - 1 - step : step;
        MalValue element = mal_typed_array_object_get(vm, array, i);
        MalValue call_args[3] = {element, mal_value_from_i32((i32) i), this_value};
        MalCompletion completion = mal_vm_call_value(vm, callback, this_arg, call_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            free(kept);
            return mal_value_new_undefined();
        }
        bool truthy = mal_value_is_truthy(completion.value);

        switch (op) {
            case MAL_TA_MAP:
                mal_typed_array_object_set(vm, map_result, i, completion.value);
                break;
            case MAL_TA_FILTER:
                if (truthy) {
                    kept[kept_count++] = element;
                }
                break;
            case MAL_TA_FIND:
                if (truthy) {
                    return element;
                }
                break;
            case MAL_TA_FIND_LAST:
                if (truthy) {
                    return element;
                }
                break;
            case MAL_TA_FIND_INDEX:
            case MAL_TA_FIND_LAST_INDEX:
                if (truthy) {
                    return mal_value_from_i32((i32) i);
                }
                break;
            case MAL_TA_SOME:
                if (truthy) {
                    return mal_value_new_boolean(true);
                }
                break;
            case MAL_TA_EVERY:
                if (!truthy) {
                    return mal_value_new_boolean(false);
                }
                break;
            case MAL_TA_FOR_EACH:
                break;
        }
    }

    switch (op) {
        case MAL_TA_MAP:
            return mapped;
        case MAL_TA_FILTER: {
            MalValue result;
            if (!mal_ta_species_create(vm, array, (u32) kept_count, &result)) {
                free(kept);
                return mal_value_new_undefined();
            }
            MalTypedArrayObject *out = mal_value_to_typed_array_object(result);
            for (usize i = 0; i < kept_count; i++) {
                mal_typed_array_object_set(vm, out, (u32) i, kept[i]);
            }
            free(kept);
            return result;
        }
        case MAL_TA_FIND:
        case MAL_TA_FIND_LAST:
            return mal_value_new_undefined();
        case MAL_TA_FIND_INDEX:
        case MAL_TA_FIND_LAST_INDEX:
            return mal_value_from_i32(-1);
        case MAL_TA_SOME:
            return mal_value_new_boolean(false);
        case MAL_TA_EVERY:
            return mal_value_new_boolean(true);
        case MAL_TA_FOR_EACH:
            return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

#define MAL_TA_ITER_METHOD(fn_name, op_value) \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) new_target; \
        return mal_ta_iterate(vm, this_value, args, arg_count, op_value); \
    }

MAL_TA_ITER_METHOD(mal_ta_for_each, MAL_TA_FOR_EACH)
MAL_TA_ITER_METHOD(mal_ta_map, MAL_TA_MAP)
MAL_TA_ITER_METHOD(mal_ta_filter, MAL_TA_FILTER)
MAL_TA_ITER_METHOD(mal_ta_find, MAL_TA_FIND)
MAL_TA_ITER_METHOD(mal_ta_find_index, MAL_TA_FIND_INDEX)
MAL_TA_ITER_METHOD(mal_ta_find_last, MAL_TA_FIND_LAST)
MAL_TA_ITER_METHOD(mal_ta_find_last_index, MAL_TA_FIND_LAST_INDEX)
MAL_TA_ITER_METHOD(mal_ta_some, MAL_TA_SOME)
MAL_TA_ITER_METHOD(mal_ta_every, MAL_TA_EVERY)

static MalValue mal_ta_reduce_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool from_right) {
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    bool has_accumulator = arg_count >= 2;
    MalValue accumulator = has_accumulator ? args[1] : mal_value_new_undefined();

    for (u32 step = 0; step < length; step++) {
        u32 i = from_right ? length - 1 - step : step;
        MalValue element = mal_typed_array_object_get(vm, array, i);
        if (!has_accumulator) {
            accumulator = element;
            has_accumulator = true;
            continue;
        }
        MalValue call_args[4] = {accumulator, element, mal_value_from_i32((i32) i), this_value};
        MalCompletion completion = mal_vm_call_value(vm, callback, mal_value_new_undefined(), call_args, 4);
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

static MalValue mal_ta_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mal_ta_reduce_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_ta_reduce_right(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mal_ta_reduce_impl(vm, this_value, args, arg_count, true);
}

// Default TypedArray sort order: numeric ascending (NaN last, -0 before +0).
static i32 mal_ta_default_compare(MalValue a, MalValue b) {
    if (mal_value_is_bigint(a) && mal_value_is_bigint(b)) {
        i128 x = mal_bigint_value(mal_value_to_bigint(a));
        i128 y = mal_bigint_value(mal_value_to_bigint(b));
        return x < y ? -1 : x > y ? 1 : 0;
    }
    f64 x = mal_ops_to_number(a);
    f64 y = mal_ops_to_number(b);
    if (isnan(x)) {
        return isnan(y) ? 0 : 1;
    }
    if (isnan(y)) {
        return -1;
    }
    if (x < y) {
        return -1;
    }
    if (x > y) {
        return 1;
    }
    return 0;
}

static MalValue mal_ta_sort(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue compare = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_undefined(compare) && !mal_value_is_callable(compare)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Comparator is not a function");
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    if (length < 2) {
        return this_value;
    }

    MalValue *values = malloc(sizeof(MalValue) * length);
    for (u32 i = 0; i < length; i++) {
        values[i] = mal_typed_array_object_get(vm, array, i);
    }

    // Insertion sort keeps it stable and lets the comparator call into the VM.
    for (u32 i = 1; i < length; i++) {
        MalValue current = values[i];
        i64 j = (i64) i - 1;
        while (j >= 0) {
            i32 order;
            if (mal_value_is_callable(compare)) {
                MalValue call_args[2] = {values[j], current};
                MalCompletion completion = mal_vm_call_value(vm, compare, mal_value_new_undefined(), call_args, 2);
                if (completion.kind != MAL_COMPLETION_NORMAL) {
                    vm->completion = completion;
                    free(values);
                    return mal_value_new_undefined();
                }
                f64 result = mal_ops_to_number(completion.value);
                order = isnan(result) ? 0 : (result < 0 ? -1 : result > 0 ? 1 : 0);
            } else {
                order = mal_ta_default_compare(values[j], current);
            }
            if (order <= 0) {
                break;
            }
            values[j + 1] = values[j];
            j--;
        }
        values[j + 1] = current;
    }

    for (u32 i = 0; i < length; i++) {
        mal_typed_array_object_set(vm, array, i, values[i]);
    }
    free(values);
    return this_value;
}

static MalValue mal_ta_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    if (mal_ta_this(vm, this_value) == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_ARRAY_KEYS, this_value);
}

static MalValue mal_ta_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    if (mal_ta_this(vm, this_value) == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_ARRAY_VALUES, this_value);
}

static MalValue mal_ta_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    if (mal_ta_this(vm, this_value) == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_ARRAY_ENTRIES, this_value);
}

// ---- statics -------------------------------------------------------------

// TypedArrayCreate(constructor, «length»): Construct(constructor, [length]) and
// require the result to be a TypedArray with at least `length` elements. The
// receiver `this_value` is the (possibly user-supplied) constructor, so of/from
// are generic over any constructor, not just the built-in kinds. Returns false
// (vm->completion set) on a throw.
static bool mal_ta_create_from_constructor(MalVm *vm, MalValue constructor, u32 length, MalValue *out) {
    if (!mal_value_is_callable(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor is not a function");
        return false;
    }
    MalValue arg = mal_value_from_i32((i32) length);
    MalCompletion completion = mal_vm_construct_value(vm, constructor, &arg, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }
    if (!mal_value_is_typed_array_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor did not produce a TypedArray");
        return false;
    }
    if (mal_typed_array_object_length(mal_value_to_typed_array_object(completion.value)) < length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Derived TypedArray is too small");
        return false;
    }
    *out = completion.value;
    return true;
}

static MalValue mal_ta_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    u32 length = (u32) (arg_count < 0 ? 0 : arg_count);
    MalValue result;
    if (!mal_ta_create_from_constructor(vm, this_value, length, &result)) {
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
    for (i32 i = 0; i < arg_count; i++) {
        mal_typed_array_object_set(vm, array, (u32) i, args[i]);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            return mal_value_new_undefined();
        }
    }
    return result;
}

static MalValue mal_ta_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    // from is generic: C is the receiver constructor (must be a constructor).
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray.from requires a constructor receiver");
        return mal_value_new_undefined();
    }
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue map_fn = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_undefined(map_fn) && !mal_value_is_callable(map_fn)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "mapfn is not a function");
        return mal_value_new_undefined();
    }
    MalValue this_arg = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    // Collect source elements (iterable preferred, array-like fallback).
    MalValue *values = nullptr;
    usize count = 0;
    usize capacity = 0;
    MalValue iterator_method;
    if (!mal_vm_get_property(vm, source, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_method)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_nil(iterator_method) && !mal_value_is_callable(iterator_method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.iterator is not a function");
        return mal_value_new_undefined();
    }
    if (mal_value_is_callable(iterator_method)) {
        MalIteratorRecord record;
        if (!mal_vm_get_iterator(vm, source, &record)) {
            return mal_value_new_undefined();
        }
        while (true) {
            MalValue item;
            bool done;
            if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
                free(values);
                return mal_value_new_undefined();
            }
            if (done) {
                break;
            }
            if (count == capacity) {
                capacity = capacity == 0 ? 8 : capacity * 2;
                values = realloc(values, sizeof(MalValue) * capacity);
            }
            values[count++] = item;
        }
    } else {
        MalValue length_value;
        if (!mal_vm_get_property(vm, source, mal_intrinsic_string_key(vm, "length"), &length_value)) {
            return mal_value_new_undefined();
        }
        f64 length_number;
        if (!mal_vm_to_number(vm, length_value, &length_number)) {
            return mal_value_new_undefined();
        }
        length_number = isnan(length_number) ? 0 : trunc(length_number);
        u32 length = (length_number > 0)
            ? (length_number > 4294967295.0 ? UINT32_MAX : (u32) length_number)
            : 0;
        values = length > 0 ? malloc(sizeof(MalValue) * length) : nullptr;
        for (u32 i = 0; i < length; i++) {
            if (!mal_vm_get_property(vm, source, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &values[i])) {
                free(values);
                return mal_value_new_undefined();
            }
        }
        count = length;
    }

    MalValue result;
    if (!mal_ta_create_from_constructor(vm, this_value, (u32) count, &result)) {
        free(values);
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
    for (usize i = 0; i < count; i++) {
        MalValue element = values[i];
        if (mal_value_is_callable(map_fn)) {
            MalValue call_args[2] = {element, mal_value_from_i32((i32) i)};
            MalCompletion completion = mal_vm_call_value(vm, map_fn, this_arg, call_args, 2);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = completion;
                free(values);
                return mal_value_new_undefined();
            }
            element = completion.value;
        }
        mal_typed_array_object_set(vm, array, (u32) i, element);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            free(values);
            return mal_value_new_undefined();
        }
    }
    free(values);
    return result;
}

// ---- install -------------------------------------------------------------

static void mal_ta_define_getter(MalVm *vm, MalObject *object, MalKey key, const byte *name, MalNativeFunctionCallback getter) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]), mal_intrinsic_ascii(vm, name), getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(object, key, &desc);
}

static MalValue mal_ta_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return this_value;
}

void mal_builtin_typed_array_install(MalVm *vm) {
    MalObject *object_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // %TypedArray% and %TypedArray%.prototype.
    MalObject *ta_prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *ta_constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "TypedArray"), 0, mal_builtin_typed_array_abstract_constructor);
    vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_CONSTRUCTOR] = mal_value_from_native_function_object(ta_constructor);
    vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_PROTOTYPE] = mal_value_from_object(ta_prototype);

    mal_intrinsic_define_data(vm, (MalObject *) ta_constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, ta_prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // Shared accessors and methods live on %TypedArray%.prototype.
    mal_ta_define_getter(vm, ta_prototype, mal_intrinsic_string_key(vm, "length"), "get length", mal_ta_get_length);
    mal_ta_define_getter(vm, ta_prototype, mal_intrinsic_string_key(vm, "byteLength"), "get byteLength", mal_ta_get_byte_length);
    mal_ta_define_getter(vm, ta_prototype, mal_intrinsic_string_key(vm, "byteOffset"), "get byteOffset", mal_ta_get_byte_offset);
    mal_ta_define_getter(vm, ta_prototype, mal_intrinsic_string_key(vm, "buffer"), "get buffer", mal_ta_get_buffer);
    mal_ta_define_getter(vm, ta_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), "get [Symbol.toStringTag]", mal_ta_get_to_string_tag);

    mal_intrinsic_define_method_n(vm, ta_prototype, "at", 1, mal_ta_at);
    mal_intrinsic_define_method_n(vm, ta_prototype, "fill", 1, mal_ta_fill);
    mal_intrinsic_define_method_n(vm, ta_prototype, "set", 1, mal_ta_set);
    mal_intrinsic_define_method_n(vm, ta_prototype, "subarray", 2, mal_ta_subarray);
    mal_intrinsic_define_method_n(vm, ta_prototype, "slice", 2, mal_ta_slice);
    mal_intrinsic_define_method_n(vm, ta_prototype, "copyWithin", 2, mal_ta_copy_within);
    mal_intrinsic_define_method_n(vm, ta_prototype, "join", 1, mal_ta_join);
    mal_intrinsic_define_method_n(vm, ta_prototype, "toString", 0, mal_ta_to_string);
    mal_intrinsic_define_method_n(vm, ta_prototype, "toLocaleString", 0, mal_ta_to_locale_string);
    mal_intrinsic_define_method_n(vm, ta_prototype, "indexOf", 1, mal_ta_index_of);
    mal_intrinsic_define_method_n(vm, ta_prototype, "lastIndexOf", 1, mal_ta_last_index_of);
    mal_intrinsic_define_method_n(vm, ta_prototype, "includes", 1, mal_ta_includes);
    mal_intrinsic_define_method_n(vm, ta_prototype, "reverse", 0, mal_ta_reverse);
    mal_intrinsic_define_method_n(vm, ta_prototype, "sort", 1, mal_ta_sort);
    mal_intrinsic_define_method_n(vm, ta_prototype, "forEach", 1, mal_ta_for_each);
    mal_intrinsic_define_method_n(vm, ta_prototype, "map", 1, mal_ta_map);
    mal_intrinsic_define_method_n(vm, ta_prototype, "filter", 1, mal_ta_filter);
    mal_intrinsic_define_method_n(vm, ta_prototype, "find", 1, mal_ta_find);
    mal_intrinsic_define_method_n(vm, ta_prototype, "findIndex", 1, mal_ta_find_index);
    mal_intrinsic_define_method_n(vm, ta_prototype, "findLast", 1, mal_ta_find_last);
    mal_intrinsic_define_method_n(vm, ta_prototype, "findLastIndex", 1, mal_ta_find_last_index);
    mal_intrinsic_define_method_n(vm, ta_prototype, "some", 1, mal_ta_some);
    mal_intrinsic_define_method_n(vm, ta_prototype, "every", 1, mal_ta_every);
    mal_intrinsic_define_method_n(vm, ta_prototype, "reduce", 1, mal_ta_reduce);
    mal_intrinsic_define_method_n(vm, ta_prototype, "reduceRight", 1, mal_ta_reduce_right);
    mal_intrinsic_define_method_n(vm, ta_prototype, "keys", 0, mal_ta_keys);
    mal_intrinsic_define_method_n(vm, ta_prototype, "entries", 0, mal_ta_entries);

    MalValue values_method = mal_intrinsic_define_method_n(vm, ta_prototype, "values", 0, mal_ta_values);
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(values_method, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(ta_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_desc);

    mal_intrinsic_define_method_n(vm, (MalObject *) ta_constructor, "from", 1, mal_ta_from);
    mal_intrinsic_define_method_n(vm, (MalObject *) ta_constructor, "of", 0, mal_ta_of);
    MalPropertyDesc species_desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "get [Symbol.species]"), mal_ta_species_getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own((MalObject *) ta_constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &species_desc);

    // The eleven concrete TypedArray constructors / prototypes.
    for (i32 k = 0; k < MAL_TA_KIND_COUNT; k++) {
        MalTypedArrayKind kind = (MalTypedArrayKind) k;
        const byte *name = mal_typed_array_name(kind);

        MalObject *prototype = mal_object_new(&vm->heap, ta_prototype);
        MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
            &vm->heap, (MalObject *) ta_constructor, mal_intrinsic_ascii(vm, name), 3, mal_ta_constructor_callbacks[kind]);

        vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + kind] = mal_value_from_native_function_object(constructor);
        vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind] = mal_value_from_object(prototype);

        mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", mal_value_from_object(prototype), MAL_PROPERTY_NONE);
        mal_intrinsic_define_data(vm, prototype, "constructor", mal_value_from_native_function_object(constructor), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

        // BYTES_PER_ELEMENT on both the constructor and the prototype.
        MalValue bytes = mal_value_from_i32((i32) mal_typed_array_element_size(kind));
        mal_intrinsic_define_data(vm, (MalObject *) constructor, "BYTES_PER_ELEMENT", bytes, MAL_PROPERTY_NONE);
        mal_intrinsic_define_data(vm, prototype, "BYTES_PER_ELEMENT", bytes, MAL_PROPERTY_NONE);

        // Each concrete constructor inherits from %TypedArray%.
        mal_object_set_prototype((MalObject *) constructor, (MalObject *) ta_constructor);
    }
}
