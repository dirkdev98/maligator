#include <stdio.h>
#include <string.h>

#include "builtin_json.h"
#include "builtin_string.h"
#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"
#include "text_buffer.h"
#include "value.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool physical_encodings_have_equal_content(MalVm *vm) {
    c16 units[256];
    for (usize i = 0; i < countof(units); i++) units[i] = (c16) i;
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    MalString *compact = mal_string_new_copy(&vm->heap, units, countof(units));
    CHECK(compact->latin1 && compact->storage == MAL_STRING_STORAGE_OWNED);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes - raw_before == mal_heap_allocation_charge(countof(units)));
    MalString *wide = mal_string_new_external(&vm->heap, units, countof(units));
    CHECK(!wide->latin1);
    CHECK(mal_string_equals(compact, wide) && mal_string_equals(wide, compact));
    CHECK(mal_string_compare(compact, wide) == 0 && mal_string_compare(wide, compact) == 0);
    u64 expected_hash = mal_string_hash_code_units(units, countof(units));
    CHECK(mal_string_hash(compact) == expected_hash && mal_string_hash(wide) == expected_hash);
    CHECK(compact->latin1 && compact->hash_valid && wide->hash_valid);
    for (usize i = 0; i < countof(units); i++) CHECK(mal_string_code_unit_at(compact, i) == i);

    const u8 inline_units[] = {0, 0x7f, 0x80, 0xff, 'a', 'b', 'c', 'd'};
    MalString *inline_compact = mal_string_new_latin1_copy(&vm->heap, inline_units, countof(inline_units));
    CHECK(inline_compact->latin1 && inline_compact->storage == MAL_STRING_STORAGE_INLINE);
    const c16 wide_units[] = {0, 0x7f, 0x80, 0x100, 'a', 'b', 'c', 'd'};
    MalString *inline_wide = mal_string_new_copy(&vm->heap, wide_units, countof(wide_units));
    CHECK(!inline_wide->latin1 && inline_wide->storage == MAL_STRING_STORAGE_INLINE);
    CHECK(!mal_string_equals(inline_compact, inline_wide));
    CHECK(mal_string_compare(inline_compact, inline_wide) < 0);
    CHECK(mal_string_compare(inline_wide, inline_compact) > 0);
    return true;
}

static bool inline_capacity_and_eight_unit_cache(MalVm *vm) {
    u8 latin1[17];
    c16 utf16[9];
    c16 narrow_utf16[8];
    for (usize i = 0; i < countof(latin1); i++) latin1[i] = (u8) (0x80 + i);
    for (usize i = 0; i < countof(utf16); i++) utf16[i] = (c16) (0x100 + i);
    for (usize i = 0; i < countof(narrow_utf16); i++) narrow_utf16[i] = latin1[i];
    utf16[7] = 0xd800;
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    MalString *compact = mal_string_new_latin1_copy(&vm->heap, latin1, 16);
    MalString *wide = mal_string_new_copy(&vm->heap, utf16, 8);
    CHECK(compact->storage == MAL_STRING_STORAGE_INLINE && compact->latin1);
    CHECK(wide->storage == MAL_STRING_STORAGE_INLINE && !wide->latin1);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);
    for (usize i = 0; i < 16; i++) CHECK(mal_string_code_unit_at(compact, i) == latin1[i]);
    for (usize i = 0; i < 8; i++) CHECK(mal_string_code_unit_at(wide, i) == utf16[i]);
    CHECK(mal_string_new_copy(&vm->heap, utf16, 8) == wide);
    MalString *cached = mal_string_new_latin1_copy(&vm->heap, latin1, 8);
    CHECK(cached->hash_valid && mal_string_new_copy(&vm->heap, narrow_utf16, 8) == cached);
    CHECK(mal_string_hash(cached) == mal_string_hash_code_units(narrow_utf16, 8));

    compact = mal_string_new_latin1_copy(&vm->heap, latin1, 17);
    wide = mal_string_new_copy(&vm->heap, utf16, 9);
    CHECK(compact->storage == MAL_STRING_STORAGE_OWNED && compact->latin1);
    CHECK(wide->storage == MAL_STRING_STORAGE_OWNED && !wide->latin1);
    for (usize i = 0; i < 17; i++) CHECK(mal_string_code_unit_at(compact, i) == latin1[i]);
    for (usize i = 0; i < 9; i++) CHECK(mal_string_code_unit_at(wide, i) == utf16[i]);
    return true;
}

