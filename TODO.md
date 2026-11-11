# Maligator roadmap

This is the sole project roadmap. It contains unfinished work only; completed work
belongs in commits, tests, generated reports, and benchmark baselines.

Each task has one owning section. Correctness, rooting, resource safety and
compatibility remain requirements independently of optimization payoff.

## Current priorities

Choose performance work from a repeated consumer and a bounded mechanism. Use
existing diagnostics only as needed to select a candidate; a broad admission audit
is not a prerequisite to independent work.

- Reduce repeated compiler work and product-emission peak memory on Node and the
  rebuilt native compiler.
- Remove a leading runtime-owned stream, allocation, string or collector cost in a
  representative application.
- Extend native specialization only where a current method, field, cursor or
  callback consumer can repay the extra proof and generated-code work.
- Keep actor, GUI and constrained-target features on their own product track.

Inventory and coverage ledgers record proved behavior; pending cells do not by
themselves commit the project to optimizing every API.

## Verification workflow

- [ ] Extend runtime-gap coverage for a selected RegExp, Intl, promise or weak-collection
      consumer, separating conversion, traversal and checksum cost. Add
      arbitrary-precision BigInt measurements after its correctness implementation and
      preserve input-scaling coverage.

- [ ] Diagnose the macOS node-fs-watch timeout with bounded phase evidence separating
      compilation, event delivery and teardown. Preserve watcher behavior and report an
      unreproduced or runner-only failure explicitly.

- [ ] Measure guarded arithmetic continuations, long-key hashing and cold FFI probes in
      full application and compiler workloads. Include Node and rebuilt native compiler
      costs, binding stub compilation/linking, peak memory and generated size. Require
      repeated matched savings beyond the focused runtime-gap and extraction cases.

# Compiler and Core IR

## Core IR contract

Core SSA is the only optimizing middle end for development, testing, interpreted
execution, native execution, and production builds. Internal formats use a hard
cut-over: schema changes invalidate cached artifacts rather than introducing adapters
or compatibility paths.

Core owns all multi-instruction optimization decisions and their proof obligations.
Target lowering may validate and consume Core decisions, while VM and C emission
perform only local lowering from explicit target metadata.

Prefer existing SSA, dataflow, effect and representation proofs. Extend analysis
only for a named consumer whose expected repeated saving can justify discovery,
invalidation, retained memory and emitted-code costs. An analysis contract needs a
bounded consumer follow-up and explicit cost evidence; it is not a runtime win.

## Native SSA storage

The independent target boundary and current storage contract are recorded in
[native SSA lowering](docs/decisions/native-ssa-lowering.md).

Choose native specialization by repeated consumer benefit and total cost. Preserve
mutable-callee fallback, coercion and exception order, publication, roots and polls.
Compare additional compiler/build time with absolute runtime savings over plausible
executions, measuring both compiler hosts.

- [ ] Try proven scalar argument/result transport through one existing frameless helper
      chain where conversions survive optimized C. Reuse entry representations and
      preserve effect-free restart. Stop if the C compiler already removes the traffic;
      otherwise require repeated-chain and compiler-workload savings that repay planning
      and native build cost.

- [ ] Distribute existing parts of one oversized native function across bounded
      translation units using a shared transfer-struct declaration. Keep only a cold-build
      improvement after link cost, peak memory, binary size and representative execution
      are included on both compiler hosts.

- [ ] Bound the end-to-end cost of splitter text recovery on current self-compile output
      before designing emitted read/write and control metadata. Migrate renderer and
      splitter together only if removing that work pays on both hosts while preserving
      split semantics, build time and size.

- [ ] Separate owner-held value-buffer pressure from survivor bytes that size the nursery
      without losing ownership or major-cycle accounting. Compare native self-compile,
      app-batch and Express time, physical footprint and pauses; retain only a bounded
      policy with stable memory use.

