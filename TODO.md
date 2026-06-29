# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## High level

- [ ] More performance work.
- [ ] **String optimizations** — strings are always flat UTF-16 (`MalString.code_units`); every `+` concat (`mal_ops_add`, vm_ops.c) and `slice`/`substring` allocates + copies. Add a rope / cons-string + dependent-string (slice) representation so concat is O(1)-amortized and substring is zero-copy. Interacts with GC: a dependent string must keep its parent buffer alive (a trace edge). Likely the biggest throughput lever for string-heavy code.
  - [ ] **String/key interning (atom table)** — today only the fixed internal vocabulary (`mal_intrinsic_ascii` → `vm->atoms`) and compile-time-baked constants are interned; runtime-created key strings (computed keys, `String(i)`, JSON keys) re-hash + compare by content, and the IC can only refill for immortal keys (the ABA dodge in vm_ops.c). Intern-on-key-use gives pointer-identity key compares, widens IC coverage to *all* string keys, and is the substrate for faster dictionary/Map lookups + a symbol-like fast path. Foundational — touches the object model, ICs, and symbols at once.
- [ ] **Promise & microtask mallocs** — `MalPromiseReaction` and `MalJob` are raw `malloc` linked lists living outside the GC (traced as roots, not owned by it). Decide the ownership/lifetime model (arena vs first-class GC cells). Probably entangled with the async/dynamic-import rooting flakiness noted below.
  - [ ] **Suspendable frame storage** — generator/async activations are heap-resident with *three* separate mallocs each (registers, arguments, with-objects). Co-allocate into one allocation or a free-list pool to cut the per-suspension allocation count. Same conversation as the malloc-ownership question above and generational GC.
- [ ] **Generate ops from a single op-descriptor list** — kill the ~6-file path to add an opcode (enum, interpreter switch, lower-vm, emit-vm, emit-c, wrapper). The `mal_op_X` interpreter shims are pure register→core marshaling (e.g. `mal_op_binary` is one call into `mal_vm_binary_op`), fully derivable from `{name, operands, core fn}`; generate the enum + interpreter dispatch + serializers from one table, keeping the irregular ops (CALL/RETURN/YIELD/AWAIT/env) hand-written. Build-time only — runtime perf unchanged. (Subsumes the "value_ops vs vm_op" decision below.)
- [ ] **Write-barrier completeness audit (prerequisite for generational GC)** — the card barrier exists at every store site but folds out today; the generational minor collector (§5.7 above) is gated on proving *every* old→young store routes through it. Stores into root containers currently skip the barrier and lean on root re-scan — fine for STW, not for a minor collector. Audit barrier completeness before flipping the flag, not after.
- [ ] **Drop bytecode for always-compiled, no-bail functions** — the native backend is an overlay: every compiled function also carries its full `MalInstruction` table (fallback + `new`). When the compiler can prove no bail path is reachable (no speculative guards, no `new`, not a generator), that bytecode is dead weight; shedding it cuts image size (cf. the 11mb binaries below) and forces a clean overlay contract.
- [ ] **Call-site inline caches** — calls re-resolve the callee every time. A monomorphic call-site IC (cache the callee / its shape) lets the compiled backend speculate a fixed target and lets the existing inliner act at more sites — the call-path analogue of the property IC.

### Open follow-ups (2026-06-23 array/perf session — detail in gc_todo.md)

- [ ] **Allocation is the next bottleneck** (alloc bench ~15× vs Node; arrays/for-of now near-Node). Two levers:
  - [ ] **Generational GC** (§5.7) — non-moving sticky-mark / card-marking minor collector (moving/copying nursery is off the table: the non-moving design is foundational — FFI raw pointers, no read barrier, identity hashing). Reduces minor-GC *time*, not per-alloc cost.
  - [ ] **Module-mode top-level-function inlining** → unblocks the non-escape scalar replacement (already built) to *eliminate* non-escaping factory allocations (`{x,y}` from `makePoint`). Inliner currently can't resolve top-level fns; sloppy-script globals are intractable, but ESM lexical bindings are resolvable. Per the design's own thesis (compiler-first, generations for residual garbage), likely do this alongside/before generations.
- [ ] **Correctness: inherent async/dynamic-import flakiness.** `dynamic-import/catch/nested-async-arrow-*` tests alternate PASS/FAIL across single-file isolation runs — a real nondeterminism, likely a promise/microtask/module-load GC-rooting gap (cf. the noted generator-frame rooting gap). Hunt it.
- [x] **Array semantics (DONE 2026-06-26):** `Object.getOwnPropertyNames`/`getOwnPropertyDescriptors(array)` now emit exotic `"length"` (length_pending pattern in `mal_builtin_object_collect_impl` + the descriptors collector, mirroring Reflect.ownKeys; non-enumerable so absent from keys/values/entries) — +2 test262. A non-extensible-rejected index store no longer bumps array `length` (`mal_array_object_store` now stores via `mal_object_set` first, bumps length only on success) — Node-identical. 0 regressions.
- [ ] **Dense-array #5 leftovers (diminishing):** presize `mal_intrinsic_new_array(len)`; full no-iterator for-of transform (for-of already 7.7× vs the index loop's 6.6×).
- Done this session: dense-array vector + fast read/append/codegen-inline + fast-array for-of (#5), flatMap inlining, and a real C-stack-overflow guard for the native backend (also retires the 2c wrapper recursion risk).
- [ ] Temporal global on temporal_rs (evaluate the temporal_capi C bindings)
- [ ] Don't include icu4x data when not used / split locales. We currently create 11mb binaries.
- [ ] Native TypeScript stripping in front of Meriyah (decided 2026-06-29: keep Meriyah, add a Rust strip-only pass — supersedes the old "replace Meriyah" framing; see eval_todo.md Phase 1)
- [ ] GC, malloc optimizations, compiled lifetimes, struct layouts
- [ ] Eval & function constructor (plan: eval_todo.md)
- [ ] Decide on value_ops vs vm_op vs whatever?

### Resources / reading list

- https://zef-lang.dev/implementation
- https://wren.io/performance.html
- https://benhoyt.com/writings/hash-table-in-c/
- https://github.com/tidwall/hashmap.c

### You never know ideas

- Erlang/OTP style message passing & cooperative scheduler.
- GUI work
- Deploying to AWS Lambda
- Compile to bare-metal maybe?
