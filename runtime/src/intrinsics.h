#pragma once

#include "./defaults.h"
#include "array_object.h"
#include "function_object.h"
#include "object_ops.h"

typedef struct MalVm MalVm;

/**
 * Well-known values created during VM bootstrap that the VM and compiler can
 * reference directly, without going through the global object.
 */
typedef enum MalIntrinsic {
    MAL_INTRINSIC_OBJECT_CONSTRUCTOR,
    MAL_INTRINSIC_OBJECT_PROTOTYPE,
    MAL_INTRINSIC_OBJECT_DEFINE_PROPERTY,
    MAL_INTRINSIC_ARRAY_CONSTRUCTOR,
    MAL_INTRINSIC_ARRAY_PROTOTYPE,
    MAL_INTRINSIC_ARRAY_PROTOTYPE_MAP,
    MAL_INTRINSIC_FUNCTION_CONSTRUCTOR,
    MAL_INTRINSIC_FUNCTION_PROTOTYPE,
    MAL_INTRINSIC_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_ERROR_PROTOTYPE,
    MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
    MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
    MAL_INTRINSIC_COUNT,
} MalIntrinsic;

/**
 * Create all intrinsic objects and install the builtins on them.
 */
void mal_intrinsics_init(MalVm *vm);

/**
 * Allocate a string from a NUL-terminated ASCII name.
 */
MalString *mal_intrinsic_ascii(MalVm *vm, const byte *name);

/**
 * Build a string property key from a NUL-terminated ASCII name.
 */
MalKey mal_intrinsic_string_key(MalVm *vm, const byte *name);

/**
 * Build a data property descriptor with the given flags.
 */
MalPropertyDesc mal_intrinsic_data_desc(MalValue value, MalPropertyFlags flags);

/**
 * Define a named data property on an intrinsic object.
 */
void mal_intrinsic_define_data(MalVm *vm, MalObject *object, const byte *name, MalValue value, MalPropertyFlags flags);

/**
 * Create a native function and define it as a writable + configurable method.
 *
 * Returns the function value so callers can additionally store it in an
 * intrinsic slot.
 */
MalValue mal_intrinsic_define_method(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback callback);

/**
 * Allocate an ordinary object backed by %Object.prototype%.
 */
MalObject *mal_intrinsic_new_object(MalVm *vm);

/**
 * Allocate an array backed by %Array.prototype% with the given length.
 */
MalArrayObject *mal_intrinsic_new_array(MalVm *vm, u32 length);

/**
 * Allocate an error backed by the given error prototype slot with the message
 * set as an own property, and set it as the VM's throw completion.
 */
void mal_vm_throw_error(MalVm *vm, MalIntrinsic prototype_slot, const byte *message);
