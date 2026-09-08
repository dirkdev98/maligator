#include "builtin_array_buffer.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "array_buffer_object.h"
#include "object_ops.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// ToIndex: full ToIntegerOrInfinity coercion (runs valueOf/toString, throws
// TypeError on Symbol/BigInt) followed by the 0 <= index <= 2^53-1 range check.
// Returns false with a pending throw on an abrupt coercion or out-of-range index.
static bool mal_array_buffer_to_index(MalVm *vm, MalValue value, f64 *out) {
    if (mal_value_is_undefined(value)) {
        *out = 0;
        return true;
    }
    f64 number;
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    number = mal_ops_number_to_integer_or_infinity(number);
    if (number < 0 || number > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array buffer length");
        return false;
    }
    *out = number;
    return true;
}

// ToIndex constrained to what the u32-backed store can address. Used where the
// value is bounded by an existing buffer length and there is no separate
// allocation step (resize/transfer/slice length).
static bool mal_array_buffer_to_index_u32(MalVm *vm, MalValue value, u32 *out) {
    f64 number;
    if (!mal_array_buffer_to_index(vm, value, &number)) {
        return false;
    }
    if (number > 4294967295.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array buffer length");
        return false;
    }
    *out = (u32) number;
    return true;
}

// Read an optional { maxByteLength } option, marking the buffer resizable.
// GetArrayBufferMaxByteLengthOption: only an Object options argument is read;
// a missing/undefined maxByteLength leaves the buffer fixed.
static bool mal_array_buffer_max_option(MalVm *vm, const MalValue *args, i32 arg_count, bool *resizable, f64 *max_byte_length) {
    *resizable = false;
    *max_byte_length = 0;
    if (arg_count < 2 || !mal_value_is_object(args[1])) {
        return true;
    }

    MalValue max;
    if (!mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, "maxByteLength"), &max)) {
        return false;
    }
    if (mal_value_is_undefined(max)) {
        return true;
    }

    if (!mal_array_buffer_to_index(vm, max, max_byte_length)) {
        return false;
    }
    *resizable = true;
    return true;
}

static MalValue mal_builtin_array_buffer_construct(MalVm *vm, const MalValue *args, i32 arg_count, MalValue new_target, bool shared) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor requires 'new'");
        return mal_value_new_undefined();
    }

    // Step 2: ToIndex(length). Allows up to 2^53-1; the data-block allocation
    // below imposes the tighter storable cap, after prototype resolution.
    f64 byte_length;
    if (!mal_array_buffer_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &byte_length)) {
        return mal_value_new_undefined();
    }

    // Step 3: GetArrayBufferMaxByteLengthOption(options).
    bool resizable;
    f64 max_byte_length;
    if (!mal_array_buffer_max_option(vm, args, arg_count, &resizable, &max_byte_length)) {
        return mal_value_new_undefined();
    }
    if (resizable && byte_length > max_byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "byteLength exceeds maxByteLength");
        return mal_value_new_undefined();
    }

    // AllocateArrayBuffer step 1: OrdinaryCreateFromConstructor reads
    // new_target.prototype (which may be a throwing getter) before allocating.
    MalIntrinsic fallback = shared ? MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE : MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE;
    MalIntrinsic constructor = shared ? MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR : MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR;
    MalObject *prototype = nullptr;
    if (mal_primitive_method_protector &&
        mal_ops_same_value(new_target, vm->intrinsics[constructor])) {
        prototype = mal_value_to_object(vm->intrinsics[fallback]);
    } else if (!mal_vm_get_prototype_from_constructor(vm, new_target, fallback, &prototype)) {
        return mal_value_new_undefined();
    }

    // CreateByteDataBlock: a length the u32 store can't address (or, for a
    // resizable buffer, an unallocatable maximum) is a RangeError.
    f64 capacity = resizable ? max_byte_length : byte_length;
    if (capacity > 4294967295.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Array buffer allocation failed");
        return mal_value_new_undefined();
    }

    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap, prototype, (u32) byte_length, (u32) max_byte_length, resizable, shared);
    return mal_value_from_array_buffer_object(buffer);
}

static MalValue mal_builtin_array_buffer_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_array_buffer_construct(vm, args, arg_count, new_target, false);
}

static MalValue mal_builtin_shared_array_buffer_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_array_buffer_construct(vm, args, arg_count, new_target, true);
}

