#include "set_object.h"

#include <math.h>
#include <string.h>

#include "gc.h"
#include "hash_index.h"
#include "perf_stats.h"
#include "profile.h"

#define MAL_SET_SMALL_CAPACITY 4
#define MAL_SET_LIVE UINT8_C(1)

struct MalSetStorage {
    void *payload;
    i32 *slots;
    u32 size;
    u32 count;
    u32 capacity;
    u32 slot_capacity;
    u32 deleted_slots;
    u32 pins;
    u32 reserve_size;
    MalSetKeyDomain domain;
    bool owner_released;
    MalValue small[MAL_SET_SMALL_CAPACITY];
};

static_assert(sizeof(MalSetStorage) <= 80, "Set descriptor outgrew its small allocation");
static_assert(sizeof(MalSetObject) <= 64, "Set object outgrew its allocation class");

static MalSetKeyDomain mal_set_key_domain(MalValue key) {
    if (mal_value_is_f64(key)) {
        f64 number = mal_value_to_f64(key);
        return number >= INT32_MIN && number <= INT32_MAX && (f64) (i32) number == number
            ? MAL_SET_KEYS_INT32 : MAL_SET_KEYS_NUMBER;
    }
    if (key == MAL_VALUE_NAN || key == MAL_VALUE_POSITIVE_INFINITY ||
        key == MAL_VALUE_NEGATIVE_INFINITY) return MAL_SET_KEYS_NUMBER;
    if (mal_value_is_string(key)) return MAL_SET_KEYS_STRING;
    if (mal_value_is_object(key) || mal_value_is_symbol(key)) return MAL_SET_KEYS_IDENTITY;
    return MAL_SET_KEYS_GENERIC;
}

static MalSetKeyDomain mal_set_join_domain(MalSetKeyDomain left, MalSetKeyDomain right) {
    if (left == MAL_SET_KEYS_EMPTY || left == right) return right;
    if ((left == MAL_SET_KEYS_INT32 && right == MAL_SET_KEYS_NUMBER) ||
        (left == MAL_SET_KEYS_NUMBER && right == MAL_SET_KEYS_INT32)) return MAL_SET_KEYS_NUMBER;
    return MAL_SET_KEYS_GENERIC;
}

static usize mal_set_row_width(MalSetKeyDomain domain) {
    return domain == MAL_SET_KEYS_INT32 ? sizeof(i32) + sizeof(u8) : sizeof(MalValue);
}

static u8 *mal_set_int32_controls(const MalSetStorage *storage) {
    return (u8 *) storage->payload + storage->capacity * sizeof(i32);
}

static bool mal_set_is_live(const MalSetStorage *storage, u32 index) {
    if (storage->payload == nullptr) return storage->small[index] != MAL_VALUE_EMPTY;
    if (storage->domain == MAL_SET_KEYS_INT32) {
        return (mal_set_int32_controls(storage)[index] & MAL_SET_LIVE) != 0;
    }
    return ((MalValue *) storage->payload)[index] != MAL_VALUE_EMPTY;
}

static MalValue mal_set_key_at(const MalSetStorage *storage, u32 index) {
    if (storage->payload == nullptr) return storage->small[index];
    if (storage->domain == MAL_SET_KEYS_INT32) {
        return mal_value_from_f64((f64) ((i32 *) storage->payload)[index]);
    }
    return ((MalValue *) storage->payload)[index];
}

static void mal_set_store_key(
    void *payload, MalSetKeyDomain domain, u32 index, MalValue key
) {
    if (domain == MAL_SET_KEYS_INT32) {
        ((i32 *) payload)[index] = (i32) mal_value_to_f64(key);
    } else {
        ((MalValue *) payload)[index] = key;
    }
}

static void mal_set_mark_deleted(MalSetStorage *storage, u32 index) {
    if (storage->payload == nullptr) storage->small[index] = MAL_VALUE_EMPTY;
    else if (storage->domain == MAL_SET_KEYS_INT32) mal_set_int32_controls(storage)[index] = 0;
    else ((MalValue *) storage->payload)[index] = MAL_VALUE_EMPTY;
}

static bool mal_set_accepts_domain(const MalSetStorage *storage, MalSetKeyDomain domain) {
    return storage->domain == MAL_SET_KEYS_GENERIC || storage->domain == domain ||
        (storage->domain == MAL_SET_KEYS_NUMBER && domain == MAL_SET_KEYS_INT32);
}

