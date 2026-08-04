#include "heap_string.h"

#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "checked_size.h"
#include "perf_stats.h"

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

static void mal_string_init_inline(
    MalString *string,
    const c16 *code_units,
    usize length
) {
    if (length > MAL_STRING_INLINE_CODE_UNITS) abort();
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_INLINE;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->length = length;
    if (length > 0) {
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

void mal_string_init_copy(MalHeap *heap, MalString *string, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        mal_string_init_inline(string, code_units, length);
        return;
    }
    c16 *owned_code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    if (length > 0) {
        memcpy(owned_code_units, code_units, sizeof(c16) * length);
    }

    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->length = length;
    string->code_units = owned_code_units;
}

void mal_string_init_external(MalString *string, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_EXTERNAL;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->length = length;
    string->code_units = code_units;
}

MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
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

typedef struct MalStringRangePart {
    MalString *string;
    usize offset;
} MalStringRangePart;

static MalString *mal_string_copy_range(
    MalHeap *heap,
    MalString *parent,
    usize offset,
    usize length
) {
    usize capacity = 64;
    MalStringRangePart *stack = malloc(sizeof(MalStringRangePart) * capacity);
    if (stack == nullptr) abort();

    c16 *code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);
    usize count = 0;
    usize end = offset + length;
    stack[count++] = (MalStringRangePart) {.string = parent, .offset = 0};

    while (count > 0) {
        MalStringRangePart current = stack[--count];
        MalString *part = current.string;
        usize part_end = current.offset + part->length;
        if (part_end <= offset || current.offset >= end) continue;

        if (part->storage != MAL_STRING_STORAGE_CONS) {
            usize copy_start = current.offset > offset ? current.offset : offset;
            usize copy_end = part_end < end ? part_end : end;
            memcpy(
                code_units + copy_start - offset,
                mal_string_code_units(part) + copy_start - current.offset,
                sizeof(c16) * (copy_end - copy_start)
            );
            continue;
        }

        usize required = count + 2;
        if (required > capacity) {
            usize grown_capacity;
            if (!mal_checked_size_growth(
                    capacity, required, 64, MAL_STRING_MAX_CODE_UNITS, &grown_capacity
                )) {
                abort();
            }
            MalStringRangePart *grown =
                realloc(stack, sizeof(MalStringRangePart) * grown_capacity);
            if (grown == nullptr) abort();
            stack = grown;
            capacity = grown_capacity;
        }

        stack[count++] = (MalStringRangePart) {
            .string = part->right,
            .offset = current.offset + part->left->length,
        };
        stack[count++] = (MalStringRangePart) {
            .string = part->left,
            .offset = current.offset,
        };
    }

    free(stack);
    return mal_string_new_owned(heap, code_units, length);
}

static void mal_string_resolve_slice(
    MalString *parent,
    usize offset,
    usize length,
    const c16 **code_units_out,
    MalString **flat_parent_out
) {
    mal_string_require_valid_length(length);
    if (parent == nullptr) {
        abort();
    }
    mal_string_require_valid_length(parent->length);

    // A dependent string stores an interior pointer, so make that pointer stable
    // before retaining the ultimate flat parent.
    const c16 *parent_code_units = mal_string_code_units(parent);

    usize end;
    if (!mal_checked_size_add(offset, length, parent->length, &end) ||
        end > parent->length) {
        abort();
    }

    MalString *flat_parent;
    switch (parent->storage) {
        case MAL_STRING_STORAGE_OWNED:
        case MAL_STRING_STORAGE_INLINE:
        case MAL_STRING_STORAGE_EXTERNAL:
            flat_parent = parent;
            break;
        case MAL_STRING_STORAGE_DEPENDENT:
            flat_parent = parent->parent;
            if (flat_parent == nullptr ||
                (flat_parent->storage != MAL_STRING_STORAGE_OWNED &&
                 flat_parent->storage != MAL_STRING_STORAGE_INLINE &&
                 flat_parent->storage != MAL_STRING_STORAGE_EXTERNAL)) {
                abort();
            }
            break;
        case MAL_STRING_STORAGE_CONS:
            // mal_string_code_units above converts cons strings in place.
            abort();
        default:
            abort();
    }

    *code_units_out = offset == 0 ? parent_code_units : parent_code_units + offset;
    *flat_parent_out = flat_parent;
}

