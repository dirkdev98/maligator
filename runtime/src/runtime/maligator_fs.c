#include "maligator_fs.h"

#include <errno.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "blocking_job.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "maligator_assets.h"
#include "posix_fs.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value.h"
#include "vm_ops.h"

typedef enum FsOperation : u32 {
    FS_EXISTS,
    FS_STAT,
    FS_LSTAT,
    FS_READ_BYTES,
    FS_READ_TEXT,
    FS_WRITE,
    FS_REMOVE,
    FS_COPY,
    FS_MOVE,
    FS_LIST,
    FS_CREATE_DIRECTORY,
    FS_REMOVE_DIRECTORY,
} FsOperation;

/* Write flags; src/fs/runtime.ts passes the same bits. */
enum {
    FS_WRITE_APPEND = 1u << 0,
    FS_WRITE_ATOMIC = 1u << 1,
    FS_WRITE_CREATE_DIRECTORIES = 1u << 2,
};

/* node:fs's copyFile mode bits, which mal_posix_fs_copy_file_mode takes. */
enum { FS_COPY_EXCLUSIVE = 1, FS_COPY_CLONE = 2 };

typedef struct FsPatterns {
    char **values;
    usize count;
} FsPatterns;

typedef struct FsJob {
    FsOperation operation;
    char *path;
    char *destination;
    /* A directory whose creation or listing failed, when different from `path`. */
    char *directory;
    byte *bytes;
    usize length;
    MalPosixStat stat;
    MalPosixDirent *entries;
    usize entry_count;
    FsPatterns include;
    FsPatterns exclude;
    usize pattern_bytes;
    u32 flags;
    u32 mode;
    bool has_mode;
    bool overwrite;
    bool exists;
    bool recursive;
    bool dot;
    bool files_only;
    int error;
    const char *syscall;
    /* `path` or `directory`: the path a failure reports. */
    const char *error_path;
} FsJob;

static const MalPropertyFlags FS_VISIBLE =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

static void fs_patterns_free(FsPatterns *patterns) {
    for (usize i = 0; i < patterns->count; i++) free(patterns->values[i]);
    free(patterns->values);
}

static void fs_job_free(void *data) {
    FsJob *job = data;
    free(job->path);
    free(job->destination);
    free(job->directory);
    free(job->bytes);
    mal_posix_fs_free_dirents(job->entries, job->entry_count);
    fs_patterns_free(&job->include);
    fs_patterns_free(&job->exclude);
    free(job);
}

static const char *fs_operation_syscall(FsOperation operation) {
    switch (operation) {
        case FS_EXISTS: return "access";
        case FS_STAT: return "stat";
        case FS_LSTAT: return "lstat";
        case FS_READ_BYTES:
        case FS_READ_TEXT: return "open";
        case FS_WRITE: return "open";
        case FS_REMOVE: return "unlink";
        case FS_COPY: return "copyfile";
        case FS_MOVE: return "rename";
        case FS_LIST: return "scandir";
        case FS_CREATE_DIRECTORY: return "mkdir";
        case FS_REMOVE_DIRECTORY: return "rmdir";
    }
    return "open";
}

static void fs_fail(FsJob *job, int error, const char *syscall) {
    job->error = error;
    job->syscall = syscall;
}

/* The length of the directory part of `path`, without its final slash except for the
 * root; zero when the path names no directory. */
static usize fs_directory_length(const char *path) {
    const char *slash = strrchr(path, '/');
    if (slash == nullptr) return 0;
    return slash == path ? 1 : (usize) (slash - path);
}

static void fs_write_direct(FsJob *job) {
    u32 flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE
        | ((job->flags & FS_WRITE_APPEND) != 0 ? MAL_POSIX_OPEN_APPEND : MAL_POSIX_OPEN_TRUNCATE);
    int fd = -1;
    int error = mal_posix_fs_open(job->path, flags, false, job->has_mode ? job->mode : 0666, &fd);
    if (error != 0) {
        fs_fail(job, error, "open");
        return;
    }
    usize written = 0;
    error = mal_posix_fs_write_fd(fd, job->bytes, job->length, &written);
    int close_error = mal_posix_fs_close_fd(fd);
    if (error != 0) fs_fail(job, error, "write");
    else if (close_error != 0) fs_fail(job, close_error, "close");
}

static _Atomic u32 fs_temporary_counter;