static bool mal_set_accepts_query(const MalSetStorage *storage, MalValue key) {
    return storage->domain == MAL_SET_KEYS_GENERIC ||
        mal_set_accepts_domain(storage, mal_set_key_domain(key));
}

static bool mal_set_key_equals_slow(MalSetKeyDomain domain, MalValue candidate, MalValue key) {
    if (domain == MAL_SET_KEYS_STRING) {
        return mal_string_equals(mal_value_to_string(candidate), mal_value_to_string(key));
    }
    return domain == MAL_SET_KEYS_GENERIC && mal_key_value_equals(candidate, key);
}

static inline bool mal_set_key_equals(const MalSetStorage *storage, u32 index, MalValue key) {
    MalValue candidate;
    if (storage->payload == nullptr) {
        candidate = storage->small[index];
    } else if (storage->domain == MAL_SET_KEYS_INT32) {
        return ((i32 *) storage->payload)[index] == (i32) mal_value_to_f64(key);
    } else {
        candidate = ((MalValue *) storage->payload)[index];
    }
    return candidate == key || mal_set_key_equals_slow(storage->domain, candidate, key);
}

static u32 mal_set_find_slot(const MalSetStorage *storage, MalValue key, u64 hash) {
    u8 *controls = mal_hash_controls(storage->slots, storage->slot_capacity);
    MalHashProbe probe = mal_hash_probe(hash, storage->slot_capacity);
    u32 available = UINT32_MAX;
    for (;;) {
        MAL_PERF_COUNT(hash_index_groups);
        MalHashMask matches = mal_hash_group_match(controls + probe.group, mal_hash_tag(hash));
        while (matches != 0) {
            u32 slot = probe.group + mal_hash_mask_first(matches);
            MAL_PERF_COUNT(hash_index_candidates);
            if (mal_set_key_equals(storage, (u32) storage->slots[slot], key)) return slot;
            matches &= matches - 1;
        }
        if (available == UINT32_MAX) {
            MalHashMask deleted = mal_hash_group_match(controls + probe.group, MAL_HASH_DELETED);
            if (deleted != 0) available = probe.group + mal_hash_mask_first(deleted);
        }
        MalHashMask empty = mal_hash_group_match(controls + probe.group, MAL_HASH_EMPTY);
        if (empty != 0) return available == UINT32_MAX
            ? probe.group + mal_hash_mask_first(empty) : available;
        mal_hash_probe_next(&probe);
    }
}

static void mal_set_fill_slots(MalSetStorage *storage, i32 *slots, u32 capacity) {
    MAL_PERF_COUNT(hash_index_rebuilds);
    mal_hash_index_reset(slots, capacity);
    storage->deleted_slots = 0;
    for (u32 i = 0; i < storage->count; i++) {
        if (!mal_set_is_live(storage, i)) continue;
        u64 hash = mal_key_hash_value(mal_set_key_at(storage, i));
        u32 slot = mal_hash_index_empty_slot(slots, capacity, hash);
        mal_hash_index_insert(slots, capacity, slot, i, hash);
    }
}

static bool mal_set_capacity(usize required, u32 minimum, u32 *out) {
    if (required > INT32_MAX - 1) return false;
    u32 capacity = minimum;
    while (capacity < required) {
        if (capacity > (u32) INT32_MAX / 2) return false;
        capacity *= 2;
    }
    *out = capacity;
    return true;
}

static bool mal_set_slot_capacity(usize members, u32 *out) {
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
static void mal_set_replace_payload(
    MalSetStorage *storage, MalSetKeyDomain domain, u32 capacity
) {
    usize width = mal_set_row_width(domain);
    if (capacity > SIZE_MAX / width) abort();
    MAL_PERF_ADD(set_storage_payload_bytes, capacity * width);
    void *payload = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), capacity * width,
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    u8 *controls = domain == MAL_SET_KEYS_INT32
        ? (u8 *) payload + capacity * sizeof(i32) : nullptr;
    if (storage->payload != nullptr && width == mal_set_row_width(storage->domain)) {
        if (domain == MAL_SET_KEYS_INT32) {
            memcpy(payload, storage->payload, storage->count * sizeof(i32));
            memcpy(controls, mal_set_int32_controls(storage), storage->count * sizeof(u8));
        } else {
            memcpy(payload, storage->payload, storage->count * sizeof(MalValue));
        }
    } else if (controls != nullptr) {
        // Domains never narrow, so packed promotion can only read inline storage.
        for (u32 i = 0; i < storage->count; i++) {
            MalValue key = storage->small[i];
            if (key == MAL_VALUE_EMPTY) {
                controls[i] = 0;
            } else {
                ((i32 *) payload)[i] = (i32) mal_value_to_f64(key);
                controls[i] = MAL_SET_LIVE;
            }
        }
    } else if (storage->payload == nullptr) {
        memcpy(payload, storage->small, storage->count * sizeof(MalValue));
    } else {
        const i32 *keys = storage->payload;
        const u8 *old_controls = mal_set_int32_controls(storage);
        MalValue *members = payload;
        for (u32 i = 0; i < storage->count; i++) {
            members[i] = (old_controls[i] & MAL_SET_LIVE) != 0
                ? mal_value_from_f64((f64) keys[i]) : MAL_VALUE_EMPTY;
        }
    }
    void *old_payload = storage->payload;
    storage->payload = payload;
    storage->capacity = capacity;
    storage->domain = domain;
    gc_free_raw(mal_gc_current_heap(), old_payload);
}

