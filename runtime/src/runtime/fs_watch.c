#include "fs_watch.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <sys/event.h>
#elif defined(__linux__)
#include <sys/inotify.h>
#endif

#include "async_context.h"
#include "gc.h"
#include "host.h"
#include "posix_fs.h"
#include "web_host_timer.h"

#define FS_WATCH_EVENTS 32
#if defined(__linux__)
#define FS_WATCH_TREE_MASK (IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO)
#endif

#if defined(__APPLE__)
typedef struct FsWatchEntry {
    char *name;
    ino_t inode;
    int fd;
    bool renamed;
} FsWatchEntry;
#endif

/* One watched directory; `relative` is root-relative ("" for the root). `fd` is the
 * kqueue O_EVTONLY descriptor on macOS and the inotify watch descriptor on Linux. */
typedef struct FsWatchDir {
    char *relative;
    int fd;
#if defined(__APPLE__)
    FsWatchEntry *entries;
    usize entry_count;
#endif
} FsWatchDir;

struct MalFsWatch {
    MalVm *vm;
    MalHost *host;
    MalFsWatchCallbacks callbacks;
    void *data;
    MalValue owner;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHostHandle operation;
    MalOp read_op;
    int fd;
    int target_fd;
    int error;
    char *path;
    // The root directory first; Linux keeps the rest sorted by watch descriptor.
    FsWatchDir **dirs;
    usize dir_count;
    usize dir_capacity;
    char *name;
    usize name_capacity;
    bool directory;
    bool recursive;
    bool closed;
    bool unreferenced;
    bool distinguish_moves;
    struct MalFsWatch *next;
};

static MAL_ISOLATE_LOCAL MalFsWatch *fs_watches;
static MAL_ISOLATE_LOCAL bool fs_watch_installed;

static bool fs_watch_delivering(MalVm *vm, const MalFsWatch *watch) {
    return !watch->closed && watch->error == 0 && vm->completion.kind != MAL_COMPLETION_THROW;
}

static void fs_watch_emit(MalVm *vm, MalFsWatch *watch, MalFsWatchKind kind, const char *relative) {
    watch->callbacks.event(vm, watch, kind, relative, watch->data);
}

static void fs_watch_dir_free(FsWatchDir *dir) {
#if defined(__APPLE__)
    for (usize i = 0; i < dir->entry_count; i++) {
        if (dir->entries[i].fd >= 0) close(dir->entries[i].fd);
        free(dir->entries[i].name);
    }
    free(dir->entries);
    // The root's descriptor is target_fd, closed with the handle.
    if (dir->relative[0] != '\0' && dir->fd >= 0) close(dir->fd);
#endif
    free(dir->relative);
    free(dir);
}

/* `dir/name` in the watcher's reusable buffer, or `name` itself at the root. */
static const char *fs_watch_join(MalFsWatch *state, const char *dir, const char *name) {
    if (dir[0] == '\0') return name;
    usize dir_length = strlen(dir);
    usize name_length = strlen(name);
    if (name_length > SIZE_MAX - dir_length - 2) { state->error = ENOMEM; return nullptr; }
    usize needed = dir_length + name_length + 2;
    if (needed > state->name_capacity) {
        char *grown = realloc(state->name, needed);
        if (grown == nullptr) { state->error = ENOMEM; return nullptr; }
        state->name = grown;
        state->name_capacity = needed;
    }
    memcpy(state->name, dir, dir_length);
    state->name[dir_length] = '/';
    memcpy(state->name + dir_length + 1, name, name_length + 1);
    return state->name;
}

static FsWatchDir *fs_watch_add_dir(MalFsWatch *state, const char *relative, int fd) {
    if (state->dir_count == state->dir_capacity) {
        usize maximum = SIZE_MAX / sizeof(FsWatchDir *);
        if (state->dir_capacity == maximum) { state->error = ENOMEM; return nullptr; }
        usize capacity = state->dir_capacity == 0 ? 4
            : state->dir_capacity > maximum / 2 ? maximum : state->dir_capacity * 2;
        FsWatchDir **grown = realloc(state->dirs, capacity * sizeof(FsWatchDir *));
        if (grown == nullptr) { state->error = ENOMEM; return nullptr; }
        state->dirs = grown;
        state->dir_capacity = capacity;
    }
    FsWatchDir *dir = calloc(1, sizeof(FsWatchDir));
    if (dir == nullptr || (dir->relative = strdup(relative)) == nullptr) {
        free(dir);
        state->error = ENOMEM;
        return nullptr;
    }
    dir->fd = fd;
    usize index = state->dir_count;
#if defined(__linux__)
    while (index > 1 && state->dirs[index - 1]->fd > fd) index--;
    memmove(state->dirs + index + 1, state->dirs + index, (state->dir_count - index) * sizeof(FsWatchDir *));
#endif
    state->dirs[index] = dir;
    state->dir_count++;
    return dir;
}

