# Encoding-aware text

JavaScript string positions and lengths count UTF-16 code units. Physical string
storage is independent: a flat string can store each unit in one byte when all
units are at most `0xff`, or in two bytes otherwise. Latin-1 is a storage encoding,
not an external serialization format. Embedded NUL and lone surrogates remain
ordinary string content.

## Representation and ownership

The string cell remains 32 bytes: a four-byte heap header, a four-byte metadata
word, an independent eight-byte hash, and a sixteen-byte payload. The metadata
packs a 25-bit length with storage and content flags, preserving the inclusive
16,777,216-code-unit engine limit. Dependent offsets share the payload with the
other representation-specific fields.

| Storage   | Payload                                     | Ownership and retained edges         |
| --------- | ------------------------------------------- | ------------------------------------ |
| Inline    | Sixteen Latin-1 units or eight UTF-16 units | Inside the string cell               |
| Owned     | Contiguous Latin-1 or UTF-16 units          | GC-accounted RAW allocation          |
| External  | Borrowed Latin-1 or UTF-16 units            | Provider retains the backing storage |
| Dependent | Parent plus UTF-16 offset and length        | One flat parent                      |
| Cons      | Left and right strings                      | Children retain their own encodings  |

Copied UTF-16 input is compacted when eligible. Builders and decoders construct
Latin-1 directly. A caller that proves owned UTF-16 content contains a wider unit
can use `mal_string_new_utf16_owned` without a redundant narrowing scan. Emitted
and wire-loaded UTF-16 literals remain valid external strings.

Cons joins preserve a weight bound: a nonterminal cons child occupies at most
three quarters of its parent's code units. Flat/dependent leaves and a cons of at
most 32 units with two flat/dependent children are terminal for balancing. The
short terminal cons adds at most one edge, avoiding reconstruction of tiny
intermediates without copying their content. Height remains logarithmic in
logical length without adding a height field. Joins reuse existing boundaries in the middle half of a subtree
and rebuild included paths; they split a flat leaf only when necessary. Existing
strings and shared subtrees keep their identities. Later materialization can
remove edges without invalidating the bound.

Slices retain a parent and an offset, never an interior payload pointer. A compact
parent can therefore widen without invalidating a slice. Construction resolves
nested slices and descends into containing rope children. Tiny slices and partial
ranges still crossing children copy their requested content; full subtrees may be
reused. Dependent slices retain flat parents only, preventing a sliding window
from retaining an unbounded chain of earlier ropes. A slice copies when its owned
flat parent exceeds 4,096 units and the retained range is less than one eighth of
that parent. External parents do not charge an owned backing buffer to the slice.
Any future lazy cross-rope slice must prune excluded ancestry and preserve this
transitive retention contract.

## Traversal and contiguous access

`MalStringIterator` yields contiguous leaves with an encoding tag and UTF-16-unit
length. Forward and reverse traversal use the same iterative stack; a reverse
iterator yields leaves right to left while each returned segment retains forward
unit order. Its current record identifies the flat owner, local offset, and visible
length. A single-leaf range can use `mal_string_try_get_segment`, and
`mal_string_get_leaf_range` resolves a visible range to its flat owner.

Traversal does not collect, invoke JavaScript, flatten, or widen strings. Segments
borrow payload storage, and pending iterator entries borrow descriptor identities.
Keep the source graph rooted during use. Dispose or reacquire traversal state
before JavaScript reentry or a bridge that could materialize that graph. Rooting
a mutable source alone does not keep its former children alive after flattening.
A separately traced identity can survive reentry when consumers obtain its
payload afresh. `MalStringCursor` owns a GC-traced current leaf and pending-node
frontier, with native scratch finalized on exhaustion or collection. Persistent
frontier storage and search patterns use owner-held RAW buffers, so abandoned
iteration contributes its full allocation cost to GC pacing and iterator profiles.
Frontier updates publish removed edges through SATB and new edges through the cursor's
minor-GC card. The cursor itself remains on the mutator's tracing path. JavaScript
string iterators use it lazily for ropes; flat strings retain direct unit access.
Sequential traversal visits consumed units and pending nodes once even if a
callback flattens the source and disconnects its former children.

