Write this file to ./core_opt3_todo.md and finish all stated slices

Core speed and output completion
Goal

Complete the Core refactor by making the current architecture materially faster than the approximately 22-second Node-hosted self-compile while also proving that it emits faster, reasonably sized native programs.

The final result must satisfy all three goals:

Compiler speed: advanced optimizations do not create nonlinear compile-time growth.
Compiler memory: temporary Core and analysis state do not require multi-gigabyte RSS.
Output quality: optimization work produces measurable runtime, generated-code, native-build or binary-size value.

This plan supersedes earlier unfinished Core performance plans. Preserve older plans and acceptance reports as historical records, but treat this file as authoritative for remaining work.

Measured starting point

The accepted Slice 0 measurement at `cfb13ff301bc38c1f327c881e50d592d8a282505` is:

Metric	Starting value
Warm Node self-compile median	22,349.685 ms
Cold Node self-compile median	23,385.125 ms
Warm optimizeCore median	14,731.747 ms
Warm constructCore median	2,911.483 ms
Input functions	3,622
Input blocks	135,139
Input instructions	426,905
Input values	1,677,769
Output blocks	73,965
Output instructions	256,291
Output values	178,581
Selected recipes	185
Generated translation units	9
Generated code units	63,272,125
Peak managed heap	2,533,673,992 bytes
Peak RSS	3,639,558,144 bytes

The accepted compiler capture constructed 1,677,769 values and sealed 178,581 live
output values: a 9.395× construction amplification. Keep that ratio visible beside
the raw counts in every replacement baseline. It is a primary Slice 1 target,
because lowering spare capacity without reducing the number of values constructed
would leave the dominant excess intact.

The clean Slice 1 compiler capture at `6dbf1c32` constructed 492,494 values and
sealed 176,991 live output values: a 2.783× construction amplification. The five-run
warm median is 17,728.224 ms, or 79.3% of Slice 0, and the warm construction median
is 1,757.240 ms, or 60.4%. It materialized 237,961 block parameters, 16.6% of the
Slice 0 construction count, and emitted 315,977 edge arguments without copying any
definition snapshot entries. Generated code is 99.57% of Slice 0. The remaining
Slice 1 failure is peak RSS: the five-run warm median is 3,381,886,976 bytes, or
92.9% of Slice 0, above the required 85%. The canonical capture is
`bench/core-opt3-slice1.json`; do not mark Slice 1 complete until the RSS and output
runtime gates also pass.

The clean Slice 2 compiler capture at `3d65a293` constructed 494,690 values and
sealed 178,559 live output values: a 2.770× construction amplification. Its five-run
warm median is 16,494.304 ms, or 73.8% of Slice 0, and warm `optimizeCore` is
10,215.804 ms, or 69.3%. The dense barrier takes 299 ms, or 1.81% of warm wall time,
and leaves every live store at exactly its live capacity with zero abandoned operand,
parameter, edge and handler storage. Generated code is 100.28% of Slice 0 and warm
and cold output digests and observable checksums agree. The remaining Slice 2 failure
is memory: warm peak managed heap is 2,561,361,432 bytes, or 101.1% of Slice 0, and
warm peak RSS is 3,316,121,600 bytes, or 91.1%. The canonical repeated capture is
`bench/core-opt3-slice2.json`; the function-major lifetime work in Slice 3 must address
these failed memory gates before Slice 2 can be marked complete.

The completed Slice 3 checkpoint at `db65f06e` constructed 495,788 values and sealed
179,007 live output values: a 2.769× construction amplification. Its five-run warm
off median is 14,580.115 ms, or 65.24% of Slice 0, and warm `optimizeCore` is
8,614.247 ms, or 58.47%. The five warm off samples have a 1,061,365,944-byte
peak-managed-heap median, or 41.89% of Slice 0, and a 2,252,161,024-byte peak RSS,
or 61.88%. The full sample recorded 62,271 analysis recomputations, 40.53% below
Slice 0. Combined control-flow-bundle and canonical-root analysis time is 525 ms,
10.96% of the corresponding 4,790 ms Slice 0 analyses. Generated code is 100.86%
of Slice 0. All warm, cold, counter, phase and profile samples agree on their
generated-output digest and observable checksum; repeated lower-tier checks show no
regression, and JavaScript, HTTP and Maligator-hosted self-compile output gates pass.
The canonical compiler capture is `bench/core-opt3-slice3.json`; Slice 3 is complete.

Preserve the completed architecture

Do not reimplement or replace these accepted components without direct profile evidence that they are a current hotspot:

the scalar CoreFunctionKernel;
intrusive, immediately unlinked use lists;
symbolic wildcard call handling;
the unified CoreProgramFlowEngine;
sparse memory state;
compact specialization recipes;
batched cross-call waves;
numeric candidate and scheduling identities;
target lowering from verified plans;
the existing complexity ladder.

Do not introduce Core4, a compatibility representation, an old/new optimizer mode or another full optimizer path.

Non-negotiable rules
Finish every slice and every completion gate.
A replacement abstraction beside an active old path does not count.
Delete or disconnect the replaced production path in the same slice that installs its replacement.
Keep the repository working at every slice boundary.
Do not obtain compile-time wins by:
disabling advanced optimizations;
changing full mode into a reduced optimization mode;
silently lowering existing optimization budgets;
skipping verification;
omitting reachable code;
changing runtime semantics;
weakening tests.
Benchmark-only ablations are allowed and required where specified. They must not become permanent public optimizer modes.
Preserve semantic checksums. Generated-code digests may change only when the output change is intentional and measured.
Use paired repeated measurements. Do not accept one favorable sample.
Commit frequently. Prefer one unsigned commit per coherent architectural migration or measured optimization.
Do not push unless separately instructed.
After every slice:
run focused tests;
run npm run type-check;
run npm run lint:ci;
run git diff --check;
leave a clean working tree;
report every measurement and failed gate exactly.
Full canonical Test262, test:full and test:full:report remain approval-only.
test:check and self-host commands must be allowed to finish. Do not treat an arbitrary five-minute fuse as successful evidence.
Slice 0 — Freeze the current compiler and output baseline
Goal

Create a trustworthy starting point that measures compiler time, compiler memory, generated-output size, native build cost and emitted-program performance.

