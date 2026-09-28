#include "heap_string.h"

#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "checked_size.h"
#include "perf_stats.h"
#include "profile.h"
#include "vm.h"

static void mal_string_require_valid_length(usize length) {
    // Raw constructors have no VM/completion channel. VM-aware producers must
    // preflight and throw; reaching this guard is an internal invariant failure.
    if (length > MAL_STRING_MAX_CODE_UNITS) {
        abort();
    }
}

#if MAL_PERF_STATS
static void mal_perf_string_allocation(usize length) {
    if (!mal_perf_stats_enabled) return;
    mal_perf_stats.string_allocations++;
    mal_perf_stats.string_code_units += length;
    if (length == 0) {
        mal_perf_stats.string_length_0_allocations++;
    } else if (length == 1) {
        mal_perf_stats.string_length_1_allocations++;
    } else if (length <= 4) {
        mal_perf_stats.string_length_2_4_allocations++;
    } else if (length <= 8) {
        mal_perf_stats.string_length_5_8_allocations++;
    } else if (length <= 16) {
        mal_perf_stats.string_length_9_16_allocations++;
    } else if (length <= 32) {
        mal_perf_stats.string_length_17_32_allocations++;
    } else if (length <= 64) {
        mal_perf_stats.string_length_33_64_allocations++;
    } else {
        mal_perf_stats.string_length_65_plus_allocations++;
    }
}
#else
static inline void mal_perf_string_allocation(usize length) {
    (void) length;
}
#endif

static bool mal_string_units_are_latin1(const c16 *units, usize length) {
    for (usize i = 0; i < length; i++) {
        if (units[i] > UINT8_MAX) return false;
    }
    return true;
}

static void mal_string_init_flat(
    MalString *string, MalStringStorage storage, bool latin1, usize length
) {
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = storage;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->latin1 = latin1;
    string->length = (u32) length;
    string->hash = 0;
}

static void mal_string_init_inline(
    MalString *string, const c16 *code_units, usize length
) {
    bool latin1 = mal_string_units_are_latin1(code_units, length);
    if (length > (latin1 ? MAL_STRING_INLINE_LATIN1_CODE_UNITS : MAL_STRING_INLINE_CODE_UNITS)) abort();
    mal_string_init_flat(string, MAL_STRING_STORAGE_INLINE, latin1, length);
    if (latin1) {
        for (usize i = 0; i < length; i++) string->inline_latin1_units[i] = (u8) code_units[i];
    } else if (length > 0) {
        memcpy(string->inline_code_units, code_units, sizeof(c16) * length);
    }
    MAL_PERF_COUNT(string_inline_allocations);
    MAL_PERF_ADD(string_inline_code_units, length);
}

u64 mal_string_hash_code_units(const c16 *code_units, usize length) {
    u64 hash = 0xcbf29ce484222325;

    for (usize i = 0; i < length; i++) {
        c16 code_unit = code_units[i];
        hash ^= (u8) (code_unit & 0xFF);
        hash *= 0x100000001b3;
        hash ^= (u8) (code_unit >> 8);
        hash *= 0x100000001b3;
    }

    return hash;
}

static MalString ***mal_string_tiny_cache_slot(MalHeap *heap) {
    return &mal_vm_from_heap(heap)->tiny_string_cache;
}

static void mal_string_tiny_cache_store(
    MalHeap *heap, usize index, MalString *replacement
) {
    MalString **cache = *mal_string_tiny_cache_slot(heap);
    if (cache == nullptr) abort();
    MalString *old = cache[index];
    if (old == replacement) return;
    if (old != nullptr && mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(old));
    }
    cache[index] = replacement;
}

typedef struct MalTinyStringCacheResult {
    MalString *string;
    bool hit;
} MalTinyStringCacheResult;

static bool mal_string_tiny_cache_matches(
    const MalString *cached, const c16 *code_units, usize length
) {
    if (cached == nullptr || cached->length != length
        || cached->storage == MAL_STRING_STORAGE_DEPENDENT
        || cached->storage == MAL_STRING_STORAGE_CONS) {
        return false;
    }
    if (cached->latin1) {
        const u8 *units = cached->storage == MAL_STRING_STORAGE_INLINE
            ? cached->inline_latin1_units : cached->latin1_units;
        for (usize i = 0; i < length; i++) {
            if (units[i] != code_units[i]) return false;
        }
        return true;
    }
    const c16 *units = cached->storage == MAL_STRING_STORAGE_INLINE
        ? cached->inline_code_units : cached->code_units;
    return length == 0 || memcmp(units, code_units, length * sizeof(c16)) == 0;
}

