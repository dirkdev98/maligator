#include "./table.h"

#include <stdlib.h>

#include "./gc.h"
#include "./heap_string.h"

#define MAL_TABLE_MIN_CAPACITY 16
#define MAL_TABLE_MAX_LOAD_NUMERATOR 3
#define MAL_TABLE_MAX_LOAD_DENOMINATOR 4

// Empty hash slot sentinel (slots hold indices into `entries`, or this).
#define MAL_TABLE_EMPTY (-1)

typedef struct MalTableEntry {
    // The key's value only; the equality domain (MalKeyKind) is derived on read
    // via mal_key_kind_of, so an entry needs no separate 4-byte kind field.
    MalValue key;
    void *data;
    MalValue value;
    bool live;
} MalTableEntry;

// One per Map/Set/dictionary entry; must stay in the 32-byte size class.
static_assert(sizeof(MalTableEntry) <= 32, "MalTableEntry outgrew its 32-byte size class");

/**
 * Insertion-ordered open-addressed table. `entries` holds the entries inline in
 * insertion order (append-only; a delete tombstones in place via `live`), and
 * `slots` is the open-addressed hash — each slot is an INDEX into `entries` (or
 * MAL_TABLE_EMPTY). Entry handles and iterators are therefore entry INDICES, not
 * pointers, so they survive a realloc of `entries` on growth; only mal_table_compact
 * renumbers, and (like the former per-entry-pointer scheme) it must not run while a
 * handle/iterator is outstanding — which is why an iterated table (Map/Set) never
 * compacts. This replaces the previous representation (an array of pointers to
 * individually malloc'd entries plus a parallel order array): one contiguous
 * allocation, no per-entry malloc, and 4-byte slot indices instead of 8-byte
 * pointers.
 */
typedef struct MalTable {
    MalTableMode mode;
    u32 size;            // live entries
    u32 tombstone_count; // dead entries still occupying an `entries` cell
    u32 slot_capacity;   // hash array length (power of two)
    u32 entry_count;     // used `entries` cells (live + tombstones); the append cursor
    u32 entry_capacity;  // allocated `entries` cells
    i32 *slots;
    MalTableEntry *entries;
} MalTable;

// Entry handles are 1-based indices boxed as void* (0/NULL means "no entry").
static inline void *mal_table_handle(u32 index) {
    return (void *) (uptr) (index + 1);
}

static inline u32 mal_table_handle_index(const void *handle) {
    return (u32) ((uptr) handle - 1);
}

static u64 mal_table_hash_mix(u64 value) {
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9;
    value ^= value >> 27;
    value *= 0x94d049bb133111eb;
    value ^= value >> 31;

    return value;
}

// Hash and equality operate directly on the stored key value (kind-free): the
// value's bits already encode its class (an int32 INDEX never bit-equals an
// f64 NUMBER, etc.), so two keys are equal iff their values are bit-equal — or,
// for two distinct string pointers, equal by code units. This is behaviour-
// identical to the former kind-guarded comparison but needs no stored kind.
static u64 mal_table_hash_value(MalValue value) {
    if (mal_value_is_string(value)) {
        return mal_table_hash_mix(mal_string_hash(mal_value_to_string(value)));
    }

    return mal_table_hash_mix(value);
}

static bool mal_table_value_equals(MalValue left, MalValue right) {
    if (left == right) {
        return true;
    }

    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }

    return false;
}

// The hash slot for `key`: either the slot holding a live entry equal to `key`,
// or the first empty slot on its probe chain (slots only ever reference live
// entries — a delete rebuilds the chains — so probing stops at the first empty).
static usize mal_table_find_slot(const MalTable *table, MalValue key) {
    usize mask = table->slot_capacity - 1;
    usize index = mal_table_hash_value(key) & mask;

    while (table->slots[index] != MAL_TABLE_EMPTY) {
        MalTableEntry *entry = &table->entries[table->slots[index]];
        if (entry->live && mal_table_value_equals(entry->key, key)) {
            break;
        }

        index = (index + 1) & mask;
    }

    return index;
}

static void mal_table_rehash(MalTable *table, u32 capacity) {
    i32 *slots = malloc(capacity * sizeof(i32));
    for (u32 i = 0; i < capacity; i++) {
        slots[i] = MAL_TABLE_EMPTY;
    }

    usize mask = capacity - 1;
    for (u32 e = 0; e < table->entry_count; e++) {
        if (!table->entries[e].live) {
            continue;
        }
        usize index = mal_table_hash_value(table->entries[e].key) & mask;
        while (slots[index] != MAL_TABLE_EMPTY) {
            index = (index + 1) & mask;
        }
        slots[index] = (i32) e;
    }

    free(table->slots);
    table->slots = slots;
    table->slot_capacity = capacity;
}

static void mal_table_grow_slots_if_needed(MalTable *table) {
    usize used_size = table->size + 1;

    if (used_size * MAL_TABLE_MAX_LOAD_DENOMINATOR <= table->slot_capacity * MAL_TABLE_MAX_LOAD_NUMERATOR) {
        return;
    }

    mal_table_rehash(table, table->slot_capacity * 2);
}

// Grows `entries` when the append cursor reaches capacity. The realloc may move
// the buffer, but handles/iterators are indices, so they stay valid.
static void mal_table_grow_entries_if_needed(MalTable *table) {
    if (table->entry_count < table->entry_capacity) {
        return;
    }

    table->entry_capacity *= 2;
    table->entries = realloc(table->entries, sizeof(MalTableEntry) * table->entry_capacity);
}

