#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_string.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "perf_stats.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static MalString *rope_from_units(MalVm *vm, const c16 *units, usize length, bool right) {
    MalString *rope = mal_intrinsic_ascii(vm, "");
    for (usize processed = 0; processed < length;) {
        usize count = length - processed;
        if (count > 47) count = 47;
        usize offset = right ? length - processed - count : processed;
        MalString *leaf = (processed / 47) % 2 == 0
            ? mal_string_new_copy(&vm->heap, units + offset, count)
            : mal_string_new_external(&vm->heap, units + offset, count);
        if (processed == 0) rope = leaf;
        else if (!mal_string_new_cons_checked(&vm->heap,
                right ? leaf : rope, right ? rope : leaf, &rope)) abort();
        processed += count;
    }
    return rope;
}

static i32 reference_find(
    const c16 *units, usize length, const c16 *needle, usize needle_length,
    f64 position, bool reverse
) {
    if (reverse) {
        if (needle_length > length) return -1;
        usize max_start = length - needle_length;
        usize start = isnan(position) || position >= (f64) max_start ? max_start
            : position <= 0 ? 0 : (usize) position;
        for (usize i = start + 1; i > 0; i--) {
            if (memcmp(units + i - 1, needle, needle_length * sizeof(c16)) == 0) return (i32) i - 1;
        }
    } else {
        usize start = isnan(position) || position <= 0 ? 0
            : position >= (f64) length ? length : (usize) position;
        for (usize i = start; i <= length && needle_length <= length - i; i++) {
            if (memcmp(units + i, needle, needle_length * sizeof(c16)) == 0) return (i32) i;
        }
    }
    return -1;
}

static bool search_matches_reference(MalVm *vm) {
    c16 units[1024];
    for (usize i = 0; i < countof(units); i++) units[i] = i % 29 == 0 ? 0 : (c16) ('a' + i % 3);
    units[46] = 0xd800;
    units[47] = 0xdc00;
    units[93] = 0xdc00;
    units[94] = 0x100;
    units[1000] = 0xd800;
    MalString *strings[] = {
        mal_string_new_copy(&vm->heap, units, countof(units)),
        mal_string_new_external(&vm->heap, units, countof(units)),
        rope_from_units(vm, units, countof(units), false),
        rope_from_units(vm, units, countof(units), true),
    };
    const usize offsets[] = {0, 1, 30, 44, 46, 47, 92, 93, 500, 990};
    const usize sizes[] = {0, 1, 2, 3, 16, 31, 32, 33};
    const f64 starts[] = {-INFINITY, -3, 0, 1, 45, 47, 500, 991, 1024, 1025, INFINITY, NAN};
    for (usize o = 0; o < countof(offsets); o++) {
        for (usize n = 0; n < countof(sizes); n++) {
            MalString *needle = mal_string_new_copy(&vm->heap, units + offsets[o], sizes[n]);
            for (usize s = 0; s < countof(strings); s++) {
                for (usize p = 0; p < countof(starts); p++) {
                    for (usize reverse = 0; reverse < 2; reverse++) {
                        i32 expected = reference_find(units, countof(units), units + offsets[o], sizes[n], starts[p], reverse);
                        MalValue actual = mal_builtin_string_search_strings(strings[s], needle, starts[p],
                            reverse ? MAL_STRING_SEARCH_LAST_INDEX_OF : MAL_STRING_SEARCH_INDEX_OF);
                        CHECK(mal_value_to_i32(actual) == expected);
                    }
                }
            }
        }
    }
    CHECK(strings[2]->storage == MAL_STRING_STORAGE_CONS);
    CHECK(strings[3]->storage == MAL_STRING_STORAGE_CONS);
    return true;
}

