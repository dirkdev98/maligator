#pragma once

#include "defaults.h"
#include "heap_string.h"
#include "heap_symbol.h"

// Zero initialization creates an empty store; RAW buckets belong to the current VM heap.
typedef struct MalAtomStore {
    MalString **buckets;
    u32 size;
    u32 capacity;
} MalAtomStore;

typedef struct MalSymbolRegistry {
    MalSymbol **buckets;
    u32 size;
    u32 capacity;
} MalSymbolRegistry;

typedef struct MalNativeSourceEntry {
    MalString *name;
    MalString *source;
} MalNativeSourceEntry;

typedef struct MalNativeSourceCache {
    MalNativeSourceEntry *buckets;
    u32 size;
    u32 capacity;
} MalNativeSourceCache;

// Finds accept borrowed stack probes and never retain them. Intern retains only heap/immortal candidates.
MalString *mal_atom_store_find(const MalAtomStore *store, const MalString *probe);
MalString *mal_atom_store_intern(MalAtomStore *store, MalString *candidate);
MalSymbol *mal_symbol_registry_find(const MalSymbolRegistry *store, const MalString *description);
// The candidate must have an immutable, nonnull description; insertion marks the canonical symbol registered.
MalSymbol *mal_symbol_registry_insert(MalSymbolRegistry *store, MalSymbol *candidate);
MalString *mal_native_source_cache_find(const MalNativeSourceCache *store, const MalString *name);
// Inserted names and sources become strong VM roots; equal names preserve the first cached source.
MalString *mal_native_source_cache_insert(MalNativeSourceCache *store, MalString *name, MalString *source);

// Start at cursor zero; insertion invalidates traversal. These scans never pin or allocate.
MalString *mal_atom_store_next(const MalAtomStore *store, u32 *cursor);
MalSymbol *mal_symbol_registry_next(const MalSymbolRegistry *store, u32 *cursor);
const MalNativeSourceEntry *mal_native_source_cache_next(const MalNativeSourceCache *store, u32 *cursor);

usize mal_atom_store_size(const MalAtomStore *store);
usize mal_symbol_registry_size(const MalSymbolRegistry *store);
usize mal_native_source_cache_size(const MalNativeSourceCache *store);
usize mal_atom_store_capacity(const MalAtomStore *store);
usize mal_symbol_registry_capacity(const MalSymbolRegistry *store);
usize mal_native_source_cache_capacity(const MalNativeSourceCache *store);
// Allocator-charged RAW bytes exclude the descriptors embedded in MalVm.
usize mal_atom_store_allocation_bytes(const MalAtomStore *store);
usize mal_symbol_registry_allocation_bytes(const MalSymbolRegistry *store);
usize mal_native_source_cache_allocation_bytes(const MalNativeSourceCache *store);

// Release before the owning heap; no member cells are read during teardown.
void mal_atom_store_free(MalAtomStore *store);
void mal_symbol_registry_free(MalSymbolRegistry *store);
void mal_native_source_cache_free(MalNativeSourceCache *store);