static MalString *mal_string_new_dependent_resolved(
    MalHeap *heap,
    MalString *flat_parent,
    const c16 *code_units,
    usize length
) {
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_dependent_allocations);
    MAL_PERF_ADD(string_dependent_code_units, length);
    MAL_PERF_ADD(string_dependent_retained_code_units, flat_parent->length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_DEPENDENT;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->parent = flat_parent;
    string->length = length;
    string->code_units = code_units;

    mal_gc_card(&string->header, mal_value_from_string(flat_parent));
    if (mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(flat_parent));
    }

    return string;
}

MalString *mal_string_new_slice(MalHeap *heap, MalString *parent, usize offset, usize length) {
    if (parent == nullptr) abort();
    MAL_PERF_COUNT(string_slice_calls);
    MAL_PERF_ADD(string_slice_requested_code_units, length);
    usize end;
    if (!mal_checked_size_add(offset, length, parent->length, &end) ||
        end > parent->length) {
        abort();
    }

    // Empty strings retain no useful backing data. Copying also keeps a zero-length
    // slice from pinning an otherwise unreachable parent.
    if (length == 0) {
        MAL_PERF_COUNT(string_slice_empty_results);
        return mal_string_new_ascii(heap, "", 0);
    }
    if (offset == 0 && length == parent->length) {
        MAL_PERF_COUNT(string_slice_full_reuses);
        return parent;
    }
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        MAL_PERF_COUNT(string_slice_copy_results);
        return mal_string_new_copy(
            heap, mal_string_code_units(parent) + offset, length
        );
    }

    usize minimum_dependent_length =
        (parent->length + MAL_STRING_SLICE_MAX_RETAINED_RATIO - 1) /
        MAL_STRING_SLICE_MAX_RETAINED_RATIO;
    if (parent->storage == MAL_STRING_STORAGE_CONS &&
        parent->length > MAL_STRING_SLICE_SMALL_PARENT_CODE_UNITS &&
        length < minimum_dependent_length) {
        MAL_PERF_COUNT(string_slice_copy_results);
        return mal_string_copy_range(heap, parent, offset, length);
    }

    const c16 *code_units;
    MalString *flat_parent;
    mal_string_resolve_slice(parent, offset, length, &code_units, &flat_parent);
    minimum_dependent_length =
        (flat_parent->length + MAL_STRING_SLICE_MAX_RETAINED_RATIO - 1) /
        MAL_STRING_SLICE_MAX_RETAINED_RATIO;
    bool use_dependent =
        flat_parent->storage == MAL_STRING_STORAGE_EXTERNAL ||
        flat_parent->length <= MAL_STRING_SLICE_SMALL_PARENT_CODE_UNITS ||
        length >= minimum_dependent_length;

    if (!use_dependent) {
        MAL_PERF_COUNT(string_slice_copy_results);
        return mal_string_new_copy(heap, code_units, length);
    }
    MAL_PERF_COUNT(string_slice_dependent_results);
    return mal_string_new_dependent_resolved(heap, flat_parent, code_units, length);
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

    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        c16 code_units[MAL_STRING_INLINE_CODE_UNITS];
        memcpy(code_units, mal_string_code_units(left), sizeof(c16) * left->length);
        memcpy(
            code_units + left->length,
            mal_string_code_units(right),
            sizeof(c16) * right->length
        );
        MAL_PERF_COUNT(string_inline_concat_results);
        *out = mal_string_new_copy(heap, code_units, length);
        return true;
    }

    MAL_PERF_COUNT(string_cons_allocations);
    MAL_PERF_ADD(string_cons_code_units, length);
    mal_perf_string_allocation(length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_CONS;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->left = left;
    string->length = length;
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

MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_owned_allocations);
    MAL_PERF_ADD(string_owned_code_units, length);
    // Takes ownership of `code_units` (a mal_heap_alloc_raw buffer) — no copy. The
    // cell allocation may run a GC, but an unowned RAW buffer is never swept (the
    // sweep only walks CELL blocks), so `code_units` survives until we adopt it.
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        mal_string_init_inline(string, code_units, length);
        gc_free_raw(heap, (void *) code_units);
        return string;
    }
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->length = length;
    string->code_units = code_units;

    return string;
}

MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length) {
    mal_string_require_valid_length(length);
    mal_perf_string_allocation(length);
    MAL_PERF_COUNT(string_ascii_allocations);
    MAL_PERF_ADD(string_ascii_code_units, length);
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        c16 code_units[MAL_STRING_INLINE_CODE_UNITS];
        for (usize i = 0; i < length; i++) {
            code_units[i] = (u8) bytes[i];
        }
        MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
        mal_string_init_inline(string, code_units, length);
        return string;
    }
    c16 *code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    for (usize i = 0; i < length; i++) {
        code_units[i] = (u8) bytes[i];
    }

    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->array_index_impossible = false;
    string->property_atom = false;
    string->length = length;
    string->code_units = code_units;

    return string;
}

typedef struct MalStringFlattenTask {
    MalString *string;
    usize source_offset;
} MalStringFlattenTask;

const c16 *mal_string_flatten(MalString *mutable) {
    MAL_PERF_COUNT(string_flatten_calls);
    MAL_PERF_ADD(string_flatten_code_units, mutable->length);
    usize capacity = 64;
    MalStringFlattenTask *stack = malloc(sizeof(MalStringFlattenTask) * capacity);
    if (stack == nullptr) {
        abort();
    }

    c16 *code_units = mal_heap_alloc_raw(mal_gc_current_heap(), sizeof(c16) * mutable->length);
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
                memcpy(
                    code_units + offset,
                    mal_string_code_units(part),
                    sizeof(c16) * part->length
                );
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
            MalStringFlattenTask *grown =
                realloc(stack, sizeof(MalStringFlattenTask) * grown_capacity);
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

    free(stack);
    if (offset != mutable->length) {
        abort();
    }

    if (mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(mutable->left));
        mal_gc_satb_record(mal_value_from_string(mutable->right));
    }
    mutable->storage = MAL_STRING_STORAGE_OWNED;
    mutable->hash_valid = false;
    mutable->code_units = code_units;
    return code_units;
}

u64 mal_string_hash_slow(const MalString *string) {
    if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
        MAL_PERF_COUNT(string_hash_computes);
        MAL_PERF_COUNT(string_hash_dependent_computes);
        return mal_string_hash_code_units(string->code_units, string->length);
    }

    MalString *mutable = (MalString *) string;
    if (string->storage == MAL_STRING_STORAGE_CONS) {
        MAL_PERF_COUNT(string_hash_cons_flattens);
    }
    const c16 *code_units = mal_string_code_units(string);
    if (!mutable->hash_valid) {
        MAL_PERF_COUNT(string_hash_computes);
        mutable->hash = mal_string_hash_code_units(code_units, string->length);
        mutable->hash_valid = true;
    } else {
        MAL_PERF_COUNT(string_hash_cached_hits);
    }
    return mutable->hash;
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
    // Hashing is only a useful prefilter when both hashes already exist. Computing
    // either one here adds a full code-unit pass before memcmp, and dependent
    // strings cannot cache that work because their union word retains the parent.
    bool left_hash_cached = left->storage != MAL_STRING_STORAGE_DEPENDENT &&
        left->storage != MAL_STRING_STORAGE_CONS && left->hash_valid;
    bool right_hash_cached = right->storage != MAL_STRING_STORAGE_DEPENDENT &&
        right->storage != MAL_STRING_STORAGE_CONS && right->hash_valid;
    if (left_hash_cached && right_hash_cached && left->hash != right->hash) {
        MAL_PERF_COUNT(string_hash_misses);
        return false;
    }

    MAL_PERF_COUNT(string_memcmp_calls);
    MAL_PERF_ADD(string_memcmp_code_units, left->length);
    return memcmp(mal_string_code_units(left), mal_string_code_units(right), sizeof(c16) * left->length) == 0;
}

i32 mal_string_compare(const MalString *left, const MalString *right) {
    usize min_length = left->length < right->length ? left->length : right->length;
    const c16 *left_code_units = mal_string_code_units(left);
    const c16 *right_code_units = mal_string_code_units(right);

    for (usize i = 0; i < min_length; i++) {
        c16 left_code_unit = left_code_units[i];
        c16 right_code_unit = right_code_units[i];

        if (left_code_unit < right_code_unit) {
            return -1;
        }

        if (left_code_unit > right_code_unit) {
            return 1;
        }
    }

    if (left->length < right->length) {
        return -1;
    }

    if (left->length > right->length) {
        return 1;
    }

    return 0;
}
