#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_json.h"
#include "builtin_regexp.h"
#include "builtin_string.h"
#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"
#include "text_buffer.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

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
    CHECK(memcmp(mal_string_code_units(cached), narrow_utf16, sizeof(narrow_utf16)) == 0);
    CHECK(mal_string_new_latin1_copy(&vm->heap, latin1, 8) == cached);
    u8 *owned = mal_heap_alloc_raw(&vm->heap, 8);
    memcpy(owned, latin1, 8);
    CHECK(mal_string_new_latin1_owned(&vm->heap, owned, 8) == cached);

    compact = mal_string_new_latin1_copy(&vm->heap, latin1, 17);
    wide = mal_string_new_copy(&vm->heap, utf16, 9);
    CHECK(compact->storage == MAL_STRING_STORAGE_OWNED && compact->latin1);
    CHECK(wide->storage == MAL_STRING_STORAGE_OWNED && !wide->latin1);
    for (usize i = 0; i < 17; i++) CHECK(mal_string_code_unit_at(compact, i) == latin1[i]);
    for (usize i = 0; i < 9; i++) CHECK(mal_string_code_unit_at(wide, i) == utf16[i]);
    return true;
}

static bool numeric_ranges_preserve_storage(MalVm *vm) {
    const struct {
        const c16 *units;
        usize length;
        f64 expected;
    } cases[] = {
        {u"\u00a0-0\u00a0", 4, -0.0},
        {u"9007199254740993", 16, 9007199254740992.0},
        {u"1e400", 5, INFINITY},
        {u"-Infinity", 9, -INFINITY},
        {u"0x1f", 4, 31},
        {u"0o71", 4, 57},
        {u"0b101", 5, 5},
        {u"-0x1f", 5, NAN},
        {u"1\0" u"2", 3, NAN},
        {u"1 2", 3, NAN},
        {u"\u00e9", 1, NAN},
        {u"\u2028 3.5\u2029", 6, 3.5},
        {u"\u00a0\u00a0", 2, 0},
        {u"", 0, 0},
    };
    for (usize i = 0; i < countof(cases); i++) {
        c16 units[48];
        usize length = 32 + cases[i].length;
        for (usize j = 0; j < length; j++) units[j] = 'x';
        memcpy(units + 16, cases[i].units, cases[i].length * sizeof(c16));
        MalString *flat = mal_string_new_copy(&vm->heap, units, length);
        MalString *wide = mal_string_new_external(&vm->heap, units, length);
        usize cut = 16 + cases[i].length / 2;
        MalString *left = mal_string_new_copy(&vm->heap, units, cut);
        MalString *right = mal_string_new_copy(&vm->heap, units + cut, length - cut);
        MalString *rope;
        CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
        MalString *strings[] = {flat, wide, rope};
        for (usize j = 0; j < countof(strings); j++) {
            MalString *string = strings[j];
            MalStringStorage storage = string->storage;
            bool latin1 = string->latin1;
            f64 actual = mal_ops_number_as_f64(
                mal_ops_string_range_to_number(string, 16, cases[i].length));
            CHECK(isnan(cases[i].expected) ? isnan(actual) : actual == cases[i].expected);
            if (actual == 0) CHECK(signbit(actual) == signbit(cases[i].expected));
            CHECK(string->storage == storage && string->latin1 == latin1);
        }
    }
    return true;
}

static bool short_case_mapping_preserves_utf16(MalVm *vm) {
    const c16 source[] = u"Abc\0xyzXYZ123!?_";
    const c16 upper[] = u"ABC\0XYZXYZ123!?_";
    const c16 lower[] = u"abc\0xyzxyz123!?_";
    for (usize length = 0; length < countof(source); length++) {
        MalString *strings[] = {
            mal_string_new_copy(&vm->heap, source, length),
            mal_string_new_external(&vm->heap, source, length),
        };
        for (usize i = 0; i < countof(strings); i++) {
            MalString *up = mal_value_to_string(mal_builtin_string_case_known(
                vm, strings[i], true, MAL_UNICODE_LOCALE_ROOT));
            MalString *down = mal_value_to_string(mal_builtin_string_case_known(
                vm, strings[i], false, MAL_UNICODE_LOCALE_ROOT));
            CHECK(up->length == length && down->length == length);
            for (usize j = 0; j < length; j++) {
                CHECK(mal_string_code_unit_at(up, j) == upper[j]);
                CHECK(mal_string_code_unit_at(down, j) == lower[j]);
            }
        }
    }
    const c16 non_ascii[] = {'a', 0xdf, 0xd800};
    const c16 expected[] = {'A', 'S', 'S', 0xd800};
    MalString *string = mal_string_new_copy(&vm->heap, non_ascii, countof(non_ascii));
    MalString *mapped = mal_value_to_string(mal_builtin_string_case_known(
        vm, string, true, MAL_UNICODE_LOCALE_ROOT));
    CHECK(mapped->length == countof(expected));
    for (usize i = 0; i < countof(expected); i++) {
        CHECK(mal_string_code_unit_at(mapped, i) == expected[i]);
    }
    return true;
}