Required measurement modes

Replace the current:

off
counters
full

with:

off
phases
counters
full
off
No optimizer counters.
No pass or analysis ledgers.
No use-traversal instrumentation.
No live-count scans solely for reporting.
Return a shared or cheaply constructed empty report.
phases

Collect only coarse timers and boundary counts:

pre-optimization verification
construction cleanup
initial local optimization
structural CFG optimization
proof and representation optimization
memory and provenance optimization
late local cleanup
program flow
cross-call transforms
specialization discovery
specialization selection
plan verification
final Core verification
sealing

It must not update counters inside instruction, value, use, CFG-edge, transfer or candidate loops.

counters

Collect aggregate work counts, but not per-pass or per-analysis timings.

full

Collect complete pass, analysis, allocation and diagnostic ledgers. No overhead target applies to this mode.

Required Core checkpoints

Record live and capacity counts at:

after Core construction
after initial local/structural optimization
before memory and provenance
before program flow
after cross-call transforms
before sealing
after sealing

At every checkpoint record:

functions
blocks: live and capacity
instructions: live and capacity
values: live and capacity
uses: live and capacity
operands: live range usage and capacity
block parameters: live range usage and capacity
terminator edges and arguments
facts
effect refinements
abandoned storage
Required compiler baselines

At one clean HEAD and source digest, capture:

Node-hosted self-compile
5 warm off samples;
3 cold off samples;
5 warm phases samples;
1 counters sample;
1 full sample with CPU and allocation profiles.
Maligator-hosted self-compile
3 warm off samples;
1 cold off sample;
1 phases sample;
output digest parity with the Node-hosted compile.
Complexity ladder

Run every existing synthetic and real tier through full Node self-compile. Retain normalized metrics for 1×, 3× and 10× synthetic cases.

Required output baseline

Run the complete production benchmark matrix:

JavaScript:
  Node
  closed compiled
  open compiled
  closed interpreted
  open interpreted

HTTP:
  bare server
  Express routes
  Express JSON
  Express form

Self-compile:
  Node-hosted
  Maligator-hosted

In addition to existing runtime metrics, record:

generated C code units
translation-unit count
total generated C bytes
object-file bytes
final binary bytes
C compilation time
link time
peak native-build RSS
runtime wall and phase times
runtime allocation
runtime GC collections and pause
runtime RSS
Required artifacts

Create:

bench/core-opt3-start.json
bench/core-opt3-output-start.json

Do not update bench/baseline.json.

Completion gates
All samples use a clean tree and identical source/configuration digests.
All corresponding outputs have matching observable checksums.
phases median overhead is at most 1% over off.
counters overhead is at most 8% over off.
The Node baseline has five warm and three cold samples.
The Maligator-hosted result is recorded rather than inferred.
The output baseline includes all JavaScript and HTTP lanes.
The complete test:check command is run to completion and its duration is recorded.
No optimization implementation changes are made in this slice except measurement-overhead fixes.
Suggested commits
bench(core): add low-overhead optimizer phase mode
bench(core): record Core capacity checkpoints
bench(native): attribute compile link size and RSS
bench(core): capture opt3 compiler baseline
bench(core): capture opt3 output baseline
Slice 1 — Finish pruned SSA construction
Goal

Stop materializing block parameters and SSA values that are immediately proved trivial by initial canonicalization.

Required construction model

Replace materialized unresolved block-entry values with virtual incomplete phis.

For every logical variable or local slot:

A read first checks the block’s local definition.
A read in an unsealed block creates an incomplete virtual phi token.
The token is not yet a CoreValueId and does not allocate a block parameter.
Once all ordinary and exceptional predecessors are known, resolve the incoming definitions.
Recursively follow equivalent virtual-phi aliases.
When all non-self incoming values are equivalent, replace the token with that value.
Materialize one block parameter only when distinct incoming definitions remain.
Add edge arguments only for materialized block parameters.

Use union-find, parent links or an equivalent numeric alias structure for trivial-phi elimination. Do not repeatedly chase object graphs or recursively copy environments.

Eliminate full environment snapshots

Remove control-flow snapshots equivalent to:

new Map(state.definitions)

Use one of:

persistent parent-linked environments
predecessor state plus sparse overrides
versioned numeric definition tables
copy-on-write pages

The chosen implementation must make edge creation proportional to the definitions actually demanded at the target, not the number of currently defined variables.

Required semantic cases

The construction algorithm must correctly support:

forward branches;
loops and irreducible cycles;
ordinary and exceptional predecessors;
catch parameters;
nested try/catch/finally;
async functions;
generators and async generators;
per-iteration environments;
mapped and unmapped arguments;
captured variables;
direct eval;
runtime-created functions;
source-position and inline-frame metadata.

Conservative handling may materialize a demanded phi. It may not fall back to transporting the complete environment.

Required deletion

Remove the active construction machinery based on:

copied ValueEnvironment definition maps
parameterVariables backward propagation
post-hoc predecessor environment expansion
one block parameter per unresolved read before trivial-phi resolution

Do not retain it as a fallback for loops, exceptions or eval.

Required instrumentation

Report:

virtual phis created
virtual phis collapsed
materialized block parameters
edge arguments emitted
definition snapshot entries copied
construction alias resolutions
maximum unresolved-phi depth

definition snapshot entries copied must be zero in the final production path.

Tests

Add focused tests for:

diamond with one unchanged variable;
diamond with one genuinely differing variable;
loop-carried variable;
trivial self-referential loop phi;
mutually dependent incomplete phis;
exception handler with demanded and undemanded values;
nested finally paths;
async/generator suspension;
direct eval;
captured per-iteration binding;
large environment with one demanded value.

The large-environment test must prove that increasing unrelated live variables by 10× does not increase emitted block parameters or edge arguments.

Completion gates

Relative to Slice 0:

constructed Core values are at most 45% of the Slice 0 count;
constructed Core values are no more than 750,000 on self-compile;
materialized block parameters are at most 50% of Slice 0;
initial structural/canonicalization edits are at most 60% of Slice 0;
constructCore is at most 80% of Slice 0;
warm Node self-compile is at most 90% of Slice 0;
peak RSS is at most 85% of Slice 0;
no output benchmark lane regresses by more than 2%;
generated code and binary size do not grow by more than 2%;
the old environment-snapshot and parameter-propagation path is deleted.
Suggested commits
refactor(core): represent incomplete construction phis virtually
refactor(core): resolve trivial construction phis before materialization
refactor(core): replace edge environment snapshots with sparse definitions
refactor(core): support exceptional and cyclic pruned SSA construction
refactor(core): delete post-hoc parameter propagation
perf(core): reduce self-compile construction footprint
Slice 2 — Add one dense Core generation barrier
Goal

Ensure that expensive analyses operate on compact live Core rather than construction-era high-water capacities and abandoned arenas.

Identity model

Keep CoreFunctionId stable for the complete compilation.

Change function-local identities to be stable within one Core generation:

CoreBlockId
CoreInstructionId
CoreValueId
CoreFactId

Use exactly two generations:

construction generation
    ↓
mandatory O1 structural normalization
    ↓
dense generation barrier
    ↓
optimization generation

Do not introduce repeated opportunistic compaction.

Required barrier

Add one final API such as:

program.finalizeConstructionGeneration()

It must rebuild each function’s local store using only live entities:

blocks
instructions
values
facts
uses
operands
results
block parameters
handler arguments
terminator edges
terminator arguments
effect refinements
rare payload references

The barrier must:

densely renumber local IDs;
preserve global function IDs;
preserve source positions and inline source chains;
rebuild definitions and intrusive use lists;
eliminate all tombstones;
eliminate abandoned operand and parameter ranges;
reset free lists;
recompute feature/opportunity indexes;
advance a Core generation number;
invalidate pre-barrier local references exactly once.
Explicit relocation contracts

Every opcode or payload field containing a local Core ID must declare its relocation schema.

Do not deep-walk arbitrary JavaScript objects looking for numbers that might be IDs.

Provide typed relocation contracts for:

instruction attributes
facts
proofs and obligations
effect refinements
source-position links
handlers
terminator payload data
construction metadata

Verification must fail when a relocatable field lacks a registered contract.

Analysis ownership

No expensive local or program analysis may exist before the generation barrier.

Before the barrier, permit only:

construction verification
mandatory O1 local simplification
structural reachability/forwarding needed to expose dead Core

The following must begin only after the barrier:

dominators and loops
value kinds
provenance and escape
MemorySSA
program flow
cross-call candidates
specialization candidates
proof certificates
Debug behavior

Old-to-new ID maps may be produced in full instrumentation mode.

In normal compilation:

do not retain relocation maps;
do not retain construction-generation storage;
do not include generation maps in CoreCompilation;
release construction scratch before advanced optimization starts.
Tests

Add tests proving:

stable function IDs;
dense local IDs after the barrier;
correct relocation of every ID-bearing attribute and proof;
exact use-list reconstruction;
handlers and exceptional edges relocate correctly;
stale pre-barrier IDs are rejected by debug generation checks;
output is deterministic regardless of construction tombstone layout;
repeated sealing does not trigger another compaction;
no analysis result survives across the generation boundary.
Completion gates

For every function with live entities:

block capacity / live blocks          ≤ 1.05
instruction capacity / live instrs    ≤ 1.05
value capacity / live values          ≤ 1.05
use capacity / live uses              ≤ 1.05
Abandoned operand, parameter and handler storage is zero immediately after the barrier.
The barrier consumes at most 5% of Node self-compile wall time.
Downstream time saved is at least 2× the barrier’s own cost.
Warm optimizeCore is at most 80% of Slice 0.
Warm total Node self-compile is at most 85% of Slice 0.
Peak RSS is at most 70% of Slice 0.
Peak managed heap is at most 75% of Slice 0.
No lower complexity tier regresses by more than 5%.
No output benchmark lane regresses by more than 2%.
No construction-generation store remains reachable after the barrier.
Suggested commits
refactor(core): define function-local Core generations
refactor(core): register explicit local-id relocation contracts
refactor(core): densely finalize construction Core
refactor(core): rebuild uses and edges at generation barrier
refactor(core): reject stale pre-barrier identities
perf(core): release construction generation before analysis
Slice 3 — Make local optimization function-major
Goal

Process each function to local quiescence while its CFG, analysis data and scratch state are hot, instead of sending every function through separate whole-program stages.

Required architecture

Introduce one final CoreFunctionOptimizationSession.

A session owns:

one editor and mutable change journal
dirty instruction queue
dirty block queue
local component dirty mask
function feature/opportunity data
control-flow bundle
local value-kind state
canonical-value state
proof and representation state
provenance and escape state
memory event and MemorySSA state
reusable numeric scratch

Large scratch buffers must come from a bounded reusable scratch pool. Do not retain one maximum-capacity scratch set per function.

Required local lifecycle

Each initially live function executes:

1. mandatory O1 structural normalization
2. fused scalar/local optimization
3. admitted CFG, dominator and loop work
4. admitted proof, value-kind and representation work
5. admitted provenance, escape and memory work
6. fused local cleanup
7. repeat only components marked dirty by actual edits
8. emit one final CoreChangeSet

There must be no general local “round.” Component dirtiness determines convergence.

Examples:

A constant fold dirties scalar users and perhaps its containing block.
A branch fold dirties CFG and scalar cleanup.
A representation edit dirties representation consumers, not CFG.
A removed memory write dirties memory state, not loop discovery unless CFG changed.
A proof-side-table change does not automatically rerun structural normalization.
Consolidated control-flow bundle

For one CFG revision, build one numeric control-flow bundle.

It must share storage for:

successor ranges
predecessor ranges
reachable blocks
reverse postorder
immediate dominators
dominator-tree children
dominance frontiers
backedges
loop headers and nesting
exceptional successors

Expensive subcomponents may be lazy, but they must reuse the same edge and block indexes.

Do not independently rebuild CFG edge objects for:

control-flow analysis
immediate dominators
loops
canonical roots
PRE
MemorySSA

Canonical value roots should be cached within the function session by SSA revision and reuse numeric scratch.

Pass-manager cutover

After migration:

type CorePassScope = "scc" | "program";

or remove the generic pass manager if no useful owners remain.

All function-scoped passes must move into the function session as:

local instruction rule
local block rule
structural component
CFG/loop component
proof/representation component
memory/provenance component
deleted as redundant

Maintain a checked migration table for every existing function pass.

Cross-call behavior

One cross-call wave must:

select all admitted transforms;
group them by caller;
open one caller session;
apply every compatible transform using that session’s editor;
locally optimize the caller to quiescence;
publish one final caller change set.

Delete:

finishCrossCallWave
post-wave control-flow stage
post-wave proof stage
post-wave memory stage
separate post-wave local canonicalization

A caller may be reopened at most once per cross-call wave.

optimizeCore shape

The active orchestration should be approximately:

verify input
finalize construction generation
optimize each function locally
solve program flow
apply one bounded cross-call wave
reopen changed callers locally
resolve affected program flow
select and verify late recipes
verify and seal final Core

It must not loop over:

all functions for canonicalization
all functions for CFG
all functions for proofs
all functions for memory
Tests

Add tests proving:

a scalar edit does not rebuild CFG;
a representation edit does not rebuild dominators;
a CFG edit reuses non-CFG local data where valid;
a memory edit does not rerun loop discovery;
one function’s work does not instantiate another function’s session;
scratch storage is reused but not concurrently aliased;
a changed caller opens exactly one post-cross-call session;
every former function pass has one final owner;
no generic function-scoped pass remains.
Completion gates

Relative to Slice 0:

warm Node optimizeCore is at most 60%;
warm total Node self-compile is at most 72%;
peak RSS is at most 62%;
peak managed heap is at most 65%;
local analysis recomputations fall by at least 40%;

combined time for:

CFG edge construction;
CFG building;
immediate dominators;
canonical roots;

is at most 45% of its Slice 0 value;

every initial function opens at most one primary session;
every changed caller opens at most one session per cross-call wave;
no lower complexity tier regresses by more than 5%;
no output runtime lane regresses by more than 2%;
stage-major local optimization and generic function passes are deleted.
Suggested commits
refactor(core): introduce function optimization sessions
refactor(core): consolidate numeric control-flow analysis
refactor(core): move CFG and loop transforms into sessions
refactor(core): move proof and representation work into sessions
refactor(core): move provenance and memory work into sessions
refactor(core): optimize cross-call callers in one session
refactor(core): delete function-scoped pass scheduling
perf(core): reuse bounded function-analysis scratch
Slice 4 — Make advanced optimization prove output value
Goal

Use the new compiler-time margin to improve emitted-program performance without allowing advanced optimization to become an unconditional compile-time tax.

Required optimization-family ledger

Measure these families independently:

O1 scalar and structural optimization
CFG, loop, LICM and PRE
proof, value-kind and representation optimization
provenance, escape and scalar replacement
MemorySSA and load/store optimization
program-flow analysis
inlining and cross-call transforms
late specialization and direct entries

For every family record:

compiler wall time
optimizer wall time
peak compiler RSS
Core instructions removed and introduced
generated C code units
object-file bytes
binary bytes
C compilation time
link time
JavaScript phase timings
bare HTTP throughput and p99
Express routes throughput and p99
Express JSON throughput and p99
Express form throughput and p99
Maligator-hosted self-compile time

A family ablation must preserve the same source, configuration and observable checksum.

Ablations are benchmark mechanisms only. They must not become permanent public optimization modes.

Optimization tiers
O1 — mandatory cheap work

Run on every function:

constant folding
copy propagation
DCE
trivial branch folding
trivial CFG cleanup
local value numbering
cheap representation propagation
O2 — opportunity-admitted function work

Run only when a concrete consumer exists:

dominators
loops and LICM
PRE
path-sensitive proofs
value-kind solving
provenance and escape
MemorySSA
scalar replacement
shape and property optimization

Broad properties such as “has a loop,” “has memory access” or “has an allocation” are insufficient admission.

Examples:

MemorySSA requires a potentially removable or forwardable read, a scalar-replacement candidate or a loop dependence consumer.
Loop analysis requires a supported loop optimization opportunity.
PRE requires repeated expressions crossing block boundaries.
Provenance requires an allocation, shape or property consumer.
Value-kind solving requires a representation, call-summary or proof consumer.
O3 — globally selected work

Use a single whole-program profitability budget for:

inlining
cross-call representation specialization
direct entries
guarded call specialization
expensive region recipes

Candidate discovery must have a cheap first stage. Do not construct full proofs and conflict sets for candidates that cannot fit the remaining budget or cannot outrank selected work.

Required profitability contract

Every non-O1 optimization family must declare:

admission predicate
expected benefit category
estimated compiler-work cost
estimated generated-code cost
per-function budget
whole-program budget
measurement lane that justifies retaining it

An expensive analysis may not run without a named admitted consumer.

Record every numeric profitability multiplier and its unit, including helper, guard,
boxing, root, safepoint, duplication, fallback, admission, materialization,
synchronization and loop-frequency weights. Calibrate them against the permanent
output lanes; do not retain or change a multiplier solely because it appears
plausible on one compiler workload.

Recorded implementation contract (2026-09-04)

The canonical values live in `src/compiler/core/core-ir-generated-cost.ts`; the
matching test intentionally snapshots every number and unit. These are estimating
units, not measured bytes or milliseconds.

Estimate group | Multiplier values and units
--- | ---
Estimated C statements | instruction 1, helper call 2, guard 2, boxing operation 1, duplicated generic fallback 1, admission check 2, materialization path 4, state synchronization 2; each value is estimated C statements per named event
Estimated binary bytes | C statement 8, input operand 2, duplicated instruction 4; each value is estimated binary bytes per named event
Compiler work | C statement 1, helper call 3, guard 2, boxing operation 1, root slot 1, safepoint 2, duplicated instruction 1, duplicated generic fallback 1, admission check 2, materialization path 4, state synchronization 2; each is compiler-work score per named event; 32 estimated binary bytes add one compiler-work score
Runtime benefit | instruction 1, helper call 6, guard 1, boxing operation 2, root slot 1, safepoint 2, admission check 1, materialization path 6, state synchronization 2; each is runtime-benefit score per named event
Loop and admission | loop nesting multiplies benefit by 4 per level through depth 3; a region is capped at 16,384 estimated binary bytes; base admission work is 128 compiler-work score and benefit is scaled by 16 compiler-work score per runtime-benefit/frequency score

