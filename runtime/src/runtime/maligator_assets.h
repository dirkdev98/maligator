#pragma once

#include "vm.h"

/**
 * Install the handle of each `maligator:assets` declaration the program reaches. A
 * slot's data is the declaration as JSON. An executable built by `maligator build`
 * embeds an asset under the declaration's `name`; without an embedded copy the handle
 * reads the declared path on the file system each time.
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

/** One member file of an asset handle, embedded or read from disk. */
typedef struct MalAssetMember {
    /** The embedded copy in a built executable, or null. */
    const MalAssetFile *embedded;
    /** The file's absolute path when it is read from disk, or null. */
    char *live_path;
    /** The member path below its directory, or the file name. */
    char *path;
} MalAssetMember;

/**
 * Find `member` (a slash-separated path) of a directory handle, or the file of a file
 * handle, which ignores `member`. Returns 1 when found, 0 when the handle has no such
 * member, and -1 after throwing, for instance when `handle` is no asset handle.
 */
int mal_asset_member(MalVm *vm, MalValue handle, const char *member, MalAssetMember *out);
void mal_asset_member_dispose(MalAssetMember *member);

/** The dev server a handle's files come from in this command, or null; caller frees. */
char *mal_asset_proxy_url(MalVm *vm, MalValue handle);

/** The media type implied by a path's extension. */
const char *mal_asset_media_type(const char *path);

/** Match a member path against an asset pattern (`*`, `?` and whole-segment `**`). */
bool mal_asset_pattern_match(const char *pattern, const char *path, bool dot);