/*
 * Write a hidden sibling, flush it and rename it over the target, so readers see the
 * old or the new contents and never a partial file. A symbolic link keeps pointing at
 * its replaced target, and a replaced file keeps its permission bits unless the caller
 * gave a mode.
 */
static void fs_write_atomic(FsJob *job) {
    char *resolved = nullptr;
    MalPosixStat status;
    if (mal_posix_fs_lstat(job->path, &status) == 0 && status.type == MAL_POSIX_FT_SYMLINK
        && mal_posix_fs_realpath(job->path, &resolved) != 0) {
        free(resolved);
        resolved = nullptr;
    }
    const char *target = resolved != nullptr ? resolved : job->path;
    bool keep_mode = !job->has_mode && mal_posix_fs_stat(target, &status) == 0
        && status.type == MAL_POSIX_FT_FILE;
    u32 mode = job->has_mode ? job->mode : keep_mode ? status.mode & 07777 : 0666;
    const char *slash = strrchr(target, '/');
    usize prefix = slash == nullptr ? 0 : (usize) (slash - target) + 1;
    usize capacity = strlen(target) + 48;
    char *temporary = malloc(capacity);
    if (temporary == nullptr) {
        fs_fail(job, ENOMEM, "open");
        free(resolved);
        return;
    }
    int fd = -1;
    int error = EEXIST;
    for (int attempt = 0; attempt < 16 && error == EEXIST; attempt++) {
        u32 serial = atomic_fetch_add_explicit(&fs_temporary_counter, 1, memory_order_relaxed);
        snprintf(temporary, capacity, "%.*s.%s.%ld.%u.tmp", (int) prefix, target,
            target + prefix, (long) getpid(), serial);
        error = mal_posix_fs_open(temporary, MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE
            | MAL_POSIX_OPEN_EXCLUSIVE, false, mode, &fd);
    }
    if (error != 0) {
        fs_fail(job, error, "open");
        free(temporary);
        free(resolved);
        return;
    }
    usize written = 0;
    if (keep_mode && (error = mal_posix_fs_fchmod(fd, mode)) != 0) fs_fail(job, error, "fchmod");
    else if ((error = mal_posix_fs_write_fd(fd, job->bytes, job->length, &written)) != 0)
        fs_fail(job, error, "write");
    else if ((error = mal_posix_fs_sync_fd(fd)) != 0) fs_fail(job, error, "fsync");
    int close_error = mal_posix_fs_close_fd(fd);
    if (job->error == 0 && close_error != 0) fs_fail(job, close_error, "close");
    if (job->error == 0 && (error = mal_posix_fs_rename(temporary, target)) != 0)
        fs_fail(job, error, "rename");
    if (job->error != 0) (void) mal_posix_fs_unlink(temporary);
    free(temporary);
    free(resolved);
}

int mal_fs_create_parents(const char *path, char **directory) {
    usize length = fs_directory_length(path);
    if (length == 0) return 0;
    *directory = strndup(path, length);
    return *directory == nullptr ? ENOMEM : mal_posix_fs_mkdir(*directory, true);
}

static void fs_write(FsJob *job) {
    if ((job->flags & FS_WRITE_CREATE_DIRECTORIES) != 0) {
        int error = mal_fs_create_parents(job->path, &job->directory);
        if (error != 0) {
            fs_fail(job, error, "mkdir");
            if (job->directory != nullptr) job->error_path = job->directory;
            return;
        }
    }
    if ((job->flags & FS_WRITE_ATOMIC) != 0) fs_write_atomic(job);
    else fs_write_direct(job);
}

/* Across file systems a regular file moves by copy and unlink. The same overwrite
 * rule applies when creating the copy. */
static void fs_move(FsJob *job) {
    MalPosixStat status;
    int error = job->overwrite ? mal_posix_fs_rename(job->path, job->destination)
        : mal_posix_fs_rename_exclusive(job->path, job->destination);
    if (error == EXDEV && mal_posix_fs_lstat(job->path, &status) == 0
        && status.type == MAL_POSIX_FT_FILE) {
        error = mal_posix_fs_copy_file_mode(job->path, job->destination,
            job->overwrite ? 0 : FS_COPY_EXCLUSIVE);
        if (error != 0) {
            fs_fail(job, error, !job->overwrite && error == EEXIST ? "rename" : "copyfile");
            return;
        }
        error = mal_posix_fs_unlink(job->path);
        if (error != 0) {
            (void) mal_posix_fs_unlink(job->destination);
            fs_fail(job, error, "unlink");
        }
        return;
    }
    if (error != 0) fs_fail(job, error, "rename");
}

