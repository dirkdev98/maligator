#pragma once

#include "./defaults.h"
#include "./key.h"

typedef struct MalTable MalTable;
typedef struct MalSymbol MalSymbol;

#define MAL_TABLE_KIND_SHIFT 48
#define MAL_TABLE_KIND_MASK (UINT64_C(3) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_INDEX (UINT64_C(1) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_STRING (UINT64_C(2) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_SYMBOL (UINT64_C(3) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_IDENTITY_MASK (UINT64_C(0x0000ffffffffffff) | MAL_TABLE_KIND_MASK)

typedef struct MalTableEntry {
    // Kind zero is dead; ownership survives deletion until the RAW sidecar is freed.
    u64 key;
    union {
        void *data;
        MalValue value;
    } payload;
} MalTableEntry;

// Ordered entry indices survive buffer growth; only unpinned compaction renumbers handles.
// The layout is public only so private-element reads can probe their hint inline.
struct MalTable {
    u64 handle_epoch;
    u32 size;
    u32 tombstone_count;
    u32 slot_capacity;
    u32 deleted_slots;
    u32 entry_count;
    u32 entry_capacity;
    u32 iterator_pins;
    i32 *slots;
    MalTableEntry *entries;
};

/**
 * Read a private element through a symbol's 1-based entry hint. Exact identity of
 * the stored key makes a hint safe across receivers, growth, and compaction.
 */
static inline bool mal_table_private_hint_read(
    const MalTable *table, MalValue symbol, u32 hint, MalValue *value
) {
    u32 index = hint - 1;
    if (index >= table->entry_count) return false;
    const MalTableEntry *entry = &table->entries[index];
    if ((entry->key & MAL_TABLE_IDENTITY_MASK) != (MAL_TABLE_SYMBOL | (symbol & MAKS_PTR)))
        return false;
    *value = entry->payload.value;
    return true;
}

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

// Keys are INDEX (0..2^32-2), STRING, or SYMBOL. Borrowed query strings are never retained.
// Inserted strings must outlive their entries; equal insertions preserve the stored representative.
MalTable *mal_table_new(void);

void mal_table_free(MalTable *table);

usize mal_table_size(const MalTable *table);

/**
 * Ensure appending until `desired_size` live entries needs no entry-buffer or
 * hash-slot growth. Existing handles and insertion-order indices stay valid.
 * Returns false when the requested capacity cannot be represented.
 */
bool mal_table_reserve(MalTable *table, usize desired_size);

/**
 * Numeric INDEX spellings normalize; STRING content and SYMBOL identity remain distinct.
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

/* The pure predicate may run twice; it must not allocate, mutate the table, or
 * reenter GC. Surviving entry handles and insertion order remain valid. */
usize mal_table_retain(MalTable *table, bool (*keep)(MalValue key));

// Pinned storage-order cursors retain their positions through clear and later appends.
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
