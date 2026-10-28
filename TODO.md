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
5. Resolve known reliability findings, including the intermittent DNS gate failure,
   and complete recoverable resource handling.
6. Advance ECMAScript, WinterTC, Node, and ecosystem correctness. Their existing
   backlog below remains in scope; it is not replaced by the performance programme.
7. Recover throughput and bound latency in the concurrent generational collector.
   Keep the native worker and Wasm inline behavior, following the ownership and
   root contract in [generational GC workers](docs/decisions/09-generational-gc-workers.md).
8. Pursue actors, SMP, embedding, and freestanding targets after the active runtime
   foundations are ready.

## Verification workflow

- [ ] Broaden runtime-gap coverage with enabled RegExp/Intl, pending and rejected
      promises, weak-reference collection, arbitrary-precision BigInt beyond the
      current 128-bit storage, and input-size scaling. Keep conversion costs separate
      from traversal and checksum work.

- [ ] Track configured asset-directory topology in `dev`. Publication validates
      consumed file identities, but adding a file or renaming a previously unwatched
      path does not change that file set. Capture recursive directory membership and
      exercise add/remove changes without editing an existing source dependency.

- [ ] Isolate `tests/native/forwarded-sort-callback.test.ts` from the eval
      compiler's own sorts. It counts process-wide comparator nominations, and in
      plain native builds the eval compiler runs as compiled code whose `.sort` calls
      nominate their comparators too: the `fallbacks` case reads 22 and the eval
      case 42 where the test expects 0 and 1. CI runs it only under sanitizers,
      where the eval compiler is interpreted, so it passes there.
      `tests/native/forwarded-from-mapper.test.ts` fails the same way under the
      plain runner through the eval compiler's `Array.from` mappers (`fallbacks`
      reads 39 Array nominations where it expects 0).

- [ ] Find why `tests/native/node-fs-watch.test.ts` takes minutes on the macOS
      Native remainder runner. Its three tests take 5 to 8 s on Linux, but on macOS
      they ranged from 22 s to 972 s over ten runs on 2026-10-22 and 23, and one run
      hit the 20-minute hook timeout. The spread predates that night's compiler
      changes, so it points at the watcher or the runner rather than the build.

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

- [x] Decouple `loop-scalar-representation-selection` storage webs. Phi arguments
      and identity moves share width decisions; arithmetic discovery does not force
      a floating accumulator and its counter into the same representation. Whole-value
      induction ranges include the final update. Shared constants keep their original
      storage and are rematerialized at typed boundaries, including exception arguments.
      Signed arithmetic and updates retain integer views in full bodies, scalar
      expressions and eligible fast entries; floating operands and unsafe signed
      remainder/division retain Number semantics. Suspension boundaries box scalar
      observations. Loops with exceptional control remain outside induction admission.

## Native SSA storage

The independent target boundary and current storage contract are recorded in
[native SSA lowering](docs/decisions/native-ssa-lowering.md).

- [ ] Extend selected typed call/aggregate transport and expression regions using
      Core proofs, with bounded code-size decisions and matched runtime evidence.
      Move remaining emission-local selection into explicit native plans before
      claiming the C emitter only renders selected decisions. Native emission now
      starts from planned canonical entries, typed entries and private closure
      environments, withdrawing unavailable or oversized bodies before publishing
      C. Frameless paths still require a base proof, and cache identities include
      the numeric-sort leaf contract independently of entry presence. Rendered
      bodies subscribe only to fast-callee availability queried during admission,
      including unavailable callees. Normal result-kind
      bounds from complete script callee sets now reach Core and native storage.
      Calls whose Number result depends on a guarded typed entry still need scalar
      transport along that admitted branch when the canonical result remains boxed.
      Normal return integer ranges now reach scalar call storage and decoding,
      including spread, rest and resumable calls. Forwarded parameters and strict
      receivers now project kinds and ranges from that caller's actual operands,
      including known iterable prefixes and omitted positional arguments.
      Normal return bounds now converge through chains and recursive callee
      components before publication, with conservative widening for growing ranges.
      Loop storage webs now use independent widths and whole-value induction
      bounds. Exact integer result facts reach full, scalar and eligible fast-entry
      kernels; ordinary, generator and async observations preserve scalar storage.
      Carry those integer views into the remaining guarded call/aggregate transport.
      Integer rounding results now retain their precise intervals through normal
      returns, selected entries and read-only record fields. Eligible frameless
      Math operations share full-body kernels and bounds, with independent operand
      guards and mutable-callee checks before the ordinary fallback.
      Identity observations now use forwarded normal returns through chains and
      phi components, including observation-argument sharing and NaN-aware equality
      emission. Compatible normal-return identities now reach general consumers,
      retaining stronger result facts and explicit scalar boxing/widening boundaries.
      Native storage now omits roots and poll publication for unobserved final call
      results, including ordinary, known, spread, rest, construction and resumable
      paths. Helper state, borrowed outputs and reused input storage remain rooted.
      Carry identities into remaining storage and liveness contracts.
      Explicit native return plans now use normal-result kinds to pass Object
      completions through base and derived constructors and to omit the result-kind
      check for base primitive completions. Unknown and mixed Object bounds retain
      generic completion; derived primitive/undefined checks and coroutine returns
      keep their own protocols, independently of invocation effects.
      Builtin alias returns now share independent result projections across kinds,
      integer intervals, return provenance and identity consumers. Known positional
      prefixes survive list transport; boxing and unboxing require input-kind
      proof. Invocation effects and stronger post-call bounds remain intact.
      Conditional aliases now publish input-kind requirements in program return
      summaries; identity, kind and interval consumers check them independently.
      Finite script-call chains now substitute conditional parameter and receiver
      projections through joined returns and recursive components. Known prefixes
      survive iterable transport; unknown list contents and sloppy receiver boxing
      retain their conditions. Callee edits withdraw stale projections. Escape
      effects and own-field proofs remain independent of the alias projection.
      Mutable Object.is now consumes operand identity,
      kinds and scalar views behind a loaded-callee guard, including frameless hits;
      its miss retains arbitrary results, throwing and root publication.
      SameValue also consumes each operand's interval, preserving only the NaN and
      signed-zero handling still required by the unbounded operand.
      Strict equality and SameValue now share partial kind and scalar consumers;
      noncoercing comparisons can form expressions within their root-safe windows.
      Immediate and joined literal lengths also select SameValue String kernels
      across full, delayed, frameless and resumable paths, including guarded hits.
      Typeof comparisons now share direct category predicates and partial kind
      consumers in full and frameless bodies: nullable primitive unions need only
      a null test, nullable Object unions need only a callability test, and other
      unions without null skip its branch, including after suspension.
      Primitive-only receiver bounds now remove impossible Array and plain-object
      probes from property reads, writes, definitions and membership in full and
      resumable bodies. Frameless admission also rejects Array-only reads that
      cannot hit. Generic helpers retain key coercion, prototype accessors,
      strict-write errors and GC publication independently of receiver bounds.
      Grouped own-slot read pairs, read regions, numeric projections, updates and
      number-record regions also reject receivers whose bounds exclude Object;
      unknown and Object-containing bounds retain their guarded admission.
      Array-only paired loops, presence windows, pair destructuring and deferred
      iterator paths now consume receiver bounds too. Primitive length loads skip
      Array and TypedArray admission; generic iterator-brand cursors remain because
      a primitive's custom iterator can supply an Array iterator.
      Conditional kind bounds now follow dominating predicate edges and phi inputs,
      including duplicate successors, backedges, calls and suspension. Canonical
      effects and whole-value representations stay independent. Local observation
      and coercion folds consume those bounds, and exact primitive String lengths
      bypass property probes in full, frameless and resumable entries. Scoped
      effect proofs still need availability obligations before code motion can
      consume branch-only facts. Static length reads now infer Number normal results
      from primitive String/nullish receiver bounds before operation lowering;
      nullish-only inputs have no normal result. Those bounds reach return summaries,
      selected entries and scalar property-result storage while preserving getter
      effects and ordinary object/prototype fallbacks.
      Intrinsic String/nullish length reads now publish nonnegative safe-integer
      ranges, and proven genuine Array length reads publish uint32 ranges. Shared
      range queries carry those bounds through phi joins, normal returns and private
      record fields into predicate folds and native entries; escaped fields and
      unknown Object/Proxy reads retain their general results and effects.
      Deletes now publish Boolean normal results independently of receiver effects.
      Empty primitive-wrapper bounds remove delete dispatch while preserving computed
      key conversion and exceptions; selected native entries also consume those
      bounds, and frameless bodies bail out before object-key coercion.
      Static membership now shares current property descriptions with reflection:
      proven own fields fold independently of their values, and genuine Array
      length remains present after escape or mutation. Inherited results require
      world proofs; unknown keys, Proxy receivers and escaped ordinary properties
      retain their effects and fallback, including across suspension.
      String/Symbol key conversions now retain normal-result facts independently
      of base exceptions. Static reads, membership and descriptors match Symbol
      SSA aliases and stable identities; repeated fresh allocation sites and
      uncertain registry keys retain their fallbacks. Cell transport clears
      producer-local SSA discriminators before rebinding the proof in its reader.