static bool fs_matches(const FsPatterns *patterns, const char *relative, bool dot) {
    for (usize i = 0; i < patterns->count; i++) {
        if (mal_asset_pattern_match(patterns->values[i], relative, dot)) return true;
    }
    return false;
}

static bool fs_list_admits(const char *relative, u32 type, const void *context) {
    const FsJob *job = context;
    if (job->files_only && type != MAL_POSIX_FT_FILE) return false;
    bool included = job->include.values == nullptr
        ? mal_asset_pattern_match("**", relative, job->dot)
        : fs_matches(&job->include, relative, job->dot);
    return included && !fs_matches(&job->exclude, relative, job->dot);
}

static void fs_job_run(void *data) {
    FsJob *job = data;
    job->error_path = job->path;
    switch (job->operation) {
        case FS_EXISTS:
            job->exists = mal_posix_fs_exists(job->path);
            return;
        case FS_STAT:
            fs_fail(job, mal_posix_fs_stat(job->path, &job->stat), "stat");
            return;
        case FS_LSTAT:
            fs_fail(job, mal_posix_fs_lstat(job->path, &job->stat), "lstat");
            return;
        case FS_READ_BYTES:
        case FS_READ_TEXT: {
            int error = mal_posix_fs_read_file(job->path, &job->bytes, &job->length);
            fs_fail(job, error, error == EISDIR ? "read" : "open");
            return;
        }
        case FS_WRITE:
            fs_write(job);
            return;
        case FS_REMOVE: {
            int error = mal_posix_fs_unlink(job->path);
            // macOS reports EPERM for a directory where Linux reports EISDIR.
            MalPosixStat status;
            if (error == EPERM && mal_posix_fs_lstat(job->path, &status) == 0
                && status.type == MAL_POSIX_FT_DIR) {
                error = EISDIR;
            }
            fs_fail(job, error, "unlink");
            return;
        }
        case FS_COPY:
            fs_fail(job, mal_posix_fs_copy_file_mode(job->path, job->destination,
                (job->overwrite ? 0 : FS_COPY_EXCLUSIVE) | FS_COPY_CLONE), "copyfile");
            return;
        case FS_MOVE:
            fs_move(job);
            return;
        case FS_LIST:
            fs_fail(job, mal_posix_fs_readdir_tree(job->path, job->recursive, fs_list_admits,
                job, &job->entries, &job->entry_count, &job->directory), "scandir");
            if (job->directory != nullptr) job->error_path = job->directory;
            return;
        case FS_CREATE_DIRECTORY:
            fs_fail(job, mal_posix_fs_mkdir_mode(job->path, job->recursive, job->mode, nullptr), "mkdir");
            return;
        case FS_REMOVE_DIRECTORY:
            fs_fail(job, job->recursive ? mal_posix_fs_rmdir_recursive(job->path)
                : mal_posix_fs_rmdir(job->path), "rmdir");
            return;
    }
}

static MalValue fs_string(MalVm *vm, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

/* `{ code, description, syscall, path, destination }`, which the source module turns
 * into a FileSystemError. */
MalValue mal_fs_failure(
    MalVm *vm, int error, const char *syscall, const char *path, const char *destination) {
    const char *names[] = {"code", "description", "syscall", "path", "destination"};
    const char *description = error == ENOTSUP ? "operation not supported" :
        mal_posix_errno_description(error);
    const char *texts[] = {mal_posix_fs_errno_name(error), description, syscall, path, destination};
    MalValue roots[2] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 0; i < countof(names); i++) {
        if (texts[i] == nullptr) continue;
        roots[1] = fs_string(vm, texts[i]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) names[i],
            roots[1], FS_VISIBLE);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue fs_stat_result(MalVm *vm, const MalPosixStat *status) {
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalObject *object = mal_value_to_object(result);
    mal_intrinsic_define_data(vm, object, (const byte *) "type", mal_value_from_i32((i32) status->type), FS_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "size", mal_value_from_f64(status->size), FS_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "mtimeMs", mal_value_from_f64(status->mtime_ms), FS_VISIBLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "mode", mal_value_from_i32((i32) status->mode), FS_VISIBLE);
    mal_gc_unroot(&root);
    return result;
}

MalValue mal_fs_take_bytes(MalVm *vm, byte *bytes, usize length) {
    if (length > UINT32_MAX) {
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "File is too large for an ArrayBuffer");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *buffer = mal_array_buffer_object_adopt(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        bytes, (u32) length, false);
    if (buffer == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue roots[1] = {mal_value_from_array_buffer_object(buffer)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 1);
    MalTypedArrayObject *view = mal_typed_array_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) length, false);
    mal_gc_unroot(&root);
    if (view == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_typed_array_object(view);
}

static MalValue fs_text_result(MalVm *vm, const FsJob *job) {
    const byte *bytes = job->bytes;
    usize length = job->length;
    const u8 *raw = (const u8 *) bytes;
    if (length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) {
        bytes += 3;
        length -= 3;
    }
    MalUtf8DecodeStatus status = MAL_UTF8_DECODE_OK;
    MalString *text = mal_string_from_utf8_report(&vm->heap, bytes, length, nullptr, &status);
    if (status == MAL_UTF8_DECODE_LENGTH_OVERFLOW) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "File is too large for a string");
        return mal_value_new_undefined();
    }
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(text);
}

