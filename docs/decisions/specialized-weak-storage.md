# Unordered weak collection storage

WeakMap and WeakSet have distinct heap types and owner structs. Both retain the
ordinary object prefix, prototype and own-property storage. Their values use the
ordinary object tag; exact heap predicates enforce the four collection brands.
Strong Map and Set no longer carry weak flags or weak-filtering APIs.

An empty weak collection allocates no backing. Its first insertion or nonzero
reserve hint creates a lazy RAW descriptor with four inline entries. On 64-bit
hosts, four WeakMap key/value pairs fit a 96-byte descriptor and four WeakSet keys
fit a 64-byte descriptor. The common header holds allocation pointers, live size,
bucket capacity, tombstone count and a lazy reserve hint. It has no insertion
order, cursor pins, key domain, canonicalization or entry cache.

Inline entries form a dense prefix; removal swaps the last entry into the hole.
The fifth live entry promotes to direct grouped buckets. WeakMap buckets contain
adjacent tagged keys and values; WeakSet buckets contain only tagged keys. One
coallocated control byte per bucket supplies both the hash fingerprint and
liveness. There is no separate row index. Requested payloads are 17 and 9 bytes
per bucket respectively, before capacity slack and allocator rounding.

Keys must be objects or unregistered symbols. Equality compares encoded identity,
and hashing mixes those same bits without dereferencing the key. Invalid query
values return absence before probing. Native insertion APIs require a valid weak
key; builtins report the JavaScript error before calling them. Revoked proxies
remain valid identities without invoking traps.

The store reuses the shared 16-byte grouped controls and triangular probe sequence.
All matching candidates in a group are checked before an EMPTY terminates a miss.
Live entries plus tombstones stay within the shared seven-eighths occupancy limit;
reusing a tombstone does not increase occupancy. Deletion from a group containing
an EMPTY can write EMPTY; a full group requires a tombstone to preserve searches
that continue beyond it. Capacities are powers of two with checked byte arithmetic.

Deletion can demote four or fewer survivors or shrink a store at one-quarter load.
Filtering visits buckets in place and performs at most one maintenance action
after the scan: demotion, shrinking, or a same-capacity rebuild when tombstones
occupy at least one quarter of capacity. Ordinary deletion leaves that last action
to insertion pressure. Demotion stops after copying the last survivor and skips
the copy scan for an empty store. No weak cursor survives mutation or collection.

GC traces ordinary object properties immediately and registers weak owners on the
main collector thread. WeakMap values are activated only by marked keys; newly
reachable weak owners extend the same ephemeron fixpoint. WeakSet cleanup follows
the completed fixpoint, including sets discovered through activated values.
Minor cards cover both new keys and WeakMap values so old weak owners participate
in registration and dead-young-key cleanup. Verification checks every surviving
weak key and value after cleanup.

WeakMap updates and deletions preserve conservative old-value and removed-key SATB
barriers. WeakSet deletion never shades its member. Collector filtering runs after
marking is disabled. Rehashing moves existing edges without changing reachability;
finalizers free RAW allocations without hashing or dereferencing member cells.
Profile finalization classifies encoded key tags only.

Constructors keep the captured adder and iterator protocol order, root extracted
items across getters and calls, and close iterators on abrupt adder completion.
WeakMap computed insertion roots its receiver, key, callback and result, then
re-searches after the callback because it may mutate or resize the same owner.
Direct strong-collection guards use exact strong heap predicates. Node util brands
use all four predicates, and structuredClone explicitly rejects both weak types.

`[perf-weak-storage]` separates promotions, rebuilds, demotions, requested payload
bytes, filtered entries and scanned bucket counts for marking, filtering and
rebuilding or demotion. Live-entry GC counts remain separate. Direct buckets remove order
history and index indirection but expose bucket-capacity scanning to GC; that
memory and pause tradeoff requires representative measurement. The native runtime
source and header identities invalidate affected artifacts; portable image fields
and public JavaScript interfaces do not change.
