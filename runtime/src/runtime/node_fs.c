#include "node_fs.h"

#if MAL_NODE

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_data_view.h"
#include "builtin_date.h"
#include "builtin_promise.h"
#include "date_object.h"
#include "function_object.h"
#include "gc.h"
#include "host.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_buffer.h"
#include "node_module.h"
#include "node_path.h"
#include "node_fs_object.h"
#include "node_stream.h"
#include "node_url.h"
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
#include "web_host_timer.h"

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

typedef enum NodeFsPathResult {
    NODE_FS_PATH_OK,
    NODE_FS_PATH_INVALID_TYPE,
    NODE_FS_PATH_EMBEDDED_NUL,
    NODE_FS_PATH_ALLOCATION_FAILED,
} NodeFsPathResult;

/* Convert Node's string / Uint8Array / WHATWG URL PathLike subset to a
 * malloc-owned C path. Uint8Array bytes cross unchanged so non-UTF-8 POSIX
 * paths remain representable. */
static NodeFsPathResult node_fs_path_bytes(
    MalVm *vm, MalValue value, bool silent, char **out) {
    if (mal_value_is_string(value)) {
        usize length;
        MalUtf8CStringResult result = mal_string_to_utf8_c_string(
            mal_value_to_string(value), out, &length);
        if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
            return NODE_FS_PATH_EMBEDDED_NUL;
        }
        if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
            return NODE_FS_PATH_ALLOCATION_FAILED;
        }
        return NODE_FS_PATH_OK;
    }
    if (mal_value_is_url_object(value)) {
        usize length;
        if (!mal_node_file_url_to_path_bytes(vm, value, silent, out, &length)) {
            return NODE_FS_PATH_INVALID_TYPE;
        }
        if (length > 0 && memchr(*out, 0, length) != nullptr) {
            free(*out);
            *out = nullptr;
            return NODE_FS_PATH_EMBEDDED_NUL;
        }
        return NODE_FS_PATH_OK;
    }
    if (!mal_value_is_typed_array_object(value)
        || mal_value_to_typed_array_object(value)->kind != MAL_TA_UINT8) {
        return NODE_FS_PATH_INVALID_TYPE;
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(value, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        return NODE_FS_PATH_INVALID_TYPE;
    }
    if (span.length > 0 && memchr(span.data, 0, span.length) != nullptr) {
        return NODE_FS_PATH_EMBEDDED_NUL;
    }
    char *path = malloc(span.length + 1);
    if (path == nullptr) return NODE_FS_PATH_ALLOCATION_FAILED;
    if (span.length > 0) memcpy(path, span.data, span.length);
    path[span.length] = '\0';
    *out = path;
    return NODE_FS_PATH_OK;
}

/* Validate a PathLike and return its malloc-owned C path. */
static char *node_fs_path_cstr(MalVm *vm, MalValue value) {
    char *path;
    NodeFsPathResult result = node_fs_path_bytes(vm, value, false, &path);
    if (result == NODE_FS_PATH_INVALID_TYPE) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "filesystem path must be a string, Uint8Array, or file URL");
        return nullptr;
    }
    if (result == NODE_FS_PATH_EMBEDDED_NUL) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "filesystem path must not contain null bytes");
        return nullptr;
    }
    if (result == NODE_FS_PATH_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return path;
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
    usize cap = strlen(code) + strlen(desc) + strlen(syscall)
        + (path == nullptr ? 0 : strlen(path))
        + (dest == nullptr ? 0 : strlen(dest)) + 24;
    char *message = malloc(cap);
    if (message != nullptr) {
        if (path == nullptr) {
            snprintf(message, cap, "%s: %s, %s", code, desc, syscall);
        } else if (dest == nullptr) {
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
        if (path != nullptr) node_fs_define_str(vm, error, "path", path);
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

static MalValue node_fs_is_block_device(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_BLOCK);
}

static MalValue node_fs_is_character_device(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_CHARACTER);
}

static MalValue node_fs_is_fifo(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_FIFO);
}

static MalValue node_fs_is_socket(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_boolean(node_fs_this_type(vm, self) == MAL_POSIX_FT_SOCKET);
}

static MalValue node_fs_date_getter(MalVm *vm, MalValue self, const char *name) {
    if (!mal_value_is_object(self)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Stats date getter requires an object receiver");
        return mal_value_new_undefined();
    }
    char milliseconds_name[16];
    snprintf(milliseconds_name, sizeof(milliseconds_name), "%sMs", name);
    MalValue milliseconds;
    if (!mal_vm_get_property(vm, self,
            mal_intrinsic_string_key(vm, (const byte *) milliseconds_name),
            &milliseconds)) {
        return mal_value_new_undefined();
    }
    f64 value = mal_ops_is_number(milliseconds)
        ? mal_ops_number_as_f64(milliseconds)
        : NAN;
    MalValue date = mal_value_from_date_object(mal_date_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]),
        round(value)));
    MalRootSpan root;
    mal_gc_root(&root, &date, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(self),
        (const byte *) name, date, NODE_FS_VISIBLE);
    mal_gc_unroot(&root);
    return date;
}

static MalValue node_fs_date_setter(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, const char *name) {
    if (!mal_value_is_object(self)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Stats date setter requires an object receiver");
        return mal_value_new_undefined();
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(self), (const byte *) name,
        argc > 0 ? args[0] : mal_value_new_undefined(), NODE_FS_VISIBLE);
    return mal_value_new_undefined();
}

#define NODE_FS_DATE_ACCESSORS(field) \
    static MalValue node_fs_get_##field( \
        MalVm *vm, MalValue self, const MalValue *args, i32 argc, \
        MalValue nt, MalValue callee) { \
        (void) args; \
        (void) argc; \
        (void) nt; \
        (void) callee; \
        return node_fs_date_getter(vm, self, #field); \
    } \
    static MalValue node_fs_set_##field( \
        MalVm *vm, MalValue self, const MalValue *args, i32 argc, \
        MalValue nt, MalValue callee) { \
        (void) nt; \
        (void) callee; \
        return node_fs_date_setter(vm, self, args, argc, #field); \
    }

NODE_FS_DATE_ACCESSORS(atime)
NODE_FS_DATE_ACCESSORS(mtime)
NODE_FS_DATE_ACCESSORS(ctime)
NODE_FS_DATE_ACCESSORS(birthtime)

#undef NODE_FS_DATE_ACCESSORS

/* A Stats object over `proto` carrying Node's numeric metadata. Date properties
 * are lazily materialized by the prototype accessors from their *Ms fields. */
static MalValue node_fs_make_stats(MalVm *vm, MalObject *proto, const MalPosixStat *st) {
    MalObject *stats = mal_object_new(&vm->heap, proto);
    MalValue v = mal_value_from_object(stats);
    MalRootSpan rs;
    mal_gc_root(&rs, &v, 1);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "dev", mal_value_from_f64(st->dev), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "mode", mal_value_from_f64((f64) st->mode), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "nlink", mal_value_from_f64(st->nlink), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "uid", mal_value_from_f64(st->uid), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "gid", mal_value_from_f64(st->gid), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "rdev", mal_value_from_f64(st->rdev), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "blksize", mal_value_from_f64(st->blksize), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "ino", mal_value_from_f64(st->ino), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "size", mal_value_from_f64(st->size), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "blocks", mal_value_from_f64(st->blocks), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "atimeMs", mal_value_from_f64(st->atime_ms), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "mtimeMs", mal_value_from_f64(st->mtime_ms), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(
        vm, stats, (const byte *) "ctimeMs", mal_value_from_f64(st->ctime_ms), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, stats, (const byte *) "birthtimeMs",
        mal_value_from_f64(st->birthtime_ms), NODE_FS_VISIBLE);
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
    char *path;
    NodeFsPathResult result = node_fs_path_bytes(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined(), true, &path);
    if (result == NODE_FS_PATH_INVALID_TYPE || result == NODE_FS_PATH_EMBEDDED_NUL) {
        return mal_value_new_boolean(false);
    }
    if (result == NODE_FS_PATH_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    bool exists = mal_posix_fs_exists(path);
    free(path);
    return mal_value_new_boolean(exists);
}

static MalValue node_fs_access_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    u32 mode = 0;
    if (argc > 1 && !mal_value_is_undefined(args[1]) && !mal_value_is_null(args[1])) {
        if (!mal_ops_is_number(args[1])) {
            free(path);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "access mode must be an integer or null");
            return mal_value_new_undefined();
        }
        f64 number = mal_ops_number_as_f64(args[1]);
        number = trunc(number);
        if (!isfinite(number) || number < 0 || number > 7) {
            free(path);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                (const byte *) "access mode must truncate to an integer from 0 through 7");
            return mal_value_new_undefined();
        }
        mode = (u32) number;
    }
    int err = mal_posix_fs_access(path, mode);
    if (err != 0) node_fs_throw_errno(vm, err, "access", path);
    free(path);
    return mal_value_new_undefined();
}

static bool node_fs_fd(MalVm *vm, MalValue value, int *fd);
static bool node_fs_open_flags(
    MalVm *vm, MalValue value, u32 *flags, bool *native_flags);
static bool node_fs_open_mode(MalVm *vm, MalValue value, u32 *mode);
static bool node_fs_write_bytes(
    MalVm *vm, MalValue data, MalValue encoding,
    const byte **bytes, usize *length, byte **owned);

static bool node_fs_encoding_option(
    MalVm *vm, MalValue value, const char *operation, MalValue *encoding) {
    if (mal_value_is_undefined(value) || mal_value_is_null(value)) {
        *encoding = mal_value_new_undefined();
        return true;
    }
    if (!mal_node_buffer_encoding_is_known(value)) {
        char message[96];
        snprintf(message, sizeof(message), "%s encoding must name a supported Buffer encoding",
            operation);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return false;
    }
    *encoding = value;
    return true;
}

static bool node_fs_read_file_options(
    MalVm *vm, MalValue options, bool descriptor, MalValue *encoding,
    u32 *flags, bool *native_flags) {
    *encoding = mal_value_new_undefined();
    *flags = MAL_POSIX_OPEN_READ;
    *native_flags = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) return true;
    if (mal_value_is_string(options)) {
        return node_fs_encoding_option(vm, options, "readFile", encoding);
    }
    if (!mal_value_is_object(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readFile options must be a string or object");
        return false;
    }
    MalValue option;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "encoding"), &option)
        || !node_fs_encoding_option(vm, option, "readFile", encoding)) {
        return false;
    }
    if (descriptor) return true;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "flag"), &option)) {
        return false;
    }
    return mal_value_is_undefined(option)
        || node_fs_open_flags(vm, option, flags, native_flags);
}

static MalValue node_fs_read_file_result(
    MalVm *vm, byte *data, usize length, MalValue encoding) {
    if (mal_value_is_undefined(encoding)) {
        return mal_node_buffer_from_owned_bytes(vm, data, length);
    }
    MalValue result = mal_node_buffer_encode_bytes(
        vm, data, length, encoding, true);
    free(data);
    return result;
}

static MalValue node_fs_read_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue file = argc >= 1 ? args[0] : mal_value_new_undefined();
    bool descriptor = mal_ops_is_number(file);
    int fd;
    char *path = nullptr;
    if (descriptor) {
        if (!node_fs_fd(vm, file, &fd)) return mal_value_new_undefined();
    } else {
        path = node_fs_path_cstr(vm, file);
        if (path == nullptr) return mal_value_new_undefined();
    }
    MalValue encoding = mal_value_new_undefined();
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    u32 flags;
    bool native_flags;
    if (!node_fs_read_file_options(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(), descriptor,
            &encoding, &flags, &native_flags)) {
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    bool close_fd = !descriptor;
    if (close_fd) {
        int open_err = mal_posix_fs_open(path, flags, native_flags, 0666, &fd);
        if (open_err != 0) {
            node_fs_throw_errno(vm, open_err, "open", path);
            mal_gc_unroot(&encoding_root);
            free(path);
            return mal_value_new_undefined();
        }
    }
    byte *data;
    usize length;
    int err = mal_posix_fs_read_all_fd(fd, &data, &length);
    int close_err = close_fd ? mal_posix_fs_close_fd(fd) : 0;
    if (err != 0) {
        node_fs_throw_errno(vm, err, "read", path);
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    if (close_err != 0) {
        free(data);
        node_fs_throw_errno_with_dest(vm, close_err, "close", nullptr, nullptr);
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    MalValue result = node_fs_read_file_result(vm, data, length, encoding);
    mal_gc_unroot(&encoding_root);
    return result;
}

static bool node_fs_write_file_options(
    MalVm *vm, MalValue options, bool descriptor, u32 default_flags,
    u32 *flags, bool *native_flags, u32 *mode, MalValue *encoding, bool *flush) {
    *flags = default_flags;
    *native_flags = false;
    *mode = 0666;
    *encoding = mal_value_new_undefined();
    *flush = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) return true;
    if (mal_value_is_string(options)) {
        return node_fs_encoding_option(vm, options, "writeFile", encoding);
    }
    if (!mal_value_is_object(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "writeFileSync options must be a string or object");
        return false;
    }
    MalValue option;
    if (!mal_vm_get_property(vm, options,
            mal_intrinsic_string_key(vm, (const byte *) "encoding"), &option)
        || !node_fs_encoding_option(vm, option, "writeFile", encoding)) {
        return false;
    }
    if (!descriptor && !mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "flag"), &option)) {
        return false;
    }
    if (!descriptor && !mal_value_is_undefined(option) &&
        !node_fs_open_flags(vm, option, flags, native_flags)) {
        return false;
    }
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "mode"), &option)) {
        return false;
    }
    if (!mal_value_is_undefined(option) && !node_fs_open_mode(vm, option, mode)) {
        return false;
    }
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "flush"), &option)) {
        return false;
    }
    if (!mal_value_is_undefined(option) && !mal_value_is_boolean(option)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "writeFile flush option must be a boolean");
        return false;
    }
    *flush = mal_value_is_boolean(option) && mal_value_to_boolean(option);
    return true;
}

