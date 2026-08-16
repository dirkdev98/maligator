#include "node_fs.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_promise.h"
#include "date_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_buffer.h"
#include "node_module.h"
#include "node_stream.h"
#include "object.h"
#include "object_ops.h"
#include "posix_fs.h" // host layer: the POSIX syscalls + errno results
#include "property_store.h"
#include "promise_object.h"
#include "table.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// The MalPosixFileType is stashed here (non-enumerable) so the shared isFile /
// isDirectory predicates can classify `this` without the runtime layer touching
// any POSIX `S_IF*` bits. Non-enumerable → invisible to Object.keys / JSON / for-in.
#define NODE_FS_TYPE_KEY "__nodeFsType"

static const MalPropertyFlags NODE_FS_VISIBLE =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

/* ---------------------------------------------------------------------------
 * Value helpers.
 * --------------------------------------------------------------------------- */

static MalValue node_fs_string_from_utf8(MalVm *vm, const byte *bytes, usize len) {
    MalString *string = mal_string_from_utf8(&vm->heap, bytes, len);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static MalValue node_fs_string_from_cstr(MalVm *vm, const char *cstr) {
    return node_fs_string_from_utf8(vm, (const byte *) cstr, strlen(cstr));
}

/* Coerce a value to a NUL-terminated UTF-8 path (malloc'd; caller frees). Returns
 * null when conversion or validation threw; the pending throw is left set. */
static char *node_fs_path_cstr(MalVm *vm, MalValue value) {
    MalString *str;
    if (!mal_vm_to_string(vm, value, &str)) {
        return nullptr;
    }
    usize len;
    char *bytes;
    MalUtf8CStringResult result = mal_string_to_utf8_c_string(str, &bytes, &len);
    if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "filesystem path must not contain null bytes");
        return nullptr;
    }
    if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return bytes;
}

/* Build a string value, root it across the define, and set it as an enumerable own
 * property. `object` must already be rooted by the caller. */
static void node_fs_define_str(MalVm *vm, MalObject *object, const char *key, const char *value) {
    MalValue v = node_fs_string_from_cstr(vm, value);
    MalRootSpan rs;
    mal_gc_root(&rs, &v, 1);
    mal_intrinsic_define_data(vm, object, (const byte *) key, v, NODE_FS_VISIBLE);
    mal_gc_unroot(&rs);
}

/* Throw a Node-shaped Error for `err` ("CODE: description, syscall 'path'") and
 * attach the `errno` / `code` / `syscall` / `path` diagnostics Node callers read. */
static void node_fs_throw_errno_with_dest(
    MalVm *vm, int err, const char *syscall, const char *path, const char *dest) {
    const char *code = mal_posix_fs_errno_name(err);
    const char *desc = strerror(err);
    usize cap = strlen(code) + strlen(desc) + strlen(syscall) + strlen(path)
        + (dest == nullptr ? 0 : strlen(dest)) + 24;
    char *message = malloc(cap);
    if (message != nullptr) {
        if (dest == nullptr) {
            snprintf(message, cap, "%s: %s, %s '%s'", code, desc, syscall, path);
        } else {
            snprintf(message, cap, "%s: %s, %s '%s' -> '%s'", code, desc, syscall, path, dest);
        }
    }
    MalValue msg = node_fs_string_from_cstr(vm, message != nullptr ? message : code);
    free(message);
    MalRootSpan rs;
    mal_gc_root(&rs, &msg, 1);
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, msg);
    mal_gc_unroot(&rs);
    // The thrown error is reachable (traced) via vm->completion.value, and the GC is
    // non-moving, so the raw pointer stays valid across the property allocations.
    MalValue thrown = vm->completion.value;
    if (mal_value_is_object(thrown)) {
        MalObject *error = mal_value_to_object(thrown);
        mal_intrinsic_define_data(vm, error, (const byte *) "errno", mal_value_from_i32(-err),
            NODE_FS_VISIBLE);
        node_fs_define_str(vm, error, "code", code);
        node_fs_define_str(vm, error, "syscall", syscall);
        node_fs_define_str(vm, error, "path", path);
        if (dest != nullptr) node_fs_define_str(vm, error, "dest", dest);
    }
}

static void node_fs_throw_errno(MalVm *vm, int err, const char *syscall, const char *path) {
    node_fs_throw_errno_with_dest(vm, err, syscall, path, nullptr);
}

/* The prototype (Stats / Dirent) carried in the active function's slot 0. Falls
 * back to %Object.prototype% defensively. */
static MalObject *node_fs_slot_proto(MalVm *vm, MalValue callee) {
    if (mal_value_is_native_function_object(callee)) {
        MalValue proto = mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0);
        if (mal_value_is_object(proto)) {
            return mal_value_to_object(proto);
        }
    }
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
}

/* ---------------------------------------------------------------------------
 * Stats / Dirent shared predicates (installed on both prototypes).
 * --------------------------------------------------------------------------- */

