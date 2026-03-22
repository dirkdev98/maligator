# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point once we compile and run most JS.

- [ ] Add a register capacity constant and a `register_base` field to `runtime/src/thread.h`.
- [ ] Add `mal_thread_init(MalThread *thread)` to `runtime/src/thread.c` to initialize `register_base`, `return_result`, and `return_value`.
- [ ] Add `mal_thread_base_push(MalThread *thread, size caller_reg_count, size callee_reg_count)` + initialize regs to undefined in `runtime/src/thread.c`.
- [ ] Add `mal_thread_base_pop(MalThread *thread, size caller_reg_count)` to `runtime/src/thread.c`.
- [ ] Add `mal_thread_get(MalThread *thread, size offset)` as a register access helper relative to `thread->register_base`.
- [ ] Add `mal_thread_set(MalThread *thread, size offset, MalValue value)` as a register write helper relative to `thread->register_base`.
- [ ] Update `src/compiler/c-comp.ts` to call `mal_thread_init(&thread)` before executing compiled code.
- [ ] Add a helper in `src/compiler/transform.ts` for checking `thread->return_result` after helper calls and compiled-function calls.
- [ ] Update top-level `ExpressionStatement` lowering in `src/compiler/transform.ts` so the final evaluated value remains in `thread->return_value`.
- [ ] Update `src/compiler/slot-allocation.ts` so function scopes assign register slots to parameters only.
- [ ] Add binding collection in `src/compiler/transform.ts` for non-param, non-captured, non-hoisted function locals.
- [ ] Emit preinitialized C local declarations for collected function locals at the start of each generated function in `src/compiler/transform.ts`.
- [ ] Extend `src/compiler/transform.ts` to emit forward declarations for compiled JS functions before module entry emission.
- [ ] Extend `src/compiler/transform.ts` to emit one C function for each JS `FunctionDeclaration`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `ReturnStatement`.
- [ ] Lower `return <expr>;` in `src/compiler/transform.ts` by evaluating the expression, assigning `thread->return_value`, setting `thread->return_result = MAL_RETURN`, and returning from the generated C function.
- [ ] Emit an implicit function epilogue in `src/compiler/transform.ts` that assigns `thread->return_value = mal_value_new_undefined()` and `thread->return_result = MAL_NORMAL`.
- [ ] Extend `runtime/src/env.h` and `runtime/src/env.c` with slot storage for env-backed bindings.
- [ ] Add `mal_env_get(MalEnv *env, size depth, size slot)` and `mal_env_set(MalEnv *env, size depth, size slot, MalValue value)` helpers for env-backed bindings.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to read function parameters through `mal_thread_get(thread, slot)`.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to read non-captured local bindings from emitted C locals.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to read env-backed bindings through `mal_env_get(...)`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `VariableDeclaration` for non-captured locals and env-backed `var` bindings.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to handle `AssignmentExpression` for local and env-backed bindings via C locals and `mal_env_set(...)`.
- [ ] Extend literal lowering in `src/compiler/transform.ts` to handle non-integer numeric literals via `mal_value_from_f64_convert_nan(...)`.
- [ ] Extend literal lowering in `src/compiler/transform.ts` to handle `true`, `false`, `null`, and `undefined`.
- [ ] Update `runtime/src/value.c` so `mal_value_to_boolean(...)` implements JS truthiness for `false`, `null`, `undefined`, `0`, `-0`, and `NaN`.
- [ ] Extend `mal_ops_add(...)` to support mixed `int32` / `f64` arithmetic instead of throwing.
- [ ] Add `mal_ops_sub(...)` to `runtime/src/value_ops.h` and `runtime/src/value_ops.c`.
- [ ] Add `mal_ops_mul(...)` to `runtime/src/value_ops.h` and `runtime/src/value_ops.c`.
- [ ] Add `mal_ops_strict_equal(...)` and `mal_ops_strict_not_equal(...)` to `runtime/src/value_ops.h` and `runtime/src/value_ops.c`.
- [ ] Add `mal_ops_less_than(...)`, `mal_ops_greater_than(...)`, `mal_ops_less_equal(...)`, and `mal_ops_greater_equal(...)` to `runtime/src/value_ops.h` and `runtime/src/value_ops.c`.
- [ ] Extend `BinaryExpression (+)` lowering in `src/compiler/transform.ts` to work inside generated functions and copy `thread->return_value` into a fresh C local when the value must survive later calls.
- [ ] Extend `BinaryExpression` lowering in `src/compiler/transform.ts` to handle `-` and `*`.
- [ ] Extend `BinaryExpression` lowering in `src/compiler/transform.ts` to handle `===`, `!==`, `<`, `>`, `<=`, and `>=`.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to handle unary `-` and logical not `!`.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to handle short-circuit `LogicalExpression` (`&&`, `||`) while preserving JS value semantics.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to handle `ConditionalExpression`.
- [ ] Extend expression lowering in `src/compiler/transform.ts` to handle direct `CallExpression` for known `FunctionDeclaration` callees.
- [ ] Lower direct calls in `src/compiler/transform.ts` by evaluating args, calling `mal_thread_base_push(&thread, caller_reg_count, callee_reg_count)`, copying args into callee parameter slots with `mal_thread_set(...)`, invoking the compiled function, normalizing callee `MAL_RETURN`, propagating callee `MAL_THROW`, and calling `mal_thread_base_pop(&thread, caller_reg_count)`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `BlockStatement`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `IfStatement`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `WhileStatement`.
- [ ] Add loop label tracking in `src/compiler/transform.ts` for `break` and `continue`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `BreakStatement` and `ContinueStatement`.
- [ ] Extend statement lowering in `src/compiler/transform.ts` to handle `ForStatement`.
- [ ] Update top-level and function-body statement lowering so the last completed expression value is preserved in `thread->return_value` where required.
- [ ] Fix any compilation issues when executing base test262 harness files.
- [ ] Setup a new Test262 execution pipeline for AOT compiler tests.