- [ ] Give record entries typed fields. Program value-kind flow now carries initial
      own-field kind summaries through exact call chains, finite callee sets,
      recursive forwarding, spread/rest and constructor completions. Field-only
      changes wake callers without rebuilding the any-script scalar aggregate.
      Conditional returns and loop-carried aliases join common own fields through
      bounded control-flow walks, including initial integer bounds.
      Call results now project initial own fields through that worklist, closing
      parameter/field cycles. Reads retain facts before later writes and escapes;
      known own sibling writes preserve untouched fields. A bounded CFG/use walk
      accounts for backedges, possible getters/setters and fresh producer lifetimes.
      Handler transport still rejects the proof. Normal-result publication
      feeds local representations and native predicates without requiring pure
      effects. Publication now changes only normal-result facts and specialization
      inputs, preserving structural, call and memory analyses while waking local
      kind/range consumers and the program return-kind worklist.
      Certified storage widths now join every virtual writer across
      producers, callers, borrowed parameters, caller-owned literals and forwards.
      The native ABI carries typed pointers through artifacts, relocation, split
      units, forwards and materialization. Numeric and Boolean fields use scalar
      locals; integer field bounds join every virtual writer and select i32 only
      when the full storage lifetime excludes negative zero and fits signed int32.
      Boxed unions without heap kinds also omit GC roots. Heap fields stay rooted,
      and materialized records retain ordinary object access. Field values
      whose kind unions exclude Object and Symbol no longer extend overwritten
      field lifetimes; own-slot refinement, scalar replacement and allocation
      sinking consume the same weak-holdability bound. Object and Symbol unions
      keep lifetime barriers, and fields used after a safepoint keep their GC roots.
      Parameters without observers omit the producer realm and union-shape pointers. Shape
      ordinals use i32 storage throughout the C ABI and materialization. Callers
      omit the producer root when neither a caller/callee observer nor backend
      fallback needs materialization. The scanner workload's whole C is now 111,548
      bytes, down from 115,075 before returned-field
      feedback and 111,795 before typed fields. Reads after own writes now join
      the initial fields with every preceding writer in the kind and range worklists,
      including loops and suspension. Incompatible kinds and negative zero widen
      independently; escapes and possible accessors retain the fallback.
      Write-backed observations enter propagation demands only once a finite
      initial field contract emerges; later contracts expand the demand set and
      withdrawn contracts override previously published bounds.
      Fresh producer allocations now retain own-field summaries across private
      writes, joining every writer with the initial kind and integer bounds before
      forwarding the result. Structural input plans survive metadata changes;
      values and ranges are solved afresh. Non-returned locals add no field demands.
      Returned field initializers and private writers also retain dominating
      branch kind bounds through call chains; later unguarded writes widen them.
      Independent own-data presence now licenses noncollecting named reads even
      when the field kind is unknown. Native full, resumable and frameless bodies
      consume that proof after virtual-field handling; misses resolve the physical
      own slot without invoking getters or prototypes. Inlining discards the scoped
      proof and republishes it from the cloned flow. Withdrawn presence removes its
      hint and effect refinement independently of normal-result kinds and bounds.
      Forwarded call and constructor results now retain those summaries across
      private writes to proven existing own fields. Cached structural plans
      revalidate required keys against current callee summaries; unknown sources
      and empty recursive cycles cannot acquire a field contract from a write.
      Wide numeric and heap-bearing unions retain their storage and root needs.
      Finite groups of private call and constructor results now retain common own
      fields through merged aliases and recursive producer updates. Every source
      must retain the required own keys; all component writers join initial kinds
      and ranges. Earlier single-source read proofs keep their point-specific
      precision. Merged reads now follow selected values backward through phi edges,
      joining only preceding writes and rejecting preceding escapes or possible
      accessors. A producer resets only its own allocation lifetime, including on
      backedges; later effects do not withdraw an earlier read. Writer/source
      correlations within the surviving prefix remain conservative.
      Typed producer storage for remaining writes,
      broader parameter-relative call effects and coroutine record transport remain.
      Activation-local field storage now joins per-instruction kinds and integer
      bounds from all initializers and certified writers, including branch-local
      proofs through boxed registers. Scalar fields omit shadow slots; String and
      unknown unions retain roots and materialized accesses keep their fallback.
      Own-field observations
      also carry initial integer bounds through the normal-result worklist, including
      finite targets, recursive forwarding and suspension. Growing fields widen
      independently of bounded siblings. The scanner still calls
      `mal_builtin_string_char_code_at_known` twice per character
      on a boxed string parameter.
- [ ] Admit more record calls. Not admitted yet: calls through instance-method hints,
      which need a guarded fallback that keeps the returned object as the record;
      record parameters that a callee passes on instead of observing; and forwarding
      more than one call deep, or through a helper that also reads the record. In the
      quick self-compile census, record calls cover 892K calls, mostly
      `decodeVmValueOperand`, `coreTerminatorInput`, `valueEnvironment` and
      `copyTerminatorEdge`, and record parameters take 186K calls.
- [ ] Weigh record entries against other plans in the code budget. The 401K context
      literals `operandShape` reads only to report a failure, and the 241K edges
      `CoreEditor#touchEdge` keeps only when they are new, qualify as record
      parameters, but their entries miss the quick self-compile's generated-code
      budget. Giving callees that take records the 16× planning weight of record
      producers admitted them, displaced 77 array iterator cursors and 67 iterator
      result virtualizations, and slowed the self-compile run by 1.5%. Direct-entry
      opportunities sum their call weights while local ones take their best
      instruction, so a flat weight cannot trade saved records against saved
      iterators. Limiting the weight to callees of at most 64 instructions kept
      `operandShape` and `#touchEdge` while losing only 5 cursors and 9
      virtualizations, yet the run was still 1.2% slower (16.13 s against 15.94 s,
      three interleaved pairs), with 8.8% more time in the emit phase.

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
      from 132 s to 59 s at eight jobs, but `emitInstruction`'s 252 parts still compile
      in one 6 MB unit for 19–21 s, now the slowest. `-O1` saves only 15–20% of that
      unit and grows its object. Parts are static and share a per-function transfer
      struct, so they need external part symbols and a shared struct header.
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
- [ ] Hoist labelled function declarations in sloppy function bodies. Annex B makes
      `label: function f() {}` a top-level var-scoped declaration initialized at
      entry, so `f()` before it runs `f`; Maligator throws a TypeError in both
      backends where Node runs it (Test262's staging
      `block-scoped-functions-annex-b-label.js` fails too). Once hoisted,
      `coreInitializedLexicalReads` must treat them as hoisted: it visits them at
      their statement, so `f` would read a later `const` without its TDZ check.
- [ ] Fold the TDZ checks that remain on module bindings read through import cycles
      and immediately invoked setup functions, such as the one that opens meriyah.
      The self-compile Core keeps 1,600 checks: 1,067 on module bindings, 491 on
      captured cells and 42 on loop values. Importers outside a cycle, closures
      created after the declaration and hoisted functions referenced only after it
      (in function bodies, CommonJS modules and acyclic ES modules) already read
      their bindings initialized. The hoisted rule pays in CommonJS libraries but
      removes almost none of the self-compile's checks; those are reads inside
      import cycles. Prefixes that continue past calls into data-only dependencies
      removed almost none either.
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
- [ ] Cut the cost of minor sweeps in large programs. The native self-compile
      allocates 71 GB, and minor collections spend 6 s sweeping 616 million young
      cells, almost all dead, one header miss per dead cell. Side mark bitmaps plus
      a bitmap of cells that own external storage would hand dead runs back to the
      allocator untouched; fewer dead cells, from escape analysis or allocation-free
      iteration, are the other lever. In the parser workload's 21.8 million dead
      young cells, arrays (6.4 M), closure environments (4.0 M), closures (3.5 M),
      plain objects (3.1 M) and iterators (2.6 M) lead. Skipping finalizer calls
      for plain objects saved 1.5%; prefetching did not help, and publishing a
      block's freed bytes and free-list links once saves about nine instructions
      per dead cell but no measurable time. Neither did a fixed nursery: capping minors at 1 to 8 MB left a
      retention-churn loop's minor sweep time at 30 to 34 ms, the same as the
      live-set-proportional trigger, and added majors.

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
      Fast-entry `calleeTry` selection now consumes typed call overrides and
      declines guarded or unavailable targets without borrowing canonical proofs.
