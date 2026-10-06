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

Native loop polls follow DFS cycle edges in the explicit target block graph,
including handler components. Phi-copy blocks can jump backward in physical order
without closing a cycle; those transfers require no native loop poll. The native
artifact records polling edges, and validation requires the remaining normal
control-flow graph to be acyclic after those edges are removed. Rendering obeys
that metadata even for physically forward transfers. Exception liveness includes
handler edges independently. The VM retains its physical backward-branch polling
contract and corresponding root maps.

Resumable functions currently persist their complete boxed native local set. Their
frame records a native local count and suspended source position independently of
bytecode. Those fields share space with interpreter caller metadata because a
compiled coroutine has no interpreter caller frame. GC and SATB use the frame's
explicit ownership tag rather than interpreting native indexes through VM maps.

A suspension or completion helper can synchronously resume the same coroutine.
The outgoing C invocation unlinks its root frame before that transfer, so its
inactive mask cannot clear a newer invocation's live slots. Runtime helpers root
the coroutine and transferred value while routing the suspension or settlement.
Completion shades and releases the activation before settlement can collect after
the activation has left the heap graph.

This boundary does not yet implement native block scheduling, compact suspension
slots, additional typed aggregate transport, or shared cold regions. It provides
independent value and storage identities for those changes. Some fast-path and
region discovery still occurs during rendering; the emitter is not yet solely a
renderer of upstream selections. Performance acceptance
still requires matched workloads and repeated measurements; fewer emitted locals
alone do not establish a speedup.
