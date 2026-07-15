# Test262 performance backlog

Ranked tasks from the 2026-07-14 full-suite run and follow-up profiling. The run
compiled 43K tests per variant and showed that compiled-mode C compilation, not
test execution, dominates wall time:

| Strict pass | Front end | C compile | Link | Execute | Wall |
| ----------- | --------: | --------: | ---: | ------: | ---: |
| interpreted |    1,149s |      190s |  31s |    236s | 228s |
| compiled    |    1,289s |    3,521s |  54s |    229s | 675s |

Phase totals sum work across eight workers. Use
`node scripts/test262-code-stats.ts --variant strict --limit 50` to recover exact
per-test function/instruction counts from interpreted artifacts without compiling
or executing Test262.

## P0 — Safety and bounded resource use

1. [ ] **Enforce an engine-wide maximum string length and checked builder
       arithmetic.** `String/replace-math.js` expands repeated `$1` substitutions
       until the process consumes ~8 GB and is OS-terminated. Check add/multiply/
       geometric-growth overflow before allocation in `regexp_builder_reserve`,
       `regexp_get_substitution`, `regexp_proto_replace`, `mal_ops_add`, and every
       `mal_string_new_*` entry; convert impossible lengths/allocation failures into
       a catchable JS error. Cover concatenation, replacement, UTF-8/UTF-16 width,
       and boundary values.

   Progress: the UTF-16 limit, constructor invariants, checked concat/repeat/
   pad/replace builders, and catchable impossible-length errors are implemented;
   URI encoding, web base64, and typed-array base64/hex expansion are now bounded
   too, and `replace-math.js` passes. Core heap allocation failure still aborts and
   remaining string producers need the same fallible allocation contract plus a
   non-allocating emergency exception path.

2. [x] **Make runtime compilation GC-safe instead of suppressing collection.** The
       self-hosted compiler retains 4+ GB while compiling large eval inputs because
       the whole native compiler frame suppresses GC. Root source, arguments,
       compiler results, scope values, wire buffers, and temporary definitions in
       `compile_source`, `mal_vm_eval_source`, and `mal_vm_eval_direct`; then permit
       collections during compilation. Verify eval/Function under GC stress and
       large generated class/block sources.

## P1 — Highest-impact compiler throughput

3. [x] **Represent precise exceptional CFG edges in liveness.** `computeSuccessors`
       currently adds every `tryBegin` target to every block. This creates ~130K
       artificial edges for `destructuring-array-done.js` and ~20M for
       `regress-561031.js`, producing cubic practical behavior. Track active
       protected ranges and add only the applicable handler edge. Preserve nested
       try/catch/finally, abrupt completion, and IteratorClose behavior.

4. [x] **Replace full-sweep liveness with a predecessor worklist and an
       aggregate-only safepoint mode.** Revisit a block only when a successor's live
       set changes, and avoid materializing every per-safepoint `Set` when lowering
       only consumes the union. Until precise edges land, add a conservative
       complexity fallback that roots all physical registers when estimated
       `blocks * handlers * registers` is excessive.

5. [x] **Make IR block cleanup linear.** `optCombineLinearBlocks` and
       `optDropUnreferencedBlocks` remove one block and rescan/reindex all remaining
       targets each time. Compute merges/removals first, rebuild once, and patch
       targets through one old-to-new map. `regress-561031.js` exposes the current
       quadratic scaling across ~1,821 try/catch statements.

6. [x] **Skip or narrow TDZ analysis when no checked slots exist.** Return early
       from `eliminateRedundantTdzChecksInFunction` when there is no `throwIfTdz`,
       and otherwise track only slots that are checked. The repeated-catch test has
       1,821 catch locals but zero TDZ checks and currently pays full set-copy/
       intersection cost.

7. [x] **Compile standard and included Test262 helpers once per batch/artifact.**
       Standard `assert.js`/`sta.js` contributes roughly 28M logical instructions
       across strict definitions (~50%). Repeated includes add an estimated 9.5M
       for `propertyHelper.js`, 3.6M for `testTypedArray.js`, and 0.87M for
       `testIntl.js`. Share immutable helper definitions/native bodies while
       preserving per-test globals, realms, mutable harness state, source positions,
       and independent failure attribution. Measure front-end, generated-C, object,
       and link reductions separately.

8. [x] **Use amortized strings in the self-hosted compiler.** Large eval class tests
       spend most sampled CPU in `mal_ops_add`/`memmove` while repeatedly rebuilding
       flat strings. Land the ropes/cons-string task from `TODO.md`, with bounded
       flattening and GC tracing, then remeasure `class/methDefn.js` and
       `class/compPropNames.js`.

   Progress: dependent strings trace their flat parent and replace unsafe borrowed
   dynamic slices. Concatenation now creates checked O(1) cons nodes; contiguous
   access flattens iteratively once, and GC traces both children with publication
   and deletion barriers. Serialized strict compiled probes pass: `methDefn.js`
   ran in 920ms and `compPropNames.js` in 473ms on 2026-07-14.

9. [x] **Run the baked compiler through compiled code or add interpreter call-site
       caching.** Runtime compilation currently executes the compiler through
       `mal_vm_interpret_function`; existing native/compiled call caches do not help
       this path. Compare AOT self-host execution with interpreter call/property
       caches before choosing the smaller production design.

