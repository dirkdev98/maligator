#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_string.h"
#include "gc.h"
#include "heap_string.h"
#include "perf_stats.h"
#include "shape.h"
#include "value.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static u64 reference_hash(const c16 *units, usize length) {
    u64 hash = 0xcbf29ce484222325;
    for (usize i = 0; i < length; i++) {
        hash = (hash ^ (u8) units[i]) * 0x100000001b3;
        hash = (hash ^ (u8) (units[i] >> 8)) * 0x100000001b3;
    }
    return hash;
}

static bool inspect_rope(const MalString *string, usize *height, usize *nodes) {
    (*nodes)++;
    if (string->storage != MAL_STRING_STORAGE_CONS) {
        if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
            CHECK(string->parent->storage != MAL_STRING_STORAGE_CONS);
            CHECK(string->parent->storage != MAL_STRING_STORAGE_DEPENDENT);
        }
        *height = 0;
        return true;
    }
    usize maximum_child = string->length - (string->length + 3) / 4;
    CHECK(string->left->length + string->right->length == string->length);
    CHECK(string->left->length > 0 && string->right->length > 0);
    const MalString *children[] = {string->left, string->right};
    for (usize i = 0; i < countof(children); i++) {
        const MalString *child = children[i];
        if (child->storage != MAL_STRING_STORAGE_CONS || child->length <= maximum_child) continue;
        CHECK(child->length <= 2 * MAL_STRING_INLINE_LATIN1_CODE_UNITS);
    }
    usize left_height, right_height;
    CHECK(inspect_rope(string->left, &left_height, nodes));
    CHECK(inspect_rope(string->right, &right_height, nodes));
    *height = 1 + (left_height > right_height ? left_height : right_height);
    CHECK(*height < 60);
    return true;
}

static bool check_range(const MalString *string, const c16 *expected, usize start, usize length) {
    for (usize reverse = 0; reverse < 2; reverse++) {
        MalStringIterator iterator;
        if (reverse) mal_string_iterator_init_reverse(&iterator, string, start, length);
        else mal_string_iterator_init(&iterator, string, start, length);
        MalStringSegment segment;
        usize consumed = 0;
        u64 before = mal_perf_stats.string_iterator_nodes;
        while (mal_string_iterator_next(&iterator, &segment)) {
            CHECK(iterator.current.string->storage != MAL_STRING_STORAGE_CONS);
            CHECK(iterator.current.string->storage != MAL_STRING_STORAGE_DEPENDENT);
            CHECK(iterator.current.length == segment.length);
            for (usize i = 0; i < segment.length; i++) {
                usize local = reverse ? segment.length - i - 1 : i;
                usize index = reverse ? start + length - consumed - i - 1 : start + consumed + i;
                CHECK(mal_string_segment_code_unit_at(&segment, local) == expected[index]);
                CHECK(mal_string_code_unit_at((MalString *) iterator.current.string,
                    iterator.current.offset + local) == expected[index]);
            }
            consumed += segment.length;
        }
        CHECK(consumed == length);
        if (mal_perf_stats_enabled) {
            u64 visited = mal_perf_stats.string_iterator_nodes - before;
            CHECK(length == 0 || visited > 0);
            CHECK(visited <= 2 * length + 60);
        }
        mal_string_iterator_dispose(&iterator);
    }
    return true;
}

static c16 fixture_unit(usize index) {
    const c16 special[] = {0, 0xff, 0x100, 0xd800, 0xdc00, 0xdfff};
    if (index % 23 < countof(special)) return special[index % 23];
    return (c16) ('a' + index % 26);
}

