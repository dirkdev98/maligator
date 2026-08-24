#include "builtin_typed_array.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "base64.h"
#include "builtin_bigint.h"
#include "builtin_iterator.h"
#include "heap_bigint.h"
#include "hex.h"
#include "object_ops.h"
#include "scalar_bits.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalObject *mal_ta_kind_prototype(MalVm *vm, MalTypedArrayKind kind) {
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind]);
}

static bool mal_ta_default_species(
    MalVm *vm, MalTypedArrayObject *array
) {
    if (!mal_primitive_method_protector ||
        array->object.prototype != mal_ta_kind_prototype(vm, array->kind)) {
        return false;
    }
    return !mal_object_get_own(
        &array->object,
        mal_intrinsic_string_key(vm, "constructor")).present;
}

static MalValue mal_ta_create_impl(
    MalVm *vm, MalTypedArrayKind kind, u32 length, bool initialize) {
    u32 element_size = mal_typed_array_element_size(kind);
    u32 byte_length = length * element_size;
    MalObject *buffer_prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = initialize
        ? mal_array_buffer_object_new(&vm->heap, buffer_prototype,
            byte_length, byte_length, false, false)
        : mal_array_buffer_object_new_uninitialized(
            &vm->heap, buffer_prototype,
            byte_length, byte_length, false, false);
    MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap, mal_ta_kind_prototype(vm, kind), buffer, kind, 0, length, false);
    return mal_value_from_typed_array_object(array);
}

// Allocate a fresh same-kind view backed by a new exact-size zeroed buffer.
static MalValue mal_ta_create(MalVm *vm, MalTypedArrayKind kind, u32 length) {
    return mal_ta_create_impl(vm, kind, length, true);
}

// Leaf native kernels use this only when every byte is overwritten before the
// result can become observable.
static MalValue mal_ta_create_uninitialized(
    MalVm *vm, MalTypedArrayKind kind, u32 length) {
    return mal_ta_create_impl(vm, kind, length, false);
}

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
static bool mal_ta_species_construct(MalVm *vm, MalValue species, const MalValue *args, i32 arg_count, i64 min_length, bool writable, MalValue *out) {
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
    if (writable && result->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return false;
    }
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
static bool mal_ta_species_create(MalVm *vm, MalTypedArrayObject *exemplar, u32 length, bool writable, MalValue *out) {
    if (mal_ta_default_species(vm, exemplar)) {
        // The watched concrete prototype/constructor chain still resolves the
        // builtin constructor and inherited @@species getter. Its construction
        // is exactly an unobservable same-kind allocation.
        *out = mal_ta_create(vm, exemplar->kind, length);
        return true;
    }
    MalValue species;
    if (!mal_ta_species_constructor(vm, exemplar, &species)) {
        return false;
    }
    MalValue length_arg = mal_value_from_f64((f64) length);
    return mal_ta_species_construct(vm, species, &length_arg, 1, (i64) length, writable, out);
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

static bool mal_ta_revalidate(MalVm *vm, MalTypedArrayObject *array) {
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray is out of bounds");
        return false;
    }
    return true;
}

// ValidateTypedArray: RequireInternalSlot, then throw if the view is out of
// bounds (detached buffer, or a resizable buffer shrunk past its extent). Most
// prototype methods begin with this.
static MalTypedArrayObject *mal_ta_this(MalVm *vm, MalValue this_value) {
    MalTypedArrayObject *array = mal_ta_this_raw(vm, this_value);
    if (array == nullptr) {
        return nullptr;
    }
    if (!mal_ta_revalidate(vm, array)) {
        return nullptr;
    }
    return array;
}

static MalTypedArrayObject *mal_ta_this_writable(MalVm *vm, MalValue this_value) {
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array != nullptr && array->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return nullptr;
    }
    return array;
}

// ToIndex: ToIntegerOrInfinity, then require an integer in [0, 2^53-1] (we cap
// at u32 range for practicality). Runs user coercion (may throw). On a throw
// leaves vm->completion set and returns false.
static bool mal_ta_to_index(MalVm *vm, MalValue value, u32 *out) {
    f64 number;
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    number = mal_ops_number_to_integer_or_infinity(number);
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
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    *out = mal_ops_number_to_integer_or_infinity(number);
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
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    *out = (u32) mal_ops_number_clamp_relative(number, (f64) length);
    return true;
}

static f64 mal_ta_span_number_at(
    const MalTypedArraySpan *span, u32 index) {
    u64 bits = mal_typed_array_span_load_bits(span, index);
    switch (span->kind) {
        case MAL_TA_INT8:
            return mal_scalar_i8_from_bits((u8) bits);
        case MAL_TA_UINT8:
        case MAL_TA_UINT8_CLAMPED:
            return (u8) bits;
        case MAL_TA_INT16:
            return mal_scalar_i16_from_bits((u16) bits);
        case MAL_TA_UINT16:
            return (u16) bits;
        case MAL_TA_INT32:
            return mal_scalar_i32_from_bits((u32) bits);
        case MAL_TA_UINT32:
            return (u32) bits;
        case MAL_TA_FLOAT32:
            return (f64) mal_scalar_f32_from_bits((u32) bits);
        case MAL_TA_FLOAT64:
            return mal_scalar_f64_from_bits(bits);
        default:
            return 0;
    }
}

static bool mal_ta_span_matches(
    const MalTypedArraySpan *span, u32 index, MalValue target,
    bool same_value_zero) {
    if (mal_typed_array_is_bigint(span->kind)) {
        if (!mal_value_is_bigint(target)) {
            return false;
        }
        u64 bits = mal_typed_array_span_load_bits(span, index);
        i128 element = span->kind == MAL_TA_BIGINT64
            ? (i128) mal_scalar_i64_from_bits(bits)
            : (i128) (u128) bits;
        return element == mal_bigint_value(mal_value_to_bigint(target));
    }
    if (!mal_ops_is_number(target)) {
        return false;
    }
    f64 element = mal_ta_span_number_at(span, index);
    f64 sought = mal_ops_number_as_f64(target);
    return element == sought ||
        (same_value_zero && isnan(element) && isnan(sought));
}

static bool mal_ta_byte_search_target(
    const MalTypedArraySpan *span, MalValue target, u8 *out
) {
    if (span->element_size != 1 || !mal_ops_is_number(target)) {
        return false;
    }
    f64 number = mal_ops_number_as_f64(target);
    if (!isfinite(number) || trunc(number) != number) {
        return false;
    }
    if (span->kind == MAL_TA_INT8) {
        if (number < -128 || number > 127) return false;
    } else if (number < 0 || number > 255) {
        return false;
    }
    *out = (u8) mal_ops_number_to_uint_width(number, 8);
    return true;
}

static u64 mal_ta_number_bits(MalTypedArrayKind kind, f64 number) {
    switch (kind) {
        case MAL_TA_INT8:
        case MAL_TA_UINT8:
            return mal_ops_number_to_uint_width(number, 8);
        case MAL_TA_UINT8_CLAMPED:
            if (isnan(number) || number <= 0) {
                return 0;
            }
            if (number >= 255) {
                return 255;
            }
            {
                f64 rounded = floor(number);
                f64 fraction = number - rounded;
                if (fraction > 0.5 ||
                    (fraction == 0.5 && ((u64) rounded & 1) != 0)) {
                    rounded += 1;
                }
                return (u8) rounded;
            }
        case MAL_TA_INT16:
        case MAL_TA_UINT16:
            return mal_ops_number_to_uint_width(number, 16);
        case MAL_TA_INT32:
        case MAL_TA_UINT32:
            return mal_ops_number_to_uint32(number);
        case MAL_TA_FLOAT32:
            return mal_scalar_f32_to_bits((f32) number);
        case MAL_TA_FLOAT64:
            return mal_scalar_f64_to_bits(number);
        default:
            return 0;
    }
}