static MalArrayBufferObject *mal_builtin_array_buffer_this(MalVm *vm, MalValue this_value, bool shared) {
    if (!mal_value_is_array_buffer_object(this_value) || mal_value_to_array_buffer_object(this_value)->shared != shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an ArrayBuffer");
        return nullptr;
    }
    return mal_value_to_array_buffer_object(this_value);
}

static MalValue mal_builtin_array_buffer_is_view(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) new_target;
    MalValue arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    return mal_value_new_boolean(mal_value_is_typed_array_object(arg) || mal_value_is_data_view_object(arg));
}

static MalValue mal_builtin_array_buffer_byte_length_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) buffer->byte_length);
}

static MalValue mal_builtin_array_buffer_max_byte_length_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    // A detached buffer reports a maxByteLength of 0.
    if (buffer->detached) {
        return mal_value_from_i32(0);
    }
    return mal_value_from_i32((i32) buffer->max_byte_length);
}

static MalValue mal_builtin_array_buffer_resizable_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(buffer->resizable);
}

static MalValue mal_builtin_array_buffer_detached_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(buffer->detached);
}

// Relative-index clamp shared by slice args. Coerces value through full
// ToIntegerOrInfinity (running valueOf/toString); a throw propagates via the
// returned false. Negative values count from the end, all clamped to [0,length].
static bool mal_array_buffer_clamp(MalVm *vm, MalValue value, u32 length, u32 fallback, u32 *out) {
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

// SpeciesConstructor(O, defaultConstructor): read O.constructor; undefined means
// the default. A non-undefined, non-object constructor is a TypeError. Then read
// constructor[@@species]: undefined/null means default, a non-constructor is a
// TypeError. Returns false with a pending throw on any abrupt step; *out holds
// the resolved constructor value on success.
static bool mal_array_buffer_default_species(
    MalVm *vm, MalValue object, MalIntrinsic default_ctor
) {
    if (!mal_primitive_method_protector ||
        !mal_value_is_array_buffer_object(object)) {
        return false;
    }
    MalIntrinsic prototype =
        default_ctor == MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR
            ? MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE
            : MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE;
    MalObject *receiver = mal_value_to_object(object);
    return receiver->prototype ==
            mal_value_to_object(vm->intrinsics[prototype]) &&
        !mal_object_get_own(
            receiver,
            mal_intrinsic_string_key(vm, "constructor")).present;
}

static bool mal_array_buffer_species_constructor(MalVm *vm, MalValue object, MalIntrinsic default_ctor, MalValue *out) {
    if (mal_array_buffer_default_species(vm, object, default_ctor)) {
        // The watched prototype/constructor chain still selects the builtin
        // species, and the builtin getter itself has no side effects.
        *out = vm->intrinsics[default_ctor];
        return true;
    }
    MalValue constructor;
    if (!mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, "constructor"), &constructor)) {
        return false;
    }
    if (mal_value_is_undefined(constructor)) {
        *out = vm->intrinsics[default_ctor];
        return true;
    }
    if (!mal_value_is_object(constructor)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "constructor is not an object");
        return false;
    }

    MalValue species;
    if (!mal_vm_get_property(vm, constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &species)) {
        return false;
    }
    if (mal_value_is_undefined(species) || mal_value_is_null(species)) {
        *out = vm->intrinsics[default_ctor];
        return true;
    }
    if (!mal_value_is_callable(species)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "constructor[Symbol.species] is not a constructor");
        return false;
    }
    *out = species;
    return true;
}

