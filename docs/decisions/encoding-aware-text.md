# Encoding-aware text

JavaScript string positions and lengths count UTF-16 code units. Physical string
storage is independent: a flat string can store each unit in one byte when all
units are at most `0xff`, or in two bytes otherwise. Latin-1 is a storage encoding,
not an external serialization format. Embedded NUL and lone surrogates remain
ordinary string content.

## Representation and ownership

The string cell remains in the 32-byte size class. Its 32-bit length covers the
existing 16-million-code-unit engine limit. The remaining half of the previous
length word stores a dependent slice's offset.

| Storage   | Payload                                  | Ownership and retained edges         |
| --------- | ---------------------------------------- | ------------------------------------ |
| Inline    | Eight Latin-1 units or four UTF-16 units | Inside the string cell               |
| Owned     | Contiguous Latin-1 or UTF-16 units       | GC-accounted RAW allocation          |
| External  | Borrowed Latin-1 or UTF-16 units         | Provider retains the backing storage |
| Dependent | Parent plus UTF-16 offset and length     | Parent may be flat or a rope         |
| Cons      | Left and right strings                   | Children retain their own encodings  |

Copied UTF-16 input is compacted when eligible. Builders construct Latin-1
directly, avoiding a temporary wide payload. Existing emitted and wire-loaded
UTF-16 literals remain valid external strings; their consumers can traverse them
without copying.

Slices retain a parent and an offset, never an interior payload pointer. This
allows a parent to widen or a retained rope to flatten without invalidating a
slice. Slice construction resolves nested slices and descends into a single rope
child when the requested range fits there. Tiny slices are copied. A larger slice
copies when its resolved parent exceeds 4,096 code units and the retained range
would be less than one eighth of that parent. Borrowed external parents do not
charge an owned backing buffer to the slice.

## Traversal and contiguous access

`MalStringIterator` yields contiguous leaves with an encoding tag and a code-unit
length. Its range is measured in UTF-16 units. It visits ropes and slices
iteratively, with small stack storage and native scratch allocation for deeper
trees. Traversal does not collect, invoke JavaScript, flatten, or widen a string.

A segment borrows its leaf's storage. Consumers keep the source graph rooted
across collection and do not retain borrowed segment pointers across JavaScript
reentry or string materialization, including repeated rope hashing and a UTF-16
bridge that could widen the same leaf. Producers append a segment before
advancing or crossing an observable call. A single-leaf range can use
`mal_string_try_get_segment` to avoid the general iterator.

`mal_string_code_units` is an explicit contiguous UTF-16 bridge. It can allocate
and widen a compact leaf or flatten a rope/slice. Once obtained, its UTF-16 pointer
is stable while the string is retained. Consumers that require a contiguous
UTF-16 interface, including existing regular-expression and Unicode integrations,
can use this bridge. Sequential consumers use segments instead.

Allocation requests a later GC poll; it does not itself run collection or
JavaScript. Descriptor transitions retain the existing SATB publication of removed
parent/child edges. Concurrent tracing does not inspect mutable string descriptors
while the mutator runs. RAW ownership remains explicit through construction,
adoption, and finalization.

## Content identity

Hashes retain the existing FNV64 contract over the low byte and high byte of each
UTF-16 unit. Latin-1 traversal therefore includes the implicit zero high byte.
Equal strings have equal hashes across physical encodings and rope partitions.
Equality and lexical ordering compare UTF-16 content, including lone surrogates.

Flat strings cache their complete hash in the first payload word. Dependent
strings use the other payload word for a cached hash while retaining their parent.
A cons string streams its first hash without materializing. A second hash
materializes compact owned storage and caches the complete hash, amortizing
repeated Map and property-key operations. The reuse marker occupies the word
otherwise used for a dependent offset. This policy preserves the 32-byte cell and
existing hash contract while keeping one-pass consumers segmented. Materialization
keeps the string identity and dependent offsets valid; it does not collect or
invoke JavaScript.

## Shared construction

`MalTextBuffer` starts in Latin-1, promotes to UTF-16 when needed, and maintains
length and capacity in code units. It supports code units, Latin-1 spans, string
ranges, complete strings, buffers, ASCII, and decimal integers. Source ranges may
not alias the destination buffer; explicit self-append handles that case.

Growth uses fallible GC-accounted RAW reallocation. Existing size-class slack and
large-buffer reallocation can retain the allocation, and promotion widens
backwards when the address is reused. A failed growth preserves the old payload,
ownership, and allocation accounting. Length overflow is detected before reading
input. Finalization transfers RAW ownership to the appropriate string constructor;
tiny strings move into inline storage. Rollback retains capacity and encoding.
Producers that know the final length can hint capacity before appending; the first
content selects the initial allocation width. Explicit reservation stays eager
for callers that write directly into the buffer.

Array joining, string replacement and raw construction, JSON, and the previous
UTF-16 buffer consumers share this implementation. Path normalization explicitly
selects UTF-16 scratch for its existing in-place algorithm. UTF-8 and Buffer output
consume segments at the external boundary, including surrogate pairs split across
leaves; bounded UTF-8 output never splits a scalar and reports UTF-16 units read.

## JSON

The parser reads a segmented code-unit cursor. Unescaped strings can retain safe
slices, and escaped strings use the compact builder. Quoting scans contiguous
leaves, copies unescaped runs in bulk, and carries surrogate pairing across leaf
boundaries. Lone surrogates are escaped in JSON output.

Generic serialization prepares each property value in observable order before
emitting its key and value directly into the final output. It retains the existing
getter, proxy, `toJSON`, replacer, omission, and pretty-printing behavior without
serializing each object member into a separate scratch output.

A guarded serializer handles ordinary shaped data objects and packed arrays
iteratively. It proves the absence of observable hooks over the relevant prototype
chain, rejects unsupported storage and exotic objects, and checks active-path
identities for cycles. Repeated non-cyclic references remain valid. Per-call shape
plans reuse property order and slots and cache escaped keys; the root retains the
immutable input graph throughout this callback-free traversal.

Replacers, property lists, indentation, accessors, proxies, holes, wrappers,
`toJSON`, raw JSON, and other unsupported cases take the generic path. An
unsupported descendant discards speculative output before generic traversal
invokes any user code. This can repeat earlier pure work, but never repeats a
getter or hook. Keeping caches within one invocation avoids cross-call shape and
prototype invalidation state. The generic traversal remains recursive.

## Verification

`encoding-aware-strings.test.ts` checks physical encodings, cross-encoding content
identity, slice retention and bridge lifetime, deep segment traversal, forced GC,
and compact storage through an actual parse–lookup–append–serialize pipeline.
`text-buffer.test.ts` checks promotion, ownership, rollback, and injected allocation
failures. `encoding-aware-text.test.ts` exercises observable string/JSON behavior
through both native backends and GC stress. These contracts also run in the
sanitizer selection.

The `text-pipeline-latin1` and `text-pipeline-mixed` runtime-gap cases cover parsing
records, slicing lookup keys, looking up values, joining and replacing labels,
serializing output, and checksumming every output code unit. Use the native micro
comparison runner with a specific baseline revision and repeated interleaved pairs.
The same frozen case runs on both revisions, with Node supplying the output oracle.
Timing conclusions belong to the measured workload and host; they do not establish
whole-runtime performance by themselves.
