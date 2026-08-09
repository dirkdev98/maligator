#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalHeap MalHeap;

/** The eight branded Temporal object families backed by temporal_rs handles. */
typedef enum MalTemporalKind : u8 {
    MAL_TEMPORAL_DURATION,
    MAL_TEMPORAL_INSTANT,
    MAL_TEMPORAL_PLAIN_DATE,
    MAL_TEMPORAL_PLAIN_DATE_TIME,
    MAL_TEMPORAL_PLAIN_MONTH_DAY,
    MAL_TEMPORAL_PLAIN_TIME,
    MAL_TEMPORAL_PLAIN_YEAR_MONTH,
    MAL_TEMPORAL_ZONED_DATE_TIME,
} MalTemporalKind;

/** Ordinary object shell plus the spec internal slots owned by temporal_rs. */
typedef struct MalTemporalObject {
    MalObject object;
    void *handle;
    MalTemporalKind kind;
} MalTemporalObject;

MalTemporalObject *mal_temporal_object_new(
    MalHeap *heap, MalObject *prototype, MalTemporalKind kind, void *handle
);

