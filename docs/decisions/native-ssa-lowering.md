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
single-use scalar expressions separately for canonical and typed entries. Root
slots differ from computational locals, and expression values have no local
assignment. Safepoint masks cover the entire native root set using an inline word
and immutable tail words; uncovered runtime-owned slots remain active. Small-mask
publication clears any previous tail. Entire inactive words are cleared together;
mixed words retain selective tracing. Expression selection admits only pure scalar operations whose
representations or exact input facts prove numeric semantics. It preserves leaf
values, effects, control boundaries, repeated uses, and profiling producer sites.
Floating-point contraction is disabled so an expression tree keeps JavaScript's
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
dominated by that definition in the ordinary control-flow graph. Handler and
resumable functions conservatively retain their constants. Scalar region inputs
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

Native layout places one-owner unconditional edge-copy blocks beside their
predecessors, preserving the relative order of Core blocks required by current
region contracts. Block references relocate before specialization and GC lowering;
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
Resumable, handler, selected-region, field-call, and switch functions retain their
checks until plan composition covers their opaque uses.

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

Resumable functions currently persist their complete boxed native local set. Their
frame records a native local count and suspended source position independently of
bytecode. Those fields share space with interpreter caller metadata because a
compiled coroutine has no interpreter caller frame. GC and SATB use the frame's
explicit ownership tag rather than interpreting native indexes through VM maps.

A suspension or completion helper can synchronously resume the same coroutine.
The outgoing C invocation captures the transferred operand and clears dead locals
using its outgoing map before unlinking its root frame. Resume destinations are
also cleared because their old values are overwritten by the next invocation.
Generator-start clears after its helper adopts the buffer. No outgoing invocation
may clear slots after a transfer, which can synchronously resume or free the buffer.
Runtime helpers root
the coroutine and transferred value while routing the suspension or settlement.
Completion shades and releases the activation before settlement can collect after
the activation has left the heap graph.

The interpreter also clears resume destinations when suspending, after capturing
and rooting the transferred value. This remains necessary for portable wire
frames, whose GC maps are untrusted and whose full register buffer is traced.
VM register reuse can alias an input with a resume destination; the captured root
keeps that input alive across PromiseResolve or queued-request reentry.

This boundary does not yet implement general native block scheduling, compact suspension
slots, additional typed aggregate transport, or shared cold regions. It provides
independent value and storage identities for those changes. Some fast-path and
region discovery still occurs during rendering; the emitter is not yet solely a
renderer of upstream selections. Performance acceptance
still requires matched workloads and repeated measurements; fewer emitted locals
alone do not establish a speedup.