/* Drops the watched directory at `relative` and every directory below it. */
static void fs_watch_forget(MalFsWatch *state, const char *relative) {
    usize length = strlen(relative);
    usize kept = 0;
    for (usize i = 0; i < state->dir_count; i++) {
        FsWatchDir *dir = state->dirs[i];
        if (strncmp(dir->relative, relative, length) != 0
            || (dir->relative[length] != '\0' && dir->relative[length] != '/')) {
            state->dirs[kept++] = dir;
            continue;
        }
#if defined(__linux__)
        (void) inotify_rm_watch(state->fd, dir->fd);
#endif
        fs_watch_dir_free(dir);
    }
    state->dir_count = kept;
}

#if defined(__APPLE__)
static int fs_watch_compare(const void *left, const void *right) {
    return strcmp(((const FsWatchEntry *) left)->name, ((const FsWatchEntry *) right)->name);
}

static bool fs_watch_list(const char *path, FsWatchEntry **out, usize *count) {
    DIR *dir = opendir(path);
    *out = nullptr;
    *count = 0;
    if (dir == nullptr) return false;
    usize capacity = 0;
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(dir);
        if (entry == nullptr) { error = errno; break; }
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (*count == capacity) {
            usize maximum = SIZE_MAX / sizeof(FsWatchEntry);
            if (capacity == maximum) { error = ENOMEM; break; }
            capacity = capacity == 0 ? 16 : capacity > maximum / 2 ? maximum : capacity * 2;
            FsWatchEntry *grown = realloc(*out, capacity * sizeof(FsWatchEntry));
            if (grown == nullptr) { error = ENOMEM; break; }
            *out = grown;
        }
        char *name = strdup(entry->d_name);
        if (name == nullptr) { error = ENOMEM; break; }
        (*out)[(*count)++] = (FsWatchEntry) {.name = name, .inode = entry->d_ino, .fd = -1};
    }
    closedir(dir);
    if (error != 0) {
        for (usize index = 0; index < *count; index++) free((*out)[index].name);
        free(*out);
        *out = nullptr;
        *count = 0;
        errno = error;
        return false;
    }
    if (*count > 1) qsort(*out, *count, sizeof(FsWatchEntry), fs_watch_compare);
    return true;
}
#endif