- [ ] Attribute current native self-compile footprint to live objects, partly occupied
      blocks, promoted garbage and external allocations, then change one owning policy.
      Require sustained footprint reduction without unacceptable compilation or pause
      cost; reuse existing page release before adding reclamation machinery.

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
- [ ] Preserve helper-owned state, handlers, resume entries and source certificates when
      retiring native entry paths. Extend reachable-edge consumption only for a selected
      surviving entry that removes measured work, with negative coverage for shared record
      storage and generic continuations.

- [ ] Measure residual isolate-local lookup in the checked-in worker/Tinypool workload on
      macOS, then prototype one hot state family carried through an existing activation.
      Keep only a worker-runtime gain with stable size and single-isolate controls,
      preserving thread ownership and teardown.

- [ ] Prove mutator/marker ordering for captured slots, then compare relaxed mutator loads
      and release stores on Linux x64 closure and self-compile workloads. Preserve atomic
      layout/publication and retain only a runtime win with collector and Apple Silicon
      controls.

## Compiled native output

Use representative compiled workloads to locate executed dispatch, allocation,
property and collection costs. Keep field facts bounded and consumer-driven;
static generated-code size and helper counts do not establish runtime cost.

- [ ] Test bounded method target sets for one repeated Core-store receiver using existing
      provenance, target caps and incremental summaries. Track relevant property/prototype
      writes and retain open fallbacks. Stop if exactness needs whole-heap flow; require
      changed downstream scalar/effect decisions and runtime savings that repay
      Node/native analysis and generated-C cost.

## Interpreted development images

`run`, `test` and `dev` interpret development images, so interpreter dispatch and
compilation both contribute to developer-loop latency.

- [ ] Hoist pure loop-invariant constants in interpreted development images using existing
      Core loop facts and valid intrinsic identities. Keep fewer dispatches only when
      interpreted JavaScript and development runs improve after compilation, frame size
      and zero-trip/handler behavior are included.

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

## Performance diagnosis and admission

- [ ] Use existing profiles and admission reports to trace leading sites in one selected
      application or compiler workload to the first blocking boundary. Stop with a bounded
      experiment, expected removed work, compile/build costs and a decisive acceptance
      criterion; do not require exhaustive diagnostics before independent work.

## Callback specialization

Shared lifetime and fallback rules are recorded in
[runtime region contracts](docs/decisions/runtime-region-contracts.md).

- [ ] Try one fixed numeric TypedArray reduction with a known synchronous reducer in the
      existing loop machinery. Preserve callback arguments, floating-point order and
      buffer invalidation. First bound the removable callback-transport cost against a
      same-order indexed control; retain only if repeated execution repays bounded
      cloning, analysis and generated-code growth.

## Selective field facts

- [ ] Carry allocation-site field kinds through one repeated record-backed compiler
      accessor chain so numeric arithmetic preserves validated access paths. Reuse bounded
      field indexes and writer/alias invalidation; keep shape, backing-pointer and value
      stability independent. Stop if the consumer requires a global mutable-shape type
      system or its saving cannot repay analysis and code growth.

## Compiler throughput and analysis scalability

- [ ] Bound aggregate work and retained state for analysis extensions, including
      discovery, rejected candidates and nested queries, with conservative fallback on
      exhaustion. Add only counters needed to prove limits and require end-to-end evidence
      before narrowing indexes or growing caches.

## Iteration and loop regions

An existing iterator cursor is not, by itself, permission to delete its language
object. Retained loop experiments preserve effects, authoritative state and fallback.

- [ ] Bound one typed-store side-exit experiment to core-to-execution or optimizer-queue
      and the corresponding compiler loop. First establish removable executed cost; then
      preserve already-committed stores and continuation state without generic OSR.
      Require end-to-end native self-compile benefit, Node-host planning controls, and
      acceptable code, frame and build costs.

## Source closure and generated-code profitability

