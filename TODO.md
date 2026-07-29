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

## Queued cross-cutting runtime work

- [ ] Implement or reject `host.scheduler: "multiprocessing"`.
- [ ] Add Intl locale subsetting.

Compiler optimization and analysis are owned by the
[compiler roadmap](docs/roadmaps/compiler.md). Test262 compiler and suite throughput
is owned by the [Test262 performance roadmap](test262-perf-todo.md).

## Domain roadmaps

- [Compiler optimization and analysis](docs/roadmaps/compiler.md)
- [GC, allocation, and recoverable OOM](docs/roadmaps/gc.md)
- [Isolates, reactor, actors, and hosts](docs/roadmaps/isolate-reactor.md)
- [WinterTC server profile](docs/roadmaps/wintertc.md)
- [Node and Express compatibility](docs/roadmaps/node-compat.md)
- [eval, Function, and realms](docs/roadmaps/eval-realms.md)
- [Test262 correctness](docs/roadmaps/test262.md)

## Triggered work

These are not active tasks:

- Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- Revisit concurrent GC marker threads and parallel marking when a real big-heap
  workload shows mutator marking is a top cost.