static void fs_watch_ready(void *data) {
    MalFsWatch *state = data;
    if (state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_host_operation_progress(&state->host->tasks, state->operation, nullptr, nullptr);
}

static bool fs_watch_arm(MalFsWatch *state) {
    state->read_op = (MalOp) {.fd = state->fd, .interest = MAL_IO_READ,
        .waker = {.fn = fs_watch_ready, .data = state}};
    if (!mal_reactor_add_op(&state->host->reactor, &state->read_op)) return false;
    if (state->unreferenced) state->host->reactor.unreferenced_ops++;
    return true;
}

static void fs_watch_disarm(MalFsWatch *state) {
    if (state->read_op.active && state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_reactor_cancel_op(&state->host->reactor, &state->read_op);
}

/* malloc-owned absolute path of a watched directory. */
static char *fs_watch_absolute(const MalFsWatch *state, const char *relative) {
    if (relative[0] == '\0') return strdup(state->path);
    usize length = strlen(state->path) + strlen(relative) + 2;
    char *absolute = malloc(length);
    if (absolute != nullptr) snprintf(absolute, length, "%s/%s", state->path, relative);
    return absolute;
}

#if defined(__APPLE__)
static void fs_watch_rescan(MalVm *vm, MalFsWatch *state, FsWatchDir *dir, bool announce);

/* Regular files get their own descriptor; a recursive watch turns subdirectories into
 * watched directories that own theirs, so their entry keeps -1. */
static int fs_watch_child(MalVm *vm, MalFsWatch *state, FsWatchDir *dir, const char *name,
    bool announce) {
    if (state->closed || state->error != 0) return -1;
    int fd = openat(dir->fd, name, O_EVTONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) {
        if (errno != ENOENT && errno != ENOTDIR && errno != ELOOP) state->error = errno;
        return -1;
    }
    struct stat st;
    bool directory = false;
    if (fstat(fd, &st) != 0) {
        state->error = errno;
        close(fd);
        return -1;
    }
    if (!(S_ISREG(st.st_mode) || (directory = state->recursive && S_ISDIR(st.st_mode)))) {
        close(fd);
        return -1;
    }
    struct kevent change;
    EV_SET(&change, fd, EVFILT_VNODE, EV_ADD | EV_CLEAR,
        directory ? NOTE_WRITE : NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB, 0, (void *) (uintptr_t) (fd + 1));
    if (kevent(state->fd, &change, 1, nullptr, 0, nullptr) < 0) {
        state->error = errno;
        close(fd);
        return -1;
    }
    if (!directory) return fd;
    const char *relative = fs_watch_join(state, dir->relative, name);
    FsWatchDir *child = relative == nullptr ? nullptr : fs_watch_add_dir(state, relative, fd);
    if (child == nullptr) {
        close(fd);
        return -1;
    }
    fs_watch_rescan(vm, state, child, announce);
    return -1;
}

typedef struct FsWatchMove {
    FsWatchEntry *entry;
    bool created;
} FsWatchMove;

static int fs_watch_inode_compare(const void *left, const void *right) {
    const FsWatchMove *a = left, *b = right;
    return (a->entry->inode > b->entry->inode) - (a->entry->inode < b->entry->inode);
}

static int fs_watch_entry_order(const FsWatchDir *dir, usize left,
    const FsWatchEntry *entries, usize count, usize right) {
    if (left == dir->entry_count) return 1;
    if (right == count) return -1;
    return strcmp(dir->entries[left].name, entries[right].name);
}

/* kqueue reports membership changes on the directory. A matched inode under
 * two names in the same rescan lets us distinguish an in-directory rename. */
static bool fs_watch_mark_moves(FsWatchDir *dir, FsWatchEntry *entries, usize count) {
    FsWatchMove *moves = nullptr;
    usize length = 0, capacity = 0;
    usize left = 0, right = 0;
    while (left < dir->entry_count || right < count) {
        int order = fs_watch_entry_order(dir, left, entries, count, right);
        if (order == 0) {
            left++;
            right++;
            continue;
        }
        if (length == capacity) {
            usize maximum = SIZE_MAX / sizeof(FsWatchMove);
            if (capacity == maximum) { free(moves); return false; }
            capacity = capacity == 0 ? 8 : capacity > maximum / 2 ? maximum : capacity * 2;
            FsWatchMove *grown = realloc(moves, capacity * sizeof(FsWatchMove));
            if (grown == nullptr) { free(moves); return false; }
            moves = grown;
        }
        moves[length++] = order < 0 ? (FsWatchMove) {.entry = &dir->entries[left++]}
            : (FsWatchMove) {.entry = &entries[right++], .created = true};
    }
    if (length > 1) qsort(moves, length, sizeof(FsWatchMove), fs_watch_inode_compare);
    for (usize i = 0; i < length;) {
        usize start = i++;
        ino_t inode = moves[start].entry->inode;
        while (i < length && moves[i].entry->inode == inode) i++;
        if (inode != 0 && i - start == 2 && moves[start].created != moves[start + 1].created) {
            moves[start].entry->renamed = true;
            moves[start + 1].entry->renamed = true;
        }
    }
    free(moves);
    return true;
}

static void fs_watch_rescan(MalVm *vm, MalFsWatch *state, FsWatchDir *dir, bool announce) {
    char *absolute = fs_watch_absolute(state, dir->relative);
    if (absolute == nullptr) { state->error = ENOMEM; return; }
    FsWatchEntry *entries;
    usize count;
    bool listed = fs_watch_list(absolute, &entries, &count);
    int error = errno;
    free(absolute);
    if (!listed) {
        if (error != ENOENT && error != ENOTDIR) state->error = error;
        return;
    }
    if (announce && state->distinguish_moves && !fs_watch_mark_moves(dir, entries, count)) {
        for (usize i = 0; i < count; i++) free(entries[i].name);
        free(entries);
        state->error = ENOMEM;
        return;
    }
    usize left = 0, right = 0;
    while (left < dir->entry_count || right < count) {
        int order = fs_watch_entry_order(dir, left, entries, count, right);
        if (order == 0) {
            FsWatchEntry *previous = &dir->entries[left++];
            FsWatchEntry *entry = &entries[right++];
            int fd = previous->fd;
            bool replaced = false;
            if (fd >= 0) {
                struct stat before, after;
                if (fstat(fd, &before) != 0) state->error = errno;
                else if (fstatat(dir->fd, entry->name, &after, AT_SYMLINK_NOFOLLOW) == 0)
                    replaced = before.st_dev != after.st_dev || before.st_ino != after.st_ino;
                else if (errno == ENOENT || errno == ENOTDIR) replaced = true;
                else state->error = errno;
            } else if (state->distinguish_moves) {
                replaced = previous->inode != entry->inode;
            }
            if (replaced) {
                if (fd >= 0) close(fd);
                const char *name = fs_watch_join(state, dir->relative, entry->name);
                if (name != nullptr && state->recursive && fd < 0) fs_watch_forget(state, name);
                if (name != nullptr && announce && fs_watch_delivering(vm, state))
                    fs_watch_emit(vm, state, MAL_FS_WATCH_RENAME, name);
                fd = fs_watch_child(vm, state, dir, entry->name, announce);
            }
            entry->fd = fd;
            continue;
        }
        if (order < 0) {
            const FsWatchEntry *entry = &dir->entries[left++];
            if (entry->fd >= 0) close(entry->fd);
            const char *name = fs_watch_join(state, dir->relative, entry->name);
            if (name != nullptr && state->recursive && entry->fd < 0) fs_watch_forget(state, name);
            if (name != nullptr && announce && fs_watch_delivering(vm, state))
                fs_watch_emit(vm, state, entry->renamed ? MAL_FS_WATCH_RENAME : MAL_FS_WATCH_DELETE, name);
        } else {
            FsWatchEntry *entry = &entries[right++];
            const char *name = fs_watch_join(state, dir->relative, entry->name);
            if (name != nullptr && announce && fs_watch_delivering(vm, state))
                fs_watch_emit(vm, state, entry->renamed ? MAL_FS_WATCH_RENAME : MAL_FS_WATCH_CREATE, name);
            entry->fd = fs_watch_child(vm, state, dir, entry->name, announce);
            entry->renamed = false;
        }
    }
    for (usize i = 0; i < dir->entry_count; i++) free(dir->entries[i].name);
    free(dir->entries);
    dir->entries = entries;
    dir->entry_count = count;
}

static void fs_watch_child_event(MalVm *vm, MalFsWatch *state, int fd) {
    for (usize i = 0; i < state->dir_count; i++) {
        FsWatchDir *dir = state->dirs[i];
        if (dir->fd == fd && dir->relative[0] != '\0') {
            fs_watch_rescan(vm, state, dir, true);
            return;
        }
        for (usize entry = 0; entry < dir->entry_count; entry++) {
            if (dir->entries[entry].fd != fd) continue;
            const char *name = fs_watch_join(state, dir->relative, dir->entries[entry].name);
            if (name != nullptr) fs_watch_emit(vm, state, MAL_FS_WATCH_MODIFY, name);
            return;
        }
    }
}
#elif defined(__linux__)
static FsWatchDir *fs_watch_find(const MalFsWatch *state, int wd, usize *index) {
    usize low = 0, high = state->dir_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        int fd = state->dirs[middle]->fd;
        if (fd == wd) {
            *index = middle;
            return state->dirs[middle];
        }
        if (fd < wd) low = middle + 1;
        else high = middle;
    }
    return nullptr;
}

static bool fs_watch_subdir(MalFsWatch *state, const char *relative) {
    char *absolute = fs_watch_absolute(state, relative);
    if (absolute == nullptr) { state->error = ENOMEM; return false; }
    // IN_ONLYDIR also rejects the DT_UNKNOWN entries that turn out not to be directories.
    int wd = inotify_add_watch(state->fd, absolute, FS_WATCH_TREE_MASK | IN_ONLYDIR | IN_DONT_FOLLOW);
    free(absolute);
    if (wd < 0) {
        if (errno != ENOENT && errno != ENOTDIR && errno != ELOOP) state->error = errno;
        return false;
    }
    // A descriptor that is already watched means a bind-mount loop; stop descending.
    usize index;
    if (fs_watch_find(state, wd, &index) != nullptr) return false;
    return fs_watch_add_dir(state, relative, wd) != nullptr;
}

/* Watches every directory below the watched `relative`; when a directory appears,
 * `announce` reports its existing children too. */
static void fs_watch_tree(MalVm *vm, MalFsWatch *state, const char *relative, bool announce) {
    char *absolute = fs_watch_absolute(state, relative);
    DIR *directory = absolute == nullptr ? nullptr : opendir(absolute);
    int error = absolute == nullptr ? ENOMEM : errno;
    free(absolute);
    if (directory == nullptr) {
        if (error != ENOENT && error != ENOTDIR) state->error = error;
        return;
    }
    for (struct dirent *entry = readdir(directory); entry != nullptr && !state->closed; entry = readdir(directory)) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        const char *name = fs_watch_join(state, relative, entry->d_name);
        if (name == nullptr) continue;
        if (announce && vm->completion.kind != MAL_COMPLETION_THROW) fs_watch_emit(vm, state, MAL_FS_WATCH_CREATE, name);
        if (entry->d_type != DT_DIR && entry->d_type != DT_UNKNOWN) continue;
        char *child = strdup(name);
        if (child == nullptr) state->error = ENOMEM;
        else if (fs_watch_subdir(state, child)) fs_watch_tree(vm, state, child, announce);
        free(child);
    }
    closedir(directory);
}