- [ ] Use typed-entry reachable edges in surviving liveness, scalar use and result ABI
      decisions. A validated per-variant plan now removes impossible C branches and
      unreachable safepoints, eliminating the dead coercive addition and root frame
      in String entries for Number predicates. Surviving GC maps retain their full
      hidden helper obligations. Propagate the refined edges into the remaining
      dataflow and specialization decisions while preserving handlers, resume points,
      region and record continuations, and canonical fallbacks.
      Full entries, frameless fast entries and numeric leaves now share that plan;
      fast admission uses the reachable graph. A shared unused-value plan removes
      effect-free producers and copy chains across full, fast, numeric and resumable
      C bodies while retaining root writes, hidden ownership uses and profile sites.
      Return ABI proofs now join reachable returns using existing kind and range
      observations, preserving handler entry contracts; callers consume those
      scalar results through existing typed transports. Use the surviving graph
      during fast-path discovery, and carry edge projections into remaining shape
      and lifetime analyses. String comparison length proofs now join surviving
      literal definitions and copies, retaining unknown handler, resume and helper
      entries; full, frameless and resumable branches consume the validated plan.
      Connected entry finalization now retires callee nominations made unreachable
      by later return facts, prunes unrooted sibling components and compacts IDs
      without changing semantic proofs. Retired code capacity is released while
      spent proof work remains charged as discovery.
      Span continuation discovery and virtual alias validation now consume the
      entry's surviving edges. Overlay consumers retain storage ownership without
      becoming helper entry roots; dead observers and overwrites no longer pin
      materialization. Generic span fallbacks retain String comparison length facts.
      Enumeration counts and snapshots now use the same projected virtual-value
      lifetimes, retaining fallback materialization and profiled observations.
      Map hint sites also have Core collection-chain entry certificates; retiring
      dead certificates now closes helper reachability from surviving entries while
      retaining every continuation of a live helper. Map reuse hints also consume
      projected edges and aliases; dead endpoints no longer retain hint locals or
      their Core call chains, while live updates retain receiver and key checks.
      Fixed fast paths, literal-switch targets and field-call windows share the
      same conditional continuation closure; handler and resume roots retain their
      explicit entry contracts.
      Entirely dead fixed windows and instruction-local plans are retired after
      projection, so their helper state and optimization metadata do not reach C.
      Record producers, caller-owned literals, parameter uses and forwarding sites
      retain storage ownership without creating control-flow entries. Their
      surviving view drops dead producers, uses and materialization observers;
      source certificates and entry ABI layouts remain intact.
      Array initializer discovery follows unique surviving edges across proven
      branches, retaining source store sites and live initializer effects. Holes,
      protected incremental ranges and independent helper entries retain fallback.
      Static property definitions now join reaching String identities through
      copies and key conversions on the same graph. Conversion effects stay at
      their source sites; unknown and indexed keys keep their existing paths.
      String and Symbol key conversions retain result kinds independently of
      throw effects. Boxed keys consume those kinds in conversion and definition
      branches while preserving nullish-base checks and Number decoding.
      Coercibility guards consume non-nullish kind unions in full and resumable
      bodies. Frameless entries perform only a rejecting nil probe and leave error
      construction and frame metadata to the full fallback.
      Generic and exact indexed accesses consume Number and integer-range facts
      through boxed keys and values. Frameless reads share those proofs; numeric
      misses retain deferred root publication and check completion before decoding
      scalar results. Non-numeric keys retain their coercing fallback.
      Frameless admission now stops individual paths before unsupported effects,
      retaining successful sibling returns and pruning state beyond each restart.
      Primitive unary facts also govern typed-entry admission; fallback retains
      original arguments and reachable fast loops still require a full frame.
      Definition initialization also accounts for incoming private-root publication
      reads after physical root selection, so conservative maps cannot expose
      future locals while rematerialized values retain their existing proofs.
      Frameless arithmetic converts eligible primitive operands independently,
      retaining Number guards only for uncertain operands. String parsing, mixed
      relational primitives, shifts and Number exponentiation use noncollecting
      helpers. String alternatives in addition and lexical String pairs retain
      fallback while mixed numeric paths survive those same operand unions.
- [x] Normalize primitive conversion calls from semantic kind unions. Eligible
      `Number` and `String` calls use unary conversions, carrying kind and effect
      proofs into native storage, full entries and frameless numeric paths.
      Primitive conversions avoid builtin and unary dispatch while retaining String
      allocation polls, extra argument effects and distinct Symbol, BigInt,
      omitted-argument, construction and spread semantics.
- [ ] Shrink the largest inline expansions in generated code. Uniform tagged
      field slots and the one-compare Number decode cut the self-compiler's text
      from 55.0 to 49.9 MB; the inline static load probe is now about 19
      instructions, spent on the value class, heap type, cache mode, shape and
      storage-kind checks. Throw checks, `MAL_FRAME_POS`, root masks and
      safepoint polls were about 5% each of one 800 KB translation unit.
      `MAL_FRAME_POS` is now one store into the C-stack frame record. A shape
      root per exotic object kind would let the shape compare imply the heap type.
- [ ] Reach the remaining thread-locals without a call on macOS, where a profile
      shows them. Every `_Thread_local` read there is a `_tlv_get_addr` call
      (Linux reads the thread pointer). Generated code still keeps a thread-local
      `MalDefinePropertyCache` per static define site (510 in the compiler), and
      inherited loads (`mal_prototype_chain_epoch`), root spans and the fiber,
      profile and perf-stats state stay thread-local. Workers keep several isolates
      per process, so this state cannot become process-global.
- [ ] Measure sequentially consistent environment slots on Linux x64. `MalEnv`
      slots are `_Atomic`, so every captured store compiles to `XCHG` on x86-64.
      Major-mark workers trace slots while the mutator runs, so stores must stay
      release, but the mutator's own loads could be relaxed. On Apple Silicon
      relaxed loads with release stores changed none of six closure workloads.

## Compiled native output

Native output should read and perform like a compiled language rather than a
translated interpreter. Measured against Node on the default closed world, class
accessors over private fields still run 75 ms against 14, polymorphic subclass
methods 40 against 10 and recursive method calls 86 against 29.

The native self-compiler takes about 15.6 s and its profile is flat: sampled by
program counter, 37% of its time is compiled JavaScript, 12% the collector and
allocation, 11% property lookup helpers, 8% collections and 7% array helpers.
Hardware counters place its gap to Node in instruction count, not stalls: at a
similar front-end stall rate it retires about 2.4 times Node's instructions. It makes
about 480 M compiled entries per run, yet cheaper calls alone did not move it:
guarded direct calls at hinted method sites, inline inherited-method hits, frameless
accessor entries and up to four times the inlining budget each changed it by 2% or
less. A whole-program points-to model over construction Core took 108 s in Node to
converge and still left generic paths at the hot receivers, so field facts stay
bounded and consumer-driven as planned below.

- [ ] Guard `Math.imul`, `Math.clz32`, `Math.pow` and `Math.atan2` like the other
      `Math` calls. With eval or realms enabled, the default, a known builtin call
      keeps a fallback obligation, and only operations in
      `VM_GUARDED_BUILTIN_OPERATIONS` then lower to a guarded inline kernel. These
      four become fully generic calls: an FNV loop with `Math.imul` runs about five
      times slower than Node, and the call keeps the loop out of a region. Their
      callee checks need `MAL_MATH_*` entries in the runtime's Math builtins.
- [ ] Keep binary searches off the element-load latency chain. A loop region
      without a counter now keeps `lo`, `hi` and `mid` in integer locals (12 M
      probes 96 to 53 ms, Node 13; random targets 105 to 67 ms, Node 56). Clang
      turns the bound updates into selects, so every iteration waits for the
      element load and compare, while Node's predicted branches run ahead. A search
      that leaves the region, such as one over records or with a call in its body,
      still runs on doubles.
- [ ] Give inline method bodies typed fields instead of a check per access. Class
      layout cells replaced the per-site probes on class members with a shape
      compare, but `store.kind(i)` in a loop still costs about 15 ns against
      Node's 2: every access re-checks the receiver, the array and the key and
      boxes the result. Reusing one receiver guard per activation saves only 17%
      of that. The rest needs field kinds (an Array of int32 behind `#opcodes`)
      flowing into Core value kinds and representations, which means bringing
      class layouts into Core.