static MalValue fs_list_result(MalVm *vm, const FsJob *job) {
    if (job->entry_count > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "Directory listing is too large for an array");
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) job->entry_count)),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 0; i < job->entry_count; i++) {
        const MalPosixDirent *entry = &job->entries[i];
        roots[1] = fs_string(vm, entry->name);
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (!job->files_only) {
            roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
            MalObject *object = mal_value_to_object(roots[2]);
            mal_intrinsic_define_data(vm, object, (const byte *) "path", roots[1], FS_VISIBLE);
            mal_intrinsic_define_data(vm, object, (const byte *) "type",
                mal_value_from_i32((i32) entry->type), FS_VISIBLE);
        }
        if (!mal_array_object_set(mal_value_to_array_object(roots[0]), mal_key_index(i),
            roots[job->files_only ? 1 : 2])) {
            mal_vm_throw_allocation_error(vm);
            break;
        }
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue fs_job_result(MalVm *vm, FsJob *job) {
    switch (job->operation) {
        case FS_EXISTS: return mal_value_new_boolean(job->exists);
        case FS_STAT:
        case FS_LSTAT: return fs_stat_result(vm, &job->stat);
        case FS_READ_BYTES: {
            byte *bytes = job->bytes;
            job->bytes = nullptr;
            return mal_fs_take_bytes(vm, bytes, job->length);
        }
        case FS_READ_TEXT: return fs_text_result(vm, job);
        case FS_WRITE: return mal_value_from_f64((f64) job->length);
        case FS_LIST: return fs_list_result(vm, job);
        case FS_REMOVE:
        case FS_COPY:
        case FS_CREATE_DIRECTORY:
        case FS_REMOVE_DIRECTORY:
        case FS_MOVE: return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static void fs_job_settle(
    MalVm *vm, void *data, bool cancelled, u32 tag, MalValue values[MAL_BLOCKING_JOB_VALUES]) {
    FsJob *job = data;
    MalPromiseObject *promise = mal_value_to_promise_object(values[0]);
    MalValue result;
    bool failed = true;
    if (cancelled || job == nullptr) {
        result = mal_fs_failure(vm, ECANCELED, fs_operation_syscall((FsOperation) tag), nullptr, nullptr);
    } else if (job->error != 0) {
        bool two_paths = job->operation == FS_COPY || job->operation == FS_MOVE;
        result = mal_fs_failure(vm, job->error, job->syscall, job->error_path,
            two_paths ? job->destination : nullptr);
    } else {
        result = fs_job_result(vm, job);
        failed = false;
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        result = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        failed = true;
    }
    if (failed) mal_promise_reject(vm, promise, result);
    else mal_promise_fulfill(vm, promise, result);
}

/* A pending promise for the job; rejects instead when the pool refuses it. */
static MalValue fs_start(MalVm *vm, FsJob *job) {
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, &promise, 1);
    MalBlockingJob blocking = {
        .run = fs_job_run,
        .destroy = fs_job_free,
        .settle = fs_job_settle,
        .data = job,
        .footprint = sizeof(*job) + job->length + job->pattern_bytes + strlen(job->path) + 1
            + (job->destination == nullptr ? 0 : strlen(job->destination) + 1),
        .tag = job->operation,
        .values = {promise},
    };
    MalBlockingWorkReservation reservation = {0};
    MalBlockingJobStart started = mal_blocking_job_start(vm, &blocking, &reservation);
    if (started != MAL_BLOCKING_JOB_STARTED) {
        mal_blocking_work_reservation_release(&reservation);
        if (started == MAL_BLOCKING_JOB_NO_MEMORY) mal_vm_throw_allocation_error(vm);
        else {
            MalValue failure = mal_fs_failure(vm, EAGAIN, fs_operation_syscall(job->operation),
                job->path, job->destination);
            if (vm->completion.kind != MAL_COMPLETION_THROW)
                mal_promise_reject(vm, mal_value_to_promise_object(promise), failure);
        }
        fs_job_free(job);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : promise;
}

char *mal_fs_path(MalVm *vm, MalValue value) {
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "path must be a string");
        return nullptr;
    }
    char *path = nullptr;
    usize length = 0;
    switch (mal_string_to_utf8_c_string(mal_value_to_string(value), &path, &length)) {
        case MAL_UTF8_C_STRING_OK:
            return path;
        case MAL_UTF8_C_STRING_EMBEDDED_NUL:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "path must not contain null bytes");
            return nullptr;
        case MAL_UTF8_C_STRING_ALLOCATION_FAILED:
            break;
    }
    mal_vm_throw_allocation_error(vm);
    return nullptr;
}

