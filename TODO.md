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

- [ ] Get the hosted native-remainder workflow green on Linux and macOS. The first
      run exposed cold feature-profile builds and aggregate GC-stress deadlines;
      verify their corrected preparation and budgets on both hosts. Inspect skipped
      external-service cases rather than treating discovery as executed coverage.
      Slow unit and Wasm coverage remains separate; Wasm needs WASI SDK 34 on the host.
- [ ] Fix the Linux crash of `test/staging/sm/expressions/octal-literals.js` in the
      sloppy pass. Two full CI runs (38120653230 and 38124199226) report it CRASHED
      in the same batch of eval-heavy staging tests, while its strict pass and both
      passes of that batch on macOS succeed. It is the only regression against the
      2026-10-04 baseline, so the 53 tests that pass since then stay unrecorded until
      a run can import an improvement-only baseline.

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

- [ ] Stream the product CLI's translation units to disk. Its build keeps the CLI's
      emitted C, 650 MB with the worker root's, in memory while it compiles the
      compiler again for the worker root, and peaks at 4.25 GB of heap; the release
      build and the self-hosted CLI check rerun themselves with an 8 GB limit.
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
- [ ] Fold the TDZ checks that remain on module and captured bindings. Module
      bindings initialized before their module can run user code, captured cells
      read by closures created after their declaration, and an owner's reads after
      a dominating initialization no longer check; 5,073 of 18,830 checks remain
      in the self-compile C. Hoisted function declarations still check every outer
      binding they read, because they exist before the declaration runs; letting
      a helper inherit the bindings declared before its first reference removed
      only 10 more in the self-compile, so that was not kept. The merged module
      init keeps the checks on bindings it writes itself. Most of the rest read
      module bindings such as `CoreEditor` or `KeywordDescTable`, whose modules
      sit in an import cycle or initialize them after a statement that calls out.
      Locked collection constructors and `Object.freeze` over literals already
      extend the prefix; continuing past calls into dependencies that receive only
      data changed nothing in the self-compile. What remains are import cycles and
      immediately invoked setup functions, such as the one that opens meriyah.
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
      single-target methods outside loops changed nothing. Private names of
      module-level classes now live in module globals, so a guarded inline in
      another module can read them, but the cone's hot `fn.kernel` accessor
      sites are still not inlined: the program generated-code budget runs out
      with 13.5 thousand candidates pending, and exact-target candidates
      outrank every hinted one. Inlining every candidate of at most 16 units
      past the budget made the cone 2.6% slower (28.20 against 27.49 s, three
      pairs), because each inlined accessor still pays the method, field and
      private probes that V8 hoists out of the loop; ranking hinted inlines
      among exact ones within the same budget cost 0.8% (28.48 against 28.25 s).
      Exempting
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
      thread-local address out of the loop). Sending an inherited-value miss
      straight to the shared stub, skipping the row the inline probe had just
      tried, saved 5% of a three-class method loop and nothing in the benchmark.
      Hot accessors only
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

- [ ] Complete shared builtin callback invocation contracts beyond the existing
      argument-kind/arity descriptors: receiver, return
      use, invocation multiplicity, retention, and synchronous versus deferred
      invocation. A sort comparator must receive numeric facts only when element
      facts justify them. Preserve canonical identity and mutation requirements;
      builtin names or source closure alone do not prove callback behavior.

- [ ] Extend the existing builtin-driven signature selection and numeric sort
      transport into a reusable invocation contract for numeric reduction with
      captured values. Audit repeated argument preparation, capture-owner resolution,
      activation checks, and canonical fallback before selecting the remaining cost.
      Reuse the per-target and program budgets; account for unknown
      callers, recursion, defaults, extra arguments, and captured environments.
      Lower one hot callback consumer through the selected typed entry while
      retaining required activation checks and generic fallback. Exit with real
      admitted sites, less executed marshalling/dispatch, semantic parity, and the
      full discovery/planning cost on both compiler hosts. Do not duplicate the
      sorting algorithm or create an unbounded callback-specialization matrix.

### Region composition implementation sequence

Track the requested expansion through the owning tasks below. Keep semantic,
mechanism, and measured acceptance separate; reuse existing callback discovery,
numeric sorting, stack objects, and string projections.
The shared lifetime and fallback rules are recorded in
[runtime region contracts](docs/decisions/runtime-region-contracts.md).

- [x] Numeric `reduce` / `reduceRight`: reuse the selected callback entry and carry
      the accumulator as a number, with per-element boxed continuation and live
      captures. Seven matched laptop pairs improved the captured-reduction case
      by 31%; focused Linux ASan/UBSan and both backend/GC modes passed.
- [x] Slice spans: retain one rooted source and normalized bounds across length,
      literal equality, numeric conversion, and conditional string observations.
      Artifact validation rejects untracked aliases and omitted observers. Seven
      matched laptop pairs improved token classification by 19%; Linux ASan/UBSan,
      both backends, primordial modes, and GC stress passed. Existing split
      materialization shares the span helper.
- [x] Conditional helper-result objects: keep multi-field results virtual through
      guarded helper joins and loop-local observations; materialize once, preserve
      aliases, and observe subsequent heap mutations. Seven matched laptop pairs
      improved the source-span helper by 66%; Linux ASan/UBSan, both backends,
      primordial modes, and GC stress passed.
- [x] Fixed Float64Array storage: extend numeric-loop admission to two through four
      fixed nonshared views, range checks, and ordered accesses; leave at polls with
      the next iteration's state. Seven matched laptop pairs improved the three-view
      kernel by 94%; both controls were inconclusive. Linux ASan/UBSan passed all
      16 focused tests, including overlaps, detachment, resizing, coercions, and GC.
- [x] Enumeration count: ordinary-object key counts
      avoid the array; observable arrays, proxies, primitives, and overridden calls
      keep the original path. Seven clean matched pairs improved count-only work by
      75%; a nine-pair confirmation retained the gain, with keys and entries controls
      0.3% and 0.6% slower respectively. Keep that small negative tradeoff explicit.
      Focused Linux ASan/UBSan passed in both backends, primordial modes, and GC stress.
- [x] Split fields compose with the shared span length/equality consumers and
      materialize at ordinary or character-access observers. Seven matched pairs
      improved classification by 22%; both string controls were inconclusive.
      Linux ASan/UBSan passed both backends, primordial modes, and GC stress.
- [x] Region-local Map entries: retain indices only for overlapping
      numeric lookups, revalidate live keys before updates, and preserve mutation
      barriers. Seven matched pairs improved interleaved updates by 18%; controls
      changed by less than 0.3%. All 10 focused Linux ASan/UBSan tests passed,
      including mutation, both backends, primordial modes, and GC verification.
- [x] Fresh Array initialization: consume the existing folded-push
      and literal-array stores through one prepared-values builder. Input roots,
      zero scanned length during reserve, card barriers, and final publication stay
      explicit. Seven matched pairs improved three-value construction by 61%; all
      eight focused Linux ASan/UBSan tests passed, including direct pushes and the
      exceptional object-lifetime path in the worker fixture.