- [ ] Resolve method calls through a sound closed-world call graph. Instance
      method hints are guarded guesses that the call graph does not see, so
      parameter, return and effect summaries stop at every method call. Hints now
      cover subclass overrides, which took the polymorphic kernel from 62 to 39 ms,
      and recursive methods outside loops get guarded direct calls. A name-based
      target set that includes every function stored under the name, and every
      function that escapes into a dynamic-key store, would make these exact. Note
      that replacing dispatch alone gains nothing: the value is in exact targets
      that need no method load and inline without a guard. Names alone will not
      stay exact on the self-compiler: its construction Core calls no dynamic-key
      read directly, but 747 of them flow into stores and arguments, and copy loops
      such as `out[k] = src[k]` would put every method behind every name. Key kinds
      and the receivers' allocation classes have to keep those reads apart.
      Class granularity alone does not get there. A whole-program flow of class
      instances, prototypes and functions over construction Core took 9.4 s in Node
      on the 7,600 self-compile functions and resolved none of its 25,229 named
      calls: instances pass through arrays, object literals, `Array.from` callbacks
      and destructured returns, where a class-level model loses them. Once an
      instance can hide among unknown values, a computed store on an unknown
      receiver (`integerRecipes[current.value] = 0` on a destructured typed array)
      may set `__proto__` or shadow a member, and a computed read may return
      `__defineGetter__`, so its class's chain is no longer exact. The
      `class-methods` case and the objects phase pricing loop hold their instances
      in arrays too. Exact targets need allocation-site cells for arrays and
      records, with models of builtin callbacks and iteration, before class facts
      pay off.
- [ ] Prove property names getter-free in the closed world. With source closure,
      locked primordials and no `Proxy`, a name that no class, object literal or
      `defineProperty` gives an accessor, and that the primordial catalog lists as
      no accessor, reads without calling user code. Memory passes could then reuse
      and hoist such loads; `this.left === null ? 0 : this.left.size()` currently
      loads `this.left` twice through its inline cache.
- [ ] Pace concurrent marking against a faster mutator. Peak RSS of the native
      self-compiler is bimodal at about 1.4 or 2.0 GB. The high runs coincide with
      a synchronous backstop, fewer major cycles and about three times the
      over-tenured bytes.

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

Shared lifetime and fallback rules are recorded in
[runtime region contracts](docs/decisions/runtime-region-contracts.md).

- [ ] Find where the runtime-gap `spread-computed-update-read-*` loops spend their
      time. `checksum = (checksum + copies[i & 31][key]) | 0`, with a module-level
      `const key = "p3"` and 32 objects from `{ ...source, [key]: value }`, takes
      5.7 ns per iteration against Node's 0.9. Samples put 55% in
      `mal_vm_indexed_load_keyed` and `mal_vm_object_try_load`, yet the keyed path
      itself is not the cost: a prototype that turned the read into a named
      `loadPropertyStatic` (folding the proven string binding, leaving canonical
      numeric strings keyed) kept the loop at 57 ms. The lookup on objects built by
      a spread plus a computed key is the next suspect.
- [ ] Sort records without a generic comparator call per comparison. The
      runtime-gap `candidate-ranking` case sorts 4096 `{ id, benefit, cost }` records
      by `benefit - cost`, then `id`: 25 ns per comparison natively against Node's
      6.4 (sort 732 against 188 ms over 600 rounds). Every comparison enters the
      comparator through its generic compiled entry with an argument array, loads
      the fields through property caches and boxes the result. Deciding number
      truthiness inline at the comparator's `||` changed nothing, although samples
      land in `mal_value_is_truthy_primitive`.
- [ ] Complete shared builtin callback invocation contracts beyond the existing
      argument-kind/arity descriptors: receiver, return
      use, invocation multiplicity, retention, and synchronous versus deferred
      invocation. A sort comparator must receive numeric facts only when element
      facts justify them. Preserve canonical identity and mutation requirements;
      builtin names or source closure alone do not prove callback behavior.

## P1: selective effects, aliases, and field facts

- [ ] Extend the existing summaries with the parameter-relative effects required
      by a selected consumer: field reads/writes, aliasing/retention, callback
      invocation/reentry, and mutation of relevant prototype or buffer state.
      Preserve useful facts across a proven read-only call or an unrelated write;
      unknown effects stay conservative. Start with scalar-field calls and callback
      regions, using bounded summaries and the existing analysis manager rather
      than a general whole-heap points-to analysis. Test invalidation and recursive
      summary convergence as well as the positive optimization.
      Conditional own-slot effects now compose through finite call sets, reordered
      parameters, receivers and recursive components. The existing memory consumer
      preserves untouched slots only after resolving every required access to own
      data; unknown calls, escaping aliases and unproven bases retain the barrier.