- [ ] Identify one residual bytecode or metadata payload removable by the existing closure
      certificate in closed compiled app-batch/JavaScript images. Stop if required
      fallback or loader entries account for it. Preserve generic, interpreted, callback
      and debug paths, and require lower binary/build cost without new whole-program
      analysis or disproportionate compilation.

## Compiler infrastructure

- [ ] Remove aggregate transport-size ceilings from root-compiler requests,
      dependency metadata, diagnostics, and thrown values. Preserve structured
      clone semantics, error identity, source validation, and cancellation while
      keeping queue reservations for backpressure.

- [ ] Extend the shared bytecode-operation and builtin descriptors to generate operand
      schemas, lowering completeness, effects, representation constraints, safepoint
      policy, and GC declarations. Adding an operation must not leave compiler, wire,
      native-C, interpreter, or runtime contracts inconsistent. Callback invocation
      semantics are owned by the callback work above, not a second descriptor set.

## Compiler measurement and diagnostics

- [ ] Fill accounting gaps for the selected optimization in existing reports: ordinary
      application time, Node/native compilation, C/link cost, peak memory and emitted
      size. Retain frozen inputs, identities, raw pairs and parity; keep profiled
      attribution separate from acceptance timings.

- [ ] Make existing source/compiler remarks identify the final admitted entry or decline
      reason needed by a selected investigation, including stripped-artifact sidecars
      where necessary. Keep remarks consistent with emission and distinguish static
      opportunities from executed or sampled counts.

## Compiler acceptance policy

Start with an exercised consumer, the work a candidate removes, and a bounded pilot.
Stop when there is no admitted site, a decisive negative upper bound, or no plausible
repayment of added compilation and native-build cost. Focused correctness coverage
and repeated ordinary execution establish acceptance; profiles and simpler generated
C explain mechanisms rather than proving a speedup.

Compare complete application savings, Node/native compiler cost, downstream C/link
cost, peak memory and generated size. Extra compilation can be worthwhile when the
intended workload runs enough to repay its measured absolute cost; state that
breakeven assumption. Pure compiler-throughput work needs lower end-to-end time or
memory with preserved behavior, without a separate application speedup. Runtime
kernels need their owning semantic and lifetime proofs, not an invented Core change.

For throughput-only compiler refactors, preserve emitted C and runtime wire where
those outputs are in scope. Intentional optimizations can change generated output,
but Node/native hosts must agree within each checkpoint and observable behavior must
agree across checkpoints. Include discovery, rejected candidates, invalidation and
retained analysis state in compiler cost. Keep controls and unfavorable results;
record material memory, pause, size and build tradeoffs explicitly.

Preserve mutable/locked primordial, strict/sloppy, eval, Realm, suspension, OOM,
exception, rooting and mixed-execution contracts at their owning layer. Follow
[AGENTS.md](AGENTS.md), [testing](docs/testing.md) and
[benchmarking](docs/benchmarking.md) for focused checks, matched measurements and CI
acceptance. Baseline replacement remains an explicit action. Keep detailed evidence
and rejected experiment history outside this roadmap.

# Runtime safety and allocation

- [ ] Complete recoverable allocation failure for CELL, RAW, LOS, GC-internal,
      runtime-helper, and direct-native allocations. OOM must remain catchable without
      corruption, lost roots, recursive failure, or partial observable objects.

- [ ] Prototype GC-managed register/argument storage for suspended compiled generators in
      the JavaScript async workload. Preserve creation-time roots, resume/return/finally
      and OOM behavior, and retain only lower total allocation/finalization cost without
      worse pause, live-memory or build costs.

- [ ] Prototype dense default indices for escaping unmapped arguments, with
      descriptor/delete transitions to ordinary properties. Preserve key order,
      freeze/seal and mapped aliases; require a checked-in repeated-call consumer to
      improve after memory and fallback costs, using call-arguments-escape as the
      mechanism control.

