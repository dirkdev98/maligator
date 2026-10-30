#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "unicode.h"

static bool case_matches(const c16 *source, usize length, const c16 *expected,
    usize expected_length, bool upper, MalUnicodeLocale locale) {
    c16 *output = nullptr;
    usize output_length = 0;
    MalUnicodeStatus status = mal_unicode_case(source, length, upper, locale,
        &output, &output_length);
    bool matches = status == MAL_UNICODE_OK && output_length == expected_length &&
        memcmp(output, expected, expected_length * sizeof(c16)) == 0;
    free(output);
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

int main(void) {
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
    puts("unicode-ascii-transforms PASS");
    return 0;
}