- [ ] Preserve useful value, field, and range facts through joins, selected calls,
      variant-local planning, and target lowering. Distinguish semantic kind facts
      at an operation from a physical register's joined storage representation.
      Diagnose boxed initializers instead of assuming every boxed value requires
      an observable object. Keep numeric signed-zero/overflow constraints and
      pointer-root requirements explicit. Extend the existing bounded range walk
      only for a demonstrated consumer; a larger walk limit is not an optimization.
      Private field facts (kinds, brands, construction-only fields and the element
      kinds of arrays only private fields hold) stop at method parameters: in
      `kill(id) { this.#live[id] = 0 }` the key is unknown and in
      `add(op) { this.#ops.push(op) }` the value is, because method calls reach no
      targets. Of the self-compiler's 94 Array fields, 23 keep known elements, and
      its native self-compile did not measurably move. A brand check followed by a
      field read of the same class on the same receiver still runs both checks.
      Field kinds per allocation site are the missing fact in class-heavy loops:
      `sum + store.opcode(id)` keeps a generic `+` fallback because `.opcode` of a
      `{ opcode, a, b }` element is unknown, and that fallback can call user code,
      so it invalidates every loop-carried accessor prefix. The loop planner also
      admits only accessors whose last read is indexed and only loops without a
      parent loop, so `this.#ops[id].opcode` reruns its method, private and indexed
      probes on every iteration (75 ms against Node's 15 in a 4 M-read kernel).

- [ ] Extend existing scalar-replacement, field-entry, and conditional-materialization
      plans to one real multi-field region unlocked by the preceding facts. Keep
      fields in SSA/native values through admitted operations and materialize only
      at certified observations or fallbacks. Preserve initializer effects/order,
      aliases, per-allocation identity, joins, exceptions, and GC roots; never
      re-evaluate an initializer or manufacture a different fallback object.
      Exit with reduced executed allocation/slot traffic on a representative
      workload, not merely a new plan kind or a synthetic object that never escapes.

## P1: compiler throughput and analysis scalability

- [ ] Bring the Node-hosted self-compile toward 40 s. It takes 46.3 s in the
      1cf304da baseline: Core optimization 23.8 s, execution to image 5.2 s, Core to
      execution 3.2 s and Core construction 2.3 s. fold-static-property-reads
      spends 1.7 s in static-value queries, pass admission checks about 1.2 s, and
      verification about 4 s. 6ce7d318 still triples plan candidates by planning
      every exact call outside the budget.
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
      Static-value queries request memory versions only when a written slot value
      can be described. Private-cell proofs now follow body, control-flow,
      exception-flow, effect and data revisions; result facts and guarded lowering
      hints retain descriptor proofs and their work budgets. Open bindings do not
      demand cell indexes. Semantic edits still clear the cell proofs; narrowing
      that invalidation to individual cells needs complete alias and initialization
      dependencies. Continue measuring residual query, dominance and verification
      costs before changing those boundaries.

- [ ] Put aggregate work and memory budgets around analysis extensions, including
      rejected candidates and nested queries, not only admitted entries. Reuse
      versioned queries within their valid lifetime; bound contexts and recursive
      propagation and fall back conservatively on budget exhaustion. Record
      instruction visits, transfer/summary builds, cache reuse, and peak retained
      data in opt-in diagnostics. Do not trade a cheap emitter for hidden planning
      scans, uncontrolled cache growth, or a new unconditional whole-program pass.
      Memory, integer, containment and program-kind queries already solve only the
      partitions, roots and dependencies a consumer requests. Still to do: decode
      memory accesses by requested family, narrow shared instruction, root and use
      indexing and partition state to requested reads, query only the needed property
      contents, and defer candidate recognition while preserving exact ranking and
      costs. Measure the compact integer snapshot's retained memory and representative
      compile time before extending these caches.

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

- [ ] Close the for-in per-call gap. With shared per-shape key arrays and
      internal iteration, a for-in over a five-field record takes 6.0 ns per key
      (10.5 when reading values) against Node's 1.5 (2.3). The remaining cost is
      per loop: the out-of-line `mal_for_in_keys` call with its prototype-chain
      check and snapshot entry, and the function call of each small kernel.

- [ ] Close the rest of the `JSON.stringify` small-record gap. 300k calls on a
      five-field record take 26 ms against Node's 20. Shape plans persist across
      calls, and an unused map or list no longer costs a libc call. Most remaining
      samples are inside `mal_builtin_json_stringify` itself; the plain frame
      walk, string segment lookup, output buffer growth and the result string's
      allocation take 3 to 6% each.
- [ ] Elide the remaining call-only closures. Direct closures cover layouts that
      capture nothing, one owner, or a chain that starts with the creating
      activation, and escaping reads create the object on first use. A layout that
      skips an owner, such as TypeScript's reportError capturing the module scope
      and checkTypeRelatedTo but not createTypeChecker, still builds a function
      object per activation: checkTypeRelatedTo creates three of them on each of its
      million calls. Passing the creator's chain instead made every call of such a
      closure resolve its owners by lookup and cost 1% of the TypeScript check;
      closures with an identical layout could share one capture vector instead.
- [ ] Finish prettier's method shims. Each `createMethodShim` call now gets its own
      clone whose `getImplementation.call(object)` inlines behind a check of the
      loaded `call`, but `implementation.apply(object, rest)` still joins the
      inlined callback's known result with `object[name]`, so it stays a
      rest-argument apply into `stringOrArrayAt` (the clone is still about 3% of
      the prettier run). Threading the join, or splitting the apply on the
      callback's result, would let the known path call, and inline, it directly.
      The clone itself never inlines into the AstPath getters that call it: the
      inliner rejects `createRestArgumentsState` and `callRestArguments`, and the
      clone has 18 blocks against the limit of 16.
- [ ] Make prettier's AstPath getters and TypeScript enum reads cheaper. Five
      prettier rounds call AstPath getters 7.4 million times through the static
      miss path, and read about 16 million `SyntaxKind` members from dictionary
      objects through the out-of-line probe, which now saves the registers its
      other rows need even for this one.
- [ ] Finish specializing higher-order helpers. TypeScript's binarySearchKey clone
      now inlines getTypeId, compareComparableValues and its `some(array)` test,
      but it is still the hottest TypeScript function at about 6%. Cloning small
      helpers at every site that omits a tested argument, or behind a module `var`
      alias, cost prettier 0.4 to 1.2%.
- [ ] Narrow the remaining class accessor gap. Loop sites now probe for a
      uniquely named class getter or setter and inline it behind a function-index
      guard: the `#celsius` getter/setter pair takes 33 ms for 5M iterations
      (was 112, Node 2). Each iteration still pays two accessor probes, two guards
      and the private hint check that V8 hoists out of the loop. Exposure runs
      before inlining, so an accessor read inside a helper called from a loop
      stays a call, and names that some literal or store also uses as data, such
      as `metadata` on the compiler's function store, are never exposed. Private
      elements live in shape slots behind a name-level slot hint (a
      three-private-field class constructs in 108 instead of 269 ms per 3M, public
      fields 75); a per-site shape row would make the private probe a single
      compare.

- [x] Let integer loop regions hold a numeric fusion whose ends are both inside.
      Guard failure and polling restore the saved iteration and resume at its
      header, where the original fusion starts again. Compiler artifacts preserve
      profile sites and instruction-site maps, so restoration keeps the same
      admission boundary for profiled and unprofiled bodies.
- [ ] Widen numeric loop regions beyond plain Array element and record sums.
      Index and for-of loops over Arrays now keep their sums in f64 locals,
      including fields of record elements (`sx += p.x` 5.7 to 1.7 ns per element,
      Node 1.0; `record-array-traversal` 532 to 250 ms, Node 109). Field reads
      through polymorphic rows, nested records, stores to records and calls in the
      body still decline, and a guard failure finishes the whole loop in the
      original code.
      A failed guard restarts its whole iteration in the original loop, so no guard
      may follow a store in the same iteration. That keeps stores at keys from
      records or other views out of regions: `core-to-execution` writes typed
      images at `instruction.id * 2` (9.1 ns per operation against Node's 2.4),
      and `optimizer-queue` appends with `queue[length++] = index` after a
      store (7.3 against 2.4). Both need side exits that leave mid-iteration with
      the live registers, which in turn needs every fallback plan's state, such as
      indexed-length kinds and fusion flags, to be valid at the exit.
      A region with inner loops is entered once, so a single restart finishes the
      whole loop in the original code. Regions over records therefore stay
      innermost, because their field guards fail until the original loop has
      cached the shapes. A retry that jumped from the original header back to the
      region's entry after one generic iteration made the nested union-find loop
      14% slower without any restart, likely because the backward jump merged the
      region into the original loop's cycle. Nesting a counted inner loop also
      turns its accesses into checked reads with a double index: an `imul` sum over
      record fields ran 35 ms nested against 28 innermost. Inner loops need their own
      counters, with range guards at each inner entry, before records can nest.
      Frame-local shape snapshots for plain static loads and stores in loops made
      such a loop about 8% faster but the self-compiler's parser slice 1.7 to 2.6%
      slower, so they serve number-record regions only.
- [ ] Track field representation facts on shapes. Every field is now one tagged
      slot, so int32, Number, object, constant or a known field shape would be a
      monotone fact on a shape's property that widens in place, not a physical
      layout with repacking. A region could then guard its receivers' shape once
      and skip per-field tag checks, and chained loads could skip the inner shape
      compare. Widening must reach the transition subtree and integrity variants,
      and trusting code needs either one fact epoch or per-field dependencies;
      try both. Measure against the loop regions first: so far the large costs are
      boxing on loop-carried chains and call dispatch, which facts alone do not remove.

- [ ] Run a `for-of` over a local generator call as the generator's own loop.
      `iterator-generator-traversal` takes 31 ns per value against Node's 12.5, and
      the self-compile spends about 1.8% inclusive in
      `mal_generator_try_exact_iterator_step`: each value pays the step probe, a
      native frame, root setup, a snapshot reload and clear, and the yield's root
      and barrier work. When the call's exact target is a generator without
      try/finally, environment operations, `this` or `arguments`, and its object
      only reaches GetIterator, Core can splice the generator body in place of the
      iterator. Each `yield` then feeds the loop body, the body's back edge resumes
      after the yield in next mode, `return` leaves the loop, and the caller's
      loop-carried values travel through the generator's blocks as parameters.
      Without a finally, `break` and a throw from the body need no generator
      return, and a throw from the generator leaves the loop unclosed as it does now.
      The self-compile's hot generators are class methods, such as
      `CoreFunctionStore#bodyInstructionIds`, `valueIds` and `#liveInstructionIds`,
      which read `this` and private fields and are reached through a method load.
      Covering them takes a guarded method target with the generic `for-of` as
      fallback, and a `this` binding, on top of the splice.

## P2: composable temporary values

- [ ] Extend existing string/capture projections only where the P0 profile shows
      materialization is a leading cost. Compose a bounded sequence of span,
      concatenation, length, numeric, or character consumers through an explicit
      virtual-value contract, instead of adding source-pattern recipes. Preserve
      UTF-16 indexing, source lifetime, case-conversion semantics, length limits,
      effects, and fallback materialization. Distinguish string allocation costs
      from RegExp/native-kernel costs that more compiler analysis will not remove.
- [ ] Allocate a fresh literal only on the paths where it escapes. A loop that
      builds `[index, index + 1, index * 2]` from an inlined helper, reads its
      elements and length, and publishes it every 1024th iteration has every read
      forwarded, yet still allocates and initializes the array on each iteration:
      about 32 ns/op natively against Node's 7.8. Moving the allocation and its
      initializing stores into the publishing branch needs the stores' values to
      stay available there and the escape to be the only remaining use.

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

# Runtime safety and allocation

- [ ] Complete recoverable allocation failure for CELL, RAW, LOS, GC-internal,
      runtime-helper, and direct-native allocations. OOM must remain catchable without
      corruption, lost roots, recursive failure, or partial observable objects.

- [ ] Keep suspended generator frames in GC-managed storage. Compiled coroutines
      take their register and argument buffers from a malloc'd pool, so a
      generator that dies suspended needs a finalizer to return them. In the
      JavaScript benchmark's async phase every generator ends suspended in its
      `finally`, and that finalization is 11% of the phase (55 ms per round
      against Node's 39). The compiled code allocates the registers before the
      generator exists, so the change spans code emission and the coroutine runtime.

- [ ] Store an arguments object's indexed elements densely. Mapped and unmapped
      arguments objects keep every index in a property table, so creating one with
      16 values upserts 16 entries and each `arguments[i]` read hashes its key. An
      opaque callee that returns its strict `arguments` costs 340 ns per call against
      Node's 6.6 (`call-arguments-escape`). Dense storage needs define, delete,
      freeze, and own-key order to understand it, and a move to the table once an
      index gets non-default attributes.

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

- [ ] Dispatch chains of string comparisons on length. A quick self-compile makes
      187M strict comparisons against string literals: 4.4M hit on identity, 170M
      fail on length and 13M compare equal-length units, about 2 to 3% of the run.
      Each comparison is already inline, and a `switch` over string cases already
      dispatches on length or hash. The volume likely comes from `===` chains such as
      `op.opcode === "A" || op.opcode === "B"` and `if`/`else if` ladders over one
      subject, which test every literal in turn.
- [ ] Construct derived classes without the generic super path. `new Pair(l, r)`
      with `super(l)` into a one-field base takes 116 ns against Node's 5.6
      (`constructor-derived-super-retained`). The construct inliner refuses
      derived constructors, so the site goes through `mal_vm_construct_value`.
      Inside, `super(l)` allocates an argument Array for `constructSuper`, the
      base constructs its receiver for its own one field, and the derived
      field then grows the slots through malloc, which also costs a finalizer.
      Inlining the derived body at a construct site needs `constructSuper` to
      become an inlined base construction with `new.target` as the receiver's
      prototype source and a slot reserve for every class in the chain, behind a
      guard that the constructor's prototype is still the heritage.
- [ ] Close the closed-compiled JavaScript benchmark's per-call gap. An
      unknown-target call still costs 6.4 ns against Node's 4.3 (a four-closure
      loop, 191 ms against 129) and a five-class method loop 345 ms against 232. The
      generic entry still unpacks an argument array, publishes a root frame and
      returns through a completion check. Frame rows are not the cost (a build
      without them ran the self-compile 0.3% faster), and field entries beat
      inlining the `quote` bodies.
- [ ] Close the rest of the objects phase's order loop. It takes 35.7 ms against
      Node's 19.3, down from 47.9 now that a chain of generic adds keeps its sum
      unboxed. The dispatched `quote` result is still boxed because the fallback call
      can return anything, and `% MOD` runs the generic remainder on the
      loop-carried checksum. The dispatch itself runs twice: three class cell checks
      pick the method, then its function index is compared with the same three
      targets once to decide whether to build `order` and once to pick the direct
      entry. A class cell's method is runtime state, so calling each entry straight
      from its class branch needs a fact that nothing reassigns `quote`. The
      `accumulator` closure stays a call as well: the inliner rejects captured
      bindings unless the closure was created in the caller's scope chain.
- [ ] Run inlined `filter` callbacks over an unknown dense Array without per-element
      dispatch. `values.filter((value) => (value & 7) === (round & 7))` over 1024
      numbers takes 5.0 ns per element against Node's 1.2 (3.9 with a constant in
      place of the captured `round`). Each element pays a generic `index in array`
      hole test with a boxed result, an element load that dispatches on the
      Array kind, and a reload of the captured binding: loop-invariant code motion
      keeps it in the loop because the `in` test and the load may call user code
      on an arbitrary receiver. The array is not known to be packed, so the
      region needs the dense storage check at entry that numeric loop regions use,
      plus the appends to the result array.
- [ ] Give large functions allocation-free iteration. Region selection spends the
      program generated-code budget after about 1,700 of 28,700 discovery
      opportunities in the self-compile, so functions such as render-native-c's
      `emitBody` get no deferred iterator cursors or entry pairs: its 54 for-of
      loops allocate an ArrayIterator each, and `entries()` loops a pair per step.
      Raising the program budget fourfold made the self-compile 3.1% slower,
      because the compiler then emits more C for its own input. Within the
      functions it reaches, four expansive plans per function decline about 3,300
      more; raising that limit to 16 made the self-compile 1.04% slower (optimize
      +18 ms and emit +20 ms for `parser.ts`) with no measurable gain in the
      compiler's own run. Admission needs a runtime benefit signal, such as loop
      nesting or a profile, rather than a larger budget or limit.
- [ ] Stop allocating closures that are only called. render-native-c's
      `emitInstruction` creates about 40 closures on entry to every call and uses
      a few per case: 1.64 million closures from 46,000 calls in the parser workload. Only the 20 of its 225 creation sites that capture lifting
      rewrites are reduced to direct calls, and even those still allocate the
      closure object the call passes as its callee. Sinking creation into the
      cases that use it, or passing no object when the target never reads its
      callee, would remove most of these allocations.
- [ ] Publish compiled root frames only on paths that can reach a safepoint.
      Small accessors such as the Core store's `instructionKind` and `checkedId`
      link a root frame and clear their GC slots on entry although only their
      throw paths collect. In the full self-compile's optimize phase those
      accessors take about 14% of the samples, and loading and dispatching the
      method calls to them another 8%; calling them directly on a known
      `CoreFunctionStore` receiver would remove most of both. Their call sites in
      loops are already offered as guarded inlines (218 for `instructionKind`,
      286 for `instructionOpcodeName`) but the cross-call program budget runs out
      first; letting inlines of 32 or fewer units bypass that budget grew the
      compiler's own output for `parser.ts` by 49% and made the self-compile 44%
      slower, so the remedy is cheaper calls or a hotness signal, not more inlining.
- [ ] Keep Node stream state in native fields. The C stream runtime reads and
      writes its state as own properties named by C strings, about 177 interned
      names per Express JSON request, and its helpers take 7% of that route's
      samples. Interning by address made each name cheap; the property traffic
      remains. Finding those names through the shared shape stub instead of a
      shape search changed nothing measurable.
- [ ] Bound the call targets of methods stored on module-scope objects. In a
      script, `holder.run(value)` with `holder.run` assigned two functions
      dispatches to both through a finite guarded set; as an ES module the same
      code calls generically. Module function declarations are stored into their
      slots by the module's instantiation function, while `holder.run = first`
      runs in its body, and the program-flow engine collects known-function
      property writes per function, resolving a receiver slot only from a store in
      that same function. Resolving closed slots from every function's stores needs
      a cross-function dependency in that incremental collection.
      `finite-call-target-dispatch` compiles its fixture as a script until then.
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

- [ ] Extend the inline Array iteration expansion to flatMap, findLast,
      findLastIndex and unseeded reduce, each with fixture coverage of holes,
      receiver mutation and fallback receivers. Expanded sites still run the
      eligibility guard on non-Array receivers with the same method names (Map and
      Set `forEach`, user `find` methods); measure that tax before widening.

- [ ] Cut the per-element cost of expanded Array iteration loops: `array-map`
      spends 6.1 ns per element against Node's 1.3. The HasProperty test still boxes
      its result for a truthiness test, separate from the element load, because the
      array presence projection does not fire on these loops; the callback's
      loop-invariant captured read (`value + round`) reloads through
      `mal_vm_load_captured` every element; and each result goes through
      `mal_vm_array_try_define_index`.

- [ ] Cut the hinted Map lookup's cost when keys alternate. A get on a 4,096-entry
      Map with alternating keys takes 7.1 ns for int32 keys and 8.6 ns for objects
      against Node's 4.3 and 4.9. Int32 and identity lookups are frameless leaf
      calls with a one-multiply hash now; what remains is the dependent probe
      chain (hash, control group, slot, key) and, at a receiver the compiler
      cannot type, the method capture guard before every call.
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
      backtracking executor for every exec; together with result arrays it
      dominates `primordial-string-regexp-projections`. In the
      Express in-process route RegExp execution took about 11% of the samples:
      backtracking under a third of that and malloc/free about as much, from each
      match's capture vector and from widening Latin-1 subjects for patterns with
      non-ASCII classes. The allocation-free plan now runs linear patterns such as
      routes and media types, 37% of the route's executions; the rest need
      alternation and quantified groups, for example content-type's parameter
      pattern with its quoted-string alternative.

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
      A module that imports its own default binding reads it without a TDZ error
      before the `export default` runs: `instn-named-bndng-dflt-expr.js`, `-cls.js`,
      `-named.js` and `-star.js` expect a ReferenceError and get none in compiled and
      wire builds. The function
      and generator defaults pass. Preserve namespace TDZ checks during cycles.

- [ ] Implement import-defer syntax and semantics. Integrate it with linking,
      evaluation state, cycles, and failure propagation.

- [ ] Implement AbstractModuleSource and source-phase imports. Preserve module identity
      and host loading boundaries across cached and uncached compilation.

- [ ] Lower `require()` of an ES module when the program entry is an ES module. Only
      `compileCjsProgram` gives required ES modules a namespace slot, so under an ES
      entry, which includes every dependency island, the call throws
      `dynamic require is not supported`. Express's `debug` requires `supports-color`
      this way and swallows the error. Evaluate the required module at its first
      `require`, as Node does.

- [ ] Let `require` and `import()` cross linked-image boundaries. A build still
      compiles one whole program for them, and `maligator test` one application image.
      The loader already aliases CommonJS registry entries and namespace slots;
      `import()` additionally needs the earlier image's module evaluation state.

- [ ] Give `run`, `dev` and development builds one linked image per application
      module, as `maligator test` does. Measure native development builds first: every
      image adds an overlay table and link units.

- [ ] Download prebuilt images and native libraries instead of compiling them into an
      empty cache. A fresh install compiles the `maligator test` runtime image (about
      650 ms of a 750 ms first test), every dependency island (6.3 s for an empty-cache
      `run` of express, drizzle and valibot, while reusing a cached island from another
      location costs about 230 ms) and, for a first build, the runtime C and Rust
      libraries (35 s). Ship the toolchain images in the npm platform packages. Publish
      dependency images keyed by package version and compiler identity, and static
      runtime libraries for the common build-setting combinations (eval, Intl, web and
      node surface, primordial policy, target), as GitHub release assets or as OCI
      artifacts on ghcr.io, the way Homebrew hosts its bottles. Consumers verify the
      digest, cache the download and link it statically; anything without a match
      still compiles locally.

## Active correctness clusters

- [ ] Cover the conservative stack scan's single-owner env walk with a regression
      test. A closure that keeps only its own scope, run after the enclosing scope
      dies, aborted with "attempted to shade a reclaimed cell" before e59c19f8 in a
      CLI `--production` build under `MAL_GC_STRESS=1` alone (verification hides it),
      even at 10 closures by 4 rounds by 50 allocations. The test harness's builds of
      the same program, production or not, keep a different stack layout and never
      reproduce it, so a harness fixture cannot guard the fix as it stands.

- [ ] Mint private names per class evaluation inside loops. A class expression
      evaluated by each iteration of a loop in one activation keeps its private
      names in that activation's captured slots, so every evaluation overwrites
      the same slots: after `for (...) list.push(class { #x; static has(o) { return #x in o; } })`,
      `list[1].has(new list[0]())` is true in both backends where Node returns
      false. The class's home-object and heritage slots are shared the same way:
      `super.m()` in the first iteration's subclass calls the last iteration's
      base. Factory functions are unaffected because each call owns its slots.
      Give such evaluations their own class scope, as per-iteration bindings do.

- [ ] Materialize a script function's lazy `prototype` before the function stops
      being extensible. `Object.freeze`, `Object.seal`, `Object.preventExtensions`
      and `Reflect.preventExtensions` on a constructor or generator whose
      `prototype` was never read leave it without one, because the later lazy
      definition is rejected: `Object.getOwnPropertyNames(Object.freeze(function f() {}))`
      lists `length,name` where Node lists `length,name,prototype`.

- [ ] Fix remaining RegExp @@replace protocol and coercion cases. Prefer shared
      replacement semantics over case-specific branches.

- [ ] Fix remaining arguments-object legacy caller and parameter-expression behavior.
      Cover strict, sloppy, mapped, and unmapped forms.
      A statically declared sloppy function returning its mapped arguments can
      expose a `callee` value unequal to that function binding. The new identity
      assertion reproduces on `46b5043c` with compiled calls; investigate callee
      identity preservation separately from fresh descriptor initialization.

- [ ] Work class, compound-assignment, super, Proxy, and iterator-helper failures in
      descending shared-root-cause order. Keep each repaired cluster in the curated
      regression manifest.

- [ ] Preserve Proxy targets and handlers across reentrant trap lookup. The
      `revoke-as-side-effect.js` case crashes in `getPrototypeOf` after the trap
      getter revokes the proxy; audit internal methods that reload those slots
      after calling user code.

- [ ] Complete script-global environment-record behavior across separately evaluated
      scripts. `$262.evalScript` now compiles a Script, but the runtime keeps no
      [[VarNames]]: a `let` over a var that an earlier eval created is refused, and
      a `var` over an existing configurable global property tries to redefine it.
      Keep eval-created declarations distinct from script declarations, including
      deletability and restricted-global checks.

- [ ] Preserve iterator [[Done]] semantics in positional destructuring. Keep abrupt
      completion and iterator closing correct around exhausted iterators.

- [ ] Look up the super constructor when `super()` runs. GetSuperConstructor reads
      the active function's current prototype, so `Object.setPrototypeOf(C, other)`
      changes what `super()` constructs; the lowering uses the class heritage
      captured at definition. Keep a guarded fast path for the unchanged parent.

- [ ] Yield the inner result object unchanged from a sync `yield*`. The spec hands
      `innerResult` to GeneratorYield without reading `value`; the `yield`
      instruction always builds a new result, so a `return()` result with
      `done: false` has its `value` getter called.

- [ ] Parse CreateDynamicFunction parameters and body separately. `new Function("/*", "*/){")`
      compiles because the joined source is valid; the spec parses each part on
      its own. Check that the function's parameter list and body close at the
      delimiters the runtime inserts.

- [ ] Give sloppy functions own `caller` and `arguments` properties. V8,
      SpiderMonkey and JSC define them as non-writable data properties holding
      null, so reading `f.caller` from sloppy code does not reach the
      %ThrowTypeError% accessors on %Function.prototype%; 16 legacy
      `Function/15.3.5.4_2-*gs` tests rely on that. Keep own-key order, descriptors
      and deletion consistent with the synthetic `prototype` property.

- [ ] Probe HasProperty again when a `with`-provided callee is read. The call path
      resolves the base and then loads the function with a plain Get, skipping
      GetBindingValue's second HasProperty that a Proxy with-object observes.

## Engine capabilities

- [ ] Replace the fixed 128-bit BigInt representation with arbitrary-precision digits.
      Remove width approximations from arithmetic, parsing, formatting, comparison,
      typed operations, and serialization.

- [ ] Work Intl from generated failure clusters covering supported values, locale
      options, NumberFormat, DateTimeFormat, and interval collapsing. Keep data
      availability distinct from algorithmic correctness.

- [ ] Add the Intl.Locale info methods: getCalendars, getCollations, getHourCycles,
      getNumberingSystems, getTimeZones and getWeekInfo. They need CLDR region
      preferences with the rg, region, sd, likely-subtags priority; ICU4X's
      calendar resolution skips likely subtags, and week data lives in the
      DateTimeFormat service while Intl.Locale is in the always-on floor.

- [ ] Reject RegExp.prototype.compile on a RegExp from another realm. The legacy
      features check needs the object's realm, which RegExp objects do not record.

- [ ] Generate a ranked failure-cluster report from scripts/test262.json. Use it rather
      than mutable hand-maintained counts to select correctness work.

# Eval, Function, and Realms

## Eval correctness

- [ ] Finish EvalDeclarationInstantiation behavior for persistence, deletion,
      non-definable globals, and strict or sloppy conflicts. Cover every relevant
      environment kind.

- [ ] Complete direct-eval arguments and parameter-environment behavior. Preserve
      mapped parameters, parameter expressions, shadowing, and strict-mode differences.

- [ ] Resolve the caller's `with` objects in direct eval code. Inside
      `with (o) { eval("m()") }` the eval code throws a ReferenceError for `m`: the
      marshaled caller scope carries the caller's bindings but not its with-object
      environments, so neither reads nor WithBaseObject calls reach `o`.

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

- [ ] Match DNS replies against the question section (2026-10-20 security audit).

- [ ] Align `http.maxHeaderSize` (16 KiB) with the codec's 64 KiB limit and answer
      HPE_HEADER_OVERFLOW with 431, as Node does.

- [ ] Give the https socket facade `destroyed`, so a throwing SNICallback reports true
      in `tlsClientError` listeners.

- [ ] Confirm SNI context matching against CVE-2026-48928 once details are published,
      and SQLite 3.53.3 against CVE-2026-69867.

- [ ] Stop re-arming epoll for every exchange on Linux. Each read op re-arms its
      EPOLLONESHOT registration with an `epoll_ctl`, so a keep-alive connection pays
      a syscall per request. kqueue now submits registrations with the next wait,
      which gained 1.5% on Express routes; epoll cannot batch, so it needs
      persistent registrations whose unused directions are dropped lazily.

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

- [ ] Complete residual byte-stream BYOB, descriptor, error, and cancellation
      semantics, and curate the streams/transform-streams WPT. Keep active Streams WPT
      slices green under normal and GC-stress execution.

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

- [ ] Add remaining TextDecoder labels and Web IDL details, and curate the
      encoding/streams WPT. Use versioned encoding data and incremental state.

- [ ] Offer CompressionStream and DecompressionStream without the Node surface: the
      zlib codec links only with the node-zlib feature. Curate the compression WPT and
      match Node's messages for corrupt input.

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

- [ ] Detect child exits from SIGCHLD or a kqueue process source instead of the
      5 ms waitpid poll, emit 'data' on exec/execFile child streams (output goes
      straight to the callback buffer today), and implement fork with an IPC channel.
      Exercise active-child cleanup in embedded VM teardown on a Linux host.

- [ ] Fail CI when THIRD_PARTY_NOTICES.md is stale against Cargo.lock, the vendored
      sources and the derived-file list, and find license texts for alloc-stdlib and
      blake2b_simd, which publish none and are listed by SPDX expression only.

- [ ] fs: watching more than 256 entries per watcher on macOS (kqueue holds one fd
      per watched file and subdirectory; FSEvents would lift it), Linux
      recursive-watch symlink entries (Node reports their events and link-target
      changes as 'rename'), the watcher 'error' event, fs.openAsBlob, readdir's
      `encoding: "buffer"` and lchmod on macOS.

- [ ] net and dgram: http2 servers and allowHalfOpen. Client sockets try resolved
      addresses one after another instead of Node's happy-eyeballs attempts (no
      250 ms attempt timer, no `connectionAttempt*` events, no family interleaving),
      and `autoSelectFamily: false` is not read. net and dgram call the internal
      lookup, so a patched `dns.lookup` is not seen; dgram ignores
      `createSocket({ lookup })`. TCP connect errors lack Node's
      `connect ECONNREFUSED host:port` message and `address`/`port`/`errno`/`syscall`
      fields. A second `listen()` during a pending named-host lookup does not throw
      ERR_SERVER_ALREADY_LISTEN, and an over-long Unix socket path throws a generic
      Error. Also dgram source-specific membership and collection of sockets that
      are never closed.