static MalValue node_fs_write_file_impl(
    MalVm *vm, const MalValue *args, i32 argc, u32 default_flags) {
    MalValue file = argc >= 1 ? args[0] : mal_value_new_undefined();
    bool descriptor = mal_ops_is_number(file);
    int fd;
    char *path = nullptr;
    if (descriptor) {
        if (!node_fs_fd(vm, file, &fd)) return mal_value_new_undefined();
    } else {
        path = node_fs_path_cstr(vm, file);
        if (path == nullptr) return mal_value_new_undefined();
    }
    u32 flags;
    bool native_flags;
    u32 mode;
    MalValue encoding = mal_value_new_undefined();
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    bool flush;
    if (!node_fs_write_file_options(
            vm, argc >= 3 ? args[2] : mal_value_new_undefined(), descriptor,
            default_flags, &flags, &native_flags, &mode, &encoding, &flush)) {
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    const byte *bytes;
    usize length;
    byte *owned;
    if (!node_fs_write_bytes(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(), encoding,
            &bytes, &length, &owned)) {
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    bool close_fd = !descriptor;
    if (close_fd) {
        int open_err = mal_posix_fs_open(path, flags, native_flags, mode, &fd);
        if (open_err != 0) {
            free(owned);
            node_fs_throw_errno(vm, open_err, "open", path);
            mal_gc_unroot(&encoding_root);
            free(path);
            return mal_value_new_undefined();
        }
    }
    usize written;
    const char *syscall = "write";
    int err = mal_posix_fs_write_fd(fd, bytes, length, &written);
    if (err == 0 && flush) {
        syscall = "fsync";
        err = mal_posix_fs_sync_fd(fd);
    }
    int close_err = close_fd ? mal_posix_fs_close_fd(fd) : 0;
    free(owned);
    if (err != 0) {
        node_fs_throw_errno(vm, err, syscall, path);
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    if (close_err != 0) {
        node_fs_throw_errno_with_dest(vm, close_err, "close", nullptr, nullptr);
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    mal_gc_unroot(&encoding_root);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_write_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    return node_fs_write_file_impl(vm, args, argc,
        MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE);
}

static MalValue node_fs_append_file_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    return node_fs_write_file_impl(vm, args, argc,
        MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND);
}

static bool node_fs_fd(MalVm *vm, MalValue value, int *fd) {
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "file descriptor must be a number");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < 0 || number > INT_MAX || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "file descriptor must be a non-negative integer");
        return false;
    }
    *fd = (int) number;
    return true;
}

static bool node_fs_non_negative_integer(
    MalVm *vm, MalValue value, const char *message, usize maximum, usize *result) {
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) message);
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < 0 || trunc(number) != number || number > (f64) maximum) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) message);
        return false;
    }
    *result = (usize) number;
    return true;
}

static bool node_fs_read_position(
    MalVm *vm, MalValue value, bool *has_position, i64 *position) {
    if (mal_value_is_undefined(value) || mal_value_is_null(value)) {
        *has_position = false;
        *position = 0;
        return true;
    }
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "read position must be an integer or null");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < -1 || trunc(number) != number
        || number > 9007199254740991.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "read position must be an integer from -1 through 2^53 - 1");
        return false;
    }
    *has_position = number >= 0;
    *position = number >= 0 ? (i64) number : 0;
    return true;
}

static bool node_fs_read_options(
    MalVm *vm, MalValue options, usize capacity,
    usize *offset, usize *length, bool *has_position, i64 *position) {
    *offset = 0;
    *length = capacity;
    *has_position = false;
    *position = 0;
    if (mal_value_is_undefined(options)) return true;
    if (!mal_value_is_object(options) || mal_value_is_null(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "read options must be an object");
        return false;
    }
    MalValue value;
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "offset"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)
        && !node_fs_non_negative_integer(
            vm, value, "read offset is out of range", capacity, offset)) {
        return false;
    }
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "length"), &value)) {
        return false;
    }
    *length = capacity - *offset;
    if (!mal_value_is_undefined(value)
        && !node_fs_non_negative_integer(
            vm, value, "read length is out of range", capacity - *offset, length)) {
        return false;
    }
    if (!mal_vm_get_property(
            vm, options, mal_intrinsic_string_key(vm, (const byte *) "position"), &value)) {
        return false;
    }
    return node_fs_read_position(vm, value, has_position, position);
}

static MalValue node_fs_read_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    MalValue buffer = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_typed_array_object(buffer) && !mal_value_is_data_view_object(buffer)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "read buffer must be a Buffer, TypedArray, or DataView");
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(buffer, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "read buffer is detached or out of bounds");
        return mal_value_new_undefined();
    }
    usize offset;
    usize length;
    bool has_position;
    i64 position;
    if (argc <= 2 || (argc == 3 && (mal_value_is_object(args[2])
            || mal_value_is_undefined(args[2])))) {
        if (!node_fs_read_options(vm,
                argc == 3 ? args[2] : mal_value_new_undefined(), span.length,
                &offset, &length, &has_position, &position)) {
            return mal_value_new_undefined();
        }
    } else {
        if (!node_fs_non_negative_integer(vm,
                argc > 2 ? args[2] : mal_value_new_undefined(),
                "read offset is out of range", span.length, &offset)
            || !node_fs_non_negative_integer(vm,
                argc > 3 ? args[3] : mal_value_new_undefined(),
                "read length is out of range", span.length - offset, &length)
            || !node_fs_read_position(vm,
                argc > 4 ? args[4] : mal_value_new_undefined(),
                &has_position, &position)) {
            return mal_value_new_undefined();
        }
    }
    usize read_count;
    int err = mal_posix_fs_read_fd(fd,
        span.data == nullptr ? nullptr : span.data + offset,
        length, has_position, position, &read_count);
    if (err != 0) {
        node_fs_throw_errno_with_dest(vm, err, "read", nullptr, nullptr);
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) read_count);
}

static bool node_fs_write_bytes(
    MalVm *vm, MalValue data, MalValue encoding,
    const byte **bytes, usize *length, byte **owned) {
    *bytes = (const byte *) "";
    *length = 0;
    *owned = nullptr;
    if (mal_value_is_typed_array_object(data) || mal_value_is_data_view_object(data)) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write data view is detached or out of bounds");
            return false;
        }
        *length = span.length;
        *bytes = span.data == nullptr ? (const byte *) "" : span.data;
        return true;
    }
    if (mal_value_is_string(data)) {
        if (mal_value_is_null(encoding)) encoding = mal_value_new_undefined();
        if (!mal_value_is_undefined(encoding)
            && !mal_node_buffer_encoding_is_known(encoding)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write encoding must name a supported Buffer encoding");
            return false;
        }
        *owned = mal_node_buffer_decode_string(vm, data, encoding, length);
        if (*owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *bytes = *owned;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "write data must be a string, TypedArray, or DataView");
    return false;
}

static MalValue node_fs_link_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *existing = node_fs_path_cstr(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (existing == nullptr) return mal_value_new_undefined();
    char *created = node_fs_path_cstr(
        vm, argc >= 2 ? args[1] : mal_value_new_undefined());
    if (created == nullptr) {
        free(existing);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_link(existing, created);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "link", existing, created);
    free(existing);
    free(created);
    return mal_value_new_undefined();
}

static bool node_fs_symlink_type(MalVm *vm, MalValue value) {
    if (mal_value_is_undefined(value) || mal_value_is_null(value)) return true;
    if (mal_value_is_string(value)) {
        MalString *type = mal_value_to_string(value);
        if (mal_string_equals_ascii(type, "file")
            || mal_string_equals_ascii(type, "dir")
            || mal_string_equals_ascii(type, "junction")) {
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        (const byte *) "symlink type must be file, dir, junction, null, or undefined");
    return false;
}

static MalValue node_fs_symlink_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *target = node_fs_path_cstr(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (target == nullptr) return mal_value_new_undefined();
    char *path = node_fs_path_cstr(
        vm, argc >= 2 ? args[1] : mal_value_new_undefined());
    if (path == nullptr) {
        free(target);
        return mal_value_new_undefined();
    }
    if (!node_fs_symlink_type(
            vm, argc >= 3 ? args[2] : mal_value_new_undefined())) {
        free(target);
        free(path);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_symlink(target, path);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "symlink", target, path);
    free(target);
    free(path);
    return mal_value_new_undefined();
}

static bool node_fs_readlink_options(
    MalVm *vm, MalValue options, MalValue *encoding, bool *buffer) {
    *encoding = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "utf8"));
    *buffer = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) return true;
    MalValue option = options;
    if (mal_value_is_object(options)) {
        if (!mal_vm_get_property(vm, options,
                mal_intrinsic_string_key(vm, (const byte *) "encoding"), &option)) {
            return false;
        }
        if (mal_value_is_undefined(option) || mal_value_is_null(option)) return true;
    } else if (!mal_value_is_string(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "readlink options must be a string or object");
        return false;
    }
    if (mal_value_is_string(option)
        && mal_string_equals_ascii_ci(mal_value_to_string(option), "buffer")) {
        *encoding = mal_value_new_undefined();
        *buffer = true;
        return true;
    }
    return node_fs_encoding_option(vm, option, "readlink", encoding);
}

static MalValue node_fs_readlink_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalValue encoding = mal_value_new_undefined();
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    bool buffer;
    if (!node_fs_readlink_options(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(), &encoding, &buffer)) {
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    byte *data;
    usize length;
    int err = mal_posix_fs_readlink(path, &data, &length);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "readlink", path);
        mal_gc_unroot(&encoding_root);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    MalValue result = buffer
        ? mal_node_buffer_from_owned_bytes(vm, data, length)
        : mal_node_buffer_encode_bytes(vm, data, length, encoding, true);
    if (!buffer) free(data);
    mal_gc_unroot(&encoding_root);
    return result;
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

static bool node_fs_mode(MalVm *vm, MalValue value, u32 *mode) {
    f64 number;
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        usize length = mal_string_length(string);
        number = 0;
        if (length == 0) goto invalid_type;
        for (usize i = 0; i < length; i++) {
            c16 digit = mal_string_code_unit_at(string, i);
            if (digit < '0' || digit > '7') goto invalid_type;
            number = number * 8 + digit - '0';
        }
    } else if (mal_value_is_int32(value) || mal_value_is_f64_or_nan(value)) {
        number = mal_ops_number_as_f64(value);
    } else {
invalid_type:
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "chmod mode must be an integer or octal string");
        return false;
    }
    if (!isfinite(number) || number < 0 || number > 4294967295.0 || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "chmod mode must be a non-negative 32-bit integer");
        return false;
    }
    *mode = (u32) number;
    return true;
}