static u32 node_fs_this_type(MalVm *vm, MalValue self) {
    if (!mal_value_is_object(self)) {
        return MAL_POSIX_FT_OTHER;
    }
    MalValue v;
    if (!mal_vm_get_property(
            vm, self, mal_intrinsic_string_key(vm, (const byte *) NODE_FS_TYPE_KEY), &v)) {
        return MAL_POSIX_FT_OTHER;
    }
    if (mal_value_is_int32(v)) {
        return (u32) mal_value_to_i32(v);
    }
    if (mal_value_is_f64(v)) {
        return (u32) mal_value_to_f64(v);
    }
    return MAL_POSIX_FT_OTHER;
}

static MalValue node_fs_is_file(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_FILE);
}

static MalValue node_fs_is_directory(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_DIR);
}

static MalValue node_fs_is_symbolic_link(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(
        node_fs_this_type(vm, self) == MAL_POSIX_FT_SYMLINK);
}

/* A Stats object over `proto` carrying Node's Date-backed timestamps plus the
 * hidden type marker the predicates read. */
static MalValue node_fs_make_stats(MalVm *vm, MalObject *proto, const MalPosixStat *st) {
    MalObject *stats = mal_object_new(&vm->heap, proto);
    MalValue v = mal_value_from_object(stats);
    MalRootSpan rs;
    mal_gc_root(&rs, &v, 1);
    MalValue date = mal_value_from_date_object(mal_date_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]),
        trunc(st->ctime_ms)));
    MalRootSpan date_rs;
    mal_gc_root(&date_rs, &date, 1);
    mal_intrinsic_define_data(vm, stats, (const byte *) "ctime", date, NODE_FS_VISIBLE);
    mal_gc_unroot(&date_rs);
    date = mal_value_from_date_object(mal_date_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]),
        trunc(st->mtime_ms)));
    mal_gc_root(&date_rs, &date, 1);
    mal_intrinsic_define_data(vm, stats, (const byte *) "mtime", date, NODE_FS_VISIBLE);
    mal_gc_unroot(&date_rs);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "ctimeMs", mal_value_from_f64(st->ctime_ms), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "mtimeMs", mal_value_from_f64(st->mtime_ms), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "dev", mal_value_from_f64(st->dev), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "ino", mal_value_from_f64(st->ino), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "size", mal_value_from_f64(st->size), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "mode", mal_value_from_f64((f64) st->mode), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, stats, (const byte *) NODE_FS_TYPE_KEY,
        mal_value_from_i32((i32) st->type), MAL_PROPERTY_NONE);
    mal_gc_unroot(&rs);
    return v;
}

/* ---------------------------------------------------------------------------
 * The *Sync methods.
 * --------------------------------------------------------------------------- */

static MalValue node_fs_exists_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined(); // ToString threw; propagate
    }
    bool exists = mal_posix_fs_exists(path);
    free(path);
    return mal_value_new_boolean(exists);
}

static MalValue node_fs_read_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    byte *data;
    usize len;
    int err = mal_posix_fs_read_file(path, &data, &len);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "open", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        MalValue result = node_fs_string_from_utf8(vm, data, len);
        free(data);
        return result;
    }
    return mal_node_buffer_from_owned_bytes(vm, data, len);
}

static MalValue node_fs_write_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue data = argc >= 2 ? args[1] : mal_value_new_undefined();
    const byte *bytes = (const byte *) "";
    usize len = 0;
    byte *owned = nullptr; // set when we UTF-8-encode a string argument
    if (mal_value_is_typed_array_object(data)
        && mal_value_to_typed_array_object(data)->kind == MAL_TA_UINT8) {
        MalTypedArrayObject *ta = mal_value_to_typed_array_object(data);
        len = mal_typed_array_object_byte_length(ta);
        if (len > 0) {
            bytes = (const byte *) ta->buffer->data + ta->byte_offset;
        }
    } else if (mal_value_is_string(data)) {
        MalString *str;
        if (!mal_vm_to_string(vm, data, &str)) {
            free(path);
            return mal_value_new_undefined();
        }
        owned = mal_string_to_utf8(str, &len);
        if (owned == nullptr) {
            free(path);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        bytes = owned;
    } else {
        free(path);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "writeFileSync data must be a string or Uint8Array");
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_write_file(path, bytes, len);
    free(owned);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "open", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return mal_value_new_undefined();
}

static bool node_fs_fd(MalVm *vm, MalValue value, int *fd) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || number > INT_MAX || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "file descriptor must be a non-negative integer");
        return false;
    }
    *fd = (int) number;
    return true;
}