10. [x] **Elide semantically empty blocks before CFG/source-position emission.**
        `regress-610026.js` creates roughly two million empty blocks and remains in
        its first runtime compile after minutes. Filter empty block statements before
        `compileStatementsToBlock`/`compileBlockStatement` creates positions and CFG
        nodes, while preserving directives, lexical scopes, declarations, and debug
        stepping contracts.

## P2 — VM instruction and generated-C reduction

11. [ ] **Bulk-lower private names and instance fields.** Unicode class generators
        emit about six VM instructions per private field; the Unicode 10 pair reaches
        50,877 instructions each. Add static private-layout descriptors plus bulk
        create/install operations that preserve unique private-name identities,
        declaration order, initializer effects, abrupt completion, and brand checks.
        Target >90% instruction/C reduction on the 8,327-field probe.

12. [ ] **Bulk-lower contiguous uninitialized global declarations.** Unicode plain
        generators emit two instructions for each of 6K-8K `var` names. Store the
        string indices as static data and execute one declaration operation while
        preserving global declaration-instantiation checks, property descriptors,
        redeclaration semantics, and realm-global observability.

13. [ ] **Add primitive constant folding plus dead-branch cleanup.** Twelve ES5 shift
        truth-table tests contribute ~122K instructions for constant comparisons and
        unreachable throw branches. Fold arithmetic/bitwise/comparison operations
        with exact JS `NaN`, `-0`, int32/uint32, overflow, BigInt, and throwing
        semantics; differential-test folded results against runtime operators.

14. [ ] **Add tagged immediate/static-key operands.** Avoid separate `CREATE_STRING`,
        `CREATE_NUMBER`, and intrinsic-load instructions when call/property/construct
        operations can carry immutable operands. `dataview.js` has ~1,074 static-key
        property loads; `unicode-ignoreCase.js` has ~6K numeric-constant operations.
        Keep dynamic-key evaluation order and exceptions unchanged.

15. [ ] **Add resumable static call tables for generated data-driven tests.**
        `unicode-ignoreCase.js` contains ~2,938 calls to one helper. Encode arguments
        as static rows and execute them through a resumable loop that performs callee
        lookup and each call in original order, preserving reassignment, throws, GC,
        and source attribution. Compare this with the smaller tagged-immediate design
        before adding a specialized opcode.

16. [ ] **Intern byte-identical definitions and function bodies.** Escaped and
        unescaped Unicode identifier variants produce identical lowered definitions;
        many DataView callbacks also share bodies. Content-address immutable
        definitions/functions/constants/debug tables so physical C/object data is
        shared without merging JS function identity, realm, environment, or mutable
        runtime state.

17. [ ] **Evaluate a lower literal-template threshold and static property opcodes on
        medium definitions.** In `dataview.js`, 28 static array literals remain below
        the current 32-word template threshold. Benchmark code size and runtime before
        changing the global threshold; prefer a cost model over a test-specific rule.

## P3 — Measurement and suite scheduling

18. [x] **Recover exact per-test code statistics from cached artifacts.**
        `scripts/test262-code-stats.ts` links a read-only inspector against interpreted
        batch objects, validates batch totals, deduplicates partial-run artifacts, and
        ranks definitions without executing tests.

19. [ ] **Persist per-entry code statistics in future artifact manifests.** Add
        function/instruction/opcode counts beside each manifest entry so ranking does
        not require object inspection. Preserve fast batch aggregate replay and avoid
        invalidating artifacts solely for reporting-schema changes if possible.

20. [ ] **Give C batches stable identities and attributable metrics.** Current timing
        output labels every batch only as `batch(n)`, so 40-55s clang outliers cannot
        be mapped to tests. Record artifact key, member paths, generated C bytes,
        function/instruction totals, object bytes, cache-hit state, worker, and phase
        timings in the report.

21. [ ] **Preserve both strict and sloppy reports.** `test262PrepareBuild()` deletes
        the build directory before each variant, removing `report-strict.json` when
        sloppy starts. Separate ephemeral build artifacts from report output or clean
        once before the dual run.

22. [ ] **Persist full-run slow lists as a durable report.** Keep top-N per-test
        front-end/runtime timings and attributable C/link batches in a repository-
        ignored JSON artifact. The committed verdict baseline should remain compact.

23. [ ] **Measure and schedule C compile/link contention.** Reproduce compiled batches
        with controlled worker counts and stable IDs. Compiled-sloppy link spikes up
        to 18s appeared to be scheduling/I/O noise; if confirmed, limit concurrent
        links or separate linking from peak clang activity without reducing compile
        parallelism.

24. [ ] **Add an uncensored targeted profiling mode.** Keep the normal 1s conformance
        watchdog, but allow explicit diagnostic runs to collect completion time, CPU,
        RSS, GC, and phase markers for known slow tests without editing constants or
        allowing runaway processes by default.

## P4 — Lower-return cleanup

25. [ ] Avoid constructing semantic/IR debug renderings when `MAL_DEBUG` is disabled.
26. [ ] Replace compiled C emission's per-instruction linear handler scan with an
        interval cursor/index (`handlerForIp` is currently `O(instructions * handlers)`).
27. [ ] Revisit exact timezone-offset caching only after higher-impact Date work;
        direct `jiff` lookup measured about 2% of the DST shard runtime.
