#include "intern_store.h"

#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "hash_index.h"
#include "key.h"
#include "perf_stats.h"
#include "profile.h"

static u32 mal_intern_grown_capacity(u32 capacity) {
    if (capacity == 0) return MAL_HASH_GROUP_WIDTH;
    if (capacity > UINT32_MAX / 2) abort();
    return capacity * 2;
}

static void *mal_intern_allocate(u32 capacity, usize width, MalPerfInternStoreKind kind) {
    if ((usize) capacity > SIZE_MAX / (width + sizeof(u8))) abort();
    usize bytes = (usize) capacity * (width + sizeof(u8));
    void *buckets = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), bytes, MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    memset((u8 *) buckets + (usize) capacity * width, MAL_HASH_EMPTY, capacity);
    MAL_PERF_COUNT(intern_stores[kind].grows);
    MAL_PERF_ADD(intern_stores[kind].allocation_bytes,
        mal_heap_raw_capacity(mal_gc_current_heap(), buckets));
    return buckets;
}

static u64 mal_intern_hash(const MalString *string) {
    return mal_key_hash_mix(mal_string_hash(string));
}

static u8 *mal_atom_store_controls(const MalAtomStore *store) {
    return (u8 *) (store->buckets + store->capacity);
}

static u32 mal_atom_store_slot(const MalAtomStore *store, const MalString *probe, u64 hash) {
    const u8 *controls = mal_atom_store_controls(store);
    MalHashProbe probe_state = mal_hash_probe(hash, store->capacity);
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].groups);
        MalHashMask matches = mal_hash_group_match(controls + probe_state.group, mal_hash_tag(hash));
        while (matches != 0) {
            u32 slot = probe_state.group + mal_hash_mask_first(matches);
            MAL_PERF_COUNT(hash_index_candidates);
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].candidates);
            MalString *candidate = store->buckets[slot];
            if (candidate == probe || mal_string_equals(candidate, probe)) return slot;
            matches &= matches - 1;
        }
        MalHashMask empty = mal_hash_group_match(controls + probe_state.group, MAL_HASH_EMPTY);
        if (empty != 0) return probe_state.group + mal_hash_mask_first(empty);
        mal_hash_probe_next(&probe_state);
    }
}

static void mal_atom_store_grow(MalAtomStore *store) {
    MalAtomStore grown = {
        .size = store->size,
        .capacity = mal_intern_grown_capacity(store->capacity),
    };
    grown.buckets = mal_intern_allocate(grown.capacity, sizeof(*grown.buckets), MAL_PERF_INTERN_ATOMS);
    u8 *controls = mal_atom_store_controls(&grown);
    const u8 *old_controls = store->capacity == 0 ? nullptr : mal_atom_store_controls(store);
    for (u32 i = 0; i < store->capacity; i++) {
        if (old_controls[i] == MAL_HASH_EMPTY) continue;
        MalString *entry = store->buckets[i];
        u64 hash = mal_intern_hash(entry);
        u32 slot = mal_hash_controls_empty_slot(controls, grown.capacity, hash);
        grown.buckets[slot] = entry;
        controls[slot] = mal_hash_tag(hash);
    }
    MAL_PERF_COUNT(hash_index_rebuilds);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_ATOMS].rehash_entries, store->size);
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = grown;
}

MalString *mal_atom_store_find(const MalAtomStore *store, const MalString *probe) {
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].lookups);
    if (store->size != 0) {
        u32 slot = mal_atom_store_slot(store, probe, mal_intern_hash(probe));
        if (mal_atom_store_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].hits);
            return store->buckets[slot];
        }
    }
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].misses);
    return nullptr;
}

MalString *mal_atom_store_intern(MalAtomStore *store, MalString *candidate) {
    u64 hash = mal_intern_hash(candidate);
    u32 slot = 0;
    if (store->size != 0) {
        slot = mal_atom_store_slot(store, candidate, hash);
        if (mal_atom_store_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].insert_hits);
            MalString *canonical = store->buckets[slot];
            canonical->property_atom = true;
            return canonical;
        }
    }
    if (!mal_hash_index_fits((usize) store->size + 1, store->capacity)) {
        mal_atom_store_grow(store);
        slot = mal_hash_controls_empty_slot(mal_atom_store_controls(store), store->capacity, hash);
    }
    candidate->property_atom = true;
    store->buckets[slot] = candidate;
    mal_atom_store_controls(store)[slot] = mal_hash_tag(hash);
    store->size++;
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_ATOMS].inserts);
    return candidate;
}

MalString *mal_atom_store_next(const MalAtomStore *store, u32 *cursor) {
    if (store->capacity == 0) return nullptr;
    const u8 *controls = mal_atom_store_controls(store);
    while (*cursor < store->capacity) {
        u32 slot = (*cursor)++;
        if (controls[slot] != MAL_HASH_EMPTY) return store->buckets[slot];
    }
    return nullptr;
}