- [ ] Add explicit locale subsetting with deterministic configuration, cache identity and
      missing-data behavior. Measure residual locale-dependent bytes after existing
      service selection before choosing the provider implementation; do not claim savings
      from locale-independent tables.

# Strings and text

The [text algorithm audit](docs/text-algorithms.md) records the implemented cost,
ownership, and bounded-resource contracts. Keep content parity, physical encoding,
allocation traffic, and retained memory distinct. Remaining work below extends those
contracts or investigates costs still visible after the string follow-ups.

## Focused performance work

- [ ] Check and bound UTF-16 start-position filtering in the pinned RegExp backend using
      the existing mixed-text/search workloads. Keep a backend change only with ordinary
      first-pass/repeated-input gains and exact captures/UTF-16 semantics; do not bundle
      speculative possessive rewrites.

- [ ] Bound a later-preheader array-initialization experiment to existing
      constant/dominance facts and initialization-region fixtures. Reproduce the original
      multi-loop admission loss before changing it, then require useful
      repeated-allocation exposure and fewer executed property definitions with bounded
      planning and handler/fallback controls.

- [ ] Expose one CoreFunctionStore cursor's captured iterator/next protocol to existing
      guarded call and scalar-replacement passes. Require removal of repeated
      protocol/result work in native self-compile, bounded Node/native planning and C
      growth, and exact mutation, done/value, abrupt-close and fallback behavior.

- [ ] Compare current region ranking with one bounded exposure signal for repeated
      iterator/record work in native self-compile, keeping existing program and function
      caps. Include discovery/rejected-candidate work, displaced plans, generic twins and
      actual C/link/size cost; retain only a net compiler/application benefit rather than
      larger budgets.

- [ ] Resolve the root-order and value-kind obligations exposed when removing unused
      loadCallee, then make genuinely unobserved callee reads discardable at their owning
      layer. Preserve observable callee/arguments identity and require CommonJS/Express
      benefit with bounded inlining and compiler cost.

- [ ] Resolve finite method writes through proven closed module slots across instantiation
      and body functions, recording incremental dependencies on every contributing store.
      Require ES-module finite-call-target parity and real repeated-call benefit, with
      bounded solve work and conservative dynamic/escaping-store fallback.

- [ ] Complete ordinary, terminator and phi/edge escape proof before suppressing
      split/trim materialization, carrying it through verification and cache identities.
      For the checked rope split/trim checksum, require full-output parity, safe
      fallback/reentry and throughput no worse than materialization on first-pass,
      repeated-input and flat controls.

- [ ] Carry an owning Core proof for private default-species map/filter output stores,
      or establish their index range through the eligibility guard. Remove repeated
      index/descriptor checks only with that proof; preserve map holes and final length,
      filter's geometric growth, write barriers and generic fallback. Compare the measured
      output-store ceiling with compiler work, native build cost and generated size.

- [ ] Bound first-pass and changing-subject RegExp executor allocations in Express and
      text workloads before extending the pinned backend's reusable-state API. Preserve
      captures, backtracking, lastIndex and reentry, cap retained state, and require
      ordinary workload gains that repay dependency and retained-memory costs.

- [ ] Use the existing complete mixed-text workload to select one leading construction,
      replacement, JSON or checksum-traversal cost, including rope rebuilding where
      exposed. Confirm through ordinary paired builds with full checksum and
      encoding/surrogate controls, rejecting work that merely shifts cost between
      construction and traversal.

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

- [ ] Evaluate per-application-module linked images for run, dev and development builds
      using one frozen multi-module edit cycle. Preserve singleton, require/import and
      evaluation-state semantics; choose granularity from incremental and clean build
      time, link units, overlays and memory on both compiler hosts before rolling it out.

- [ ] Prototype shipping one existing toolchain runtime image or common runtime-library
      artifact with the matching platform package. Key it by full source, toolchain,
      target and configuration identity, verify its digest and retain local compilation
      fallback. Accept on cold end-to-end install/use savings after transfer, package size
      and cache storage; do not add a universal dependency-image registry or build-setting
      matrix as a prerequisite.

