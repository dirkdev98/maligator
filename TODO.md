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

- [ ] Convert public substring producers to dependent slices. Cover String and
      RegExp producers, add a retention heuristic so tiny slices do not pin large
      parents, and verify both backends under GC stress.
- [ ] Generalize property-key interning beyond the intrinsic atom table. Define
      lifetime and GC policy before using pointer identity in shapes, dictionaries,
      Maps, and inline caches.
- [ ] Add validity/version cells for user-defined prototype chains, then extend the
      inherited-value cache beyond watched built-in chains and measure method-call
      improvement.
- [ ] Emit stack objects for eligible `stackAllocCandidates`, then add partial
      escape with lazy materialization at cold escape edges.
- [ ] Measure region allocation and drop-insertion free lists after stack allocation
      lands; do not add either without an allocation-rate or wall-time win.
- [ ] Pool promise jobs/reactions and suspendable-frame support allocations. Record
      allocation count and wall time before and after.
- [ ] Pack `MalInstruction` after pointer-carrying operands move behind side-table
      indices in the bytecode format.
- [ ] Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- [ ] Generate compiler/runtime opcode plumbing from one descriptor list.
- [ ] Classify static `arguments` usage in semantic analysis so IR can avoid
      materializing unused arguments objects.
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

## Testing and tooling

- [ ] Delete or formalize the unreferenced `tests/local/classify-di.cjs` and
      `tests/local/classify-di2.cjs` probes, then add a fixture-reference audit or
      explicit allowlist.
- [ ] Replace the local absolute path in the semantic snapshot test with a
      CI-portable fixture path.

## Revisit triggers

These are not active tasks:

- Loaded-field numeric unboxing: revisit when shared deoptimization machinery exists
  or a tracked benchmark regresses materially. Prior subtree-fusion measurements
  were low ROI.
- Concurrent GC marker threads and parallel marking: revisit when a real big-heap
  workload shows mutator marking is a top cost.
- Array-literal scalar replacement and full no-iterator `for-of`: revisit only with a
  benchmark that is not covered by the existing iterator-protocol optimizations.