static MalValue mal_builtin_array_buffer_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot slice a detached ArrayBuffer");
        return mal_value_new_undefined();
    }

    // ToInteger(start) must run before ToInteger(end).
    u32 length = buffer->byte_length;
    u32 start;
    if (!mal_array_buffer_clamp(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_array_buffer_clamp(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    u32 new_length = end > start ? end - start : 0;

    // SpeciesConstructor(O, %ArrayBuffer%), then Construct(ctor, «newLen»).
    MalValue ctor;
    if (!mal_array_buffer_species_constructor(vm, this_value, MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR, &ctor)) {
        return mal_value_new_undefined();
    }
    MalValue result_value;
    bool direct_result =
        ctor == vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR];
    if (direct_result) {
        result_value = mal_value_from_array_buffer_object(
            mal_array_buffer_object_new_uninitialized(
                &vm->heap,
                mal_value_to_object(
                    vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
                new_length, new_length, false, false));
    } else {
        MalValue len_arg = mal_value_from_i32((i32) new_length);
        MalCompletion completion =
            mal_vm_construct_value(vm, ctor, &len_arg, 1);
        if (completion.kind == MAL_COMPLETION_THROW) {
            vm->completion = completion;
            return mal_value_new_undefined();
        }
        result_value = completion.value;
    }

    // The constructed value must itself be a (non-shared, non-detached) ArrayBuffer
    // at least newLen bytes long, and distinct from the source.
    if (!mal_value_is_array_buffer_object(result_value) ||
        mal_value_to_array_buffer_object(result_value)->shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor did not return an ArrayBuffer");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *result = mal_value_to_array_buffer_object(result_value);
    if (result == buffer) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned the source ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (result->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (result->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned an immutable ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (result->byte_length < new_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned a too-small ArrayBuffer");
        return mal_value_new_undefined();
    }

    // The constructor may have detached or shrunk the source while running.
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Source ArrayBuffer was detached during slice");
        return mal_value_new_undefined();
    }
    if (new_length > 0) {
        u32 available = buffer->byte_length > start ? buffer->byte_length - start : 0;
        u32 copy = new_length < available ? new_length : available;
        if (copy > 0) {
            memcpy(result->data, buffer->data + start, copy);
        }
        if (direct_result && copy < new_length) {
            memset(result->data + copy, 0, new_length - copy);
        }
    }
    return result_value;
}

static MalValue mal_builtin_array_buffer_resize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    // RequireInternalSlot([[ArrayBufferMaxByteLength]]): a non-resizable buffer
    // lacks the slot, so resize on it is a TypeError (not a RangeError).
    if (!buffer->resizable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "ArrayBuffer is not resizable");
        return mal_value_new_undefined();
    }

    // ToIntegerOrInfinity(newLength) runs before the detached check, and may
    // itself run user code that detaches the buffer (spec: one detach check
    // after argument coercion).
    u32 new_length;
    if (!mal_array_buffer_to_index_u32(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &new_length)) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot resize a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (!mal_array_buffer_object_resize(buffer, new_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Resize length exceeds maxByteLength");
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static MalValue mal_builtin_array_buffer_transfer_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool preserve_resizability) {
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    // newLength: undefined keeps the current byte length; otherwise ToIndex (may
    // run user code that detaches the source). The detached/immutable checks
    // follow the coercion per ArrayBufferCopyAndDetach.
    u32 new_length = buffer->byte_length;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0]) &&
        !mal_array_buffer_to_index_u32(vm, args[0], &new_length)) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot transfer a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot transfer an immutable ArrayBuffer");
        return mal_value_new_undefined();
    }

    // transfer preserves resizability (and the source maxByteLength);
    // transferToFixedLength always yields a fixed-length buffer.
    bool resizable = preserve_resizability && buffer->resizable;
    u32 max_byte_length = resizable ? buffer->max_byte_length : new_length;
    if (resizable && new_length > max_byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Transfer length exceeds maxByteLength");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    if (new_length <= buffer->allocation_capacity &&
        max_byte_length <= buffer->allocation_capacity) {
        MalArrayBufferObject *result = mal_array_buffer_object_move_store(
            &vm->heap, prototype, buffer, new_length, max_byte_length,
            resizable, false);
        return mal_value_from_array_buffer_object(result);
    }

    MalArrayBufferObject *result = mal_array_buffer_object_new_uninitialized(
        &vm->heap, prototype, new_length, max_byte_length, resizable, false);
    // The contents move, so the scrub-before-release contract moves with them:
    // transferring a derived key must not leave an unscrubbed copy behind.
    result->sensitive = buffer->sensitive;
    u32 copy = new_length < buffer->byte_length ? new_length : buffer->byte_length;
    if (copy > 0) {
        memcpy(result->data, buffer->data, copy);
    }
    if (new_length > copy) {
        memset(result->data + copy, 0, new_length - copy);
    }
    mal_array_buffer_object_detach(buffer);
    return mal_value_from_array_buffer_object(result);
}

static MalValue mal_builtin_array_buffer_transfer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_builtin_array_buffer_transfer_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_array_buffer_transfer_to_fixed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_builtin_array_buffer_transfer_impl(vm, this_value, args, arg_count, false);
}

// get ArrayBuffer.prototype.immutable: requires [[ArrayBufferData]] and a
// non-shared buffer; reports the [[ArrayBufferIsImmutable]] marker.
static MalValue mal_builtin_array_buffer_immutable_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(buffer->immutable);
}