`mal_string_code_units` is an explicit contiguous UTF-16 bridge. It can allocate
and widen a compact leaf or flatten a rope; a dependent slice resolves the bridge
through its parent. Its returned UTF-16 pointer is stable while the string is
retained. Existing regular-expression and Unicode integrations can use that
interface when they require contiguous UTF-16. Sequential consumers use segments.

Allocation requests a later GC poll; it does not itself collect or invoke
JavaScript. New retained edges use card/SATB publication, and representation
changes preserve publication of removed parent/child edges. Concurrent tracing
does not inspect mutable string descriptors while the mutator runs. RAW ownership
remains explicit through construction, adoption, and finalization.

## Content identity and property keys

Hashes retain the FNV64 contract over the low byte and high byte of each UTF-16
unit, including Latin-1's zero high byte. Equal content has equal hashes across
encodings and rope partitions. Every representation caches its full hash
independently of its payload, and content-preserving representation changes retain
that hash.

A cached left prefix is a valid FNV continuation state. Hashing can stream only
the appended right content; balancing preserves that prefix state when it changes
the physical prefix edge. Arbitrary final child hashes are not independently
composable. Hashing preserves storage and borrowed segment lifetimes. Equality
and lexical ordering first recognize pointer identity. Equality may reject
unequal valid hashes but neither computes missing hashes merely for comparison
nor treats a hash match as proof of equality. The bounded tiny-string cache has
256 entries and accepts up to eight UTF-16 units.

