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
    MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_URI_ERROR_PROTOTYPE,
    MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR,
    MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE,
    MAL_INTRINSIC_STRING_CONSTRUCTOR,
    MAL_INTRINSIC_STRING_PROTOTYPE,
    MAL_INTRINSIC_NUMBER_CONSTRUCTOR,
    MAL_INTRINSIC_NUMBER_PROTOTYPE,
    MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR,
    MAL_INTRINSIC_BOOLEAN_PROTOTYPE,
    MAL_INTRINSIC_SYMBOL_CONSTRUCTOR,
    MAL_INTRINSIC_SYMBOL_PROTOTYPE,
    // Well-known symbol values (Table 1 of the spec), referenced by both the
    // VM and builtin install passes.
    MAL_INTRINSIC_SYMBOL_ITERATOR,
    MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR,
    MAL_INTRINSIC_SYMBOL_TO_STRING_TAG,
    MAL_INTRINSIC_SYMBOL_HAS_INSTANCE,
    MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE,
    MAL_INTRINSIC_SYMBOL_SPECIES,
    MAL_INTRINSIC_SYMBOL_IS_CONCAT_SPREADABLE,
    MAL_INTRINSIC_SYMBOL_MATCH,
    MAL_INTRINSIC_SYMBOL_MATCH_ALL,
    MAL_INTRINSIC_SYMBOL_REPLACE,
    MAL_INTRINSIC_SYMBOL_SEARCH,
    MAL_INTRINSIC_SYMBOL_SPLIT,
    MAL_INTRINSIC_SYMBOL_UNSCOPABLES,
    MAL_INTRINSIC_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_MAP_PROTOTYPE,
    MAL_INTRINSIC_SET_CONSTRUCTOR,
    MAL_INTRINSIC_SET_PROTOTYPE,
    MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_MAP_PROTOTYPE,
    MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
    MAL_INTRINSIC_WEAK_SET_PROTOTYPE,
    MAL_INTRINSIC_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE,
    MAL_INTRINSIC_GENERATOR_PROTOTYPE,
    // %GeneratorFunction.prototype% (%Generator%): the [[Prototype]] of
    // generator function objects; its own .prototype is %GeneratorPrototype%.
    MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE,
    MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR,
    MAL_INTRINSIC_PARSE_INT,
    MAL_INTRINSIC_PARSE_FLOAT,
    MAL_INTRINSIC_IS_NAN,
    MAL_INTRINSIC_IS_FINITE,
    MAL_INTRINSIC_MATH,
    MAL_INTRINSIC_JSON,
    MAL_INTRINSIC_CONSOLE,
    MAL_INTRINSIC_GLOBAL_THIS,
    MAL_INTRINSIC_NAN_VALUE,
    MAL_INTRINSIC_INFINITY_VALUE,
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
 * Build a symbol property key from a well-known symbol intrinsic slot.
 */
MalKey mal_intrinsic_symbol_key(MalVm *vm, MalIntrinsic symbol_slot);

/**
 * Create a native function and define it as a writable + configurable method
 * under a well-known symbol key. display_name becomes the function name
 * (e.g. "[Symbol.iterator]").
 */
MalValue mal_intrinsic_define_symbol_method(
    MalVm *vm,
    MalObject *object,
    MalIntrinsic symbol_slot,
    const byte *display_name,
    MalNativeFunctionCallback callback
);

/**
 * Define the spec-shaped `get [Symbol.species]` accessor (returns the
 * receiver) on a constructor.
 */
void mal_intrinsic_define_species(MalVm *vm, MalObject *constructor);

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

/**
 * mal_vm_throw_error with an arbitrary value as the message.
 */
void mal_vm_throw_error_value(MalVm *vm, MalIntrinsic prototype_slot, MalValue message);
