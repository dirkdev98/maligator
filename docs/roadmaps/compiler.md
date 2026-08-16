# Compiler optimization and static-analysis roadmap

Maligator AOT-compiles optimized IR through generated C. Static call inlining,
scalar replacement, native numeric fusion, guarded property regions, call and
property caches, closed `String.prototype.split` projection, and a narrow
stack-object path are implemented. This roadmap owns the shared static-analysis
architecture and the compiler/runtime optimizations that consume it.

Test262 corpus build throughput and artifact size remain in the
[Test262 performance roadmap](../../test262-perf-todo.md). Eval and Realm semantic
correctness remain in the [eval and realms roadmap](eval-realms.md). That roadmap
defines what those features do; this roadmap defines how their presence constrains
analysis, reachability, and generated code. GC implementation work remains in the
[GC roadmap](gc.md), while escape and allocation elimination stay here.

`bench/baseline.json` is the current committed performance snapshot; Git retains its
history. Keep changing measurements out of this document. Each optimization should
be selected by current attribution rather than by the order in which an idea was
added here.

## Goal: one fact-driven compiler

Maligator should use one optimizing pipeline for development, testing, `run`, and
production builds. Build configuration changes the semantic world presented to that
pipeline, not which optimizer implementation is used. Analyses derive shared facts,
passes consume those facts, and the compiler emits the strongest lowering justified
at each site.

The pipeline must improve both the generated program and compilation throughput.
When a proof makes guards, generic twins, helper bodies, or materialization paths
unreachable, remove them in Maligator IR before emitting C instead of relying on the
downstream C compiler to rediscover the proof.

The knowledge levels are cumulative capabilities, not separate backends:

| Knowledge level    | Available guarantee                                                                                | Primary generated form and beneficiaries                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Universal          | Ordinary JavaScript semantics; identities and mutations may be dynamic                             | Generic operations plus local inlining, escape analysis, scalar replacement, shape/value propagation, and DCE valid for all code                  |
| Epoch-guarded      | A cached identity, shape, or semantic condition remains valid for a recorded epoch                 | One entry/region guard, unchecked cache or known-slot hit paths inside the region, and a generic twin for invalidation                            |
| Proof-specialized  | Local call, consumer, effect, escape, or representation facts establish a narrower operation       | Known-builtin calls, split/capture projection, native numeric regions, allocation sinking, and materialization only at proven escape boundaries   |
| Locked whole world | Primordial authority is locked and the compiler knows every source and host entry that can execute | No primordial lookup or epoch guards, direct lowering, cross-call fusion, whole-program inlining and DCE, and removal of unreachable generic code |

A locked build with runtime eval is authority-closed but not source-closed: primordial
facts remain invariant, while reachability and DCE become conservative only at the
scopes eval can observe. A mutable build can still reach the proof-specialized level
through local facts and guarded generic twins.

## Semantic world contract

Add `engine.primordials: "locked" | "mutable"` to `maligator.build.ts`, defaulting
to `"locked"`. Test262 and other compatibility work that intentionally mutates
intrinsics must select `"mutable"` explicitly. The selected policy is identical in
development, tests, `run`, and production; commands must not silently substitute a
different semantic profile.

`"locked"` is deliberately stronger and clearer than ordinary `Object.freeze`
semantics:

- Statically detected attempts to mutate a protected primordial emit a source-aware
  warning. Compilation continues because the path may be conditional or unreachable.
- The runtime is authoritative. An executed mutation attempt throws `TypeError`
  consistently, including in sloppy code.
- The protection covers intrinsic-bearing global bindings, namespace objects,
  constructors, prototypes, well-known intrinsic objects, their protected properties,
  and their prototype links. The inventory must be generated or validated from one
  descriptor source rather than maintained as scattered allowlists.
- Assignment, deletion, definition/redefinition, prototype changes, and reflective
  mutation APIs must pass through the same policy. No optimized path may depend on a
  mutation route that the runtime does not reject.
- Eval-created code inherits the current world's policy. Every Realm has distinct
  objects and identities but initializes the same locked or mutable primordial policy;
  creating a Realm is not an escape hatch from the lock.
- Locking primordials does not freeze ordinary user objects. It removes the authority
  to change the language/runtime identities on which static lowering depends.

