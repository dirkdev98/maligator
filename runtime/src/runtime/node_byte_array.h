#pragma once

#include <stdlib.h>

#include "array_buffer_object.h"
#include "gc.h"
#include "secure_scrub.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "vm.h"

static inline MalValue mal_byte_array_view(
    MalVm *vm, MalObject *prototype, MalArrayBufferObject *backing, u32 offset, u32 length, bool is_buffer
) {
    MalTypedArrayObject *array = mal_typed_array_object_new(
        &vm->heap, prototype, backing, MAL_TA_UINT8, offset, length, false);
    array->is_buffer = is_buffer;
    return mal_value_from_typed_array_object(array);
}

static inline MalValue mal_byte_array_allocate(
    MalVm *vm, MalObject *prototype, u32 length, bool initialize, bool is_buffer
) {
    MalObject *backing_prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = initialize
        ? mal_array_buffer_object_new(
            &vm->heap, backing_prototype,
            length, length, false, false)
        : mal_array_buffer_object_new_uninitialized(
            &vm->heap, backing_prototype,
            length, length, false, false, false);
    MalValue backing = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &backing, 1);
    if (length > 0 && mal_value_to_array_buffer_object(backing)->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer allocation failed");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalValue result = mal_byte_array_view(
        vm, prototype, mal_value_to_array_buffer_object(backing), 0, length, is_buffer);
    mal_gc_unroot(&root);
    return result;
}

static inline MalValue mal_byte_array_adopt(
    MalVm *vm, MalObject *prototype, byte *bytes, usize length, bool sensitive, bool is_buffer
) {
    if (length > INT32_MAX || (length > 0 && bytes == nullptr)) {
        if (sensitive) mal_secure_scrub(bytes, length);
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer allocation failed");
        return mal_value_new_undefined();
    }
    if (length == 0) {
        free(bytes);
        bytes = nullptr;
    }
    MalArrayBufferObject *backing = mal_array_buffer_object_adopt(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        bytes, (u32) length, sensitive);
    MalValue root_value = mal_value_from_array_buffer_object(backing);
    MalRootSpan root;
    mal_gc_root(&root, &root_value, 1);
    MalValue result = mal_byte_array_view(
        vm, prototype, backing, 0, (u32) length, is_buffer);
    mal_gc_unroot(&root);
    return result;
}

static inline byte *mal_byte_array_encode_utf8(const MalString *string, usize *length) {
    usize capacity = mal_string_utf8_length(string);
    *length = 0;
    byte *bytes = malloc(capacity == 0 ? 1 : capacity);
    if (bytes != nullptr) {
        mal_string_utf8_encode_into(string, bytes, capacity, nullptr, length);
    }
    return bytes;
}

static inline MalValue mal_byte_array_adopt_encoded(
    MalVm *vm, MalObject *prototype, byte *bytes, usize length, bool is_buffer
) {
    if (bytes == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer encoding allocation failed");
        return mal_value_new_undefined();
    }
    if (length > INT32_MAX) {
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer is too large");
        return mal_value_new_undefined();
    }
    return mal_byte_array_adopt(vm, prototype, bytes, length, false, is_buffer);
}

MalValue mal_node_byte_array_from_array_like(
    MalVm *vm, MalObject *prototype, MalValue source, bool is_buffer);

void mal_host_install_node_fetch_body_bytes(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