static bool node_fs_write_bytes(
    MalVm *vm, MalValue data, const byte **bytes, usize *length, byte **owned) {
    *bytes = (const byte *) "";
    *length = 0;
    *owned = nullptr;
    if (mal_value_is_typed_array_object(data)
        && mal_value_to_typed_array_object(data)->kind == MAL_TA_UINT8) {
        MalTypedArrayObject *view = mal_value_to_typed_array_object(data);
        *length = mal_typed_array_object_byte_length(view);
        if (*length > 0) {
            *bytes = (const byte *) view->buffer->data + view->byte_offset;
        }
        return true;
    }
    if (mal_value_is_string(data)) {
        *owned = mal_string_to_utf8(mal_value_to_string(data), length);
        if (*owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *bytes = *owned;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "write data must be a string or Uint8Array");
    return false;
}

static MalValue node_fs_append_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    const byte *bytes;
    usize length;
    byte *owned;
    if (!node_fs_write_bytes(vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
            &bytes, &length, &owned)) {
        free(path);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_append_file(path, bytes, length);
    free(owned);
    if (err != 0) node_fs_throw_errno(vm, err, "open", path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_unlink_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    int err = mal_posix_fs_unlink(path);
    if (err != 0) node_fs_throw_errno(vm, err, "unlink", path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_write_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    const byte *bytes;
    usize length;
    byte *owned;
    if (!node_fs_write_bytes(
            vm, argc > 1 ? args[1] : mal_value_new_undefined(),
            &bytes, &length, &owned)) {
        return mal_value_new_undefined();
    }
    usize written;
    int err = mal_posix_fs_write_fd(fd, bytes, length, &written);
    free(owned);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "write", "");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) written);
}

static MalValue node_fs_stat_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    MalPosixStat st;
    int err = mal_posix_fs_stat(path, &st);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "stat", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &st);
}

static MalValue node_fs_lstat_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    char *path = node_fs_path_cstr(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalPosixStat st;
    int err = mal_posix_fs_lstat(path, &st);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "lstat", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &st);
}

static bool node_fs_time_value(MalVm *vm, MalValue value, i64 *seconds, i64 *nanoseconds) {
    f64 milliseconds;
    if (mal_value_is_date_object(value)) {
        milliseconds = mal_value_to_date_object(value)->date_value;
    } else {
        f64 seconds_value;
        if (!mal_vm_to_number(vm, value, &seconds_value)) return false;
        milliseconds = seconds_value * 1000.0;
    }
    if (!isfinite(milliseconds)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "utimesSync time must be a finite number or Date");
        return false;
    }
    f64 whole_seconds = floor(milliseconds / 1000.0);
    if (whole_seconds < (f64) INT64_MIN || whole_seconds > (f64) INT64_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "utimesSync time is outside the supported range");
        return false;
    }
    *seconds = (i64) whole_seconds;
    *nanoseconds = (i64) ((milliseconds - whole_seconds * 1000.0) * 1000000.0);
    return true;
}

static MalValue node_fs_utimes_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    i64 atime_seconds;
    i64 atime_nanoseconds;
    i64 mtime_seconds;
    i64 mtime_nanoseconds;
    if (!node_fs_time_value(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(),
            &atime_seconds, &atime_nanoseconds)
        || !node_fs_time_value(vm,
            argc >= 3 ? args[2] : mal_value_new_undefined(),
            &mtime_seconds, &mtime_nanoseconds)) {
        free(path);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_utimes(path,
        atime_seconds, atime_nanoseconds, mtime_seconds, mtime_nanoseconds);
    if (err != 0) node_fs_throw_errno(vm, err, "utime", path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_readdir_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    bool with_types = false;
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue wft;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "withFileTypes"), &wft)) {
            free(path);
            return mal_value_new_undefined();
        }
        with_types = mal_value_is_truthy(wft);
    }
    MalPosixDirent *entries;
    usize count;
    int err = mal_posix_fs_readdir(path, &entries, &count);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "scandir", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);

    MalObject *dirent_proto = node_fs_slot_proto(vm, callee);
    MalValue array = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) count));
    MalRootSpan array_rs;
    mal_gc_root(&array_rs, &array, 1);
    MalObject *array_obj = mal_value_to_object(array);
    for (usize i = 0; i < count; i++) {
        // Root the name string + the dirent object together across the allocations
        // that build them; after mal_object_set they survive via the (rooted) array.
        MalValue held[2];
        held[0] = mal_value_new_undefined();
        held[1] = mal_value_new_undefined();
        MalRootSpan rs;
        mal_gc_root(&rs, held, 2);
        held[0] = node_fs_string_from_utf8(
            vm, (const byte *) entries[i].name, strlen(entries[i].name));
        MalValue element;
        if (with_types) {
            MalObject *dirent = mal_object_new(&vm->heap, dirent_proto);
            held[1] = mal_value_from_object(dirent);
            mal_intrinsic_define_data(vm, dirent, (const byte *) "name", held[0], NODE_FS_VISIBLE);
            mal_intrinsic_define_data(vm, dirent, (const byte *) NODE_FS_TYPE_KEY,
                mal_value_from_i32((i32) entries[i].type), MAL_PROPERTY_NONE);
            element = held[1];
        } else {
            element = held[0];
        }
        mal_object_set(array_obj, mal_key_index(i), element);
        mal_gc_unroot(&rs);
    }
    mal_gc_unroot(&array_rs);
    mal_posix_fs_free_dirents(entries, count);
    return array;
}

