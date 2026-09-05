#include "./table.h"

#include <stdlib.h>
#include <string.h>

#include "./gc.h"
#include "./heap.h"
#include "./heap_string.h"
#include "./heap_symbol.h"
#include "./perf_stats.h"
#include "./profile.h"

#define MAL_TABLE_SMALL_MIN_CAPACITY 4
#define MAL_TABLE_GLOBAL_MIN_CAPACITY 16
#define MAL_TABLE_MAX_LOAD_NUMERATOR 3
#define MAL_TABLE_MAX_LOAD_DENOMINATOR 4

// Empty hash slot sentinel (slots hold indices into `entries`, or this).
#define MAL_TABLE_EMPTY (-1)

typedef struct MalTableEntry {
    // The key's value only; the equality domain (MalKeyKind) is derived on read
    // via mal_key_kind_of, so an entry needs no separate 4-byte kind field.
    MalValue key;
    void *data;
    MalValue value;
    u32 hash_fingerprint;
    u8 property_flags;
    bool live;
} MalTableEntry;

// One per Map/Set/dictionary entry; must stay in the 32-byte size class.
static_assert(sizeof(MalTableEntry) <= 32, "MalTableEntry outgrew its 32-byte size class");

/**
 * Insertion-ordered open-addressed table. `entries` holds the entries inline in
 * insertion order (append-only; a delete tombstones in place via `live`), and
 * `slots` is the open-addressed hash — each slot is an INDEX into `entries` (or
 * MAL_TABLE_EMPTY). Entry handles and iterators are therefore entry INDICES, not
 * pointers, so they survive a realloc of `entries` on growth; only mal_table_compact
 * renumbers, and (like the former per-entry-pointer scheme) it must not run while a
 * handle/iterator is outstanding. Pins defer compaction until the last active
 * storage-order iterator finishes. This replaces the previous representation (an array of pointers to
 * individually malloc'd entries plus a parallel order array): one contiguous
 * allocation, no per-entry malloc, and 4-byte slot indices instead of 8-byte
 * pointers.
 */
typedef struct MalTable {
    MalTableMode mode;
    MalTableRole role;
    u64 handle_epoch;     // advanced whenever compaction renumbers entry handles
    u32 size;            // live entries
    u32 tombstone_count; // dead entries still occupying an `entries` cell
    u32 slot_capacity;   // hash array length (power of two)
    u32 entry_count;     // used `entries` cells (live + tombstones); the append cursor
    u32 entry_capacity;  // allocated `entries` cells
    u32 iterator_pins;   // persistent JS + transient native storage-order iterators
    bool owner_released; // Map/Set finalizer ran; last iterator pin owns teardown
    i32 *slots;
    MalTableEntry *entries;
    // Most compiler Maps/Sets never outgrow four hash slots. Co-locate that
    // first slot vector with the table header: 80 bytes has the same aggregate
    // size-class charge as the former 64-byte header plus 16-byte RAW vector,
    // but needs one allocation/free instead of two. Entries remain separate so
    // growing a collection never strands their much larger initial buffer.
    i32 inline_slots[MAL_TABLE_SMALL_MIN_CAPACITY];
} MalTable;

static_assert(sizeof(MalTable) <= 80, "MalTable outgrew its inline-slot size class");

static_assert(MAL_TABLE_ROLE_COUNT == MAL_PERF_TABLE_ROLE_COUNT, "table role stats mismatch");

// Entry handles are 1-based indices boxed as void* (0/NULL means "no entry").
static inline void *mal_table_handle(u32 index) {
    return (void *) (uptr) (index + 1);
}

static inline u32 mal_table_handle_index(const void *handle) {
    return (u32) ((uptr) handle - 1);
}

static u64 mal_table_hash_mix(u64 value) {
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9;
    value ^= value >> 27;
    value *= 0x94d049bb133111eb;
    value ^= value >> 31;

    return value;
}

// Hash and equality operate directly on the stored key value (kind-free): the
// value's bits already encode its class (an int32 INDEX never bit-equals an
// f64 NUMBER, etc.). Strings compare/hash by code units and BigInts by their
// numeric backing value; all other canonicalized values use their bits. This
// needs no separately stored kind.
static u64 mal_table_hash_value(MalValue value) {
    if (mal_value_is_string(value)) {
        return mal_table_hash_mix(mal_string_hash(mal_value_to_string(value)));
    }
    if (mal_value_is_bigint(value)) {
        u128 bits = (u128) mal_bigint_value(mal_value_to_bigint(value));
        u64 low = (u64) bits;
        u64 high = (u64) (bits >> 64);
        return mal_table_hash_mix(low ^ mal_table_hash_mix(high ^ 0x9e3779b97f4a7c15ull));
    }

    return mal_table_hash_mix(value);
}