## ABI

- `MalThread` stores `registers[...]`, `register_base`, `return_result`, and `return_value`.
- Compiled JS functions use `void fn(MalThread *thread, MalEnv *env)`.
- Runtime helpers use `void fn(MalThread *thread, MalEnv *env, MalValue arg1, ...)`.
- `thread->return_result` and `thread->return_value` are the completion and value return channels.
- Parameter slots are addressed relative to `thread->register_base`.
- `mal_thread_base_push(thread, caller_reg_count, callee_reg_count)` advances `thread->register_base` by `caller_reg_count` and preinitializes the callee register range to `undefined`.
- `mal_thread_base_pop(thread, caller_reg_count)` decrements `thread->register_base` by `caller_reg_count`.
- `mal_thread_get(thread, offset)` and `mal_thread_set(thread, offset, value)` access registers relative to `thread->register_base`.
- Non-captured, non-hoisted local bindings are emitted as preinitialized C locals.
- Captured or hoisted bindings stay in `MalEnv`.
- After any helper or compiled-function call, callers must inspect `thread->return_result`.
- A compiled function `return expr;` sets `thread->return_value`, sets `thread->return_result = MAL_RETURN`, and returns.
- Falling off the end of a compiled function sets `thread->return_value = mal_value_new_undefined()` and `thread->return_result = MAL_NORMAL`.
- A direct function call treats callee `MAL_RETURN` as successful call completion and continues with the callee's `thread->return_value`.
- `MAL_THROW` propagates unchanged.
- Any value that must survive another helper or function call must be copied from `thread->return_value` into a C local before making the next call.

### You never know ideas

- Erlang/OTP style message passing & cooperative scheduler.
- GUI work
- Deploying to AWS Lambda
- Compile to bare-metal maybe?