static bool ropes_stream_and_cross_leaf_slices_copy(MalVm *vm) {
    u8 left_units[128];
    c16 right_units[128];
    c16 expected[256];
    for (usize i = 0; i < countof(left_units); i++) {
        left_units[i] = (u8) i;
        right_units[i] = (c16) (i + 128);
        expected[i] = left_units[i];
        expected[i + 128] = right_units[i];
    }
    MalString *left = mal_string_new_latin1_copy(&vm->heap, left_units, countof(left_units));
    MalString *right = mal_string_new_external(&vm->heap, right_units, countof(right_units));
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    MalStringSegment segment;
    CHECK(mal_string_try_get_segment(rope, 10, 16, &segment));
    CHECK(segment.latin1 && segment.length == 16 && segment.latin1_units == left->latin1_units + 10);
    CHECK(!mal_string_try_get_segment(rope, 120, 16, &segment));
    CHECK(segment.latin1 && segment.length == 16 && segment.latin1_units == left->latin1_units + 10);
    CHECK(mal_string_try_get_segment(rope, 136, 16, &segment));
    CHECK(!segment.latin1 && segment.utf16_units == right_units + 8);
    CHECK(mal_string_try_get_segment(rope, rope->length, 0, &segment));
    CHECK(segment.length == 0 && segment.latin1_units != nullptr);
    MalString *flat = mal_string_new_copy(&vm->heap, expected, countof(expected));
    CHECK(mal_string_hash(rope) == mal_string_hash(flat));
    CHECK(mal_string_equals(rope, flat) && mal_string_compare(rope, flat) == 0);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && left->latin1 && !right->latin1);
    CHECK(mal_string_new_slice(&vm->heap, rope, 0, rope->length) == rope);
    CHECK(mal_string_new_slice(&vm->heap, rope, 0, left->length) == left);
    CHECK(mal_string_new_slice(&vm->heap, rope, left->length, right->length) == right);

    MalString *slice = mal_string_new_slice(&vm->heap, rope, 32, 192);
    CHECK(slice->storage == MAL_STRING_STORAGE_OWNED && slice->latin1);
    u64 expected_hash = mal_string_hash_code_units(expected + 32, 192);
    CHECK(mal_string_hash(slice) == expected_hash && slice->hash_valid);
    CHECK(mal_string_hash(slice) == expected_hash && slice->hash == expected_hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, rope, 48, 160);
    usize offset = 0;
    usize segments = 0;
    while (mal_string_iterator_next(&iterator, &segment)) {
        CHECK(segment.latin1 == (segments == 0));
        for (usize i = 0; i < segment.length; i++) {
            CHECK(mal_string_segment_code_unit_at(&segment, i) == expected[48 + offset + i]);
        }
        offset += segment.length;
        segments++;
    }
    mal_string_iterator_dispose(&iterator);
    CHECK(offset == 160 && segments == 2);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && left->latin1);

    MalValue roots[] = {mal_value_from_string(rope), mal_value_from_string(slice)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    const c16 *flattened = mal_string_code_units(rope);
    CHECK(rope->storage == MAL_STRING_STORAGE_OWNED && !rope->latin1);
    CHECK(memcmp(flattened, expected, sizeof(expected)) == 0);
    const c16 *slice_units = mal_string_code_units(slice);
    CHECK(memcmp(slice_units, expected + 32, 192 * sizeof(c16)) == 0);
    CHECK(mal_string_try_get_segment(slice, 5, 16, &segment));
    CHECK(!segment.latin1 && segment.utf16_units == slice_units + 5);
    mal_gc_collect(vm);
    for (usize i = 0; i < slice->length; i++) CHECK(mal_string_code_unit_at(slice, i) == expected[32 + i]);
    CHECK(mal_string_hash(slice) == expected_hash);
    mal_gc_unroot(&span);
    return true;
}

