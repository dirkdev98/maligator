#include "./table.h"

#include <stdlib.h>

#include "./heap_string.h"

#define MAL_TABLE_MIN_CAPACITY 16
#define MAL_TABLE_MAX_LOAD_NUMERATOR 3
#define MAL_TABLE_MAX_LOAD_DENOMINATOR 4

typedef struct MalTableEntry {
    MalKey key;
    bool live;
} MalTableEntry;

typedef struct MalTable {
    MalTableMode mode;
    usize size;
    usize tombstone_count;
    usize slot_capacity;
    usize order_capacity;
    MalTableEntry **slots;
    MalTableEntry **order;
} MalTable;

static u64 mal_table_hash_mix(u64 value) {
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9;
    value ^= value >> 27;
    value *= 0x94d049bb133111eb;
    value ^= value >> 31;

    return value;
}

static u64 mal_table_hash_key(MalKey key) {
    u64 hash = mal_table_hash_mix((u64) key.kind);

    if (key.kind == MAL_KEY_STRING) {
        const MalString *string = mal_value_to_string(key.value);
        const byte *bytes = string->bytes;
        usize length = string->length;

        // FNV-1a keeps string hashing simple while the table substrate is young.
        hash ^= 0xcbf29ce484222325;
        for (usize i = 0; i < length; i++) {
            hash ^= (u8) bytes[i];
            hash *= 0x100000001b3;
        }

        return mal_table_hash_mix(hash);
    }

    return mal_table_hash_mix(hash ^ key.value);
}

static bool mal_table_key_equals(MalKey left, MalKey right) {
    if (left.kind != right.kind) {
        return false;
    }

    if (left.kind != MAL_KEY_STRING) {
        return left.value == right.value;
    }

    const MalString *left_string = mal_value_to_string(left.value);
    const MalString *right_string = mal_value_to_string(right.value);
    usize length = left_string->length;

    if (length != right_string->length) {
        return false;
    }

    const byte *left_bytes = left_string->bytes;
    const byte *right_bytes = right_string->bytes;

    for (usize i = 0; i < length; i++) {
        if (left_bytes[i] != right_bytes[i]) {
            return false;
        }
    }

    return true;
}

static usize mal_table_find_slot(MalTableEntry **slots, usize capacity, MalKey key) {
    usize index = mal_table_hash_key(key) & (capacity - 1);

    while (slots[index] != nullptr) {
        if (slots[index]->live && mal_table_key_equals(slots[index]->key, key)) {
            break;
        }

        index = (index + 1) & (capacity - 1);
    }

    return index;
}

static void mal_table_insert_slot(MalTableEntry **slots, usize capacity, MalTableEntry *entry) {
    usize index = mal_table_find_slot(slots, capacity, entry->key);
    slots[index] = entry;
}

static void mal_table_rehash(MalTable *table, usize capacity) {
    MalTableEntry **slots = calloc(capacity, sizeof(MalTableEntry *));

    for (usize i = 0; i < table->order_capacity; i++) {
        MalTableEntry *entry = table->order[i];

        if (entry != nullptr && entry->live) {
            mal_table_insert_slot(slots, capacity, entry);
        }
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

static void mal_table_grow_order_if_needed(MalTable *table) {
    usize used_size = table->size + table->tombstone_count;

    if (used_size < table->order_capacity) {
        return;
    }

    usize capacity = table->order_capacity * 2;
    table->order = realloc(table->order, sizeof(MalTableEntry *) * capacity);

    for (usize i = table->order_capacity; i < capacity; i++) {
        table->order[i] = nullptr;
    }

    table->order_capacity = capacity;
}

MalTable *mal_table_new(MalTableMode mode) {
    MalTable *table = malloc(sizeof(MalTable));

    table->mode = mode;
    table->size = 0;
    table->tombstone_count = 0;
    table->slot_capacity = MAL_TABLE_MIN_CAPACITY;
    table->order_capacity = MAL_TABLE_MIN_CAPACITY;
    table->slots = calloc(table->slot_capacity, sizeof(MalTableEntry *));
    table->order = calloc(table->order_capacity, sizeof(MalTableEntry *));

    return table;
}

void mal_table_free(MalTable *table) {
    for (usize i = 0; i < table->order_capacity; i++) {
        free(table->order[i]);
    }

    free(table->slots);
    free(table->order);
    free(table);
}

MalTableMode mal_table_mode(const MalTable *table) {
    return table->mode;
}

usize mal_table_size(const MalTable *table) {
    return table->size;
}

MalTableLookup mal_table_lookup(const MalTable *table, MalKey key) {
    usize index = mal_table_find_slot(table->slots, table->slot_capacity, key);
    MalTableEntry *entry = table->slots[index];

    if (entry == nullptr) {
        return (MalTableLookup) {.present = false, .entry = nullptr};
    }

    return (MalTableLookup) {.present = true, .entry = entry};
}

void *mal_table_upsert_entry(MalTable *table, MalKey key) {
    MalTableLookup lookup = mal_table_lookup(table, key);

    if (lookup.present) {
        return lookup.entry;
    }

    mal_table_grow_slots_if_needed(table);
    mal_table_grow_order_if_needed(table);

    MalTableEntry *entry = malloc(sizeof(MalTableEntry));
    entry->key = key;
    entry->live = true;

    table->order[table->size + table->tombstone_count] = entry;
    table->size++;

    mal_table_insert_slot(table->slots, table->slot_capacity, entry);

    return entry;
}

bool mal_table_delete(MalTable *table, MalKey key) {
    usize index = mal_table_find_slot(table->slots, table->slot_capacity, key);
    MalTableEntry *entry = table->slots[index];

    if (entry == nullptr) {
        return false;
    }

    entry->live = false;
    table->slots[index] = nullptr;
    table->size--;
    table->tombstone_count++;

    // Removing from an open-addressed table can break probe chains, so rebuild them.
    mal_table_rehash(table, table->slot_capacity);

    return true;
}

void mal_table_compact(MalTable *table) {
    usize write_index = 0;

    for (usize read_index = 0; read_index < table->order_capacity; read_index++) {
        MalTableEntry *entry = table->order[read_index];

        if (entry == nullptr) {
            continue;
        }

        if (!entry->live) {
            free(entry);
            table->order[read_index] = nullptr;
            continue;
        }

        table->order[write_index] = entry;
        write_index++;
    }

    for (usize i = write_index; i < table->order_capacity; i++) {
        table->order[i] = nullptr;
    }

    table->tombstone_count = 0;
    mal_table_rehash(table, table->slot_capacity);
}

void mal_table_iter_init(MalTableIter *iter, MalTable *table, MalTableIterKind kind) {
    iter->table = table;
    iter->kind = kind;
    iter->index = 0;
}

bool mal_table_iter_next(MalTableIter *iter, MalKey *key_out, void **entry_out) {
    while (iter->index < iter->table->order_capacity) {
        MalTableEntry *entry = iter->table->order[iter->index];
        iter->index++;

        if (entry == nullptr || !entry->live) {
            continue;
        }

        *key_out = entry->key;
        *entry_out = entry;

        return true;
    }

    return false;
}