The O3 ledger is shared across cross-call and late specialization. Its program caps
are 4,096 generated-code units and 32,768 compiler-work units. Cross-call retains a
tighter family cap of 1,024 generated-code units and 16,384 compiler-work units,
with per-caller caps of 64 expansions, 192 generated-code units and 768
compiler-work units. Late specialization retains at most 4 expansive regions per
function inside the shared per-caller caps of 512 generated-code units and 2,048
compiler-work units.

Required emitted-program work

Use the current JavaScript and HTTP profiles to identify output bottlenecks.

Implement at least three independently measured emitted-program improvements. At least:

one must improve a general JavaScript workload phase;
one must improve an Express workload;
one must reduce native build cost, generated code or binary size without slowing runtime.

Choose improvements from actual profiles. Possible categories include:

missed scalar representation propagation
missed property or collection specialization
missed loop optimization
missed direct call or inline opportunity
excess generic fallback duplication
duplicate helper or constant emission
source-closure reachability
generated control-flow expansion
register/liveness-induced code growth

Do not implement benchmark-specific operation names or fixture-specific patterns.

Output performance gates

Relative to Slice 0’s output baseline:

closed compiled JavaScript balanced phase time is at most 92%;
open compiled JavaScript does not regress by more than 2%;
Express geometric-mean throughput across routes, JSON and form is at least 108%;
no individual Express throughput lane regresses by more than 2%;
no Express p99 regresses by more than 5%;
bare HTTP throughput is at least 98%;
Maligator-hosted self-compile is at most 80%;

at least one of:

generated C code units;
total object bytes;
binary bytes;
C compilation plus linking time;

improves by at least 10%;

generated C and binary size may not grow by more than 2% unless the paired benchmark demonstrates at least a 5% runtime improvement attributable to that growth.
Compiler-time guardrails

Output optimization may not erase the compiler gains:

Node optimizeCore may regress at most 5% from Slice 3;
Node total wall time may regress at most 3% from Slice 3;
peak compiler RSS may not regress;
candidate discovery and proof construction must remain within their recorded budgets;
no lower complexity tier may regress by more than 5%.
Tests

Add tests proving:

every O2 analysis has a concrete admission predicate;
ineligible functions make zero corresponding analysis queries;
O3 discovery stops when no remaining candidate can displace selected work;
profitability estimates are deterministic;
generated-code costs include fallback duplication;
output benchmark ablations do not change semantics;
locked and mutable primordial modes preserve required guards and fallbacks;
runtime improvements are not obtained by incorrectly omitting generic paths.
Suggested commits
bench(core): attribute output value by optimization family
refactor(core): require concrete O2 optimization opportunities
perf(core): bound O3 discovery by remaining profitability
perf(core): improve measured JavaScript output path
perf(core): improve measured Express output path
perf(native): reduce measured generated output cost
bench(core): record optimizer output profitability

Recorded implementation result (2026-09-04)

Slice 4 produced three independently measured output changes. Factory-returned
closures now expose guarded direct-call candidates (`95b98307`), improving the
JavaScript objects phase by 1.296% in seven paired samples with a 0.556% to 1.651%
improvement interval and no binary growth. Function and callable own-shape slots now
use the shared property-cache path (`1e4f677e`), improving Express routes by 2.365%,
JSON by 1.260% and form by 2.039% in seven paired samples, with no binary growth or
p99 regression. Compact generated program-image row templates (`de5c185c`) reduce
JavaScript generated C by 12.509% and Express generated C by 10.763% relative to
Slice 0. Its isolated seven-pair JavaScript and five-pair HTTP guards found no
runtime or binary regression; the Express C-compilation median improved 16.565%.

The family ledger is `bench/core-opt3-slice4-attribution.json` and the consolidated
implementation evidence is `bench/core-opt3-slice4.json`. Observable checksums match
throughout. The final Slice 0-relative runtime targets remain acceptance gates for
Slice 5 rather than claims inferred from the incremental comparisons.

Slice 5 — Optimization and completion
Goal

Audit all previous slices, run the complete increasing-complexity ladder again, remove the largest remaining algorithmic and RSS costs, validate emitted-program performance, and adopt the new baseline only when every gate passes.

Part A — Self-audit all slices

Create a checked requirement table for Slices 0–4.

Recorded requirement audit (2026-09-04)

