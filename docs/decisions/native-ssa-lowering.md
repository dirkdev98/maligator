# Independent native SSA lowering

Optimized Core and its certified optimization plan feed two target lowerings.
VM lowering colors storage into `ExecutionProgram`; native lowering assigns one
local identity per SSA value into `NativeProgram`. Both use the same semantic
operation selection and proof contracts. Native lowering does not consume VM
register allocation, and the production image boundary requires both targets
from the same Core compilation.

Each native function owns its lowered body, representations, source positions,
safepoints, selected regions, and typed entry contracts. Its body currently uses
the shared terminal instruction vocabulary. Sharing that vocabulary does not
make its instruction indexes or locals interchangeable with the VM body.
Constants and source resources are finalized jointly over both targets; a
constant used only by the native body must survive compaction. Captures, profiling
sites, test batch relocation, and compiler artifacts preserve both bodies.

Native storage planning precedes C rendering. It chooses root slot order, private
boxed locals and their publication obligations, stable incoming roots, and bounded
single-use scalar expressions separately for canonical and typed entries. Direct
SSA bodies persist a logical-root-to-physical-slot map. Audited private locals
share slots only when their complete incoming/outgoing safepoint unions do not
overlap; parameters, argument snapshots, continuously rooted locals, and helper
output addresses retain dedicated slots. Publication tracks each slot's current
occupant and forgets potentially cleared values at GC and control-flow boundaries.
Selected ordinary script-call transports also admit boxed final results to private
locals: typed, unavailable-entry, and guard-miss branches check completion before
assignment and publish the result before their outgoing GC poll. Region claims,
field materialization spans, builtin overlays, and destinations aliasing call inputs
retain continuously rooted storage. Transport selection precedes root selection;
recomputation never consumes a caller's previous storage plan.
Shared slots initialize once before entry allocations; resumable invocation roots
retain dedicated storage. Root slots differ from computational locals, and expression values have no local
assignment. Safepoint masks cover the entire native root set using an inline word
and immutable tail words; uncovered runtime-owned slots remain active. Small-mask
publication clears any previous tail. Entire inactive words are cleared together;
mixed words retain selective tracing. Expression selection admits only pure scalar operations whose
representations or exact input facts prove numeric semantics. It preserves leaf
values, effects, control boundaries, repeated uses, and profiling producer sites.
Exact Number inputs permit unary scalar expressions even when their input storage
is boxed. Floating-point contraction is disabled so an expression tree keeps JavaScript's
intermediate rounding. The artifact stores these choices; validation checks their
safety without requiring profiled artifacts to reselect expressions after reading.
Independent call and construction selections do not suppress unrelated scalar
chains; an expression still cannot cross their effect boundary. Scalar locals with
one definition and only later reads in the same straight-line block initialize at
that definition. Roots, argument prefixes, synthetic temporaries, and opaque region
storage retain initialization. This choice is persisted and checked independently
of expression selection, including profiled artifacts.
Numeric leaf helpers have their own selected scalar plan. Their eligibility is
chosen upstream from the typed ABI, and their expressions and initialization
choices are planned independently of ordinary boxed-body overlays. Rendering
preserves branch targets before eliding producers and confines expression macros
to the helper. The runtime observation guard still selects the ordinary typed body
when required.
The leaf plan also records unconditional edges to the immediately following
instruction as fallthroughs. Rendering retains only labels targeted by remaining
branches; a selected expression producer can still be such a target.

Immutable numeric and boolean SSA constants use a separate rematerialization plan,
so repeated uses and intervening effects do not force a C local. Selection requires
one explicit definition outside argument and synthetic storage, with every use
dominated by that definition in the logical control-flow graph, including snapshot
saves. Handler-bearing functions conservatively retain their constants. Scalar region inputs
can be read early; overlays may only write explicit outputs or boxed materialization
storage. Constants preserve their declared C representation, including int32 casts
and negative zero. Profiling retains their producer sites. The artifact stores and
validates this plan independently for ordinary bodies and numeric leaf helpers.
Selected switches and property fast paths retain priority over constant producer
elision. Scalar expression selection protects opaque region IPs and their borrowed
destinations, field-call spans, and literal-switch spans individually. Unrelated
scalar tails can still fold; their full expression window must preserve effects,
control flow, and the values of transitive input leaves.

Native loop polls cut cycles in the explicit target block graph, including
exceptional paths through handlers. Phi-copy blocks can jump backward in physical order
without closing a cycle; those transfers require no native loop poll. The native
artifact records polling edges, and validation requires the remaining
control-flow graph to be acyclic after those edges are removed. Rendering obeys
that metadata even for physically forward transfers. An exceptional DFS cycle
selects a normal branch on its path because exceptional transfers cannot poll.
The VM retains its physical backward-branch polling
contract and corresponding root maps.

