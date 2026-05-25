#include "property_iter.h"

#define MAL_PROPERTY_ITER_PHASE_INDEX 0
#define MAL_PROPERTY_ITER_PHASE_STRING 1
#define MAL_PROPERTY_ITER_PHASE_SYMBOL 2
#define MAL_PROPERTY_ITER_PHASE_DONE 3

static bool mal_property_iter_is_enumerable_view(const MalPropertyIter *iter) {
    return iter->kind == MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER;
}

static bool mal_property_iter_desc_matches(const MalPropertyIter *iter, MalPropertyDesc desc) {
    if (!mal_property_iter_is_enumerable_view(iter)) {
        return true;
    }

    return (desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
}

static u32 mal_property_iter_index_value(MalKey key) {
    if (mal_value_is_int32(key.value)) {
        return (u32) mal_value_to_i32(key.value);
    }

    return (u32) key.value;
}

static bool mal_property_iter_next_storage(MalPropertyIter *iter, MalKey *key_out, MalPropertyDesc *desc_out) {
    MalKey key;
    void *entry;

    while (mal_table_iter_next(&iter->table_iter, &key, &entry)) {
        MalPropertyDesc desc = mal_property_entry_desc(iter->object->properties, entry);

        if (!mal_property_iter_desc_matches(iter, desc)) {
            continue;
        }

        *key_out = key;
        *desc_out = desc;

        return true;
    }

    return false;
}

static bool mal_property_iter_next_index(MalPropertyIter *iter, MalKey *key_out, MalPropertyDesc *desc_out) {
    MalTableIter table_iter;
    MalKey key;
    void *entry;
    bool found = false;
    u32 next_index = 0;
    MalPropertyDesc next_desc = {0};
    MalKey next_key = {0};

    mal_table_iter_init(&table_iter, iter->object->properties, MAL_TABLE_ITER_STORAGE);

    while (mal_table_iter_next(&table_iter, &key, &entry)) {
        if (key.kind != MAL_KEY_INDEX) {
            continue;
        }

        u32 index = mal_property_iter_index_value(key);

        if (iter->has_last_index && index <= iter->last_index) {
            continue;
        }

        MalPropertyDesc desc = mal_property_entry_desc(iter->object->properties, entry);

        if (!mal_property_iter_desc_matches(iter, desc)) {
            continue;
        }

        if (!found || index < next_index) {
            found = true;
            next_index = index;
            next_desc = desc;
            next_key = key;
        }
    }

    if (!found) {
        return false;
    }

    iter->last_index = next_index;
    iter->has_last_index = true;
    *key_out = next_key;
    *desc_out = next_desc;

    return true;
}

static bool mal_property_iter_next_kind(MalPropertyIter *iter, MalKeyKind kind, MalKey *key_out, MalPropertyDesc *desc_out) {
    MalKey key;
    void *entry;

    while (mal_table_iter_next(&iter->table_iter, &key, &entry)) {
        if (key.kind != kind) {
            continue;
        }

        MalPropertyDesc desc = mal_property_entry_desc(iter->object->properties, entry);

        if (!mal_property_iter_desc_matches(iter, desc)) {
            continue;
        }

        *key_out = key;
        *desc_out = desc;

        return true;
    }

    return false;
}

static void mal_property_iter_start_phase(MalPropertyIter *iter, u32 phase) {
    iter->phase = phase;
    mal_table_iter_init(&iter->table_iter, iter->object->properties, MAL_TABLE_ITER_STORAGE);
}

void mal_property_iter_init(MalPropertyIter *iter, MalObject *object, MalPropertyIterKind kind) {
    iter->object = object;
    iter->kind = kind;
    iter->phase = MAL_PROPERTY_ITER_PHASE_INDEX;
    iter->last_index = 0;
    iter->has_last_index = false;
    mal_table_iter_init(&iter->table_iter, object->properties, MAL_TABLE_ITER_STORAGE);
}

bool mal_property_iter_next(MalPropertyIter *iter, MalKey *key_out, MalPropertyDesc *desc_out) {
    if (iter->kind == MAL_PROPERTY_ITER_STORAGE_ORDER) {
        return mal_property_iter_next_storage(iter, key_out, desc_out);
    }

    while (iter->phase != MAL_PROPERTY_ITER_PHASE_DONE) {
        if (iter->phase == MAL_PROPERTY_ITER_PHASE_INDEX) {
            if (mal_property_iter_next_index(iter, key_out, desc_out)) {
                return true;
            }

            mal_property_iter_start_phase(iter, MAL_PROPERTY_ITER_PHASE_STRING);
            continue;
        }

        if (iter->phase == MAL_PROPERTY_ITER_PHASE_STRING) {
            if (mal_property_iter_next_kind(iter, MAL_KEY_STRING, key_out, desc_out)) {
                return true;
            }

            mal_property_iter_start_phase(iter, MAL_PROPERTY_ITER_PHASE_SYMBOL);
            continue;
        }

        if (mal_property_iter_next_kind(iter, MAL_KEY_SYMBOL, key_out, desc_out)) {
            return true;
        }

        iter->phase = MAL_PROPERTY_ITER_PHASE_DONE;
    }

    return false;
}
