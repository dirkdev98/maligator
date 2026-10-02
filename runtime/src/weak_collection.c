#include "weak_collection.h"

#include <string.h>

#include "gc.h"
#include "hash_index.h"
#include "perf_stats.h"
#include "profile.h"

#define MAL_WEAK_INLINE_CAPACITY 4
#define MAL_WEAK_MAP_WIDTH (2 * sizeof(MalValue))
#define MAL_WEAK_SET_WIDTH sizeof(MalValue)

struct MalWeakStorage {
    void *buckets;
    u8 *controls;
    u32 size;
    u32 capacity;
    u32 deleted;
    u32 reserve_size;
    MalValue small[];
};

static_assert(sizeof(MalWeakStorage) + 4 * MAL_WEAK_MAP_WIDTH <= 96,
    "WeakMap descriptor outgrew its allocation class");
static_assert(sizeof(MalWeakStorage) + 4 * MAL_WEAK_SET_WIDTH <= 64,
    "WeakSet descriptor outgrew its allocation class");
static_assert(sizeof(MalWeakMapObject) <= 64, "WeakMap owner outgrew its allocation class");
static_assert(sizeof(MalWeakSetObject) <= 64, "WeakSet owner outgrew its allocation class");

static MalValue *mal_weak_row(const MalWeakStorage *storage, usize width, u32 index) {
    void *base = storage->buckets == nullptr ? (void *) storage->small : storage->buckets;
    return (MalValue *) ((u8 *) base + (usize) index * width);
}

static bool mal_weak_live(const MalWeakStorage *storage, u32 index) {
    return storage->buckets == nullptr ? index < storage->size : storage->controls[index] < MAL_HASH_EMPTY;
}

static bool mal_weak_capacity(usize members, usize width, u32 *out) {
    u32 capacity = MAL_HASH_GROUP_WIDTH;
    while (!mal_hash_index_fits(members, capacity)) {
        if (capacity > (u32) INT32_MAX / 2) return false;
        capacity *= 2;
    }
    if ((usize) capacity > SIZE_MAX / (width + sizeof(u8))) return false;
    *out = capacity;
    return true;
}

static MalWeakStorage *mal_weak_storage_new(usize width) {
    MalWeakStorage *storage = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), sizeof(MalWeakStorage) + MAL_WEAK_INLINE_CAPACITY * width,
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    *storage = (MalWeakStorage) {0};
    MAL_PERF_COUNT(weak_storage_descriptors[width == MAL_WEAK_MAP_WIDTH]);
    return storage;
}

static u32 mal_weak_find(const MalWeakStorage *storage, usize width, MalValue key, u64 hash) {
    if (storage->buckets == nullptr) {
        for (u32 i = 0; i < storage->size; i++) {
            if (mal_weak_row(storage, width, i)[0] == key) return i;
        }
        return storage->size;
    }
    MalHashProbe probe = mal_hash_probe(hash, storage->capacity);
    u32 available = UINT32_MAX;
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MalHashMask matches = mal_hash_group_match(storage->controls + probe.group, mal_hash_tag(hash));
        while (matches != 0) {
            u32 slot = probe.group + mal_hash_mask_first(matches);
            MAL_PERF_COUNT(hash_index_candidates);
            if (mal_weak_row(storage, width, slot)[0] == key) return slot;
            matches &= matches - 1;
        }
        if (available == UINT32_MAX) {
            MalHashMask deleted = mal_hash_group_match(storage->controls + probe.group, MAL_HASH_DELETED);
            if (deleted != 0) available = probe.group + mal_hash_mask_first(deleted);
        }
        MalHashMask empty = mal_hash_group_match(storage->controls + probe.group, MAL_HASH_EMPTY);
        if (empty != 0) return available == UINT32_MAX
            ? probe.group + mal_hash_mask_first(empty) : available;
        mal_hash_probe_next(&probe);
    }
}

