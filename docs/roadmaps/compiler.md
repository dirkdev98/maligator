# Compiler optimization and static-analysis roadmap

Maligator AOT-compiles optimized IR through generated C. Static call inlining,
scalar replacement, native numeric fusion, call and property caches, closed
`String.prototype.split` projection, and a narrow stack-object path are
implemented. This roadmap owns the shared static-analysis architecture and the
compiler/runtime optimizations that consume it.

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

## Core SSA hard cut-over

Core SSA is the only optimizing middle end. Production builds, development builds,
the test harness, Test262, frontend-cache misses, and frontend-cache hits all run the
same verified Core pipeline. Internal formats have no compatibility contract: a
schema change increments its wire identity and stale artifacts rebuild.

Optimization ownership is strict:

- Core instructions and terminators have stable function-local identities, explicit
  block arguments, effect descriptors, representations, and proof-backed facts.
- A speculative multi-instruction optimization is selected as one atomic Core region.
  Its certificate names Core values, instructions, blocks, dependencies, fallback or
  materialization obligations, and the complete claimed instruction set.
- Register allocation and VM lowering may validate and consume a certificate, but
  may not rediscover it from instruction order, source positions, register reuse,
  adjacency, or a second CFG/dataflow analysis.
- Native emission consumes validated target metadata only. It does not mutate the VM
  definition or infer new optimization regions.
- There are no legacy readers, adapters, dual formats, or best-effort compatibility
  paths. A failed proof retains the ordinary JavaScript-semantic twin.

The current Core-native optimization set includes direct-call proofs, small-function
inlining, exact builtin dispatch, primitive folding, TDZ cleanup, copy/value
numbering, dead-instruction elimination, stack objects, numeric binary fusion,
RegExp capture and iterator projections, String split projection/cursors,
slice-to-Number fusion, and bounded `charCodeAt` reads.

The following performance families are deliberately deferred until they have
Core-owned analyses and certificates: exact dense Array loops, closed record Arrays,
closed global tables, affine-range virtualization, finite-string/property domains,
finite-key construction, numeric Array HOF plans, recursive numeric representation,
private aggregate memoization, inlined String scan summaries, String-search/RegExp
fusion, and invariant JSON parse/map templates. These remain roadmap items until a
Core-owned pass can prove them. The retired region schemas, wire payloads,
runtime-only helpers, and implementation-specific tests are deleted; none may return
as backend pattern matching or a compatibility path.

## Semantic world contract

`engine.primordials: "locked" | "mutable"` defaults to `"locked"`. Test262 and
other compatibility work that intentionally mutates intrinsics must select
`"mutable"` explicitly. The selected policy is identical in development, tests,
`run`, and production; commands must not silently substitute a different semantic
profile.

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

Facts carry their payload, scope, validity, dependencies, and
fallback/materialization obligation. Passes ask for facts through shared APIs rather
than inspect `engine.primordials`, epochs, or syntax independently.

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

## Implementation phases

### Phase 3: unify the epoch-guarded implementation

Make the current mutable fast paths consumers of facts, then let locked builds prove
the same facts unconditionally.

- [ ] Version hot regions once and replace repeated protector checks, epoch reads,
      cache probes, and static-key comparisons with unchecked operations inside the
      region.
- [ ] In locked builds, turn primordial dependencies into world invariants and remove
      dead entry guards, fallback edges, property loads, callback identity checks, and
      helper bodies in IR before C emission.
- [ ] Keep mutable performance neutral or better. A locked-world optimization must not
      be implemented by slowing the generic or epoch-guarded path.

### Phase 4: reference consumers and partial specialization

Use a small set of semantically different consumers to validate that the fact system
is general rather than a registry-shaped collection of special cases.

- [ ] Specialize higher-order intrinsics when callback identity and iteration
      semantics are stable, prioritizing measured `reduce`, `forEach`, `map`, and
      `sort` boundaries. Use these to validate user-callback effect summaries and
      native-loop fusion.

#### Allocation and representation consumers

- [ ] Preserve escape and scalar facts through every cloned IR path or re-run the
      analyses after inlining. Extend the source-aware residual report beyond object
      sites so retained unused helper bodies cannot obscure transformed hot clones.
- [ ] Extend native closed fixed-shape stack objects to further proven local classes.
      Calls, stores, captures, suspension, and dynamic-shape operations remain heap
      escapes until a narrower effect proof handles them soundly.

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
      be observed outside the region.
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
  allocation lands.
- Revisit loaded-field numeric layout changes after direct-slot specialization
  establishes the remaining cost.
- Revisit array-literal scalar replacement and full no-iterator `for-of` only with a
  benchmark not covered by existing iterator-protocol optimizations.
