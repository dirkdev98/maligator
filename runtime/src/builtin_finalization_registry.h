#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;

/**
 * One registration in a FinalizationRegistry. `target` and `unregister_token`
 * are held WEAKLY (not traced); `held_value` is held STRONGLY (traced) and is
 * passed to the cleanup callback when the target is reclaimed. An undefined
 * unregister_token denotes the no-token case, keeping the pooled node to four
 * machine words.
 */
typedef struct MalFinRegCell {
    MalValue target;
    MalValue held_value;
    MalValue unregister_token;
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