static void mal_set_rehash(MalSetStorage *storage, u32 capacity) {
    MAL_PERF_ADD(set_storage_index_bytes, mal_hash_index_bytes(capacity));
    i32 *slots = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), mal_hash_index_bytes(capacity),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    mal_set_fill_slots(storage, slots, capacity);
    i32 *old_slots = storage->slots;
    storage->slots = slots;
    storage->slot_capacity = capacity;
    gc_free_raw(mal_gc_current_heap(), old_slots);
}

static void mal_set_free(MalSetStorage *storage) {
    gc_free_raw(mal_gc_current_heap(), storage->payload);
    gc_free_raw(mal_gc_current_heap(), storage->slots);
    gc_free_raw(mal_gc_current_heap(), storage);
}

static void mal_set_compact(MalSetStorage *storage) {
    if (storage->pins != 0) return;
    MAL_PERF_COUNT(set_storage_compactions);
    u32 count = 0;
    if (storage->payload != nullptr && storage->domain == MAL_SET_KEYS_INT32) {
        i32 *keys = storage->payload;
        u8 *controls = mal_set_int32_controls(storage);
        for (u32 i = 0; i < storage->count; i++) {
            if ((controls[i] & MAL_SET_LIVE) == 0) continue;
            keys[count] = keys[i];
            controls[count++] = MAL_SET_LIVE;
        }
    } else {
        MalValue *keys = storage->payload == nullptr ? storage->small : storage->payload;
        for (u32 i = 0; i < storage->count; i++) {
            MalValue key = keys[i];
            if (key != MAL_VALUE_EMPTY) keys[count++] = key;
        }
    }
    storage->count = count;
    if (count <= MAL_SET_SMALL_CAPACITY) {
        if (storage->payload != nullptr) {
            if (storage->domain == MAL_SET_KEYS_INT32) {
                const i32 *keys = storage->payload;
                for (u32 i = 0; i < count; i++) storage->small[i] = mal_value_from_f64((f64) keys[i]);
            } else {
                memcpy(storage->small, storage->payload, count * sizeof(MalValue));
            }
        }
        gc_free_raw(mal_gc_current_heap(), storage->payload);
        gc_free_raw(mal_gc_current_heap(), storage->slots);
        storage->payload = nullptr;
        storage->slots = nullptr;
        storage->capacity = MAL_SET_SMALL_CAPACITY;
        storage->slot_capacity = 0;
        storage->deleted_slots = 0;
        storage->reserve_size = 0;
        if (count == 0) storage->domain = MAL_SET_KEYS_EMPTY;
        return;
    }
    u32 capacity;
    if (!mal_set_capacity(count, 8, &capacity)) abort();
    if (capacity < storage->capacity) mal_set_replace_payload(storage, storage->domain, capacity);
    u32 slots;
    if (!mal_set_slot_capacity(count, &slots)) abort();
    if (slots != storage->slot_capacity) {
        mal_set_rehash(storage, slots);
    } else {
        mal_set_fill_slots(storage, storage->slots, slots);
    }
}

static bool mal_set_should_compact(const MalSetStorage *storage) {
    u32 dead = storage->count - storage->size;
    return storage->pins == 0 && dead != 0 &&
        (storage->size == 0 || storage->payload == nullptr ||
         (dead >= 16 && (dead >= storage->size ||
                        (storage->count == storage->capacity && dead >= storage->size / 4))));
}