static MalValue node_fs_mkdir_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    bool recursive = false;
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue rec;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "recursive"), &rec)) {
            free(path);
            return mal_value_new_undefined();
        }
        recursive = mal_value_is_truthy(rec);
    }
    int err = mal_posix_fs_mkdir(path, recursive);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "mkdir", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    // Node returns the first created directory for recursive; undefined is a
    // conforming value and all this slice's callers need.
    return mal_value_new_undefined();
}

static MalValue node_fs_copy_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *source = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (source == nullptr) return mal_value_new_undefined();
    char *destination = node_fs_path_cstr(vm, argc >= 2 ? args[1] : mal_value_new_undefined());
    if (destination == nullptr) {
        free(source);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_copy_file(source, destination);
    if (err != 0) node_fs_throw_errno(vm, err, "copyfile", source);
    free(destination);
    free(source);
    return mal_value_new_undefined();
}

static MalValue node_fs_realpath_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *input = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (input == nullptr) return mal_value_new_undefined();
    char *resolved;
    int err = mal_posix_fs_realpath(input, &resolved);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "realpath", input);
        free(input);
        return mal_value_new_undefined();
    }
    MalValue result = node_fs_string_from_cstr(vm, resolved);
    free(resolved);
    free(input);
    return result;
}

static MalValue node_fs_rename_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *source = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (source == nullptr) return mal_value_new_undefined();
    char *destination = node_fs_path_cstr(vm, argc >= 2 ? args[1] : mal_value_new_undefined());
    if (destination == nullptr) {
        free(source);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_rename(source, destination);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "rename", source, destination);
    free(destination);
    free(source);
    return mal_value_new_undefined();
}

static MalValue node_fs_mkdtemp_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *prefix = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (prefix == nullptr) return mal_value_new_undefined();
    char *created;
    int err = mal_posix_fs_mkdtemp(prefix, &created);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "mkdtemp", prefix);
        free(prefix);
        return mal_value_new_undefined();
    }
    MalValue result = node_fs_string_from_cstr(vm, created);
    free(created);
    free(prefix);
    return result;
}

static MalValue node_fs_rm_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    bool recursive = false;
    bool force = false;
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue option;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "recursive"), &option)) {
            free(path);
            return mal_value_new_undefined();
        }
        recursive = mal_value_is_truthy(option);
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "force"), &option)) {
            free(path);
            return mal_value_new_undefined();
        }
        force = mal_value_is_truthy(option);
    }
    int err = mal_posix_fs_rm(path, recursive, force);
    if (err != 0) node_fs_throw_errno(vm, err, recursive ? "rm" : "unlink", path);
    free(path);
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * Callback stat and buffered file Readable.
 * --------------------------------------------------------------------------- */

static void node_fs_clear_completion(MalVm *vm) {
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
}

enum {
    NODE_FS_PROMISE_TASK_PROMISE,
    NODE_FS_PROMISE_TASK_OPERATION,
    NODE_FS_PROMISE_TASK_PATH,
    NODE_FS_PROMISE_TASK_OPTIONS,
    NODE_FS_PROMISE_TASK_SLOT_COUNT,
};