- [x] Tagged-record branches: retain receiver admission across bounded strict tag
      comparisons and safe forward branches, including reference-valued fields.
      Implemented with all-predecessor validation and per-load fallback; focused
      unit coverage passes. Require three reads on every admitted path: this removes
      the short selector's 8% regression (confirmation is within noise) while seven
      matched pairs improve broader shared-layout and distinct-layout cases by 10%
      and 2.5%. All 21 focused Linux ASan/UBSan checks passed after correcting an
      obsolete fixture assertion.
- [x] Enumeration snapshot traversal: consume a retained key snapshot without a
      general keys Array; preserve eager enumeration, key order, and mutation semantics.
      Indexed traversal now retains up to 16 shaped-record keys in root slots, with
      one cached Array materialization for out-of-range or coercing observations.
      Seven matched pairs improved indexed traversal by 24%; the observable keys
      control changed by about 1%. Admission now follows a captured keys method across
      bounded argument preparation. All three focused native checks now pass after
      fixing the realm harness and exercising materialization in a selected region;
      all three expanded Linux ASan/UBSan checks pass.
- [ ] Broaden shared span consumers beyond length, equality, and numeric conversion;
      preserve method identity, UTF-16 behavior, and materialization at observers.
      Slice and split spans now support guarded `charCodeAt`, and split spans share
      numeric conversion. Focused unit checks pass; native execution and measurement
      are pending. Regexp captures now use the same consumer and lazy materialization
      contract, preserving missing captures and rejecting stale lifetimes across
      repeated execution. Sanitizer failures exposed retained capture/case-result
      control-flow escapes and missing locked character-method authority; both are
      repaired, with 71 focused span/Core and 16 regexp emission checks passing.
      Regexp and slice Linux ASan/UBSan checks pass. Split native checks pass after
      adding an executed numeric callback path; both sanitizer rerun modes pass.
- [ ] Broaden numeric comparator invocation to fixed argument snapshots, missing
      and default parameters, bounded rest, and comparator-owned captured locals.
      Implemented through the existing two-number callback ABI and per-activation
      environment; focused units and Linux ASan/UBSan checks pass. Measurement remains
      pending; general argument escapes and unproved results remain generic.
- [ ] Carry temporary-object allocation state through mixed virtual/materialized
      loop backedges when the same allocation cannot execute again on that lifetime.
      Implemented using dominance and the existing alias/generation validation;
      retain heap mutation visibility after observation and decline cross-generation
      aliases. Focused compiler and mutable/locked Linux ASan/UBSan checks pass;
      the busy-laptop microbenchmark is inconclusive.
- [ ] Extend fixed TypedArray storage regions to Float32, Int32, Uint32, and mixed
      views using one admitted storage descriptor and ordered numeric accesses.
      Implemented with store rounding, integer conversion, overlap order, and completed
      iteration state at polls. One shared loop generator retains a separate all-Float64
      entry after an initial microbenchmark exposed repeated kind checks. Focused
      checks, the runtime helper probe, and mutable/locked Linux ASan/UBSan checks
      pass; measurements on an isolated host remain pending.
- [ ] Reuse builtin callback arity facts for bounded argument snapshots and rest
      parameters, including numeric reduction, without changing invocation semantics.
      Implemented through existing descriptor argument counts and native entries;
      pure entry producers preserve snapshots, while effects end the admissible prefix.
      Focused units and mutable/locked Linux ASan/UBSan checks pass; measurement
      remains pending.
- [ ] Carry proven pure numeric producers into the shared fresh Array output plan;
      preserve initializer order, roots, and the existing publication contract.
      Bounded same-block Core scheduling and preallocation key lookup are implemented;
      focused units and mutable/locked Linux ASan/UBSan checks pass; measurement
      remains pending.
- [ ] Complete broad verification and compiler-cost acceptance for this sequence;
      the completed cases do not close the broader owning tasks below. The initial
      sequence's native self-compiler comparison was inconclusive (five matched pairs,
      0.76% slower); later widening is outside that captured source.
- [ ] Extend descriptor-driven callback invocation to TypedArray `reduce` and
      `reduceRight`, retaining element observation, detachment behavior, callback
      effects, and generic BigInt fallback. Implemented through explicit guarded
      invocation families and the shared VM callback entry; fixed argument snapshots,
      rest, every numeric element kind, and generic resizable/shared inputs are covered
      by the new fixture. Focused units and all three Linux ASan/UBSan checks pass,
      including foreign realms; measurement remains pending.
- [ ] Admit `substring` as a shared span producer using its own swap/clamp bounds
      normalization and the existing rooted lifetime and consumer contract. Implemented
      with one shared range normalizer and validated producer metadata; 78 focused
      compiler and 11 emission checks pass. Both mutable/locked Linux ASan/UBSan checks
      pass; measurement remains pending.
- [ ] Widen fixed numeric storage regions to bounded affine index windows such as
      `i + constant`; validate each view's full window once and preserve overlap order.
      Implemented with bounded reaching facts, unanimous joins, dynamic numeric start
      admission, and per-view offsets rederived by artifact validation. The existing
      instruction/view budgets and two loop bodies remain; 91 focused plan, integer-loop,
      and codec checks pass. Expanded Linux ASan/UBSan checks pass; measurement remains
      pending.
- [ ] Apply the storage contract to Int8, Uint8, Uint8Clamped, Int16, and Uint16 views.
      Runtime admission and byte-safe numeric transport are implemented; the existing
      clamping and integer conversion helpers retain store semantics. All nine numeric
      kinds pass a Node-derived conversion and guard probe and mutable/locked
      compiled/interpreted fixtures under ASan/UBSan; measurement remains pending.
- [ ] Compose `codePointAt` with range, split, and regexp spans; keep surrogate-pair
      reads within the retained span and preserve undefined results and late observers.
      Implemented through the shared numeric-character helper and bounded captured-method
      proof; 76 focused compiler checks, Node oracles, and C syntax checks pass. Actual
      regions are selected for all producers in both primordial modes. Expanded Linux
      ASan/UBSan checks, including foreign-realm fallback, pass; measurement remains
      pending.
- [ ] Extend the shared callback invocation contract to TypedArray `map`, `filter`,
      `forEach`, `some`, `every`, `find`, `findIndex`, `findLast`, and `findLastIndex`.
      Implemented through the existing traversal and exact callback entry, preserving
      species, live element reads, early exits, callback effects, and generic fallback.
      All nine methods select the shared transport in both primordial modes; 119
      focused compiler checks, Node oracles, and all three Linux ASan/UBSan checks
      pass; measurement remains pending.
- [ ] Carry range spans through nested `slice` and `substring` producers, including
      split fields and regexp captures. Implemented with depth-two continuations,
      separate child roots and materialization slots, and relative UTF-16 bounds.
      Discovery is bounded and transported metadata is independently rederived;
      56 focused checks, Node oracles, and emitted-C syntax checks pass. All four
      parent kinds select actual regions; all three expanded Linux ASan/UBSan checks
      pass, including realms. Measurement remains pending.