static bool tiny_cache_collisions_preserve_content(MalVm *vm) {
    const u8 original[] = {0, 0xff, 0x7f, 'a', 'b', 'c', 'd', 'e'};
    for (usize length = 0; length <= countof(original); length++) {
        MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
        MalRootSpan span;
        mal_gc_root(&span, roots, countof(roots));
        u8 *exact = malloc(length == 0 ? 1 : length);
        CHECK(exact != nullptr);
        memcpy(exact, original, length);
        roots[0] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, exact, length));
        free(exact);
        if (length >= 2) {
            c16 collision[8];
            for (usize i = 0; i < length; i++) collision[i] = original[i];
            collision[length >= 6 ? length - 2 : 0] ^= 1;
            usize slot = mal_string_hash(mal_value_to_string(roots[0])) & (MAL_TINY_STRING_CACHE_CAPACITY - 1);
            bool found = false;
            for (usize last = 0; last <= 0xff; last++) {
                collision[length - 1] = (c16) last;
                if ((mal_string_hash_code_units(collision, length) & (MAL_TINY_STRING_CACHE_CAPACITY - 1)) == slot) {
                    found = true;
                    break;
                }
            }
            CHECK(found);
            u8 bytes[8];
            for (usize i = 0; i < length; i++) bytes[i] = (u8) collision[i];
            roots[1] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, bytes, length));
            CHECK(!mal_string_equals(mal_value_to_string(roots[0]), mal_value_to_string(roots[1])));
        }
        MalString *reloaded = mal_string_new_latin1_copy(&vm->heap, original, length);
        roots[2] = mal_value_from_string(reloaded);
        CHECK(mal_string_new_latin1_copy(&vm->heap, original, length) == reloaded);
        mal_string_code_units(reloaded);
        CHECK(mal_string_new_latin1_copy(&vm->heap, original, length) == reloaded);
        mal_gc_collect(vm);
        for (usize i = 0; i < length; i++) CHECK(mal_string_code_unit_at(reloaded, i) == original[i]);
        CHECK(mal_string_equals(mal_value_to_string(roots[0]), reloaded));
        mal_gc_unroot(&span);
    }
    return true;
}

static bool short_concatenations_preserve_code_units(MalVm *vm) {
    u8 bytes[16];
    c16 units[16];
    for (usize i = 0; i < countof(bytes); i++) {
        bytes[i] = i == 0 ? 0 : (u8) (0xf0 + i);
        units[i] = bytes[i];
    }
    for (usize split = 1; split < countof(bytes); split++) {
        MalString *left = mal_string_new_latin1_copy(&vm->heap, bytes, split);
        MalString *right = mal_string_new_latin1_copy(&vm->heap, bytes + split, countof(bytes) - split);
        MalString *joined;
        CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &joined));
        CHECK(mal_string_hash(joined) == mal_string_hash_code_units(units, countof(units)));
        for (usize i = 0; i < countof(units); i++) CHECK(mal_string_code_unit_at(joined, i) == units[i]);
        mal_string_code_units(left);
        CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &joined));
        for (usize i = 0; i < countof(units); i++) CHECK(mal_string_code_unit_at(joined, i) == units[i]);
    }
    units[7] = 0xd800;
    units[8] = 0xdc00;
    units[15] = 0xdcff;
    MalString *left = mal_string_new_copy(&vm->heap, units, 8);
    MalString *right = mal_string_new_copy(&vm->heap, units + 8, 8);
    MalString *joined;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &joined));
    CHECK(mal_string_hash(joined) == mal_string_hash_code_units(units, countof(units)));
    for (usize i = 0; i < countof(units); i++) CHECK(mal_string_code_unit_at(joined, i) == units[i]);
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

