# Text algorithms: costs and remaining work

This document describes the current string, search, property-key, construction,
encoding, and JSON algorithms. The [storage decision](decisions/encoding-aware-text.md)
owns representation and ownership contracts; the [roadmap](../TODO.md#strings-and-text)
owns unfinished work. Measured results and tested revisions belong to the PR and
retained benchmark reports. An algorithmic bound alone does not explain a timing
change.

## Cost model

Let N count consumed UTF-16 units, R visited rope nodes, H rope height, M needle
units, and O output units. Shared subtrees count again when their content must be
emitted again. For JSON, V counts visited value/member occurrences, D container
depth, K retained shape-plan entries, P prototype-validation steps (including
rechecks after cache eviction), and Q cached escaped-key units. Hash-table costs
are expected bounds. User callbacks and platform number conversion have their own
costs.

| Operation                         | Current cost and qualification                                                                                                                                                                                                                                                                           | Owning implementation                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Concatenation                     | Inline results copy a bounded number of units. Larger joins reuse subtrees and rebuild affected paths; nonterminal cons children have at most three quarters of their parent's units. A <=32-unit cons with two non-cons children adds one terminal edge. Reconstruction can allocate multiple nodes.    | [String construction](../runtime/src/heap_string.c)                                                                             |
| Indexing and traversal            | Indexed access is O(H). Forward/reverse segment iteration consumes a range in O(N + R), with O(H) native scratch. GC-owned string and projected-split cursors retain a traced frontier across reentry, giving the same linear traversal bound.                                                           | [String access](../runtime/src/heap_string.h), [string iterators](../runtime/src/builtin_iterator.c)                            |
| Hashing                           | An uncached hash streams content in O(N + R), reusing a cached left-prefix FNV state when available. Append-and-hash retains prefix reuse through rebalancing; repeated full hashes are O(1).                                                                                                            | [Hashing](../runtime/src/heap_string.c)                                                                                         |
| Equality and ordering             | Linear in the examined content and visited nodes. Identity, unequal cached hashes, contiguous leaves, and matching shared rope structure provide shortcuts. Equality does not compute missing hashes; equal hashes do not prove equality.                                                                | [Comparison](../runtime/src/heap_string.c)                                                                                      |
| Slicing                           | Descent costs O(H); complete ranges reuse subtrees. Partial cross-child ranges copy their content. Flat dependent slices retain one flat parent under the retention policy.                                                                                                                              | [Slice construction](../runtime/src/heap_string.c)                                                                              |
| Search                            | Needles of at least 32 units use streaming KMP: O(N + M + R) work and O(M + H) scratch. Short-needle filters retain low setup cost; cross-leaf candidate verification can add root seeks. Reverse traversal can stop at the first suffix match.                                                          | [String search](../runtime/src/builtin_string.c)                                                                                |
| Builder                           | Geometric growth and one width promotion give amortized linear append copying. Finish may scan/narrow UTF-16 content or copy disproportionate capacity; trim allocation failure preserves the valid original allocation.                                                                                 | [Text buffer](../runtime/src/text_buffer.c)                                                                                     |
| Property keys                     | Queries reuse existing atoms without inserting missing names. Shapes hash ropes without materialization; transition indexes avoid unbounded sibling-list scans for ordinary hash distributions. Untraced ICs admit only stable identities; repeated transient misses still pay normalization and lookup. | [Key resolution](../runtime/src/intrinsics.c), [shape indexes](../runtime/src/shape.c), [property ICs](../runtime/src/vm_ops.c) |
| UTF-8 boundary                    | Decoding grows compact storage with emitted units. Buffer encoding counts bytes and writes an exactly sized adopted buffer. Both are linear passes; remaining temporary C-string encoders still reserve an upper bound.                                                                                  | [UTF-8](../runtime/src/utf8.c), [Buffer conversion](../runtime/src/runtime/node_buffer.c)                                       |
| JSON parsing and reviver metadata | Token traversal is sequential; small integers accumulate during validation and other numbers use token-local byte scratch. Object source records build a last-occurrence hash index on demand, avoiding a backward member scan for each reviver lookup.                                                  | [JSON parser and source records](../runtime/src/builtin_json.c)                                                                 |
| Generic stringify                 | Active-path membership is expected O(1) per container, with O(D) live identities. Native recursion has a 512-container cap and the VM's actual stack bound; pretty-printing and callbacks can add work independently of traversal.                                                                       | [Generic JSON serializer](../runtime/src/builtin_json.c)                                                                        |
| Plain-data stringify              | Iterative traversal with expected O(V + O + K + P + Q) work, plus string traversal. Optional caches have fixed admission budgets; frames and active-path state remain O(D). Late unsupported descendants resume generic traversal on the active stack while retaining completed output.                  | [Guarded JSON serializer](../runtime/src/builtin_json.c)                                                                        |
| JSON quoting                      | O(N + O + R), including bounded escape expansion. Safe Latin-1 and ordinary UTF-16 runs use word scanning; quoting stops for escapes and surrogate handling, including pairs across leaves.                                                                                                              | [JSON quoting](../runtime/src/builtin_json.c)                                                                                   |

## Rope ownership, balancing, and sequential work

A nonterminal cons-to-cons edge reduces remaining logical length to at most three
quarters. Flat/dependent leaves and a cons of at most 32 units whose children are
both non-cons are terminal for balancing. The short cons adds at most one edge;
its reuse avoids transient reconstruction in small concatenation chains without
copying payloads. This bounds height in terms of code-unit length even when leaf
sizes differ greatly. Joins
prefer existing boundaries in the middle half of a subtree. Always splitting at
the exact midpoint would repeatedly cut leaves and rebuild prefixes. Flattening
a shared child preserves the bound because it removes edges without changing
lengths. The [32-byte representation](decisions/encoding-aware-text.md#representation-and-ownership)
contains no height field.

Partial slices crossing a cons boundary copy their requested range after descent.
Dependent slices retain flat parents only. This prevents repeated operations such
as `s = (s + chunk).slice(chunk.length)` from retaining an unbounded history of
previous windows. Full-subtree reuse remains valid. A future lazy cross-rope slice
must prune excluded ancestry and preserve the same retention guarantee; comparing
only the immediate parent's length is insufficient.

The segment iterator retains its traversal stack and supports both directions.
Its current record exposes a flat owner and offset for token-local construction.
Consumers must dispose or reacquire borrowed traversal state before JavaScript
reentry or a representation-changing bridge. A traced leaf identity can survive
those events if its payload is obtained afresh afterward.

The JavaScript iterator lazily allocates a GC-owned cursor for rope input. Its
current leaf and pending-node frontier are independently traced, so flattening
the original source cannot release nodes still needed by iteration. Each step
reacquires the payload; frontier changes use SATB deletion and minor-GC cards.
Native scratch is released on exhaustion or cursor finalization, and tracing the
mutable frontier stays on the mutator. Flat input retains direct unit access.
Compiler-projected split on rope input roots the same cursor across JavaScript
bodies, together with an owned KMP pattern prepared once when a match is possible.
Both traverse consumed units and visited nodes linearly across yields. Initially
flat or dependent split inputs retain an offset and the separator without a new
cursor allocation. They cannot acquire rope ancestry through materialization.
Each successful match consumes a disjoint separator-length range, so repeated
pattern setup on that path still totals O(N + M) work. An overlong separator also
retains the offset path and skips traversal and pattern allocation.

FNV hashes process each unit's low byte and high byte, including Latin-1's zero
high byte. A cached prefix is a valid continuation state; arbitrary final child
hashes cannot be combined as though they were independent blocks. If balancing
changes the physical prefix edge, construction can continue the original cached
prefix with the appended suffix and cache the resulting full hash. This preserves
append-and-hash scaling, but can hash that suffix before a caller requests the
result's hash. Measure that work separately from descriptor allocation and first
versus repeated hashes.

## Search and compact consumers

The long-pattern path owns its UTF-16 needle and KMP prefix table and streams the
haystack through leaf segments. Reverse search reverses the owned pattern and
consumes segments from the requested end; it returns immediately on the first
complete match. Comparisons remain by UTF-16 units, including NUL, lone
surrogates, and pairs split across differently encoded leaves.

Split and replacement use persistent nonoverlapping search cursors within a
native operation. Split's bounded initial match plan can resume from its first
unplanned match. Literal replacement counts output, streams matches again, and
copies source ranges sequentially. Replacement templates also scan and copy
literal runs sequentially. Functional `replaceAll` collects match offsets and
disposes borrowed traversal state before calling JavaScript; callbacks may then
materialize strings, collect, or throw. Output size, stored offsets, and callback
work remain separate from the search bound.

Latin-1 well-formedness and no-op trim preserve the input representation. ASCII
case conversion uses compact construction and returns unchanged input when
possible; Unicode and locale-sensitive paths retain their required interfaces.
Single-argument `concat` shares a balanced prefix beyond the inline case, while
multiargument concat builds compact output. Repeat and padding use encoded
self-copying; the existing large-result lazy repeat path remains available.
Observable receiver and argument coercion order is unchanged. See
[string builtins](../runtime/src/builtin_string.c).

Array length-key checks reject the wrong length before borrowing one small
segment. Path predicates read only required units; normalization copies segments
into its required mutable UTF-16 scratch without widening the input. Header
validation, comparison, lowercase construction, trimming, and joining consume
compact segments. A nearby regex or Unicode bridge is not automatically avoidable
when the downstream consumer already requires contiguous UTF-16. See
[array keys](../runtime/src/array_object.c), [path operations](../runtime/src/runtime/node_path.c),
and [headers](../runtime/src/runtime/web_headers.c).

## Property queries and retained identities

Property-query conversion returns an existing canonical atom when one exists;
otherwise it returns the transient string without adding it to the VM atom table.
Stored property names still use atomization. Conversion preserves indices,
symbols, and one-time coercion, and roots the resulting key across observable
trap-method lookup, getters, and proxy calls.

Property ICs and shared stubs are untraced, so admission requires an immortal
string or a VM-rooted property atom. A transient query does not clear unrelated
existing rows. Shape-cache hits retain the shape-owned name; negative entries
admit only stable names. Unique missing queries therefore do not themselves add
VM-lifetime atom roots or leave untraced cache pointers into collectable rope
graphs. Repeated transient misses still pay query normalization and ordinary
lookup. Bounded tiny-string caches and explicit user storage remain independent
sources of retention. See
[query preparation](../runtime/src/vm_ops.c),
[atom resolution](../runtime/src/intrinsics.c), and [shape caches](../runtime/src/shape.c).

A successful normal `Map.set` may refresh an equal primitive string's stored
representative after lookup or validated entry-hint resolution. Inline strings
are eligible. Owned strings must fit the allocator charge of their visible
payload using actual RAW capacity; if either equal string is known Latin-1, that
charge uses one byte per unit. This rejects oversized buffers, failed trims, and
backing growth caused by widening a known compact key. Cons, dependent, and
external query strings are excluded from representative refresh.

The existing entry traces the replacement, with a deletion barrier for the old
key and the owning Map's young-edge card. Hash/probe state and insertion order do
not change, and no query-cache field is added. Repeated accesses using the refreshed
query can become identity hits; accesses using the previous equal string can still
compare content. Reads alone do not refresh representatives. This applies to normal
Map entries, with WeakMap lifetime behavior unchanged. See [Map builtins](../runtime/src/builtin_map.c),
[table entries](../runtime/src/table.c), and [RAW capacity](../runtime/src/heap.c).

## JSON traversal and metadata

Number validation accumulates an integer magnitude while scanning and directly
admits integral literals within the exact integer range, preserving negative zero.
Fractional, exponent, and larger literals use the original token's byte scratch
for `strtod`, without rereading the source rope. A string confined to the current
leaf can retain a safe slice of that owner; crossed segments are copied while
the cursor advances. These paths avoid root reseeks when token ends fall at or
inside leaf boundaries. The runtime's sequential validation/copy bound does not
establish a universal bound for the platform number converter.

Reviver source lookup builds a canonical-key hash index lazily for each object's
parse records and retains the last occurrence of duplicate keys. Property order,
source ranges, and reviver mutation semantics remain separate from this index.
Syntax records for overwritten members remain allocated until parse/reviver
cleanup, so memory follows parsed input rather than only the final object.

Parsing, generic serialization, and reviver traversal remain recursive. Before
entering another container, they check the 512-container limit and the VM's
current native stack bound; a small scheduler fiber or sanitizer frame may reach
the stack bound earlier. Exhaustion throws `RangeError`. Parse-node cleanup is
allocation-free and iterative, including error cleanup. Generic serialization
uses an active-path pointer set, removing identities as frames return so repeated
non-cyclic children remain valid. The guarded plain serializer uses heap frames
and is not subject to the recursive container cap.

The plain serializer checks eligibility without executing hooks. At an unsupported
descendant it rewinds only the current member's uncommitted separator/key, roots
active holders and remaining keys, and resumes generic serialization while
unwinding the existing stack. Original key lists, array lengths, completed output,
and active-cycle membership survive; callbacks may mutate subsequent values.
No cached slot or prototype proof is reused after reentry. This avoids serializing
the completed prefix twice and adds no getter, proxy trap, replacer, or `toJSON`
invocation. Continuation retains its root list until the operation ends, including
holders disconnected by callbacks; this conservative lifetime is bounded by the
saved active stack and remaining keys at fallback. Shape/prototype
maps and active-path checks already use hash tables; the parser's small shaped
object duplicate scan remains capped at 32 names.

Optional plain-serializer caches share a 64 KiB budget for requested shape-plan
bytes and encoded-key buffer capacities. Shape and prototype maps each retain at
most 256 entries and use at most 512 pointer-map slots, adding at most 16 KiB of
entry storage. The resulting 80 KiB accounted cache bound excludes allocator
headers and RAW size-class rounding; it is not a resident-memory bound. Traversal
frames and the active-path set are separate depth-dependent scratch.

After shape admission stops, eligible objects walk their validated immutable
shape directly and quote keys into final output. Cache exhaustion neither discards
output nor enters the generic serializer. A key is first quoted into final output;
its encoded range is retained only when predicted buffer growth, including width
promotion, fits the remaining budget. A declined key stays uncached. Prototype
proofs use bounded rotating eviction, caching at most the nearest 256 nodes of a
validated chain. Eviction can repeat prototype-validation work, so cache bounds
do not imply a universal constant-time eligibility check.

Ordinary UTF-16 quote runs use four-unit word scanning after a short scalar prefix.
Scanning stops before controls, quote, backslash, or any surrogate; the existing
scalar path then handles escaping and pairs across leaves. Short and dense-escape
runs retain a scalar path. This avoids repeated scalar probes for long BMP runs
without changing the output or materializing input strings. Plan/key capacity,
reuse, discarded-output, quote-probe, and parser-seek counters describe these JSON
costs. `scripts/profile-text-pipeline.ts` measures nested intervals within the
complete mixed pipeline and reports sampler and marker overhead separately.
Its eight controls retain early/late wide units, sparse/dense escapes, BMP runs,
and split/joined surrogate pairs. Phase shares include instrumentation overhead;
isolated quote probes do not establish a production timing share.

## Construction and external encoding

`MalTextBuffer` starts compact, grows geometrically, and promotes when necessary.
An individual failed growth preserves its old allocation. A segmented append may
have committed earlier segments before a later failure; append is not
transactional, and rollback neither releases capacity nor clears a sticky error.
A UTF-16 buffer flag alone does not prove wide units survive truncation.

Finish attempts an exact RAW copy for a non-inline result when capacity exceeds
1,024 units and the used length is below half the capacity. This avoids transferring
disproportionate slack in normal operation. The copy is fallible: if it fails, the
original valid allocation is still transferred, so the retention bound is best
effort under allocation failure. Ordinary finishes transfer ownership directly;
tiny outputs use inline storage. RAW reallocation itself still does not shrink.
See [builder ownership](../runtime/src/text_buffer.h).

The shared UTF-8-to-string decoder grows with emitted code units, starts in
Latin-1, copies ASCII runs in bulk, and promotes for wider content. A known-wide
result uses the owned UTF-16 constructor without another narrowing scan. Decoded
UTF-16 units, including replacement characters and both units of an astral scalar,
determine the string limit. Encoded input bytes can legitimately exceed that
limit. Where the API strips a leading BOM, stripping precedes the decoded-length
check. Buffer, streaming decoders, and relevant host input paths share this logic.

UTF-8 Buffer output first counts encoded bytes, then writes and adopts an exactly
sized allocation. This trades a second sequential pass for bounded retained
backing. Surrogate pairing works across leaves; lone surrogates become replacement
characters at the external boundary. Bounded encoding never splits a scalar and
reports consumed UTF-16 units. Temporary C-string and TextEncoder allocation
paths still use the existing `3N + 1` upper bound; the malloc UTF-16 decoder remains
for path operations that require mutable UTF-16 scratch.

## Acceptance and measurement

Use the relevant row below and retain the existing six text workloads as controls.
Build intended physical representations at runtime or with explicit C constructors;
constant-folded literals can invalidate a rope or compact-storage experiment.

| Target                         | Inputs that expose the cost                                                                                                  | Acceptance evidence                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mixed construction and quoting | Latin-1, early/late wide units, BMP, emoji, lone surrogates; sparse/dense escapes at each alignment                          | Complete output; paired time, allocation, promotion, copied units, and quote probes                           |
| Search                         | Repeated-prefix misses, overlaps, increasing N/M, both chain directions, cross-leaf hits, clamped offsets                    | Flat UTF-16 oracle; active comparison/traversal counters showing the intended bound                           |
| Ropes, hashes, keys            | Balanced, append, prepend, random joins and large terminal leaves; first/cached hashes; fresh-equal/unique keys              | Content and GC checks; cons-edge weight, height, visited nodes, hash units, cache hits, and timings           |
| JSON traversal                 | Tokens ending inside/on leaf boundaries; growing reviver key sets; compact deep chains, identity replacers, scheduler fibers | Values, negative zero, duplicate source records, callback order, lookup/seek counts, controlled depth failure |
| Caches and fallback            | Repeated/one-use shapes; unsupported descendants at beginning/middle/end; Map mutation and representative retention          | Plan/key/backing bytes, reuse, discarded output, callback traces, quiescent retention, and time               |
| Encoding                       | ASCII/non-ASCII, malformed/streamed data, decoded max/max+1, BOM, tiny finishes and truncated large builders                 | Exact bytes/units; sticky failure behavior, RAW/adopted capacity, and live storage after collection           |

Instrumented custom C entrypoints must initialize performance statistics and run
with them enabled. Require positive relevant counter deltas before checking upper
bounds; a compiled instrumentation flag alone does not establish that measurements
ran. Keep timing runs separate from GC instrumentation, retain complete checksums
and source/toolchain identity, and report dispersion and unfavorable controls.
Measure retained live storage after a defined quiescent collection separately from
allocation traffic, allocator capacity, and RSS.
