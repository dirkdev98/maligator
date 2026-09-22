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
7. Pursue actors, SMP, embedding, and freestanding targets after the active runtime
   foundations are ready.

## Verification workflow

- [ ] Make `scripts/dx-performance.ts` verify the running application's revision
      before and after a dependency edit. A controlled driver that keeps reporting
      revision 0 after the source changes to 1 currently passes on compiler log markers.
      Bound invocation, readiness, and shutdown; a child ignoring SIGTERM currently
      hangs cleanup. Require prompt failure on child exit, forced termination after
      a grace period, and retained diagnostics. Verify stale-output and stuck-child
      failures alongside a real successful development restart.

- [ ] Retain gate reports per run with source revision/content identity. The current
      `scripts/test-suite.ts` overwrites `report-<tier>.json` and cannot associate its
      stage verdicts with a specific source snapshot. Preserve a discoverable latest
      report without replacing earlier evidence.

- [ ] Align `scripts/command-requirements.ts` with actual cache-lease behavior. Unit
      and quality plans declare no user-cache writes, while their `CommandProgress`
      wrappers create leases there. Verify the declared capabilities against the
      command lifecycle so restricted execution retains cache coordination.

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

- [ ] Reduce the largest measured Core planning/optimization costs on both hosts.
      Attribute candidate discovery, shared-fact/transfer construction, CFG and
      dominance work, fixed-point iterations, invalidations, and materialization of
      intermediate data. Use the existing feature indexes, summaries, and analysis
      manager to skip irrelevant work and rebuild only invalidated results. Reopen
      a previously optimized subsystem only with fresh residual-cost evidence.

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

