#pragma once

#include "./defaults.h"
#include "table.h"

/**
 * Property flags stored alongside a descriptor-bearing table entry.
 */
typedef enum MalPropertyFlags {
    MAL_PROPERTY_NONE = 0,
    MAL_PROPERTY_WRITABLE = 1 << 0,
    MAL_PROPERTY_ENUMERABLE = 1 << 1,
    MAL_PROPERTY_CONFIGURABLE = 1 << 2,
    MAL_PROPERTY_ACCESSOR = 1 << 3,
} MalPropertyFlags;

/**
 * JS-flavored property descriptor payload stored over a table entry.
 */
typedef struct MalPropertyDesc {
    MalPropertyFlags flags;
    MalValue value;
    MalValue getter;
    MalValue setter;
} MalPropertyDesc;

/**
 * Result of resolving a property-backed entry.
 */
typedef struct MalPropertyLookup {
    bool present;
    void *entry;
    MalPropertyDesc desc;
} MalPropertyLookup;

typedef struct MalPropertyEnsure {
    bool inserted;
    void *entry;
    MalPropertyDesc desc;
} MalPropertyEnsure;

/**
 * Look up a property descriptor stored for key.
 */
MalPropertyLookup mal_property_lookup(const MalTable *table, MalKey key);

/** Ensure a property exists, initializing its descriptor only when inserted. */
MalPropertyEnsure mal_property_ensure(
    MalTable *table, MalKey key, const MalPropertyDesc *initial
);

/**
 * Define or replace the descriptor stored for key.
 */
void *mal_property_define(MalTable *table, MalKey key, const MalPropertyDesc *desc);

/**
 * Update only the value field of an existing data descriptor, or create a new
 * default data descriptor if the key is absent.
 */
void *mal_property_set_value(MalTable *table, MalKey key, MalValue value);

/**
 * Replace the descriptor payload for a previously resolved entry handle.
 */
void mal_property_write_entry(MalTable *table, void *entry, const MalPropertyDesc *desc);

/**
 * Read the canonical key for a previously resolved entry handle.
 */
MalKey mal_property_entry_key(const MalTable *table, void *entry);

/**
 * Read the descriptor payload for a previously resolved entry handle.
 */
MalPropertyDesc mal_property_entry_desc(const MalTable *table, void *entry);
