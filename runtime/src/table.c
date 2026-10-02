#include "./table.h"

#include <stdlib.h>
#include <string.h>

#include "./gc.h"
#include "./hash_index.h"
#include "./heap.h"
#include "./heap_string.h"
#include "./heap_symbol.h"
#include "./perf_stats.h"
#include "./profile.h"
#include "./property_store.h"

#define MAL_TABLE_SMALL_MIN_CAPACITY 4
#define MAL_TABLE_EMPTY (-1)

#define MAL_TABLE_KIND_SHIFT 48
#define MAL_TABLE_KIND_MASK (UINT64_C(3) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_INDEX (UINT64_C(1) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_STRING (UINT64_C(2) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_SYMBOL (UINT64_C(3) << MAL_TABLE_KIND_SHIFT)
#define MAL_TABLE_IDENTITY_MASK (UINT64_C(0x0000ffffffffffff) | MAL_TABLE_KIND_MASK)
#define MAL_TABLE_FLAGS_SHIFT 50
#define MAL_TABLE_FLAGS_MASK (UINT64_C(0x7f) << MAL_TABLE_FLAGS_SHIFT)
#define MAL_TABLE_OWNS_DATA (UINT64_C(1) << 57)
#define MAL_TABLE_HASH_SHIFT 58
#define MAL_TABLE_HASH_MASK (UINT64_C(0x3f) << MAL_TABLE_HASH_SHIFT)

typedef struct MalTableEntry {
    // Kind zero is dead; ownership survives deletion until the RAW sidecar is freed.
    u64 key;
    union {
        void *data;
        MalValue value;
    } payload;
} MalTableEntry;

static_assert(sizeof(MalTableEntry) == 16, "property rows must occupy two words");
static_assert(MAKS_PTR == UINT64_C(0x0000ffffffffffff), "property keys share the value pointer width");
static_assert((MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE |
    MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_INTERNAL_FLAGS) == 0x7f, "property metadata needs seven bits");

static inline bool mal_table_row_live(const MalTableEntry *entry) {
    return (entry->key & MAL_TABLE_KIND_MASK) != 0;
}

static inline bool mal_table_row_owned(const MalTableEntry *entry) {
    return (entry->key & MAL_TABLE_OWNS_DATA) != 0;
}

static u64 mal_table_encode_key(MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        u32 index;
        if (mal_value_is_int32(key.value)) {
            i32 integer = mal_value_to_i32(key.value);
            if (integer < 0) abort();
            index = (u32) integer;
        } else {
            if (!mal_value_is_f64(key.value)) abort();
            f64 number = mal_value_to_f64(key.value);
            if (!(number >= 0 && number < (f64) UINT32_MAX) || (f64) (u32) number != number) abort();
            index = (u32) number;
        }
        return MAL_TABLE_INDEX | index;
    }
    if (key.kind == MAL_KEY_STRING && mal_value_is_string(key.value)) {
        return MAL_TABLE_STRING | (key.value & MAKS_PTR);
    }
    if (key.kind == MAL_KEY_SYMBOL && mal_value_is_symbol(key.value)) {
        return MAL_TABLE_SYMBOL | (key.value & MAKS_PTR);
    }
    abort();
}

static inline MalValue mal_table_key_value(u64 key) {
    switch (key & MAL_TABLE_KIND_MASK) {
        case MAL_TABLE_INDEX: return mal_value_from_u32((u32) key);
        case MAL_TABLE_STRING: return MAL_VALUE_STRING | (key & MAKS_PTR);
        case MAL_TABLE_SYMBOL: return MAL_VALUE_SYMBOL | (key & MAKS_PTR);
        default: return MAL_VALUE_EMPTY;
    }
}

static inline u64 mal_table_key_hash(u64 key) {
    if ((key & MAL_TABLE_KIND_MASK) == MAL_TABLE_STRING) {
        return mal_key_hash_mix(mal_string_hash((MalString *) (uptr) (key & MAKS_PTR)));
    }
    return mal_key_hash_mix(mal_table_key_value(key));
}

static inline MalKey mal_table_decode_key(u64 key) {
    MalValue value = mal_table_key_value(key);
    return (MalKey) {.kind = (key & MAL_TABLE_KIND_MASK) == MAL_TABLE_INDEX ? MAL_KEY_INDEX :
        (key & MAL_TABLE_KIND_MASK) == MAL_TABLE_STRING ? MAL_KEY_STRING : MAL_KEY_SYMBOL,
        .value = value};
}