- [ ] crypto: RSA key generation (ring has none), encrypted PEM, RSA-PSS salt
      lengths other than the digest length, ECDSA signing with a hash other than the
      curve's own, publicEncrypt, DiffieHellman and Cipheriv as Transform streams.
      The rest of WebCrypto: RSA generateKey, RSA-OAEP, ECDH/X25519,
      deriveKey/deriveBits, wrapKey, jwk export of secret keys, and
      Crypto/SubtleCrypto methods on their prototypes rather than the instances.

- [ ] crypto: createHash, createHmac and createCipheriv drop their options instead of
      keeping them as `_options` for lazy stream initialization, so stream options
      such as `highWaterMark` do not apply; after a stream flushes a hash, update and
      digest report ERR_CRYPTO_HASH_FINALIZED where Node reports
      ERR_CRYPTO_HASH_UPDATE_FAILED and digest still answers.

- [ ] crypto: createECDH/ECDH needs elliptic-curve arithmetic that ring does not
      expose (private-key import and export, reusable computeSecret), so it waits on a
      crate decision. X509Certificate: OpenSSL-exact checkIssued (key identifiers and
      keyUsage), checkHost options, RSA-PSS verify, toLegacyObject's public-key
      fields, issuerCertificate, and the DEP0179/DEP0181 warnings of the Hash and Hmac
      constructors.

