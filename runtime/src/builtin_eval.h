#pragma once

#include "vm.h"

/**
 * Runtime `eval` / `new Function` (eval Phase 4).
 *
 * Registers the global `eval` function on globalThis. On first use it splices
 * the baked compiler (compiler_wire.c) into the running VM, then for each call
 * compiles the source through it, splices the result at the current bases, and
 * runs the entry on the interpreter.
 */
void mal_intrinsics_init_eval(MalVm *vm, MalObject *global_this);

/**
 * Compile `source` (a JS string value) in global scope, splice it, run it, and
 * return its completion value. Indirect eval and the `Function` constructor body
 * share this. On a parse/compile/runtime throw, sets vm->completion and returns
 * undefined.
 */
MalValue mal_vm_eval_source(MalVm *vm, MalValue source);

#if MAL_REALMS
/**
 * Evaluate a script in `realm`, returning its normal or throw completion. The
 * caller's realm is restored before return, and vm->completion matches the
 * returned completion.
 */
MalCompletion mal_realm_eval_script(MalVm *vm, MalRealm *realm, MalValue source);
#endif

/**
 * Direct eval: compile `source` so free identifiers resolve against the caller's
 * scope, then run it with `scope_object` (the caller's marshaled bindings)
 * injected as a with-scope. On a parse/compile/runtime throw, sets vm->completion
 * and returns undefined.
 */
MalValue mal_vm_eval_direct(MalVm *vm, MalValue source, MalValue scope_object, bool caller_strict,
                            bool in_param_expr, bool in_field_initializer, MalValue caller_this,
                            MalValue caller_new_target);

/**
 * Which dynamic-function constructor is assembling source — selects the wrapper
 * keyword so the body parses in the right context (yield / await allowed).
 */
typedef enum {
    MAL_DYNAMIC_FUNCTION_NORMAL,          // Function          → (function anonymous ...)
    MAL_DYNAMIC_FUNCTION_GENERATOR,       // GeneratorFunction → (function* anonymous ...)
    MAL_DYNAMIC_FUNCTION_ASYNC,           // AsyncFunction     → (async function anonymous ...)
    MAL_DYNAMIC_FUNCTION_ASYNC_GENERATOR, // AsyncGeneratorFunction → (async function* anonymous ...)
} MalDynamicFunctionKind;

/**
 * The dynamic-function constructors (`Function`, `GeneratorFunction`,
 * `AsyncFunction`, `AsyncGeneratorFunction` and their `new` forms): ToString the
 * parameter args and body, assemble `(<kind> anonymous(params){body})`, compile
 * + run it, and return the resulting function (created in global scope). On a
 * ToString or compile throw, sets vm->completion and returns undefined.
 */
MalValue mal_vm_construct_function(MalVm *vm, const MalValue *args, i32 arg_count,
                                   MalDynamicFunctionKind kind);