static bool mal_table_key_equals(const MalTableEntry *entry, u64 key, bool hashed) {
    MAL_PERF_COUNT(key_equals_calls);
    u64 candidate = entry->key & MAL_TABLE_IDENTITY_MASK;
    if (candidate == key) {
        MAL_PERF_COUNT(key_pointer_hits);
        return true;
    }
    if ((candidate & MAL_TABLE_KIND_MASK) != MAL_TABLE_STRING ||
        (key & MAL_TABLE_KIND_MASK) != MAL_TABLE_STRING) return false;
    MalString *left = mal_value_to_string(mal_table_key_value(candidate));
    MalString *right = mal_value_to_string(mal_table_key_value(key));
    // Indexed queries and every insertion have cached content hashes; tiny probes need none.
    if (hashed && left->hash != right->hash) return false;
    MAL_PERF_COUNT(key_string_fallbacks);
    return mal_string_equals(left, right);
}

// Ordered entry indices survive buffer growth; only unpinned compaction renumbers handles.
typedef struct MalTable {
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
} MalTable;

static_assert(sizeof(MalTable) <= 64, "MalTable outgrew its descriptor allocation class");

// Entry handles are 1-based indices boxed as void* (0/NULL means "no entry").
static inline void *mal_table_handle(u32 index) {
    return (void *) (uptr) (index + 1);
}

static inline u32 mal_table_handle_index(const void *handle) {
    return (u32) ((uptr) handle - 1);
}

static inline u64 mal_table_hash_fingerprint(u64 hash) {
    // Group tags use bits 57..63; these six independent bits reject candidates before pointer loads.
    return ((hash >> 51) & UINT64_C(0x3f)) << MAL_TABLE_HASH_SHIFT;
}

static u32 mal_table_find_slot(const MalTable *table, u64 key, u64 hash) {
    u32 result = table->entry_count;
    u64 probes = 0;
    if (table->slot_capacity == 0) {
        for (u32 i = 0; i < table->entry_count; i++) {
            probes++;
            if (mal_table_row_live(&table->entries[i]) && mal_table_key_equals(&table->entries[i], key, false)) {
                result = i;
                break;
            }
        }
    } else {
        u8 *controls = mal_hash_controls(table->slots, table->slot_capacity);
        MalHashProbe probe = mal_hash_probe(hash, table->slot_capacity);
        u32 available = UINT32_MAX;
        for (;;) {
            MAL_PERF_COUNT(hash_index_groups);
            MalHashMask matches = mal_hash_group_match(controls + probe.group, mal_hash_tag(hash));
            while (matches != 0) {
                u32 slot = probe.group + mal_hash_mask_first(matches);
                const MalTableEntry *entry = &table->entries[table->slots[slot]];
                MAL_PERF_COUNT(hash_index_candidates);
                probes++;
                if ((entry->key & MAL_TABLE_HASH_MASK) == mal_table_hash_fingerprint(hash) &&
                    mal_table_key_equals(entry, key, true)) {
                    result = slot;
                    goto found;
                }
                matches &= matches - 1;
            }
            if (available == UINT32_MAX) {
                MalHashMask deleted = mal_hash_group_match(controls + probe.group, MAL_HASH_DELETED);
                if (deleted != 0) available = probe.group + mal_hash_mask_first(deleted);
            }
            MalHashMask empty = mal_hash_group_match(controls + probe.group, MAL_HASH_EMPTY);
            if (empty != 0) {
                result = available == UINT32_MAX ? probe.group + mal_hash_mask_first(empty) : available;
                break;
            }
            mal_hash_probe_next(&probe);
        }
    }
found:
    if (mal_perf_stats_enabled) {
        MalPerfTableStats *stats = &mal_perf_stats.table;
        stats->find_calls++;
        stats->probes += probes;
        if (probes > stats->max_probe) stats->max_probe = probes;
        if ((key & MAL_TABLE_KIND_MASK) == MAL_TABLE_STRING) stats->string_queries++;
    }
    return result;
}

static i32 mal_table_slot_entry(const MalTable *table, u32 slot) {
    if (table->slot_capacity == 0) {
        return slot < table->entry_count ? (i32) slot : MAL_TABLE_EMPTY;
    }
    return mal_hash_slot_live(table->slots, table->slot_capacity, slot)
        ? table->slots[slot] : MAL_TABLE_EMPTY;
}

