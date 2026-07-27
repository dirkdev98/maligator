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
typedef enum {
    MAL_SHADOW_REALM_EVAL_FAILURE_NONE,
    MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_PARSE,
    MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_POLICY,
    MAL_SHADOW_REALM_EVAL_FAILURE_SANITIZE,
} MalShadowRealmEvalFailure;

/**
 * Evaluate a script in `realm`, returning its normal or throw completion. The
 * caller's realm is restored before return, and vm->completion matches the
 * returned completion.
 */
MalCompletion mal_realm_eval_script(MalVm *vm, MalRealm *realm, MalValue source);

/**
 * Compile and splice primitive string `source` while `caller_realm` is current,
 * then create and run its entry closure in `target_realm`. Parse/early compiler
 * failures become a fresh caller-realm SyntaxError; a disabled-eval policy error
 * remains the caller-realm EvalError produced by the runtime gate. Other abrupt
 * completions are returned for the ShadowRealm builtin to sanitize. `failure_out`
 * explicitly identifies those cases without inspecting error prototypes. The
 * caller realm is restored and vm->completion matches the result on every exit.
 */
MalCompletion mal_shadow_realm_eval_script(MalVm *vm, MalRealm *caller_realm,
                                           MalRealm *target_realm, MalValue source,
                                           MalShadowRealmEvalFailure *failure_out);
#endif

/**
 * Direct eval: compile `source` so free identifiers resolve against the caller's
 * scope, then run it with `scope_object` (the caller's marshaled bindings)
 * injected as a with-scope. On a parse/compile/runtime throw, sets vm->completion
 * and returns undefined.
 *
 * `dirty_tracker` is a plain object, keyed the same as `scope_object`, that
 * mal_vm_op_with_set marks (own property = true) only for names actually Set
 * during this eval — the caller's writeback evidence. Pass undefined to disable.
 */
MalValue mal_vm_eval_direct(MalVm *vm, MalValue source, MalValue scope_object, bool caller_strict,
                             bool in_param_expr, bool in_field_initializer, MalValue caller_this,
                             MalValue caller_new_target, MalValue direct_eval_context,
                             MalValue dirty_tracker, MalValue persistent_scope);

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
                                   MalDynamicFunctionKind kind, MalValue new_target,
                                   MalValue constructor);