- [x] Implement VM training feedback, profile-guided Core budget admission, and the
      persistent single-module Core pilot through stages 1–3 of
      [the PGO decision log](docs/decisions/08-profile-guided-and-incremental-optimization.md#d014--2026-09-22--vm-training-capture-and-explicit-merge).
      Focused native and unit checks cover attribution, lazy proof admission,
      cache invalidation, relocation, and independent module state.
- [ ] Complete representative PGO training and performance acceptance; tune the
      measured/unknown allowances and make remaining cross-call proof discovery lazy.
- [x] Integrate opt-in persistent Core reuse into ordinary production builds for
      admitted static ESM leaves. Preserve live exports, initializer order, captured
      cells and source-immutable facts; skip only the completed scalar seed.
- [x] Extend the boxed artifact boundary for Meriyah's classes, handlers, switches,
      heap operations and literal pools; reuse its Core after application edits.
- [x] Reuse the verified Core function storage on first import instead of rebuilding
      SSA and use chains; keep repeated imports independently owned.
- [x] Split persistent Core manifests and variants; ordinary hits load only optimized
      bodies, while canonical decoding remains explicit and lazy.
- [x] Reuse Core-owned immutable constant tables and retain their rows through
      frontend import/finalization while snapshotting caller-owned inputs.
- [x] Materialize decoder operand placeholders only for actual forward references,
      retaining verification of missing, cyclic and non-dominating uses.
- [x] Persist completed scalar/structural cleanup with strict budget completion and
      version witnesses; skip unchanged imports' initial construction cleanup.
- [x] Make cross-call value-kind propagation consumer-driven: collect foldable
      observations first and request global types only when their unresolved inputs
      depend on call results, parameters or receivers. Preserve local folds and
      conservative fallback through moves, block parameters and later edits.
- [x] Restrict global type transfers to the dependencies of return values, consumed
      call inputs and type observations. Keep local integer proofs complete and
      distinguish unrequested values from lattice bottom in published snapshots.
- [ ] Transfer already-dense function storage across construction generations without
      copying its columns. Preserve retired-handle and iterator failures, kernel
      ownership, version accounting and compaction for functions with holes.
- [ ] Investigate repeated execution-register liveness in lowering, verification and
      runtime-image emission. Reuse valid work across consumers with different
      safepoint sets while preserving body-change invalidation and exact GC roots.
- [ ] Design and measure explicit optimized-only cold-cache capture, skipping unused
      canonical capture, validation and encoding. Preserve D020/D023's current
      canonical publication and load-only access contracts until an append-only
      decision defines variant identities and reconstruction from pinned inputs.
      Keep reconstruction explicit and measure cold cost separately from warm reuse.
- [ ] Finish ADR stage 4: split function bodies for demand loading and
      complete repeated representative application-edit performance acceptance. Current
      `build --production --core-cache` reuses supported leaves, while graph parsing,
      semantic analysis and selected-module decoding remain current-build work.

- [ ] Implement reusable optimized Core modules, then stable native products and
      bounded upgrades through stages 3–7 of [the incremental optimization plan](docs/decisions/08-profile-guided-and-incremental-optimization.md#d009--2026-09-22--meriyah-pilot-and-plan-of-attack).
      Extend dependency validation beyond admitted leaves, preserve canonical
      alternatives and charge cached output growth.

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

- [ ] Preserve conditional iterable expressions in compact type stripping.
      `for (const item of condition ? items : [])` currently loses the ternary's
      colon and following code during compiler-source baking. Cover this syntax
      at the stripper boundary; the demand-driven discovery loops use named
      iterable locals in the meantime.

- [ ] Extend the shared bytecode-operation and builtin descriptors to generate operand
      schemas, lowering completeness, effects, representation constraints, safepoint
      policy, and GC declarations. Adding an operation must not leave compiler, wire,
      native-C, interpreter, or runtime contracts inconsistent. Callback invocation
      semantics are owned by the P1 callback work above, not a second descriptor set.

## Compiler measurement and diagnostics

- [ ] Make the current-checkpoint paired workflow retain and compare local evidence
      without requiring a published baseline update. Preserve historical architecture
      snapshots separately. Refresh published JavaScript, HTTP/Express, and
      self-compile baselines only through an explicitly authorized update after
      acceptance; do not rank current work against an unrelated old checkpoint.

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

- [ ] Move publishing to a tag-driven GitHub workflow using npm trusted publishing.
      Keep prereleases on SemVer alpha versions and the npm alpha dist-tag.

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

- [ ] Fix remaining arguments-object indexed-property creation, legacy caller, and
      parameter-expression behavior. Cover strict, sloppy, mapped, and unmapped forms.

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

- [ ] Implement Unicode case mapping beyond the ASCII fallback. Use versioned data and
      cover context-sensitive and multi-code-point mappings.

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

- [ ] Cache compiled runtime-eval wire buffers by source and compilation context.
      Include world policy, Realm, host capabilities, and format identity.

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

- [ ] Add watch mode, snapshots, fake timers, and mocking when their semantics can
      remain deterministic in compiled and interpreted tests. Keep the unit loop fast.

- [ ] Add coverage, browser environments, parallel workers, and process-per-file
      isolation independently. Define cache, port, temporary-directory, and
      failure-reporting behavior for each.

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

- [ ] Move fiber, scheduler, GC, root, hook, clock, and host state from process globals
      into thread-local or isolate-owned structures. Preserve the single-isolate path.

- [ ] Run one isolate and scheduler per OS thread. Keep heaps and language objects
      isolated unless data is explicitly cloned or transferred.

- [ ] Implement cross-isolate send as copy plus MPSC enqueue and backend wake. Make
      queue ownership and shutdown races explicit.

- [ ] Add work stealing only for work without isolate-local pointers. Measure fairness
      and cache effects before enabling it by default.

- [ ] Verify independent per-isolate collection without cross-heap pointers or global
      stop-the-world coordination. Stress simultaneous collection, messaging,
      cancellation, and shutdown.

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

# Triggered work

These are not active tasks and become actionable only when their condition is
observed.

- Add concurrent marker or parallel GC workers only when a realistic large-heap
  workload shows mutator marking is a leading cost.
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
- Redesign persistent object layouts, specialize collection storage, or eliminate
  generator/async objects only after a representative profile and explicit
  identity/escape/completion contract establish the need. They are not prerequisites
  for the bounded P1 work.
- Start another emitter-only sweep when the fact-flow report identifies sufficient
  existing proofs that still select a general path; do not rediscover already
  implemented primitive kernels or mistake inline helpers for unavoidable calls.