Keep two closure facts distinct:

- **Authority closure** means all code that can execute, including runtime eval and
  Realm code, is subject to the same host capabilities and primordial policy.
- **Source closure** means the compiler knows all source and externally reachable
  entry points that can execute. Runtime eval, unresolved loading, or open host
  callbacks can remove source closure without removing authority closure.

When eval is enabled, direct eval invalidates lexical reachability and value facts
only in environments it can observe; indirect eval affects the global environment;
Function-family constructors cannot observe caller locals. Locked primordial facts
remain invariant in all three cases. When eval is disabled, its absence should feed
whole-program reachability and DCE rather than exist only as a runtime feature flag.

## Shared fact architecture

Design the fact system before adding more emitter-level recognizers. A fact must carry
its payload, scope, validity, dependencies, and fallback/materialization obligation.
Passes should ask for facts through shared APIs rather than inspect
`engine.primordials`, epochs, or syntax independently.

The initial fact families are:

- **World facts:** primordial policy, authority and source closure, eval/Realm
  capabilities, module-graph closure, host entry points, reflection boundaries, and
  externally observable exports.
- **Identity facts:** stable builtin, function, Realm, property, and shape identities.
  Semantic builtin identity is shared across Realms while exact object identity also
  carries the Realm.
- **Effect facts:** global/prototype reads and writes, coercion and property access,
  calls into user code, allocation, escape, throw, suspension, safepoints, unknown
  calls, and eval visibility.
- **Value and representation facts:** primitive/value class, numeric range, shape,
  field class, string form, ownership, identity observation, scalar state, and
  materialization requirements.
- **Reachability facts:** callable target sets, source/host roots, reflection and eval
  visibility, retained function identity, and whether an object or helper body remains
  observable.

Validity is orthogonal to the payload. A fact can be unconditional for a scope,
dependent on a semantic epoch, established by a local guard, or unavailable. The
same optimization should therefore accept an unconditional fact in a locked world,
an epoch-backed fact in a mutable world, or decline with a stable reason code.

### Phase 0: fact-system design

- [x] Define the fact representation, scopes, dependency identities, invalidation
      rules, and merge behavior at control-flow and call boundaries. Do not embed
      fallback C snippets in facts; represent the proof and let lowering select the
      implementation.
- [x] Create one declarative builtin/primordial descriptor registry containing owner,
      key, semantic identity, receiver/arity rules, evaluation and coercion ordering,
      effects, result facts, Realm behavior, and available lowerings. Generate the
      compiler/runtime identity plumbing from it.
- [x] Introduce a canonical known-call/builtin-call IR representation so Math, String,
      RegExp, JSON, and collection intrinsics do not depend on independent syntax
      recognizers in the C emitter.
- [x] Compute function and module effect/reachability summaries to a fixed point.
      Cache summaries by source identity, compiler version, and relevant world facts;
      changing unrelated build features should not invalidate them.
- [x] Preserve fact and source-site identity through inlining and IR cloning, or
      deliberately re-run the affected analyses. Joins must expose which input lost a
      proof.
- [x] Make resolved build configuration seed world facts once. Optimization passes
      must consume those facts rather than branch directly on configuration fields.
- [x] Give every applied transform and declined opportunity a stable reason code,
      including unknown target set, invalidatable epoch, escaping result, observable
      identity, unsupported consumer, representation mismatch, eval visibility, and
      open-world reachability.

## Implementation phases

### Phase 1: locked-world enforcement

Establish the semantic contract before removing guards or fallbacks.

- [x] Add the default-locked configuration, public types, schema validation, cache
      derivation, generated build flags, and explicit mutable Test262 configuration.
- [x] Generate or validate the complete protected primordial graph from the shared
      descriptor source, including per-Realm initialization and intrinsic-bearing
      global bindings.
- [x] Route every ordinary and reflective mutation path through one runtime policy.
      Cover strict and sloppy assignment, deletion, property definition, prototype
      mutation, eval-created code, and cross-Realm access with focused regressions.
- [x] Add source-aware warnings for statically visible locked-primordial mutation.
      The warning and runtime error should identify the affected binding/object and
      property when available.
- [x] Prove that mutable builds retain existing ECMAScript behavior and that command
      selection cannot change the configured policy.