static MalCompletion call_named(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 count
) {
    MalValue method;
    if (!mal_vm_get_property(vm, receiver, mal_intrinsic_string_key(vm, name), &method)) {
        return vm->completion;
    }
    return mal_vm_call_value(vm, method, receiver, args, count);
}

static bool string_equals_latin1(const MalString *string, const char *expected) {
    usize length = strlen(expected);
    if (string->length != length) return false;
    for (usize i = 0; i < length; i++) {
        if (mal_string_code_unit_at((MalString *) string, i) != (u8) expected[i]) return false;
    }
    return true;
}

static MalValue latin1_value(MalVm *vm, const char *units) {
    return mal_value_from_string(
        mal_string_new_latin1_copy(&vm->heap, (const u8 *) units, strlen(units)));
}

static MalValue latin1_regexp(MalVm *vm, const char *pattern, const char *flags) {
    MalValue strings[2] = {latin1_value(vm, pattern), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, strings, countof(strings));
    strings[1] = latin1_value(vm, flags);
    MalValue regexp = mal_regexp_create(
        vm, mal_value_to_string(strings[0]), mal_value_to_string(strings[1]));
    mal_gc_unroot(&span);
    return regexp;
}

static bool regexp_subjects_stay_compact(MalVm *vm) {
    MalValue roots[6];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));

    u8 long_units[320];
    memset(long_units, 'a', sizeof(long_units));
    memcpy(long_units + 200, "id=42;", 6);
    memcpy(long_units + 300, "id=7;", 5);
    roots[0] = mal_value_from_string(
        mal_string_new_latin1_copy(&vm->heap, long_units, sizeof(long_units)));
    roots[1] = latin1_regexp(vm, "id=(\\d+);", "g");
    roots[2] = latin1_value(vm, "<$1:$$:$&>");
    MalCompletion result = call_named(vm, roots[0], "replace", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    roots[5] = result.value;
    MalString *replaced = mal_value_to_string(result.value);
    CHECK(mal_value_to_string(roots[0])->latin1 && replaced->latin1);
    CHECK(replaced->length == sizeof(long_units) - 11 + 13 + 11);
    CHECK(mal_string_code_unit_at(replaced, 199) == 'a' && mal_string_code_unit_at(replaced, 200) == '<');
    MalString *first = mal_string_new_slice(&vm->heap, replaced, 200, 13);
    CHECK(string_equals_latin1(first, "<42:$:id=42;>"));

    roots[0] = latin1_value(vm, "caf\xe9 x=1, caf\xe8 x=2");
    roots[1] = latin1_regexp(vm, "caf(.) x=(\\d)", "g");
    roots[2] = latin1_value(vm, "$2$1");
    result = call_named(vm, roots[0], "replace", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(roots[0])->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "1\xe9, 2\xe8"));

    roots[0] = latin1_value(vm, "un caf\xe9");
    roots[1] = latin1_regexp(vm, "CAF\xc9", "i");
    result = call_named(vm, roots[1], "exec", &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_object(result.value));
    roots[3] = result.value;
    MalValue index;
    CHECK(mal_vm_get_property(vm, roots[3], mal_intrinsic_string_key(vm, "index"), &index));
    CHECK(mal_ops_is_number(index) && mal_ops_number_as_f64(index) == 3);
    CHECK(mal_value_to_string(roots[0])->latin1);

    u8 halves[2][64];
    memset(halves[0], 'a', sizeof(halves[0]));
    memset(halves[1], 'c', sizeof(halves[1]));
    halves[0][63] = 'b';
    halves[1][0] = 'b';
    roots[3] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, halves[0], 64));
    roots[4] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, halves[1], 64));
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, mal_value_to_string(roots[3]),
        mal_value_to_string(roots[4]), &rope));
    roots[0] = mal_value_from_string(rope);
    roots[1] = latin1_regexp(vm, "b+", "");
    result = call_named(vm, roots[1], "exec", &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_object(result.value));
    roots[5] = result.value;
    CHECK(mal_vm_get_property(vm, roots[5], mal_intrinsic_string_key(vm, "index"), &index));
    CHECK(mal_ops_number_as_f64(index) == 63);
    CHECK(rope->storage == MAL_STRING_STORAGE_OWNED && rope->latin1);

    roots[0] = latin1_value(vm, "ab12cd");
    roots[1] = latin1_regexp(vm, "(?<num>[0-9]+)", "");
    roots[2] = latin1_value(vm, "[$`|$'|$<num>|$9|$<x]");
    result = call_named(vm, roots[0], "replace", &roots[1], 2);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "ab[ab|cd|12|$9|$<x]cd"));

    MalValue escape;
    CHECK(mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR],
        mal_intrinsic_string_key(vm, "escape"), &escape));
    roots[0] = latin1_value(vm, "a.b-c\xe9 d");
    result = mal_vm_call_value(vm, escape, mal_value_new_undefined(), &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(roots[0])->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "\\x61\\.b\\x2dc\xe9\\x20d"));

    mal_gc_collect(vm);
    mal_gc_unroot(&span);
    return true;
}