static MalTinyStringCacheResult mal_string_tiny_cache_get_or_create(
    MalHeap *heap, const c16 *code_units, usize length
) {
    if (length > MAL_STRING_INLINE_CODE_UNITS) abort();
    MalString ***cache_slot = mal_string_tiny_cache_slot(heap);
    if (*cache_slot == nullptr) {
        *cache_slot = calloc(
            MAL_TINY_STRING_CACHE_CAPACITY, sizeof(**cache_slot));
        if (*cache_slot == nullptr) abort();
    }
    MalString **cache = *cache_slot;
    u64 hash = mal_string_hash_code_units(code_units, length);
    usize index = (usize) hash & (MAL_TINY_STRING_CACHE_CAPACITY - 1);
    MalString *cached = cache[index];
    if (mal_string_tiny_cache_matches(cached, code_units, length)) {
        MAL_PERF_COUNT(string_tiny_cache_hits);
        return (MalTinyStringCacheResult) {.string = cached, .hit = true};
    }

    MAL_PERF_COUNT(string_tiny_cache_misses);
    if (cached != nullptr) {
        MAL_PERF_COUNT(string_tiny_cache_replacements);
    }
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_inline(string, code_units, length);
    string->hash = hash;
    string->hash_valid = true;
    mal_string_tiny_cache_store(heap, index, string);
    return (MalTinyStringCacheResult) {.string = string, .hit = false};
}

void mal_string_tiny_cache_promote(MalHeap *heap, MalString *atom) {
    if (atom == nullptr || atom->length > MAL_STRING_INLINE_CODE_UNITS
        || (atom->storage != MAL_STRING_STORAGE_INLINE
            && atom->storage != MAL_STRING_STORAGE_OWNED
            && atom->storage != MAL_STRING_STORAGE_EXTERNAL)) {
        return;
    }
    MalString **cache = *mal_string_tiny_cache_slot(heap);
    if (cache == nullptr) return;
    u64 hash = mal_string_hash(atom);
    usize index = (usize) hash & (MAL_TINY_STRING_CACHE_CAPACITY - 1);
    if (cache[index] == atom) return;
    if (cache[index] == nullptr || !mal_string_equals(cache[index], atom)) return;
    mal_string_tiny_cache_store(heap, index, atom);
    MAL_PERF_COUNT(string_tiny_cache_promotions);
}

void mal_string_init_copy(MalHeap *heap, MalString *string, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    bool latin1 = mal_string_units_are_latin1(code_units, length);
    if (length <= (latin1 ? MAL_STRING_INLINE_LATIN1_CODE_UNITS : MAL_STRING_INLINE_CODE_UNITS)) {
        mal_string_init_inline(string, code_units, length);
        return;
    }
    mal_string_init_flat(string, MAL_STRING_STORAGE_OWNED, latin1, length);
    if (latin1) {
        u8 *owned = mal_heap_alloc_raw_profiled(heap, length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        for (usize i = 0; i < length; i++) owned[i] = (u8) code_units[i];
        string->latin1_units = owned;
    } else {
        c16 *owned = mal_heap_alloc_raw_profiled(heap, sizeof(c16) * length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        memcpy(owned, code_units, sizeof(c16) * length);
        string->code_units = owned;
    }
}

void mal_string_init_external(MalString *string, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    mal_string_init_flat(string, MAL_STRING_STORAGE_EXTERNAL, false, length);
    string->code_units = code_units;
}

void mal_string_init_external_latin1(MalString *string, const u8 *units, usize length) {
    mal_string_require_valid_length(length);
    mal_string_init_flat(string, MAL_STRING_STORAGE_EXTERNAL, true, length);
    string->latin1_units = units;
}

MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        MalTinyStringCacheResult result =
            mal_string_tiny_cache_get_or_create(heap, code_units, length);
        if (!result.hit) {
            mal_perf_string_allocation(length);
            MAL_PERF_COUNT(string_copy_allocations);
            MAL_PERF_ADD(string_copy_code_units, length);
        }
        return result.string;
    }
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_copy_allocations);
    MAL_PERF_ADD(string_copy_code_units, length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_copy(heap, string, code_units, length);

    return string;
}

MalString *mal_string_new_external(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_external_allocations);
    MAL_PERF_ADD(string_external_code_units, length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_external(string, code_units, length);

    return string;
}

#define MAL_STRING_SLICE_SMALL_PARENT_CODE_UNITS ((usize) 4096)
#define MAL_STRING_SLICE_MAX_RETAINED_RATIO ((usize) 8)

static MalStringSegment mal_string_leaf_segment(
    const MalString *string, usize offset, usize length
) {
    MalStringSegment segment = {.latin1 = string->latin1, .length = length};
    if (string->latin1) {
        segment.latin1_units = (string->storage == MAL_STRING_STORAGE_INLINE
            ? string->inline_latin1_units : string->latin1_units) + offset;
    } else {
        segment.utf16_units = (string->storage == MAL_STRING_STORAGE_INLINE
            ? string->inline_code_units : string->code_units) + offset;
    }
    return segment;
}

