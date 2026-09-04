# Core local optimizer migration matrix

- Status: accepted migration checkpoint
- Scope: ownership of the pass names registered before the fused sparse scheduler
- Predecessor: [Core storage and optimizer](./04-core-storage-and-optimizer.md)

## Decision

The fused scheduler replaces pass-by-IR scheduling without carrying its registry
structure forward. Each of the 48 currently registered names has one final owner in
the matrix below. The five `post-*` entries are aliases of canonical rules; relevant
edits dirty the canonical rule instead of creating another pass identity.

`deleted as redundant` is an owner, not a staging state. Dead-code removal belongs to
the optimizer edit loop, fact normalization belongs to the editor, and empty-fact
cleanup belongs to fact mutation. No entry is temporary or legacy.

| Registered name                                  | Current registry                     | Final owner               | Migration note                                                                         |
| ------------------------------------------------ | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| `annotate-terminal-yield-sites`                  | `CORE_LOCAL_CANONICALIZATION_PASSES` | late recipe matcher       | Match the complete generator terminal-yield recipe after local convergence.            |
| `fold-static-property-keys`                      | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from dynamic property loads and stores.                                       |
| `rewrite-exact-builtin-calls`                    | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from calls dirtied by fact or value-kind changes.                             |
| `local-constant-folding`                         | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from foldable unary, binary, and typeof operations.                           |
| `typeof-comparison-canonicalization`             | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from binary comparisons.                                                      |
| `primitive-coercion-folding`                     | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from primitive coercions.                                                     |
| `numeric-algebraic-simplification`               | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from numeric binary operations.                                               |
| `local-copy-propagation`                         | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from moves and wake their users immediately.                                  |
| `local-control-folding`                          | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Revisit only blocks whose terminator inputs changed.                                   |
| `local-value-numbering`                          | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Maintain block-local expression state.                                                 |
| `local-dead-instruction-elimination`             | `CORE_LOCAL_CANONICALIZATION_PASSES` | deleted as redundant      | Integrated dead-code elimination owns newly dead instructions.                         |
| `canonical-block-parameter-elimination`          | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Revisit blocks with changed incoming values or parameters.                             |
| `block-parameter-simplification`                 | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Revisit blocks with changed incoming edges.                                            |
| `forwarding-block-elimination`                   | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Match forwarding blocks from dirty CFG neighborhoods.                                  |
| `linear-block-merging`                           | `CORE_LOCAL_CANONICALIZATION_PASSES` | local block rule          | Match single-predecessor linear block pairs.                                           |
| `unreachable-block-removal`                      | `CORE_LOCAL_CANONICALIZATION_PASSES` | function CFG transform    | Remove blocks after reachability-changing CFG edits.                                   |
| `value-kind-observation-folding`                 | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from observations dirtied by value-kind changes.                              |
| `local-explicit-throw-lowering`                  | `CORE_LOCAL_CANONICALIZATION_PASSES` | function CFG transform    | Rewrite exceptional flow as one function CFG operation.                                |
| `redundant-tdz-check-folding`                    | `CORE_LOCAL_CANONICALIZATION_PASSES` | local opcode rule         | Dispatch from TDZ checks dirtied by facts or kinds.                                    |
| `post-representation-exact-builtin-calls`        | `CORE_LOCAL_FINALIZATION_PASSES`     | deleted as redundant      | Alias of `rewrite-exact-builtin-calls`; representation edits dirty the canonical rule. |
| `post-representation-primitive-coercion-folding` | `CORE_LOCAL_FINALIZATION_PASSES`     | deleted as redundant      | Alias of `primitive-coercion-folding`; representation edits dirty the canonical rule.  |
| `post-representation-dead-instruction-removal`   | `CORE_LOCAL_FINALIZATION_PASSES`     | deleted as redundant      | Alias of integrated dead-code elimination.                                             |
| `post-memory-tdz-check-folding`                  | `CORE_LOCAL_FINALIZATION_PASSES`     | deleted as redundant      | Alias of `redundant-tdz-check-folding`; memory edits dirty the canonical rule.         |
| `post-memory-unreachable-block-removal`          | `CORE_LOCAL_FINALIZATION_PASSES`     | deleted as redundant      | Alias of `unreachable-block-removal`; CFG edits dirty the canonical transform.         |
| `canonicalize-fact-claims`                       | `CORE_PROOF_PASSES`                  | deleted as redundant      | CoreEditor normalizes fact claims when facts change.                                   |
| `empty-fact-elimination`                         | `CORE_PROOF_PASSES`                  | deleted as redundant      | Fact mutation removes empty unreferenced facts immediately.                            |
| `primitive-effect-refinement`                    | `CORE_PROOF_PASSES`                  | local opcode rule         | Dispatch from primitive-effect operations.                                             |
| `rewire-subsumed-effect-proofs`                  | `CORE_PROOF_PASSES`                  | function CFG transform    | Rewire proof availability across the function CFG.                                     |
| `fold-subsumed-guards`                           | `CORE_PROOF_PASSES`                  | local block rule          | Revisit guard terminators when available facts change.                                 |
| `local-scalar-representation-selection`          | `CORE_PROOF_PASSES`                  | local opcode rule         | Select representations from producer and consumer constraints.                         |
| `flow-scalar-representation-selection`           | `CORE_PROOF_PASSES`                  | function CFG transform    | Reconcile scalar representations across CFG edges.                                     |
| `natural-loop-canonicalization`                  | `CORE_CONTROL_FLOW_PASSES`           | function loop transform   | Canonicalize natural-loop structure once per affected function.                        |
| `loop-invariant-code-motion`                     | `CORE_CONTROL_FLOW_PASSES`           | function loop transform   | Hoist across loop structure under provenance proofs.                                   |
| `dominance-redundancy-elimination`               | `CORE_CONTROL_FLOW_PASSES`           | function CFG transform    | Eliminate expressions using dominance across the function CFG.                         |
| `partial-redundancy-elimination`                 | `CORE_CONTROL_FLOW_PASSES`           | function CFG transform    | Insert and eliminate expressions across CFG paths.                                     |
| `loop-scalar-representation-selection`           | `CORE_CONTROL_FLOW_PASSES`           | function loop transform   | Select scalar loop-carried representations.                                            |
| `path-range-control-folding`                     | `CORE_CONTROL_FLOW_PASSES`           | function loop transform   | Consume loop path ranges to fold control.                                              |
| `path-range-strength-reduction`                  | `CORE_CONTROL_FLOW_PASSES`           | function loop transform   | Consume loop path ranges to reduce bounded operations.                                 |
| `fold-exact-allocation-observations`             | `CORE_MEMORY_PASSES`                 | local opcode rule         | Dispatch from exact allocation observations.                                           |
| `forward-fresh-own-slot-prefix`                  | `CORE_MEMORY_PASSES`                 | function memory transform | Forward the proven fresh-object slot prefix.                                           |
| `annotate-known-own-slots`                       | `CORE_MEMORY_PASSES`                 | local opcode rule         | Dispatch from property operations with shape provenance.                               |
| `refine-contained-own-slot-accesses`             | `CORE_MEMORY_PASSES`                 | local opcode rule         | Dispatch from contained-object property operations.                                    |
| `forward-exact-memory-loads`                     | `CORE_MEMORY_PASSES`                 | function memory transform | Forward loads through function memory versions.                                        |
| `refine-exact-typed-array-accesses`              | `CORE_MEMORY_PASSES`                 | local opcode rule         | Dispatch from typed-array operations with exact allocation proofs.                     |
| `rewrite-contained-fresh-array-builtins`         | `CORE_MEMORY_PASSES`                 | function memory transform | Rewrite builtins using function containment proofs.                                    |
| `refine-exact-collection-accesses`               | `CORE_MEMORY_PASSES`                 | local opcode rule         | Dispatch from exact collection accesses.                                               |
| `refine-stack-object-cell-representations`       | `CORE_MEMORY_PASSES`                 | function memory transform | Reconcile stack-object cell representations.                                           |
| `scalarize-rooted-contained-objects`             | `CORE_MEMORY_PASSES`                 | function memory transform | Scalarize rooted objects with CFG and escape proofs.                                   |
| `scalar-replace-contained-aggregates`            | `CORE_MEMORY_PASSES`                 | function memory transform | Replace aggregates using function memory versions.                                     |

## Scheduler boundary

The migration keeps only opcode rules and block rules inside `CoreLocalOptimizer`.
Function CFG, loop, and memory owners run from the phase manager and may dirty local
work. Program-flow, cross-call, and late-recipe owners remain outside local queues.
Deleted entries have no scheduler identity.