### Phase 2: facts without new specialization

Land the shared representation and diagnostics before using it to justify new fast
paths.

- [x] Represent current semantic protector/epoch state, known builtin identities,
      shapes, escape results, and immutable binding targets as shared facts while
      preserving generated behavior.
- [x] Extend the source-aware residual object and partial-escape inline reports into
      structured optimization remarks for every allocation, call, property, and
      boxing site.
- [x] Report substitution-stage reasons for calls that eligibility analysis labels
      inlinable but lowering retains, including inner closures, exception regions,
      relocation, expansion limits, escape-cost barriers, and unavailable world
      facts.
- [x] Record pass-by-pass IR deltas for allocation sites, dynamic calls, boxed
      operations, property helpers, world guards, and safepoints. Add bounded
      optimization ablations so benchmark deltas can be assigned to transforms.
- [x] Validate summary caching and invalidation across primordial policy, eval/Realm
      policy, modules, hosts, and source changes before using cached summaries for
      code removal.

### Phase 3: unify the epoch-guarded implementation

Make the current mutable fast paths consumers of facts, then let locked builds prove
the same facts unconditionally.

- [x] Express `mal_primitive_method_protector`, watched-method epochs, property/cache
      identities, and array-element protectors as named fact dependencies rather than
      emitter-local conditions.
  - [x] Make guarded Array/String/Map/Set calls consume one canonical builtin-identity
        fact through lowering, frontend-cache serialization, and C emission.
  - [x] Make the bounded cardinality-array region combine builtin identity,
        primitive-method, and array-element facts with explicit fallback and
        materialization obligations.
  - [x] Make inherited stack-object loads consume the primitive-method fact and
        retain heap materialization as their generic twin.
  - [x] Let locked primitive-String `charCodeAt` fusions remove the watched-method
        property probe while retaining the ordinary Get+Call twin for local misses.
  - [x] Make String split projections and cursors consume the canonical
        `String.prototype.split` identity fact instead of matching only syntax.
  - [x] Let locked String split projections and cursors fuse the adjacent property
        Get into their generic twin and call identity-free runtime helpers; keep
        receiver, separator, coercion, and materialization guards local.
  - [x] Give the split cursor's `trim` consumer its own canonical builtin fact and
        let locked regions remove the per-element property probe and callback check.
  - [x] Give the projected slice-to-Number consumer a canonical `slice` fact and let
        locked fusions move the adjacent property Get into their generic twin.
  - [x] Lower primitive-method, watched-method, and array-element dependencies
        through one native admission/revalidation bridge. Make inherited stack
        objects, cardinality regions, and split cursors consume their named guards;
        locked-world dependencies collapse before emission, while mutable regions
        retain the generic twin and one combined semantic-activity snapshot.
  - [x] Thread the program-level Watched-methods fact into every compiled function
        variant. Mutable local property/cache probes acquire their epoch through the
        shared admission bridge, locked builds snapshot it without a protector
        condition, and definitions without the fact disable the optional fast path.
  - [x] Retain the three runtime-backed protector facts as program metadata through
        MALW v42 so analyses that intentionally rebuild after frontend-cache loading
        consume the same world/epoch proof. Migrate affine-range virtualization to
        the Array-elements fact and erase its semantic guard in locked builds.
  - [x] License closed finite global tables with the Array-elements fact and explicit
        generic-operation/materialization obligations through IR, lowering, and
        MALW. Mutable builds use the shared admission bridge; locked builds erase
        the raw protector condition while retaining local deopt materialization.
- [ ] Version hot regions once and replace repeated protector checks, epoch reads,
      cache probes, and static-key comparisons with unchecked operations inside the
      region.
  - [x] Give split cursors one combined split/trim region license. Mutable builds
        validate the trim cache and callback once, use unchecked span trimming in
        stable regions, and revalidate the combined named dependencies through one
        semantic-activity snapshot after a potentially invalidating loop operation.
- [x] Retain a generic twin when invalidation or a local guard can fail. Define the
      shared fallback/materialization contract before adding loaded-field numeric
      layouts or more speculative object representations.
- [ ] In locked builds, turn primordial dependencies into world invariants and remove
      dead entry guards, fallback edges, property loads, callback identity checks, and
      helper bodies in IR before C emission.