Check | Requirement | Evidence
--- | --- | ---
[x] Slice 0 | The four instrumentation modes, seven Core checkpoints, compiler/runtime output matrix, profiles and canonical artifacts exist. | `tests/compile-core.test.ts`, `bench/core-opt3-slice0.json` and `bench/core-opt3-slice0-output.json`; the accepted measurements remain recorded above.
[x] Slice 0 | Off, phases, counters and full modes retain identical output while detailed ledgers remain full-only. | `tests/compile-core.test.ts` and the mode guards in `core-optimization-report.ts`.
[x] Slice 1 | Construction uses versioned definition tables and virtual incomplete phis, resolves SCC aliases before materializing parameters, and emits only demanded edge arguments. | `core-frontend-construction.ts` and `tests/core-pruned-ssa-construction.test.ts`.
[x] Slice 1 | Copied definition environments, backward parameter propagation and post-hoc predecessor expansion are absent; copied snapshot entries remain zero. | Production-path search plus the large-environment and instrumented-report cases in `tests/core-pruned-ssa-construction.test.ts`.
[x] Slice 1 | Semantic and compiler gates are satisfied by the later Slice 3 checkpoint. | 495,788 constructed values, 2.769× amplification, 14,580.115 ms warm wall and 2,252,161,024-byte peak RSS in `bench/core-opt3-slice3.json`; output gates passed as recorded above.
[x] Slice 2 | One dense generation barrier preserves function IDs, relocates registered local-ID payloads, rebuilds uses/edges, retires construction stores and rejects stale managers. | `tests/core-store.test.ts`, `tests/core-ir.test.ts`, `tests/core-optimizer-infrastructure.test.ts`.
[x] Slice 2 | Only construction annotation and structural reachability/forwarding precede the barrier; advanced analyses and planning follow it. | `optimize.ts` ordering and the construction-pass analysis allowlist in `tests/core-optimizer-infrastructure.test.ts`.
[x] Slice 2 | Capacity, barrier-cost, compiler-time and memory gates passed at or before Slice 3. | Zero abandoned storage and a 299 ms / 1.81% barrier in `bench/core-opt3-slice2.json`; the stronger Slice 3 time and memory results are recorded above.
[x] Slice 3 | Initial local work is function-major, scratch is pooled, each initial function has one session, and callers reopen at most once per cross-call wave. | `core-function-optimization-session.ts` and `tests/core-optimizer-infrastructure.test.ts`.
[x] Slice 3 | The control-flow bundle shares structural, dominance, loop and exceptional views; generic multi-function scheduling and stage replay are absent. | `core-ir-control-flow.ts`, `tests/core-local-optimizer-migration.test.ts`, and checkpoint `db65f06e`.
[x] Slice 3 | Compiler time, analysis recomputation, memory and output guardrails pass. | `bench/core-opt3-slice3.json` and the completed Slice 3 record above.
[x] Slice 4 | Every optimization family has an ablation ledger, O2 work has concrete admission, and O3 selection shares bounded program and per-function budgets. | `bench/core-opt3-slice4-attribution.json`, `tests/core-optimizer-infrastructure.test.ts`, and `tests/core-specialization-plan.test.ts`.
[x] Slice 4 | Every profitability multiplier has one canonical value and declared estimating unit. | `core-ir-generated-cost.ts`, `tests/core-generated-cost.test.ts`, and the recorded multiplier table above.
[x] Slice 4 | Three independently measured output improvements cover JavaScript, Express and generated/native build cost without semantic drift. | `bench/core-opt3-slice4.json` and checkpoints `95b98307`, `1e4f677e`, `de5c185c`.
[ ] Slice 4 final acceptance | Repeat the complete Slice 0-relative production matrix after the Slice 5 algorithm and RSS loops. | Intentionally deferred to Parts D and E; incremental comparisons are not substituted for the final paired campaign.

Recorded prohibited-leftover audit (2026-09-04)

Check | Production-path finding
--- | ---
[x] | No copied construction definition maps or post-hoc parameter propagation remain; `DefinitionTable` retains sparse version history and edge materialization reads only demanded phis.
[x] | Incomplete phis remain numeric virtual tokens until SCC resolution; only conflicting resolved components allocate block parameters.
[x] | The sole pre-barrier analysis consumer is the permitted structural control-flow bundle; dominators, loops, value kinds, provenance, memory, program flow and candidates start after the barrier.
[x] | The dense barrier replaces each live function store, retires the construction generation, clears program-flow journals and retains no relocation map in `CoreCompilation`.
[x] | Every opcode declares `attributeRelocations`; registry construction and Core verification reject missing, duplicate or invalid local-ID payload contracts.
[x] | Initial post-barrier optimization is function-major. `CoreFunctionPassScheduler` is single-function only and has no generic function, SCC or program scope.
[x] | Cross-call transforms are selected in bounded waves, grouped by caller and applied through one caller editor/session; no external post-wave CFG/proof/memory replay exists.
[x] | O2 passes declare concrete feature/opcode/admission consumers; ineligible functions perform zero corresponding analysis queries.
[x] | Cross-call and late specialization use one bounded `CoreTransformCandidateService`; discovery and selection charge the shared O3 ledger.
[x] | Call targets, summaries, program value kinds and reachability are dimensions of one `CoreProgramFlowEngine`; production obtains them through one incremental program-flow analysis.
[x] | Target lowering consumes the verified numeric plan, and residual site facts derive from sealed Core plus that plan without Core analysis or optimization rediscovery.
[x] | Off mode skips counters, phase timers, detailed ledgers, traversal statistics and checkpoints; phases, counters and full mode collect only their declared levels.

Search the complete active production path for prohibited leftovers:

copied construction definition maps
post-hoc block-parameter propagation
materialized incomplete phis
analyses created before the generation barrier
construction-generation storage retained after the barrier
unregistered local-ID payload relocation
stage-major local optimization
generic function-scoped passes
cross-call stage replay
unconditional O2 analyses
unbounded O3 candidate construction
duplicate program-flow solvers
target-side optimization rediscovery
always-on detailed instrumentation

For every match:

remove it;
identify why it remained;
add a structural test preventing its return.

A slice is not complete because its replacement abstraction exists. Its superseded production path must be removed.

Part B — Increasing-complexity algorithm loop

Run the complete ladder in this order:

local arithmetic at 1×, 3× and 10×;
straight-line Core at 1×, 3× and 10×;
CFG and phi-heavy Core at 1×, 3× and 10×;
nested loops, LICM and PRE at 1×, 3× and 10×;
memory, provenance and allocation at 1×, 3× and 10×;
exact call graphs and recursive SCCs at 1×, 3× and 10×;
wildcard and opaque calls at 1×, 3× and 10×;
transform candidates;
pass/optimizer infrastructure;
shape provenance;
memory analysis;
summaries;
value kinds;
optimize.ts;
compile-program.ts;
complete Core subtree;
full Node-hosted self-compile;
full Maligator-hosted self-compile;
cold test:check.

For each tier record:

cold and warm wall time
all compiler phases
input and output Core sizes
post-generation capacities
component executions
function sessions and reopenings
CFG and dominance work
program-flow transfers
memory events and transfers
candidate discovery and selection
allocated bytes
GC CPU and wall time
peak heap
peak RSS
generated output size
digest and observable checksum

Normalize by:

milliseconds per 1,000 input instructions
local work per applied edit
CFG work per live block and edge
value-kind work per live value
memory work per memory event
program-flow work per exact edge and SCC
candidate work per admitted function
allocated bytes per live Core instruction
peak RSS per 100,000 live Core instructions
Required algorithm optimization loop

At each tier:

Find the first material rise in normalized cost.
Capture CPU and allocation profiles.
Identify one owning algorithm.
State the expected complexity.
Implement one focused correction.
Commit it separately.
Rerun the target tier and every lower tier.
Reject and revert the change when:
it merely moves the cliff to a smaller tier;
it makes any lower tier more than 5% slower;
output performance materially regresses;
memory growth offsets the CPU benefit.
Continue upward until the complete ladder passes.