usize mal_atom_store_size(const MalAtomStore *store) {
    return store->size;
}

usize mal_atom_store_capacity(const MalAtomStore *store) {
    return store->capacity;
}

usize mal_atom_store_allocation_bytes(const MalAtomStore *store) {
    return store->buckets == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), store->buckets);
}

void mal_atom_store_free(MalAtomStore *store) {
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = (MalAtomStore) {0};
}

static u8 *mal_symbol_registry_controls(const MalSymbolRegistry *store) {
    return (u8 *) (store->buckets + store->capacity);
}

static u32 mal_symbol_registry_slot(const MalSymbolRegistry *store, const MalString *description, u64 hash) {
    const u8 *controls = mal_symbol_registry_controls(store);
    MalHashProbe probe_state = mal_hash_probe(hash, store->capacity);
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].groups);
        MalHashMask matches = mal_hash_group_match(controls + probe_state.group, mal_hash_tag(hash));
        while (matches != 0) {
            u32 slot = probe_state.group + mal_hash_mask_first(matches);
            MAL_PERF_COUNT(hash_index_candidates);
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].candidates);
            MalString *candidate = store->buckets[slot]->description;
            if (candidate == description || mal_string_equals(candidate, description)) return slot;
            matches &= matches - 1;
        }
        MalHashMask empty = mal_hash_group_match(controls + probe_state.group, MAL_HASH_EMPTY);
        if (empty != 0) return probe_state.group + mal_hash_mask_first(empty);
        mal_hash_probe_next(&probe_state);
    }
}

static void mal_symbol_registry_grow(MalSymbolRegistry *store) {
    MalSymbolRegistry grown = {
        .size = store->size,
        .capacity = mal_intern_grown_capacity(store->capacity),
    };
    grown.buckets = mal_intern_allocate(grown.capacity, sizeof(*grown.buckets), MAL_PERF_INTERN_SYMBOL_REGISTRY);
    u8 *controls = mal_symbol_registry_controls(&grown);
    const u8 *old_controls = store->capacity == 0 ? nullptr : mal_symbol_registry_controls(store);
    for (u32 i = 0; i < store->capacity; i++) {
        if (old_controls[i] == MAL_HASH_EMPTY) continue;
        MalSymbol *entry = store->buckets[i];
        u64 hash = mal_intern_hash(entry->description);
        u32 slot = mal_hash_controls_empty_slot(controls, grown.capacity, hash);
        grown.buckets[slot] = entry;
        controls[slot] = mal_hash_tag(hash);
    }
    MAL_PERF_COUNT(hash_index_rebuilds);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].rehash_entries, store->size);
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = grown;
}

MalSymbol *mal_symbol_registry_find(const MalSymbolRegistry *store, const MalString *description) {
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].lookups);
    if (store->size != 0) {
        u32 slot = mal_symbol_registry_slot(store, description, mal_intern_hash(description));
        if (mal_symbol_registry_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].hits);
            return store->buckets[slot];
        }
    }
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].misses);
    return nullptr;
}

MalSymbol *mal_symbol_registry_insert(MalSymbolRegistry *store, MalSymbol *candidate) {
    u64 hash = mal_intern_hash(candidate->description);
    u32 slot = 0;
    if (store->size != 0) {
        slot = mal_symbol_registry_slot(store, candidate->description, hash);
        if (mal_symbol_registry_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].insert_hits);
            MalSymbol *canonical = store->buckets[slot];
            canonical->registered = true;
            return canonical;
        }
    }
    if (!mal_hash_index_fits((usize) store->size + 1, store->capacity)) {
        mal_symbol_registry_grow(store);
        slot = mal_hash_controls_empty_slot(mal_symbol_registry_controls(store), store->capacity, hash);
    }
    candidate->registered = true;
    store->buckets[slot] = candidate;
    mal_symbol_registry_controls(store)[slot] = mal_hash_tag(hash);
    store->size++;
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_SYMBOL_REGISTRY].inserts);
    return candidate;
}

MalSymbol *mal_symbol_registry_next(const MalSymbolRegistry *store, u32 *cursor) {
    if (store->capacity == 0) return nullptr;
    const u8 *controls = mal_symbol_registry_controls(store);
    while (*cursor < store->capacity) {
        u32 slot = (*cursor)++;
        if (controls[slot] != MAL_HASH_EMPTY) return store->buckets[slot];
    }
    return nullptr;
}

usize mal_symbol_registry_size(const MalSymbolRegistry *store) {
    return store->size;
}

usize mal_symbol_registry_capacity(const MalSymbolRegistry *store) {
    return store->capacity;
}

usize mal_symbol_registry_allocation_bytes(const MalSymbolRegistry *store) {
    return store->buckets == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), store->buckets);
}