static bool direct_search_accepts_rope_receivers(MalVm *vm) {
    MalString *left = mal_string_new_ascii(&vm->heap, "abcdefghX", 9);
    MalString *right = mal_string_new_ascii(&vm->heap, "Yijklmnop", 9);
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    MalString *cross_leaf = mal_string_new_ascii(&vm->heap, "XY", 2);
    MalString *single_leaf = mal_string_new_ascii(&vm->heap, "Yij", 3);
    MalString *last_position = mal_string_new_ascii(&vm->heap, "op", 2);
    MalValue result;
    CHECK(mal_builtin_string_search_direct(mal_value_from_string(rope),
        mal_value_from_string(cross_leaf), 0, MAL_STRING_SEARCH_INDEX_OF, &result));
    CHECK(mal_value_to_i32(result) == 8);
    CHECK(mal_builtin_string_search_direct(mal_value_from_string(rope),
        mal_value_from_string(single_leaf), 0, MAL_STRING_SEARCH_INDEX_OF, &result));
    CHECK(mal_value_to_i32(result) == 9);
    CHECK(mal_builtin_string_search_direct(mal_value_from_string(rope),
        mal_value_from_string(last_position), 0, MAL_STRING_SEARCH_INDEX_OF, &result));
    CHECK(mal_value_to_i32(result) == 16);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    return true;
}

static bool utf16_search_rejects_byte_aliases(void) {
    c16 units[256];
    for (usize i = 0; i < 64; i++) units[i] = 0x7400;
    units[64] = 't';
    for (usize i = 65; i < 128; i++) units[i] = 0x0001;
    units[128] = 0x0100;
    for (usize i = 129; i < 192; i++) units[i] = 0x4142;
    units[192] = 0x4141;
    for (usize i = 193; i < 240; i++) units[i] = 0x1234;
    units[240] = 0;
    units[241] = 't';
    units[242] = 0x0100;
    units[243] = 0x4141;
    for (usize i = 244; i < 255; i++) units[i] = 0xffff;
    units[255] = 0x4141;
    const c16 needles[] = {'t', 0x0100, 0x4141, 0, 0xffff, 0x7400, 1, 0x1234, 0xdead};
    const usize starts[] = {0, 1, 60, 63, 64, 65, 67, 124, 127, 128, 129, 130,
        190, 191, 192, 193, 237, 240, 241, 243, 244, 254, 255, 256, 257};
    MalString haystack;
    mal_string_init_external(&haystack, units, countof(units));
    for (usize n = 0; n < countof(needles); n++) {
        MalString needle;
        mal_string_init_external(&needle, needles + n, 1);
        for (usize s = 0; s < countof(starts); s++) {
            i32 expected = -1;
            for (usize i = starts[s]; i < countof(units); i++) {
                if (units[i] == needles[n]) {
                    expected = (i32) i;
                    break;
                }
            }
            MalValue actual;
            CHECK(mal_builtin_string_search_direct(mal_value_from_string(&haystack),
                mal_value_from_string(&needle), (f64) starts[s], MAL_STRING_SEARCH_INDEX_OF, &actual));
            CHECK(mal_value_to_i32(actual) == expected);
        }
    }
    CHECK(haystack.storage == MAL_STRING_STORAGE_EXTERNAL && !haystack.latin1);
    return true;
}

