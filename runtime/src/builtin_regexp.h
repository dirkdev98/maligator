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