Native layout follows default-successor traces between atomic block groups. Selected
region anchors, claims, admission sites, and control-flow envelopes constrain the
original Core-order span; field calls constrain allocation through call. Overlapping
spans merge, and only one-owner default edge-copy blocks may intervene within a span.
A separate verifier rejects reversed, split, or unrelated-copy layouts before
relocation. Handler transport and suspension markers remain inside their original
blocks. Block references relocate before specialization and GC lowering;
instruction identities and cycle-safe copy schedules survive that permutation.
Explicit per-block source attribution prevents moved copies from inheriting an
unrelated source position. The target keeps its explicit jumps and exception ranges;
ordinary C rendering omits jumps to the immediately following instruction.

Native merge copies use their own reader-count schedule and cycle scratch pool.
A scratch can serve successive cycles and different blocks only when its canonical
class and every selected typed entry class match. Typed entries seed that scratch
from the saved SSA value before propagating representation conflicts through moves.
Each copy must define its scratch before reading it; scratch cannot be a semantic
copy operand or escape the contiguous copy. The verifier symbolically checks every
simultaneous assignment. VM temporary ownership remains confined to one block.

Ordinary native storage plans also record TDZ checks whose final number, int32, or
boolean source cannot hold the boxed hole sentinel. Selection is per canonical or
typed entry after move representation propagation. The semantic body and GC maps
retain those checks; rendering omits only their C statements while preserving
labels, source/profile events, and conservative deferred-root bookkeeping. Artifacts
persist and validate the selected IPs against each entry's final representations.
Selected regions, field calls, switches, protected instructions, and handler entries
cut scalar windows. Their borrowed operands retain initialization and TDZ guards;
independent numeric windows remain eligible for scalar cleanup. Constant
rematerialization still excludes handler-bearing bodies because its dominance
contract does not describe exceptional edges.

Static numeric property pair, triple, and quad projections are selected per native
entry before scalar and root storage. Their plans retain instruction and cache
references, load/step/register operands, claimed IPs, borrowed locals, and the
original-instruction fallback. Storage excludes claimed sites and borrowed locals
from delayed expressions, TDZ omissions, and private root aliases. Unrelated scalar
storage remains eligible in property-load functions. Artifact validation recomputes
each entry's selection; C rendering builds action maps from the stored plans.
Other selected regions and native loop-poll sites are admission barriers; explicit
numeric-fusion handoffs retain their existing contract. Projection misses execute
the retained operations in their original order, including getter, coercion,
exception, and GC behavior.

Numeric property updates also have per-entry plans selected before storage. Admission
follows distinct load, ToNumeric, arithmetic, and store values rather than requiring
VM-style destructive register reuse. A successful Number admission computes and
commits without user code; only old/new values with uses outside the claimed window
are materialized at their original definitions. Opaque consumers and profiling
conservatively retain all outputs. A failed admission or commit executes the original
instructions in order, including BigInt, coercion, accessors, Proxy, and exceptions.
The plan records claims, borrowed locals, and materialization sites; artifact validation
recomputes those obligations. Ordinary control entries and polling edges cut admission.
Functions with numeric fusion retain generic updates because a preceding RHS can
reside in a fusion temporary instead of its semantic local.

Bounded boxed property read regions are also selected per entry before rendering.
Their persisted plans record receiver, load/cache references, the pure window's
claims and borrowed locals, and the remaining-instructions continuation. Scalar
expressions cannot borrow that window. Unlike numeric intermediates, read-region
results are stored at every original load, so private root publication remains
eligible. The first miss permanently ends that admission before user code or GC.
Artifacts validate the selected window against each entry's body and representations.
Numeric-fusion overlays cut read admission because their hidden temporaries and
slow paths have no read-region cooperation contract.

Adjacent boxed property reads also carry per-entry persisted plans. The receiver,
cache sites, borrowed values, and two claimed instructions are selected before
storage planning. Rendering consumes the pair admission and preserves a separate
original-instruction fallback at each load, including its source and profile event.

Paired indexed-array reads, constructor initialization, and private-field capacity
also have persisted per-entry plans. Paired admission retains the existing indexed-loop
certificate and pins borrowed receivers; each secondary read checks current receiver
identity and indexed storage because the loop certificate permits intervening mutation.
Presence probes retain their current prototype and hole checks. Each parent length
site owns at most one paired admission. Constructor plans reference original store
instructions and reserve the entire first-to-last store window. Eager final-shape
publication requires every intervening operation to be pure under the selected
representations, without overlays or polls. Private capacity planning preserves the
original definition sites and their effects. Rendering only reconstructs action maps;
artifact validation recomputes the selections and ownership contracts.

Selected ordinary and guarded typed calls carry per-caller-entry transport plans.
Existing callee signatures determine argument and result conversions, including
certified field slots and rest argument slices. Whole-program validation checks
those choices against the current target ABIs; artifact and batch relocation retain
target identities. Rendering may fall back when an entry is unavailable, but does
not choose new conversions. Guarded typed calls assign their result after leaving
the callee and checking completion, with the caller realm restored before an
exception transfer. They avoid a boxed completion aggregate; scalar destinations
stay scalar only when the caller already proves that representation. Open guarded
fallbacks generally retain boxed destinations. Number-to-int32 transport uses the
runtime conversion rather than a C cast.

