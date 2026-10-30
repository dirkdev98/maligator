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
Output consumers such as repeat and padding pass those bounds into the canonical builder.
The builder retains the source across allocation and publishes either its final
result or its pending exception; a declined admission has performed no effects.
Padding converts its target before its filler, and a satisfied target never observes
the filler. Direct compiled helpers own no native GC-suppression contribution; only
the native wrapper may remove its own contribution after publishing its roots.
Long repetition polls only after publishing a completed prefix.
Case conversion bounds both its Latin-1 scans and Unicode context to the span,
including final-sigma decisions at either boundary. A changed output uses the
canonical builder; unchanged output materializes only the final range. Whole-string
callers retain cached flattening, while partial ropes copy only the required range.
Normalization shares this bounded input preparation and canonical Unicode builder.
The source and form stay rooted through form coercion; validation occurs before
empty or already-normalized shortcuts, and an admitted exception never replays.
String toString and valueOf retain the same span after primitive-brand and captured
native-method validation. Their ignored arguments still finish evaluation, but are
never coerced by the identity operation. Wrappers retain the original branded call.
Concatenation shares a ranged output builder with ordinary String concat. Bounded
primitive arguments are rooted and converted in order; observable conversions
retain the original call before any work. Partial spans copy only their range.
Primitive string replacement reuses the canonical replacement parser and bounded
search. Match, prefix and suffix substitutions refer to the retained range, not
its source's surrounding text. Object search protocols and functional replacement
keep the original call, including its callback roots and effects.
Well-formedness uses the same segmented UTF16 scanner for canonical strings and
retained ranges. A surrogate can pair across rope segments inside the range, but
never across its boundary; repair copies only the selected units.

Enumeration snapshots retain the sequence produced by the original operation.
Keys can be counted without loading values; values must be copied eagerly into
root slots before any consumer runs. Bounded accessor enumeration first captures all
original string keys, including hidden keys whose enumerability an earlier getter
can change. Each key then rechecks its own descriptor before observing its value.
Captured keys, prior values and the receiver remain rooted through every getter;
no storage pointer survives it. Admission becomes irreversible before the first
getter, so an abrupt result propagates without replay. Unsupported storage and
oversized key sets fall back before user code runs. Indexed observations share one cached Array
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
Read-only reductions retain the same storage guards without requiring writable
buffers. Every view contributes its complete visited index window, including all
interleaved lanes; the region preserves each numeric operation and storage rounding.
Proven Math builtin identities reuse their canonical numeric bodies inside fixed
storage regions. Admission guards every consumed argument as a Number before any
memory operation; these bodies cannot invoke user code or collect. Mutable method
lookups and argument effects retain their original execution path. Known primitive
defaults use their numeric values; variadic numeric bodies consume every argument
and preserve NaN, infinity and signed-zero behavior.
Their induction update proves the stride; admission covers the visited index
windows. Polling publishes completed-iteration state before resumption. Fresh Array
plans use the shared builder's root and publication contract: only effect-free
initializer work can move before allocation, and references remain rooted until
the completed result is published. Incremental initialization reserves capacity
with zero scanned length, then publishes each initialized slot at its original
store. Collecting initializers retain the owner as an ordinary rooted value and
use per-store barriers; no backing pointer survives their calls. A handler that
could observe partially changed Array length prevents that admission.

DataView accessor calls join fixed storage regions as byte views. Admission uses the
conditions that make `byteLength` the intrinsic getter: the watched-prototype
protector, the intrinsic prototype, an empty own layout, and a fixed view over an
attached, unshared buffer that covers it. Those conditions also make every accessor
the intrinsic method until the next poll; stores additionally need a mutable buffer.
Each access's byte key is a counted multiple of the index plus an offset, and
admission guards every byte of the visited window, so a loop whose access would
throw runs its original instructions. Stored values and byte orders are Numbers,
or constants folded through ToBoolean.

Numeric record regions carry guarded field values through the same certified
numeric builtin bodies as fixed storage loops. Every consumed dynamic operand is
a Number before execution; admitted bodies neither allocate nor invoke user code.
The original field and writable-store guards remain valid until final publication.
Unknown methods and coercions end the region before their original observation.
Certified Number predicates produce Boolean locals without coercing inputs.
Dynamic operands use the region's Number guards; non-number immediate operands
produce false. Boolean branches preserve that kind, and numeric stores still
require Number values.
Read-only reductions may borrow numeric own fields from frozen or prototype objects
and callable objects with the existing ordinary-slot layout. Stores retain the
stricter receiver guard and writable cache rows. Larger plans keep bounded prefixes
and may cover complete numeric fusions; no fusion temporary crosses their boundary.
Small linear read-only arithmetic stays with the existing pair/triple/quad projections.
Read-only admission supports compact, embedded and external own-slot storage.
Alternate cache rows carry their own slot; writeback uses the slot admitted for
the record's shape, not the primary row's slot for another shape. Ordinary
writable records retain admission after growth into external storage; embedded
objects remain excluded from writeback.

Property-read regions can retain a receiver through must-alias register moves
and effect-free forward branches. Every incoming edge preserves that identity.
Own-slot admission also covers callable objects and alternate shape-cache rows;
each cached slot is read from the retained shape's field storage. Inherited constant rows retain their ordinary-object receiver guard.
An unmaterialized scalar-backed stack object may have a shape without a field
buffer; it cannot enter a borrowed-field region.
Named own slots of Arrays, TypedArrays, Maps, Sets, Dates, RegExps, Promises,
ArrayBuffers and DataViews share this storage contract.
The two-to-four-field projections use the same receiver and backing-buffer
admission as larger property regions. Their indexed or internal properties still
require the original admission; an own
shape row never licenses element storage, collection size or a buffer extent.
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

Locale-aware span case conversion resolves the full locale list before empty or
unchanged output shortcuts. Its shared helper roots the source and locale input;
only locale resolution owns a balanced native-frame contribution. The bounded
Unicode builder resumes with the caller's original frame count and span context.
Ordinary and prepared locale comparisons retain that same bounded input through
canonical collation. The right operand is converted before locale/options effects;
all observable inputs stay rooted, and borrowed segments begin after callbacks.
Whole-string callers preserve cached UTF16 bridges; partial inputs share bounded
preparation owned by heap strings. Only Collator construction owns a temporary
native-frame contribution, and prepared collators keep their existing cache identity.

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

String span searches convert primitive needles through canonical ToString while
rooting the source and arguments. Position conversion follows needle conversion.
Observable coercions, symbols and foreign-realm methods take the original call;
admitted allocation failures retain normal completion handling.

Span replacement converts primitive search and replacement values in the canonical
order, retaining source and argument roots until conversion completes. The existing
replacement builder owns no-match conversion and range-relative substitutions.