static bool cached_rope_hashes_preserve_segments_and_slices(MalVm *vm) {
    c16 units[40];
    for (usize i = 0; i < countof(units); i++) units[i] = (c16) (i + 160);
    MalString *left = mal_string_new_copy(&vm->heap, units, 20);
    MalString *right = mal_string_new_external(&vm->heap, units + 20, 20);
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    u64 hash = mal_string_hash_code_units(units, countof(units));
    usize raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    CHECK(mal_string_hash(rope) == hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && rope->hash_valid && rope->hash == hash);
    MalString *slice = mal_string_new_slice(&vm->heap, rope, 7, 26);
    CHECK(slice->storage == MAL_STRING_STORAGE_OWNED && slice->latin1);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes - raw_before == mal_heap_allocation_charge(26));
    raw_before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    u64 slice_hash = mal_string_hash_code_units(units + 7, 26);
    CHECK(mal_string_hash(slice) == slice_hash && slice->hash_valid);
    CHECK(mal_string_hash(rope) == hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && rope->left == left && rope->right == right);
    CHECK(mal_string_hash(rope) == hash && mal_string_hash(slice) == slice_hash);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == raw_before);
    MalValue roots[] = {mal_value_from_string(rope), mal_value_from_string(slice)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(vm);
    for (usize i = 0; i < slice->length; i++) CHECK(mal_string_code_unit_at(slice, i) == units[7 + i]);
    CHECK(mal_string_hash(slice) == slice_hash && mal_string_hash(rope) == hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && rope->left == left && rope->right == right);
    const c16 *flattened = mal_string_code_units(rope);
    CHECK(memcmp(flattened, units, sizeof(units)) == 0);
    CHECK(rope->hash_valid && rope->hash == hash && mal_string_hash(rope) == hash);
    CHECK(memcmp(mal_string_code_units(slice), units + 7, 26 * sizeof(c16)) == 0);
    CHECK(mal_string_hash(slice) == slice_hash);
    mal_gc_unroot(&span);

    units[21] = 0x100;
    units[27] = 0xd800;
    units[35] = 0xdc00;
    left = mal_string_new_copy(&vm->heap, units, 20);
    right = mal_string_new_copy(&vm->heap, units + 20, 20);
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    hash = mal_string_hash_code_units(units, countof(units));
    CHECK(mal_string_hash(rope) == hash && rope->storage == MAL_STRING_STORAGE_CONS);
    CHECK(mal_string_hash(rope) == hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && !rope->latin1 && rope->hash_valid);
    c16 copy[countof(units)];
    mal_string_copy_range_to(rope, 0, rope->length, copy);
    CHECK(memcmp(copy, units, sizeof(units)) == 0 && rope->storage == MAL_STRING_STORAGE_CONS);
    return true;
}

