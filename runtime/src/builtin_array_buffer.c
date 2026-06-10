#include "builtin_array_buffer.h"

#include <math.h>
#include <string.h>

#include "array_buffer_object.h"
#include "object_ops.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// ToIndex: a non-negative integer length. Returns false (with a pending throw)
// on a negative or non-integral value.
static bool mal_array_buffer_to_index(MalVm *vm, MalValue value, u32 *out) {
    f64 number = mal_ops_to_number(value);
    if (isnan(number)) {
        number = 0;
    }
    if (number < 0 || isinf(number) || trunc(number) != number || number > 4294967295.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array buffer length");
        return false;
    }
    *out = (u32) number;
    return true;
}

// Read an optional { maxByteLength } option, marking the buffer resizable.
static bool mal_array_buffer_max_option(MalVm *vm, const MalValue *args, i32 arg_count, bool *resizable, u32 *max_byte_length) {
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

static MalObject *mal_array_buffer_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    return mal_value_is_object(prototype) ? mal_value_to_object(prototype) : mal_value_to_object(vm->intrinsics[fallback]);
}

static MalValue mal_builtin_array_buffer_construct(MalVm *vm, const MalValue *args, i32 arg_count, MalValue new_target, bool shared) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor requires 'new'");
        return mal_value_new_undefined();
    }

    u32 byte_length;
    if (!mal_array_buffer_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &byte_length)) {
        return mal_value_new_undefined();
    }

    bool resizable;
    u32 max_byte_length;
    if (!mal_array_buffer_max_option(vm, args, arg_count, &resizable, &max_byte_length)) {
        return mal_value_new_undefined();
    }
    if (resizable && byte_length > max_byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "byteLength exceeds maxByteLength");
        return mal_value_new_undefined();
    }

    MalIntrinsic fallback = shared ? MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE : MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE;
    MalObject *prototype = mal_array_buffer_resolve_prototype(vm, new_target, fallback);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }

    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap, prototype, byte_length, max_byte_length, resizable, shared);
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

// Relative-index clamp shared by slice/resize args.
static u32 mal_array_buffer_clamp(MalValue value, u32 length, u32 fallback) {
    if (mal_value_is_undefined(value)) {
        return fallback;
    }
    f64 number = mal_ops_to_number(value);
    if (isnan(number)) {
        number = 0;
    }
    if (number < 0) {
        number += length;
        return number < 0 ? 0 : (u32) number;
    }
    return number > length ? length : (u32) number;
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

    u32 length = buffer->byte_length;
    u32 start = mal_array_buffer_clamp(arg_count >= 1 ? args[0] : mal_value_new_undefined(), length, 0);
    u32 end = mal_array_buffer_clamp(arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, length);
    u32 new_length = end > start ? end - start : 0;

    MalArrayBufferObject *result = mal_array_buffer_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        new_length,
        new_length,
        false,
        false
    );
    if (new_length > 0 && !buffer->detached) {
        memcpy(result->data, buffer->data + start, new_length);
    }
    return mal_value_from_array_buffer_object(result);
}

static MalValue mal_builtin_array_buffer_resize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }

    u32 new_length;
    if (!mal_array_buffer_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &new_length)) {
        return mal_value_new_undefined();
    }
    if (!mal_array_buffer_object_resize(buffer, new_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid resize: buffer is not resizable or length exceeds maximum");
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static MalValue mal_builtin_array_buffer_transfer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalArrayBufferObject *buffer = mal_builtin_array_buffer_this(vm, this_value, false);
    if (buffer == nullptr) {
        return mal_value_new_undefined();
    }
    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot transfer a detached ArrayBuffer");
        return mal_value_new_undefined();
    }

    u32 new_length = buffer->byte_length;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0]) &&
        !mal_array_buffer_to_index(vm, args[0], &new_length)) {
        return mal_value_new_undefined();
    }

    MalArrayBufferObject *result = mal_array_buffer_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        new_length,
        new_length,
        false,
        false
    );
    u32 copy = new_length < buffer->byte_length ? new_length : buffer->byte_length;
    if (copy > 0) {
        memcpy(result->data, buffer->data, copy);
    }
    mal_array_buffer_object_detach(buffer);
    return mal_value_from_array_buffer_object(result);
}

// @@species getter returns the receiver (the default behavior).
static MalValue mal_builtin_array_buffer_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return this_value;
}

static void mal_builtin_array_buffer_define_getter(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback getter) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, name),
            getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(object, mal_intrinsic_string_key(vm, name), &desc);
}

static void mal_builtin_array_buffer_define_species(MalVm *vm, MalObject *constructor) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "get [Symbol.species]"),
            mal_builtin_array_buffer_species_getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &desc);
}

void mal_builtin_array_buffer_install(MalVm *vm) {
    MalObject *object_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // ArrayBuffer
    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "ArrayBuffer"), mal_builtin_array_buffer_constructor);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method(vm, (MalObject *) constructor, "isView", mal_builtin_array_buffer_is_view);
    mal_builtin_array_buffer_define_species(vm, (MalObject *) constructor);

    mal_builtin_array_buffer_define_getter(vm, prototype, "byteLength", mal_builtin_array_buffer_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "maxByteLength", mal_builtin_array_buffer_max_byte_length_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "resizable", mal_builtin_array_buffer_resizable_getter);
    mal_builtin_array_buffer_define_getter(vm, prototype, "detached", mal_builtin_array_buffer_detached_getter);
    mal_intrinsic_define_method(vm, prototype, "slice", mal_builtin_array_buffer_slice);
    mal_intrinsic_define_method(vm, prototype, "resize", mal_builtin_array_buffer_resize);
    mal_intrinsic_define_method(vm, prototype, "transfer", mal_builtin_array_buffer_transfer);
    mal_intrinsic_define_method(vm, prototype, "transferToFixedLength", mal_builtin_array_buffer_transfer);

    MalPropertyDesc tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "ArrayBuffer")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);

    // SharedArrayBuffer (minimal: same shape, never detached, growable via grow)
    MalObject *shared_prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *shared_constructor = mal_native_function_object_new(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "SharedArrayBuffer"), mal_builtin_shared_array_buffer_constructor);
    vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR] = mal_value_from_native_function_object(shared_constructor);
    vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE] = mal_value_from_object(shared_prototype);

    mal_intrinsic_define_data(vm, (MalObject *) shared_constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, shared_prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc shared_tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "SharedArrayBuffer")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(shared_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &shared_tag);
}
