#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "unicode.h"
#include "builtin_string.h"
#include "gc.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;
static MalHeap *case_heap;

static bool case_matches(const c16 *source, usize length, const c16 *expected,
    usize expected_length, bool upper, MalUnicodeLocale locale) {
    MalTextBuffer output = {.heap = case_heap};
    bool changed;
    MalTextBufferStatus status = mal_unicode_case(source, length, upper, locale, &output, &changed);
    bool expected_changed = length != expected_length || memcmp(source, expected, length * sizeof(c16)) != 0;
    bool matches = status == MAL_TEXT_BUFFER_OK && changed == expected_changed;
    if (changed) {
        matches &= output.length == expected_length;
        if (output.length == expected_length)
            for (usize i = 0; i < expected_length; i++)
                matches &= mal_text_buffer_code_unit_at(&output, i) == expected[i];
    } else matches &= output.data == nullptr && output.length == 0;
    mal_text_buffer_dispose(&output);
    return matches;
}

static bool normalization_matches(const c16 *source, usize length,
    const c16 *expected, usize expected_length, bool compatibility, bool compose) {
    c16 *output = nullptr;
    usize output_length = 0;
    MalUnicodeStatus status = mal_unicode_normalize(source, length,
        compatibility, compose, &output, &output_length);
    bool matches = status == MAL_UNICODE_OK && output_length == expected_length &&
        memcmp(output, expected, expected_length * sizeof(c16)) == 0;
    free(output);
    return matches;
}

#define CASE(source, expected, upper, locale) do { \
    if (!case_matches(source, countof(source) - 1, expected, countof(expected) - 1, upper, locale)) { \
        fprintf(stderr, "case transform failed at line %d\n", __LINE__); return 1; \
    } \
} while (0)
#define NORMALIZE(source, expected, compatibility, compose) do { \
    if (!normalization_matches(source, countof(source) - 1, expected, countof(expected) - 1, compatibility, compose)) { \
        fprintf(stderr, "normalization failed at line %d\n", __LINE__); return 1; \
    } \
} while (0)

static bool case_storage(MalVm *vm) {
    MalValue roots[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    bool passed = false;
#define CHECK_STORAGE(condition) do { \
    if (!(condition)) { fprintf(stderr, "case storage failed at line %d\n", __LINE__); goto done; } \
} while (0)
    c16 wide[MAL_STRING_INLINE_CODE_UNITS + 9];
    c16 expected[countof(wide)];
    for (usize i = 0; i < countof(wide); i++) {
        wide[i] = (i & 1) == 0 ? 0xe9 : 0x3c3;
        expected[i] = (i & 1) == 0 ? 0xc9 : 0x3a3;
    }
    wide[countof(wide) - 2] = expected[countof(wide) - 2] = 0xd83d;
    wide[countof(wide) - 1] = expected[countof(wide) - 1] = 0xde00;
    roots[0] = mal_value_from_string(mal_string_new_copy(&vm->heap, wide, countof(wide)));
    roots[1] = mal_builtin_string_case_known(vm, mal_value_to_string(roots[0]), true, MAL_UNICODE_LOCALE_ROOT);
    CHECK_STORAGE(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_string(roots[1]));
    MalString *converted = mal_value_to_string(roots[1]);
    CHECK_STORAGE(!converted->latin1 && converted->storage == MAL_STRING_STORAGE_OWNED);
    CHECK_STORAGE(converted->length == countof(expected));
    mal_gc_collect(vm);
    for (usize i = 0; i < countof(expected); i++)
        CHECK_STORAGE(mal_string_code_unit_at(converted, i) == expected[i]);

    c16 compact[MAL_STRING_INLINE_LATIN1_CODE_UNITS + 1];
    for (usize i = 0; i < countof(compact); i++) compact[i] = 0x212a;
    roots[2] = mal_value_from_string(mal_string_new_copy(&vm->heap, compact, countof(compact)));
    roots[3] = mal_builtin_string_case_known(vm, mal_value_to_string(roots[2]), false, MAL_UNICODE_LOCALE_ROOT);
    CHECK_STORAGE(vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_string(roots[3]));
    converted = mal_value_to_string(roots[3]);
    CHECK_STORAGE(converted->latin1 && converted->storage == MAL_STRING_STORAGE_OWNED);
    CHECK_STORAGE(converted->length == countof(compact));
    mal_gc_collect(vm);
    for (usize i = 0; i < countof(compact); i++) CHECK_STORAGE(mal_string_code_unit_at(converted, i) == 'k');

    c16 unchanged[MAL_STRING_INLINE_CODE_UNITS + 1];
    for (usize i = 0; i < countof(unchanged); i++) unchanged[i] = 0x4e2d;
    roots[0] = mal_value_from_string(mal_string_new_copy(&vm->heap, unchanged, countof(unchanged)));
#if MAL_PERF_STATS
    vm->heap.fail_next_raw_allocation = true;
#endif
    roots[1] = mal_builtin_string_case_known(vm, mal_value_to_string(roots[0]), true, MAL_UNICODE_LOCALE_ROOT);
    CHECK_STORAGE(vm->completion.kind != MAL_COMPLETION_THROW && roots[1] == roots[0]);
#if MAL_PERF_STATS
    CHECK_STORAGE(vm->heap.fail_next_raw_allocation);
    MalValue failed = mal_builtin_string_case_known(vm, mal_value_to_string(roots[2]), false, MAL_UNICODE_LOCALE_ROOT);
    CHECK_STORAGE(vm->completion.kind == MAL_COMPLETION_THROW && mal_value_is_undefined(failed));
    CHECK_STORAGE(!vm->heap.fail_next_raw_allocation);
#endif
    passed = true;
 done:
#if MAL_PERF_STATS
    vm->heap.fail_next_raw_allocation = false;
#endif
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    mal_gc_unroot(&span);
#undef CHECK_STORAGE
    return passed;
}