static bool string_is_utf16_units(const MalString *string, const c16 *expected, usize length) {
    if (string->length != length) return false;
    for (usize i = 0; i < length; i++) {
        if (mal_string_code_unit_at((MalString *) string, i) != expected[i]) return false;
    }
    return true;
}

static bool latin1_case_and_normalization_stay_compact(MalVm *vm) {
    MalValue roots[4];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));

    roots[0] = latin1_value(vm, "Caf\xe9 \xd1o\xf1o \xd7\xf7 \xaa\xba long enough");
    MalCompletion result = call_named(vm, roots[0], "toUpperCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "CAF\xc9 \xd1O\xd1O \xd7\xf7 \xaa\xba LONG ENOUGH"));
    roots[1] = result.value;
    result = call_named(vm, roots[1], "toLowerCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "caf\xe9 \xf1o\xf1o \xd7\xf7 \xaa\xba long enough"));
    CHECK(mal_value_to_string(roots[0])->latin1 && mal_value_to_string(roots[1])->latin1);

    roots[0] = latin1_value(vm, "stra\xdf" "e \xb5 \xff and more text");
    result = call_named(vm, roots[0], "toUpperCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    const c16 expanded[] = {'S', 'T', 'R', 'A', 'S', 'S', 'E', ' ', 0x39c, ' ', 0x178,
        ' ', 'A', 'N', 'D', ' ', 'M', 'O', 'R', 'E', ' ', 'T', 'E', 'X', 'T'};
    CHECK(string_is_utf16_units(mal_value_to_string(result.value), expanded, countof(expanded)));
    CHECK(mal_value_to_string(roots[0])->latin1);
    result = call_named(vm, roots[0], "toLowerCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == roots[0]);

    roots[0] = latin1_value(vm, "Stra\xdf" "e und Fu\xdf");
    result = call_named(vm, roots[0], "toUpperCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "STRASSE UND FUSS"));

    MalString *rope;
    roots[1] = latin1_value(vm, "first \xe9l\xe9ment, ");
    roots[2] = latin1_value(vm, "second \xc9L\xc9MENT");
    CHECK(mal_string_new_cons_checked(&vm->heap, mal_value_to_string(roots[1]),
        mal_value_to_string(roots[2]), &rope));
    roots[0] = mal_value_from_string(rope);
    result = call_named(vm, roots[0], "toLowerCase", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "first \xe9l\xe9ment, second \xe9l\xe9ment"));
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);

    roots[0] = latin1_value(vm, "na\xefve r\xe9sum\xe9 with \xa0 spacing");
    result = call_named(vm, roots[0], "normalize", nullptr, 0);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == roots[0]);
    roots[1] = latin1_value(vm, "NFD");
    result = call_named(vm, roots[0], "normalize", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    MalString *decomposed = mal_value_to_string(result.value);
    CHECK(decomposed->length == mal_value_to_string(roots[0])->length + 3);
    CHECK(mal_string_code_unit_at(decomposed, 2) == 'i' && mal_string_code_unit_at(decomposed, 3) == 0x308);
    roots[1] = latin1_value(vm, "NFKC");
    result = call_named(vm, roots[0], "normalize", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "na\xefve r\xe9sum\xe9 with   spacing"));
    CHECK(mal_value_to_string(roots[0])->latin1);

    roots[1] = mal_value_from_i32(3);
    result = call_named(vm, roots[0], "codePointAt", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && result.value == mal_value_from_i32('v'));
    CHECK(mal_value_to_string(roots[0])->latin1);

    mal_gc_collect(vm);
    mal_gc_unroot(&span);
    return true;
}

