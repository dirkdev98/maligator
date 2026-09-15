#pragma once

#include "./defaults.h"
#include "./key.h"

typedef struct MalTable MalTable;
typedef struct MalSymbol MalSymbol;

/**
 * Storage mode carried by a table instance.
 */
typedef enum MalTableMode {
    MAL_TABLE_MODE_OBJECT,
    MAL_TABLE_MODE_GENERAL,
} MalTableMode;

/** Instrumentation role; storage semantics continue to come from MalTableMode. */
typedef enum MalTableRole {
    MAL_TABLE_ROLE_OBJECT,
    MAL_TABLE_ROLE_ATOMS,
    MAL_TABLE_ROLE_SYMBOL_REGISTRY,
    MAL_TABLE_ROLE_MAP,
    MAL_TABLE_ROLE_COUNT,
} MalTableRole;

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
MalTable *mal_table_new(MalTableMode mode, MalTableRole role);

/**
 * Destroy a table previously created with mal_table_new.
 */
void mal_table_free(MalTable *table);

/**
 * Release a Map/Set's ownership. If a dead iterator is still pinned during the
 * same GC sweep, defer the raw-table free until its finalizer drops the last pin.
 */
void mal_table_release_owner(MalTable *table);

/**
 * Return the mode associated with the table.
 */
MalTableMode mal_table_mode(const MalTable *table);

/**
 * Return the number of live entries currently stored in the table.
 */
usize mal_table_size(const MalTable *table);

/**
 * Ensure appending until `desired_size` live entries needs no entry-buffer or
 * hash-slot growth. Existing handles and insertion-order indices stay valid.
 * Returns false when the requested capacity cannot be represented.
 */
bool mal_table_reserve(MalTable *table, usize desired_size);

/**
 * Look up a key using the equality rule implied by key.kind.
 */
MalTableLookup mal_table_lookup(const MalTable *table, MalKey key);

// Private fields and compiler-managed brand markers always carry inline data values.
bool mal_table_get_private_value(const MalTable *table, MalSymbol *symbol, MalValue *value);

/**
 * Insert a new entry for key, or return the existing live entry if present.
 * When non-null, `inserted` reports which result was returned.
 */
void *mal_table_upsert_entry(MalTable *table, MalKey key, bool *inserted);

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

/** Prevent/re-enable entry renumbering while a persistent iterator is live. */
void mal_table_pin(MalTable *table);
void mal_table_unpin(MalTable *table);

/**
 * Read the key stored for a live entry handle.
 */
MalKey mal_table_entry_key(const MalTable *table, void *entry);

/**
 * Read the active owned-data pointer, or null for a value entry.
 */
void *mal_table_entry_data(const MalTable *table, void *entry);

/**
 * Replace the owned-data pointer stored for a live entry handle. Clearing it
 * switches the entry back to an undefined value payload; the caller frees the
 * prior owned allocation.
 */
void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data);

/** Compact property metadata carried inline by object-mode table entries. */
u8 mal_table_entry_property_flags(const MalTable *table, void *entry);
void mal_table_entry_set_property_flags(
    MalTable *table, void *entry, u8 flags);

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
 * Generation of entry handles. Growth preserves handles; compaction renumbers
 * them and advances this generation.
 */
u64 mal_table_handle_epoch(const MalTable *table);

/**
 * Validate a cached entry handle against its generation and exact key. Safe for
 * stale handles, including handles retained across compaction.
 */
bool mal_table_entry_matches(
    const MalTable *table, const void *entry, u64 handle_epoch, MalKey key
);

/** Validate a cached handle and its exact stored-key identity without hashing. */
bool mal_table_entry_matches_stored_key(
    const MalTable *table, const void *entry, u64 handle_epoch,
    MalValue stored_key
);

// Cross-table hints require a live value entry with exact key identity.
bool mal_table_read_entry_hint(
    const MalTable *table, const void *entry, MalValue key,
    MalValue *value, u8 *property_flags
);

/**
 * Initialize a live storage-order iterator.
 */
void mal_table_iter_init(MalTableIter *iter, MalTable *table, MalTableIterKind kind);

/**
 * Advance a storage-order iterator.
 */
bool mal_table_iter_next(MalTableIter *iter, MalKey *key_out, void **entry_out);