- [ ] Retain exact comparator invocation on nonnumeric sort pairs and BigInt
      TypedArray `sort`/`toSorted` inputs. Preserve existing sort algorithms, guarded
      numeric entries, callback effects, and result coercion on the boxed path.
      Implemented through the shared exact callback entry without changing sorting
      algorithms; 23 compiler checks and isolated Array, BigInt, mixed, and realm Node
      oracles pass. All three Linux ASan/UBSan checks pass; measurement remains pending.
- [ ] Extend shared span character consumers to `charAt` and `at`, including nested
      ranges; preserve relative indexing, single UTF-16 code-unit results, method
      identity, coercion order, and root publication when producing strings. Implemented
      through the shared bounded character helper, with transported consumer validation
      and ordinary call root publication. Focused compiler and primitive-operation
      checks, Node oracles, and emitted-C syntax checks pass. Range-span Linux ASan/UBSan
      passes. Split and locked regexp checks now pass, including executed character
      counters. Mutable regexp positive calls ran after prototype mutation permanently
      invalidated the protector; their placement is repaired while fallback coverage
      and strict counters remain. Both regexp sanitizer modes now pass; measurement remains pending.

- [ ] Compose bounded range continuations up to four levels, including split and
      regexp roots, while retaining each span's own lifetime and materialization state.
      Seed discovery from certified leaves, permit only validated child boundaries,
      and keep fixed discovery, plan, and consumer budgets. Implemented with memoized
      bottom-up admission, independent roots, and a depth-four suffix when an outer
      producer exceeds the cap. All three source kinds select connected depth-four
      chains; 133 span/codec checks, Node oracles, and emitted-C syntax checks pass.
      Both backends and GC stress preserve outputs. Locked sanitizer coverage passes;
      the mutable aggregate read/admission ratio was invalidated by deeper chains and
      is replaced with explicit composition and executed-consumer checks. The sanitizer
      rerun passes; measurement remains pending.
- [ ] Extend exact callback invocation to Map and Set `forEach` receivers.
      Carry value/key/owner arguments without numeric assumptions, preserving live
      iteration, mutation, callback effects, realms, and cached generic fallback.
      Implemented through the existing iterators and exact callback entry. Proven
      receivers retain concrete guarded calls; locked builtin calls retain their
      callback contract through target lowering. Focused
      compiler and verifier checks pass; mutable and locked sanitizer checks pass.
      Realm coverage required eval for its Function constructor; that configuration is
      repaired and its sanitizer rerun passes. Measurement remains pending.
- [ ] Share guarded `forEach` invocation across Array, TypedArray, Map, and Set
      receivers passed through helpers and loop backedges. Keep the common callback
      arguments boxed; numeric entry nominations require the existing argument guards.
      Preserve captured-method identity, realm behavior, live iteration, and fallback.
      Implemented through one collection invocation family; constructor syntax hints
      are removed. All 131 focused callback/entry/codec checks, Node oracles, and C
      syntax checks pass. All five collection sanitizer checks pass, including both
      backends, primordial modes, GC stress, and foreign realms. Measurement remains
      pending. Forwarded callback parameters use the runtime invocation contract
      recorded below.
- [ ] Consume range, split, regexp, and nested spans with `startsWith`, `endsWith`,
      `includes`, and `indexOf` through bounded shared search helpers. Preserve relative
      UTF-16 positions, empty needles, matching boundaries, coercion order, and one-time
      materialization for unsupported or observable arguments.
      Implemented through the existing bounded forward search and KMP cursor, with
      primitive-needle/position guards and per-method/source-family execution counters.
      Focused compiler checks, Node oracles, and C syntax checks pass. Both native
      backends preserve output under GC stress. A locked-mode missing range counter
      exposed escape analysis counting unreachable inlined predecessor edges; that
      analysis is repaired, with dead/live merge coverage and 171 focused checks
      passing. All three Linux ASan/UBSan checks now pass with strict search counters;
      measurement remains pending.
- [ ] Admit observed temporary-object lifetimes after unrelated exception handlers
      and in disjoint branches. Reuse per-function control-flow reachability and
      target alias flow; preserve rejection of active exception transport and
      allocation-generation backedges. Implemented with one reverse reachability
      analysis and reuse of target virtual-value flow. All 131 focused tests, Node
      oracles, both-mode frontend selection, and artifact roundtrips pass. Native
      ASan/UBSan checks pass; measurement remains pending. Later reachable handlers end
      admission even when the object's last explicit use precedes them.
- [ ] Compose `trim`, `trimStart`, and `trimEnd` as shared span producers, including
      split fields and regexp captures. Reuse whitespace-boundary discovery and the
      existing consumers, nested lifetime, and cached materialization contract.
      Preserve method identity, coercions, UTF-16 whitespace, and foreign realms.
      Implemented with bounded whitespace scans and zero through two ignored
      arguments. Inlined template observers can now consume a cached materialization
      through the original ToString operation. All 2,833 focused tests, Node oracles,
      both-mode frontend selection, and runtime/generated C syntax checks pass.
      All three Linux ASan/UBSan checks pass, including both backends, primordial
      modes, GC stress, and realms; measurement remains pending.
- [ ] Preserve exact callback contexts across runtime image growth and fiber
      switches. Replace cached function-table row pointers with stable indices and
      save the dynamically scoped callback context with each fiber's execution state.
      Cover runtime compilation between callbacks and interleaved suspended builtins.
      Implemented through stable function indices and the existing fiber execution
      state. All 145 focused checks, Node oracles, both-mode frontend selection, and
      runtime/generated C syntax checks pass. Deterministic table relocation and
      interleaved scheduler regressions pass under Linux ASan/UBSan, as do both
      mutable/locked JavaScript lifetime checks across backends and GC stress.
- [ ] Establish one canonical compiled callback contract for forwarded callback
      parameters and selected closures. Reuse the guarded collection operation and
      exact callback context without inventing numeric argument or result facts;
      preserve invocation order and fallback for unsupported callable kinds.
      Implemented through one runtime nomination after builtin identity validation.
      All 64 focused checks, Node oracles, both-mode frontend/codec checks, and runtime
      and generated C syntax checks pass. All three Linux ASan/UBSan checks pass across
      both backends, primordial modes, GC stress, and realm fallbacks; measurement
      remains pending. Foreign-realm callbacks conservatively retain generic invocation.
- [ ] Compose `substr` with existing span lifetimes and consume spans through
      bounded `lastIndexOf`. Reuse the canonical relative-index normalization and
      reverse search machinery, including its lower window boundary; preserve
      coercions, UTF-16 boundaries, and materialization at observers. Implemented
      through shared range and reverse-search algorithms; unreachable span uses no
      longer block admission after inlining. All 305 focused checks, Node oracles,
      actual bundled selection, and C syntax checks pass. All three Linux ASan/UBSan
      checks pass, including executed source-family counters, both backends, GC stress,
      and realm fallback. Measurement remains pending.
