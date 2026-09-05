#pragma once

#include "defaults.h"

#ifndef MAL_PERF_STATS
#define MAL_PERF_STATS 0
#endif

#define MAL_PERF_TABLE_ROLE_COUNT 4
#define MAL_PERF_SHAPE_CALLER_COUNT 6
#define MAL_PERF_IC_MODE_COUNT 9

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
    u64 storage_allocations;
    u64 storage_releases;
    u64 entry_shrinks;
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
    u64 string_search_calls;
    u64 string_search_multi_unit_calls;
    u64 string_search_candidates;
    u64 string_search_first_unit_rejects;
    u64 string_search_last_unit_rejects;
    u64 string_search_memcmp_calls;
    u64 string_search_memcmp_code_units;
    u64 string_reverse_search_calls;
    u64 string_reverse_search_candidates;
    u64 string_reverse_search_first_unit_rejects;
    u64 string_reverse_search_last_unit_rejects;
    u64 string_reverse_search_memcmp_calls;
    u64 string_reverse_search_memcmp_code_units;
    u64 string_unit_scan_word_blocks;
    u64 string_unit_scan_candidate_blocks;
    u64 string_unit_scan_scalar_code_units;
    u64 string_split_planned_matches;
    u64 string_split_plan_overflows;
    u64 string_char_code_at_direct_hits;
    u64 string_char_code_at_direct_fallbacks;
    u64 string_case_calls;
    u64 string_case_input_code_units;
    u64 string_case_reuses;
    u64 string_case_changed_allocations;
    u64 string_case_changed_code_units;
    u64 string_allocations;
    u64 string_code_units;
    u64 string_length_0_allocations;
    u64 string_length_1_allocations;
    u64 string_length_2_4_allocations;
    u64 string_length_5_8_allocations;
    u64 string_length_9_16_allocations;
    u64 string_length_17_32_allocations;
    u64 string_length_33_64_allocations;
    u64 string_length_65_plus_allocations;
    u64 string_inline_allocations;
    u64 string_inline_code_units;
    u64 string_inline_concat_results;
    u64 string_tiny_cache_hits;
    u64 string_tiny_cache_misses;
    u64 string_tiny_cache_replacements;
    u64 string_tiny_cache_promotions;
    u64 string_small_uint_cache_hits;
    u64 string_small_uint_cache_misses;
    u64 string_copy_allocations;
    u64 string_copy_code_units;
    u64 string_ascii_allocations;
    u64 string_ascii_code_units;
    u64 string_owned_allocations;
    u64 string_owned_code_units;
    u64 string_external_allocations;
    u64 string_external_code_units;
    u64 string_dependent_allocations;
    u64 string_dependent_code_units;
    u64 string_dependent_retained_code_units;
    u64 string_cons_allocations;
    u64 string_cons_code_units;
    u64 string_slice_calls;
    u64 string_slice_requested_code_units;
    u64 string_slice_empty_results;
    u64 string_slice_full_reuses;
    u64 string_slice_dependent_results;
    u64 string_slice_copy_results;
    u64 string_flatten_calls;
    u64 string_flatten_code_units;
    u64 string_flatten_cons_nodes;
    u64 string_flatten_flat_leaves;
    u64 string_flatten_shared_copies;

    u64 regexp_exec_calls;
    u64 regexp_fast_exec_calls;
    u64 regexp_ascii_exec_calls;
    u64 regexp_ascii_cache_hits;
    u64 regexp_ascii_cache_fills;
    u64 regexp_utf16_exec_calls;
    u64 regexp_utf16_cache_hits;
    u64 regexp_utf16_cache_fills;

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
    u64 property_constant_atom_hits;
    u64 property_accessor_sidecar_allocations;
    u64 property_accessor_sidecar_frees;
    u64 known_own_slot_load_probes;
    u64 known_own_slot_load_hits;
    u64 known_own_slot_load_fallbacks;
    u64 known_own_slot_store_probes;
    u64 known_own_slot_store_hits;
    u64 known_own_slot_store_fallbacks;
    u64 exact_own_slot_loads;
    u64 exact_own_slot_stores;
    u64 exact_typed_array_loads;
    u64 shape_case_probes;
    u64 shape_case_hits;
    u64 shape_case_fallbacks;
    u64 shape_case_load_probes;
    u64 shape_case_load_hits;
    u64 shape_case_load_fallbacks;
    u64 copy_data_linear_exclusion_checks;
    u64 copy_data_shaped_hits;
    u64 copy_data_shaped_slots;
    u64 copy_data_fallbacks;
    u64 map_get_set_cache_checks;
    u64 map_get_set_cache_hits;
    u64 map_get_set_cache_misses;
    u64 collection_exact_receiver_hits;
    u64 collection_direct_map_get_hits;
    u64 collection_direct_map_set_hits;
    u64 collection_direct_map_has_hits;
    u64 collection_direct_map_delete_hits;
    u64 collection_direct_set_add_hits;
    u64 collection_direct_set_has_hits;
    u64 collection_direct_set_delete_hits;
    u64 collection_direct_fallbacks;
    u64 iterator_entry_pair_hits;
    u64 iterator_entry_pair_fallbacks;
    u64 object_empty_creations;
    u64 object_shaped_creations;
    u64 stack_object_initializations;
    u64 stack_object_materializations;
    u64 stack_object_inherited_fast_initializations;
    u64 stack_object_inherited_heap_fallbacks;
    u64 stack_object_inherited_direct_loads;
    u64 error_stack_trace_stores;
    u64 error_stack_trace_releases;
    u64 error_stack_trace_peak_live;
    u64 function_property_cache_allocations;
    u64 function_property_cache_bytes;
    u64 function_literal_cache_allocations;
    u64 function_literal_cache_bytes;
    u64 property_stub_cache_allocations;
    u64 inherited_property_stub_cache_allocations;
    u64 inherited_property_stub_cache_bytes;
    u64 interp_call_cache_allocations;
    u64 global_property_cache_allocations;

    u64 binary_number_arithmetic_hits;
    u64 binary_number_arithmetic_fallbacks;
    u64 binary_number_comparison_hits;
    u64 binary_number_comparison_fallbacks;
    u64 binary_number_bitwise_hits;
    u64 binary_number_bitwise_fallbacks;
    u64 binary_number_other_fallbacks;

    u64 interpreter_direct_leaf_executions;
    u64 interpreter_guard_branch_fusions;
    u64 interpreter_global_tdz_fusions;
    u64 interpreter_binary_branch_fusions;
    u64 interpreter_create_object_shaped_jump_fusions;
    u64 interpreter_boundary_dispatches;
    u64 interpreter_state_syncs;
    u64 interpreter_state_reloads;
    u64 interpreter_normal_helper_continuations;
    u64 interpreter_strict_direct_hits;
    u64 interpreter_strict_string_fallbacks;
    u64 interpreter_local_load_ic_hits;
    u64 interpreter_local_store_ic_hits;
    u64 interpreter_load_ic_sync_fallbacks;
    u64 interpreter_store_ic_sync_fallbacks;
    u64 interpreter_iterator_dense_hits;
    u64 interpreter_iterator_sync_fallbacks;

    u64 rest_array_allocations;
    u64 rest_array_values;
    u64 rest_forward_calls;
    u64 rest_forward_values;
    u64 rest_forward_copies;
    u64 argument_snapshot_logical_values;
    u64 argument_snapshot_destination_writes;
    u64 argument_snapshot_temporary_copies;
	u64 direct_entry_hits;

	u64 call_cache_probes;
    u64 call_cache_exact_identity_hits;
    u64 call_cache_compiled_exact_hits;
    u64 call_cache_compiled_family_hits;
    u64 call_cache_native_exact_hits;
    u64 call_cache_way_checks;
    u64 call_cache_dispatch_misses;
    u64 call_cache_compiled_fills;
    u64 call_cache_native_fills;
    u64 compiled_enter_calls;
    u64 compiled_debug_frame_entries;

    u64 coroutine_buffer_release_clear_slots;
    u64 coroutine_buffer_allocation_init_slots;

    u64 promise_await_typed_continuations;
    u64 promise_await_typed_jobs;
    u64 promise_job_slab_hits;
    u64 promise_job_slab_fresh_slots;
    u64 promise_job_slab_block_allocations;
    u64 promise_job_slab_block_frees;
    u64 promise_job_slab_peak_retained_bytes;
    u64 promise_native_adoption_hits;
    u64 promise_native_adoption_guard_fallbacks;
    u64 promise_resolve_identity_hits;
    u64 promise_intrinsic_species_hits;
    u64 promise_discarded_dependent_registrations;
    u64 promise_guarded_fallbacks;
    u64 promise_resolving_pairs;
    u64 promise_async_generator_direct_requests;

    u64 array_fresh_dense_stores;
    u64 array_fresh_dense_growths;
    u64 array_fresh_dense_fallbacks;
    u64 array_fresh_dense_exact_reserves;
    u64 array_fresh_dense_reserved_slots;
    u64 array_fresh_dense_growths_avoided;
    u64 array_indexed_fill_reserves;
    u64 array_indexed_fill_reserved_slots;
    u64 array_indexed_fill_allocations_avoided;
    u64 array_indexed_fill_raw_bytes_avoided;
    u64 array_indexed_fill_guard_fallbacks;
	u64 array_push_direct_hits;
    u64 array_push_direct_fallbacks;
	u64 array_contained_pushes;
	u64 array_contained_push_overflows;
	u64 array_contained_pops;
	u64 array_contained_empty_pops;
	u64 array_contained_element_reads;
    u64 array_iteration_direct_hits;
    u64 array_iteration_direct_fallbacks;
    u64 array_iteration_exact_callback_calls;
    u64 array_iteration_exact_compiled_callback_calls;

    u64 node_event_singleton_inserts;
    u64 node_event_listener_array_allocations;
    u64 node_event_listener_array_copied_entries;
    u64 node_event_listener_promotions;
    u64 node_event_listener_demotions;

    u64 http_response_index_lookups;
    u64 http_response_index_hits;
    u64 http_response_index_misses;
    u64 http_response_index_probes;
    u64 http_response_index_max_probes;
    u64 http_response_index_peak_entries;
    u64 http_response_index_inserts;
    u64 http_response_index_removes;
    u64 http_response_index_rehashes;
    u64 http_response_header_name_coercions;
    u64 http_response_header_name_materializations;
    u64 http_response_header_insertions;
    u64 http_response_header_replacements;
    u64 http_response_header_allocation_free_lookups;
    u64 http_response_header_spills;
    u64 http_response_header_max_count;
    u64 http_codec_head_allocations;
    u64 http_codec_field_spills;
    u64 http_codec_arena_spills;
    u64 http_codec_body_growths;
    u64 http_codec_max_fields;
    u64 http_codec_max_head_bytes;
    u64 http_drain_calls;
    u64 http_request_state_scans;
    u64 http_close_scans;
    u64 http_close_request_state_scans;
    u64 http_request_remove_scans;
    u64 http_dispatch_enqueues;
    u64 http_dispatch_dequeues;
    u64 http_completion_enqueues;
    u64 http_completion_dequeues;
    u64 http_request_inserts;
    u64 http_request_removes;
    u64 http_request_state_allocations;
    u64 http_request_body_allocations;
    u64 http_request_packed_headers;
    u64 http_request_copy_operations;
    u64 http_request_copy_bytes;
    u64 http_request_body_transfers;
    u64 http_request_state_direct_frees;
    u64 http_request_body_direct_frees;
    u64 http_bulk_shaped_objects;
    u64 http_bulk_shaped_slots;
    u64 http_property_definitions_avoided;
    u64 http_shape_transitions_avoided;
    u64 http_incoming_message_shape_append_batches;
    u64 http_incoming_message_shape_append_slots;
    u64 http_incoming_message_shape_append_fallbacks;
    u64 http_incoming_message_slot_growths_avoided;
    u64 http_response_constructor_shape_append_batches;
    u64 http_response_constructor_shape_append_slots;
    u64 http_response_constructor_shape_append_fallbacks;
    u64 http_response_constructor_slot_growths_avoided;
    u64 http_response_shape_append_batches;
    u64 http_response_shape_append_slots;
    u64 http_response_shape_append_fallbacks;
    u64 http_response_slot_growths_avoided;

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
    u64 ic_load_inherited_hits;
    u64 ic_load_missing_hits;
    u64 ic_load_missing_fills;
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
    u64 prototype_epoch_invalidations;
    u64 prototype_epoch_define_invalidations;
    u64 prototype_epoch_dictionary_invalidations;
    u64 prototype_epoch_append_invalidations;
    u64 prototype_epoch_delete_invalidations;
    u64 prototype_epoch_reparent_invalidations;
    u64 prototype_epoch_shaped_invalidations;
    u64 prototype_epoch_finalize_invalidations;

    u64 ic_store_mono_hits;
    u64 ic_store_fallbacks;
    u64 ic_store_slow_mono_hits;
    u64 ic_store_poly_hits;
    u64 ic_store_mega_hits;
    u64 ic_store_mega_misses;
    u64 ic_store_shape_hits;
    u64 ic_store_shape_fills;
    u64 ic_store_shape_uncacheable;
    u64 ic_store_transition_hits;
    u64 ic_store_transition_fills;
    u64 ic_store_plain_generic;
    u64 ic_store_other_generic;

    u64 ic_mode_replacements[MAL_PERF_IC_MODE_COUNT][MAL_PERF_IC_MODE_COUNT];

    u64 prototype_dependency_register_calls;
    u64 prototype_dependency_register_nodes;
    u64 prototype_dependency_register_failures;
    u64 prototype_dependency_unregister_calls;
    u64 prototype_dependency_unregister_scan_steps;
    u64 prototype_dependency_unregister_removed;
    u64 prototype_dependency_invalidate_calls;
    u64 prototype_dependency_invalidate_scan_steps;
    u64 prototype_dependency_invalidate_removed;
} MalPerfStats;