- [ ] Keep mutable performance neutral or better. A locked-world optimization must not
      be implemented by slowing the generic or epoch-guarded path.
  - [x] Pair the Phase 3 emitter convergence against pre-convergence checkpoint
        `8e8172b0` over five interleaved String and prototype-cache samples. The
        classified metrics contain no regressions: String and the stable inherited
        post-mutation metric are unchanged; noisier prototype submetrics remain
        inconclusive rather than being recorded as wins.

### Phase 4: reference consumers and partial specialization

Use a small set of semantically different consumers to validate that the fact system
is general rather than a registry-shaped collection of special cases.

- [x] Migrate closed `String.prototype.split` projection and cursor lowering to the
      known-call/effect/representation facts. Preserve its generic fallback for
      mutable or unsupported consumers and erase it when facts make it unreachable.
  - [x] Publish registry effects, result semantics, and supported lowerings beside
        canonical builtin identity facts. Require the split projection/cursor
        consumers to license `projected-elements` or `split-cursor-spans`
        representations from those facts and retain their whole-region/on-demand
        generic twin contracts.
  - [x] Add a backend-neutral no-dynamic-dispatch builtin-call operation. Use an
        exact primitive String receiver plus the locked split identity to remove
        the property Get and generic call in IR, preserve full split semantics in
        native code and MALW v40, and leave projection/cursor-shaped result uses for
        their stronger retained-twin representation pass.
  - [x] Let exact primitive locked split calls enter projected-result selection
        after dynamic dispatch has already been erased in IR. Keep the virtual
        projection's local materialization fallback as a direct exact builtin call,
        so compiled code never reconstructs the property Get or generic dispatch
        and interpreted code shares the same direct-call operation.
  - [x] Select closed constant-index split projections in IR from the canonical call
        facts and the result's complete move/use set. Carry the representation,
        region license, retained twin, materialization contract, and exact consumer
        instructions through VM lowering; retain VM recognition only to rebuild
        compile-only metadata after a frontend-wire cache round trip.
  - [x] Select the closed indexed split-to-trim cursor in IR after final dead-code
        cleanup. Prove dominance, single-entry/single-run control flow, complete
        result/index/element use sets, and a combined split/trim license before
        register allocation; carry exact operations through lowering and retain VM
        recognition only for frontend-wire compatibility. Let an exact locked
        primitive split use direct builtin cursor initialization and fallback.
- [x] Lower statically known Math calls through builtin-call IR. Preserve argument
      evaluation, coercion, exceptions, and Realm identity; use native numeric
      arguments/results when representation facts allow it.
  - [x] Publish canonical facts for the currently supported unary Math operations
        and two-argument `min`/`max`, preserve them through the frontend wire format,
        and make locked exact-arity numeric calls native in both register allocation
        and C emission. Mutable calls retain exact-callback guards and generic
        fallback.
  - [x] Remove the now-dead Math namespace load, property Get, and generic call twin
        in IR when the locked identity and numeric lowering proofs make them
        unreachable.
    - [x] Carry exclusive namespace/property producer identities from canonical IR
          analysis through lowering so the native backend can first prove and erase
          an exact no-fallback numeric call without changing the generic path.
    - [x] Promote the proven operation to unary/binary numeric Math IR and VM
          instructions, erase the generic twin before either backend, and preserve
          the direct operation through MALW v39 for interpreted execution. Mutable,
          boxed, and otherwise unsupported calls retain the complete generic twin.
- [x] Lower locked exact `Object.hasOwn` namespace calls through the same
      backend-neutral builtin-call IR. Erase the `Object` property Get and callback
      identity seam while preserving argument evaluation, object/key coercion,
      Proxy internal methods, exceptions, and the mutable generic call.
- [x] Add closed `RegExp.prototype.exec` capture projection as the first stateful and
      effect-sensitive projection. Preserve `lastIndex`, capture, coercion, and
      unmatched-value semantics with materialization on unsupported consumers.
  - [x] Publish canonical `RegExp.prototype.exec` identity, effect, result, and
        capture-projection facts through IR and the frontend wire format. License
        the existing whole-region projection from those facts while retaining the
        ordinary call and result materialization as its mutable/guard-miss twin.
  - [x] Prove an exact unaliased RegExp literal from its intrinsic construction,
        dominance, and complete use set. In locked native code, erase its `exec`
        property Get, callback/Realm checks, and generic call twin while keeping
        input coercion, `lastIndex`, throws, and capture materialization in the
        projected helper. Mutable and interpreted code retain the ordinary twin.
