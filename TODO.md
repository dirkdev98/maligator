# Maligator roadmap

This is the committed cross-project index. Each task has one owning roadmap;
completed work belongs in commits, tests, and benchmark baselines rather than in
active checklists. Test262 verdict counts live only in `scripts/test262.json`.

## Current priorities

1. Safety and bounded resource use.
2. AOT throughput and allocation elimination.
3. Outbound I/O and server-runtime APIs.
4. ECMAScript correctness and runtime usability.
5. Actors, SMP, GUI embedding, and freestanding targets.

## Queued compiler and runtime work

- [ ] Generalize property-key interning beyond the intrinsic atom table. Define
      lifetime and GC policy before using pointer identity in shapes, dictionaries,
      Maps, and inline caches.
- [ ] Add validity/version cells for user-defined prototype chains, then extend the
      inherited-value cache beyond watched built-in chains and measure method-call
      improvement.
- [ ] Extend the native-only closed fixed-shape local stack-object slice to further
      proven classes. Continuing call, store, and capture escapes remain.
- [ ] Measure region allocation and drop-insertion free lists after broader stack
      allocation lands; add neither without an allocation-rate or wall-time win.
- [ ] Generate compiler/runtime opcode plumbing from one descriptor list.
- [ ] Implement or reject `host.scheduler: "multiprocessing"`.
- [ ] Add Intl locale subsetting.

Test262 compiler and suite throughput is owned by
[`test262-perf-todo.md`](test262-perf-todo.md).

## Domain roadmaps

- [GC, allocation, and recoverable OOM](docs/roadmaps/gc.md)
- [Isolates, reactor, actors, and hosts](docs/roadmaps/isolate-reactor.md)
- [WinterTC server profile](docs/roadmaps/wintertc.md)
- [Node and Express compatibility](docs/roadmaps/node-compat.md)
- [eval, Function, and realms](docs/roadmaps/eval-realms.md)
- [Test262 correctness](docs/roadmaps/test262.md)

## Triggered work

These are not active tasks:

- Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- Revisit loaded-field numeric unboxing when shared deoptimization machinery exists
  or a tracked benchmark regresses materially.
- Revisit concurrent GC marker threads and parallel marking when a real big-heap
  workload shows mutator marking is a top cost.
- Revisit array-literal scalar replacement and full no-iterator `for-of` only with a
  benchmark not covered by existing iterator-protocol optimizations.
