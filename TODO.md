# Maligator roadmap

This is the sole project roadmap. It contains unfinished work only; completed work
belongs in commits, tests, generated reports, and benchmark baselines.

Each task has one owning section. Cross-cutting dependencies may be mentioned, but
the work itself is not duplicated. Priority orders performance work; correctness,
rooting, and resource-safety defects can interrupt that order.

## Current priorities

1. Identify the first missing or lost proof at real hot sites, rather than repeating
   emitter-only searches. Complete the P0 admission audit before choosing another
   multi-optimization implementation session.
2. Extend bounded Core analysis and its consumers together: start with callback-aware
   call summaries, selective effects, and field/representation facts. The first P1
   implementation is selected by applicability and cost, not by syntax alone.
3. Improve Core planning and optimization throughput on both Node and the self-hosted
   compiler. Measure this alongside every analysis extension, not as leftover work.
4. Use those foundations for scalar materialization and virtual iteration, then
   source-closure reduction and profitability-aware specialization. These are
   dependency-ordered workstreams, not parallel requirements for the next session.
5. Resolve known reliability findings, including the intermittent DNS gate failure;
   stabilize alpha releases and recoverable resource handling.
6. Advance ECMAScript, WinterTC, Node, and ecosystem correctness. Their existing
   backlog below remains in scope; it is not replaced by the performance programme.
7. Recover throughput and bound latency in the concurrent generational collector.
   Keep the native worker and Wasm inline behavior, following the ownership and
   root contract in [generational GC workers](docs/decisions/09-generational-gc-workers.md).
8. Pursue actors, SMP, embedding, and freestanding targets after the active runtime
   foundations are ready.

## Verification workflow

- [ ] Restore a portable full gate on Linux: derive native-entry audit targets from
      the probed toolchain, honor the configured Cargo cache in toolchain fixtures,
      and wait for subprocess readiness before testing signal handling. Resolve
      cold-build timeouts in remaining native/sanitizer suites, the asynchronous
      crypto event-loop tick assertion, and the compiled WPT harness failure.

- [ ] Resolve the remaining concatenation, typed-array, and retained-graph costs
      against `d871b66e` with matched kernel measurements. The historical JavaScript
      phase regressions have recovered; separate profile samples still show possible
      kernel regressions. Keep representative output parity and phase timing controls.

- [ ] Broaden runtime-gap coverage with enabled RegExp/Intl, pending and rejected
      promises, weak-reference collection, arbitrary-precision BigInt beyond the
      current 128-bit storage, and input-size scaling. Keep conversion costs separate
      from traversal and checksum work.

- [ ] Retain gate reports per run with source revision/content identity. The current
      `scripts/test-suite.ts` overwrites `report-<tier>.json` and cannot associate its
      stage verdicts with a specific source snapshot. Preserve a discoverable latest
      report without replacing earlier evidence.

- [ ] Align `scripts/command-requirements.ts` with actual cache-lease behavior. Unit
      and quality plans declare no user-cache writes, while their `CommandProgress`
      wrappers create leases there. Verify the declared capabilities against the
      command lifecycle so restricted execution retains cache coordination.

- [ ] Track configured asset-directory topology in `dev`. Publication validates
      consumed file identities, but adding a file or renaming a previously unwatched
      path does not change that file set. Capture recursive directory membership and
      exercise add/remove changes without editing an existing source dependency.

# Compiler and Core IR

## Core IR contract

Core SSA is the only optimizing middle end for development, testing, interpreted
execution, native execution, and production builds. Internal formats use a hard
cut-over: schema changes invalidate cached artifacts rather than introducing adapters
or compatibility paths.

Core owns all multi-instruction optimization decisions and their proof obligations.
Target lowering may validate and consume Core decisions, while VM and C emission
perform only local lowering from explicit target metadata.

Performance recovery should come from standard SSA, dataflow, effect, representation,
and whole-program optimizations. Do not maintain a queue of retired optimizer patterns
to restore; generic passes may naturally rediscover their useful results.

An emitter-only restriction is not a project-wide restriction on analysis work.
Prefer preserving and consuming existing facts, but extend analysis when a concrete
hot consumer needs a stronger proof. An analysis contract may land before its
consumer with precision, invalidation, and cost tests; it is not a runtime speedup
until the consumer admits real sites and measurements establish a benefit.

## Native SSA storage

The independent target boundary and current storage contract are recorded in
[native SSA lowering](docs/decisions/native-ssa-lowering.md).

- [x] Persist compact physical shadow-root slots for audited direct SSA locals;
      preserve dedicated entry, borrowed, and helper-output storage and publish
      the current physical-slot occupant on collecting edges.

- [x] Schedule default-successor traces for native functions without selected region
      or field-call contracts; preserve source positions, handler transport, and polls.
- [x] Schedule native default traces between selected region and field-call spans;
      preserve their internal Core order and verify every moved copy independently.
- [x] Persist live suspension values in compact boxed slots with per-site save and
      restore maps; keep scalar computation in typed C locals. Cover queued
      async-generator resumes, throwing await resolution, eval splices, and
      concurrent-GC ownership transitions.
- [x] Reuse suspension slots per site and compose scalar expressions, constants,
      TDZ omission, and initialization in unprotected resumables.
- [x] Compose scalar expressions, TDZ omission, and definition initialization in
      independent numeric windows beside selected regions and exception handlers;
      preserve borrowed operands and protected windows.
- [x] Persist multi-field typed stack storage for direct activation-local objects
      with existing non-materializing certificates and stable scalar fields.
- [x] Preserve scalar fields in mixed activation-local stack objects; root only
      stable boxed and string fields in dedicated active shadow slots.
- [x] Keep stable fields typed through certified returns, boxing into a rooted
      materialization vector only on the escaping edge, including boxed-result
      typed entries.
- [x] Persist paired-array, constructor initialization, and private-field capacity
      plans per entry, including borrowed storage and original fallbacks. Recheck
      paired receivers at each read and reject effectful eager-shape windows.
- [x] Persist typed call argument/result conversions per caller entry, validate
      target ABIs across artifact and batch boundaries, and retain guarded fallback
      and realm/exception/root behavior without boxed completion aggregates.
- [x] Use selected ordinary script-call transports to keep boxed final results in
      private locals, preserving GC publication, guard misses, exceptions, and
      disjoint heap lifetimes while retaining borrowed inputs and virtual fields.
- [x] Reuse existing selected typed entries for exact Array callbacks through
      guarded adapters, retaining canonical fallbacks, callback argument roots,
      receiver/realm handling, and independently bounded optional entry code.
- [ ] Extend selected typed call/aggregate transport and expression regions using
      Core proofs, with bounded code-size decisions and matched runtime evidence.
      Move remaining emission-local selection into explicit native plans before
      claiming the C emitter only renders selected decisions.

- [ ] Improve Node.js self-compile phase time and memory using the restored cold
      paired comparison. The protocol now requires strict emitted-C and runtime-image
      byte parity; use matched before/after evidence for speedup claims. Compiling
      the compiler itself peaks near 1.6 GB of live heap while its Core, execution,
      native, and image forms coexist; Node 24's default 2 GB heap leaves little
      margin for in-process native builds of the compiler.

- [ ] Spread one split native function over several translation units. Outlining
      functions past 256 Ki into 128 Ki parts cut the self-compile `-O2` unit wall time
      from 132 s to 59 s at eight jobs, but `emitInstruction`'s parts still compile
      in one 19–21 s unit, now the slowest. Parts are static and share a per-function
      transfer struct, so they need external part symbols and a shared struct header.
