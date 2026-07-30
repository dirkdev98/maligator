#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "vm.h"

/**
 * Create the String constructor and install the String builtins on
 * %String.prototype%.
 *
 * There are no wrapper objects: constructing behaves like calling and string
 * methods receive the primitive string as their this value.
 */
void mal_builtin_string_install(MalVm *vm);

/**
 * Guarded native-backend dispatch for a direct `.charCodeAt(...)` site.
 * Primitive strings with the live builtin callback and an absent or numeric position
 * read their UTF-16 code unit directly; every guard miss uses the ordinary
 * per-site cached call path unchanged.
 */
MalCompletion mal_builtin_string_char_code_at_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);