static bool short_chains_reuse_their_intermediate(MalVm *vm) {
    for (usize encoding = 0; encoding < 3; encoding++) {
        for (usize prefix_length = 10; prefix_length <= 13; prefix_length++) {
            for (usize suffix_length = 1; suffix_length <= 3; suffix_length++) {
                for (usize prepend = 0; prepend < 2; prepend++) {
                    c16 prefix[13], middle[7], suffix[3], expected[23];
                    for (usize i = 0; i < prefix_length; i++) prefix[i] = (c16) ('a' + i);
                    for (usize i = 0; i < countof(middle); i++) middle[i] = (c16) ('k' + i);
                    for (usize i = 0; i < suffix_length; i++) suffix[i] = (c16) ('0' + i);
                    if (encoding == 1) prefix[2] = 0xff;
                    if (encoding == 2) {
                        prefix[2] = 0x100;
                        middle[6] = 0xd800;
                        suffix[0] = 0xdc00;
                    }
                    MalString *a = mal_string_new_copy(&vm->heap, prefix, prefix_length);
                    MalString *b = mal_string_new_copy(&vm->heap, middle, countof(middle));
                    MalString *c = mal_string_new_copy(&vm->heap, suffix, suffix_length);
                    usize length = prefix_length + countof(middle) + suffix_length;
                    MalString *intermediate, *result;
                    u64 allocations_before = mal_perf_stats.string_allocations;
                    u64 cons_before = mal_perf_stats.string_cons_allocations;
                    if (prepend) {
                        memcpy(expected, suffix, suffix_length * sizeof(c16));
                        memcpy(expected + suffix_length, middle, sizeof(middle));
                        memcpy(expected + suffix_length + countof(middle), prefix, prefix_length * sizeof(c16));
                        CHECK(mal_string_new_cons_checked(&vm->heap, b, a, &intermediate));
                        CHECK(mal_string_new_cons_checked(&vm->heap, c, intermediate, &result));
                    } else {
                        memcpy(expected, prefix, prefix_length * sizeof(c16));
                        memcpy(expected + prefix_length, middle, sizeof(middle));
                        memcpy(expected + prefix_length + countof(middle), suffix, suffix_length * sizeof(c16));
                        CHECK(mal_string_new_cons_checked(&vm->heap, a, b, &intermediate));
                        CHECK(mal_string_hash(intermediate) == reference_hash(expected, intermediate->length));
                        CHECK(mal_string_new_cons_checked(&vm->heap, intermediate, c, &result));
                    }
                    if (mal_perf_stats_enabled) {
                        CHECK(mal_perf_stats.string_allocations - allocations_before == 2);
                        CHECK(mal_perf_stats.string_cons_allocations - cons_before == 2);
                    }
                    usize height, nodes = 0;
                    CHECK(inspect_rope(result, &height, &nodes));
                    CHECK(height == 2);
                    CHECK(check_range(result, expected, 0, length));
                    CHECK(mal_string_hash(result) == reference_hash(expected, length));
                    MalValue roots[] = {mal_value_from_string(result), mal_value_from_string(intermediate)};
                    MalRootSpan span;
                    mal_gc_root(&span, roots, countof(roots));
                    mal_gc_collect(vm);
                    CHECK(check_range(result, expected, 0, length));
                    // A retained short subtree may be materialized independently.
                    mal_string_code_units(intermediate);
                    CHECK(check_range(result, expected, 0, length));
                    CHECK(mal_string_hash(result) == reference_hash(expected, length));
                    mal_gc_unroot(&span);
                }
            }
        }
    }
    return true;
}