static MalValue node_fs_chmod_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    u32 mode;
    if (!node_fs_mode(vm, argc >= 2 ? args[1] : mal_value_new_undefined(), &mode)) {
        free(path);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_chmod(path, mode);
    if (err != 0) node_fs_throw_errno(vm, err, "chmod", path);
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
    MalValue data = argc > 1 ? args[1] : mal_value_new_undefined();
    const byte *bytes;
    usize length;
    byte *owned = nullptr;
    bool has_position;
    i64 position;
    if (mal_value_is_string(data)) {
        MalValue encoding = argc > 3 ? args[3] : mal_value_new_undefined();
        if (!node_fs_write_bytes(vm, data, encoding, &bytes, &length, &owned)
            || !node_fs_read_position(vm,
                argc > 2 ? args[2] : mal_value_new_undefined(),
                &has_position, &position)) {
            free(owned);
            return mal_value_new_undefined();
        }
    } else {
        if (!mal_value_is_typed_array_object(data)
            && !mal_value_is_data_view_object(data)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write buffer must be a Buffer, TypedArray, or DataView");
            return mal_value_new_undefined();
        }
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "write buffer is detached or out of bounds");
            return mal_value_new_undefined();
        }
        usize offset = 0;
        length = span.length;
        has_position = false;
        position = 0;
        if (argc <= 2 || (argc == 3 && (mal_value_is_object(args[2])
                || mal_value_is_undefined(args[2])))) {
            MalValue options = argc == 3 ? args[2] : mal_value_new_undefined();
            if (!node_fs_read_options(vm, options, span.length,
                    &offset, &length, &has_position, &position)) {
                return mal_value_new_undefined();
            }
        } else if (!node_fs_non_negative_integer(vm,
                argc > 2 ? args[2] : mal_value_new_undefined(),
                "write offset is out of range", span.length, &offset)
            || !node_fs_non_negative_integer(vm,
                argc > 3 ? args[3] : mal_value_new_undefined(),
                "write length is out of range", span.length - offset, &length)
            || !node_fs_read_position(vm,
                argc > 4 ? args[4] : mal_value_new_undefined(),
                &has_position, &position)) {
            return mal_value_new_undefined();
        }
        bytes = span.data == nullptr ? (const byte *) "" : span.data + offset;
    }
    usize written;
    int err = mal_posix_fs_write_at_fd(
        fd, bytes, length, has_position, position, &written);
    free(owned);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "write", "");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) written);
}

static MalValue node_fs_close_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_close_fd(fd);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "close", nullptr, nullptr);
    return mal_value_new_undefined();
}

static MalValue node_fs_fsync_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_sync_fd(fd);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "fsync", nullptr, nullptr);
    return mal_value_new_undefined();
}

static bool node_fs_truncate_length(MalVm *vm, MalValue value, i64 *length) {
    if (mal_value_is_undefined(value)) {
        *length = 0;
        return true;
    }
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "ftruncate length must be a number");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number || number > 9007199254740991.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "ftruncate length must be an integer no greater than 2^53 - 1");
        return false;
    }
    *length = number < 0 ? 0 : (i64) number;
    return true;
}

static MalValue node_fs_ftruncate_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    i64 length;
    if (!node_fs_truncate_length(
            vm, argc > 1 ? args[1] : mal_value_new_undefined(), &length)) {
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_truncate_fd(fd, length);
    if (err != 0) node_fs_throw_errno_with_dest(vm, err, "ftruncate", nullptr, nullptr);
    return mal_value_new_undefined();
}

static bool node_fs_string_open_flags(MalString *value, u32 *flags) {
    if (mal_string_equals_ascii(value, "r")) {
        *flags = MAL_POSIX_OPEN_READ;
    } else if (mal_string_equals_ascii(value, "rs") ||
               mal_string_equals_ascii(value, "sr")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_SYNC;
    } else if (mal_string_equals_ascii(value, "r+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE;
    } else if (mal_string_equals_ascii(value, "rs+") ||
               mal_string_equals_ascii(value, "sr+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_SYNC;
    } else if (mal_string_equals_ascii(value, "w")) {
        *flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE;
    } else if (mal_string_equals_ascii(value, "wx") ||
               mal_string_equals_ascii(value, "xw")) {
        *flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE |
            MAL_POSIX_OPEN_TRUNCATE | MAL_POSIX_OPEN_EXCLUSIVE;
    } else if (mal_string_equals_ascii(value, "w+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE |
            MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE;
    } else if (mal_string_equals_ascii(value, "wx+") ||
               mal_string_equals_ascii(value, "xw+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE |
            MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE |
            MAL_POSIX_OPEN_EXCLUSIVE;
    } else if (mal_string_equals_ascii(value, "a")) {
        *flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND;
    } else if (mal_string_equals_ascii(value, "ax") ||
               mal_string_equals_ascii(value, "xa")) {
        *flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE |
            MAL_POSIX_OPEN_APPEND | MAL_POSIX_OPEN_EXCLUSIVE;
    } else if (mal_string_equals_ascii(value, "a+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE |
            MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND;
    } else if (mal_string_equals_ascii(value, "ax+") ||
               mal_string_equals_ascii(value, "xa+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE |
            MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND |
            MAL_POSIX_OPEN_EXCLUSIVE;
    } else if (mal_string_equals_ascii(value, "as") ||
               mal_string_equals_ascii(value, "sa")) {
        *flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE |
            MAL_POSIX_OPEN_APPEND | MAL_POSIX_OPEN_SYNC;
    } else if (mal_string_equals_ascii(value, "as+") ||
               mal_string_equals_ascii(value, "sa+")) {
        *flags = MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE |
            MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND | MAL_POSIX_OPEN_SYNC;
    } else {
        return false;
    }
    return true;
}

static bool node_fs_open_flags(
    MalVm *vm, MalValue value, u32 *flags, bool *native_flags) {
    if (mal_value_is_string(value)) {
        *native_flags = false;
        if (node_fs_string_open_flags(mal_value_to_string(value), flags)) return true;
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "open flags must be a supported string or integer");
        return false;
    }
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || number > INT_MAX || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "open flags must be a non-negative integer");
        return false;
    }
    *flags = (u32) number;
    *native_flags = true;
    return true;
}

static bool node_fs_open_mode(MalVm *vm, MalValue value, u32 *mode) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || number > 4294967295.0 || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "open mode must be a non-negative 32-bit integer");
        return false;
    }
    *mode = (u32) number;
    return true;
}

static MalValue node_fs_open_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    u32 flags;
    bool native_flags;
    if (!node_fs_open_flags(
            vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
            &flags, &native_flags)) {
        free(path);
        return mal_value_new_undefined();
    }
    u32 mode = 0666;
    if (argc >= 3 && !mal_value_is_undefined(args[2]) &&
        !node_fs_open_mode(vm, args[2], &mode)) {
        free(path);
        return mal_value_new_undefined();
    }
    int fd;
    int err = mal_posix_fs_open(path, flags, native_flags, mode, &fd);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "open", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return mal_value_from_f64((f64) fd);
}

static MalValue node_fs_stat_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    bool throw_if_no_entry = true;
    if (argc > 1 && mal_value_is_object(args[1])) {
        MalValue option;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "throwIfNoEntry"), &option)) {
            return mal_value_new_undefined();
        }
        throw_if_no_entry = !mal_value_is_boolean(option) || mal_value_is_truthy(option);
    }
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    MalPosixStat st;
    int err = mal_posix_fs_stat(path, &st);
    if (err != 0) {
        if (throw_if_no_entry || (err != ENOENT && err != ENOTDIR)) {
            node_fs_throw_errno(vm, err, "stat", path);
        }
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &st);
}

static MalValue node_fs_fstat_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) {
        return mal_value_new_undefined();
    }
    MalPosixStat st;
    int err = mal_posix_fs_fstat(fd, &st);
    if (err != 0) {
        node_fs_throw_errno_with_dest(vm, err, "fstat", nullptr, nullptr);
        return mal_value_new_undefined();
    }
    return node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &st);
}

static MalValue node_fs_lstat_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    bool throw_if_no_entry = true;
    if (argc > 1 && mal_value_is_object(args[1])) {
        MalValue option;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "throwIfNoEntry"), &option)) {
            return mal_value_new_undefined();
        }
        throw_if_no_entry = !mal_value_is_boolean(option) || mal_value_is_truthy(option);
    }
    char *path = node_fs_path_cstr(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalPosixStat st;
    int err = mal_posix_fs_lstat(path, &st);
    if (err != 0) {
        if (throw_if_no_entry || (err != ENOENT && err != ENOTDIR)) {
            node_fs_throw_errno(vm, err, "lstat", path);
        }
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
        if (!mal_value_is_string(value) && !mal_value_is_int32(value) && !mal_value_is_f64_or_nan(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "utimes time must be a finite number, string, or Date");
            return false;
        }
        if (!mal_vm_to_number(vm, value, &seconds_value)) return false;
        milliseconds = !mal_value_is_string(value) && seconds_value < 0
            ? mal_date_now_ms() : seconds_value * 1000.0;
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
    MalObject *dirent_proto = node_fs_slot_proto(vm, callee);
    MalValue held_array[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan array_rs;
    mal_gc_root(&array_rs, held_array, countof(held_array));
    held_array[0] = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) count));
    if (with_types) held_array[1] = node_fs_string_from_cstr(vm, path);
    free(path);
    MalValue array = held_array[0];
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
            mal_intrinsic_define_data(vm, dirent, (const byte *) "parentPath", held_array[1], NODE_FS_VISIBLE);
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
    MalValue encoding = mal_value_new_undefined();
    bool buffer = false;
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    if (!node_fs_readlink_options(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &encoding, &buffer)) {
        free(input);
        mal_gc_unroot(&encoding_root);
        return mal_value_new_undefined();
    }
    char *resolved;
    int err = mal_posix_fs_realpath(input, &resolved);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "realpath", input);
        free(input);
        mal_gc_unroot(&encoding_root);
        return mal_value_new_undefined();
    }
    MalValue result = buffer
        ? mal_node_buffer_from_owned_bytes(vm, (byte *) resolved, strlen(resolved))
        : mal_node_buffer_encode_bytes(vm, (const byte *) resolved, strlen(resolved), encoding, true);
    if (!buffer) free(resolved);
    free(input);
    mal_gc_unroot(&encoding_root);
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

typedef struct {
    bool recursive;
    bool force;
    i64 max_retries;
    i64 delay;
} NodeFsRmOptions;

static bool node_fs_rm_options(MalVm *vm, MalValue options, NodeFsRmOptions *out) {
    *out = (NodeFsRmOptions) {.delay = 100};
    if (mal_value_is_undefined(options)) return true;
    if (!mal_value_is_object(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "rm options must be an object");
        return false;
    }
    static const char *names[] = {"recursive", "force", "maxRetries", "retryDelay"};
    for (usize i = 0; i < countof(names); i++) {
        MalValue option;
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, names[i]), &option)) return false;
        if (mal_value_is_undefined(option)) continue;
        if (i < 2) {
            if (!mal_value_is_boolean(option)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "rm recursive and force options must be booleans");
                return false;
            }
            if (i == 0) out->recursive = mal_value_is_truthy(option);
            else out->force = mal_value_is_truthy(option);
        } else {
            if (!(mal_value_is_int32(option) || mal_value_is_f64_or_nan(option))) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "rm retry options must be numbers");
                return false;
            }
            f64 number = mal_ops_number_as_f64(option);
            if (!isfinite(number) || number < 0 || number > INT_MAX || floor(number) != number) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "rm retry options must be non-negative integers");
                return false;
            }
            if (i == 2) out->max_retries = (i64) number;
            else out->delay = (i64) number;
        }
    }
    return true;
}

static bool node_fs_rm_retryable(int err) {
    return err == EBUSY || err == EMFILE || err == ENFILE || err == ENOTEMPTY || err == EPERM;
}