Exact Array callback sites can reuse typed entries already selected from ordinary
calls. Each caller storage plan records the chosen signature; validation recomputes
it against the current entry table, and artifact/batch relocation preserves the
target. One guarded adapter per selected target entry retains the canonical callback
ABI and falls back on incompatible arguments. Snapshot and rest entries require the
builtin invocation's exact arity. The adapter shares its entry's optional code-size
budget, so rejection restores the canonical callback pointer. The existing exact
script-call helper continues to own activation, realm, receiver adjustment, and
boxed argument roots. Typed results are boxed without allocation at this boundary.
This consumes existing entry contracts; it does not discover new callback-driven
signatures or remove the builtin's boxed argument buffer.

Direct activation-local stack objects with existing certificates
can store several fields in independent number, int32, and boolean locals. Stable
boxed and string fields occupy dedicated shadow slots initialized before frame
publication and active throughout the invocation. Every field must retain its initial
representation at all certified accesses; inherited or changing fields
keep whole-object boxed storage. All-boxed sites retain the existing contiguous layout.
The persisted plan is selected and validated independently for each entry. The embedded
header retains identity with a null field-storage pointer, so this layout cannot escape
the certificate. Existing certified returns can materialize a typed layout: rendering
boxes the current fields into a bounded vector only on that edge, and the shared
materializer roots the vector before allocating the managed cell. The clone preserves
shape, prototype, and current values; allocation errors are checked before frame unlink.
Boxed-result typed entries share this path. General escaping uses remain excluded.

Literal-shape caches are shared by both target bodies. Their slot identities come
from Core allocation origins, independently of physical block order. Both the wire
and compiler artifact persist those identities explicitly; validation rejects
duplicate or out-of-range slots and descriptors whose keys disagree with an allocation.

Property caches also use shared Core operation identities, retained independently
of GC safepoints. Both targets reserve the same union of cache sites, and the wire
persists each site's ID and the shared capacity. Compiler overlays keep canonical
VM instructions while attaching native bodies; startup seeding and native reads
therefore address the same semantic cache row even when block order differs.
Validation rejects duplicate IDs, incompatible capacities, and shared rows whose
property keys or operation contracts disagree. Static cache hits omit key checks,
so physical instruction ordinals cannot identify these shared rows.

Resumable functions keep per-value representations in C locals. Each invocation
publishes an active root array for traced locals and the coroutine itself. A separate
boxed activation buffer holds the largest individual suspension snapshot, plus
two resume mailboxes. Each site's ordered map assigns its live locals to shared slots.
Full value liveness covers scalars, exceptional edges, and finally paths. Boxed and
string spills come exclusively from trusted outgoing root obligations: conservative
handler edges can name stale heap bits, and Core also retains scalar-replaced boxed
occupants beyond their last executable read. Arguments and captured environments
keep their existing ownership contracts.

Unprotected resumables also compose scalar expressions, constant rematerialization,
TDZ omission, and initialization plans. Suspension saves are explicit planning reads;
resume entries cut straight-line windows. Saved locals and mailbox destinations cannot
be expression macros. Admitted immutable constants need no snapshot slot, and validation
derives the expected snapshot from the stored safe subset of rematerialized producers.
Retaining a producer therefore also retains its required spill. Protected windows
retain conservative scalar motion; independent unprotected windows remain eligible.

The frame records the compact slot count and suspended source position independently
of bytecode. GC and SATB use its explicit ownership tag and compact count, rather than
interpreting native indexes through VM maps. Artifact validation recomputes the
suspension contract from the native body and trusted root obligations.

A suspension or completion helper can synchronously resume the same coroutine.
The outgoing C invocation captures the transferred operand, replaces the snapshot
with selected live values, then unlinks its active root frame before transferring.
Resume destinations use dedicated mailboxes; their previous values are discarded.
A resumed invocation restores locals and mailboxes into its published active frame,
then clears the snapshot with SATB barriers. Generator-start saves before its helper
adopts the buffer. No outgoing invocation may write slots after a transfer that can
synchronously resume or free the buffer. Runtime helpers root the coroutine and
transferred value while routing suspension or settlement. Completion shades and
releases the activation before settlement can collect after it leaves the heap graph.

The interpreter also clears resume destinations when suspending, after capturing
and rooting the transferred value. This remains necessary for portable wire
frames, whose GC maps are untrusted and whose full register buffer is traced.
VM register reuse can alias an input with a resume destination; the captured root
keeps that input alive across PromiseResolve or queued-request reentry.

This boundary does not yet implement general native block scheduling,
additional typed aggregate transport, or shared cold regions. It provides
independent value and storage identities for those changes. Some fast-path and
region discovery still occurs during rendering; the emitter is not yet solely a
renderer of upstream selections. Performance acceptance
still requires matched workloads and repeated measurements; fewer emitted locals
alone do not establish a speedup.
