#include "maligator_fs.h"

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include "blocking_job.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_fs_object.h"
#include "posix_fs.h"
#include "promise_object.h"
#include "vm_ops.h"

typedef enum FsDescriptorOperation : u32 {
    FS_DESCRIPTOR_OPEN,
    FS_DESCRIPTOR_READ,
    FS_DESCRIPTOR_WRITE,
    FS_DESCRIPTOR_FLUSH,
    FS_DESCRIPTOR_CLOSE,
} FsDescriptorOperation;

typedef struct FsDescriptorJob {
    FsDescriptorOperation operation;
    char *path;
    char *parent;
    byte *bytes;
    usize length;
    i64 offset;
    int fd;
    int error;
    u32 flags;
    u32 mode;
    const char *syscall;
    const char *error_path;
    bool create_directories;
} FsDescriptorJob;

static const char *fs_descriptor_syscall(FsDescriptorOperation operation) {
    switch (operation) {
        case FS_DESCRIPTOR_OPEN: return "open";
        case FS_DESCRIPTOR_READ: return "read";
        case FS_DESCRIPTOR_WRITE: return "write";
        case FS_DESCRIPTOR_FLUSH: return "fsync";
        case FS_DESCRIPTOR_CLOSE: return "close";
    }
    return "open";
}

static void fs_descriptor_job_free(void *data) {
    FsDescriptorJob *job = data;
    if (job->fd >= 0 && (job->operation == FS_DESCRIPTOR_OPEN || job->operation == FS_DESCRIPTOR_CLOSE))
        (void) mal_posix_fs_close_fd(job->fd);
    free(job->path);
    free(job->parent);
    free(job->bytes);
    free(job);
}

static void fs_descriptor_job_run(void *data) {
    FsDescriptorJob *job = data;
    switch (job->operation) {
        case FS_DESCRIPTOR_OPEN:
            if (job->create_directories) {
                job->error = mal_fs_create_parents(job->path, &job->parent);
                if (job->error != 0) {
                    job->syscall = "mkdir";
                    if (job->parent != nullptr) job->error_path = job->parent;
                    return;
                }
            }
            job->error = mal_posix_fs_open(job->path, job->flags, false, job->mode, &job->fd);
            break;
        case FS_DESCRIPTOR_READ: {
            usize capacity = job->length;
            job->bytes = malloc(capacity);
            if (job->bytes == nullptr) {
                job->error = ENOMEM;
                return;
            }
            job->error = mal_posix_fs_read_fd(job->fd, job->bytes, capacity, true, job->offset, &job->length);
            if (job->error == 0 && job->length > 0 && job->length < capacity) {
                // Charge the buffer for the allocation it keeps after a short read.
                byte *trimmed = realloc(job->bytes, job->length);
                if (trimmed == nullptr) job->error = ENOMEM;
                else job->bytes = trimmed;
            }
            break;
        }
        case FS_DESCRIPTOR_WRITE:
            job->error = mal_posix_fs_write_fd(job->fd, job->bytes, job->length, &job->length);
            break;
        case FS_DESCRIPTOR_FLUSH:
            job->error = mal_posix_fs_sync_fd(job->fd);
            break;
        case FS_DESCRIPTOR_CLOSE: {
            int fd = job->fd;
            job->fd = -1;
            if (fd >= 0) job->error = mal_posix_fs_close_fd(fd);
            break;
        }
    }
}

/* The opaque descriptor uses the same heap layout and close-on-sweep contract as
 * Node's FileHandle. Its prototype and operations belong to maligator:fs. */
static void fs_descriptor_finalize(MalHeapHeader *cell) {
    MalNodeFsFileHandleObject *handle = (MalNodeFsFileHandleObject *) cell;
    if (handle->fd >= 0) {
        (void) mal_posix_fs_close_fd(handle->fd);
        handle->fd = -1;
    }
}

