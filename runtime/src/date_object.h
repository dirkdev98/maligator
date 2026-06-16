#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalHeap MalHeap;

/**
 * A Date exotic object: an ordinary object plus the [[DateValue]] internal slot,
 * a time value in milliseconds since the epoch (an integral f64, or NaN for an
 * invalid Date). The slot is mutated in place by the Date.prototype.setX
 * methods. See builtin_date.c for the spec time abstract operations.
 */
typedef struct MalDateObject {
    MalObject object;
    f64 date_value;
} MalDateObject;

/**
 * Initialize Date object state in caller-provided storage.
 */
void mal_date_object_init(MalHeap *heap, MalDateObject *date, MalObject *prototype, f64 date_value);

/**
 * Allocate and initialize a new Date object holding date_value.
 */
MalDateObject *mal_date_object_new(MalHeap *heap, MalObject *prototype, f64 date_value);
