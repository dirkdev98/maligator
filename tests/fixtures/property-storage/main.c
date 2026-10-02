#include <stdio.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "hash_index.h"
#include "object_ops.h"
#include "table.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "property-storage:%d: %s\n", __LINE__, #test); return false; } } while (0)

static MalKey string_key(MalString *string) {
    return (MalKey) {.kind = MAL_KEY_STRING, .value = mal_value_from_string(string)};
}

static MalPropertyDesc data_desc(MalValue value) {
    return (MalPropertyDesc) {.flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = value, .getter = MAL_VALUE_UNDEFINED, .setter = MAL_VALUE_UNDEFINED};
}

static bool check_indices_and_charge(MalVm *vm) {
    usize before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    MalTable *table = mal_table_new();
    usize descriptor = mal_heap_usage(&vm->heap).raw_owned_bytes - before;
    CHECK(mal_table_reserve(table, 64));
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes - before == descriptor +
        mal_heap_allocation_charge(64 * 16) + mal_heap_allocation_charge(mal_hash_index_bytes(128)));
    const u32 indices[] = {0, 1, INT32_MAX, (u32) INT32_MAX + 1, UINT32_MAX - 1};
    for (usize i = 0; i < countof(indices); i++) {
        void *entry = mal_table_upsert_entry(table, mal_key_index(indices[i]), nullptr);
        mal_table_entry_set_value(table, entry, i == 0 ? MAL_VALUE_EMPTY : mal_value_from_i32((i32) i));
        MalKey alternate = {.kind = MAL_KEY_INDEX, .value = mal_value_from_f64((f64) indices[i])};
        bool inserted = true;
        CHECK(mal_table_upsert_entry(table, alternate, &inserted) == entry && !inserted);
        CHECK(mal_table_lookup(table, alternate).entry == entry);
        CHECK(mal_table_entry_key(table, entry).value == mal_key_index(indices[i]).value);
        CHECK(mal_table_entry_matches(table, entry, mal_table_handle_epoch(table), alternate));
    }
    CHECK(mal_table_lookup(table, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_f64(-0.0)}).entry ==
        mal_table_lookup(table, mal_key_index(0)).entry);
    MalKey numeric_string = string_key(mal_string_new_ascii(&vm->heap, "1", 1));
    MalKey largest_string = string_key(mal_string_new_ascii(&vm->heap, "4294967295", 10));
    mal_property_set_value(table, numeric_string, MAL_VALUE_TRUE);
    mal_property_set_value(table, largest_string, MAL_VALUE_FALSE);
    CHECK(mal_table_size(table) == 7);
    CHECK(mal_property_lookup(table, numeric_string).desc.value == MAL_VALUE_TRUE);
    CHECK(mal_property_lookup(table, mal_key_index(1)).desc.value == mal_value_from_i32(1));
    CHECK(mal_table_delete(table, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_f64(1.0)}));
    CHECK(mal_table_lookup(table, numeric_string).present);
    MalTableIter iter;
    mal_table_iter_init(&iter, table, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    CHECK(mal_table_iter_next(&iter, &key, &entry) && key.kind == MAL_KEY_INDEX && mal_key_index_value(key) == 0);
    CHECK(mal_table_entry_is_live(table, entry) && mal_table_entry_value(table, entry) == MAL_VALUE_EMPTY);
    CHECK(!mal_table_reserve(table, SIZE_MAX));
    mal_table_free(table);
    return true;
}