static MalValue node_fs_rm_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    NodeFsRmOptions options;
    if (!node_fs_rm_options(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &options)) {
        return mal_value_new_undefined();
    }
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    int err;
    i64 retry = 0;
    for (;;) {
        err = mal_posix_fs_rm(path, options.recursive, options.force);
        if (!options.recursive || !node_fs_rm_retryable(err) || retry >= options.max_retries) break;
        mal_posix_fs_sleep_milliseconds(options.delay * ++retry);
    }
    if (err != 0) node_fs_throw_errno(vm, err, options.recursive ? "rm" : "unlink", path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_rmdir_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    int err = mal_posix_fs_rmdir(path);
    if (err != 0) node_fs_throw_errno(vm, err, "rmdir", path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue node_fs_make_fn(MalVm *, MalObject *, const char *, i32, MalNativeFunctionCallback);
static MalValue node_fs_make_fn_slot(MalVm *, MalObject *, const char *, i32, MalNativeFunctionCallback, MalValue);

enum {
    NODE_FS_GLOB_CWD,
    NODE_FS_GLOB_PATTERNS,
    NODE_FS_GLOB_EXCLUDE,
    NODE_FS_GLOB_WITH_TYPES,
    NODE_FS_GLOB_STACK,
    NODE_FS_GLOB_SEEN,
    NODE_FS_GLOB_DONE,
    NODE_FS_GLOB_DIRENT_PROTO,
    NODE_FS_GLOB_STATE_COUNT,
};

static MalValue node_fs_array_get(MalValue array, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(array), index, &value);
    return value;
}

static void node_fs_array_push(MalValue array, MalValue value) {
    MalArrayObject *object = mal_value_to_array_object(array);
    mal_array_object_store(object, mal_key_index(mal_array_object_length(object)), value);
}

static MalValue node_fs_glob_dirent(MalVm *vm, MalValue proto,
    const char *absolute, MalPosixFileType type) {
    const char *separator = strrchr(absolute, '/');
    MalValue roots[3] = {proto, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(proto)));
    roots[2] = node_fs_string_from_cstr(vm, separator == nullptr ? absolute : separator + 1);
    MalObject *dirent = mal_value_to_object(roots[1]);
    mal_intrinsic_define_data(vm, dirent, (const byte *) "name", roots[2], NODE_FS_VISIBLE);
    roots[2] = node_fs_string_from_utf8(vm, (const byte *) absolute,
        separator == nullptr ? 0 : separator == absolute ? 1 : (usize) (separator - absolute));
    mal_intrinsic_define_data(vm, dirent, (const byte *) "parentPath", roots[2], NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, dirent, (const byte *) NODE_FS_TYPE_KEY,
        mal_value_from_i32((i32) type), MAL_PROPERTY_NONE);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static bool node_fs_glob_matches(MalVm *vm, MalValue patterns, MalValue path, bool partial) {
    u32 length = mal_array_object_length(mal_value_to_array_object(patterns));
    for (u32 i = 0; i < length; i++) {
        MalValue pattern = node_fs_array_get(patterns, i);
        if (mal_node_path_glob_match(vm, mal_value_to_string(path),
                mal_value_to_string(pattern), partial)) return true;
        if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    }
    return false;
}

static bool node_fs_glob_follows_symlink(MalVm *vm, MalValue patterns, MalValue path) {
    MalString *candidate = mal_value_to_string(path);
    usize candidate_depth = 0;
    bool in_segment = false;
    for (usize i = 0; i < mal_string_length(candidate); i++) {
        if (mal_string_code_unit_at(candidate, i) == '/') in_segment = false;
        else if (!in_segment) { candidate_depth++; in_segment = true; }
    }
    u32 count = mal_array_object_length(mal_value_to_array_object(patterns));
    for (u32 i = 0; i < count; i++) {
        MalString *pattern = mal_value_to_string(node_fs_array_get(patterns, i));
        if (!mal_node_path_glob_match(vm, candidate, pattern, true)) continue;
        usize length = mal_string_length(pattern);
        usize segment = 0;
        usize depth = 0;
        bool recursive_before_link = false;
        for (usize n = 0; n <= length; n++) {
            if (n == length || mal_string_code_unit_at(pattern, n) == '/') {
                if (n - segment == 2 && mal_string_code_unit_at(pattern, segment) == '*'
                    && mal_string_code_unit_at(pattern, segment + 1) == '*' && depth < candidate_depth) {
                    recursive_before_link = true;
                    break;
                }
                if (n > segment) depth++;
                segment = n + 1;
            }
        }
        if (!recursive_before_link) return true;
    }
    return false;
}

static MalValue node_fs_glob_step(MalVm *vm, MalValue state) {
    MalValue roots[6] = {state, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue stack = node_fs_array_get(state, NODE_FS_GLOB_STACK);
    MalValue patterns = node_fs_array_get(state, NODE_FS_GLOB_PATTERNS);
    MalValue exclude = node_fs_array_get(state, NODE_FS_GLOB_EXCLUDE);
    bool with_types = mal_value_is_truthy(node_fs_array_get(state, NODE_FS_GLOB_WITH_TYPES));
    MalValue value = mal_value_new_undefined();
    bool done = mal_value_is_truthy(node_fs_array_get(state, NODE_FS_GLOB_DONE));
    while (!done && mal_array_object_length(mal_value_to_array_object(stack)) > 0) {
        value = mal_value_new_undefined();
        MalArrayObject *pending = mal_value_to_array_object(stack);
        u32 length = mal_array_object_length(pending);
        roots[1] = node_fs_array_get(stack, length - 1);
        mal_array_object_set_length(pending, length - 1);
        MalKey key = mal_key_from_value(roots[1]);
        MalObject *seen = mal_value_to_object(node_fs_array_get(state, NODE_FS_GLOB_SEEN));
        MalPropertyLookup seen_entry = mal_object_get_own(seen, key);
        if (seen_entry.present) continue;
        mal_object_set(seen, key, mal_value_new_boolean(true));
        char *relative = node_fs_path_cstr(vm, roots[1]);
        char *cwd = node_fs_path_cstr(vm, node_fs_array_get(state, NODE_FS_GLOB_CWD));
        if (relative == nullptr || cwd == nullptr) { free(relative); free(cwd); break; }
        usize capacity = strlen(cwd) + strlen(relative) + 2;
        char *absolute = malloc(capacity);
        if (absolute == nullptr) {
            free(relative); free(cwd); mal_vm_throw_allocation_error(vm); break;
        }
        if (relative[0] == '/') snprintf(absolute, capacity, "%s", relative);
        else if (strcmp(relative, ".") == 0) snprintf(absolute, capacity, "%s", cwd);
        else snprintf(absolute, capacity, "%s/%s", cwd, relative);
        free(cwd);
        MalPosixStat st;
        int err = mal_posix_fs_lstat(absolute, &st);
        if (err != 0) {
            if (err != ENOENT && err != ENOTDIR) node_fs_throw_errno(vm, err, "lstat", absolute);
            free(absolute); free(relative);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            continue;
        }
        roots[2] = mal_value_new_undefined();
        if (with_types && mal_value_is_callable(exclude)) {
            roots[2] = node_fs_glob_dirent(vm,
                node_fs_array_get(state, NODE_FS_GLOB_DIRENT_PROTO), absolute, st.type);
        }
        bool excluded = false;
        if (mal_value_is_array_object(exclude)) {
            excluded = node_fs_glob_matches(vm, exclude, roots[1], false);
            for (usize n = strlen(relative); !excluded && n > 0; n--) {
                if (relative[n - 1] != '/' || n == 1) continue;
                relative[n - 1] = 0;
                roots[3] = node_fs_string_from_cstr(vm, relative);
                relative[n - 1] = '/';
                MalPropertyLookup parent_seen = mal_object_get_own(seen, mal_key_from_value(roots[3]));
                if (parent_seen.present) break;
                excluded = node_fs_glob_matches(vm, exclude, roots[3], false);
                if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            }
        } else if (mal_value_is_callable(exclude)) {
            MalValue argument = with_types ? roots[2] : roots[1];
            MalCompletion completion = mal_vm_call_value(vm, exclude,
                mal_value_new_undefined(), &argument, 1);
            if (completion.kind == MAL_COMPLETION_THROW) {
                free(absolute); free(relative); break;
            }
            excluded = mal_value_is_truthy(completion.value);
        }
        if (excluded || vm->completion.kind == MAL_COMPLETION_THROW) {
            free(absolute); free(relative);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            continue;
        }
        bool is_directory = st.type == MAL_POSIX_FT_DIR;
        if (st.type == MAL_POSIX_FT_SYMLINK && node_fs_glob_follows_symlink(vm, patterns, roots[1])) {
            MalPosixStat followed;
            if (mal_posix_fs_stat(absolute, &followed) == 0) is_directory = followed.type == MAL_POSIX_FT_DIR;
        }
        bool root_directory = strcmp(relative, ".") == 0;
        bool matched = node_fs_glob_matches(vm, patterns, roots[1], false);
        if (root_directory) {
            u32 pattern_count = mal_array_object_length(mal_value_to_array_object(patterns));
            for (u32 i = 0; i < pattern_count; i++) {
                MalString *pattern = mal_value_to_string(node_fs_array_get(patterns, i));
                if (mal_string_equals_ascii(pattern, "**") || mal_string_equals_ascii(pattern, "**/")) matched = true;
            }
        }
        if (is_directory) {
            usize relative_length = strlen(relative);
            char *with_separator = malloc(relative_length + 2);
            if (with_separator == nullptr) { mal_vm_throw_allocation_error(vm); }
            else {
                memcpy(with_separator, relative, relative_length);
                with_separator[relative_length] = '/'; with_separator[relative_length + 1] = 0;
                roots[3] = node_fs_string_from_cstr(vm, with_separator);
                free(with_separator);
                matched = matched || node_fs_glob_matches(vm, patterns, roots[3], false);
            }
        }
        bool descend = is_directory
            && (root_directory || node_fs_glob_matches(vm, patterns, roots[1], true));
        if (descend && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalPosixDirent *entries;
            usize count;
            err = mal_posix_fs_readdir(absolute, &entries, &count);
            if (err != 0 && err != ENOENT && err != ENOTDIR) {
                node_fs_throw_errno(vm, err, "scandir", absolute);
            } else if (err == 0) {
                for (usize i = count; i > 0; i--) {
                    const char *name = entries[i - 1].name;
                    usize child_capacity = strlen(relative) + strlen(name) + 2;
                    char *child = malloc(child_capacity);
                    if (child == nullptr) { mal_vm_throw_allocation_error(vm); break; }
                    if (strcmp(relative, ".") == 0) snprintf(child, child_capacity, "%s", name);
                    else snprintf(child, child_capacity, "%s/%s", relative, name);
                    roots[4] = node_fs_string_from_cstr(vm, child);
                    free(child);
                    node_fs_array_push(stack, roots[4]);
                }
                mal_posix_fs_free_dirents(entries, count);
            }
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) { free(absolute); free(relative); break; }
        if (matched) {
            if (with_types && mal_value_is_undefined(roots[2])) {
                roots[2] = node_fs_glob_dirent(vm,
                    node_fs_array_get(state, NODE_FS_GLOB_DIRENT_PROTO), absolute, st.type);
            }
            free(absolute); free(relative);
            roots[5] = with_types ? roots[2] : roots[1];
            value = roots[5];
            break;
        }
        free(absolute); free(relative);
        value = mal_value_new_undefined();
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    done = mal_value_is_undefined(value);
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[5]), (const byte *) "value", value, NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[5]), (const byte *) "done",
        mal_value_new_boolean(done), NODE_FS_VISIBLE);
    if (done) {
        mal_array_object_store(mal_value_to_array_object(state), mal_key_index(NODE_FS_GLOB_DONE), mal_value_new_boolean(true));
        mal_array_object_store(mal_value_to_array_object(state), mal_key_index(NODE_FS_GLOB_SEEN), mal_value_new_undefined());
    }
    MalValue result = roots[5];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_glob_next(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue roots[2] = {state, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalValue result = node_fs_glob_step(vm, state);
    MalPromiseObject *promise = mal_value_to_promise_object(roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        result = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_array_object_set_length(mal_value_to_array_object(node_fs_array_get(state, NODE_FS_GLOB_STACK)), 0);
        mal_promise_reject(vm, promise, result);
    } else mal_promise_fulfill(vm, promise, result);
    MalValue promise_value = roots[1];
    mal_gc_unroot(&root);
    return promise_value;
}

static MalValue node_fs_glob_return(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    mal_array_object_store(mal_value_to_array_object(state), mal_key_index(NODE_FS_GLOB_DONE), mal_value_new_boolean(true));
    mal_array_object_set_length(mal_value_to_array_object(node_fs_array_get(state, NODE_FS_GLOB_STACK)), 0);
    return node_fs_glob_next(vm, self, args, argc, nt, callee);
}

static MalValue node_fs_glob_iterator(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) nt; (void) callee;
    return self;
}

static bool node_fs_glob_patterns(MalVm *vm, MalValue input, MalValue *output) {
    if (mal_value_is_string(input)) {
        *output = mal_value_from_array_object(mal_intrinsic_new_array(vm, 1));
        mal_array_object_store(mal_value_to_array_object(*output), mal_key_index(0), input);
        return true;
    }
    if (mal_value_is_array_object(input)) {
        u32 length = mal_array_object_length(mal_value_to_array_object(input));
        *output = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
        for (u32 i = 0; i < length; i++) {
            MalValue pattern;
            if (!mal_vm_get_property(vm, input, mal_key_index(i), &pattern)) return false;
            if (!mal_value_is_string(pattern)) break;
            node_fs_array_push(*output, pattern);
        }
        if (mal_array_object_length(mal_value_to_array_object(*output)) == length) return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Glob patterns must be strings");
    return false;
}

static MalValue node_fs_glob(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[7];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_array_object(mal_intrinsic_new_array(vm, NODE_FS_GLOB_STATE_COUNT));
    roots[1] = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!node_fs_glob_patterns(vm, roots[1], &roots[2])) goto failed;
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_PATTERNS), roots[2]);
    roots[3] = node_fs_string_from_cstr(vm, ".");
    roots[4] = mal_value_new_undefined();
    roots[5] = mal_value_new_boolean(false);
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        if (!mal_value_is_object(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Glob options must be an object");
            goto failed;
        }
        if (!mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, "cwd"), &roots[6])) goto failed;
        if (!mal_value_is_undefined(roots[6])) {
            char *cwd = node_fs_path_cstr(vm, roots[6]);
            if (cwd == nullptr) goto failed;
            roots[3] = node_fs_string_from_cstr(vm, cwd);
            free(cwd);
        }
        if (!mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, "exclude"), &roots[4])
            || !mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, "withFileTypes"), &roots[5])) goto failed;
        if (!mal_value_is_undefined(roots[4]) && !mal_value_is_callable(roots[4])) {
            if (!mal_value_is_array_object(roots[4])) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Glob exclude must be a function or string array");
                goto failed;
            }
            roots[6] = roots[4];
            if (!node_fs_glob_patterns(vm, roots[6], &roots[4])) goto failed;
        }
    }
    roots[3] = mal_node_path_resolve_path(vm, roots[3]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_CWD), roots[3]);
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_EXCLUDE), roots[4]);
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_WITH_TYPES), roots[5]);
    roots[3] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_STACK), roots[3]);
    u32 length = mal_array_object_length(mal_value_to_array_object(roots[2]));
    for (u32 i = length; i > 0; i--) {
        char *pattern = node_fs_path_cstr(vm, node_fs_array_get(roots[2], i - 1));
        if (pattern == nullptr) goto failed;
        usize literal = 0;
        usize separator = 0;
        for (; pattern[literal] != 0; literal++) {
            char c = pattern[literal];
            if (c == '*' || c == '?' || c == '[' || c == '{' || ((c == '@' || c == '+' || c == '!') && pattern[literal + 1] == '(')) break;
            if (c == '/') separator = literal;
        }
        if (pattern[literal] != 0) {
            if (separator == 0 && pattern[0] == '/') pattern[1] = 0;
            else pattern[separator] = 0;
        }
        usize seed_length = strlen(pattern);
        while (seed_length > 1 && pattern[seed_length - 1] == '/') pattern[--seed_length] = 0;
        roots[4] = node_fs_string_from_cstr(vm, seed_length == 0 ? "." : pattern);
        free(pattern);
        node_fs_array_push(roots[3], roots[4]);
    }
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_SEEN), roots[3]);
    MalValue dirent_proto = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_DIRENT_PROTO), dirent_proto);
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE])));
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    roots[2] = node_fs_make_fn_slot(vm, fn_proto, "next", 0, node_fs_glob_next, roots[0]);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "next", roots[2], NODE_FS_VISIBLE);
    roots[2] = node_fs_make_fn_slot(vm, fn_proto, "return", 0, node_fs_glob_return, roots[0]);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "return", roots[2], NODE_FS_VISIBLE);
    roots[2] = node_fs_make_fn(vm, fn_proto, "[Symbol.asyncIterator]", 0, node_fs_glob_iterator);
    MalPropertyDesc descriptor = mal_intrinsic_data_desc(roots[2], NODE_FS_VISIBLE);
    mal_object_define_own(mal_value_to_object(roots[1]), mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &descriptor);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