static inline u32 mal_table_hash_fingerprint(u64 hash) {
    return (u32) (hash >> 32);
}

// The hash slot for `key`: either the slot holding a live entry equal to `key`,
// or the first empty slot on its probe chain (slots only ever reference live
// entries — a delete rebuilds the chains — so probing stops at the first empty).
static usize mal_table_find_slot(const MalTable *table, MalValue key, u64 hash) {
    if (table->slot_capacity == 0) return 0;
    usize mask = table->slot_capacity - 1;
    usize index = hash & mask;
    u32 fingerprint = mal_table_hash_fingerprint(hash);
    u64 probes = 0;

    while (table->slots[index] != MAL_TABLE_EMPTY) {
        probes++;
        MalTableEntry *entry = &table->entries[table->slots[index]];
        if (entry->live && entry->hash_fingerprint == fingerprint &&
            mal_key_value_equals(entry->key, key)) {
            break;
        }

        index = (index + 1) & mask;
    }

    if (mal_perf_stats_enabled) {
        MalPerfTableStats *stats = &mal_perf_stats.tables[table->role];
        stats->find_calls++;
        stats->probes += probes;
        if (probes > stats->max_probe) {
            stats->max_probe = probes;
        }
        if (mal_value_is_string(key)) {
            stats->string_queries++;
        }
    }

    return index;
}

static u32 mal_table_initial_capacity(const MalTable *table) {
    return table->role == MAL_TABLE_ROLE_ATOMS
            || table->role == MAL_TABLE_ROLE_SYMBOL_REGISTRY
        ? MAL_TABLE_GLOBAL_MIN_CAPACITY : MAL_TABLE_SMALL_MIN_CAPACITY;
}

static bool mal_table_slots_are_inline(const MalTable *table, const i32 *slots) {
    return slots == table->inline_slots;
}

static i32 *mal_table_allocate_slots(MalTable *table, u32 capacity) {
    if (capacity == MAL_TABLE_SMALL_MIN_CAPACITY) {
        return table->inline_slots;
    }
    return mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), capacity * sizeof(*table->slots),
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
}

static void mal_table_free_slots(MalTable *table, i32 *slots) {
    if (slots != nullptr && !mal_table_slots_are_inline(table, slots)) {
        gc_free_raw(mal_gc_current_heap(), slots);
    }
}

