#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "gc.h"
#include "intern_store.h"
#include "intrinsics.h"
#include "table.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

#define CHECK(condition) do { \
    if (!(condition)) { \
        fprintf(stderr, "intern-stores:%d: %s\n", __LINE__, #condition); \
        return false; \
    } \
} while (0)

static void collect_young(MalVm *vm) {
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    mal_gc_finish_pending_cycle(vm);
}

typedef struct IncrementalEntry {
    MalString *atom;
    MalSymbol *symbol;
    MalString *name;
    MalString *source;
} IncrementalEntry;

static IncrementalEntry insert_incremental_entry(MalVm *vm, usize index) {
    char name[96];
    usize length = (usize) snprintf(name, sizeof(name), "incremental-atom-%zu-abcdefghijklmnop", index);
    MalString *atom = mal_property_atomize_string(vm, mal_string_new_ascii(&vm->heap, name, length));
    length = (usize) snprintf(name, sizeof(name), "incremental-symbol-%zu-abcdefghijklmnop", index);
    MalSymbol *symbol = mal_symbol_new(&vm->heap, mal_string_new_ascii(&vm->heap, name, length));
    mal_symbol_registry_insert(&vm->symbol_registry, symbol);
    length = (usize) snprintf(name, sizeof(name), "incremental-source-%zu-abcdefghijklmnop", index);
    MalString *cache_name = mal_string_new_ascii(&vm->heap, name, length);
    MalString *source = mal_string_new_ascii(&vm->heap, "incremental-cache-value", sizeof("incremental-cache-value") - 1);
    mal_native_source_cache_insert(&vm->native_source_cache, cache_name, source);
    return (IncrementalEntry) {.atom = atom, .symbol = symbol, .name = cache_name, .source = source};
}

static bool check_incremental_entry(MalVm *vm, usize index, IncrementalEntry expected) {
    char name[96];
    MalString probe;
    usize length = (usize) snprintf(name, sizeof(name), "incremental-atom-%zu-abcdefghijklmnop", index);
    mal_string_init_external_latin1(&probe, (const u8 *) name, length);
    CHECK(mal_atom_store_find(&vm->atoms, &probe) == expected.atom);
    CHECK(!(expected.atom->header.mark & MAL_MARK_FREE));
    length = (usize) snprintf(name, sizeof(name), "incremental-symbol-%zu-abcdefghijklmnop", index);
    mal_string_init_external_latin1(&probe, (const u8 *) name, length);
    CHECK(mal_symbol_registry_find(&vm->symbol_registry, &probe) == expected.symbol);
    CHECK(!(expected.symbol->header.mark & MAL_MARK_FREE));
    CHECK(!(expected.symbol->description->header.mark & MAL_MARK_FREE));
    length = (usize) snprintf(name, sizeof(name), "incremental-source-%zu-abcdefghijklmnop", index);
    mal_string_init_external_latin1(&probe, (const u8 *) name, length);
    CHECK(mal_native_source_cache_find(&vm->native_source_cache, &probe) == expected.source);
    CHECK(!(expected.name->header.mark & MAL_MARK_FREE));
    CHECK(!(expected.source->header.mark & MAL_MARK_FREE));
    return true;
}

