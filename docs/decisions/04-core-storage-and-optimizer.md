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
    -> ExecutionProgram + NativeProgram
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
- instruction codes, owning blocks, and previous/next links;
- operand and result ranges;
- source-position and effect-refinement references;
- value representation and definition;
- use-list records.

One instruction code identifies a registry opcode, a structural terminator or a
deleted row. This lets a reader establish liveness and instruction kind with one
table lookup. Function stores read the registry's append-only name and descriptor
columns after checking the generation and decoding the instruction code. The shared
columns also expose opcodes registered after a store was created.

Hot instruction walks start with a checked block head and follow live kernel links
to avoid iterator allocation and dispatch. Reading the next link after processing
the current instruction preserves the cursor's behavior during edits. A retired
generation rejects both walks.

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

Publishing a call result or initial own-field read advances its normal-result and
specialization-input versions. Passes that read normal-completion kinds, brands or
ranges declare a `normalResults` wake. The program's return-kind worklist observes
the same domain. An effect refinement also wakes that worklist for bodies with
handlers, where it can change the set of reachable returns.

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

Local plan inputs are materialized once for each live function at final selection,
after cross-call cleanup and loop versioning. Function sessions return their changes
and identity so later rewrites keep the same caller set. They do not retain planning
snapshots whose facts can expire before selection. Final construction reads the
current compilation context and analyses; individual instruction proofs retain their
ordinary version checks.

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

Cheap local analyses may recompute for a changed function. The per-definition cache
keeps the first function's result inline. A second function needs the indexed table.
The manager creates the program-flow engine on its first use. Whole-program analysis
requires an explicit program dependency. The manager records queries, hits,
recomputations, invalidations, and elapsed time for every analysis.

Demand-driven products stay within that versioned lifetime. Structural CFG queries
need no dominators; dominance products are computed on the first dominance query.
After a memory-effect edit, the exceptional CFG first checks whether any protected
block gained or lost a throwing exit. Unchanged exits preserve the structural graph
and its derived dominance; handler or handler-argument changes still invalidate it
through the exception-flow version.
Structural snapshots assign compact edge IDs and retain endpoints and operand ranges.
Ordinary and exceptional views share the ordinary IDs, including distinct edges to
the same successor. Consumers use the owning snapshot to read operands from Core.
Instruction dominance uses block and edge dominance when they determine whether a
protected block can bypass its ordinary exit. Queries that need an explicit exit
node build the split graph on demand.
Canonical roots resolve alias cycles from compact input ranges in dependency order.
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

Static-value consumers share proofs of absence for unsupported producer shapes and
slots with neither a direct writer nor a closed-cell proof path. A move, call, or
property read can inherit absence from an operand with its own proof. An incoming
rejection at a join is scoped to the current analysis because an edge edit can
replace that argument. A definition edit retracts the proof along the SSA use
chains, and a direct writer edit retracts the slot proofs for that function.
Positive observations belong to their analysis snapshot and are verified there
before a pass applies them.

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

Edits enqueue only affected local components. When an optional pass runs without
edits, its next wake enters a deferred queue. Active work can then coalesce several
edits before the pass repeats its proof. The component converges once both queues drain.

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

Value-kind flow builds components from the inputs each transfer reads. Call results
flow to callers, arguments flow to callees with known callers, and only a closed
wildcard call reads the aggregate return. These directions can form a cycle even when
the calls themselves do not recurse.

Solve components in dependency order. A dirty component replaces its incoming masks
with the join of current caller values from outside the component and any opaque
entry seed. Its internal arguments and returns start from bottom so old feedback
cannot keep a removed kind alive. A removed call also dirties its former recipients.
After convergence, changed returns wake their readers, and argument recipients compare
their new boundary masks with the saved ones before rebuilding local analyses.
Within a reset, a clean function reuses its previous evaluation when its inputs,
callee returns, wildcard aggregate and record alternatives match. The solver
publishes that evaluation at the same worklist step as a fresh transfer.
Lazy heap-brand queries retain the function's call results and record inputs from
its last evaluation. A reused analysis does not hold the rest of that solve alive.
Appending constants preserves existing references and the heap-brand proofs that use
them. Replacing the data tables invalidates those proofs and the value-kind snapshot.