failed:
    mal_gc_unroot(&root);
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
    NODE_FS_RM_PROMISE,
    NODE_FS_RM_PATH,
    NODE_FS_RM_RECURSIVE,
    NODE_FS_RM_FORCE,
    NODE_FS_RM_RETRIES,
    NODE_FS_RM_DELAY,
    NODE_FS_RM_ATTEMPT,
    NODE_FS_RM_SLOT_COUNT,
};

static MalValue node_fs_rm_task(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[NODE_FS_RM_SLOT_COUNT];
    for (i32 i = 0; i < NODE_FS_RM_SLOT_COUNT; i++) roots[i] = mal_native_function_object_get_slot(task, i);
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *path = node_fs_path_cstr(vm, roots[NODE_FS_RM_PATH]);
    bool recursive = mal_value_is_truthy(roots[NODE_FS_RM_RECURSIVE]);
    int err = path == nullptr ? EINVAL : mal_posix_fs_rm(path, recursive, mal_value_is_truthy(roots[NODE_FS_RM_FORCE]));
    i64 attempt = (i64) mal_ops_number_as_f64(roots[NODE_FS_RM_ATTEMPT]);
    i64 retries = (i64) mal_ops_number_as_f64(roots[NODE_FS_RM_RETRIES]);
    if (path != nullptr && recursive && node_fs_rm_retryable(err) && attempt < retries) {
        mal_native_function_object_set_slot(task, NODE_FS_RM_ATTEMPT, mal_value_from_f64((f64) (attempt + 1)));
        i64 delay = (i64) mal_ops_number_as_f64(roots[NODE_FS_RM_DELAY]);
        mal_host_set_timeout(vm, callee, delay * (attempt + 1), nullptr, 0);
        free(path);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (path != nullptr && err != 0) node_fs_throw_errno(vm, err, recursive ? "rm" : "unlink", path);
    free(path);
    MalPromiseObject *promise = mal_value_to_promise_object(roots[NODE_FS_RM_PROMISE]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_RM_PATH] = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, promise, roots[NODE_FS_RM_PATH]);
    } else mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_rm_promise(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[NODE_FS_RM_SLOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[NODE_FS_RM_PROMISE] = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    roots[NODE_FS_RM_PATH] = argc > 0 ? args[0] : mal_value_new_undefined();
    NodeFsRmOptions options;
    bool valid = node_fs_rm_options(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &options);
    char *path = valid ? node_fs_path_cstr(vm, roots[NODE_FS_RM_PATH]) : nullptr;
    free(path);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_RM_PATH] = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(roots[NODE_FS_RM_PROMISE]), roots[NODE_FS_RM_PATH]);
    } else {
        roots[NODE_FS_RM_RECURSIVE] = mal_value_new_boolean(options.recursive);
        roots[NODE_FS_RM_FORCE] = mal_value_new_boolean(options.force);
        roots[NODE_FS_RM_RETRIES] = mal_value_from_f64((f64) options.max_retries);
        roots[NODE_FS_RM_DELAY] = mal_value_from_f64((f64) options.delay);
        roots[NODE_FS_RM_ATTEMPT] = mal_value_from_i32(0);
        MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), 0, node_fs_rm_task, roots, countof(roots)));
        mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    MalValue promise = roots[NODE_FS_RM_PROMISE];
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_errno_value(
    MalVm *vm, int error, const char *syscall, const char *path);

typedef struct NodeFsWriteJob {
    char *path;
    byte *bytes;
    usize length;
    int fd;
    u32 flags;
    u32 mode;
    bool native_flags;
    bool close_fd;
    bool flush;
    int error;
    const char *syscall;
} NodeFsWriteJob;

typedef struct NodeFsAsyncWrite {
    struct NodeFsAsyncWrite *next;
    MalVm *vm;
    MalHostHandle operation;
    MalValue promise;
#if MAL_REALMS
    MalRealm *realm;
#endif
} NodeFsAsyncWrite;

static NodeFsAsyncWrite *node_fs_async_writes;
static bool node_fs_async_installed;

static void node_fs_write_job_free(void *data) {
    NodeFsWriteJob *job = data;
    free(job->path);
    free(job->bytes);
    free(job);
}

static void node_fs_write_job_run(void *data) {
    NodeFsWriteJob *job = data;
    job->syscall = "open";
    if (job->close_fd) {
        job->error = mal_posix_fs_open(job->path, job->flags,
            job->native_flags, job->mode, &job->fd);
        if (job->error != 0) return;
    }
    job->syscall = "write";
    usize written;
    job->error = mal_posix_fs_write_fd(job->fd, job->bytes, job->length, &written);
    if (job->error == 0 && job->flush) {
        job->syscall = "fsync";
        job->error = mal_posix_fs_sync_fd(job->fd);
    }
    int close_error = job->close_fd ? mal_posix_fs_close_fd(job->fd) : 0;
    if (job->error == 0 && close_error != 0) {
        job->syscall = "close";
        job->error = close_error;
    }
}

static void node_fs_async_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (NodeFsAsyncWrite *state = node_fs_async_writes;
        state != nullptr; state = state->next) {
        if (state->vm == vm) mal_gc_mark_value(state->promise);
    }
}

static void node_fs_async_free(MalVm *vm) {
    NodeFsAsyncWrite **link = &node_fs_async_writes;
    while (*link != nullptr) {
        NodeFsAsyncWrite *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        *link = state->next;
        free(state);
    }
}