After reaching full self-compile, optimize the top three independent algorithmic hotspots that each consume at least 3% of optimizeCore, or continue until no such hotspots remain.

Do not optimize only the full self-compile case when a smaller tier reproduces the same behavior.

Recorded ladder checkpoint (2026-09-04)

These artifacts are retained discovery evidence, not final acceptance measurements. The host was interactive and moved between battery and AC power during the real tiers; repeat the complete production campaign on a quiet host before applying the final thresholds.

Tier | Workload | Recorded result
--- | --- | ---
1 | Local arithmetic at 1x, 3x and 10x | `bench/core-opt3-slice5-tier1.json`; 10x input grew 9.19x while optimizeCore grew 3.00x, ending at 9.87 ms per 1,000 input instructions.
2 | Straight-line Core at 1x, 3x and 10x | `bench/core-opt3-slice5-tier2.json`; 10x input grew 9.96x and optimizeCore grew 9.28x, ending at 6.61 ms per 1,000 input instructions.
3 | CFG and phi-heavy Core at 1x, 3x and 10x | `bench/core-opt3-slice5-tier3.json`; 10x input grew 9.44x and optimizeCore grew 3.46x, ending at 12.85 ms per 1,000 input instructions with six CFG recomputations.
4 | Nested loops, LICM and PRE at 1x, 3x and 10x | `bench/core-opt3-slice5-tier4.json`; 10x input grew 8.71x and optimizeCore grew 4.90x, ending at 14.93 ms per 1,000 input instructions.
5 | Memory, provenance and allocation at 1x, 3x and 10x | `bench/core-opt3-slice5-tier5.json`; 10x input grew 8.77x and optimizeCore grew 4.66x, ending at 9.46 ms per 1,000 input instructions.
6 | Exact call graphs and recursive SCCs at 1x, 3x and 10x | `bench/core-opt3-slice5-tier6.json`; 10x input grew 9.66x and optimizeCore grew 6.04x, with about 13.9 transfers per exact edge at 10x.
7 | Wildcard and opaque calls at 1x, 3x and 10x | `bench/core-opt3-slice5-tier7.json`; 10x input grew 8.51x and optimizeCore grew 5.00x, ending at 21.86 ms per 1,000 input instructions.
8 | Transform candidates | `bench/core-opt3-slice5-tier8.json`; 35.65 ms wall and 18.20 ms optimizeCore per 1,000 input instructions, with 32 admitted candidates.
9 | Pass and optimizer infrastructure | `bench/core-opt3-slice5-tier9.json`; 30.30 ms wall and 17.42 ms optimizeCore per 1,000 input instructions.
10 | Shape provenance | `bench/core-opt3-slice5-tier10.json`; 36.67 ms wall and 22.49 ms optimizeCore per 1,000 input instructions. The adjacent wall ratio was 1.210x and triggered the focused algorithm survey despite remaining below the 1.25x gate.
11 | Memory analysis | `bench/core-opt3-slice5-tier11.json`; 40.20 ms wall and 24.66 ms optimizeCore per 1,000 input instructions, adjacent ratios 1.096x wall and 1.096x optimizeCore.
12 | Summaries | `bench/core-opt3-slice5-tier12.json`; 33.03 ms wall and 19.43 ms optimizeCore per 1,000 input instructions.
13 | Value kinds | `bench/core-opt3-slice5-tier13.json`; 32.34 ms wall and 19.40 ms optimizeCore per 1,000 input instructions.
14 | `optimize.ts` | `bench/core-opt3-slice5-tier14.json`; 35.40 ms wall and 21.46 ms optimizeCore per 1,000 input instructions, with 1.295 GB sampled peak RSS.
15 | `compile-program.ts` | `bench/core-opt3-slice5-tier15.json`; 40.47 ms wall and 24.20 ms optimizeCore per 1,000 input instructions, adjacent ratios 1.143x wall and 1.128x optimizeCore, with 1.786 GB sampled peak RSS.
16 | Complete Core subtree | `bench/core-opt3-slice5-tier16.json`; 33.90 ms wall and 20.21 ms optimizeCore per 1,000 input instructions, both about 0.84x tier 15.
17 | Full Node-hosted self-compile | `bench/core-opt3-slice5-tier17.json`; five warm median 16.003 s, three cold median 17.130 s, normalized adjacent ratios 1.058x wall and 1.051x optimizeCore, and one observable checksum across every sample. This misses the 15.0 s warm and 8.0 s optimizeCore final gates and requires a quiet rerun.
18 | Full Maligator-hosted self-compile | `bench/core-opt3-slice5-tier18.json`; five-pair medians were 18.966 s under Node and 194.213 s under Maligator with matching digests. The repository comparison reported Maligator 54.0% faster than the saved baseline. The native build took 236.567 s and peaked at 3.838 GB RSS; the runtime resource sample recorded 2.106 GB Maligator RSS and 2.031 GB Node RSS. Treat these active-device measurements as provisional.
19 | Cold `test:check` | Pending until the algorithm and RSS loops stop changing the compiler.

Tier 18 initially ran all build, cold, warmup, five paired, phase and resource work under one 600-second parent and timed out. The retained result used the repository's resumable checkpoint protocol: ten independent stages, each with its own 600-second fuse. No stage exceeded 3m59s and the final artifact was emitted only after all stages and parity checks completed.

Recorded algorithm experiments

Experiment | Result | Decision
--- | --- | ---
Batch equivalent exact-load forwarding in one function editor session | The tier-10 target improved about 2.2% and reduced memory-version recomputations from 992 to 971 and memory transfers from 73,598 to 61,233, but tier 9 regressed 6.0% optimizeCore and 8.0% wall and smaller tiers exceeded the 5% guardrail. | Rejected and reverted.
Memoized natural-loop parent and depth construction | Focused loop tests passed and allocation/RSS fell, but the tier-10 wall and optimizeCore medians regressed about 9%; the workload did not sample `naturalLoops` as a CPU hotspot. | Rejected and reverted.
Skip general sparse-memory SSA bookkeeping for single-predecessor functions | Focused type checking and 74 memory/provenance tests passed; the target analysis fell from 511 ms to 340 ms and sampled allocation fell 25%, but an active-device tiers 1-11 campaign produced contradictory off-mode regressions while the later full-profile sample improved. | Inconclusive and reverted; repeat as a quiet paired A/B before considering it.