- [ ] Extend fixed TypedArray regions to positive constant strides and useful
      interleaved kernels. Derive stride from the actual induction update, bound each
      view by the final visited index, and retain ordered accesses, numeric guards,
      and completed-iteration state when polling. Implemented with a positive i32
      stride and up to twelve accesses for four interleaved lanes, within the existing
      instruction and view budgets. All 107 focused checks, actual bundled frontend
      selection, artifact roundtrips, Node oracles, and C syntax checks pass. All four
      Linux ASan/UBSan checks pass across backends, primordial modes, and GC stress;
      measurement remains pending.
- [ ] Widen fresh Array output plans beyond eight prepared elements and accept
      mixed immutable literals. Share bounded discovery limits between preparation
      and target selection; preserve initializer effects, roots, holes, and the
      existing builder publication contract. Implemented with a shared 32-value bound
      and bounded cached key discovery. Immutable string loads now carry their actual
      GC-free effect contract. Focused Core/root/codec checks, actual bundled selection,
      Node oracles, and emitted C syntax checks pass. Both mutable/locked Linux
      ASan/UBSan checks pass across backends and GC stress; measurement remains pending.

- [ ] Reuse canonical runtime callback nomination for forwarded Array and TypedArray
      `sort`/`toSorted` comparators. Preserve selected numeric adapters, eager element
      collection, boxed comparator semantics, nested contexts, and realm fallback.
      Implemented through one shared canonical callback nomination helper. All 31
      focused checks, Node oracles, eleven frontend/codec/generated-C checks, and
      runtime C syntax checks pass. All four Linux ASan/UBSan checks now pass with
      the documented compiler-only GC cadence; program GC stress and strict counter
      assertions remain enabled. Measurement remains pending.
- [ ] Extend enumeration snapshots to `Object.values` on ordinary shaped data
      records. Capture values eagerly in rooted slots, retain the cached result
      materialization, and decline accessors before executing any user effects.
      Implemented through one keys/values plan and runtime helper with sixteen
      rooted elements. All 211 focused checks, Node oracles, seven actual bundled
      programs, artifact roundtrips, and C syntax checks pass. Both Linux ASan/UBSan
      checks pass across backends, primordial modes, and GC stress; measurement
      remains pending.

- [ ] Reuse canonical callback contexts for functional String and RegExp replacers.
      Preserve eager match collection, variable callback arguments, result coercion,
      captured environments, nested contexts, and restoration after abrupt completion.
      Implemented through the shared nomination helper; RegExp callback results remain
      rooted during conversion. All 43 focused checks, Node oracles, eleven frontend
      artifact roundtrips, and runtime/generated C syntax checks pass. Typed-context
      and realm sanitizer checks pass. The remaining modes exposed a Node 24 oracle
      disagreements for overlapping matches and custom flags-getter observation;
      explicit normative expectations are repaired and all four sanitizer checks
      now pass. Measurement remains pending.
- [ ] Admit fresh Array regions inside handler-bearing functions when their local
      allocation and initialization range has one exception target and no external
      entry. Accept immutable BigInt literals through the existing rooted builder;
      the prepared mode continues declining protected-range crossings.
      Implemented with the existing local body facts and GC-free constant loads.
      All 195 focused checks, Node oracles, four actual bundled programs, byte-identical
      artifact roundtrips, and emitted C syntax checks pass. All four expanded Linux
      ASan/UBSan checks pass across backends, primordial modes, and GC stress;
      measurement remains pending.

- [ ] Reuse canonical callback nomination in Array.from and TypedArray.from mapping.
      Preserve iterator versus array-like ordering, custom construction, callback
      this/arity, IteratorClose behavior, roots, and nested transport fallback.
      Implemented in the existing rooted iterable and array-like algorithms. All 43
      focused checks, Node oracles, eleven frontend/artifact roundtrips, and runtime
      and generated C syntax checks pass. All four Linux ASan/UBSan checks pass,
      including typed-context fallback and foreign realms; measurement remains pending.
- [ ] Admit Object.keys/values snapshots in functions with independent handlers.
      Validate exception successors and keep the retained snapshot lifetime outside
      protected instructions and handler entries; retain generation and alias checks.
      Implemented with existing exception successor facts and bounded alias discovery.
      All 197 focused checks, Node oracles, four actual bundled programs, artifact
      roundtrips, and generated C syntax checks pass. Both handler-specific Linux
      ASan/UBSan checks and both existing snapshot controls pass; measurement remains
      pending.

- [ ] Accept non-observable primitive position conversions in shared string spans.
      Reuse the canonical number parser for null, Boolean, and primitive string bounds;
      preserve method defaults and defer object, Symbol, and BigInt coercions.
      Implemented through one shared primitive-number guard and canonical parser.
      All 102 focused checks, Node oracles, four actual bundled programs, artifact
      roundtrips, and runtime/generated C syntax checks pass. Both Linux ASan/UBSan
      checks pass across primordial modes, backends, and GC stress. A separate C
      fixture's obsolete null-rejection expectation is repaired and its Linux
      ASan/UBSan rerun passes; measurement remains pending.
- [ ] Reuse canonical callback nomination in Object.groupBy and Map.groupBy.
      Preserve iterator closing, property-key conversion, identity and equality rules,
      callback arity, nested contexts, and rooted group construction. Implemented in
      the existing rooted traversals through the shared callback contract. All 43
      focused checks, Node oracles, ten actual frontend/artifact roundtrips, and
      runtime/generated C syntax checks pass. All four Linux ASan/UBSan checks pass,
      including typed-context fallback and realms; measurement remains pending.

- [ ] Reuse canonical callback nomination in synchronous Iterator terminal methods.
      Preserve the existing forEach, reduce, some, every, and find traversals, exact
      argument counts, accumulator roots, and IteratorClose completion rules.
      Implemented through three existing rooted loops and the shared callback entry.
      All 43 focused checks, Node oracles, ten actual frontend/artifact roundtrips,
      and runtime/generated C syntax checks pass. All four Linux ASan/UBSan checks
      pass, including typed-context fallback and realms; measurement remains pending.
- [ ] Restore entry-pair virtualization selection in the complete collection fixture.
      CI found correct observable output but zero executed entry-pair hits; trace
      the shared budget's candidate costing. Result regions now group only steps
      from the same iterator/next protocol, preserving the existing bounds. All 100
      focused tests, actual bundled selection, artifact roundtrips, and emitted C
      syntax pass. All four collection Linux ASan/UBSan checks pass with the strict
      executed-hit and fallback counters retained.