static MalValue node_fs_promise_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[NODE_FS_PROMISE_TASK_SLOT_COUNT];
    for (i32 i = 0; i < NODE_FS_PROMISE_TASK_SLOT_COUNT; i++) {
        roots[i] = mal_native_function_object_get_slot(task, i);
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion completion = mal_vm_call_value(
        vm, roots[NODE_FS_PROMISE_TASK_OPERATION], mal_value_new_undefined(),
        roots + NODE_FS_PROMISE_TASK_PATH, 2);
    MalPromiseObject *promise = mal_value_to_promise_object(
        roots[NODE_FS_PROMISE_TASK_PROMISE]);
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_PROMISE_TASK_PATH] = completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, promise, roots[NODE_FS_PROMISE_TASK_PATH]);
    } else {
        roots[NODE_FS_PROMISE_TASK_PATH] = completion.value;
        mal_promise_fulfill(vm, promise, roots[NODE_FS_PROMISE_TASK_PATH]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_promises_operation(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue roots[NODE_FS_PROMISE_TASK_SLOT_COUNT] = {
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        argc >= 2 ? args[1] : mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "readdir"),
            node_fs_promise_task, roots, countof(roots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    MalValue promise = roots[NODE_FS_PROMISE_TASK_PROMISE];
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_callback_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[NODE_FS_PROMISE_TASK_SLOT_COUNT];
    for (i32 i = 0; i < NODE_FS_PROMISE_TASK_SLOT_COUNT; i++) {
        roots[i] = mal_native_function_object_get_slot(task, i);
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion completion = mal_vm_call_value(
        vm, roots[NODE_FS_PROMISE_TASK_OPERATION], mal_value_new_undefined(),
        roots + NODE_FS_PROMISE_TASK_PATH, 2);
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_PROMISE_TASK_PATH] = completion.value;
        node_fs_clear_completion(vm);
        mal_vm_call_value(vm, roots[NODE_FS_PROMISE_TASK_PROMISE],
            mal_value_new_undefined(), roots + NODE_FS_PROMISE_TASK_PATH, 1);
    } else {
        roots[NODE_FS_PROMISE_TASK_PATH] = mal_value_new_null();
        roots[NODE_FS_PROMISE_TASK_OPTIONS] = completion.value;
        mal_vm_call_value(vm, roots[NODE_FS_PROMISE_TASK_PROMISE],
            mal_value_new_undefined(), roots + NODE_FS_PROMISE_TASK_PATH, 2);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_callback_operation(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    i32 callback_index = argc - 1;
    if (callback_index < 1 || !mal_value_is_callable(args[callback_index])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readdir callback must be a function");
        return mal_value_new_undefined();
    }
    MalValue roots[NODE_FS_PROMISE_TASK_SLOT_COUNT] = {
        args[callback_index],
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        args[0],
        callback_index > 1 ? args[1] : mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "readdirCallback"),
            node_fs_callback_task, roots, countof(roots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_errno_value(
    MalVm *vm, int err, const char *syscall, const char *path) {
    node_fs_throw_errno(vm, err, syscall, path);
    MalValue error = vm->completion.value;
    node_fs_clear_completion(vm);
    return error;
}

static MalValue node_fs_write_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(task, 0),
        mal_native_function_object_get_slot(task, 1),
        mal_native_function_object_get_slot(task, 2),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    int fd;
    const byte *bytes;
    usize length;
    byte *owned;
    usize written = 0;
    int err = 0;
    if (!node_fs_fd(vm, roots[1], &fd)
        || !node_fs_write_bytes(vm, roots[2], &bytes, &length, &owned)) {
        roots[3] = vm->completion.value;
        node_fs_clear_completion(vm);
        err = -1;
    } else {
        err = mal_posix_fs_write_fd(fd, bytes, length, &written);
        free(owned);
        if (err != 0) roots[3] = node_fs_errno_value(vm, err, "write", "");
    }
    if (err == 0) {
        MalValue callback_args[] = {
            mal_value_new_null(), mal_value_from_f64((f64) written), roots[2],
        };
        mal_vm_call_value(
            vm, roots[0], mal_value_new_undefined(), callback_args, 3);
    } else {
        mal_vm_call_value(
            vm, roots[0], mal_value_new_undefined(), roots + 3, 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    i32 callback_index = argc - 1;
    if (callback_index < 2 || !mal_value_is_callable(args[callback_index])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "write callback must be a function");
        return mal_value_new_undefined();
    }
    MalValue slots[] = {args[callback_index], args[0], args[1]};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "write"),
            node_fs_write_task, slots, countof(slots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalCompletion node_fs_call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[] = {
        receiver, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 2; i++) roots[2 + i] = args[i];
    if (!mal_vm_get_property(
            vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) name), &roots[1])) {
        MalCompletion completion = vm->completion;
        mal_gc_unroot(&root);
        return completion;
    }
    MalCompletion completion = mal_vm_call_value(
        vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    mal_gc_unroot(&root);
    return completion;
}

static MalValue node_fs_stats_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalPosixStat empty = {0};
    return node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &empty);
}

static MalValue node_fs_stat_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(task, 0),
        mal_native_function_object_get_slot(task, 1),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *path = node_fs_path_cstr(vm, roots[1]);
    if (path == nullptr) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalPosixStat st;
    int err = mal_posix_fs_stat(path, &st);
    if (err == 0) {
        roots[2] = node_fs_make_stats(
            vm, mal_value_to_object(mal_native_function_object_get_slot(task, 2)), &st);
        MalValue callback_args[] = {mal_value_new_null(), roots[2]};
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), callback_args, 2);
    } else {
        roots[2] = node_fs_errno_value(vm, err, "stat", path);
        MalValue callback_args[] = {roots[2]};
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), callback_args, 1);
    }
    free(path);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_read_file_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(task, 0),
        mal_native_function_object_get_slot(task, 1),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *path = node_fs_path_cstr(vm, roots[1]);
    if (path == nullptr) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    byte *data;
    usize length;
    int err = mal_posix_fs_read_file(path, &data, &length);
    if (err == 0) {
        bool encoded = mal_value_to_boolean(
            mal_native_function_object_get_slot(task, 2));
        if (encoded) {
            roots[2] = node_fs_string_from_utf8(vm, data, length);
            free(data);
        } else {
            roots[2] = mal_node_buffer_from_owned_bytes(vm, data, length);
        }
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            MalValue callback_args[] = {mal_value_new_null(), roots[2]};
            mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), callback_args, 2);
        }
    } else {
        roots[2] = node_fs_errno_value(vm, err, "open", path);
        MalValue callback_args[] = {roots[2]};
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), callback_args, 1);
    }
    free(path);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool node_fs_read_file_encoding(
    MalVm *vm, MalValue options, bool *encoded) {
    *encoded = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) return true;
    if (mal_value_is_object(options)) {
        MalValue encoding;
        if (!mal_vm_get_property(vm, options,
                mal_intrinsic_string_key(vm, (const byte *) "encoding"), &encoding)) {
            return false;
        }
        return node_fs_read_file_encoding(vm, encoding, encoded);
    }
    if (!mal_value_is_string(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readFile encoding must be a string or null");
        return false;
    }
    MalString *encoding = mal_value_to_string(options);
    if (!mal_string_equals_ascii_ci(encoding, "utf8")
        && !mal_string_equals_ascii_ci(encoding, "utf-8")) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readFile only supports utf8 encoding");
        return false;
    }
    *encoded = true;
    return true;
}