MalSetStorage *mal_set_object_storage(MalSetObject *set) {
    if (set->entries == nullptr) {
        MAL_PERF_COUNT(set_storage_descriptors);
        MalSetStorage *storage = mal_heap_alloc_raw_profiled(
            mal_gc_current_heap(), sizeof(MalSetStorage), MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        *storage = (MalSetStorage) {.capacity = MAL_SET_SMALL_CAPACITY};
        set->entries = storage;
    }
    return set->entries;
}

MalSetObject *mal_set_object_new(MalHeap *heap, MalObject *prototype) {
    MalSetObject *set = mal_heap_alloc(heap, sizeof(MalSetObject), MAL_HEAP_SET_OBJECT);
    mal_object_init(heap, &set->object, MAL_HEAP_SET_OBJECT, prototype);
    set->entries = nullptr;
    mal_perf_collection_new(
        set, MAL_PERF_COLLECTION_SET, heap->epoch);
    return set;
}

static bool mal_set_small_has(const MalSetStorage *storage, MalValue key) {
    for (u32 i = 0; i < storage->count; i++) {
        if (mal_set_is_live(storage, i) && mal_set_key_equals(storage, i, key)) return true;
    }
    return false;
}

static bool mal_set_storage_has(const MalSetStorage *storage, MalValue key) {
    if (storage == nullptr || storage->size == 0 || !mal_set_accepts_query(storage, key)) return false;
    if (storage->payload == nullptr) return mal_set_small_has(storage, key);
    return mal_hash_slot_live(storage->slots, storage->slot_capacity,
        mal_set_find_slot(storage, key, mal_key_hash_value(key)));
}

static void mal_set_perf_query(MalValue key) {
#if MAL_PERF_STATS
    u8 bit = mal_perf_collection_key_bit(mal_set_key_domain(key) == MAL_SET_KEYS_INT32
        ? mal_value_from_i32((i32) mal_value_to_f64(key)) : key);
    u32 kind = 0;
    while (((1u << kind) & bit) == 0) kind++;
    MAL_PERF_COUNT(set_storage_query_kinds[kind]);
#else
    (void) key;
#endif
}

bool mal_set_object_has_canonical(const MalSetObject *set, MalValue key) {
    mal_set_perf_query(key);
    return mal_set_storage_has(set->entries, key);
}

bool mal_set_object_has(const MalSetObject *set, MalValue value) {
    return mal_set_object_has_canonical(set, mal_collection_key_from_value(value).value);
}

void mal_set_object_add_canonical(MalSetObject *set, MalValue key) {
    MalSetStorage *storage = mal_set_object_storage(set);
    if (mal_set_should_compact(storage)) mal_set_compact(storage);
    MalSetKeyDomain key_domain = storage->domain == MAL_SET_KEYS_GENERIC
        ? MAL_SET_KEYS_GENERIC : mal_set_key_domain(key);
    bool accepts = mal_set_accepts_domain(storage, key_domain);
    u64 hash = 0;
    u32 missing_slot = 0;
    bool known_slot = storage->payload != nullptr && accepts;
    if (known_slot) {
        hash = mal_key_hash_value(key);
        missing_slot = mal_set_find_slot(storage, key, hash);
        if (mal_hash_slot_live(storage->slots, storage->slot_capacity, missing_slot)) return;
    } else if (accepts && mal_set_small_has(storage, key)) {
        return;
    }
    MalSetKeyDomain domain = mal_set_join_domain(storage->domain, key_domain);
    if (storage->domain == MAL_SET_KEYS_EMPTY) {
        MAL_PERF_COUNT(set_storage_domain_selections[domain]);
    } else if (storage->domain != domain) {
        MAL_PERF_COUNT(set_storage_domain_widenings[domain]);
    }
#if MAL_PERF_STATS
    mal_perf_collection_key_value(set, mal_set_key_domain(key) == MAL_SET_KEYS_INT32
        ? mal_value_from_i32((i32) mal_value_to_f64(key)) : key);
#endif
    if (storage->payload == nullptr && storage->count < MAL_SET_SMALL_CAPACITY) {
        MAL_PERF_COUNT(set_storage_small_inserts);
        storage->small[storage->count] = key;
        storage->domain = domain;
        storage->count++;
    } else {
        MAL_PERF_COUNT(set_storage_hashed_inserts);
        if (storage->payload == nullptr) MAL_PERF_COUNT(set_storage_promotions);
        usize desired = storage->count + 1;
        if (storage->reserve_size > storage->size) desired += storage->reserve_size - storage->size - 1;
        u32 capacity;
        if (!mal_set_capacity(desired, storage->payload == nullptr ? 8 : storage->capacity, &capacity)) abort();
        if (storage->payload == nullptr || capacity != storage->capacity ||
            mal_set_row_width(domain) != mal_set_row_width(storage->domain)) {
            mal_set_replace_payload(storage, domain, capacity);
        } else {
            storage->domain = domain;
        }
        usize members = storage->reserve_size > storage->size + 1
            ? storage->reserve_size : storage->size + 1;
        bool reuses_deleted = known_slot &&
            mal_hash_controls(storage->slots, storage->slot_capacity)[missing_slot] == MAL_HASH_DELETED;
        if (storage->slot_capacity == 0 ||
            !mal_hash_index_fits(members + storage->deleted_slots - reuses_deleted, storage->slot_capacity)) {
            u32 slots;
            if (!mal_set_slot_capacity(members, &slots)) abort();
            mal_set_rehash(storage, slots);
            known_slot = false;
        }
        if (!known_slot) hash = mal_key_hash_value(key);
        u32 slot = known_slot ? missing_slot : mal_set_find_slot(storage, key, hash);
        u32 index = storage->count;
        mal_set_store_key(storage->payload, storage->domain, index, key);
        if (storage->domain == MAL_SET_KEYS_INT32) mal_set_int32_controls(storage)[index] = MAL_SET_LIVE;
        storage->count++;
        if (mal_hash_controls(storage->slots, storage->slot_capacity)[slot] == MAL_HASH_DELETED) {
            storage->deleted_slots--;
        }
        mal_hash_index_insert(storage->slots, storage->slot_capacity, slot, index, hash);
        storage->reserve_size = 0;
    }
    storage->size++;
    mal_gc_card(&set->object.header, key);
    mal_perf_collection_mutation(set, storage->size);
}

void mal_set_object_add(MalSetObject *set, MalValue value) {
    mal_set_object_add_canonical(set, mal_collection_key_from_value(value).value);
}

bool mal_set_object_delete_canonical(MalSetObject *set, MalValue key) {
    mal_set_perf_query(key);
    MalSetStorage *storage = set->entries;
    if (storage == nullptr || storage->size == 0 || !mal_set_accepts_query(storage, key)) return false;
    u32 index = storage->count;
    if (storage->payload == nullptr) {
        for (u32 i = 0; i < storage->count; i++) {
            if (mal_set_is_live(storage, i) && mal_set_key_equals(storage, i, key)) {
                index = i;
                break;
            }
        }
    } else {
        u32 slot = mal_set_find_slot(storage, key, mal_key_hash_value(key));
        if (!mal_hash_slot_live(storage->slots, storage->slot_capacity, slot)) return false;
        index = (u32) storage->slots[slot];
        storage->deleted_slots += mal_hash_index_erase(storage->slots, storage->slot_capacity, slot);
    }
    if (index == storage->count) return false;
    mal_gc_write_barrier(mal_set_key_at(storage, index));
    mal_set_mark_deleted(storage, index);
    storage->size--;
    mal_perf_collection_mutation(set, storage->size);
    if (mal_set_should_compact(storage)) mal_set_compact(storage);
    return true;
}

bool mal_set_object_delete(MalSetObject *set, MalValue value) {
    return mal_set_object_delete_canonical(set, mal_collection_key_from_value(value).value);
}

usize mal_set_object_size(const MalSetObject *set) {
    return set->entries == nullptr ? 0 : set->entries->size;
}

void mal_set_object_clear(MalSetObject *set) {
    MalSetStorage *storage = set->entries;
    if (storage == nullptr) return;
    bool mutated = storage->size != 0;
    if (storage->payload != nullptr && storage->domain == MAL_SET_KEYS_INT32) {
        // Packed Int32 keys carry no collector edges to shade.
        memset(mal_set_int32_controls(storage), 0, storage->count * sizeof(u8));
    } else {
        MalValue *keys = storage->payload == nullptr ? storage->small : storage->payload;
        for (u32 i = 0; i < storage->count; i++) {
            MalValue key = keys[i];
            if (key == MAL_VALUE_EMPTY) continue;
            mal_gc_write_barrier(key);
            keys[i] = MAL_VALUE_EMPTY;
        }
    }
    storage->size = 0;
    if (storage->slot_capacity != 0) mal_hash_index_reset(storage->slots, storage->slot_capacity);
    storage->deleted_slots = 0;
    if (mal_set_should_compact(storage)) mal_set_compact(storage);
    if (mutated) mal_perf_collection_mutation(set, 0);
}

bool mal_set_object_reserve(MalSetObject *set, usize desired_size) {
    u32 capacity;
    u32 slots;
    if (!mal_set_capacity(desired_size, 8, &capacity) || !mal_set_slot_capacity(desired_size, &slots)) return false;
    if (desired_size <= mal_set_object_size(set)) return true;
    MalSetStorage *storage = mal_set_object_storage(set);
    if ((usize) capacity > SIZE_MAX / mal_set_row_width(storage->domain)) return false;
    if (storage->payload == nullptr) {
        if (desired_size > storage->reserve_size) storage->reserve_size = (u32) desired_size;
        return true;
    }
    usize required = storage->count + desired_size - storage->size;
    if (!mal_set_capacity(required, storage->capacity, &capacity)) return false;
    if ((usize) capacity > SIZE_MAX / mal_set_row_width(storage->domain)) return false;
    if (capacity > storage->capacity) mal_set_replace_payload(storage, storage->domain, capacity);
    if (slots > storage->slot_capacity) mal_set_rehash(storage, slots);
    return true;
}

void mal_set_iter_init(MalSetIter *iter, MalSetStorage *storage) {
    *iter = (MalSetIter) {.storage = storage};
}

bool mal_set_iter_next(MalSetIter *iter, MalValue *key) {
    MalSetStorage *storage = iter->storage;
    if (storage == nullptr) return false;
    if (storage->payload != nullptr && storage->domain == MAL_SET_KEYS_INT32) {
        const i32 *keys = storage->payload;
        const u8 *controls = mal_set_int32_controls(storage);
        while (iter->index < storage->count) {
            u32 index = (u32) iter->index++;
            if ((controls[index] & MAL_SET_LIVE) == 0) continue;
            *key = mal_value_from_f64((f64) keys[index]);
            return true;
        }
    } else {
        const MalValue *keys = storage->payload == nullptr ? storage->small : storage->payload;
        while (iter->index < storage->count) {
            MalValue member = keys[iter->index++];
            if (member == MAL_VALUE_EMPTY) continue;
            *key = member;
            return true;
        }
    }
    return false;
}

void mal_set_storage_pin(MalSetStorage *storage) {
    if (storage != nullptr) {
        if (storage->pins == UINT32_MAX) abort();
        storage->pins++;
    }
}

void mal_set_storage_unpin(MalSetStorage *storage) {
    if (storage == nullptr || storage->pins == 0) return;
    storage->pins--;
    if (storage->pins == 0 && storage->owner_released) mal_set_free(storage);
}

void mal_set_object_compact(MalSetObject *set) {
    if (set->entries != nullptr && mal_set_should_compact(set->entries)) mal_set_compact(set->entries);
}

void mal_set_storage_release_owner(MalSetStorage *storage) {
    if (storage == nullptr) return;
    if (storage->pins == 0) mal_set_free(storage);
    else storage->owner_released = true;
}

usize mal_set_storage_traced_slots(const MalSetStorage *storage) {
    if (storage == nullptr || storage->domain == MAL_SET_KEYS_INT32 ||
        storage->domain == MAL_SET_KEYS_NUMBER) return 0;
    return storage->size;
}

MalSetKeyDomain mal_set_storage_key_domain(const MalSetStorage *storage) {
    return storage == nullptr ? MAL_SET_KEYS_EMPTY : storage->domain;
}

usize mal_set_storage_order_length(const MalSetStorage *storage) {
    return storage == nullptr ? 0 : storage->count;
}

usize mal_set_storage_allocation_bytes(const MalSetStorage *storage) {
    if (storage == nullptr) return 0;
    return mal_heap_allocation_charge(sizeof(MalSetStorage)) +
        (storage->payload == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), storage->payload)) +
        (storage->slots == nullptr ? 0 : mal_heap_raw_capacity(mal_gc_current_heap(), storage->slots));
}

#if MAL_PERF_STATS
// Sweep may already have reclaimed members; classify tags without dereferencing them.
u8 mal_set_object_perf_key_mask(const MalSetObject *set) {
    u8 mask = 0;
    MalSetIter iter;
    mal_set_iter_init(&iter, set->entries);
    MalValue key;
    while (mal_set_iter_next(&iter, &key)) {
        MalValue value = mal_set_key_domain(key) == MAL_SET_KEYS_INT32
            ? mal_value_from_i32((i32) mal_value_to_f64(key)) : key;
        mask |= mal_perf_collection_key_bit(value);
    }
    return mask;
}
#endif