static bool check_incremental_growth(MalVm *vm) {
    IncrementalEntry initial[32];
    for (usize index = 0; index < countof(initial); index++) {
        initial[index] = insert_incremental_entry(vm, index);
    }
    usize atom_capacity = mal_atom_store_capacity(&vm->atoms);
    usize registry_capacity = mal_symbol_registry_capacity(&vm->symbol_registry);
    usize source_capacity = mal_native_source_cache_capacity(&vm->native_source_cache);
    usize count = atom_capacity;
    if (count < registry_capacity) count = registry_capacity;
    if (count < source_capacity) count = source_capacity;
    // Expected pointers stay outside GC root spans, so only the VM stores can retain these cells.
    IncrementalEntry *inserted = calloc(count, sizeof(*inserted));
    CHECK(inserted != nullptr);
    vm->heap.next_gc_at = 1;
    mal_gc_poll = true;
    mal_gc_safepoint(vm);
    CHECK(mal_gc_marking_active);
    for (usize index = 0; index < count; index++) {
        inserted[index] = insert_incremental_entry(vm, index + countof(initial));
    }
    CHECK(mal_gc_marking_active);
    CHECK(mal_atom_store_capacity(&vm->atoms) > atom_capacity);
    CHECK(mal_symbol_registry_capacity(&vm->symbol_registry) > registry_capacity);
    CHECK(mal_native_source_cache_capacity(&vm->native_source_cache) > source_capacity);
    CHECK(mal_gc_finish_pending_cycle(vm));
    // A fresh major removes the black-allocation protection of entries born during marking.
    mal_gc_collect(vm);
    bool ok = true;
    for (usize index = 0; index < countof(initial) && ok; index++) {
        ok = check_incremental_entry(vm, index, initial[index]);
    }
    for (usize index = 0; index < count && ok; index++) {
        ok = check_incremental_entry(vm, index + countof(initial), inserted[index]);
    }
    free(inserted);
    return ok;
}

static bool check_atoms(MalVm *vm) {
    usize initial = mal_atom_store_size(&vm->atoms);
    MalString *first = nullptr;
    MalString *expected[512];
    char name[96];
    for (usize index = 0; index < 512; index++) {
        usize length = (usize) snprintf(name, sizeof(name), "interned-property-name-%zu-abcdefghijklmnop", index);
        MalString *atom = mal_intrinsic_ascii(vm, name);
        expected[index] = atom;
        CHECK(atom->property_atom);
        if (index == 0) first = atom;
        MalString latin1;
        mal_string_init_external_latin1(&latin1, (const u8 *) name, length);
        CHECK(mal_atom_store_find(&vm->atoms, &latin1) == atom);
        c16 units[96];
        for (usize unit = 0; unit < length; unit++) units[unit] = (u8) name[unit];
        MalString utf16;
        mal_string_init_external(&utf16, units, length);
        CHECK(mal_atom_store_find(&vm->atoms, &utf16) == atom);
        MalString *equal = mal_string_new_ascii(&vm->heap, name, length);
        CHECK(equal != atom);
        CHECK(mal_atom_store_intern(&vm->atoms, equal) == atom);
        CHECK(mal_property_atomize_string(vm, equal) == atom);
        memset(name, '?', length);
    }
    CHECK(mal_atom_store_size(&vm->atoms) == initial + 512);
    const c16 wide_units[] = {0x0100, 0xd83d, 0xde00, 'x'};
    MalString *wide = mal_property_atomize_string(vm,
        mal_string_new_copy(&vm->heap, wide_units, countof(wide_units)));
    MalString wide_probe;
    mal_string_init_external(&wide_probe, wide_units, countof(wide_units));
    CHECK(mal_atom_store_find(&vm->atoms, &wide_probe) == wide);
    usize bytes = mal_atom_store_allocation_bytes(&vm->atoms);
    MalString absent;
    mal_string_init_external_latin1(&absent, (const u8 *) "unretained-stack-probe", 22);
    CHECK(mal_atom_store_find(&vm->atoms, &absent) == nullptr);
    CHECK(mal_atom_store_size(&vm->atoms) == initial + 513);
    CHECK(mal_atom_store_allocation_bytes(&vm->atoms) == bytes);
    mal_gc_collect(vm);
    MalString *young = mal_intrinsic_ascii(vm, "young-atom-held-only-by-the-vm");
    collect_young(vm);
    CHECK(mal_intrinsic_ascii(vm, "young-atom-held-only-by-the-vm") == young);
    for (usize index = 0; index < countof(expected); index++) {
        usize length = (usize) snprintf(name, sizeof(name), "interned-property-name-%zu-abcdefghijklmnop", index);
        MalString probe;
        mal_string_init_external_latin1(&probe, (const u8 *) name, length);
        CHECK(mal_atom_store_find(&vm->atoms, &probe) == expected[index]);
        CHECK(!(expected[index]->header.mark & MAL_MARK_FREE));
    }
    CHECK(mal_atom_store_find(&vm->atoms, &wide_probe) == wide);
    mal_gc_collect(vm);
    CHECK(mal_intrinsic_ascii(vm, "interned-property-name-0-abcdefghijklmnop") == first);
    CHECK(mal_intrinsic_ascii(vm, "young-atom-held-only-by-the-vm") == young);
    return true;
}

