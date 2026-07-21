# Maligator roadmap

This is the committed cross-project roadmap. Each roadmap task has one owning
checklist; this file owns compiler/runtime performance and links to the domain
roadmaps for everything else. Test262 verdict counts live only in
`scripts/test262.json`.

## Priorities

1. Safety and bounded resource use.
2. AOT throughput and allocation elimination.
3. Outbound I/O, actors, and SMP.
4. ECMAScript correctness and runtime usability.
5. GUI embedding and freestanding targets.

## Compiler and runtime performance

- [x] Gate semantic and IR debug rendering before construction when `MAL_DEBUG`
      is disabled. The compiler benchmark tracks Node-hosted front-end wall time
      and serialized wire bytes on a deterministic multi-function corpus.
- [x] Fold exact primitive numeric/boolean/null/undefined operations and constant
      branches in non-resumable functions. Preserve NaN, infinities, and negative
      zero; leave exponentiation and resumable functions to host/resume-aware work.
- [x] Embed exact primitive, small-integer, and string values directly in ordinary
      call/construct operands. Negative arithmetic tags remain deterministic in the
      self-hosted compiler; static property keys use dedicated bytecodes.
- [x] Batch private-name creation, initializer-free private instance fields, and
      contiguous undefined global-var initialization while preserving declaration,
      brand, ordering, and abrupt-completion semantics.
- [x] Coallocate one-slot ordinary shaped-object storage in the existing 48-byte
      managed-cell class. Growth migrates to an owned buffer, dictionary/finalizer
      paths honor ownership, and the stack-object benchmark tracks avoided buffers.
- [x] Convert public String, RegExp, and Intl substring producers to dependent
      slices. Tiny slices copy instead of pinning disproportionate owned parents;
      the broad string benchmark tracks allocation and wall time, and both backends
      run the producer coverage under GC stress.
- [ ] Generalize property-key interning beyond the intrinsic atom table. Define
      lifetime and GC policy before using pointer identity in shapes, dictionaries,
      Maps, and inline caches.
- [ ] Add validity/version cells for user-defined prototype chains, then extend the
      inherited-value cache beyond watched built-in chains and measure method-call
      improvement.
- [ ] Extend the native-only closed fixed-shape local stack-object slice to further
      proven classes. Fixed-shape/zero-slot objects and acyclic conditional-return
      materialization are done; continuing call/store/capture escapes remain.
- [ ] Measure region allocation and drop-insertion free lists after stack allocation
      lands; do not add either without an allocation-rate or wall-time win.
- [x] Pool paired promise reactions, microtask jobs, suspendable-frame buffers, and
      async-generator requests in bounded per-VM freelists. The broad promise and
      coroutine benchmarks track native allocation counts, reuse, and wall time.
- [x] Pack `MalInstruction` from 40 to 20 bytes by moving variable operands behind
      per-function side-table offsets and storing F64 payloads as raw 32-bit words.
      The interpreted benchmark tracks row, side-table, and total bytecode bytes.
- [x] Fold constant-string property keys into static-key bytecodes after high-level
      optimization. This removes dead key producers and cuts tracked interpreter
      bytecode rows without changing computed-key coercion semantics.
- [x] Resolve native exception handlers with a nested-range sweep instead of
      scanning every handler for every emitted instruction.
- [ ] Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- [ ] Generate compiler/runtime opcode plumbing from one descriptor list.
- [x] Reuse the runtime's immutable compiler-wire byte array for the product CLI's
      compiler asset instead of linking a second byte-identical copy.
- [x] Classify binding-wide-safe `arguments.length` and constant-index reads in
      semantic analysis. IR snapshots them from frame metadata/values without
      materializing an arguments object; the arguments benchmark tracks both
      backends' allocation, buffer, instruction, artifact, and wall-time effects.
- [ ] Finish the accepted-but-unwired build configuration fields
      (`host.scheduler: "multiprocessing"`, `surface.maligator: false`) or reject
      them; add Intl locale subsetting.

Test262 compiler and suite throughput is owned by
[`test262-perf-todo.md`](test262-perf-todo.md).

## General usability

- [ ] Complete `package.json#exports` resolution for wildcard subpaths, null
      targets, target validation, encapsulation, and full Node entry detection.
- [ ] Bake module paths so CommonJS `__filename` and `__dirname` are available.

## Domain roadmaps

- [GC and allocation](docs/roadmaps/gc.md)
- [Isolates, reactor, actors, and hosts](docs/roadmaps/isolate-reactor.md)
- [eval, Function, and realms](docs/roadmaps/eval-realms.md)
- [Test262 correctness](docs/roadmaps/test262.md)

## Revisit triggers

These are not active tasks:

- Loaded-field numeric unboxing: revisit when shared deoptimization machinery exists
  or a tracked benchmark regresses materially. Prior subtree-fusion measurements
  were low ROI.
- Concurrent GC marker threads and parallel marking: revisit when a real big-heap
  workload shows mutator marking is a top cost.
- Array-literal scalar replacement and full no-iterator `for-of`: revisit only with a
  benchmark that is not covered by the existing iterator-protocol optimizations.