- [ ] Reduce the native splitter's emission cost. It adds about 1.1 s (13%) to Node
      emission of the self-compile program, mostly block parsing and bitset liveness
      over every value local that a part names. In the native self-compiler its
      tokenizer, liveness, and interface planning take about 9% of the emission
      phase; flattening rope lines before tokenizing only moved that time into the
      tokenizer itself. The lasting fix is to stop recovering declarations, uses,
      control transfers and address-exposed storage from C text: emission units
      should carry that metadata for the operations they actually emit, including
      fast-path branches and helper temporaries, and the splitter should consume
      it. That needs every renderer path to report its C-level reads and writes,
      so it lands as one migration rather than per opcode. A cheap splitter would
      also pay for lower thresholds: splitting past 64 Ki into 32 Ki parts cut the
      self-compile's clang CPU from 352 s to 322 s, but added 4 s of
      single-threaded emission, which cancels the saving at eight jobs.
- [ ] Use dominance for definition-initialized locals in functions with exception
      handlers. Handler entries currently disable it, so
      `lowerExecutionFunctionToNativePlan` still zeroes 4,351 registers on every call.
      Handler edges must leave from before each protected instruction's writes.
- [ ] Fold TDZ checks on captured and module bindings. Property-load results no
      longer keep their checks, but 18,942 remain in the self-compile C, mostly on
      reads of captured cells and module globals. A closure created after its
      owner initializes a binding can never observe that binding's TDZ, and an
      owner's own read is safe once the initializing store dominates it with no
      environment rebinding in between.
- [ ] Bring the native self-compile's memory closer to its live set. Peak live
      bytes stay near 900 MB, but maximum RSS is 4.4 GB now that process GC
      pressure backs off past its budget (it was 3.5 GB while pressure forced 183
      major collections and cost 40 s), and RSS understates it: on macOS the
      physical footprint peaked at 6.2 GB because up to 2.1 GB of GC chunks were
      compressed. At the end of a run the 4.1 GB of mapped chunks hold 311 MB live
      after the last major, 1.4 GB of free cells in partly live cell blocks, 1.4 GB
      of recycled empty blocks and 0.46 GB of free raw cells; 1.5 GB was promoted
      and 645 MB of it over-tenured. Malloc zones add another 0.96 GB in 10.5
      million allocations outside the GC heap. Fragmentation of partly live blocks
      and promoted garbage are the levers; recycled blocks are already madvised.
- [ ] Win back the open-compiled allocation phase. Since the inline static
      property probe keeps only monomorphic and inherited-value hits, that phase
      runs about 9% slower on the JavaScript benchmark because its polymorphic hits
      take the out-of-line probe. Reading the GC poll flag through a VM pointer
      cost the same phase another 20%, so that change was reverted: the pointer
      load stays in the loop where the thread-local address was hoisted.
- [ ] Cut the cost of minor sweeps in large programs. The native self-compile
      allocates 71 GB, and minor collections spend 6 s sweeping 616 million young
      cells, almost all dead; skipping the finalizer's out-of-line calls for plain
      objects saved 1.5% of that, so touching each dead cell is the cost.
- [ ] Stop fingerprinting every bytecode function with `JSON.stringify` to trust its
      safepoint root maps (452 ms of a 40 s Node frontend). Only functions that keep
      bytecode consume the trust. Profile builds also replace `profileSiteIds` in
      place after trust is established, which silently drops the exact root maps
      of every interpreted function.

- [ ] Share one invocation-local native analysis context across storage, expression,
      root, and fast-path planning. Native read/write, branch, handler, and lazy
      root-cycle facts now share an invocation; storage CFG analysis is lazy.
      Combine preserved Core identities with native
      CFG, effects, ownership, and uses; invalidate facts after layout/copy changes
      and measure cost on both compiler hosts without another wholesale IR rewrite.
- [ ] Finish remaining legality-affecting renderer selection in explicit native
      plans; capture-owner and String-transform strategies now persist and validate.
      Exact String comparison and concatenation operand proofs now select direct
      kernels through boxed storage as well as physical String locals.
      Rendering may choose C syntax; semantic
      assumptions, specialization admission, and ownership obligations belong in
      planning and must retain validated fallbacks. Deferring incoming root
      publication to a probe's collecting slow path stays renderer-local: eager
      publication is always legal, and the deferral follows fixed render-form
      rules over plan facts rather than a planning choice.
- [ ] Measure suspension planning with growing resumable functions on both compiler
      hosts. Bound instruction-by-value liveness storage and repeated variant/
      validation work. Block liveness and continuation snapshots now replace dense
      per-instruction state; quantify scaling before expanding coroutine specialization.
- [ ] Select the next proof consumer from a measured hot path rather than
      local-count or plan-kind totals. On the shape-analysis cone the native
      self-compiler went from 43.4 s to about 29.3 s on one machine (Node: 8.4 s);
      array for-of loops whose iterator reaches only its steps and closes no longer
      allocate it (iterator cells were 21% of sampled bytes before that), and
      inherited getters, alternating prototype methods and empty sites answered by
      the shared inherited stub no longer take the collecting property slow path
      (its entries fell from 242 to 52 million). Shrinking the inline static
      property probe cut 16% of the self-compile text and made the cone 2.5% faster:
      most samples in hot runtime helpers land on their first instruction, which
      points at instruction fetch across 44 MB of text rather than their bodies. Self
      time now puts 26% in generated code, 19% in property caches, 11% in call
      dispatch, 11% in GC, and 3% in macOS thread-local lookups; call caches and the
      root-frame head no longer use thread-locals, so the rest comes from safepoint
      polls, runtime protector flags, and GC allocation state. The hottest
      generated functions are one-line Core store accessors called through
      `mal_vm_call_cached`. Measured dead ends: `__builtin_expect` on the
      generated throw check made the cone 11% slower, and forcing `always_inline`
      on the hottest small value and cache helpers changed nothing. Hinting
      single-target methods outside loops changed nothing: the accessors read
      private fields through class-scope captures, which a guarded inline cannot
      resolve without the callee's environment, and the same accessors with
      public fields inline but stay within 6% because each iteration still pays
      every property probe that V8 hoists out of the loop. Exempting
      single-target guarded direct calls or small inlines from the program
      generated-code budget made thousands more sites direct or inlined without
      changing wall time, because
      callee frames rather than dispatch carry the per-call cost. Exempting
      iterator cursors from the four-expansion per-function cap admitted 350 more
      array cursors but spent the program budget that collection call chains and
      result virtualization had used, with no wall-time change; doubling the
      specialization program budget and moving the allocation mark state from
      thread-locals onto the heap also left wall time unchanged, as did moving the
      open-world Math call hint from a thread-local into the call-cache row (an
      open-world copy of the allocation loop stayed at 171 ms; clang hoists the
      thread-local address out of the loop). Hot accessors only
      sped up once inlining accepted throwing callees and class-scope closures.
      Inlining the strict `this` check and reading the callee's realm field
      directly in `mal_vm_call_cached` and guarded direct calls did not change the
      JavaScript benchmarks either (closed-compiled wall +0.65%), and moving a
      private field load's root publication into its probe miss, as static loads
      do, left the shape-analysis cone at 27.8 s while adding 45 Ki code units. A
      hot accessor takes about a quarter of its own samples on its first
      instruction, so entry, not root stores, is where its time goes.