static MalFsWatchKind fs_watch_entry_kind(u32 mask) {
    if ((mask & (IN_MOVED_FROM | IN_MOVED_TO | IN_MOVE_SELF)) != 0) return MAL_FS_WATCH_RENAME;
    if ((mask & (IN_DELETE | IN_DELETE_SELF)) != 0) return MAL_FS_WATCH_DELETE;
    if ((mask & IN_CREATE) != 0) return MAL_FS_WATCH_CREATE;
    return MAL_FS_WATCH_MODIFY;
}

static void fs_watch_tree_event(MalVm *vm, MalFsWatch *state, const struct inotify_event *event) {
    usize index;
    FsWatchDir *dir = fs_watch_find(state, event->wd, &index);
    if (dir == nullptr) return;
    bool root = dir->relative[0] == '\0';
    if ((event->mask & IN_IGNORED) != 0) {
        if (root) return;
        memmove(state->dirs + index, state->dirs + index + 1, (state->dir_count - index - 1) * sizeof(FsWatchDir *));
        state->dir_count--;
        fs_watch_dir_free(dir);
        return;
    }
    if (event->len == 0) {
        if (root && (event->mask & (IN_DELETE_SELF | IN_MOVE_SELF)) != 0)
            fs_watch_emit(vm, state, fs_watch_entry_kind(event->mask), "");
        return;
    }
    const char *name = fs_watch_join(state, dir->relative, event->name);
    if (name == nullptr) return;
    bool renamed = (event->mask & (IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO)) != 0;
    bool directory = (event->mask & IN_ISDIR) != 0;
    if (directory && !renamed) return;
    fs_watch_emit(vm, state, fs_watch_entry_kind(event->mask), name);
    if (!directory || state->closed) return;
    char *relative = strdup(name);
    if (relative == nullptr) { state->error = ENOMEM; return; }
    if ((event->mask & (IN_DELETE | IN_MOVED_FROM)) != 0) {
        fs_watch_forget(state, relative);
    } else if (fs_watch_subdir(state, relative)) {
        fs_watch_tree(vm, state, relative, vm->completion.kind != MAL_COMPLETION_THROW);
    }
    free(relative);
}
#endif

