#include "map_object.h"

#include <math.h>
#include <string.h>

#include "gc.h"
#include "hash_index.h"
#include "perf_stats.h"
#include "profile.h"

#define MAL_MAP_SMALL_CAPACITY 4

typedef struct MalMapPair {
    MalValue key;
    MalValue value;
} MalMapPair;

struct MalMapStorage {
    void *payload;
    i32 *slots;
    u32 size;
    u32 count;
    u32 capacity;
    u32 slot_capacity;
    u32 deleted_slots;
    u32 pins;
    u32 reserve_size;
    u32 entry_hint;
    // A live entry owns this exact key; removing or renumbering it invalidates the mirror.
    MalValue hint_key;
    MalMapKeyDomain domain;
    bool owner_released;
    union {
        struct {
            MalValue small[MAL_MAP_SMALL_CAPACITY];
            MalValue small_values[MAL_MAP_SMALL_CAPACITY];
        };
        MalValue *int32_values;
    };
};

static_assert(sizeof(MalMapStorage) <= 128, "Map descriptor outgrew its small allocation");
static_assert(sizeof(MalMapObject) <= 64, "Map object outgrew its allocation class");
static_assert(sizeof(MalMapPair) == 2 * sizeof(MalValue), "Map pairs must not add payload padding");

static MalMapKeyDomain mal_map_key_domain(MalValue key) {
    if (mal_value_is_f64(key)) {
        f64 number = mal_value_to_f64(key);
        return number >= INT32_MIN && number <= INT32_MAX && (f64) (i32) number == number
            ? MAL_MAP_KEYS_INT32 : MAL_MAP_KEYS_NUMBER;
    }
    if (key == MAL_VALUE_NAN || key == MAL_VALUE_POSITIVE_INFINITY ||
        key == MAL_VALUE_NEGATIVE_INFINITY) return MAL_MAP_KEYS_NUMBER;
    if (mal_value_is_string(key)) return MAL_MAP_KEYS_STRING;
    if (mal_value_is_object(key) || mal_value_is_symbol(key)) return MAL_MAP_KEYS_IDENTITY;
    return MAL_MAP_KEYS_GENERIC;
}

static MalMapKeyDomain mal_map_join_domain(MalMapKeyDomain left, MalMapKeyDomain right) {
    if (left == MAL_MAP_KEYS_EMPTY || left == right) return right;
    if ((left == MAL_MAP_KEYS_INT32 && right == MAL_MAP_KEYS_NUMBER) ||
        (left == MAL_MAP_KEYS_NUMBER && right == MAL_MAP_KEYS_INT32)) return MAL_MAP_KEYS_NUMBER;
    return MAL_MAP_KEYS_GENERIC;
}

static usize mal_map_row_width(MalMapKeyDomain domain) {
    return domain == MAL_MAP_KEYS_INT32 ? sizeof(i32) + sizeof(MalValue) : sizeof(MalMapPair);
}

static MalValue *mal_map_value_slot(MalMapStorage *storage, u32 index) {
    if (storage->payload == nullptr) return &storage->small_values[index];
    if (storage->domain == MAL_MAP_KEYS_INT32) return &storage->int32_values[index];
    return &((MalMapPair *) storage->payload)[index].value;
}

static MalValue mal_map_value_at(const MalMapStorage *storage, u32 index) {
    return *mal_map_value_slot((MalMapStorage *) storage, index);
}

// Spilled scans check values before reading stale or uninitialized dead keys.
static bool mal_map_is_live(const MalMapStorage *storage, u32 index) {
    return storage->payload == nullptr
        ? storage->small[index] != MAL_VALUE_EMPTY
        : mal_map_value_at(storage, index) != MAL_VALUE_EMPTY;
}

static MalValue mal_map_key_at(const MalMapStorage *storage, u32 index) {
    if (storage->payload == nullptr) return storage->small[index];
    if (storage->domain == MAL_MAP_KEYS_INT32) {
        return mal_value_from_f64((f64) ((i32 *) storage->payload)[index]);
    }
    return ((MalMapPair *) storage->payload)[index].key;
}

static void mal_map_store_key(
    void *payload, MalMapKeyDomain domain, u32 index, MalValue key
) {
    if (domain == MAL_MAP_KEYS_INT32) {
        ((i32 *) payload)[index] = (i32) mal_value_to_f64(key);
    } else {
        ((MalMapPair *) payload)[index].key = key;
    }
}

static bool mal_map_accepts_domain(const MalMapStorage *storage, MalMapKeyDomain domain) {
    return storage->domain == MAL_MAP_KEYS_GENERIC || storage->domain == domain ||
        (storage->domain == MAL_MAP_KEYS_NUMBER && domain == MAL_MAP_KEYS_INT32);
}