static bool unit_appends_keep_bounded_height(MalVm *vm) {
    enum { LENGTH = 4096 };
    c16 expected[LENGTH];
    for (usize encoding = 0; encoding < 3; encoding++) {
        for (usize prepend = 0; prepend < 2; prepend++) {
            MalString *rope = nullptr;
            for (usize i = 0; i < LENGTH; i++) {
                c16 unit = encoding == 2 ? fixture_unit(i) : (c16) (encoding == 1 ? 0x80 + i % 128 : 'a' + i % 26);
                expected[prepend ? LENGTH - i - 1 : i] = unit;
                MalString *piece = mal_string_new_copy(&vm->heap, &unit, 1);
                if (rope == nullptr) rope = piece;
                else if (prepend) CHECK(mal_string_new_cons_checked(&vm->heap, piece, rope, &rope));
                else CHECK(mal_string_new_cons_checked(&vm->heap, rope, piece, &rope));
            }
            usize height, nodes = 0;
            CHECK(inspect_rope(rope, &height, &nodes));
            CHECK(nodes < LENGTH * 2);
            CHECK(check_range(rope, expected, 0, LENGTH));
            CHECK(mal_string_hash(rope) == reference_hash(expected, LENGTH));
            MalValue rooted = mal_value_from_string(rope);
            MalRootSpan span;
            mal_gc_root(&span, &rooted, 1);
            mal_gc_collect(vm);
            CHECK(check_range(rope, expected, 0, LENGTH));
            mal_gc_unroot(&span);
        }
    }
    return true;
}

static bool traversal_and_balancing(MalVm *vm, usize leaves, usize construction) {
    usize length = leaves * 17;
    c16 *expected = malloc(length * sizeof(c16));
    MalString **parts = malloc(leaves * sizeof(*parts));
    CHECK(expected != nullptr && parts != nullptr);
    for (usize i = 0; i < length; i++) expected[i] = fixture_unit(i);
    for (usize i = 0; i < leaves; i++) parts[i] = mal_string_new_copy(&vm->heap, expected + i * 17, 17);
    MalString *rope;
    if (construction == 0) {
        rope = parts[0];
        for (usize i = 1; i < leaves; i++) CHECK(mal_string_new_cons_checked(&vm->heap, rope, parts[i], &rope));
    } else if (construction == 1) {
        rope = parts[leaves - 1];
        for (usize i = leaves - 1; i > 0; i--) CHECK(mal_string_new_cons_checked(&vm->heap, parts[i - 1], rope, &rope));
    } else if (construction == 2) {
        for (usize count = leaves; count > 1;) {
            usize next = 0;
            for (usize i = 0; i < count; i += 2) {
                if (i + 1 == count) parts[next++] = parts[i];
                else {
                    CHECK(mal_string_new_cons_checked(&vm->heap, parts[i], parts[i + 1], &parts[next]));
                    next++;
                }
            }
            count = next;
        }
        rope = parts[0];
    } else {
        usize count = leaves;
        u32 random = 0x4d4c4701;
        while (count > 1) {
            random = random * 1664525 + 1013904223;
            usize index = random % (count - 1);
            CHECK(mal_string_new_cons_checked(&vm->heap, parts[index], parts[index + 1], &parts[index]));
            memmove(parts + index + 1, parts + index + 2, (count - index - 2) * sizeof(*parts));
            count--;
        }
        rope = parts[0];
    }
    usize height, nodes = 0;
    CHECK(inspect_rope(rope, &height, &nodes));
    CHECK(nodes < leaves * 6);
    CHECK(mal_string_hash(rope) == reference_hash(expected, length));
    CHECK(check_range(rope, expected, 0, length));
    CHECK(check_range(rope, expected, 1, length - 3));
    CHECK(check_range(rope, expected, 17, 34));
    CHECK(check_range(rope, expected, length - 19, 19));
    CHECK(check_range(rope, expected, length, 0));
    for (usize i = 0; i < length; i += 31) {
        const MalString *leaf;
        usize offset, available;
        mal_string_get_leaf_range(rope, i, &leaf, &offset, &available);
        CHECK(available > 0 && available <= length - i);
        CHECK(mal_string_code_unit_at((MalString *) leaf, offset) == expected[i]);
        CHECK(mal_string_code_unit_at((MalString *) leaf, offset + available - 1) == expected[i + available - 1]);
    }
    MalValue rooted = mal_value_from_string(rope);
    MalRootSpan span;
    mal_gc_root(&span, &rooted, 1);
    free(parts);
    mal_gc_collect(vm);
    CHECK(check_range(rope, expected, 0, length));
    // Materializing a shared child changes storage but cannot violate the length bound.
    mal_string_code_units(rope->left);
    MalString *suffix = mal_string_new_copy(&vm->heap, expected, 17);
    CHECK(mal_string_new_cons_checked(&vm->heap, rope, suffix, &rope));
    rooted = mal_value_from_string(rope);
    nodes = 0;
    CHECK(inspect_rope(rope, &height, &nodes));
    CHECK(check_range(rope, expected, 0, length));
    mal_gc_collect(vm);
    CHECK(mal_string_code_unit_at(rope, length + 5) == expected[5]);
    mal_gc_unroot(&span);
    free(expected);
    return true;
}