- [ ] Reuse canonical callback nomination for JSON.parse revivers and JSON.stringify
      replacers. Preserve recursive traversal, holder identity, context.source,
      toJSON ordering, existing roots, and callback restoration across reentry.
      Implemented through one dynamically scoped contract per operation, preserving
      the existing traversal algorithms and automatic-GC suppression. All 43 focused
      checks, Node oracles, ten actual frontend/artifact roundtrips, and runtime/generated
      C syntax checks pass. All four callback checks and five existing JSON controls
      pass under Linux ASan/UBSan; measurement remains pending.
- [ ] Reuse callback nomination across suspended Iterator map/filter/flatMap helpers.
      Retain only a stable function index in the existing helper state; rebuild the
      stack-local context on resume and preserve matching outer typed contexts.
      Keep the helper in its 128-byte allocation class and preserve callback roots,
      realm fallback, abrupt completion, and reentry. All 43 focused checks, twelve
      frontend/artifact/generated-C checks, Node oracles, and C syntax checks pass.
      Typed-context, realm, and both counter/table-relocation sanitizer cases pass.
      Forced collection exposed missing old-to-young cards on retained inner
      iterators in flatMap; the shared flatMap/concat publication repair now passes
      all six retained-Iterator Linux ASan/UBSan checks. Measurement remains pending.
- [ ] Remove the i32 index limit in synchronous Iterator methods. Lazy helpers and
      terminal traversals now follow Number addition, including rounding at 2^53.
      A C fixture seeds real helpers at both index boundaries and relocates the
      function table between public-next and direct-step resumes; both compiled and
      interpreted Linux ASan/UBSan cases pass.
- [ ] Extend rooted enumeration snapshots to own string and Symbol keys. Support
      non-enumerable and accessor keys without invoking getters, retain Symbol
      identity, and synthesize Array length in the correct own-key order. Reuse
      cached result materialization and captured-builtin realm fallback. Implemented
      for ordinary objects and Arrays with bounded rooted storage; focused compiler,
      Node oracle and frontend/artifact/C checks pass. Realm sanitizer coverage passes;
      both materialization cases now pass after repairing execution through a
      protected inline range and a locked-prototype mutation. Measurement is pending.
- [ ] Extend enumeration snapshots to Object.entries with eager key/value capture
      and lazy pair arrays. Reuse sixteen rooted slots for up to eight entries;
      first observation caches each pair, and outer materialization reuses those
      identities. Allocating indexed reads publish incoming roots and their result
      before polling. All 150 focused tests, five frontend/artifact/generated-C
      checks, Node oracles, and runtime C syntax checks pass. All three new Linux
      ASan/UBSan cases and seven keys/values/handler controls pass across both
      backends, primordial modes, GC stress, and realms; measurement remains pending.

- [ ] Preserve conditional temporary-object regions at known builtin observations.
      Treat fixed nonconstructing CALL_KNOWN arguments as the same materialization
      boundary as ordinary call arguments; independently validate receiver/callee
      exclusions and retain existing lifetime guards. Freeze, seal, defineProperty,
      assign, result aliases, and mixed proxy inputs select actual plans in both
      modes. All 153 focused tests, four Node cases and four frontend/artifact/C
      checks pass. Both new native cases and both existing observation controls pass
      under Linux ASan/UBSan; measurement remains pending.
- [ ] Admit canonical compiled callbacks from other realms owned by the same VM.
      Validate realm membership before using the shared function-index space and
      preserve per-invocation realm switching, restoration, this boxing, and generic
      eval-callback fallback. Retained lazy contexts use the same ownership proof.
      All 43 focused checks, sixteen Node oracles, sixteen frontend/artifact/C
      checks, and runtime/C-driver syntax checks pass. A worker-thread VM exercises
      same-index rejection without sharing GC thread state and passes Linux ASan/UBSan.
      Six existing eager callback realm controls pass. The new realm fixture exposed
      an unrooted freshly boxed sloppy this value at compiled entry. Collecting bodies
      that read this now retain an activation root, including generic and direct calls;
      33 focused checks and six frontend/artifact/C checks pass. All three owned-realm
      Linux ASan/UBSan checks now pass. Measurement remains pending.

- [ ] Parse numeric prefixes directly from range, split, capture, and nested string
      spans using the canonical parseInt/parseFloat algorithms. Preserve captured
      callee identity, radix coercion order, Unicode bounds, signed zero, and the
      existing materialization fallback. A bounded canonical parser reader traverses
      rope leaves without flattening the source. All 188 focused checks, eleven Node
      oracles, five frontend/artifact/C checks, and runtime C syntax checks pass. Both
      main-mode sanitizer checks, the bounded rope parser C check and repaired realm
      driver pass; measurement remains pending.
- [ ] Reuse builtin Map/Set/Array entry cursors in Object.fromEntries while retaining
      eager key/value capture, property-key conversion, result realms, and iterator
      completion behavior. Implemented through the existing rooted traversal;
      twelve focused checks, Node oracles, and eight frontend/artifact/C checks pass.
      Six Node oracles exercise the explicit GC hook. Native verification and
      measurement remain pending.

- [ ] Retain several Map lookup indices for arbitrary keys and reference values,
      including unprotected regions in functions with handlers. Revalidate current
      storage, live entry and canonical key before using the existing barrier-aware
      updater. Eight focused checks, six frontend/artifact/C captures and forced-GC
      Node oracles pass; native verification and measurement remain pending.
- [ ] Root fresh collection constructors before adder and iterator acquisition;
      reuse one captured compiled-adder contract through Map, WeakMap, Set and
      WeakSet population. Reuse borrowed entry pairs without replay after an abrupt
      step, and preserve foreign weak-adder error realms. A foreign Array next method
      falls back before entry borrowing can bypass its error realm. All 24 focused
      checks, ten forced-GC Node oracles and six frontend/artifact/C captures pass;
      both main-mode constructor sanitizer cases pass. The realm case exposed a
      shared iterator-step boundary that discarded captured next realm; its runtime
      and compiler-cursor callers are repaired with 178 focused checks and new
      cross-realm error and pair-prototype coverage. Native repair verification and
      measurement remain pending.

- [ ] Extend fixed TypedArray regions to two-access copies and single-view updates,
      including ordered overlapping shifts and contained numeric-fusion operations.
      Preserve storage guards, numeric admission, poll resumption and original fallback.
      All 50 loop-plan checks, four actual frontend/artifact/C captures and forced-GC
      Node oracles pass. Both new native cases and four existing storage controls
      pass under Linux ASan/UBSan; measurement remains pending.
- [ ] Extend fixed TypedArray loops to descending and inclusive ranges with either
      comparison operand order. Retain signed strides, per-view affine bounds,
      original alias order, numeric admission and poll resumption. Focused loop and
      artifact checks, four actual frontend/C captures and forced-GC Node oracles
      pass. Both new directed-loop cases and four span controls pass under Linux
      ASan/UBSan; measurement remains pending.