// Copy `count` elements from src[src_start..] into dst[dst_start..]. Same-kind
// and BigInt-kind copies preserve raw bits; numeric cross-kind copies convert
// without materializing MalValues. Copying is deliberately forward and
// element-by-element when species returns a view over the source buffer: slice
// specifies observable sequential reads/writes rather than snapshot semantics.
static bool mal_ta_copy_elements(MalVm *vm, MalTypedArrayObject *dst, u32 dst_start, MalTypedArrayObject *src, u32 src_start, u32 count) {
    if (count == 0) {
        return true;
    }

    MalTypedArraySpan dst_span, src_span;
    if (!mal_typed_array_object_span(dst, &dst_span) ||
        !mal_typed_array_object_span(src, &src_span)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "TypedArray is out of bounds");
        return false;
    }

    byte *dst_at = dst_span.data + (usize) dst_start * dst_span.element_size;
    const byte *src_at = src_span.data + (usize) src_start * src_span.element_size;
    if (dst->kind == src->kind && dst->buffer != src->buffer) {
        memcpy(dst_at, src_at, (usize) count * src_span.element_size);
        return true;
    }

    bool dst_bigint = mal_typed_array_is_bigint(dst->kind);
    bool src_bigint = mal_typed_array_is_bigint(src->kind);
    if (dst_bigint != src_bigint) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot mix BigInt and non-BigInt typed arrays");
        return false;
    }

    for (u32 i = 0; i < count; i++) {
        u64 bits = src_bigint
            ? mal_typed_array_span_load_bits(&src_span, src_start + i)
            : mal_ta_number_bits(dst->kind,
                mal_ta_span_number_at(&src_span, src_start + i));
        mal_typed_array_span_store_bits(&dst_span, dst_start + i, bits);
    }
    return true;
}

// SetTypedArrayFromTypedArray snapshots a same-buffer source before writing so
// overlapping target stores cannot affect later source reads. Same-kind copies
// preserve the exact element bits; cross-kind copies decode from the snapshot
// and then apply the target kind's conversion.
static bool mal_ta_set_from_same_buffer(
    MalVm *vm,
    MalTypedArrayObject *dst,
    u32 dst_start,
    MalTypedArrayObject *src,
    u32 count
) {
    if (count == 0) {
        return true;
    }

    MalTypedArraySpan dst_span, src_span;
    if (!mal_typed_array_object_span(dst, &dst_span) ||
        !mal_typed_array_object_span(src, &src_span)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TypedArray is out of bounds");
        return false;
    }
    byte *dst_at = dst_span.data + (usize) dst_start * dst_span.element_size;
    usize snapshot_size = (usize) count * src_span.element_size;
    if (dst->kind == src->kind) {
        memmove(dst_at, src_span.data, snapshot_size);
        return true;
    }

    byte *snapshot = malloc(snapshot_size);
    memcpy(snapshot, src_span.data, snapshot_size);
    MalTypedArraySpan read_span = src_span;
    read_span.data = snapshot;
    read_span.length = count;
    bool bigint = mal_typed_array_is_bigint(src->kind);
    for (u32 i = 0; i < count; i++) {
        u64 bits = bigint
            ? mal_typed_array_span_load_bits(&read_span, i)
            : mal_ta_number_bits(dst->kind,
                mal_ta_span_number_at(&read_span, i));
        mal_typed_array_span_store_bits(&dst_span, dst_start + i, bits);
    }
    free(snapshot);
    return true;
}

static MalValue mal_typed_array_construct(MalVm *vm, MalTypedArrayKind kind, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor TypedArray requires 'new'");
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
            if (byte_offset > buffer->byte_length) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "byteOffset exceeds buffer length");
                return mal_value_new_undefined();
            }
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
            if (buffer->detached) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot construct over a detached ArrayBuffer");
                return mal_value_new_undefined();
            }
            if ((u64) byte_offset + (u64) length * element_size > buffer->byte_length) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid typed array length");
                return mal_value_new_undefined();
            }
        }

        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target,
                (MalIntrinsic) (MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind),
                &prototype)) {
            return mal_value_new_undefined();
        }
        MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap, prototype, buffer, kind, byte_offset, length, length_tracking);
        return mal_value_from_typed_array_object(array);
    }

    // new T(typedArray): copy converting elements.
    if (mal_value_is_typed_array_object(arg)) {
        MalTypedArrayObject *source = mal_value_to_typed_array_object(arg);
        if (!mal_ta_revalidate(vm, source)) {
            return mal_value_new_undefined();
        }
        if (mal_typed_array_is_bigint(kind) != mal_typed_array_is_bigint(source->kind)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot mix BigInt and non-BigInt typed arrays");
            return mal_value_new_undefined();
        }
        u32 length = mal_typed_array_object_length(source);
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target,
                (MalIntrinsic) (MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind),
                &prototype)) {
            return mal_value_new_undefined();
        }
        MalValue result = mal_ta_create_uninitialized(vm, kind, length);
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
            // Each step re-enters JS (iterator.next) and can collect; the items
            // collected so far are arbitrary heap values, so root the buffer (its
            // pointer is refreshed after each realloc) and lift GC suppression.
            MalValue result = mal_value_new_undefined();
            MalRootSpan values_span, result_span;
            mal_gc_root(&values_span, values, 0);
            mal_gc_root(&result_span, &result, 1);
            mal_gc_native_rooted_begin(vm);
            while (true) {
                MalValue item;
                bool done;
                if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
                    result = mal_value_new_undefined();
                    goto iter_done;
                }
                if (done) {
                    break;
                }
                if (count == capacity) {
                    capacity = capacity == 0 ? 8 : capacity * 2;
                    values = realloc(values, sizeof(MalValue) * capacity);
                    values_span.slots = values;
                }
                values[count++] = item;
                values_span.count = (i32) count;
            }

            MalObject *prototype;
            if (!mal_vm_get_prototype_from_constructor(
                    vm, new_target,
                    (MalIntrinsic) (MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind),
                    &prototype)) {
                result = mal_value_new_undefined();
                goto iter_done;
            }
            result = mal_ta_create(vm, kind, (u32) count);
            MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
            mal_object_set_prototype(&array->object, prototype);
            for (usize i = 0; i < count; i++) {
                mal_typed_array_object_set(vm, array, (u32) i, values[i]);
                if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
                    result = mal_value_new_undefined();
                    goto iter_done;
                }
            }

        iter_done:
            mal_gc_native_rooted_end(vm);
            mal_gc_unroot(&result_span);
            mal_gc_unroot(&values_span);
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
        length_number = mal_ops_number_to_length(length_number);
        // AllocateTypedArrayBuffer rejects a length that overflows a valid
        // buffer with a RangeError (e.g. 2^53).
        if (length_number > 4294967295.0 || (u64) length_number * element_size > 4294967295u) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid typed array length");
            return mal_value_new_undefined();
        }
        u32 length = (u32) length_number;

        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target,
                (MalIntrinsic) (MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind),
                &prototype)) {
            return mal_value_new_undefined();
        }
        MalValue result = mal_ta_create(vm, kind, length);
        MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
        mal_object_set_prototype(&array->object, prototype);
        for (u32 i = 0; i < length; i++) {
            MalValue element;
            if (!mal_vm_get_property(vm, arg, mal_key_index(i), &element)) {
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
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target,
            (MalIntrinsic) (MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + kind),
            &prototype)) {
        return mal_value_new_undefined();
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
    u32 offset = mal_typed_array_object_is_out_of_bounds(array) ? 0 : array->byte_offset;
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
    f64 actual = relative < 0 ? (f64) length + relative : relative;
    if (actual < 0 || actual >= (f64) length) {
        return mal_value_new_undefined();
    }
    return mal_typed_array_object_get(vm, array, (u32) actual);
}