static bool uri_coding_keeps_compact_storage(MalVm *vm) {
    MalValue roots[2];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalValue encode = vm->intrinsics[MAL_INTRINSIC_ENCODE_URI_COMPONENT];
    MalValue decode = vm->intrinsics[MAL_INTRINSIC_DECODE_URI_COMPONENT];

    roots[0] = latin1_value(vm, "caf\xe9 & co/\xff");
    MalCompletion result = mal_vm_call_value(vm, encode, mal_value_new_undefined(), &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1 && mal_value_to_string(roots[0])->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value), "caf%C3%A9%20%26%20co%2F%C3%BF"));
    roots[1] = result.value;
    result = mal_vm_call_value(vm, decode, mal_value_new_undefined(), &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(mal_string_equals(mal_value_to_string(result.value), mal_value_to_string(roots[0])));

    roots[0] = latin1_value(vm, "price%20%E2%82%AC5");
    result = mal_vm_call_value(vm, decode, mal_value_new_undefined(), &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    const c16 euro[] = {'p', 'r', 'i', 'c', 'e', ' ', 0x20ac, '5'};
    CHECK(string_is_utf16_units(mal_value_to_string(result.value), euro, countof(euro)));
    CHECK(mal_value_to_string(roots[0])->latin1);

    roots[0] = latin1_value(vm, "%E9%");
    result = mal_vm_call_value(vm, decode, mal_value_new_undefined(), &roots[0], 1);
    CHECK(result.kind == MAL_COMPLETION_THROW);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    mal_gc_unroot(&span);
    return true;
}

static bool dense_joins_write_compact_results(MalVm *vm) {
    MalValue roots[4];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[0] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalArrayObject *array = mal_value_to_array_object(roots[0]);
    const char *parts[] = {"caf\xe9", "", "na\xefve-and-longer-than-inline", "x"};
    for (u32 i = 0; i < countof(parts); i++) {
        roots[1] = latin1_value(vm, parts[i]);
        CHECK(mal_array_object_store(array, mal_key_index(i), roots[1]));
    }
    CHECK(mal_array_object_store(array, mal_key_index(4), mal_value_new_null()));
    CHECK(mal_array_object_store(array, mal_key_index(5), mal_value_from_i32(-1234)));

    roots[1] = latin1_value(vm, ",");
    MalCompletion result = call_named(vm, roots[0], "join", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(mal_value_to_string(result.value)->latin1);
    CHECK(string_equals_latin1(mal_value_to_string(result.value),
        "caf\xe9,,na\xefve-and-longer-than-inline,x,,-1234"));

    roots[1] = latin1_value(vm, " | ");
    result = call_named(vm, roots[0], "join", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    CHECK(string_equals_latin1(mal_value_to_string(result.value),
        "caf\xe9 |  | na\xefve-and-longer-than-inline | x |  | -1234"));

    const c16 wide[] = {'p', 0x3c0};
    roots[2] = mal_value_from_string(mal_string_new_copy(&vm->heap, wide, countof(wide)));
    CHECK(mal_array_object_store(array, mal_key_index(1), roots[2]));
    roots[1] = latin1_value(vm, "/");
    result = call_named(vm, roots[0], "join", &roots[1], 1);
    CHECK(result.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(result.value));
    MalString *joined = mal_value_to_string(result.value);
    CHECK(!joined->latin1 && joined->length == 4 + 1 + 2 + 1 + 28 + 1 + 1 + 1 + 0 + 1 + 5);
    CHECK(mal_string_code_unit_at(joined, 3) == 0xe9 && mal_string_code_unit_at(joined, 6) == 0x3c0);
    CHECK(mal_string_code_unit_at(joined, joined->length - 5) == '-');

    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = physical_encodings_have_equal_content(&vm)
        && inline_capacity_and_eight_unit_cache(&vm)
        && tiny_cache_collisions_preserve_content(&vm)
        && numeric_ranges_preserve_storage(&vm)
        && short_case_mapping_preserves_utf16(&vm)
        && short_concatenations_preserve_code_units(&vm)
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
        && compact_parse_lookup_build_serialize(&vm)
        && regexp_subjects_stay_compact(&vm)
        && latin1_case_and_normalization_stay_compact(&vm)
        && uri_coding_keeps_compact_storage(&vm)
        && dense_joins_write_compact_results(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("encoding-aware-strings PASS");
    return 0;
}