static void mal_weak_rebuild(MalWeakStorage *storage, usize width, u32 capacity) {
    if ((usize) capacity > SIZE_MAX / (width + sizeof(u8))) abort();
    void *buckets = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), (usize) capacity * (width + sizeof(u8)),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    u8 *controls = (u8 *) buckets + (usize) capacity * width;
    memset(controls, MAL_HASH_EMPTY, capacity);
    u32 limit = storage->buckets == nullptr ? storage->size : storage->capacity;
    MAL_PERF_ADD(weak_storage_rebuild_scan_slots[width == MAL_WEAK_MAP_WIDTH], limit);
    for (u32 i = 0; i < limit; i++) {
        if (!mal_weak_live(storage, i)) continue;
        MalValue *row = mal_weak_row(storage, width, i);
        u64 hash = mal_key_hash_mix(row[0]);
        u32 slot = mal_hash_controls_empty_slot(controls, capacity, hash);
        memcpy((u8 *) buckets + (usize) slot * width, row, width);
        controls[slot] = mal_hash_tag(hash);
    }
    void *old = storage->buckets;
    storage->buckets = buckets;
    storage->controls = controls;
    storage->capacity = capacity;
    storage->deleted = 0;
    storage->reserve_size = 0;
    gc_free_raw(mal_gc_current_heap(), old);
    MAL_PERF_COUNT(weak_storage_rebuilds[width == MAL_WEAK_MAP_WIDTH]);
    MAL_PERF_ADD(weak_storage_payload_bytes[width == MAL_WEAK_MAP_WIDTH],
        (usize) capacity * (width + sizeof(u8)));
}

static void mal_weak_maintain(MalWeakStorage *storage, usize width, bool after_filter) {
    if (storage->buckets == nullptr) return;
    if (storage->size <= MAL_WEAK_INLINE_CAPACITY) {
        u32 next = 0;
        u32 scanned = 0;
        for (; scanned < storage->capacity && next < storage->size; scanned++) {
            if (!mal_weak_live(storage, scanned)) continue;
            memcpy((u8 *) storage->small + (usize) next++ * width,
                mal_weak_row(storage, width, scanned), width);
        }
        MAL_PERF_ADD(weak_storage_demotion_scan_slots[width == MAL_WEAK_MAP_WIDTH], scanned);
        gc_free_raw(mal_gc_current_heap(), storage->buckets);
        storage->buckets = nullptr;
        storage->controls = nullptr;
        storage->capacity = 0;
        storage->deleted = 0;
        storage->reserve_size = 0;
        MAL_PERF_COUNT(weak_storage_demotions[width == MAL_WEAK_MAP_WIDTH]);
    } else if (storage->capacity > MAL_HASH_GROUP_WIDTH && storage->size <= storage->capacity / 4) {
        u32 capacity;
        if (!mal_weak_capacity(storage->size, width, &capacity)) abort();
        mal_weak_rebuild(storage, width, capacity);
    } else if (after_filter && storage->deleted >= storage->capacity / 4) {
        mal_weak_rebuild(storage, width, storage->capacity);
    }
}

static u32 mal_weak_upsert(MalWeakStorage *storage, usize width, MalValue key, bool *inserted) {
    u64 hash = storage->buckets == nullptr ? 0 : mal_key_hash_mix(key);
    u32 slot = mal_weak_find(storage, width, key, hash);
    if (mal_weak_live(storage, slot)) {
        *inserted = false;
        return slot;
    }
    if (storage->buckets == nullptr && storage->size < MAL_WEAK_INLINE_CAPACITY) {
        MalValue *row = mal_weak_row(storage, width, slot);
        row[0] = key;
        if (width == MAL_WEAK_MAP_WIDTH) row[1] = MAL_VALUE_UNDEFINED;
        storage->size++;
        *inserted = true;
        return slot;
    }
    bool reuse = storage->buckets != nullptr && storage->controls[slot] == MAL_HASH_DELETED;
    usize members = storage->reserve_size > storage->size + 1 ? storage->reserve_size : storage->size + 1;
    if (storage->buckets == nullptr ||
        !mal_hash_index_fits(members + storage->deleted - reuse, storage->capacity)) {
        u32 capacity;
        if (!mal_weak_capacity(members, width, &capacity)) abort();
        if (storage->buckets == nullptr) MAL_PERF_COUNT(weak_storage_promotions[width == MAL_WEAK_MAP_WIDTH]);
        mal_weak_rebuild(storage, width, capacity);
        hash = mal_key_hash_mix(key);
        slot = mal_weak_find(storage, width, key, hash);
    }
    MalValue *row = mal_weak_row(storage, width, slot);
    row[0] = key;
    if (width == MAL_WEAK_MAP_WIDTH) row[1] = MAL_VALUE_UNDEFINED;
    if (storage->controls[slot] == MAL_HASH_DELETED) {
        storage->deleted--;
        MAL_PERF_COUNT(hash_index_tombstone_reuses);
    }
    storage->controls[slot] = mal_hash_tag(hash);
    storage->size++;
    *inserted = true;
    return slot;
}