## Active correctness clusters

- [ ] Resolve Intl locale availability and matching per service from bundled data.
      Preserve requested-locale order, lookup and best-fit semantics, relevant Unicode
      extensions and observable option coercion. Provider fallback alone does not prove
      that a locale is supported.

- [ ] Finish Intl NumberFormat currency/unit styles, scientific/engineering/compact
      notation, range formatting and localized nonfinite/percent affixes; DateTimeFormat
      option/calendar/time-zone selection, parts and interval fields; and DurationFormat
      structured unit and numeric parts. Keep reusable native plans and measure
      constructor cost, steady-state formatting and retained memory together.

- [ ] Generate decimal symbol data for the remaining locale/numbering-system
      combinations. Preserve per-service data selection and
      report actual fallback; do not substitute another language's punctuation.

- [ ] Cover the conservative stack scan's single-owner env walk with a regression
      test. A closure that keeps only its own scope, run after the enclosing scope
      dies, aborted with "attempted to shade a reclaimed cell" before e59c19f8 in a
      CLI `--production` build under `MAL_GC_STRESS=1` alone (verification hides it),
      even at 10 closures by 4 rounds by 50 allocations. The test harness's builds of
      the same program, production or not, keep a different stack layout and never
      reproduce it, so a harness fixture cannot guard the fix as it stands.

- [ ] Fix remaining RegExp @@replace protocol and coercion cases. Prefer shared
      replacement semantics over case-specific branches.

- [ ] Validate RegExp literal Unicode properties independently of the compiler host's
      Unicode data. Meriyah uses the host RegExp constructor, which rejects Unicode 18
      script names on Node 26 even though the native backend accepts them. Preserve
      syntax early errors and self-hosted parsing without per-literal subprocesses.

- [ ] Fix remaining arguments-object legacy caller and parameter-expression behavior.
      Cover strict, sloppy, mapped, and unmapped forms.
      A statically declared sloppy function returning its mapped arguments can
      expose a `callee` value unequal to that function binding. The new identity
      assertion reproduces on `46b5043c` with compiled calls; investigate callee
      identity preservation separately from fresh descriptor initialization.

- [ ] Work class, compound-assignment, super, Proxy, and iterator-helper failures in
      descending shared-root-cause order. Keep each repaired cluster in the curated
      regression manifest.

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

- [ ] Stop interning untrusted HTTP header names as VM-lifetime atoms. Incoming names
      become property keys through `mal_property_atomize_string`, and atoms are
      permanent roots, so a peer sending distinct names grows the atom table without
      bound.

- [ ] Honor configurable incoming HTTP header budgets across the codec and Node
      adapter, including growth beyond fixed field-size and field-count ceilings.
      Align `http.maxHeaderSize` (16 KiB) with the codec and answer
      HPE_HEADER_OVERFLOW with 431, as Node does.

- [ ] Give the https socket facade `destroyed`, so a throwing SNICallback reports true
      in `tlsClientError` listeners.

- [ ] Confirm SNI context matching against CVE-2026-48928 once details are published,
      and SQLite 3.53.3 against CVE-2026-69867.

- [ ] Compare persistent Linux epoll interests with the current one-shot registration on
      representative keep-alive HTTP traffic. Preserve cancellation, stale-token and
      fd-reuse safety and avoid idle spin; accept only lower end-to-end CPU or request
      latency with stable throughput and bounded registrations.

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
      cancellation behavior. Stream incoming Mal.serve bodies instead of imposing
      the buffered 16 MiB total-size ceiling, and expose configurable budgets for
      callers that choose buffering.

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

- [ ] Use one frozen UPM archive/install workload with output parity to choose a leading
      filesystem scheduling, decompression scheduling or DNS/Agent reuse cost. Change one
      owner path, preserve backpressure/cancellation, and accept on complete-workload wall
      time, CPU and memory; do not add a V8-style compile cache.