static bool check_registry_and_sources(MalVm *vm) {
    usize initial_registry = mal_symbol_registry_size(&vm->symbol_registry);
    usize initial_sources = mal_native_source_cache_size(&vm->native_source_cache);
    MalSymbol *first = nullptr;
    MalString *first_source = nullptr;
    MalSymbol *expected_symbols[512];
    MalString *expected_sources[512];
    char name[96];
    for (usize index = 0; index < 512; index++) {
        usize length = (usize) snprintf(name, sizeof(name), "registry-only-description-%zu-abcdefghijklmnop", index);
        MalString *description = mal_string_new_ascii(&vm->heap, name, length);
        MalSymbol *symbol = mal_symbol_new(&vm->heap, description);
        CHECK(mal_symbol_registry_insert(&vm->symbol_registry, symbol) == symbol);
        expected_symbols[index] = symbol;
        CHECK(symbol->registered && !description->property_atom);
        MalString probe;
        mal_string_init_external_latin1(&probe, (const u8 *) name, length);
        CHECK(mal_symbol_registry_find(&vm->symbol_registry, &probe) == symbol);
        MalSymbol *duplicate = mal_symbol_new(&vm->heap, mal_string_new_ascii(&vm->heap, name, length));
        CHECK(mal_symbol_registry_insert(&vm->symbol_registry, duplicate) == symbol);
        if (index == 0) first = symbol;

        length = (usize) snprintf(name, sizeof(name), "internalCallableName%zu", index);
        MalString *cache_name = mal_intrinsic_ascii(vm, name);
        MalString *source = mal_string_new_ascii(&vm->heap, "native-source-held-only-by-cache", 32);
        CHECK(mal_native_source_cache_insert(&vm->native_source_cache, cache_name, source) == source);
        expected_sources[index] = source;
        MalString *equal_name = mal_string_new_ascii(&vm->heap, name, length);
        MalString *other_source = mal_string_new_ascii(&vm->heap, "rejected-source", 15);
        CHECK(mal_native_source_cache_insert(&vm->native_source_cache, equal_name, other_source) == source);
        CHECK(mal_native_source_cache_find(&vm->native_source_cache, equal_name) == source);
        if (index == 0) first_source = source;
    }
    CHECK(mal_symbol_registry_size(&vm->symbol_registry) == initial_registry + 512);
    CHECK(mal_native_source_cache_size(&vm->native_source_cache) == initial_sources + 512);
    MalString *private_name = mal_string_new_ascii(&vm->heap, "source-cache-only-name", 22);
    MalString *private_source = mal_string_new_ascii(&vm->heap, "source-cache-only-source", 24);
    CHECK(!private_name->property_atom);
    CHECK(mal_native_source_cache_insert(&vm->native_source_cache, private_name, private_source) == private_source);
    collect_young(vm);
    CHECK(!(private_name->header.mark & MAL_MARK_FREE));
    CHECK(!(private_source->header.mark & MAL_MARK_FREE));
    for (usize index = 0; index < countof(expected_symbols); index++) {
        CHECK(!(expected_symbols[index]->header.mark & MAL_MARK_FREE));
        CHECK(!(expected_sources[index]->header.mark & MAL_MARK_FREE));
    }
    mal_gc_collect(vm);
    for (usize index = 0; index < countof(expected_symbols); index++) {
        CHECK(!(expected_symbols[index]->header.mark & MAL_MARK_FREE));
        CHECK(!(expected_sources[index]->header.mark & MAL_MARK_FREE));
    }
    MalString probe;
    mal_string_init_external_latin1(&probe, (const u8 *) "source-cache-only-name", 22);
    CHECK(mal_native_source_cache_find(&vm->native_source_cache, &probe) == private_source);
    CHECK(!(private_name->header.mark & MAL_MARK_FREE));
    CHECK(!(private_source->header.mark & MAL_MARK_FREE));
    mal_string_init_external_latin1(&probe, (const u8 *) "registry-only-description-0-abcdefghijklmnop", 44);
    CHECK(mal_symbol_registry_find(&vm->symbol_registry, &probe) == first);
    CHECK(mal_string_equals_ascii(first->description, "registry-only-description-0-abcdefghijklmnop"));
    CHECK(first->registered);
    CHECK(mal_native_source_cache_find(&vm->native_source_cache,
        mal_intrinsic_ascii(vm, "internalCallableName0")) == first_source);
    CHECK(mal_string_equals_ascii(first_source, "native-source-held-only-by-cache"));
    return true;
}

