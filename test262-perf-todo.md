# Test262 performance roadmap

The 2026-07-14 full-suite profile showed compiled-mode C compilation dominating
wall time. It predates later shared-helper emission, so capture a new cold baseline
before re-ranking work. Artifact manifests already persist per-entry function,
instruction, and opcode statistics.

## P0 - Safety and bounded resources

The maximum string length and checked string-builder/encoder arithmetic are
implemented. Impossible lengths are catchable and the original replacement-growth
reproducer passes.

1. [ ] Design recoverable allocation failure for CELL, RAW, LOS, and direct native
       allocations. Add a preallocated/non-allocating emergency exception and
       deterministic fault-injection tests that prove OOM is catchable without GC
       corruption or recursive allocation.

## P1 - Generated code reduction

2. [ ] Bulk-lower private names and instance fields while preserving identity,
       declaration order, initializer effects, abrupt completion, and brand checks.
3. [ ] Bulk-lower contiguous uninitialized global declarations while preserving
       declaration-instantiation checks and global observability.
4. [x] Add conservative Number/Boolean/null/undefined constant folding and
       dead-branch cleanup with exact NaN, negative-zero, overflow, and throwing
       semantics. Keep BigInt, strings, exponentiation, and resumable functions on
       their runtime paths until their host/resume contracts are explicit.
5. [ ] Add tagged immediate and static-key operands to avoid standalone constant
       creation for calls, property operations, and construction.
6. [ ] Evaluate resumable static call tables only after item 5 is measured; add them
       only if they materially reduce generated C/object size further.
7. [ ] Intern byte-identical immutable definitions, function bodies, constants, and
       debug tables without merging JavaScript identity or mutable state.
8. [ ] Measure a lower literal-template threshold and static property opcodes on
       medium definitions; use a cost model rather than fixture-specific rules.

## P2 - Measurement and scheduling

9. [ ] Give C batches stable IDs and persist member paths, generated-C bytes,
       logical/physical code totals, object bytes, cache state, worker, and phase
       timings in each variant report.
10. [ ] Preserve both strict and sloppy reports across an unfiltered dual run.
        Acceptance: both report files remain available with their pass summaries.
11. [ ] After item 9, measure C compile/link contention at controlled worker counts
        and limit concurrent links only if attribution confirms contention.
12. [ ] Add bounded targeted profiling flags, valid only with `--filter` or
        `--manifest`, for timeout, RSS, CPU, GC statistics, and phase markers. Keep the
        normal watchdog and an outer kill deadline.

## P3 - Compiler cleanup

13. [x] Avoid constructing semantic and IR debug renderings when `MAL_DEBUG` is
        disabled; gate construction rather than only the logger call.
14. [x] Replace compiled C emission's per-instruction handler scan with an interval
        cursor/index. Preserve innermost-handler selection and add a generated
        many-handler regression.

## Revisit trigger

- Exact timezone-offset caching measured at about 2% of the DST shard. Reconsider
  only if Date profiling makes offset lookup a top-five self-time contributor.
