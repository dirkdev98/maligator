#pragma once

#include "./defaults.h"
#include "object_ops.h"

/**
 * Enumeration view exposed over an object's own properties.
 */
typedef enum MalPropertyIterKind {
    MAL_PROPERTY_ITER_STORAGE_ORDER,
    MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER,
    MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
} MalPropertyIterKind;

typedef struct MalPropertyIter {
    MalObject *object;
    MalPropertyIterKind kind;
    MalTableIter table_iter;
    u32 phase;
    u32 last_index;
    bool has_last_index;
    /** Next shaped (inline) property to emit; shaped props are all string keys. */
    u32 shape_index;
} MalPropertyIter;

/**
 * Initialize an iterator over an object's own properties.
 */
void mal_property_iter_init(MalPropertyIter *iter, MalObject *object, MalPropertyIterKind kind);

/**
 * Advance an object property iterator.
 */
bool mal_property_iter_next(MalPropertyIter *iter, MalKey *key_out, MalPropertyDesc *desc_out);