- [ ] Decide whether native builds should scan C stacks conservatively instead of
      publishing shadow-stack roots. Root slots, masks and their publication are a
      large share of the emitted C. A prototype that emitted none of them scanned
      the running stack after a `setjmp` spill and every suspended fiber from its
      saved stack pointer, mapping each word, raw or NaN-boxed, to an allocated cell
      through the chunk index, block cell size and bump pointer. It cut the
      self-compile C by 22%, its clang CPU by 14% and its Node emission by 35%, and
      passed the GC stress fixtures. However, self-compile wall time and RSS did not
      move (168 to 177 s either way), so the gain is build time only. Wasm cannot
      scan its stack and keeps precise roots, so both modes would stay supported.
      Stale stack words retain dead objects, which breaks three deterministic
      WeakRef and ephemeron reclamation tests. Recycled cells keep stale contents,
      so a dead, half-initialized cell found on the stack would be traced through
      freed edges unless allocation clears payloads and tracers accept null shapes.

## World-knowledge ladder

| Level             | Available knowledge                                                                   | Intended result                                                             |
| ----------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Universal         | Ordinary open JavaScript semantics                                                    | Local SSA, escape, representation, shape, and effect optimization           |
| Epoch-guarded     | A recorded identity, shape, or semantic condition remains valid for an epoch          | One guard, unchecked operations, and an explicit generic twin               |
| Proof-specialized | Local identity, consumer, escape, effect, or representation facts narrow an operation | Direct lowering, scalar replacement, and bounded materialization            |
| Authority-closed  | Primordials and host authority are locked although runtime source may remain open     | Primordial identities become invariants and mutation fallbacks disappear    |
| Source-closed     | All source and externally callable entry points are known                             | Whole-program reachability, cross-call specialization, and output reduction |

These levels are cumulative facts consumed by one optimizer, not separate pipelines.
Runtime eval may remove source closure without invalidating authority closure.

## P0: performance diagnosis and admission

- [ ] Produce a bounded, source-ranked missed-optimization report for current
      JavaScript, representative compiler inputs, and relevant Express hot paths.
      Extend the existing fact-flow, candidate, and profile reports rather than
      building a parallel diagnostics framework. For each leading site, record
      observed cost, applicable facts, attempted consumer, admission/decline reason,
      and the expected removal in generated C. Distinguish missing analysis, lost
      facts, an insufficient semantic contract, absent lowering, budget rejection,
      and already-specialized code whose runtime kernel is still expensive.
      Exit with the leading five opportunities and one chosen vertical slice; do
      not make exhaustive instrumentation a prerequisite to useful implementation.

- [ ] Trace the reported callback, iterator, and scalar-record blockers through
      Core facts, candidate selection, region/signature admission, variant planning,
      target/image lowering, and emission. Establish the first failing boundary:
      ordinary-call-driven signature selection for builtin callbacks, iterator
      synchronization with an authoritative language object, or field/initializer
      facts and materialization requirements. Separate absent proofs from valid
      conservative declines. Retain a reduced positive and negative fixture for
      each selected blocker; do not assume that its previous workaround is the fix.

- [ ] Establish two distinct cost ledgers on the same source checkpoint: execution
      of generated applications, and compilation on Node versus the self-hosted
      compiler. Rank compiler work by phase and sampled source cost, then inspect
      hot functions' generated paths. Separate excessive compiler work from slow
      execution of that work. A report must not infer runtime progress from static
      helper counts, a synthetic-only win, or unchanged generated operations.

## P1: callback-aware interprocedural facts

- [ ] Extend shared builtin descriptors with the callback invocation contracts
      needed by the selected hot consumer: argument kinds/arity, receiver, return
      use, invocation multiplicity, retention, and synchronous versus deferred
      invocation. A sort comparator must receive numeric facts only when element
      facts justify them. Preserve canonical identity and mutation requirements;
      builtin names or source closure alone do not prove callback behavior.

- [ ] Feed certified builtin callback edges into the existing bounded signature
      selection and call-summary machinery, rather than restricting eligibility to
      ordinary calls. Reuse the per-target and program budgets; account for unknown
      callers, recursion, defaults, extra arguments, and captured environments.
      Lower one hot callback consumer through the selected typed entry while
      retaining required activation checks and generic fallback. Exit with real
      admitted sites, less executed marshalling/dispatch, semantic parity, and the
      full discovery/planning cost on both compiler hosts. Do not duplicate the
      sorting algorithm or create an unbounded callback-specialization matrix.

## P1: selective effects, aliases, and field facts

- [ ] Extend the existing summaries with the parameter-relative effects required
      by a selected consumer: field reads/writes, aliasing/retention, callback
      invocation/reentry, and mutation of relevant prototype or buffer state.
      Preserve useful facts across a proven read-only call or an unrelated write;
      unknown effects stay conservative. Start with scalar-field calls and callback
      regions, using bounded summaries and the existing analysis manager rather
      than a general whole-heap points-to analysis. Test invalidation and recursive
      summary convergence as well as the positive optimization.

- [ ] Preserve useful value, field, and range facts through joins, selected calls,
      variant-local planning, and target lowering. Distinguish semantic kind facts
      at an operation from a physical register's joined storage representation.
      Diagnose boxed initializers instead of assuming every boxed value requires
      an observable object. Keep numeric signed-zero/overflow constraints and
      pointer-root requirements explicit. Extend the existing bounded range walk
      only for a demonstrated consumer; a larger walk limit is not an optimization.

- [ ] Extend existing scalar-replacement, field-entry, and conditional-materialization
      plans to one real multi-field region unlocked by the preceding facts. Keep
      fields in SSA/native values through admitted operations and materialize only
      at certified observations or fallbacks. Preserve initializer effects/order,
      aliases, per-allocation identity, joins, exceptions, and GC roots; never
      re-evaluate an initializer or manufacture a different fallback object.
      Exit with reduced executed allocation/slot traffic on a representative
      workload, not merely a new plan kind or a synthetic object that never escapes.

## P1: compiler throughput and analysis scalability

- [ ] Invalidate warm frontend caches when module-resolution topology changes.
      The original serial cache can retain a resolved `.mjs` target after a preferred
      extensionless file appears, or retain a package target after a nearer package
      is added. An unchanged warm build then reuses the old wire while forced
      compilation selects different code. Track the resolver's absent candidates
      or equivalent selection identities, including worker roots; test edit-free
      warm invalidation without clearing caches or reparsing every graph on a hit.

- [ ] Reduce the largest measured Core planning/optimization costs on both hosts.
      Attribute candidate discovery, shared-fact/transfer construction, CFG and
      dominance work, fixed-point iterations, invalidations, and materialization of
      intermediate data. Use the existing feature indexes, summaries, and analysis
      manager to skip irrelevant work and rebuild only invalidated results. Reopen
      a previously optimized subsystem only with fresh residual-cost evidence.
      On the Node-hosted self-compile (43 s), memory and provenance optimization
      takes 7.4 of Core's 20 s. Its static-value queries cost about 2.5 s, mostly
      memory forwarding (`valueForRead`, `solveSlot`) while describing a receiver
      that is itself a load: `fold-static-property-reads` spends 1.7 s over 7,681
      runs for 20 changed functions, and `lower-primitive-operations` 1.0 s for 40.
      Skipping that forwarding changes which reads fold, so it needs a measured
      output comparison rather than a byte-parity check. Verification is another
      5.5 s (13%), most of it independent re-derivation at trust boundaries.