static MalValue node_fs_read_file(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    i32 callback_index = argc - 1;
    if (callback_index < 1 || !mal_value_is_callable(args[callback_index])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readFile callback must be a function");
        return mal_value_new_undefined();
    }
    char *path = node_fs_path_cstr(vm, args[0]);
    if (path == nullptr) return mal_value_new_undefined();
    bool encoded;
    MalValue options = callback_index > 1 ? args[1] : mal_value_new_undefined();
    if (!node_fs_read_file_encoding(vm, options, &encoded)) {
        free(path);
        return mal_value_new_undefined();
    }
    MalValue slots[] = {
        args[callback_index], node_fs_string_from_cstr(vm, path),
        mal_value_new_boolean(encoded),
    };
    free(path);
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "readFileCallback"),
            node_fs_read_file_task, slots, countof(slots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_stat(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    if (argc < 2 || !mal_value_is_callable(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "stat callback must be a function");
        return mal_value_new_undefined();
    }
    char *path = node_fs_path_cstr(vm, args[0]);
    if (path == nullptr) return mal_value_new_undefined();
    MalValue slots[] = {
        args[1], node_fs_string_from_cstr(vm, path),
        mal_value_from_object(node_fs_slot_proto(vm, callee)),
    };
    free(path);
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "statCallback"),
            node_fs_stat_task, slots, countof(slots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool node_fs_stream_offset(
    MalVm *vm, MalValue options, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(options)) return true;
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) return true;
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || floor(number) != number || number < 0
        || number > 9007199254740991.0 || number > (f64) SIZE_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "createReadStream offsets must be non-negative integers");
        return false;
    }
    *out = mal_value_from_f64(number);
    return true;
}

static bool node_fs_truthy_property(MalVm *vm, MalValue object, const char *name) {
    MalValue value;
    return mal_vm_get_property(
               vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value)
        && mal_value_is_truthy(value);
}

static MalValue node_fs_read_stream_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(task, 0),
        mal_native_function_object_get_slot(task, 1),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (node_fs_truthy_property(vm, roots[0], "destroyed")) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    char *path = node_fs_path_cstr(vm, roots[1]);
    if (path == nullptr) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    byte *data;
    usize length;
    int err = mal_posix_fs_read_file(path, &data, &length);
    if (err != 0) {
        roots[2] = node_fs_errno_value(vm, err, "open", path);
        roots[3] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "error"));
        MalValue emit_args[] = {roots[3], roots[2]};
        node_fs_call_method(vm, roots[0], "emit", emit_args, 2);
        free(path);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    free(path);

    MalValue start_value = mal_native_function_object_get_slot(task, 2);
    MalValue end_value = mal_native_function_object_get_slot(task, 3);
    usize start = mal_value_is_undefined(start_value)
        ? 0 : (usize) mal_value_to_f64(start_value);
    usize end = mal_value_is_undefined(end_value) || length == 0
        ? (length == 0 ? 0 : length - 1)
        : (usize) mal_value_to_f64(end_value);
    if (start > length) start = length;
    if (length > 0 && end >= length) end = length - 1;
    usize selected = length == 0 || start == length || end < start ? 0 : end - start + 1;
    if (selected > 0 && start > 0) memmove(data, data + start, selected);
    roots[2] = mal_node_buffer_from_owned_bytes(vm, data, selected);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        node_fs_call_method(vm, roots[0], "push", roots + 2, 1);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[3] = mal_value_new_null();
        node_fs_call_method(vm, roots[0], "push", roots + 3, 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_create_read_stream(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue slots[] = {
        mal_value_new_undefined(), node_fs_string_from_cstr(vm, path),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    free(path);
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    if (!node_fs_stream_offset(vm, options, "start", &slots[2])
        || !node_fs_stream_offset(vm, options, "end", &slots[3])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(slots[2]) && !mal_value_is_undefined(slots[3])
        && mal_value_to_f64(slots[3]) < mal_value_to_f64(slots[2])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "createReadStream end must be greater than or equal to start");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalCompletion stream = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR], nullptr, 0);
    if (stream.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    slots[0] = stream.value;
    mal_object_set(mal_value_to_object(slots[0]),
        mal_intrinsic_string_key(vm, (const byte *) "path"), slots[1]);
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "readStream"),
            node_fs_read_stream_task, slots, countof(slots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    MalValue result = slots[0];
    mal_gc_unroot(&root);
    return result;
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

static MalValue node_fs_make_fn(
    MalVm *vm, MalObject *fn_proto, const char *name, i32 arity, MalNativeFunctionCallback cb) {
    MalNativeFunctionObject *fn = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) name), arity, cb);
    return mal_value_from_native_function_object(fn);
}