static bool node_fs_async_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    NodeFsAsyncWrite **link = &node_fs_async_writes;
    while (*link != nullptr &&
        ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    NodeFsAsyncWrite *state = *link;
    if (state == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    NodeFsWriteJob *job = task.data;
    MalPromiseObject *promise = mal_value_to_promise_object(state->promise);
    if (task.result == MAL_HOST_TERMINAL_CANCELLED) {
        MalValue error = node_fs_errno_value(vm, ECANCELED, "write", nullptr);
        mal_promise_reject(vm, promise, error);
    } else if (job->error != 0) {
        MalValue error = node_fs_errno_value(vm, job->error, job->syscall,
            strcmp(job->syscall, "close") == 0 ? nullptr : job->path);
        mal_promise_reject(vm, promise, error);
    } else {
        mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    }
    *link = state->next;
    free(state);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static void node_fs_queue_write(
    MalVm *vm, MalValue promise_value, const MalValue *args, i32 argc, u32 flags) {
    NodeFsWriteJob *job = calloc(1, sizeof(*job));
    NodeFsAsyncWrite *state = calloc(1, sizeof(*state));
    if (job == nullptr || state == nullptr) {
        free(job);
        free(state);
        mal_vm_throw_allocation_error(vm);
        goto reject;
    }
    MalValue file = argc > 0 ? args[0] : mal_value_new_undefined();
    job->close_fd = !mal_ops_is_number(file);
    if (job->close_fd) {
        job->path = node_fs_path_cstr(vm, file);
        if (job->path == nullptr) goto failed;
    } else if (!node_fs_fd(vm, file, &job->fd)) goto failed;
    MalValue encoding = mal_value_new_undefined();
    MalRootSpan encoding_root;
    mal_gc_root(&encoding_root, &encoding, 1);
    bool valid = node_fs_write_file_options(vm,
        argc > 2 ? args[2] : mal_value_new_undefined(), !job->close_fd,
        flags, &job->flags, &job->native_flags, &job->mode, &encoding, &job->flush);
    const byte *bytes;
    byte *owned = nullptr;
    if (valid) valid = node_fs_write_bytes(vm,
        argc > 1 ? args[1] : mal_value_new_undefined(), encoding,
        &bytes, &job->length, &owned);
    mal_gc_unroot(&encoding_root);
    if (!valid) goto failed;
    job->bytes = owned;
    if (owned == nullptr && job->length > 0) {
        // Workers cannot retain borrowed pointers into detachable or resizable VM buffers.
        job->bytes = malloc(job->length);
        if (job->bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto failed;
        }
        memcpy(job->bytes, bytes, job->length);
    }
    state->vm = vm;
    state->promise = promise_value;
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    if (!mal_blocking_work_start(mal_host(vm), node_fs_write_job_run, job,
            node_fs_write_job_free, &state->operation)) {
        node_fs_throw_errno(vm, EAGAIN, "write", job->path);
        goto failed;
    }
    state->next = node_fs_async_writes;
    node_fs_async_writes = state;
    return;
failed:
    node_fs_write_job_free(job);
    free(state);
reject:
    {
        MalValue error = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(promise_value), error);
    }
}

enum {
    NODE_FS_PROMISE_TASK_PROMISE,
    NODE_FS_PROMISE_TASK_OPERATION,
    NODE_FS_PROMISE_TASK_ARG0,
    NODE_FS_PROMISE_TASK_ARG1,
    NODE_FS_PROMISE_TASK_ARG2,
    NODE_FS_PROMISE_TASK_ARGC,
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
    i32 operation_argc = (i32) mal_ops_number_as_f64(
        roots[NODE_FS_PROMISE_TASK_ARGC]);
    MalCompletion completion = mal_vm_call_value(
        vm, roots[NODE_FS_PROMISE_TASK_OPERATION], mal_value_new_undefined(),
        roots + NODE_FS_PROMISE_TASK_ARG0, operation_argc);
    MalPromiseObject *promise = mal_value_to_promise_object(
        roots[NODE_FS_PROMISE_TASK_PROMISE]);
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_PROMISE_TASK_ARG0] = completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, promise, roots[NODE_FS_PROMISE_TASK_ARG0]);
    } else {
        roots[NODE_FS_PROMISE_TASK_ARG0] = completion.value;
        mal_promise_fulfill(vm, promise, roots[NODE_FS_PROMISE_TASK_ARG0]);
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
        argc >= 3 ? args[2] : mal_value_new_undefined(),
        mal_value_from_i32(argc < 3 ? argc : 3),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue operation = roots[NODE_FS_PROMISE_TASK_OPERATION];
    if (mal_value_is_native_function_object(operation)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(operation));
        if (callback == node_fs_write_file_sync || callback == node_fs_append_file_sync) {
            node_fs_queue_write(vm, roots[NODE_FS_PROMISE_TASK_PROMISE],
                roots + NODE_FS_PROMISE_TASK_ARG0, argc < 3 ? argc : 3,
                callback == node_fs_append_file_sync
                    ? MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND
                    : MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE);
            MalValue promise = roots[NODE_FS_PROMISE_TASK_PROMISE];
            mal_gc_unroot(&root);
            return promise;
        }
    }
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
    i32 operation_argc = (i32) mal_ops_number_as_f64(
        roots[NODE_FS_PROMISE_TASK_ARGC]);
    MalCompletion completion = mal_vm_call_value(
        vm, roots[NODE_FS_PROMISE_TASK_OPERATION], mal_value_new_undefined(),
        roots + NODE_FS_PROMISE_TASK_ARG0, operation_argc);
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_PROMISE_TASK_ARG0] = completion.value;
        node_fs_clear_completion(vm);
        mal_vm_call_value(vm, roots[NODE_FS_PROMISE_TASK_PROMISE],
            mal_value_new_undefined(), roots + NODE_FS_PROMISE_TASK_ARG0, 1);
    } else {
        roots[NODE_FS_PROMISE_TASK_ARG0] = mal_value_new_null();
        roots[NODE_FS_PROMISE_TASK_ARG1] = completion.value;
        mal_vm_call_value(vm, roots[NODE_FS_PROMISE_TASK_PROMISE],
            mal_value_new_undefined(), roots + NODE_FS_PROMISE_TASK_ARG0,
            mal_value_is_undefined(completion.value) ? 1 : 2);
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
            (const byte *) "filesystem callback must be a function");
        return mal_value_new_undefined();
    }
    MalValue roots[NODE_FS_PROMISE_TASK_SLOT_COUNT] = {
        args[callback_index],
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        args[0],
        callback_index > 1 ? args[1] : mal_value_new_undefined(),
        callback_index > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_from_i32(callback_index < 3 ? callback_index : 3),
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
        || !node_fs_write_bytes(vm, roots[2], mal_value_new_undefined(),
            &bytes, &length, &owned)) {
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

/* ---------------------------------------------------------------------------
 * node:fs/promises FileHandle.
 * --------------------------------------------------------------------------- */

typedef enum NodeFsFileHandleOperation {
    NODE_FS_FILE_HANDLE_APPEND_FILE,
    NODE_FS_FILE_HANDLE_CLOSE,
    NODE_FS_FILE_HANDLE_DATASYNC,
    NODE_FS_FILE_HANDLE_READ,
    NODE_FS_FILE_HANDLE_READ_FILE,
    NODE_FS_FILE_HANDLE_STAT,
    NODE_FS_FILE_HANDLE_SYNC,
    NODE_FS_FILE_HANDLE_TRUNCATE,
    NODE_FS_FILE_HANDLE_WRITE,
    NODE_FS_FILE_HANDLE_WRITE_FILE,
} NodeFsFileHandleOperation;

enum {
    NODE_FS_FILE_HANDLE_TASK_PROMISE,
    NODE_FS_FILE_HANDLE_TASK_RECEIVER,
    NODE_FS_FILE_HANDLE_TASK_FUNCTION,
    NODE_FS_FILE_HANDLE_TASK_OPERATION,
    NODE_FS_FILE_HANDLE_TASK_ARG0,
    NODE_FS_FILE_HANDLE_TASK_ARG1,
    NODE_FS_FILE_HANDLE_TASK_ARG2,
    NODE_FS_FILE_HANDLE_TASK_ARG3,
    NODE_FS_FILE_HANDLE_TASK_ARGC,
    NODE_FS_FILE_HANDLE_TASK_SLOT_COUNT,
};

static bool node_fs_is_file_handle(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT);
}

static MalNodeFsFileHandleObject *node_fs_file_handle(MalValue value) {
    return (MalNodeFsFileHandleObject *) mal_value_to_heap(value);
}

static void node_fs_file_handle_finalize(MalHeapHeader *cell) {
    MalNodeFsFileHandleObject *handle = (MalNodeFsFileHandleObject *) cell;
    if (handle->fd >= 0) {
        (void) mal_posix_fs_close_fd(handle->fd);
        handle->fd = -1;
    }
}

static const char *node_fs_file_handle_syscall(NodeFsFileHandleOperation operation) {
    switch (operation) {
        case NODE_FS_FILE_HANDLE_CLOSE: return "close";
        case NODE_FS_FILE_HANDLE_DATASYNC: return "fdatasync";
        case NODE_FS_FILE_HANDLE_STAT: return "fstat";
        case NODE_FS_FILE_HANDLE_SYNC: return "fsync";
        case NODE_FS_FILE_HANDLE_TRUNCATE: return "ftruncate";
        case NODE_FS_FILE_HANDLE_READ:
        case NODE_FS_FILE_HANDLE_READ_FILE:
            return "read";
        case NODE_FS_FILE_HANDLE_APPEND_FILE:
        case NODE_FS_FILE_HANDLE_WRITE:
        case NODE_FS_FILE_HANDLE_WRITE_FILE:
            return "write";
    }
    return "filehandle";
}

static MalValue node_fs_file_handle_result(
    MalVm *vm, NodeFsFileHandleOperation operation, MalValue count,
    MalValue buffer) {
    if (operation != NODE_FS_FILE_HANDLE_READ
        && operation != NODE_FS_FILE_HANDLE_WRITE) {
        return count;
    }
    MalValue result = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalValue roots[] = {result, count, buffer};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
        (const byte *) (operation == NODE_FS_FILE_HANDLE_READ
            ? "bytesRead" : "bytesWritten"), roots[1], NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
        (const byte *) "buffer", roots[2], NODE_FS_VISIBLE);
    result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_file_handle_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[NODE_FS_FILE_HANDLE_TASK_SLOT_COUNT];
    for (i32 i = 0; i < NODE_FS_FILE_HANDLE_TASK_SLOT_COUNT; i++) {
        roots[i] = mal_native_function_object_get_slot(task, i);
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPromiseObject *promise = mal_value_to_promise_object(
        roots[NODE_FS_FILE_HANDLE_TASK_PROMISE]);
    NodeFsFileHandleOperation operation = (NodeFsFileHandleOperation)
        mal_ops_number_as_f64(roots[NODE_FS_FILE_HANDLE_TASK_OPERATION]);
    MalCompletion completion = {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    MalNodeFsFileHandleObject *handle = nullptr;
    if (!node_fs_is_file_handle(roots[NODE_FS_FILE_HANDLE_TASK_RECEIVER])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "FileHandle method called on incompatible receiver");
        completion = vm->completion;
    } else {
        handle = node_fs_file_handle(roots[NODE_FS_FILE_HANDLE_TASK_RECEIVER]);
        if (operation == NODE_FS_FILE_HANDLE_CLOSE && handle->fd < 0) {
            completion.value = mal_value_new_undefined();
        } else if (handle->fd < 0) {
            node_fs_throw_errno_with_dest(vm, EBADF,
                node_fs_file_handle_syscall(operation), nullptr, nullptr);
            completion = vm->completion;
        } else if (operation == NODE_FS_FILE_HANDLE_DATASYNC) {
            int err = mal_posix_fs_datasync_fd(handle->fd);
            if (err != 0) {
                node_fs_throw_errno_with_dest(
                    vm, err, "fdatasync", nullptr, nullptr);
                completion = vm->completion;
            }
        } else {
            MalValue operation_args[5] = {
                mal_value_from_i32(handle->fd),
                roots[NODE_FS_FILE_HANDLE_TASK_ARG0],
                roots[NODE_FS_FILE_HANDLE_TASK_ARG1],
                roots[NODE_FS_FILE_HANDLE_TASK_ARG2],
                roots[NODE_FS_FILE_HANDLE_TASK_ARG3],
            };
            i32 operation_argc = 1 + (i32) mal_ops_number_as_f64(
                roots[NODE_FS_FILE_HANDLE_TASK_ARGC]);
            completion = mal_vm_call_value(vm,
                roots[NODE_FS_FILE_HANDLE_TASK_FUNCTION],
                mal_value_new_undefined(), operation_args, operation_argc);
        }
    }
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_FILE_HANDLE_TASK_ARG0] = completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, promise, roots[NODE_FS_FILE_HANDLE_TASK_ARG0]);
    } else {
        if (operation == NODE_FS_FILE_HANDLE_CLOSE && handle != nullptr) {
            handle->fd = -1;
        }
        roots[NODE_FS_FILE_HANDLE_TASK_ARG1] = node_fs_file_handle_result(
            vm, operation, completion.value,
            roots[NODE_FS_FILE_HANDLE_TASK_ARG0]);
        mal_promise_fulfill(vm, promise, roots[NODE_FS_FILE_HANDLE_TASK_ARG1]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_file_handle_operation(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) nt;
    MalNativeFunctionObject *method = mal_value_to_native_function_object(callee);
    MalValue bound = mal_native_function_object_get_slot(method, 2);
    MalValue roots[NODE_FS_FILE_HANDLE_TASK_SLOT_COUNT] = {
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        node_fs_is_file_handle(bound) ? bound : self,
        mal_native_function_object_get_slot(method, 0),
        mal_native_function_object_get_slot(method, 1),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 2 ? args[2] : mal_value_new_undefined(),
        argc > 3 ? args[3] : mal_value_new_undefined(),
        mal_value_from_i32(argc < 4 ? argc : 4),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue task_value = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "fileHandleOperation"),
            node_fs_file_handle_task, roots, countof(roots)));
    mal_vm_enqueue_reaction_job(vm, task_value, false,
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    MalValue promise_value = roots[NODE_FS_FILE_HANDLE_TASK_PROMISE];
    mal_gc_unroot(&root);
    return promise_value;
}

static MalValue node_fs_file_handle_fd_getter(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (!node_fs_is_file_handle(self)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "FileHandle fd getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32(node_fs_file_handle(self)->fd);
}

enum {
    NODE_FS_OPEN_TASK_PROMISE,
    NODE_FS_OPEN_TASK_OPEN_SYNC,
    NODE_FS_OPEN_TASK_PROTOTYPE,
    NODE_FS_OPEN_TASK_CLOSE_SYNC,
    NODE_FS_OPEN_TASK_PATH,
    NODE_FS_OPEN_TASK_FLAGS,
    NODE_FS_OPEN_TASK_MODE,
    NODE_FS_OPEN_TASK_ARGC,
    NODE_FS_OPEN_TASK_RESULT,
    NODE_FS_OPEN_TASK_SLOT_COUNT,
};

static MalValue node_fs_open_promise_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[NODE_FS_OPEN_TASK_SLOT_COUNT];
    for (i32 i = 0; i < NODE_FS_OPEN_TASK_SLOT_COUNT; i++) {
        roots[i] = mal_native_function_object_get_slot(task, i);
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue open_args[] = {
        roots[NODE_FS_OPEN_TASK_PATH],
        roots[NODE_FS_OPEN_TASK_FLAGS],
        roots[NODE_FS_OPEN_TASK_MODE],
    };
    i32 open_argc = (i32) mal_ops_number_as_f64(
        roots[NODE_FS_OPEN_TASK_ARGC]);
    MalCompletion completion = mal_vm_call_value(vm,
        roots[NODE_FS_OPEN_TASK_OPEN_SYNC], mal_value_new_undefined(),
        open_args, open_argc);
    MalPromiseObject *promise = mal_value_to_promise_object(
        roots[NODE_FS_OPEN_TASK_PROMISE]);
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[NODE_FS_OPEN_TASK_RESULT] = completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, promise, roots[NODE_FS_OPEN_TASK_RESULT]);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }

    MalNodeFsFileHandleObject *handle = mal_heap_alloc(
        &vm->heap, sizeof(MalNodeFsFileHandleObject),
        MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT);
    mal_object_init(&vm->heap, &handle->object,
        MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT,
        mal_value_to_object(roots[NODE_FS_OPEN_TASK_PROTOTYPE]));
    handle->fd = (int) mal_ops_number_as_f64(completion.value);
    roots[NODE_FS_OPEN_TASK_RESULT] =
        mal_value_from_heap((MalHeapHeader *) handle);

    MalValue close_slots[] = {
        roots[NODE_FS_OPEN_TASK_CLOSE_SYNC],
        mal_value_from_i32(NODE_FS_FILE_HANDLE_CLOSE),
        roots[NODE_FS_OPEN_TASK_RESULT],
    };
    MalValue close = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "close"), 0,
            node_fs_file_handle_operation, close_slots, countof(close_slots)));
    MalRootSpan close_root;
    mal_gc_root(&close_root, &close, 1);
    mal_intrinsic_define_data(vm, &handle->object,
        (const byte *) "close", close, NODE_FS_VISIBLE);
    mal_gc_unroot(&close_root);
    mal_promise_fulfill(vm, promise, roots[NODE_FS_OPEN_TASK_RESULT]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_open_promise(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *open = mal_value_to_native_function_object(callee);
    MalValue flags = argc > 1 && !mal_value_is_undefined(args[1])
        ? args[1]
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "r"));
    MalValue roots[NODE_FS_OPEN_TASK_SLOT_COUNT] = {
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        mal_native_function_object_get_slot(open, 0),
        mal_native_function_object_get_slot(open, 1),
        mal_native_function_object_get_slot(open, 2),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        flags,
        argc > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_from_i32(argc > 2 ? 3 : 2),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue task_value = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "open"),
            node_fs_open_promise_task, roots, countof(roots)));
    mal_vm_enqueue_reaction_job(vm, task_value, false,
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    MalValue promise_value = roots[NODE_FS_OPEN_TASK_PROMISE];
    mal_gc_unroot(&root);
    return promise_value;
}