static void mal_table_allocate_storage(MalTable *table) {
    if (table->entry_capacity != 0) return;
    u32 capacity = MAL_TABLE_SMALL_MIN_CAPACITY;
    table->entries = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), capacity * sizeof(*table->entries),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    table->entry_capacity = capacity;
    MAL_PERF_COUNT(table.storage_allocations);
}

static void mal_table_fill_slots(MalTable *table, i32 *slots, u32 capacity) {
    MAL_PERF_COUNT(hash_index_rebuilds);
    if (mal_perf_stats_enabled) {
        MalPerfTableStats *stats = &mal_perf_stats.table;
        stats->rehashes++;
        stats->rehash_entries += table->size;
    }
    table->deleted_slots = 0;
    if (capacity == 0) return;
    mal_hash_index_reset(slots, capacity);
    for (u32 e = 0; e < table->entry_count; e++) {
        if (!mal_table_row_live(&table->entries[e])) continue;
        u64 hash = mal_table_key_hash(table->entries[e].key);
        u32 slot = mal_hash_index_empty_slot(slots, capacity, hash);
        mal_hash_index_insert(slots, capacity, slot, e, hash);
    }
}

static void mal_table_rehash(MalTable *table, u32 capacity) {
    i32 *slots = capacity == 0 ? nullptr : mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), mal_hash_index_bytes(capacity),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    mal_table_fill_slots(table, slots, capacity);
    gc_free_raw(mal_gc_current_heap(), table->slots);
    table->slots = slots;
    table->slot_capacity = capacity;
}

static bool mal_table_grow_slots_if_needed(MalTable *table, bool reuses_deleted) {
    if (table->slot_capacity == 0 && table->entry_count < MAL_TABLE_SMALL_MIN_CAPACITY) return false;
    if (table->slot_capacity != 0 &&
        mal_hash_index_fits((usize) table->size + table->deleted_slots + 1 - reuses_deleted, table->slot_capacity)) {
        return false;
    }
    u32 capacity = table->slot_capacity == 0 ? MAL_HASH_GROUP_WIDTH : table->slot_capacity;
    if (!mal_hash_index_fits((usize) table->size + 1, capacity)) {
        if (capacity > (u32) INT32_MAX / 2) abort();
        capacity *= 2;
        MAL_PERF_COUNT(table.slot_growths);
    }
    mal_table_rehash(table, capacity);
    return true;
}