static void mal_weak_erase(MalWeakStorage *storage, usize width, u32 slot) {
    MalValue *row = mal_weak_row(storage, width, slot);
    if (width == MAL_WEAK_MAP_WIDTH) {
        mal_gc_write_barrier(row[0]);
        mal_gc_write_barrier(row[1]);
    }
    if (storage->buckets == nullptr) {
        if (slot + 1 != storage->size) memcpy(row, mal_weak_row(storage, width, storage->size - 1), width);
    } else {
        storage->deleted += mal_hash_controls_erase(storage->controls, slot);
    }
    storage->size--;
}

static bool mal_weak_lookup(const MalWeakStorage *storage, usize width, MalValue key, u32 *slot) {
    if (storage == nullptr || storage->size == 0 || !mal_weak_key_can_be_held(key)) return false;
    *slot = mal_weak_find(storage, width, key, storage->buckets == nullptr ? 0 : mal_key_hash_mix(key));
    return mal_weak_live(storage, *slot);
}

static bool mal_weak_delete(MalWeakStorage *storage, usize width, MalValue key) {
    u32 slot;
    if (!mal_weak_lookup(storage, width, key, &slot)) return false;
    mal_weak_erase(storage, width, slot);
    mal_weak_maintain(storage, width, false);
    return true;
}

static bool mal_weak_reserve(MalWeakStorage **entries, usize width, usize desired_size) {
    u32 capacity;
    if (!mal_weak_capacity(desired_size, width, &capacity)) return false;
    if (desired_size == 0 || (*entries != nullptr && desired_size <= (*entries)->size)) return true;
    if (*entries == nullptr) *entries = mal_weak_storage_new(width);
    MalWeakStorage *storage = *entries;
    if (storage->buckets == nullptr) {
        if (desired_size > storage->reserve_size) storage->reserve_size = (u32) desired_size;
    } else if (capacity > storage->capacity) {
        mal_weak_rebuild(storage, width, capacity);
    }
    return true;
}

static usize mal_weak_retain(MalWeakStorage *storage, usize width, bool (*keep)(MalValue)) {
    if (storage == nullptr) return 0;
    usize before = storage->size;
    MAL_PERF_ADD(weak_storage_filter_scan_slots[width == MAL_WEAK_MAP_WIDTH],
        mal_weak_storage_scan_slots(storage));
    if (storage->buckets == nullptr) {
        for (u32 i = 0; i < storage->size;) {
            if (keep(mal_weak_row(storage, width, i)[0])) i++;
            else mal_weak_erase(storage, width, i);
        }
    } else {
        for (u32 i = 0; i < storage->capacity; i++) {
            if (mal_weak_live(storage, i) && !keep(mal_weak_row(storage, width, i)[0])) {
                mal_weak_erase(storage, width, i);
            }
        }
    }
    usize removed = before - storage->size;
    if (removed != 0) mal_weak_maintain(storage, width, true);
    MAL_PERF_ADD(weak_storage_filtered[width == MAL_WEAK_MAP_WIDTH], removed);
    return removed;
}

MalWeakMapObject *mal_weak_map_object_new(MalHeap *heap, MalObject *prototype) {
    MalWeakMapObject *map = mal_heap_alloc(heap, sizeof(MalWeakMapObject), MAL_HEAP_WEAK_MAP_OBJECT);
    mal_object_init(heap, &map->object, MAL_HEAP_WEAK_MAP_OBJECT, prototype);
    map->entries = nullptr;
    mal_perf_collection_new(map, MAL_PERF_COLLECTION_WEAK_MAP, heap->epoch);
    return map;
}

