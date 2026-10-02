# Specialized Map storage

Map owns `MalMapStorage`, independently of property tables. Its
index uses the shared grouped-hash implementation; its payload, equality,
mutation barriers, cursor lifetime, and tracing belong to the Map owner.
Weak collections use distinct [unordered storage](specialized-weak-storage.md).

An empty Map has no backing allocation. An insertion, iterator, or nonzero reserve
hint creates a stable RAW descriptor with four inline key/value pairs. Larger Maps
with int32 keys use coallocated packed-key and tagged-value lanes plus a grouped
index. Other domains store contiguous 16-byte key/value pairs, placing the mapped
value beside the key examined by a successful probe. The existing key domain
selects the layout. Values always occupy eight bytes; the payload uses 12 or 16
bytes per order position, excluding index capacity, descriptor, and allocator
rounding. Packed-key capacities preserve alignment of the value lane.

Every layout uses the internal `MAL_VALUE_EMPTY` value as its deleted-row marker;
the C insertion/update API excludes that sentinel. A present `undefined` value is
live, including the initial value published by upsert before its caller supplies
the mapped value. Iteration checks the value before reading a potentially dead
key. Inline deleted keys also mirror the sentinel, letting tiny linear misses
read only the key lane. Deletion and clear shade the old key and value before replacing the value
with the sentinel. Numeric Maps therefore need no separate liveness lane, but
numeric deletion writes the value lane instead of a separate byte lane.

The descriptor fits the 128-byte allocation class. Its inline storage shares a
union with the cached packed-key value pointer. Payload replacement preserves live
keys and every value below the order length, including deleted-row markers,
before publishing the new layout; demotion snapshots all live pairs before
overwriting that pointer. Widening int32 keys creates paired storage, while
transitions between other key domains preserve their pair layout.

The key domains are int32, Number, string, identity, and generic. Insertions widen
when a novel key requires it; updates and incompatible queries never widen.
Number canonicalization preserves SameValueZero, while BigInt remains a distinct
equality domain. Strings compare by content and objects/symbols by identity.
Equal string updates can replace the stored representative only with inline or
tightly owned backing, preserving the existing retention bound and SATB barrier.

Order positions remain stable during growth, key widening, and index rebuilding.
Unpinned clear shades live edges and discards the payload/index directly, without
writing or scanning dead rows that are about to be freed. Empty compaction also
skips the dead-row scan. Pins prevent payload compaction; deletion and clear leave dead positions so live
iterators observe subsequent appends. Normal exhaustion may compact after dropping
the pin. GC finalizers only release ownership or decrement pins, because member
cells may already have been reclaimed. A Map's borrowed entry hint is validated
against an encoded mirror of the live stored key. Removing that entry, clearing,
compacting, or releasing the owner invalidates the hint. A compact-string
representative replacement refreshes the mirror; an equal temporary query never
becomes a new retention edge.

Maps trace every value, including Maps with numeric keys. Numeric keys need no
key tracing. Mutator writes retain old-edge barriers and card the owner for young
edges. WeakMap has a separate heap family and never enters Map cursor or tracing
paths.

All Map consumers use this owner API: construction, grouping, ordinary and direct
methods, computed insertion, callbacks, iterator protocols and fast drains,
structured-clone snapshots, tracing, finalization, and remembered-owner accounting.
Callback argument spans remain rooted while callable Proxy trap getters can mutate
the collection and collect. Stored-key profiling records successful insertions;
lookup inputs do not change that population. Storage counters separately record
allocations, promotions, compactions, and domain transitions.
