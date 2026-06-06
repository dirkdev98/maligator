#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the String constructor and install the String builtins on
 * %String.prototype%.
 *
 * There are no wrapper objects: constructing behaves like calling and string
 * methods receive the primitive string as their this value.
 */
void mal_builtin_string_install(MalVm *vm);