- [ ] Root captured Set-like records throughout observable size/has/keys acquisition,
      then reuse one compiled has callback contract in intersection, difference,
      isSubsetOf and isDisjointFrom. Keep native Set and keys-only traversal paths.
      All 24 callback-contract checks, eleven forced-GC Node oracles and six actual
      frontend/artifact/C captures pass. All three Linux ASan/UBSan cases pass across
      both backends, primordial modes, GC stress and realms; measurement remains pending.

- [ ] Compare range spans directly with dynamic strict-equality inputs through the
      existing bounded UTF-16 equality helper. Preserve non-coercing comparison,
      unrelated input identities, aliases and cached materialization. All 47 focused
      span checks, forced-GC Node oracles and four actual frontend/artifact/C captures
      pass. Native values checks passed before an incorrect fallback counter assertion;
      actual frontend proof shows that fallback comparisons are generic or folded.
      The repaired counter contract retains mandatory positive values coverage;
      both repaired native cases pass under Linux ASan/UBSan; measurement remains pending.

- [ ] Extend split, regexp and nested span continuations to completed exception
      handlers, disjoint protected branches and valid catch-local ranges. Prove
      exception-aware alias lifetimes, preserve Core-owned protected spans and reject
      live continuation crossings or expired generations. All 174 focused checks,
      four actual frontend/artifact/C captures and seven forced-GC Node oracles pass;
      both new handler cases and four existing continuation controls pass under Linux
      ASan/UBSan; measurement remains pending.

- [ ] Retain canonical Array.fromAsync mapper nomination across awaits using a
      stable function index in the traced step state. Rebuild guarded stack contexts
      per invocation and restore them before suspension. Root setup state, acquired
      iterator records and original errors throughout user-code boundaries. All 24
      callback checks, seven forced-GC Node oracles and six actual frontend/artifact/C
      captures pass. All three initial Linux ASan/UBSan cases pass; the wider
      async-close and Number-index implementation below is still awaiting verification.
- [ ] Extend keys, values and entries snapshots to ordinary indexed records and
      arrays, including holes, sparse storage and non-enumerable own properties.
      Preserve property order and eager values; reject observable accessors before
      any allocation, root captured values during index-string creation, and retain
      cached pair/outer identities. Four actual frontend/artifact/C captures and five
      forced-GC Node oracles pass. Both new cases and three existing entries controls
      pass under Linux ASan/UBSan; measurement remains pending.
- [ ] Make Array.fromAsync await AsyncIteratorClose before settling an original
      mapper rejection, and replace its u32 iteration index with the specified Number
      index. Implemented with a traced original error and suspended close phase,
      exactly-once return observations, original throw precedence and Proxy-aware
      property creation. All 24 focused checks, four frontend/artifact/C captures
      and runtime/driver C syntax checks pass. All five Linux ASan/UBSan cases pass,
      including both backend boundary drivers, awaited close and realm coverage.

- [ ] Reserve fresh Array capacity across effectful initializer calls and getters,
      preserving each evaluation and store position. The incremental mode supports
      up to128 values without a temporary C value array; retained roots and per-store
      cards preserve collecting initializer results. Reject escaped aliases, control
      entries and protected allocations whose handlers could observe partial length.
      Focused compiler contracts, Node GC oracles and four artifact/C captures pass;
      all focused Linux ASan/UBSan cases pass; performance evidence remains pending.
- [ ] Keep revalidated Map entry indices across branches, protected control flow and
      loop iterations. Nomination uses bounded CFG reachability; current storage,
      live entry and canonical key checks remain authoritative at every update.
      All71 focused contracts, eight Node GC oracles and four frontend/artifact/C
      captures pass; all focused Linux ASan/UBSan cases pass; performance evidence remains pending.

- [ ] Widen count-only enumeration to all five keys, values, entries, own-names and
      own-symbol methods without allocating bounded snapshot slots. Ordinary data
      records and Arrays can exceed previous element limits; primitives reuse their
      exact own-key counts. Accessors, proxies and other exotics preserve original
      eager observations through fallback. A Symbol-only property iterator skips
      unrelated keys and supplies exact fresh-result capacity to getOwnPropertySymbols.
      Focused unit, Node and frontend/artifact/C checks pass; both count sanitizer cases pass.
      The complete batch archive is retained; measurement remains pending.
- [ ] Compose trimLeft and trimRight aliases through existing trim range kernels,
      and admit ignored extra trim arguments while retaining their evaluation and
      effects. Existing method identity, UTF-16, source roots and cached escapes
      remain authoritative. All 174 focused checks, eleven forced-GC Node oracles
      and five frontend/artifact/C captures pass. A nested fixture counter failure is
      repaired by executing the selected helpers through runtime dispatch;25 Node GC
      modes and179 integrated span/codec checks pass. All three repaired Linux ASan/UBSan
      cases pass; measurement remains pending.

- [ ] Extend retained property-read admission through receiver aliases, typeof tests
      and boxed truthiness branches, with up to16 fields over96 instructions.
      Every incoming edge must preserve the same receiver; the first generic miss
      permanently ends the raw-storage lifetime before getters or Proxy callbacks.
      All81 focused checks and four actual frontend/artifact/C captures pass, including
      constructor-selection controls. Forced-GC Node oracles cover reference identity,
      throwing accessors and prototype mutation. Both new and21 existing property-read
      cases pass under Linux ASan/UBSan; performance checks remain pending.

- [ ] Let coercing global isFinite and isNaN consume retained range, split, capture
      and nested spans through the existing numeric parser, preserving exact callee
      identity. Number.isFinite and Number.isNaN retain noncoercing semantics; extra
      arguments and foreign callees use ordinary materialization. All179 focused
      span/codec checks,25 Node GC modes and seven actual frontend/artifact/C captures
      pass. All three Linux ASan/UBSan cases pass with mandatory execution counters;
      performance measurement remains pending.

- [ ] Reuse the shared enumeration contract for Reflect.ownKeys counts and snapshots,
      retaining public Symbol identity and string/Symbol ordering while preserving
      primitive rejection, Proxy observations and foreign result realms. All six
      enumeration methods also accept ignored extra arguments after their original
      evaluation. All70 focused checks, eleven Node GC modes, five frontend/artifact/C
      captures and six runtime C syntax checks pass. All three Linux ASan/UBSan cases
      pass, alongside the existing count and entry controls; measurement pending.

- [ ] Build repeated string output directly from retained range, split, capture and
      nested spans. Reuse the canonical repeat builder with source bounds, retaining
      primitive count conversion, current-realm method identity, error precedence,
      output roots and ordinary fallback before effects. All184 span/codec checks,
      eleven Node GC modes and five actual frontend/artifact/C captures pass, including
      large partial ranges, ropes, surrogate boundaries and foreign method errors.
      The first native run timed out inside exhaustive JavaScript checksums of large
      outputs. Those checks now compare complete output strings against Node while
      retaining input sizes, stress, GC hooks, counters and timeouts. The rooted
      repeat polling repair and stronger output oracle pass all three Linux ASan/UBSan
      cases. Measurement remains pending.