static void mal_table_allocate_storage(MalTable *table) {
    if (table->slot_capacity != 0) return;
    u32 capacity = mal_table_initial_capacity(table);
    MalHeap *heap = mal_gc_current_heap();
    table->slots = mal_table_allocate_slots(table, capacity);
    for (u32 i = 0; i < capacity; i++) table->slots[i] = MAL_TABLE_EMPTY;
    table->entries =
        mal_heap_alloc_raw_profiled(
            heap, capacity * sizeof(*table->entries),
            MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
    table->slot_capacity = capacity;
    table->entry_capacity = capacity;
    MAL_PERF_COUNT(tables[table->role].storage_allocations);
}

static void mal_table_close_delete_hole(MalTable *table, usize hole) {
    usize mask = table->slot_capacity - 1;
    usize scan = (hole + 1) & mask;

    while (table->slots[scan] != MAL_TABLE_EMPTY) {
        MAL_PERF_COUNT(tables[table->role].delete_cluster_scans);
        i32 entry_index = table->slots[scan];
        usize home = mal_table_hash_value(table->entries[entry_index].key) & mask;
        if (((hole - home) & mask) < ((scan - home) & mask)) {
            table->slots[hole] = entry_index;
            hole = scan;
            MAL_PERF_COUNT(tables[table->role].delete_slot_moves);
        }
        scan = (scan + 1) & mask;
    }

    table->slots[hole] = MAL_TABLE_EMPTY;
}

static void mal_table_rehash(MalTable *table, u32 capacity) {
    if (mal_perf_stats_enabled) {
        MalPerfTableStats *stats = &mal_perf_stats.tables[table->role];
        stats->rehashes++;
        stats->rehash_entries += table->size;
    }
    i32 *slots = mal_table_allocate_slots(table, capacity);
    for (u32 i = 0; i < capacity; i++) {
        slots[i] = MAL_TABLE_EMPTY;
    }

    usize mask = capacity - 1;
    for (u32 e = 0; e < table->entry_count; e++) {
        if (!table->entries[e].live) {
            continue;
        }
        usize index = mal_table_hash_value(table->entries[e].key) & mask;
        while (slots[index] != MAL_TABLE_EMPTY) {
            index = (index + 1) & mask;
        }
        slots[index] = (i32) e;
    }

    mal_table_free_slots(table, table->slots);
    table->slots = slots;
    table->slot_capacity = capacity;
}

static bool mal_table_grow_slots_if_needed(MalTable *table) {
    usize used_size = table->size + 1;

    if (used_size * MAL_TABLE_MAX_LOAD_DENOMINATOR <= table->slot_capacity * MAL_TABLE_MAX_LOAD_NUMERATOR) {
        return false;
    }

    if (mal_perf_stats_enabled) {
        mal_perf_stats.tables[table->role].slot_growths++;
    }
    mal_table_rehash(table, table->slot_capacity * 2);
    return true;
}

// Grows `entries` when the append cursor reaches capacity. The grow may move the
// buffer, but handles/iterators are indices, so they stay valid. Routed through the
// RAW space (gc_realloc_raw: alloc-new / copy / free-old) so the bytes count toward
// the GC trigger; no safepoint runs inside the allocator, so the detached old buffer
// is never observed by the collector (the entries it holds are copied forward and
// traced via the owner at the new address).
static void mal_table_grow_entries_if_needed(MalTable *table) {
    if (table->entry_count < table->entry_capacity) {
        return;
    }

    table->entry_capacity *= 2;
    table->entries = gc_realloc_raw_profiled(
        mal_gc_current_heap(), table->entries,
        sizeof(MalTableEntry) * table->entry_capacity,
        MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
}

static bool mal_table_should_compact(const MalTable *table) {
    return table->role == MAL_TABLE_ROLE_MAP && table->iterator_pins == 0
        && table->tombstone_count >= 16
        && table->tombstone_count > table->size;
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
    table->entry_count = 0;
    table->entry_capacity = 0;
    table->iterator_pins = 0;
    table->owner_released = false;
    table->slots = nullptr;
    table->entries = nullptr;

    return table;
}

void mal_table_free(MalTable *table) {
    // RAW frees touch the heap via mal_gc_current_heap(); the VM-global symbol/atom
    // tables must therefore be freed (mal_vm_free) before mal_heap_free tears the
    // heap down. Cell-owned tables are freed from finalizers, where the heap is live.
    MalHeap *heap = mal_gc_current_heap();

    // Owned descriptor data is held by every occupied cell (live or tombstoned)
    // until compact/free, so release all of them.
    for (u32 e = 0; e < table->entry_count; e++) {
        gc_free_raw(heap, table->entries[e].data);
    }

    mal_table_free_slots(table, table->slots);
    gc_free_raw(heap, table->entries);
    gc_free_raw(heap, table);
}

void mal_table_release_owner(MalTable *table) {
    if (table == nullptr) return;
    if (table->iterator_pins == 0) {
        mal_table_free(table);
    } else {
        table->owner_released = true;
    }
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

    u32 target_slots = mal_table_initial_capacity(table);
    while ((desired_size + 1) * MAL_TABLE_MAX_LOAD_DENOMINATOR >
           (usize) target_slots * MAL_TABLE_MAX_LOAD_NUMERATOR) {
        if (target_slots > (u32) INT32_MAX / 2) {
            return false;
        }
        target_slots *= 2;
    }

    MalHeap *heap = mal_gc_current_heap();
    if (table->slot_capacity == 0) {
        table->slots = mal_table_allocate_slots(table, target_slots);
        for (u32 i = 0; i < target_slots; i++) {
            table->slots[i] = MAL_TABLE_EMPTY;
        }
        table->entries = mal_heap_alloc_raw_profiled(
            heap, target_entries * sizeof(*table->entries),
            MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        table->slot_capacity = target_slots;
        table->entry_capacity = target_entries;
        MAL_PERF_COUNT(tables[table->role].storage_allocations);
        return true;
    }

    if (target_entries > table->entry_capacity) {
        table->entries = gc_realloc_raw_profiled(
            heap, table->entries, sizeof(*table->entries) * target_entries,
            MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION);
        table->entry_capacity = target_entries;
    }
    if (target_slots > table->slot_capacity) {
        mal_table_rehash(table, target_slots);
    }
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
            *value = entry->value;
            return true;
        }
    }
    MalTableLookup lookup = mal_table_lookup(table, (MalKey) {.kind = MAL_KEY_SYMBOL, .value = key});
    if (!lookup.present) return false;
    symbol->private_entry_hint = (u32) (uptr) lookup.entry;
    *value = table->entries[mal_table_handle_index(lookup.entry)].value;
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
    u64 hash = mal_table_hash_value(key.value);
    usize index = mal_table_find_slot(table, key.value, hash);
    i32 entry = table->slots[index];

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
    if (mal_table_should_compact(table)) mal_table_compact(table);
    mal_table_allocate_storage(table);
    u64 hash = mal_table_hash_value(key.value);
    usize index = mal_table_find_slot(table, key.value, hash);
    if (table->slots[index] != MAL_TABLE_EMPTY) {
        if (stats != nullptr) {
            stats->upsert_hits++;
        }
        if (inserted != nullptr) *inserted = false;
        return mal_table_handle((u32) table->slots[index]);
    }

    // Entry-buffer growth preserves the slot array. Only slot growth rehashes and
    // invalidates the empty index found above.
    mal_table_grow_entries_if_needed(table);
    if (mal_table_grow_slots_if_needed(table)) {
        index = mal_table_find_slot(table, key.value, hash);
    }

    u32 entry_index = table->entry_count++;
    MalTableEntry *entry = &table->entries[entry_index];
    entry->key = key.value;
    entry->data = nullptr;
    entry->value = mal_value_new_undefined();
    entry->hash_fingerprint = mal_table_hash_fingerprint(hash);
    entry->property_flags = 0;
    entry->live = true;

    table->slots[index] = (i32) entry_index;
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
    u64 hash = mal_table_hash_value(key.value);
    usize index = mal_table_find_slot(table, key.value, hash);
    i32 entry_index = table->slots[index];

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
    mal_gc_write_barrier(entry->value);

    // Tombstone the cell in place (keeps insertion order / outstanding indices
    // valid); the sweep-out of dead cells happens in compact.
    entry->live = false;
    table->size--;
    table->tombstone_count++;

    // Preserve every surviving probe chain without reallocating the slot array.
    mal_table_close_delete_hole(table, index);

    return true;
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
            mal_gc_write_barrier(table->entries[e].value);
            table->entries[e].live = false;
            table->tombstone_count++;
        }
    }

    table->size = 0;

    for (u32 i = 0; i < table->slot_capacity; i++) {
        table->slots[i] = MAL_TABLE_EMPTY;
    }
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
            gc_free_raw(mal_gc_current_heap(), entry->data);
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
        mal_table_free_slots(table, table->slots);
        gc_free_raw(mal_gc_current_heap(), table->entries);
        table->slots = nullptr;
        table->entries = nullptr;
        table->slot_capacity = 0;
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

    u32 target_slots = mal_table_initial_capacity(table);
    while (((usize) table->size + 1) * MAL_TABLE_MAX_LOAD_DENOMINATOR
           > (usize) target_slots * MAL_TABLE_MAX_LOAD_NUMERATOR) {
        target_slots *= 2;
    }
    mal_table_rehash(table, target_slots);
}

