# Core storage and optimizer

- Status: accepted
- Scope: canonical Core storage, mutation, analysis, optimization scheduling,
  specialization planning, target consumption, and compiler-work measurement
- Historical reference: `81cc4d33928630573e10633fa87ed090ac64630b`

## Context

Core is the canonical optimizing SSA boundary between semantic construction and
allocated execution state. The existing outer boundaries remain appropriate:

```text
SemanticProgram
    -> mutable CoreProgram
    -> optimizeCore(program, context)
    -> seal
    -> CoreCompilation {
         program: SealedCoreProgram,
         plan: CoreOptimizationPlan,
         context: CoreCompilationContext
       }
    -> ExecutionProgram
    -> ProgramImage
```

The historical implementation represents functions as readonly aggregate object
graphs. Transforms clone blocks, instructions, inputs, outputs, values, facts, and
regions, then replace whole functions and increment one `mutationEpoch`. Analyses
are cached by object identity and explicitly inherited across replacements. A large
optimizer drives nested fixed-point rounds, and target lowering can still consult
Core analyses or rediscover policy.

That model makes a local edit allocate and invalidate far beyond the semantic change.
It also obscures whether work is caused by Core optimization or by lowering Core into
execution state. The replacement is an in-place hard cutover to stable identities,
program-owned mutable storage, precise invalidation, and worklist scheduling.

## Decision

### Identity and ownership

`CoreProgram` is the only owner of mutable Core storage during construction and
optimization. It owns program data and a monotonic function table. Each function row
owns its function-local tables; blocks and instructions are identities into those
tables, not nested object graphs.

Core function IDs are stable for the lifetime of the program. Removing a function
leaves a tombstone, and reachability never compacts, reorders, or renumbers Core
functions. Each function independently allocates monotonic block, instruction, value,
and fact IDs. A deleted local entity also leaves a tombstone, and no ID is reused.

Stable Core identities are distinct from dense target indexes. Lowering creates an
explicit `CoreFunctionId` to execution-function index mapping for the live functions
selected for emission. Every cross-function reference entering execution state uses
that mapping.

### Table layout

High-volume fields use dense numeric tables indexed by stable function-local IDs.
These include:

- block liveness and linked instruction-list heads and tails;
- instruction liveness, numeric opcode, owning block, and previous/next links;
- operand and result ranges;
- source-position and effect-refinement references;
- value representation and definition;
- use-list records.

Opcode IDs are owned by the existing opcode descriptor registry. Names remain
descriptor and debugging data rather than hot-path identities.

Operand and use records are append-only during mutation. Replacing a range may
abandon the old range until sealing, but it never shifts unrelated records. Deletion
marks table rows as tombstones. Rare instruction attributes, facts, proof data, and
region or candidate payloads live out of line and are referenced by stable IDs. A
rare payload may be a readonly object; it is not nested into a newly cloned
instruction graph after every transformation.

### Mutation and versions

`CoreEditor` is the sole mutation API. Store tables expose read-only readers and
cursors outside an active editor. There can be only one active edit session for a
function, and sealing permanently rejects new sessions.

An editor maintains definitions, uses, instruction order, block ownership, and CFG
references as it applies insertions, removals, replacements, operand changes, block
creation, edge redirection, and representation changes. Committing one session
returns one precise `CoreChangeSet`. The commit advances each affected version domain
once, regardless of the number of edits in the session, and does not advance an
unaffected domain.

Function version domains are at least:

- body and SSA;
- CFG;
- exception flow;
- calls;
- memory and effects;
- facts;
- representations;
- specialization-plan inputs.

Program version domains separately describe changes to the function set and
reachability, call graph, program data and constant tables, published summaries, and
specialization-plan inputs. A `CoreChangeSet` identifies the changed functions,
blocks, instructions, values, facts, edges, calls, and exact version domains. An edit
to one function leaves every version of unrelated functions unchanged.

### Sealed boundary

Sealing ends Core construction and optimization and returns a read-only
`SealedCoreProgram` over the same owned storage. It may build dense live-iteration
indexes and finalize abandoned append-only ranges, but it does not copy or
reconstruct the whole graph and does not renumber stable IDs.

`CoreCompilation` contains that sealed program, the immutable selected
`CoreOptimizationPlan`, and the compilation context. Target lowering cannot receive a
mutable program.

### Analysis management

`CoreAnalysisManager` caches an analysis by:

```text
(analysis key, scope kind, scope ID, required version tuple, context identity)
```

Scopes are function, SCC, or program. Each analysis declares the exact version
domains and context inputs on which its result depends. An unchanged tuple reuses the
result automatically; a changed tuple recomputes only that scope. Correctness never
depends on JavaScript object identity, and there are no `WeakMap<CoreFunction, ...>`
caches or manual `inheritControlFlow`, `inheritSummaries`, or equivalent preservation
APIs.

Cheap local analyses may recompute for a changed function. Whole-program analysis
requires an explicit program dependency. The manager records queries, hits,
recomputations, invalidations, and elapsed time for every analysis.

### Pass scheduling

`CorePassManager` owns traversal and work queues. A pass declares its scope as
instruction, block, function, SCC, or program, together with required analyses,
change kinds that wake it, analyses it preserves, the version domains it may change,
and a compiler-work budget with an explicit exhaustion policy.

Edits enqueue only affected instructions, users, blocks, functions, SCC members, or
program consumers. Queue exhaustion defines convergence. There are no global
optimization rounds, `maxRounds`, generic `dependsOnProgram`, or pass-private
whole-program fixed-point loops. Optional transforms stop conservatively when their
budgets are exhausted; sound analyses converge or widen to a documented conservative
result.