static bool cached_append_hash_and_terminal_weight(MalVm *vm) {
    enum { PREFIX = 32768, APPENDS = 768, CHUNK = 17 };
    c16 *expected = malloc((PREFIX + APPENDS * CHUNK) * sizeof(c16));
    CHECK(expected != nullptr);
    for (usize i = 0; i < PREFIX + APPENDS * CHUNK; i++) expected[i] = fixture_unit(i);
    MalString *rope = mal_string_new_copy(&vm->heap, expected, PREFIX);
    CHECK(mal_string_hash(rope) == reference_hash(expected, PREFIX));
    u64 hashed_before = mal_perf_stats.string_hash_code_units;
    u64 allocated_before = mal_perf_stats.string_cons_allocations;
    for (usize i = 0; i < APPENDS; i++) {
        usize length = PREFIX + i * CHUNK;
        MalString *suffix = mal_string_new_copy(&vm->heap, expected + length, CHUNK);
        CHECK(mal_string_new_cons_checked(&vm->heap, rope, suffix, &rope));
        CHECK(mal_string_hash(rope) == reference_hash(expected, length + CHUNK));
        u64 repeated_before = mal_perf_stats.string_hash_code_units;
        CHECK(mal_string_hash(rope) == rope->hash);
        CHECK(mal_perf_stats.string_hash_code_units == repeated_before);
    }
    if (mal_perf_stats_enabled) {
        CHECK(mal_perf_stats.string_hash_code_units > hashed_before);
        CHECK(mal_perf_stats.string_cons_allocations > allocated_before);
        CHECK(mal_perf_stats.string_hash_code_units - hashed_before <= APPENDS * CHUNK * 8);
        CHECK(mal_perf_stats.string_cons_allocations - allocated_before <= APPENDS * 64);
    }
    usize height, nodes = 0;
    CHECK(inspect_rope(rope, &height, &nodes));
    CHECK(check_range(rope, expected, 0, rope->length));
    u64 units_before = mal_perf_stats.string_hash_code_units;
    CHECK(mal_string_compare(rope, rope) == 0);
    CHECK(mal_perf_stats.string_hash_code_units == units_before);
    free(expected);
    return true;
}

static bool alternating_sides_of_a_large_leaf(MalVm *vm) {
    enum { PREFIX = 32768, APPENDS = 384, CHUNK = 17 };
    c16 *expected = malloc((PREFIX + APPENDS * CHUNK) * sizeof(c16));
    CHECK(expected != nullptr);
    for (usize i = 0; i < PREFIX; i++) expected[i] = fixture_unit(i);
    MalString *rope = mal_string_new_copy(&vm->heap, expected, PREFIX);
    usize length = PREFIX;
    for (usize i = 0; i < APPENDS; i++) {
        c16 units[CHUNK];
        for (usize j = 0; j < CHUNK; j++) units[j] = fixture_unit(PREFIX + i * CHUNK + j);
        MalString *piece = mal_string_new_copy(&vm->heap, units, CHUNK);
        if (i % 2 == 0) {
            memmove(expected + CHUNK, expected, length * sizeof(c16));
            memcpy(expected, units, sizeof(units));
            CHECK(mal_string_new_cons_checked(&vm->heap, piece, rope, &rope));
        } else {
            memcpy(expected + length, units, sizeof(units));
            CHECK(mal_string_new_cons_checked(&vm->heap, rope, piece, &rope));
        }
        length += CHUNK;
    }
    usize height, nodes = 0;
    CHECK(inspect_rope(rope, &height, &nodes));
    CHECK(nodes < APPENDS * 6);
    CHECK(mal_string_hash(rope) == reference_hash(expected, length));
    MalValue rooted = mal_value_from_string(rope);
    MalRootSpan span;
    mal_gc_root(&span, &rooted, 1);
    mal_gc_collect(vm);
    CHECK(check_range(rope, expected, 0, length));
    mal_gc_unroot(&span);
    free(expected);
    return true;
}

