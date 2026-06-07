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
 * Tagged key wrapper used by the ordered table substrate.
 */
typedef struct MalKey {
    MalKeyKind kind;
    MalValue value;
} MalKey;

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
