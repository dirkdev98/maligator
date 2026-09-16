#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * Install the Set and WeakSet constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_set_install(MalVm *vm);

MalValue mal_builtin_set_add_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalValue mal_builtin_set_has_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalValue mal_builtin_set_delete_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

// Fixed-arity native entries require an exact Set receiver.
MalValue mal_builtin_set_add_value(MalVm *vm, MalValue this_value, MalValue value);
MalValue mal_builtin_set_add_number(MalVm *vm, MalValue this_value, f64 value);
bool mal_builtin_set_has_value(MalVm *vm, MalValue this_value, MalValue value);
bool mal_builtin_set_has_number(MalVm *vm, MalValue this_value, f64 value);
bool mal_builtin_set_delete_value(MalVm *vm, MalValue this_value, MalValue value);
bool mal_builtin_set_delete_number(MalVm *vm, MalValue this_value, f64 value);