- [ ] Specialize higher-order intrinsics when callback identity and iteration
      semantics are stable, prioritizing measured `reduce`, `forEach`, `map`, and
      `sort` boundaries. Use these to validate user-callback effect summaries and
      native-loop fusion.
  - [x] Publish canonical identity/effect/result facts for the 12 implemented Array
        callback-loop substitutions and preserve them on their slow-path calls and
        through the frontend wire format. Make the region guard validate the method
        value captured by the original property Get, not re-read the property after
        argument effects; retain exact receiver, Realm, and species checks.
  - [x] In locked builds, prove an exact fresh Array from its allocation, numeric
        element initialization, dominance, and complete use set. Erase its method
        Get, eligibility helper, callback fallback allocation, and generic call twin
        directly in IR; mutable, dynamic, aliased, and argument-exposed receivers
        retain the loaded-callee guard and ordinary fallback.
    - [x] Publish exact fresh-Array length and indexed coverage as a reusable
          function-scoped fact instead of a callback-inliner boolean. Closed loops
          use the snapshotted exact length without a property Get and omit hole
          checks only for complete coverage when the callback cannot observe the
          receiver; sparse arrays and receiver-observing callbacks retain the
          semantic check.
    - [x] Carry stable complete indexed-access certificates through IR, VM lowering,
          MALW, and native emission. Closed loops read the dense vector without
          repeating Array-brand, index, bounds, or hole checks; a failed dense
          allocation retains the ordinary property operation as its table-backed
          representation fallback.
    - [x] Lower a locked one-shot `freshArray.push(...)` through the shared exact
          fresh-Array fact into backend-neutral builtin-call IR. Erase the method
          Get and callback identity check, support arbitrary arity in MALW and both
          backends, and retain the complete builtin algorithm when the ordinary
          dense representation cannot append directly.
  - [x] License capture-free numeric `reduce` regions with the canonical reduce,
        unary-Math, primitive-method, and array-element facts through IR, MALW, and
        native emission. Mutable builds admit the combined epochs once; locked builds
        erase that semantic guard, retain only local dense/type fallback, and accept
        the complete registered unary numeric Math surface without a runtime identity
        table or helper body.
    - [x] Compose the locked fresh-Array proof with numeric fusion instead of making
          the two specializations exclusive. Mark the inlined accumulator
          initialization as the durable region certificate: guarded builds attempt
          fusion at their existing entry guard and retain the ordinary call twin;
          closed builds enter on that post-construction marker, erase method dispatch,
          and identify the proven allocation explicitly. Either form retains the
          inlined loop as the numeric layout/type fallback.

#### Allocation and representation consumers

- [ ] Generalize the implemented hot-loop partial-return inline barrier into an
      allocation-aware inlining cost model that compares the caller clone with the
      standalone callee rather than relying on one partial-escape pattern.
- [ ] Replace function-wide cycle rejection for partial escape with site-local
      lifetime and control-flow proof. Prefer path-sensitive scalar replacement and
      allocation sinking on rare escape edges over constructing a stack object when
      identity is otherwise unobserved.
- [ ] Preserve escape and scalar facts through every cloned IR path or re-run the
      analyses after inlining. Extend the source-aware residual report beyond object
      sites so retained unused helper bodies cannot obscure transformed hot clones.
- [ ] Extend native closed fixed-shape stack objects to further proven local classes.
      Calls, stores, captures, suspension, and dynamic-shape operations remain heap
      escapes until a narrower effect proof handles them soundly.
- [ ] Materialize only on a guarded fallback for local fixed-shape objects whose sole
      blocker is an inherited watched data-property read. Measure the repeated
      `toString` observations in the stack-object lane before accepting the added
      guard and fallback.

#### Shape and value consumers

- [ ] Propagate literal and constructor shape provenance through local arrays, phi
      joins, and bounded call results. Use it to version hot loops once and replace
      repeated region guards, static-key comparisons, and cache probes with direct
      known-slot access.
