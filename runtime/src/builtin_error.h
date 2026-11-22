#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Error constructor hierarchy (Error, TypeError, RangeError,
 * ReferenceError, SyntaxError, AggregateError) and install the Error builtins.
 */
void mal_builtin_error_install(MalVm *vm);

/*
 * Node's Error.prepareStackTrace and Error.stackTraceLimit. The compiler lists this
 * installer in a Node program's install table, and the intrinsics look for it while
 * they build Error, because the primordial lock freezes Error before any installer
 * runs. Run as an installer, it has nothing left to do.
 */
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;
typedef struct MalHostInstall MalHostInstall;
typedef struct MalRuntimeImage MalRuntimeImage;
void mal_host_install_node_error_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

bool mal_runtime_image_selects_node_error_hooks(const MalRuntimeImage *image);

/**
 * Carry a fragment's hook requirement into the root image before VM initialization.
 * If this replaces the root's install table, the caller owns it until VM teardown.
 */
bool mal_runtime_image_include_node_error_hooks(MalRuntimeImage *root, MalHostInstall **owned_installs);

/**
 * Publish Promise.any's private ordered errors Array on an intrinsic AggregateError.
 * The list is already collected, so this path must not consult an iterator.
 */
MalValue mal_builtin_new_aggregate_error(MalVm *vm, MalValue errors);

/** Create the intrinsic SuppressedError used while folding disposal failures. */
MalValue mal_builtin_new_suppressed_error(
    MalVm *vm, MalValue error, MalValue suppressed);

/**
 * True if `value` is an object carrying the [[ErrorData]] marker. Backs
 * Error.isError and Object.prototype.toString's "[object Error]" tag.
 */
bool mal_builtin_value_has_error_data(MalVm *vm, MalValue value);

/** Release a private captured-stack slot owned by a dying ordinary object. */
void mal_builtin_error_finalize_object(MalVm *vm, MalObject *object);
