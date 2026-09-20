#include "perf_stats.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "value.h"

#if MAL_PERF_STATS
#define MAL_PERF_INTRINSIC_NAME_CAPACITY 2048
#define MAL_PERF_INTRINSIC_NAME_MAX_LENGTH 63
#define MAL_PERF_NATIVE_NAME_CAPACITY 512
#define MAL_PERF_NATIVE_NAME_MAX_LENGTH 63
#define MAL_PERF_COLLECTION_RECORD_INITIAL_CAPACITY (1u << 16)

typedef struct MalPerfIntrinsicName {
    u64 hash;
    u64 calls;
    u32 length;
    byte name[MAL_PERF_INTRINSIC_NAME_MAX_LENGTH + 1];
} MalPerfIntrinsicName;

typedef struct MalPerfNativeName {
    u64 hash;
    u64 calls;
    u32 length;
    c16 name[MAL_PERF_NATIVE_NAME_MAX_LENGTH + 1];
} MalPerfNativeName;

typedef struct MalPerfCollectionRecord {
    const void *collection;
    u64 iteration_steps;
    usize peak_size;
    usize current_size;
    u32 birth_epoch;
    u32 mutations;
    u32 iterations;
    MalPerfCollectionKind kind;
    u8 array_element_mask;
    u8 collection_key_mask;
} MalPerfCollectionRecord;

static u32 mal_perf_collection_latest_epoch;
static usize mal_perf_collection_record_capacity;
static usize mal_perf_collection_record_live;
static usize mal_perf_collection_record_occupied;

bool mal_perf_stats_enabled = false;
MalPerfStats mal_perf_stats;
static MalPerfIntrinsicName mal_perf_intrinsic_names[MAL_PERF_INTRINSIC_NAME_CAPACITY];
static MalPerfNativeName mal_perf_native_names[MAL_PERF_NATIVE_NAME_CAPACITY];
static MalPerfCollectionRecord *mal_perf_collection_records;

static const char *const mal_perf_collection_kinds[MAL_PERF_COLLECTION_KIND_COUNT] = {
    "array",
    "map",
    "set",
    "weak_map",
    "weak_set",
};

static usize mal_perf_collection_record_index(
    const void *collection, usize capacity
) {
    uptr hash = (uptr) collection >> 4;
    hash ^= hash >> 17;
    hash *= (uptr) 0xed5ad4bbU;
    return (usize) hash & (capacity - 1);
}

static bool mal_perf_collection_records_resize(usize capacity) {
    MalPerfCollectionRecord *records = calloc(
        capacity, sizeof(MalPerfCollectionRecord));
    if (records == nullptr) return false;

    usize live = 0;
    for (usize index = 0; index < mal_perf_collection_record_capacity; index++) {
        MalPerfCollectionRecord record = mal_perf_collection_records[index];
        if (record.collection == nullptr ||
            record.collection == (const void *) (uptr) 1) {
            continue;
        }
        usize destination = mal_perf_collection_record_index(
            record.collection, capacity);
        while (records[destination].collection != nullptr) {
            destination = (destination + 1) & (capacity - 1);
        }
        records[destination] = record;
        live++;
    }

    free(mal_perf_collection_records);
    mal_perf_collection_records = records;
    mal_perf_collection_record_capacity = capacity;
    mal_perf_collection_record_live = live;
    mal_perf_collection_record_occupied = live;
    return true;
}

static bool mal_perf_collection_records_prepare_insert(void) {
    if (mal_perf_collection_record_capacity == 0) {
        return mal_perf_collection_records_resize(
            MAL_PERF_COLLECTION_RECORD_INITIAL_CAPACITY);
    }
    if ((mal_perf_collection_record_occupied + 1) * 10 <
        mal_perf_collection_record_capacity * 7) {
        return true;
    }
    usize capacity = (mal_perf_collection_record_live + 1) * 10 >=
            mal_perf_collection_record_capacity * 7
        ? mal_perf_collection_record_capacity * 2
        : mal_perf_collection_record_capacity;
    return capacity > mal_perf_collection_record_capacity ||
            mal_perf_collection_record_live < mal_perf_collection_record_capacity
        ? mal_perf_collection_records_resize(capacity)
        : false;
}

static MalPerfCollectionRecord *mal_perf_collection_record(
    const void *collection, bool insert
) {
    if (insert && !mal_perf_collection_records_prepare_insert()) return nullptr;
    if (mal_perf_collection_record_capacity == 0) return nullptr;
    usize index = mal_perf_collection_record_index(
        collection, mal_perf_collection_record_capacity);
    MalPerfCollectionRecord *tombstone = nullptr;
    for (usize probe = 0; probe < mal_perf_collection_record_capacity; probe++) {
        MalPerfCollectionRecord *record = &mal_perf_collection_records[index];
        if (record->collection == collection) return record;
        if (record->collection == nullptr) {
            if (!insert) return nullptr;
            if (tombstone != nullptr) {
                mal_perf_collection_record_live++;
                return tombstone;
            }
            mal_perf_collection_record_live++;
            mal_perf_collection_record_occupied++;
            return record;
        }
        if (record->collection == (const void *) (uptr) 1 && tombstone == nullptr) {
            tombstone = record;
        }
        index = (index + 1) & (mal_perf_collection_record_capacity - 1);
    }
    if (tombstone != nullptr && insert) mal_perf_collection_record_live++;
    return tombstone;
}

static usize mal_perf_collection_size_bucket(usize size) {
    if (size == 0) return 0;
    if (size == 1) return 1;
    if (size < 8) return 2;
    if (size < 32) return 3;
    if (size < 256) return 4;
    return 5;
}

static usize mal_perf_collection_lifetime_bucket(u32 epochs) {
    if (epochs == 0) return 0;
    if (epochs == 1) return 1;
    if (epochs < 4) return 2;
    return 3;
}

static usize mal_perf_collection_mutation_bucket(u32 mutations) {
    if (mutations == 0) return 0;
    if (mutations == 1) return 1;
    if (mutations < 8) return 2;
    if (mutations < 32) return 3;
    return 4;
}

static usize mal_perf_collection_iteration_bucket(u32 iterations) {
    if (iterations == 0) return 0;
    if (iterations == 1) return 1;
    if (iterations < 8) return 2;
    return 3;
}

static usize mal_perf_collection_key_shape(u8 mask) {
    if (mask == 0) return 0;
    if (mask == (1u << 0)) return 1;
    if (mask == (1u << 1)) return 2;
    if (mask == ((1u << 0) | (1u << 1))) return 3;
    if (mask == (1u << 2)) return 4;
    if (mask == (1u << 3)) return 5;
    if (mask == (1u << 4)) return 6;
    if ((mask & ((1u << 5) | (1u << 6))) != 0 &&
        (mask & ~((1u << 5) | (1u << 6))) == 0) {
        return 7;
    }
    return 8;
}

void mal_perf_collection_new(
    const void *collection, MalPerfCollectionKind kind, u32 epoch
) {
    if (!mal_perf_stats_enabled) return;
    if (epoch > mal_perf_collection_latest_epoch) {
        mal_perf_collection_latest_epoch = epoch;
    }
    mal_perf_stats.collection_allocations[kind]++;
    MalPerfCollectionRecord *record = mal_perf_collection_record(collection, true);
    if (record == nullptr) {
        mal_perf_stats.collection_tracking_overflows++;
        return;
    }
    *record = (MalPerfCollectionRecord) {
        .collection = collection,
        .birth_epoch = epoch,
        .kind = kind,
    };
}

void mal_perf_collection_mutation(const void *collection, usize size) {
    if (!mal_perf_stats_enabled) return;
    MalPerfCollectionRecord *record = mal_perf_collection_record(collection, false);
    if (record == nullptr) return;
    record->mutations++;
    record->current_size = size;
    if (size > record->peak_size) record->peak_size = size;
    mal_perf_stats.collection_mutation_events[record->kind]++;
}

void mal_perf_collection_iteration_start(const void *collection) {
    if (!mal_perf_stats_enabled) return;
    MalPerfCollectionRecord *record = mal_perf_collection_record(collection, false);
    if (record == nullptr) return;
    record->iterations++;
    mal_perf_stats.collection_iteration_starts[record->kind]++;
}

void mal_perf_collection_iteration_step(const void *collection) {
    if (!mal_perf_stats_enabled) return;
    MalPerfCollectionRecord *record = mal_perf_collection_record(collection, false);
    if (record == nullptr) return;
    record->iteration_steps++;
    mal_perf_stats.collection_iteration_steps[record->kind]++;
}

void mal_perf_collection_epoch(u32 epoch) {
    if (mal_perf_stats_enabled && epoch > mal_perf_collection_latest_epoch) {
        mal_perf_collection_latest_epoch = epoch;
    }
}