static MalValue mal_weak_map_store(MalWeakMapObject *map, MalValue key, MalValue value, bool preserve) {
    if (!mal_weak_key_can_be_held(key)) abort();
    if (map->entries == nullptr) map->entries = mal_weak_storage_new(MAL_WEAK_MAP_WIDTH);
    bool inserted;
    u32 slot = mal_weak_upsert(map->entries, MAL_WEAK_MAP_WIDTH, key, &inserted);
    MalValue *row = mal_weak_row(map->entries, MAL_WEAK_MAP_WIDTH, slot);
    if (!inserted && preserve) return row[1];
    mal_gc_write_barrier(row[1]);
    row[1] = value;
    mal_gc_card(&map->object.header, key);
    mal_gc_card(&map->object.header, value);
    if (inserted) mal_perf_collection_key_value(map, key);
    mal_perf_collection_mutation(map, map->entries->size);
    return value;
}

void mal_weak_map_object_set(MalWeakMapObject *map, MalValue key, MalValue value) {
    (void) mal_weak_map_store(map, key, value, false);
}

MalValue mal_weak_map_object_get_or_insert(MalWeakMapObject *map, MalValue key, MalValue value) {
    return mal_weak_map_store(map, key, value, true);
}

MalValue mal_weak_map_object_get(const MalWeakMapObject *map, MalValue key) {
    MalValue value;
    return mal_weak_map_object_lookup(map, key, &value) ? value : MAL_VALUE_UNDEFINED;
}

bool mal_weak_map_object_lookup(const MalWeakMapObject *map, MalValue key, MalValue *value) {
    u32 slot;
    if (!mal_weak_lookup(map->entries, MAL_WEAK_MAP_WIDTH, key, &slot)) return false;
    *value = mal_weak_row(map->entries, MAL_WEAK_MAP_WIDTH, slot)[1];
    return true;
}

bool mal_weak_map_object_has(const MalWeakMapObject *map, MalValue key) {
    u32 slot;
    return mal_weak_lookup(map->entries, MAL_WEAK_MAP_WIDTH, key, &slot);
}

bool mal_weak_map_object_delete(MalWeakMapObject *map, MalValue key) {
    if (!mal_weak_delete(map->entries, MAL_WEAK_MAP_WIDTH, key)) return false;
    mal_perf_collection_mutation(map, map->entries->size);
    return true;
}

usize mal_weak_map_object_size(const MalWeakMapObject *map) {
    return map->entries == nullptr ? 0 : map->entries->size;
}

bool mal_weak_map_object_reserve(MalWeakMapObject *map, usize desired_size) {
    return mal_weak_reserve(&map->entries, MAL_WEAK_MAP_WIDTH, desired_size);
}

MalWeakSetObject *mal_weak_set_object_new(MalHeap *heap, MalObject *prototype) {
    MalWeakSetObject *set = mal_heap_alloc(heap, sizeof(MalWeakSetObject), MAL_HEAP_WEAK_SET_OBJECT);
    mal_object_init(heap, &set->object, MAL_HEAP_WEAK_SET_OBJECT, prototype);
    set->entries = nullptr;
    mal_perf_collection_new(set, MAL_PERF_COLLECTION_WEAK_SET, heap->epoch);
    return set;
}

void mal_weak_set_object_add(MalWeakSetObject *set, MalValue key) {
    if (!mal_weak_key_can_be_held(key)) abort();
    if (set->entries == nullptr) set->entries = mal_weak_storage_new(MAL_WEAK_SET_WIDTH);
    bool inserted;
    mal_weak_upsert(set->entries, MAL_WEAK_SET_WIDTH, key, &inserted);
    if (!inserted) return;
    mal_gc_card(&set->object.header, key);
    mal_perf_collection_key_value(set, key);
    mal_perf_collection_mutation(set, set->entries->size);
}

bool mal_weak_set_object_has(const MalWeakSetObject *set, MalValue key) {
    u32 slot;
    return mal_weak_lookup(set->entries, MAL_WEAK_SET_WIDTH, key, &slot);
}