An unchanged function with no input dependencies can witness a saturated wildcard
aggregate. A valid witness lets the solver use the aggregate directly. When the
witness is lost, wildcard readers and their dependencies converge together again.
Effect summaries project only wildcard calls that can read their aggregate. The
summary transfer prepares call-site metadata and opaque-call escapes once, then
resolves the effects and provenance that depend on other summaries.

Call targets treat each parameter of a closure that some function creates as a
cell. Every visible call writes its argument's targets into the callee's parameter
cells, and a function whose identity is published, or flows through an inlined
constructor result, gets opaque parameters. A closure created and called only by
known sites therefore sees exactly the closures its callers pass. Entry bodies the
runtime creates itself keep opaque parameters.

Code that `engine.eval: true` compiles at run time is one more opaque caller when it
can only run as global code: indirect eval and the function constructors reach the
global object, the values the program hands them and what those reach, which is
what host code can reach. Direct eval retains the caller's lexical bridges, actual
`with` objects and deletable variable records in lookup order. Declarative bridges use
accessors that share caller storage, checking TDZ and immutable writes at access time.
Imported accessors follow exporter storage. Actual `with` records retain their entry's
boxed object and apply unscopables; declarative records give calls an undefined receiver.

A nonoptional bare `eval(...)` uses the selected callee's identity, including local
aliases of intrinsic eval. Semantic analysis and lowering share the admitted call set,
so caller storage and optimizer visibility agree. Callee and receiver are captured
before arguments; ordinary replacements keep that reference. Optional calls, member
calls and sequence callees remain indirect. An immutable local function can avoid the
eval environment only when dynamic lookup and intervening activations cannot intercept it.

The global declarative registry contains lexical bindings only. Global vars and
functions use the object record, so a configurable property created by eval can be
shadowed by a later script's lexical declaration. Restricted global properties still
reject that declaration. Adding a lexical binding invalidates cached object-record
reads, and each realm keeps its own registry.

The embedded compiler module returns its compiler export directly to the VM after
synchronous evaluation. The VM roots that callable and its captured storage. The
handoff uses no application-global property, so global extensibility and properties
cannot intercept it.
Meriyah's cloning dependency is bound lexically to a private helper during baking.
The bake identity includes that helper and the binding recipe, so neither depends
on installing a property on the application global object.

Private syntax state travels as an eval-entry argument, outside name resolution, so
proxies cannot observe bookkeeping keys. Nested eval and escaped closures retain the
ordered records. A function created by eval owns its variable record, and parameter
expressions and bodies use distinct variable environments. Declaration instantiation
and function declarations target the selected variable environment; var initializers
resolve an ordinary reference before evaluating their right-hand side.

The bridge accessors escape through the opaque runtime call, so Core must retain the
reads and writes eval can make. Strict eval keeps its `var`s in its own environment.
Proofs that enumerate readers and writers through Core therefore exclude the
functions, cells, module bindings and private fields some direct eval can see.
Private field facts also need the field's key to stay inside private element
operations; a key passed in the private eval context gives its field unknown values.

An actual `with` environment stores the object produced by ToObject once at entry.
Primitive wrappers retain per-entry writes and remain the receiver for calls and
escaped closures. Failed HasProperty or unscopables probes terminate resolution
before another environment, a value read or an assignment can run.

In a CommonJS module the bindings in scope include the wrapper's `module`,
`exports`, `require`, `__filename` and `__dirname`. The loader creates `module` and
`exports` and keeps them in its registry, so what a module stores on them is
already published to host code. `require` is the loader's intrinsic, which a
computed `require(expression)` reaches too: it rejects a specifier and otherwise
returns some module's published `module.exports`, running its wrapper once through
the registry. A CommonJS wrapper starts sloppy unless its source has a `"use strict"`
directive prologue. Nested functions inherit that strictness or introduce their own
directive. The Node globals prelude preserves the source's directive prologue.

Each class static block owns its variable and top-level function declarations while
retaining lexical early errors within that body. Lexical bindings enter their TDZ
before hoisted functions can capture them. Parser dependency corrections apply before
embedding. JavaScript-dependent cache producers and source bakes include the resolved parser's bytes and
pinned version, so a dependency correction invalidates their artifacts. C-header
models use Clang and the C extraction source cone without resolving the JavaScript
parser. Binding generation retains parser identity because it evaluates JavaScript
contracts.

