#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;

/**
 * One registration in a FinalizationRegistry. `target` and `unregister_token`
 * are held WEAKLY (not traced); `held_value` is held STRONGLY (traced) and is
 * passed to the cleanup callback when the target is reclaimed. A plain malloc'd
 * linked-list node, freed on unregister, on cleanup, or when the registry dies.
 */
typedef struct MalFinRegCell {
    MalValue target;
    MalValue held_value;
    MalValue unregister_token;
    bool has_token;
    struct MalFinRegCell *next;
} MalFinRegCell;

/**
 * A FinalizationRegistry instance: an ordinary object plus a strong
 * [[CleanupCallback]] and the live list of registrations. After a collection the
 * weak pass enqueues a cleanup job (callback(heldValue)) for each cell whose
 * target was reclaimed, then unlinks that cell.
 */
typedef struct MalFinalizationRegistryObject {
    MalObject object;
    MalValue cleanup_callback;
    MalFinRegCell *cells;
} MalFinalizationRegistryObject;

/** Allocate/recycle the VM-owned native registration cells. */
MalFinRegCell *mal_finalization_registry_cell_new(MalVm *vm);
void mal_finalization_registry_cell_recycle(MalVm *vm, MalFinRegCell *cell);
void mal_finalization_registry_free_cell_pool(MalVm *vm);

/**
 * Install the FinalizationRegistry constructor and prototype.
 */
void mal_builtin_finalization_registry_install(MalVm *vm);