static MalValue node_fs_stats_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalPosixStat empty = {
        .atime_ms = NAN,
        .mtime_ms = NAN,
        .ctime_ms = NAN,
        .birthtime_ms = NAN,
    };
    MalValue result = node_fs_make_stats(vm, node_fs_slot_proto(vm, callee), &empty);
    if (!mal_value_is_object(result)) return result;
    static const char *undefined_fields[] = {
        "dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks",
    };
    for (usize i = 0; i < countof(undefined_fields); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(result),
            (const byte *) undefined_fields[i], mal_value_new_undefined(), NODE_FS_VISIBLE);
    }
    return result;
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
        mal_native_function_object_get_slot(task, 2),
        mal_native_function_object_get_slot(task, 3),
        mal_native_function_object_get_slot(task, 4),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool descriptor = mal_ops_is_number(roots[1]);
    int fd;
    char *path = nullptr;
    int err = 0;
    if (descriptor) {
        if (!node_fs_fd(vm, roots[1], &fd)) {
            roots[5] = vm->completion.value;
            node_fs_clear_completion(vm);
            err = -1;
        }
    } else {
        path = node_fs_path_cstr(vm, roots[1]);
        if (path == nullptr) {
            roots[5] = vm->completion.value;
            node_fs_clear_completion(vm);
            err = -1;
        } else {
            u32 flags = (u32) mal_ops_number_as_f64(roots[3]);
            bool native_flags = mal_value_to_boolean(roots[4]);
            err = mal_posix_fs_open(path, flags, native_flags, 0666, &fd);
            if (err != 0) roots[5] = node_fs_errno_value(vm, err, "open", path);
        }
    }
    byte *data;
    usize length;
    if (err == 0) {
        err = mal_posix_fs_read_all_fd(fd, &data, &length);
        int close_err = descriptor ? 0 : mal_posix_fs_close_fd(fd);
        if (err != 0) roots[5] = node_fs_errno_value(vm, err, "read", path);
        else if (close_err != 0) {
            roots[5] = node_fs_errno_value(vm, close_err, "close", nullptr);
            free(data);
            err = close_err;
        }
    }
    if (err == 0) {
        roots[5] = node_fs_read_file_result(vm, data, length, roots[2]);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            MalValue callback_args[] = {mal_value_new_null(), roots[5]};
            mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), callback_args, 2);
        } else {
            roots[5] = vm->completion.value;
            node_fs_clear_completion(vm);
            mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), roots + 5, 1);
        }
    } else {
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), roots + 5, 1);
    }
    free(path);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
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
    bool descriptor = mal_ops_is_number(args[0]);
    int fd;
    char *path = nullptr;
    if (descriptor) {
        if (!node_fs_fd(vm, args[0], &fd)) return mal_value_new_undefined();
    } else {
        path = node_fs_path_cstr(vm, args[0]);
        if (path == nullptr) return mal_value_new_undefined();
    }
    MalValue options = callback_index > 1 ? args[1] : mal_value_new_undefined();
    MalValue slots[] = {
        args[callback_index], args[0], mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    if (!descriptor) {
        usize path_length = strlen(path);
        byte *path_bytes = path_length == 0 ? nullptr : malloc(path_length);
        if (path_length > 0 && path_bytes == nullptr) {
            free(path);
            mal_gc_unroot(&root);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        if (path_length > 0) memcpy(path_bytes, path, path_length);
        slots[1] = mal_node_buffer_from_owned_bytes(vm, path_bytes, path_length);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(path);
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
    }
    u32 flags;
    bool native_flags;
    if (!node_fs_read_file_options(
            vm, options, descriptor, &slots[2], &flags, &native_flags)) {
        free(path);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    slots[3] = mal_value_from_f64((f64) flags);
    slots[4] = mal_value_new_boolean(native_flags);
    free(path);
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

static MalValue node_fs_stream_get(MalVm *vm, MalValue state, const char *name) {
    MalValue value = mal_value_new_undefined();
    mal_vm_get_property(vm, state, mal_intrinsic_string_key(vm, name), &value);
    return value;
}

static void node_fs_stream_set(MalVm *vm, MalValue state, const char *name, MalValue value) {
    mal_object_set(mal_value_to_object(state), mal_intrinsic_string_key(vm, name), value);
}

static void node_fs_stream_close(MalVm *vm, MalValue state, MalValue receiver) {
    node_fs_file_handle_finalize(mal_value_to_heap(state));
    if (node_fs_truthy_property(vm, state, "autoClose")) node_fs_stream_set(vm, receiver, "fd", mal_value_new_null());
}

static MalValue node_fs_read_stream_destroy(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    node_fs_stream_close(vm, state, self);
    if (argc > 1) mal_vm_call_value(vm, args[1], mal_value_new_undefined(), args, 1);
    return mal_value_new_undefined();
}

static MalValue node_fs_read_stream_read(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    MalValue roots[] = {self, mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeFsFileHandleObject *state = node_fs_file_handle(roots[1]);
    MalValue fd_value = node_fs_stream_get(vm, roots[1], "fd");
    int fd = mal_value_is_nil(fd_value) ? -1 : mal_value_to_i32(fd_value);
    int error = 0;
    char *path = node_fs_path_cstr(vm, node_fs_stream_get(vm, roots[1], "path"));
    if (path == nullptr) goto finished;
    if (fd < 0) {
        error = mal_posix_fs_open(path, MAL_POSIX_OPEN_READ, false, 0666, &fd);
        if (error != 0) goto failed;
        node_fs_stream_set(vm, roots[1], "fd", mal_value_from_i32(fd));
        if (node_fs_truthy_property(vm, roots[1], "autoClose")) state->fd = fd;
        node_fs_stream_set(vm, self, "fd", mal_value_from_i32(fd));
        roots[2] = mal_value_from_i32(fd);
        MalValue open_args[] = {node_fs_string_from_cstr(vm,"open"), roots[2]};
        node_fs_call_method(vm, self, "emit", open_args, 2);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW || node_fs_truthy_property(vm, self, "destroyed")) { free(path); goto finished; }
    usize position = (usize) mal_ops_number_as_f64(node_fs_stream_get(vm, roots[1], "position"));
    MalValue end_value = node_fs_stream_get(vm, roots[1], "end");
    usize chunk_size = (usize) mal_value_to_i32(node_fs_stream_get(vm, roots[1], "highWaterMark"));
    if (!mal_value_is_undefined(end_value)) {
        usize end = (usize) mal_ops_number_as_f64(end_value);
        chunk_size = position > end ? 0 : chunk_size > end-position+1 ? end-position+1 : chunk_size;
    }
    byte *data = chunk_size == 0 ? nullptr : malloc(chunk_size);
    if (chunk_size > 0 && data == nullptr) { error=ENOMEM; goto failed; }
    usize length = 0;
    if (chunk_size > 0) error = mal_posix_fs_read_fd(fd, data, chunk_size,
        node_fs_truthy_property(vm, roots[1], "positioned"), (i64) position, &length);
    if (error != 0) { free(data); goto failed; }
    free(path);
    if (length == 0) {
        free(data);
        node_fs_stream_close(vm, roots[1], self);
        roots[2] = mal_value_new_null();
        mal_node_stream_push_chunk(vm, self, roots[2]);
        node_fs_stream_set(vm, self, "_malAutoDestroyAfterEnd", mal_value_new_boolean(node_fs_truthy_property(vm, roots[1], "autoClose")));
    } else {
        node_fs_stream_set(vm, roots[1], "position", mal_value_from_f64((f64)(position+length)));
        roots[2] = mal_node_buffer_from_owned_bytes(vm, data, length);
        mal_node_stream_push_chunk(vm, self, roots[2]);
    }
    goto finished;
failed:
    roots[2] = node_fs_errno_value(vm, error, "read", path);
    free(path);
    node_fs_call_method(vm, self, "destroy", roots + 2, 1);
finished:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_create_read_stream(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalValue roots[6] = {argc > 1 ? args[1] : mal_value_new_undefined(),
        node_fs_string_from_cstr(vm,path), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    free(path);
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!node_fs_stream_offset(vm, roots[0], "start", roots+2)
        || !node_fs_stream_offset(vm, roots[0], "end", roots+3)) goto finished;
    if (!mal_value_is_undefined(roots[2]) && !mal_value_is_undefined(roots[3])
        && mal_ops_number_as_f64(roots[3]) < mal_ops_number_as_f64(roots[2])) {
        mal_vm_throw_error(vm,MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,"createReadStream end must be greater than or equal to start"); goto finished;
    }
    MalValue hwm = mal_value_new_undefined(), fd = mal_value_new_undefined(), auto_close = mal_value_new_undefined();
    if (mal_value_is_object(roots[0])) {
        hwm=node_fs_stream_get(vm,roots[0],"highWaterMark");
        fd=node_fs_stream_get(vm,roots[0],"fd");
        auto_close=node_fs_stream_get(vm,roots[0],"autoClose");
    }
    if (!mal_value_is_undefined(fd)) {
        int native_fd;
        if (!node_fs_fd(vm, fd, &native_fd)) goto finished;
        fd = mal_value_from_i32(native_fd);
    }
    i32 chunk_size=65536;
    if (!mal_value_is_undefined(hwm)) {
        f64 number;
        if (!mal_vm_to_number(vm,hwm,&number)) goto finished;
        if (!isfinite(number) || floor(number)!=number || number<1 || number>INT32_MAX) {
            mal_vm_throw_error(vm,MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,"createReadStream highWaterMark is out of range"); goto finished;
        }
        chunk_size=(i32)number;
    }
    MalNodeFsFileHandleObject *state=mal_heap_alloc(&vm->heap,sizeof(MalNodeFsFileHandleObject),MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT);
    mal_object_init(&vm->heap,&state->object,MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    state->fd=-1;
    roots[4]=mal_value_from_heap((MalHeapHeader*)state);
    node_fs_stream_set(vm,roots[4],"path",roots[1]);
    node_fs_stream_set(vm,roots[4],"position",mal_value_is_undefined(roots[2])?mal_value_from_i32(0):roots[2]);
    node_fs_stream_set(vm,roots[4],"positioned",mal_value_new_boolean(!mal_value_is_undefined(roots[2])));
    node_fs_stream_set(vm,roots[4],"end",roots[3]);
    node_fs_stream_set(vm,roots[4],"highWaterMark",mal_value_from_i32(chunk_size));
    node_fs_stream_set(vm,roots[4],"autoClose",mal_value_new_boolean(!mal_value_is_boolean(auto_close)||mal_value_to_boolean(auto_close)));
    node_fs_stream_set(vm,roots[4],"fd",fd);
    if (mal_ops_is_number(fd) && node_fs_truthy_property(vm,roots[4],"autoClose")) state->fd=mal_value_to_i32(fd);
    mal_gc_register_finalizer(MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT,node_fs_file_handle_finalize);
    roots[5]=mal_value_from_object(mal_intrinsic_new_object(vm));
    node_fs_stream_set(vm,roots[5],"highWaterMark",mal_value_from_i32(chunk_size));
    roots[2]=node_fs_make_fn_slot(vm,mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),"read",1,node_fs_read_stream_read,roots[4]);
    node_fs_stream_set(vm,roots[5],"read",roots[2]);
    roots[3]=node_fs_make_fn_slot(vm,mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),"destroy",2,node_fs_read_stream_destroy,roots[4]);
    node_fs_stream_set(vm,roots[5],"destroy",roots[3]);
    MalCompletion stream=mal_vm_construct_value(vm,vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR],roots+5,1);
    roots[2]=stream.kind==MAL_COMPLETION_THROW?mal_value_new_undefined():stream.value;
    if (stream.kind!=MAL_COMPLETION_THROW) {
        node_fs_stream_set(vm,roots[2],"path",roots[1]);
        node_fs_stream_set(vm,roots[2],"fd",mal_value_is_undefined(fd)?mal_value_new_null():fd);
    }
finished:
    MalValue result=vm->completion.kind==MAL_COMPLETION_THROW?mal_value_new_undefined():roots[2];
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
    if (strcmp(name, "accessSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "accessSync", 2, node_fs_access_sync);
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
    if (strcmp(name, "linkSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "linkSync", 2, node_fs_link_sync);
    }
    if (strcmp(name, "readlinkSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "readlinkSync", 1, node_fs_readlink_sync);
    }
    if (strcmp(name, "symlinkSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "symlinkSync", 2, node_fs_symlink_sync);
    }
    if (strcmp(name, "chmodSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "chmodSync", 2, node_fs_chmod_sync);
    }
    if (strcmp(name, "closeSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "closeSync", 1, node_fs_close_sync);
    }
    if (strcmp(name, "openSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "openSync", 3, node_fs_open_sync);
    }
    if (strcmp(name, "readSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "readSync", 5, node_fs_read_sync);
    }
    if (strcmp(name, "unlinkSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "unlinkSync", 1, node_fs_unlink_sync);
    }
    if (strcmp(name, "utimesSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "utimesSync", 3, node_fs_utimes_sync);
    }
    if (strcmp(name, "writeSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "writeSync", 5, node_fs_write_sync);
    }
    if (strcmp(name, "write") == 0) {
        return node_fs_make_fn(vm, fn_proto, "write", 3, node_fs_write);
    }
    if (strcmp(name, "statSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "statSync", 1, node_fs_stat_sync, protos[0]);
    }
    if (strcmp(name, "fstatSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "fstatSync", 1, node_fs_fstat_sync, protos[0]);
    }
    if (strcmp(name, "fsyncSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "fsyncSync", 1, node_fs_fsync_sync);
    }
    if (strcmp(name, "ftruncateSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "ftruncateSync", 1, node_fs_ftruncate_sync);
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
    if (strcmp(name, "link") == 0 || strcmp(name, "readlink") == 0
        || strcmp(name, "symlink") == 0) {
        const char *sync_name = strcmp(name, "link") == 0
            ? "linkSync"
            : strcmp(name, "readlink") == 0 ? "readlinkSync" : "symlinkSync";
        i32 arity = strcmp(name, "symlink") == 0 ? 4 : 3;
        MalValue operation = node_fs_export(vm, fn_proto, sync_name, protos);
        MalRootSpan root;
        mal_gc_root(&root, &operation, 1);
        MalValue result = node_fs_make_fn_slot(
            vm, fn_proto, name, arity, node_fs_callback_operation, operation);
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
    if (strcmp(name, "rmdirSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "rmdirSync", 1, node_fs_rmdir_sync);
    }
    return mal_value_new_undefined();
}

void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:fs", slots, count)) return;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:fs", slots, count, cached);
        return;
    }
    if (!node_fs_async_installed) {
        mal_gc_register_root_source(node_fs_async_scan_roots, nullptr);
        mal_host_register_macrotask_drain(node_fs_async_drain, false);
        node_fs_async_installed = true;
    }
    if (!mal_vm_register_runtime_cleanup(vm, node_fs_async_free)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "Could not register node:fs runtime cleanup");
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
        vm, stats_proto, (const byte *) "isBlockDevice", 0, node_fs_is_block_device);
    mal_intrinsic_define_method_n(vm, stats_proto,
        (const byte *) "isCharacterDevice", 0, node_fs_is_character_device);
    mal_intrinsic_define_method_n(
        vm, stats_proto, (const byte *) "isFIFO", 0, node_fs_is_fifo);
    mal_intrinsic_define_method_n(
        vm, stats_proto, (const byte *) "isSocket", 0, node_fs_is_socket);
    mal_intrinsic_define_method_n(
        vm, stats_proto, (const byte *) "isSymbolicLink", 0,
        node_fs_is_symbolic_link);
    mal_intrinsic_define_accessor_n(vm, stats_proto,
        mal_intrinsic_string_key(vm, (const byte *) "atime"),
        (const byte *) "get", 0, node_fs_get_atime,
        (const byte *) "set", 1, node_fs_set_atime,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(vm, stats_proto,
        mal_intrinsic_string_key(vm, (const byte *) "mtime"),
        (const byte *) "get", 0, node_fs_get_mtime,
        (const byte *) "set", 1, node_fs_set_mtime,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(vm, stats_proto,
        mal_intrinsic_string_key(vm, (const byte *) "ctime"),
        (const byte *) "get", 0, node_fs_get_ctime,
        (const byte *) "set", 1, node_fs_set_ctime,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(vm, stats_proto,
        mal_intrinsic_string_key(vm, (const byte *) "birthtime"),
        (const byte *) "get", 0, node_fs_get_birthtime,
        (const byte *) "set", 1, node_fs_set_birthtime,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    MalObject *dirent_proto = mal_object_new(&vm->heap, obj_proto);
    protos[1] = mal_value_from_object(dirent_proto);
    mal_intrinsic_define_method_n(vm, dirent_proto, (const byte *) "isFile", 0, node_fs_is_file);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isDirectory", 0, node_fs_is_directory);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isBlockDevice", 0, node_fs_is_block_device);
    mal_intrinsic_define_method_n(vm, dirent_proto,
        (const byte *) "isCharacterDevice", 0, node_fs_is_character_device);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isFIFO", 0, node_fs_is_fifo);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isSocket", 0, node_fs_is_socket);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isSymbolicLink", 0,
        node_fs_is_symbolic_link);

    static const char *names[] = {
		"Stats", "accessSync", "appendFileSync", "chmodSync", "closeSync", "copyFileSync", "createReadStream", "existsSync", "fstatSync", "fsyncSync", "ftruncateSync", "link", "linkSync", "lstatSync", "mkdirSync",
		"mkdtempSync", "openSync", "readFile", "readFileSync", "readlink", "readlinkSync", "readSync", "readdir", "readdirSync", "realpathSync", "renameSync",
        "rmSync", "rmdirSync", "statSync", "stat", "symlink", "symlinkSync", "unlinkSync", "utimesSync", "write", "writeFileSync", "writeSync",
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
    MalValue constants = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan constants_root;
    mal_gc_root(&constants_root, &constants, 1);
    usize constant_count;
    const MalPosixFsConstant *constant_table = mal_posix_fs_constants(&constant_count);
    for (usize i = 0; i < constant_count; i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(constants),
            (const byte *) constant_table[i].name,
            mal_value_from_f64((f64) constant_table[i].value), MAL_PROPERTY_ENUMERABLE);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(module),
        (const byte *) "constants", constants, MAL_PROPERTY_ENUMERABLE);
    mal_gc_unroot(&constants_root);
    vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE] = module;
    mal_node_module_publish(vm, "node:fs", slots, count, module);
    mal_gc_unroot(&module_root);

    mal_gc_unroot(&proto_rs);
}

void mal_host_install_node_fs_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:fs/promises", slots, count)) return;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:fs/promises", slots, count, cached);
        return;
    }

    mal_host_install_node_fs(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    mal_gc_register_finalizer(
        MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT, node_fs_file_handle_finalize);

    MalValue roots[] = {
        vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE],
        mal_value_new_undefined(),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *obj_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap, obj_proto));
    MalObject *file_handle_proto = mal_value_to_object(roots[3]);
    mal_intrinsic_define_getter(vm, file_handle_proto,
        (const byte *) "fd", (const byte *) "get fd",
        node_fs_file_handle_fd_getter, MAL_PROPERTY_CONFIGURABLE);

    static const struct {
        const char *name;
        const char *sync_name;
        i32 arity;
        NodeFsFileHandleOperation operation;
    } file_handle_operations[] = {
        {"appendFile", "appendFileSync", 2, NODE_FS_FILE_HANDLE_APPEND_FILE},
        {"datasync", nullptr, 0, NODE_FS_FILE_HANDLE_DATASYNC},
        {"read", "readSync", 4, NODE_FS_FILE_HANDLE_READ},
        {"readFile", "readFileSync", 1, NODE_FS_FILE_HANDLE_READ_FILE},
        {"stat", "fstatSync", 1, NODE_FS_FILE_HANDLE_STAT},
        {"sync", "fsyncSync", 0, NODE_FS_FILE_HANDLE_SYNC},
        {"truncate", "ftruncateSync", 0, NODE_FS_FILE_HANDLE_TRUNCATE},
        {"write", "writeSync", 4, NODE_FS_FILE_HANDLE_WRITE},
        {"writeFile", "writeFileSync", 2, NODE_FS_FILE_HANDLE_WRITE_FILE},
    };
    for (usize i = 0; i < countof(file_handle_operations); i++) {
        roots[1] = mal_value_new_undefined();
        if (file_handle_operations[i].sync_name != nullptr
            && !mal_vm_get_property(vm, roots[0],
                mal_intrinsic_string_key(vm,
                    (const byte *) file_handle_operations[i].sync_name),
                &roots[1])) {
            mal_gc_unroot(&root);
            return;
        }
        MalValue method_slots[] = {
            roots[1], mal_value_from_i32(file_handle_operations[i].operation),
        };
        MalValue method = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(
                &vm->heap, fn_proto,
                mal_intrinsic_ascii(vm,
                    (const byte *) file_handle_operations[i].name),
                file_handle_operations[i].arity,
                node_fs_file_handle_operation,
                method_slots, countof(method_slots)));
        MalRootSpan method_root;
        mal_gc_root(&method_root, &method, 1);
        mal_intrinsic_define_data(vm, file_handle_proto,
            (const byte *) file_handle_operations[i].name, method,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_gc_unroot(&method_root);
    }

    static const struct {
        const char *name;
        const char *sync_name;
        i32 arity;
    } operations[] = {
        {"appendFile", "appendFileSync", 2},
        {"chmod", "chmodSync", 2},
        {"copyFile", "copyFileSync", 2},
        {"link", "linkSync", 2},
        {"lstat", "lstatSync", 1},
        {"mkdir", "mkdirSync", 1},
        {"readFile", "readFileSync", 1},
        {"readlink", "readlinkSync", 1},
        {"readdir", "readdirSync", 1},
        {"realpath", "realpathSync", 1},
        {"rename", "renameSync", 2},
        {"rm", "rmSync", 1},
        {"rmdir", "rmdirSync", 1},
        {"stat", "statSync", 1},
        {"symlink", "symlinkSync", 2},
        {"unlink", "unlinkSync", 1},
        {"utimes", "utimesSync", 3},
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

    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "openSync"),
            &roots[4])
        || !mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "closeSync"),
            &roots[5])) {
        mal_gc_unroot(&root);
        return;
    }
    MalValue open_slots[] = {roots[4], roots[3], roots[5]};
    MalValue open = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap, fn_proto,
            mal_intrinsic_ascii(vm, (const byte *) "open"), 3,
            node_fs_open_promise, open_slots, countof(open_slots)));
    MalRootSpan open_root;
    mal_gc_root(&open_root, &open, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]),
        (const byte *) "open", open, NODE_FS_VISIBLE);
    mal_gc_unroot(&open_root);

    roots[1] = node_fs_make_fn(vm, fn_proto, "rm", 1, node_fs_rm_promise);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "rm", roots[1], NODE_FS_VISIBLE);
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, "readdirSync"), &roots[1])) {
        mal_gc_unroot(&root);
        return;
    }
    MalValue dirent_proto = mal_native_function_object_get_slot(mal_value_to_native_function_object(roots[1]), 0);
    roots[1] = node_fs_make_fn_slot(vm, fn_proto, "glob", 1, node_fs_glob, dirent_proto);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "glob", roots[1], NODE_FS_VISIBLE);

    vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE] = roots[2];
    mal_node_module_publish(vm, "node:fs/promises", slots, count, roots[2]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
