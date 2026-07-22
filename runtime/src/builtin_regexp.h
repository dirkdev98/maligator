#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;

/**
 * Install the RegExp constructor, RegExp.prototype (exec/test, the Symbol.*
 * protocol, the flag accessors, toString), and %RegExpStringIteratorPrototype%
 * on the VM intrinsics + globalThis.
 */
void mal_builtin_regexp_install(MalVm *vm);

/**
 * RegExpCreate(pattern, flags): allocate a RegExp with %RegExp.prototype% and
 * RegExpInitialize it. Returns the boxed RegExp, or sets a throw completion and
 * returns undefined on an invalid pattern/flags. Exposed for the compiler's
 * regex-literal lowering (mal_vm_op_create_regex) and String.prototype.
 */
MalValue mal_regexp_create(MalVm *vm, MalString *pattern, MalString *flags);

/**
 * Invoke an unmodified built-in RegExp String-protocol method without generic
 * property/call dispatch. Returns false when any observable customization means
 * the caller must use the ordinary protocol path.
 */
bool mal_regexp_try_exact_string_dispatch(
    MalVm *vm, MalValue regexp, i32 symbol_slot, MalValue string,
    const MalValue *extra, i32 extra_count, MalValue *out
);

/**
 * Handle String.prototype.matchAll's validation and exact dispatch for a
 * canonical RegExp. Returns false when observable customization requires the
 * ordinary IsRegExp / flags / protocol path.
 */
bool mal_regexp_try_canonical_match_all(
    MalVm *vm, MalValue regexp, MalValue string, MalValue *out
);

/**
 * Advance an exact RegExp String Iterator without materializing its disposable
 * IteratorResult wrapper. Returns 1 on success, 0 when generic stepping is
 * required, and -1 when the exact step threw.
 */
int mal_regexp_try_exact_iterator_step(
    MalVm *vm, MalValue iterator, MalValue next_method,
    MalValue *value_out, bool *done_out
);
