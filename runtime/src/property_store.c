#include "property_store.h"

#include <stdlib.h>

#include "./gc.h"
#include "./heap.h"
#include "./perf_stats.h"
#include "./profile.h"

typedef struct MalPropertyAccessors {
    MalValue getter;
    MalValue setter;
} MalPropertyAccessors;

static_assert(MAL_PROPERTY_INTERNAL_FLAGS <= UINT8_MAX,
              "property flags no longer fit in a table entry");
static_assert(sizeof(MalPropertyAccessors) == 16,
              "accessor sidecar should use the 16-byte raw class");

static MalPropertyDesc mal_property_entry_read(
    const MalTable *table, void *entry) {
    MalPropertyFlags flags =
        (MalPropertyFlags) mal_table_entry_property_flags(table, entry);
    if ((flags & MAL_PROPERTY_ACCESSOR) == 0) {
        return (MalPropertyDesc) {
            .flags = flags,
            .value = mal_table_entry_value(table, entry),
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
    }
    MalPropertyAccessors *accessors = mal_table_entry_data(table, entry);
    return (MalPropertyDesc) {
        .flags = flags,
        .value = mal_value_new_undefined(),
        .getter = accessors->getter,
        .setter = accessors->setter,
    };
}

static void mal_property_entry_write(
    MalTable *table, void *entry, const MalPropertyDesc *desc) {
    bool was_accessor =
        (mal_table_entry_property_flags(table, entry)
         & MAL_PROPERTY_ACCESSOR) != 0;
    bool is_accessor = (desc->flags & MAL_PROPERTY_ACCESSOR) != 0;
    void *data = mal_table_entry_data(table, entry);
    if (is_accessor) {
        MalPropertyAccessors *accessors = data;
        if (!was_accessor) {
            accessors = mal_heap_alloc_raw_profiled(
                mal_gc_current_heap(), sizeof(*accessors),
                MAL_PROFILE_ALLOCATION_FAMILY_OBJECT);
            mal_table_entry_set_owned_data(table, entry, accessors);
            MAL_PERF_COUNT(property_accessor_sidecar_allocations);
        }
        accessors->getter = desc->getter;
        accessors->setter = desc->setter;
        mal_table_entry_set_value(table, entry, mal_value_new_undefined());
    } else {
        if (was_accessor) {
            gc_free_raw(mal_gc_current_heap(), data);
            mal_table_entry_set_owned_data(table, entry, nullptr);
            MAL_PERF_COUNT(property_accessor_sidecar_frees);
        }
        mal_table_entry_set_value(table, entry, desc->value);
    }
    mal_table_entry_set_property_flags(table, entry, (u8) desc->flags);
}

MalPropertyLookup mal_property_lookup(const MalTable *table, MalKey key) {
    MalTableLookup lookup = mal_table_lookup(table, key);

    if (!lookup.present) {
        return (MalPropertyLookup) {.present = false, .entry = nullptr};
    }

    return (MalPropertyLookup) {
        .present = true,
        .entry = lookup.entry,
        .desc = mal_property_entry_read(table, lookup.entry),
    };
}

MalPropertyRead mal_property_read(const MalTable *table, MalKey key) {
    MalTableLookup lookup = mal_table_lookup(table, key);
    if (!lookup.present) {
        return (MalPropertyRead) {.kind = MAL_PROPERTY_READ_MISSING};
    }

    MalPropertyFlags flags =
        (MalPropertyFlags) mal_table_entry_property_flags(table, lookup.entry);
    if ((flags & MAL_PROPERTY_ACCESSOR) == 0) {
        return (MalPropertyRead) {
            .kind = MAL_PROPERTY_READ_DATA,
            .value = mal_table_entry_value(table, lookup.entry),
        };
    }

    MalPropertyAccessors *accessors = mal_table_entry_data(table, lookup.entry);
    return (MalPropertyRead) {
        .kind = MAL_PROPERTY_READ_ACCESSOR,
        .value = accessors->getter,
    };
}

MalPropertyEnsure mal_property_ensure(
    MalTable *table, MalKey key, const MalPropertyDesc *initial
) {
    MAL_PERF_COUNT(property_ensure_calls);
    bool inserted;
    void *entry = mal_table_upsert_entry(table, key, &inserted);
    if (inserted) {
        mal_property_entry_write(table, entry, initial);
        MAL_PERF_COUNT(property_ensure_inserts);
    } else {
        MAL_PERF_COUNT(property_ensure_hits);
    }
    return (MalPropertyEnsure) {
        .inserted = inserted,
        .entry = entry,
        .desc = inserted ? *initial : mal_property_entry_read(table, entry),
    };
}

void *mal_property_define(MalTable *table, MalKey key, const MalPropertyDesc *desc) {
    void *entry = mal_table_upsert_entry(table, key, nullptr);
    mal_property_entry_write(table, entry, desc);

    return entry;
}

void *mal_property_set_value(MalTable *table, MalKey key, MalValue value) {
    void *entry = mal_table_upsert_entry(table, key, nullptr);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE
            | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    mal_property_entry_write(table, entry, &desc);

    return entry;
}

void mal_property_write_entry(MalTable *table, void *entry, const MalPropertyDesc *desc) {
    MalPropertyDesc current = mal_property_entry_read(table, entry);
    // SATB: shade the descriptor refs being overwritten. write_entry is only
    // called on an already-present property, so `current` holds valid old values.
    mal_gc_write_barrier(current.value);
    mal_gc_write_barrier(current.getter);
    mal_gc_write_barrier(current.setter);
    mal_property_entry_write(table, entry, desc);
}

MalKey mal_property_entry_key(const MalTable *table, void *entry) {
    return mal_table_entry_key(table, entry);
}

MalPropertyDesc mal_property_entry_desc(const MalTable *table, void *entry) {
    return mal_property_entry_read(table, entry);
}