extern MalPerfStats mal_perf_stats;

#if MAL_PERF_STATS
extern bool mal_perf_stats_enabled;
void mal_perf_stats_init(void);
void mal_perf_stats_reset(void);
void mal_perf_intrinsic_name(const byte *name, usize length);
void mal_perf_native_call_name(const c16 *name, usize length);

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
static inline void mal_perf_stats_reset(void) {}
static inline void mal_perf_intrinsic_name(const byte *name, usize length) {
    (void) name;
    (void) length;
}
static inline void mal_perf_native_call_name(const c16 *name, usize length) {
    (void) name;
    (void) length;
}

#define MAL_PERF_COUNT(field) ((void) 0)
#define MAL_PERF_ADD(field, value) ((void) 0)
#endif

static inline void mal_perf_ic_load_mono_hit(void) {
    MAL_PERF_COUNT(ic_load_mono_hits);
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

static inline void mal_perf_stack_object_init(void) {
    MAL_PERF_COUNT(stack_object_initializations);
}

static inline void mal_perf_stack_object_inherited_fast_init(void) {
    MAL_PERF_COUNT(stack_object_inherited_fast_initializations);
}

static inline void mal_perf_stack_object_inherited_heap_fallback(void) {
    MAL_PERF_COUNT(stack_object_inherited_heap_fallbacks);
}

static inline void mal_perf_stack_object_inherited_direct_load(void) {
    MAL_PERF_COUNT(stack_object_inherited_direct_loads);
}