bool mal_weak_set_object_delete(MalWeakSetObject *set, MalValue key) {
    if (!mal_weak_delete(set->entries, MAL_WEAK_SET_WIDTH, key)) return false;
    mal_perf_collection_mutation(set, set->entries->size);
    return true;
}

usize mal_weak_set_object_size(const MalWeakSetObject *set) {
    return set->entries == nullptr ? 0 : set->entries->size;
}

bool mal_weak_set_object_reserve(MalWeakSetObject *set, usize desired_size) {
    return mal_weak_reserve(&set->entries, MAL_WEAK_SET_WIDTH, desired_size);
}

void mal_weak_map_iter_init(MalWeakMapIter *iter, const MalWeakStorage *storage) {
    *iter = (MalWeakMapIter) {.storage = storage};
}

bool mal_weak_map_iter_next(MalWeakMapIter *iter, MalValue *key, MalValue *value) {
    const MalWeakStorage *storage = iter->storage;
    if (storage == nullptr) return false;
    usize limit = mal_weak_storage_scan_slots(storage);
    while (iter->index < limit) {
        u32 i = (u32) iter->index++;
        if (!mal_weak_live(storage, i)) continue;
        MalValue *row = mal_weak_row(storage, MAL_WEAK_MAP_WIDTH, i);
        *key = row[0];
        *value = row[1];
        return true;
    }
    return false;
}

void mal_weak_set_iter_init(MalWeakSetIter *iter, const MalWeakStorage *storage) {
    *iter = (MalWeakSetIter) {.storage = storage};
}

bool mal_weak_set_iter_next(MalWeakSetIter *iter, MalValue *key) {
    const MalWeakStorage *storage = iter->storage;
    if (storage == nullptr) return false;
    usize limit = mal_weak_storage_scan_slots(storage);
    while (iter->index < limit) {
        u32 i = (u32) iter->index++;
        if (!mal_weak_live(storage, i)) continue;
        *key = mal_weak_row(storage, MAL_WEAK_SET_WIDTH, i)[0];
        return true;
    }
    return false;
}

usize mal_weak_map_storage_retain(MalWeakStorage *storage, bool (*keep)(MalValue)) {
    return mal_weak_retain(storage, MAL_WEAK_MAP_WIDTH, keep);
}

usize mal_weak_set_storage_retain(MalWeakStorage *storage, bool (*keep)(MalValue)) {
    return mal_weak_retain(storage, MAL_WEAK_SET_WIDTH, keep);
}

void mal_weak_storage_free(MalWeakStorage *storage) {
    if (storage == nullptr) return;
    gc_free_raw(mal_gc_current_heap(), storage->buckets);
    gc_free_raw(mal_gc_current_heap(), storage);
}

usize mal_weak_storage_allocation_bytes(const MalWeakStorage *storage) {
    if (storage == nullptr) return 0;
    return mal_heap_raw_capacity(mal_gc_current_heap(), storage) +
        (storage->buckets == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), storage->buckets));
}

usize mal_weak_storage_capacity(const MalWeakStorage *storage) {
    return storage == nullptr ? 0 : storage->buckets == nullptr ? MAL_WEAK_INLINE_CAPACITY : storage->capacity;
}

usize mal_weak_storage_scan_slots(const MalWeakStorage *storage) {
    return storage == nullptr ? 0 : storage->buckets == nullptr ? storage->size : storage->capacity;
}

#if MAL_PERF_STATS
static u8 mal_weak_perf_key_mask(const MalWeakStorage *storage, usize width) {
    u8 mask = 0;
    for (u32 i = 0; i < mal_weak_storage_scan_slots(storage); i++) {
        if (mal_weak_live(storage, i)) mask |= mal_perf_collection_key_bit(mal_weak_row(storage, width, i)[0]);
    }
    return mask;
}

u8 mal_weak_map_object_perf_key_mask(const MalWeakMapObject *map) {
    return mal_weak_perf_key_mask(map->entries, MAL_WEAK_MAP_WIDTH);
}

u8 mal_weak_set_object_perf_key_mask(const MalWeakSetObject *set) {
    return mal_weak_perf_key_mask(set->entries, MAL_WEAK_SET_WIDTH);
}
#endif
