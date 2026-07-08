# Compiled coroutines (generators & async in the native-C backend)

## Context

The native-C backend (`emit-c.ts`) lowers eligible functions straight to C, no
VM dispatch loop. Performance is the top project priority, with small binary size
close behind; one payoff of the backend is being able to _strip the interpreter_
when `eval` is disabled (a size win).
Until now the backend bailed on every generator/async function (`fn.isGenerator
|| fn.isAsync` → `return null`), so any program using them kept the whole
bytecode interpreter reachable. That blocks the strip.

Generators and async functions suspend mid-body. A straight-line C function
cannot pause and resume: its live state (program counter, locals) lives on the
native C stack, which is gone after `return`. There were three ways to fix this:

- **Stackless state machine** (chosen): reify the body into a resumable form —
  the resume point becomes an explicit label reached via an entry dispatch, and
  all cross-suspend state lives in an explicit heap frame, never in a C local
  that a `return` would discard.
- **Stackful coroutine**: give each activation its own C stack (reuse `fiber.c`
  / ucontext), suspend by switching stacks. Trivial compiler, but a whole C
  stack per in-flight coroutine (async keeps many live) fights the size/memory
  priority, and a precise GC cannot cheaply scan native stacks.
- **Segment splitting**: split the body into one C function per straight-line
  run between yields. Strictly more work than the state machine (needs a CFG
  split the front-end deliberately avoids) for no gain.

The stackless model is the natural fit _because the engine is already shaped for
it_: the front-end flattens a coroutine body to one linear instruction stream
with absolute-IP jumps and **already emits the inline resume-mode dispatch**
(`RESUME_{NEXT,THROW,RETURN}`) right after each `YIELD`/`AWAIT`; `emit-c` already
emits flat `goto`-based control flow (a label per jump target); and the runtime
already keeps a suspended activation as a heap `MalGeneratorObject` with a
register buffer. Compiled coroutines reuse all of it and interoperate with the
same runtime objects (generator/async state, promises, the microtask queue,
`mal_vm_resume_generator`, the drivers in `builtin_generator.c` /
`builtin_async_generator.c` / `async_function.c`), none of which is recompiled.

## Decision

### One C function per coroutine, unified fresh + resume entry

The compiled ABI (`MalCompiledFunction`) gains a trailing parameter:

```c
MalValue (*)(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
             MalValue new_target, MalEnv *env, MalValue callee,
             struct MalGeneratorObject *resume_state);
```

`resume_state == nullptr` is a **fresh call** (the normal call/construct/entry
path passes `nullptr`); non-null is a **resume** of that suspended coroutine
(only `mal_vm_resume_generator` passes it). Non-coroutine functions ignore it
(`(void) resume_state;`). C cannot `goto` across functions, so fresh and resume
must be one function distinguished by this parameter; a parameter is chosen over
a VM field so the contract is visible in the signature (mirrors the earlier
`callee` extension).

### Cross-suspend state lives in a heap register buffer

A compiled coroutine holds **all** registers boxed in a heap `MalValue` buffer
indexed by register number — `#define r<i> (__gc_slots[i])` for every register
(the buffer reuses the `__gc_slots` name so the shared register / with-object
emission works unchanged), no rep specialization, no unboxing (unboxed C locals
would not survive a suspend, and the resume ABI writes MalValues by register
index). Layout:

| range                            | contents                 |
| -------------------------------- | ------------------------ |
| `[0, registerCount)`             | registers                |
| `[registerCount, +maxWithDepth)` | `with`-object stack      |
| `[registerCount + maxWithDepth]` | coroutine self-reference |

Total = `registerCount + maxWithDepth + 1`. The buffer is
`gen->frame.registers`; the trace scans `frame.function->register_count`
(= `registerCount`) register slots, so the generator's own GC trace
(`mal_gc_trace_frame`) never wanders into the `with`/self slots.

- **Fresh**: allocate the buffer (all `undefined`), point `__gc_slots` at it,
  publish a `MalRootFrame{ slots = __gc_slots, slot_count = total }`. The
  prologue runs (reading the `args` param), then `GENERATOR_START`/`ASYNC_START`
  creates the coroutine object and _adopts_ the buffer.
- **Resume**: `__gc_slots = resume_state->frame.registers`; restore
  `env = resume_state->frame.env`; publish the root frame over the same buffer;
  dispatch `switch (resume_state->frame.instruction_pointer) { case N: goto L_N; }`
  to the saved resume point. The sent value + resume mode were already written
  into the buffer (by register index) by `mal_vm_resume_generator` before the
  call, so the front-end's inline post-suspend dispatch reads them verbatim.

### Rooting