// ArrayBuffer.prototype.transferToImmutable([newLength]): copy (and optionally
// resize) the bytes into a fresh immutable, fixed-length buffer and detach the
// source.
static MalValue mal_builtin_array_buffer_transfer_to_immutable(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    u32 new_length = buffer->byte_length;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0]) &&
        !mal_array_buffer_to_index_u32(vm, args[0], &new_length)) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot transfer a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot transfer an immutable ArrayBuffer");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    if (new_length <= buffer->allocation_capacity) {
        MalArrayBufferObject *result = mal_array_buffer_object_move_store(
            &vm->heap, prototype, buffer, new_length, new_length,
            false, true);
        return mal_value_from_array_buffer_object(result);
    }

    MalArrayBufferObject *result = mal_array_buffer_object_new_uninitialized(
        &vm->heap, prototype,
        new_length, new_length, false, false);
    result->immutable = true;
    result->sensitive = buffer->sensitive;
    u32 copy = new_length < buffer->byte_length ? new_length : buffer->byte_length;
    if (copy > 0) {
        memcpy(result->data, buffer->data, copy);
    }
    if (new_length > copy) {
        memset(result->data + copy, 0, new_length - copy);
    }
    mal_array_buffer_object_detach(buffer);
    return mal_value_from_array_buffer_object(result);
}

// ArrayBuffer.prototype.sliceToImmutable([start, end]): copy the [start, end)
// byte range into a fresh immutable buffer; the source is left intact.
static MalValue mal_builtin_array_buffer_slice_to_immutable(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot slice a detached ArrayBuffer");
        return mal_value_new_undefined();
    }

    u32 length = buffer->byte_length;
    u32 first;
    u32 final;
    if (!mal_array_buffer_clamp(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &first)) {
        return mal_value_new_undefined();
    }
    if (!mal_array_buffer_clamp(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length, &final)) {
        return mal_value_new_undefined();
    }

    // Argument coercion may have detached or shrunk the source.
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Source ArrayBuffer was detached during slice");
        return mal_value_new_undefined();
    }
    if (buffer->byte_length < final) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Source ArrayBuffer shrank below the resolved end");
        return mal_value_new_undefined();
    }
    u32 new_length = final > first ? final - first : 0;

    MalArrayBufferObject *result = mal_array_buffer_object_new_uninitialized(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        new_length, new_length, false, false
    );
    result->immutable = true;
    result->sensitive = buffer->sensitive;
    if (new_length > 0) {
        memcpy(result->data, buffer->data + first, new_length);
    }
    return mal_value_from_array_buffer_object(result);
}

static void mal_builtin_array_buffer_define_getter(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback getter) {
    // Built-in accessor functions have "get " prepended to the property name.
    byte get_name[64];
    snprintf((char *) get_name, sizeof(get_name), "get %s", name);
    mal_intrinsic_define_getter(
        vm, object, name, get_name, getter, MAL_PROPERTY_CONFIGURABLE);
}

// ---- SharedArrayBuffer.prototype accessors/methods (shared brand) ----

static MalValue mal_shared_array_buffer_byte_length_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, true);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) buffer->byte_length);
}

static MalValue mal_shared_array_buffer_max_byte_length_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, true);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) buffer->max_byte_length);
}

static MalValue mal_shared_array_buffer_growable_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, true);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(buffer->resizable);
}