int main(void) {
    MalVm vm;
    mal_gc_test_precise_stack_roots = true;
    mal_vm_init(&vm, &mal_runtime_image);
    case_heap = &vm.heap;
    const char *storage = getenv("UNICODE_CASE_STORAGE");
    if (storage != nullptr && strcmp(storage, "1") == 0) {
        bool passed = case_storage(&vm);
        mal_gc_collect(&vm);
        mal_vm_free(&vm);
        if (!passed) return 1;
        puts("unicode-case-storage PASS");
        return 0;
    }
    CASE(u"Stra\u00dfe \ufb03", u"STRASSE FFI", true, MAL_UNICODE_LOCALE_ROOT);
    CASE(u"A\u03a3'A A\u03a3'", u"a\u03c3'a a\u03c2'", false, MAL_UNICODE_LOCALE_ROOT);
    CASE(u"\U00010400\U00010428\xd800""", u"\U00010428\U00010428\xd800""", false, MAL_UNICODE_LOCALE_ROOT);
    CASE(u"\u0130\u0131", u"i\u0307\u0131", false, MAL_UNICODE_LOCALE_ROOT);
    CASE(u"I\u0323\u0307 I\u0301\u0307 i\u0131", u"i\u0323 \u0131\u0301\u0307 i\u0131", false, MAL_UNICODE_LOCALE_TURKIC);
    CASE(u"i\u0131", u"\u0130I", true, MAL_UNICODE_LOCALE_TURKIC);
    CASE(u"I\u0323\u0301 J\u0300", u"i\u0307\u0323\u0301 j\u0307\u0300", false, MAL_UNICODE_LOCALE_LITHUANIAN);
    CASE(u"i\u0323\u0307 i\u0301\u0307", u"I\u0323 I\u0301\u0307", true, MAL_UNICODE_LOCALE_LITHUANIAN);
    CASE(u"Az-09\0\u00e9", u"AZ-09\0\u00c9", true, MAL_UNICODE_LOCALE_ROOT);
    NORMALIZE(u"\xd800""A\u030a\xdfff", u"\xd800""\u00c5\xdfff", false, true);
    NORMALIZE(u"\xd800""A\u030a\xdfff", u"\xd800""A\u030a\xdfff", false, false);
    NORMALIZE(u"\u1e0a\u0323", u"\u1e0c\u0307", false, true);
    NORMALIZE(u"\u1e0a\u0323", u"D\u0323\u0307", false, false);
    NORMALIZE(u"\ufb03", u"ffi", true, true);
    NORMALIZE(u"\ufb03", u"ffi", true, false);
    NORMALIZE(u"\u1100\u1161\u11a8", u"\uac01", false, true);
    NORMALIZE(u"\uac01", u"\u1100\u1161\u11a8", false, false);
    NORMALIZE(u"A\0\u212b", u"A\0\u00c5", false, true);
    mal_vm_free(&vm);
    puts("unicode-ascii-transforms PASS");
    return 0;
}
