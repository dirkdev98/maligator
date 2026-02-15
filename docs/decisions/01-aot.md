# AOT to C

## Context

The initial implementation of Maligator was a spec-compliant tree-walker implemented in
TypeScript, implementing the spec 1-on-1, leveraging V8 for memory management and value
representation. While successful for learning the ECMA-262 spec and how a JS engine works,
the next goals present themselves:

- Can we make something that is more performant? The V8 optimizers helped our
  implementation a lot in not feeling too slow, but that's cheating :)
- Can I use JS for native binaries with a decent FFI story?
- Learn more bits around garbage collection, semantic analysis and more.

I want something that I can use in 'Platform Engineering' tools. I'm the most comfortable
with scripting in JS. But shipping Node.js everywhere is not the ideal I strive for.

## Decision

We will move to an Ahead-of-Time (AOT) compiler architecture written in TypeScript that
emits C code, linked against a custom Native C Runtime.

Instead of a bytecode VM with a switch-loop, we will transpile to C functions which will
operate on a `MalThread`-struct for local stack registers and `MalEnv` for escaped
variables. All base logic will be implemented as C functions operating on these two main
structs. E.g `mal_add(output *Value, input1 *Value, input2 *Value);`.

## Consequences

We will basically start from scratch. So all work will be done again. Working in two
languages (TS and C) will complicate the development setup, but we will figurate that out
as we get there.

We are going to start with semantic analysis. A step we skipped so far. We need to figure
out which variables escape their scope, do register allocation, and more. So no immediate
progress on the end-goal is made.

The main thing we have to worry about is debuggability. We need to make sure that we can
trace our implementation in all ways to debug.

## Example

Input:

```js
const offset = 10;

function createAdder(x) {
	return function (y) {
		return x + y + offset;
	};
}

const addFive = createAdder(5);
const result = addFive(2); // Expected: 17
```

Output:

```c
#include "maligator.h"

// --- Metadata & Interned Strings ---
static const char* FILE_NAME = "logic.js";
MalValue G_offset; // Global variable

// --- 1. The Closure Function (Inner) ---
// Logic: return x + y + offset;
MalResultType func_inner(MalThread* thread, MalValue* out) {
    // Setup Debug Frame
    mal_frame_push(thread, "anonymous", FILE_NAME, 4);

    // R0: y (Argument)
    // Environment Access (x was lifted)
    MalValue x = mal_env_get(thread->env, 0);

    // x + y
    if (mal_add(thread, &thread->regs[1], x, thread->regs[0]) != MAL_SUCCESS) goto bail;

    // (x + y) + offset
    if (mal_add(thread, &thread->regs[2], thread->regs[1], G_offset) != MAL_SUCCESS) goto bail;

    *out = thread->regs[2];
    mal_frame_pop(thread);
    return MAL_SUCCESS;

bail:
    mal_frame_pop(thread);
    return MAL_THROW;
}

// --- 2. The Factory Function (Outer) ---
MalResultType func_createAdder(MalThread* thread, MalValue* out) {
    mal_frame_push(thread, "createAdder", FILE_NAME, 3);

    // R0: x (Argument)
    // 1. LIFITING: x escapes, so create an Environment
    MalEnv* new_env = mal_env_new(thread->env, 1); // 1 slot for x
    mal_env_set(new_env, 0, thread->regs[0]);

    // 2. Create Closure Object
    *out = mal_closure_new(func_inner, new_env);

    mal_frame_pop(thread);
    return MAL_SUCCESS;
}

// --- 3. Main Entry (Global Script) ---
int main() {
    MalThread* thread = mal_thread_new();

    // const offset = 10;
    G_offset = mal_int(10);

    // const addFive = createAdder(5);
    thread->regs[0] = mal_int(5); // Prepare argument
    if (func_createAdder(thread, &thread->regs[1]) != MAL_SUCCESS) return 1;
    MalValue addFive = thread->regs[1];

    // const result = addFive(2);
    thread->regs[2] = mal_int(2); // Prepare argument
    // Logic: execute the closure stored in 'addFive'
    if (mal_call_closure(thread, addFive, &thread->regs[3], 1) != MAL_SUCCESS) return 1;

    printf("Result: %ld\n", mal_to_int(thread->regs[3]));
    return 0;
}
```