static MalValue fs_descriptor_result(MalVm *vm, FsDescriptorJob *job) {
    switch (job->operation) {
        case FS_DESCRIPTOR_OPEN: {
            MalNodeFsFileHandleObject *handle = mal_heap_try_alloc(
                &vm->heap, sizeof(*handle), MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT);
            if (handle == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
            mal_object_init(&vm->heap, &handle->object, MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT, nullptr);
            handle->fd = job->fd;
            job->fd = -1;
            return mal_value_from_heap((MalHeapHeader *) handle);
        }
        case FS_DESCRIPTOR_READ: {
            if (job->length == 0) return mal_value_new_undefined();
            byte *bytes = job->bytes;
            job->bytes = nullptr;
            return mal_fs_take_bytes(vm, bytes, job->length);
        }
        case FS_DESCRIPTOR_WRITE:
            return mal_value_from_f64((f64) job->length);
        case FS_DESCRIPTOR_FLUSH:
        case FS_DESCRIPTOR_CLOSE:
            return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static void fs_descriptor_settle(
    MalVm *vm, void *data, bool cancelled, u32 tag, MalValue values[MAL_BLOCKING_JOB_VALUES]) {
    FsDescriptorJob *job = data;
    bool failed = cancelled || job == nullptr || job->error != 0;
    MalValue result;
    if (cancelled || job == nullptr) {
        result = mal_fs_failure(vm, ECANCELED, fs_descriptor_syscall((FsDescriptorOperation) tag),
            job == nullptr ? nullptr : job->path, nullptr);
    } else if (failed) {
        result = mal_fs_failure(vm, job->error, job->syscall, job->error_path, nullptr);
    } else {
        result = fs_descriptor_result(vm, job);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        result = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        failed = true;
    }
    MalPromiseObject *promise = mal_value_to_promise_object(values[0]);
    if (failed) mal_promise_reject(vm, promise, result);
    else mal_promise_fulfill(vm, promise, result);
}

static MalValue fs_descriptor_start(MalVm *vm, FsDescriptorJob *job, MalValue descriptor) {
    MalValue roots[] = {mal_value_new_undefined(), descriptor};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalBlockingJob blocking = {
        .run = fs_descriptor_job_run,
        .destroy = fs_descriptor_job_free,
        .settle = fs_descriptor_settle,
        .data = job,
        .footprint = sizeof(*job) + job->length + strlen(job->path) + 1,
        .tag = job->operation,
        // Keep the descriptor alive until the worker has stopped using its fd.
        .values = {roots[0], roots[1]},
    };
    MalBlockingWorkReservation reservation = {0};
    MalBlockingJobStart started = mal_blocking_job_start(vm, &blocking, &reservation);
    if (started != MAL_BLOCKING_JOB_STARTED) {
        mal_blocking_work_reservation_release(&reservation);
        if (started == MAL_BLOCKING_JOB_NO_MEMORY) mal_vm_throw_allocation_error(vm);
        else {
            MalValue failure = mal_fs_failure(vm, EAGAIN, job->syscall, job->path, nullptr);
            if (vm->completion.kind != MAL_COMPLETION_THROW)
                mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), failure);
        }
        fs_descriptor_job_free(job);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[0];
}

enum { FS_OPEN_READ, FS_OPEN_WRITE, FS_OPEN_APPEND };

static MalValue fs_descriptor_operation(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    FsDescriptorOperation operation = (FsDescriptorOperation) mal_value_to_i32(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    MalValue descriptor = argc > 1 && operation != FS_DESCRIPTOR_OPEN ? args[1] : mal_value_new_undefined();
    MalNodeFsFileHandleObject *handle = nullptr;
    if (operation != FS_DESCRIPTOR_OPEN) {
        if (!mal_value_is_heap_type(descriptor, MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Invalid file descriptor");
            return mal_value_new_undefined();
        }
        handle = (MalNodeFsFileHandleObject *) mal_value_to_heap(descriptor);
        if (handle->fd < 0) {
            if (operation == FS_DESCRIPTOR_CLOSE) return mal_value_new_undefined();
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "File descriptor is closed");
            return mal_value_new_undefined();
        }
    }
    FsDescriptorJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    job->operation = operation;
    job->syscall = fs_descriptor_syscall(operation);
    job->fd = -1;
    job->path = mal_fs_path(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (job->path == nullptr) goto failed;
    job->error_path = job->path;
    switch (operation) {
        case FS_DESCRIPTOR_OPEN: {
            int access = argc > 1 && mal_ops_is_number(args[1]) ? (int) mal_ops_number_as_f64(args[1]) : FS_OPEN_READ;
            job->mode = argc > 3 && mal_ops_is_number(args[3]) ? (u32) mal_ops_number_as_f64(args[3]) & 07777 : 0666;
            job->create_directories = argc > 2 && mal_value_is_truthy(args[2]);
            job->flags = access == FS_OPEN_READ ? MAL_POSIX_OPEN_READ
                : MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE
                    | (access == FS_OPEN_APPEND ? MAL_POSIX_OPEN_APPEND : MAL_POSIX_OPEN_TRUNCATE);
            break;
        }
        case FS_DESCRIPTOR_READ: {
            f64 offset = argc > 2 && mal_ops_is_number(args[2]) ? mal_ops_number_as_f64(args[2]) : -1;
            f64 length = argc > 3 && mal_ops_is_number(args[3]) ? mal_ops_number_as_f64(args[3]) : 0;
            if (!(offset >= 0 && offset <= 9007199254740991.0 && length >= 1 && length <= UINT32_MAX)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "Invalid file range");
                goto failed;
            }
            job->offset = (i64) offset;
            job->length = (usize) length;
            break;
        }
        case FS_DESCRIPTOR_WRITE:
            if (!mal_fs_copy_data(vm, argc > 2 ? args[2] : mal_value_new_undefined(), &job->bytes, &job->length))
                goto failed;
            break;
        case FS_DESCRIPTOR_FLUSH:
        case FS_DESCRIPTOR_CLOSE:
            break;
    }
    if (handle != nullptr) {
        job->fd = handle->fd;
        // A queued close owns the fd even if shutdown cancels the worker call.
        if (operation == FS_DESCRIPTOR_CLOSE) handle->fd = -1;
    }
    return fs_descriptor_start(vm, job, descriptor);
failed:
    fs_descriptor_job_free(job);
    return mal_value_new_undefined();
}

void mal_host_install_maligator_internal_fs_descriptor(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    if (!mal_blocking_jobs_install(vm)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Could not register file descriptor cleanup");
        return;
    }
    mal_gc_register_finalizer(MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT, fs_descriptor_finalize);
    static const struct {
        const char *name;
        FsDescriptorOperation operation;
        i32 length;
    } functions[] = {
        {"openDescriptor", FS_DESCRIPTOR_OPEN, 4},
        {"readChunk", FS_DESCRIPTOR_READ, 4},
        {"writeChunk", FS_DESCRIPTOR_WRITE, 3},
        {"flushDescriptor", FS_DESCRIPTOR_FLUSH, 2},
        {"closeDescriptor", FS_DESCRIPTOR_CLOSE, 2},
    };
    for (i32 i = 0; i < count; i++) {
        for (usize j = 0; j < countof(functions); j++) {
            if (strcmp(slots[i].name, functions[j].name) != 0) continue;
            MalValue operation = mal_value_from_i32((i32) functions[j].operation);
            vm->globals[slots[i].slot] = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots_arity(&vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                    mal_intrinsic_ascii(vm, (const byte *) slots[i].name), functions[j].length,
                    fs_descriptor_operation, &operation, 1));
            break;
        }
    }
}