The retained tier-17 CPU profile sampled 12,630.714 ms in optimizeCore. Hotspots at or near the 3% continuation threshold are GC at 1,115.948 ms (8.8%), `memoryVersions` at 649.213 ms (5.1%), `buildEdges` at 433.769 ms (3.4%), and `immediateDominators` at 372.630 ms (3.0% after rounding). The algorithm loop remains open.

Part C — RSS and allocation loop

Profile at least:

CFG-heavy 10×
memory/provenance 10×
optimize.ts
compile-program.ts
complete Core subtree
Node-hosted self-compile
Maligator-hosted self-compile
native output build

Explicitly inspect:

Core generation lifetime
relocation maps
session scratch retention
capacity-sized typed arrays
CFG and dominance storage
value-kind state
provenance and memory-event state
program-flow maps and sets
candidate and proof retention
source-position retention
generated C strings
translation-unit lifetime
worker or subprocess buffers
object-file and linker concurrency

Implement the top three independent allocation or RSS corrections, unless fewer than three causes individually account for at least 5% of peak live memory.

Each correction requires:

a separate commit;
before/after peak heap;
before/after peak RSS;
before/after wall time;
proof that no lower tier regressed materially.
Part D — Recheck output profitability

Rerun every optimization-family ablation and the complete production benchmark.

Verify that:

each advanced family still has a measured consumer;
compile-time estimates remain correlated with actual work;
generated-code cost estimates remain correlated with C/object/binary growth;
runtime improvements survive repeated paired measurements;
no optimization family remains enabled unconditionally merely because it existed before this plan.

Adjust admission and budgets from evidence. Do not simply disable a family whose implementation can be made selective.

Part E — Correctness and self-host gates

Run to completion:

npm run type-check
npm run lint:ci
npm run test:unit
npm run test:smoke
npm run test:check
npm run test262:regressions
npm run selfhost:frontend
npm run selfhost:native
npm run selfhost:cli
git diff --check

Also run:

the complete JavaScript benchmark;
the complete HTTP benchmark;
Node-hosted self-compile;
Maligator-hosted self-compile;
the complete complexity ladder.

An aborted, fused or timed-out command is a failed gate.

Final compiler gates

All of these must pass:

Metric	Required
Warm Node self-compile median	≤15.0 s and ≤68% of Slice 0
Warm Node optimizeCore median	≤8.0 s and ≤55% of Slice 0
Warm Node constructCore median	≤2.0 s and ≤70% of Slice 0
Slowest of 5 warm Node runs	≤1.12× median
Cold Node median	≤1.20× warm median
Maligator-hosted self-compile	≤75% of Slice 0
Constructed Core values	≤650,000 and ≤40% of Slice 0
Post-barrier capacity/live ratio	≤1.05
Peak Node self-compile RSS	≤2.0 GB and ≤60% of Slice 0
Peak managed heap	≤1.5 GB and ≤60% of Slice 0
phases overhead	≤1%
counters overhead	≤5%
Lower ladder tiers	None >5% slower
Real-tier adjacent normalized cliff	≤1.25×
test:check	Completes in ≤12 minutes
Final output gates

All of these must pass:

Metric	Required
Closed compiled JavaScript balanced time	≤92% of Slice 0
Open compiled JavaScript	No lane >2% slower
Express geometric-mean RPS	≥108% of Slice 0
Individual Express RPS	No lane >2% slower
Express p99	No lane >5% worse
Bare HTTP throughput	≥98% of Slice 0
Maligator compiler output digest	Node/Maligator agreement
Generated C or native-build cost	At least one ≥10% improvement
Generated C growth	≤2% unless paired runtime improves ≥5%
Binary growth	≤2% unless paired runtime improves ≥5%
Observable checksums	All match

When any gate fails, continue the measured algorithmic, RSS or output-performance loop. Do not mark the plan complete and do not update the permanent baseline.

Final acceptance report

Create:

bench/core-opt3-acceptance.md

It must contain:

the requirement audit for every slice;
current HEAD and all benchmark digests;
five warm and three cold Node samples;
Maligator-hosted samples;
every compiler phase;
every Core size checkpoint;
post-generation capacities;
heap, RSS, allocation and GC values;
complete normalized complexity ladder;
optimization-family profitability;
JavaScript and HTTP comparisons;
C, object, link and binary sizes;
all correctness command results;
every rejected experiment;
every remaining hotspot over 3% of compiler wall time;
explicit pass/fail status for every final gate.
Baseline adoption

Only after every gate passes:

Update bench/baseline.json using the repository’s normal repeated benchmark protocol.
Replace the obsolete failed compiler-scale baseline with the accepted result.
Preserve the historical 56-second and 115-second references in acceptance history.
Update the Core architecture decision and roadmap.
Mark older Core performance plans as superseded.
Remove temporary benchmark artifacts that are not intended history.
Commit the baseline separately from implementation changes.
Suggested commits

Use small measured commits during this slice, for example:

perf(core): remove measured CFG complexity cliff
perf(core): reduce value-kind scratch retention
perf(core): eliminate redundant local analysis rebuild
perf(core): release generation relocation state
perf(core): compact memory event lifetime
perf(core): reduce program-flow retained state
perf(native): reduce generated translation-unit retention
perf(core): tighten measured optimization admission
bench(core): record opt3 acceptance
bench(core): adopt completed optimizer baseline
docs(core): close Core speed and output plan
Definition of done

This plan is complete only when:

every slice is fully implemented;
every superseded production path is removed;
pruned construction no longer produces the current value explosion;
expensive analyses operate only on compact optimization-generation Core;
local optimization is function-major rather than stage-major;
advanced optimization is admitted and budgeted from measured opportunity;
emitted runtime performance has measurably improved;
generated-output and native-build costs remain controlled;
the complete ladder is free of unexplained algorithmic cliffs;
the algorithmic and RSS optimization loops are both completed;
every correctness and self-host command finishes successfully;
every final compiler and output gate passes;
the permanent benchmark and architecture documentation describe the final accepted implementation.