static bool fs_argument_true(const MalValue *args, i32 argc, i32 index) {
    return index < argc && mal_value_is_truthy(args[index]);
}

/* A job for `operation` on the path argument, or null after throwing. */
static FsJob *fs_job_new(MalVm *vm, FsOperation operation, const MalValue *args, i32 argc) {
    FsJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    job->operation = operation;
    job->path = mal_fs_path(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (job->path == nullptr) {
        fs_job_free(job);
        return nullptr;
    }
    return job;
}

/* mediaType(path): the media type the extension implies. */
static MalValue fs_media_type(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    char *path = mal_fs_path(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalValue type = fs_string(vm, mal_asset_media_type(path));
    free(path);
    return type;
}

/* exists(path): whether the path resolves, following symbolic links. */
static MalValue fs_exists(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_EXISTS, args, argc);
    return job == nullptr ? mal_value_new_undefined() : fs_start(vm, job);
}

/* stat(path, follow): `{ type, size, mtimeMs, mode }`. */
static MalValue fs_stat(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, fs_argument_true(args, argc, 1) ? FS_STAT : FS_LSTAT, args, argc);
    return job == nullptr ? mal_value_new_undefined() : fs_start(vm, job);
}

/* read(path, text): the contents as a Uint8Array, or as text without a byte order mark. */
static MalValue fs_read(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, fs_argument_true(args, argc, 1) ? FS_READ_TEXT : FS_READ_BYTES,
        args, argc);
    return job == nullptr ? mal_value_new_undefined() : fs_start(vm, job);
}

/* Copy the bytes to write, so the worker never reads a buffer JavaScript can detach. */
bool mal_fs_copy_data(MalVm *vm, MalValue data, byte **bytes, usize *length) {
    if (mal_value_is_string(data)) {
        *bytes = mal_string_to_utf8(mal_value_to_string(data), length);
        if (*bytes == nullptr && *length > 0) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        return true;
    }
    MalBufferSourceSpan span;
    switch (mal_buffer_source_span(data, &span)) {
        case MAL_BUFFER_SOURCE_SPAN_OK:
            break;
        case MAL_BUFFER_SOURCE_SPAN_DETACHED:
        case MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write data is detached or out of bounds");
            return false;
        case MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write data must be a string, an ArrayBuffer or an ArrayBufferView");
            return false;
    }
    *length = span.length;
    if (span.length == 0) return true;
    *bytes = malloc(span.length);
    if (*bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    mal_buffer_source_span_read(&span, 0, *bytes, span.length);
    return true;
}

/* write(path, data, flags, mode): the number of bytes written. */
static MalValue fs_write_file(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_WRITE, args, argc);
    if (job == nullptr) return mal_value_new_undefined();
    if (!mal_fs_copy_data(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &job->bytes, &job->length)) {
        fs_job_free(job);
        return mal_value_new_undefined();
    }
    job->flags = argc > 2 && mal_ops_is_number(args[2]) ? (u32) mal_ops_number_as_f64(args[2]) : 0;
    job->has_mode = argc > 3 && mal_ops_is_number(args[3]);
    if (job->has_mode) job->mode = (u32) mal_ops_number_as_f64(args[3]) & 07777;
    return fs_start(vm, job);
}