static bool dependent_offsets_survive_parent_widening(MalVm *vm) {
    u8 bytes[256];
    for (usize i = 0; i < countof(bytes); i++) bytes[i] = (u8) i;
    MalString *parent = mal_string_new_latin1_copy(&vm->heap, bytes, countof(bytes));
    MalString *slice = mal_string_new_slice(&vm->heap, parent, 13, 64);
    CHECK(slice->storage == MAL_STRING_STORAGE_DEPENDENT && slice->latin1);
    MalString *nested = mal_string_new_slice(&vm->heap, slice, 7, 32);
    CHECK(nested->storage == MAL_STRING_STORAGE_DEPENDENT);
    CHECK(nested->parent == parent && nested->slice_offset == 20);
    u64 hash = mal_string_hash(nested);
    MalValue roots[] = {mal_value_from_string(slice), mal_value_from_string(nested)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    const c16 *wide = mal_string_code_units(parent);
    CHECK(!parent->latin1 && parent->storage == MAL_STRING_STORAGE_OWNED);
    CHECK(mal_string_code_units(parent) == wide);
    CHECK(mal_string_code_units(nested) == wide + 20);
    mal_gc_collect(vm);
    for (usize i = 0; i < nested->length; i++) CHECK(mal_string_code_unit_at(nested, i) == i + 20);
    CHECK(mal_string_hash(nested) == hash && nested->hash_valid);
    mal_gc_unroot(&span);
    return true;
}

static bool deep_segment_stacks_and_retained_slices(MalVm *vm) {
    u8 units[16];
    for (usize i = 0; i < countof(units); i++) units[i] = (u8) (i + 128);
    MalString *leaf = mal_string_new_latin1_copy(&vm->heap, units, countof(units));
    MalString *rope = leaf;
    for (usize i = 0; i < 80; i++) {
        MalString *next;
        CHECK(mal_string_new_cons_checked(&vm->heap, rope, leaf, &next));
        rope = next;
    }
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, rope, 3, rope->length - 7);
    MalStringSegment segment;
    usize offset = 3;
    while (mal_string_iterator_next(&iterator, &segment)) {
        CHECK(segment.latin1);
        for (usize i = 0; i < segment.length; i++) {
            CHECK(mal_string_segment_code_unit_at(&segment, i) == units[(offset + i) % countof(units)]);
        }
        offset += segment.length;
    }
    mal_string_iterator_dispose(&iterator);
    CHECK(offset == rope->length - 4 && rope->storage == MAL_STRING_STORAGE_CONS);

    MalString *large = leaf;
    for (usize i = 0; i < 12; i++) {
        MalString *next;
        CHECK(mal_string_new_cons_checked(&vm->heap, large, large, &next));
        large = next;
    }
    MalString *subtree = mal_string_new_slice(&vm->heap, large, 256, 256);
    CHECK(subtree->storage == MAL_STRING_STORAGE_CONS && subtree->length == 256);
    MalString *narrow = mal_string_new_slice(&vm->heap, large, 7, 129);
    CHECK(narrow->latin1 && narrow->storage == MAL_STRING_STORAGE_OWNED);
    usize start = large->length / 2 - 65;
    MalString *small = mal_string_new_slice(&vm->heap, large, start, 129);
    CHECK(small->latin1 && small->storage == MAL_STRING_STORAGE_OWNED);
    CHECK(large->storage == MAL_STRING_STORAGE_CONS);
    MalValue roots[] = {mal_value_from_string(narrow), mal_value_from_string(small)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(vm);
    for (usize i = 0; i < small->length; i++) {
        CHECK(mal_string_code_unit_at(narrow, i) == units[(7 + i) % countof(units)]);
        CHECK(mal_string_code_unit_at(small, i) == units[(start + i) % countof(units)]);
    }
    mal_gc_unroot(&span);
    return true;
}

static c16 sliding_window_unit(usize index, bool wide) {
    if (!wide) return (c16) (index % 256);
    if (index % 16 == 0) return 0xd800;
    if (index % 16 == 1) return 0xdc00;
    if (index % 16 == 7) return 0xdfff;
    if (index % 16 == 12) return 0xd834;
    return (c16) (0x100 + index % 37);
}

static bool sliding_slices_release_previous_windows(MalVm *vm, usize length, bool wide) {
    c16 initial[4097];
    CHECK(length <= countof(initial) && length > MAL_STRING_INLINE_LATIN1_CODE_UNITS);
    for (usize i = 0; i < length; i++) initial[i] = sliding_window_unit(i, wide);
    MalValue roots[3] = {
        mal_value_from_string(mal_string_new_copy(&vm->heap, initial, length)),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    usize start = 0;
    for (usize iteration = 0; iteration < 32; iteration++) {
        c16 suffix_units[16];
        for (usize i = 0; i < countof(suffix_units); i++) {
            suffix_units[i] = sliding_window_unit(start + length + i, wide);
        }
        MalString *previous = mal_value_to_string(roots[0]);
        MalString *suffix = mal_string_new_copy(&vm->heap, suffix_units, countof(suffix_units));
        roots[1] = mal_value_from_string(suffix);
        MalString *rope;
        CHECK(mal_string_new_cons_checked(&vm->heap, previous, suffix, &rope));
        roots[2] = mal_value_from_string(rope);
        MalString *window = mal_string_new_slice(&vm->heap, rope, countof(suffix_units), length);
        CHECK(window->storage == MAL_STRING_STORAGE_OWNED && window->latin1 == !wide);
        CHECK(rope->storage == MAL_STRING_STORAGE_CONS && rope->left == previous && rope->right == suffix);
        roots[0] = mal_value_from_string(window);
        roots[1] = roots[2] = mal_value_new_undefined();
        start += countof(suffix_units);
        if (iteration % 8 == 7) mal_gc_collect(vm);
        CHECK(window->length == length && window->storage == MAL_STRING_STORAGE_OWNED);
        for (usize i = 0; i < length; i++) {
            CHECK(mal_string_code_unit_at(window, i) == sliding_window_unit(start + i, wide));
        }
    }
    mal_gc_unroot(&span);
    return true;
}

static bool compact_parse_lookup_build_serialize(MalVm *vm) {
    const u8 source_units[] = "{\"caf\xe9\xff-record-long-key\":\"caf\xe9\xff-payload-long-value\"}";
    const u8 path_units[] = "prefix:caf\xe9\xff-record-long-key:suffix";
    MalValue roots[7];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalString *source = mal_string_new_latin1_copy(&vm->heap, source_units, sizeof(source_units) - 1);
    roots[0] = mal_value_from_string(source);
    roots[1] = mal_builtin_json_parse_intrinsic(vm, roots[0]);
    CHECK(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_object(roots[1]));
    MalString *path = mal_string_new_latin1_copy(&vm->heap, path_units, sizeof(path_units) - 1);
    roots[2] = mal_value_from_string(path);
    MalString *key = mal_string_new_slice(&vm->heap, path, 7, path->length - 14);
    roots[3] = mal_value_from_string(key);
    MalKey property_key = mal_key_from_value(roots[3]);
    MalObject *record = mal_value_to_object(roots[1]);
    MalPropertyLookup lookup = mal_object_get_own(record, property_key);
    CHECK(lookup.present && mal_value_is_string(lookup.desc.value));
    roots[6] = lookup.desc.value;
    MalString *value = mal_value_to_string(lookup.desc.value);
    CHECK(source->latin1 && path->latin1 && key->latin1 && value->latin1);

    MalTextBuffer buffer = {.heap = &vm->heap};
    CHECK(mal_text_buffer_append_string(&buffer, value) == MAL_TEXT_BUFFER_OK);
    CHECK(mal_text_buffer_push(&buffer, '/') == MAL_TEXT_BUFFER_OK);
    CHECK(mal_text_buffer_append_string(&buffer, key) == MAL_TEXT_BUFFER_OK);
    MalString *built = mal_text_buffer_finish(&vm->heap, &buffer);
    roots[4] = mal_value_from_string(built);
    CHECK(built->latin1 && mal_object_set(record, property_key, roots[4]));
    MalValue json = vm->intrinsics[MAL_INTRINSIC_JSON];
    MalKey stringify_key = mal_key_from_value(mal_value_from_string(mal_intrinsic_ascii(vm, "stringify")));
    MalPropertyLookup stringify = mal_object_get_own(mal_value_to_object(json), stringify_key);
    CHECK(stringify.present);
    MalCompletion serialized = mal_vm_call_value(vm, stringify.desc.value, json, &roots[1], 1);
    CHECK(serialized.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(serialized.value));
    roots[5] = serialized.value;
    MalString *output = mal_value_to_string(roots[5]);
    CHECK(source->latin1 && key->latin1 && value->latin1 && built->latin1 && output->latin1);
    const u8 expected[] = "{\"caf\xe9\xff-record-long-key\":\"caf\xe9\xff-payload-long-value/caf\xe9\xff-record-long-key\"}";
    CHECK(output->length == sizeof(expected) - 1);
    mal_gc_collect(vm);
    for (usize i = 0; i < output->length; i++) CHECK(mal_string_code_unit_at(output, i) == expected[i]);
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = physical_encodings_have_equal_content(&vm)
        && inline_capacity_and_eight_unit_cache(&vm)
        && ropes_stream_and_cross_leaf_slices_copy(&vm)
        && direct_search_accepts_rope_receivers(&vm)
        && utf16_search_rejects_byte_aliases()
        && cached_rope_hashes_preserve_segments_and_slices(&vm)
        && dependent_offsets_survive_parent_widening(&vm)
        && deep_segment_stacks_and_retained_slices(&vm)
        && sliding_slices_release_previous_windows(&vm, 17, false)
        && sliding_slices_release_previous_windows(&vm, 17, true)
        && sliding_slices_release_previous_windows(&vm, 4097, false)
        && sliding_slices_release_previous_windows(&vm, 4097, true)
        && compact_parse_lookup_build_serialize(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("encoding-aware-strings PASS");
    return 0;
}