static void mal_perf_collection_summarize(
    MalPerfCollectionRecord *record,
    MalPerfCollectionKind kind,
    u32 epoch,
    usize size,
    u8 array_element_mask,
    u8 collection_key_mask,
    bool array_deoptimized,
    bool live_snapshot
) {
    if (live_snapshot) mal_perf_stats.collection_live_snapshots[kind]++;
    else mal_perf_stats.collection_finalizations[kind]++;
    mal_perf_stats.collection_final_sizes[kind][mal_perf_collection_size_bucket(size)]++;
    if (record == nullptr) {
        mal_perf_stats.collection_tracking_misses++;
    } else {
        mal_perf_stats.collection_peak_sizes[kind][mal_perf_collection_size_bucket(record->peak_size)]++;
        mal_perf_stats.collection_lifetimes[kind][mal_perf_collection_lifetime_bucket(epoch - record->birth_epoch)]++;
        mal_perf_stats.collection_mutations[kind][mal_perf_collection_mutation_bucket(record->mutations)]++;
        mal_perf_stats.collection_iterations[kind][mal_perf_collection_iteration_bucket(record->iterations)]++;
        if (live_snapshot) collection_key_mask = record->collection_key_mask;
        record->collection = (const void *) (uptr) 1;
        mal_perf_collection_record_live--;
    }
    mal_perf_stats.collection_key_shapes[kind][
        mal_perf_collection_key_shape(collection_key_mask)]++;
    if (kind != MAL_PERF_COLLECTION_ARRAY) return;
    if (array_deoptimized) {
        mal_perf_stats.array_final_deoptimized++;
        return;
    }
    usize final_kind = array_element_mask == 0 ? 0 :
        array_element_mask == 1 ? 1 :
        array_element_mask == 2 ? 2 :
        array_element_mask == 3 ? 3 :
        array_element_mask == 4 ? 4 : 5;
    mal_perf_stats.array_final_kinds[final_kind]++;
}

void mal_perf_collection_finalize(
    const void *collection,
    MalPerfCollectionKind kind,
    u32 epoch,
    usize size,
    u8 array_element_mask,
    u8 collection_key_mask,
    bool array_deoptimized
) {
    if (!mal_perf_stats_enabled) return;
    if (epoch > mal_perf_collection_latest_epoch) {
        mal_perf_collection_latest_epoch = epoch;
    }
    mal_perf_collection_summarize(
        mal_perf_collection_record(collection, false),
        kind,
        epoch,
        size,
        array_element_mask,
        collection_key_mask,
        array_deoptimized,
        false);
}

static void mal_perf_collection_snapshot_live(void) {
    for (usize index = 0; index < mal_perf_collection_record_capacity; index++) {
        MalPerfCollectionRecord *record = &mal_perf_collection_records[index];
        if (record->collection == nullptr ||
            record->collection == (const void *) (uptr) 1) {
            continue;
        }
        mal_perf_collection_summarize(
            record,
            record->kind,
            mal_perf_collection_latest_epoch,
            record->current_size,
            record->array_element_mask,
            record->collection_key_mask,
            false,
            true);
    }
}

u8 mal_perf_collection_key_bit(u64 value) {
    usize kind = mal_value_is_int32(value) ? 0 :
        (mal_value_is_f64_or_nan(value) || value == MAL_VALUE_NEGATIVE_ZERO ||
            value == MAL_VALUE_POSITIVE_INFINITY || value == MAL_VALUE_NEGATIVE_INFINITY) ? 1 :
        mal_value_is_string(value) ? 2 :
        mal_value_is_symbol(value) ? 3 :
        mal_value_is_object(value) ? 4 :
        mal_value_is_bigint(value) ? 5 : 6;
    return (u8) (1u << kind);
}

void mal_perf_collection_key_value(const void *collection, u64 value) {
    if (!mal_perf_stats_enabled) return;
    MalPerfCollectionRecord *record = mal_perf_collection_record(collection, false);
    if (record == nullptr) return;
    u8 bit = mal_perf_collection_key_bit(value);
    usize kind = 0;
    while (((u8) (1u << kind) & bit) == 0) kind++;
    mal_perf_stats.collection_key_kinds[record->kind][kind]++;
    record->collection_key_mask |= bit;
}

void mal_perf_array_element_write(const void *array, u64 value) {
    if (!mal_perf_stats_enabled) return;
    usize kind = mal_value_is_int32(value) ? 0 :
        (mal_value_is_f64_or_nan(value) || value == MAL_VALUE_NEGATIVE_ZERO ||
            value == MAL_VALUE_POSITIVE_INFINITY || value == MAL_VALUE_NEGATIVE_INFINITY) ? 1 : 2;
    mal_perf_stats.array_element_writes[kind]++;
    MalPerfCollectionRecord *record = mal_perf_collection_record(array, false);
    if (record == nullptr) return;
    u8 bit = (u8) (1u << kind);
    if ((record->array_element_mask & bit) == 0 && record->array_element_mask != 0) {
        mal_perf_stats.array_element_kind_widenings++;
    }
    record->array_element_mask |= bit;
}

static const char *const mal_perf_table_roles[MAL_PERF_TABLE_ROLE_COUNT] = {
    "object",
    "atoms",
    "symbol_registry",
    "map",
};

static const char *const mal_perf_shape_callers[MAL_PERF_SHAPE_CALLER_COUNT] = {
    "get_own",
    "define_own",
    "delete_own",
    "set_own",
    "load_ic",
    "store_ic",
};

static bool mal_perf_ic_mode_is_chain(usize mode) {
    return mode == 1 || mode == 5 || mode == 6 || mode == 7;
}

void mal_perf_intrinsic_name(const byte *name, usize length) {
    if (!mal_perf_stats_enabled || length > MAL_PERF_INTRINSIC_NAME_MAX_LENGTH) {
        return;
    }

    u64 hash = 1469598103934665603ULL;
    for (usize i = 0; i < length; i++) {
        hash ^= name[i];
        hash *= 1099511628211ULL;
    }

    usize index = hash & (MAL_PERF_INTRINSIC_NAME_CAPACITY - 1);
    for (usize probe = 0; probe < MAL_PERF_INTRINSIC_NAME_CAPACITY; probe++) {
        MalPerfIntrinsicName *entry = &mal_perf_intrinsic_names[index];
        if (entry->calls == 0) {
            entry->hash = hash;
            entry->length = (u32) length;
            memcpy(entry->name, name, length);
            entry->name[length] = '\0';
            entry->calls = 1;
            return;
        }
        if (entry->hash == hash && entry->length == length && memcmp(entry->name, name, length) == 0) {
            entry->calls++;
            return;
        }
        index = (index + 1) & (MAL_PERF_INTRINSIC_NAME_CAPACITY - 1);
    }
}

void mal_perf_native_call_name(const c16 *name, usize length) {
    if (!mal_perf_stats_enabled || length > MAL_PERF_NATIVE_NAME_MAX_LENGTH) {
        return;
    }
    u64 hash = 1469598103934665603ULL;
    for (usize i = 0; i < length; i++) {
        hash ^= name[i];
        hash *= 1099511628211ULL;
    }
    usize index = hash & (MAL_PERF_NATIVE_NAME_CAPACITY - 1);
    for (usize probe = 0; probe < MAL_PERF_NATIVE_NAME_CAPACITY; probe++) {
        MalPerfNativeName *entry = &mal_perf_native_names[index];
        if (entry->calls == 0) {
            entry->hash = hash;
            entry->length = (u32) length;
            memcpy(entry->name, name, length * sizeof(c16));
            entry->name[length] = 0;
            entry->calls = 1;
            return;
        }
        if (entry->hash == hash && entry->length == length &&
            memcmp(entry->name, name, length * sizeof(c16)) == 0) {
            entry->calls++;
            return;
        }
        index = (index + 1) & (MAL_PERF_NATIVE_NAME_CAPACITY - 1);
    }
}

