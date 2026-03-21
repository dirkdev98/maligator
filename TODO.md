# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point once we compile and run most JS.

- [ ] Add `src/compiler/aot-context.ts` to hold module id, symbol counters, label counters, diagnostics, and compile options.
- [ ] Add `src/compiler/runtime-symbols.ts` to centralize runtime C symbol names/signatures (`mal_ops_add`, thread window helpers, print helper).
- [ ] Add `REG_CAPACITY` and `reg_top` to `runtime/src/thread.h` so register windows can be allocated at runtime.
- [ ] Implement `mal_thread_push_window(size, *base)` in `runtime/src/thread.c` to set `base = reg_top` and increment `reg_top` by `size`.
- [ ] Implement `mal_thread_pop_window(size)` in `runtime/src/thread.c` to decrement `reg_top` by `size`.
- [ ] Add overflow/underflow checks in thread window push/pop and return `MAL_THROW` on invalid operations.
- [ ] Add `src/compiler/aot-entry.ts` command that accepts input JS path + output C path and runs parse -> scope analysis -> C emission.
- [ ] Add `src/compiler/emit-c.ts` that writes C in fixed order: includes, globals, forward declarations, function definitions, module init, module entry, optional main.
- [ ] Add AST dispatch loop in `src/compiler/emit-c.ts` that walks the program body and routes each node to `emit-c-expr.ts`, `emit-c-stmt.ts`, or `emit-c-fn.ts` based on node type.
- [ ] Add throw-check helper in `src/compiler/emit-c.ts` that emits `if (status != MAL_NORMAL) goto bail;` after every call to a `MalResult`-returning function, used by all emit-c-\*.ts files.
- [ ] Define emitted storage classes: C locals for ephemeral temps, thread->registers[base + ...] for ABI/result passing, MalEnv slots for captured bindings.
- [ ] Add `src/compiler/emit-c-expr.ts` lowering for `NumericLiteral` to `mal_value_from_i32(...)` writes into C local variables.
- [ ] Add `BooleanLiteral`, `NullLiteral`, and `Identifier[undefined]` lowering in `src/compiler/emit-c-expr.ts` to emit `MAL_VALUE_TRUE`/`MAL_VALUE_FALSE`, `MAL_VALUE_NULL`, and `MAL_VALUE_UNDEFINED` from `runtime/src/value.h` constants.
- [ ] Add `src/compiler/emit-c-expr.ts` lowering for `BinaryExpression (+)` to `mal_ops_add(thread, env, &thread->registers[base + out], thread->registers[base + left], thread->registers[base + right])`.
- [ ] Add `src/compiler/emit-c-stmt.ts` lowering for `VariableDeclaration` to a register write (`thread->registers[base + rN] = <init expr>`) and `ExpressionStatement` to evaluate the expression discarding the result.
- [ ] Add `AssignmentExpression` lowering in `src/compiler/emit-c-expr.ts` to write the RHS value into the register or env slot assigned to the target binding.
- [ ] Emit `module_init_<moduleId>(MalThread *thread, MalEnv *env)` in `src/compiler/emit-c.ts` to hold hoisted `var`/`function` bindings, starting with an empty body.
- [ ] Emit `module_entry_<moduleId>(MalThread *thread, MalEnv *env, size base)` in `src/compiler/emit-c.ts` to execute top-level statements and write the final expression result to `thread->registers[base + resultReg]`.
- [ ] Emit `main()` in `src/compiler/emit-c.ts` standalone mode that stack-allocates `MalThread` + `MalEnv`, calls `module_init`, `mal_thread_push_window`, `module_entry`, reads `thread.registers[base + resultReg]`, calls `mal_print(result)`, and `mal_thread_pop_window`.
- [ ] Add `scripts/aot-compile-run.sh` that takes a JS file path, runs `aot-entry.ts` to produce C, compiles it with clang against `runtime/`, and executes the resulting binary.
- [ ] Add F64 coercion to `mal_ops_add` in `runtime/src/value_ops.c` so mixed int32/f64 operands promote to f64 instead of returning `MAL_THROW`.
- [ ] Add `mal_ops_sub(MalThread*, MalEnv*, MalValue*, MalValue, MalValue)` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` with int32 fast path and f64 fallback.
- [ ] Add `mal_ops_mul(MalThread*, MalEnv*, MalValue*, MalValue, MalValue)` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` with int32 fast path and f64 fallback.
- [ ] Add `BinaryExpression (-)` and `BinaryExpression (*)` lowering in `src/compiler/emit-c-expr.ts` using `mal_ops_sub` and `mal_ops_mul`.
- [ ] Update `mal_value_to_boolean` in `runtime/src/value.c` to implement JS truthiness: `0`, `-0`, `NaN`, `null`, `undefined`, `false` return false; everything else returns true. Currently only returns true for `MAL_VALUE_TRUE`.
- [ ] Add `IfStatement` lowering in `src/compiler/emit-c-stmt.ts` by emitting `if (mal_value_to_boolean(cond))` for the consequent block and an `else` block for the alternate, using C block scoping.
- [ ] Add `WhileStatement` lowering in `src/compiler/emit-c-stmt.ts` by emitting `lbl_<id>_head:`, `if (!mal_value_to_boolean(cond)) goto lbl_<id>_exit;`, body, `goto lbl_<id>_head;`, `lbl_<id>_exit:`, with `break` mapping to `goto lbl_<id>_exit` and `continue` to `goto lbl_<id>_head`.
- [ ] Add `ForStatement` lowering in `src/compiler/emit-c-stmt.ts` by emitting init, `lbl_<id>_head:`, test, body, update, `goto lbl_<id>_head;`, `lbl_<id>_exit:`, with `break`/`continue` mapped to the same label scheme as `WhileStatement`.
- [ ] Add `ReturnStatement` lowering in `src/compiler/emit-c-stmt.ts` to write the return expression to `thread->registers[base + resultReg]` and emit `return MAL_RETURN;`, plus implicit end-of-function `thread->registers[base + resultReg] = MAL_VALUE_UNDEFINED; return MAL_NORMAL;` for functions without explicit return.
- [ ] Add `mal_ops_strict_equal(MalValue, MalValue) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` returning `MAL_VALUE_TRUE`/`MAL_VALUE_FALSE`.
- [ ] Add `mal_ops_strict_not_equal(MalValue, MalValue) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c`.
- [ ] Add `mal_ops_less_than(MalValue, MalValue) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` with numeric comparison.
- [ ] Add `mal_ops_greater_than(MalValue, MalValue) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` with numeric comparison.
- [ ] Add `mal_ops_less_equal(MalValue, MalValue) -> MalValue` and `mal_ops_greater_equal(MalValue, MalValue) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c`.
- [ ] Add `BinaryExpression (===, !==, <, >, <=, >=)` lowering in `src/compiler/emit-c-expr.ts` using the corresponding `mal_ops_*` functions.
- [ ] Add `UnaryExpression` lowering in `src/compiler/emit-c-expr.ts` for `-x` (negate), `!x` (`mal_value_to_boolean` then invert), `typeof x` (type tag dispatch returning a string MalValue).
- [ ] Add `LogicalExpression` lowering in `src/compiler/emit-c-expr.ts` for `&&` and `||` with short-circuit evaluation (emit as C if/else with temporaries, not C `&&`/`||` which don't preserve JS value semantics).
- [ ] Add `ConditionalExpression` lowering in `src/compiler/emit-c-expr.ts` by emitting `if (mal_value_to_boolean(test))` with consequent and alternate writing to the same result register.
- [ ] Add `src/compiler/emit-c-fn.ts` to emit one C function per JS function declaration with signature `fn_<id>(MalThread *thread, MalEnv *env, size base)`, writing the return value to `thread->registers[base + resultReg]`.
- [ ] Add parameter and local access in `src/compiler/emit-c-fn.ts` by reading params from `thread->registers[base + paramReg]` and writing locals/temps to `thread->registers[base + localReg]`.
- [ ] Add direct function call lowering in `src/compiler/emit-c-fn.ts`: evaluate args into caller registers, `mal_thread_push_window(callee.maxRegs, &calleeBase)`, write args to `thread->registers[calleeBase + paramReg]`, call `fn_<callee>(thread, env, calleeBase)`, `mal_thread_pop_window(callee.maxRegs)`, read result from `thread->registers[calleeBase + resultReg]`.
- [ ] Extend `runtime/src/env.c` with a `MalValue *slots` array and `size slot_count` field, and implement `mal_env_get(MalEnv*, size slot) -> MalValue` and `mal_env_set(MalEnv*, size slot, MalValue)`.
- [ ] Add `MalClosure` struct with `MalResult (*fn_ptr)(MalThread*, MalEnv*, size)` and `MalEnv *env` fields to `runtime/src/closure.h` + `runtime/src/closure.c`, with `mal_closure_new(fn_ptr, env)` returning a heap-allocated `MalValue`.
- [ ] Add closure emission in `src/compiler/emit-c-fn.ts` that emits `mal_env_new(parent, slot_count)` + `mal_env_set(env, slot, value)` for captured bindings at closure creation, and `mal_env_get(env, slot)` for captured variable reads inside the closure body.
- [ ] Add indirect call lowering in `src/compiler/emit-c-fn.ts` for `CallExpression` where the callee is not a direct function declaration: extract `fn_ptr` and `env` from the `MalClosure`, then call via the function pointer.
- [ ] Add `mal_get_global(const char *name) -> MalValue` to `runtime/src/value_ops.h` + `runtime/src/value_ops.c` with a static lookup table, and add `Identifier` emission in `src/compiler/emit-c-expr.ts` that emits `mal_get_global("name")` for identifiers classified as `global` by scope analysis.
- [ ] Add `mal_object_new(MalThread*)` and `mal_object_set(MalValue, const char*, MalValue)` to `runtime/src/object.h` + `runtime/src/object.c`, and add `ObjectExpression` lowering in `src/compiler/emit-c-expr.ts` that allocates via `mal_object_new` then calls `mal_object_set` per property.
- [ ] Add `mal_array_new(MalThread*, size)` and `mal_array_set(MalValue, size, MalValue)` to `runtime/src/array.h` + `runtime/src/array.c`, and add `ArrayExpression` lowering in `src/compiler/emit-c-expr.ts` that allocates via `mal_array_new(length)` then calls `mal_array_set` per element.
- [ ] Add `runtime/src/runtime.h` as umbrella include that re-exports `value.h`, `value_ops.h`, `thread.h`, `env.h`, `closure.h`, `object.h`, `array.h`, and `print.h` so generated C only needs `#include "runtime.h"`.
- [ ] Add AOT mode to `scripts/test262.ts` that compiles allowlisted tests to C via `aot-entry.ts`, links against `runtime/`, executes the binary, and compares stdout/exit code.
- [ ] Create `src/test262/aot-allowlist.txt` with 5-10 test paths that only require shipped features (`NumericLiteral`, `+`, `-`, `*`, comparisons, return, simple local calls).
- [ ] Add AOT progress files `src/test262/aot-passing.txt` and `src/test262/aot-known-failing.txt` and update them after each AOT run.
- [ ] Add CI job to run AOT allowlist and fail only on regressions within that allowlist.
- [ ] Extend ScopeAnalysis output to produce return-path metadata (`explicitReturn`, `implicitEnd`, `throwPath`).
- [ ] Extend ScopeAnalysis output to produce resolved label ids for loop `break` and `continue` targets.

### You never know ideas

- Erlang/OTP style message passing & cooperative scheduler.
- GUI work
- Deploying to AWS Lambda
- Compile to bare-metal maybe?