static bool mal_map_key_equals_slow(MalMapKeyDomain domain, MalValue candidate, MalValue key) {
    if (domain == MAL_MAP_KEYS_STRING) {
        return mal_value_is_string(key) &&
            mal_string_equals(mal_value_to_string(candidate), mal_value_to_string(key));
    }
    return domain == MAL_MAP_KEYS_GENERIC && mal_key_value_equals(candidate, key);
}

/*
 * Hashed-storage probe specialized by the constant `domain`. A hit returns the
 * index bucket holding an equal live key. A miss returns UINT32_MAX for lookups;
 * insertion instead returns the first reusable DELETED bucket, or the EMPTY bucket
 * that ended the search. Packed int32 storage compares `int_key`.
 */
static inline __attribute__((always_inline)) u32 mal_map_probe_in(
    const MalMapStorage *storage, MalMapKeyDomain domain, MalValue key, i32 int_key,
    u64 hash, bool insert
) {
    const u8 *controls = mal_hash_controls(storage->slots, storage->slot_capacity);
    MalHashProbe probe = mal_hash_probe(hash, storage->slot_capacity);
    u8 tag = mal_hash_tag(hash);
    u32 available = UINT32_MAX;
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MalHashMask matches = mal_hash_group_match(controls + probe.group, tag);
        while (matches != 0) {
            u32 slot = probe.group + mal_hash_mask_first(matches);
            u32 index = (u32) storage->slots[slot];
            MAL_PERF_COUNT(hash_index_candidates);
            if (domain == MAL_MAP_KEYS_INT32) {
                if (((const i32 *) storage->payload)[index] == int_key) return slot;
            } else {
                MalValue candidate = ((const MalMapPair *) storage->payload)[index].key;
                if (candidate == key) return slot;
                if (domain == MAL_MAP_KEYS_STRING &&
                    mal_string_equals(mal_value_to_string(candidate), mal_value_to_string(key))) {
                    return slot;
                }
                if (domain == MAL_MAP_KEYS_GENERIC && mal_key_value_equals(candidate, key)) return slot;
            }
            matches &= matches - 1;
        }
        if (insert && available == UINT32_MAX) {
            MalHashMask deleted = mal_hash_group_match(controls + probe.group, MAL_HASH_DELETED);
            if (deleted != 0) available = probe.group + mal_hash_mask_first(deleted);
        }
        MalHashMask empty = mal_hash_group_match(controls + probe.group, MAL_HASH_EMPTY);
        if (empty != 0) {
            if (!insert) return UINT32_MAX;
            return available == UINT32_MAX ? probe.group + mal_hash_mask_first(empty) : available;
        }
        mal_hash_probe_next(&probe);
    }
}

static inline __attribute__((always_inline)) u32 mal_map_probe(
    const MalMapStorage *storage, MalValue key, i32 int_key, u64 hash, bool insert
) {
    switch (storage->domain) {
        case MAL_MAP_KEYS_INT32:
            return mal_map_probe_in(storage, MAL_MAP_KEYS_INT32, key, int_key, hash, insert);
        case MAL_MAP_KEYS_STRING:
            return mal_map_probe_in(storage, MAL_MAP_KEYS_STRING, key, 0, hash, insert);
        case MAL_MAP_KEYS_GENERIC:
            return mal_map_probe_in(storage, MAL_MAP_KEYS_GENERIC, key, 0, hash, insert);
        default:
            // Canonical Number bits and identities are equal exactly when their tagged words are.
            return mal_map_probe_in(storage, MAL_MAP_KEYS_IDENTITY, key, 0, hash, insert);
    }
}

// The key must already be accepted by the storage domain.
static u32 mal_map_find_slot(const MalMapStorage *storage, MalValue key, u64 hash) {
    i32 int_key = storage->domain == MAL_MAP_KEYS_INT32 ? (i32) mal_value_to_f64(key) : 0;
    return mal_map_probe(storage, key, int_key, hash, true);
}