static bool check_storage_charge_and_release(MalVm *vm) {
    MalAtomStore atoms = {0};
    MalSymbolRegistry registry = {0};
    MalNativeSourceCache sources = {0};
    CHECK(mal_atom_store_allocation_bytes(&atoms) == 0);
    CHECK(mal_symbol_registry_allocation_bytes(&registry) == 0);
    CHECK(mal_native_source_cache_allocation_bytes(&sources) == 0);
    MalHeapUsage before = mal_heap_usage(&vm->heap);
    MalTable *properties = mal_table_new();
    for (u32 index = 0; index < 64; index++) {
        mal_table_upsert_entry(properties, mal_key_index(index), nullptr);
    }
    usize property_bytes = mal_heap_usage(&vm->heap).raw_owned_bytes - before.raw_owned_bytes;
    for (u32 index = 0; index < 64; index++) {
        char name[64];
        usize length = (usize) snprintf(name, sizeof(name), "local-unrooted-store-key-%u", index);
        MalString *key = mal_string_new_ascii(&vm->heap, name, length);
        mal_atom_store_intern(&atoms, key);
        mal_symbol_registry_insert(&registry, mal_symbol_new(&vm->heap, key));
        mal_native_source_cache_insert(&sources, key, mal_string_new_ascii(&vm->heap, "source", 6));
    }
    usize atom_bytes = mal_atom_store_allocation_bytes(&atoms);
    usize registry_bytes = mal_symbol_registry_allocation_bytes(&registry);
    usize source_bytes = mal_native_source_cache_allocation_bytes(&sources);
    mal_atom_store_free(&atoms);
    mal_symbol_registry_free(&registry);
    mal_native_source_cache_free(&sources);
    CHECK(atom_bytes == registry_bytes && atom_bytes < property_bytes);
    CHECK(mal_atom_store_size(&atoms) == 0 && mal_atom_store_capacity(&atoms) == 0);
    CHECK(mal_symbol_registry_size(&registry) == 0 && mal_symbol_registry_capacity(&registry) == 0);
    CHECK(mal_native_source_cache_size(&sources) == 0 && mal_native_source_cache_capacity(&sources) == 0);
    mal_table_free(properties);
    MalString *unrooted = mal_string_new_ascii(&vm->heap, "unrooted-for-release", 20);
    mal_atom_store_intern(&atoms, unrooted);
    mal_symbol_registry_insert(&registry, mal_symbol_new(&vm->heap, unrooted));
    mal_native_source_cache_insert(&sources, unrooted,
        mal_string_new_ascii(&vm->heap, "unrooted-source", 15));
    mal_gc_collect(vm);
    mal_atom_store_free(&atoms);
    mal_symbol_registry_free(&registry);
    mal_native_source_cache_free(&sources);
    printf("intern-stores bytes atoms=%zu registry=%zu sources=%zu properties=%zu\n",
        atom_bytes, registry_bytes, source_bytes, property_bytes);
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    vm.heap.next_gc_at = SIZE_MAX;
    bool ok = check_incremental_growth(&vm) && check_atoms(&vm)
        && check_registry_and_sources(&vm) && check_storage_charge_and_release(&vm);
    if (vm.completion.kind != MAL_COMPLETION_NORMAL) ok = false;
    mal_vm_free(&vm);
    if (ok) puts("intern-stores PASS");
    return ok ? 0 : 1;
}