Per-pass verification consumes `CoreChangeSet` and checks the changed local and
cross-function contracts. Full verification remains unconditional at the major Core
boundaries.

### Interprocedural solving

The call graph uses stable function and call-instruction IDs with explicit outgoing
and reverse-caller indexes. Local summary facts are collected once for each changed
function. The graph is condensed into strongly connected components, and summaries
are solved with component and member worklists.

A function publishes a new summary version only when its semantic summary changes.
Only affected callers, SCC members, and registered consumers are then woken. An
unchanged summary does not propagate work, and an edit cannot cause every function to
be revisited merely because the program changed.

### Late specialization

Ordinary canonical CFG and SSA optimization completes before specialization
selection. Discovery produces immutable candidates that reference stable Core IDs and
carry their proof obligations, generic fallback, generated-code cost, and
compiler-work cost. Discovery does not select regions or freeze CFG changes.

One deterministic bounded planner deduplicates candidates, resolves overlap and
conflicts, applies per-site, per-function, and program budgets, and records structured
reasons for declined candidates. The resulting `CoreOptimizationPlan` is separate
from canonical Core, is verified against the sealed program and its versions, and is
the only specialization policy consumed by target lowering.

The generic semantic path remains in canonical Core and stays valid if the plan is
ignored. Target lowering receives the sealed program and plan, not the analysis
manager, and may not rerun Core analysis or rediscover optimization policy.

### Permanent measurements

Compiler phase measurement uses these non-overlapping fields:

| Field                | Measures                                             |
| -------------------- | ---------------------------------------------------- |
| `constructCoreMs`    | Semantic program to mutable canonical Core           |
| `optimizeCoreMs`     | Core analysis, transformation, planning, and sealing |
| `coreToExecutionMs`  | Sealed Core and plan to allocated `ExecutionProgram` |
| `executionToImageMs` | Execution state to `ProgramImage`                    |
| `emitMs`             | Rendering runtime/native output                      |
| `writeMs`            | Writing the requested compiler output                |

The ephemeral `CoreOptimizationReport` records:

- input and output function, block, instruction, value, fact, and plan-candidate
  counts;
- elapsed time per optimizer stage;
- runs, work items examined, changed items, edits, and elapsed time per pass;
- queries, hits, recomputations, invalidations, and elapsed time per analysis;
- queue pushes, pops, and maximum depths;
- SCC counts, transfers, and caller wakeups;
- candidates discovered, selected, and declined by kind and reason;
- compiler-work and generated-code budget consumption.

The report is available to compiler callbacks, profile output, the frontend cache
result, and concise complete `--verbose` output. It is not serialized into
`ProgramImage` or compiler artifacts unless a distinct explicit profile-report
format is requested.

### Hard cutover and broken window

This replacement does not introduce `Core2`, `LegacyCore`, old/new modes, conversion
adapters, compatibility wrappers, feature flags, or dual optimizer paths. The
existing Core names become the new contracts immediately. Internal cache and artifact
identities are invalidated when their producers change; old readers are not retained.

The cutover deliberately permits a broken repository between the representation
replacement and consumer migration:

1. Replacing Core storage removes the old aggregate types before frontend, optimizer,
   verifier, and target consumers compile.
2. Semantic construction and verification migrate directly to the store while the
   optimizer and target remain disconnected.
3. End-to-end compilation returns with the final optimizer entrypoint and an empty
   registered optimization pipeline.
4. Local, control-flow, proof, memory, interprocedural, inlining, and specialization
   capabilities then return as worklist-based passes and analyses.
5. Diagnostics and all normal repository gates are restored only after every active
   old consumer has been removed.

Intermediate failures in that window are recorded by subsystem. They are not hidden
by changing VM/runtime semantics, weakening verification, adding fixture-specific
behavior, preserving the old graph, or teaching tests to accept missing behavior.

## Historical performance reference

The hard-cutover reference is commit
`81cc4d33928630573e10633fa87ed090ac64630b`, whose committed
`bench/baseline.json` has schema 3. The closed-world self-compile entry records five
runs, 11 generated units, Darwin arm64, and Node v26.7.0.

| Measurement         | Maligator (ms) |    Node (ms) |
| ------------------- | -------------: | -----------: |
| Wall                |  421745.646917 | 56373.195333 |
| Graph               |            769 |          191 |
| Semantic            |           1761 |          241 |
| Lower semantic      |          19842 |         3585 |
| Optimize            |         380515 |        48495 |
| Register allocation |              0 |            0 |
| Lower               |           4455 |          998 |
| Emit                |          12886 |         1919 |
| Write               |            693 |          792 |

Both runs generated 79,151,552 code units. The historical `optimizeMs` field combines
Core optimization and Core-to-execution lowering. Those components cannot be
recovered from this baseline and must not be presented as if they were separately
measured; the new phase schema starts with the replacement pipeline.

## Consequences

Stable identities and tombstones trade some transient storage for precise mutation,
cache reuse, diagnostics, and target mappings. Append-only ranges can retain dead
space until sealing, so reports and later profiling must expose abandoned-range and
tombstone traversal costs rather than hiding them.

Passes and analyses become smaller modules with declared scope and invalidation
contracts. The migration is intentionally disruptive, but the completed architecture
has one canonical Core, one optimizer scheduler, one late specialization plan, and no
target-side policy discovery.
