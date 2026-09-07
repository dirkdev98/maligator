#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "vm.h"

/**
 * Install %TypedArray% / %TypedArray%.prototype and the eleven concrete
 * TypedArray constructors and prototypes.
 */
void mal_builtin_typed_array_install(MalVm *vm);

MalValue mal_builtin_typed_array_sort(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);
MalValue mal_builtin_typed_array_to_sorted(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);