static bool long_prefix_work_is_bounded(MalVm *vm) {
    for (usize length = 4096; length <= 65536; length *= 4) {
        usize needle_length = length / 4;
        c16 *units = malloc(length * sizeof(c16));
        c16 *needle_units = malloc(needle_length * sizeof(c16));
        if (units == nullptr || needle_units == nullptr) abort();
        for (usize i = 0; i < length; i++) units[i] = 'a';
        for (usize i = 0; i < needle_length; i++) needle_units[i] = 'a';
        // Both ends match, defeating first/last-unit filtering in either direction.
        needle_units[needle_length / 2] = 'b';
        MalString *haystack = rope_from_units(vm, units, length, false);
        MalString *needle = rope_from_units(vm, needle_units, needle_length, true);
        for (usize reverse = 0; reverse < 2; reverse++) {
            mal_perf_stats_reset();
            MalValue result = mal_builtin_string_search_strings(haystack, needle,
                reverse ? INFINITY : 0,
                reverse ? MAL_STRING_SEARCH_LAST_INDEX_OF : MAL_STRING_SEARCH_INDEX_OF);
            CHECK(mal_value_to_i32(result) == -1);
#if MAL_PERF_STATS
            CHECK(mal_perf_stats.string_search_linear_comparisons <= 3 * (length + needle_length));
            CHECK(mal_perf_stats.string_iterator_nodes <= 4 * (length + needle_length) / 47 + 128);
            printf("prefix length=%zu needle=%zu reverse=%zu comparisons=%llu nodes=%llu\n",
                length, needle_length, reverse,
                (unsigned long long) mal_perf_stats.string_search_linear_comparisons,
                (unsigned long long) mal_perf_stats.string_iterator_nodes);
#endif
        }
        // A suffix hit should stop after the needle, without scanning the prefix.
        mal_perf_stats_reset();
        MalString *suffix = mal_string_new_ascii(&vm->heap, "aaaa", 4);
        CHECK(mal_value_to_i32(mal_builtin_string_search_strings(
            haystack, suffix, INFINITY, MAL_STRING_SEARCH_LAST_INDEX_OF)) == (i32) length - 4);
#if MAL_PERF_STATS
        CHECK(mal_perf_stats.string_iterator_nodes < 128);
#endif
        CHECK(haystack->storage == MAL_STRING_STORAGE_CONS && needle->storage == MAL_STRING_STORAGE_CONS);
        free(needle_units);
        free(units);
    }
    return true;
}

static usize replacement_calls;

static MalValue materializing_replacer(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 count,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (count != 3 || mal_ops_number_as_f64(args[1]) != (f64) (replacement_calls * 2 + 1)) abort();
    replacement_calls++;
    MalString *source = mal_value_to_string(args[2]);
    (void) mal_string_code_units(source);
    if (replacement_calls % 32 == 0) mal_gc_collect(vm);
    return mal_value_from_string(mal_intrinsic_ascii(vm, "+"));
}

static bool split_and_replace_keep_sequential_state(MalVm *vm) {
    c16 units[4096];
    for (usize i = 0; i < countof(units); i++) units[i] = i % 2 == 0 ? 'a' : ',';
    MalValue roots[5] = {0};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[0] = mal_value_from_string(rope_from_units(vm, units, countof(units), false));
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, ","));
    roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, "+"));
    MalString *source = mal_value_to_string(roots[0]);
    mal_perf_stats_reset();
    roots[3] = mal_builtin_string_split_direct(vm, roots[0], roots + 1, 1);
    CHECK(vm->completion.kind != MAL_COMPLETION_THROW);
    MalArrayObject *split = mal_value_to_array_object(roots[3]);
    CHECK(mal_array_object_length(split) == 2049);
    for (u32 i = 0; i < 2049; i++) {
        MalValue part;
        CHECK(mal_array_object_dense_get(split, i, &part));
        CHECK(mal_string_length(mal_value_to_string(part)) == (i == 2048 ? 0 : 1));
    }
#if MAL_PERF_STATS
    CHECK(mal_perf_stats.string_iterator_nodes < 800);
#endif
    mal_perf_stats_reset();
    roots[3] = mal_builtin_string_replace_known(vm, source, mal_value_to_string(roots[1]), roots[2], true);
    CHECK(vm->completion.kind != MAL_COMPLETION_THROW);
    MalString *replaced = mal_value_to_string(roots[3]);
    CHECK(replaced->length == countof(units) && replaced->latin1);
    for (usize i = 0; i < replaced->length; i++) CHECK(mal_string_code_unit_at(replaced, i) == (i % 2 == 0 ? 'a' : '+'));
#if MAL_PERF_STATS
    CHECK(mal_perf_stats.string_iterator_nodes < 800);
#endif
    CHECK(source->storage == MAL_STRING_STORAGE_CONS);

    MalValue empty = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    mal_perf_stats_reset();
    roots[3] = mal_builtin_string_split_direct(vm, roots[0], &empty, 1);
    CHECK(mal_array_object_length(mal_value_to_array_object(roots[3])) == countof(units));
#if MAL_PERF_STATS
    CHECK(mal_perf_stats.string_iterator_nodes < 400);