static MalValue mal_ta_fill(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_writable(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    // Coerce and lower the fill value exactly once, before start/end coercion.
    u64 bits;
    if (!mal_typed_array_coerce_element_bits(vm, array->kind,
            arg_count >= 1 ? args[0] : mal_value_new_undefined(), &bits)) {
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
    if (!mal_ta_revalidate(vm, array)) {
        return mal_value_new_undefined();
    }
    // The view length is re-read after coercion (a resizable buffer may have
    // shrunk); clamp start/end so we never write past the current extent.
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    u32 current = span.length;
    if (start > current) {
        start = current;
    }
    if (end > current) {
        end = current;
    }
    if (start < end && span.element_size == 1) {
        memset(span.data + start, (u8) bits, end - start);
    } else {
        for (u32 i = start; i < end; i++) {
            mal_typed_array_span_store_bits(&span, i, bits);
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
    if (array->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
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
    if (!mal_ta_revalidate(vm, array)) {
        return mal_value_new_undefined();
    }
    u32 offset = offset_number > 4294967295.0 ? UINT32_MAX : (u32) offset_number;
    u32 length = mal_typed_array_object_length(array);

    if (mal_value_is_typed_array_object(source)) {
        MalTypedArrayObject *src = mal_value_to_typed_array_object(source);
        if (!mal_ta_revalidate(vm, src)) {
            return mal_value_new_undefined();
        }
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
        if (array->buffer == src->buffer) {
            if (!mal_ta_set_from_same_buffer(vm, array, offset, src, src_length)) {
                return mal_value_new_undefined();
            }
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
    src_length_number = mal_ops_number_to_length(src_length_number);
    u32 src_length = src_length_number > 4294967295.0 ? UINT32_MAX : (u32) src_length_number;
    if ((u64) offset + src_length > length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Source is too large");
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < src_length; i++) {
        MalValue element;
        if (!mal_vm_get_property(vm, source, mal_key_index(i), &element)) {
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
    if (!mal_ta_species_construct(vm, species, ctor_args, length_tracking_to_end ? 2 : 3, -1, false, &result)) {
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
    if (!mal_ta_species_create(vm, array, new_length, true, &result)) {
        return mal_value_new_undefined();
    }
    if (new_length > 0 && !mal_ta_revalidate(vm, array)) {
        return mal_value_new_undefined();
    }
    u32 current = mal_typed_array_object_length(array);
    u32 current_end = end < current ? end : current;
    u32 copy_length = current_end > start ? current_end - start : 0;
    if (!mal_ta_copy_elements(vm, mal_value_to_typed_array_object(result), 0, array, start, copy_length)) {
        return mal_value_new_undefined();
    }
    return result;
}

static MalValue mal_ta_copy_within(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_writable(vm, this_value);
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
    u32 count = end > start ? end - start : 0;
    if (count > length - target) {
        count = length - target;
    }
    if (!mal_ta_revalidate(vm, array)) {
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
    u32 live_count = end > start ? end - start : 0;
    if (live_count > current - target) {
        live_count = current - target;
    }
    if (count > live_count) {
        count = live_count;
    }
    u32 element_size = mal_typed_array_element_size(array->kind);
    // memmove handles overlap; the element bits move verbatim.
    memmove(array->buffer->data + array->byte_offset + (usize) target * element_size,
        array->buffer->data + array->byte_offset + (usize) start * element_size,
        (usize) count * element_size);
    return this_value;
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
        if (!mal_vm_to_string(vm, args[0], &separator)) {
            return mal_value_new_undefined();
        }
    } else {
        separator = mal_intrinsic_ascii(vm, ",");
    }

    MalValue result = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    for (u32 i = 0; i < length; i++) {
        if (i > 0) {
            result = mal_vm_add(vm, result, mal_value_from_string(separator));
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
        }
        MalValue element = mal_typed_array_object_get(vm, array, i);
        if (mal_value_is_nil(element)) {
            continue;
        }
        result = mal_vm_add(
            vm, result, mal_value_from_string(mal_ops_to_string(&vm->heap, element)));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }
    return result;
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
            result = mal_vm_add(vm, result, mal_value_from_string(separator));
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
        }
        MalValue element = mal_typed_array_object_get(vm, array, i);
        if (mal_value_is_nil(element)) {
            continue;
        }
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
        result = mal_vm_add(vm, result, mal_value_from_string(part));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
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
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_from_i32(-1);
    }
    if (span.element_size == 1) {
        u8 needle;
        u32 search_end = current < length ? current : length;
        if (!mal_ta_byte_search_target(&span, target, &needle) ||
            from >= search_end) {
            return mal_value_from_i32(-1);
        }
        const byte *found = memchr(
            span.data + from, needle, search_end - from);
        return found == nullptr
            ? mal_value_from_i32(-1)
            : mal_value_from_i32((i32) (found - span.data));
    }
    for (u32 i = from; i < length && i < current; i++) {
        if (mal_ta_span_matches(&span, i, target, false)) {
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
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_from_i32(-1);
    }
    if (span.element_size == 1) {
        u8 needle;
        if (!mal_ta_byte_search_target(&span, target, &needle)) {
            return mal_value_from_i32(-1);
        }
        for (i64 i = from; i >= 0; i--) {
            if (span.data[i] == needle) {
                return mal_value_from_i32((i32) i);
            }
        }
        return mal_value_from_i32(-1);
    }
    for (i64 i = from; i >= 0; i--) {
        if (mal_ta_span_matches(&span, (u32) i, target, false)) {
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
    MalTypedArraySpan span;
    if (mal_typed_array_object_span(array, &span)) {
        u32 present_end = span.length < length ? span.length : length;
        if (span.element_size == 1) {
            u8 needle;
            if (!mal_ta_byte_search_target(&span, target, &needle)) {
                return mal_value_new_boolean(
                    mal_value_is_undefined(target) &&
                    (from > span.length ? from : span.length) < length);
            }
            if (from >= present_end) {
                return mal_value_new_boolean(false);
            }
            return mal_value_new_boolean(
                memchr(span.data + from, needle, present_end - from) !=
                nullptr);
        }
        for (u32 i = from; i < present_end; i++) {
            if (mal_ta_span_matches(&span, i, target, true)) {
                return mal_value_new_boolean(true);
            }
        }
        if (mal_value_is_undefined(target) &&
            (from > span.length ? from : span.length) < length) {
            return mal_value_new_boolean(true);
        }
        return mal_value_new_boolean(false);
    }

    // A coercing fromIndex can detach the buffer. includes still performs Get
    // for every captured index, whose IntegerIndexedElementGet result is then
    // undefined; retain that observable edge instead of treating it as a span.
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
    MalTypedArrayObject *array = mal_ta_this_writable(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < span.length / 2; i++) {
        u32 other = span.length - 1 - i;
        u64 a = mal_typed_array_span_load_bits(&span, i);
        u64 b = mal_typed_array_span_load_bits(&span, other);
        mal_typed_array_span_store_bits(&span, i, b);
        mal_typed_array_span_store_bits(&span, other, a);
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
        if (!mal_ta_species_create(vm, array, length, true, &mapped)) {
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

    // Lift GC suppression so a long allocating callback cannot grow the heap
    // without bound. Heap scratch that must survive a collection inside a callback
    // is rooted: obj_roots[0] = MAP result; obj_roots[1] = the in-flight callback
    // return (held across the element store, whose ToNumber/ToBigInt may re-enter
    // JS) and later the FILTER result; the `kept` span = collected elements; and
    // call_args per call. Numeric elements are non-heap and ignored by the scan,
    // but a BigInt typed array yields heap values, so root uniformly.
    MalValue obj_roots[2] = {mapped, mal_value_new_undefined()};
    MalRootSpan obj_span, kept_span;
    mal_gc_root(&obj_span, obj_roots, 2);
    mal_gc_root(&kept_span, kept, 0);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    bool last = op == MAL_TA_FIND_LAST || op == MAL_TA_FIND_LAST_INDEX;
    for (u32 step = 0; step < length; step++) {
        u32 i = last ? length - 1 - step : step;
        MalValue element = mal_typed_array_object_get(vm, array, i);
        MalValue call_args[3] = {element, mal_value_from_i32((i32) i), this_value};
        MalRootSpan call_span;
        mal_gc_root(&call_span, call_args, 3);
        MalCompletion completion = mal_vm_call_value(vm, callback, this_arg, call_args, 3);
        mal_gc_unroot(&call_span);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            goto done;
        }
        obj_roots[1] = completion.value; // held across the MAP element store
        bool truthy = mal_value_is_truthy(completion.value);

        switch (op) {
            case MAL_TA_MAP:
                mal_typed_array_object_set(vm, map_result, i, completion.value);
                break;
            case MAL_TA_FILTER:
                if (truthy) {
                    kept[kept_count++] = element;
                    kept_span.count = (i32) kept_count;
                }
                break;
            case MAL_TA_FIND:
            case MAL_TA_FIND_LAST:
                if (truthy) {
                    ret = element;
                    goto done;
                }
                break;
            case MAL_TA_FIND_INDEX:
            case MAL_TA_FIND_LAST_INDEX:
                if (truthy) {
                    ret = mal_value_from_i32((i32) i);
                    goto done;
                }
                break;
            case MAL_TA_SOME:
                if (truthy) {
                    ret = mal_value_new_boolean(true);
                    goto done;
                }
                break;
            case MAL_TA_EVERY:
                if (!truthy) {
                    ret = mal_value_new_boolean(false);
                    goto done;
                }
                break;
            case MAL_TA_FOR_EACH:
                break;
        }
    }

    switch (op) {
        case MAL_TA_MAP:
            ret = mapped;
            break;
        case MAL_TA_FILTER: {
            MalValue result;
            if (!mal_ta_species_create(vm, array, (u32) kept_count, true, &result)) {
                break; // ret stays undefined; throw pending
            }
            obj_roots[1] = result;
            MalTypedArrayObject *out = mal_value_to_typed_array_object(result);
            for (usize i = 0; i < kept_count; i++) {
                mal_typed_array_object_set(vm, out, (u32) i, kept[i]);
            }
            ret = result;
            break;
        }
        case MAL_TA_FIND:
        case MAL_TA_FIND_LAST:
            ret = mal_value_new_undefined();
            break;
        case MAL_TA_FIND_INDEX:
        case MAL_TA_FIND_LAST_INDEX:
            ret = mal_value_from_i32(-1);
            break;
        case MAL_TA_SOME:
            ret = mal_value_new_boolean(false);
            break;
        case MAL_TA_EVERY:
            ret = mal_value_new_boolean(true);
            break;
        case MAL_TA_FOR_EACH:
            ret = mal_value_new_undefined();
            break;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&kept_span);
    mal_gc_unroot(&obj_span);
    free(kept);
    return ret;
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

    // The accumulator (an arbitrary callback return) is carried across every
    // callback and must survive a collection inside one; root it (and the call
    // arguments, which also hold a BigInt element). Numeric elements are non-heap.
    MalValue acc_root[1] = {accumulator};
    MalRootSpan acc_span;
    mal_gc_root(&acc_span, acc_root, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    for (u32 step = 0; step < length; step++) {
        u32 i = from_right ? length - 1 - step : step;
        MalValue element = mal_typed_array_object_get(vm, array, i);
        if (!has_accumulator) {
            accumulator = element;
            acc_root[0] = accumulator;
            has_accumulator = true;
            continue;
        }
        MalValue call_args[4] = {accumulator, element, mal_value_from_i32((i32) i), this_value};
        MalRootSpan call_span;
        mal_gc_root(&call_span, call_args, 4);
        MalCompletion completion = mal_vm_call_value(vm, callback, mal_value_new_undefined(), call_args, 4);
        mal_gc_unroot(&call_span);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            goto done;
        }
        accumulator = completion.value;
        acc_root[0] = accumulator;
    }

    if (!has_accumulator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty array with no initial value");
        goto done;
    }
    ret = accumulator;

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&acc_span);
    return ret;
}

static MalValue mal_ta_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mal_ta_reduce_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_ta_reduce_right(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mal_ta_reduce_impl(vm, this_value, args, arg_count, true);
}

// Default TypedArray sort order over raw element bits: numeric ascending (NaN
// last, -0 before +0). Equal values compare equal so the merge remains stable,
// including distinct NaN payloads.
static i32 mal_ta_compare_raw(
    MalTypedArrayKind kind, u64 a, u64 b) {
    switch (kind) {
        case MAL_TA_INT8: {
            i8 x = mal_scalar_i8_from_bits((u8) a);
            i8 y = mal_scalar_i8_from_bits((u8) b);
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_UINT8:
        case MAL_TA_UINT8_CLAMPED: {
            u8 x = (u8) a;
            u8 y = (u8) b;
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_INT16: {
            i16 x = mal_scalar_i16_from_bits((u16) a);
            i16 y = mal_scalar_i16_from_bits((u16) b);
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_UINT16: {
            u16 x = (u16) a;
            u16 y = (u16) b;
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_INT32: {
            i32 x = mal_scalar_i32_from_bits((u32) a);
            i32 y = mal_scalar_i32_from_bits((u32) b);
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_UINT32: {
            u32 x = (u32) a;
            u32 y = (u32) b;
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_BIGINT64: {
            i64 x = mal_scalar_i64_from_bits(a);
            i64 y = mal_scalar_i64_from_bits(b);
            return x < y ? -1 : x > y ? 1 : 0;
        }
        case MAL_TA_BIGUINT64:
            return a < b ? -1 : a > b ? 1 : 0;
        default:
            break;
    }

    f64 x = kind == MAL_TA_FLOAT32
        ? (f64) mal_scalar_f32_from_bits((u32) a)
        : mal_scalar_f64_from_bits(a);
    f64 y = kind == MAL_TA_FLOAT32
        ? (f64) mal_scalar_f32_from_bits((u32) b)
        : mal_scalar_f64_from_bits(b);
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
    if (x == 0 && y == 0) {
        if (signbit(x) && !signbit(y)) {
            return -1;
        }
        if (!signbit(x) && signbit(y)) {
            return 1;
        }
    }
    return 0;
}

static void mal_ta_sort_default(MalTypedArrayObject *array) {
    MalTypedArraySpan target;
    if (!mal_typed_array_object_span(array, &target) || target.length < 2) {
        return;
    }

    usize byte_length = (usize) target.length * target.element_size;
    byte *source_data = malloc(byte_length);
    byte *scratch_data = malloc(byte_length);
    memcpy(source_data, target.data, byte_length);

    MalTypedArraySpan source = target;
    MalTypedArraySpan scratch = target;
    u32 width = 1;
    while (width < target.length) {
        source.data = source_data;
        scratch.data = scratch_data;
        u32 base = 0;
        while (base < target.length) {
            u32 remaining = target.length - base;
            u32 middle = width < remaining ? base + width : target.length;
            remaining = target.length - middle;
            u32 end = width < remaining ? middle + width : target.length;
            u32 left = base;
            u32 right = middle;
            for (u32 out = base; out < end; out++) {
                bool take_left = right >= end ||
                    (left < middle && mal_ta_compare_raw(target.kind,
                        mal_typed_array_span_load_bits(&source, left),
                        mal_typed_array_span_load_bits(&source, right)) <= 0);
                u32 selected = take_left ? left++ : right++;
                mal_typed_array_span_store_bits(&scratch, out,
                    mal_typed_array_span_load_bits(&source, selected));
            }
            base = end;
        }
        byte *swap = source_data;
        source_data = scratch_data;
        scratch_data = swap;
        width = width > target.length / 2 ? target.length : width * 2;
    }

    memcpy(target.data, source_data, byte_length);
    free(source_data);
    free(scratch_data);
}

static bool mal_ta_compare_callback(
    MalVm *vm, MalValue compare, MalValue left, MalValue right, i32 *order) {
    MalValue call_args[2] = {left, right};
    MalRootSpan call_span;
    mal_gc_root(&call_span, call_args, 2);
    MalCompletion completion = mal_vm_call_value(
        vm, compare, mal_value_new_undefined(), call_args, 2);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        mal_gc_unroot(&call_span);
        vm->completion = completion;
        return false;
    }
    call_args[0] = completion.value;
    f64 result;
    if (!mal_vm_to_number(vm, completion.value, &result)) {
        mal_gc_unroot(&call_span);
        return false;
    }
    mal_gc_unroot(&call_span);
    *order = isnan(result) ? 0 : (result < 0 ? -1 : result > 0 ? 1 : 0);
    return true;
}

static MalValue mal_ta_sort(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalTypedArrayObject *array = mal_ta_this_writable(vm, this_value);
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
    if (mal_value_is_undefined(compare)) {
        mal_ta_sort_default(array);
        return this_value;
    }

    MalValue *values = malloc(sizeof(MalValue) * length);
    MalValue *scratch = malloc(sizeof(MalValue) * length);
    for (u32 i = 0; i < length; i++) {
        values[i] = mal_typed_array_object_get(vm, array, i);
        scratch[i] = mal_value_new_undefined();
    }

    // A user comparator can collect; root both merge buffers (BigInt arrays hold
    // heap elements) and lift GC suppression. Bottom-up stable merge sort bounds
    // comparator calls to O(n log n), while keeping all array writes until after
    // the comparator phase.
    MalRootSpan values_span, scratch_span;
    mal_gc_root(&values_span, values, (i32) length);
    mal_gc_root(&scratch_span, scratch, (i32) length);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = this_value;

    MalValue *source = values;
    MalValue *destination = scratch;
    u32 width = 1;
    while (width < length) {
        u32 base = 0;
        while (base < length) {
            u32 remaining = length - base;
            u32 middle = width < remaining ? base + width : length;
            remaining = length - middle;
            u32 end = width < remaining ? middle + width : length;
            u32 left = base;
            u32 right = middle;
            for (u32 out = base; out < end; out++) {
                bool take_left = right >= end;
                if (!take_left && left < middle) {
                    i32 order;
                    if (!mal_ta_compare_callback(
                            vm, compare, source[left], source[right], &order)) {
                        ret = mal_value_new_undefined();
                        goto done;
                    }
                    take_left = order <= 0;
                } else if (left < middle) {
                    take_left = true;
                }
                destination[out] = take_left
                    ? source[left++] : source[right++];
            }
            base = end;
        }
        MalValue *swap = source;
        source = destination;
        destination = swap;
        width = width > length / 2 ? length : width * 2;
    }

    for (u32 i = 0; i < length; i++) {
        mal_typed_array_object_set(vm, array, i, source[i]);
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&scratch_span);
    mal_gc_unroot(&values_span);
    free(scratch);
    free(values);
    return ret;
}

// %TypedArray%.prototype.toReversed(): a new array of the SAME type (not via
// @@species) holding this array's elements in reverse. The receiver is left
// unchanged. Elements are already numeric, so no user coercion runs.
static MalValue mal_ta_to_reversed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue result = mal_ta_create_uninitialized(vm, array->kind, length);
    MalTypedArrayObject *out = mal_value_to_typed_array_object(result);
    MalTypedArraySpan source_span, result_span;
    if (!mal_typed_array_object_span(array, &source_span) ||
        !mal_typed_array_object_span(out, &result_span)) {
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < length; i++) {
        mal_typed_array_span_store_bits(&result_span, i,
            mal_typed_array_span_load_bits(&source_span, length - 1 - i));
    }
    return result;
}

// %TypedArray%.prototype.toSorted(comparefn): a new same-type array holding this
// array's elements sorted. Validates the comparator first, copies into a fresh
// array, then sorts that copy in place (so the comparator can never observe or
// mutate the original through the sort). Same-type, not @@species.
static MalValue mal_ta_to_sorted(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalValue compare = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_undefined(compare) && !mal_value_is_callable(compare)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Comparator is not a function");
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    MalValue result = mal_ta_create_uninitialized(vm, array->kind, length);
    if (!mal_ta_copy_elements(vm, mal_value_to_typed_array_object(result), 0, array, 0, length)) {
        return mal_value_new_undefined();
    }
    // Sort the fresh copy in place; on a comparator throw this forwards the
    // completion and returns undefined.
    MalValue sorted = mal_ta_sort(vm, result, args, arg_count, new_target, callee);
    if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
        return mal_value_new_undefined();
    }
    return sorted;
}

// %TypedArray%.prototype.with(index, value): a new same-type array equal to this
// one but with element `index` replaced by `value`. ToIntegerOrInfinity(index)
// and the value coercion (ToBigInt/ToNumber) run before the bounds check, which
// throws RangeError for an out-of-range index. Same-type, not @@species.
static MalValue mal_ta_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);

    f64 relative;
    if (!mal_ta_to_integer(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &relative)) {
        return mal_value_new_undefined();
    }
    f64 actual = relative >= 0 ? relative : (f64) length + relative;

    u64 replacement_bits;
    if (!mal_typed_array_coerce_element_bits(vm, array->kind,
            arg_count >= 2 ? args[1] : mal_value_new_undefined(),
            &replacement_bits)) {
        return mal_value_new_undefined();
    }

    // IsValidIntegerIndex observes the live post-coercion extent. The result
    // still has the original captured length, so a newly-valid grown index can
    // lie beyond it and simply replace no copied element.
    u32 current_length = mal_typed_array_object_length(array);
    if (mal_typed_array_object_is_out_of_bounds(array) || actual < 0 || actual >= (f64) current_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid typed array index");
        return mal_value_new_undefined();
    }
    u32 actual_index = (u32) actual;

    MalValue result = mal_ta_create_uninitialized(vm, array->kind, length);
    MalTypedArrayObject *out = mal_value_to_typed_array_object(result);
    MalTypedArraySpan source_span, result_span;
    if (!mal_typed_array_object_span(array, &source_span) ||
        !mal_typed_array_object_span(out, &result_span)) {
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < length; i++) {
        u64 bits;
        if (i == actual_index) {
            bits = replacement_bits;
        } else if (i < source_span.length) {
            bits = mal_typed_array_span_load_bits(&source_span, i);
        } else if (!mal_typed_array_coerce_element_bits(
                vm, array->kind, mal_value_new_undefined(), &bits)) {
            return mal_value_new_undefined();
        }
        mal_typed_array_span_store_bits(&result_span, i, bits);
    }
    return result;
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
    MalTypedArrayObject *result = mal_value_to_typed_array_object(completion.value);
    if (result->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return false;
    }
    if (mal_typed_array_object_length(result) < length) {
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
    // The result is held across the element stores, whose ToNumber/ToBigInt may
    // re-enter JS (valueOf) and collect; root it. The args are value-stack rooted.
    MalRootSpan result_span;
    mal_gc_root(&result_span, &result, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = result;
    for (i32 i = 0; i < arg_count; i++) {
        mal_typed_array_object_set(vm, array, (u32) i, args[i]);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            ret = mal_value_new_undefined();
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&result_span);
    return ret;
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
    // Every phase below re-enters JS and can collect: iterator.next / array-like
    // index gets during collection, Construct during creation, and the mapfn +
    // element store during the build. Root the growing snapshot (refreshing its
    // pointer after each realloc, and only scanning filled entries) plus the
    // result and in-flight mapped element, and lift GC suppression.
    MalValue extra[2] = {mal_value_new_undefined(), mal_value_new_undefined()}; // [0]=result, [1]=mapped element
    MalRootSpan values_span, extra_span;
    mal_gc_root(&values_span, values, 0);
    mal_gc_root(&extra_span, extra, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    if (mal_value_is_callable(iterator_method)) {
        MalIteratorRecord record;
        if (!mal_vm_get_iterator_from_method(vm, source, iterator_method, &record)) {
            goto done;
        }
        while (true) {
            MalValue item;
            bool done_flag;
            if (!mal_vm_iterator_step(vm, &record, &item, &done_flag)) {
                goto done;
            }
            if (done_flag) {
                break;
            }
            if (count == capacity) {
                capacity = capacity == 0 ? 8 : capacity * 2;
                values = realloc(values, sizeof(MalValue) * capacity);
                values_span.slots = values;
            }
            values[count++] = item;
            values_span.count = (i32) count;
        }
    } else {
        MalValue length_value;
        if (!mal_vm_get_property(vm, source, mal_intrinsic_string_key(vm, "length"), &length_value)) {
            goto done;
        }
        f64 length_number;
        if (!mal_vm_to_number(vm, length_value, &length_number)) {
            goto done;
        }
        length_number = mal_ops_number_to_length(length_number);
        u32 length = length_number > 4294967295.0 ? UINT32_MAX : (u32) length_number;
        MalValue result;
        if (!mal_ta_create_from_constructor(vm, this_value, length, &result)) {
            goto done;
        }
        extra[0] = result;
        MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
        for (u32 i = 0; i < length; i++) {
            MalValue element;
            if (!mal_vm_get_property(vm, source, mal_key_index(i), &element)) {
                goto done;
            }
            if (mal_value_is_callable(map_fn)) {
                MalValue call_args[2] = {element, mal_value_from_i32((i32) i)};
                MalRootSpan call_span;
                mal_gc_root(&call_span, call_args, 2);
                MalCompletion completion = mal_vm_call_value(vm, map_fn, this_arg, call_args, 2);
                mal_gc_unroot(&call_span);
                if (completion.kind != MAL_COMPLETION_NORMAL) {
                    vm->completion = completion;
                    goto done;
                }
                element = completion.value;
            }
            extra[1] = element;
            mal_typed_array_object_set(vm, array, i, element);
            if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
                goto done;
            }
        }
        ret = result;
        goto done;
    }

    MalValue result;
    if (!mal_ta_create_from_constructor(vm, this_value, (u32) count, &result)) {
        goto done;
    }
    extra[0] = result;
    MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
    for (usize i = 0; i < count; i++) {
        MalValue element = values[i];
        if (mal_value_is_callable(map_fn)) {
            MalValue call_args[2] = {element, mal_value_from_i32((i32) i)};
            MalRootSpan call_span;
            mal_gc_root(&call_span, call_args, 2);
            MalCompletion completion = mal_vm_call_value(vm, map_fn, this_arg, call_args, 2);
            mal_gc_unroot(&call_span);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = completion;
                goto done;
            }
            element = completion.value;
        }
        extra[1] = element; // held across the element store (ToNumber may re-enter)
        mal_typed_array_object_set(vm, array, (u32) i, element);
        if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
            goto done;
        }
    }
    ret = result;

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&extra_span);
    mal_gc_unroot(&values_span);
    free(values);
    return ret;
}

// ---- Uint8Array base64/hex (Uint8Array-to/from-base64 proposal) ----------

typedef enum { MAL_B64_LOOSE, MAL_B64_STRICT, MAL_B64_STOP } MalB64LastChunk;

/** ValidateUint8Array: receiver must be a Uint8Array. */
static MalTypedArrayObject *mal_ta_uint8_this(MalVm *vm, MalValue this_value) {
    if (!mal_value_is_typed_array_object(this_value) ||
        mal_value_to_typed_array_object(this_value)->kind != MAL_TA_UINT8) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a Uint8Array");
        return nullptr;
    }
    return mal_value_to_typed_array_object(this_value);
}

/** GetOptionsObject: undefined -> a fresh null-proto object, an object passes
 * through, anything else throws a TypeError. */
static bool mal_b64_get_options(MalVm *vm, MalValue value, MalValue *out) {
    if (mal_value_is_undefined(value)) {
        *out = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        return true;
    }
    if (mal_value_is_object(value)) {
        *out = value;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "options is not an object");
    return false;
}

/** Read the "alphabet" option: "base64" (default) or "base64url". */
static bool mal_b64_read_alphabet(MalVm *vm, MalValue options, bool *url) {
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "alphabet"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *url = false;
        return true;
    }
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "base64"))) {
            *url = false;
            return true;
        }
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "base64url"))) {
            *url = true;
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "alphabet must be 'base64' or 'base64url'");
    return false;
}

/** Read the "lastChunkHandling" option: loose (default) / strict / stop-before-partial. */
static bool mal_b64_read_last_chunk(MalVm *vm, MalValue options, MalB64LastChunk *mode) {
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "lastChunkHandling"), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *mode = MAL_B64_LOOSE;
        return true;
    }
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "loose"))) {
            *mode = MAL_B64_LOOSE;
            return true;
        }
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "strict"))) {
            *mode = MAL_B64_STRICT;
            return true;
        }
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "stop-before-partial"))) {
            *mode = MAL_B64_STOP;
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "lastChunkHandling must be 'loose', 'strict', or 'stop-before-partial'");
    return false;
}