static void mal_perf_stats_print(void) {
    mal_perf_collection_snapshot_live();
    fprintf(
        stderr,
        "[perf-string-stats] key_equals_calls=%llu key_pointer_hits=%llu "
        "key_string_fallbacks=%llu key_non_string_misses=%llu "
        "string_equals_calls=%llu string_pointer_hits=%llu string_length_misses=%llu "
        "string_hash_misses=%llu string_memcmp_calls=%llu string_memcmp_code_units=%llu "
        "hash_calls=%llu hash_cached_hits=%llu hash_computes=%llu "
        "hash_dependent_computes=%llu hash_cons_flattens=%llu "
        "search_calls=%llu search_multi_unit_calls=%llu search_candidates=%llu "
        "search_first_unit_rejects=%llu search_last_unit_rejects=%llu "
        "search_memcmp_calls=%llu search_memcmp_code_units=%llu "
        "reverse_search_calls=%llu reverse_search_candidates=%llu "
        "reverse_search_first_unit_rejects=%llu "
        "reverse_search_last_unit_rejects=%llu "
        "reverse_search_memcmp_calls=%llu reverse_search_memcmp_code_units=%llu "
        "unit_scan_word_blocks=%llu unit_scan_candidate_blocks=%llu "
        "unit_scan_scalar_code_units=%llu "
        "split_planned_matches=%llu split_plan_overflows=%llu "
        "char_code_at_direct_hits=%llu char_code_at_direct_fallbacks=%llu "
        "case_calls=%llu case_input_code_units=%llu case_reuses=%llu "
        "case_changed_allocations=%llu case_changed_code_units=%llu\n",
        (unsigned long long) mal_perf_stats.key_equals_calls,
        (unsigned long long) mal_perf_stats.key_pointer_hits,
        (unsigned long long) mal_perf_stats.key_string_fallbacks,
        (unsigned long long) mal_perf_stats.key_non_string_misses,
        (unsigned long long) mal_perf_stats.string_equals_calls,
        (unsigned long long) mal_perf_stats.string_pointer_hits,
        (unsigned long long) mal_perf_stats.string_length_misses,
        (unsigned long long) mal_perf_stats.string_hash_misses,
        (unsigned long long) mal_perf_stats.string_memcmp_calls,
        (unsigned long long) mal_perf_stats.string_memcmp_code_units,
        (unsigned long long) mal_perf_stats.string_hash_calls,
        (unsigned long long) mal_perf_stats.string_hash_cached_hits,
        (unsigned long long) mal_perf_stats.string_hash_computes,
        (unsigned long long) mal_perf_stats.string_hash_dependent_computes,
        (unsigned long long) mal_perf_stats.string_hash_cons_flattens,
        (unsigned long long) mal_perf_stats.string_search_calls,
        (unsigned long long) mal_perf_stats.string_search_multi_unit_calls,
        (unsigned long long) mal_perf_stats.string_search_candidates,
        (unsigned long long) mal_perf_stats.string_search_first_unit_rejects,
        (unsigned long long) mal_perf_stats.string_search_last_unit_rejects,
        (unsigned long long) mal_perf_stats.string_search_memcmp_calls,
        (unsigned long long) mal_perf_stats.string_search_memcmp_code_units,
        (unsigned long long) mal_perf_stats.string_reverse_search_calls,
        (unsigned long long) mal_perf_stats.string_reverse_search_candidates,
        (unsigned long long) mal_perf_stats.string_reverse_search_first_unit_rejects,
        (unsigned long long) mal_perf_stats.string_reverse_search_last_unit_rejects,
        (unsigned long long) mal_perf_stats.string_reverse_search_memcmp_calls,
        (unsigned long long) mal_perf_stats.string_reverse_search_memcmp_code_units,
        (unsigned long long) mal_perf_stats.string_unit_scan_word_blocks,
        (unsigned long long) mal_perf_stats.string_unit_scan_candidate_blocks,
        (unsigned long long) mal_perf_stats.string_unit_scan_scalar_code_units,
        (unsigned long long) mal_perf_stats.string_split_planned_matches,
        (unsigned long long) mal_perf_stats.string_split_plan_overflows,
        (unsigned long long) mal_perf_stats.string_char_code_at_direct_hits,
        (unsigned long long) mal_perf_stats.string_char_code_at_direct_fallbacks,
        (unsigned long long) mal_perf_stats.string_case_calls,
        (unsigned long long) mal_perf_stats.string_case_input_code_units,
        (unsigned long long) mal_perf_stats.string_case_reuses,
        (unsigned long long) mal_perf_stats.string_case_changed_allocations,
        (unsigned long long) mal_perf_stats.string_case_changed_code_units
    );
    fprintf(stderr, "[perf-intl-collation-stats] hits=%llu misses=%llu\n",
        (unsigned long long) mal_perf_stats.intl_collation_cache_hits,
        (unsigned long long) mal_perf_stats.intl_collation_cache_misses);
    fprintf(
        stderr,
        "[perf-string-allocation-stats] allocations=%llu code_units=%llu "
        "length_0=%llu length_1=%llu length_2_4=%llu length_5_8=%llu "
        "length_9_16=%llu length_17_32=%llu length_33_64=%llu length_65_plus=%llu "
        "inline_allocations=%llu inline_code_units=%llu inline_concat_results=%llu "
        "tiny_cache_hits=%llu tiny_cache_misses=%llu tiny_cache_replacements=%llu "
        "tiny_cache_promotions=%llu "
        "small_uint_cache_hits=%llu small_uint_cache_misses=%llu "
        "copy_allocations=%llu copy_code_units=%llu "
        "ascii_allocations=%llu ascii_code_units=%llu "
        "owned_allocations=%llu owned_code_units=%llu "
        "external_allocations=%llu external_code_units=%llu "
        "dependent_allocations=%llu dependent_code_units=%llu "
        "dependent_retained_code_units=%llu cons_allocations=%llu cons_code_units=%llu "
        "slice_calls=%llu slice_requested_code_units=%llu slice_empty_results=%llu "
        "slice_full_reuses=%llu slice_dependent_results=%llu slice_copy_results=%llu "
        "flatten_calls=%llu flatten_code_units=%llu flatten_cons_nodes=%llu "
        "flatten_flat_leaves=%llu flatten_shared_copies=%llu\n",
        (unsigned long long) mal_perf_stats.string_allocations,
        (unsigned long long) mal_perf_stats.string_code_units,
        (unsigned long long) mal_perf_stats.string_length_0_allocations,
        (unsigned long long) mal_perf_stats.string_length_1_allocations,
        (unsigned long long) mal_perf_stats.string_length_2_4_allocations,
        (unsigned long long) mal_perf_stats.string_length_5_8_allocations,
        (unsigned long long) mal_perf_stats.string_length_9_16_allocations,
        (unsigned long long) mal_perf_stats.string_length_17_32_allocations,
        (unsigned long long) mal_perf_stats.string_length_33_64_allocations,
        (unsigned long long) mal_perf_stats.string_length_65_plus_allocations,
        (unsigned long long) mal_perf_stats.string_inline_allocations,
        (unsigned long long) mal_perf_stats.string_inline_code_units,
        (unsigned long long) mal_perf_stats.string_inline_concat_results,
        (unsigned long long) mal_perf_stats.string_tiny_cache_hits,
        (unsigned long long) mal_perf_stats.string_tiny_cache_misses,
        (unsigned long long) mal_perf_stats.string_tiny_cache_replacements,
        (unsigned long long) mal_perf_stats.string_tiny_cache_promotions,
        (unsigned long long) mal_perf_stats.string_small_uint_cache_hits,
        (unsigned long long) mal_perf_stats.string_small_uint_cache_misses,
        (unsigned long long) mal_perf_stats.string_copy_allocations,
        (unsigned long long) mal_perf_stats.string_copy_code_units,
        (unsigned long long) mal_perf_stats.string_ascii_allocations,
        (unsigned long long) mal_perf_stats.string_ascii_code_units,
        (unsigned long long) mal_perf_stats.string_owned_allocations,
        (unsigned long long) mal_perf_stats.string_owned_code_units,
        (unsigned long long) mal_perf_stats.string_external_allocations,
        (unsigned long long) mal_perf_stats.string_external_code_units,
        (unsigned long long) mal_perf_stats.string_dependent_allocations,
        (unsigned long long) mal_perf_stats.string_dependent_code_units,
        (unsigned long long) mal_perf_stats.string_dependent_retained_code_units,
        (unsigned long long) mal_perf_stats.string_cons_allocations,
        (unsigned long long) mal_perf_stats.string_cons_code_units,
        (unsigned long long) mal_perf_stats.string_slice_calls,
        (unsigned long long) mal_perf_stats.string_slice_requested_code_units,
        (unsigned long long) mal_perf_stats.string_slice_empty_results,
        (unsigned long long) mal_perf_stats.string_slice_full_reuses,
        (unsigned long long) mal_perf_stats.string_slice_dependent_results,
        (unsigned long long) mal_perf_stats.string_slice_copy_results,
        (unsigned long long) mal_perf_stats.string_flatten_calls,
        (unsigned long long) mal_perf_stats.string_flatten_code_units,
        (unsigned long long) mal_perf_stats.string_flatten_cons_nodes,
        (unsigned long long) mal_perf_stats.string_flatten_flat_leaves,
        (unsigned long long) mal_perf_stats.string_flatten_shared_copies
    );
    fprintf(
        stderr,
        "[perf-regexp-stats] exec_calls=%llu fast_exec_calls=%llu ascii_exec_calls=%llu "
        "ascii_cache_hits=%llu ascii_cache_fills=%llu utf16_exec_calls=%llu "
        "utf16_cache_hits=%llu utf16_cache_fills=%llu\n",
        (unsigned long long) mal_perf_stats.regexp_exec_calls,
        (unsigned long long) mal_perf_stats.regexp_fast_exec_calls,
        (unsigned long long) mal_perf_stats.regexp_ascii_exec_calls,
        (unsigned long long) mal_perf_stats.regexp_ascii_cache_hits,
        (unsigned long long) mal_perf_stats.regexp_ascii_cache_fills,
        (unsigned long long) mal_perf_stats.regexp_utf16_exec_calls,
        (unsigned long long) mal_perf_stats.regexp_utf16_cache_hits,
        (unsigned long long) mal_perf_stats.regexp_utf16_cache_fills
    );
    fprintf(
        stderr,
        "[perf-intrinsic-stats] calls=%llu bytes=%llu cache_hits=%llu cache_fills=%llu "
        "hits=%llu misses=%llu direct_calls=%llu direct_hits=%llu\n",
        (unsigned long long) mal_perf_stats.intrinsic_ascii_calls,
        (unsigned long long) mal_perf_stats.intrinsic_ascii_bytes,
        (unsigned long long) mal_perf_stats.intrinsic_ascii_cache_hits,
        (unsigned long long) mal_perf_stats.intrinsic_ascii_cache_fills,
        (unsigned long long) mal_perf_stats.intrinsic_ascii_hits,
        (unsigned long long) mal_perf_stats.intrinsic_ascii_misses,
        (unsigned long long) mal_perf_stats.intrinsic_hot_direct_calls,
        (unsigned long long) mal_perf_stats.intrinsic_hot_direct_hits
    );
    for (usize i = 0; i < MAL_PERF_INTRINSIC_NAME_CAPACITY; i++) {
        const MalPerfIntrinsicName *entry = &mal_perf_intrinsic_names[i];
        if (entry->calls == 0) continue;
        fprintf(
            stderr, "[perf-intrinsic-name] name=%s calls=%llu\n",
            entry->name, (unsigned long long) entry->calls
        );
    }
    fprintf(
        stderr, "[perf-property-stats] ensure_calls=%llu ensure_inserts=%llu ensure_hits=%llu "
        "constant_atom_hits=%llu "
        "copy_linear_checks=%llu copy_shaped_hits=%llu copy_shaped_slots=%llu "
        "copy_fallbacks=%llu merge_shaped_hits=%llu merge_shaped_slots=%llu "
        "merge_fallbacks=%llu merge_shape_cache_probes=%llu "
        "merge_shape_cache_hits=%llu merge_shape_cache_misses=%llu "
        "merge_shape_cache_builds=%llu\n",
        (unsigned long long) mal_perf_stats.property_ensure_calls,
        (unsigned long long) mal_perf_stats.property_ensure_inserts,
        (unsigned long long) mal_perf_stats.property_ensure_hits,
        (unsigned long long) mal_perf_stats.property_constant_atom_hits,
        (unsigned long long) mal_perf_stats.copy_data_linear_exclusion_checks,
        (unsigned long long) mal_perf_stats.copy_data_shaped_hits,
        (unsigned long long) mal_perf_stats.copy_data_shaped_slots,
        (unsigned long long) mal_perf_stats.copy_data_fallbacks,
        (unsigned long long) mal_perf_stats.merge_data_shaped_hits,
        (unsigned long long) mal_perf_stats.merge_data_shaped_slots,
        (unsigned long long) mal_perf_stats.merge_data_fallbacks,
        (unsigned long long) mal_perf_stats.merge_shape_cache_probes,
        (unsigned long long) mal_perf_stats.merge_shape_cache_hits,
        (unsigned long long) mal_perf_stats.merge_shape_cache_misses,
        (unsigned long long) mal_perf_stats.merge_shape_cache_builds
    );
    fprintf(
        stderr,
        "[perf-known-own-slot-stats] probes=%llu hits=%llu fallbacks=%llu "
        "store_probes=%llu store_hits=%llu store_fallbacks=%llu "
        "exact_loads=%llu exact_stores=%llu "
        "exact_typed_array_loads=%llu\n",
        (unsigned long long) mal_perf_stats.known_own_slot_load_probes,
        (unsigned long long) mal_perf_stats.known_own_slot_load_hits,
        (unsigned long long) mal_perf_stats.known_own_slot_load_fallbacks,
        (unsigned long long) mal_perf_stats.known_own_slot_store_probes,
        (unsigned long long) mal_perf_stats.known_own_slot_store_hits,
        (unsigned long long) mal_perf_stats.known_own_slot_store_fallbacks,
        (unsigned long long) mal_perf_stats.exact_own_slot_loads,
        (unsigned long long) mal_perf_stats.exact_own_slot_stores,
        (unsigned long long) mal_perf_stats.exact_typed_array_loads
    );
    fprintf(
        stderr,
        "[perf-shape-case-stats] probes=%llu hits=%llu fallbacks=%llu "
        "load_probes=%llu load_hits=%llu load_fallbacks=%llu\n",
        (unsigned long long) mal_perf_stats.shape_case_probes,
        (unsigned long long) mal_perf_stats.shape_case_hits,
        (unsigned long long) mal_perf_stats.shape_case_fallbacks,
        (unsigned long long) mal_perf_stats.shape_case_load_probes,
        (unsigned long long) mal_perf_stats.shape_case_load_hits,
        (unsigned long long) mal_perf_stats.shape_case_load_fallbacks
    );
    fprintf(
        stderr,
        "[perf-map-stats] get_set_cache_checks=%llu get_set_cache_hits=%llu "
        "get_set_cache_misses=%llu exact_receiver_hits=%llu "
        "direct_get_hits=%llu direct_set_hits=%llu "
        "direct_map_has_hits=%llu direct_map_delete_hits=%llu "
        "direct_add_hits=%llu direct_set_has_hits=%llu "
        "direct_set_delete_hits=%llu direct_fallbacks=%llu "
        "entry_pair_hits=%llu entry_pair_fallbacks=%llu\n",
        (unsigned long long) mal_perf_stats.map_get_set_cache_checks,
        (unsigned long long) mal_perf_stats.map_get_set_cache_hits,
        (unsigned long long) mal_perf_stats.map_get_set_cache_misses,
        (unsigned long long) mal_perf_stats.collection_exact_receiver_hits,
        (unsigned long long) mal_perf_stats.collection_direct_map_get_hits,
        (unsigned long long) mal_perf_stats.collection_direct_map_set_hits,
        (unsigned long long) mal_perf_stats.collection_direct_map_has_hits,
        (unsigned long long) mal_perf_stats.collection_direct_map_delete_hits,
        (unsigned long long) mal_perf_stats.collection_direct_set_add_hits,
        (unsigned long long) mal_perf_stats.collection_direct_set_has_hits,
        (unsigned long long) mal_perf_stats.collection_direct_set_delete_hits,
        (unsigned long long) mal_perf_stats.collection_direct_fallbacks,
        (unsigned long long) mal_perf_stats.iterator_entry_pair_hits,
        (unsigned long long) mal_perf_stats.iterator_entry_pair_fallbacks
    );
    for (usize i = 0; i < MAL_PERF_COLLECTION_KIND_COUNT; i++) {
        fprintf(
            stderr,
            "[perf-collection-profile] kind=%s allocations=%llu observations=%llu "
            "reclaimed=%llu live_at_exit=%llu "
            "final_size_0=%llu final_size_1=%llu final_size_2_7=%llu "
            "final_size_8_31=%llu final_size_32_255=%llu final_size_256_plus=%llu "
            "peak_size_0=%llu peak_size_1=%llu peak_size_2_7=%llu "
            "peak_size_8_31=%llu peak_size_32_255=%llu peak_size_256_plus=%llu "
            "lifetime_epochs_0=%llu lifetime_epochs_1=%llu lifetime_epochs_2_3=%llu "
            "lifetime_epochs_4_plus=%llu mutation_events=%llu mutations_0=%llu "
            "mutations_1=%llu mutations_2_7=%llu mutations_8_31=%llu "
            "mutations_32_plus=%llu iteration_starts=%llu iteration_steps=%llu "
            "iterations_0=%llu iterations_1=%llu iterations_2_7=%llu "
            "iterations_8_plus=%llu\n",
            mal_perf_collection_kinds[i],
            (unsigned long long) mal_perf_stats.collection_allocations[i],
            (unsigned long long) (mal_perf_stats.collection_finalizations[i] +
                mal_perf_stats.collection_live_snapshots[i]),
            (unsigned long long) mal_perf_stats.collection_finalizations[i],
            (unsigned long long) mal_perf_stats.collection_live_snapshots[i],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][0],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][1],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][2],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][3],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][4],
            (unsigned long long) mal_perf_stats.collection_final_sizes[i][5],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][0],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][1],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][2],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][3],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][4],
            (unsigned long long) mal_perf_stats.collection_peak_sizes[i][5],
            (unsigned long long) mal_perf_stats.collection_lifetimes[i][0],
            (unsigned long long) mal_perf_stats.collection_lifetimes[i][1],
            (unsigned long long) mal_perf_stats.collection_lifetimes[i][2],
            (unsigned long long) mal_perf_stats.collection_lifetimes[i][3],
            (unsigned long long) mal_perf_stats.collection_mutation_events[i],
            (unsigned long long) mal_perf_stats.collection_mutations[i][0],
            (unsigned long long) mal_perf_stats.collection_mutations[i][1],
            (unsigned long long) mal_perf_stats.collection_mutations[i][2],
            (unsigned long long) mal_perf_stats.collection_mutations[i][3],
            (unsigned long long) mal_perf_stats.collection_mutations[i][4],
            (unsigned long long) mal_perf_stats.collection_iteration_starts[i],
            (unsigned long long) mal_perf_stats.collection_iteration_steps[i],
            (unsigned long long) mal_perf_stats.collection_iterations[i][0],
            (unsigned long long) mal_perf_stats.collection_iterations[i][1],
            (unsigned long long) mal_perf_stats.collection_iterations[i][2],
            (unsigned long long) mal_perf_stats.collection_iterations[i][3]
        );
    }
    fprintf(
        stderr,
        "[perf-array-kind-profile] final_empty=%llu final_int32=%llu final_f64=%llu "
        "final_int32_f64=%llu final_other=%llu final_mixed_other=%llu "
        "final_deoptimized=%llu write_int32=%llu write_f64=%llu write_other=%llu "
        "kind_widenings=%llu\n",
        (unsigned long long) mal_perf_stats.array_final_kinds[0],
        (unsigned long long) mal_perf_stats.array_final_kinds[1],
        (unsigned long long) mal_perf_stats.array_final_kinds[2],
        (unsigned long long) mal_perf_stats.array_final_kinds[3],
        (unsigned long long) mal_perf_stats.array_final_kinds[4],
        (unsigned long long) mal_perf_stats.array_final_kinds[5],
        (unsigned long long) mal_perf_stats.array_final_deoptimized,
        (unsigned long long) mal_perf_stats.array_element_writes[0],
        (unsigned long long) mal_perf_stats.array_element_writes[1],
        (unsigned long long) mal_perf_stats.array_element_writes[2],
        (unsigned long long) mal_perf_stats.array_element_kind_widenings
    );
    for (usize i = 0; i < MAL_PERF_COLLECTION_KIND_COUNT; i++) {
        fprintf(
            stderr,
            "[perf-collection-key-profile] kind=%s int32=%llu f64=%llu "
            "string=%llu symbol=%llu object=%llu bigint=%llu static=%llu\n",
            mal_perf_collection_kinds[i],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][0],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][1],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][2],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][3],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][4],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][5],
            (unsigned long long) mal_perf_stats.collection_key_kinds[i][6]
        );
        fprintf(
            stderr,
            "[perf-collection-key-shape] kind=%s empty=%llu int32=%llu "
            "f64=%llu numeric_mixed=%llu string=%llu symbol=%llu object=%llu "
            "other=%llu mixed=%llu\n",
            mal_perf_collection_kinds[i],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][0],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][1],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][2],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][3],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][4],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][5],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][6],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][7],
            (unsigned long long) mal_perf_stats.collection_key_shapes[i][8]
        );
    }
    fprintf(
        stderr,
        "[perf-collection-tracking] overflows=%llu misses=%llu\n",
        (unsigned long long) mal_perf_stats.collection_tracking_overflows,
        (unsigned long long) mal_perf_stats.collection_tracking_misses
    );
    fprintf(
        stderr,
        "[perf-allocation-stats] empty_objects=%llu shaped_objects=%llu "
        "stack_objects=%llu stack_materializations=%llu "
        "stack_inherited_fast=%llu stack_inherited_heap_fallbacks=%llu "
        "stack_inherited_direct_loads=%llu "
        "accessor_sidecar_allocations=%llu accessor_sidecar_frees=%llu "
        "error_trace_stores=%llu error_trace_releases=%llu error_trace_peak_live=%llu "
        "function_property_cache_allocations=%llu function_property_cache_bytes=%llu "
        "function_literal_cache_allocations=%llu function_literal_cache_bytes=%llu "
        "property_stub_cache_allocations=%llu "
        "inherited_property_stub_cache_allocations=%llu "
        "inherited_property_stub_cache_bytes=%llu interp_call_cache_allocations=%llu "
        "global_property_cache_allocations=%llu\n",
        (unsigned long long) mal_perf_stats.object_empty_creations,
        (unsigned long long) mal_perf_stats.object_shaped_creations,
        (unsigned long long) mal_perf_stats.stack_object_initializations,
        (unsigned long long) mal_perf_stats.stack_object_materializations,
        (unsigned long long) mal_perf_stats.stack_object_inherited_fast_initializations,
        (unsigned long long) mal_perf_stats.stack_object_inherited_heap_fallbacks,
        (unsigned long long) mal_perf_stats.stack_object_inherited_direct_loads,
        (unsigned long long) mal_perf_stats.property_accessor_sidecar_allocations,
        (unsigned long long) mal_perf_stats.property_accessor_sidecar_frees,
        (unsigned long long) mal_perf_stats.error_stack_trace_stores,
        (unsigned long long) mal_perf_stats.error_stack_trace_releases,
        (unsigned long long) mal_perf_stats.error_stack_trace_peak_live,
        (unsigned long long) mal_perf_stats.function_property_cache_allocations,
        (unsigned long long) mal_perf_stats.function_property_cache_bytes,
        (unsigned long long) mal_perf_stats.function_literal_cache_allocations,
        (unsigned long long) mal_perf_stats.function_literal_cache_bytes,
        (unsigned long long) mal_perf_stats.property_stub_cache_allocations,
        (unsigned long long) mal_perf_stats.inherited_property_stub_cache_allocations,
        (unsigned long long) mal_perf_stats.inherited_property_stub_cache_bytes,
        (unsigned long long) mal_perf_stats.interp_call_cache_allocations,
        (unsigned long long) mal_perf_stats.global_property_cache_allocations
    );
    fprintf(
        stderr,
        "[perf-binary-stats] arithmetic_hits=%llu arithmetic_fallbacks=%llu "
        "comparison_hits=%llu comparison_fallbacks=%llu bitwise_hits=%llu "
        "bitwise_fallbacks=%llu other_fallbacks=%llu\n",
        (unsigned long long) mal_perf_stats.binary_number_arithmetic_hits,
        (unsigned long long) mal_perf_stats.binary_number_arithmetic_fallbacks,
        (unsigned long long) mal_perf_stats.binary_number_comparison_hits,
        (unsigned long long) mal_perf_stats.binary_number_comparison_fallbacks,
        (unsigned long long) mal_perf_stats.binary_number_bitwise_hits,
        (unsigned long long) mal_perf_stats.binary_number_bitwise_fallbacks,
        (unsigned long long) mal_perf_stats.binary_number_other_fallbacks
    );
    fprintf(
        stderr,
        "[perf-interpreter-stats] direct_leaf_executions=%llu guard_branch_fusions=%llu "
        "global_tdz_fusions=%llu binary_branch_fusions=%llu "
        "create_object_shaped_jump_fusions=%llu boundary_dispatches=%llu "
        "state_syncs=%llu state_reloads=%llu normal_helper_continuations=%llu "
        "strict_direct_hits=%llu "
        "strict_string_fallbacks=%llu local_load_ic_hits=%llu local_store_ic_hits=%llu "
        "load_ic_sync_fallbacks=%llu store_ic_sync_fallbacks=%llu "
        "iterator_dense_hits=%llu iterator_sync_fallbacks=%llu\n",
        (unsigned long long) mal_perf_stats.interpreter_direct_leaf_executions,
        (unsigned long long) mal_perf_stats.interpreter_guard_branch_fusions,
        (unsigned long long) mal_perf_stats.interpreter_global_tdz_fusions,
        (unsigned long long) mal_perf_stats.interpreter_binary_branch_fusions,
        (unsigned long long) mal_perf_stats.interpreter_create_object_shaped_jump_fusions,
        (unsigned long long) mal_perf_stats.interpreter_boundary_dispatches,
        (unsigned long long) mal_perf_stats.interpreter_state_syncs,
        (unsigned long long) mal_perf_stats.interpreter_state_reloads,
        (unsigned long long) mal_perf_stats.interpreter_normal_helper_continuations,
        (unsigned long long) mal_perf_stats.interpreter_strict_direct_hits,
        (unsigned long long) mal_perf_stats.interpreter_strict_string_fallbacks,
        (unsigned long long) mal_perf_stats.interpreter_local_load_ic_hits,
        (unsigned long long) mal_perf_stats.interpreter_local_store_ic_hits,
        (unsigned long long) mal_perf_stats.interpreter_load_ic_sync_fallbacks,
        (unsigned long long) mal_perf_stats.interpreter_store_ic_sync_fallbacks,
        (unsigned long long) mal_perf_stats.interpreter_iterator_dense_hits,
        (unsigned long long) mal_perf_stats.interpreter_iterator_sync_fallbacks
    );
    fprintf(
        stderr,
        "[perf-promise-stats] await_typed_continuations=%llu await_typed_jobs=%llu "
        "job_slab_hits=%llu job_slab_fresh_slots=%llu "
        "job_slab_block_allocations=%llu job_slab_block_frees=%llu "
        "job_slab_peak_retained_bytes=%llu native_adoption_hits=%llu "
        "native_adoption_guard_fallbacks=%llu resolve_identity_hits=%llu "
        "intrinsic_species_hits=%llu "
        "discarded_dependent_registrations=%llu guarded_fallbacks=%llu "
        "resolving_pairs=%llu async_generator_direct_requests=%llu\n",
        (unsigned long long) mal_perf_stats.promise_await_typed_continuations,
        (unsigned long long) mal_perf_stats.promise_await_typed_jobs,
        (unsigned long long) mal_perf_stats.promise_job_slab_hits,
        (unsigned long long) mal_perf_stats.promise_job_slab_fresh_slots,
        (unsigned long long) mal_perf_stats.promise_job_slab_block_allocations,
        (unsigned long long) mal_perf_stats.promise_job_slab_block_frees,
        (unsigned long long) mal_perf_stats.promise_job_slab_peak_retained_bytes,
        (unsigned long long) mal_perf_stats.promise_native_adoption_hits,
        (unsigned long long) mal_perf_stats.promise_native_adoption_guard_fallbacks,
        (unsigned long long) mal_perf_stats.promise_resolve_identity_hits,
        (unsigned long long) mal_perf_stats.promise_intrinsic_species_hits,
        (unsigned long long) mal_perf_stats.promise_discarded_dependent_registrations,
        (unsigned long long) mal_perf_stats.promise_guarded_fallbacks,
        (unsigned long long) mal_perf_stats.promise_resolving_pairs,
        (unsigned long long) mal_perf_stats.promise_async_generator_direct_requests
    );
    fprintf(stderr, "[perf-rest-stats] arrays=%llu array_values=%llu forwards=%llu forwarded_values=%llu forward_copies=%llu\n",
        (unsigned long long) mal_perf_stats.rest_array_allocations,
        (unsigned long long) mal_perf_stats.rest_array_values,
        (unsigned long long) mal_perf_stats.rest_forward_calls,
        (unsigned long long) mal_perf_stats.rest_forward_values,
        (unsigned long long) mal_perf_stats.rest_forward_copies);
    fprintf(
        stderr,
        "[perf-arguments-stats] logical_values=%llu destination_writes=%llu "
        "temporary_copies=%llu\n",
        (unsigned long long) mal_perf_stats.argument_snapshot_logical_values,
        (unsigned long long) mal_perf_stats.argument_snapshot_destination_writes,
        (unsigned long long) mal_perf_stats.argument_snapshot_temporary_copies
    );
	fprintf(
        stderr,
        "[perf-coroutine-stats] release_clear_slots=%llu allocation_init_slots=%llu\n",
        (unsigned long long) mal_perf_stats.coroutine_buffer_release_clear_slots,
        (unsigned long long) mal_perf_stats.coroutine_buffer_allocation_init_slots
    );
    fprintf(
        stderr,
        "[perf-array-stats] fresh_dense_stores=%llu fresh_dense_growths=%llu "
        "fresh_dense_fallbacks=%llu fresh_dense_exact_reserves=%llu "
        "fresh_dense_reserved_slots=%llu fresh_dense_growths_avoided=%llu "
		"indexed_fill_reserves=%llu indexed_fill_reserved_slots=%llu "
		"indexed_fill_allocations_avoided=%llu indexed_fill_raw_bytes_avoided=%llu "
		"indexed_fill_guard_fallbacks=%llu "
		"push_direct_hits=%llu push_direct_fallbacks=%llu "
		"contained_pushes=%llu contained_push_overflows=%llu "
		"contained_pops=%llu contained_empty_pops=%llu contained_element_reads=%llu "
        "iteration_direct_hits=%llu iteration_direct_fallbacks=%llu "
        "iteration_exact_callback_calls=%llu "
        "iteration_exact_compiled_callback_calls=%llu\n",
        (unsigned long long) mal_perf_stats.array_fresh_dense_stores,
        (unsigned long long) mal_perf_stats.array_fresh_dense_growths,
        (unsigned long long) mal_perf_stats.array_fresh_dense_fallbacks,
        (unsigned long long) mal_perf_stats.array_fresh_dense_exact_reserves,
        (unsigned long long) mal_perf_stats.array_fresh_dense_reserved_slots,
        (unsigned long long) mal_perf_stats.array_fresh_dense_growths_avoided,
        (unsigned long long) mal_perf_stats.array_indexed_fill_reserves,
        (unsigned long long) mal_perf_stats.array_indexed_fill_reserved_slots,
		(unsigned long long) mal_perf_stats.array_indexed_fill_allocations_avoided,
		(unsigned long long) mal_perf_stats.array_indexed_fill_raw_bytes_avoided,
		(unsigned long long) mal_perf_stats.array_indexed_fill_guard_fallbacks,
		(unsigned long long) mal_perf_stats.array_push_direct_hits,
        (unsigned long long) mal_perf_stats.array_push_direct_fallbacks,
		(unsigned long long) mal_perf_stats.array_contained_pushes,
		(unsigned long long) mal_perf_stats.array_contained_push_overflows,
		(unsigned long long) mal_perf_stats.array_contained_pops,
		(unsigned long long) mal_perf_stats.array_contained_empty_pops,
		(unsigned long long) mal_perf_stats.array_contained_element_reads,
        (unsigned long long) mal_perf_stats.array_iteration_direct_hits,
        (unsigned long long) mal_perf_stats.array_iteration_direct_fallbacks,
        (unsigned long long) mal_perf_stats.array_iteration_exact_callback_calls,
        (unsigned long long) mal_perf_stats.array_iteration_exact_compiled_callback_calls
    );
    fprintf(
        stderr,
        "[perf-node-events-stats] singleton_inserts=%llu listener_array_allocations=%llu "
        "listener_array_copied_entries=%llu promotions=%llu demotions=%llu\n",
        (unsigned long long) mal_perf_stats.node_event_singleton_inserts,
        (unsigned long long) mal_perf_stats.node_event_listener_array_allocations,
        (unsigned long long) mal_perf_stats.node_event_listener_array_copied_entries,
        (unsigned long long) mal_perf_stats.node_event_listener_promotions,
        (unsigned long long) mal_perf_stats.node_event_listener_demotions
    );
    fprintf(
        stderr,
        "[perf-http-stats] response_index_lookups=%llu response_index_hits=%llu "
        "response_index_misses=%llu response_index_probes=%llu "
        "response_index_max_probes=%llu response_index_peak_entries=%llu "
        "response_index_inserts=%llu response_index_removes=%llu "
        "response_index_rehashes=%llu response_header_name_coercions=%llu "
        "response_header_name_materializations=%llu response_header_insertions=%llu "
        "response_header_replacements=%llu "
        "response_header_allocation_free_lookups=%llu "
        "response_header_spills=%llu response_header_max_count=%llu "
        "codec_head_allocations=%llu codec_field_spills=%llu "
        "codec_arena_spills=%llu codec_body_growths=%llu "
        "codec_max_fields=%llu codec_max_head_bytes=%llu drain_calls=%llu "
        "request_state_scans=%llu "
        "close_scans=%llu close_request_state_scans=%llu request_remove_scans=%llu "
        "dispatch_enqueues=%llu dispatch_dequeues=%llu completion_enqueues=%llu "
        "completion_dequeues=%llu request_inserts=%llu request_removes=%llu "
        "request_state_allocations=%llu request_body_allocations=%llu "
        "request_packed_headers=%llu request_copy_operations=%llu "
        "request_copy_bytes=%llu request_body_transfers=%llu "
        "request_state_direct_frees=%llu request_body_direct_frees=%llu "
        "bulk_shaped_objects=%llu bulk_shaped_slots=%llu "
        "property_definitions_avoided=%llu shape_transitions_avoided=%llu "
        "incoming_message_shape_append_batches=%llu "
        "incoming_message_shape_append_slots=%llu "
        "incoming_message_shape_append_fallbacks=%llu "
        "incoming_message_slot_growths_avoided=%llu "
        "response_constructor_shape_append_batches=%llu "
        "response_constructor_shape_append_slots=%llu "
        "response_constructor_shape_append_fallbacks=%llu "
        "response_constructor_slot_growths_avoided=%llu "
        "response_shape_append_batches=%llu response_shape_append_slots=%llu "
        "response_shape_append_fallbacks=%llu response_slot_growths_avoided=%llu\n",
        (unsigned long long) mal_perf_stats.http_response_index_lookups,
        (unsigned long long) mal_perf_stats.http_response_index_hits,
        (unsigned long long) mal_perf_stats.http_response_index_misses,
        (unsigned long long) mal_perf_stats.http_response_index_probes,
        (unsigned long long) mal_perf_stats.http_response_index_max_probes,
        (unsigned long long) mal_perf_stats.http_response_index_peak_entries,
        (unsigned long long) mal_perf_stats.http_response_index_inserts,
        (unsigned long long) mal_perf_stats.http_response_index_removes,
        (unsigned long long) mal_perf_stats.http_response_index_rehashes,
        (unsigned long long) mal_perf_stats.http_response_header_name_coercions,
        (unsigned long long) mal_perf_stats.http_response_header_name_materializations,
        (unsigned long long) mal_perf_stats.http_response_header_insertions,
        (unsigned long long) mal_perf_stats.http_response_header_replacements,
        (unsigned long long) mal_perf_stats.http_response_header_allocation_free_lookups,
        (unsigned long long) mal_perf_stats.http_response_header_spills,
        (unsigned long long) mal_perf_stats.http_response_header_max_count,
        (unsigned long long) mal_perf_stats.http_codec_head_allocations,
        (unsigned long long) mal_perf_stats.http_codec_field_spills,
        (unsigned long long) mal_perf_stats.http_codec_arena_spills,
        (unsigned long long) mal_perf_stats.http_codec_body_growths,
        (unsigned long long) mal_perf_stats.http_codec_max_fields,
        (unsigned long long) mal_perf_stats.http_codec_max_head_bytes,
        (unsigned long long) mal_perf_stats.http_drain_calls,
        (unsigned long long) mal_perf_stats.http_request_state_scans,
        (unsigned long long) mal_perf_stats.http_close_scans,
        (unsigned long long) mal_perf_stats.http_close_request_state_scans,
        (unsigned long long) mal_perf_stats.http_request_remove_scans,
        (unsigned long long) mal_perf_stats.http_dispatch_enqueues,
        (unsigned long long) mal_perf_stats.http_dispatch_dequeues,
        (unsigned long long) mal_perf_stats.http_completion_enqueues,
        (unsigned long long) mal_perf_stats.http_completion_dequeues,
        (unsigned long long) mal_perf_stats.http_request_inserts,
        (unsigned long long) mal_perf_stats.http_request_removes,
        (unsigned long long) mal_perf_stats.http_request_state_allocations,
        (unsigned long long) mal_perf_stats.http_request_body_allocations,
        (unsigned long long) mal_perf_stats.http_request_packed_headers,
        (unsigned long long) mal_perf_stats.http_request_copy_operations,
        (unsigned long long) mal_perf_stats.http_request_copy_bytes,
        (unsigned long long) mal_perf_stats.http_request_body_transfers,
        (unsigned long long) mal_perf_stats.http_request_state_direct_frees,
        (unsigned long long) mal_perf_stats.http_request_body_direct_frees,
        (unsigned long long) mal_perf_stats.http_bulk_shaped_objects,
        (unsigned long long) mal_perf_stats.http_bulk_shaped_slots,
        (unsigned long long) mal_perf_stats.http_property_definitions_avoided,
        (unsigned long long) mal_perf_stats.http_shape_transitions_avoided,
        (unsigned long long) mal_perf_stats.http_incoming_message_shape_append_batches,
        (unsigned long long) mal_perf_stats.http_incoming_message_shape_append_slots,
        (unsigned long long) mal_perf_stats.http_incoming_message_shape_append_fallbacks,
        (unsigned long long) mal_perf_stats.http_incoming_message_slot_growths_avoided,
        (unsigned long long) mal_perf_stats.http_response_constructor_shape_append_batches,
        (unsigned long long) mal_perf_stats.http_response_constructor_shape_append_slots,
        (unsigned long long) mal_perf_stats.http_response_constructor_shape_append_fallbacks,
        (unsigned long long) mal_perf_stats.http_response_constructor_slot_growths_avoided,
        (unsigned long long) mal_perf_stats.http_response_shape_append_batches,
        (unsigned long long) mal_perf_stats.http_response_shape_append_slots,
        (unsigned long long) mal_perf_stats.http_response_shape_append_fallbacks,
        (unsigned long long) mal_perf_stats.http_response_slot_growths_avoided
    );
    for (u32 i = 0; i < MAL_PERF_TABLE_ROLE_COUNT; i++) {
        const MalPerfTableStats *stats = &mal_perf_stats.tables[i];
        fprintf(
            stderr,
            "[perf-table-stats] role=%s lookups=%llu lookup_hits=%llu lookup_misses=%llu "
            "upserts=%llu upsert_hits=%llu upsert_inserts=%llu find_calls=%llu "
            "probes=%llu max_probe=%llu string_queries=%llu rehashes=%llu "
            "rehash_entries=%llu slot_growths=%llu deletes=%llu delete_hits=%llu "
            "delete_cluster_scans=%llu delete_slot_moves=%llu clears=%llu compactions=%llu "
            "storage_allocations=%llu storage_releases=%llu entry_shrinks=%llu\n",
            mal_perf_table_roles[i],
            (unsigned long long) stats->lookups,
            (unsigned long long) stats->lookup_hits,
            (unsigned long long) stats->lookup_misses,
            (unsigned long long) stats->upserts,
            (unsigned long long) stats->upsert_hits,
            (unsigned long long) stats->upsert_inserts,
            (unsigned long long) stats->find_calls,
            (unsigned long long) stats->probes,
            (unsigned long long) stats->max_probe,
            (unsigned long long) stats->string_queries,
            (unsigned long long) stats->rehashes,
            (unsigned long long) stats->rehash_entries,
            (unsigned long long) stats->slot_growths,
            (unsigned long long) stats->deletes,
            (unsigned long long) stats->delete_hits,
            (unsigned long long) stats->delete_cluster_scans,
            (unsigned long long) stats->delete_slot_moves,
            (unsigned long long) stats->clears,
            (unsigned long long) stats->compactions,
            (unsigned long long) stats->storage_allocations,
            (unsigned long long) stats->storage_releases,
            (unsigned long long) stats->entry_shrinks
        );
    }
    for (u32 i = 0; i < MAL_PERF_SHAPE_CALLER_COUNT; i++) {
        const MalPerfShapeStats *stats = &mal_perf_stats.shapes[i];
        fprintf(
            stderr,
            "[perf-shape-stats] caller=%s calls=%llu hits=%llu misses=%llu widths=%llu "
            "comparisons=%llu max_width=%llu max_comparisons=%llu pointer_hits=%llu "
            "content_hits=%llu\n",
            mal_perf_shape_callers[i],
            (unsigned long long) stats->calls,
            (unsigned long long) stats->hits,
            (unsigned long long) stats->misses,
            (unsigned long long) stats->widths,
            (unsigned long long) stats->comparisons,
            (unsigned long long) stats->max_width,
            (unsigned long long) stats->max_comparisons,
            (unsigned long long) stats->pointer_hits,
            (unsigned long long) stats->content_hits
        );
    }
    fprintf(
        stderr,
        "[perf-shape-transition-stats] calls=%llu hits=%llu creates=%llu comparisons=%llu "
        "max_comparisons=%llu pointer_hits=%llu content_hits=%llu index_lookups=%llu "
        "index_hits=%llu index_probes=%llu index_builds=%llu\n",
        (unsigned long long) mal_perf_stats.shape_transition_calls,
        (unsigned long long) mal_perf_stats.shape_transition_hits,
        (unsigned long long) mal_perf_stats.shape_transition_creates,
        (unsigned long long) mal_perf_stats.shape_transition_comparisons,
        (unsigned long long) mal_perf_stats.shape_transition_max_comparisons,
        (unsigned long long) mal_perf_stats.shape_transition_pointer_hits,
        (unsigned long long) mal_perf_stats.shape_transition_content_hits,
        (unsigned long long) mal_perf_stats.shape_transition_index_lookups,
        (unsigned long long) mal_perf_stats.shape_transition_index_hits,
        (unsigned long long) mal_perf_stats.shape_transition_index_probes,
        (unsigned long long) mal_perf_stats.shape_transition_index_builds
    );
    fprintf(
        stderr,
        "[perf-call-cache-stats] probes=%llu exact_identity_hits=%llu "
        "compiled_dispatches=%llu native_exact_hits=%llu "
        "way_checks=%llu dispatch_misses=%llu native_fills=%llu "
        "compiled_enters=%llu compiled_debug_frames=%llu "
        "direct_entry_hits=%llu numeric_sort_callback_calls=%llu\n",
        (unsigned long long) mal_perf_stats.call_cache_probes,
        (unsigned long long) mal_perf_stats.call_cache_exact_identity_hits,
        (unsigned long long) mal_perf_stats.call_cache_compiled_dispatches,
        (unsigned long long) mal_perf_stats.call_cache_native_exact_hits,
        (unsigned long long) mal_perf_stats.call_cache_way_checks,
        (unsigned long long) mal_perf_stats.call_cache_dispatch_misses,
        (unsigned long long) mal_perf_stats.call_cache_native_fills,
        (unsigned long long) mal_perf_stats.compiled_enter_calls,
        (unsigned long long) mal_perf_stats.compiled_debug_frame_entries,
        (unsigned long long) mal_perf_stats.direct_entry_hits,
        (unsigned long long) mal_perf_stats.numeric_sort_callback_calls
    );
    for (usize i = 0; i < MAL_PERF_NATIVE_NAME_CAPACITY; i++) {
        const MalPerfNativeName *entry = &mal_perf_native_names[i];
        if (entry->calls == 0) continue;
        char name[MAL_PERF_NATIVE_NAME_MAX_LENGTH + 1];
        for (usize j = 0; j < entry->length; j++) {
            name[j] = entry->name[j] <= 0x7f ? (char) entry->name[j] : '?';
        }
        name[entry->length] = '\0';
        fprintf(
            stderr, "[perf-native-call] name=%s calls=%llu\n",
            name, (unsigned long long) entry->calls
        );
    }
    fprintf(
        stderr,
        "[perf-ic-stats] load_mono_hits=%llu load_inherited_hits=%llu "
        "load_own_table_hits=%llu load_own_table_fills=%llu "
        "load_missing_hits=%llu load_missing_fills=%llu "
        "load_fallbacks=%llu load_slow_mono_hits=%llu "
        "load_poly_hits=%llu load_mega_hits=%llu load_mega_misses=%llu "
        "load_shape_hits=%llu load_shape_fills=%llu load_shape_uncacheable=%llu "
        "load_plain_generic=%llu load_primitive_hits=%llu load_primitive_fills=%llu "
        "load_primitive_uncacheable=%llu load_string_length_hits=%llu "
        "load_array_length_hits=%llu load_typed_array_length_hits=%llu "
        "load_watched_hits=%llu load_watched_fills=%llu "
        "load_other_generic=%llu inherited_fills=%llu inherited_reject_basic=%llu "
        "inherited_reject_key=%llu inherited_reject_receiver=%llu "
        "inherited_reject_resolution=%llu inherited_reject_chain=%llu "
        "prototype_epoch_invalidations=%llu prototype_epoch_define=%llu "
        "prototype_epoch_dictionary=%llu prototype_epoch_append=%llu "
        "prototype_epoch_delete=%llu prototype_epoch_reparent=%llu "
        "prototype_epoch_shaped=%llu prototype_epoch_finalize=%llu "
        "store_mono_hits=%llu store_fallbacks=%llu "
        "store_slow_mono_hits=%llu store_poly_hits=%llu "
        "store_mega_hits=%llu store_mega_misses=%llu store_shape_hits=%llu "
        "store_shape_fills=%llu store_shape_uncacheable=%llu "
        "store_transition_hits=%llu store_transition_fills=%llu "
        "define_transition_hits=%llu define_transition_fills=%llu store_plain_generic=%llu "
        "store_other_generic=%llu\n",
        (unsigned long long) mal_perf_stats.ic_load_mono_hits,
        (unsigned long long) mal_perf_stats.ic_load_inherited_hits,
        (unsigned long long) mal_perf_stats.ic_load_own_table_hits,
        (unsigned long long) mal_perf_stats.ic_load_own_table_fills,
        (unsigned long long) mal_perf_stats.ic_load_missing_hits,
        (unsigned long long) mal_perf_stats.ic_load_missing_fills,
        (unsigned long long) mal_perf_stats.ic_load_fallbacks,
        (unsigned long long) mal_perf_stats.ic_load_slow_mono_hits,
        (unsigned long long) mal_perf_stats.ic_load_poly_hits,
        (unsigned long long) mal_perf_stats.ic_load_mega_hits,
        (unsigned long long) mal_perf_stats.ic_load_mega_misses,
        (unsigned long long) mal_perf_stats.ic_load_shape_hits,
        (unsigned long long) mal_perf_stats.ic_load_shape_fills,
        (unsigned long long) mal_perf_stats.ic_load_shape_uncacheable,
        (unsigned long long) mal_perf_stats.ic_load_plain_generic,
        (unsigned long long) mal_perf_stats.ic_load_primitive_hits,
        (unsigned long long) mal_perf_stats.ic_load_primitive_fills,
        (unsigned long long) mal_perf_stats.ic_load_primitive_uncacheable,
        (unsigned long long) mal_perf_stats.ic_load_string_length_hits,
        (unsigned long long) mal_perf_stats.ic_load_array_length_hits,
        (unsigned long long) mal_perf_stats.ic_load_typed_array_length_hits,
        (unsigned long long) mal_perf_stats.ic_load_watched_hits,
        (unsigned long long) mal_perf_stats.ic_load_watched_fills,
        (unsigned long long) mal_perf_stats.ic_load_other_generic,
        (unsigned long long) mal_perf_stats.ic_inherited_fills,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_basic,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_key,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_receiver,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_resolution,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_chain,
        (unsigned long long) mal_perf_stats.prototype_epoch_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_define_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_dictionary_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_append_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_delete_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_reparent_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_shaped_invalidations,
        (unsigned long long) mal_perf_stats.prototype_epoch_finalize_invalidations,
        (unsigned long long) mal_perf_stats.ic_store_mono_hits,
        (unsigned long long) mal_perf_stats.ic_store_fallbacks,
        (unsigned long long) mal_perf_stats.ic_store_slow_mono_hits,
        (unsigned long long) mal_perf_stats.ic_store_poly_hits,
        (unsigned long long) mal_perf_stats.ic_store_mega_hits,
        (unsigned long long) mal_perf_stats.ic_store_mega_misses,
        (unsigned long long) mal_perf_stats.ic_store_shape_hits,
        (unsigned long long) mal_perf_stats.ic_store_shape_fills,
        (unsigned long long) mal_perf_stats.ic_store_shape_uncacheable,
        (unsigned long long) mal_perf_stats.ic_store_transition_hits,
        (unsigned long long) mal_perf_stats.ic_store_transition_fills,
        (unsigned long long) mal_perf_stats.define_property_transition_hits,
        (unsigned long long) mal_perf_stats.define_property_transition_fills,
        (unsigned long long) mal_perf_stats.ic_store_plain_generic,
        (unsigned long long) mal_perf_stats.ic_store_other_generic
    );
    u64 replacements = 0;
    u64 cross_mode = 0;
    u64 own_to_chain = 0;
    u64 chain_to_own = 0;
    for (usize from = 0; from < MAL_PERF_IC_MODE_COUNT; from++) {
        for (usize to = 0; to < MAL_PERF_IC_MODE_COUNT; to++) {
            u64 count = mal_perf_stats.ic_mode_replacements[from][to];
            replacements += count;
            if (from != to) cross_mode += count;
            if ((from == 0 || from == 9) && mal_perf_ic_mode_is_chain(to)) own_to_chain += count;
            if (mal_perf_ic_mode_is_chain(from) && (to == 0 || to == 9)) chain_to_own += count;
            if (count != 0) {
                fprintf(
                    stderr,
                    "[perf-ic-mode-replacement] from=%zu to=%zu count=%llu\n",
                    from, to, (unsigned long long) count
                );
            }
        }
    }
    fprintf(
        stderr,
        "[perf-ic-mode-stats] replacements=%llu cross_mode=%llu "
        "own_to_chain=%llu chain_to_own=%llu shape_to_transition=%llu "
        "transition_to_shape=%llu\n",
        (unsigned long long) replacements,
        (unsigned long long) cross_mode,
        (unsigned long long) own_to_chain,
        (unsigned long long) chain_to_own,
        (unsigned long long) mal_perf_stats.ic_mode_replacements[0][8],
        (unsigned long long) mal_perf_stats.ic_mode_replacements[8][0]
    );
    fprintf(
        stderr,
        "[perf-prototype-dependency-stats] register_calls=%llu register_nodes=%llu "
        "register_failures=%llu unregister_calls=%llu unregister_scan_steps=%llu "
        "unregister_removed=%llu invalidate_calls=%llu invalidate_scan_steps=%llu "
        "invalidate_removed=%llu\n",
        (unsigned long long) mal_perf_stats.prototype_dependency_register_calls,
        (unsigned long long) mal_perf_stats.prototype_dependency_register_nodes,
        (unsigned long long) mal_perf_stats.prototype_dependency_register_failures,
        (unsigned long long) mal_perf_stats.prototype_dependency_unregister_calls,
        (unsigned long long) mal_perf_stats.prototype_dependency_unregister_scan_steps,
        (unsigned long long) mal_perf_stats.prototype_dependency_unregister_removed,
        (unsigned long long) mal_perf_stats.prototype_dependency_invalidate_calls,
        (unsigned long long) mal_perf_stats.prototype_dependency_invalidate_scan_steps,
        (unsigned long long) mal_perf_stats.prototype_dependency_invalidate_removed
    );
}

void mal_perf_stats_init(void) {
    static bool registered = false;
    if (getenv("MAL_PERF_STATS") == nullptr) {
        return;
    }
    mal_perf_stats_enabled = true;
    if (!registered && getenv("MAL_PROFILE_COMPILER") == nullptr) {
        registered = true;
        atexit(mal_perf_stats_print);
    }
}

void mal_perf_stats_reset(void) {
    if (!mal_perf_stats_enabled) {
        return;
    }
    memset(&mal_perf_stats, 0, sizeof(mal_perf_stats));
    memset(mal_perf_intrinsic_names, 0, sizeof(mal_perf_intrinsic_names));
    memset(mal_perf_native_names, 0, sizeof(mal_perf_native_names));
    if (mal_perf_collection_records != nullptr) {
        memset(
            mal_perf_collection_records,
            0,
            mal_perf_collection_record_capacity * sizeof(MalPerfCollectionRecord));
    }
    mal_perf_collection_record_live = 0;
    mal_perf_collection_record_occupied = 0;
    mal_perf_collection_latest_epoch = 0;
}
#else
// Keep dead instrumentation references valid even in unoptimized diagnostic builds.
MalPerfStats mal_perf_stats;
#endif
