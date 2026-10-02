# Grouped hash indexing

Strong Map storage, Set storage and the property-only MalTable share an index
format in `hash_index.h`. Ordered payloads remain owned by their stores: index
buckets contain four-byte order indices and one-byte metadata. Lookup filters 16
metadata bytes before accessing candidate payloads. A seven-bit tag comes from the high hash
bits; the existing avalanche hash supplies both positioning and tags.

Groups start at aligned 16-bucket boundaries. Power-of-two capacities begin at 16,
and triangular group strides visit every group. NEON and SSE2 form candidate masks;
other targets, including the current scalar WASM build, use identical scalar
matching. Loads stay within allocated groups. A complete unsuccessful cycle aborts
rather than hiding a broken occupancy invariant in an infinite probe.

Lookup checks every candidate tag in a group before stopping at EMPTY. DELETED
never terminates a search. Insertion remembers the first reusable deleted bucket
and uses it only after establishing absence. Deletion changes a bucket to EMPTY
when its group already contains EMPTY; otherwise it uses DELETED. This proof relies
on aligned group starts and must be replaced if arbitrary starts are introduced.

Live entries plus hash tombstones stay at or below seven eighths of bucket capacity.
Reusing DELETED consumes no additional occupancy. An insertion that would exceed
the limit rebuilds the index at the same capacity when live entries still fit,
or doubles it when they do not. Index rebuilding does not relocate ordered entries,
change handle generations, or require iterator pins to be released. Ordered
compaction remains the owner's operation and still respects pins.

Set retains its four-member inline scan. MalTable scans up to four physical
entries without an index, then promotes; reserve can install an index earlier.
This avoids a 16-bucket allocation for tiny dictionaries. Property flags, owned
accessor data, private-symbol hints, entry handles, and collector barriers remain
MalTable contracts. Its [property rows](specialized-property-storage.md) encode
key identity, flags, ownership, and a secondary tag in 16 bytes; candidate strings
still compare by full content. Map owns its packed payload and four-pair inline store; it
shares the index without carrying property metadata or accessor ownership.

WeakMap and WeakSet use the same control/probe primitives with direct identity
buckets, as described in [unordered weak storage](specialized-weak-storage.md).
The [VM intern stores](specialized-intern-stores.md) also use direct buckets, with
typed string/symbol payloads. Those insertion-only stores have no tombstones,
ordered payloads or index lane. Sharing grouped probes does not require sharing
storage ownership, payload equality or collector behavior.

Hash tombstones and ordered tombstones have independent counters and lifetimes.
Clear resets hash metadata even when pins retain ordered history. Bulk filtering
rebuilds surviving buckets without moving payloads. Finalization only frees storage;
it must not hash keys that may already have been collected.

`[perf-hash-index]` reports groups examined, candidate payload checks, tombstone
reuse and index rebuilds. Table `probes` now counts candidate payload checks,
including tiny-store comparisons, rather than every occupied scalar bucket.
The typed VM stores also attribute groups, candidates and growth to their own
`[perf-intern-store]` records. Ordinary timing builds compile these counters out.
Allocation arithmetic checks 32-bit limits before multiplying, and occupancy
comparisons avoid multiplication.

This format follows the candidate filtering described by
[Abseil Swiss tables](https://abseil.io/about/design/swisstables), with aligned groups
and a separate ordered payload. F14 overflow accounting and Robin Hood displacement
remain alternatives when measured churn or target behavior warrants their additional
maintenance invariants.
