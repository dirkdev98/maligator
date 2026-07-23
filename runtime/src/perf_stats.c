#include "perf_stats.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if MAL_PERF_STATS
#define MAL_PERF_INTRINSIC_NAME_CAPACITY 2048
#define MAL_PERF_INTRINSIC_NAME_MAX_LENGTH 63

typedef struct MalPerfIntrinsicName {
    u64 hash;
    u64 calls;
    u32 length;
    byte name[MAL_PERF_INTRINSIC_NAME_MAX_LENGTH + 1];
} MalPerfIntrinsicName;

bool mal_perf_stats_enabled = false;
MalPerfStats mal_perf_stats;
static MalPerfIntrinsicName mal_perf_intrinsic_names[MAL_PERF_INTRINSIC_NAME_CAPACITY];

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

static void mal_perf_stats_print(void) {
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
        "search_memcmp_calls=%llu search_memcmp_code_units=%llu\n",
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
        (unsigned long long) mal_perf_stats.string_search_memcmp_code_units
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
        stderr, "[perf-property-stats] ensure_calls=%llu ensure_inserts=%llu ensure_hits=%llu\n",
        (unsigned long long) mal_perf_stats.property_ensure_calls,
        (unsigned long long) mal_perf_stats.property_ensure_inserts,
        (unsigned long long) mal_perf_stats.property_ensure_hits
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
        "[perf-interpreter-stats] direct_leaf_executions=%llu boundary_dispatches=%llu "
        "state_syncs=%llu state_reloads=%llu strict_direct_hits=%llu "
        "strict_string_fallbacks=%llu local_load_ic_hits=%llu local_store_ic_hits=%llu "
        "load_ic_sync_fallbacks=%llu store_ic_sync_fallbacks=%llu\n",
        (unsigned long long) mal_perf_stats.interpreter_direct_leaf_executions,
        (unsigned long long) mal_perf_stats.interpreter_boundary_dispatches,
        (unsigned long long) mal_perf_stats.interpreter_state_syncs,
        (unsigned long long) mal_perf_stats.interpreter_state_reloads,
        (unsigned long long) mal_perf_stats.interpreter_strict_direct_hits,
        (unsigned long long) mal_perf_stats.interpreter_strict_string_fallbacks,
        (unsigned long long) mal_perf_stats.interpreter_local_load_ic_hits,
        (unsigned long long) mal_perf_stats.interpreter_local_store_ic_hits,
        (unsigned long long) mal_perf_stats.interpreter_load_ic_sync_fallbacks,
        (unsigned long long) mal_perf_stats.interpreter_store_ic_sync_fallbacks
    );
    fprintf(
        stderr,
        "[perf-promise-stats] await_typed_continuations=%llu await_typed_jobs=%llu "
        "job_slab_hits=%llu job_slab_fresh_slots=%llu "
        "job_slab_block_allocations=%llu job_slab_block_frees=%llu "
        "job_slab_peak_retained_bytes=%llu\n",
        (unsigned long long) mal_perf_stats.promise_await_typed_continuations,
        (unsigned long long) mal_perf_stats.promise_await_typed_jobs,
        (unsigned long long) mal_perf_stats.promise_job_slab_hits,
        (unsigned long long) mal_perf_stats.promise_job_slab_fresh_slots,
        (unsigned long long) mal_perf_stats.promise_job_slab_block_allocations,
        (unsigned long long) mal_perf_stats.promise_job_slab_block_frees,
        (unsigned long long) mal_perf_stats.promise_job_slab_peak_retained_bytes
    );
    fprintf(
        stderr,
        "[perf-arguments-stats] unique_values=%llu register_restores=%llu\n",
        (unsigned long long) mal_perf_stats.argument_snapshot_unique_values,
        (unsigned long long) mal_perf_stats.argument_snapshot_register_restores
    );
    fprintf(
        stderr,
        "[perf-array-stats] fresh_dense_stores=%llu fresh_dense_growths=%llu "
        "fresh_dense_fallbacks=%llu fresh_dense_exact_reserves=%llu "
        "fresh_dense_reserved_slots=%llu fresh_dense_growths_avoided=%llu\n",
        (unsigned long long) mal_perf_stats.array_fresh_dense_stores,
        (unsigned long long) mal_perf_stats.array_fresh_dense_growths,
        (unsigned long long) mal_perf_stats.array_fresh_dense_fallbacks,
        (unsigned long long) mal_perf_stats.array_fresh_dense_exact_reserves,
        (unsigned long long) mal_perf_stats.array_fresh_dense_reserved_slots,
        (unsigned long long) mal_perf_stats.array_fresh_dense_growths_avoided
    );
    for (u32 i = 0; i < MAL_PERF_TABLE_ROLE_COUNT; i++) {
        const MalPerfTableStats *stats = &mal_perf_stats.tables[i];
        fprintf(
            stderr,
            "[perf-table-stats] role=%s lookups=%llu lookup_hits=%llu lookup_misses=%llu "
            "upserts=%llu upsert_hits=%llu upsert_inserts=%llu find_calls=%llu "
            "probes=%llu max_probe=%llu string_queries=%llu rehashes=%llu "
            "rehash_entries=%llu slot_growths=%llu deletes=%llu delete_hits=%llu "
            "delete_cluster_scans=%llu delete_slot_moves=%llu clears=%llu compactions=%llu\n",
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
            (unsigned long long) stats->compactions
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
        "[perf-ic-stats] load_mono_hits=%llu load_region_hits=%llu "
        "load_inherited_hits=%llu load_fallbacks=%llu load_slow_mono_hits=%llu "
        "load_poly_hits=%llu load_mega_hits=%llu load_mega_misses=%llu "
        "load_shape_hits=%llu load_shape_fills=%llu load_shape_uncacheable=%llu "
        "load_plain_generic=%llu load_primitive_hits=%llu load_primitive_fills=%llu "
        "load_primitive_uncacheable=%llu load_string_length_hits=%llu "
        "load_array_length_hits=%llu load_watched_hits=%llu load_watched_fills=%llu "
        "load_other_generic=%llu inherited_fills=%llu inherited_reject_basic=%llu "
        "inherited_reject_key=%llu inherited_reject_receiver=%llu "
        "inherited_reject_resolution=%llu inherited_reject_chain=%llu "
        "store_mono_hits=%llu store_region_hits=%llu store_fallbacks=%llu "
        "store_slow_mono_hits=%llu store_poly_hits=%llu store_shape_hits=%llu "
        "store_shape_fills=%llu store_shape_uncacheable=%llu store_plain_generic=%llu "
        "store_other_generic=%llu\n",
        (unsigned long long) mal_perf_stats.ic_load_mono_hits,
        (unsigned long long) mal_perf_stats.ic_load_region_hits,
        (unsigned long long) mal_perf_stats.ic_load_inherited_hits,
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
        (unsigned long long) mal_perf_stats.ic_load_watched_hits,
        (unsigned long long) mal_perf_stats.ic_load_watched_fills,
        (unsigned long long) mal_perf_stats.ic_load_other_generic,
        (unsigned long long) mal_perf_stats.ic_inherited_fills,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_basic,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_key,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_receiver,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_resolution,
        (unsigned long long) mal_perf_stats.ic_inherited_reject_chain,
        (unsigned long long) mal_perf_stats.ic_store_mono_hits,
        (unsigned long long) mal_perf_stats.ic_store_region_hits,
        (unsigned long long) mal_perf_stats.ic_store_fallbacks,
        (unsigned long long) mal_perf_stats.ic_store_slow_mono_hits,
        (unsigned long long) mal_perf_stats.ic_store_poly_hits,
        (unsigned long long) mal_perf_stats.ic_store_shape_hits,
        (unsigned long long) mal_perf_stats.ic_store_shape_fills,
        (unsigned long long) mal_perf_stats.ic_store_shape_uncacheable,
        (unsigned long long) mal_perf_stats.ic_store_plain_generic,
        (unsigned long long) mal_perf_stats.ic_store_other_generic
    );
}

void mal_perf_stats_init(void) {
    static bool registered = false;
    if (getenv("MAL_PERF_STATS") == nullptr) {
        return;
    }
    mal_perf_stats_enabled = true;
    if (!registered) {
        registered = true;
        atexit(mal_perf_stats_print);
    }
}
#else
// Keep dead instrumentation references valid even in unoptimized diagnostic builds.
MalPerfStats mal_perf_stats;
#endif
