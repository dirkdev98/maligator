#include "property_store.h"

#include <stdlib.h>

static MalPropertyDesc *mal_property_entry_data(MalTable *table, void *entry) {
    MalPropertyDesc *desc = mal_table_entry_data(table, entry);

    if (desc == nullptr) {
        desc = malloc(sizeof(MalPropertyDesc));
        mal_table_entry_set_owned_data(table, entry, desc);
    }

    return desc;
}

MalPropertyLookup mal_property_lookup(const MalTable *table, MalKey key) {
    MalTableLookup lookup = mal_table_lookup(table, key);

    if (!lookup.present) {
        return (MalPropertyLookup) {.present = false, .entry = nullptr};
    }

    MalPropertyDesc *desc = mal_table_entry_data(table, lookup.entry);

    return (MalPropertyLookup) {.present = true, .entry = lookup.entry, .desc = *desc};
}

void *mal_property_define(MalTable *table, MalKey key, const MalPropertyDesc *desc) {
    void *entry = mal_table_upsert_entry(table, key);
    *mal_property_entry_data(table, entry) = *desc;

    return entry;
}

void *mal_property_set_value(MalTable *table, MalKey key, MalValue value) {
    void *entry = mal_table_upsert_entry(table, key);
    MalPropertyDesc *desc = mal_property_entry_data(table, entry);

    desc->flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    desc->value = value;
    desc->getter = mal_value_new_undefined();
    desc->setter = mal_value_new_undefined();

    return entry;
}

void mal_property_write_entry(MalTable *table, void *entry, const MalPropertyDesc *desc) {
    *mal_property_entry_data(table, entry) = *desc;
}

MalKey mal_property_entry_key(const MalTable *table, void *entry) {
    return mal_table_entry_key(table, entry);
}

MalPropertyDesc mal_property_entry_desc(const MalTable *table, void *entry) {
    MalPropertyDesc *desc = mal_table_entry_data(table, entry);

    return *desc;
}