Publishing the root frame over the whole buffer roots registers + `with`-stack
directly, and roots the coroutine object via the self slot. The object's trace
then transitively covers `yielded_value`, `async_resolve`/`async_reject` (hence
the result promise, held by those resolving closures), `awaited_by`, and the
async-generator request queue — so all coroutine state stays live during a run
without relying on the caller keeping the object reachable. `this`/`callee`/`env`
are read from `gen->frame` on resume (the `this_value`/`callee`/`env` C params
are only valid on the fresh call).

### Suspend / return signaling

The C return value is only meaningful on a coroutine's **first** exit (the
initial synchronous run), which returns to the original caller via
`mal_vm_call_value`; subsequent resumes return into `mal_vm_resume_generator`,
whose callers ignore the value. So:

- **`GENERATOR_START`**: create the generator (prototype from `callee.prototype`,
  else `%GeneratorPrototype%`/`%AsyncGeneratorPrototype%`), stash into
  `gen->frame`: adopted buffer, `function`/`function_index`, `env`, `this_value`,
  `callee`, `instruction_pointer = <resume ip>`, `generator = gen`,
  `stack_base = -1`, `arguments = nullptr`, `argument_count = 0`; write the self
  slot; `state = SUSPENDED_START`; `remember_if_old`; `return <generator>`.
- **`ASYNC_START`**: create the result promise + hidden state (reusing
  `mal_async_function_start`'s shape), adopt the buffer, write the self slot,
  stash the promise in a local `__async_result_promise`; **do not suspend** — the
  body keeps running. Every later exit `return __async_result_promise` (undefined
  on a resume path, where it is ignored).
- **`YIELD`**: `gen->yielded_value = <src>`; record `resume_value_register` /
  `resume_mode_register`; `state = SUSPENDED_YIELD`;
  `gen->frame.instruction_pointer = <resume ip>`; `remember_if_old`; unlink the
  root frame; `return`. Async generators additionally call
  `mal_async_generator_yield`.
- **`AWAIT`**: like `YIELD` (state `SUSPENDED_YIELD`, save resume ip), then call
  `mal_async_function_await(vm, state, awaited)` to hook the settlement
  continuation; unlink; `return __async_result_promise`.
- **coroutine `RETURN`** (body completes): `state = COMPLETED` _first_, then free
  the buffer and route the value exactly as the interpreter's RETURN does — async
  generator → `mal_async_generator_return`, async → `mal_async_function_settle_return`,
  plain generator → `NORMAL` completion for the `.next()` driver. Marking
  COMPLETED before freeing preserves the finalizer's double-free guard
  (`gc.c`: the finalizer frees the buffers only while SUSPENDED; a COMPLETED
  coroutine's are already freed, left dangling — same contract as the
  interpreter).
- **uncaught throw**: propagates via `vm->completion`; `mal_vm_resume_generator`
  marks the coroutine COMPLETED (unchanged).

The resume point is `ip + 1` of each `YIELD`/`AWAIT` (the IP is advanced past the
suspend before the frame is saved, so resume continues at the following inline
dispatch). `emit-c` forces a label at every such IP and builds the entry switch
from them.

### Resume dispatch in the runtime

`mal_vm_resume_generator` re-resolves `gen->frame.function` (splice-safe), writes
`(sent_value, resume_mode)` into the buffer by register index, then:

- compiled coroutine → call the compiled entry with `resume_state = gen` (no VM
  frame pushed, no interpreter loop);
- interpreted coroutine → the existing push-frame-and-run path.

Post-run completion handling (mark COMPLETED on throw) is shared.

## Consequences

- No compiled function references the interpreter. Once generators/async compile,
  a program that is fully compilable emits **zero** bytecode arrays and zero
  `mal_vm_interpret_function` references, unblocking the interpreter strip under
  `eval:false` (the size payoff).
- Coroutine registers are always boxed and memory-resident; the backend forgoes
  cross-suspend C-level register allocation and vectorization of yield-spanning
  loops. This is the accepted stackless trade-off and is aligned with the goals
  (suspend/resume and call overhead dominate coroutine bodies; footprint per
  in-flight coroutine stays minimal). A future refinement can spill only the
  live-across-a-suspend set and keep the rest in C locals within straight-line
  segments.
- `yield*` (desugared to plain IR by the front-end) and `async function*`
  (a coroutine with both suspend kinds; the runtime already has the
  async-generator request queue) need no additional backend design.
- `gcRootRegisters` liveness is enabled for resumable functions (it was gated
  off only because the backend did not compile them); the coroutine buffer roots
  the full register file regardless, so liveness minimization does not apply to
  the coroutine buffer itself.
