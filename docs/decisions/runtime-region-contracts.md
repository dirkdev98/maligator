# Runtime region contracts

Regions retain established facts and temporary state across operations that would
otherwise rediscover them. Expansion uses the existing traversal, conversion,
search, and construction algorithms. A new method or input kind must establish
the same contract before consuming retained state.

## Authority and lifetime

A captured method remains the call's authority after argument evaluation.
Mutable calls guard that actual callee; locked calls use their certified builtin
operation. Neither a property name nor a receiver constructor establishes method
identity. Realm checks also protect delayed materialization, whose prototype must
belong to the original operation's realm.

Exact callback contexts carry the callee, creation environment, canonical compiled
entry, and stable function index. Runtime image growth can replace the function
table, so contexts resolve rows through that index. Dynamically scoped contexts
belong to the fiber's execution state and restore their predecessor on return or
throw. Runtime nomination of a compiled callback supplies no numeric argument or
result facts; selected numeric adapters retain their separate guards.
Realm membership proves that a callback's function index belongs to this VM's
runtime image. An owned foreign realm is admissible because each exact invocation
switches to the callback's realm and restores its caller's realm on completion.
Being callable, or having an in-range function index, does not prove VM ownership.

Suspended Iterator helpers retain the rooted callback and its stable function
index, then reconstruct a stack-local context on each resume. Stack addresses,
function-table rows, and numeric adapters cannot survive the suspension. A matching
outer typed context retains its own argument guards. Callback indices follow
JavaScript Number addition, including rounding at the safe-integer boundary.

String spans retain a rooted source, normalized UTF-16 bounds, and one cached
materialization per lifetime. Child spans share the source while retaining their
own bounds and observation state. Non-observable primitive position conversions
share the canonical number parser. Arguments that invoke JavaScript or throw, and
unsupported observers, materialize before the original operation. Search helpers
honor both window boundaries, including when traversing ropes in reverse.
Numeric prefix parsing shares the ordinary parseInt/parseFloat algorithms through
a bounded segment reader. Borrowed leaves remain within a non-collecting parse;
the source stays rooted and unrelated rope ranges need not be flattened. Radix
conversion that can execute user code falls back before parsing begins.
Output consumers such as repeat pass those bounds into the canonical builder.
The builder retains the source across allocation and publishes either its final
result or its pending exception; a declined admission has performed no effects.

Enumeration snapshots retain the sequence produced by the original operation.
Keys can be counted without loading values; values must be copied eagerly into
root slots before any consumer runs. Enumerable accessors and unsupported storage
fall back before user code runs. Indexed observations share one cached Array
materialization, so later reads see mutations made through that Array.
Reflect.ownKeys includes strings and public Symbols in own-key order and rejects
primitive targets; it does not inherit Object methods' primitive boxing behavior.
Ignored arguments still finish evaluation before enumeration captures its state.
Entries capture keys and values eagerly but create each pair Array only when
observed. The captured string key distinguishes an unrealized pair from its cached
Array in the same rooted slot. Repeated reads reuse that pair; outer materialization
reuses every already-observed pair. Pair creation is a collecting boundary even
when it replaces an indexed property read, so incoming values and the produced
pair must be published to roots at that boundary.

## Effects and continuation

Virtual state follows allocation identity and control flow. Unreachable uses do
not create an escape, but live joins, exception transport, and allocation-generation
backedges still require a valid lifetime proof. Independent handlers do not exclude
a region whose retained state stays outside protected instructions and handler
entries. A runtime guard may restart an
operation only before observable work. After completed work, fallback resumes from
the corresponding state rather than replaying earlier effects.

An ordinary call and a certified builtin call observe temporary arguments through
the same materialization contract. The cached heap object becomes authoritative
before invoking either observer, including when the builtin changes descriptors
or returns the same object. Callee and receiver positions require separate proof.

Fixed TypedArray regions preserve memory-operation order for overlapping views.
Their induction update proves the stride; admission covers the visited index
windows. Polling publishes completed-iteration state before resumption. Fresh Array
plans use the shared builder's root and publication contract: only effect-free
initializer work can move before allocation, and references remain rooted until
the completed result is published. Incremental initialization reserves capacity
with zero scanned length, then publishes each initialized slot at its original
store. Collecting initializers retain the owner as an ordinary rooted value and
use per-store barriers; no backing pointer survives their calls. A handler that
could observe partially changed Array length prevents that admission.

Property-read regions can retain a receiver through must-alias register moves
and effect-free forward branches. Every incoming edge preserves that identity.
The first property-cache miss ends the borrowed shape and field-pointer lifetime
before the generic load can invoke user code; later reads never readmit that region.

Borrowed Map entries carry an owner-relative index, never a storage pointer. Each
update checks the current live entry and canonical key before using the ordinary
barrier-aware updater. Reference values and equal string or BigInt representatives
need no additional retained roots; the Map owns its stored keys and values.

Entry-pair consumers may reuse keys and values from an exact captured builtin
iterator without constructing an otherwise unobservable pair Array. Both values
must be rooted before key coercion or callbacks can mutate the collection. A
failed Array entry step may already have advanced and thrown; only a clean
admission miss permits the original step, while abrupt completion propagates.
An Array entry cursor with a foreign captured next method takes that original call
so an element access throws in the method's realm. Fresh collection constructors
root their receiver and captured adder before acquiring the iterator, since either
getter can explicitly collect.

## Bounded expansion

Discovery limits cover unsuccessful candidates as well as accepted plans. Shared
preparation and selection use compatible bounds, and transported plans are
independently checked against the current body. Artifact schema changes invalidate
older compiler caches.

Admission and execution counters distinguish selected metadata from exercised
paths. Semantic and memory checks establish correctness; retained matched timing
evidence is still required before claiming a performance improvement. Wider
regions must account for discovery cost, root slots, retained state, and generated
code as well as the work removed from their successful path.
