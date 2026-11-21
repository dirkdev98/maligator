#pragma once

#include <stdatomic.h>

#include "text_buffer.h"

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

/** Preserve lone surrogates while mapping into an empty managed buffer. The input
 * remains immutable for locale context; unchanged text leaves the buffer empty. */
MalTextBufferStatus mal_unicode_case(
    const c16 *source, usize length, bool upper, MalUnicodeLocale locale,
    MalTextBuffer *output, bool *changed);

/**
 * Root-locale case mapping for the common text whose every scalar maps to one scalar,
 * which keeps its UTF-16 length: writes `length` units to `output` and returns true, or
 * returns false at the first expanding mapping, which mal_unicode_case handles.
 * `aggregate` ORs the written units so callers can choose the narrowest representation.
 * Lone surrogates are preserved.
 */
bool mal_unicode_case_fixed(
    const c16 *source, usize length, bool upper, c16 *output, bool *changed, c16 *aggregate);

// Preserve lone surrogates and return malloc-owned UTF-16.
typedef MalUnicodeStatus MalUnicodeNormalizer(
    const c16 *source, usize length, bool compatibility, bool compose,
    c16 **output, usize *output_length);

extern _Atomic(MalUnicodeNormalizer *) mal_unicode_normalizer;

struct MalVm;
struct MalHostInstallSlot;
struct MalHostLaunchContext;

void mal_host_install_unicode_normalization(struct MalVm *vm,
    const struct MalHostInstallSlot *slots, i32 count,
    const struct MalHostLaunchContext *launch);
