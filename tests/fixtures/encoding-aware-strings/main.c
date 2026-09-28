#include <stdio.h>
#include <string.h>

#include "builtin_json.h"
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
    MalString *owned_wide = mal_string_new_copy(&vm->heap, wide_units, countof(wide_units));
    CHECK(!owned_wide->latin1 && owned_wide->storage == MAL_STRING_STORAGE_OWNED);
    CHECK(!mal_string_equals(inline_compact, owned_wide));
    CHECK(mal_string_compare(inline_compact, owned_wide) < 0);
    CHECK(mal_string_compare(owned_wide, inline_compact) > 0);
    return true;
}

static bool ropes_and_slices_stream_without_materialization(MalVm *vm) {
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
    MalString *flat = mal_string_new_copy(&vm->heap, expected, countof(expected));
    CHECK(mal_string_hash(rope) == mal_string_hash(flat));
    CHECK(mal_string_equals(rope, flat) && mal_string_compare(rope, flat) == 0);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS && left->latin1 && !right->latin1);

    MalString *slice = mal_string_new_slice(&vm->heap, rope, 32, 192);
    CHECK(slice->storage == MAL_STRING_STORAGE_DEPENDENT && slice->parent == rope);
    u64 expected_hash = mal_string_hash_code_units(expected + 32, 192);
    CHECK(mal_string_hash(slice) == expected_hash && slice->hash_valid);
    CHECK(mal_string_hash(slice) == expected_hash && slice->dependent_hash == expected_hash);
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, slice, 16, 160);
    MalStringSegment segment;
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

    MalValue root = mal_value_from_string(slice);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    const c16 *flattened = mal_string_code_units(rope);
    CHECK(rope->storage == MAL_STRING_STORAGE_OWNED && !rope->latin1);
    CHECK(mal_string_code_units(slice) == flattened + 32);
    mal_gc_collect(vm);
    for (usize i = 0; i < slice->length; i++) CHECK(mal_string_code_unit_at(slice, i) == expected[32 + i]);
    CHECK(mal_string_hash(slice) == expected_hash);
    mal_gc_unroot(&span);
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
    MalString *narrow = mal_string_new_slice(&vm->heap, large, 7, 129);
    CHECK(narrow->latin1 && narrow->storage == MAL_STRING_STORAGE_DEPENDENT);
    CHECK(narrow->parent != large && narrow->parent->length <= 8 * narrow->length);
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
        && ropes_and_slices_stream_without_materialization(&vm)
        && dependent_offsets_survive_parent_widening(&vm)
        && deep_segment_stacks_and_retained_slices(&vm)
        && compact_parse_lookup_build_serialize(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("encoding-aware-strings PASS");
    return 0;
}