- [ ] Retain bounded Object.values and Object.entries snapshots across observable
      getters. Capture all original string keys before effects, recheck each current
      descriptor, and root prior values through mutation, nested calls and collection.
      Once observation starts, propagate the original exception without replay.
      Eleven Node GC oracle modes, five actual frontend/artifact/C captures and four
      runtime C syntax checks pass. All three Linux ASan/UBSan cases and the four
      existing values controls pass. Performance verification remains pending.
- [ ] Build padStart and padEnd output directly from retained range, split, capture
      and nested spans through the canonical padding builder. Preserve target/filler
      conversion order, no-op coercion suppression, source roots and foreign methods.
      Keep repeat's shared allocating helper frame-neutral; only its native wrapper
      owns suppression, and long builders poll with completed prefixes rooted.
      Focused compiler, Node, frontend/C and all three JavaScript ASan/UBSan cases
      pass. The corrected C polling driver also passes with collection statistics enabled
      and balanced cleanup on failure. Measurement remains pending.

- [ ] Widen fixed TypedArray storage regions to read-only sums and dot products,
      up to eight view owners,32 ordered accesses and128 instructions. Retain exact
      view bounds, numeric admission, overlap order, rounding and poll continuation;
      immutable inputs remain readable, while immutable outputs preserve fallback.
      All72 loop contracts, four Node GC modes, six actual frontend/artifact/C
      captures and both Linux ASan/UBSan cases pass. Performance verification remains
      pending.
- [ ] Produce lower- and uppercase output directly from retained range, split,
      capture and nested spans. Bound the canonical Latin-1 scans and Unicode
      conversion context to the original span, retaining source roots and final
      unchanged-output materialization. All196 span/codec contracts, eleven Node GC
      modes, five actual frontend/artifact/C captures and all three Linux ASan/UBSan
      cases pass. Performance verification remains pending.

- [ ] Retain fixed TypedArray storage across certified Math unary and binary bodies.
      Guard consumed numeric inputs before memory operations and reuse canonical
      signed-zero, NaN and rounding semantics without per-call transport. Mutable
      lookups, coercion and ignored-argument effects preserve their original path.
      All111 loop contracts, eighteen Node GC modes, four frontend/artifact/C
      captures and both Linux ASan/UBSan cases pass. Performance verification remains
      pending.
- [ ] Normalize retained range, split, capture and nested spans through the shared
      canonical Unicode builder, preserving form coercion, invalid-form errors,
      source roots and bounded normalization context. All237 focused checks, eleven
      Node GC modes, six frontend/artifact/C captures, four runtime C syntax
      configurations and all three Linux ASan/UBSan cases pass. Performance
      verification remains pending.

- [ ] Extend fixed TypedArray regions across canonical integer, half-rounding,
      power and angle kernels, plus bounded variadic min/max/hypot. Carry known
      primitive defaults into numeric bodies while guarding dynamic consumed
      arguments; no admitted body collects or invokes user code. All128 loop
      contracts, sixteen Node GC modes, four frontend/artifact/C captures and both
      Linux ASan/UBSan cases pass. Performance verification remains pending.
- [ ] Validate and repair UTF16 directly over retained string spans, reusing the
      canonical segmented scan with range-relative surrogate boundaries. Preserve
      captured methods, ignored argument effects, output roots and cached original
      materialization. All229 focused checks, eleven Node GC modes, five frontend/
      artifact/C captures, four runtime C configurations and all three Linux
      ASan/UBSan cases pass. Performance verification remains pending.

- [ ] Carry numeric record fields through certified Math bodies, including variadic
      clamps, integer kernels, half rounding, powers and norms. Preserve field and
      numeric-input guards before effects and canonical fallback for accessors,
      coercion, exceptions, mutable methods and non-writable fields. All149 compiler
      contracts, fourteen Node GC modes, four frontend/artifact/C captures and both
      Linux ASan/UBSan cases pass. Performance verification remains pending.
- [ ] Convert locale-aware case directly over retained string spans through canonical
      locale resolution and the shared bounded Unicode case builder. Preserve all
      locale-list observations, invalid-tag errors, captured-method identity, source
      roots and balanced native-frame ownership. All249 focused checks, eleven Node
      GC modes, five frontend/artifact/C captures, eight runtime C configurations
      and all three Linux ASan/UBSan cases pass. Performance verification remains
      pending.

- [ ] Admit read-only numeric record reductions and bounded larger field groups.
      Keep existing small projections, compose complete numeric fusions, allow
      32 fields and128 instructions, and retain valid prefixes of larger records.
      Read-only guards cover frozen objects, prototype objects and function own
      fields; writable regions retain the original object and notification guards.
      All208 focused contracts, twenty Node GC modes and eight frontend/artifact/C
      captures pass. Native and performance verification remain pending.
- [ ] Feed ordinary and prepared localeCompare directly from retained string spans.
      Reuse canonical locale/options effects and collation with bounded UTF16 input
      preparation shared by case conversion and normalization. Preserve source and
      argument roots, original exception order, prepared-cache identity and foreign
      method fallback. All256 focused checks, fifteen Node GC modes, ten frontend/
      artifact/C captures and24 runtime C configurations pass. Native and
      performance verification remain pending.

- [ ] Retain up to32 reference property reads over128 instructions, including
      callable own slots and alternate shape-cache rows. The first generic miss
      ends borrowed storage before accessors, proxies or collection can run.
      All55 focused contracts, eighteen Node GC modes and eight frontend/artifact/C
      captures pass. Native and performance verification remain pending.
- [ ] Carry Number predicate Boolean results through numeric record and fixed
      TypedArray branches. Preserve no-coercion semantics, missing arguments,
      ignored argument effects and original builtin authority; numeric stores
      still require Number results. All235 focused checks, twenty Node GC modes
      and four frontend/artifact/C captures pass. Native and performance
      verification remain pending.

| Order | Slice                        | Owning work and exit condition                                                                                                                                  |
| ----- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Callback invocation          | The tasks above; remove measured repeated invocation work for a numeric reduction with captures.                                                                |
| 2     | Composable string spans      | P2 composable temporary values; length and literal comparison share a span, with materialization on an escaping branch.                                         |
| 3     | Cross-call temporary objects | P1 selective effects, aliases, and field facts; carry multiple fields through a helper and a conditional observation, including mutation after materialization. |
| 4     | Fixed TypedArray storage     | P2 virtual iteration and loop regions; admit a three-view numeric kernel with ordered overlapping accesses and detached/resizable fallback.                     |
| 5     | Enumeration snapshots        | P2 composable temporary values; eliminate a keys array for a length or keys-only consumer while preserving snapshot order.                                      |
| 6     | Region-local Map results     | P2 composable temporary values; measure residual lookup cost before retaining multiple owner-relative entry identities.                                         |
| 7     | Fresh construction           | P2 composable temporary values; share a bounded scalar initialization contract with explicit GC publication state.                                              |
| 8     | Discriminant and layout      | P1 selective effects, aliases, and field facts; prove a useful tagged-record correlation before specializing field reads.                                       |