// RAW realloc has no safepoint; the owner publishes the copied rows before GC can observe them.
static void mal_table_grow_entries_if_needed(MalTable *table) {
    if (table->entry_count < table->entry_capacity) {
        return;
    }

    if (table->entry_capacity > (u32) INT32_MAX / 2 ||
        (usize) table->entry_capacity > SIZE_MAX / sizeof(MalTableEntry) / 2) abort();
    table->entry_capacity *= 2;
    table->entries = gc_realloc_raw_profiled(
        mal_gc_current_heap(), table->entries,
        sizeof(MalTableEntry) * table->entry_capacity,
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
}

// The owning object's finalizer releases the descriptor and all RAW side allocations.
MalTable *mal_table_new(void) {
    MalHeap *heap = mal_gc_current_heap();
    MalTable *table = mal_heap_alloc_raw_profiled(
        heap, sizeof(MalTable), MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);

    table->handle_epoch = 1;
    table->size = 0;
    table->tombstone_count = 0;
    table->slot_capacity = 0;
    table->deleted_slots = 0;
    table->entry_count = 0;
    table->entry_capacity = 0;
    table->iterator_pins = 0;
    table->slots = nullptr;
    table->entries = nullptr;

    return table;
}

void mal_table_free(MalTable *table) {
    MalHeap *heap = mal_gc_current_heap();

    // Dead rows still own sidecars; teardown must not dereference their reclaimed keys.
    for (u32 e = 0; e < table->entry_count; e++) {
        if (mal_table_row_owned(&table->entries[e])) {
            gc_free_raw(heap, table->entries[e].payload.data);
        }
    }

    gc_free_raw(mal_gc_current_heap(), table->slots);
    gc_free_raw(heap, table->entries);
    gc_free_raw(heap, table);
}

usize mal_table_size(const MalTable *table) {
    return table->size;
}

bool mal_table_reserve(MalTable *table, usize desired_size) {
    if (desired_size <= table->size) {
        return true;
    }
    if (desired_size > INT32_MAX - 1) {
        return false;
    }

    usize appended = desired_size - table->size;
    usize required_entries = (usize) table->entry_count + appended;
    u32 target_entries = MAL_TABLE_SMALL_MIN_CAPACITY;
    while ((usize) target_entries < required_entries) {
        if (target_entries > (u32) INT32_MAX / 2) {
            return false;
        }
        target_entries *= 2;
    }
    if ((usize) target_entries > SIZE_MAX / sizeof(*table->entries)) return false;

    u32 target_slots = required_entries <= MAL_TABLE_SMALL_MIN_CAPACITY ? 0 : MAL_HASH_GROUP_WIDTH;
    while (target_slots != 0 && !mal_hash_index_fits(desired_size, target_slots)) {
        if (target_slots > (u32) INT32_MAX / 2) return false;
        target_slots *= 2;
    }
    if ((usize) target_slots > SIZE_MAX / (sizeof(i32) + sizeof(u8))) return false;
    MalHeap *heap = mal_gc_current_heap();
    if (target_entries > table->entry_capacity) {
        table->entries = gc_realloc_raw_profiled(
            heap, table->entries, sizeof(*table->entries) * target_entries,
            MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        if (table->entry_capacity == 0) MAL_PERF_COUNT(table.storage_allocations);
        table->entry_capacity = target_entries;
    }
    if (target_slots > table->slot_capacity) mal_table_rehash(table, target_slots);
    return true;
}

bool mal_table_get_private_value(const MalTable *table, MalSymbol *symbol, MalValue *value) {
    if (table == nullptr) return false;
    MalValue key = mal_value_from_symbol(symbol);
    u64 encoded = MAL_TABLE_SYMBOL | (key & MAKS_PTR);
    u32 index = symbol->private_entry_hint - 1;
    if (index < table->entry_count) {
        const MalTableEntry *entry = &table->entries[index];
        // Exact identity makes hints safe across receivers, growth, and compaction.
        if (mal_table_row_live(entry) && (entry->key & MAL_TABLE_IDENTITY_MASK) == encoded) {
            *value = entry->payload.value;
            return true;
        }
    }
    MalTableLookup lookup = mal_table_lookup(table, (MalKey) {.kind = MAL_KEY_SYMBOL, .value = key});
    if (!lookup.present) return false;
    symbol->private_entry_hint = (u32) (uptr) lookup.entry;
    *value = table->entries[mal_table_handle_index(lookup.entry)].payload.value;
    return true;
}

MalTableLookup mal_table_lookup(const MalTable *table, MalKey key) {
    u64 encoded = mal_table_encode_key(key);
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.table : nullptr;
    if (stats != nullptr) {
        stats->lookups++;
    }
    if (table->size == 0) {
        if (stats != nullptr) stats->lookup_misses++;
        return (MalTableLookup) {.present = false, .entry = nullptr};
    }
    if (key.kind == MAL_KEY_INDEX) {
        u32 index = (u32) encoded;
        if (index < table->entry_count) {
            const MalTableEntry *entry = &table->entries[index];
            // Dense array deoptimization preserves index order; exact keys reject shifted entries.
            if (mal_table_row_live(entry) && (entry->key & MAL_TABLE_IDENTITY_MASK) == encoded) {
                if (stats != nullptr) stats->lookup_hits++;
                return (MalTableLookup) {.present = true, .entry = mal_table_handle(index)};
            }
        }
    }
    u64 hash = table->slot_capacity == 0 ? 0 : mal_table_key_hash(encoded);
    u32 index = mal_table_find_slot(table, encoded, hash);
    i32 entry = mal_table_slot_entry(table, index);

    if (entry == MAL_TABLE_EMPTY) {
        if (stats != nullptr) {
            stats->lookup_misses++;
        }
        return (MalTableLookup) {.present = false, .entry = nullptr};
    }

    if (stats != nullptr) {
        stats->lookup_hits++;
    }
    return (MalTableLookup) {.present = true, .entry = mal_table_handle((u32) entry)};
}

void *mal_table_upsert_entry(MalTable *table, MalKey key, bool *inserted) {
    u64 encoded = mal_table_encode_key(key);
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.table : nullptr;
    if (stats != nullptr) {
        stats->upserts++;
    }
    mal_table_allocate_storage(table);
    u64 hash = table->slot_capacity == 0 ? 0 : mal_table_key_hash(encoded);
    u32 index = mal_table_find_slot(table, encoded, hash);
    if (mal_table_slot_entry(table, index) != MAL_TABLE_EMPTY) {
        if (stats != nullptr) {
            stats->upsert_hits++;
        }
        if (inserted != nullptr) *inserted = false;
        return mal_table_handle((u32) mal_table_slot_entry(table, index));
    }

    // Entry-buffer growth preserves the slot array. Only slot growth rehashes and
    // invalidates the empty index found above.
    mal_table_grow_entries_if_needed(table);
    bool reuses_deleted = table->slot_capacity != 0 &&
        mal_hash_controls(table->slots, table->slot_capacity)[index] == MAL_HASH_DELETED;
    if (mal_table_grow_slots_if_needed(table, reuses_deleted)) {
        hash = mal_table_key_hash(encoded);
        index = mal_table_find_slot(table, encoded, hash);
    } else if (table->slot_capacity == 0) {
        hash = mal_table_key_hash(encoded);
    }

    u32 entry_index = table->entry_count++;
    MalTableEntry *entry = &table->entries[entry_index];
    entry->key = encoded | mal_table_hash_fingerprint(hash);
    entry->payload.value = mal_value_new_undefined();

    if (table->slot_capacity != 0) {
        if (mal_hash_controls(table->slots, table->slot_capacity)[index] == MAL_HASH_DELETED) {
            table->deleted_slots--;
        }
        mal_hash_index_insert(table->slots, table->slot_capacity, index, entry_index, hash);
    }
    table->size++;
    if (stats != nullptr) {
        stats->upsert_inserts++;
    }

    if (inserted != nullptr) *inserted = true;
    return mal_table_handle(entry_index);
}

bool mal_table_delete(MalTable *table, MalKey key) {
    u64 encoded = mal_table_encode_key(key);
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.table : nullptr;
    if (stats != nullptr) {
        stats->deletes++;
    }
    if (table->size == 0) return false;
    u64 hash = table->slot_capacity == 0 ? 0 : mal_table_key_hash(encoded);
    u32 index = mal_table_find_slot(table, encoded, hash);
    i32 entry_index = mal_table_slot_entry(table, index);

    if (entry_index == MAL_TABLE_EMPTY) {
        return false;
    }
    if (stats != nullptr) {
        stats->delete_hits++;
    }

    MalTableEntry *entry = &table->entries[entry_index];

    // The property MOP shades accessor edges; this layer preserves keys and inline values for SATB.
    mal_gc_write_barrier(mal_table_key_value(entry->key));
    if (!mal_table_row_owned(entry)) {
        mal_gc_write_barrier(entry->payload.value);
    }

    // Keep raw ownership on dead rows until compact/free; cursors retain their positions.
    entry->key &= ~MAL_TABLE_KIND_MASK;
    table->size--;
    table->tombstone_count++;

    if (table->slot_capacity != 0) {
        table->deleted_slots += mal_hash_index_erase(table->slots, table->slot_capacity, index);
    }

    return true;
}

usize mal_table_retain(MalTable *table, bool (*keep)(MalValue key)) {
    MalValue rejected[16];
    usize removed = 0;
    for (u32 e = 0; e < table->entry_count; ++e) {
        MalTableEntry *entry = &table->entries[e];
        if (!mal_table_row_live(entry) || keep(mal_table_key_value(entry->key))) continue;
        if (removed < countof(rejected)) rejected[removed] = mal_table_key_value(entry->key);
        removed++;
    }
    if (removed == 0) return 0;
    if (removed == table->size) {
        mal_table_clear(table);
        return removed;
    }

    usize remaining = table->size - removed;
    if (removed < countof(rejected) || removed < remaining / 4) {
        if (removed <= countof(rejected)) {
            for (usize i = 0; i < removed; ++i) {
                mal_table_delete(table, mal_key_from_value(rejected[i]));
            }
        } else {
            for (u32 e = 0; e < table->entry_count; ++e) {
                MalTableEntry *entry = &table->entries[e];
                if (!mal_table_row_live(entry) || keep(mal_table_key_value(entry->key))) continue;
                mal_table_delete(table, mal_table_decode_key(entry->key));
            }
        }
        return removed;
    }

    // Dense filtering rebuilds only the index, preserving surviving handles.
    for (u32 e = 0; e < table->entry_count; ++e) {
        MalTableEntry *entry = &table->entries[e];
        if (!mal_table_row_live(entry) || keep(mal_table_key_value(entry->key))) continue;
        mal_gc_write_barrier(mal_table_key_value(entry->key));
        if (!mal_table_row_owned(entry)) mal_gc_write_barrier(entry->payload.value);
        entry->key &= ~MAL_TABLE_KIND_MASK;
    }
    table->size -= (u32) removed;
    table->tombstone_count += (u32) removed;
    if (mal_perf_stats_enabled) {
        mal_perf_stats.table.deletes += removed;
        mal_perf_stats.table.delete_hits += removed;
    }
    mal_table_fill_slots(table, table->slots, table->slot_capacity);
    return removed;
}

void mal_table_clear(MalTable *table) {
    if (mal_perf_stats_enabled) {
        mal_perf_stats.table.clears++;
    }
    if (table->size == 0) {
        // A sequence of individual deletes can leave an empty table backed by
        // tombstones. An explicit clear is a useful release point when no
        // iterator still depends on the stable insertion-order indices.
        if (table->iterator_pins == 0 && table->tombstone_count != 0) {
            mal_table_compact(table);
        }
        return;
    }
    for (u32 e = 0; e < table->entry_count; e++) {
        if (mal_table_row_live(&table->entries[e])) {
            mal_gc_write_barrier(mal_table_key_value(table->entries[e].key));
            if (!mal_table_row_owned(&table->entries[e])) {
                mal_gc_write_barrier(table->entries[e].payload.value);
            }
            table->entries[e].key &= ~MAL_TABLE_KIND_MASK;
            table->tombstone_count++;
        }
    }

    table->size = 0;

    if (table->slot_capacity != 0) mal_hash_index_reset(table->slots, table->slot_capacity);
    table->deleted_slots = 0;
    if (table->iterator_pins == 0) mal_table_compact(table);
}

void mal_table_compact(MalTable *table) {
    if (table->iterator_pins != 0 || table->tombstone_count == 0) return;
    if (mal_perf_stats_enabled) {
        mal_perf_stats.table.compactions++;
    }
    u32 write_index = 0;

    for (u32 read_index = 0; read_index < table->entry_count; read_index++) {
        MalTableEntry *entry = &table->entries[read_index];

        if (!mal_table_row_live(entry)) {
            if (mal_table_row_owned(entry)) {
                gc_free_raw(mal_gc_current_heap(), entry->payload.data);
            }
            continue;
        }

        if (write_index != read_index) {
            table->entries[write_index] = *entry;
        }
        write_index++;
    }

    table->entry_count = write_index;
    table->tombstone_count = 0;
    table->handle_epoch++;
    if (table->handle_epoch == 0) {
        table->handle_epoch = 1;
    }
    if (table->size == 0) {
        gc_free_raw(mal_gc_current_heap(), table->slots);
        gc_free_raw(mal_gc_current_heap(), table->entries);
        table->slots = nullptr;
        table->entries = nullptr;
        table->slot_capacity = 0;
        table->deleted_slots = 0;
        table->entry_capacity = 0;
        MAL_PERF_COUNT(table.storage_releases);
        return;
    }

    u32 target_entries = MAL_TABLE_SMALL_MIN_CAPACITY;
    while (target_entries < table->size) target_entries *= 2;
    if (target_entries < table->entry_capacity) {
        // gc_realloc_raw deliberately retains a buffer when the new request
        // fits its existing size class. Compaction is a memory release point,
        // so allocate the smaller class explicitly and return the old cell.
        MalHeap *heap = mal_gc_current_heap();
        MalTableEntry *entries = mal_heap_alloc_raw_profiled(
            heap, sizeof(*entries) * target_entries,
            MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        memcpy(entries, table->entries,
               sizeof(*entries) * table->entry_count);
        gc_free_raw(heap, table->entries);
        table->entries = entries;
        table->entry_capacity = target_entries;
        MAL_PERF_COUNT(table.entry_shrinks);
    }

    u32 target_slots = table->size <= MAL_TABLE_SMALL_MIN_CAPACITY ? 0 : MAL_HASH_GROUP_WIDTH;
    while (target_slots != 0 && !mal_hash_index_fits(table->size, target_slots)) target_slots *= 2;
    mal_table_rehash(table, target_slots);
}

void mal_table_pin(MalTable *table) {
    if (table != nullptr) table->iterator_pins++;
}

void mal_table_unpin(MalTable *table) {
    if (table == nullptr || table->iterator_pins == 0) return;
    table->iterator_pins--;
}

MalKey mal_table_entry_key(const MalTable *table, void *entry) {
    return mal_table_decode_key(table->entries[mal_table_handle_index(entry)].key);
}

void *mal_table_entry_data(const MalTable *table, void *entry) {
    const MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    return mal_table_row_owned(target) ? target->payload.data : nullptr;
}

void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data) {
    MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    if (!mal_table_row_owned(target)) {
        mal_gc_write_barrier(target->payload.value);
    }
    if (data != nullptr) {
        target->payload.data = data;
        target->key |= MAL_TABLE_OWNS_DATA;
    } else {
        target->payload.value = mal_value_new_undefined();
        target->key &= ~MAL_TABLE_OWNS_DATA;
    }
}

u8 mal_table_entry_property_flags(const MalTable *table, void *entry) {
    return (u8) ((table->entries[mal_table_handle_index(entry)].key & MAL_TABLE_FLAGS_MASK) >> MAL_TABLE_FLAGS_SHIFT);
}

void mal_table_entry_set_property_flags(
    MalTable *table, void *entry, u8 flags) {
    if ((flags & ~0x7f) != 0) abort();
    MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    target->key = (target->key & ~MAL_TABLE_FLAGS_MASK) | ((u64) flags << MAL_TABLE_FLAGS_SHIFT);
}

MalValue mal_table_entry_value(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].payload.value;
}

void mal_table_entry_set_value(MalTable *table, void *entry, MalValue value) {
    // Replacing an initialized property value must preserve the SATB snapshot.
    MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    mal_gc_write_barrier(target->payload.value);
    target->payload.value = value;
}

bool mal_table_entry_is_live(const MalTable *table, const void *entry) {
    return entry != nullptr && (uptr) entry <= table->entry_count &&
        mal_table_row_live(&table->entries[mal_table_handle_index(entry)]);
}

u64 mal_table_handle_epoch(const MalTable *table) {
    return table->handle_epoch;
}

bool mal_table_entry_matches(
    const MalTable *table, const void *entry, u64 handle_epoch, MalKey key
) {
    if (entry == nullptr || handle_epoch != table->handle_epoch) {
        return false;
    }
    u32 index = mal_table_handle_index(entry);
    if (index >= table->entry_count) {
        return false;
    }
    const MalTableEntry *candidate = &table->entries[index];
    if (!mal_table_row_live(candidate)) return false;
    u64 encoded = mal_table_encode_key(key);
    if (table->slot_capacity == 0) return mal_table_key_equals(candidate, encoded, false);
    u64 hash = mal_table_key_hash(encoded);
    return (candidate->key & MAL_TABLE_HASH_MASK) == mal_table_hash_fingerprint(hash) &&
        mal_table_key_equals(candidate, encoded, true);
}

bool mal_table_read_entry_hint(
    const MalTable *table, const void *entry, MalValue key,
    MalValue *value, u8 *property_flags
) {
    if (entry == nullptr) return false;
    u32 index = mal_table_handle_index(entry);
    if (index >= table->entry_count) return false;
    const MalTableEntry *candidate = &table->entries[index];
    if (!mal_table_row_live(candidate) ||
        (candidate->key & MAL_TABLE_IDENTITY_MASK) != mal_table_encode_key(mal_key_from_value(key)) ||
        mal_table_row_owned(candidate)) {
        return false;
    }
    *value = candidate->payload.value;
    *property_flags = (u8) ((candidate->key & MAL_TABLE_FLAGS_MASK) >> MAL_TABLE_FLAGS_SHIFT);
    return true;
}

void mal_table_iter_init(MalTableIter *iter, MalTable *table, MalTableIterKind kind) {
    iter->table = table;
    iter->kind = kind;
    iter->index = 0;
}

bool mal_table_iter_next(MalTableIter *iter, MalKey *key_out, void **entry_out) {
    while (iter->index < iter->table->entry_count) {
        u32 entry_index = (u32) iter->index++;
        MalTableEntry *entry = &iter->table->entries[entry_index];

        if (!mal_table_row_live(entry)) {
            continue;
        }

        *key_out = mal_table_decode_key(entry->key);
        *entry_out = mal_table_handle(entry_index);

        return true;
    }

    return false;
}
