#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Boolean constructor and install the Boolean builtins on
 * %Boolean.prototype%.
 */
void mal_builtin_boolean_install(MalVm *vm);

/** Exact locked Boolean.prototype.valueOf after primitive-receiver proof. */
MalValue mal_builtin_boolean_value_of_known(MalValue this_value);