C declarator suffixes retain their eventual type nodes and link them in reverse
order before returning the parsed type. This avoids separate builder closures or
wrapper objects while preserving optional array bounds and parameter-array identity.

Retaining a source builtin for runtime loading does not add an eager evaluation edge.
Its provider manifest retains the synchronous graph evaluator and initializes native imports
on demand. Discovery uses the same builtin catalog, including prefix-only names.
Provider and worker discovery converge before sealing the owner's inputs, including
lookups introduced by required roots and dynamic import candidates.
Worker declarations follow immutable aliases through the nearest binding. Lexical,
parameter and hoisted variable environments can shadow an imported declaration;
parameter defaults remain outside the function body's variable environment. A bound
`URL` constructor needs the `node:url` export identity before declaring a module URL.
Runtime-owned TypeScript providers use the compiler's canonical type erasure even
when application inputs have already been stripped by their caller.
The loader creates the evaluator in its callee realm and caches the exports in that
realm; dynamic imports reuse the graph's real module namespace.

Independent images share a source builtin's bindings, namespace and instantiation
and evaluation records before relocating instructions. Private bindings share
ownership too: one image can instantiate hoisted functions while another evaluates
the body. These cells are excluded from proofs that require one image to own all
writes. Source builtins therefore retain source despite an external interface and
use the provider table for ownership instead of publishing unevaluated bindings
through ordinary module links.

Optimization admission follows the operations that can observe sloppy semantics.
Mapped parameter aliases, dynamic scope, receiver coercion and legacy activation
reflection need their own proofs. A numeric generator or pure factory whose admitted
body excludes those observations does not require strict mode. Inlining across modes
also excludes stores whose throwing behavior depends on the destination frame and
operations that can expose the removed activation to user code.

The closure certificate keeps source closure for such a program unless a direct eval
may run in sloppy code (it adds `var`s to its caller's variable
environment and hands over a mapped `arguments` with its `callee`), a script
shares its top-level declarations with global code, primordials are mutable, or
realms are enabled. Proofs that enumerate every reader or writer of a local,
captured, module or private binding stay off while run-time code is unconfined.

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

Inlining a rest-forwarding helper snapshots its positional inputs in the caller's
registers. Those explicit sources do not retain the caller's incoming argument span;
the native and wire loaders derive the same retention requirement. Ordinary coroutine
liveness preserves their values across earlier caller suspension. A linear forwarding
helper creates and consumes one fresh state in a single expansion and cannot itself
suspend, so a caller await or yield cannot divide that state's lifetime. State
initialization writes prevent CSE or loop motion from sharing it across invocations.
The same source snapshots support ordinary construction. Mapped arguments keep their
own activation and owning callee, because another caller's snapshots cannot replace
current parameter cells or the fallback object's identity.

Candidate claim headers and exact costs participate in ranking and admission before
target payloads are materialized. Rejected candidates do not receive target blocks,
anchors, representations, or admission payloads. Plan verification rediscovers only
selected source families and still checks every selected recipe and proof. Candidate
recognition itself remains eager within an admitted family; delaying it must not
change profitability ordering or overlap decisions.

The generic semantic path remains in canonical Core and stays valid if the plan is
ignored. Target lowering receives the sealed program and plan, not the analysis
manager, and may not rerun Core analysis or rediscover optimization policy.

Guarded numeric loop versioning runs on changed callers after cross-call rewriting.
A generic call's completion can widen an otherwise numeric recurrence to boxed
arithmetic, even when the call sits behind an inlined fast path. Versioning keeps
that completion in a generic loop copy. A failed guard enters the copy at the
corresponding operation, carrying live SSA values through block parameters. Reads
and calls already completed in the iteration are not repeated. Number checks after
unknown reads and calls keep coercion and string concatenation in the generic copy;
boxing happens on bailout edges. Loop-invariant guards select the version before
the loop. Invariant binding loops retain the native backend's entry guards instead.
The pass bounds copied bodies, numeric checks, and live parameters, and creates at
most one generic loop copy per function.

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