// SharedArrayBuffer.prototype.grow(newLength): grow-only (never shrinks, never
// detaches). A non-growable buffer is a TypeError; a length below the current
// size or above maxByteLength is a RangeError.
static MalValue mal_shared_array_buffer_grow(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, true);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    if (!buffer->resizable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "SharedArrayBuffer is not growable");
        return mal_value_new_undefined();
    }
    u32 new_length;
    if (!mal_array_buffer_to_index_u32(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &new_length)) {
        return mal_value_new_undefined();
    }
    if (new_length < buffer->byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "SharedArrayBuffer cannot shrink");
        return mal_value_new_undefined();
    }
    if (!mal_array_buffer_object_resize(buffer, new_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Grow length exceeds maxByteLength");
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

// SharedArrayBuffer.prototype.slice(start, end): like ArrayBuffer.prototype.slice
// but the species default is %SharedArrayBuffer% and the result must be a
// distinct SharedArrayBuffer.
static MalValue mal_shared_array_buffer_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, true);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = buffer->byte_length;
    u32 start;
    if (!mal_array_buffer_clamp(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0, &start)) {
        return mal_value_new_undefined();
    }
    u32 end;
    if (!mal_array_buffer_clamp(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    u32 new_length = end > start ? end - start : 0;

    MalValue ctor;
    if (!mal_array_buffer_species_constructor(vm, this_value, MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR, &ctor)) {
        return mal_value_new_undefined();
    }
    MalValue result_value;
    bool direct_result =
        ctor == vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR];
    if (direct_result) {
        result_value = mal_value_from_array_buffer_object(
            mal_array_buffer_object_new_uninitialized(
                &vm->heap,
                mal_value_to_object(
                    vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE]),
                new_length, new_length, false, true));
    } else {
        MalValue len_arg = mal_value_from_i32((i32) new_length);
        MalCompletion completion =
            mal_vm_construct_value(vm, ctor, &len_arg, 1);
        if (completion.kind == MAL_COMPLETION_THROW) {
            vm->completion = completion;
            return mal_value_new_undefined();
        }
        result_value = completion.value;
    }
    if (!mal_value_is_array_buffer_object(result_value) || !mal_value_to_array_buffer_object(result_value)->shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Species constructor did not return a SharedArrayBuffer");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *result = mal_value_to_array_buffer_object(result_value);
    if (result == buffer) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned the source buffer");
        return mal_value_new_undefined();
    }
    if (result->byte_length < new_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Species constructor returned a too-small buffer");
        return mal_value_new_undefined();
    }
    if (new_length > 0) {
        u32 available = buffer->byte_length > start ? buffer->byte_length - start : 0;
        u32 copy = new_length < available ? new_length : available;
        if (copy > 0) {
            memcpy(result->data, buffer->data + start, copy);
        }
        if (direct_result && copy < new_length) {
            memset(result->data + copy, 0, new_length - copy);
        }
    }
    return result_value;
}

void mal_builtin_array_buffer_install(MalVm *vm) {
    MalObject *object_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // ArrayBuffer
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "ArrayBuffer"), 1, mal_builtin_array_buffer_constructor);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "isView", 1, mal_builtin_array_buffer_is_view);
    mal_intrinsic_define_species(vm, (MalObject *) constructor);

    mal_builtin_array_buffer_define_getter(vm, prototype, "byteLength", mal_builtin_array_buffer_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "maxByteLength", mal_builtin_array_buffer_max_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "resizable", mal_builtin_array_buffer_resizable_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "detached", mal_builtin_array_buffer_detached_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "immutable", mal_builtin_array_buffer_immutable_getter);
    mal_intrinsic_define_method_n(vm, prototype, "slice", 2, mal_builtin_array_buffer_slice);
    mal_intrinsic_define_method_n(vm, prototype, "sliceToImmutable", 2, mal_builtin_array_buffer_slice_to_immutable);
    mal_intrinsic_define_method_n(vm, prototype, "resize", 1, mal_builtin_array_buffer_resize);
    mal_intrinsic_define_method_n(vm, prototype, "transfer", 0, mal_builtin_array_buffer_transfer);
    mal_intrinsic_define_method_n(vm, prototype, "transferToFixedLength", 0, mal_builtin_array_buffer_transfer_to_fixed);
    mal_intrinsic_define_method_n(vm, prototype, "transferToImmutable", 0, mal_builtin_array_buffer_transfer_to_immutable);

    MalPropertyDesc tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "ArrayBuffer")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);

    // SharedArrayBuffer (minimal: same shape, never detached, growable via grow)
    MalObject *shared_prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *shared_constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "SharedArrayBuffer"), 1, mal_builtin_shared_array_buffer_constructor);
    vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR] = mal_value_from_native_function_object(shared_constructor);
    vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE] = mal_value_from_object(shared_prototype);

    mal_intrinsic_define_data(vm, (MalObject *) shared_constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, shared_prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_species(vm, (MalObject *) shared_constructor);

    mal_builtin_array_buffer_define_getter(vm, shared_prototype, "byteLength", mal_shared_array_buffer_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, shared_prototype, "maxByteLength", mal_shared_array_buffer_max_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, shared_prototype, "growable", mal_shared_array_buffer_growable_getter);
    mal_intrinsic_define_method_n(vm, shared_prototype, "grow", 1, mal_shared_array_buffer_grow);
    mal_intrinsic_define_method_n(vm, shared_prototype, "slice", 2, mal_shared_array_buffer_slice);

    MalPropertyDesc shared_tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "SharedArrayBuffer")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(shared_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &shared_tag);
}

#include "generated/known_native_builtin_array_buffer_c.inc"
