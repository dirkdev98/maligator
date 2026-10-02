# Specialized property storage

`MalTable` owns object property dictionaries. Map, Set, weak collections, VM atoms,
registered symbols, and native source caches have separate owner stores. The
property row is two words: an encoded key with metadata, and a full tagged value
or full native pointer to an owned accessor sidecar. The descriptor and shared
grouped hash index retain their existing roles.

## Key and metadata word

| Bits  | Meaning                                                       |
| ----- | ------------------------------------------------------------- |
| 0–47  | String/symbol pointer payload or zero-extended unsigned index |
| 48–49 | Dead, index, string, symbol                                   |
| 50–56 | Seven property flags                                          |
| 57    | Owns a RAW accessor sidecar                                   |
| 58–63 | Six secondary hash bits                                       |

This encoding uses the same 48-bit pointer payload as `MalValue`; it does not
require a narrower address space or spare alignment bits. The word itself is not
a `MalValue`. All owner iteration, hashing, barriers, and cached-key checks decode
or mask it explicitly. Reconstructing a string or symbol value needs no heap-header
read, so dead-member reclamation cannot make RAW-only teardown dereference a key.

The admissible key families are INDEX, STRING, and SYMBOL. Index inputs represent
0 through 2^32−2; alternate tagged-integer and integral-double spellings normalize
to the same unsigned index. Hashing and exposed decoded keys use `mal_key_index`.
An explicit STRING such as `"1"` retains its string family; ToPropertyKey conversion
belongs to the caller. Symbols, including private names, compare by identity.
Invalid internal key families or out-of-range indices abort at the owner boundary.

Strings compare by content and need not be VM atoms. Lookup and deletion accept
borrowed stack probes without retaining them. An equal insertion preserves the
stored representative. Consequently neither nonatom native-host property names
nor equal strings from different VMs depend on atom pointer canonicality.

## Filtering and small dictionaries

The grouped index retains its seven-bit tag from mixed-hash bits 57–63. The row
uses disjoint mixed-hash bits 51–56. After both metadata filters, unequal string
identities compare cached full 64-bit content hashes before content equality.
Every inserted string has already been hashed, and indexed queries calculate the
query hash before probing. Equal hashes still require content equality.

Up to four physical rows are scanned without an index. Tiny queries and cached
handle validation avoid forcing a query string hash. Exact identity remains the
first equality check. Compared with the former full 32-bit row fingerprint, the
13 combined metadata bits admit more candidate string-header loads; the full
content-hash gate preserves cheap rejection before comparing string units. That
cache-locality tradeoff needs workload evidence, especially for missing strings.

## Ownership, order, and GC

Kind zero marks a dead row. Flags and sidecar ownership survive deletion because
property transitions set payload ownership and descriptor flags independently.
Dead accessor sidecars are freed once during compaction or owner teardown. The
second word remains a full pointer; it is never interpreted as a value while the
independent ownership bit is set. Inline property values may include internal
`MAL_VALUE_EMPTY`, so values cannot act as this owner's liveness sentinel.

Handles remain one-based order indices. Growth moves storage without renumbering;
compaction advances the handle epoch. Pins prevent renumbering, and clear followed
by insertion appends after the preserved dead positions. Dense-index shortcuts
validate the encoded index, and private hints validate exact symbol identity.
Cross-table hints require a live inline-value row with the matching key.

The property MOP still owns generational cards and accessor-edge SATB shading.
The table shades removed keys and inline values after decoding the key word.
Tracing visits only live decoded rows and reads descriptors through the existing
property API. Owner teardown and compaction of dead rows inspect RAW ownership
only and never hash or dereference dead members. No collector scheduling change is
part of this representation.

A reserved dictionary with 64 rows requests 1024 row bytes instead of 1536;
descriptor, grouped index, accessor sidecars, and allocator slack are additional.
This is a representation guarantee, not a claim of universal speed improvement.
The ABI fixture covers charged storage, numeric spelling and key-family boundaries,
borrowed and nonflat strings, colliding fingerprints, flag/ownership transitions,
private hints, pinned cursors, stale handles, owner cards, minor/major tracing, and
RAW release after member reclamation.
