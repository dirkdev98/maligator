#include "node_fs.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_data_view.h"
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
    if (!mal_vm_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || number > 4294967295.0 || trunc(number) != number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "chmodSync mode must be a non-negative 32-bit integer");
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
    const byte *bytes;
    usize length;
    byte *owned;
    MalValue encoding = mal_value_is_string(
            argc > 1 ? args[1] : mal_value_new_undefined()) && argc > 3
        ? args[3]
        : mal_value_new_undefined();
    if (!node_fs_write_bytes(
            vm, argc > 1 ? args[1] : mal_value_new_undefined(),
            encoding,
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
        return node_fs_make_fn(vm, fn_proto, "writeSync", 2, node_fs_write_sync);
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
        "rmSync", "statSync", "stat", "symlink", "symlinkSync", "unlinkSync", "utimesSync", "write", "writeFileSync", "writeSync",
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
        {"link", "linkSync", 2},
        {"lstat", "lstatSync", 1},
        {"mkdir", "mkdirSync", 1},
        {"readFile", "readFileSync", 1},
        {"readlink", "readlinkSync", 1},
        {"readdir", "readdirSync", 1},
        {"rename", "renameSync", 2},
        {"rm", "rmSync", 1},
        {"stat", "statSync", 1},
        {"symlink", "symlinkSync", 2},
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
