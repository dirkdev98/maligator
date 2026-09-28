#pragma once

#include "./defaults.h"
#include "heap.h"
#include "perf_stats.h"

/**
 * Physical ownership is independent of the encoding of a flat string's payload.
 */
typedef enum MalStringStorage : u32 {
    MAL_STRING_STORAGE_OWNED,
    MAL_STRING_STORAGE_INLINE,
    MAL_STRING_STORAGE_EXTERNAL,
    MAL_STRING_STORAGE_DEPENDENT,
    MAL_STRING_STORAGE_CONS,
} MalStringStorage;

typedef struct MalString {
    MalHeapHeader header;
    /** The inclusive 2^24-unit engine limit needs 25 bits. */
    u32 length : 25;
    MalStringStorage storage : 3;
    u32 hash_valid : 1;
    u32 array_index_impossible : 1;
    /** Canonical VM-lifetime representative in the owning VM's atom table. */
    u32 property_atom : 1;
    /** Flat payload is one byte per UTF-16 unit; ropes/slices may conservatively clear it. */
    u32 latin1 : 1;
    /** Full content hash for every representation, independent of its payload. */
    u64 hash;
    union {
        const c16 *code_units;
        const u8 *latin1_units;
        c16 inline_code_units[8];
        u8 inline_latin1_units[16];
        struct {
            struct MalString *left;
            struct MalString *right;
        };
        struct {
            /** Retained parent is flat; offset is in UTF-16 units. */
            struct MalString *parent;
            u32 slice_offset;
        };
    };
} MalString;

static_assert(sizeof(MalString) == 32, "MalString must fit its 32-byte cell");
static_assert(offsetof(MalString, hash) == 8, "string metadata must occupy one word after its header");
static_assert(offsetof(MalString, code_units) == 16, "string payload must follow its cached hash");
#define MAL_STRING_INLINE_CODE_UNITS ((usize) 8)
#define MAL_STRING_INLINE_LATIN1_CODE_UNITS ((usize) 16)

/** Engine string lengths are measured in UTF-16 code units. */
#define MAL_STRING_MAX_CODE_UNITS ((usize) 16 * 1024 * 1024)
static_assert(MAL_STRING_MAX_CODE_UNITS <= INT32_MAX, "string length must fit regexp/i32 indices");
static_assert(MAL_STRING_MAX_CODE_UNITS < ((usize) 1 << 25), "string length must fit its packed field");

/**
 * Hash a UTF-16 code unit sequence.
 */
u64 mal_string_hash_code_units(const c16 *code_units, usize length);

/**
 * Make a canonical flat property atom the preferred representative for its
 * tiny-string cache slot. This is only an allocation shortcut; callers must
 * continue to use content-correct string equality.
 */
void mal_string_tiny_cache_promote(MalHeap *heap, MalString *atom);

/**
 * Copy UTF-16 input into compact Latin-1 storage whenever its units fit.
 */
void mal_string_init_copy(MalHeap *heap, MalString *string, const c16 *code_units, usize length);

/**
 * Initialize a string that borrows externally managed UTF-16 storage.
 */
void mal_string_init_external(MalString *string, const c16 *code_units, usize length);
void mal_string_init_external_latin1(MalString *string, const u8 *units, usize length);

/**
 * Allocate a string by copying UTF-16 input, compacting eligible payloads.
 */
MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length);

/**
 * Allocate and initialize a string that borrows external UTF-16 storage.
 */
MalString *mal_string_new_external(MalHeap *heap, const c16 *code_units, usize length);

/**
 * Allocate a substring using a flat dependent parent when doing so will not
 * retain a disproportionate owned backing buffer. Cross-leaf ranges are copied;
 * complete subtrees may be reused. Offset and length are UTF-16 code units, and
 * the range must be in bounds. Full-range slices may return `parent`.
 */
MalString *mal_string_new_slice(MalHeap *heap, MalString *parent, usize offset, usize length);

/**
 * Allocate a weight-balanced lazy concatenation after checking its combined
 * UTF-16 length. Cons children occupy at most three quarters of their parent,
 * except a short cons of two non-cons children, which adds one terminal height edge.
 * Returns false without allocating when the engine string limit would be exceeded.
 */
bool mal_string_new_cons_checked(MalHeap *heap, MalString *left, MalString *right, MalString **out);

/**
 * Allocate a string that TAKES OWNERSHIP of an existing heap-raw buffer (one
 * returned by `mal_heap_alloc_raw`). Eligible UTF-16 input is compacted; other
 * input is adopted directly. Callers relinquish the input in either case.
 */
MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length);

MalString *mal_string_new_latin1_copy(MalHeap *heap, const u8 *units, usize length);
/** Takes ownership of a mal_heap_alloc_raw buffer. */
MalString *mal_string_new_latin1_owned(MalHeap *heap, const u8 *units, usize length);
/** Takes ownership of UTF-16 storage known to contain a unit above Latin-1. */
MalString *mal_string_new_utf16_owned(MalHeap *heap, const c16 *units, usize length);

/**
 * Allocate and initialize a string from ASCII bytes.
 */
MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length);

/** Explicit UTF-16 bridge: widen compact leaves or flatten ropes as needed. */
const c16 *mal_string_flatten(MalString *string);

/**
 * Return contiguous UTF-16 storage, widening or flattening when needed. Its
 * address stays valid while the string is rooted. Prefer segments for traversal.
 */
static inline const c16 *mal_string_code_units(const MalString *string) {
    // C memory operations require nonnull pointers, including empty wire strings.
    if (string->length == 0 ||
        (string->storage == MAL_STRING_STORAGE_INLINE && !string->latin1)) {
        return string->inline_code_units;
    }
    if (!string->latin1 && string->storage != MAL_STRING_STORAGE_CONS &&
        string->storage != MAL_STRING_STORAGE_DEPENDENT) {
        return string->code_units;
    }
    return mal_string_flatten((MalString *) string);
}

