# Core storage and optimizer

- Scope: canonical Core storage, mutation, analysis, optimization scheduling,
  specialization planning, target consumption, and compiler-work measurement

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

Stable identities, program-owned mutable storage, precise invalidation, and
worklist scheduling keep local edits from allocating or invalidating unrelated
functions. Separate phase measurements distinguish optimization from lowering
Core into execution state.

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
- normal-result kinds and integer bounds;
- representations;
- specialization-plan inputs.

Program version domains separately describe changes to the function set and
reachability, call graph, program data and constant tables, published summaries, and
specialization-plan inputs. A `CoreChangeSet` identifies the changed functions,
blocks, instructions, values, facts, edges, calls, and exact version domains. An edit
to one function leaves every version of unrelated functions unchanged.

Publishing a call result or initial own-field read changes its normal-result facts
and specialization inputs without replacing the instruction's operands or effect
proof. The `normalResults` domain wakes local kind/range consumers and the program's
return-kind worklist. CFG, call targets, effects, provenance and memory versions
remain reusable. Ordinary fact edits, including effect-only proofs, do not dirty
the return-kind worklist.

Own-slot candidate hints change only specialization inputs. They preserve operand
storage, effect proofs and structural analyses while invalidating specialization
admission and its lazy details. A hint can select guarded lowering; it cannot refine
the access's effects or change its normal-result contract.

The local fact bundle projects separately versioned structural indexes and allocation
provenance. Result-fact or specialization-input changes refresh value consumers
without rebuilding those projections. Representation changes invalidate provenance
but retain the index; body, CFG and effect changes invalidate both, and program data
changes invalidate provenance. Counters record actual provenance construction rather
than using bundle refreshes as a proxy.

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

Demand-driven products stay within that versioned lifetime. Structural CFG queries
need no dominators; dominance products are computed on the first dominance query.
After a memory-effect edit, the exceptional CFG first checks whether any protected
block gained or lost a throwing exit. Unchanged exits preserve the structural graph
and its derived dominance; handler or handler-argument changes still invalidate it
through the exception-flow version.
Packed-rest consumers request value kinds and CFG only after finding a relevant
access. A memory-version handle initially builds no graph. Its first proof query
indexes raw memory accesses and writers; each requested partition then builds its
own events and versions. Exact global, local, captured, and activation slots need
no heap provenance. Heap partitions inspect accesses sharing the allocation's
canonical root and its initializer. A shared family-kill column retains store
checkpoints for every location with reads, including locations queried later.

Allocation layouts and escape proofs are cached per allocation. Layout and shape
candidate queries do not request escape proofs; an exact own-cell query does. Bulk
layout enumeration remains explicit. Representation-only edits preserve layout
and escape queries, but invalidate representation-dependent weak-hold queries.
The shared instruction, allocation-root, and use indexes still scan their snapshot
when needed. Requested partitions still cover all their reads and control flow.
Each partition is finalized once, including phi aliases and family-kill state at
both reads and reaching stores. Later queries cannot change an earlier answer.
Memory queries reject stale function or program-data versions before using either
cached results or lazy dependencies.

Repeated-load consumers first match opcode, operands, attributes, representation,
and dominance. Only then do they request complete memory equivalence. Candidate
read states are indexed after this first demand so intervening stores do not turn
proof lookup into a quadratic scan. Requested partitions retain complete reader
sets; this is not yet per-read slicing.
Instrumentation records preparation and solve deltas as work happens. Analysis
handle creation is not a memory solve, and retaining old graphs for final reporting
is unnecessary.

### Pass scheduling

Each `CoreFunctionOptimizationSession` owns a function-only pass scheduler, local
optimizer queues, analysis manager, feature-index views, and bounded shared scratch.
A function pass declares its required analyses, change kinds that wake it, version
domains it may change, and a compiler-work budget with an explicit exhaustion policy.
The pass contract has no scope discriminator and the scheduler cannot enqueue work
for another function.