void mal_symbol_registry_free(MalSymbolRegistry *store) {
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = (MalSymbolRegistry) {0};
}

static u8 *mal_native_source_cache_controls(const MalNativeSourceCache *store) {
    return (u8 *) (store->buckets + store->capacity);
}

static u32 mal_native_source_cache_slot(const MalNativeSourceCache *store, const MalString *name, u64 hash) {
    const u8 *controls = mal_native_source_cache_controls(store);
    MalHashProbe probe_state = mal_hash_probe(hash, store->capacity);
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].groups);
        MalHashMask matches = mal_hash_group_match(controls + probe_state.group, mal_hash_tag(hash));
        while (matches != 0) {
            u32 slot = probe_state.group + mal_hash_mask_first(matches);
            MAL_PERF_COUNT(hash_index_candidates);
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].candidates);
            MalString *candidate = store->buckets[slot].name;
            if (candidate == name || mal_string_equals(candidate, name)) return slot;
            matches &= matches - 1;
        }
        MalHashMask empty = mal_hash_group_match(controls + probe_state.group, MAL_HASH_EMPTY);
        if (empty != 0) return probe_state.group + mal_hash_mask_first(empty);
        mal_hash_probe_next(&probe_state);
    }
}

static void mal_native_source_cache_grow(MalNativeSourceCache *store) {
    MalNativeSourceCache grown = {
        .size = store->size,
        .capacity = mal_intern_grown_capacity(store->capacity),
    };
    grown.buckets = mal_intern_allocate(grown.capacity, sizeof(*grown.buckets), MAL_PERF_INTERN_NATIVE_SOURCE_CACHE);
    u8 *controls = mal_native_source_cache_controls(&grown);
    const u8 *old_controls = store->capacity == 0 ? nullptr : mal_native_source_cache_controls(store);
    for (u32 i = 0; i < store->capacity; i++) {
        if (old_controls[i] == MAL_HASH_EMPTY) continue;
        MalNativeSourceEntry entry = store->buckets[i];
        u64 hash = mal_intern_hash(entry.name);
        u32 slot = mal_hash_controls_empty_slot(controls, grown.capacity, hash);
        grown.buckets[slot] = entry;
        controls[slot] = mal_hash_tag(hash);
    }
    MAL_PERF_COUNT(hash_index_rebuilds);
    MAL_PERF_ADD(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].rehash_entries, store->size);
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = grown;
}

MalString *mal_native_source_cache_find(const MalNativeSourceCache *store, const MalString *name) {
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].lookups);
    if (store->size != 0) {
        u32 slot = mal_native_source_cache_slot(store, name, mal_intern_hash(name));
        if (mal_native_source_cache_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].hits);
            return store->buckets[slot].source;
        }
    }
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].misses);
    return nullptr;
}

MalString *mal_native_source_cache_insert(MalNativeSourceCache *store, MalString *name, MalString *source) {
    u64 hash = mal_intern_hash(name);
    u32 slot = 0;
    if (store->size != 0) {
        slot = mal_native_source_cache_slot(store, name, hash);
        if (mal_native_source_cache_controls(store)[slot] != MAL_HASH_EMPTY) {
            MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].insert_hits);
            return store->buckets[slot].source;
        }
    }
    if (!mal_hash_index_fits((usize) store->size + 1, store->capacity)) {
        mal_native_source_cache_grow(store);
        slot = mal_hash_controls_empty_slot(mal_native_source_cache_controls(store), store->capacity, hash);
    }
    store->buckets[slot] = (MalNativeSourceEntry) {.name = name, .source = source};
    mal_native_source_cache_controls(store)[slot] = mal_hash_tag(hash);
    store->size++;
    MAL_PERF_COUNT(intern_stores[MAL_PERF_INTERN_NATIVE_SOURCE_CACHE].inserts);
    return source;
}

const MalNativeSourceEntry *mal_native_source_cache_next(const MalNativeSourceCache *store, u32 *cursor) {
    if (store->capacity == 0) return nullptr;
    const u8 *controls = mal_native_source_cache_controls(store);
    while (*cursor < store->capacity) {
        u32 slot = (*cursor)++;
        if (controls[slot] != MAL_HASH_EMPTY) return &store->buckets[slot];
    }
    return nullptr;
}

usize mal_native_source_cache_size(const MalNativeSourceCache *store) {
    return store->size;
}

usize mal_native_source_cache_capacity(const MalNativeSourceCache *store) {
    return store->capacity;
}

usize mal_native_source_cache_allocation_bytes(const MalNativeSourceCache *store) {
    return store->buckets == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), store->buckets);
}

void mal_native_source_cache_free(MalNativeSourceCache *store) {
    gc_free_raw(mal_gc_current_heap(), store->buckets);
    *store = (MalNativeSourceCache) {0};
}