static bool rope_shape_keys_share_and_survive_collection(MalVm *vm, usize count) {
    MalShape *root = mal_shape_root(&vm->heap);
    u64 comparisons_before = mal_perf_stats.string_equals_calls;
    u64 probes_before = mal_perf_stats.shape_transition_index_probes;
    for (usize i = 0; i < count; i++) {
        char suffix_bytes[32];
        int suffix_length = snprintf(suffix_bytes, sizeof(suffix_bytes), "%08zu", i);
        CHECK(suffix_length == 8);
        MalString *prefix = mal_string_new_ascii(&vm->heap, "rope-shape-followup-", 20);
        MalString *suffix = mal_string_new_ascii(&vm->heap, suffix_bytes, 8);
        MalString *key;
        CHECK(mal_string_new_cons_checked(&vm->heap, prefix, suffix, &key));
        MalShape *shape = mal_shape_add_property(root, mal_key_from_value(mal_value_from_string(key)), 7);
        c16 units[28];
        mal_string_copy_range_to(key, 0, 28, units);
        MalString probe;
        mal_string_init_external(&probe, units, countof(units));
        MalShape *same = mal_shape_add_property(root, mal_key_from_value(mal_value_from_string(&probe)), 7);
        CHECK(shape == same);
        CHECK(key->storage == MAL_STRING_STORAGE_CONS && key->left->latin1);
        CHECK(mal_string_hash(key) == reference_hash(units, countof(units)));
        CHECK(mal_shape_find(shape, mal_key_from_value(mal_value_from_string(&probe)), MAL_SHAPE_FIND_GET_OWN) == 0);
    }
    if (mal_perf_stats_enabled) {
        CHECK(mal_perf_stats.string_equals_calls > comparisons_before);
        CHECK(mal_perf_stats.shape_transition_index_probes > probes_before);
        CHECK(mal_perf_stats.string_equals_calls - comparisons_before < count * 16);
        CHECK(mal_perf_stats.shape_transition_index_probes - probes_before < count * 32);
    }
    mal_gc_collect(vm);
    MalShape *wide = root;
    for (usize i = 0; i < 16; i++) {
        char bytes[40];
        int length = snprintf(bytes, sizeof(bytes), "wide-rope-lookup-%08zu", i);
        MalString *prefix = mal_string_new_ascii(&vm->heap, bytes, 10);
        MalString *suffix = mal_string_new_ascii(&vm->heap, bytes + 10, (usize) length - 10);
        MalString *key;
        CHECK(mal_string_new_cons_checked(&vm->heap, prefix, suffix, &key));
        wide = mal_shape_add_property(wide, mal_key_from_value(mal_value_from_string(key)), 7);
    }
    for (usize round = 0; round < 3; round++) {
        for (usize i = 0; i < 16; i++) {
            MalString *key = mal_value_to_string(wide->props[i].key);
            c16 units[40];
            mal_string_copy_range_to(key, 0, key->length, units);
            MalString *query = mal_string_new_copy(&vm->heap, units, key->length);
            mal_string_code_units(query);
            CHECK(mal_shape_find(wide, mal_key_from_value(mal_value_from_string(query)), MAL_SHAPE_FIND_GET_OWN) == (i32) i);
            CHECK(mal_shape_find(wide, mal_key_from_value(mal_value_from_string(key)), MAL_SHAPE_FIND_GET_OWN) == (i32) i);
        }
        mal_gc_collect(vm);
    }
    return true;
}