Edits enqueue only affected local components. Queue exhaustion defines convergence.
There are no stage-major function sweeps, global optimization rounds, `maxRounds`,
generic `dependsOnProgram`, or pass-private whole-program fixed-point loops. Program
flow and cross-call selection remain explicit whole-program owners outside the
function scheduler. Optional transforms stop conservatively when their budgets are
exhausted; sound analyses converge or widen to a documented conservative result.

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

Call targets treat each parameter of a closure that some function creates as a
cell. Every visible call writes its argument's targets into the callee's parameter
cells, and a function whose identity is published, or flows through an inlined
constructor result, gets opaque parameters. A closure created and called only by
known sites therefore sees exactly the closures its callers pass. Entry bodies the
runtime creates itself keep opaque parameters.

A property read keeps finite targets only as guarded candidates: the functions a
known function object's property or a same-function object literal's initializer
put in that slot, joined with opaque. Dispatch guards the loaded callee's function
index and keeps the generic fallback.

Effect-domain unions use bounded bit masks and interned immutable domain lists.
Joins reuse an input summary when it already covers the result, and reuse the top
summary only after both memory dimensions and every independent flag reach top.

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

Full-mode program budgets for cross-call transforms and late specialization grow
linearly with reachable live instructions, measured after local optimization and
before cross-call expansion. Programs up to 32,768 instructions retain the baseline
allowance. Larger programs receive the same allowance per 32,768 instructions; code
introduced by expansion cannot increase it. Per-site and per-function limits remain
fixed, and development-mode budgets remain fixed. Discovery is admitted before
expensive proofs and charged even when no usable candidate is found.

Discovery and candidate selection use caller round-robin order while preserving
priority within each caller. Global, per-caller, and per-site budgets still bound
work. The `priority-scheduling` benchmark ablation restores global priority order
for matched policy comparisons.

Cross-call inline candidates rank estimated dispatch savings, minus added guards,
times capped loop frequency, divided by generated-code growth. Known exact and
guarded targets compete in the same priority class; method hints remain lower
priority. The estimate credits one eliminated dispatch, even for finite target
sets, because the callee body still executes. Array predicates credit one callback
dispatch after accounting for eligibility checks, without assuming an array length.
Scoring uses the already-demanded CFG and candidate costs; it does not request
additional proofs. Compiler-work costs remain hard admission limits. This is a
static scheduling estimate, not a measured runtime benefit or a semantic proof.

A helper that repeats a callback, by calling it in a loop or forwarding it to a
function that does, is cloned once for each distinct set of exact closures its
call sites pass. Each clone is created at those sites, so its parameters become
exact and its callback calls direct or inlined. Clones run before inline discovery,
in up to three rounds so a forwarding helper's clone exposes its callee; each round
reconsiders every candidate under its share of a budget the size of the cross-call
one, at most 16 variants per helper, and ranks clones that complete such a chain
first. Every clone counts equally under static scheduling, so reducing the budget
can discard useful forwarding chains.

Candidate claim headers and exact costs participate in ranking and admission before
target payloads are materialized. Rejected candidates do not receive target blocks,
anchors, representations, or admission payloads. Plan verification rediscovers only
selected source families and still checks every selected recipe and proof. Candidate
recognition itself remains eager within an admitted family; delaying it must not
change profitability ordering or overlap decisions.

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

### Internal format changes

Storage and schema changes migrate producers and consumers together. Invalidate
internal cache and artifact identities rather than retaining parallel optimizer
representations, conversion adapters, or compatibility readers.

## Consequences

Stable identities and tombstones trade some transient storage for precise mutation,
cache reuse, diagnostics, and target mappings. Append-only ranges can retain dead
space until sealing, so reports and later profiling must expose abandoned-range and
tombstone traversal costs rather than hiding them.

Passes and analyses declare their scope and invalidation contracts. Canonical Core
and its selected specialization plan keep optimization policy above target lowering.