static bool check_strings(MalVm *vm) {
    MalTable *table = mal_table_new();
    const char text[] = "non-atom-property-with-borrowed-probes";
    MalString *stored = mal_string_new_ascii(&vm->heap, text, sizeof(text) - 1);
    CHECK(!stored->property_atom);
    void *first = mal_property_set_value(table, string_key(stored), MAL_VALUE_TRUE);
    c16 wide[sizeof(text) - 1];
    for (usize i = 0; i < countof(wide); i++) wide[i] = (u8) text[i];
    MalString probe;
    mal_string_init_external(&probe, wide, countof(wide));
    CHECK(!probe.hash_valid);
    CHECK(mal_table_lookup(table, string_key(&probe)).entry == first && !probe.hash_valid);
    CHECK(mal_table_entry_matches(table, first, mal_table_handle_epoch(table), string_key(&probe)));
    CHECK(!probe.hash_valid);
    MalString *equal = mal_string_new_copy(&vm->heap, wide, countof(wide));
    CHECK(equal != stored);
    CHECK(mal_property_set_value(table, string_key(equal), MAL_VALUE_FALSE) == first);
    CHECK(mal_table_entry_key(table, first).value == mal_value_from_string(stored));
    for (u32 i = 0; i < 32; i++) mal_table_upsert_entry(table, mal_key_index(i), nullptr);
    CHECK(mal_table_lookup(table, string_key(&probe)).entry == first && probe.hash_valid);
    CHECK(mal_table_entry_matches(table, first, mal_table_handle_epoch(table), string_key(&probe)));
    memset(wide, 0, sizeof(wide));
    CHECK(mal_table_entry_key(table, first).value == mal_value_from_string(stored));

    const c16 unicode[] = {0x100, 0xd83d, 0xde00, 'p', 'r', 'o', 'p'};
    MalString *utf16 = mal_string_new_copy(&vm->heap, unicode, countof(unicode));
    MalString utf16_probe;
    mal_string_init_external(&utf16_probe, unicode, countof(unicode));
    mal_property_set_value(table, string_key(utf16), MAL_VALUE_NULL);
    CHECK(mal_property_lookup(table, string_key(&utf16_probe)).desc.value == MAL_VALUE_NULL);
    const char left_text[] = "abcdefghijklmnopqrstuvwxyz0123456789";
    MalString *left = mal_string_new_ascii(&vm->heap, left_text, sizeof(left_text) - 1);
    MalString *right = mal_string_new_ascii(&vm->heap, "ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210", 36);
    MalString *rope;
    CHECK(mal_string_new_cons_checked(&vm->heap, left, right, &rope));
    CHECK(rope->storage == MAL_STRING_STORAGE_CONS);
    char rope_text[72];
    memcpy(rope_text, left_text, 36);
    memcpy(rope_text + 36, "ABCDEFGHIJKLMNOPQRSTUVWXYZ9876543210", 36);
    MalString rope_probe;
    mal_string_init_external_latin1(&rope_probe, (const u8 *) rope_text, sizeof(rope_text));
    mal_property_set_value(table, string_key(rope), MAL_VALUE_TRUE);
    CHECK(mal_property_lookup(table, string_key(&rope_probe)).desc.value == MAL_VALUE_TRUE);
    MalString *slice = mal_string_new_slice(&vm->heap, left, 1, 30);
    CHECK(slice->storage == MAL_STRING_STORAGE_DEPENDENT);
    MalString slice_probe;
    mal_string_init_external_latin1(&slice_probe, (const u8 *) left_text + 1, 30);
    mal_property_set_value(table, string_key(slice), MAL_VALUE_FALSE);
    CHECK(mal_property_lookup(table, string_key(&slice_probe)).desc.value == MAL_VALUE_FALSE);
    CHECK(mal_table_delete(table, string_key(&slice_probe)));
    mal_table_free(table);
    return true;
}

static bool check_hash_filter_collisions(MalVm *vm) {
    MalTable *table = mal_table_new();
    MalString *first = mal_string_new_ascii(&vm->heap, "fingerprint-collision-0", 23);
    u64 hash = mal_key_hash_value(mal_value_from_string(first));
    char text[64];
    usize length = 0;
    for (u32 i = 1;; i++) {
        length = (usize) snprintf(text, sizeof(text), "fingerprint-collision-%u", i);
        MalString probe;
        mal_string_init_external_latin1(&probe, (const u8 *) text, length);
        u64 other = mal_key_hash_value(mal_value_from_string(&probe));
        if ((hash >> 51) == (other >> 51) && hash != other) break;
        CHECK(i < 1000000);
    }
    MalString *second = mal_string_new_ascii(&vm->heap, text, length);
    void *anchor = mal_property_set_value(table, string_key(first), MAL_VALUE_TRUE);
    for (u32 i = 0; i < 8; i++) mal_table_upsert_entry(table, mal_key_index(i), nullptr);
    CHECK(!mal_table_lookup(table, string_key(second)).present);
    CHECK(!mal_table_entry_matches(table, anchor, mal_table_handle_epoch(table), string_key(second)));
    mal_property_set_value(table, string_key(second), MAL_VALUE_FALSE);
    CHECK(mal_property_lookup(table, string_key(first)).desc.value == MAL_VALUE_TRUE);
    CHECK(mal_property_lookup(table, string_key(second)).desc.value == MAL_VALUE_FALSE);
    mal_table_free(table);
    return true;
}