// A query outside the stored domain cannot equal a stored key, so it needs no hash or probe.
static inline bool mal_map_query_in_domain(
    const MalMapStorage *storage, MalValue key, i32 *int_key
) {
    switch (storage->domain) {
        case MAL_MAP_KEYS_INT32: {
            if (!mal_value_is_f64(key)) return false;
            f64 number = mal_value_to_f64(key);
            if (!(number >= INT32_MIN && number <= INT32_MAX)) return false;
            *int_key = (i32) number;
            return (f64) *int_key == number;
        }
        case MAL_MAP_KEYS_NUMBER:
            return mal_value_is_f64(key) || key == MAL_VALUE_NAN ||
                key == MAL_VALUE_POSITIVE_INFINITY || key == MAL_VALUE_NEGATIVE_INFINITY;
        case MAL_MAP_KEYS_STRING:
            return mal_value_is_string(key);
        case MAL_MAP_KEYS_IDENTITY:
            return mal_value_is_object(key) || mal_value_is_symbol(key);
        case MAL_MAP_KEYS_GENERIC:
            return true;
        case MAL_MAP_KEYS_EMPTY:
            return false;
    }
    abort();
}

// Returns the index bucket of an equal live key in hashed storage, or UINT32_MAX.
static inline __attribute__((always_inline)) u32 mal_map_lookup_slot(
    const MalMapStorage *storage, MalValue key
) {
    i32 int_key = 0;
    if (!mal_map_query_in_domain(storage, key, &int_key)) return UINT32_MAX;
    return mal_map_probe(storage, key, int_key, mal_key_hash_value(key), false);
}

static void mal_map_fill_slots(MalMapStorage *storage, i32 *slots, u32 capacity) {
    MAL_PERF_COUNT(hash_index_rebuilds);
    mal_hash_index_reset(slots, capacity);
    storage->deleted_slots = 0;
    for (u32 i = 0; i < storage->count; i++) {
        if (!mal_map_is_live(storage, i)) continue;
        u64 hash = mal_key_hash_value(mal_map_key_at(storage, i));
        u32 slot = mal_hash_index_empty_slot(slots, capacity, hash);
        mal_hash_index_insert(slots, capacity, slot, i, hash);
    }
}

static bool mal_map_capacity(usize required, u32 minimum, u32 *out) {
    if (required > INT32_MAX - 1) return false;
    u32 capacity = minimum;
    while (capacity < required) {
        if (capacity > (u32) INT32_MAX / 2) return false;
        capacity *= 2;
    }
    *out = capacity;
    return true;
}

static bool mal_map_slot_capacity(usize members, u32 *out) {
    u32 capacity = MAL_HASH_GROUP_WIDTH;
    while (!mal_hash_index_fits(members, capacity)) {
        if (capacity > (u32) INT32_MAX / 2) return false;
        capacity *= 2;
    }
    if ((usize) capacity > SIZE_MAX / (sizeof(i32) + sizeof(u8))) return false;
    *out = capacity;
    return true;
}

// Conversion keeps tombstone positions so every pinned cursor retains its continuation.
static void mal_map_replace_payload(
    MalMapStorage *storage, MalMapKeyDomain domain, u32 capacity
) {
    usize width = mal_map_row_width(domain);
    if (capacity > SIZE_MAX / width) abort();
    MAL_PERF_ADD(map_storage_payload_bytes, capacity * width);
    void *payload = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), capacity * width,
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    MalValue *int32_values = domain == MAL_MAP_KEYS_INT32
        ? (MalValue *) ((u8 *) payload + capacity * sizeof(i32)) : nullptr;
    if (storage->payload != nullptr && width == mal_map_row_width(storage->domain)) {
        if (domain == MAL_MAP_KEYS_INT32) {
            memcpy(payload, storage->payload, storage->count * sizeof(i32));
            memcpy(int32_values, storage->int32_values, storage->count * sizeof(MalValue));
        } else {
            memcpy(payload, storage->payload, storage->count * sizeof(MalMapPair));
        }
    } else {
        for (u32 i = 0; i < storage->count; i++) {
            MalValue value = mal_map_value_at(storage, i);
            if (domain == MAL_MAP_KEYS_INT32) int32_values[i] = value;
            else ((MalMapPair *) payload)[i].value = value;
            if (value != MAL_VALUE_EMPTY) {
                MalValue key = mal_map_key_at(storage, i);
                mal_map_store_key(payload, domain, i, key);
            }
        }
    }
    void *old_payload = storage->payload;
    storage->payload = payload;
    storage->int32_values = int32_values;
    storage->capacity = capacity;
    storage->domain = domain;
    gc_free_raw(mal_gc_current_heap(), old_payload);
}

static void mal_map_rehash(MalMapStorage *storage, u32 capacity) {
    MAL_PERF_ADD(map_storage_index_bytes, mal_hash_index_bytes(capacity));
    i32 *slots = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), mal_hash_index_bytes(capacity),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    mal_map_fill_slots(storage, slots, capacity);
    i32 *old_slots = storage->slots;
    storage->slots = slots;
    storage->slot_capacity = capacity;
    gc_free_raw(mal_gc_current_heap(), old_slots);
}