- [ ] Infer and bulk-construct the result shape of object rest/spread normalization
      when source shapes and excluded keys are bounded. Avoid building every
      normalized application record through the empty-object path while retaining a
      generic fallback for dynamic sources.
- [ ] Propagate stable field value classes through proven shapes and stores. Keep
      numeric values unboxed across property arithmetic only behind a sound validity
      and fallback/materialization contract.

### Phase 5: whole-program analysis and output reduction

- [ ] Generalize the module benchmark's TDZ-aware single-assignment callee resolution
      to proven immutable imports, single-assignment `let` bindings, stable closure
      fields, constructor-derived methods, and bounded call-result target sets.
- [ ] Build the closed-program call/effect/reachability graph from modules, host entry
      points, exports, reflection, eval capabilities, and Realm creation. Explain each
      retained open edge in optimization remarks.
- [ ] Lower local throw/catch regions to ordinary control flow only when effect and
      exception analysis proves the value, handler, and completion ordering cannot
      be observed outside the region. Use the split control-flow phase to establish
      whether this is preferable to extending exception-aware inlining first.
- [ ] Propagate identity, shape, value, escape, and representation summaries across
      calls. Use them for whole-program inlining, native pipeline fusion, allocation
      sinking, and representation selection.
- [ ] Remove retained helper bodies and function objects only when eval, identity,
      reflection, exports, host roots, and reachability facts prove their absence is
      unobservable.
- [ ] Add a generated-code cost model that weights helper calls, guards, boxing, root
      slots, safepoints, code duplication, and downstream compile cost by profile
      counts or proven loop frequency. Use it for inlining, region formation, and
      specialization decisions.
- [ ] Generate compiler/runtime opcode and builtin plumbing from the shared descriptor
      lists so adding an identity or lowering cannot leave the two sides inconsistent.

## Permanent measurement foundation

- [ ] Split the language lane into loops, objects, arrays, allocation, intrinsics,
      control flow, and application phase metrics while retaining its aggregate
      checksum and wall-time regression signal.
- [x] Extend workload-only aggregate allocation, call-cache, and property-cache
      counters to stable source sites, boxing fallbacks, world/region guards, and
      safepoints. Keep all runtime storage and increments behind the build-time
      `MAL_PERF_STATS` gate and collect them only in separately instrumented binaries.
- [ ] Report cold process time separately from steady-state kernel time. Interleave
      paired Maligator and Node runs, retain sample dispersion, and record the host,
      toolchain, build flags, primordial/eval policy, and runtime configuration used
      by each baseline.
- [ ] Track frontend, analysis, IR optimization, C emission, downstream C compilation,
      link time, generated C size, binary size, and peak build memory. A smaller or
      faster program should not silently make the compiler impractical.
- [ ] Emit source-derived C symbols and `#line` mappings, with an optional annotated
      disassembly report that relates source, facts, optimized IR, generated C, and
      machine code.

## Acceptance policy

Each optimization needs a focused semantic regression, the relevant allocation or
dispatch signal, and a repeated wall-time comparison. Keep the curated Test262
regressions and `npm run test:check` green. Prefer root-cause transforms over
fixture-specific patterns, and do not accept a faster median that materially worsens
allocation, tail latency, generated size, compilation time, or correctness without
recording the tradeoff.

World-sensitive work also needs:

- locked and mutable coverage with identical command behavior;
- strict, sloppy, reflective, eval-created, and cross-Realm mutation coverage;
- proof that mutable invalidation reaches the generic twin safely;
- proof from IR/generated output that locked-world guards and unreachable fallbacks
  were removed rather than merely predicted to be cheap; and
- representative controls showing that specialization does not regress code that
  lacks the required facts.

## Triggered work

- Measure region allocation and drop-insertion free lists only after broader stack
  allocation lands; the current allocation-to-wall-time result strengthens the
  requirement for an attributed wall-time win before adding either.
- Revisit loaded-field numeric layout changes after shared fallback/materialization
  machinery exists and direct-slot specialization establishes the remaining cost.
- Revisit array-literal scalar replacement and full no-iterator `for-of` only with a
  benchmark not covered by existing iterator-protocol optimizations.
