#include "property_store.h"

#include <stdlib.h>

#include "./gc.h"
#include "./heap.h"
#include "./perf_stats.h"

static_assert(MAL_PROPERTY_ACCESSOR <= UINT8_MAX, "property flags must fit table metadata");

static bool mal_property_desc_is_inline(const MalPropertyDesc *desc) {
    return (desc->flags & MAL_PROPERTY_ACCESSOR) == 0;
}

/**
 * Data properties use the table entry's inline value and metadata payloads.
 * Accessors retain the full owned descriptor side allocation.
 */
static MalPropertyDesc mal_property_read_entry(
    const MalTable *table, void *entry
) {
    const MalPropertyDesc *boxed = mal_table_entry_data(table, entry);
    if (boxed != nullptr) {
        MAL_PERF_COUNT(property_boxed_reads);
        return *boxed;
    }
    MAL_PERF_COUNT(property_inline_reads);
    return (MalPropertyDesc) {
        .flags = (MalPropertyFlags) mal_table_entry_metadata(table, entry),
        .value = mal_table_entry_value(table, entry),
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

static void mal_property_initialize_entry(
    MalTable *table, void *entry, const MalPropertyDesc *desc
) {
    if (mal_property_desc_is_inline(desc)) {
        MAL_PERF_COUNT(property_inline_writes);
        mal_table_entry_set_metadata(table, entry, (u8) desc->flags);
        mal_table_entry_set_value(table, entry, desc->value);
        return;
    }
    MalPropertyDesc *boxed =
        mal_heap_alloc_raw(mal_gc_current_heap(), sizeof(MalPropertyDesc));
    *boxed = *desc;
    mal_table_entry_set_owned_data(table, entry, boxed);
    MAL_PERF_COUNT(property_boxed_allocations);
}

static void mal_property_replace_entry(
    MalTable *table, void *entry, const MalPropertyDesc *desc
) {
    MalPropertyDesc *boxed = mal_table_entry_data(table, entry);
    if (boxed != nullptr) {
        mal_gc_write_barrier(boxed->value);
        mal_gc_write_barrier(boxed->getter);
        mal_gc_write_barrier(boxed->setter);
        if (!mal_property_desc_is_inline(desc)) {
            *boxed = *desc;
            return;
        }
        mal_table_entry_set_owned_data(table, entry, nullptr);
        gc_free_raw(mal_gc_current_heap(), boxed);
        MAL_PERF_COUNT(property_inline_writes);
        mal_table_entry_set_metadata(table, entry, (u8) desc->flags);
        mal_table_entry_set_value(table, entry, desc->value);
        return;
    }
    if (mal_property_desc_is_inline(desc)) {
        MAL_PERF_COUNT(property_inline_writes);
        mal_table_entry_set_metadata(table, entry, (u8) desc->flags);
        mal_table_entry_set_value(table, entry, desc->value);
        return;
    }
    // The inline value is now represented by the boxed descriptor. Clear the
    // generic payload so table tracing does not retain it independently.
    mal_table_entry_set_value(table, entry, mal_value_new_undefined());
    mal_property_initialize_entry(table, entry, desc);
}

MalPropertyLookup mal_property_lookup(const MalTable *table, MalKey key) {
    MalTableLookup lookup = mal_table_lookup(table, key);

    if (!lookup.present) {
        return (MalPropertyLookup) {.present = false, .entry = nullptr};
    }

    return (MalPropertyLookup) {
        .present = true,
        .entry = lookup.entry,
        .desc = mal_property_read_entry(table, lookup.entry),
    };
}

MalPropertyEnsure mal_property_ensure(
    MalTable *table, MalKey key, const MalPropertyDesc *initial
) {
    MAL_PERF_COUNT(property_ensure_calls);
    bool inserted;
    void *entry = mal_table_upsert_entry(table, key, &inserted);
    if (inserted) {
        mal_property_initialize_entry(table, entry, initial);
        MAL_PERF_COUNT(property_ensure_inserts);
    } else {
        MAL_PERF_COUNT(property_ensure_hits);
    }
    return (MalPropertyEnsure) {
        .inserted = inserted,
        .entry = entry,
        .desc = inserted ? *initial : mal_property_read_entry(table, entry),
    };
}

void *mal_property_define(MalTable *table, MalKey key, const MalPropertyDesc *desc) {
    bool inserted;
    void *entry = mal_table_upsert_entry(table, key, &inserted);
    if (inserted) {
        mal_property_initialize_entry(table, entry, desc);
    } else {
        mal_property_replace_entry(table, entry, desc);
    }

    return entry;
}

void *mal_property_set_value(MalTable *table, MalKey key, MalValue value) {
    bool inserted;
    void *entry = mal_table_upsert_entry(table, key, &inserted);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    if (inserted) {
        mal_property_initialize_entry(table, entry, &desc);
    } else {
        mal_property_replace_entry(table, entry, &desc);
    }

    return entry;
}

void mal_property_write_entry(MalTable *table, void *entry, const MalPropertyDesc *desc) {
    mal_property_replace_entry(table, entry, desc);
}

MalKey mal_property_entry_key(const MalTable *table, void *entry) {
    return mal_table_entry_key(table, entry);
}

MalPropertyDesc mal_property_entry_desc(const MalTable *table, void *entry) {
    return mal_property_read_entry(table, entry);
}