For each retained slice, run focused semantic and memory checks, compare repeated
matched performance samples, then commit and push on main for CI verification.
Use mjq for longer verification and continue the next independent slice while it
runs. Keep run identities and raw evidence under the task's ignored cache directory.

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
      Start with the repeated Core-store private-brand checks: retain the producer's
      module-singleton private-key provenance, validate initialization and all
      current writers, and relate later key loads only after a dominating successful
      private access. `singleAssignmentGlobalSlots` alone is not that proof. Preserve
      receiver/key roots and getter calls; do not cache field payloads or backing
      locations. Keep captured/per-evaluation keys conservative. Confirm admitted
      receiver/key pairs and matched compiler cost before widening scope.

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
      takes 7.4 of Core's 20 s. Static-value queries now ask for memory versions
      only when a slot's written value could be described, which kept the output
      byte-identical and cut `fold-static-property-reads` to 1.1 s and
      `fold-static-binding-constants` to 0.65 s over about 7,500 runs each. Most of
      what remains is the exceptional control-flow analysis their joins request
      after each edit, and the static cell index, which drops every cell's facts
      whenever any function changes. Without that global drop, unsoundly, the two
      folds took 0.9 s less before the memory gate. `lower-primitive-operations`
      spends 1.0 s for 40 changed functions. Verification is another 5.5 s (13%),
      most of it independent re-derivation at trust boundaries.

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
      Safe-integer loop regions cover only innermost loops of numbers and
      Booleans. No loop in the self-compiled compiler qualifies: of its 2,495
      single-entry innermost loops, only 15 have one blocking opcode (10 iterator
      steps, 4 keyed loads, 1 static load), so typed-array or property access
      inside such a region needs a consumer outside the compiler first.

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

- [ ] Close the closed-compiled JavaScript benchmark's per-call gap. In its
      pricing loop the three-class `quote` call costs 54 ms against Node's 6 (13 ms
      of it polymorphism), the `arguments` function 24 ms against 4 and the
      one-line closure 26 ms against 8, about 7 ns per call. Frame work is not the
      main cost: dropping native debug frames saved about 5 ms of 97 and dropping
      root-frame links about 3 ms. `mal_vm_enter_compiled` and the inherited,
      array-length and array-index probes stay out of line in the large caller;
      forcing them inline cut the loop by 12% but grew the benchmark binary 1.6%.
      Moving the entry checks into each compiled function's prologue would inline
      them once per function instead of once per call site. Inlining the three
      `quote` bodies instead of dispatching to their field entries doubled the
      three-class loop (106 against 51 ms), so field entries stay preferred.
      A leaf entry keeps its native stack check even when its caller's frame is
      verified: `checked-leaf-entry` enters a leaf from a caller frame large
      enough to exhaust the remaining margin.
- [ ] Keep three receivers of a polymorphic method site in its own cache. The
      objects phase's `rules[i % 3].quote(order)` hits the site's one inherited row
      for one class in three; the others take the out-of-line probe and the shared
      stub, about 31% of that loop's samples (40 ms alone against Node's 14 ms).
      The 72-byte cache row has no room for three shape, prototype and value
      triples, so extra rows need storage registered for prototype invalidation
      like the stub's. A two-extra-row experiment preserved the primary probe and
      binary-size budget, but matched whole-workload compiled results were
      inconclusive. An isolated three-class loop improved 7% while its monomorphic
      control regressed 1.3%; resolve that trade-off before shipping site storage.
- [ ] Forward `fn.apply(this, arguments)` without materializing `arguments`.
      Express's router (`restore`) and type-is build a dictionary arguments object
      per call, about 3% of the Express JSON route's samples. Rest parameters
      already forward through `callRestArguments`; arguments objects also need
      mapped-parameter aliasing ruled out, and a fallback that builds an arguments
      object rather than an Array when `apply` is not the builtin.
- [ ] Keep Node stream state in native fields. The C stream runtime reads and
      writes its state as own properties named by C strings, about 177 interned
      names per Express JSON request, and its helpers take 7% of that route's
      samples. Interning by address made each name cheap; the property traffic
      remains. The route's other cache misses are mostly debug's `enabled` getter,
      ten per request; calling it straight from the function's own table changed
      nothing measurable.
- [ ] Bound the call targets of methods stored on module-scope objects. In a
      script, `holder.run(value)` with `holder.run` assigned two functions
      dispatches to both through a finite guarded set; as an ES module the same
      code calls generically, because top-level declarations become captured
      module bindings that the finite target analysis does not follow.
      `finite-call-target-dispatch` compiles its fixture as a script until then.
- [ ] Prefer Map entry-pair virtualization when other iterator regions also apply
      to a loop. Typing construct results as objects let iterator-result
      virtualization and array cursors apply to `for (const [k, v] of new Map())`
      loops in `collection-direct`, and selection then dropped every entry-pair
      region, so that typing was reverted. It removed an out-of-line
      RequireObjectCoercible from `counts[i & 15]++` on a constructed typed array.
- [ ] Re-measure numeric property update plans now that number record regions
      take over loops that only touch number fields of one receiver. On the
      particle loop, before regions, they ran 59 ms against 55 ms for generic loads
      and stores, because their begin and commit checks cost more than the boxing
      they save. Make them cheaper or drop them where they still apply.
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

- [ ] Restore the interpreted `await using` Test262 results. Against the
      1 October baseline, 15 tests under `language/statements/await-using` and
      `for-of/head-await-using-bound-names-fordecl-tdz.js` now fail in the
      interpreted backend while passing compiled: use-before-initialization
      reads and initializer `Symbol.asyncDispose`/`Symbol.dispose` validation.
      They fail at HEAD without tonight's TDZ fold, so bisect from the baseline.

- [ ] Mint private names per class evaluation inside loops. A class expression
      evaluated by each iteration of a loop in one activation keeps its private
      names in that activation's captured slots, so every evaluation overwrites
      the same slots: after `for (...) list.push(class { #x; static has(o) { return #x in o; } })`,
      `list[1].has(new list[0]())` is true in both backends where Node returns
      false. Factory functions are unaffected because each call owns its slots.
      Give such evaluations their own class scope, as per-iteration bindings do.

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

- [ ] Match Node's invalid-argument diagnostic inspection, including custom inspect
      hooks and thrown-hook precedence. Buffer validators and copyBytesFrom currently
      use a generic formatter.

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
- [ ] Measure peak committed/deferred storage, synchronous minor and long
      root/remark/finalizer pauses, and backstop completions. Lower allocation in
      the production JavaScript workload coincides with longer maximum minor pauses,
      despite less total GC time in raw diagnostic pairs. Isolate the expensive
      collection with matched checkpoint ablations before changing pacing; retain
      mark, remembered-slot, sweep and promotion evidence. Keep peak managed
      survivor accounting distinct from exact live heap and RSS. Extend block
      ownership only if a measured need justifies background reclamation.

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
