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

#define MAL_TABLE_SMALL_MIN_CAPACITY 4
#define MAL_TABLE_GLOBAL_MIN_CAPACITY 16
#define MAL_TABLE_EMPTY (-1)

typedef struct MalTableEntry {
    // The key's value only; the equality domain (MalKeyKind) is derived on read
    // via mal_key_kind_of, so an entry needs no separate 4-byte kind field.
    MalValue key;
    union {
        void *data;
        MalValue value;
    } payload;
    u32 hash_fingerprint;
    u8 property_flags;
    bool live;
    bool owns_data;
} MalTableEntry;

static_assert(sizeof(MalTableEntry) == 24, "MalTableEntry must stay densely packed");

// Ordered entry indices survive buffer growth; only unpinned compaction renumbers handles.
typedef struct MalTable {
    MalTableMode mode;
    MalTableRole role;
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

static_assert(sizeof(MalTable) <= 80, "MalTable outgrew its descriptor allocation class");

static_assert(MAL_TABLE_ROLE_COUNT == MAL_PERF_TABLE_ROLE_COUNT, "table role stats mismatch");

// Entry handles are 1-based indices boxed as void* (0/NULL means "no entry").
static inline void *mal_table_handle(u32 index) {
    return (void *) (uptr) (index + 1);
}

static inline u32 mal_table_handle_index(const void *handle) {
    return (u32) ((uptr) handle - 1);
}

static inline u32 mal_table_hash_fingerprint(u64 hash) {
    return (u32) (hash >> 32);
}

static u32 mal_table_find_slot(const MalTable *table, MalValue key, u64 hash) {
    u32 result = table->entry_count;
    u64 probes = 0;
    if (table->slot_capacity == 0) {
        for (u32 i = 0; i < table->entry_count; i++) {
            probes++;
            if (table->entries[i].live && mal_key_value_equals(table->entries[i].key, key)) {
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
                if (entry->hash_fingerprint == mal_table_hash_fingerprint(hash) &&
                    mal_key_value_equals(entry->key, key)) {
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
        MalPerfTableStats *stats = &mal_perf_stats.tables[table->role];
        stats->find_calls++;
        stats->probes += probes;
        if (probes > stats->max_probe) stats->max_probe = probes;
        if (mal_value_is_string(key)) stats->string_queries++;
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

static u32 mal_table_initial_capacity(const MalTable *table) {
    return table->role == MAL_TABLE_ROLE_ATOMS
            || table->role == MAL_TABLE_ROLE_SYMBOL_REGISTRY
        ? MAL_TABLE_GLOBAL_MIN_CAPACITY : MAL_TABLE_SMALL_MIN_CAPACITY;
}

static void mal_table_allocate_storage(MalTable *table) {
    if (table->entry_capacity != 0) return;
    u32 capacity = mal_table_initial_capacity(table);
    table->entries = mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), capacity * sizeof(*table->entries),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    table->entry_capacity = capacity;
    MAL_PERF_COUNT(tables[table->role].storage_allocations);
}

static void mal_table_fill_slots(MalTable *table, i32 *slots, u32 capacity) {
    MAL_PERF_COUNT(hash_index_rebuilds);
    if (mal_perf_stats_enabled) {
        MalPerfTableStats *stats = &mal_perf_stats.tables[table->role];
        stats->rehashes++;
        stats->rehash_entries += table->size;
    }
    table->deleted_slots = 0;
    if (capacity == 0) return;
    mal_hash_index_reset(slots, capacity);
    for (u32 e = 0; e < table->entry_count; e++) {
        if (!table->entries[e].live) continue;
        u64 hash = mal_key_hash_value(table->entries[e].key);
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
        MAL_PERF_COUNT(tables[table->role].slot_growths);
    }
    mal_table_rehash(table, capacity);
    return true;
}

// Grows `entries` when the append cursor reaches capacity. The grow may move the
// buffer, but handles/iterators are indices, so they stay valid. Routed through the
// RAW space so the bytes count toward
// the GC trigger; no safepoint runs inside the allocator, so the detached old buffer
// is never observed by the collector (the entries it holds are copied forward and
// traced via the owner at the new address).
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

// The table header, non-inline `slots`, `entries`, and each entry's `data`
// descriptor blob live in the GC RAW space so their bytes count toward the
// collection trigger (big Maps/dictionaries used to under-trigger) and so an
// emptied RAW block returns to the OS. The table is not a GC cell; it is traced via
// its owner and freed explicitly by the owner's finalizer (or, for the VM-global
// symbol/atom tables, by mal_vm_free BEFORE mal_heap_free — see mal_table_free).
MalTable *mal_table_new(MalTableMode mode, MalTableRole role) {
    MalHeap *heap = mal_gc_current_heap();
    MalTable *table = mal_heap_alloc_raw_profiled(
        heap, sizeof(MalTable), MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);

    table->mode = mode;
    table->role = role;
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
    // RAW frees touch the heap via mal_gc_current_heap(); the VM-global symbol/atom
    // tables must therefore be freed (mal_vm_free) before mal_heap_free tears the
    // heap down. Cell-owned tables are freed from finalizers, where the heap is live.
    MalHeap *heap = mal_gc_current_heap();

    // Owned descriptor data is held by occupied accessor cells, including tombstones,
    // until compact/free.
    for (u32 e = 0; e < table->entry_count; e++) {
        if (table->entries[e].owns_data) {
            gc_free_raw(heap, table->entries[e].payload.data);
        }
    }

    gc_free_raw(mal_gc_current_heap(), table->slots);
    gc_free_raw(heap, table->entries);
    gc_free_raw(heap, table);
}

MalTableMode mal_table_mode(const MalTable *table) {
    return table->mode;
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
    u32 target_entries = mal_table_initial_capacity(table);
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
        if (table->entry_capacity == 0) MAL_PERF_COUNT(tables[table->role].storage_allocations);
        table->entry_capacity = target_entries;
    }
    if (target_slots > table->slot_capacity) mal_table_rehash(table, target_slots);
    return true;
}

bool mal_table_get_private_value(const MalTable *table, MalSymbol *symbol, MalValue *value) {
    if (table == nullptr) return false;
    MalValue key = mal_value_from_symbol(symbol);
    u32 index = symbol->private_entry_hint - 1;
    if (index < table->entry_count) {
        const MalTableEntry *entry = &table->entries[index];
        // Exact identity makes hints safe across receivers, growth, and compaction.
        if (entry->live && entry->key == key) {
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
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.tables[table->role] : nullptr;
    if (stats != nullptr) {
        stats->lookups++;
    }
    if (table->size == 0) {
        if (stats != nullptr) stats->lookup_misses++;
        return (MalTableLookup) {.present = false, .entry = nullptr};
    }
    if (key.kind == MAL_KEY_INDEX && table->mode == MAL_TABLE_MODE_OBJECT) {
        u32 index = mal_key_index_value(key);
        if (index < table->entry_count) {
            const MalTableEntry *entry = &table->entries[index];
            // Dense array deoptimization preserves index order; exact keys reject shifted entries.
            if (entry->live && entry->key == key.value) {
                if (stats != nullptr) stats->lookup_hits++;
                return (MalTableLookup) {.present = true, .entry = mal_table_handle(index)};
            }
        }
    }
    u64 hash = table->slot_capacity == 0 ? 0 : mal_key_hash_value(key.value);
    u32 index = mal_table_find_slot(table, key.value, hash);
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
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.tables[table->role] : nullptr;
    if (stats != nullptr) {
        stats->upserts++;
    }
    mal_table_allocate_storage(table);
    u64 hash = table->slot_capacity == 0 ? 0 : mal_key_hash_value(key.value);
    u32 index = mal_table_find_slot(table, key.value, hash);
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
        hash = mal_key_hash_value(key.value);
        index = mal_table_find_slot(table, key.value, hash);
    } else if (table->slot_capacity == 0) {
        hash = mal_key_hash_value(key.value);
    }

    u32 entry_index = table->entry_count++;
    MalTableEntry *entry = &table->entries[entry_index];
    entry->key = key.value;
    entry->payload.value = mal_value_new_undefined();
    entry->hash_fingerprint = mal_table_hash_fingerprint(hash);
    entry->property_flags = 0;
    entry->live = true;
    entry->owns_data = false;

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
    MalPerfTableStats *stats = mal_perf_stats_enabled ? &mal_perf_stats.tables[table->role] : nullptr;
    if (stats != nullptr) {
        stats->deletes++;
    }
    if (table->size == 0) return false;
    u64 hash = table->slot_capacity == 0 ? 0 : mal_key_hash_value(key.value);
    u32 index = mal_table_find_slot(table, key.value, hash);
    i32 entry_index = mal_table_slot_entry(table, index);

    if (entry_index == MAL_TABLE_EMPTY) {
        return false;
    }
    if (stats != nullptr) {
        stats->delete_hits++;
    }

    MalTableEntry *entry = &table->entries[entry_index];

    // SATB obligation: a RAW table is traced via its
    // owner but mutated independently, so a key/value dropped mid-cycle must be
    // shaded or it could be lost. Generic here (key + inline value); the property
    // MOP shades a deleted descriptor's value/getter/setter. Folds out off-cycle.
    mal_gc_write_barrier(entry->key);
    if (!entry->owns_data) {
        mal_gc_write_barrier(entry->payload.value);
    }

    // Tombstone the cell in place (keeps insertion order / outstanding indices
    // valid); the sweep-out of dead cells happens in compact.
    entry->live = false;
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
        if (!entry->live || keep(entry->key)) continue;
        if (removed < countof(rejected)) rejected[removed] = entry->key;
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
                if (!entry->live || keep(entry->key)) continue;
                mal_table_delete(table, mal_key_from_value(entry->key));
            }
        }
        return removed;
    }

    // Dense filtering rebuilds only the index, preserving surviving handles.
    for (u32 e = 0; e < table->entry_count; ++e) {
        MalTableEntry *entry = &table->entries[e];
        if (!entry->live || keep(entry->key)) continue;
        mal_gc_write_barrier(entry->key);
        if (!entry->owns_data) mal_gc_write_barrier(entry->payload.value);
        entry->live = false;
    }
    table->size -= (u32) removed;
    table->tombstone_count += (u32) removed;
    if (mal_perf_stats_enabled) {
        mal_perf_stats.tables[table->role].deletes += removed;
        mal_perf_stats.tables[table->role].delete_hits += removed;
    }
    mal_table_fill_slots(table, table->slots, table->slot_capacity);
    return removed;
}

void mal_table_clear(MalTable *table) {
    if (mal_perf_stats_enabled) {
        mal_perf_stats.tables[table->role].clears++;
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
        if (table->entries[e].live) {
            // SATB: shade each dropped key/value (see mal_table_delete).
            mal_gc_write_barrier(table->entries[e].key);
            if (!table->entries[e].owns_data) {
                mal_gc_write_barrier(table->entries[e].payload.value);
            }
            table->entries[e].live = false;
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
        mal_perf_stats.tables[table->role].compactions++;
    }
    u32 write_index = 0;

    for (u32 read_index = 0; read_index < table->entry_count; read_index++) {
        MalTableEntry *entry = &table->entries[read_index];

        if (!entry->live) {
            if (entry->owns_data) {
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
        MAL_PERF_COUNT(tables[table->role].storage_releases);
        return;
    }

    u32 target_entries = mal_table_initial_capacity(table);
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
        MAL_PERF_COUNT(tables[table->role].entry_shrinks);
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
    return mal_key_from_value(table->entries[mal_table_handle_index(entry)].key);
}

void *mal_table_entry_data(const MalTable *table, void *entry) {
    const MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    return target->owns_data ? target->payload.data : nullptr;
}

void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data) {
    MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    if (!target->owns_data) {
        mal_gc_write_barrier(target->payload.value);
    }
    if (data != nullptr) {
        target->payload.data = data;
        target->owns_data = true;
    } else {
        target->payload.value = mal_value_new_undefined();
        target->owns_data = false;
    }
}

u8 mal_table_entry_property_flags(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].property_flags;
}

void mal_table_entry_set_property_flags(
    MalTable *table, void *entry, u8 flags) {
    table->entries[mal_table_handle_index(entry)].property_flags = flags;
}

MalValue mal_table_entry_value(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].payload.value;
}

void mal_table_entry_set_value(MalTable *table, void *entry, MalValue value) {
    // SATB: replacing a live entry's value (e.g. Map.set on an existing key) drops
    // the old value. Every handle comes from upsert/lookup/iter, so the slot is
    // always initialized (upsert seeds it undefined), making this safe to shade
    // unconditionally. Folds out off-cycle.
    MalTableEntry *target = &table->entries[mal_table_handle_index(entry)];
    mal_gc_write_barrier(target->payload.value);
    target->payload.value = value;
}

bool mal_table_entry_is_live(const MalTable *table, const void *entry) {
    return table->entries[mal_table_handle_index(entry)].live;
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
    u64 hash = mal_key_hash_value(key.value);
    return candidate->live &&
        candidate->hash_fingerprint == mal_table_hash_fingerprint(hash) &&
        mal_key_value_equals(candidate->key, key.value);
}

bool mal_table_read_entry_hint(
    const MalTable *table, const void *entry, MalValue key,
    MalValue *value, u8 *property_flags
) {
    if (entry == nullptr) return false;
    u32 index = mal_table_handle_index(entry);
    if (index >= table->entry_count) return false;
    const MalTableEntry *candidate = &table->entries[index];
    if (!candidate->live || candidate->key != key || candidate->owns_data) {
        return false;
    }
    *value = candidate->payload.value;
    *property_flags = candidate->property_flags;
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

        if (!entry->live) {
            continue;
        }

        *key_out = mal_key_from_value(entry->key);
        *entry_out = mal_table_handle(entry_index);

        return true;
    }

    return false;
}
