# Specialized Set storage

Set and WeakSet own a key-only ordered store through `MalSetObject`. Map and WeakMap
retain `MalMapObject` and the general ordered table. Shared SameValueZero
canonicalization and hashing live in `key.h`; property-key canonicalization remains
separate. Collection identity and ordinary object properties survive every backing
change.

The Set API carries canonical `MalValue` members directly through lookup, algebra
and traversal. Transient property-key kinds belong to the general table boundary.
Raw member entry points apply shared collection normalization; canonical entry
points accept values produced by that normalization or Set iteration.

## Layout and transitions

A newly created, unreserved Set has no backing allocation. First insertion, iterator creation or a nonzero reserve hint
allocates a stable RAW descriptor with four inline canonical tagged members.
Small stores search linearly and allocate no hash index. Capacity hints from
constructors, copying and algebra remain lazy, so reserving an empty Set cannot
choose a generic domain before seeing its members.

Hashed storage separates ordered keys, liveness/fingerprints and an open-addressed
index. An index slot names an insertion-order position; it never exposes an entry
pointer to consumers. Packed int32 keys use four bytes per position plus four bytes
of control data. Other domains use an eight-byte canonical tagged key plus the same
control data. Index slots, capacity slack, the descriptor and allocator charges are
additional costs. There is no duplicated value lane or accessor sidecar.

| Domain   | Accepted inserted members                 | Query comparison              | Payload bytes per position |
| -------- | ----------------------------------------- | ----------------------------- | -------------------------- |
| Empty    | First member chooses the domain           | Always absent                 | Inline only                |
| Int32    | Integral Numbers in signed 32-bit range   | Unboxed integer               | 8                          |
| Number   | All Numbers, including NaN and infinities | Canonical bits                | 12                         |
| String   | Strings                                   | Content equality              | 12                         |
| Identity | Objects and symbols                       | Identity                      | 12                         |
| Generic  | All members                               | Shared SameValueZero equality | 12                         |

A novel insertion joins the current domain with its member's domain. Int32 widens
to Number, and incompatible domains widen to Generic. Queries and duplicate
insertions never widen. BigInts enter Generic even though the shared `MalKey` kind
places them in its numeric equality category. Canonicalization unifies int32/f64
Numbers, signed zero and NaN while keeping Number and BigInt distinct.

Int32 widening decodes keys into a replacement lane. Other domains have the same
physical width and can generalize without copying. Growth copies existing lanes
and fingerprints rather than hashing every member again. Rehashing rebuilds index
slots from live members. Insertions reuse their initial missing-slot probe unless
rehashing invalidates it. Deletion closes probe holes by shifting index slots;
ordered tombstones stay outside the lookup index.

## Order and ownership

A descriptor remains stable while its payload and index change. Every cursor
stores a logical order position. JavaScript cursors pin the descriptor; native walks
pin explicitly when they can mutate or re-enter user code. Growth and widening
preserve live and deleted positions, including transitions out of inline storage.
Clear followed by insertion appends after the previous positions while pinned, so
unfinished iterators see the new members. An exhausted JavaScript iterator remains
exhausted.

Unpinned empty, inline or dead-heavy storage compacts, preserving survivor order.
Small survivors return to inline storage; an empty unpinned store can select a new
domain. Active pins defer renumbering. A long-lived iterator therefore still
retains tombstone history; cursor relocation during compaction is a separate
future design.

Normal iterator exhaustion and native pinned walks can compact their live owner
after releasing a pin. GC finalization only decrements ownership and frees RAW
buffers after the final owner/pin is released. It must not allocate, hash or read
member cells: those cells and the managed Set may already have been finalized.
RAW descriptors are not GC roots. A live iterator roots its Set through its target;
a dead iterator retains only the RAW lifetime until its finalizer drops the pin.
Performance finalization may classify member tags, but cannot dereference members.

## GC and callback boundaries

Strong Sets trace each live member once; Number and Int32 domains have no member
edges. Object properties and prototypes keep the ordinary exotic-object trace.
Insertion cards old owners, including WeakSets, so remembered owners participate
in minor tracing or weak registration. Strong deletion shades the removed edge
for SATB; weak deletion must never make an otherwise dead member strong.

WeakSets have a separate collector registry and are filtered after the complete
WeakMap ephemeron fixpoint. This includes WeakSets discovered through activated
WeakMap values. Filtering uses a non-allocating, non-mutating mark predicate and
rebuilds the index before compaction. Verification traces surviving weak members.

Constructor items, algebra callback keys and forEach arguments remain explicitly
rooted across user callbacks, including callable Proxy apply getters.
Structured cloning snapshots and roots members before recursively cloning them;
getters may clear or mutate the source. The same snapshot rule covers Map entries.

## Runtime and compiler boundary

Builtins, constructors, all algebra methods, direct calls, iterator stepping and
bulk draining, cloning, Node util brands and every GC consumer use the Set API.
No consumer accesses a key lane or assumes a domain. A proven Set receiver brand
licenses semantic direct dispatch; it does not prove its current backing layout.
Backing changes do not change shapes or protector state. No portable wire field
changed; native artifact identity includes the new runtime sources and headers.

`[perf-set-storage]` reports successful small/hashed insertions, promotions, domain
selections/widenings, query kinds and requested payload/index allocation bytes.
Set collection key profiles count successful stored members independently of query
kinds. `mal_set_storage_allocation_bytes` exposes current allocator-charged RAW
ownership, while order length and trace-slot queries support native contract tests.

The Set regression suite covers domain changes, wrapped collision chains, mismatched
queries, multiple cursors, callback mutation, cloning, weak fixpoint discovery,
old-owner additions and abandoned iterator ownership. Its JavaScript fixture runs both backends and GC
stress; the companion C fixture checks storage and GC contracts. The suite belongs to the normal developer gate and sanitizer selection.

The reusable principle for later backings is a stable semantic owner, an explicit
storage domain, an ordered traversal contract, and one owning transition routine.
Other collections can adopt that boundary when their semantics justify a specialized
store; they do not need to share this Set layout or a speculative universal vtable.