/**
 * Decode base64 `s` into `out` (cap `max_out` bytes). Sets *read (code units
 * consumed yielding committed output) and *written. Throws SyntaxError on an
 * illegal character / bad padding / extra bits (strict). When max_out is reached
 * mid-stream, decoding stops cleanly (for setFromBase64).
 */
static bool mal_b64_decode(MalVm *vm, const c16 *s, usize len, bool url, MalB64LastChunk last_chunk, byte *out, usize max_out, usize *read_out, usize *written_out) {
    usize i = 0;
    usize written = 0;
    usize read = 0;
    u32 acc = 0;
    i32 nsext = 0;

    // maxLength reached up front (empty target): read nothing, ignore the input.
    if (max_out == 0) {
        *read_out = 0;
        *written_out = 0;
        return true;
    }

    while (i < len) {
        c16 c = s[i];
        if (mal_base64_is_ascii_whitespace(c)) {
            i++;
            continue;
        }
        if (c == '=') {
            break;
        }
        i32 v = mal_base64_decode_digit(
            c, url ? MAL_BASE64_ALPHABET_URL : MAL_BASE64_ALPHABET_STANDARD);
        if (v < 0) {
            // Commit the bytes decoded so far (setFromBase64 writes up to the error).
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid base64 character");
            return false;
        }
        acc = (acc << 6) | (u32) v;
        nsext++;
        i++;
        if (nsext == 4) {
            if (written + 3 > max_out) {
                // The next 3-byte chunk won't fit: stop before it (unread).
                *read_out = read;
                *written_out = written;
                return true;
            }
            out[written++] = (byte) ((acc >> 16) & 0xFF);
            out[written++] = (byte) ((acc >> 8) & 0xFF);
            out[written++] = (byte) (acc & 0xFF);
            acc = 0;
            nsext = 0;
            read = i;
            // Target full after this chunk: stop, ignoring any trailing input.
            if (written == max_out) {
                *read_out = read;
                *written_out = written;
                return true;
            }
        }
    }

    // Tail: pending sextets and/or '=' padding.
    if (nsext == 0) {
        // Only whitespace may remain (stray '=' is malformed).
        while (i < len) {
            if (!mal_base64_is_ascii_whitespace(s[i])) {
                *read_out = read;
                *written_out = written;
                mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Unexpected base64 padding");
                return false;
            }
            i++;
        }
        *read_out = len;
        *written_out = written;
        return true;
    }

    bool has_padding = i < len && s[i] == '=';
    i32 produced = nsext == 2 ? 1 : 2;  // bytes a 2/3-sextet partial chunk yields
    i32 used_bits = produced * 8;
    u32 extra_mask = nsext == 1 ? 0 : (1u << (nsext * 6 - used_bits)) - 1;

    // If the partial chunk's bytes cannot fit the output, stop before it (the
    // chunk and any padding stay unread) — matching the maxLength early-out.
    if (nsext >= 2 && written + (usize) produced > max_out) {
        *read_out = read;
        *written_out = written;
        return true;
    }

    if (!has_padding) {
        // No padding follows the partial chunk.
        if (last_chunk == MAL_B64_STOP) {
            // Leave the partial chunk unread.
            *read_out = read;
            *written_out = written;
            return true;
        }
        if (nsext == 1) {
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid base64 length");
            return false;
        }
        if (last_chunk == MAL_B64_STRICT) {
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Missing base64 padding");
            return false;
        }
        // loose: decode the partial chunk, ignoring any extra low bits.
    } else {
        if (nsext == 1) {
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid base64 length");
            return false;
        }
        i32 needed_padding = 4 - nsext;
        i32 seen = 0;
        while (seen < needed_padding && i < len && s[i] == '=') {
            i++;
            seen++;
            while (i < len && mal_base64_is_ascii_whitespace(s[i])) i++;
        }
        if (seen < needed_padding) {
            // Incomplete padding: stop-before-partial stops here; others error.
            if (last_chunk == MAL_B64_STOP) {
                *read_out = read;
                *written_out = written;
                return true;
            }
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Malformed base64 padding");
            return false;
        }
        // Exactly the needed padding: only whitespace may follow.
        while (i < len) {
            if (!mal_base64_is_ascii_whitespace(s[i])) {
                *read_out = read;
                *written_out = written;
                mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Unexpected character after base64 padding");
                return false;
            }
            i++;
        }
        if (last_chunk == MAL_B64_STRICT && (acc & extra_mask) != 0) {
            *read_out = read;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Extra bits in base64 chunk");
            return false;
        }
    }

    u32 value = acc >> (nsext * 6 - used_bits);
    if (written + (usize) produced <= max_out) {
        for (i32 b = produced - 1; b >= 0; b--) {
            out[written++] = (byte) ((value >> (b * 8)) & 0xFF);
        }
    }

    *read_out = len;
    *written_out = written;
    return true;
}

