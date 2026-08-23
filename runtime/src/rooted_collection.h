#pragma once

#include "gc.h"
#include "key.h"

/**
 * A growable property-key snapshot. `roots` mirrors keys[i].value so string and
 * symbol keys remain live even when the property that formerly owned them is
 * deleted while the snapshot is being consumed.
 */
typedef struct MalRootedKeySnapshot {
    MalKey *keys;
    MalValue *roots;
    usize count;
    usize capacity;
    MalRootSpan root_span;
} MalRootedKeySnapshot;

void mal_rooted_key_snapshot_init(MalRootedKeySnapshot *snapshot);
void mal_rooted_key_snapshot_append(MalRootedKeySnapshot *snapshot, MalKey key);
bool mal_rooted_key_snapshot_own_keys(
    MalVm *vm, MalValue object, MalRootedKeySnapshot *snapshot);
void mal_rooted_key_snapshot_dispose(MalRootedKeySnapshot *snapshot);

/** A growable list whose values remain live across subsequent JS re-entry. */
typedef struct MalRootedValueList {
    MalValue *values;
    usize count;
    usize capacity;
    MalRootSpan root_span;
} MalRootedValueList;

void mal_rooted_value_list_init(MalRootedValueList *list);
void mal_rooted_value_list_append(MalRootedValueList *list, MalValue value);
void mal_rooted_value_list_dispose(MalRootedValueList *list);

/**
 * Exactly sized rooted strings accumulated for one flatten operation. The
 * separator and each non-empty part stay rooted while caller-owned coercion or
 * iteration re-enters JS. `expected_count` fixes both storage and separator
 * accounting before those side effects.
 */
typedef struct MalRootedStringParts {
    MalValue separator_root;
    MalValue *roots;
    usize count;
    usize expected_count;
    usize total_length;
    MalRootSpan separator_span;
    MalRootSpan parts_span;
} MalRootedStringParts;

bool mal_rooted_string_parts_init(
    MalRootedStringParts *parts, MalString *separator, usize expected_count);
bool mal_rooted_string_parts_append(MalRootedStringParts *parts, MalString *part);
bool mal_rooted_string_parts_flatten(
    MalVm *vm, MalRootedStringParts *parts, MalString **out);
void mal_rooted_string_parts_dispose(MalRootedStringParts *parts);