static bool keep_odd_index(MalValue value) {
    return (mal_key_index_value(mal_key_from_value(value)) & 1) != 0;
}

static bool check_metadata_and_cursors(MalVm *vm) {
    MalTable *table = mal_table_new();
    MalSymbol *private = mal_symbol_new_private(&vm->heap);
    MalSymbol *other = mal_symbol_new_private(&vm->heap);
    MalKey key = mal_key_from_value(mal_value_from_symbol(private));
    void *anchor = mal_property_set_value(table, key, MAL_VALUE_TRUE);
    MalValue value;
    MalString *description = mal_string_new_ascii(&vm->heap, "same-symbol-description", 23);
    MalKey public_key = mal_key_from_value(mal_value_from_symbol(mal_symbol_new(&vm->heap, description)));
    MalKey other_public = mal_key_from_value(mal_value_from_symbol(mal_symbol_new(&vm->heap, description)));
    mal_property_set_value(table, public_key, MAL_VALUE_TRUE);
    CHECK(!mal_table_lookup(table, other_public).present);
    mal_property_set_value(table, other_public, MAL_VALUE_FALSE);
    CHECK(mal_property_lookup(table, public_key).desc.value == MAL_VALUE_TRUE);
    CHECK(mal_property_lookup(table, other_public).desc.value == MAL_VALUE_FALSE);
    CHECK(mal_table_delete(table, public_key) && mal_table_delete(table, other_public));
    CHECK(mal_table_get_private_value(table, private, &value) && value == MAL_VALUE_TRUE);
    other->private_entry_hint = private->private_entry_hint;
    CHECK(!mal_table_get_private_value(table, other, &value));
    for (u8 flags = 0; flags < 128; flags++) {
        mal_table_entry_set_property_flags(table, anchor, flags);
        CHECK(mal_table_entry_property_flags(table, anchor) == flags);
        CHECK(mal_table_entry_key(table, anchor).value == key.value);
    }
    mal_table_entry_set_property_flags(table, anchor, MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc accessor = {.flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE |
        MAL_PROPERTY_PRIMORDIAL | MAL_PROPERTY_LOCKED_SETTER, .value = MAL_VALUE_UNDEFINED,
        .getter = MAL_VALUE_UNDEFINED, .setter = MAL_VALUE_UNDEFINED};
    usize before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    mal_property_write_entry(table, anchor, &accessor);
    CHECK(mal_table_entry_data(table, anchor) != nullptr);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == before + mal_heap_allocation_charge(16));
    MalPropertyDesc data = data_desc(MAL_VALUE_EMPTY);
    mal_property_write_entry(table, anchor, &data);
    CHECK(mal_table_entry_data(table, anchor) == nullptr && mal_table_entry_value(table, anchor) == MAL_VALUE_EMPTY);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == before);
    mal_property_write_entry(table, anchor, &accessor);
    mal_table_pin(table);
    u64 epoch = mal_table_handle_epoch(table);
    MalTableIter iter;
    mal_table_iter_init(&iter, table, MAL_TABLE_ITER_STORAGE);
    void *entry;
    MalKey observed;
    CHECK(mal_table_iter_next(&iter, &observed, &entry) && observed.value == key.value);
    for (u32 i = 0; i < 96; i++) mal_property_set_value(table, mal_key_index(i), mal_value_from_u32(i));
    CHECK(mal_table_entry_matches(table, anchor, epoch, key));
    CHECK(mal_table_delete(table, key));
    CHECK(!mal_table_entry_is_live(table, anchor));
    CHECK(mal_table_entry_data(table, anchor) != nullptr);
    CHECK(mal_table_entry_property_flags(table, anchor) == accessor.flags);
    mal_table_compact(table);
    CHECK(mal_table_handle_epoch(table) == epoch);
    CHECK(mal_table_retain(table, keep_odd_index) == 48);
    CHECK(mal_table_size(table) == 48);
    mal_table_clear(table);
    void *appended = mal_property_set_value(table, key, MAL_VALUE_NULL);
    CHECK(appended != anchor && mal_table_handle_epoch(table) == epoch);
    CHECK(mal_table_iter_next(&iter, &observed, &entry) && observed.value == key.value && entry == appended);
    CHECK(!mal_table_iter_next(&iter, &observed, &entry));
    mal_table_unpin(table);
    before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    mal_table_compact(table);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes < before);
    CHECK(!mal_table_entry_matches(table, appended, epoch, key));
    CHECK(mal_table_get_private_value(table, private, &value) && value == MAL_VALUE_NULL);
    u8 flags;
    entry = mal_table_lookup(table, key).entry;
    CHECK(mal_table_read_entry_hint(table, entry, key.value, &value, &flags) && value == MAL_VALUE_NULL);
    CHECK(!mal_table_read_entry_hint(table, entry, mal_value_from_symbol(other), &value, &flags));
    mal_table_free(table);
    return true;
}