static void fs_watch_receive(MalVm *vm, MalFsWatch *state) {
#if defined(__APPLE__)
    struct kevent events[FS_WATCH_EVENTS];
    struct timespec zero = {0};
    int ready = kevent(state->fd, nullptr, 0, events, FS_WATCH_EVENTS, &zero);
    if (ready < 0 && errno != EINTR && errno != EAGAIN) state->error = errno;
    for (int i = 0; i < ready && !state->closed && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        if ((events[i].flags & EV_ERROR) != 0) { state->error = (int) events[i].data; break; }
        u32 flags = events[i].fflags;
        if (events[i].udata != nullptr) {
            fs_watch_child_event(vm, state, (int) ((uintptr_t) events[i].udata - 1));
            continue;
        }
        if (state->directory && (flags & NOTE_WRITE) != 0) fs_watch_rescan(vm, state, state->dirs[0], true);
        if (state->closed || vm->completion.kind == MAL_COMPLETION_THROW) continue;
        if ((flags & (NOTE_RENAME | NOTE_REVOKE)) != 0)
            fs_watch_emit(vm, state, MAL_FS_WATCH_RENAME, "");
        else if ((flags & NOTE_DELETE) != 0)
            fs_watch_emit(vm, state, MAL_FS_WATCH_DELETE, "");
        else if (!state->directory && (flags & (NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB)) != 0)
            fs_watch_emit(vm, state, MAL_FS_WATCH_MODIFY, "");
    }
#elif defined(__linux__)
    _Alignas(struct inotify_event) char buffer[4096];
    ssize_t length = read(state->fd, buffer, sizeof(buffer));
    if (length < 0 && errno != EINTR && errno != EAGAIN) state->error = errno;
    for (ssize_t offset = 0; offset < length && !state->closed && vm->completion.kind != MAL_COMPLETION_THROW;) {
        const struct inotify_event *event = (const struct inotify_event *) (buffer + offset);
        offset += (ssize_t) (sizeof(struct inotify_event) + event->len);
        if ((event->mask & IN_Q_OVERFLOW) != 0) { state->error = EOVERFLOW; break; }
        if (state->recursive) {
            fs_watch_tree_event(vm, state, event);
            continue;
        }
        if ((event->mask & (FS_WATCH_TREE_MASK | IN_DELETE_SELF | IN_MOVE_SELF)) != 0)
            fs_watch_emit(vm, state, fs_watch_entry_kind(event->mask), event->len > 0 ? event->name : "");
    }
#endif
    if (state->closed) return;
    if (state->error == 0 && !fs_watch_arm(state)) state->error = ENOMEM;
    if (state->error != 0) {
        state->callbacks.error(vm, state, state->error, state->data);
        mal_fs_watch_stop(state);
    }
}

