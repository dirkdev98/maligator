# Compiler fact-flow audit

This audit describes the optimizing pipeline at `faa28d41` and ranks gaps by
semantic reach, measured opportunity in the fully closed self-compile workload,
and implementation leverage. It distinguishes facts used to rewrite Core from
facts that are only attached late enough for target lowering or diagnostics.

## Pipeline

1. Semantic analysis establishes world policy, closure, builtin authority,
   immutable bindings, feature availability, and frontend source facts.
2. Core construction turns the semantic graph into SSA functions, explicit
   ordinary and exceptional control flow, memory operations, baseline effects,
   representations, and proof-carrying facts.
3. Normalization resolves bounded callee targets, performs cost-bounded direct
   and guarded inlining, and annotates residual singleton calls.
4. The local fixed point runs constant/control-flow simplification,
   representation refinement, fact subsumption, local exception lowering,
   property-key and contained-cell refinement, memory SSA optimizations,
   allocation optimization, loop optimization, value numbering, PRE, and DCE.
5. The program fixed point solves transitive function summaries and narrows call
   effects. A changed summary reopens the local fixed point.
6. Finalization refreshes direct calls and reachability, compacts functions,
   narrows call-result and scalar representations, selects builtin/aggregate
   regions, and finally publishes exact heap-class, value-kind, and shape facts.
7. Target lowering validates Core certificates, allocates registers, consumes
   explicit direct-entry/slot/class/kind/region metadata, and produces the common
   execution program used by the VM and native backend.
8. Wire, C, and profile emission consume the execution program. Core summaries
   remain compilation-local; site facts and decisions are projected into profile
   metadata when requested.

The ownership boundary is sound: Core decides multi-instruction transforms and
the target consumes explicit decisions. The main loss is timing. Several strong
whole-program analyses run after the local fixed point and cannot expose more
constant folding, memory forwarding, LICM, PRE, or DCE.

## Fact inventory and utilization

| Fact or analysis | Collected precision | Current consumers | Missing or late use |
| --- | --- | --- | --- |
| World, closure, epochs, builtins, immutable bindings | Explicit authority and fallback obligations | builtin recognition, guarded regions, reachability, stable cells | Shared dependencies are not a general dominance-scoped path-fact lattice; most local facts are re-derived separately |
| Callee targets | Bounded finite script set plus `anyScript` and opaque bits through SSA, cells, aggregates, and returns | inlining, singleton direct calls, callback targets, reachability, summaries | A finite residual multi-target call that cannot be inlined has no polymorphic direct-dispatch output |
| Function summaries | Transitive effects, call graph, escape, containment, return provenance, return representation | call effect/result refinement, provenance, value-kind/class/shape flow, diagnostics | Return facts carry alias class and representation, but not primitive identity/range or allocation/result determinism |
| Core proof claims | Identity, shape, numeric range, and effect implication vocabulary | fact normalization, dominance-aware guard subsumption, effect refinements | Production facts currently emit effect claims only; identity/shape/range claims have no optimizing producer-consumer loop |
| Value kinds | All ECMAScript kinds plus exact Int32, across SSA, stable cells, calls, and returns | scalar materialization, typed direct arguments, selected binary lowering | Generic `typeof`, strict equality, truthiness/nullish reasoning, coercion effects, and the local fixed point do not consume the result |
| Value classes | Exact heap brands and contained Map/Set receivers across calls and stable cells | typed-array accesses and exact collection builtin calls | Runs after local optimization; exact brands cannot refine effects, aliases, property paths, or dead work earlier |
| Shape provenance | Finite shaped-object origins, opacity, exact shared slots, loop placement | exact/guarded own-slot target selection and clustered loads | Runs last; the local memory and property passes cannot use cross-call/stable-cell shape closure, and acyclic stores remain generic |
| Local allocation provenance | Exact fresh layouts, own cells, escape, weak observability | property effect refinement, memory SSA, forwarding, dead stores/allocations, sinking, stack/aggregate regions | Strong within one activation; cross-call precision depends on summary substitution and does not describe heap objects returned freshly by callees |
| Memory versions | Exact local/captured/global/contained cells plus imprecise domain kills | forwarding and value numbering; indirectly DSE/LICM/PRE | Shape/class facts selected later cannot sharpen its alias partition; summary domains remain coarser than exact cells |
| Loop induction | Canonical additive `f64` recurrence, comparison, safe-integer interval, trip upper bound | bounded `charCodeAt`, comparison folding, `%` strength reduction | No `i32` recurrence, general range propagation, bounds/check elimination, derived induction, or target loop metadata |
| Exception flow | Explicit throw with nonthrowing prefix and an exclusive immediate handler | local throw-to-jump conversion | Does not use general nonthrowing effect regions to remove vacuous handlers or expose catch/finally facts |
| Region validity and generated-code cost | Epoch transparency, guard placement, duplication/materialization cost | every final region selector and inliner/PRE admission | Estimates are not related to final C/binary size; correct but not a source of new semantic facts |
| Site facts and compiler remarks | Shape, escape, representation, builtin and binding facts keyed to source sites | profile metadata and final lowering remarks | Most Core proof provenance, summary facts, fact declines, and emitted native path choices are not related in one final report |

## Measured closed-world opportunity

`node scripts/inspect-self-compile-core.ts --full --summary` on the audited tree
reported 21.84 s in Core optimization, 1,480 call sites with exact scalar
arguments, 320 exact scalar parameters, and only 310 binary sites carrying exact
kind masks. Shape analysis found 778 property sites with closed origins; 167 were
exact slots and 661 received guarded own-slot output. Exact heap analysis found
137 typed-array accesses and 330 exact collection receivers. The analysis itself
visited 1.54 million shape nodes, so new consumers must reuse solves and avoid
adding whole-program rounds casually.

## Ranked implementation slices

The first six changes deliberately consume an existing fact or add only the
minimum precision required by an immediate consumer.

1. **Primitive-kind semantic folding.** Reuse the whole-program kind lattice in
   the program fixed point to fold `typeof`, `typeofCompare`, disjoint strict
   equality, and values whose truthiness is fixed without invoking coercion.
2. **Primitive-operator effect refinement.** Turn exact operand kinds into
   proof-carrying effect refinements before memory optimization, so primitive
   unary/binary operations stop acting as universal host barriers.
3. **Redundant coercion and check removal.** Consume exact non-nullish and
   property-key kinds to remove `requireCoercible` and `toPropertyKey` work while
   preserving Symbol, BigInt, negative zero, and user-code semantics.
4. **Reusable numeric ranges.** Generalize constant and induction intervals into
   one range analysis, include `i32` values, and consume it for comparison/check
   folding and representation-safe strength reduction.
5. **Earlier exact heap/shape consequences.** Publish cross-call exact class and
   shape consequences before the last local cleanup, refine eligible property
   effects/locations, then rerun only the passes that can profit.
6. **Residual finite-target dispatch.** Preserve a bounded closed callee set when
   bodies cannot be inlined and lower it as cost-capped checked direct entries
   with one generic semantic twin.

The next tier is richer return identity/range summaries, broader exception-region
reasoning, derived-induction and bounds facts, final C/disassembly attribution,
and feedback-calibrated generated-code cost. They stay out of the first six until
the retained slices demonstrate benefit.