Property queries reuse an existing canonical atom or return the original transient
string without inserting a missing name. Stored names still use atomization.
Query conversion preserves indices, symbols, coercion order, and roots across
observable trap-method lookup and calls. Property ICs and shared stubs admit only
immortal strings or VM-rooted atoms because those caches are untraced. Shape-cache
hits retain shape-owned keys; negative entries require the same stable-name
contract. Rope keys participate in shape hashing without materialization. See
[query and cache costs](../text-algorithms.md#property-queries-and-retained-identities).

Normal `Map.set` may replace an equal primitive string's stored representative
with an inline string or a tightly owned flat string, after resolving the same
entry. Owned admission checks actual RAW capacity against the visible payload's
allocator charge and uses Latin-1 width when either equal string is known compact.
Rope, dependent, external, over-reserved, and widening representations that exceed
that charge are excluded. The existing traced entry and Map card retain the new
key, and a deletion barrier preserves the old key during an active snapshot. Hash
and insertion order stay unchanged. Reads do not refresh keys, and WeakMap keeps
its existing lifetime semantics.

## Search and compact builtin results

Long-pattern search uses an owned UTF-16 needle and KMP prefix table over segmented
haystacks. Needles of at least 32 units use this path for individual forward and
reverse searches; smaller needles retain low-setup candidate scans. Reverse
traversal stops at the first complete match from the requested end. All comparison
positions are UTF-16 units, including across encoding and leaf boundaries.

Split and replacement can keep nonoverlapping search and copy cursors across
allocation-only work. Functional `replaceAll` collects offsets and disposes its
borrowed cursor before invoking JavaScript. Replacement-template literal runs
also stream sequentially. Compiler-projected split iteration on rope input roots
a `MalStringCursor` across arbitrary JavaScript bodies. Its owned pattern and KMP
prefix table are prepared once when a match is possible; the frontier resumes
the haystack without a new root descent or pattern setup after each yield.
Initially flat or dependent inputs retain the allocation-free offset path and
cannot gain rope ancestry through materialization. An overlong separator also
uses that path without pattern setup or traversal. Exhaustion frees native
scratch, and GC handles abandoned cursors after abrupt loop exits. No borrowed
payload pointer survives a JavaScript body.

Projected split/trim consumers scan only each field's whitespace boundaries. They
preserve the shared subject's rope structure and compact width, so trimming the
first field does not materialize the input before subsequent cursor advances.

Latin-1 well-formedness and no-op trim preserve compact inputs. ASCII case changes
use compact output, with identity results when unchanged; Unicode/locale fallbacks
retain required bridges. Single-argument concat shares a balanced prefix beyond
inline results, multiargument concat uses the builder, and repeat/padding use
encoded self-copying while retaining the large lazy-repeat path. These paths
preserve observable coercion and callback order.

## Shared construction and external encoding

`MalTextBuffer` starts in Latin-1, promotes to UTF-16 when needed, and measures
length/capacity in code units. It accepts units, Latin-1 spans, string ranges,
complete strings, buffers, ASCII, and decimal integers. Source ranges cannot alias
the destination allocation; explicit self-append handles that case.

Growth uses fallible GC-accounted RAW reallocation. Reused capacity and backwards
promotion avoid unnecessary copies. A failed growth preserves the old payload,
ownership, and allocation accounting; overflow is detected before reading input.
A segmented append can have committed earlier segments before later failure.
Append is not transactional, and rollback preserves capacity/encoding without
clearing an error. Producers may hint final capacity; the first content chooses
the initial width. Explicit reservation remains eager for direct buffer writers.

Finish normally transfers RAW ownership; tiny results use inline storage. For a
non-inline result with capacity above 1,024 units and length below half capacity,
finish attempts an exact-size RAW copy because RAW shrinking is otherwise a no-op.
If trimming fails, it still transfers the valid original allocation. This is a
best-effort retained-capacity bound, not a new failure of an otherwise complete
output. UTF-16 finish may narrow content: truncation can remove every wide unit.

The shared UTF-8 decoder builds directly in compact storage, copies ASCII runs,
and promotes only when emitted units require it. Decoded UTF-16 units determine
the string limit, including replacement characters for malformed input. APIs that
strip a leading BOM do so before applying that decoded-length limit. Streaming
state preserves incomplete sequences and BOM handling; TextDecoder borrows input
unless it must join pending bytes. Buffer, StringDecoder, TextDecoder, and relevant
host input paths share the decoder. A known-wide decoded result avoids another
full-width scan at finish.

UTF-8 Buffer encoding counts bytes before writing and adopts an exactly sized
allocation. Surrogate pairing works across leaf boundaries; lone surrogates use
replacement characters at the external boundary. Bounded encoding never splits
a scalar and reports consumed UTF-16 units. Temporary host C-string and TextEncoder
encoders still reserve `3N + 1`; path normalization retains a malloc UTF-16 decoder
and mutable scratch where its algorithm requires them.

## JSON

The parser consumes a segmented cursor. It accumulates small integer magnitudes
while validating; fractional, exponent, and larger numbers retain their original
token in byte scratch for conversion, preserving negative zero. Unescaped strings
within one leaf can retain safe slices using that leaf's owner/offset. Cross-leaf
and escaped tokens append consumed segments to compact output without source-root
reseeks. Source ranges remain absolute UTF-16 offsets.

Reviver source records lazily index canonical keys and the last duplicate
occurrence, preserving property order and `context.source`. Parse records retain
overwritten syntax members until cleanup. Cleanup uses an allocation-free iterative
list. Parsing, reviver traversal, and generic serialization check both a
512-container recursive limit and the VM's native stack bound, throwing
`RangeError` before another container when a bound is reached. Small fibers and
sanitizer frames can reach the stack bound earlier.

Generic serialization prepares property values in observable order and writes
directly to final output, preserving getters, proxies, `toJSON`, replacers,
omission, and indentation. An active-path pointer set detects cycles while
allowing repeated non-cyclic children. Serializing frames root active objects
across callbacks.

A guarded serializer handles eligible ordinary shaped objects and packed arrays
iteratively. It proves the absence of observable hooks over relevant prototypes,
rejects unsupported storage/exotics, and uses active-path identities for cycles.
Per-call shape plans reuse property order/slots and escaped keys; the rooted input
graph remains immutable throughout this callback-free traversal. It uses heap
frames and is not subject to the generic recursive container cap.

Optional cache admission allows 64 KiB of requested plan bytes and encoded-key
buffer capacities. Shape/prototype maps each hold at most 256 entries, using at
most 16 KiB of entry storage together. This bounds accounted cache payload/capacity
to 80 KiB, excluding allocator headers and RAW size-class rounding. Active-path
identities and traversal frames remain separate depth-dependent scratch. Shape
admission stops at the limit; eligible uncached objects walk their immutable
shapes and quote directly into final output. A quoted key is retained only when
its cache growth, including width promotion, fits. Declining optional caching
causes neither output discard nor generic fallback. Prototype proofs use bounded
rotating eviction, so eligibility may revalidate a prototype chain.

Replacers, property lists, and indentation select the generic path from the start.
When plain traversal reaches an unsupported descendant, it rolls back only the
current member's uncommitted separator/key and resumes generic serialization on
the active stack. Completed output is retained. Before invoking user code it roots
all active holders and remaining snapshotted keys, preserves each original array
length, and transfers active-path cycle membership. Subsequent properties use
observable Get and preparation; shape slots and prototype proofs are no longer
reused. A callback can mutate later properties without changing the saved key
order or causing earlier hooks to run again. Generic depth limits still apply to
continuation. Caches stay within one invocation, avoiding cross-call
shape/prototype invalidation state. Quoting scans safe runs in both
encodings in bulk. UTF-16 scanning stops before surrogates so the existing pair
handling can span leaves; lone surrogates are escaped. A short scalar prefix
preserves the short-run and dense-escape path. The complete-pipeline phase profiler
measures parsing, lookup, construction, serialization, and checksum intervals,
with separate sampler and marker overhead controls; quote counters alone do not
attribute an aggregate timing change.

## Verification

[Physical encoding tests](../../tests/native/encoding-aware-strings.test.ts) cover
content identity, retained slices, bridge lifetime, and the compact
parse–lookup–append–serialize pipeline. [Rope tests](../../tests/native/string-rope-followups.test.ts)
cover weight bounds, both growth directions, mixed leaves, forward/reverse ranges,
hashing, shape collisions, and GC. [Search tests](../../tests/native/string-search-followups.test.ts)
cover adversarial patterns, callback reentry, and active comparison/traversal
counts. [Cursor tests](../../tests/native/string-cursor-frontier.test.ts) cover
detached frontier nodes, minor roots, impossible delimiters, and prefix overlap.
[Late JSON tests](../../tests/native/json-late-fallback.test.ts) cover retained
output and allocation work; [JSON callback tests](../../tests/native/json-stringify-scratch.test.ts)
cover mutation and callback order through continuation.
[Builder](../../tests/native/text-buffer.test.ts),
[encoding boundary](../../tests/native/utf8-string-storage.test.ts),
[compact consumer](../../tests/native/compact-string-boundaries.test.ts),
[property query](../../tests/native/transient-property-query.test.ts),
[Map representative](../../tests/native/map-string-representative.test.ts), and
[JSON algorithm](../../tests/native/json-algorithms.test.ts) fixtures exercise the
owning allocation, failure, lifetime, and observable-behavior boundaries. The
[behavior suite](../../tests/native/encoding-aware-text.test.ts) covers compiled
and interpreted execution with GC stress. These fixtures are selected by the
native check and sanitizer manifests.

The [algorithm cost model and acceptance matrix](../text-algorithms.md) separate
source-derived bounds from performance evidence. Use a specific baseline revision,
complete checksums, and repeated interleaved pairs for the same frozen workloads.
Instrumented custom C entrypoints must initialize and enable statistics and require
positive relevant deltas. Timing, allocation traffic, retained backing, and
quiescent live storage are distinct measurements; a native microbenchmark does
not establish whole-runtime performance.