- [ ] Prototype one guarded numeric recurrence for the nonparameter task seed in the
      persistent Tinypool workload. Preserve zero-trip and coercion effects and retain
      boxed fallback; accept on complete task throughput after dispatch, both-host
      compilation and generated-size costs.

- [ ] Replace periodic child-exit polling with a host completion source while preserving
      exit/reap ordering, ref/unref and VM teardown. Keep exec/execFile stream data and
      fork IPC support. Validate Linux teardown and platform event ownership, and compare
      exit latency and idle CPU separately from API correctness.

- [ ] Fail CI when THIRD_PARTY_NOTICES.md is stale against Cargo.lock, the vendored
      sources and the derived-file list, and find license texts for alloc-stdlib and
      blake2b_simd, which publish none and are listed by SPDX expression only.

- [ ] fs: use FSEvents to reduce file-descriptor use for large macOS watch sets, Linux
      recursive-watch symlink entries (Node reports their events and link-target
      changes as 'rename'), fs.openAsBlob, readdir's
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

- [ ] Implement worker_threads locks and navigator.locks with request/query,
      exclusive/shared modes, ifAvailable, steal and signal, using process-wide ownership
      and per-isolate grant delivery. Make markAsUntransferable also prevent ArrayBuffer
      transfer and transferToFixedLength with the required detach error.

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
      reject pooling options. Add ServerResponse.appendHeader. ServerResponse sends
      header names lowercased and lets
      getHeader see headers passed only to writeHead. Stream destroy() emits 'error'
      and 'close' synchronously where Node defers them a tick.

- [ ] Exercise postgres.js logical replication, prepared transactions, negotiated TLS,
      and primary or standby selection against a dedicated topology. Keep
      topology-dependent tests separate from the deterministic local baseline.

# Actors and SMP

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

## Native GUI and freestanding targets

- [ ] Drive a Rust GUI stack from a Maligator application through a C ABI. Validate
      lifecycle, wakeups, callbacks, rendering-loop integration, and shutdown.

- [ ] Build scheduler, reactor, and GC core without libc over a fixed arena. Make
      unsupported dynamic facilities fail explicitly.

- [ ] Add a poll or ISR backend and fixed-size fiber stacks for constrained targets.
      Keep backend selection separate from JavaScript semantics.

- [ ] Define the minimal-core capability profile using existing feature selection and
      source-closure certification. Verify omitted bytecode, Intl, web and host
      personalities are absent from linked output and unsupported features fail
      explicitly; record binary, resident-memory and build costs without requiring a
      runtime speedup.

## Generational GC workers

- [ ] Compare the current native GC scheduling policy with one bounded pacing change on
      native self-compile, app-batch and representative HTTP traffic. Measure total CPU,
      wall time, peak storage and pause distributions from matched finished binaries; keep
      mutator-owned sweep unless a measured end-to-end gain pays for ownership complexity.

- [ ] Validate native worker capacity under live constrained and nested CPU quotas.
      Synthetic v1/v2 mounted-path and visible-ancestor fixtures pass; hidden
      namespace ancestors cannot be inferred. Keep the inline capacity fallback.
- [ ] Attribute peak committed/deferred storage and long minor, root, remark or finalizer
      pauses on matched production workloads, including the current skipped-block slice
      budget. Keep managed survivors, exact liveness and RSS distinct. Bound any change to
      the measured phase or container, preserving tracing and promotion; require lower
      tail latency or retained storage without a material total-CPU/throughput regression.

### Concurrent generational GC experiments

- [ ] Decide whether to retain the existing ephemeron pending index using a representative
      weak-cache workload and a no-weak-entry control, recording scan work, total CPU,
      pause time and bounded index memory. Remove or simplify the optimization if it
      cannot pay; preserve weak-cleanup SATB correctness independently.