static int fs_watch_open(MalFsWatch *state) {
    MalPosixStat st;
    int error = mal_posix_fs_stat(state->path, &st);
    if (error != 0) return error;
    state->directory = (st.mode & S_IFMT) == S_IFDIR;
    state->recursive = state->recursive && state->directory;
#if defined(__APPLE__)
    state->target_fd = open(state->path, O_EVTONLY | O_CLOEXEC);
    if (state->target_fd < 0) return errno;
    state->fd = kqueue();
    if (state->fd < 0) return errno;
    (void) fcntl(state->fd, F_SETFD, FD_CLOEXEC);
    struct kevent change;
    EV_SET(&change, state->target_fd, EVFILT_VNODE, EV_ADD | EV_CLEAR,
        NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB | NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE, 0, nullptr);
    if (kevent(state->fd, &change, 1, nullptr, 0, nullptr) < 0) return errno;
    if (state->directory) {
        FsWatchDir *root = fs_watch_add_dir(state, "", state->target_fd);
        if (root == nullptr) return ENOMEM;
        fs_watch_rescan(nullptr, state, root, false);
    }
#elif defined(__linux__)
    state->fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (state->fd < 0) return errno;
    int wd = inotify_add_watch(state->fd, state->path, FS_WATCH_TREE_MASK | IN_DELETE_SELF | IN_MOVE_SELF);
    if (wd < 0) return errno;
    if (state->recursive) {
        if (fs_watch_add_dir(state, "", wd) == nullptr) return ENOMEM;
        fs_watch_tree(nullptr, state, "", false);
    }
#else
    return ENOSYS;
#endif
    return state->error;
}

static void fs_watch_close_fds(MalFsWatch *state) {
    if (state->fd >= 0) close(state->fd);
    if (state->target_fd >= 0) close(state->target_fd);
    state->fd = -1;
    state->target_fd = -1;
}

void mal_fs_watch_stop(MalFsWatch *state) {
    if (state == nullptr || state->closed) return;
    state->closed = true;
    fs_watch_disarm(state);
    mal_host_operation_unbind(&state->host->tasks, state->operation, state);
    (void) mal_host_operation_complete(&state->host->tasks, state->operation, MAL_HOST_TERMINAL_OK,
        nullptr, nullptr);
    fs_watch_close_fds(state);
}

void mal_fs_watch_ref(MalFsWatch *state, bool referenced) {
    if (state == nullptr || state->closed || state->unreferenced == !referenced) return;
    if (state->read_op.active) state->host->reactor.unreferenced_ops += referenced ? -1 : 1;
    state->unreferenced = !referenced;
}

