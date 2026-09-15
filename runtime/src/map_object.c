#include "./map_object.h"

#include <math.h>

#include "./gc.h"

void mal_map_object_init(MalHeap *heap, MalMapObject *map, MalHeapType type, MalObject *prototype, bool weak) {
    mal_object_init(heap, &map->object, type, prototype);
    map->entries = weak
        ? mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_MAP)
        : nullptr;
    map->weak = weak;
}

MalMapObject *mal_map_object_new(MalHeap *heap, MalHeapType type, MalObject *prototype, bool weak) {
    MalMapObject *map = mal_heap_alloc(heap, sizeof(MalMapObject), type);
    mal_map_object_init(heap, map, type, prototype, weak);

    return map;
}

MalTable *mal_map_object_ensure_entries(MalMapObject *map) {
    if (map->entries == nullptr) {
        map->entries = mal_table_new(MAL_TABLE_MODE_GENERAL, MAL_TABLE_ROLE_MAP);
    }
    return map->entries;
}

MalKey mal_map_key_from_value(MalValue value) {
    if (mal_value_is_string(value)) {
        return (MalKey) {.kind = MAL_KEY_STRING, .value = value};
    }

    if (mal_value_is_symbol(value)) {
        return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = value};
    }

    if (mal_value_is_object(value)) {
        return (MalKey) {.kind = MAL_KEY_OBJECT, .value = value};
    }

    if (mal_value_is_int32(value)) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64((f64) mal_value_to_i32(value))};
    }

    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64(0.0)};
    }

    if (mal_value_is_f64(value)) {
        f64 number = mal_value_to_f64(value);

        if (number == 0.0) {
            return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64(0.0)};
        }

        if (isnan(number)) {
            return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_new_nan()};
        }

        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    if (value == MAL_VALUE_NAN || value == MAL_VALUE_POSITIVE_INFINITY || value == MAL_VALUE_NEGATIVE_INFINITY) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    if (mal_value_is_bigint(value)) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    // true / false / null / undefined.
    return (MalKey) {.kind = MAL_KEY_STATIC, .value = value};
}

void mal_map_object_set_canonical(MalMapObject *map, MalKey key, MalValue value) {
    MalTable *entries = mal_map_object_ensure_entries(map);
    void *entry = mal_table_upsert_entry(entries, key, nullptr);
    mal_table_entry_set_value(entries, entry, value);
    // Old map gaining a young key/value: remember it so the minor collector traces
    // its entries table. For a WeakMap this also re-registers it for the weak pass
    // (its young keys are weak), so a dead young key's entry is still cleaned and the
    // key reclaimed without dangling — tracing reaches both through `map`.
    mal_gc_card(&map->object.header, key.value);
    mal_gc_card(&map->object.header, value);
}

void mal_map_object_set(MalMapObject *map, MalValue key, MalValue value) {
    mal_map_object_set_canonical(map, mal_map_key_from_value(key), value);
}

bool mal_map_object_has_canonical(const MalMapObject *map, MalKey key) {
    return mal_table_lookup(map->entries, key).present;
}

bool mal_map_object_has(const MalMapObject *map, MalValue key) {
    return mal_map_object_has_canonical(map, mal_map_key_from_value(key));
}

MalValue mal_map_object_get(const MalMapObject *map, MalValue key) {
    MalTableLookup lookup = mal_table_lookup(map->entries, mal_map_key_from_value(key));

    if (!lookup.present) {
        return mal_value_new_undefined();
    }

    return mal_table_entry_value(map->entries, lookup.entry);
}

bool mal_map_object_delete_canonical(MalMapObject *map, MalKey key) {
    return mal_table_delete(map->entries, key);
}

bool mal_map_object_delete(MalMapObject *map, MalValue key) {
    return mal_map_object_delete_canonical(map, mal_map_key_from_value(key));
}

usize mal_map_object_size(const MalMapObject *map) {
    return mal_table_size(map->entries);
}

void mal_map_object_clear(MalMapObject *map) {
    mal_table_clear(map->entries);
}
