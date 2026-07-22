#pragma once

#include "defaults.h"

#ifndef MAL_PERF_STATS
#define MAL_PERF_STATS 0
#endif

#define MAL_PERF_TABLE_ROLE_COUNT 4
#define MAL_PERF_SHAPE_CALLER_COUNT 6

typedef struct MalPerfTableStats {
    u64 lookups;
    u64 lookup_hits;
    u64 lookup_misses;
    u64 upserts;
    u64 upsert_hits;
    u64 upsert_inserts;
    u64 find_calls;
    u64 probes;
    u64 max_probe;
    u64 string_queries;
    u64 rehashes;
    u64 rehash_entries;
    u64 slot_growths;
    u64 deletes;
    u64 delete_hits;
    u64 delete_cluster_scans;
    u64 delete_slot_moves;
    u64 clears;
    u64 compactions;
} MalPerfTableStats;

typedef struct MalPerfShapeStats {
    u64 calls;
    u64 hits;
    u64 misses;
    u64 widths;
    u64 comparisons;
    u64 max_width;
    u64 max_comparisons;
    u64 pointer_hits;
    u64 content_hits;
} MalPerfShapeStats;

typedef struct MalPerfStats {
    u64 key_equals_calls;
    u64 key_pointer_hits;
    u64 key_string_fallbacks;
    u64 key_non_string_misses;

    u64 string_equals_calls;
    u64 string_pointer_hits;
    u64 string_length_misses;
    u64 string_hash_misses;
    u64 string_memcmp_calls;
    u64 string_memcmp_code_units;
    u64 string_hash_calls;
    u64 string_hash_cached_hits;
    u64 string_hash_computes;
    u64 string_hash_dependent_computes;
    u64 string_hash_cons_flattens;

    u64 intrinsic_ascii_calls;
    u64 intrinsic_ascii_bytes;
    u64 intrinsic_ascii_cache_hits;
    u64 intrinsic_ascii_cache_fills;
    u64 intrinsic_ascii_hits;
    u64 intrinsic_ascii_misses;
    u64 intrinsic_hot_direct_calls;
    u64 intrinsic_hot_direct_hits;

    u64 property_ensure_calls;
    u64 property_ensure_inserts;
    u64 property_ensure_hits;

    u64 binary_number_arithmetic_hits;
    u64 binary_number_arithmetic_fallbacks;
    u64 binary_number_comparison_hits;
    u64 binary_number_comparison_fallbacks;
    u64 binary_number_bitwise_hits;
    u64 binary_number_bitwise_fallbacks;
    u64 binary_number_other_fallbacks;

    MalPerfTableStats tables[MAL_PERF_TABLE_ROLE_COUNT];
    MalPerfShapeStats shapes[MAL_PERF_SHAPE_CALLER_COUNT];
    u64 shape_transition_calls;
    u64 shape_transition_hits;
    u64 shape_transition_creates;
    u64 shape_transition_comparisons;
    u64 shape_transition_max_comparisons;
    u64 shape_transition_pointer_hits;
    u64 shape_transition_content_hits;
    u64 shape_transition_index_lookups;
    u64 shape_transition_index_hits;
    u64 shape_transition_index_probes;
    u64 shape_transition_index_builds;

    u64 ic_load_mono_hits;
    u64 ic_load_region_hits;
    u64 ic_load_inherited_hits;
    u64 ic_load_fallbacks;
    u64 ic_load_slow_mono_hits;
    u64 ic_load_poly_hits;
    u64 ic_load_mega_hits;
    u64 ic_load_mega_misses;
    u64 ic_load_shape_hits;
    u64 ic_load_shape_fills;
    u64 ic_load_shape_uncacheable;
    u64 ic_load_plain_generic;
    u64 ic_load_primitive_hits;
    u64 ic_load_primitive_fills;
    u64 ic_load_primitive_uncacheable;
    u64 ic_load_string_length_hits;
    u64 ic_load_array_length_hits;
    u64 ic_load_watched_hits;
    u64 ic_load_watched_fills;
    u64 ic_load_other_generic;
    u64 ic_inherited_fills;
    u64 ic_inherited_reject_basic;
    u64 ic_inherited_reject_key;
    u64 ic_inherited_reject_receiver;
    u64 ic_inherited_reject_resolution;
    u64 ic_inherited_reject_chain;

    u64 ic_store_mono_hits;
    u64 ic_store_region_hits;
    u64 ic_store_fallbacks;
    u64 ic_store_slow_mono_hits;
    u64 ic_store_poly_hits;
    u64 ic_store_shape_hits;
    u64 ic_store_shape_fills;
    u64 ic_store_shape_uncacheable;
    u64 ic_store_plain_generic;
    u64 ic_store_other_generic;
} MalPerfStats;

extern MalPerfStats mal_perf_stats;

#if MAL_PERF_STATS
extern bool mal_perf_stats_enabled;
void mal_perf_stats_init(void);
void mal_perf_intrinsic_name(const byte *name, usize length);

#define MAL_PERF_COUNT(field) \
    do { \
        if (mal_perf_stats_enabled) { \
            mal_perf_stats.field++; \
        } \
    } while (0)

#define MAL_PERF_ADD(field, value) \
    do { \
        if (mal_perf_stats_enabled) { \
            mal_perf_stats.field += (u64) (value); \
        } \
    } while (0)
#else
#define mal_perf_stats_enabled false

static inline void mal_perf_stats_init(void) {}
static inline void mal_perf_intrinsic_name(const byte *name, usize length) {
    (void) name;
    (void) length;
}

#define MAL_PERF_COUNT(field) ((void) 0)
#define MAL_PERF_ADD(field, value) ((void) 0)
#endif

static inline void mal_perf_ic_load_mono_hit(void) {
    MAL_PERF_COUNT(ic_load_mono_hits);
}

static inline void mal_perf_ic_load_region_hit(void) {
    MAL_PERF_COUNT(ic_load_region_hits);
}

static inline void mal_perf_ic_load_inherited_hit(void) {
    MAL_PERF_COUNT(ic_load_inherited_hits);
}

static inline void mal_perf_ic_load_primitive_hit(void) {
    MAL_PERF_COUNT(ic_load_primitive_hits);
}

static inline void mal_perf_ic_load_string_length_hit(void) {
    MAL_PERF_COUNT(ic_load_string_length_hits);
}

static inline void mal_perf_ic_load_array_length_hit(void) {
    MAL_PERF_COUNT(ic_load_array_length_hits);
}

static inline void mal_perf_ic_store_mono_hit(void) {
    MAL_PERF_COUNT(ic_store_mono_hits);
}

static inline void mal_perf_ic_store_region_hit(void) {
    MAL_PERF_COUNT(ic_store_region_hits);
}