#endif
    roots[4] = mal_value_from_native_function_object(mal_native_function_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "replacer"), materializing_replacer));
    replacement_calls = 0;
    roots[3] = mal_builtin_string_replace_known(vm, source, mal_value_to_string(roots[1]), roots[4], true);
    CHECK(vm->completion.kind != MAL_COMPLETION_THROW && replacement_calls == 2048);
    replaced = mal_value_to_string(roots[3]);
    CHECK(replaced->length == countof(units));
    for (usize i = 0; i < replaced->length; i++) CHECK(mal_string_code_unit_at(replaced, i) == (i % 2 == 0 ? 'a' : '+'));
    CHECK(source->storage != MAL_STRING_STORAGE_CONS);
    mal_gc_unroot(&span);
    return true;
}

static bool compact_builtin_outputs_preserve_sources(MalVm *vm) {
    c16 units[2048];
    for (usize i = 0; i < countof(units); i++) units[i] = (c16) ('a' + i % 26);
    MalValue roots[8] = {0};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[0] = mal_value_from_string(rope_from_units(vm, units, countof(units), false));
    MalString *source = mal_value_to_string(roots[0]);
    CHECK(mal_builtin_string_trim_known(vm, source, true, true) == roots[0]);
    CHECK(mal_builtin_string_case_known(vm, source, false, MAL_UNICODE_LOCALE_ROOT) == roots[0]);
    CHECK(mal_value_to_boolean(mal_builtin_string_is_well_formed_known(source)));
    CHECK(mal_builtin_string_to_well_formed_known(vm, source) == roots[0]);
    roots[1] = mal_builtin_string_case_known(vm, source, true, MAL_UNICODE_LOCALE_ROOT);
    CHECK(mal_value_to_string(roots[1])->latin1);
    for (usize i = 0; i < countof(units); i++) {
        CHECK(mal_string_code_unit_at(mal_value_to_string(roots[1]), i) == 'A' + i % 26);
    }
    roots[2] = mal_builtin_string_repeat_numeric(vm, source, 3);
    CHECK(mal_value_to_string(roots[2])->length == countof(units) * 3);
    CHECK(mal_value_to_string(roots[2])->latin1);
    for (usize i = 0; i < countof(units) * 3; i++) {
        CHECK(mal_string_code_unit_at(mal_value_to_string(roots[2]), i) == units[i % countof(units)]);
    }
    roots[3] = mal_value_from_string(mal_intrinsic_ascii(vm, "xy"));
    for (usize start = 0; start < 2; start++) {
        roots[4] = mal_builtin_string_pad_numeric(vm, source, countof(units) + 7, roots[3], start);
        MalString *padded = mal_value_to_string(roots[4]);
        CHECK(padded->latin1 && padded->length == countof(units) + 7);
        for (usize i = 0; i < padded->length; i++) {
            c16 expected = start ? (i < 7 ? (i % 2 ? 'y' : 'x') : units[i - 7])
                : (i < countof(units) ? units[i] : ((i - countof(units)) % 2 ? 'y' : 'x'));
            CHECK(mal_string_code_unit_at(padded, i) == expected);
        }
    }
    MalValue concat_args[] = {roots[0], mal_value_from_string(mal_intrinsic_ascii(vm, ""))};
    CHECK(mal_builtin_string_concat_direct(vm, roots[0], concat_args, countof(concat_args), &roots[5]));
    CHECK(mal_value_to_string(roots[5])->latin1 && mal_value_to_string(roots[5])->length == countof(units) * 2);
    CHECK(mal_builtin_string_concat_direct(vm, concat_args[1], &roots[0], 1, &roots[5]));
    CHECK(roots[5] == roots[0]);
    CHECK(source->storage == MAL_STRING_STORAGE_CONS);

    const c16 surrogate_filler[] = {0xd800, 0xdc00};
    roots[3] = mal_value_from_string(mal_string_new_copy(&vm->heap, surrogate_filler, 2));
    roots[4] = mal_builtin_string_pad_numeric(vm, source, countof(units) + 3, roots[3], true);
    MalString *padded = mal_value_to_string(roots[4]);
    CHECK(!padded->latin1 && padded->length == countof(units) + 3);
    CHECK(mal_string_code_unit_at(padded, 0) == 0xd800);
    CHECK(mal_string_code_unit_at(padded, 1) == 0xdc00);
    CHECK(mal_string_code_unit_at(padded, 2) == 0xd800);
    CHECK(mal_string_code_unit_at(padded, 3) == 'a');

    c16 wide[200];
    for (usize i = 0; i < countof(wide); i++) wide[i] = 'q';
    wide[46] = 0xd800;
    wide[47] = 0xdc00;
    wide[94] = 0xdc00;
    wide[140] = 0xd800;
    wide[141] = 0xd800;
    wide[142] = 0xdc00;
    wide[199] = 0xd800;
    roots[6] = mal_value_from_string(rope_from_units(vm, wide, countof(wide), false));
    CHECK(!mal_value_to_boolean(mal_builtin_string_is_well_formed_known(mal_value_to_string(roots[6]))));
    roots[7] = mal_builtin_string_to_well_formed_known(vm, mal_value_to_string(roots[6]));
    CHECK(mal_value_to_boolean(mal_builtin_string_is_well_formed_known(mal_value_to_string(roots[7]))));
    for (usize i = 0; i < countof(wide); i++) {
        CHECK(mal_string_code_unit_at(mal_value_to_string(roots[7]), i) ==
            (i == 94 || i == 140 || i == 199 ? 0xfffd : wide[i]));
    }
    CHECK(mal_value_to_string(roots[6])->storage == MAL_STRING_STORAGE_CONS);
    mal_gc_collect(vm);
    CHECK(mal_string_code_unit_at(source, 2047) == units[2047]);
    mal_gc_unroot(&span);
    return true;
}