/** Read an in-bounds unit from a known flat leaf, reacquiring its current payload. */
static inline c16 mal_string_flat_code_unit_at(const MalString *string, usize index) {
    if (string->latin1) {
        return string->storage == MAL_STRING_STORAGE_INLINE
            ? string->inline_latin1_units[index] : string->latin1_units[index];
    }
    return string->storage == MAL_STRING_STORAGE_INLINE
        ? string->inline_code_units[index] : string->code_units[index];
}

/** Ancestry resolution does not allocate, widen, flatten, or collect. */
c16 mal_string_code_unit_at_slow(const MalString *string, usize index);

/** Read one in-bounds UTF-16 unit without allocating, widening, or flattening. */
static inline c16 mal_string_code_unit_at(MalString *string, usize index) {
    if (string->storage >= MAL_STRING_STORAGE_DEPENDENT) {
        return mal_string_code_unit_at_slow(string, index);
    }
    return mal_string_flat_code_unit_at(string, index);
}

typedef struct MalStringSegment {
    bool latin1;
    usize length;
    union {
        const u8 *latin1_units;
        const c16 *utf16_units;
    };
} MalStringSegment;

/** Return a borrowed segment when a valid range lies in one leaf. Resolves
 * dependent offsets without allocating or mutating; leaves `segment` unchanged
 * when the range spans leaves. Empty ranges succeed with valid storage. */
bool mal_string_try_get_segment(
    const MalString *string, usize offset, usize length, MalStringSegment *segment);

/** Find the flat leaf at an in-bounds offset. Available units stop at the
 * visible input range, including dependent slices. Leaf identity can be rooted
 * across reentry; obtain its payload afresh after possible materialization. */
void mal_string_get_leaf_range(
    const MalString *string, usize offset, const MalString **leaf_out,
    usize *leaf_offset_out, usize *available_out);

typedef struct MalStringIteratorPart {
    const MalString *string;
    usize offset;
    usize length;
} MalStringIteratorPart;

typedef struct MalStringIterator {
    MalStringIteratorPart *stack;
    usize count;
    usize capacity;
    bool reverse;
    /** Non-null when a heap cursor traces this frontier and owns its RAW storage. */
    MalHeapHeader *owner;
    /** Flat owner of the last returned segment; valid until next/dispose. */
    MalStringIteratorPart current;
    MalStringIteratorPart inline_stack[16];
} MalStringIterator;

/** Segments borrow leaf storage. Root the input across GC; do not retain an
 * iterator or segment across JS reentry or a UTF-16 bridge that may materialize
 * it. Traversal never collects or mutates strings; borrowed scratch uses malloc. */
void mal_string_iterator_init(
    MalStringIterator *iterator, const MalString *string, usize offset, usize length);
/** Returns segments right to left; each segment retains its forward unit order. */
void mal_string_iterator_init_reverse(
    MalStringIterator *iterator, const MalString *string, usize offset, usize length);
bool mal_string_iterator_next(MalStringIterator *iterator, MalStringSegment *segment);
void mal_string_iterator_dispose(MalStringIterator *iterator);

/** Internal heap cell; never exposed as a JavaScript object. Pending subtree
 * identities and the current leaf remain traced even if reentry flattens ancestors. */
typedef struct MalStringCursor {
    MalHeapHeader header;
    MalStringIterator *iterator;
    usize local;
    usize position;
    usize length;
    /** Optional pointer-free RAW scratch, owned until exhaustion or finalization. */
    void *scratch;
} MalStringCursor;

MalStringCursor *mal_string_cursor_new(MalHeap *heap, const MalString *string);
/** Reacquire leaf storage; consume at most segment.length units before another call. */
bool mal_string_cursor_segment(MalStringCursor *cursor, MalStringSegment *segment);
void mal_string_cursor_consume(MalStringCursor *cursor, usize count);
/** Release exhausted state. Also safe during GC finalization after clearing owner. */
void mal_string_cursor_dispose(MalStringCursor *cursor);

static inline c16 mal_string_segment_code_unit_at(const MalStringSegment *segment, usize index) {
    return segment->latin1 ? segment->latin1_units[index] : segment->utf16_units[index];
}

/** Copy a valid range without flattening a lazy concatenation; destination holds length units. */
void mal_string_copy_range_to(
    MalString *string, usize offset, usize length, c16 *destination);

/**
 * Return the string UTF-16 code unit length.
 */
static inline usize mal_string_length(const MalString *string) {
    return string->length;
}

/**
 * Hash UTF-16 content independent of physical encoding. Every representation
 * caches the full hash; computing it never materializes, collects, or reenters JS.
 */
u64 mal_string_hash_slow(const MalString *string);

/**
 * Most property-name hashes are already cached. Keep that overwhelmingly hot
 * read at the call site; first hashes retain traversal out of line.
 */
static inline u64 mal_string_hash(const MalString *string) {
    MAL_PERF_COUNT(string_hash_calls);
    if (string->hash_valid) {
        MAL_PERF_COUNT(string_hash_cached_hits);
        return string->hash;
    }
    return mal_string_hash_slow(string);
}

/**
 * Return the storage policy used by the string.
 */
static inline MalStringStorage mal_string_storage(const MalString *string) {
    return string->storage;
}

/**
 * Compare two strings by UTF-16 code units.
 */
bool mal_string_equals(const MalString *left, const MalString *right);

/**
 * Lexicographically compare two strings by UTF-16 code units.
 */
i32 mal_string_compare(const MalString *left, const MalString *right);