- [ ] tls and https: https.Server should cache SNI-selected configs (tls.Server keeps
      four) and give request sockets `authorized`, `authorizationError` and
      getPeerCertificate. Cache the deferred verification verdict on the session, and
      accept tls.connect's `checkServerIdentity` option. `new tls.TLSSocket(socket,
options)` wrapping with a deferred start, and `setDefaultCACertificates`.
      rootCertificates comes from the system store rather than Node's NSS list, and
      no certificate compression is offered. Plain 'connection' listeners on a
      tls.Server see a TLSSocket where Node passes the raw socket.
      getPeerCertificate(true) issuer chains, repeated name attributes as arrays,
      public-key fields, `ext_key_usage`, `infoAccess` and IPv6 subjectaltname
      entries. https agents with TLS options, Buffer `cert`/`key` and
      `pfx`/`passphrase` for https requests, Node's `ERR_OSSL_*` codes for malformed
      credentials, and 'connection' on https.Server with TLSSocket-like sockets for
      its 'tlsClientError'. http: move the shared header and body methods onto
      OutgoingMessage.prototype so overriding them there reaches ServerResponse and
      ClientRequest.

- [ ] modules: createRequire with a computed specifier, or a base other than
      `import.meta.url`, resolves only what the module graph bundled from literal
      specifiers. import.meta.resolve does not resolve `#` package imports, does not
      realpath symlinked files, and resolves a computed bare specifier only when the
      module imports it or resolves it literally.

