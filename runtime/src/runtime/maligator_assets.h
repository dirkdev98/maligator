#pragma once

#include "vm.h"

/**
 * Install the handle of each `maligator:assets` declaration the program reaches. A
 * slot's data is the declaration's canonical JSON. An executable built by
 * `maligator build` embeds an asset under that name; without an embedded copy the
 * handle reads the declared path on the file system each time.
 */
void mal_host_install_maligator_assets(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/**
 * Write an embedded asset below `base` once per content identity and return the
 * malloc'd path of its file or directory. Returns 0 or an errno.
 */
int mal_asset_materialize(const MalAsset *asset, const char *base, char **out_path);

/** The directory materializations go to when the caller names none. */
const char *mal_asset_temporary_directory(void);