static bool full_hash_collisions_preserve_key_identity(MalVm *vm) {
    MalShape *shapes[16];
    MalShape *root = mal_shape_root(&vm->heap);
    for (usize pass = 0; pass < 2; pass++) {
        for (usize i = 0; i < countof(shapes); i++) {
            char bytes[40];
            int length = snprintf(bytes, sizeof(bytes), "rope-full-hash-collision-%04zu", i);
            MalString *left = mal_string_new_ascii(&vm->heap, bytes, 17);
            MalString *right = mal_string_new_ascii(&vm->heap, bytes + 17, (usize) length - 17);
            MalString *key;
            CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &key));
            // Force the hash-collision boundary independently of FNV preimage search.
            key->hash = 0x6d616c696761746f;
            key->hash_valid = true;
            MalShape *shape = mal_shape_add_property(root, mal_key_from_value(mal_value_from_string(key)), 7);
            if (pass == 0) shapes[i] = shape;
            else CHECK(shape == shapes[i]);
            if (i > 0) CHECK(shape != shapes[i - 1]);
        }
        mal_gc_collect(vm);
    }
    return true;
}

static bool leaf_cache_survives_materialization_and_collection(MalVm *vm) {
    MalStringLeafReadCache cache = {0};
    MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    for (usize pass = 0; pass < 32; pass++) {
        for (usize i = 0; i < countof(roots); i++) roots[i] = MAL_VALUE_UNDEFINED;
        mal_gc_collect(vm);
        c16 units[128];
        for (usize i = 0; i < countof(units); i++) units[i] = (c16) ('a' + (i + pass) % 23);
        units[127] = 0x100;
        roots[0] = mal_value_from_string(mal_string_new_copy(&vm->heap, units, 64));
        roots[1] = mal_value_from_string(mal_string_new_copy(&vm->heap, units + 64, 64));
        MalString *source;
        CHECK(mal_string_new_cons_checked(&vm->heap,
            mal_value_to_string(roots[0]), mal_value_to_string(roots[1]), &source));
        roots[2] = mal_value_from_string(source);
        for (usize i = 0; i < countof(units); i++) {
            if (i == 4) mal_string_code_units(mal_value_to_string(roots[0]));
            if (i == 20) mal_gc_collect(vm);
            if (i == 48) {
                mal_string_code_units(source);
                roots[0] = roots[1] = MAL_VALUE_UNDEFINED;
                mal_gc_collect(vm);
            }
            CHECK(mal_value_to_i32(mal_builtin_string_char_code_at_cached_in_bounds(
                vm, &cache, roots[2], i)) == units[i]);
        }
    }
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    mal_perf_stats_init();
#if MAL_PERF_STATS
    if (!mal_perf_stats_enabled) {
        fputs("string-rope-followups requires MAL_PERF_STATS=1\n", stderr);
        return 1;
    }
#endif
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = short_chains_reuse_their_intermediate(&vm)
        && unit_appends_keep_bounded_height(&vm);
    for (usize construction = 0; construction < 4 && passed; construction++) {
        passed = traversal_and_balancing(&vm, 257, construction)
            && traversal_and_balancing(&vm, 1024, construction);
    }
    passed = passed && cached_append_hash_and_terminal_weight(&vm)
        && alternating_sides_of_a_large_leaf(&vm)
        && rope_shape_keys_share_and_survive_collection(&vm, 1024)
        && full_hash_collisions_preserve_key_identity(&vm)
        && leaf_cache_survives_materialization_and_collection(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("string-rope-followups PASS");
    return 0;
}