- [ ] Put aggregate work and memory budgets around analysis extensions, including
      rejected candidates and nested queries, not only admitted entries. Reuse
      versioned queries within their valid lifetime; bound contexts and recursive
      propagation and fall back conservatively on budget exhaustion. Record
      instruction visits, transfer/summary builds, cache reuse, and peak retained
      data in opt-in diagnostics. Do not trade a cheap emitter for hidden planning
      scans, uncontrolled cache growth, or a new unconditional whole-program pass.
      Memory versions now solve requested partitions, repeated-load proofs start
      after matching inputs and dominance, and late target payloads are built only
      after selection. Memory events now belong to requested partitions, heap
      accesses resolve by allocation root, and layouts/escape proofs are lazy per
      allocation. Slot-only queries avoid heap provenance entirely. Optional loop
      and receiver certificates now wait for recipe consumers; numeric-array and
      closed-global indexes wait for eligible reads. Constant and array-brand
      queries avoid replaying mutable contents. Scalar-family queries now skip
      integer propagation, and heap brands skip containment/use/range indexes.
      Integer proofs follow requested COPY/JOIN dependencies; containment checks
      follow requested allocation roots. Program kinds now have an independent
      query and journal cursor; terminal cross-call refreshes update summaries and
      reachability without solving unused kinds. Static queries skip impossible
      cell/identity proofs. Memory columns share broad clobbers and compact
      unobserved intermediate definitions. Remaining work: decode memory accesses
      by requested family, narrow shared instruction/root/use indexing and partition
      state to requested reads, query only the needed property contents, and defer
      candidate recognition while preserving exact ranking and costs. Measure the compact
      integer snapshot's retained memory and representative compile time before
      extending these caches.

- [ ] Repair indexed-length-loop region cost verification for the existing
      `core-primitive-numeric` Array.from length and holey-array checksum cases.
      Both fail the instruction/cost contract in VM lowering on `0f39d688`, before
      demand-driven analysis changes. Preserve the region checks and numeric
      semantics when reconciling discovery, selection, and lowering costs.

- [ ] Add representative small, medium, and large compiler-scaling cases to the
      existing measurement workflow. Alternate Node and rebuilt self-hosted
      measurements, checking equal generated output within each checkpoint.
      Exercise production and diagnostic configurations where their paths differ.
      Accept improvements by end-to-end execution and memory costs; retain phase
      regressions explicitly and distinguish reduced work from host-specific speed.

## P2: virtual iteration and loop regions

Depends on a P0 hot site and the necessary P1 effect/escape facts. An existing
iterator cursor is not, by itself, permission to delete its language object.

- [ ] Add an explicit Core ownership/materialization contract for a nonescaping
      array or fixed-TypedArray iterator whose language identity need not be
      observable on the admitted path. Define authoritative cursor state, progress,
      exhaustion, mutation visibility, exception/close behavior, and reconstruction
      before any fallback. Start with one exact synchronous protocol; preserve own
      iterator overrides, inherited properties, holes, and required roots/polls.
      Exit with removal of an actual hot iterator/protocol allocation or dispatch,
      plus negative tests that retain the authoritative-object implementation.

- [ ] Consume range, storage-stability, and effect facts in a bounded loop region
      to avoid repeated length, bounds, identity, and element-kind work. Preserve
      per-iteration length semantics when mutation is possible, and reload backing
      pointers across invalidating operations. Reuse existing loop/region machinery
      and separate admission checks from proven interior operations. Do not claim
      SIMD/vectorization from simpler C, remove necessary polls, enable fast-math,
      or reorder observable accesses to make a loop look native.

## P2: composable temporary values

- [ ] Extend existing string/capture projections only where the P0 profile shows
      materialization is a leading cost. Compose a bounded sequence of span,
      concatenation, length, numeric, or character consumers through an explicit
      virtual-value contract, instead of adding source-pattern recipes. Preserve
      UTF-16 indexing, source lifetime, case-conversion semantics, length limits,
      effects, and fallback materialization. Distinguish string allocation costs
      from RegExp/native-kernel costs that more compiler analysis will not remove.

## P2: source closure and generated-code profitability

- [ ] Reduce remaining execution-liveness work where saved analysis outweighs demand
      bookkeeping. Sharing across verification or frame-exit consumers requires an
      explicit body-ownership contract; mutable function identity is insufficient.
- [ ] Establish a complete source-closed entry/escape set for native reduction,
      including exports, host callbacks, dynamic loading/eval policy, reflection,
      and generic/interpreted callers. Use it to remove unreachable functions,
      unused ABI siblings, bytecode, and metadata only when every required entry
      and fallback is covered. Retain canonical boxed adapters where observable;
      locked primordials alone never justify deleting them. Reuse the same closure
      certificate for runtime-feature reduction and verify all affected loaders,
      cache identities, debug/profile modes, and mixed execution paths.

- [ ] Extend the existing generated-code cost model to charge for whole admitted
      regions and ABI siblings, retained generic twins, materialization, guard
      frequency, and downstream C compilation/linking. Calibrate on small and
      large representative inputs and expose reasons for budget declines. Keep
      per-function and whole-program caps; prefer profitable shared mechanisms
      over many clones. Treat measured runtime, analysis time, build memory, and
      code-size tradeoffs as separate acceptance dimensions.

- [ ] Validate a stable per-function optimization policy for pathological generated
      bodies. A 4.1 MiB self-compile body compiled about 47% faster at `-O1` than
      `-O2`, but its object grew and linked runtime behavior was not measured. Use
      source-stable diagnostics rather than generated ordinals, and require matched
      runtime, startup, binary-size, and correctness evidence before adoption.

## Compiler infrastructure

- [ ] Extend the shared bytecode-operation and builtin descriptors to generate operand
      schemas, lowering completeness, effects, representation constraints, safepoint
      policy, and GC declarations. Adding an operation must not leave compiler, wire,
      native-C, interpreter, or runtime contracts inconsistent. Callback invocation
      semantics are owned by the P1 callback work above, not a second descriptor set.

## Compiler measurement and diagnostics

- [ ] Close gaps in the existing report's end-to-end cost accounting: cold process
      versus warm kernel time; complete analysis discovery/planning; register
      allocation, lowering, emission and serialization; downstream C compilation
      plus linking; generated C/binary size and peak build memory. Retain source,
      host, toolchain, flags, world/eval policy, runtime features, cache state,
      sample dispersion, and raw paired samples. Node repeats beside development
      and production native executables are controls, not two Node build modes.

- [ ] Extend source-derived C symbols/line mappings and the existing source-to-Core,
      target, C, and disassembly reports with final admitted-entry identities and
      decline reasons. Retain a sidecar mapping for stripped production artifacts
      without changing the measured flags or requiring local symbols to survive.
      Final compiler remarks must agree with the emitted path; static counts and
      sampled/executed counts must remain distinguishable.

## Compiler acceptance policy

Use staged acceptance: inspect applicability and the expected Core/C change, run
focused correctness tests and a bounded pilot, then invest in repeated representative
measurements for a promising vertical slice. Do not spend a full benchmark matrix
proving that a candidate with zero admitted sites changes no executed code. Such a
candidate may still be compiler-throughput work, but must be measured as that.

Every accepted runtime optimization requires focused semantic coverage, optimized-Core
and proof validation, an actual allocation/dispatch/materialization change, and
repeated representative timings with matching checksums. Analysis-only milestones
need explicit precision, invalidation, budget, and cost evidence, with their consumer
still tracked as unfinished. Structural simplification is not a measured speedup.

Measure both compiler hosts when analysis/planning changes. Include discovery and
rejected candidates; tiny warmed per-entry timings are not total compiler overhead.
Use the same frozen input and configuration, rebuild native hosts from the checkpoint
under test, and require Node/native output parity within each checkpoint. Keep
intentional baseline/candidate output differences distinct from host divergence.