bool mal_string_try_get_segment(
    const MalString *string, usize offset, usize length, MalStringSegment *segment
) {
    usize end;
    if (string == nullptr || segment == nullptr ||
        !mal_checked_size_add(offset, length, string->length, &end)) abort();
    if (length == 0) {
        *segment = (MalStringSegment) {
            .latin1 = true, .length = 0, .latin1_units = string->inline_latin1_units,
        };
        return true;
    }
    for (;;) {
        if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
            offset += string->slice_offset;
            string = string->parent;
        } else if (string->storage == MAL_STRING_STORAGE_CONS) {
            usize left_length = string->left->length;
            if (offset >= left_length) {
                offset -= left_length;
                string = string->right;
            } else if (length <= left_length - offset) {
                string = string->left;
            } else {
                return false;
            }
        } else {
            *segment = mal_string_leaf_segment(string, offset, length);
            return true;
        }
    }
}

static void mal_string_iterator_push(MalStringIterator *iterator, MalStringIteratorPart part) {
    if (part.length == 0) return;
    if (iterator->count == iterator->capacity) {
        usize capacity;
        if (!mal_checked_size_growth(iterator->capacity, iterator->count + 1,
                16, MAL_STRING_MAX_CODE_UNITS, &capacity)) abort();
        MalStringIteratorPart *grown;
        if (iterator->stack == iterator->inline_stack) {
            grown = malloc(sizeof(*grown) * capacity);
            if (grown != nullptr) memcpy(grown, iterator->stack, sizeof(*grown) * iterator->count);
        } else {
            grown = realloc(iterator->stack, sizeof(*grown) * capacity);
        }
        if (grown == nullptr) abort();
        iterator->stack = grown;
        iterator->capacity = capacity;
    }
    iterator->stack[iterator->count++] = part;
}

void mal_string_iterator_init(
    MalStringIterator *iterator, const MalString *string, usize offset, usize length
) {
    usize end;
    if (string == nullptr || !mal_checked_size_add(offset, length, string->length, &end)) abort();
    iterator->stack = iterator->inline_stack;
    iterator->count = 0;
    iterator->capacity = sizeof(iterator->inline_stack) / sizeof(iterator->inline_stack[0]);
    mal_string_iterator_push(iterator, (MalStringIteratorPart) {
        .string = string, .offset = offset, .length = length,
    });
}

bool mal_string_iterator_next(MalStringIterator *iterator, MalStringSegment *segment) {
    if (iterator->count == 0) return false;
    MalStringIteratorPart part = iterator->stack[--iterator->count];
    for (;;) {
        const MalString *string = part.string;
        if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
            part.offset += string->slice_offset;
            part.string = string->parent;
            continue;
        }
        if (string->storage == MAL_STRING_STORAGE_CONS) {
            usize left_length = string->left->length;
            if (part.offset >= left_length) {
                part.offset -= left_length;
                part.string = string->right;
                continue;
            }
            usize available = left_length - part.offset;
            if (part.length > available) {
                mal_string_iterator_push(iterator, (MalStringIteratorPart) {
                    .string = string->right, .offset = 0, .length = part.length - available,
                });
                part.length = available;
            }
            part.string = string->left;
            continue;
        }
        *segment = mal_string_leaf_segment(string, part.offset, part.length);
        return true;
    }
}

void mal_string_iterator_dispose(MalStringIterator *iterator) {
    if (iterator->stack != iterator->inline_stack) free(iterator->stack);
    iterator->stack = iterator->inline_stack;
    iterator->count = 0;
    iterator->capacity = sizeof(iterator->inline_stack) / sizeof(iterator->inline_stack[0]);
}

static void mal_string_copy_segment_to(const MalStringSegment *segment, c16 *destination) {
    if (segment->length == 0) return;
    if (segment->latin1) {
        for (usize i = 0; i < segment->length; i++) destination[i] = segment->latin1_units[i];
    } else {
        memcpy(destination, segment->utf16_units, segment->length * sizeof(c16));
    }
}

void mal_string_copy_range_to(MalString *string, usize offset, usize length, c16 *destination) {
    if (length != 0 && destination == nullptr) abort();
    MalStringSegment segment;
    if (mal_string_try_get_segment(string, offset, length, &segment)) {
        mal_string_copy_segment_to(&segment, destination);
        return;
    }
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, string, offset, length);
    while (mal_string_iterator_next(&iterator, &segment)) {
        mal_string_copy_segment_to(&segment, destination);
        destination += segment.length;
    }
    mal_string_iterator_dispose(&iterator);
}