/** Decode hex `s` into `out` (cap max_out). Throws SyntaxError on a non-hex
 * character or odd length. */
static bool mal_hex_decode(MalVm *vm, const c16 *s, usize len, byte *out, usize max_out, usize *read_out, usize *written_out) {
    if (len % 2 != 0) {
        *read_out = 0;
        *written_out = 0;
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Hex string length must be even");
        return false;
    }
    usize written = 0;
    usize i = 0;
    while (i + 2 <= len) {
        if (written + 1 > max_out) {
            break;
        }
        i32 hi = mal_hex_decode_digit(s[i]);
        i32 lo = mal_hex_decode_digit(s[i + 1]);
        if (hi < 0 || lo < 0) {
            // Commit the bytes decoded so far (setFromHex writes up to the error).
            *read_out = i;
            *written_out = written;
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid hex character");
            return false;
        }
        out[written++] = (byte) ((hi << 4) | lo);
        i += 2;
    }
    *read_out = i;
    *written_out = written;
    return true;
}

/** Encode `bytes` as base64 into a fresh String. */
static MalValue mal_b64_encode(MalVm *vm, const byte *bytes, usize length, bool url, bool omit_padding) {
    usize out_length;
    if (!mal_base64_encoded_length(
            length, !omit_padding, MAL_STRING_MAX_CODE_UNITS, &out_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    MalString *result = mal_base64_encode_string(
        &vm->heap, bytes, length,
        url ? MAL_BASE64_ALPHABET_URL : MAL_BASE64_ALPHABET_STANDARD,
        !omit_padding);
    return mal_value_from_string(result);
}

/** Encode `bytes` as lowercase hex into a fresh String. */
static MalValue mal_hex_encode(MalVm *vm, const byte *bytes, usize length) {
    usize out_length;
    if (!mal_hex_encoded_length(length, MAL_STRING_MAX_CODE_UNITS, &out_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(
        mal_hex_encode_string(&vm->heap, bytes, length));
}

// Require a String argument (these methods never coerce).
static bool mal_b64_require_string(MalVm *vm, MalValue value, MalString **out) {
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "argument must be a string");
        return false;
    }
    *out = mal_value_to_string(value);
    return true;
}

static MalValue mal_ta_from_base64(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_b64_require_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    MalValue options;
    if (!mal_b64_get_options(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    bool url;
    MalB64LastChunk last_chunk;
    if (!mal_b64_read_alphabet(vm, options, &url) || !mal_b64_read_last_chunk(vm, options, &last_chunk)) {
        return mal_value_new_undefined();
    }

    usize len = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    usize cap = len / 4 * 3 + 3;
    byte *bytes = malloc(cap);
    usize read;
    usize written;
    if (!mal_b64_decode(vm, units, len, url, last_chunk, bytes, cap, &read, &written)) {
        free(bytes);
        return mal_value_new_undefined();
    }
    MalValue result = mal_ta_create(vm, MAL_TA_UINT8, (u32) written);
    MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
    if (written > 0) memcpy(array->buffer->data, bytes, written);
    free(bytes);
    return result;
}

static MalValue mal_ta_from_hex(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_b64_require_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    usize len = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    byte *bytes = malloc(len / 2 + 1);
    usize read;
    usize written;
    if (!mal_hex_decode(vm, units, len, bytes, len / 2 + 1, &read, &written)) {
        free(bytes);
        return mal_value_new_undefined();
    }
    MalValue result = mal_ta_create(vm, MAL_TA_UINT8, (u32) written);
    MalTypedArrayObject *array = mal_value_to_typed_array_object(result);
    if (written > 0) memcpy(array->buffer->data, bytes, written);
    free(bytes);
    return result;
}

static MalValue mal_ta_to_base64(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_uint8_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue options;
    if (!mal_b64_get_options(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    bool url;
    if (!mal_b64_read_alphabet(vm, options, &url)) {
        return mal_value_new_undefined();
    }
    MalValue omit_value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "omitPadding"), &omit_value)) {
        return mal_value_new_undefined();
    }
    bool omit_padding = mal_value_is_truthy(omit_value);
    if (array->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot encode a detached buffer");
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    const byte *bytes = length == 0
        ? nullptr
        : array->buffer->data + array->byte_offset;
    return mal_b64_encode(vm, bytes, length, url, omit_padding);
}

static MalValue mal_ta_to_hex(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_uint8_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    if (array->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot encode a detached buffer");
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    const byte *bytes = length == 0
        ? nullptr
        : array->buffer->data + array->byte_offset;
    return mal_hex_encode(vm, bytes, length);
}

/** Build the { read, written } result record for setFromBase64/setFromHex. */
static MalValue mal_b64_set_result(MalVm *vm, usize read, usize written) {
    MalObject *object = mal_intrinsic_new_object(vm);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, object, "read", mal_value_from_f64((f64) read), flags);
    mal_intrinsic_define_data(vm, object, "written", mal_value_from_f64((f64) written), flags);
    return mal_value_from_object(object);
}

static MalValue mal_ta_set_from_base64(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_uint8_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    // Mutability is verified before any argument coercion (string/options).
    if (array->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return mal_value_new_undefined();
    }
    MalString *string;
    if (!mal_b64_require_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    MalValue options;
    if (!mal_b64_get_options(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    bool url;
    MalB64LastChunk last_chunk;
    if (!mal_b64_read_alphabet(vm, options, &url) || !mal_b64_read_last_chunk(vm, options, &last_chunk)) {
        return mal_value_new_undefined();
    }
    if (array->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to a detached buffer");
        return mal_value_new_undefined();
    }

    u32 target_length = mal_typed_array_object_length(array);
    usize len = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    usize cap = len / 4 * 3 + 3;
    byte *bytes = malloc(cap);
    usize read;
    usize written;
    bool ok = mal_b64_decode(vm, units, len, url, last_chunk, bytes, target_length, &read, &written);
    // Commit the successfully-decoded bytes even when a later chunk errors.
    if (written > 0) {
        memcpy(array->buffer->data + array->byte_offset, bytes, written);
    }
    free(bytes);
    if (!ok) {
        return mal_value_new_undefined();
    }
    return mal_b64_set_result(vm, read, written);
}

static MalValue mal_ta_set_from_hex(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = mal_ta_uint8_this(vm, this_value);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    if (array->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return mal_value_new_undefined();
    }
    MalString *string;
    if (!mal_b64_require_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    if (array->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to a detached buffer");
        return mal_value_new_undefined();
    }
    u32 target_length = mal_typed_array_object_length(array);
    usize len = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    byte *bytes = malloc(len / 2 + 1);
    usize read;
    usize written;
    bool ok = mal_hex_decode(vm, units, len, bytes, target_length, &read, &written);
    if (written > 0) {
        memcpy(array->buffer->data + array->byte_offset, bytes, written);
    }
    free(bytes);
    if (!ok) {
        return mal_value_new_undefined();
    }
    return mal_b64_set_result(vm, read, written);
}

// ---- install -------------------------------------------------------------

static void mal_ta_define_getter(MalVm *vm, MalObject *object, MalKey key, const byte *name, MalNativeFunctionCallback getter) {
    mal_intrinsic_define_accessor_n(
        vm, object, key, name, 0, getter, nullptr, 0, nullptr,
        MAL_PROPERTY_CONFIGURABLE);
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
    MalPropertyLookup array_to_string = mal_object_get_own(
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]),
        mal_intrinsic_string_key(vm, "toString"));
    mal_intrinsic_define_data(
        vm, ta_prototype, "toString", array_to_string.desc.value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, ta_prototype, "toLocaleString", 0, mal_ta_to_locale_string);
    mal_intrinsic_define_method_n(vm, ta_prototype, "indexOf", 1, mal_ta_index_of);
    mal_intrinsic_define_method_n(vm, ta_prototype, "lastIndexOf", 1, mal_ta_last_index_of);
    mal_intrinsic_define_method_n(vm, ta_prototype, "includes", 1, mal_ta_includes);
    mal_intrinsic_define_method_n(vm, ta_prototype, "reverse", 0, mal_ta_reverse);
    mal_intrinsic_define_method_n(vm, ta_prototype, "sort", 1, mal_ta_sort);
    mal_intrinsic_define_method_n(vm, ta_prototype, "toReversed", 0, mal_ta_to_reversed);
    mal_intrinsic_define_method_n(vm, ta_prototype, "toSorted", 1, mal_ta_to_sorted);
    mal_intrinsic_define_method_n(vm, ta_prototype, "with", 2, mal_ta_with);
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
    mal_intrinsic_define_species(vm, (MalObject *) ta_constructor);

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

    // Uint8Array base64/hex (Uint8Array-to/from-base64 proposal): statics on the
    // Uint8Array constructor and methods on Uint8Array.prototype.
    MalObject *u8_constructor = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + MAL_TA_UINT8]);
    MalObject *u8_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + MAL_TA_UINT8]);
    mal_intrinsic_define_method_n(vm, u8_constructor, "fromBase64", 1, mal_ta_from_base64);
    mal_intrinsic_define_method_n(vm, u8_constructor, "fromHex", 1, mal_ta_from_hex);
    mal_intrinsic_define_method_n(vm, u8_prototype, "toBase64", 0, mal_ta_to_base64);
    mal_intrinsic_define_method_n(vm, u8_prototype, "toHex", 0, mal_ta_to_hex);
    mal_intrinsic_define_method_n(vm, u8_prototype, "setFromBase64", 1, mal_ta_set_from_base64);
    mal_intrinsic_define_method_n(vm, u8_prototype, "setFromHex", 1, mal_ta_set_from_hex);
}