void mal_table_pin(MalTable *table) {
    if (table != nullptr) table->iterator_pins++;
}

void mal_table_unpin(MalTable *table) {
    if (table == nullptr || table->iterator_pins == 0) return;
    table->iterator_pins--;
    if (table->iterator_pins == 0 && table->owner_released) {
        mal_table_free(table);
    }
}

MalKey mal_table_entry_key(const MalTable *table, void *entry) {
    return mal_key_from_value(table->entries[mal_table_handle_index(entry)].key);
}

void *mal_table_entry_data(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].data;
}

void mal_table_entry_set_owned_data(MalTable *table, void *entry, void *data) {
    table->entries[mal_table_handle_index(entry)].data = data;
}

u8 mal_table_entry_property_flags(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].property_flags;
}

void mal_table_entry_set_property_flags(
    MalTable *table, void *entry, u8 flags) {
    table->entries[mal_table_handle_index(entry)].property_flags = flags;
}

MalValue mal_table_entry_value(const MalTable *table, void *entry) {
    return table->entries[mal_table_handle_index(entry)].value;
}

void mal_table_entry_set_value(MalTable *table, void *entry, MalValue value) {
    // SATB: replacing a live entry's value (e.g. Map.set on an existing key) drops
    // the old value. Every handle comes from upsert/lookup/iter, so the slot is
    // always initialized (upsert seeds it undefined), making this safe to shade
    // unconditionally. Folds out off-cycle.
    mal_gc_write_barrier(table->entries[mal_table_handle_index(entry)].value);
    table->entries[mal_table_handle_index(entry)].value = value;
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
    u64 hash = mal_table_hash_value(key.value);
    return candidate->live &&
        candidate->hash_fingerprint == mal_table_hash_fingerprint(hash) &&
        mal_key_value_equals(candidate->key, key.value);
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
