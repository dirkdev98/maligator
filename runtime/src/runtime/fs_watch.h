#pragma once

#include "vm.h"

typedef struct MalFsWatch MalFsWatch;
typedef enum MalFsWatchKind {
    MAL_FS_WATCH_CREATE,
    MAL_FS_WATCH_MODIFY,
    MAL_FS_WATCH_DELETE,
    MAL_FS_WATCH_RENAME,
} MalFsWatchKind;

typedef struct MalFsWatchCallbacks {
    /* An empty relative path names the watched file or directory itself. */
    void (*event)(MalVm *vm, MalFsWatch *watch, MalFsWatchKind kind, const char *relative, void *data);
    void (*error)(MalVm *vm, MalFsWatch *watch, int error, void *data);
    /* Runs after the last callback returns and during VM teardown. */
    void (*release)(void *data, bool teardown);
} MalFsWatchCallbacks;

/* The reactor owns the returned watch and releases it after stop, or on teardown.
 * The optional owner is rooted while the watch is registered. */
int mal_fs_watch_start(MalVm *vm, const char *path, bool recursive, bool referenced,
    bool distinguish_moves, MalValue owner, const MalFsWatchCallbacks *callbacks, void *data,
    MalFsWatch **result);
void mal_fs_watch_stop(MalFsWatch *watch);
void mal_fs_watch_ref(MalFsWatch *watch, bool referenced);
bool mal_fs_watch_recursive(const MalFsWatch *watch);
MalValue mal_fs_watch_owner(const MalFsWatch *watch);
MalFsWatch *mal_fs_watch_find(MalVm *vm, MalValue owner);