Report controls individually, including negative and inconclusive results. Preserve
raw samples; do not treat marginal and paired medians as interchangeable or attribute
a combined win to every constituent change. Prevent unexplained material regressions
and record accepted phase, memory, size, and compilation tradeoffs explicitly. A
synthetic fixture establishes a mechanism, not its importance in real applications.

World-sensitive work requires applicable locked/mutable, strict/sloppy, mutation,
eval and cross-Realm coverage, safe invalidation, and evidence that only disproven
guards/fallbacks were removed. Preserve exception, OOM, rooting, suspension, debug,
profiling, and mixed-execution contracts at their owning layer.

Follow AGENTS.md and docs/testing.md for the relevant gates. Full standards/full
release runs and baseline updates remain separate approvals. Keep detailed evidence
and completed/rejected experiment history outside this unfinished-work roadmap;
retain reproduction sources and helpers with their evidence instead of deleting the
only reproducible input.

# Release and product readiness

## Cross-platform native binaries

- [ ] Validate and document minimum supported macOS and glibc-based Linux versions for
      arm64 and x64 artifacts. Windows remains deferred until deliberately selected.

- [ ] Build the product CLI natively for every supported target in CI. Keep
      target-specific runtime and archive inputs attributable in the artifact manifest.

- [ ] Run the release smoke test against every artifact, including a clean host with
      only documented toolchains. Exercise installation, diagnostics, project creation,
      production building, and execution outside the repository.

## Release operations

- [ ] Run npm run test:full:report for release candidates and resolve or record every
      result. This gate and the full Test262 corpus remain approval-only.

- [ ] Define a failed-release procedure that stops the workflow, deprecates broken
      versions, fixes forward, and publishes a new alpha. Never reuse a published
      version.

# Runtime safety and allocation

- [ ] Complete recoverable allocation failure for CELL, RAW, LOS, GC-internal,
      runtime-helper, and direct-native allocations. OOM must remain catchable without
      corruption, lost roots, recursive failure, or partial observable objects.

- [ ] Deterministically release nonescaping RegExp and ICU handles at compiled scope
      end once ownership analysis proves their lifetime. Retain finalization for every
      uncertain path.

- [ ] Add Intl locale subsetting with deterministic configuration and cache identity.
      Missing data must follow an explicit failure or fallback policy.

# Strings and text

The [text algorithm audit](docs/text-algorithms.md) records the implemented cost,
ownership, and bounded-resource contracts. Keep content parity, physical encoding,
allocation traffic, and retained memory distinct. Remaining work below extends those
contracts or investigates costs still visible after the string follow-ups.

## Focused performance work

- [ ] Fuse projected split/trim length consumption without flattening the shared
      rope or repeatedly descending from its root for each field's edges and slice.
      First prove split and trim results and their aliases do not escape through
      ordinary uses, terminators, or phi/jump-edge arguments; the current ordinary
      use index does not cover control-edge uses. Carry that stronger Core proof
      through region and artifact verification, and invalidate affected cache/schema
      identities before suppressing materialization. Preserve trim identity guards,
      observable fallback, reentry, and abrupt completion. Cover loop-carried and
      returned fields, then compare matched first-pass and repeated-input runs of
      concatenation-prepared and flat controls. Require throughput to hold against
      the materializing implementation, with complete output checks and
      GC/materialization safety.

- [ ] Investigate a bounded repeated-miss probe before property-query normalization,
      where already-string keys can avoid repeated constant-name and atom-table
      lookup. Preserve coercion and prototype invalidation, bound retained storage,
      and require repeated-miss gains without taxing existing atoms or unique-name
      churn. Keep the three property-query benchmark controls together.
      The rooted dynamic-key miss case in `property-transition-cache.test.ts` still
      performs 16,384 comparisons against its 1,026 bound.

- [ ] Extend the inline Array iteration expansion to flatMap, findLast,
      findLastIndex and unseeded reduce, each with fixture coverage of holes,
      receiver mutation and fallback receivers. Expanded sites still run the
      eligibility guard on non-Array receivers with the same method names (Map and
      Set `forEach`, user `find` methods); measure that tax before widening.

- [ ] Cut the per-element cost of expanded Array iteration loops: `array-map`
      still spends about 24 ns per element against Node's 2.5 ns. The HasProperty
      test and element load stay separate because the array presence projection
      does not fire on these loops, and a callback's loop-invariant captured read
      (`value + round`) reloads and rechecks TDZ every element.

- [ ] Explain the per-iteration cost of `map-get-hit-*-selected` loops, about
      40 ns regardless of size or key domain. At bf289f61 the compiled loop itself
      held 54% of samples against 26% for the hashed probe. Get line-level samples
      before changing the guarded collection arm or method capture.
- [ ] Reduce rope construction cost in append and prepend loops. Balanced joins
      split and rebuild O(log n) nodes per piece; `string-rope-access` still spends
      about 20% in join, split, node allocation and sweep. Copying short pieces into
      the adjacent edge leaf was measured and rejected: it slowed short
      concatenations by about 20% without improving rope access. Preserve the
      bounded-traversal, append-hash continuation and encoding-aware rope fixtures.

- [ ] Hash string keys faster than byte-serial FNV-1a without losing encoding
      independence or the leaf-streaming continuation that append hashing and the
      rope fixtures rely on. Long Map, Set and property keys pay roughly one
      dependent multiply per code unit.

- [ ] Remove per-match allocations from RegExp execution. regress builds a fresh
      backtracking executor for every exec, and each RegExp literal evaluation
      allocates a compiled-pattern handle freed at finalization; together with
      result arrays they dominate `primordial-string-regexp-projections`.

- [ ] Investigate full-output checksum traversal and construction/replacement in
      the complete mixed-text pipeline. Use `scripts/profile-text-pipeline.ts`
      with its encoding, escape, and surrogate controls, then confirm candidate
      changes through paired ordinary builds with the complete checksum retained.
      Bound marker overhead and resolve cooperative-sampler delay before treating
      instrumented phase intervals as production cost shares. Quoting counters
      alone do not attribute an aggregate timing change.

# ECMAScript correctness

## Modules and agents

- [ ] Finish dynamic-import resolution, import attributes, evaluation order, and error
      ordering. Cover compiled, interpreted, and runtime-loading paths.
      Dynamic-import target parse and linking errors must reject the import promise;
      ambiguous/circular re-exports and duplicate declarations currently fail the
      enclosing compilation. Preserve top-level-await sibling scheduling and
      fulfillment/rejection order.

- [ ] Fix default-export initialization and live bindings in self-importing modules.
      `instn-named-bndng-dflt-gen-anon.js` segfaults in compiled mode and reports a
      non-callable value in wire mode; adjacent default function, class, and expression
      cases also fail. Preserve namespace TDZ checks during cycles.

- [ ] Implement import-defer syntax and semantics. Integrate it with linking,
      evaluation state, cycles, and failure propagation.

- [ ] Implement AbstractModuleSource and source-phase imports. Preserve module identity
      and host loading boundaries across cached and uncached compilation.

- [ ] Add $262.agent and multi-agent Atomics behavior. Define worker lifetime, shared
      memory, synchronization, cleanup, and harness failure reporting first.

## Active correctness clusters

- [ ] Apply computed object-literal accessor names at runtime. For
      `const k = Symbol("field"); const o = { get [k]() {} };`, the getter's
      name is currently empty instead of `get [field]`. Reuse the evaluated
      property key and preserve the getter/setter prefix without repeating coercion.

- [ ] Fix remaining RegExp @@replace protocol and coercion cases. Prefer shared
      replacement semantics over case-specific branches.