bool mal_fs_watch_recursive(const MalFsWatch *state) {
    return state->recursive;
}

MalValue mal_fs_watch_owner(const MalFsWatch *state) {
    return state->owner;
}

MalFsWatch *mal_fs_watch_find(MalVm *vm, MalValue owner) {
    for (MalFsWatch *state = fs_watches; state != nullptr; state = state->next) {
        if (state->vm == vm && state->owner == owner) return state;
    }
    return nullptr;
}

static void fs_watch_free(MalFsWatch *state) {
    fs_watch_close_fds(state);
    for (usize i = 0; i < state->dir_count; i++) fs_watch_dir_free(state->dirs[i]);
    free(state->dirs);
    free(state->name);
    free(state->path);
    free(state);
}

static void fs_watch_release(MalFsWatch **link, bool teardown) {
    MalFsWatch *state = *link;
    *link = state->next;
    if (state->callbacks.release != nullptr) state->callbacks.release(state->data, teardown);
    fs_watch_free(state);
}

static void fs_watch_cleanup(MalVm *vm) {
    MalFsWatch **link = &fs_watches;
    while (*link != nullptr) {
        MalFsWatch *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        mal_fs_watch_stop(state);
        fs_watch_release(link, true);
    }
}

static void fs_watch_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalFsWatch *state = fs_watches; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->owner);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static bool fs_watch_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask peek;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &peek)) return false;
    MalFsWatch **link = &fs_watches;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != peek.operation)) {
        link = &(*link)->next;
    }
    MalFsWatch *state = *link;
    if (state == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        fs_watch_release(link, false);
    } else if (!state->closed) {
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_realm_switch(vm, state->realm);
#endif
        MalAsyncContextScope scope;
        mal_async_context_scope_enter(vm, &scope, state->async_context);
        fs_watch_receive(vm, state);
        mal_async_context_scope_exit(vm, &scope);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
    }
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static char *fs_watch_root(const char *path) {
    if (path[0] == '/') return strdup(path);
    char *cwd = getcwd(nullptr, 0);
    if (cwd == nullptr) return nullptr;
    char *absolute = nullptr;
    int length = asprintf(&absolute, "%s/%s", cwd, path);
    free(cwd);
    if (length < 0) {
        errno = ENOMEM;
        return nullptr;
    }
    return absolute;
}

int mal_fs_watch_start(MalVm *vm, const char *path, bool recursive, bool referenced,
    bool distinguish_moves, MalValue owner, const MalFsWatchCallbacks *callbacks, void *data,
    MalFsWatch **result) {
    if (path[0] == '\0') return ENOENT;
    MalHost *host = mal_host(vm);
    if (host == nullptr || !mal_vm_register_runtime_cleanup(vm, fs_watch_cleanup)) return ENOMEM;
    if (!fs_watch_installed) {
        mal_gc_register_root_source(fs_watch_scan_roots, nullptr);
        mal_host_register_macrotask_drain(fs_watch_drain, false);
        fs_watch_installed = true;
    }

    MalFsWatch *state = calloc(1, sizeof(*state));
    if (state == nullptr) return ENOMEM;
    *state = (MalFsWatch) {
        .vm = vm,
        .host = host,
        .callbacks = *callbacks,
        .data = data,
        .owner = owner,
        .fd = -1,
        .target_fd = -1,
        .recursive = recursive,
        .unreferenced = !referenced,
        .distinguish_moves = distinguish_moves,
    };
    state->path = fs_watch_root(path);
    int error = state->path == nullptr ? errno : fs_watch_open(state);
    if (error == 0 && !mal_host_operation_start(&host->tasks, &state->operation)) error = ENOMEM;
    if (error == 0 && (!mal_host_operation_bind(&host->tasks, state->operation, state) || !fs_watch_arm(state)
            || !mal_host_operation_activate(&host->tasks, state->operation))) {
        fs_watch_disarm(state);
        mal_host_operation_unbind(&host->tasks, state->operation, state);
        (void) mal_host_operation_abort_start(&host->tasks, state->operation);
        error = ENOMEM;
    }
    if (error != 0) {
        fs_watch_free(state);
        return error;
    }
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    state->next = fs_watches;
    fs_watches = state;
    *result = state;
    return 0;
}