/* remove(path): unlink a file; a directory fails with EISDIR. */
static MalValue fs_remove(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_REMOVE, args, argc);
    return job == nullptr ? mal_value_new_undefined() : fs_start(vm, job);
}

static MalValue fs_transfer(
    MalVm *vm, FsOperation operation, const MalValue *args, i32 argc) {
    FsJob *job = fs_job_new(vm, operation, args, argc);
    if (job == nullptr) return mal_value_new_undefined();
    job->destination = mal_fs_path(vm, argc > 1 ? args[1] : mal_value_new_undefined());
    if (job->destination == nullptr) {
        fs_job_free(job);
        return mal_value_new_undefined();
    }
    job->overwrite = fs_argument_true(args, argc, 2);
    return fs_start(vm, job);
}

/* copy(source, destination, overwrite). */
static MalValue fs_copy(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return fs_transfer(vm, FS_COPY, args, argc);
}

/* move(source, destination, overwrite). */
static MalValue fs_move_file(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return fs_transfer(vm, FS_MOVE, args, argc);
}

static bool fs_read_patterns(MalVm *vm, MalValue list, FsPatterns *patterns, usize *footprint) {
    if (mal_value_is_undefined(list)) return true;
    if (!mal_value_is_array_object(list)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Directory patterns must be an array of strings");
        return false;
    }
    u32 length = mal_array_object_length(mal_value_to_array_object(list));
    patterns->values = calloc(length == 0 ? 1 : length, sizeof(*patterns->values));
    if (patterns->values == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    *footprint += length * sizeof(*patterns->values);
    for (u32 i = 0; i < length; i++) {
        MalValue value;
        if (!mal_vm_get_property(vm, list, mal_key_index(i), &value)) return false;
        char *pattern = mal_fs_path(vm, value);
        if (pattern == nullptr) return false;
        patterns->values[patterns->count++] = pattern;
        *footprint += strlen(pattern) + 1;
    }
    return true;
}

static MalValue fs_list(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_LIST, args, argc);
    if (job == nullptr) return mal_value_new_undefined();
    job->recursive = fs_argument_true(args, argc, 1);
    job->files_only = fs_argument_true(args, argc, 2);
    job->dot = fs_argument_true(args, argc, 3);
    MalValue include = argc > 4 ? args[4] : mal_value_new_undefined();
    MalValue exclude = argc > 5 ? args[5] : mal_value_new_undefined();
    if (!fs_read_patterns(vm, include, &job->include, &job->pattern_bytes)
        || !fs_read_patterns(vm, exclude, &job->exclude, &job->pattern_bytes)) {
        fs_job_free(job);
        return mal_value_new_undefined();
    }
    return fs_start(vm, job);
}

static MalValue fs_create_directory(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_CREATE_DIRECTORY, args, argc);
    if (job == nullptr) return mal_value_new_undefined();
    job->recursive = fs_argument_true(args, argc, 1);
    job->mode = argc > 2 && mal_ops_is_number(args[2]) ? (u32) mal_ops_number_as_f64(args[2]) & 07777 : 0777;
    return fs_start(vm, job);
}

static MalValue fs_remove_directory(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    FsJob *job = fs_job_new(vm, FS_REMOVE_DIRECTORY, args, argc);
    if (job == nullptr) return mal_value_new_undefined();
    job->recursive = fs_argument_true(args, argc, 1);
    return fs_start(vm, job);
}

void mal_host_install_maligator_internal_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    if (!mal_blocking_jobs_install(vm)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Could not register maligator:fs runtime cleanup");
        return;
    }
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
        i32 length;
    } functions[] = {
        {"mediaType", fs_media_type, 1},
        {"exists", fs_exists, 1},
        {"stat", fs_stat, 2},
        {"read", fs_read, 2},
        {"write", fs_write_file, 4},
        {"remove", fs_remove, 1},
        {"copy", fs_copy, 3},
        {"move", fs_move_file, 3},
        {"list", fs_list, 6},
        {"createDirectory", fs_create_directory, 3},
        {"removeDirectory", fs_remove_directory, 2},
    };
    for (i32 i = 0; i < count; i++) {
        for (usize j = 0; j < countof(functions); j++) {
            if (strcmp(slots[i].name, functions[j].name) != 0) continue;
            vm->globals[slots[i].slot] = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots_arity(&vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                    mal_intrinsic_ascii(vm, (const byte *) slots[i].name), functions[j].length,
                    functions[j].callback, nullptr, 0));
            break;
        }
    }
}
