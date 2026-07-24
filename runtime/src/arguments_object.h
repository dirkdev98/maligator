#pragma once

#include "object.h"

typedef struct MalEnv MalEnv;

/** Mapped Arguments exotic object. The trailing map stores captured-slot indices. */
typedef struct MalArgumentsObject {
    MalObject object;
    MalEnv *env;
    i32 map_count;
    i32 parameter_map[];
} MalArgumentsObject;

MalArgumentsObject *mal_arguments_object_new(
    MalHeap *heap, MalObject *prototype, MalEnv *env,
    const i32 *parameter_map, i32 map_count, i32 argument_count);

static inline bool mal_object_is_mapped_arguments(const MalObject *object) {
    return object->header.type == MAL_HEAP_ARGUMENTS_OBJECT;
}

static inline i32 mal_arguments_object_mapped_slot(
    const MalArgumentsObject *arguments, MalKey key) {
    if (key.kind != MAL_KEY_INDEX) return -1;
    u32 index = mal_key_index_value(key);
    return index < (u32) arguments->map_count ? arguments->parameter_map[index] : -1;
}

static inline void mal_arguments_object_unmap(MalArgumentsObject *arguments, MalKey key) {
    if (key.kind == MAL_KEY_INDEX && mal_key_index_value(key) < (u32) arguments->map_count) {
        arguments->parameter_map[mal_key_index_value(key)] = -1;
    }
}
