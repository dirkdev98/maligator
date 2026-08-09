#include "./vm.h"

// Realm storage lives entirely behind MAL_REALMS. Including vm.h above keeps this
// a non-empty translation unit when the feature is off (the GLOB build compiles
// this file unconditionally), so no realm symbols are emitted in that build.
#if MAL_REALMS

#include <stdlib.h>

MalRealm *mal_realm_new(MalVm *vm) {
    MalRealm *realm = malloc(sizeof(MalRealm));
    realm->globals = malloc(sizeof(MalValue) * (usize) vm->global_capacity);
    // Pre-fill active slots before linking: the collector scans every realm in
    // vm->realms, so a realm must hold only scannable MalValues the instant it
    // becomes reachable, even if the caller has not populated it yet.
    for (i32 i = 0; i < vm->definition->global_count; i++) {
        realm->globals[i] = mal_value_new_undefined();
    }
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        realm->intrinsics[i] = mal_value_new_undefined();
    }
    realm->next = vm->realms;
    vm->realms = realm;
    return realm;
}

void mal_realm_free_all(MalVm *vm) {
    MalRealm *realm = vm->realms;
    while (realm != nullptr) {
        MalRealm *next = realm->next;
        free(realm->globals);
        free(realm);
        realm = next;
    }
    vm->realms = nullptr;
}

void mal_realm_switch(MalVm *vm, MalRealm *realm) {
    vm->current_realm = realm;
    // Alias the engine-wide pointers at the realm storage so indexed accesses use
    // the active realm without changing their hot paths.
    vm->globals = realm->globals;
    vm->intrinsics = realm->intrinsics;
    // Keep the heap's cache in lockstep so function-object init stamps this realm.
    vm->heap.current_realm = realm;
}

MalRealm *mal_realm_create(MalVm *vm, MalRealmInstaller installer, void *data) {
    MalRealm *caller_realm = vm->current_realm;
    MalRealm *realm = mal_realm_new(vm);

    // Well-known symbols belong to the isolate's agent, not an individual realm.
    // Their enum slots are deliberately contiguous.
    for (i32 slot = MAL_INTRINSIC_SYMBOL_ITERATOR; slot <= MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE; slot++) {
        realm->intrinsics[slot] = vm->initial_realm->intrinsics[slot];
    }

    mal_realm_switch(vm, realm);
    mal_intrinsics_init(vm);
    if (vm->completion.kind == MAL_COMPLETION_NORMAL && installer != nullptr) {
        installer(vm, data);
    }
    mal_realm_switch(vm, caller_realm);
    return realm;
}

MalValue mal_realm_global(const MalRealm *realm) {
    return realm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
}

#endif // MAL_REALMS
