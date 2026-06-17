#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalHeap MalHeap;

/**
 * The Intl service an MalIntlObject instance backs. Stored on the instance so
 * the shared prototype methods can brand-check their receiver.
 */
typedef enum MalIntlKind {
    MAL_INTL_LOCALE,
    MAL_INTL_COLLATOR,
    MAL_INTL_NUMBER_FORMAT,
    MAL_INTL_DATE_TIME_FORMAT,
    MAL_INTL_PLURAL_RULES,
    MAL_INTL_LIST_FORMAT,
    MAL_INTL_DISPLAY_NAMES,
    MAL_INTL_RELATIVE_TIME_FORMAT,
    MAL_INTL_SEGMENTER,
    MAL_INTL_SEGMENTS,
    MAL_INTL_SEGMENT_ITERATOR,
    MAL_INTL_DURATION_FORMAT,
} MalIntlKind;

/**
 * A generic Intl service instance: an ordinary object plus the bits every
 * service needs. `handle` is a Rust-owned ICU4X formatter (leaked — no GC yet,
 * consistent with the bump allocator), null for services with no native state
 * (e.g. Locale). `data` is a per-kind MalValue: the canonical tag string for
 * Locale, or the resolved-options object for the formatters (so resolvedOptions
 * can copy from it). `bound` caches the bound `format` accessor function.
 */
typedef struct MalIntlObject {
    MalObject object;
    MalIntlKind kind;
    void *handle;
    MalValue data;
    MalValue bound;
} MalIntlObject;

void mal_intl_object_init(MalHeap *heap, MalIntlObject *intl, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data);

MalIntlObject *mal_intl_object_new(MalHeap *heap, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data);