static bool check_dead_sidecar_ownership(MalVm *vm) {
    usize before = mal_heap_usage(&vm->heap).raw_owned_bytes;
    MalTable *table = mal_table_new();
    usize descriptor = mal_heap_usage(&vm->heap).raw_owned_bytes - before;
    MalPropertyDesc accessor = {.flags = MAL_PROPERTY_ACCESSOR,
        .value = MAL_VALUE_UNDEFINED, .getter = MAL_VALUE_UNDEFINED, .setter = MAL_VALUE_UNDEFINED};
    void *entry = mal_property_define(table, mal_key_index(7), &accessor);
    void *sidecar = mal_table_entry_data(table, entry);
    CHECK(sidecar != nullptr);
    mal_table_entry_set_property_flags(table, entry, MAL_PROPERTY_NONE);
    CHECK(mal_table_entry_data(table, entry) == sidecar);
    mal_table_pin(table);
    usize occupied = mal_heap_usage(&vm->heap).raw_owned_bytes;
    CHECK(mal_table_delete(table, mal_key_index(7)));
    CHECK(mal_table_entry_data(table, entry) == sidecar);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == occupied);
    mal_table_unpin(table);
    mal_table_compact(table);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == before + descriptor);
    mal_table_free(table);
    CHECK(mal_heap_usage(&vm->heap).raw_owned_bytes == before);
    return true;
}

static MalValue getter(MalVm *vm, MalValue self, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) count; (void) target; (void) callee;
    return MAL_VALUE_UNDEFINED;
}

static bool check_owner_gc(MalVm *vm) {
    MalObject *owners[3];
    MalValue roots[3];
    for (usize i = 0; i < countof(owners); i++) {
        owners[i] = mal_object_new(&vm->heap, nullptr);
        roots[i] = mal_value_from_object(owners[i]);
        mal_object_properties(owners[i]);
    }
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_collect(vm);
    for (usize i = 0; i < countof(owners); i++) CHECK(mal_heap_mark_is_old(owners[i]->header.mark));
    MalObject *young_value = mal_object_new(&vm->heap, nullptr);
    MalString *young_key = mal_string_new_ascii(&vm->heap, "young-non-atom-property-key", 27);
    MalNativeFunctionObject *young_getter = mal_native_function_object_new(&vm->heap, nullptr, nullptr, getter);
    CHECK(!young_key->property_atom);
    CHECK(mal_object_set(owners[0], mal_key_index(0), mal_value_from_object(young_value)));
    CHECK(mal_object_set(owners[1], string_key(young_key), MAL_VALUE_TRUE));
    MalPropertyDesc accessor = {.flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = MAL_VALUE_UNDEFINED, .getter = mal_value_from_object(&young_getter->object), .setter = MAL_VALUE_UNDEFINED};
    CHECK(mal_object_define_own(owners[2], mal_key_index(0), &accessor) == MAL_DEFINE_OWN_APPLIED);
    vm->heap.gc_stats = true;
    u64 inspected = vm->heap.minor_cells_inspected;
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(!mal_gc_marking_active);
    CHECK(vm->heap.minor_cells_inspected > inspected);
    CHECK(!(young_value->header.mark & MAL_MARK_FREE) && mal_heap_mark_is_old(young_value->header.mark));
    CHECK(!(young_key->header.mark & MAL_MARK_FREE) && mal_heap_mark_is_old(young_key->header.mark));
    CHECK(!(young_getter->object.header.mark & MAL_MARK_FREE));
    MalString probe;
    mal_string_init_external_latin1(&probe, (const u8 *) "young-non-atom-property-key", 27);
    CHECK(mal_object_get_own(owners[1], string_key(&probe)).desc.value == MAL_VALUE_TRUE);
    mal_gc_collect(vm);
    CHECK(mal_object_get_own(owners[0], mal_key_index(0)).desc.value == mal_value_from_object(young_value));
    CHECK(mal_object_get_own(owners[2], mal_key_index(0)).desc.getter == accessor.getter);
    mal_gc_unroot(&span);
    mal_gc_collect(vm);
    return true;
}

