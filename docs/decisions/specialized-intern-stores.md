# VM intern stores

The VM owns three insertion-only stores independently of object property tables:
canonical property atoms, the Symbol.for registry, and cached native callable
source strings. MalTable now owns only property storage. It retains ordered
entries, property flags, accessor ownership, handles, epochs, private-symbol
hints and pinned traversal; the former GENERAL mode and instrumentation roles
for atoms and the symbol registry are removed.

Each typed store embeds a zero-initialized pointer/size/capacity descriptor in
MalVm. An empty store allocates nothing. First insertion allocates 16 direct
buckets with coallocated control bytes; capacities double at seven-eighths load.
The shared grouped probe supplies aligned 16-byte filtering and triangular group
strides on NEON, SSE2 and scalar targets. These stores never delete entries, so
only EMPTY and live fingerprint controls exist. No ordered payload, index lane,
property metadata, tombstone accounting or cursor pins are needed.

Atoms and registry buckets each contain one pointer plus one control byte: nine
requested bytes per bucket on 64-bit hosts. A native-source bucket contains two
pointers plus one control byte: seventeen requested bytes. Capacity slack and RAW
allocator rounding remain additional costs. Growth rehashes pointers into a new
allocation before publication; byte multiplication and capacity doubling are
checked. The old allocation is released after migration. Descriptors do not own
separate RAW allocations.

Atom lookup accepts borrowed stack strings, including Latin-1 and UTF-16 probes,
without retaining or materializing them. Insertion accepts heap or immortal
strings and returns the first stored content-equal pointer. Only that canonical
representative receives property_atom; an equal rejected candidate is not marked
as canonical. Stored pointers never change when buckets grow. Shapes, inline
caches, ASCII/hot-name caches, code-unit caches and compiled atom arrays continue
to borrow these VM-lifetime roots. Query-only property resolution does not intern
an absent string.

The symbol registry stores only MalSymbol pointers. Hashing and equality inspect
the symbol's immutable nonnull description; the ordinary symbol GC edge owns that
description. Symbol.for still performs observable string coercion before lookup,
and insertion marks the canonical symbol registered. Symbol.keyFor and the ban on
registered weak keys continue to use that flag. All realms within one VM share
the same registry.

Function.prototype.toString caches source strings in a separate name/source store.
The key is the sanitized internal callable name, including the shared empty-name
fallback, rather than the callable identity or its mutable public name property.
Names are atomized by the caller, while lookup remains content-correct for an
already-atom string originating elsewhere. Equal names preserve the first source.
VM-owned cache values never live on possibly shared or immortal string cells.

All three stores are strong VM roots. Minor, major, incremental remark and
verification root scans visit the typed buckets; registry symbols trace their
immutable descriptions through ordinary cell traversal. Source-cache scans mark
both names and sources. These insertion-only root stores need neither a managed
owner card nor a deletion SATB barrier: roots are rescanned at remark, and no edge
is replaced or removed during VM execution. Their raw payloads do not become GC
roots independently of the owning VM. Teardown releases each RAW allocation before
heap destruction and never hashes or dereferences member cells.

The scan API exposes physical bucket traversal only for synchronous GC/native
inspection. Insertion invalidates its cursor and returned bucket addresses; it is
not an ECMAScript iterator. Root scan work follows capacity rather than live size.
The new source cache also adds its own lazy allocation where the old atom table
reused a value lane. These are explicit memory/scan tradeoffs to measure, not an
unconditional speed or peak-memory claim.

`[perf-intern-store]` attributes lookups, hits, misses, novel inserts, duplicate
insertions, probe groups/candidates, growth and rehashed entries to each owner.
Its allocation_bytes counter sums allocator-charged RAW allocations over time;
the public allocation-byte accessor reports current charged ownership, excluding
the embedded descriptor. Root counters separate physical scan slots from live
root values. Property telemetry retains `[perf-table-stats] role=object`.

Runtime source discovery includes the new translation unit. Runtime source and
header hashes invalidate archives and generated application ABI consumers after
the MalVm/table changes; the portable program-image wire format does not change.
Focused tests and matched measurements determine acceptance separately from this
storage contract.