MalTable *mal_table_new(MalTableMode mode) {
    MalTable *table = malloc(sizeof(MalTable));

    table->mode = mode;
    table->size = 0;
    table->tombstone_count = 0;
    table->slot_capacity = MAL_TABLE_MIN_CAPACITY;
    table->entry_count = 0;
    table->entry_capacity = MAL_TABLE_MIN_CAPACITY;
    table->slots = malloc(table->slot_capacity * sizeof(i32));
    for (u32 i = 0; i < table->slot_capacity; i++) {
        table->slots[i] = MAL_TABLE_EMPTY;
    }
    table->entries = malloc(table->entry_capacity * sizeof(MalTableEntry));

    return table;
}

void mal_table_free(MalTable *table) {
    // Owned descriptor data is held by every occupied cell (live or tombstoned)
    // until compact/free, so release all of them.
    for (u32 e = 0; e < table->entry_count; e++) {
        free(table->entries[e].data);
    }

    free(table->slots);
    free(table->entries);
    free(table);
}

MalTableMode mal_table_mode(const MalTable *table) {
    return table->mode;
}

usize mal_table_size(const MalTable *table) {
    return table->size;
}

MalTableLookup mal_table_lookup(const MalTable *table, MalKey key) {
    usize index = mal_table_find_slot(table, key.value);
    i32 entry = table->slots[index];

    if (entry == MAL_TABLE_EMPTY) {
        return (MalTableLookup) {.present = false, .entry = nullptr};
    }

    return (MalTableLookup) {.present = true, .entry = mal_table_handle((u32) entry)};
}

void *mal_table_upsert_entry(MalTable *table, MalKey key) {
    usize index = mal_table_find_slot(table, key.value);
    if (table->slots[index] != MAL_TABLE_EMPTY) {
        return mal_table_handle((u32) table->slots[index]);
    }

    // Grow first (both may reallocate / rehash), then re-find the now-valid slot.
    mal_table_grow_entries_if_needed(table);
    mal_table_grow_slots_if_needed(table);
    index = mal_table_find_slot(table, key.value);

    u32 entry_index = table->entry_count++;
    MalTableEntry *entry = &table->entries[entry_index];
    entry->key = key.value;
    entry->data = nullptr;
    entry->value = mal_value_new_undefined();
    entry->live = true;

    table->slots[index] = (i32) entry_index;
    table->size++;

    return mal_table_handle(entry_index);
}

bool mal_table_delete(MalTable *table, MalKey key) {
    usize index = mal_table_find_slot(table, key.value);
    i32 entry_index = table->slots[index];

    if (entry_index == MAL_TABLE_EMPTY) {
        return false;
    }

    MalTableEntry *entry = &table->entries[entry_index];

    // SATB obligation: a RAW table is traced via its
    // owner but mutated independently, so a key/value dropped mid-cycle must be
    // shaded or it could be lost. Generic here (key + inline value); the property
    // MOP shades a deleted descriptor's value/getter/setter. Folds out off-cycle.
    mal_gc_write_barrier(entry->key);
    mal_gc_write_barrier(entry->value);

    // Tombstone the cell in place (keeps insertion order / outstanding indices
    // valid); the sweep-out of dead cells happens in compact.
    entry->live = false;
    table->size--;
    table->tombstone_count++;

    // Removing from an open-addressed table can break probe chains, so rebuild them.
    mal_table_rehash(table, table->slot_capacity);

    return true;
}

void mal_table_clear(MalTable *table) {
    for (u32 e = 0; e < table->entry_count; e++) {
        if (table->entries[e].live) {
            // SATB: shade each dropped key/value (see mal_table_delete).
            mal_gc_write_barrier(table->entries[e].key);
            mal_gc_write_barrier(table->entries[e].value);
            table->entries[e].live = false;
            table->tombstone_count++;
        }
    }

    table->size = 0;

    for (u32 i = 0; i < table->slot_capacity; i++) {
        table->slots[i] = MAL_TABLE_EMPTY;
    }
}

void mal_table_compact(MalTable *table) {
    u32 write_index = 0;

    for (u32 read_index = 0; read_index < table->entry_count; read_index++) {
        MalTableEntry *entry = &table->entries[read_index];

        if (!entry->live) {
            free(entry->data);
            continue;
        }

        if (write_index != read_index) {
            table->entries[write_index] = *entry;
        }
        write_index++;
    }

    table->entry_count = write_index;
    table->tombstone_count = 0;
    mal_table_rehash(table, table->slot_capacity);
}

MalKey mal_table_entry_key(const MalTable *table, void *entry) {
    return mal_key_from_value(table->entries[mal_table_handle_index(entry)].key);
}

void *mal_table_entry_data(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].data;
}

void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data) {
    table->entries[mal_table_handle_index(entry)].data = data;
}

MalValue mal_table_entry_value(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].value;
}

void mal_table_entry_set_value(MalTable *table, void *entry, MalValue value) {
    table->entries[mal_table_handle_index(entry)].value = value;
}

bool mal_table_entry_is_live(const MalTable *table, const void *entry) {
    return table->entries[mal_table_handle_index(entry)].live;
}

void mal_table_iter_init(MalTableIter *iter, MalTable *table, MalTableIterKind kind) {
    iter->table = table;
    iter->kind = kind;
    iter->index = 0;
}

bool mal_table_iter_next(MalTableIter *iter, MalKey *key_out, void **entry_out) {
    while (iter->index < iter->table->entry_count) {
        u32 entry_index = (u32) iter->index++;
        MalTableEntry *entry = &iter->table->entries[entry_index];

        if (!entry->live) {
            continue;
        }

        *key_out = mal_key_from_value(entry->key);
        *entry_out = mal_table_handle(entry_index);

        return true;
    }

    return false;
}