static MalHeapHeader *tracked_string;
static MalHeapHeader *tracked_object;
static bool tracked_string_live;
static u32 object_finalizations;

static void observe_tracked_string(MalHeapHeader *cell) {
    if (cell == tracked_string && (cell->mark & MAL_MARK_FREE) == 0) tracked_string_live = true;
}

static bool tracked_string_is_live(MalVm *vm) {
    tracked_string_live = false;
    mal_heap_walk_cells(&vm->heap, observe_tracked_string);
    return tracked_string_live;
}

static void count_object_finalized(MalHeapHeader *cell) {
    if (cell == tracked_object) object_finalizations++;
}

static bool check_snapshot_delete(MalVm *vm) {
    MalObject *owner = mal_object_new(&vm->heap, nullptr);
    MalValue root = mal_value_from_object(owner);
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    mal_object_properties(owner);
    MalString *key = mal_string_new_ascii(&vm->heap, "snapshot-deleted-non-atom-key", 29);
    MalObject *value = mal_object_new(&vm->heap, nullptr);
    CHECK(mal_object_set(owner, string_key(key), mal_value_from_object(value)));
    tracked_string = &key->header;
    tracked_object = &value->header;
    object_finalizations = 0;
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, count_object_finalized);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(mal_gc_marking_active);
    CHECK(mal_object_delete_own(owner, string_key(key)));
    CHECK(mal_gc_finish_pending_cycle(vm));
    CHECK(tracked_string_is_live(vm) && object_finalizations == 0);
    mal_gc_collect(vm);
    CHECK(!tracked_string_is_live(vm) && object_finalizations == 1);
    mal_gc_register_finalizer(MAL_HEAP_OBJECT, nullptr);
    mal_gc_unroot(&span);
    return true;
}

static bool check_reclaimed_member_teardown(MalVm *vm) {
    MalTable *table = mal_table_new();
    MalString *key = mal_string_new_ascii(&vm->heap, "unrooted-key-before-raw-teardown", 32);
    MalPropertyDesc desc = {.flags = MAL_PROPERTY_ACCESSOR, .value = MAL_VALUE_UNDEFINED,
        .getter = MAL_VALUE_UNDEFINED, .setter = MAL_VALUE_UNDEFINED};
    void *entry = mal_property_define(table, string_key(key), &desc);
    void *sidecar = mal_table_entry_data(table, entry);
    CHECK(sidecar != nullptr);
    tracked_string = &key->header;
    CHECK(tracked_string_is_live(vm));
    mal_gc_collect(vm);
    CHECK(!tracked_string_is_live(vm));
    mal_table_free(table);
    CHECK(!tracked_string_is_live(vm));
    return true;
}

static usize no_workers(void) { return 0; }

int main(void) {
    mal_gc_test_worker_limit_hook = no_workers;
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    bool ok = check_indices_and_charge(&vm) && check_strings(&vm) && check_hash_filter_collisions(&vm)
        && check_metadata_and_cursors(&vm) && check_dead_sidecar_ownership(&vm)
        && check_owner_gc(&vm) && check_reclaimed_member_teardown(&vm);
    mal_vm_free(&vm);
    if (ok) {
        mal_vm_init(&vm, &mal_runtime_image);
        vm.heap.next_gc_at = SIZE_MAX;
        ok = check_snapshot_delete(&vm);
        mal_vm_free(&vm);
    }
    mal_gc_test_worker_limit_hook = nullptr;
    if (ok) puts("property-storage ABI PASS");
    return ok ? 0 : 1;
}