static void mal_map_free(MalMapStorage *storage) {
    gc_free_raw(mal_gc_current_heap(), storage->payload);
    gc_free_raw(mal_gc_current_heap(), storage->slots);
    gc_free_raw(mal_gc_current_heap(), storage);
}

static void mal_map_compact(MalMapStorage *storage) {
    if (storage->pins != 0) return;
    storage->entry_hint = 0;
    storage->hint_key = MAL_VALUE_EMPTY;
    MAL_PERF_COUNT(map_storage_compactions);
    u32 count = 0;
    if (storage->size != 0) {
        for (u32 i = 0; i < storage->count; i++) {
            MalValue value = mal_map_value_at(storage, i);
            if (value == MAL_VALUE_EMPTY) continue;
            if (storage->payload == nullptr) {
                storage->small[count] = storage->small[i];
            } else {
                MalValue key = mal_map_key_at(storage, i);
                mal_map_store_key(storage->payload, storage->domain, count, key);
            }
            *mal_map_value_slot(storage, count) = value;
            count++;
        }
    }
    storage->count = count;
    if (count <= MAL_MAP_SMALL_CAPACITY) {
        MalValue keys[MAL_MAP_SMALL_CAPACITY];
        MalValue values[MAL_MAP_SMALL_CAPACITY];
        for (u32 i = 0; i < count; i++) {
            keys[i] = mal_map_key_at(storage, i);
            values[i] = mal_map_value_at(storage, i);
        }
        gc_free_raw(mal_gc_current_heap(), storage->payload);
        gc_free_raw(mal_gc_current_heap(), storage->slots);
        storage->payload = nullptr;
        storage->slots = nullptr;
        memcpy(storage->small, keys, count * sizeof(MalValue));
        memcpy(storage->small_values, values, count * sizeof(MalValue));
        storage->capacity = MAL_MAP_SMALL_CAPACITY;
        storage->slot_capacity = 0;
        storage->deleted_slots = 0;
        storage->reserve_size = 0;
        if (count == 0) storage->domain = MAL_MAP_KEYS_EMPTY;
        return;
    }
    u32 capacity;
    if (!mal_map_capacity(count, 4, &capacity)) abort();
    if (capacity < storage->capacity) mal_map_replace_payload(storage, storage->domain, capacity);
    u32 slots;
    if (!mal_map_slot_capacity(count, &slots)) abort();
    if (slots != storage->slot_capacity) {
        mal_map_rehash(storage, slots);
    } else {
        mal_map_fill_slots(storage, storage->slots, slots);
    }
}

static bool mal_map_should_compact(const MalMapStorage *storage) {
    u32 dead = storage->count - storage->size;
    return storage->pins == 0 && dead != 0 &&
        (storage->size == 0 || storage->payload == nullptr ||
         (dead >= 16 && (dead >= storage->size ||
                        (storage->count == storage->capacity && dead >= storage->size / 4))));
}