static bool compact_result_boundaries_and_concat_growth(MalVm *vm) {
    const usize lengths[] = {8, 9, 16, 17};
    u8 units[17];
    memset(units, 'a', sizeof(units));
    MalValue roots[4] = {0};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    roots[0] = mal_value_from_string(mal_intrinsic_ascii(vm, "a"));
    for (usize i = 0; i < countof(lengths); i++) {
        usize length = lengths[i];
        roots[1] = mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, units, length));
        roots[2] = mal_builtin_string_case_known(vm, mal_value_to_string(roots[1]), true, MAL_UNICODE_LOCALE_ROOT);
        roots[3] = mal_builtin_string_repeat_numeric(vm, mal_value_to_string(roots[0]), length);
        MalString *upper = mal_value_to_string(roots[2]);
        MalString *repeated = mal_value_to_string(roots[3]);
        CHECK(upper->latin1 && repeated->latin1);
        CHECK(upper->length == length && repeated->length == length);
        CHECK((upper->storage == MAL_STRING_STORAGE_INLINE) == (length <= 16));
        CHECK((repeated->storage == MAL_STRING_STORAGE_INLINE) == (length <= 16));
        roots[3] = mal_builtin_string_pad_numeric(vm, mal_value_to_string(roots[0]), length, roots[0], false);
        CHECK(mal_value_to_string(roots[3])->latin1 && mal_string_equals(mal_value_to_string(roots[3]), mal_value_to_string(roots[1])));
    }
    const c16 sharp_s[] = {0xdf};
    roots[1] = mal_value_from_string(mal_string_new_copy(&vm->heap, sharp_s, 1));
    roots[2] = mal_builtin_string_case_known(vm, mal_value_to_string(roots[1]), true, MAL_UNICODE_LOCALE_ROOT);
    CHECK(mal_string_length(mal_value_to_string(roots[2])) == 2);
    CHECK(mal_string_code_unit_at(mal_value_to_string(roots[2]), 0) == 'S');
    CHECK(mal_string_code_unit_at(mal_value_to_string(roots[2]), 1) == 'S');

    roots[1] = roots[0];
    mal_perf_stats_reset();
    for (usize length = 2; length <= 8192; length++) {
        CHECK(mal_builtin_string_concat_direct(vm, roots[1], roots, 1, &roots[1]));
    }
    MalString *concatenated = mal_value_to_string(roots[1]);
    CHECK(concatenated->length == 8192 && concatenated->latin1);
    CHECK(concatenated->storage == MAL_STRING_STORAGE_CONS);
    for (usize i = 0; i < concatenated->length; i++) CHECK(mal_string_code_unit_at(concatenated, i) == 'a');
#if MAL_PERF_STATS
    u64 copied = mal_perf_stats.string_copy_code_units + mal_perf_stats.string_owned_code_units;
    CHECK(copied < 8192 * 64);
    printf("concat length=8192 copied_units=%llu\n", (unsigned long long) copied);
#endif
    mal_gc_unroot(&span);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    bool passed = search_matches_reference(&vm)
        && long_prefix_work_is_bounded(&vm)
        && split_and_replace_keep_sequential_state(&vm)
        && compact_builtin_outputs_preserve_sources(&vm)
        && compact_result_boundaries_and_concat_growth(&vm);
    mal_vm_free(&vm);
    if (!passed) return 1;
    puts("string-search-followups PASS");
    return 0;
}