- [ ] Set `RegExp.lastParen` from the last capture group. The legacy-features
      proposal and V8 use the last element of the captured values, an empty String
      when that group did not participate, for any group count; the runtime returns
      the highest participating group up to `$9`, and `tests/local/regexp_cache.js`
      asserts that (`/(a)(b)(c)?/` yields "b" instead of "").

- [x] Propagate shaped allocation failures through the owning handler: use the
      fallible shared helper, preserve allocation exception edges in Core, check
      native completion, and unwind the interpreter before forward-jump fusion.

- [ ] Fix remaining arguments-object legacy caller and parameter-expression behavior.
      Cover strict, sloppy, mapped, and unmapped forms.
      A statically declared sloppy function returning its mapped arguments can
      expose a `callee` value unequal to that function binding. The new identity
      assertion reproduces on `46b5043c` with compiled calls; investigate callee
      identity preservation separately from fresh descriptor initialization.

- [ ] Work class, compound-assignment, super, Proxy, and iterator-helper failures in
      descending shared-root-cause order. Keep each repaired cluster in the curated
      regression manifest.

- [ ] Preserve callable Proxy targets through Function.prototype.bind. Under mutable
      primordials, binding a Proxy around String.raw with an apply trap produces a
      bound invocation that throws "Value is not a function"; direct, call, apply,
      and Reflect.apply invocation succeed. Node accepts the bound call.

- [ ] Preserve Proxy targets and handlers across reentrant trap lookup. The
      `revoke-as-side-effect.js` case crashes in `getPrototypeOf` after the trap
      getter revokes the proxy; audit internal methods that reload those slots
      after calling user code.

- [ ] Complete script-global environment-record behavior across separately evaluated
      scripts. `$262.evalScript` still uses indirect eval, so persistent lexical
      declarations, declaration conflicts, and global-property attributes diverge
      from Script evaluation. Keep eval-created declarations distinct from script
      declarations, including deletability and restricted-global checks.

- [ ] Preserve iterator [[Done]] semantics in positional destructuring. Keep abrupt
      completion and iterator closing correct around exhausted iterators.

## Engine capabilities

- [ ] Replace the fixed 128-bit BigInt representation with arbitrary-precision digits.
      Remove width approximations from arithmetic, parsing, formatting, comparison,
      typed operations, and serialization.

- [ ] Work Intl from generated failure clusters covering supported values, locale
      options, NumberFormat, DateTimeFormat, and interval collapsing. Keep data
      availability distinct from algorithmic correctness.

- [ ] Implement `Temporal.PlainDateTime.prototype.with` through the existing Rust
      partial-date-time API. Preserve observable field access and conversion order,
      calendar fields, overflow behavior, and rejection of Temporal objects.

- [ ] Complete Duration `relativeTo` conversion for strings and property bags in
      `compare`, `round`, and `total`. Preserve option access order and Rust handle
      lifetimes for plain and zoned reference dates.

- [ ] Generate a ranked failure-cluster report from scripts/test262.json. Use it rather
      than mutable hand-maintained counts to select correctness work.

# Eval, Function, and Realms

## Eval correctness

- [ ] Finish EvalDeclarationInstantiation behavior for persistence, deletion,
      non-definable globals, and strict or sloppy conflicts. Cover every relevant
      environment kind.

- [ ] Complete direct-eval arguments and parameter-environment behavior. Preserve
      mapped parameters, parameter expressions, shadowing, and strict-mode differences.

- [ ] Complete eval-created and nested new.target behavior. Keep direct eval connected
      to the correct active function or constructor without exposing it indirectly.

- [ ] Preserve direct-eval completion-value identity and lexical write-back semantics.
      Cover abrupt completion and object identity as well as primitives.

## Realm correctness and runtime capabilities

- [ ] Decouple the baked eval compiler from the application's RegExp capability.
      Standalone builds with `engine.eval: true` and `engine.regexp: false` fail
      during compiler initialization even for `eval("20 + 22")`, in both source
      and packaged compiler paths. Remove the compiler cone's implicit RegExp
      dependencies or separate private compiler capabilities from application
      capabilities. Preserve the disabled public constructor, throwing regex
      methods, and omitted engine; cover native and interpreted compiler images.

- [ ] Preserve the iterator creation Realm when bypassing builtin `next` dispatch.
      On checkpoint `48aa2375`, a foreign Map's direct `entries().next().value` has
      the foreign Array prototype, while the same pair obtained through `for...of`
      has the current Realm's prototype in both backends. Audit protocol cursors
      and entry-pair materialization guards in `runtime/src/builtin_iterator.c`;
      cover borrowed `next` methods and modified foreign Array iteration as well.

- [ ] Implement module loading for ShadowRealm.prototype.importValue. Preserve
      wrapping, rejection, module identity, and cross-Realm error semantics.

- [ ] Fix residual cross-Realm cases selected from the committed Test262 verdict.
      Distinguish semantic builtin identity from exact per-Realm object identity.

- [ ] Accept erasable TypeScript syntax in runtime eval using a native
      blank-space-preserving stripper. Re-evaluate the compact implementation before
      selecting a larger dependency.

- [ ] Optionally tier hot eval-created functions through native C compilation when a
      toolchain is available. Preserve interpreter fallback.

# Host architecture and transport

The accepted ownership, streaming, cancellation, and event-loop contract is
docs/decisions/03-wave-0-host-architecture.md. Engine objects own language semantics,
API adapters own their public surfaces, and the host owns DNS, sockets, TLS, clocks,
entropy, cancellation, and reactor completions.

## Active host work

- [ ] Finish H1 with Happy Eyeballs racing, bounded teardown for resolvers stuck in
      getaddrinfo, a public one-turn pump, embedder access to the wake source, and
      runtime-owned timer state.

- [ ] Finish H2 hard limits, pipelining, and parser fuzzing around shared llhttp and
      streaming servers. Cover fragmentation, backpressure, cancellation, malformed
      input, and cleanup.

- [ ] Finish H3 connection pooling and the neutral streaming HTTP/1 client used by
      WinterTC fetch and Node adapters. Keep decompression policy above the host layer.

- [ ] Finish H4 sanitizer, fuzz, leak, symbol-size, and benchmark gates for optional
      Rustls. Keep TLS cancellation and teardown correct under GC stress and partial
      connection failure.

# WinterTC web platform

The target is the complete ECMA-429 server surface except WebAssembly. Mal.serve
remains a Maligator extension and does not count as global fetch conformance.

## W1: semantic substrate and streaming boundary

- [ ] Complete DOMException stack, descriptors, serialization, Web IDL behavior, and
      integration into stream and fetch errors. Use shared exception construction.

- [ ] Complete AbortController and AbortSignal coercions, dependent-signal lifetime,
      and cancellation integration. Expand applicable WPT once fetch shares the path.

- [ ] Define global exception and rejection reporting, including reportError,
      microtask failures, and exactly-once uncaught reporting. Choose the ECMA-429
      server-global mechanism explicitly.

- [ ] Complete residual byte-stream BYOB, descriptor, error, cancellation, and
      TransformStream semantics. Keep active Streams WPT slices green under normal and
      GC-stress execution.

- [ ] Bridge host llhttp headers and bodies to Web Streams without exposing parser
      buffers or socket ownership. Backpressure, EOF, abort, failure, and teardown each
      need one completion path.

## W2: bytes, bodies, URLs, and transforms

- [ ] Complete BodyInit validation, arbitrary stream bodies, asynchronous consumption,
      BYOB, tee, and remaining Request and Response properties. Preserve single-use and
      cancellation behavior.

