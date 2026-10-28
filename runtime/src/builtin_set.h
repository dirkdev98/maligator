#pragma once

#include "./defaults.h"
#include "set_object.h"

typedef struct MalVm MalVm;

// Weak entries require a genuine WeakSet receiver; keys are never coerced.
bool mal_builtin_weak_set_has_key(MalValue receiver, MalValue key);
bool mal_builtin_weak_set_delete_key(MalValue receiver, MalValue key);
// Throwing entries require the captured builtin's realm to be current.
MalValue mal_builtin_weak_set_add_key(MalVm *vm, MalValue receiver, MalValue key);
// Holdable entries additionally require an Object or unregistered Symbol key.
MalValue mal_builtin_weak_set_add_holdable_key(MalValue receiver, MalValue key);

/**
 * Install the Set and WeakSet constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_set_install(MalVm *vm);

MalValue mal_builtin_set_prototype_for_each(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
);

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
bool mal_builtin_set_has_value(MalVm *vm, MalValue this_value, MalValue value);
bool mal_builtin_set_delete_value(MalVm *vm, MalValue this_value, MalValue value);
// Number-member variants for members the compiler already holds unboxed.
MalValue mal_builtin_set_add_number(MalVm *vm, MalValue this_value, f64 value);
bool mal_builtin_set_has_number(MalVm *vm, MalValue this_value, f64 value);
bool mal_builtin_set_delete_number(MalVm *vm, MalValue this_value, f64 value);
