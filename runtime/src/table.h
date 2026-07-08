#pragma once

#include "./defaults.h"
#include "./value.h"

typedef struct MalTable MalTable;

/**
 * Storage mode carried by a table instance.
 */
typedef enum MalTableMode {
    MAL_TABLE_MODE_OBJECT,
    MAL_TABLE_MODE_GENERAL,
} MalTableMode;

/**
 * Equality domain for a stored key.
 */
typedef enum MalKeyKind {
    MAL_KEY_INDEX,
    MAL_KEY_STRING,
    MAL_KEY_SYMBOL,
    MAL_KEY_NUMBER,
    MAL_KEY_OBJECT,
    /**
     * Statically encoded values (true/false/null/undefined) keyed by their
     * bit pattern. Used by general-mode tables (Map/Set keys).
     */
    MAL_KEY_STATIC,
} MalKeyKind;

/**
 * Tagged key wrapper used by the ordered table substrate. `kind` is fully
 * determined by `value` (see mal_key_kind_of) — it is a transient convenience on
 * the by-value argument type, NOT stored per entry: the substrate stores only the
 * 8-byte `value` and reconstructs the kind on read.
 */
typedef struct MalKey {
    MalKeyKind kind;
    MalValue value;
} MalKey;

/**
 * Derive a key's equality domain from its value's NaN-boxing class. The map key
 * canonicalizer (mal_map_key_from_value) and every property-key constructor pick
 * a kind consistent with this, so a stored key needs only its value: an integer
 * index is int32-encoded (INDEX); a numeric Map key is always f64-encoded
 * (NUMBER, never colliding with an int32 INDEX); strings/symbols/objects carry
 * their own class; null/undefined/true/false are STATIC.
 */
static inline MalKeyKind mal_key_kind_of(MalValue value) {
    if (mal_value_is_string(value)) {
        return MAL_KEY_STRING;
    }
    if (mal_value_is_symbol(value)) {
        return MAL_KEY_SYMBOL;
    }
    if (mal_value_is_object(value)) {
        return MAL_KEY_OBJECT;
    }
    if (mal_value_is_int32(value)) {
        return MAL_KEY_INDEX;
    }
    if (mal_value_is_nil(value) || mal_value_is_boolean(value)) {
        return MAL_KEY_STATIC;
    }
    return MAL_KEY_NUMBER;
}

/** Reconstruct the full tagged key from a stored value. */
static inline MalKey mal_key_from_value(MalValue value) {
    return (MalKey) {.kind = mal_key_kind_of(value), .value = value};
}

/**
 * Physical iteration order exposed by the table substrate.
 */
typedef enum MalTableIterKind {
    MAL_TABLE_ITER_STORAGE,
} MalTableIterKind;

typedef struct MalTableIter {
    MalTable *table;
    MalTableIterKind kind;
    usize index;
} MalTableIter;

/**
 * Result of looking up a key in the ordered table.
 */
typedef struct MalTableLookup {
    bool present;
    void *entry;
} MalTableLookup;

/**
 * Create a new ordered table substrate.
 */
MalTable *mal_table_new(MalTableMode mode);

/**
 * Destroy a table previously created with mal_table_new.
 */
void mal_table_free(MalTable *table);

/**
 * Return the mode associated with the table.
 */
MalTableMode mal_table_mode(const MalTable *table);

/**
 * Return the number of live entries currently stored in the table.
 */
usize mal_table_size(const MalTable *table);

/**
 * Look up a key using the equality rule implied by key.kind.
 */
MalTableLookup mal_table_lookup(const MalTable *table, MalKey key);

/**
 * Insert a new entry for key, or return the existing live entry if present.
 */
void *mal_table_upsert_entry(MalTable *table, MalKey key);

/**
 * Delete a live entry if present.
 */
bool mal_table_delete(MalTable *table, MalKey key);

/**
 * Delete all live entries. Entries become tombstones rather than being
 * freed, so outstanding storage-order iterators stay valid and observe the
 * emptied table (Map.prototype.clear semantics).
 */
void mal_table_clear(MalTable *table);

/**
 * Rebuild internal hash and order structures to remove tombstones.
 */
void mal_table_compact(MalTable *table);

/**
 * Read the key stored for a live entry handle.
 */
MalKey mal_table_entry_key(const MalTable *table, void *entry);

/**
 * Read the data pointer stored for a live entry handle.
 */
void *mal_table_entry_data(const MalTable *table, void *entry);

/**
 * Replace the owned data pointer stored for a live entry handle.
 */
void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data);

/**
 * Read the inline value payload stored for an entry handle. The payload is
 * not owned storage (unlike the data pointer) and defaults to undefined.
 */
MalValue mal_table_entry_value(const MalTable *table, void *entry);

/**
 * Replace the inline value payload stored for a live entry handle.
 */
void mal_table_entry_set_value(MalTable *table, void *entry, MalValue value);

/**
 * Check whether an entry handle still refers to a live entry. Storage-order
 * iterators may outlive deletions, so callers holding entry handles use this
 * to detect tombstoned entries.
 */
bool mal_table_entry_is_live(const MalTable *table, const void *entry);

/**
 * Initialize a live storage-order iterator.
 */
void mal_table_iter_init(MalTableIter *iter, MalTable *table, MalTableIterKind kind);

/**
 * Advance a storage-order iterator.
 */
bool mal_table_iter_next(MalTableIter *iter, MalKey *key_out, void **entry_out);