- [ ] Implement Blob storage and streaming, File metadata, ordered FormData, multipart
      parsing and serialization, URL-encoded extraction, and Body.formData. Give native
      backing objects correct tracing and finalization.

- [ ] Complete Headers guards, Web IDL record conversion, descriptors, and
      Proxy-sensitive behavior. Expand applicable WPT with outbound fetch.

- [ ] Complete URL and URLSearchParams Web IDL behavior and broader WPT, then implement
      URLPattern. Connect object URLs after Blob lifetime and revocation are defined.

- [ ] Add remaining TextDecoder labels and Web IDL details, then implement encoding
      streams over TransformStream. Use versioned encoding data and incremental state.

- [ ] Add compression streams over a DCE-friendly backend. Cover format selection,
      chunking, flushing, errors, cancellation, and native-state cleanup.

## W3: fetch and crypto

- [ ] Implement global fetch over shared streaming HTTP and optional TLS after H3 and
      H4 are ready. Cover redirects, aborts, streamed bodies, limits, errors, and
      finalization without a private HTTP stack.

- [ ] Define server-runtime origin, credentials, cache, default User-Agent, and
      decompression policies. Document intentional Fetch divergences.

- [ ] Complete Crypto, CryptoKey, and SubtleCrypto with audited primitives and exact
      WebCrypto errors. Keep entropy at the engine-neutral host boundary.

## W4: compatibility closure

- [ ] Complete Console, timers, Performance, base64, global aliases, and remaining
      descriptors. Keep clocks and timer state isolate-owned.

- [ ] Complete EventTarget, event subclasses, MessageChannel, and MessagePort. Include
      listener options, entanglement, transfer, task delivery, reentrancy, and lifetime.

- [ ] Complete structured cloning for DataView, Blob, File, MessagePort transfer,
      active platform objects, properties, and Realm boundaries. Reuse compatible
      rules for actors.

- [ ] Expand to every applicable pinned ECMA-429 WPT and remove stale expected
      failures. Publish WebAssembly as the sole intentional exception.

# Node and ecosystem compatibility

- [ ] Measure remaining UPM performance paths: off-loop filesystem and
      decompression scheduling, and DNS/Agent dispatcher reuse. Use matched
      workloads after output parity; AOT does not need a V8 compile cache.

- [ ] Reduce boxing and numeric conversion in loop recurrences whose initial
      value is unknown, including persistent Tinypool task inputs. Scalar Math
      results and [proved integer truncation](docs/decisions/11-truncating-integer-arithmetic.md)
      remove intermediate conversions. The recurrence edge still boxes its value;
      specializing it must preserve zero-trip behavior and coercion effects.

- [ ] Extend asynchronous child-process stdio to pipes and implement exec/execFile;
      inherited and ignored stdio cover UPM commands. Exercise active-child cleanup
      in embedded VM teardown and Linux memory/libc reporting on a Linux host.

- [ ] Align node:module builtinModules/isBuiltin with the supported builtin registry;
      its separate list omits stream/promises and advertises unsupported aliases.

- [ ] Preserve partially consumed ciphertext in direct node:tls socket reads;
      the Rust TLS input ABI can accept less than one socket-read buffer. Exercise
      large encrypted bodies beyond the existing ping fixtures.

- [ ] Extend HTTPS transport beyond its verified default-trust fetch boundary:
      mutable Agent configuration and pooling, custom TLS options, and IPv6 DNS
      address selection. Request options refuse unsupported direct overrides;
      globalAgent mutation does not configure the current transport.

- [ ] Complete package.json exports wildcard matching, null targets, validation, and
      remaining modern Node resolution. Test the general resolver rather than pinned
      dependency paths.

- [ ] Complete observable node:http and node:net behavior beyond Express and
      postgres.js. Add socket APIs, Agent reuse, validation, lifecycle, cancellation,
      and error ordering over shared transport.

- [ ] Close measured Express performance gaps without regressing fixture behavior or
      bare-server throughput. Profile before selecting compiler or runtime work.

- [ ] Exercise postgres.js logical replication, prepared transactions, negotiated TLS,
      and primary or standby selection against a dedicated topology. Keep
      topology-dependent tests separate from the deterministic local baseline.

# Testing, profiling, and developer tooling

## Product profiling

- [ ] Add repeat, warmup, or minimum-duration handling for short profiled commands and
      a CLI for rendering existing captures. Document interval overrides as expert
      diagnostics requiring overhead revalidation.

- [ ] Harden the authenticated Claude and Fable review harness with a small read-only
      smoke, bounded cleanup, and explicit external-disclosure approval. Never expose
      or persist authentication material.

## First-class testing

- [ ] Add snapshots, fake timers, and mocking when their semantics can remain
      deterministic in compiled and interpreted tests. Keep the unit loop fast.

- [ ] Add coverage, browser environments, and process-per-file isolation
      independently. Fresh-isolate watch reruns and explicit file scheduling are
      available; define cache, port, temporary-directory, and failure-reporting
      behavior for the remaining modes.

- [ ] Add benchmark, fuzzing, and test-plugin support after stable extension points
      exist. Plugins must not silently broaden sandbox, host, or network capabilities.

## Test262 throughput

- [ ] Capture and analyze a current cold compiled-suite profile without updating the
      verdict baseline. Re-rank work from current phase, RSS, object-size, and link
      evidence.

- [ ] Evaluate resumable static call tables and adopt them only if they materially
      reduce generated C or object size. Preserve resumability, identity, and debugging.

- [ ] Merge additional byte-identical immutable helpers, constants, and debug tables
      without merging JavaScript identity or mutable state. Report size and compile-time
      effects.

- [ ] Measure lower literal-template thresholds on medium definitions and select a cost
      model rather than fixture-specific cutoffs. Include runtime allocation, output
      size, and compilation time.

- [ ] Use worker controls and batch reports to measure C compilation and link
      contention. Limit concurrent links only when attribution confirms contention.

- [ ] Add bounded targeted profiling flags for timeout, RSS, CPU, GC statistics, and
      phase markers. Require a filter or manifest and retain both watchdog deadlines.

# Actors, SMP, and embedding

## Actors

- [ ] Build rooted actor mailboxes and spawn, send, and receive semantics on fibers.
      Define message ordering, actor lifetime, roots, and teardown first.

- [ ] Integrate reduction-budget scheduling and prove a tight-loop actor cannot starve
      peers. Keep host completions and microtasks fairly observable.

- [ ] Copy actor messages with structured-clone semantics and support transferables.
      Preserve the no-cross-heap-pointer rule required by SMP.

- [ ] Add links, monitors, kill, cancellation, and deterministic teardown. Specify
      failure propagation without bypassing exception reporting.

## SMP

- [ ] Add work stealing only for work without isolate-local pointers. Measure fairness
      and cache effects before enabling it by default.

- [ ] Validate the x86_64 fiber switch on Linux. Retain ABI and sanitizer coverage.

## Embedding and freestanding targets

- [ ] Expose the H1 one-turn pump and wake source through a stable embedding API.
      Permit foreign GUI loops to retain event-loop ownership.

- [ ] Drive a Rust GUI stack through the FFI as an embedding experiment. Validate
      lifecycle, wakeups, callbacks, rendering-loop integration, and shutdown.

- [ ] Build scheduler, reactor, and GC core without libc over a fixed arena. Make
      unsupported dynamic facilities fail explicitly.

- [ ] Add a poll or ISR backend and fixed-size fiber stacks for constrained targets.
      Keep backend selection separate from JavaScript semantics.

- [ ] Define a minimal-core profile omitting unused bytecode, Intl data, web APIs, and
      host modules. Verify omitted personalities do not remain linked indirectly.

