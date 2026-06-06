#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Error constructor hierarchy (Error, TypeError, RangeError,
 * ReferenceError, SyntaxError) and install the Error builtins.
 */
void mal_builtin_error_install(MalVm *vm);