MalMapStorage *mal_map_object_storage(MalMapObject *map) {
    if (map->entries == nullptr) {
        MAL_PERF_COUNT(map_storage_descriptors);
        MalMapStorage *storage = mal_heap_alloc_raw_profiled(
            mal_gc_current_heap(), sizeof(MalMapStorage), MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        *storage = (MalMapStorage) {.capacity = MAL_MAP_SMALL_CAPACITY};
        map->entries = storage;
    }
    return map->entries;
}

void mal_map_object_init(MalHeap *heap, MalMapObject *map, MalObject *prototype) {
    mal_object_init(heap, &map->object, MAL_HEAP_MAP_OBJECT, prototype);
    map->entries = nullptr;
    mal_perf_collection_new(map, MAL_PERF_COLLECTION_MAP, heap->epoch);
}

MalMapObject *mal_map_object_new(MalHeap *heap, MalObject *prototype) {
    MalMapObject *map = mal_heap_alloc(heap, sizeof(MalMapObject), MAL_HEAP_MAP_OBJECT);
    mal_map_object_init(heap, map, prototype);
    return map;
}

static u32 mal_map_small_find(const MalMapStorage *storage, MalValue key) {
    for (u32 i = 0; i < storage->count; i++) {
        MalValue candidate = storage->small[i];
        if (candidate != MAL_VALUE_EMPTY &&
            (candidate == key || mal_map_key_equals_slow(storage->domain, candidate, key))) return i + 1;
    }
    return 0;
}

static inline __attribute__((always_inline)) u32 mal_map_storage_find(
    const MalMapStorage *storage, MalValue key
) {
    if (storage == nullptr || storage->size == 0) return 0;
    if (storage->payload == nullptr) return mal_map_small_find(storage, key);
    u32 slot = mal_map_lookup_slot(storage, key);
    return slot == UINT32_MAX ? 0 : (u32) storage->slots[slot] + 1;
}

u32 mal_map_object_find_canonical(const MalMapObject *map, MalValue key) {
    return mal_map_storage_find(map->entries, key);
}

bool mal_map_object_has_canonical(const MalMapObject *map, MalValue key) {
    return mal_map_object_find_canonical(map, key) != 0;
}

bool mal_map_object_has(const MalMapObject *map, MalValue value) {
    return mal_map_object_has_canonical(map, mal_collection_canonical_value(value));
}

MalValue mal_map_object_get(const MalMapObject *map, MalValue key) {
    u32 entry = mal_map_object_find_canonical(map, mal_collection_canonical_value(key));
    return entry == 0 ? MAL_VALUE_UNDEFINED : mal_map_storage_value(map->entries, entry);
}

MalValue mal_map_storage_key(const MalMapStorage *storage, u32 entry) {
    return mal_map_key_at(storage, entry - 1);
}

MalValue mal_map_storage_value(const MalMapStorage *storage, u32 entry) {
    return mal_map_value_at(storage, entry - 1);
}

static u32 mal_map_storage_entry_hint(const MalMapStorage *storage, MalValue key) {
    if (storage == nullptr || storage->entry_hint == 0) return 0;
    if (storage->hint_key == key) return storage->entry_hint;
    if (!mal_value_is_string(key) && !mal_value_is_bigint(key)) return 0;
    return mal_key_value_equals(storage->hint_key, key) ? storage->entry_hint : 0;
}

static inline __attribute__((always_inline)) u32 mal_map_storage_counted_hint(
    const MalMapStorage *storage, MalValue key
) {
    MAL_PERF_COUNT(map_get_set_cache_checks);
    u32 entry = mal_map_storage_entry_hint(storage, key);
    if (entry != 0) MAL_PERF_COUNT(map_get_set_cache_hits);
    else MAL_PERF_COUNT(map_get_set_cache_misses);
    return entry;
}

u32 mal_map_object_entry_hint(const MalMapObject *map, MalValue key) {
    return mal_map_storage_counted_hint(map->entries, key);
}

// The hint keeps the Map's own key: the Map, not the caller, keeps that value alive.
static inline void mal_map_storage_remember_entry(MalMapStorage *storage, u32 entry) {
    if (storage == nullptr || storage->entry_hint == entry) return;
    storage->hint_key = entry == 0 ? MAL_VALUE_EMPTY : mal_map_key_at(storage, entry - 1);
    storage->entry_hint = entry;
}

void mal_map_object_remember_entry(MalMapObject *map, u32 entry) {
    mal_map_storage_remember_entry(map->entries, entry);
}

// Get, has and set run this for every call; keep the hint, probe and refresh in one frame.
static inline __attribute__((always_inline)) u32 mal_map_storage_find_hinted(
    MalMapStorage *storage, MalValue key
) {
    u32 entry = mal_map_storage_counted_hint(storage, key);
    if (entry != 0) return entry;
    entry = mal_map_storage_find(storage, key);
    if (entry != 0) mal_map_storage_remember_entry(storage, entry);
    return entry;
}

u32 mal_map_object_find_hinted(MalMapObject *map, MalValue key) {
    return mal_map_storage_find_hinted(map->entries, key);
}

MalValue mal_map_object_get_hinted(MalMapObject *map, MalValue key) {
    MalMapStorage *storage = map->entries;
    u32 entry = mal_map_storage_find_hinted(storage, key);
    return entry == 0 ? MAL_VALUE_UNDEFINED : mal_map_value_at(storage, entry - 1);
}

u32 mal_map_object_upsert_canonical(MalMapObject *map, MalValue key, bool *inserted) {
    MalMapStorage *storage = mal_map_object_storage(map);
    if (mal_map_should_compact(storage)) mal_map_compact(storage);
    MalMapKeyDomain key_domain = storage->domain == MAL_MAP_KEYS_GENERIC
        ? MAL_MAP_KEYS_GENERIC : mal_map_key_domain(key);
    bool accepts = mal_map_accepts_domain(storage, key_domain);
    u64 hash = 0;
    u32 missing_slot = 0;
    bool known_slot = storage->payload != nullptr && accepts;
    u32 existing = 0;
    if (known_slot) {
        hash = mal_key_hash_value(key);
        missing_slot = mal_map_find_slot(storage, key, hash);
        if (mal_hash_slot_live(storage->slots, storage->slot_capacity, missing_slot)) {
            existing = (u32) storage->slots[missing_slot] + 1;
        }
    } else if (accepts) {
        existing = mal_map_small_find(storage, key);
    }
    if (existing != 0) {
        if (inserted != nullptr) *inserted = false;
        return existing;
    }
    MalMapKeyDomain domain = mal_map_join_domain(storage->domain, key_domain);
    if (storage->domain == MAL_MAP_KEYS_EMPTY) MAL_PERF_COUNT(map_storage_domain_selections[domain]);
    else if (storage->domain != domain) MAL_PERF_COUNT(map_storage_domain_widenings[domain]);
#if MAL_PERF_STATS
    mal_perf_collection_key_value(map, mal_map_key_domain(key) == MAL_MAP_KEYS_INT32
        ? mal_value_from_i32((i32) mal_value_to_f64(key)) : key);
#endif
    u32 index = storage->count;
    if (storage->payload == nullptr && storage->count < MAL_MAP_SMALL_CAPACITY) {
        MAL_PERF_COUNT(map_storage_small_inserts);
        storage->small[index] = key;
        storage->small_values[index] = MAL_VALUE_UNDEFINED;
        storage->domain = domain;
        storage->count++;
    } else {
        MAL_PERF_COUNT(map_storage_hashed_inserts);
        if (storage->payload == nullptr) MAL_PERF_COUNT(map_storage_promotions);
        usize desired = storage->count + 1;
        if (storage->reserve_size > storage->size) desired += storage->reserve_size - storage->size - 1;
        u32 capacity;
        if (!mal_map_capacity(desired, storage->payload == nullptr ? 4 : storage->capacity, &capacity)) abort();
        if (storage->payload == nullptr || capacity != storage->capacity ||
            mal_map_row_width(domain) != mal_map_row_width(storage->domain)) {
            mal_map_replace_payload(storage, domain, capacity);
        } else storage->domain = domain;
        usize members = storage->reserve_size > storage->size + 1 ? storage->reserve_size : storage->size + 1;
        bool reuses_deleted = known_slot &&
            mal_hash_controls(storage->slots, storage->slot_capacity)[missing_slot] == MAL_HASH_DELETED;
        if (storage->slot_capacity == 0 ||
            !mal_hash_index_fits(members + storage->deleted_slots - reuses_deleted, storage->slot_capacity)) {
            u32 slots;
            if (!mal_map_slot_capacity(members, &slots)) abort();
            mal_map_rehash(storage, slots);
            known_slot = false;
        }
        if (!known_slot) hash = mal_key_hash_value(key);
        u32 slot = known_slot ? missing_slot : mal_map_find_slot(storage, key, hash);
        mal_map_store_key(storage->payload, storage->domain, index, key);
        *mal_map_value_slot(storage, index) = MAL_VALUE_UNDEFINED;
        storage->count++;
        if (mal_hash_controls(storage->slots, storage->slot_capacity)[slot] == MAL_HASH_DELETED) storage->deleted_slots--;
        mal_hash_index_insert(storage->slots, storage->slot_capacity, slot, index, hash);
        storage->reserve_size = 0;
    }
    storage->size++;
    mal_gc_card(&map->object.header, key);
    if (inserted != nullptr) *inserted = true;
    return index + 1;
}

void mal_map_object_update_entry(MalMapObject *map, u32 entry, MalValue key, MalValue value) {
    MalMapStorage *storage = map->entries;
    u32 index = entry - 1;
    MalValue *value_slot = mal_map_value_slot(storage, index);
    mal_gc_write_barrier(*value_slot);
    *value_slot = value;
    if (mal_value_is_string(key)) {
        MalValue old_key = mal_map_key_at(storage, index);
        if (old_key != key) {
            const MalString *string = mal_value_to_string(key);
            bool compact = string->storage == MAL_STRING_STORAGE_INLINE;
            if (string->storage == MAL_STRING_STORAGE_OWNED) {
                const MalString *old_string = mal_value_to_string(old_key);
                usize unit_size = string->latin1 || old_string->latin1 ? 1 : sizeof(c16);
                usize limit = mal_heap_allocation_charge((usize) string->length * unit_size);
                compact = mal_heap_raw_capacity(mal_gc_current_heap(), string->code_units) <= limit;
            }
            if (compact) {
                // Equal primitive strings share the hash and order position; keep only compact backing.
                mal_gc_write_barrier(old_key);
                if (storage->payload == nullptr) storage->small[index] = key;
                else mal_map_store_key(storage->payload, storage->domain, index, key);
                if (storage->entry_hint == entry) storage->hint_key = key;
                mal_gc_card(&map->object.header, key);
            }
        }
    }
    mal_gc_card(&map->object.header, value);
    mal_perf_collection_mutation(map, storage->size);
}

void mal_map_object_set_hinted(MalMapObject *map, MalValue key, MalValue value) {
    u32 entry = mal_map_storage_counted_hint(map->entries, key);
    if (entry == 0) entry = mal_map_object_upsert_canonical(map, key, nullptr);
    mal_map_object_update_entry(map, entry, key, value);
    mal_map_storage_remember_entry(map->entries, entry);
}

void mal_map_object_set_canonical(MalMapObject *map, MalValue key, MalValue value) {
    u32 entry = mal_map_object_upsert_canonical(map, key, nullptr);
    mal_map_object_update_entry(map, entry, key, value);
}

void mal_map_object_set(MalMapObject *map, MalValue key, MalValue value) {
    mal_map_object_set_canonical(map, mal_collection_canonical_value(key), value);
}

bool mal_map_object_delete_canonical(MalMapObject *map, MalValue key) {
    MalMapStorage *storage = map->entries;
    if (storage == nullptr || storage->size == 0) return false;
    u32 index;
    if (storage->payload == nullptr) {
        u32 entry = mal_map_small_find(storage, key);
        if (entry == 0) return false;
        index = entry - 1;
    } else {
        u32 slot = mal_map_lookup_slot(storage, key);
        if (slot == UINT32_MAX) return false;
        index = (u32) storage->slots[slot];
        storage->deleted_slots += mal_hash_index_erase(storage->slots, storage->slot_capacity, slot);
    }
    if (storage->entry_hint == index + 1) {
        storage->entry_hint = 0;
        storage->hint_key = MAL_VALUE_EMPTY;
    }
    mal_gc_write_barrier(mal_map_key_at(storage, index));
    MalValue *value_slot = mal_map_value_slot(storage, index);
    mal_gc_write_barrier(*value_slot);
    // Inline keys mirror tombstones so linear misses need no value-lane load.
    if (storage->payload == nullptr) storage->small[index] = MAL_VALUE_EMPTY;
    *value_slot = MAL_VALUE_EMPTY;
    storage->size--;
    mal_perf_collection_mutation(map, storage->size);
    if (mal_map_should_compact(storage)) mal_map_compact(storage);
    return true;
}

bool mal_map_object_delete(MalMapObject *map, MalValue value) {
    return mal_map_object_delete_canonical(map, mal_collection_canonical_value(value));
}

usize mal_map_object_size(const MalMapObject *map) {
    return map->entries == nullptr ? 0 : map->entries->size;
}

void mal_map_object_clear(MalMapObject *map) {
    MalMapStorage *storage = map->entries;
    if (storage == nullptr) return;
    storage->entry_hint = 0;
    storage->hint_key = MAL_VALUE_EMPTY;
    bool mutated = storage->size != 0;
    if (mal_gc_marking_active) {
        for (u32 i = 0; i < storage->count; i++) {
            MalValue value = mal_map_value_at(storage, i);
            if (value == MAL_VALUE_EMPTY) continue;
            mal_gc_write_barrier(mal_map_key_at(storage, i));
            mal_gc_write_barrier(value);
        }
    }
    storage->size = 0;
    if (storage->pins == 0 && storage->count != 0) {
        // Unpinned clear discards every row, so no cursor needs tombstone writes or index reset.
        mal_map_compact(storage);
    } else {
        if (storage->payload == nullptr) {
            for (u32 i = 0; i < storage->count; i++) {
                storage->small[i] = MAL_VALUE_EMPTY;
                storage->small_values[i] = MAL_VALUE_EMPTY;
            }
        } else if (storage->domain == MAL_MAP_KEYS_INT32) {
            for (u32 i = 0; i < storage->count; i++) storage->int32_values[i] = MAL_VALUE_EMPTY;
        } else {
            MalMapPair *pairs = storage->payload;
            for (u32 i = 0; i < storage->count; i++) pairs[i].value = MAL_VALUE_EMPTY;
        }
        if (storage->slot_capacity != 0) mal_hash_index_reset(storage->slots, storage->slot_capacity);
        storage->deleted_slots = 0;
    }
    if (mutated) mal_perf_collection_mutation(map, 0);
}

bool mal_map_object_reserve(MalMapObject *map, usize desired_size) {
    u32 capacity;
    u32 slots;
    if (!mal_map_capacity(desired_size, 4, &capacity) || !mal_map_slot_capacity(desired_size, &slots)) return false;
    if (desired_size <= mal_map_object_size(map)) return true;
    MalMapStorage *storage = mal_map_object_storage(map);
    if ((usize) capacity > SIZE_MAX / mal_map_row_width(storage->domain)) return false;
    if (storage->payload == nullptr) {
        if (desired_size > storage->reserve_size) storage->reserve_size = (u32) desired_size;
        return true;
    }
    usize required = storage->count + desired_size - storage->size;
    if (!mal_map_capacity(required, storage->capacity, &capacity)) return false;
    if ((usize) capacity > SIZE_MAX / mal_map_row_width(storage->domain)) return false;
    if (capacity > storage->capacity) mal_map_replace_payload(storage, storage->domain, capacity);
    if (slots > storage->slot_capacity) mal_map_rehash(storage, slots);
    return true;
}

void mal_map_iter_init(MalMapIter *iter, MalMapStorage *storage) {
    *iter = (MalMapIter) {.storage = storage};
}

bool mal_map_iter_next(MalMapIter *iter, MalValue *key, MalValue *value) {
    const MalMapStorage *storage = iter->storage;
    if (storage == nullptr) return false;
    usize index = iter->index;
    usize count = storage->count;
    if (storage->payload == nullptr) {
        for (; index < count; index++) {
            MalValue mapped = storage->small_values[index];
            if (mapped == MAL_VALUE_EMPTY) continue;
            *key = storage->small[index];
            *value = mapped;
            iter->index = index + 1;
            return true;
        }
    } else if (storage->domain == MAL_MAP_KEYS_INT32) {
        const i32 *keys = storage->payload;
        for (; index < count; index++) {
            MalValue mapped = storage->int32_values[index];
            if (mapped == MAL_VALUE_EMPTY) continue;
            *key = mal_value_from_f64((f64) keys[index]);
            *value = mapped;
            iter->index = index + 1;
            return true;
        }
    } else {
        const MalMapPair *pairs = storage->payload;
        for (; index < count; index++) {
            MalValue mapped = pairs[index].value;
            if (mapped == MAL_VALUE_EMPTY) continue;
            *key = pairs[index].key;
            *value = mapped;
            iter->index = index + 1;
            return true;
        }
    }
    iter->index = index;
    return false;
}

void mal_map_storage_pin(MalMapStorage *storage) {
    if (storage != nullptr) {
        if (storage->pins == UINT32_MAX) abort();
        storage->pins++;
    }
}

void mal_map_storage_unpin(MalMapStorage *storage) {
    if (storage == nullptr || storage->pins == 0) return;
    storage->pins--;
    if (storage->pins == 0 && storage->owner_released) mal_map_free(storage);
}

void mal_map_object_compact(MalMapObject *map) {
    if (map->entries != nullptr && mal_map_should_compact(map->entries)) mal_map_compact(map->entries);
}

void mal_map_storage_release_owner(MalMapStorage *storage) {
    if (storage == nullptr) return;
    storage->entry_hint = 0;
    storage->hint_key = MAL_VALUE_EMPTY;
    if (storage->pins == 0) mal_map_free(storage);
    else storage->owner_released = true;
}

usize mal_map_storage_traced_slots(const MalMapStorage *storage) {
    if (storage == nullptr) return 0;
    return (usize) storage->size * (storage->domain == MAL_MAP_KEYS_INT32 ||
        storage->domain == MAL_MAP_KEYS_NUMBER ? 1 : 2);
}

MalMapKeyDomain mal_map_storage_key_domain(const MalMapStorage *storage) {
    return storage == nullptr ? MAL_MAP_KEYS_EMPTY : storage->domain;
}

usize mal_map_storage_order_length(const MalMapStorage *storage) {
    return storage == nullptr ? 0 : storage->count;
}

usize mal_map_storage_allocation_bytes(const MalMapStorage *storage) {
    if (storage == nullptr) return 0;
    return mal_heap_allocation_charge(sizeof(MalMapStorage)) +
        (storage->payload == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), storage->payload)) +
        (storage->slots == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), storage->slots));
}

#if MAL_PERF_STATS
// Sweep may already have reclaimed members; classify tags without dereferencing them.
u8 mal_map_object_perf_key_mask(const MalMapObject *map) {
    u8 mask = 0;
    MalMapIter iter;
    mal_map_iter_init(&iter, map->entries);
    MalValue key, mapped;
    while (mal_map_iter_next(&iter, &key, &mapped)) {
        MalValue value = mal_map_key_domain(key) == MAL_MAP_KEYS_INT32
            ? mal_value_from_i32((i32) mal_value_to_f64(key)) : key;
        mask |= mal_perf_collection_key_bit(value);
    }
    return mask;
}
#endif
