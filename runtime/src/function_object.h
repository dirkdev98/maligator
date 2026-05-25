#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;

typedef struct MalFunctionObject {
    MalObject object;
    i32 function_index;
} MalFunctionObject;

/**
 * Native callback ABI used by runtime-provided callable objects.
 */
typedef MalValue (*MalNativeFunctionCallback)(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

typedef struct MalNativeFunctionObject {
    MalObject object;
    MalString *name;
    MalNativeFunctionCallback callback;
} MalNativeFunctionObject;

/**
 * Initialize script function object state in caller-provided storage.
 */
void mal_function_object_init(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index
);

/**
 * Allocate and initialize a new script function object.
 */
MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    i32 function_index
);

/**
 * Read the VM function definition index carried by a script function object.
 */
i32 mal_function_object_function_index(const MalFunctionObject *function);

/**
 * Initialize native function object state in caller-provided storage.
 */
void mal_native_function_object_init(
    MalHeap *heap,
    MalNativeFunctionObject *function,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
);

/**
 * Allocate and initialize a new native function object.
 */
MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
);

/**
 * Return the display name attached to a native function object.
 */
MalString *mal_native_function_object_name(const MalNativeFunctionObject *function);

/**
 * Return the callback carried by a native function object.
 */
MalNativeFunctionCallback mal_native_function_object_callback(const MalNativeFunctionObject *function);
