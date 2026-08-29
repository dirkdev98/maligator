#pragma once

#include "./defaults.h"
#include "heap_string.h"
#include "object.h"

typedef struct MalVm MalVm;

/**
 * One export of a module namespace: a name and the global slot that holds its
 * live binding value (so [[Get]] always reflects the current value, and the
 * temporal-dead-zone sentinel throws ReferenceError).
 */
typedef struct MalModuleNamespaceExport {
    MalString *name;
    i32 slot;
} MalModuleNamespaceExport;

/**
 * An ES Module Namespace exotic object (`import * as ns`). The base object has
 * a null prototype and is non-extensible (so stores/defines/setPrototypeOf fail
 * through the ordinary machinery); the exports below are served as synthetic,
 * non-configurable, enumerable string properties, plus a @@toStringTag of
 * "Module". Exports are sorted by code unit at creation.
 */
typedef struct MalModuleNamespaceObject {
    MalObject object;
    MalModuleNamespaceExport *exports;
    i32 export_count;
    MalValue init_fn;
    i32 status_slot;
    i32 error_slot;
    bool deferred;
} MalModuleNamespaceObject;

void mal_module_namespace_object_init(
    MalHeap *heap,
    MalModuleNamespaceObject *ns,
    MalModuleNamespaceExport *exports,
    i32 export_count
);

MalModuleNamespaceObject *mal_module_namespace_object_new(
    MalHeap *heap,
    MalModuleNamespaceExport *exports,
    i32 export_count
);

void mal_module_namespace_configure_deferred(
    MalModuleNamespaceObject *ns,
    MalValue init_fn,
    i32 status_slot,
    i32 error_slot
);

bool mal_module_evaluate_sync(
    MalVm *vm,
    MalValue init_fn,
    i32 status_slot,
    i32 error_slot,
    bool throw_on_evaluating
);

bool mal_module_namespace_ensure_evaluated(
    MalVm *vm,
    MalModuleNamespaceObject *ns
);
