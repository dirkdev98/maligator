#pragma once

#include "defaults.h"

typedef enum MalUnicodeStatus : u8 {
    MAL_UNICODE_OK,
    MAL_UNICODE_LENGTH_OVERFLOW,
    MAL_UNICODE_ALLOCATION_FAILURE,
} MalUnicodeStatus;

typedef enum MalUnicodeLocale : u8 {
    MAL_UNICODE_LOCALE_ROOT,
    MAL_UNICODE_LOCALE_TURKIC,
    MAL_UNICODE_LOCALE_LITHUANIAN,
} MalUnicodeLocale;

// These pure transforms preserve lone surrogates and return malloc-owned UTF-16.
MalUnicodeStatus mal_unicode_case(
    const c16 *source, usize length, bool upper, MalUnicodeLocale locale,
    c16 **output, usize *output_length);
MalUnicodeStatus mal_unicode_normalize(
    const c16 *source, usize length, bool compatibility, bool compose,
    c16 **output, usize *output_length);