/* Like node_fs_make_fn but with `proto` captured in slot 0 (the Stats / Dirent
 * prototype the method allocates instances over) and the spec `length` restored. */
static MalValue node_fs_make_fn_slot(MalVm *vm, MalObject *fn_proto, const char *name, i32 arity,
    MalNativeFunctionCallback cb, MalValue proto) {
    MalValue slots[1] = {proto};
    MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) name), cb, slots, 1);
    MalValue value = mal_value_from_native_function_object(fn);
    MalRootSpan rs;
    mal_gc_root(&rs, &value, 1);
    mal_intrinsic_define_data(
        vm, (MalObject *) fn, (const byte *) "length", mal_value_from_i32(arity),
        MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&rs);
    return value;
}

static MalValue node_fs_make_constructor_slot(MalVm *vm, MalObject *fn_proto, const char *name,
    MalNativeFunctionCallback cb, MalValue proto) {
    MalValue value = node_fs_make_fn_slot(vm, fn_proto, name, 0, cb, proto);
    MalNativeFunctionObject *constructor = mal_value_to_native_function_object(value);
    mal_native_function_object_set_constructor(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", proto,
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(proto), (const byte *) "constructor", value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return value;
}

static MalValue node_fs_export(
    MalVm *vm, MalObject *fn_proto, const char *name, const MalValue *protos) {
    if (strcmp(name, "Stats") == 0) {
        return node_fs_make_constructor_slot(
            vm, fn_proto, "Stats", node_fs_stats_constructor, protos[0]);
    }
    if (strcmp(name, "createReadStream") == 0) {
        return node_fs_make_fn(vm, fn_proto, "createReadStream", 2, node_fs_create_read_stream);
    }
    if (strcmp(name, "existsSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "existsSync", 1, node_fs_exists_sync);
    }
    if (strcmp(name, "readFileSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "readFileSync", 1, node_fs_read_file_sync);
    }
    if (strcmp(name, "readFile") == 0) {
        return node_fs_make_fn(vm, fn_proto, "readFile", 3, node_fs_read_file);
    }
    if (strcmp(name, "writeFileSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "writeFileSync", 2, node_fs_write_file_sync);
    }
    if (strcmp(name, "appendFileSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "appendFileSync", 2, node_fs_append_file_sync);
    }
    if (strcmp(name, "unlinkSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "unlinkSync", 1, node_fs_unlink_sync);
    }
    if (strcmp(name, "utimesSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "utimesSync", 3, node_fs_utimes_sync);
    }
    if (strcmp(name, "writeSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "writeSync", 2, node_fs_write_sync);
    }
    if (strcmp(name, "write") == 0) {
        return node_fs_make_fn(vm, fn_proto, "write", 3, node_fs_write);
    }
    if (strcmp(name, "statSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "statSync", 1, node_fs_stat_sync, protos[0]);
    }
    if (strcmp(name, "lstatSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "lstatSync", 1, node_fs_lstat_sync, protos[0]);
    }
    if (strcmp(name, "stat") == 0) {
        return node_fs_make_fn_slot(vm, fn_proto, "stat", 2, node_fs_stat, protos[0]);
    }
    if (strcmp(name, "readdirSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "readdirSync", 1, node_fs_readdir_sync, protos[1]);
    }
	if (strcmp(name, "readdir") == 0) {
		MalValue operation = node_fs_make_fn_slot(
			vm, fn_proto, "readdirSync", 1, node_fs_readdir_sync, protos[1]);
		MalRootSpan root;
		mal_gc_root(&root, &operation, 1);
		MalValue result = node_fs_make_fn_slot(
			vm, fn_proto, "readdir", 3, node_fs_callback_operation, operation);
		mal_gc_unroot(&root);
		return result;
	}
    if (strcmp(name, "mkdirSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "mkdirSync", 1, node_fs_mkdir_sync);
    }
    if (strcmp(name, "copyFileSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "copyFileSync", 2, node_fs_copy_file_sync);
    }
    if (strcmp(name, "realpathSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "realpathSync", 1, node_fs_realpath_sync);
    }
    if (strcmp(name, "renameSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "renameSync", 2, node_fs_rename_sync);
    }
    if (strcmp(name, "mkdtempSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "mkdtempSync", 1, node_fs_mkdtemp_sync);
    }
    if (strcmp(name, "rmSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "rmSync", 1, node_fs_rm_sync);
    }
    return mal_value_new_undefined();
}

void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }
    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    // Two shared prototypes hold the isFile / isDirectory predicates. They are kept
    // alive for the isolate by living in the statSync / readdirSync closure slots,
    // which sit in reachable globals; root them until those closures are built.
    MalValue protos[2];
    protos[0] = mal_value_new_undefined(); // Stats.prototype
    protos[1] = mal_value_new_undefined(); // Dirent.prototype
    MalRootSpan proto_rs;
    mal_gc_root(&proto_rs, protos, 2);

    MalObject *stats_proto = mal_object_new(&vm->heap, obj_proto);
    protos[0] = mal_value_from_object(stats_proto);
    mal_intrinsic_define_method_n(vm, stats_proto, (const byte *) "isFile", 0, node_fs_is_file);
    mal_intrinsic_define_method_n(
        vm, stats_proto, (const byte *) "isDirectory", 0, node_fs_is_directory);
    mal_intrinsic_define_method_n(
        vm, stats_proto, (const byte *) "isSymbolicLink", 0,
        node_fs_is_symbolic_link);

    MalObject *dirent_proto = mal_object_new(&vm->heap, obj_proto);
    protos[1] = mal_value_from_object(dirent_proto);
    mal_intrinsic_define_method_n(vm, dirent_proto, (const byte *) "isFile", 0, node_fs_is_file);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isDirectory", 0, node_fs_is_directory);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isSymbolicLink", 0,
        node_fs_is_symbolic_link);

    static const char *names[] = {
        "Stats", "appendFileSync", "copyFileSync", "createReadStream", "existsSync", "lstatSync", "mkdirSync",
		"mkdtempSync", "readFile", "readFileSync", "readdir", "readdirSync", "realpathSync", "renameSync",
        "rmSync", "statSync", "stat", "unlinkSync", "utimesSync", "write", "writeFileSync", "writeSync",
    };
    MalValue module = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan module_root;
    mal_gc_root(&module_root, &module, 1);
    for (usize i = 0; i < countof(names); i++) {
        MalValue value = node_fs_export(vm, fn_proto, names[i], protos);
        MalRootSpan value_root;
        mal_gc_root(&value_root, &value, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(module),
            (const byte *) names[i], value, NODE_FS_VISIBLE);
        mal_gc_unroot(&value_root);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE] = module;
    mal_node_module_publish(vm, slots, count, module);
    mal_gc_unroot(&module_root);

    mal_gc_unroot(&proto_rs);
}

void mal_host_install_node_fs_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, slots, count, cached);
        return;
    }

    mal_host_install_node_fs(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;

    MalValue roots[] = {
        vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE],
        mal_value_new_undefined(),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    static const struct {
        const char *name;
        const char *sync_name;
        i32 arity;
    } operations[] = {
        {"appendFile", "appendFileSync", 2},
        {"copyFile", "copyFileSync", 2},
        {"lstat", "lstatSync", 1},
        {"mkdir", "mkdirSync", 1},
        {"readFile", "readFileSync", 1},
        {"readdir", "readdirSync", 1},
        {"rename", "renameSync", 2},
        {"rm", "rmSync", 1},
        {"stat", "statSync", 1},
        {"unlink", "unlinkSync", 1},
        {"writeFile", "writeFileSync", 2},
    };
    for (usize i = 0; i < countof(operations); i++) {
        if (!mal_vm_get_property(vm, roots[0],
                mal_intrinsic_string_key(vm, (const byte *) operations[i].sync_name),
                &roots[1])) {
            mal_gc_unroot(&root);
            return;
        }
        MalValue operation = node_fs_make_fn_slot(
            vm, fn_proto, operations[i].name, operations[i].arity,
            node_fs_promises_operation, roots[1]);
        MalRootSpan operation_root;
        mal_gc_root(&operation_root, &operation, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]),
            (const byte *) operations[i].name, operation, NODE_FS_VISIBLE);
        mal_gc_unroot(&operation_root);
    }

    vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE] = roots[2];
    mal_node_module_publish(vm, slots, count, roots[2]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