- [ ] dns: resolveAny sends no query (ENOTIMP); decide whether to match Node 26's
      irregular cares_wrap output. resolve4/resolve6 still use getaddrinfo, so
      /etc/hosts applies and `ttl` is 0; route them through the record-query
      transport. dns.Resolver instances share the module's servers and lack the
      `timeout`/`tries` options and cancel(); queries send no EDNS0.

- [ ] zlib zstd and the zip archive APIs.

- [ ] WebSocket: try further resolved addresses after a refused connect (Happy
      Eyeballs like Node's autoSelectFamily), offer permessage-deflate, and bound send
      backpressure and message size. Web events: base Event fields as prototype
      getters like Node, and MessageEvent.prototype.initMessageEvent.

- [ ] worker_threads: `locks` / `navigator.locks` (LockManager request/query,
      exclusive and shared modes, ifAvailable, steal, signal), shared across threads
      through a process-wide table with per-isolate grant mailboxes.
      `markAsUntransferable` should also make an ArrayBuffer's
      `transfer()`/`transferToFixedLength()` throw "ArrayBuffer is not detachable
      and could not be cloned.", as V8's detach key does. BroadcastChannel scans one
      process-wide list; index it by name if processes use many channels.

- [ ] vm's SourceTextModule, SyntheticModule, measureMemory and DONT_CONTEXTIFY, and
      a live contextified global (contexts copy the sandbox's own enumerable
      properties in and changed globals back, so its prototype chain, getters and
      deletions do not reach the script), plus collection of realms whose sandboxes
      are gone.

- [ ] node:net: `BlockList` (lib/internal/blocklist.js plus node_sockaddr.cc
      matching, IPv4-mapped IPv6 included) and `SocketAddress`
      (lib/internal/socketaddress.js, `parse` through WHATWG URL parsing); make
      connect() honour getDefaultAutoSelectFamily() and its attempt timeout, which
      are module state only today. util.throttle as Node 26 defines it. url.parse
      emits no DEP0169 warning, and ASCII hostnames skip Node's toASCII validation.

- [ ] node:stream: `removeListener('readable')` does not re-evaluate
      readableListening (Node's updateReadableListening), and 'close' after destroy is
      emitted synchronously from the destroy callback rather than on the next tick.
      Middle generator stages in pipeline receive the previous Readable itself, where
      Node wraps it with fromReadable.

- [ ] node:stream: a pipeline stage that pumps into a web TransformStream rejects with
      "Value is not a function" (Readable → TransformStream → Writable), although the
      TransformStream's writer and async iteration work on their own.

- [ ] node:url: `url.format` should `querystring.stringify` an object `query` when
      `search` is absent, and format WHATWG URL objects with its options argument.
      util.isPartialDeepStrictEqual, and `_extend` on a primitive target throwing V8's
      exact message. Once `URL.createObjectURL` exists, buffer.resolveObjectURL must
      look up registered `blob:nodedata:` ids.

- [ ] Make async_hooks observe more than AsyncResource: timers, I/O and promises
      do not emit hook events, and executionAsyncId() inside their callbacks stays
      at the enclosing resource. perf_hooks reports no GC, http or dns entries and
      no loop idle time, since the reactor does not expose its wait time.

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
      and error ordering over shared transport. Known differences: the HTTP client
      keeps one idle pool for every Agent, so a new keep-alive Agent can report
      `reusedSocket` on its first request and `agent.destroy()` closes every idle
      connection; it tries one address per request where Node falls back and
      reports an AggregateError (`localhost` with nothing listening); https agents
      reject pooling options. ServerResponse sends header names lowercased and lets
      getHeader see headers passed only to writeHead. Stream destroy() emits 'error'
      and 'close' synchronously where Node defers them a tick.

- [ ] Close measured Express performance gaps without regressing fixture behavior or
      bare-server throughput. Profile before selecting compiler or runtime work.

- [ ] Exercise postgres.js logical replication, prepared transactions, negotiated TLS,
      and primary or standby selection against a dedicated topology. Keep
      topology-dependent tests separate from the deterministic local baseline.

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

- [ ] Barriers: decide dense-fill and scalar captured-store card specialization
      after representative HTTP and compiler comparisons; app-batch screens were
      mixed. Dense reverse removes redundant scans under whole-array tracing and
      had a neutral application cut. Dense shift/copy card narrowing was rolled
      back after a repeated application slowdown; its semantic fixture remains.
      Keep SATB deletion protection independent of generational facts.
- [ ] Pacing: replace the eighth-collection major cadence with a pressure policy
      built on young survival, promotion debt, major reclamation yield, RAW and
      chunk capacity and assist cost. Fixed cadences are not one: 16 raised peak
      RSS about 27% without improving elapsed or CPU time, and 4 traded fewer
      minor visits for more major work and 3.1% more pause time.
- [ ] Bounded slices: retain the skipped-block sweep budget only after combined
      latency review. One instrumented app run had more short major slices and a
      5.998 ms minor pause outlier; repeat before claiming application pause gains.
      Use mutator-only array trace attribution to identify a measured large-container
      or root-scan offender before adding resumable tracing or wider exact liveness.
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

# Triggered work

These are not active tasks and become actionable only when their condition is
observed.

- Replace global free lists with per-block lists, or release chunks, only when a
  workload shows long sweep exposure; the app diagnostic allocated 32,800 bytes
  during major sweep.
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