## Generational GC workers

- [ ] Resolve the native performance trade-off: the historical five-family
      portfolio found a 1.15% aggregate cost against `40063120`, while the current
      retained source estimates a 0.82% gain against `d149ffe6` with a 95% interval
      from 0.87% worse to 2.29% better. Neither comparison establishes recovered
      throughput. A separate ten-pair, 30-second HTTP routes comparison found a
      0.66% loss against `d149ffe6`; a newer five-pair run estimated a 1.77%
      loss and 1.68% more server CPU per completed response, both with intervals
      spanning zero. Its single GC diagnostic cannot attribute the loss. A
      direct ten-pair primitive-filter rollback found no routes throughput or
      CPU recovery. Profile matched finished HTTP binaries to locate the routes
      CPU difference before another collector scheduling change. Keep
      mutator-owned sweep unless measured benefit justifies worker ownership.
- [ ] Validate native worker capacity under live constrained and nested CPU quotas.
      Synthetic v1/v2 mounted-path and visible-ancestor fixtures pass; hidden
      namespace ancestors cannot be inferred. Keep the inline capacity fallback.
- [ ] Measure peak committed/deferred storage, long root/remark/finalizer pauses,
      and backstop completions. Extend block ownership only if a measured need
      justifies background reclamation.

### Concurrent generational GC experiments

- [ ] Snapshot/dispatch: compare copied heap bytes, discovery yield, preparation,
      worker CPU, merge, and remark wait on finished app-batch and HTTP binaries.
      Keep the primitive filter, though its throughput benefit remains unproven.
      Shape-key omission and active-worker sizing were reverted after application
      regressions. A ten-pair, 30-second HTTP
      comparison found Express routes about 0.66% slower than `d149ffe6`, with
      exact completed-response counts confirming the signal. A newer five-pair
      routes run had a directionally consistent 1.77% loss and 1.68% more server
      CPU per completed response, but its GC diagnostic cannot assign the cause:
      snapshot preparation was only 5.434 ms during an 18-second routes load.
      A direct ten-pair rollback found no resolved routes throughput or CPU gain
      from removing the filter, while one diagnostic copied 13.4% more bytes per
      completion. A separate app diagnostic copied more total values despite
      primitive filtering while batch counts also rose; filtering within a
      snapshot does not prove lower application work.
- [ ] Safe worker traversal: private draining was removed after zero app-batch
      drain traces and no measured benefit. Revisit only with a representative
      chain or shared-graph handoff benefit and combined CPU gain.
- [ ] Barriers: decide dense-fill and scalar captured-store card specialization
      after representative HTTP and compiler comparisons; app-batch screens were
      mixed. Dense reverse removes redundant scans under whole-array tracing and
      had a neutral application cut. Dense shift/copy card narrowing was rolled
      back after a repeated application slowdown; its semantic fixture remains.
      Keep SATB deletion protection independent of generational facts.
- [ ] Pacing: measure young survival, promotion debt, major reclamation yield,
      current RAW/reusable/chunk capacity, external pressure, and assist/backstop
      cost before replacing the eighth-collection cadence. A 15-pair app-batch
      comparison rejected fixed cadence 16: elapsed/CPU did not improve, and
      peak RSS rose about 27% in every pair; its 2,000-iteration diagnostic had
      fewer majors but more minor cell visits and a higher mapped/RSS plateau.
      Fixed cadence four also failed to improve ordinary throughput materially
      or lower RSS meaningfully: its 2,000-iteration diagnostic reduced minor
      cells inspected by 16.5% but added major work and 3.1% total pause time.
      Neither fixed cadence is a pressure policy.
      Validate nested cgroup quota discovery on Linux.
- [ ] Bounded slices: retain the skipped-block sweep budget only after combined
      latency review. One instrumented app run had more short major slices and a
      5.998 ms minor pause outlier; repeat before claiming application pause gains.
      Use mutator-only array trace attribution to identify a measured large-container
      or root-scan offender before adding resumable tracing or wider exact liveness.
- [ ] Minor locality: black-allocation enrollment showed no application gain.
      The young-position bitmap reduced counted visits but slowed seven paired
      app-batch runs, so it was reverted. A diagnostic app run inspected about
      1.26 cells per young cell swept; the stats-only counters were removed after
      recording their evidence. Test young-block placement only if a workload
      shows material sweep time from fragmentation, and account for allocation
      cost and fragmentation. Native finalizers are cleanup-only after the
      mark/weak fixpoint; they may not allocate from the heap or publish graph edges.
- [ ] Survivor age: measure post-promotion deaths and allocation during majors;
      one diagnostic app run reclaimed about 87% of promoted bytes at the next
      completed major and allocated about 1.3 MB during major marking. This
      establishes temporary promotion, not its exact death time or a benefit from
      another young survival. The stats-only counters were removed after the run.
      Define remembered-set persistence and weak-key liveness before changing age.
- [ ] Dirty ranges: compare sparse and dense old-container writes with logical
      scanned slots and discoveries on applications. The 8,192-slot sparse array
      fixture shows one discovery from a full-owner scan; cards remain experimental.
- [ ] Ephemerons: focused Linux ASan+UBSan and app-batch timing are complete,
      but app-batch visited zero weak entries. Measure a representative
      weak-heavy workload and bounded pending-index memory before retaining
      the indexed pass; retain the separate weak-cleanup SATB correctness fix.
- [ ] Release exhausted Map/Set iterator targets after dropping their storage pin.
      The current GC trace retains the entire owner through `iterator->target`.
      Audit direct cursor helpers and preserve SATB before clearing that edge;
      this retention predates the specialized collection stores.
- [ ] Reclamation: measure fresh allocation during sweep, reusable capacity,
      mapped and resident memory, page faults, and grow/shrink cycles with the new
      point-in-time heap-usage counters before replacing global free lists or
      releasing chunks. A local seven-pair sweep-reserve probe at 16 MiB showed
      that replacing one quarter of managed cells before their free lists were
      rebuilt added 4.0625 MiB of mapping, 4.0–4.03125 MiB of peak RSS, and 256–258
      page faults versus reuse after the cursor; final live bytes matched. Total
      timing included asymmetric usage scans, so allocation latency remains
      unmeasured. The prior app diagnostic allocated only 32,800 bytes during major
      sweep; establish representative long-sweep exposure before adding per-block
      free lists.

# Triggered work

These are not active tasks and become actionable only when their condition is
observed.

- Elide SATB barriers only if concurrent GC becomes the default and a realistic
  store-heavy workload makes the barrier material.
- Revisit MalVm and host-structure layout when multiple VMs or isolates are active in
  one process.
- Choose segmented, guarded, or fixed fiber stacks when measured actor density makes
  the current policy limiting.
- Consider separate actor heaps only if idle actor density becomes a measured
  constraint; preserve copy-message semantics meanwhile.
- Add io_uring only after epoll validates the completion-oriented reactor interface.
- Reconsider timezone-offset caching only if Date profiling makes it a top-five
  self-time contributor.

- Reopen VM-independent leaf workers only when actual activation overhead is a
  leading cost and existing eligibility covers real hot sites; neutral structural
  simplification is not justification for broader eligibility on its own.
- Specialize collection storage or eliminate generator/async objects only after a
  representative profile and explicit identity/escape/completion contract establish
  the need. They are not prerequisites for the bounded P1 work.
- Start another emitter-only sweep when the fact-flow report identifies sufficient
  existing proofs that still select a general path; do not rediscover already
  implemented primitive kernels or mistake inline helpers for unavoidable calls.
