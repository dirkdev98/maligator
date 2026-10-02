# Specialized Map storage

Map and WeakMap own `MalMapStorage`, independently of property tables. Their
index uses the shared grouped-hash implementation; their payload, equality,
mutation barriers, cursor lifetime, and tracing belong to the Map owner.

An empty Map has no backing allocation. An insertion, iterator, or nonzero reserve
hint creates a stable RAW descriptor with four inline key/value pairs. Larger Maps
with int32 keys use coallocated packed-key, tagged-value, and byte-liveness lanes
plus a grouped index. Other domains store contiguous 16-byte key/value pairs
followed by a byte-liveness lane, placing the mapped value beside the key examined
by a successful probe. The existing key domain selects the layout. Values always
occupy eight bytes; the payload uses 13 or 17 bytes per order position, excluding
index capacity, descriptor, and allocator rounding. Packed-key capacities preserve
alignment of the value lane.

The descriptor fits the 128-byte allocation class. Its inline storage shares a
union with cached hashed-payload pointers. Payload replacement copies keys, values,
and liveness before publishing the new layout; demotion snapshots all live pairs
before overwriting those pointers. Widening int32 keys creates paired storage,
while transitions between other key domains preserve their pair layout.

The key domains are int32, Number, string, identity, and generic. Insertions widen
when a novel key requires it; updates and incompatible queries never widen.
Number canonicalization preserves SameValueZero, while BigInt remains a distinct
equality domain. Strings compare by content and objects/symbols by identity.
Equal string updates can replace the stored representative only with inline or
tightly owned backing, preserving the existing retention bound and SATB barrier.

Order positions remain stable during growth, key widening, and index rebuilding.
Pins prevent payload compaction; deletion and clear leave dead positions so live
iterators observe subsequent appends. Normal exhaustion may compact after dropping
the pin. GC finalizers only release ownership or decrement pins, because member
cells may already have been reclaimed. A Map's borrowed entry hint is validated
against an encoded mirror of the live stored key. Removing that entry, clearing,
compacting, or releasing the owner invalidates the hint. A compact-string
representative replacement refreshes the mirror; an equal temporary query never
becomes a new retention edge.

Strong Maps trace every value, including Maps with numeric keys. Numeric keys
need no key tracing. WeakMaps initially use the same ordered payload, but their
entries remain ephemerons: the collector discovers all newly reachable weak owners
and reaches its key/value fixpoint before filtering dead entries. Mutator writes
retain conservative old-key/old-value barriers and card the owner for young edges.
Collector cleanup runs after marking is disabled. Unordered weak storage is a
separate change with different deletion and compaction rules.

All Map consumers use this owner API: construction, grouping, ordinary and direct
methods, computed insertion, callbacks, iterator protocols and fast drains,
structured-clone snapshots, tracing, finalization, and remembered-owner accounting.
Callback argument spans remain rooted while callable Proxy trap getters can mutate
the collection and collect. Stored-key profiling records successful insertions;
lookup inputs do not change that population. Storage counters separately record
allocations, promotions, compactions, and domain transitions.
