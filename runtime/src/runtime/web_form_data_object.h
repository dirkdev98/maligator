#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"
#include "value.h"

typedef struct MalFormDataEntry {
    MalString *name;
    MalValue value; // USVString or Blob
    MalString *filename; // nullptr for string values
} MalFormDataEntry;

typedef struct MalFormDataObject {
    MalObject object;
    MalFormDataEntry *entries;
    i32 count;
    i32 capacity;
} MalFormDataObject;

typedef enum MalFormDataIteratorKind : u8 {
    MAL_FORM_DATA_ITERATOR_ENTRIES,
    MAL_FORM_DATA_ITERATOR_KEYS,
    MAL_FORM_DATA_ITERATOR_VALUES,
} MalFormDataIteratorKind;

typedef struct MalFormDataIteratorObject {
    MalObject object;
    MalFormDataObject *form_data;
    u64 index;
    MalFormDataIteratorKind kind;
} MalFormDataIteratorObject;
