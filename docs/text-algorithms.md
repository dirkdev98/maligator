# Text algorithms: costs and improvement targets

This audit covers string storage and traversal, search, property lookup, output
construction, encoding boundaries, and JSON. Reviewers examined areas outside
their implementation ownership, checked the relevant callers, and compared the
slice-retention behavior with the pre-change runtime. The findings below separate
source-derived bounds from opportunities that still need profiling.

The [storage decision](decisions/encoding-aware-text.md) owns representation and
ownership contracts. The [roadmap](../TODO.md#strings-and-text) owns unfinished
work. Measured results and the exact tested revisions belong to the PR and retained
benchmark reports; an algorithmic bound does not identify the cause of a measured
regression.

## Cost model

Let N be the number of UTF-16 code units consumed, R the number of rope nodes
visited, H the rope height, M the needle length, and O the output code units.
Shared subtrees count again when their content must be emitted again. For JSON,
let V count visited value/member occurrences, D be container depth, K the total
shape-plan entries, P distinct validated prototype objects, and Q cached escaped
key units. Hash-table costs are expected bounds unless stated otherwise. User
callbacks can perform arbitrary additional work.

| Operation                         | Current cost and qualification                                                                                                                                                                                                    | Owning implementation                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Concatenation                     | Allocates a cons node after the small-inline case; does not balance the tree. Repeated append can make H linear in the number of leaves.                                                                                          | [String construction](../runtime/src/heap_string.c), [addition](../runtime/src/value_ops.c)                    |
| Indexing and sequential traversal | One indexed access is O(H); an index-by-index scan of a skewed rope can be quadratic. An iterator visits the selected content in O(N + R), with O(H) native scratch in the worst case.                                            | [Accessor and iterator](../runtime/src/heap_string.h), [iterator implementation](../runtime/src/heap_string.c) |
| Hashing                           | First hash reads the logical content in O(N + R); subsequent hashes are O(1) for every representation. Hashing preserves storage and segment lifetimes.                                                                           | [Hashing](../runtime/src/heap_string.c)                                                                        |
| Equality and ordering             | Content comparison is linear in the examined prefix and visited nodes. Pointer identity, unequal valid hashes, contiguous leaves, and matching shared rope structure provide shortcuts. A hash match alone never proves equality. | [Comparison](../runtime/src/heap_string.c)                                                                     |
| Slicing                           | Descends through containing children; full ranges reuse their subtree. Partial ranges crossing children copy the requested content. Flat dependent slices retain one flat parent, subject to the retention policy.                | [Slice construction](../runtime/src/heap_string.c)                                                             |
| Forward search                    | Candidate-unit scans are fast, but repeated long partial matches still permit O(NM) comparisons. A cross-leaf candidate may also restart range traversal from the root.                                                           | [String search](../runtime/src/builtin_string.c)                                                               |
| Reverse search                    | Visits leaves in forward order and searches each leaf backwards. A match near the end does not provide a global early exit before earlier leaves are visited.                                                                     | [String search](../runtime/src/builtin_string.c)                                                               |
| Builder append                    | Geometric growth and at most one Latin-1-to-UTF-16 promotion give amortized linear copying in appended units. Explicit over-reservation, truncation, and the allocator's retained capacity require separate space accounting.     | [Text buffer](../runtime/src/text_buffer.c), [RAW growth](../runtime/src/heap.c)                               |
| JSON quoting                      | O(N + O + R), including bounded escape expansion. Latin-1 safe runs use word scanning; UTF-16 quoting still scans units and handles surrogate pairs individually.                                                                 | [JSON quoting](../runtime/src/builtin_json.c)                                                                  |
| Plain-data stringify              | Expected O(V + O + K + P + Q), plus string traversal; auxiliary state is O(D + shapes + K + P + Q). Cache construction and string work are not free simply because container traversal is iterative.                              | [Guarded serializer](../runtime/src/builtin_json.c)                                                            |
| Generic stringify                 | Native recursion uses O(D) stack. Its linear ancestor-vector search produces quadratic cycle-check work on a depth-D chain even with compact output.                                                                              | [Generic serializer](../runtime/src/builtin_json.c)                                                            |

## Retention defect addressed by the audit

A partial dependent slice of a rope can retain history disproportionate to its
visible length. For example, repeatedly evaluating
`s = (s + "abcdefghijklmnop").slice(16)` from a 17-unit string leaves the result
length unchanged. Retaining the crossing cons parent also retains the previous
slice, its cons parent, and every earlier iteration. Comparing the immediate
parent's length with the slice length cannot bound this transitive graph.

The storage policy therefore copies partial ranges that still cross a cons
boundary after descent, without materializing the source rope. Dependent slices
retain flat parents only. Full-subtree reuse remains valid. Regression coverage
uses small and larger-than-4,096-unit sliding windows, compact and wide content,
and collection with only the current window retained.

Copying is a deliberate bounded-retention choice. A future range-pruned rope
slice could preserve large lazy ranges, but it must retain only intersecting
subtrees, bound descriptor growth, and account for tree balance and boundary
node allocation. A small-window-only copy threshold would leave the same history
problem for larger windows.

## Highest-value algorithmic follow-ups

### Preserve sequential work through ropes

The iterator is iterative, but the tree is unbalanced and indexed callers still
start from the root. `charCodeAt` loops and the empty-separator `split` loop can
perform quadratic traversal on a left-deep append chain. A bounded balancing
policy and sequential cursors address different costs: balancing bounds random
access depth; cursors avoid repeating a search for adjacent code units. A cursor
must not retain borrowed segment pointers across reentry or representation-changing
bridges. See [string builtins](../runtime/src/builtin_string.c) and
[native lowering](../src/compiler/target/render-native-c.ts).

JSON's lexical scanner is monotone, but the complete parser is not uniformly
linear over ropes. Number validation may advance to the following leaf before
conversion rereads the token. A backward read resets the iterator from the source
root. Unescaped string construction independently seeks its absolute token range
from that root. T short tokens on a height-H rope can therefore incur O(TH)
seeking work. Accumulating small integers while scanning and preserving token-local
ranges or cursor checkpoints can remove those repeated seeks. The platform
`strtod` call has its own cost; the runtime's linear validation/copy work does not
establish a universal bound for that library function. See
[parser cursor and token conversion](../runtime/src/builtin_json.c).

### Give search a robust long-pattern path

First/last-unit filtering and bulk candidate scans improve favorable inputs but
do not change the worst-case substring algorithm. A haystack of repeated `a`
units and a needle ending in `ba` after a long `a` prefix defeats both endpoint
filters and repeatedly fails near the end. Evaluate a streaming prefix-table
search or another algorithm with a proved bound for long repetitive patterns,
while keeping a small-needle path with low setup cost. Reverse traversal should
also be able to start at the requested end position and stop at the first match.
All variants must compare UTF-16 units, support embedded NUL, and match across
encoding and leaf boundaries. See [search helpers](../runtime/src/builtin_string.c).

### Let lookup use the new hash contract

`mal_shape_transition_hash` and `mal_shape_find_hash` still reject cons strings.
That exclusion bypasses their indexes even though rope hashes now cache without
materialization. Distinct rope-named transitions from one parent shape can then
accumulate quadratic sibling-list comparisons. Removing the representation veto
needs collision, shape-sharing, cache-lifetime, and GC coverage. See
[shape indexes](../runtime/src/shape.c).

Newly appended strings also start hashing from the initial FNV state even when
their left child already has a valid full hash. Hashing every growing prefix can
therefore be quadratic. Continuing from the cached left hash and streaming the
right child preserves the existing content hash definition; arbitrary right-child
final hashes cannot simply be combined independently of their initial state.
Retain the current rule that equality does not compute missing hashes merely to
compare two strings. Lexical comparison can separately return zero immediately
for identical pointers. See [hashing and comparison](../runtime/src/heap_string.c).

There are also avoidable boundary conversions: `mal_array_key_is_length` requests
UTF-16 storage before rejecting keys of the wrong length, and the specialized
string iterator still uses the contiguous bridge. Audit actual call paths before
migrating generated regex capture projections: the regex engine already requires
UTF-16 input, so removing a nearby bridge may save nothing. See
[array keys](../runtime/src/array_object.c),
[iterators](../runtime/src/builtin_iterator.c), and
[native capture lowering](../src/compiler/target/render-native-c.ts).

The Map entry hint still compares contents when a fresh query string is equal to
a stored key. Reusing that same fresh query for get/set/get can repeat equality
work. Any query-identity cache needs explicit tracing and mutation invalidation;
compiler fusion needs proof of intrinsic identity and intervening effects. This
is a workload-matching opportunity, not an established explanation for the
string-key benchmark result. See [Map builtins](../runtime/src/builtin_map.c) and
[table hints](../runtime/src/table.c).

Dynamic property queries currently intern strings through the VM's rooted atom
table even for missing properties. Unique read misses can therefore retain all
their key strings and reachable backing storage for the VM lifetime. Transient
queries require a different cache/lifetime contract, not an eviction patch that
leaves IC or shape-cache key pointers untraced. This is separate from Map lookup.
See [property-key preparation](../runtime/src/vm_ops.c),
[atomization](../runtime/src/intrinsics.c), and [GC roots](../runtime/src/gc.c).

### Index JSON metadata and bound recursive paths

With a reviver, every surviving object key scans the recorded child list backwards
to locate its last occurrence. An identity reviver over m distinct properties
therefore causes quadratic parse-record comparisons even for flat, shallow input.
A last-occurrence index must preserve duplicate-key `context.source`, numeric
property ordering, and reviver mutation behavior. Source tracking retains syntax
nodes for overwritten members too, so memory follows parsed input rather than
only the final object. See [reviver source lookup](../runtime/src/builtin_json.c).

Parsing, generic serialization, reviver traversal, and parse-node disposal all
retain native recursion without an explicit JSON depth guard. They need iterative
traversal or controlled depth failure, including cleanup after exceptions. Reuse
an active-path set for generic cycle checks without confusing shared children
with cycles. An identity replacer is the right compact-output stress case;
indentation can itself produce quadratic output and obscure traversal cost.

Several apparent risks are already bounded. The parser's shaped-object duplicate
scan is capped at 32 inline names, so it is not an unbounded quadratic member
algorithm. The plain serializer's shape/prototype caches use pointer hash tables,
and its active set uses backward-shift deletion rather than accumulating sibling
tombstones. Late fallback is attempted once at the top level: it duplicates a
pure prefix before generic traversal, but does not retry speculation in every
subtree. See [JSON implementation](../runtime/src/builtin_json.c).

## Construction and external encoding opportunities

The shared builder already has amortized linear growth. Its remaining costs are
extra passes and retained capacity. A large buffer truncated to 17 Latin-1 units
still transfers its large allocation to the resulting non-inline string; RAW
reallocation currently treats shrink requests as a no-op. A finish-time policy
should copy disproportionate capacity while preserving ordinary ownership
transfer. The UTF-16 flag alone cannot prove that wide content survives truncation
or that an explicitly wide scratch buffer contains wide content.

Append failures are sticky. An individual failed growth preserves its old
allocation, but a segmented append can have committed earlier segments before
later growth fails. The whole append is not transactional. Rollback preserves
capacity and encoding and does not clear an allocation error. See
[builder contracts](../runtime/src/text_buffer.h) and
[append/finish](../runtime/src/text_buffer.c).

The non-ASCII UTF-8 decode path scans for ASCII, decodes into a UTF-16 temporary,
then constructs a string that may scan and narrow again. This is linear work with
avoidable full-size transients. A compact decoder must preserve malformed-input
replacement, surrogate behavior, decoded-unit limits, and streaming semantics.
The UTF-8 encoder instead reserves `3N + 1` bytes; an ASCII `Buffer.from` can adopt
that buffer with a much smaller visible length. Compare tighter Latin-1 bounds,
exact sizing, and fallible shrinking using actual backing capacity as well as
allocation counters. See [UTF-8](../runtime/src/utf8.c) and
[Buffer conversion](../runtime/src/runtime/node_buffer.c).

There is a pre-existing Buffer decode restriction to correct separately: UTF-8
input bytes above the string-unit limit are rejected before decoded length is
known. For example, 9 Mi units of U+00E9 need 18 MiB of UTF-8 input while fitting
the 16 Mi UTF-16-unit string limit. Validate the decoded count and malformed-input
replacement count rather than treating encoded bytes as code units.

UTF-16 quoting, sparse versus dense escapes, and the position of the first wide
unit are plausible contributors to mixed-text cost. Shape/key caches may also
waste work on one-use shapes or late fallback. Profile those dimensions before
adding persistent cache state, duplicate serializer implementations, or chunked
output. Those choices trade code size, invalidation complexity, and final copying
against less repeated scanning or promotion.

Other consumers have inexpensive admission proofs worth preserving before a
bridge: Latin-1 content cannot contain a surrogate, so well-formedness checks can
return immediately; trim can inspect endpoints without materializing an unchanged
rope. Direct concat, case conversion, repeat, and padding still use wide staging
in several paths. Repeated eager `concat` can copy a growing prefix quadratically.
These are distinct consumer migrations, with Unicode fallbacks and observable
coercion order retained. See [string builtins](../runtime/src/builtin_string.c).

## Minimal acceptance matrix

Use the row relevant to an optimization, then retain the existing six workloads
as controls. Physical representations should be built at runtime or with explicit
C constructors; constant-folded UTF-16 literals can invalidate an intended rope
or compact-storage experiment.

| Target                         | Inputs that expose the cost                                                                                                        | Acceptance evidence                                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed construction and quoting | Equal-size Latin-1, early/late wide units, BMP, emoji, lone surrogates; sparse/dense escapes at every scan alignment               | Exact complete output; paired time, allocation, promotion, and copied-unit counts                                                            |
| Search                         | Repeated-prefix misses and overlaps at increasing N and M; flat/balanced/skewed storage; cross-leaf hits                           | Flat UTF-16 oracle; comparison/traversal counts that demonstrate the intended scaling bound                                                  |
| Ropes, hashes, and keys        | Equal content in balanced/left/right-deep trees; 4/64/1,024 leaves; first versus cached hash; same-object/fresh-equal/unique keys  | Content and GC checks; depth, visited nodes, equality units, cache hits, and paired timings                                                  |
| JSON traversal and metadata    | Token ends at leaf boundaries; 1K/2K/4K/8K reviver keys; compact deep chains with identity replacer                                | Exact values, negative zero, duplicate source records, callback order; lookup/seek counts and controlled depth behavior                      |
| Shape caches and fallback      | Same output with one/few/unique shapes; one unsupported value at the beginning/middle/end                                          | Plan/key bytes, cache hits, discarded output, exact callback trace, and total time                                                           |
| Encoding and retained storage  | Long ASCII/non-ASCII and malformed data; tiny/large decoded lengths; sliding slices; retained keys after dropping source documents | Output-unit limits and byte parity; RAW/adopted capacity and live storage after a defined quiescent collection, separately from ordinary RSS |

Do not infer retained live data from a collector snapshot taken at arbitrary
points in different collection schedules. Keep timing runs separate from GC
instrumentation, retain matching checksums and source/toolchain identities, and
report dispersion and unfavorable controls alongside improvements.