static bool mal_string_range_is_latin1(MalString *string, usize offset, usize length) {
    if (string->latin1) return true;
    MalStringSegment segment;
    if (mal_string_try_get_segment(string, offset, length, &segment)) {
        return segment.latin1 || mal_string_units_are_latin1(segment.utf16_units, segment.length);
    }
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, string, offset, length);
    bool latin1 = true;
    while (mal_string_iterator_next(&iterator, &segment)) {
        if (!segment.latin1 && !mal_string_units_are_latin1(segment.utf16_units, segment.length)) {
            latin1 = false;
            break;
        }
    }
    mal_string_iterator_dispose(&iterator);
    return latin1;
}

static MalString *mal_string_adopt_utf16(MalHeap *heap, const c16 *units, usize length) {
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_owned_allocations);
    MAL_PERF_ADD(string_owned_code_units, length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_flat(string, MAL_STRING_STORAGE_OWNED, false, length);
    string->code_units = units;
    return string;
}

static MalString *mal_string_copy_range(
    MalHeap *heap, MalString *parent, usize offset, usize length
) {
    MalStringSegment segment;
    if (mal_string_try_get_segment(parent, offset, length, &segment)) {
        return segment.latin1
            ? mal_string_new_latin1_copy(heap, segment.latin1_units, length)
            : mal_string_new_copy(heap, segment.utf16_units, length);
    }
    if (length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
        c16 units[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
        mal_string_copy_range_to(parent, offset, length, units);
        return mal_string_new_copy(heap, units, length);
    }
    if (mal_string_range_is_latin1(parent, offset, length)) {
        u8 *units = mal_heap_alloc_raw_profiled(heap, length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        u8 *destination = units;
        MalStringIterator iterator;
        mal_string_iterator_init(&iterator, parent, offset, length);
        while (mal_string_iterator_next(&iterator, &segment)) {
            if (segment.latin1) {
                memcpy(destination, segment.latin1_units, segment.length);
            } else {
                for (usize i = 0; i < segment.length; i++) destination[i] = (u8) segment.utf16_units[i];
            }
            destination += segment.length;
        }
        mal_string_iterator_dispose(&iterator);
        return mal_string_new_latin1_owned(heap, units, length);
    }
    c16 *units = mal_heap_alloc_raw_profiled(heap, sizeof(c16) * length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    mal_string_copy_range_to(parent, offset, length, units);
    return mal_string_adopt_utf16(heap, units, length);
}

static MalString *mal_string_new_dependent_resolved(
    MalHeap *heap, MalString *parent, usize offset, usize length
) {
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_dependent_allocations);
    MAL_PERF_ADD(string_dependent_code_units, length);
    MAL_PERF_ADD(string_dependent_retained_code_units, parent->length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_flat(string, MAL_STRING_STORAGE_DEPENDENT, parent->latin1, length);
    string->parent = parent;
    string->slice_offset = (u32) offset;
    mal_gc_card(&string->header, mal_value_from_string(parent));
    if (mal_gc_marking_active) mal_gc_satb_record(mal_value_from_string(parent));
    return string;
}

MalString *mal_string_new_slice(MalHeap *heap, MalString *parent, usize offset, usize length) {
    if (parent == nullptr) abort();
    MAL_PERF_COUNT(string_slice_calls);
    MAL_PERF_ADD(string_slice_requested_code_units, length);
    usize end;
    if (!mal_checked_size_add(offset, length, parent->length, &end)) abort();
    if (length == 0) {
        MAL_PERF_COUNT(string_slice_empty_results);
        return mal_string_new_ascii(heap, "", 0);
    }
    if (offset == 0 && length == parent->length) {
        MAL_PERF_COUNT(string_slice_full_reuses);
        return parent;
    }
    if (length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
        MAL_PERF_COUNT(string_slice_copy_results);
        return mal_string_copy_range(heap, parent, offset, length);
    }

    // Resolve slices by offset, never by an interior pointer: widening a compact
    // parent or flattening a retained rope cannot leave its dependents dangling.
    for (;;) {
        if (parent->storage == MAL_STRING_STORAGE_DEPENDENT) {
            offset += parent->slice_offset;
            parent = parent->parent;
        } else if (parent->storage == MAL_STRING_STORAGE_CONS) {
            usize left_length = parent->left->length;
            if (offset >= left_length) {
                offset -= left_length;
                parent = parent->right;
            } else if (length <= left_length - offset) {
                parent = parent->left;
            } else {
                break;
            }
        } else {
            break;
        }
    }
    if (offset == 0 && length == parent->length) {
        MAL_PERF_COUNT(string_slice_full_reuses);
        return parent;
    }
    usize minimum_dependent_length =
        (parent->length + MAL_STRING_SLICE_MAX_RETAINED_RATIO - 1) / MAL_STRING_SLICE_MAX_RETAINED_RATIO;
    bool use_dependent = parent->storage == MAL_STRING_STORAGE_EXTERNAL ||
        parent->length <= MAL_STRING_SLICE_SMALL_PARENT_CODE_UNITS || length >= minimum_dependent_length;
    if (!use_dependent) {
        MAL_PERF_COUNT(string_slice_copy_results);
        return mal_string_copy_range(heap, parent, offset, length);
    }
    MAL_PERF_COUNT(string_slice_dependent_results);
    return mal_string_new_dependent_resolved(heap, parent, offset, length);
}

bool mal_string_new_cons_checked(MalHeap *heap, MalString *left, MalString *right, MalString **out) {
    if (left == nullptr || right == nullptr || out == nullptr) {
        abort();
    }
    if (left->length == 0 || right->length == 0) {
        abort();
    }

    usize length;
    if (!mal_checked_size_add(left->length, right->length, MAL_STRING_MAX_CODE_UNITS, &length)) {
        return false;
    }

    if (length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
        c16 units[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
        mal_string_copy_range_to(left, 0, left->length, units);
        mal_string_copy_range_to(right, 0, right->length, units + left->length);
        if (length <= MAL_STRING_INLINE_CODE_UNITS || mal_string_units_are_latin1(units, length)) {
            MAL_PERF_COUNT(string_inline_concat_results);
            *out = mal_string_new_copy(heap, units, length);
            return true;
        }
    }

    MAL_PERF_COUNT(string_cons_allocations);
    MAL_PERF_ADD(string_cons_code_units, length);
    mal_perf_string_allocation(length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_flat(string, MAL_STRING_STORAGE_CONS, left->latin1 && right->latin1, length);
    string->left = left;
    string->right = right;

    MalValue left_value = mal_value_from_string(left);
    MalValue right_value = mal_value_from_string(right);
    mal_gc_card(&string->header, left_value);
    mal_gc_card(&string->header, right_value);
    if (mal_gc_marking_active) {
        // Black allocation during an incremental mark must publish both new edges.
        mal_gc_satb_record(left_value);
        mal_gc_satb_record(right_value);
    }

    *out = string;
    return true;
}

static MalString *mal_string_new_latin1(
    MalHeap *heap, const u8 *units, usize length, bool owned, bool ascii
) {
    mal_string_require_valid_length(length);
    MalString *string;
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        c16 small[MAL_STRING_INLINE_CODE_UNITS];
        for (usize i = 0; i < length; i++) small[i] = units[i];
        MalTinyStringCacheResult result = mal_string_tiny_cache_get_or_create(heap, small, length);
        if (owned) gc_free_raw(heap, (void *) units);
        if (result.hit) return result.string;
        string = result.string;
    } else {
        string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
        if (length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
            mal_string_init_flat(string, MAL_STRING_STORAGE_INLINE, true, length);
            memcpy(string->inline_latin1_units, units, length);
            if (owned) gc_free_raw(heap, (void *) units);
            MAL_PERF_COUNT(string_inline_allocations);
            MAL_PERF_ADD(string_inline_code_units, length);
        } else {
            mal_string_init_flat(string, MAL_STRING_STORAGE_OWNED, true, length);
            if (owned) {
                string->latin1_units = units;
            } else {
                u8 *copy = mal_heap_alloc_raw_profiled(heap, length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
                memcpy(copy, units, length);
                string->latin1_units = copy;
            }
        }
    }
    mal_perf_string_allocation(length);
    if (ascii) {
        MAL_PERF_COUNT(string_ascii_allocations);
        MAL_PERF_ADD(string_ascii_code_units, length);
    } else if (owned) {
        MAL_PERF_COUNT(string_owned_allocations);
        MAL_PERF_ADD(string_owned_code_units, length);
    } else {
        MAL_PERF_COUNT(string_copy_allocations);
        MAL_PERF_ADD(string_copy_code_units, length);
    }
    return string;
}

MalString *mal_string_new_latin1_copy(MalHeap *heap, const u8 *units, usize length) {
    return mal_string_new_latin1(heap, units, length, false, false);
}

MalString *mal_string_new_latin1_owned(MalHeap *heap, const u8 *units, usize length) {
    return mal_string_new_latin1(heap, units, length, true, false);
}

MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    // RAW buffers survive collection until explicitly adopted or freed.
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        MalTinyStringCacheResult result = mal_string_tiny_cache_get_or_create(heap, code_units, length);
        gc_free_raw(heap, (void *) code_units);
        if (!result.hit) {
            mal_perf_string_allocation(length);
            MAL_PERF_COUNT(string_owned_allocations);
            MAL_PERF_ADD(string_owned_code_units, length);
        }
        return result.string;
    }
    if (mal_string_units_are_latin1(code_units, length)) {
        if (length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
            u8 small[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
            for (usize i = 0; i < length; i++) small[i] = (u8) code_units[i];
            gc_free_raw(heap, (void *) code_units);
            return mal_string_new_latin1_copy(heap, small, length);
        }
        u8 *compact = mal_heap_alloc_raw_profiled(heap, length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        for (usize i = 0; i < length; i++) compact[i] = (u8) code_units[i];
        gc_free_raw(heap, (void *) code_units);
        return mal_string_new_latin1_owned(heap, compact, length);
    }
    return mal_string_adopt_utf16(heap, code_units, length);
}

MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length) {
    return mal_string_new_latin1(heap, (const u8 *) bytes, length, false, true);
}

typedef struct MalStringFlattenTask {
    MalString *string;
    usize source_offset;
} MalStringFlattenTask;

const c16 *mal_string_flatten(MalString *mutable) {
    if (mutable->storage == MAL_STRING_STORAGE_DEPENDENT) {
        return mal_string_code_units(mutable->parent) + mutable->slice_offset;
    }
    if (mutable->storage != MAL_STRING_STORAGE_CONS) {
        if (!mutable->latin1) return mal_string_code_units(mutable);
        if (mutable->storage == MAL_STRING_STORAGE_INLINE && mutable->length <= MAL_STRING_INLINE_CODE_UNITS) {
            c16 units[MAL_STRING_INLINE_CODE_UNITS];
            for (usize i = 0; i < mutable->length; i++) units[i] = mutable->inline_latin1_units[i];
            memcpy(mutable->inline_code_units, units, mutable->length * sizeof(c16));
            mutable->latin1 = false;
            return mutable->inline_code_units;
        }
        MalHeap *heap = mal_gc_current_heap();
        c16 *units = mal_heap_alloc_raw_profiled(heap, sizeof(c16) * mutable->length,
            MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        const u8 *source = mutable->storage == MAL_STRING_STORAGE_INLINE
            ? mutable->inline_latin1_units : mutable->latin1_units;
        for (usize i = 0; i < mutable->length; i++) units[i] = source[i];
        if (mutable->storage == MAL_STRING_STORAGE_OWNED) gc_free_raw(heap, (void *) source);
        mutable->storage = MAL_STRING_STORAGE_OWNED;
        mutable->latin1 = false;
        mutable->code_units = units;
        return units;
    }

    MAL_PERF_COUNT(string_flatten_calls);
    MAL_PERF_ADD(string_flatten_code_units, mutable->length);
    MalStringFlattenTask inline_stack[64];
    usize capacity = sizeof(inline_stack) / sizeof(inline_stack[0]);
    MalStringFlattenTask *stack = inline_stack;

    c16 *code_units = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), sizeof(c16) * mutable->length,
        MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    usize count = 0;
    usize offset = 0;
    stack[count++] = (MalStringFlattenTask) {.string = mutable};

    while (count > 0) {
        MalStringFlattenTask task = stack[--count];
        if (task.string == nullptr) {
            MAL_PERF_COUNT(string_flatten_shared_copies);
            // The shared child has just filled [source_offset, offset); duplicate
            // that completed range instead of traversing the same DAG again.
            if (task.source_offset > offset) abort();
            usize copy_length = offset - task.source_offset;
            usize next_offset;
            if (!mal_checked_size_add(offset, copy_length, mutable->length, &next_offset)) {
                abort();
            }
            memcpy(code_units + offset, code_units + task.source_offset, sizeof(c16) * copy_length);
            offset = next_offset;
            continue;
        }

        MalString *part = task.string;
        if (part->storage != MAL_STRING_STORAGE_CONS) {
            MAL_PERF_COUNT(string_flatten_flat_leaves);
            usize next_offset;
            if (!mal_checked_size_add(offset, part->length, mutable->length, &next_offset)) {
                abort();
            }
            if (part->length > 0) {
                mal_string_copy_range_to(part, 0, part->length, code_units + offset);
            }
            offset = next_offset;
            continue;
        }
        MAL_PERF_COUNT(string_flatten_cons_nodes);

        usize required;
        if (!mal_checked_size_add(count, 2, MAL_STRING_MAX_CODE_UNITS, &required)) {
            abort();
        }
        if (required > capacity) {
            usize grown_capacity;
            if (!mal_checked_size_growth(capacity, required, 64, MAL_STRING_MAX_CODE_UNITS, &grown_capacity)) {
                abort();
            }
            MalStringFlattenTask *grown;
            if (stack == inline_stack) {
                grown = malloc(sizeof(MalStringFlattenTask) * grown_capacity);
                if (grown != nullptr) {
                    memcpy(grown, stack, sizeof(MalStringFlattenTask) * count);
                }
            } else {
                grown = realloc(
                    stack, sizeof(MalStringFlattenTask) * grown_capacity);
            }
            if (grown == nullptr) {
                abort();
            }
            stack = grown;
            capacity = grown_capacity;
        }

        if (part->left == part->right) {
            stack[count++] = (MalStringFlattenTask) {
                .string = nullptr,
                .source_offset = offset,
            };
            stack[count++] = (MalStringFlattenTask) {.string = part->left};
        } else {
            stack[count++] = (MalStringFlattenTask) {.string = part->right};
            stack[count++] = (MalStringFlattenTask) {.string = part->left};
        }
    }

    if (stack != inline_stack) free(stack);
    if (offset != mutable->length) {
        abort();
    }

    if (mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(mutable->left));
        mal_gc_satb_record(mal_value_from_string(mutable->right));
    }
    mutable->storage = MAL_STRING_STORAGE_OWNED;
    mutable->latin1 = false;
    mutable->code_units = code_units;
    return code_units;
}

static u64 mal_string_hash_segment(u64 hash, const MalStringSegment *segment) {
    if (segment->latin1) {
        for (usize i = 0; i < segment->length; i++) {
            hash ^= segment->latin1_units[i];
            hash *= 0x100000001b3;
            hash *= 0x100000001b3;
        }
    } else {
        for (usize i = 0; i < segment->length; i++) {
            c16 unit = segment->utf16_units[i];
            hash ^= (u8) unit;
            hash *= 0x100000001b3;
            hash ^= (u8) (unit >> 8);
            hash *= 0x100000001b3;
        }
    }
    return hash;
}

u64 mal_string_hash_slow(const MalString *string) {
    if (string->hash_valid) {
        MAL_PERF_COUNT(string_hash_cached_hits);
        return string->hash;
    }
    MAL_PERF_COUNT(string_hash_computes);
    if (string->storage == MAL_STRING_STORAGE_DEPENDENT) MAL_PERF_COUNT(string_hash_dependent_computes);
    u64 hash = 0xcbf29ce484222325;
    MalStringSegment segment;
    if (mal_string_try_get_segment(string, 0, string->length, &segment)) {
        hash = mal_string_hash_segment(hash, &segment);
    } else {
        MalStringIterator iterator;
        mal_string_iterator_init(&iterator, string, 0, string->length);
        while (mal_string_iterator_next(&iterator, &segment)) hash = mal_string_hash_segment(hash, &segment);
        mal_string_iterator_dispose(&iterator);
    }
    MalString *mutable = (MalString *) string;
    mutable->hash = hash;
    mutable->hash_valid = true;
    return hash;
}

#define MAL_STRING_STRUCTURAL_COMPARE_CAPACITY ((usize) 64)

typedef struct MalStringComparePair {
    const MalString *left;
    const MalString *right;
} MalStringComparePair;

static i32 mal_string_compare_code_units(
    const c16 *left, const c16 *right, usize length
) {
    usize index = 0;
    while (length - index >= 4) {
        u64 left_word;
        u64 right_word;
        memcpy(&left_word, left + index, sizeof(left_word));
        memcpy(&right_word, right + index, sizeof(right_word));
        if (left_word != right_word) {
            for (usize lane = 0; lane < 4; lane++) {
                c16 left_unit = left[index + lane];
                c16 right_unit = right[index + lane];
                if (left_unit < right_unit) return -1;
                if (left_unit > right_unit) return 1;
            }
            abort();
        }
        index += 4;
    }
    while (index < length) {
        c16 left_unit = left[index];
        c16 right_unit = right[index];
        if (left_unit < right_unit) return -1;
        if (left_unit > right_unit) return 1;
        index++;
    }
    return 0;
}

static i32 mal_string_compare_segments(
    const MalStringSegment *left, usize left_offset,
    const MalStringSegment *right, usize right_offset, usize length, bool equality_only
) {
    if (left->latin1 && right->latin1) {
        int result = memcmp(left->latin1_units + left_offset, right->latin1_units + right_offset, length);
        return result < 0 ? -1 : result > 0 ? 1 : 0;
    }
    if (!left->latin1 && !right->latin1) {
        if (equality_only) {
            return memcmp(left->utf16_units + left_offset, right->utf16_units + right_offset,
                length * sizeof(c16)) != 0;
        }
        return mal_string_compare_code_units(left->utf16_units + left_offset, right->utf16_units + right_offset, length);
    }
    for (usize i = 0; i < length; i++) {
        c16 a = mal_string_segment_code_unit_at(left, left_offset + i);
        c16 b = mal_string_segment_code_unit_at(right, right_offset + i);
        if (a < b) return -1;
        if (a > b) return 1;
    }
    return 0;
}

static i32 mal_string_compare_prefix(
    const MalString *left, const MalString *right, usize length, bool equality_only
) {
    if (length == 0) return 0;
    MalStringSegment a, b;
    if (mal_string_try_get_segment(left, 0, length, &a) &&
        mal_string_try_get_segment(right, 0, length, &b)) {
        return mal_string_compare_segments(&a, 0, &b, 0, length, equality_only);
    }
    MalStringIterator left_iterator;
    MalStringIterator right_iterator;
    mal_string_iterator_init(&left_iterator, left, 0, length);
    mal_string_iterator_init(&right_iterator, right, 0, length);
    if (!mal_string_iterator_next(&left_iterator, &a) || !mal_string_iterator_next(&right_iterator, &b)) abort();
    usize left_offset = 0, right_offset = 0;
    i32 result = 0;
    while (length > 0) {
        usize take = a.length - left_offset;
        if (take > b.length - right_offset) take = b.length - right_offset;
        result = mal_string_compare_segments(&a, left_offset, &b, right_offset, take, equality_only);
        if (result != 0) break;
        length -= take;
        left_offset += take;
        right_offset += take;
        if (length == 0) break;
        if (left_offset == a.length) {
            if (!mal_string_iterator_next(&left_iterator, &a)) abort();
            left_offset = 0;
        }
        if (right_offset == b.length) {
            if (!mal_string_iterator_next(&right_iterator, &b)) abort();
            right_offset = 0;
        }
    }
    mal_string_iterator_dispose(&left_iterator);
    mal_string_iterator_dispose(&right_iterator);
    return result;
}

/**
 * Compare equally sized, identically partitioned ropes without flattening them.
 * Repeat builds shared DAGs, so matching duplicated children only need one visit.
 * Return false when the partitions or depth do not fit this bounded fast path.
 */
static bool mal_string_compare_structural(
    const MalString *left, const MalString *right, i32 *result_out, bool equality_only
) {
    if (left->length != right->length ||
        left->storage != MAL_STRING_STORAGE_CONS ||
        right->storage != MAL_STRING_STORAGE_CONS) {
        return false;
    }
    MalStringComparePair stack[MAL_STRING_STRUCTURAL_COMPARE_CAPACITY];
    usize count = 1;
    stack[0] = (MalStringComparePair) {.left = left, .right = right};

    while (count > 0) {
        MalStringComparePair pair = stack[--count];
        if (pair.left == pair.right) continue;
        if (pair.left->length != pair.right->length) return false;

        bool left_cons = pair.left->storage == MAL_STRING_STORAGE_CONS;
        bool right_cons = pair.right->storage == MAL_STRING_STORAGE_CONS;
        if (left_cons || right_cons) {
            if (!left_cons || !right_cons ||
                pair.left->left->length != pair.right->left->length) {
                return false;
            }
            if (pair.left->left == pair.left->right &&
                pair.right->left == pair.right->right) {
                if (count == MAL_STRING_STRUCTURAL_COMPARE_CAPACITY) return false;
                stack[count++] = (MalStringComparePair) {
                    .left = pair.left->left,
                    .right = pair.right->left,
                };
                continue;
            }
            if (count > MAL_STRING_STRUCTURAL_COMPARE_CAPACITY - 2) return false;
            stack[count++] = (MalStringComparePair) {
                .left = pair.left->right,
                .right = pair.right->right,
            };
            stack[count++] = (MalStringComparePair) {
                .left = pair.left->left,
                .right = pair.right->left,
            };
            continue;
        }

        i32 result = mal_string_compare_prefix(pair.left, pair.right, pair.left->length, equality_only);
        if (result != 0) {
            *result_out = result;
            return true;
        }
    }

    *result_out = 0;
    return true;
}

bool mal_string_equals(const MalString *left, const MalString *right) {
    MAL_PERF_COUNT(string_equals_calls);
    if (left == right) {
        MAL_PERF_COUNT(string_pointer_hits);
        return true;
    }

    if (left->length != right->length) {
        MAL_PERF_COUNT(string_length_misses);
        return false;
    }
    // Computing a missing hash adds an unnecessary full pass before comparison.
    if (left->hash_valid && right->hash_valid && left->hash != right->hash) {
        MAL_PERF_COUNT(string_hash_misses);
        return false;
    }
    i32 structural_result;
    if (mal_string_compare_structural(left, right, &structural_result, true)) {
        return structural_result == 0;
    }

    MAL_PERF_COUNT(string_memcmp_calls);
    MAL_PERF_ADD(string_memcmp_code_units, left->length);
    return mal_string_compare_prefix(left, right, left->length, true) == 0;
}

i32 mal_string_compare(const MalString *left, const MalString *right) {
    usize min_length = left->length < right->length ? left->length : right->length;
    i32 structural_result;
    if (mal_string_compare_structural(left, right, &structural_result, false)) {
        return structural_result;
    }
    i32 result = mal_string_compare_prefix(left, right, min_length, false);
    if (result != 0) return result;

    if (left->length < right->length) {
        return -1;
    }

    if (left->length > right->length) {
        return 1;
    }

    return 0;
}
