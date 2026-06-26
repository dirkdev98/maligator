# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## High level

- [ ] More performance work.

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
- [ ] Replace Meriyah with a type-stripping supporting parser
- [ ] GC, malloc optimizations, compiled lifetimes, struct layouts
- [ ] Eval & function constructor
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
