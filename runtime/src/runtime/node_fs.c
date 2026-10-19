#include "node_fs.h"

#if MAL_NODE

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#if defined(__APPLE__)
#include <sys/event.h>
#elif defined(__linux__)
#include <sys/inotify.h>
#endif

#include "ascii.h"
#include "async_context.h"
#include "array_object.h"
#include "builtin_iterator.h"
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
#include "reactor.h"
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
    return mal_node_buffer_encode_bytes(vm, bytes, len,
        mal_value_from_string(mal_intrinsic_ascii(vm, "utf8")), true);
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
    char *path = malloc(span.length + 1);
    if (path == nullptr) return NODE_FS_PATH_ALLOCATION_FAILED;
    // Validate the private copy so a shared source cannot change after the NUL check.
    mal_buffer_source_span_read(&span, 0, (byte *) path, span.length);
    if (span.length > 0 && memchr(path, 0, span.length) != nullptr) {
        free(path);
        return NODE_FS_PATH_EMBEDDED_NUL;
    }
    path[span.length] = '\0';
    *out = path;
    return NODE_FS_PATH_OK;
}

static void node_fs_throw_code(
    MalVm *vm, MalIntrinsic prototype, const byte *message, const byte *code
) {
    mal_vm_throw_error(vm, prototype, message);
    MalValue roots[] = {
        vm->completion.value,
        mal_value_from_string(mal_intrinsic_ascii(vm, code)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "code", roots[1],
        NODE_FS_VISIBLE);
    mal_gc_unroot(&root);
}

/* Validate a PathLike and return its malloc-owned C path. */
static char *node_fs_path_cstr(MalVm *vm, MalValue value) {
    char *path;
    NodeFsPathResult result = node_fs_path_bytes(vm, value, false, &path);
    if (result == NODE_FS_PATH_INVALID_TYPE) {
        if (vm->completion.kind == MAL_COMPLETION_THROW) return nullptr;
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "filesystem path must be a string, Uint8Array, or file URL",
            "ERR_INVALID_ARG_TYPE");
        return nullptr;
    }
    if (result == NODE_FS_PATH_EMBEDDED_NUL) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "filesystem path must not contain null bytes", "ERR_INVALID_ARG_VALUE");
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
    mal_node_throw_errno(vm, err, syscall, path, dest);
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
        f64 number = mal_value_to_f64(v);
        if (number >= 0 && number <= UINT32_MAX) return (u32) number;
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

static bool node_fs_access_mode(MalVm *vm, MalValue value, u32 *mode) {
    *mode = 0;
    if (mal_value_is_nil(value)) return true;
    if (!mal_ops_is_number(value)) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "access mode must be a number or null", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    f64 number = trunc(mal_ops_number_as_f64(value));
    if (!isfinite(number) || number < 0 || number > 7) {
        node_fs_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "access mode must truncate to an integer from 0 through 7", "ERR_OUT_OF_RANGE");
        return false;
    }
    *mode = (u32) number;
    return true;
}

static MalValue node_fs_access_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    u32 mode;
    if (!node_fs_access_mode(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &mode)) {
        free(path);
        return mal_value_new_undefined();
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
    const byte **bytes, usize *length, byte **owned,
    MalBlockingWorkReservation *reservation);

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
            &bytes, &length, &owned, nullptr)) {
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
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "file descriptor must be a number", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < 0 || number > INT_MAX || trunc(number) != number) {
        node_fs_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "file descriptor must be a non-negative integer", "ERR_OUT_OF_RANGE");
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
    // The kernel writes plain bytes; a shared destination receives them bytewise.
    byte *staged = span.shared && length > 0 ? malloc(length) : nullptr;
    if (span.shared && length > 0 && staged == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    int err = mal_posix_fs_read_fd(fd,
        staged != nullptr ? staged : span.data == nullptr ? nullptr : span.data + offset,
        length, has_position, position, &read_count);
    if (staged != nullptr) {
        if (err == 0) mal_buffer_source_span_write(&span, offset, staged, read_count);
        free(staged);
    }
    if (err != 0) {
        node_fs_throw_errno_with_dest(vm, err, "read", nullptr, nullptr);
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) read_count);
}

static bool node_fs_write_bytes(
    MalVm *vm, MalValue data, MalValue encoding,
    const byte **bytes, usize *length, byte **owned,
    MalBlockingWorkReservation *reservation) {
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
        if (reservation != nullptr &&
            !mal_blocking_work_reserve(mal_host(vm), span.length, reservation)) {
            node_fs_throw_errno(vm, EAGAIN, "write", nullptr);
            return false;
        }
        const byte *data = mal_buffer_source_span_private(&span, owned);
        if (span.length > 0 && data == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *bytes = data == nullptr ? (const byte *) "" : data;
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
        if (reservation != nullptr) {
            usize units = mal_string_length(mal_value_to_string(data));
            // All supported encoders allocate at most three bytes per UTF-16 unit plus padding.
            if (units > (SIZE_MAX - 3) / 3 ||
                !mal_blocking_work_reserve(mal_host(vm), units * 3 + 3, reservation)) {
                node_fs_throw_errno(vm, EAGAIN, "write", nullptr);
                return false;
            }
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
    } else if (mal_value_is_int32(value) || mal_value_is_f64(value)) {
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
        if (!node_fs_write_bytes(vm, data, encoding, &bytes, &length, &owned, nullptr)
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
        if (span.shared && length > 0) {
            owned = malloc(length);
            if (owned == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
            mal_buffer_source_span_read(&span, offset, owned, length);
            bytes = owned;
        }
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

static MalValue node_fs_sync_call(
    MalVm *vm, const MalValue *args, i32 argc, MalValue new_target, bool data_only
) {
    MalValue instance = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(vm, new_target,
                MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) goto failed;
    int err = data_only ? mal_posix_fs_datasync_fd(fd) : mal_posix_fs_sync_fd(fd);
    if (err != 0) {
        node_fs_throw_errno_with_dest(vm, err, data_only ? "fdatasync" : "fsync", nullptr, nullptr);
        goto failed;
    }
    mal_gc_unroot(&root);
    return instance;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_fsync_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) callee;
    return node_fs_sync_call(vm, args, argc, new_target, false);
}

static MalValue node_fs_fdatasync_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) callee;
    return node_fs_sync_call(vm, args, argc, new_target, true);
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

static MalValue node_fs_make_statfs(MalVm *vm, const MalPosixStatFs *statfs) {
    MalPosixStatFs st = *statfs;
    MalObject *object = mal_intrinsic_new_object(vm);
    MalValue value = mal_value_from_object(object);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    const struct {
        const char *name;
        f64 number;
    } fields[] = {
        {"type", st.type}, {"bsize", st.bsize}, {"blocks", st.blocks}, {"bfree", st.bfree},
        {"bavail", st.bavail}, {"files", st.files}, {"ffree", st.ffree},
    };
    for (usize i = 0; i < countof(fields); i++) {
        mal_intrinsic_define_data(vm, object, (const byte *) fields[i].name,
            mal_value_from_f64(fields[i].number), NODE_FS_VISIBLE);
    }
    mal_gc_unroot(&root);
    return value;
}

static MalValue node_fs_statfs_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) return mal_value_new_undefined();
    MalPosixStatFs st;
    int err = mal_posix_fs_statfs(path, &st);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "statfs", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return node_fs_make_statfs(vm, &st);
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
        if (!mal_value_is_string(value) && !mal_value_is_int32(value) && !mal_value_is_f64(value)) {
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

static MalValue node_fs_directory_entries(
    MalVm *vm, char *path, bool with_types, MalObject *dirent_proto, const char *syscall);
static MalValue node_fs_directory_entries_recursive(
    MalVm *vm, char *path, bool with_types, MalObject *dirent_proto);

static MalValue node_fs_readdir_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    char *path = node_fs_path_cstr(vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) {
        return mal_value_new_undefined();
    }
    bool with_types = false;
    bool recursive = false;
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue wft;
        MalValue recursive_option;
        if (!mal_vm_get_property(
                vm, args[1], mal_intrinsic_string_key(vm, (const byte *) "withFileTypes"), &wft)
            || !mal_vm_get_property(vm, args[1], mal_intrinsic_string_key(vm, "recursive"),
                &recursive_option)) {
            free(path);
            return mal_value_new_undefined();
        }
        with_types = mal_value_is_truthy(wft);
        recursive = mal_value_is_truthy(recursive_option);
    }
    if (recursive) {
        return node_fs_directory_entries_recursive(vm, path, with_types, node_fs_slot_proto(vm, callee));
    }
    return node_fs_directory_entries(vm, path, with_types, node_fs_slot_proto(vm, callee),
        "scandir");
}

static char *node_fs_cp_join(const char *left, const char *right);
static void node_fs_array_push(MalValue array, MalValue value);

/* Node's readdirSyncRecursive: breadth-first, names relative to `path` (owned), descending
 * through symlinked directories too. */
static MalValue node_fs_directory_entries_recursive(
    MalVm *vm, char *path, bool with_types, MalObject *dirent_proto) {
    usize capacity = 16;
    char **queue = malloc(capacity * sizeof(char *));
    usize queued = 0;
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = queue != nullptr && (queue[queued++] = strdup("")) != nullptr;
    if (ok) roots[0] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    else mal_vm_throw_allocation_error(vm);
    for (usize head = 0; ok && head < queued; head++) {
        char *relative = queue[head];
        char *directory = relative[0] == '\0' ? strdup(path) : node_fs_cp_join(path, relative);
        MalPosixDirent *entries = nullptr;
        usize count = 0;
        int err = directory == nullptr ? ENOMEM : mal_posix_fs_readdir(directory, &entries, &count);
        if (err != 0) {
            if (err == ENOMEM) mal_vm_throw_allocation_error(vm);
            else node_fs_throw_errno(vm, err, "scandir", directory);
            free(directory);
            ok = false;
            break;
        }
        if (with_types) roots[1] = node_fs_string_from_cstr(vm, directory);
        for (usize i = 0; ok && i < count; i++) {
            const char *name = entries[i].name;
            char *child = relative[0] == '\0' ? strdup(name) : node_fs_cp_join(relative, name);
            if (child == nullptr) {
                mal_vm_throw_allocation_error(vm);
                ok = false;
                break;
            }
            bool is_directory = entries[i].type == MAL_POSIX_FT_DIR;
            if (with_types) {
                MalObject *dirent = mal_object_new(&vm->heap, dirent_proto);
                roots[2] = mal_value_from_object(dirent);
                roots[3] = node_fs_string_from_cstr(vm, name);
                mal_intrinsic_define_data(vm, dirent, (const byte *) "name", roots[3], NODE_FS_VISIBLE);
                mal_intrinsic_define_data(vm, dirent, (const byte *) "parentPath", roots[1], NODE_FS_VISIBLE);
                mal_intrinsic_define_data(vm, dirent, (const byte *) NODE_FS_TYPE_KEY,
                    mal_value_from_i32((i32) entries[i].type), MAL_PROPERTY_NONE);
            } else {
                roots[2] = node_fs_string_from_cstr(vm, child);
            }
            if (entries[i].type == MAL_POSIX_FT_SYMLINK || entries[i].type == MAL_POSIX_FT_OTHER) {
                char *target = node_fs_cp_join(directory, name);
                MalPosixStat st;
                is_directory = target != nullptr && mal_posix_fs_stat(target, &st) == 0
                    && st.type == MAL_POSIX_FT_DIR;
                free(target);
            }
            node_fs_array_push(roots[0], roots[2]);
            if (is_directory && queued == capacity) {
                char **grown = realloc(queue, capacity * 2 * sizeof(char *));
                if (grown != nullptr) {
                    queue = grown;
                    capacity *= 2;
                }
            }
            if (!is_directory) {
                free(child);
            } else if (queued < capacity) {
                queue[queued++] = child;
            } else {
                free(child);
                mal_vm_throw_allocation_error(vm);
                ok = false;
            }
        }
        mal_posix_fs_free_dirents(entries, count);
        free(directory);
    }
    for (usize i = 0; i < queued; i++) free(queue[i]);
    free(queue);
    free(path);
    MalValue result = ok ? roots[0] : mal_value_new_undefined();
    mal_gc_unroot(&root);
    return result;
}

/* List `path` (owned) as names or Dirents; failures throw with `syscall`. */
static MalValue node_fs_directory_entries(
    MalVm *vm, char *path, bool with_types, MalObject *dirent_proto, const char *syscall) {
    MalPosixDirent *entries;
    usize count;
    int err = mal_posix_fs_readdir(path, &entries, &count);
    if (err != 0) {
        node_fs_throw_errno(vm, err, syscall, path);
        free(path);
        return mal_value_new_undefined();
    }
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

static bool node_fs_mkdtemp_options(MalVm *vm, MalValue *options) {
    if (mal_value_is_nil(*options) || mal_value_is_callable(*options)) {
        *options = mal_value_new_undefined();
        return true;
    }
    MalValue temporary = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &temporary, 1);
    bool ok = true;
    if (mal_value_is_string(*options)) {
        temporary = *options;
        if (!mal_string_equals_ascii(mal_value_to_string(temporary), "buffer")
            && mal_value_is_truthy(temporary) && !mal_node_buffer_encoding_is_known(temporary)) goto invalid_encoding;
    } else if (!mal_value_is_object(*options)) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The options argument must be a string or object", "ERR_INVALID_ARG_TYPE");
        ok = false;
    } else {
        if (!mal_vm_get_property(vm, *options, mal_intrinsic_string_key(vm, "encoding"), &temporary)) goto failed;
        if (!mal_value_is_string(temporary)
            || !mal_string_equals_ascii(mal_value_to_string(temporary), "buffer")) {
            if (!mal_vm_get_property(vm, *options, mal_intrinsic_string_key(vm, "encoding"), &temporary)) goto failed;
            if (mal_value_is_truthy(temporary) && !mal_node_buffer_encoding_is_known(temporary)) goto invalid_encoding;
        }
        if (!mal_vm_get_property(vm, *options, mal_intrinsic_string_key(vm, "signal"), &temporary)) goto failed;
        if (!mal_value_is_undefined(temporary)) {
            if (!mal_vm_get_property(vm, *options, mal_intrinsic_string_key(vm, "signal"), &temporary)) goto failed;
            if (!mal_value_is_undefined(temporary)) {
                bool present = mal_value_is_object(temporary) && !mal_value_is_callable(temporary)
                    && mal_vm_has_property(vm, temporary, mal_intrinsic_string_key(vm, "aborted"));
                if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
                if (!present) {
                    node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                        "The signal option must be an AbortSignal", "ERR_INVALID_ARG_TYPE");
                    goto failed;
                }
            }
        }
    }
    mal_gc_unroot(&root);
    return ok;
 invalid_encoding:
    node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "The encoding option is invalid", "ERR_INVALID_ARG_VALUE");
 failed:
    mal_gc_unroot(&root);
    return false;
}

static bool node_fs_mkdtemp_encoding(MalVm *vm, MalValue options, MalValue *encoding) {
    MalValue value = options;
    if (mal_value_is_object(options)
        && !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "encoding"), &value)) return false;
    if (mal_value_is_string(value) && mal_string_equals_ascii_ci(mal_value_to_string(value), "buffer")) {
        *encoding = mal_value_new_undefined();
    } else if (mal_node_buffer_encoding_is_known(value)) {
        *encoding = value;
    } else {
        *encoding = mal_value_from_string(mal_intrinsic_ascii(vm, "utf8"));
    }
    return true;
}

static char *node_fs_mkdtemp_prefix(MalVm *vm, MalValue prefix, MalValue options, MalValue *encoding) {
    char *path = node_fs_path_cstr(vm, prefix);
    if (path == nullptr) return nullptr;
    if (!node_fs_mkdtemp_encoding(vm, options, encoding)) {
        free(path);
        return nullptr;
    }
    // The binding copies byte prefixes after the final encoding getter has run.
    if (mal_value_is_typed_array_object(prefix)) {
        free(path);
        path = node_fs_path_cstr(vm, prefix);
    }
    return path;
}

static MalValue node_fs_mkdtemp_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self; (void) callee;
    MalValue roots[] = {argc > 1 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(vm, new_target,
                MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        roots[2] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    if (!node_fs_mkdtemp_options(vm, roots)) goto failed;
    char *prefix = node_fs_mkdtemp_prefix(vm, argc > 0 ? args[0] : mal_value_new_undefined(), roots[0], roots + 1);
    if (prefix == nullptr) goto failed;
    char *created;
    int err = mal_posix_fs_mkdtemp(prefix, &created);
    if (err != 0) {
        node_fs_throw_errno(vm, err, "mkdtemp", created != nullptr ? created : prefix);
        free(created);
        free(prefix);
        goto failed;
    }
    roots[3] = mal_node_buffer_encode_bytes(vm, (const byte *) created, strlen(created), roots[1], true);
    free(created);
    free(prefix);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    MalValue result = !mal_value_is_undefined(new_target) && !mal_value_is_object(roots[3]) ? roots[2] : roots[3];
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
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
            if (!(mal_value_is_int32(option) || mal_value_is_f64(option))) {
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

// The next match, or undefined once the walk is done or has thrown.
static MalValue node_fs_glob_advance(MalVm *vm, MalValue state) {
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
    if (mal_value_is_undefined(value)) {
        mal_array_object_store(mal_value_to_array_object(state), mal_key_index(NODE_FS_GLOB_DONE), mal_value_new_boolean(true));
        mal_array_object_store(mal_value_to_array_object(state), mal_key_index(NODE_FS_GLOB_SEEN), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return value;
}

static MalValue node_fs_glob_step(MalVm *vm, MalValue state) {
    MalValue roots[] = {state, node_fs_glob_advance(vm, state), mal_value_new_undefined()};
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "value", roots[1], NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "done",
        mal_value_new_boolean(mal_value_is_undefined(roots[1])), NODE_FS_VISIBLE);
    MalValue result = roots[2];
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

static bool node_fs_glob_patterns(MalVm *vm, MalValue input, MalValue *output, const char *name) {
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
            if (!mal_value_is_string(pattern)) {
                char element[64];
                snprintf(element, sizeof element, "%s[%u]", name, i);
                mal_node_throw_invalid_arg_type(vm, element, "of type string", pattern);
                return false;
            }
            node_fs_array_push(*output, pattern);
        }
        return true;
    }
    mal_node_throw_invalid_arg_type(vm, name, "of type string", input);
    return false;
}

// Validates the patterns and options and returns the walk state, or undefined after a throw.
static MalValue node_fs_glob_state(MalVm *vm, const MalValue *args, i32 argc, MalValue dirent_proto) {
    MalValue roots[7];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_array_object(mal_intrinsic_new_array(vm, NODE_FS_GLOB_STATE_COUNT));
    roots[1] = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!node_fs_glob_patterns(vm, roots[1], &roots[2], "patterns")) goto failed;
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_PATTERNS), roots[2]);
    roots[3] = node_fs_string_from_cstr(vm, ".");
    roots[4] = mal_value_new_undefined();
    roots[5] = mal_value_new_boolean(false);
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        if (!mal_value_is_object(args[1])) {
            mal_node_throw_invalid_arg_type(vm, "options", "of type object", args[1]);
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
                mal_node_throw_invalid_arg_type(vm, "options.exclude", "of type function or string[]", roots[4]);
                goto failed;
            }
            roots[6] = roots[4];
            if (!node_fs_glob_patterns(vm, roots[6], &roots[4], "options.exclude")) goto failed;
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
    mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(NODE_FS_GLOB_DIRENT_PROTO), dirent_proto);
    MalValue state = roots[0];
    mal_gc_unroot(&root);
    return state;
failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_glob(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {node_fs_glob_state(vm, args, argc,
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0)),
        mal_value_new_undefined(), mal_value_new_undefined()};
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
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
}

// The remaining matches as an array, or undefined after a throw.
static MalValue node_fs_glob_collect(MalVm *vm, MalValue state) {
    MalValue roots[] = {state, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    for (;;) {
        roots[2] = node_fs_glob_advance(vm, roots[0]);
        if (mal_value_is_undefined(roots[2])) break;
        node_fs_array_push(roots[1], roots[2]);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_glob_sync(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = node_fs_glob_state(vm, args, argc,
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return node_fs_glob_collect(vm, state);
}

// fs.cp walks an explicit work stack so the asynchronous form can suspend on a filter promise.
typedef enum NodeFsCpPhase {
    NODE_FS_CP_CHECK,
    NODE_FS_CP_DIR_FINISH,
} NodeFsCpPhase;

typedef struct NodeFsCpItem {
    char *src;
    char *dest;
    u32 mode;
    u8 phase;
    bool top;
    bool set_mode;
} NodeFsCpItem;

typedef enum NodeFsCpStatus {
    NODE_FS_CP_DONE,
    NODE_FS_CP_FAILED,
    NODE_FS_CP_FILTER,
} NodeFsCpStatus;

typedef struct NodeFsCp {
    NodeFsCpItem *items;
    usize count;
    usize capacity;
    u32 mode;
    bool dereference;
    bool error_on_exist;
    bool force;
    bool preserve_timestamps;
    bool recursive;
    bool verbatim_symlinks;
    // cpSync keeps Node's native path checks and their plain coded errors.
    bool sync;
    bool filter;
    bool filter_answered;
    bool filter_result;
    int error;
    const char *syscall;
    // A coded failure when set; otherwise `error` is a plain errno failure.
    const char *code;
    // The SystemError prefix, or nullptr for a plain Error carrying only `code`.
    const char *prefix;
    const char *info_code;
    char *message;
    char *path;
    char *dest;
} NodeFsCp;

static void node_fs_cp_free(NodeFsCp *cp) {
    if (cp == nullptr) return;
    for (usize i = 0; i < cp->count; i++) {
        free(cp->items[i].src);
        free(cp->items[i].dest);
    }
    free(cp->items);
    free(cp->message);
    free(cp->path);
    free(cp->dest);
    free(cp);
}

static NodeFsCpStatus node_fs_cp_errno(
    NodeFsCp *cp, int err, const char *syscall, const char *path, const char *dest) {
    cp->error = err;
    cp->syscall = syscall;
    cp->path = path == nullptr ? nullptr : strdup(path);
    cp->dest = dest == nullptr ? nullptr : strdup(dest);
    return NODE_FS_CP_FAILED;
}

static NodeFsCpStatus node_fs_cp_fail(NodeFsCp *cp, const char *code, const char *prefix,
    const char *info_code, int err, const char *path, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int length = vsnprintf(nullptr, 0, format, args);
    va_end(args);
    cp->message = length < 0 ? nullptr : malloc((usize) length + 1);
    if (cp->message != nullptr) {
        va_start(args, format);
        vsnprintf(cp->message, (usize) length + 1, format, args);
        va_end(args);
    }
    cp->code = code;
    cp->prefix = prefix;
    cp->info_code = info_code;
    cp->error = err;
    cp->syscall = "cp";
    cp->path = path == nullptr ? nullptr : strdup(path);
    return NODE_FS_CP_FAILED;
}

static bool node_fs_cp_push(NodeFsCp *cp, char *src, char *dest, NodeFsCpPhase phase,
    bool top, u32 mode, bool set_mode) {
    if (src != nullptr && dest != nullptr && cp->count == cp->capacity) {
        usize capacity = cp->capacity == 0 ? 16 : cp->capacity * 2;
        NodeFsCpItem *items = realloc(cp->items, capacity * sizeof(NodeFsCpItem));
        if (items != nullptr) {
            cp->items = items;
            cp->capacity = capacity;
        }
    }
    if (src == nullptr || dest == nullptr || cp->count == cp->capacity) {
        free(src);
        free(dest);
        return false;
    }
    cp->items[cp->count++] = (NodeFsCpItem) {
        .src = src, .dest = dest, .mode = mode, .phase = (u8) phase, .top = top, .set_mode = set_mode};
    return true;
}

// path.posix.normalize; `keep_trailing` preserves a trailing separator as normalize does
// and resolve does not.
static char *node_fs_cp_normalize(const char *path, bool keep_trailing) {
    usize length = strlen(path);
    char *out = malloc(length + 2);
    if (out == nullptr) return nullptr;
    bool absolute = length > 0 && path[0] == '/';
    usize used = 0;
    usize segments = 0;
    for (usize i = 0; i < length;) {
        while (i < length && path[i] == '/') i++;
        usize start = i;
        while (i < length && path[i] != '/') i++;
        usize size = i - start;
        if (size == 0 || (size == 1 && path[start] == '.')) continue;
        if (size == 2 && path[start] == '.' && path[start + 1] == '.') {
            usize last = used;
            while (last > 0 && out[last - 1] != '/') last--;
            bool parent = used - last == 2 && out[last] == '.' && out[last + 1] == '.';
            if (segments > 0 && !parent) {
                used = last > 0 ? last - 1 : 0;
                segments--;
                continue;
            }
            if (absolute) continue;
        }
        if (used > 0) out[used++] = '/';
        memcpy(out + used, path + start, size);
        used += size;
        if (!(size == 2 && path[start] == '.' && path[start + 1] == '.')) segments++;
    }
    if (absolute) {
        memmove(out + 1, out, used);
        out[0] = '/';
        used++;
    } else if (used == 0) {
        out[used++] = '.';
    }
    if (keep_trailing && length > 0 && path[length - 1] == '/' && out[used - 1] != '/') out[used++] = '/';
    out[used] = '\0';
    return out;
}

static char *node_fs_cp_join(const char *left, const char *right) {
    usize capacity = strlen(left) + strlen(right) + 2;
    char *joined = malloc(capacity);
    if (joined == nullptr) return nullptr;
    snprintf(joined, capacity, "%s/%s", left, right);
    char *normalized = node_fs_cp_normalize(joined, true);
    free(joined);
    return normalized;
}

// path.posix.dirname
static char *node_fs_cp_dirname(const char *path) {
    usize length = strlen(path);
    if (length == 0) return strdup(".");
    usize end = length;
    while (end > 1 && path[end - 1] == '/') end--;
    while (end > 0 && path[end - 1] != '/') end--;
    if (end == 0) return strdup(".");
    while (end > 1 && path[end - 1] == '/') end--;
    return strndup(path, end);
}

// path.posix.resolve(base, path) against the current directory.
static char *node_fs_cp_resolve(const char *base, const char *path) {
    if (path[0] == '/') return node_fs_cp_normalize(path, false);
    char cwd[PATH_MAX];
    if (base[0] != '/' && getcwd(cwd, sizeof cwd) == nullptr) cwd[0] = '\0';
    usize capacity = strlen(cwd) + strlen(base) + strlen(path) + 3;
    char *joined = malloc(capacity);
    if (joined == nullptr) return nullptr;
    if (base[0] == '/') snprintf(joined, capacity, "%s/%s", base, path);
    else snprintf(joined, capacity, "%s/%s/%s", cwd, base, path);
    char *resolved = node_fs_cp_normalize(joined, false);
    free(joined);
    return resolved;
}

// Node's isSrcSubdir: every resolved segment of src prefixes dest's.
static bool node_fs_cp_is_subdir(const char *src, const char *dest) {
    char *a = node_fs_cp_resolve(".", src);
    char *b = node_fs_cp_resolve(".", dest);
    bool result = false;
    if (a != nullptr && b != nullptr) {
        usize length = strlen(a);
        result = strcmp(a, "/") == 0
            || (strncmp(a, b, length) == 0 && (b[length] == '/' || b[length] == '\0'));
    }
    free(a);
    free(b);
    return result;
}

static bool node_fs_cp_identical(const MalPosixStat *src, const MalPosixStat *dest) {
    return dest->ino != 0 && dest->dev != 0 && dest->ino == src->ino && dest->dev == src->dev;
}

static int node_fs_cp_stat(const NodeFsCp *cp, const char *path, MalPosixStat *out) {
    return cp->dereference ? mal_posix_fs_stat(path, out) : mal_posix_fs_lstat(path, out);
}

static NodeFsCpStatus node_fs_cp_set_times(NodeFsCp *cp, const char *src, const char *dest) {
    MalPosixStat st;
    int err = mal_posix_fs_stat(src, &st);
    if (err != 0) return node_fs_cp_errno(cp, err, "stat", src, nullptr);
    // Node copies the millisecond Date values, not the native nanosecond timestamps.
    f64 atime = floor(st.atime_ms / 1000.0);
    f64 mtime = floor(st.mtime_ms / 1000.0);
    err = mal_posix_fs_utimes(dest, (i64) atime, (i64) llround((st.atime_ms - atime * 1000.0) * 1e6),
        (i64) mtime, (i64) llround((st.mtime_ms - mtime * 1000.0) * 1e6));
    if (err != 0) return node_fs_cp_errno(cp, err, "utime", dest, nullptr);
    return NODE_FS_CP_DONE;
}

static NodeFsCpStatus node_fs_cp_copy_file(NodeFsCp *cp, const char *src, const char *dest, u32 mode) {
    int err = mal_posix_fs_copy_file_mode(src, dest, cp->mode);
    if (err != 0) return node_fs_cp_errno(cp, err, "copyfile", src, dest);
    if (cp->preserve_timestamps) {
        if ((mode & 0200) == 0 && (err = mal_posix_fs_chmod(dest, (mode | 0200) & 07777)) != 0) {
            return node_fs_cp_errno(cp, err, "chmod", dest, nullptr);
        }
        if (node_fs_cp_set_times(cp, src, dest) != NODE_FS_CP_DONE) return NODE_FS_CP_FAILED;
    }
    err = mal_posix_fs_chmod(dest, mode & 07777);
    return err == 0 ? NODE_FS_CP_DONE : node_fs_cp_errno(cp, err, "chmod", dest, nullptr);
}

static NodeFsCpStatus node_fs_cp_exists_error(NodeFsCp *cp, const char *dest) {
    return node_fs_cp_fail(cp, "ERR_FS_CP_EEXIST", "Target already exists", "EEXIST", EEXIST, dest,
        "%s already exists", dest);
}

static NodeFsCpStatus node_fs_cp_dir(NodeFsCp *cp, const char *src, const char *dest,
    const MalPosixStat *src_stat, bool dest_exists) {
    if (!dest_exists) {
        int err = mal_posix_fs_mkdir_mode(dest, false, 0777, nullptr);
        if (err != 0) return node_fs_cp_errno(cp, err, "mkdir", dest, nullptr);
        if (!node_fs_cp_push(cp, strdup(src), strdup(dest), NODE_FS_CP_DIR_FINISH, false,
                src_stat->mode, true)) return node_fs_cp_errno(cp, ENOMEM, "cp", src, nullptr);
    } else {
        if (cp->error_on_exist && !cp->force) return node_fs_cp_exists_error(cp, dest);
        if (cp->preserve_timestamps && !node_fs_cp_push(cp, strdup(src), strdup(dest),
                NODE_FS_CP_DIR_FINISH, false, 0, false)) return node_fs_cp_errno(cp, ENOMEM, "cp", src, nullptr);
    }
    MalPosixDirent *entries;
    usize count;
    int err = mal_posix_fs_readdir(src, &entries, &count);
    if (err != 0) return node_fs_cp_errno(cp, err, "opendir", src, nullptr);
    bool ok = true;
    for (usize i = count; ok && i > 0; i--) {
        ok = node_fs_cp_push(cp, node_fs_cp_join(src, entries[i - 1].name),
            node_fs_cp_join(dest, entries[i - 1].name), NODE_FS_CP_CHECK, false, 0, false);
    }
    mal_posix_fs_free_dirents(entries, count);
    return ok ? NODE_FS_CP_DONE : node_fs_cp_errno(cp, ENOMEM, "cp", src, nullptr);
}

static NodeFsCpStatus node_fs_cp_link(NodeFsCp *cp, const char *src, const char *dest, bool dest_exists) {
    byte *bytes;
    usize length;
    int err = mal_posix_fs_readlink(src, &bytes, &length);
    if (err != 0) return node_fs_cp_errno(cp, err, "readlink", src, nullptr);
    char *target = strndup((const char *) bytes, length);
    free(bytes);
    char *resolved_dest = nullptr;
    NodeFsCpStatus status = NODE_FS_CP_DONE;
    if (target == nullptr) return node_fs_cp_errno(cp, ENOMEM, "readlink", src, nullptr);
    if (!cp->verbatim_symlinks && target[0] != '/') {
        char *parent = node_fs_cp_dirname(src);
        char *absolute = parent == nullptr ? nullptr : node_fs_cp_resolve(parent, target);
        free(parent);
        free(target);
        target = absolute;
        if (target == nullptr) return node_fs_cp_errno(cp, ENOMEM, "readlink", src, nullptr);
    }
    if (dest_exists) {
        err = mal_posix_fs_readlink(dest, &bytes, &length);
        if (err != 0 && err != EINVAL) {
            status = node_fs_cp_errno(cp, err, "readlink", dest, nullptr);
            goto done;
        }
    }
    if (dest_exists && err == 0) {
        resolved_dest = strndup((const char *) bytes, length);
        free(bytes);
        if (resolved_dest != nullptr && resolved_dest[0] != '/') {
            char *parent = node_fs_cp_dirname(dest);
            char *absolute = parent == nullptr ? nullptr : node_fs_cp_resolve(parent, resolved_dest);
            free(parent);
            free(resolved_dest);
            resolved_dest = absolute;
        }
        if (resolved_dest == nullptr) {
            status = node_fs_cp_errno(cp, ENOMEM, "readlink", dest, nullptr);
            goto done;
        }
        MalPosixStat st;
        bool src_is_dir = mal_posix_fs_stat(src, &st) == 0 && st.type == MAL_POSIX_FT_DIR;
        if (src_is_dir && node_fs_cp_is_subdir(target, resolved_dest)) {
            status = node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", "Invalid src or dest", "EINVAL", EINVAL,
                dest, "cannot copy %s to a subdirectory of self %s", target, resolved_dest);
            goto done;
        }
        bool overwrites_dir = src_is_dir;
        if (cp->sync) {
            err = mal_posix_fs_stat(dest, &st);
            if (err != 0) {
                status = node_fs_cp_errno(cp, err, "stat", dest, nullptr);
                goto done;
            }
            overwrites_dir = st.type == MAL_POSIX_FT_DIR;
        }
        if (overwrites_dir && node_fs_cp_is_subdir(resolved_dest, target)) {
            status = node_fs_cp_fail(cp, "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY",
                "Cannot overwrite symlink in subdirectory of self", "EINVAL", EINVAL, dest,
                "cannot overwrite %s with %s", resolved_dest, target);
            goto done;
        }
        err = mal_posix_fs_unlink(dest);
        if (err != 0) {
            status = node_fs_cp_errno(cp, err, "unlink", dest, nullptr);
            goto done;
        }
    }
    err = mal_posix_fs_symlink(target, dest);
    if (err != 0) status = node_fs_cp_errno(cp, err, "symlink", target, dest);
done:
    free(target);
    free(resolved_dest);
    return status;
}

// cpSyncCheckPaths: Node's native checks report plain coded Errors, and a source directory
// is printed with a trailing separator.
static NodeFsCpStatus node_fs_cp_check_sync(NodeFsCp *cp, const char *src, const char *dest,
    const MalPosixStat *src_stat, const MalPosixStat *dest_stat, bool dest_exists) {
    bool src_dir = src_stat->type == MAL_POSIX_FT_DIR;
    if (dest_exists) {
        bool dest_dir = dest_stat->type == MAL_POSIX_FT_DIR;
        if (node_fs_cp_identical(src_stat, dest_stat)) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", nullptr, nullptr, EINVAL, nullptr,
                "src and dest cannot be the same %s", dest);
        }
        if (src_dir && !dest_dir) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_DIR_TO_NON_DIR", nullptr, nullptr, EISDIR, nullptr,
                "Cannot overwrite non-directory %s with directory %s", dest, src);
        }
        if (!src_dir && dest_dir) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_NON_DIR_TO_DIR", nullptr, nullptr, ENOTDIR, nullptr,
                "Cannot overwrite directory %s with non-directory %s", dest, src);
        }
    }
    if (!src_dir) return NODE_FS_CP_DONE;
    usize length = strlen(src);
    bool slash = length > 0 && src[length - 1] == '/';
    const char *separator = slash ? "" : "/";
    if (strncmp(dest, src, length) == 0 && (slash || dest[length] == '/')) {
        return node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", nullptr, nullptr, EINVAL, nullptr,
            "Cannot copy %s%s to a subdirectory of self %s", src, separator, dest);
    }
    if (!cp->recursive) {
        return node_fs_cp_fail(cp, "ERR_FS_EISDIR", nullptr, nullptr, EISDIR, nullptr,
            "Recursive option not enabled, cannot copy a directory: %s%s", src, separator);
    }
    return NODE_FS_CP_DONE;
}

// checkPaths and, for the top-level call, checkParentPaths of Node's promise-based cp.
static NodeFsCpStatus node_fs_cp_check(NodeFsCp *cp, const char *src, const char *dest,
    const MalPosixStat *src_stat, const MalPosixStat *dest_stat, bool dest_exists, bool top) {
    bool src_dir = src_stat->type == MAL_POSIX_FT_DIR;
    if (dest_exists) {
        bool dest_dir = dest_stat->type == MAL_POSIX_FT_DIR;
        if (node_fs_cp_identical(src_stat, dest_stat)) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", "Invalid src or dest", "EINVAL", EINVAL,
                dest, "src and dest cannot be the same");
        }
        if (src_dir && !dest_dir) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_DIR_TO_NON_DIR",
                "Cannot overwrite non-directory with directory", "EISDIR", EISDIR, dest,
                "cannot overwrite non-directory %s with directory %s", dest, src);
        }
        if (!src_dir && dest_dir) {
            return node_fs_cp_fail(cp, "ERR_FS_CP_NON_DIR_TO_DIR",
                "Cannot overwrite directory with non-directory", "ENOTDIR", ENOTDIR, dest,
                "cannot overwrite directory %s with non-directory %s", dest, src);
        }
    }
    if (src_dir && node_fs_cp_is_subdir(src, dest)) {
        return node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", "Invalid src or dest", "EINVAL", EINVAL, dest,
            "cannot copy %s to a subdirectory of self %s", src, dest);
    }
    if (!top) return NODE_FS_CP_DONE;
    char *src_dir_name = node_fs_cp_dirname(src);
    char *src_parent = src_dir_name == nullptr ? nullptr : node_fs_cp_resolve(".", src_dir_name);
    free(src_dir_name);
    char *current = strdup(dest);
    NodeFsCpStatus status = NODE_FS_CP_DONE;
    while (src_parent != nullptr && current != nullptr) {
        char *dir_name = node_fs_cp_dirname(current);
        char *parent = dir_name == nullptr ? nullptr : node_fs_cp_resolve(".", dir_name);
        free(dir_name);
        if (parent == nullptr || strcmp(parent, src_parent) == 0 || strcmp(parent, "/") == 0) {
            free(parent);
            break;
        }
        MalPosixStat st;
        int err = mal_posix_fs_stat(parent, &st);
        if (err == 0 && node_fs_cp_identical(src_stat, &st)) {
            status = node_fs_cp_fail(cp, "ERR_FS_CP_EINVAL", "Invalid src or dest", "EINVAL", EINVAL,
                current, "cannot copy %s to a subdirectory of self %s", src, current);
        } else if (err != 0 && err != ENOENT) {
            status = node_fs_cp_errno(cp, err, "stat", parent, nullptr);
        }
        free(current);
        current = parent;
        if (err != 0 || status != NODE_FS_CP_DONE) break;
    }
    free(src_parent);
    free(current);
    return status;
}

static NodeFsCpStatus node_fs_cp_entry(NodeFsCp *cp, const char *src, const char *dest, bool top) {
    const char *stat_syscall = cp->dereference ? "stat" : "lstat";
    MalPosixStat src_stat;
    MalPosixStat dest_stat;
    int err = node_fs_cp_stat(cp, src, &src_stat);
    if (err != 0) return node_fs_cp_errno(cp, err, stat_syscall, src, nullptr);
    err = node_fs_cp_stat(cp, dest, &dest_stat);
    if (err != 0 && err != ENOENT) return node_fs_cp_errno(cp, err, stat_syscall, dest, nullptr);
    bool dest_exists = err == 0;
    NodeFsCpStatus status = NODE_FS_CP_DONE;
    if (cp->sync && top) status = node_fs_cp_check_sync(cp, src, dest, &src_stat, &dest_stat, dest_exists);
    else if (!cp->sync) status = node_fs_cp_check(cp, src, dest, &src_stat, &dest_stat, dest_exists, top);
    if (status != NODE_FS_CP_DONE) return status;
    if (top) {
        char *parent = node_fs_cp_dirname(dest);
        if (parent == nullptr) return node_fs_cp_errno(cp, ENOMEM, "mkdir", dest, nullptr);
        MalPosixStat st;
        err = mal_posix_fs_stat(parent, &st);
        if (err == ENOENT) err = mal_posix_fs_mkdir_mode(parent, true, 0777, nullptr);
        if (err != 0) status = node_fs_cp_errno(cp, err, "mkdir", parent, nullptr);
        free(parent);
        if (status != NODE_FS_CP_DONE) return status;
    }
    switch (src_stat.type) {
        case MAL_POSIX_FT_DIR:
            if (!cp->recursive) {
                return node_fs_cp_fail(cp, "ERR_FS_EISDIR", "Path is a directory", "EISDIR", EISDIR,
                    src, "%s is a directory (not copied)", src);
            }
            return node_fs_cp_dir(cp, src, dest, &src_stat, dest_exists);
        case MAL_POSIX_FT_FILE:
        case MAL_POSIX_FT_BLOCK:
        case MAL_POSIX_FT_CHARACTER:
            if (!dest_exists) return node_fs_cp_copy_file(cp, src, dest, src_stat.mode);
            if (cp->force) {
                err = mal_posix_fs_unlink(dest);
                if (err != 0) return node_fs_cp_errno(cp, err, "unlink", dest, nullptr);
                return node_fs_cp_copy_file(cp, src, dest, src_stat.mode);
            }
            return cp->error_on_exist ? node_fs_cp_exists_error(cp, dest) : NODE_FS_CP_DONE;
        case MAL_POSIX_FT_SYMLINK:
            return node_fs_cp_link(cp, src, dest, dest_exists);
        case MAL_POSIX_FT_SOCKET:
            return node_fs_cp_fail(cp, "ERR_FS_CP_SOCKET", "Cannot copy a socket file", "EINVAL",
                EINVAL, dest, "cannot copy a socket file: %s", dest);
        case MAL_POSIX_FT_FIFO:
            return node_fs_cp_fail(cp, "ERR_FS_CP_FIFO_PIPE", "Cannot copy a FIFO pipe", "EINVAL",
                EINVAL, dest, "cannot copy a FIFO pipe: %s", dest);
        default:
            return node_fs_cp_fail(cp, "ERR_FS_CP_UNKNOWN", "Cannot copy an unknown file type",
                "EINVAL", EINVAL, dest, "cannot copy an unknown file type: %s", dest);
    }
}

// Runs until done or failed, or until the next item needs the filter's answer.
static NodeFsCpStatus node_fs_cp_run(NodeFsCp *cp) {
    while (cp->count > 0) {
        NodeFsCpItem item = cp->items[cp->count - 1];
        bool check = item.phase == NODE_FS_CP_CHECK;
        if (check && cp->filter && !cp->filter_answered) return NODE_FS_CP_FILTER;
        cp->count--;
        NodeFsCpStatus status = NODE_FS_CP_DONE;
        if (!check) {
            if (cp->preserve_timestamps) status = node_fs_cp_set_times(cp, item.src, item.dest);
            int err = status == NODE_FS_CP_DONE && item.set_mode
                ? mal_posix_fs_chmod(item.dest, item.mode & 07777) : 0;
            if (err != 0) status = node_fs_cp_errno(cp, err, "chmod", item.dest, nullptr);
        } else {
            bool copy = !cp->filter || cp->filter_result;
            cp->filter_answered = false;
            if (copy) status = node_fs_cp_entry(cp, item.src, item.dest, item.top);
        }
        free(item.src);
        free(item.dest);
        if (status != NODE_FS_CP_DONE) return status;
    }
    return NODE_FS_CP_DONE;
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

static MalValue node_fs_stream_get(MalVm *vm, MalValue state, const char *name);
static void node_fs_stream_set(MalVm *vm, MalValue state, const char *name, MalValue value);

#define NODE_FS_DIR_ENTRIES "__malDirEntries"
#define NODE_FS_DIR_INDEX "__malDirIndex"

static bool node_fs_dir_open(MalVm *vm, MalValue self, bool throw_closed) {
    MalValue entries = mal_value_new_undefined();
    if (mal_value_is_object(self)) {
        mal_vm_get_property(vm, self, mal_intrinsic_string_key(vm, NODE_FS_DIR_ENTRIES), &entries);
    }
    if (mal_value_is_array_object(entries)) return true;
    if (throw_closed) {
        node_fs_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Directory handle was closed",
            "ERR_DIR_CLOSED");
    }
    return false;
}

static MalValue node_fs_dir_closed_error(MalVm *vm) {
    node_fs_dir_open(vm, mal_value_new_undefined(), true);
    MalValue error = vm->completion.value;
    node_fs_clear_completion(vm);
    return error;
}

static MalValue node_fs_dir_next_entry(MalVm *vm, MalValue self) {
    MalValue entries = node_fs_stream_get(vm, self, NODE_FS_DIR_ENTRIES);
    i32 index = mal_value_to_i32(node_fs_stream_get(vm, self, NODE_FS_DIR_INDEX));
    if ((u32) index >= mal_array_object_length(mal_value_to_array_object(entries))) {
        return mal_value_new_null();
    }
    node_fs_stream_set(vm, self, NODE_FS_DIR_INDEX, mal_value_from_i32(index + 1));
    return node_fs_array_get(entries, (u32) index);
}

static void node_fs_dir_mark_closed(MalVm *vm, MalValue self) {
    node_fs_stream_set(vm, self, NODE_FS_DIR_ENTRIES, mal_value_new_null());
}

static MalValue node_fs_settled_promise(MalVm *vm, MalValue value, bool fulfilled) {
    MalValue roots[] = {value, mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (fulfilled) mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    else mal_promise_reject(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue node_fs_dir_callback_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(task, 0),
        mal_native_function_object_get_slot(task, 1), mal_native_function_object_get_slot(task, 2)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    i32 count = mal_value_is_null(roots[1]) && !mal_value_is_undefined(roots[2]) ? 2 : 1;
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), roots + 1, count);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Node delivers Dir callbacks asynchronously even when the result is already known. */
static void node_fs_dir_defer_callback(MalVm *vm, MalValue callback, MalValue error, MalValue value) {
    MalValue slots[] = {callback, error, value};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, ""), node_fs_dir_callback_task, slots, countof(slots)));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static bool node_fs_dir_callback_argument(MalVm *vm, const MalValue *args, i32 argc,
    MalValue *callback) {
    *callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(*callback) || mal_value_is_callable(*callback)) return true;
    node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "The \"callback\" argument must be of type function", "ERR_INVALID_ARG_TYPE");
    return false;
}

static MalValue node_fs_dir_read_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    if (!node_fs_dir_open(vm, self, true)) return mal_value_new_undefined();
    return node_fs_dir_next_entry(vm, self);
}

static MalValue node_fs_dir_read(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue callback;
    if (!node_fs_dir_open(vm, self, true)
        || !node_fs_dir_callback_argument(vm, args, argc, &callback)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {callback, node_fs_dir_next_entry(vm, self)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (mal_value_is_undefined(roots[0])) result = node_fs_settled_promise(vm, roots[1], true);
    else node_fs_dir_defer_callback(vm, roots[0], mal_value_new_null(), roots[1]);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_dir_close_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    if (node_fs_dir_open(vm, self, true)) node_fs_dir_mark_closed(vm, self);
    return mal_value_new_undefined();
}

static MalValue node_fs_dir_close(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue callback;
    if (!node_fs_dir_callback_argument(vm, args, argc, &callback)) return mal_value_new_undefined();
    MalValue roots[] = {callback, mal_value_new_null()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool open = node_fs_dir_open(vm, self, false);
    if (open) node_fs_dir_mark_closed(vm, self);
    else roots[1] = node_fs_dir_closed_error(vm);
    MalValue result = mal_value_new_undefined();
    if (!mal_value_is_undefined(roots[0])) {
        node_fs_dir_defer_callback(vm, roots[0], roots[1], mal_value_new_undefined());
    } else {
        result = node_fs_settled_promise(vm, open ? mal_value_new_undefined() : roots[1], open);
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_dir_iterator_next(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0), mal_value_new_null()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (node_fs_dir_open(vm, roots[0], false)) roots[1] = node_fs_dir_next_entry(vm, roots[0]);
    // Exhausting the iterator closes the directory, as Node's async generator does.
    if (mal_value_is_null(roots[1])) {
        node_fs_dir_mark_closed(vm, roots[0]);
        roots[1] = mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    } else {
        roots[1] = mal_vm_create_iter_result(vm, roots[1], false);
    }
    MalValue result = node_fs_settled_promise(vm, roots[1], true);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_dir_iterator_return(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue dir = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    node_fs_dir_mark_closed(vm, dir);
    MalValue done = mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    MalRootSpan root;
    mal_gc_root(&root, &done, 1);
    MalValue result = node_fs_settled_promise(vm, done, true);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_dir_async_iterator(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue roots[] = {self, mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE]))),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    roots[2] = node_fs_make_fn_slot(vm, fn_proto, "next", 0, node_fs_dir_iterator_next, roots[0]);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "next", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[2] = node_fs_make_fn_slot(vm, fn_proto, "return", 0, node_fs_dir_iterator_return, roots[0]);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "return", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[1];
}

/* Slot 0 holds Dir.prototype and slot 1 Dirent.prototype. The listing is read eagerly. */
static MalValue node_fs_opendir_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *path = node_fs_path_cstr(vm, roots[0]);
    if (path == nullptr) goto failed;
    roots[0] = node_fs_string_from_cstr(vm, path);
    roots[1] = node_fs_directory_entries(vm, path, true,
        mal_value_to_object(mal_native_function_object_get_slot(function, 1)), "opendir");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(mal_native_function_object_get_slot(function, 0))));
    MalObject *dir = mal_value_to_object(roots[2]);
    mal_intrinsic_define_data(vm, dir, NODE_FS_DIR_ENTRIES, roots[1], MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, dir, NODE_FS_DIR_INDEX, mal_value_from_i32(0),
        MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, dir, "path", roots[0], MAL_PROPERTY_NONE);
    mal_gc_unroot(&root);
    return roots[2];
failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_dir_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "The \"handle\" argument must be specified", "ERR_MISSING_ARGS");
    return mal_value_new_undefined();
}

static MalValue node_fs_errno_value(
    MalVm *vm, int error, const char *syscall, const char *path);

typedef enum NodeFsJobKind {
    NODE_FS_JOB_WRITE,
    NODE_FS_JOB_ACCESS,
    NODE_FS_JOB_UNLINK,
    NODE_FS_JOB_RENAME,
    NODE_FS_JOB_MKDTEMP,
    NODE_FS_JOB_FSYNC,
    NODE_FS_JOB_FDATASYNC,
    NODE_FS_JOB_OPEN,
    NODE_FS_JOB_CLOSE,
    NODE_FS_JOB_READ,
    NODE_FS_JOB_LSTAT,
    NODE_FS_JOB_FSTAT,
    NODE_FS_JOB_REALPATH,
    NODE_FS_JOB_REALPATH_NATIVE,
    NODE_FS_JOB_MKDIR,
    NODE_FS_JOB_COPY_FILE,
    NODE_FS_JOB_RM,
    NODE_FS_JOB_RMDIR,
    NODE_FS_JOB_CHMOD,
    NODE_FS_JOB_FCHMOD,
    NODE_FS_JOB_UTIMES,
    NODE_FS_JOB_FUTIMES,
    NODE_FS_JOB_LUTIMES,
    NODE_FS_JOB_TRUNCATE,
    NODE_FS_JOB_FTRUNCATE,
    NODE_FS_JOB_CHOWN,
    NODE_FS_JOB_FCHOWN,
    NODE_FS_JOB_LCHOWN,
    NODE_FS_JOB_EXISTS,
    NODE_FS_JOB_READV,
    NODE_FS_JOB_WRITEV,
    NODE_FS_JOB_STATFS,
    NODE_FS_JOB_CP,
} NodeFsJobKind;

typedef struct NodeFsJob {
    NodeFsJobKind kind;
    char *path;
    char *destination;
    char *created;
    byte *bytes;
    usize length;
    usize offset;
    usize count;
    i64 position;
    i64 times[4];
    i64 retries;
    i64 delay;
    MalPosixStat stat;
    MalPosixStatFs statfs;
    int fd;
    u32 flags;
    u32 mode;
    u32 uid;
    u32 gid;
    bool native_flags;
    bool close_fd;
    bool flush;
    bool has_position;
    bool recursive;
    bool force;
    bool buffer_result;
    int error;
    const char *syscall;
    NodeFsCp *cp;
} NodeFsJob;

typedef struct NodeFsPending {
    struct NodeFsPending *next;
    MalVm *vm;
    MalHostHandle operation;
    MalValue completion;
    MalValue encoding;
    MalValue extra;
    bool callback;
    const char *syscall;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} NodeFsPending;

// Pending operations and their root registration belong to this mutator's isolate.
static MAL_ISOLATE_LOCAL NodeFsPending *node_fs_pending;
static MAL_ISOLATE_LOCAL bool node_fs_async_installed;

static void node_fs_job_clear(NodeFsJob *job) {
    node_fs_cp_free(job->cp);
    free(job->path);
    free(job->destination);
    free(job->created);
    free(job->bytes);
}

static void node_fs_job_free(void *data) {
    node_fs_job_clear(data);
    free(data);
}

static const char *node_fs_job_syscall(NodeFsJobKind kind) {
    switch (kind) {
        case NODE_FS_JOB_WRITE: return "write";
        case NODE_FS_JOB_ACCESS: return "access";
        case NODE_FS_JOB_UNLINK: return "unlink";
        case NODE_FS_JOB_RENAME: return "rename";
        case NODE_FS_JOB_MKDTEMP: return "mkdtemp";
        case NODE_FS_JOB_FSYNC: return "fsync";
        case NODE_FS_JOB_FDATASYNC: return "fdatasync";
        case NODE_FS_JOB_OPEN: return "open";
        case NODE_FS_JOB_CLOSE: return "close";
        case NODE_FS_JOB_READ: return "read";
        case NODE_FS_JOB_LSTAT: return "lstat";
        case NODE_FS_JOB_FSTAT: return "fstat";
        case NODE_FS_JOB_REALPATH: return "lstat";
        case NODE_FS_JOB_REALPATH_NATIVE: return "realpath";
        case NODE_FS_JOB_MKDIR: return "mkdir";
        case NODE_FS_JOB_COPY_FILE: return "copyfile";
        case NODE_FS_JOB_RM: return "rm";
        case NODE_FS_JOB_RMDIR: return "rmdir";
        case NODE_FS_JOB_CHMOD: return "chmod";
        case NODE_FS_JOB_FCHMOD: return "fchmod";
        case NODE_FS_JOB_UTIMES: return "utime";
        case NODE_FS_JOB_FUTIMES: return "futime";
        case NODE_FS_JOB_LUTIMES: return "lutime";
        case NODE_FS_JOB_TRUNCATE: return "open";
        case NODE_FS_JOB_FTRUNCATE: return "ftruncate";
        case NODE_FS_JOB_CHOWN: return "chown";
        case NODE_FS_JOB_FCHOWN: return "fchown";
        case NODE_FS_JOB_LCHOWN: return "lchown";
        case NODE_FS_JOB_EXISTS: return "access";
        case NODE_FS_JOB_READV: return "read";
        case NODE_FS_JOB_WRITEV: return "write";
        case NODE_FS_JOB_STATFS: return "statfs";
        case NODE_FS_JOB_CP: return "cp";
    }
    return "unknown";
}

// Node's JavaScript realpath walks the path with lstat and reports the first missing prefix.
static void node_fs_realpath_failure(NodeFsJob *job) {
    if (job->error != ENOENT && job->error != ENOTDIR) {
        job->syscall = "realpath";
        return;
    }
    usize length = strlen(job->path);
    for (usize i = 1; i <= length; i++) {
        if (job->path[i] != '/' && job->path[i] != '\0') continue;
        char saved = job->path[i];
        job->path[i] = '\0';
        MalPosixStat st;
        int err = mal_posix_fs_lstat(job->path, &st);
        if (err != 0) {
            job->error = err;
            free(job->created);
            job->created = strdup(job->path);
            job->path[i] = saved;
            return;
        }
        job->path[i] = saved;
    }
}

static void node_fs_job_run(void *data) {
    NodeFsJob *job = data;
    job->syscall = node_fs_job_syscall(job->kind);
    switch (job->kind) {
        case NODE_FS_JOB_OPEN:
            job->error = mal_posix_fs_open(job->path, job->flags, job->native_flags,
                job->mode, &job->fd);
            return;
        case NODE_FS_JOB_CLOSE:
            job->error = mal_posix_fs_close_fd(job->fd);
            return;
        case NODE_FS_JOB_READ:
            job->error = mal_posix_fs_read_fd(job->fd, job->bytes, job->length,
                job->has_position, job->position, &job->count);
            return;
        case NODE_FS_JOB_LSTAT:
            job->error = mal_posix_fs_lstat(job->path, &job->stat);
            return;
        case NODE_FS_JOB_FSTAT:
            job->error = mal_posix_fs_fstat(job->fd, &job->stat);
            return;
        case NODE_FS_JOB_REALPATH:
        case NODE_FS_JOB_REALPATH_NATIVE:
            job->error = mal_posix_fs_realpath(job->path, &job->created);
            if (job->error != 0 && job->kind == NODE_FS_JOB_REALPATH) node_fs_realpath_failure(job);
            return;
        case NODE_FS_JOB_MKDIR:
            job->error = mal_posix_fs_mkdir_mode(job->path, job->recursive, job->mode,
                job->recursive ? &job->created : nullptr);
            return;
        case NODE_FS_JOB_CP:
            job->error = node_fs_cp_run(job->cp) == NODE_FS_CP_DONE ? 0
                : job->cp->error != 0 ? job->cp->error : EIO;
            return;
        case NODE_FS_JOB_COPY_FILE:
            job->error = mal_posix_fs_copy_file_mode(job->path, job->destination, job->mode);
            return;
        case NODE_FS_JOB_RM: {
            MalPosixStat st;
            job->syscall = "lstat";
            job->error = mal_posix_fs_lstat(job->path, &st);
            if (job->error != 0) {
                if (job->force && job->error == ENOENT) job->error = 0;
                return;
            }
            job->syscall = "rm";
            if (st.type == MAL_POSIX_FT_DIR && !job->recursive) {
                job->error = EISDIR;
                return;
            }
            if (!job->recursive) job->syscall = "unlink";
            for (i64 retry = 0;;) {
                job->error = mal_posix_fs_rm(job->path, job->recursive, job->force);
                if (!job->recursive || !node_fs_rm_retryable(job->error)
                    || retry >= job->retries) return;
                mal_posix_fs_sleep_milliseconds(job->delay * ++retry);
            }
        }
        case NODE_FS_JOB_RMDIR:
            job->error = mal_posix_fs_rmdir(job->path);
            return;
        case NODE_FS_JOB_CHMOD:
            job->error = mal_posix_fs_chmod(job->path, job->mode);
            return;
        case NODE_FS_JOB_FCHMOD:
            job->error = mal_posix_fs_fchmod(job->fd, job->mode);
            return;
        case NODE_FS_JOB_UTIMES:
            job->error = mal_posix_fs_utimes(job->path,
                job->times[0], job->times[1], job->times[2], job->times[3]);
            return;
        case NODE_FS_JOB_FUTIMES:
            job->error = mal_posix_fs_futimes(job->fd,
                job->times[0], job->times[1], job->times[2], job->times[3]);
            return;
        case NODE_FS_JOB_LUTIMES:
            job->error = mal_posix_fs_lutimes(job->path,
                job->times[0], job->times[1], job->times[2], job->times[3]);
            return;
        case NODE_FS_JOB_TRUNCATE: {
            int fd;
            job->error = mal_posix_fs_open(job->path,
                MAL_POSIX_OPEN_READ | MAL_POSIX_OPEN_WRITE, false, 0666, &fd);
            if (job->error != 0) return;
            job->syscall = "ftruncate";
            job->error = mal_posix_fs_truncate_fd(fd, job->position);
            int close_error = mal_posix_fs_close_fd(fd);
            if (job->error == 0 && close_error != 0) {
                job->syscall = "close";
                job->error = close_error;
            }
            return;
        }
        case NODE_FS_JOB_FTRUNCATE:
            job->error = mal_posix_fs_truncate_fd(job->fd, job->position);
            return;
        case NODE_FS_JOB_CHOWN:
        case NODE_FS_JOB_LCHOWN:
            job->error = mal_posix_fs_chown(job->path, job->uid, job->gid,
                job->kind == NODE_FS_JOB_CHOWN);
            return;
        case NODE_FS_JOB_FCHOWN:
            job->error = mal_posix_fs_fchown(job->fd, job->uid, job->gid);
            return;
        case NODE_FS_JOB_EXISTS:
            job->error = mal_posix_fs_access(job->path, 0);
            return;
        case NODE_FS_JOB_ACCESS:
            job->syscall = "access";
            job->error = mal_posix_fs_access(job->path, job->mode);
            return;
        case NODE_FS_JOB_UNLINK:
            job->syscall = "unlink";
            job->error = mal_posix_fs_unlink(job->path);
            return;
        case NODE_FS_JOB_RENAME:
            job->syscall = "rename";
            job->error = mal_posix_fs_rename(job->path, job->destination);
            return;
        case NODE_FS_JOB_MKDTEMP:
            job->syscall = "mkdtemp";
            job->error = mal_posix_fs_mkdtemp(job->path, &job->created);
            return;
        case NODE_FS_JOB_FSYNC:
            job->syscall = "fsync";
            job->error = mal_posix_fs_sync_fd(job->fd);
            return;
        case NODE_FS_JOB_FDATASYNC:
            job->syscall = "fdatasync";
            job->error = mal_posix_fs_datasync_fd(job->fd);
            return;
        case NODE_FS_JOB_READV:
            job->error = mal_posix_fs_read_fd(job->fd, job->bytes, job->length,
                job->has_position, job->position, &job->count);
            return;
        case NODE_FS_JOB_WRITEV:
            job->error = mal_posix_fs_write_at_fd(job->fd, job->bytes, job->length,
                job->has_position, job->position, &job->count);
            return;
        case NODE_FS_JOB_STATFS:
            job->error = mal_posix_fs_statfs(job->path, &job->statfs);
            return;
        case NODE_FS_JOB_WRITE:
            break;
    }
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

static void node_fs_cp_scan_drivers(MalVm *vm);

static void node_fs_async_scan_roots(MalVm *vm, void *data) {
    (void) data;
    node_fs_cp_scan_drivers(vm);
    for (NodeFsPending *state = node_fs_pending;
        state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->completion);
        mal_gc_mark_value(state->encoding);
        mal_gc_mark_value(state->extra);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static void node_fs_cp_free_drivers(MalVm *vm);

static void node_fs_async_free(MalVm *vm) {
    node_fs_cp_free_drivers(vm);
    NodeFsPending **link = &node_fs_pending;
    while (*link != nullptr) {
        NodeFsPending *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        *link = state->next;
        free(state);
    }
}

static void node_fs_cp_throw(MalVm *vm, const NodeFsCp *cp);

static void node_fs_job_throw(MalVm *vm, NodeFsJob *job) {
    if (job->kind == NODE_FS_JOB_CP) {
        node_fs_cp_throw(vm, job->cp);
        return;
    }
    if (job->kind == NODE_FS_JOB_RM && job->error == EISDIR) {
        const char *prefix = "Path is a directory: rm returned EISDIR (is a directory) ";
        usize length = strlen(prefix) + strlen(job->path) + 1;
        char *message = malloc(length);
        if (message == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return;
        }
        snprintf(message, length, "%s%s", prefix, job->path);
        node_fs_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message,
            "ERR_FS_EISDIR");
        free(message);
        MalObject *error = mal_value_to_object(vm->completion.value);
        mal_intrinsic_define_data(vm, error, "errno", mal_value_from_i32(EISDIR), NODE_FS_VISIBLE);
        node_fs_define_str(vm, error, "syscall", "rm");
        node_fs_define_str(vm, error, "path", job->path);
        return;
    }
    node_fs_throw_errno_with_dest(vm, job->error, job->syscall,
        strcmp(job->syscall, "close") == 0 ? nullptr
            : job->created != nullptr ? job->created : job->path, job->destination);
}

/* Materialize a successful job's callback values after the error argument; `out` must
 * be rooted. A thrown completion reports a conversion failure. */
static i32 node_fs_job_results(
    MalVm *vm, NodeFsJob *job, MalValue encoding, MalValue extra, MalValue *out) {
    switch (job->kind) {
        case NODE_FS_JOB_MKDTEMP:
        case NODE_FS_JOB_REALPATH:
        case NODE_FS_JOB_REALPATH_NATIVE: {
            usize length = strlen(job->created);
            if (job->buffer_result) {
                out[0] = mal_node_buffer_from_owned_bytes(vm, (byte *) job->created, length);
                job->created = nullptr;
            } else {
                out[0] = mal_node_buffer_encode_bytes(
                    vm, (const byte *) job->created, length, encoding, true);
            }
            return 1;
        }
        case NODE_FS_JOB_MKDIR:
            if (job->created == nullptr) return 0;
            out[0] = node_fs_string_from_cstr(vm, job->created);
            return 1;
        case NODE_FS_JOB_OPEN:
            out[0] = mal_value_from_f64((f64) job->fd);
            return 1;
        case NODE_FS_JOB_LSTAT:
        case NODE_FS_JOB_FSTAT:
            out[0] = node_fs_make_stats(vm, mal_value_to_object(extra), &job->stat);
            return 1;
        case NODE_FS_JOB_READ: {
            MalBufferSourceSpan span;
            if (job->count > 0
                && mal_buffer_source_span(extra, &span) == MAL_BUFFER_SOURCE_SPAN_OK
                && job->offset < span.length) {
                usize available = span.length - job->offset;
                mal_buffer_source_span_write(&span, job->offset, job->bytes,
                    job->count < available ? job->count : available);
            }
            out[0] = mal_value_from_f64((f64) job->count);
            out[1] = extra;
            return 2;
        }
        case NODE_FS_JOB_READV: {
            usize copied = 0;
            u32 count = mal_array_object_length(mal_value_to_array_object(extra));
            for (u32 i = 0; i < count && copied < job->count; i++) {
                MalBufferSourceSpan span;
                if (mal_buffer_source_span(node_fs_array_get(extra, i), &span)
                    != MAL_BUFFER_SOURCE_SPAN_OK) continue;
                usize part = span.length < job->count - copied ? span.length : job->count - copied;
                mal_buffer_source_span_write(&span, 0, job->bytes + copied, part);
                copied += part;
            }
            out[0] = mal_value_from_f64((f64) job->count);
            out[1] = extra;
            return 2;
        }
        case NODE_FS_JOB_WRITEV:
            out[0] = mal_value_from_f64((f64) job->count);
            out[1] = extra;
            return 2;
        case NODE_FS_JOB_STATFS:
            out[0] = node_fs_make_statfs(vm, &job->statfs);
            return 1;
        case NODE_FS_JOB_CP:
            // Node callbackifies cp, so a successful callback receives (null, undefined).
            out[0] = mal_value_new_undefined();
            return 1;
        default:
            return 0;
    }
}

static bool node_fs_async_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    NodeFsPending **link = &node_fs_pending;
    while (*link != nullptr &&
        ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    NodeFsPending *state = *link;
    if (state == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    *link = state->next;
    enum { DRAIN_COMPLETION, DRAIN_ENCODING, DRAIN_EXTRA, DRAIN_ERROR, DRAIN_RESULT };
    MalValue roots[] = {state->completion, state->encoding, state->extra,
        mal_value_new_null(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, state->async_context);
    bool callback = state->callback;
    const char *syscall = state->syscall;
    free(state);
    NodeFsJob *job = mal_blocking_work_result_data(task.data);
    bool cancelled = task.result == MAL_HOST_TERMINAL_CANCELLED;
    if (cancelled) {
        roots[DRAIN_ERROR] = node_fs_errno_value(vm, ECANCELED, syscall, nullptr);
    } else if (job->error != 0) {
        node_fs_job_throw(vm, job);
        roots[DRAIN_ERROR] = vm->completion.value;
        node_fs_clear_completion(vm);
    }
    i32 result_count = 0;
    if (mal_value_is_null(roots[DRAIN_ERROR]) && job != nullptr) {
        result_count = node_fs_job_results(vm, job, roots[DRAIN_ENCODING], roots[DRAIN_EXTRA], roots + DRAIN_RESULT);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            roots[DRAIN_ERROR] = vm->completion.value;
            node_fs_clear_completion(vm);
            result_count = 0;
        }
    }
    if (callback && job != nullptr && job->kind == NODE_FS_JOB_EXISTS) {
        roots[DRAIN_ERROR] = mal_value_new_boolean(!cancelled && job->error == 0);
        mal_vm_call_value(vm, roots[DRAIN_COMPLETION], mal_value_new_undefined(), roots + DRAIN_ERROR, 1);
    } else if (callback) {
        // fs.close accepts an omitted callback.
        if (!mal_value_is_undefined(roots[DRAIN_COMPLETION])) {
            mal_vm_call_value(vm, roots[DRAIN_COMPLETION], mal_value_new_undefined(), roots + DRAIN_ERROR,
                mal_value_is_null(roots[DRAIN_ERROR]) ? 1 + result_count : 1);
        }
    } else {
        MalPromiseObject *promise = mal_value_to_promise_object(roots[DRAIN_COMPLETION]);
        if (mal_value_is_null(roots[DRAIN_ERROR])) {
            mal_promise_fulfill(vm, promise,
                result_count > 0 ? roots[DRAIN_RESULT] : mal_value_new_undefined());
        } else {
            mal_promise_reject(vm, promise, roots[DRAIN_ERROR]);
        }
    }
    mal_async_context_scope_exit(vm, &async_scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static bool node_fs_start_job(
    MalVm *vm, NodeFsJob *job, MalBlockingWorkReservation *reservation,
    MalValue completion, bool callback, MalValue encoding, MalValue extra
) {
    NodeFsPending *state = calloc(1, sizeof(*state));
    if (state == nullptr) {
        node_fs_job_free(job);
        mal_blocking_work_reservation_release(reservation);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    state->vm = vm;
    state->completion = completion;
    state->encoding = encoding;
    state->extra = extra;
    state->callback = callback;
    state->syscall = node_fs_job_syscall(job->kind);
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    usize footprint = sizeof(*job) + job->length
        + (job->path == nullptr ? 0 : strlen(job->path) + 1)
        + (job->destination == nullptr ? 0 : strlen(job->destination) + 1);
    if ((!reservation->active
            && !mal_blocking_work_reserve(mal_host(vm), footprint, reservation))
        || !mal_blocking_work_start(mal_host(vm), node_fs_job_run, job,
            node_fs_job_free, reservation, &state->operation)) {
        node_fs_throw_errno_with_dest(vm, EAGAIN, state->syscall, job->path, job->destination);
        node_fs_job_free(job);
        mal_blocking_work_reservation_release(reservation);
        free(state);
        return false;
    }
    state->next = node_fs_pending;
    node_fs_pending = state;
    return true;
}

static bool node_fs_queue_write(
    MalVm *vm, MalValue completion, bool callback, const MalValue *args, i32 argc, u32 flags) {
    MalBlockingWorkReservation reservation = {0};
    NodeFsJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
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
        &bytes, &job->length, &owned, &reservation);
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
    return node_fs_start_job(vm, job, &reservation, completion, callback,
        mal_value_new_undefined(), mal_value_new_undefined());
failed:
    node_fs_job_free(job);
    mal_blocking_work_reservation_release(&reservation);
    return false;
}

static bool node_fs_queue_job(
    MalVm *vm, NodeFsJobKind kind, char *path, char *destination, u32 mode,
    MalValue completion, bool callback, MalValue encoding, int fd
) {
    NodeFsJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) {
        free(path);
        free(destination);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    job->kind = kind;
    job->fd = fd;
    job->path = path;
    job->destination = destination;
    job->mode = mode;
    MalBlockingWorkReservation reservation = {0};
    return node_fs_start_job(vm, job, &reservation, completion, callback, encoding,
        mal_value_new_undefined());
}

static NodeFsJobKind node_fs_job_kind(MalValue callee) {
    return (NodeFsJobKind) mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0));
}

static MalValue node_fs_path_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    NodeFsJobKind kind = node_fs_job_kind(callee);
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (path == nullptr) goto failed;
    char *destination = nullptr;
    if (kind == NODE_FS_JOB_RENAME) {
        destination = node_fs_path_cstr(vm, argc > 1 ? args[1] : mal_value_new_undefined());
        if (destination == nullptr) { free(path); goto failed; }
    }
    MalValue mode = argc > 1 ? args[1] : mal_value_new_undefined();
    bool omitted_mode = kind == NODE_FS_JOB_ACCESS && mal_value_is_callable(mode);
    i32 callback_index = kind == NODE_FS_JOB_UNLINK || omitted_mode ? 1 : 2;
    roots[1] = argc > callback_index ? args[callback_index] : mal_value_new_undefined();
    if (!mal_value_is_callable(roots[1])) {
        free(path);
        free(destination);
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The callback argument must be a function", "ERR_INVALID_ARG_TYPE");
        goto failed;
    }
    u32 access_mode = 0;
    if (kind == NODE_FS_JOB_ACCESS && !node_fs_access_mode(
            vm, omitted_mode ? mal_value_new_undefined() : mode, &access_mode)) {
        free(path);
        free(destination);
        goto failed;
    }
    if (!node_fs_queue_job(vm, kind, path, destination, access_mode, roots[1], true, mal_value_new_undefined(), -1)) goto failed;
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_path_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target;
    NodeFsJobKind kind = node_fs_job_kind(callee);
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, &promise, 1);
    char *path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    char *destination = nullptr;
    u32 mode = 0;
    bool started = false;
    if (path != nullptr) {
        bool valid = true;
        if (kind == NODE_FS_JOB_RENAME) {
            destination = node_fs_path_cstr(vm, argc > 1 ? args[1] : mal_value_new_undefined());
            valid = destination != nullptr;
        } else if (kind == NODE_FS_JOB_ACCESS) {
            valid = node_fs_access_mode(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &mode);
        }
        if (valid) {
            started = node_fs_queue_job(vm, kind, path, destination, mode, promise, false, mal_value_new_undefined(), -1);
        } else {
            free(path);
            free(destination);
        }
    }
    if (!started) {
        MalValue error = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(promise), error);
    }
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_sync_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    MalValue roots[] = {mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(vm, new_target,
                MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    if (!mal_value_is_callable(roots[1])) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The callback argument must be a function", "ERR_INVALID_ARG_TYPE");
        goto failed;
    }
    int fd;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &fd)) goto failed;
    if (!node_fs_queue_job(vm, node_fs_job_kind(callee), nullptr, nullptr, 0,
            roots[1], true, mal_value_new_undefined(), fd)) goto failed;
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_mkdtemp_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) callee;
    MalValue roots[] = {mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(vm, new_target,
                MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) goto failed;
        roots[0] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    roots[2] = mal_value_is_callable(roots[1]) ? roots[1]
        : argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_value_is_callable(roots[2])) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The callback argument must be a function", "ERR_INVALID_ARG_TYPE");
        goto failed;
    }
    if (!node_fs_mkdtemp_options(vm, roots + 1)) goto failed;
    char *prefix = node_fs_mkdtemp_prefix(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        roots[1], roots + 3);
    if (prefix == nullptr) goto failed;
    if (!node_fs_queue_job(vm, NODE_FS_JOB_MKDTEMP, prefix, nullptr, 0,
            roots[2], true, roots[3], -1)) goto failed;
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool node_fs_cp_options(MalVm *vm, MalValue options, NodeFsCp *cp, MalValue *filter) {
    cp->force = true;
    *filter = mal_value_new_undefined();
    if (mal_value_is_undefined(options)) return true;
    if (!mal_value_is_object(options) || mal_value_is_array_object(options) || mal_value_is_callable(options)) {
        mal_node_throw_invalid_arg_type(vm, "options", "of type object", options);
        return false;
    }
    static const char *const names[] = {"options.dereference", "options.errorOnExist", "options.force",
        "options.preserveTimestamps", "options.recursive", "options.verbatimSymlinks"};
    bool *flags[] = {&cp->dereference, &cp->error_on_exist, &cp->force, &cp->preserve_timestamps,
        &cp->recursive, &cp->verbatim_symlinks};
    for (usize i = 0; i < countof(names); i++) {
        MalValue value;
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, names[i] + 8), &value)) return false;
        if (mal_value_is_undefined(value)) continue;
        if (!mal_value_is_boolean(value)) {
            mal_node_throw_invalid_arg_type(vm, names[i], "of type boolean", value);
            return false;
        }
        *flags[i] = mal_value_is_truthy(value);
    }
    MalValue mode;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "mode"), &mode)) return false;
    if (!mal_value_is_undefined(mode)) {
        f64 number;
        if (!mal_node_validate_integer(vm, mode, "mode", 0, 7, &number)) return false;
        cp->mode = (u32) number;
    }
    if (cp->dereference && cp->verbatim_symlinks) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Option \"dereference\" cannot be used in combination with option \"verbatimSymlinks\"",
            "ERR_INCOMPATIBLE_OPTION_PAIR");
        return false;
    }
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "filter"), filter)) return false;
    if (!mal_value_is_undefined(*filter) && !mal_value_is_callable(*filter)) {
        mal_node_throw_invalid_arg_type(vm, "options.filter", "of type function", *filter);
        return false;
    }
    return true;
}

static char *node_fs_cp_path(MalVm *vm, MalValue value, const char *name) {
    char *path;
    NodeFsPathResult result = node_fs_path_bytes(vm, value, false, &path);
    if (result == NODE_FS_PATH_OK) return path;
    if (vm->completion.kind == MAL_COMPLETION_THROW) return nullptr;
    if (result == NODE_FS_PATH_INVALID_TYPE) {
        mal_node_throw_invalid_arg_type(vm, name, "of type string or an instance of Buffer or URL", value);
    } else if (result == NODE_FS_PATH_EMBEDDED_NUL) {
        char message[128];
        snprintf(message, sizeof message,
            "The argument '%s' must be a string, Uint8Array, or URL without null bytes", name);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
    } else {
        mal_vm_throw_allocation_error(vm);
    }
    return nullptr;
}

// Validates like Node: options first, then src and dest.
static NodeFsCp *node_fs_cp_new(MalVm *vm, MalValue src, MalValue dest, MalValue options,
    bool sync, MalValue *filter) {
    NodeFsCp *cp = calloc(1, sizeof(*cp));
    if (cp == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    cp->sync = sync;
    char *src_path = nullptr;
    char *dest_path = nullptr;
    if (!node_fs_cp_options(vm, options, cp, filter)
        || (src_path = node_fs_cp_path(vm, src, "src")) == nullptr
        || (dest_path = node_fs_cp_path(vm, dest, "dest")) == nullptr) {
        free(src_path);
        node_fs_cp_free(cp);
        return nullptr;
    }
    cp->filter = mal_value_is_callable(*filter);
    if (!node_fs_cp_push(cp, src_path, dest_path, NODE_FS_CP_CHECK, true, 0, false)) {
        node_fs_cp_free(cp);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return cp;
}

static void node_fs_cp_throw(MalVm *vm, const NodeFsCp *cp) {
    if (cp->code == nullptr) {
        node_fs_throw_errno_with_dest(vm, cp->error, cp->syscall, cp->path, cp->dest);
        return;
    }
    const char *message = cp->message == nullptr ? "" : cp->message;
    if (cp->prefix == nullptr) {
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, cp->code);
        return;
    }
    const char *path = cp->path == nullptr ? "" : cp->path;
    usize length = strlen(cp->prefix) + strlen(cp->info_code) + strlen(message) + strlen(path) + 32;
    char *full = malloc(length);
    if (full == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    snprintf(full, length, "%s: cp returned %s (%s) %s", cp->prefix, cp->info_code, message, path);
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, full, cp->code);
    free(full);
    MalValue roots[] = {vm->completion.value, mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *error = mal_value_to_object(roots[0]);
    MalObject *info = mal_value_to_object(roots[1]);
    node_fs_define_str(vm, info, "message", message);
    node_fs_define_str(vm, info, "path", path);
    node_fs_define_str(vm, info, "syscall", "cp");
    mal_intrinsic_define_data(vm, info, "errno", mal_value_from_i32(cp->error), NODE_FS_VISIBLE);
    node_fs_define_str(vm, info, "code", cp->info_code);
    mal_intrinsic_define_data(vm, error, "info", roots[1], NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, error, "errno", mal_value_from_i32(cp->error), NODE_FS_VISIBLE);
    node_fs_define_str(vm, error, "syscall", "cp");
    node_fs_define_str(vm, error, "path", path);
    roots[1] = mal_value_from_string(mal_intrinsic_ascii(vm, "SystemError"));
    mal_intrinsic_define_data(vm, error, "name", roots[1], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[0]};
    mal_gc_unroot(&root);
}

// Calls the filter for the pending top item; false leaves its throw in the completion.
static bool node_fs_cp_call_filter(MalVm *vm, const NodeFsCp *cp, MalValue filter, MalValue *out) {
    const NodeFsCpItem *item = &cp->items[cp->count - 1];
    MalValue args[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    args[0] = node_fs_string_from_cstr(vm, item->src);
    args[1] = node_fs_string_from_cstr(vm, item->dest);
    MalCompletion completion = mal_vm_call_value(vm, filter, mal_value_new_undefined(), args, 2);
    mal_gc_unroot(&root);
    if (completion.kind == MAL_COMPLETION_THROW) return false;
    *out = completion.value;
    return true;
}

static MalValue node_fs_cp_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue filter = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &filter, 1);
    NodeFsCp *cp = node_fs_cp_new(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined(),
        true, &filter);
    while (cp != nullptr) {
        NodeFsCpStatus status = node_fs_cp_run(cp);
        if (status == NODE_FS_CP_FAILED) node_fs_cp_throw(vm, cp);
        if (status != NODE_FS_CP_FILTER) break;
        MalValue result;
        if (!node_fs_cp_call_filter(vm, cp, filter, &result)) break;
        if (mal_value_is_promise_object(result)) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Expected boolean to be returned from the \"filter\" function but got an instance of Promise.",
                "ERR_INVALID_RETURN_VALUE");
            break;
        }
        cp->filter_result = mal_value_is_truthy(result);
        cp->filter_answered = true;
    }
    node_fs_cp_free(cp);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

// Slots: [callback, mode]; mode 0 passes the argument alone, 1 passes (null, argument).
static MalValue node_fs_deferred_callback(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue callback = mal_native_function_object_get_slot(function, 0);
    bool with_null = mal_value_to_i32(mal_native_function_object_get_slot(function, 1)) == 1;
    MalValue argument = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue call_args[] = {with_null ? mal_value_new_null() : argument, argument};
    MalCompletion completion = mal_vm_call_value(vm, callback, mal_value_new_undefined(), call_args,
        with_null ? 2 : 1);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

// Calls `callback` from a microtask; a throw rejects an unobserved promise, as Node's
// `.then(callback, callback)` does.
static void node_fs_defer_callback(MalVm *vm, MalValue callback, bool with_null, MalValue argument) {
    MalValue roots[] = {callback, argument, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue slots[] = {callback, mal_value_from_i32(with_null ? 1 : 0)};
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "callback"), node_fs_deferred_callback, slots, countof(slots)));
    mal_promise_new_direct_capability(vm, &roots[3], &roots[4], &roots[5]);
    mal_vm_enqueue_reaction_job(vm, roots[2], false, roots[4], roots[5], roots[1]);
    mal_gc_unroot(&root);
}

typedef struct NodeFsCpDriver {
    struct NodeFsCpDriver *next;
    MalVm *vm;
    NodeFsCp *cp;
    MalValue filter;
    MalValue completion;
    bool callback;
    u32 id;
    // Identifies the pending filter result, so a thenable settling twice answers once.
    u32 step;
} NodeFsCpDriver;

// Filtered asynchronous copies run on the mutator between filter results.
static MAL_ISOLATE_LOCAL NodeFsCpDriver *node_fs_cp_drivers;
static MAL_ISOLATE_LOCAL u32 node_fs_cp_next_id;

static void node_fs_cp_scan_drivers(MalVm *vm) {
    for (NodeFsCpDriver *driver = node_fs_cp_drivers; driver != nullptr; driver = driver->next) {
        if (driver->vm != vm) continue;
        mal_gc_mark_value(driver->filter);
        mal_gc_mark_value(driver->completion);
    }
}

static void node_fs_cp_free_drivers(MalVm *vm) {
    NodeFsCpDriver **link = &node_fs_cp_drivers;
    while (*link != nullptr) {
        NodeFsCpDriver *driver = *link;
        if (driver->vm != vm) {
            link = &driver->next;
            continue;
        }
        *link = driver->next;
        node_fs_cp_free(driver->cp);
        free(driver);
    }
}

static void node_fs_cp_finish(MalVm *vm, NodeFsCpDriver *driver, MalValue error, bool failed) {
    NodeFsCpDriver **link = &node_fs_cp_drivers;
    while (*link != nullptr && *link != driver) link = &(*link)->next;
    if (*link == driver) *link = driver->next;
    MalValue roots[] = {driver->completion, error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool callback = driver->callback;
    node_fs_cp_free(driver->cp);
    free(driver);
    if (callback) {
        node_fs_defer_callback(vm, roots[0], !failed, failed ? roots[1] : mal_value_new_undefined());
    } else if (failed) {
        mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), roots[1]);
    } else {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
}

static void node_fs_cp_fail_driver(MalVm *vm, NodeFsCpDriver *driver) {
    MalValue error = vm->completion.value;
    node_fs_clear_completion(vm);
    node_fs_cp_finish(vm, driver, error, true);
}

static MalValue node_fs_cp_filter_settled(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee);

static void node_fs_cp_drive(MalVm *vm, NodeFsCpDriver *driver) {
    for (;;) {
        NodeFsCpStatus status = node_fs_cp_run(driver->cp);
        if (status == NODE_FS_CP_DONE) {
            node_fs_cp_finish(vm, driver, mal_value_new_undefined(), false);
            return;
        }
        if (status == NODE_FS_CP_FAILED) {
            node_fs_cp_throw(vm, driver->cp);
            node_fs_cp_fail_driver(vm, driver);
            return;
        }
        MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        if (!node_fs_cp_call_filter(vm, driver->cp, driver->filter, &roots[0])) {
            mal_gc_unroot(&root);
            node_fs_cp_fail_driver(vm, driver);
            return;
        }
        bool thenable = mal_value_is_promise_object(roots[0]);
        if (!thenable && mal_value_is_object(roots[0])) {
            if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, "then"), &roots[1])) {
                mal_gc_unroot(&root);
                node_fs_cp_fail_driver(vm, driver);
                return;
            }
            thenable = mal_value_is_callable(roots[1]);
        }
        if (!thenable) {
            mal_gc_unroot(&root);
            driver->cp->filter_result = mal_value_is_truthy(roots[0]);
            driver->cp->filter_answered = true;
            continue;
        }
        MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        driver->step++;
        for (i32 rejected = 0; rejected < 2; rejected++) {
            MalValue slots[] = {mal_value_from_f64((f64) driver->id), mal_value_new_boolean(rejected == 1),
                mal_value_from_f64((f64) driver->step)};
            roots[2 + rejected] = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots_arity(&vm->heap, fn_proto,
                    mal_intrinsic_ascii(vm, ""), 1, node_fs_cp_filter_settled, slots, countof(slots)));
        }
        if (mal_value_is_promise_object(roots[0])) {
            mal_promise_perform_then(vm, roots[0], roots[2], roots[3],
                mal_value_new_undefined(), mal_value_new_undefined());
        } else {
            MalCompletion completion = mal_vm_call_value(vm, roots[1], roots[0], roots + 2, 2);
            if (completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&root);
                node_fs_cp_fail_driver(vm, driver);
                return;
            }
        }
        mal_gc_unroot(&root);
        return;
    }
}

static MalValue node_fs_cp_filter_settled(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    u32 id = (u32) mal_ops_number_as_f64(mal_native_function_object_get_slot(function, 0));
    bool rejected = mal_value_is_truthy(mal_native_function_object_get_slot(function, 1));
    u32 step = (u32) mal_ops_number_as_f64(mal_native_function_object_get_slot(function, 2));
    NodeFsCpDriver *driver = node_fs_cp_drivers;
    while (driver != nullptr && (driver->vm != vm || driver->id != id)) driver = driver->next;
    if (driver == nullptr || driver->step != step) return mal_value_new_undefined();
    driver->step++;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (rejected) {
        node_fs_cp_finish(vm, driver, value, true);
    } else {
        driver->cp->filter_result = mal_value_is_truthy(value);
        driver->cp->filter_answered = true;
        node_fs_cp_drive(vm, driver);
    }
    return mal_value_new_undefined();
}

static bool node_fs_cp_start(MalVm *vm, const MalValue *args, i32 argc, MalValue options,
    MalValue completion, bool callback) {
    MalValue filter = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &filter, 1);
    NodeFsCp *cp = node_fs_cp_new(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), options, false, &filter);
    bool started = cp != nullptr;
    if (started && cp->filter) {
        NodeFsCpDriver *driver = calloc(1, sizeof(*driver));
        if (driver == nullptr) {
            node_fs_cp_free(cp);
            mal_vm_throw_allocation_error(vm);
            started = false;
        } else {
            *driver = (NodeFsCpDriver) {.next = node_fs_cp_drivers, .vm = vm, .cp = cp, .filter = filter,
                .completion = completion, .callback = callback, .id = ++node_fs_cp_next_id};
            node_fs_cp_drivers = driver;
            node_fs_cp_drive(vm, driver);
        }
    } else if (started) {
        // Without a filter the whole copy runs on the blocking-work pool, like Node's CpDirJob.
        NodeFsJob *job = calloc(1, sizeof(*job));
        if (job == nullptr) {
            node_fs_cp_free(cp);
            mal_vm_throw_allocation_error(vm);
            started = false;
        } else {
            job->kind = NODE_FS_JOB_CP;
            job->cp = cp;
            job->path = strdup(cp->items[0].src);
            MalBlockingWorkReservation reservation = {0};
            started = node_fs_start_job(vm, job, &reservation, completion, callback,
                mal_value_new_undefined(), mal_value_new_undefined());
        }
    }
    mal_gc_unroot(&root);
    return started;
}

static MalValue node_fs_cp_callback(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue options = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue callback = argc > 3 ? args[3] : mal_value_new_undefined();
    if (mal_value_is_callable(options)) {
        callback = options;
        options = mal_value_new_undefined();
    }
    if (!mal_value_is_callable(callback)) {
        mal_node_throw_invalid_arg_type(vm, "cb", "of type function", callback);
        return mal_value_new_undefined();
    }
    (void) node_fs_cp_start(vm, args, argc, options, callback, true);
    return mal_value_new_undefined();
}

static MalValue node_fs_glob_callback(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_callable(roots[1])) {
        roots[2] = roots[1];
        roots[1] = mal_value_new_undefined();
    }
    if (!mal_value_is_callable(roots[2])) {
        mal_node_throw_invalid_arg_type(vm, "cb", "of type function", roots[2]);
        goto done;
    }
    // Pattern and option errors throw synchronously, as Node's Glob constructor does.
    roots[3] = node_fs_glob_state(vm, roots, 2,
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[3] = node_fs_glob_collect(vm, roots[3]);
    bool failed = vm->completion.kind == MAL_COMPLETION_THROW;
    if (failed) {
        roots[3] = vm->completion.value;
        node_fs_clear_completion(vm);
    }
    node_fs_defer_callback(vm, roots[2], !failed, roots[3]);
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_cp_promise(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, &promise, 1);
    if (!node_fs_cp_start(vm, args, argc, argc > 2 ? args[2] : mal_value_new_undefined(), promise, false)) {
        MalValue error = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(promise), error);
    }
    mal_gc_unroot(&root);
    return promise;
}

// Slots: [absolute path, async]. Removal ignores a directory that is already gone.
static MalValue node_fs_mkdtemp_remove(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    bool async = mal_value_is_truthy(mal_native_function_object_get_slot(function, 1));
    char *path = node_fs_path_cstr(vm, mal_native_function_object_get_slot(function, 0));
    int err = path == nullptr ? 0 : mal_posix_fs_rm(path, true, true);
    if (err != 0) node_fs_throw_errno(vm, err, "rm", path);
    free(path);
    if (!async) return mal_value_new_undefined();
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(promise), error);
    } else {
        mal_promise_fulfill(vm, mal_value_to_promise_object(promise), mal_value_new_undefined());
    }
    return promise;
}

// Node 24's disposable temporary directory: { path, remove, [Symbol.dispose] } with the
// path resolved up front so a later chdir cannot redirect removal.
static MalValue node_fs_mkdtemp_disposable(MalVm *vm, const MalValue *args, i32 argc, bool async) {
    MalValue roots[] = {node_fs_mkdtemp_sync(vm, mal_value_new_undefined(), args, argc,
        mal_value_new_undefined(), mal_value_new_undefined()), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *created = node_fs_path_cstr(vm, roots[0]);
    char *full = created == nullptr ? nullptr : node_fs_cp_resolve(".", created);
    free(created);
    MalValue result = mal_value_new_undefined();
    if (full == nullptr) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_throw_allocation_error(vm);
        goto done;
    }
    roots[1] = node_fs_string_from_cstr(vm, full);
    free(full);
    roots[2] = mal_value_from_object(async ? mal_object_new(&vm->heap, nullptr) : mal_intrinsic_new_object(vm));
    MalObject *object = mal_value_to_object(roots[2]);
    mal_intrinsic_define_data(vm, object, "path", roots[0], NODE_FS_VISIBLE);
    MalObject *prototype = mal_value_to_object(vm->intrinsics[async
        ? MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE : MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue slots[] = {roots[1], mal_value_new_boolean(async)};
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, prototype, mal_intrinsic_ascii(vm, "remove"), 0, node_fs_mkdtemp_remove,
        slots, countof(slots)));
    if (async) mal_native_function_object_set_async(mal_value_to_native_function_object(roots[3]));
    mal_intrinsic_define_data(vm, object, "remove", roots[3], NODE_FS_VISIBLE);
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, prototype,
        mal_intrinsic_ascii(vm, async ? "[Symbol.asyncDispose]" : "[Symbol.dispose]"), 0,
        node_fs_mkdtemp_remove, slots, countof(slots)));
    if (async) mal_native_function_object_set_async(mal_value_to_native_function_object(roots[3]));
    MalPropertyDesc descriptor = mal_intrinsic_data_desc(roots[3], NODE_FS_VISIBLE);
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm,
        async ? MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE : MAL_INTRINSIC_SYMBOL_DISPOSE), &descriptor);
    result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_mkdtemp_disposable_sync(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return node_fs_mkdtemp_disposable(vm, args, argc, false);
}

static MalValue node_fs_mkdtemp_disposable_promise(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = node_fs_mkdtemp_disposable(vm, args, argc, true);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[1] = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), roots[1]);
    } else {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
    }
    MalValue promise = roots[0];
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_mkdtemp_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool started = false;
    if (node_fs_mkdtemp_options(vm, roots + 1)) {
        char *prefix = node_fs_mkdtemp_prefix(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
            roots[1], roots + 2);
        if (prefix != nullptr) started = node_fs_queue_job(vm, NODE_FS_JOB_MKDTEMP,
            prefix, nullptr, 0, roots[0], false, roots[2], -1);
    }
    if (!started) {
        MalValue error = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(roots[0]), error);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

enum {
    NODE_FS_JOB_VALUE_CALLBACK,
    NODE_FS_JOB_VALUE_ENCODING,
    NODE_FS_JOB_VALUE_EXTRA,
    NODE_FS_JOB_VALUE_RESULT,
    NODE_FS_JOB_VALUE_COUNT = NODE_FS_JOB_VALUE_RESULT + 2,
};

static bool node_fs_owner_id(MalVm *vm, MalValue value, u32 *id) {
    if (!mal_ops_is_number(value)) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "owner id must be an integer", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number || number < -1 || number > 4294967295.0) {
        node_fs_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "owner id must be an integer from -1 through 4294967295", "ERR_OUT_OF_RANGE");
        return false;
    }
    *id = number < 0 ? UINT32_MAX : (u32) number;
    return true;
}

static bool node_fs_job_path(MalVm *vm, NodeFsJob *job, MalValue value) {
    job->path = node_fs_path_cstr(vm, value);
    return job->path != nullptr;
}

static bool node_fs_job_times(MalVm *vm, NodeFsJob *job, MalValue atime, MalValue mtime) {
    return node_fs_time_value(vm, atime, &job->times[0], &job->times[1])
        && node_fs_time_value(vm, mtime, &job->times[2], &job->times[3]);
}

static bool node_fs_job_mkdir_options(MalVm *vm, NodeFsJob *job, MalValue options) {
    job->mode = 0777;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) return true;
    if (mal_ops_is_number(options) || mal_value_is_string(options)) {
        return node_fs_mode(vm, options, &job->mode);
    }
    if (!mal_value_is_object(options)) return true;
    MalValue option;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "recursive"), &option)) {
        return false;
    }
    if (!mal_value_is_undefined(option) && !mal_value_is_boolean(option)) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"options.recursive\" property must be of type boolean", "ERR_INVALID_ARG_TYPE");
        return false;
    }
    job->recursive = mal_value_is_truthy(option);
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "mode"), &option)) {
        return false;
    }
    return mal_value_is_undefined(option) || node_fs_mode(vm, option, &job->mode);
}

static bool node_fs_job_read_arguments(
    MalVm *vm, NodeFsJob *job, const MalValue *args, i32 argc, MalValue *values) {
    MalValue params = mal_value_new_undefined();
    bool positional = argc > 4;
    if (argc <= 2) {
        values[NODE_FS_JOB_VALUE_CALLBACK] = argc > 1 ? args[1] : mal_value_new_undefined();
    } else if (argc == 3 && !mal_value_is_typed_array_object(args[1])
        && !mal_value_is_data_view_object(args[1])) {
        params = args[1];
        values[NODE_FS_JOB_VALUE_CALLBACK] = args[2];
        if (mal_value_is_object(params) && !mal_vm_get_property(vm, params,
                mal_intrinsic_string_key(vm, "buffer"), &values[NODE_FS_JOB_VALUE_EXTRA])) {
            return false;
        }
    } else {
        values[NODE_FS_JOB_VALUE_EXTRA] = args[1];
        if (argc == 3) positional = true;
        else if (argc == 4) {
            params = args[2];
            values[NODE_FS_JOB_VALUE_CALLBACK] = args[3];
        }
        if (positional) values[NODE_FS_JOB_VALUE_CALLBACK] = args[argc > 5 ? 5 : argc - 1];
    }
    if (mal_value_is_null(params)) params = mal_value_new_undefined();
    if (mal_value_is_undefined(values[NODE_FS_JOB_VALUE_EXTRA])) {
        byte *bytes = calloc(1, 16384);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        values[NODE_FS_JOB_VALUE_EXTRA] = mal_node_buffer_from_owned_bytes(vm, bytes, 16384);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    }
    MalValue buffer = values[NODE_FS_JOB_VALUE_EXTRA];
    MalBufferSourceSpan span;
    if ((!mal_value_is_typed_array_object(buffer) && !mal_value_is_data_view_object(buffer))
        || mal_buffer_source_span(buffer, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"buffer\" argument must be an instance of Buffer, TypedArray, or DataView",
            "ERR_INVALID_ARG_TYPE");
        return false;
    }
    if (!positional) {
        return node_fs_read_options(vm, params, span.length,
            &job->offset, &job->length, &job->has_position, &job->position);
    }
    MalValue offset = args[2];
    if (mal_value_is_undefined(offset) || mal_value_is_null(offset)) job->offset = 0;
    else if (!node_fs_non_negative_integer(vm, offset,
            "read offset is out of range", span.length, &job->offset)) return false;
    return node_fs_non_negative_integer(vm, argc > 3 ? args[3] : mal_value_new_undefined(),
            "read length is out of range", span.length - job->offset, &job->length)
        && node_fs_read_position(vm, argc > 4 ? args[4] : mal_value_new_undefined(),
            &job->has_position, &job->position);
}

/* Borrow each view of `buffers`; the spans are invalid once JavaScript can run again. */
static bool node_fs_buffer_vectors(MalVm *vm, MalValue buffers, MalPosixIoVec **vectors,
    usize *count, usize *total, bool *shared) {
    *vectors = nullptr;
    *count = 0;
    *total = 0;
    *shared = false;
    u32 length = mal_value_is_array_object(buffers)
        ? mal_array_object_length(mal_value_to_array_object(buffers)) : 0;
    if (length > 0) {
        *vectors = malloc(sizeof(**vectors) * length);
        if (*vectors == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
    }
    bool valid = mal_value_is_array_object(buffers);
    for (u32 i = 0; valid && i < length; i++) {
        MalValue view = node_fs_array_get(buffers, i);
        MalBufferSourceSpan span;
        valid = (mal_value_is_typed_array_object(view) || mal_value_is_data_view_object(view))
            && mal_buffer_source_span(view, &span) == MAL_BUFFER_SOURCE_SPAN_OK;
        if (!valid) break;
        (*vectors)[i] = (MalPosixIoVec) {.data = span.data, .length = span.length};
        *shared = *shared || span.shared;
        *total += span.length;
    }
    if (!valid) {
        free(*vectors);
        *vectors = nullptr;
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"buffers\" argument must be an instance of ArrayBufferView[]",
            "ERR_INVALID_ARG_TYPE");
        return false;
    }
    *count = length;
    return true;
}

/* Give a vector job private contiguous bytes: workers cannot borrow VM buffers. */
static bool node_fs_vector_job_bytes(MalVm *vm, NodeFsJob *job, MalValue buffers) {
    MalPosixIoVec *vectors;
    usize count;
    bool shared;
    if (!node_fs_buffer_vectors(vm, buffers, &vectors, &count, &job->length, &shared)) {
        return false;
    }
    if (job->length > 0) {
        job->bytes = malloc(job->length);
        if (job->bytes == nullptr) {
            free(vectors);
            mal_vm_throw_allocation_error(vm);
            return false;
        }
    }
    if (job->kind == NODE_FS_JOB_WRITEV) {
        usize offset = 0;
        for (usize i = 0; i < count; i++) {
            MalBufferSourceSpan span;
            if (mal_buffer_source_span(node_fs_array_get(buffers, (u32) i), &span)
                != MAL_BUFFER_SOURCE_SPAN_OK) continue;
            mal_buffer_source_span_read(&span, 0, job->bytes + offset, span.length);
            offset += span.length;
        }
    }
    free(vectors);
    return true;
}

static void node_fs_vector_position(MalValue value, NodeFsJob *job) {
    job->has_position = mal_ops_is_number(value);
    job->position = job->has_position ? (i64) mal_ops_number_as_f64(value) : 0;
}

static MalValue node_fs_vector_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target;
    NodeFsJob job = {.kind = node_fs_job_kind(callee)};
    MalValue buffers = argc > 1 ? args[1] : mal_value_new_undefined();
    node_fs_vector_position(argc > 2 ? args[2] : mal_value_new_undefined(), &job);
    MalPosixIoVec *vectors;
    usize count;
    usize total;
    bool shared;
    if (!node_fs_fd(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &job.fd)
        || !node_fs_buffer_vectors(vm, buffers, &vectors, &count, &total, &shared)) {
        return mal_value_new_undefined();
    }
    MalValue result = mal_value_new_undefined();
    if (!shared) {
        job.error = job.kind == NODE_FS_JOB_WRITEV
            ? mal_posix_fs_writev_fd(job.fd, vectors, count, job.has_position, job.position,
                &job.count)
            : mal_posix_fs_readv_fd(job.fd, vectors, count, job.has_position, job.position,
                &job.count);
        job.syscall = node_fs_job_syscall(job.kind);
    } else if (node_fs_vector_job_bytes(vm, &job, buffers)) {
        // Shared views may change concurrently, so they go through private copies.
        node_fs_job_run(&job);
        MalValue out[2];
        if (job.error == 0) node_fs_job_results(vm, &job, mal_value_new_undefined(), buffers, out);
    } else {
        free(vectors);
        return result;
    }
    free(vectors);
    if (job.error != 0) node_fs_job_throw(vm, &job);
    else if (vm->completion.kind != MAL_COMPLETION_THROW) {
        result = mal_value_from_f64((f64) job.count);
    }
    node_fs_job_clear(&job);
    return result;
}

/* Validate a job's JavaScript arguments into `job` and the rooted `values`. Callback
 * forms also locate the callback by Node's per-operation optional-argument rules. */
static bool node_fs_job_arguments(
    MalVm *vm, NodeFsJob *job, const MalValue *args, i32 argc, MalValue *values) {
    MalValue a[4];
    for (i32 i = 0; i < 4; i++) a[i] = argc > i ? args[i] : mal_value_new_undefined();
    MalValue *callback = &values[NODE_FS_JOB_VALUE_CALLBACK];
    bool optional = mal_value_is_callable(a[1]);
    switch (job->kind) {
        case NODE_FS_JOB_OPEN: {
            MalValue flags = a[1];
            MalValue mode = a[2];
            if (argc < 3) {
                *callback = a[1];
                flags = mal_value_new_undefined();
                mode = mal_value_new_undefined();
            } else if (mal_value_is_callable(a[2])) {
                *callback = a[2];
                mode = mal_value_new_undefined();
            } else {
                *callback = a[3];
            }
            if (!node_fs_job_path(vm, job, a[0])) return false;
            job->flags = MAL_POSIX_OPEN_READ;
            job->mode = 0666;
            if (!mal_value_is_undefined(flags) && !mal_value_is_null(flags)
                && !node_fs_open_flags(vm, flags, &job->flags, &job->native_flags)) return false;
            return mal_value_is_undefined(mode) || mal_value_is_null(mode)
                || node_fs_mode(vm, mode, &job->mode);
        }
        case NODE_FS_JOB_CLOSE:
            *callback = a[1];
            return node_fs_fd(vm, a[0], &job->fd);
        case NODE_FS_JOB_READ:
            if (!node_fs_fd(vm, a[0], &job->fd)
                || !node_fs_job_read_arguments(vm, job, args, argc, values)) return false;
            // Workers cannot retain borrowed pointers into detachable or resizable VM buffers.
            if (job->length > 0) {
                job->bytes = malloc(job->length);
                if (job->bytes == nullptr) {
                    mal_vm_throw_allocation_error(vm);
                    return false;
                }
            }
            return true;
        case NODE_FS_JOB_LSTAT:
            *callback = optional ? a[1] : a[2];
            return node_fs_job_path(vm, job, a[0]);
        case NODE_FS_JOB_FSTAT:
            *callback = optional ? a[1] : a[2];
            return node_fs_fd(vm, a[0], &job->fd);
        case NODE_FS_JOB_REALPATH:
        case NODE_FS_JOB_REALPATH_NATIVE:
            *callback = optional ? a[1] : a[2];
            return node_fs_job_path(vm, job, a[0])
                && node_fs_readlink_options(vm, optional ? mal_value_new_undefined() : a[1],
                    &values[NODE_FS_JOB_VALUE_ENCODING], &job->buffer_result);
        case NODE_FS_JOB_MKDIR:
            *callback = optional ? a[1] : a[2];
            return node_fs_job_mkdir_options(vm, job, optional ? mal_value_new_undefined() : a[1])
                && node_fs_job_path(vm, job, a[0]);
        case NODE_FS_JOB_COPY_FILE: {
            bool omitted = mal_value_is_callable(a[2]);
            *callback = omitted ? a[2] : a[3];
            if (!node_fs_job_path(vm, job, a[0])) return false;
            job->destination = node_fs_path_cstr(vm, a[1]);
            if (job->destination == nullptr) return false;
            job->mode = 0;
            if (omitted || mal_value_is_undefined(a[2])) return true;
            if (!mal_ops_is_number(a[2])) {
                node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "The \"mode\" argument must be of type number", "ERR_INVALID_ARG_TYPE");
                return false;
            }
            f64 mode = mal_ops_number_as_f64(a[2]);
            if (trunc(mode) != mode || mode < 0 || mode > 7) {
                node_fs_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "The value of \"mode\" is out of range. It must be an integer >= 0 && <= 7",
                    "ERR_OUT_OF_RANGE");
                return false;
            }
            job->mode = (u32) mode;
            return true;
        }
        case NODE_FS_JOB_RM: {
            *callback = optional ? a[1] : a[2];
            NodeFsRmOptions options;
            if (!node_fs_rm_options(vm, optional ? mal_value_new_undefined() : a[1], &options)
                || !node_fs_job_path(vm, job, a[0])) return false;
            job->recursive = options.recursive;
            job->force = options.force;
            job->retries = options.max_retries;
            job->delay = options.delay;
            return true;
        }
        case NODE_FS_JOB_RMDIR:
            *callback = optional ? a[1] : a[2];
            return node_fs_job_path(vm, job, a[0]);
        case NODE_FS_JOB_CHMOD:
            *callback = a[2];
            return node_fs_job_path(vm, job, a[0]) && node_fs_mode(vm, a[1], &job->mode);
        case NODE_FS_JOB_FCHMOD:
            *callback = a[2];
            return node_fs_fd(vm, a[0], &job->fd) && node_fs_mode(vm, a[1], &job->mode);
        case NODE_FS_JOB_UTIMES:
        case NODE_FS_JOB_LUTIMES:
            *callback = a[3];
            return node_fs_job_path(vm, job, a[0]) && node_fs_job_times(vm, job, a[1], a[2]);
        case NODE_FS_JOB_FUTIMES:
            *callback = a[3];
            return node_fs_fd(vm, a[0], &job->fd) && node_fs_job_times(vm, job, a[1], a[2]);
        case NODE_FS_JOB_TRUNCATE:
        case NODE_FS_JOB_FTRUNCATE: {
            *callback = optional ? a[1] : a[2];
            if (!node_fs_truncate_length(vm, optional ? mal_value_new_undefined() : a[1],
                    &job->position)) return false;
            // Node forwards a numeric truncate target to ftruncate.
            if (job->kind == NODE_FS_JOB_FTRUNCATE || mal_ops_is_number(a[0])) {
                job->kind = NODE_FS_JOB_FTRUNCATE;
                return node_fs_fd(vm, a[0], &job->fd);
            }
            return node_fs_job_path(vm, job, a[0]);
        }
        case NODE_FS_JOB_CHOWN:
        case NODE_FS_JOB_LCHOWN:
            *callback = a[3];
            return node_fs_job_path(vm, job, a[0]) && node_fs_owner_id(vm, a[1], &job->uid)
                && node_fs_owner_id(vm, a[2], &job->gid);
        case NODE_FS_JOB_FCHOWN:
            *callback = a[3];
            return node_fs_fd(vm, a[0], &job->fd) && node_fs_owner_id(vm, a[1], &job->uid)
                && node_fs_owner_id(vm, a[2], &job->gid);
        case NODE_FS_JOB_READV:
        case NODE_FS_JOB_WRITEV:
            *callback = mal_value_is_truthy(a[3]) ? a[3] : a[2];
            values[NODE_FS_JOB_VALUE_EXTRA] = a[1];
            node_fs_vector_position(mal_value_is_callable(a[2]) ? mal_value_new_undefined() : a[2],
                job);
            return node_fs_fd(vm, a[0], &job->fd) && node_fs_vector_job_bytes(vm, job, a[1]);
        case NODE_FS_JOB_STATFS:
            *callback = optional ? a[1] : a[2];
            return node_fs_job_path(vm, job, a[0]);
        case NODE_FS_JOB_EXISTS:
            *callback = a[1];
            // An invalid path reports false through the callback instead of throwing.
            if (!node_fs_job_path(vm, job, a[0])) {
                node_fs_clear_completion(vm);
                job->path = strdup("");
                if (job->path == nullptr) {
                    mal_vm_throw_allocation_error(vm);
                    return false;
                }
            }
            return true;
        default:
            return false;
    }
}

static MalValue node_fs_job_instance(MalVm *vm, MalValue new_target, bool *ok) {
    *ok = true;
    if (mal_value_is_undefined(new_target)) return mal_value_new_undefined();
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        *ok = false;
        return mal_value_new_undefined();
    }
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

static MalValue node_fs_job_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue values[NODE_FS_JOB_VALUE_COUNT + 1];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_undefined();
    values[NODE_FS_JOB_VALUE_EXTRA] = mal_native_function_object_get_slot(function, 1);
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    bool ok;
    values[NODE_FS_JOB_VALUE_COUNT] = node_fs_job_instance(vm, new_target, &ok);
    NodeFsJob *job = ok ? calloc(1, sizeof(*job)) : nullptr;
    if (ok && job == nullptr) mal_vm_throw_allocation_error(vm);
    if (job == nullptr) goto failed;
    job->kind = node_fs_job_kind(callee);
    if (!node_fs_job_arguments(vm, job, args, argc, values)) {
        node_fs_job_free(job);
        goto failed;
    }
    MalValue callback = values[NODE_FS_JOB_VALUE_CALLBACK];
    if (!mal_value_is_callable(callback)
        && !(job->kind == NODE_FS_JOB_CLOSE && mal_value_is_undefined(callback))) {
        node_fs_job_free(job);
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"cb\" argument must be of type function", "ERR_INVALID_ARG_TYPE");
        goto failed;
    }
    MalBlockingWorkReservation reservation = {0};
    if (!node_fs_start_job(vm, job, &reservation, callback, true,
            values[NODE_FS_JOB_VALUE_ENCODING], values[NODE_FS_JOB_VALUE_EXTRA])) goto failed;
    MalValue result = values[NODE_FS_JOB_VALUE_COUNT];
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_job_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue values[NODE_FS_JOB_VALUE_COUNT + 1];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_undefined();
    values[NODE_FS_JOB_VALUE_EXTRA] = mal_native_function_object_get_slot(function, 1);
    values[NODE_FS_JOB_VALUE_COUNT] = mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    NodeFsJob *job = calloc(1, sizeof(*job));
    bool started = false;
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
    } else {
        job->kind = node_fs_job_kind(callee);
        if (!node_fs_job_arguments(vm, job, args, argc, values)) {
            node_fs_job_free(job);
        } else {
            MalBlockingWorkReservation reservation = {0};
            started = node_fs_start_job(vm, job, &reservation, values[NODE_FS_JOB_VALUE_COUNT],
                false, values[NODE_FS_JOB_VALUE_ENCODING], values[NODE_FS_JOB_VALUE_EXTRA]);
        }
    }
    if (!started) {
        values[NODE_FS_JOB_VALUE_CALLBACK] = vm->completion.value;
        node_fs_clear_completion(vm);
        mal_promise_reject(vm, mal_value_to_promise_object(values[NODE_FS_JOB_VALUE_COUNT]),
            values[NODE_FS_JOB_VALUE_CALLBACK]);
    }
    MalValue promise = values[NODE_FS_JOB_VALUE_COUNT];
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_job_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue values[NODE_FS_JOB_VALUE_COUNT];
    for (usize i = 0; i < countof(values); i++) values[i] = mal_value_new_undefined();
    values[NODE_FS_JOB_VALUE_EXTRA] = mal_native_function_object_get_slot(function, 1);
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    NodeFsJob job = {.kind = node_fs_job_kind(callee)};
    MalValue result = mal_value_new_undefined();
    if (node_fs_job_arguments(vm, &job, args, argc, values)) {
        node_fs_job_run(&job);
        if (job.error != 0) {
            node_fs_job_throw(vm, &job);
        } else if (node_fs_job_results(vm, &job, values[NODE_FS_JOB_VALUE_ENCODING],
                values[NODE_FS_JOB_VALUE_EXTRA], values + NODE_FS_JOB_VALUE_RESULT) > 0) {
            result = values[NODE_FS_JOB_VALUE_RESULT];
        }
    }
    node_fs_job_clear(&job);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_write_file_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) new_target;
    u32 flags = (u32) mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0));
    MalValue values[] = {
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 2 ? args[2] : mal_value_new_undefined(),
        argc > 3 && mal_value_is_truthy(args[3]) ? args[3]
            : argc > 2 ? args[2] : mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    if (!mal_value_is_callable(values[3])) {
        node_fs_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"cb\" argument must be of type function", "ERR_INVALID_ARG_TYPE");
    } else {
        if (mal_value_is_callable(values[2])) values[2] = mal_value_new_undefined();
        node_fs_queue_write(vm, values[3], true, values, 3, flags);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
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
            if (!node_fs_queue_write(vm, roots[NODE_FS_PROMISE_TASK_PROMISE], false,
                    roots + NODE_FS_PROMISE_TASK_ARG0, argc < 3 ? argc : 3,
                    callback == node_fs_append_file_sync
                        ? MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_APPEND
                        : MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE)) {
                roots[NODE_FS_PROMISE_TASK_ARG0] = vm->completion.value;
                node_fs_clear_completion(vm);
                mal_promise_reject(vm, mal_value_to_promise_object(
                    roots[NODE_FS_PROMISE_TASK_PROMISE]), roots[NODE_FS_PROMISE_TASK_ARG0]);
            }
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
            &bytes, &length, &owned, nullptr)) {
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
    (void) self; (void) nt;
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
        MalValue proto = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
        mal_object_set_prototype(mal_value_to_object(roots[2]), mal_value_to_object(proto));
        node_fs_stream_set(vm,roots[2],"path",roots[1]);
        node_fs_stream_set(vm,roots[2],"fd",mal_value_is_undefined(fd)?mal_value_new_null():fd);
    }
finished:
    MalValue result=vm->completion.kind==MAL_COMPLETION_THROW?mal_value_new_undefined():roots[2];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_slot_function(MalVm *vm, const char *name, i32 arity,
    MalNativeFunctionCallback callback, const MalValue *slots, usize count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name), arity, callback, slots, (i32) count));
}

static bool node_fs_start_fd_job(MalVm *vm, NodeFsJobKind kind, int fd, MalValue completion) {
    NodeFsJob *job = calloc(1, sizeof(*job));
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    job->kind = kind;
    job->fd = fd;
    MalBlockingWorkReservation reservation = {0};
    return node_fs_start_job(vm, job, &reservation, completion, true,
        mal_value_new_undefined(), mal_value_new_undefined());
}

static void node_fs_call_callback(MalVm *vm, MalValue callback, MalValue error) {
    mal_vm_call_value(vm, callback, mal_value_new_undefined(), &error, mal_value_is_nil(error) ? 0 : 1);
}

/* Callback slots: the stream callback, the stream, and an error to report after closing. */
static MalValue node_fs_write_stream_closed(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        argc > 0 && !mal_value_is_nil(args[0]) ? args[0]
            : mal_native_function_object_get_slot(function, 2)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    node_fs_stream_set(vm, roots[1], "fd", mal_value_new_null());
    node_fs_call_callback(vm, roots[0], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void node_fs_write_stream_close(
    MalVm *vm, MalValue state, MalValue stream, MalValue callback, MalValue error) {
    MalNodeFsFileHandleObject *handle = node_fs_file_handle(state);
    MalValue fd = node_fs_stream_get(vm, state, "fd");
    if (!mal_ops_is_number(fd) || !node_fs_truthy_property(vm, state, "autoClose")) {
        node_fs_call_callback(vm, callback, error);
        return;
    }
    MalValue slots[] = {callback, stream, error, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    // The worker owns the descriptor from here; the finalizer must not close it again.
    handle->fd = -1;
    node_fs_stream_set(vm, state, "fd", mal_value_new_null());
    slots[3] = node_fs_slot_function(vm, "", 1, node_fs_write_stream_closed, slots, 3);
    if (!node_fs_start_fd_job(vm, NODE_FS_JOB_CLOSE, mal_value_to_i32(fd), slots[3])) {
        slots[2] = vm->completion.value;
        node_fs_clear_completion(vm);
        node_fs_call_callback(vm, callback, slots[2]);
    }
    mal_gc_unroot(&root);
}

static MalValue node_fs_write_stream_synced(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        mal_native_function_object_get_slot(function, 2),
        argc > 0 ? args[0] : mal_value_new_null()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_nil(roots[3])) node_fs_write_stream_close(vm, roots[0], roots[1], roots[2], roots[3]);
    else node_fs_call_callback(vm, roots[2], roots[3]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Node closes an autoClose descriptor once the stream finishes, after the optional flush. */
static void node_fs_write_stream_final(MalVm *vm, MalValue state, MalValue stream, MalValue callback) {
    if (!node_fs_truthy_property(vm, state, "flush")) {
        node_fs_write_stream_close(vm, state, stream, callback, mal_value_new_null());
        return;
    }
    MalValue slots[] = {state, stream, callback, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    slots[3] = node_fs_slot_function(vm, "", 1, node_fs_write_stream_synced, slots, 3);
    if (!node_fs_start_fd_job(vm, NODE_FS_JOB_FSYNC,
            mal_value_to_i32(node_fs_stream_get(vm, state, "fd")), slots[3])) {
        slots[3] = vm->completion.value;
        node_fs_clear_completion(vm);
        node_fs_call_callback(vm, callback, slots[3]);
    }
    mal_gc_unroot(&root);
}

static MalValue node_fs_write_stream_written(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        argc > 0 ? args[0] : mal_value_new_null()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_nil(roots[2]) && argc > 1) {
        f64 written = mal_ops_number_as_f64(node_fs_stream_get(vm, roots[1], "bytesWritten"));
        node_fs_stream_set(vm, roots[1], "bytesWritten",
            mal_value_from_f64(written + mal_ops_number_as_f64(args[1])));
    }
    node_fs_call_callback(vm, roots[0], roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void node_fs_write_stream_chunk(MalVm *vm, MalValue state, MalValue stream,
    MalValue chunk, MalValue encoding, MalValue callback) {
    MalValue slots[] = {callback, stream, mal_value_new_undefined(), chunk};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalBlockingWorkReservation reservation = {0};
    NodeFsJob *job = calloc(1, sizeof(*job));
    const byte *bytes;
    byte *owned = nullptr;
    if (job == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto failed;
    }
    job->kind = NODE_FS_JOB_WRITEV;
    job->fd = mal_value_to_i32(node_fs_stream_get(vm, state, "fd"));
    if (!node_fs_write_bytes(vm, chunk, mal_value_is_string(chunk) ? encoding
            : mal_value_new_undefined(), &bytes, &job->length, &owned, &reservation)) goto failed;
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
    MalValue position = node_fs_stream_get(vm, state, "position");
    job->has_position = mal_ops_is_number(position);
    if (job->has_position) {
        job->position = (i64) mal_ops_number_as_f64(position);
        node_fs_stream_set(vm, state, "position",
            mal_value_from_f64((f64) job->position + (f64) job->length));
    }
    slots[2] = node_fs_slot_function(vm, "", 2, node_fs_write_stream_written, slots, 2);
    NodeFsJob *started = job;
    job = nullptr;
    if (node_fs_start_job(vm, started, &reservation, slots[2], true, mal_value_new_undefined(),
            slots[3])) {
        mal_gc_unroot(&root);
        return;
    }
failed:
    if (job != nullptr) node_fs_job_free(job);
    mal_blocking_work_reservation_release(&reservation);
    slots[2] = vm->completion.value;
    node_fs_clear_completion(vm);
    node_fs_call_callback(vm, callback, slots[2]);
    mal_gc_unroot(&root);
}

static MalValue node_fs_write_stream_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue encoding = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_ops_is_number(node_fs_stream_get(vm, state, "fd"))) {
        // Writable serializes _write calls, so at most one chunk waits for the open.
        node_fs_stream_set(vm, state, "pendingChunk", chunk);
        node_fs_stream_set(vm, state, "pendingEncoding", encoding);
        node_fs_stream_set(vm, state, "pendingCallback", callback);
        return mal_value_new_undefined();
    }
    node_fs_write_stream_chunk(vm, state, self, chunk, encoding, callback);
    return mal_value_new_undefined();
}

static MalValue node_fs_write_stream_final_hook(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_ops_is_number(node_fs_stream_get(vm, state, "fd"))
        && !node_fs_truthy_property(vm, state, "opened")) {
        node_fs_stream_set(vm, state, "pendingFinal", callback);
        return mal_value_new_undefined();
    }
    node_fs_write_stream_final(vm, state, self, callback);
    return mal_value_new_undefined();
}

static MalValue node_fs_write_stream_destroy(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    node_fs_write_stream_close(vm, state, self, argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_null());
    return mal_value_new_undefined();
}

static MalValue node_fs_write_stream_opened(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        argc > 0 ? args[0] : mal_value_new_null(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_nil(roots[2])) {
        node_fs_call_method(vm, roots[1], "destroy", roots + 2, 1);
        goto finished;
    }
    int fd = (int) mal_ops_number_as_f64(roots[3]);
    if (node_fs_truthy_property(vm, roots[1], "destroyed")) {
        (void) mal_posix_fs_close_fd(fd);
        goto finished;
    }
    node_fs_stream_set(vm, roots[0], "opened", mal_value_new_boolean(true));
    node_fs_stream_set(vm, roots[0], "fd", mal_value_from_i32(fd));
    if (node_fs_truthy_property(vm, roots[0], "autoClose")) node_fs_file_handle(roots[0])->fd = fd;
    node_fs_stream_set(vm, roots[1], "fd", mal_value_from_i32(fd));
    MalValue open_args[] = {node_fs_string_from_cstr(vm, "open"), mal_value_from_i32(fd)};
    roots[4] = open_args[0];
    node_fs_call_method(vm, roots[1], "emit", open_args, 2);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto finished;
    roots[4] = node_fs_string_from_cstr(vm, "ready");
    node_fs_call_method(vm, roots[1], "emit", roots + 4, 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto finished;
    roots[4] = node_fs_stream_get(vm, roots[0], "pendingCallback");
    if (!mal_value_is_undefined(roots[4])) {
        MalValue chunk = node_fs_stream_get(vm, roots[0], "pendingChunk");
        MalValue encoding = node_fs_stream_get(vm, roots[0], "pendingEncoding");
        MalValue pending[] = {chunk, encoding};
        MalRootSpan pending_root;
        mal_gc_root(&pending_root, pending, countof(pending));
        node_fs_stream_set(vm, roots[0], "pendingCallback", mal_value_new_undefined());
        node_fs_stream_set(vm, roots[0], "pendingChunk", mal_value_new_undefined());
        node_fs_write_stream_chunk(vm, roots[0], roots[1], pending[0], pending[1], roots[4]);
        mal_gc_unroot(&pending_root);
        goto finished;
    }
    roots[4] = node_fs_stream_get(vm, roots[0], "pendingFinal");
    if (!mal_value_is_undefined(roots[4])) {
        node_fs_stream_set(vm, roots[0], "pendingFinal", mal_value_new_undefined());
        node_fs_write_stream_final(vm, roots[0], roots[1], roots[4]);
    }
finished:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool node_fs_write_stream_option(
    MalVm *vm, MalValue options, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    return !mal_value_is_object(options)
        || mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, name), out);
}

/* Slot 0 holds WriteStream.prototype. */
static MalValue node_fs_create_write_stream(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    enum { W_OPTIONS, W_PATH, W_STATE, W_WRITABLE, W_STREAM, W_VALUE, W_FD, W_FLAGS, W_MODE,
        W_START, W_COUNT };
    MalValue roots[W_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    roots[W_OPTIONS] = argc > 1 ? args[1] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    char *path = nullptr;
    NodeFsJob *job = nullptr;
    MalValue encoding = mal_value_new_undefined();
    if (mal_value_is_string(roots[W_OPTIONS])) {
        encoding = roots[W_OPTIONS];
        roots[W_OPTIONS] = mal_value_new_undefined();
    }
    MalValue auto_close, flush, hwm;
    if (!node_fs_write_stream_option(vm, roots[W_OPTIONS], "fd", &roots[W_FD])
        || !node_fs_write_stream_option(vm, roots[W_OPTIONS], "flags", &roots[W_FLAGS])
        || !node_fs_write_stream_option(vm, roots[W_OPTIONS], "mode", &roots[W_MODE])
        || !node_fs_stream_offset(vm, roots[W_OPTIONS], "start", &roots[W_START])
        || !node_fs_write_stream_option(vm, roots[W_OPTIONS], "autoClose", &auto_close)
        || !node_fs_write_stream_option(vm, roots[W_OPTIONS], "flush", &flush)
        || !node_fs_write_stream_option(vm, roots[W_OPTIONS], "highWaterMark", &hwm)) goto finished;
    if (mal_value_is_undefined(encoding)
        && !node_fs_write_stream_option(vm, roots[W_OPTIONS], "encoding", &encoding)) goto finished;
    bool closes = mal_value_is_undefined(auto_close) || mal_value_is_truthy(auto_close);
    u32 flags = MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE | MAL_POSIX_OPEN_TRUNCATE;
    bool native_flags = false;
    u32 mode = 0666;
    int fd = -1;
    if (!mal_value_is_nil(roots[W_FD])) {
        if (!node_fs_fd(vm, roots[W_FD], &fd)) goto finished;
    } else {
        path = node_fs_path_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined());
        if (path == nullptr) goto finished;
        roots[W_PATH] = node_fs_string_from_cstr(vm, path);
    }
    if (!mal_value_is_nil(roots[W_FLAGS])
        && !node_fs_open_flags(vm, roots[W_FLAGS], &flags, &native_flags)) goto finished;
    if (!mal_value_is_nil(roots[W_MODE]) && !node_fs_mode(vm, roots[W_MODE], &mode)) goto finished;
    MalNodeFsFileHandleObject *state = mal_heap_alloc(&vm->heap, sizeof(MalNodeFsFileHandleObject),
        MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT);
    mal_object_init(&vm->heap, &state->object, MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    state->fd = closes ? fd : -1;
    mal_gc_register_finalizer(MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT, node_fs_file_handle_finalize);
    roots[W_STATE] = mal_value_from_heap((MalHeapHeader *) state);
    node_fs_stream_set(vm, roots[W_STATE], "fd", fd < 0 ? mal_value_new_null() : mal_value_from_i32(fd));
    node_fs_stream_set(vm, roots[W_STATE], "opened", mal_value_new_boolean(fd >= 0));
    node_fs_stream_set(vm, roots[W_STATE], "position", roots[W_START]);
    node_fs_stream_set(vm, roots[W_STATE], "autoClose", mal_value_new_boolean(closes));
    node_fs_stream_set(vm, roots[W_STATE], "flush", mal_value_new_boolean(mal_value_is_truthy(flush)));
    roots[W_WRITABLE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    if (!mal_value_is_undefined(hwm)) node_fs_stream_set(vm, roots[W_WRITABLE], "highWaterMark", hwm);
    if (!mal_value_is_nil(encoding)) node_fs_stream_set(vm, roots[W_WRITABLE], "defaultEncoding", encoding);
    static const struct {
        const char *name;
        i32 arity;
        MalNativeFunctionCallback callback;
    } hooks[] = {
        {"write", 3, node_fs_write_stream_write},
        {"final", 1, node_fs_write_stream_final_hook},
        {"destroy", 2, node_fs_write_stream_destroy},
    };
    for (usize i = 0; i < countof(hooks); i++) {
        roots[W_VALUE] = node_fs_slot_function(vm, hooks[i].name, hooks[i].arity,
            hooks[i].callback, &roots[W_STATE], 1);
        node_fs_stream_set(vm, roots[W_WRITABLE], hooks[i].name, roots[W_VALUE]);
    }
    MalCompletion stream = mal_vm_construct_value(vm,
        vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR], &roots[W_WRITABLE], 1);
    if (stream.kind == MAL_COMPLETION_THROW) goto finished;
    roots[W_STREAM] = stream.value;
    mal_object_set_prototype(mal_value_to_object(roots[W_STREAM]), mal_value_to_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0)));
    node_fs_stream_set(vm, roots[W_STREAM], "path", roots[W_PATH]);
    node_fs_stream_set(vm, roots[W_STREAM], "fd", fd < 0 ? mal_value_new_null() : mal_value_from_i32(fd));
    node_fs_stream_set(vm, roots[W_STREAM], "flags", mal_value_is_nil(roots[W_FLAGS])
        ? node_fs_string_from_cstr(vm, "w") : roots[W_FLAGS]);
    node_fs_stream_set(vm, roots[W_STREAM], "mode", mal_value_from_i32((i32) mode));
    node_fs_stream_set(vm, roots[W_STREAM], "start", roots[W_START]);
    node_fs_stream_set(vm, roots[W_STREAM], "autoClose", mal_value_new_boolean(closes));
    node_fs_stream_set(vm, roots[W_STREAM], "bytesWritten", mal_value_from_i32(0));
    node_fs_stream_set(vm, roots[W_STREAM], "_malAutoDestroyAfterFinish", mal_value_new_boolean(true));
    if (fd < 0) {
        job = calloc(1, sizeof(*job));
        if (job == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto finished;
        }
        job->kind = NODE_FS_JOB_OPEN;
        job->path = path;
        path = nullptr;
        job->flags = flags;
        job->native_flags = native_flags;
        job->mode = mode;
        MalValue opened_slots[] = {roots[W_STATE], roots[W_STREAM]};
        roots[W_VALUE] = node_fs_slot_function(vm, "", 2, node_fs_write_stream_opened,
            opened_slots, countof(opened_slots));
        MalBlockingWorkReservation reservation = {0};
        NodeFsJob *started = job;
        job = nullptr;
        if (!node_fs_start_job(vm, started, &reservation, roots[W_VALUE], true,
                mal_value_new_undefined(), mal_value_new_undefined())) goto finished;
    }
    result = roots[W_STREAM];
finished:
    free(path);
    if (job != nullptr) node_fs_job_free(job);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_dirent_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    // Node passes libuv dirent types; translate them to MalPosixFileType.
    static const i32 types[] = {MAL_POSIX_FT_OTHER, MAL_POSIX_FT_FILE, MAL_POSIX_FT_DIR,
        MAL_POSIX_FT_SYMLINK, MAL_POSIX_FT_FIFO, MAL_POSIX_FT_SOCKET, MAL_POSIX_FT_CHARACTER,
        MAL_POSIX_FT_BLOCK};
    MalValue dirent = mal_value_from_object(mal_object_new(&vm->heap, node_fs_slot_proto(vm, callee)));
    MalRootSpan root;
    mal_gc_root(&root, &dirent, 1);
    MalObject *object = mal_value_to_object(dirent);
    i32 type = argc > 1 && mal_value_is_int32(args[1]) ? mal_value_to_i32(args[1]) : 0;
    mal_intrinsic_define_data(vm, object, "name", argc > 0 ? args[0] : mal_value_new_undefined(),
        NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, object, "parentPath",
        argc > 2 ? args[2] : mal_value_new_undefined(), NODE_FS_VISIBLE);
    mal_intrinsic_define_data(vm, object, NODE_FS_TYPE_KEY, mal_value_from_i32(
        type >= 0 && (usize) type < countof(types) ? types[type] : MAL_POSIX_FT_OTHER),
        MAL_PROPERTY_NONE);
    mal_gc_unroot(&root);
    return dirent;
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

static MalValue node_fs_regular_function(MalVm *vm, MalValue value) {
    MalValue roots[] = {value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *function = mal_value_to_native_function_object(roots[0]);
    mal_native_function_object_set_constructor(function);
    mal_native_function_object_set_handles_new_target_prototype(function);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", roots[1],
        MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "constructor", roots[0],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_make_regular_fn(
    MalVm *vm, MalObject *prototype, const char *name, i32 arity,
    MalNativeFunctionCallback callback, NodeFsJobKind kind
) {
    MalValue slot = mal_value_from_i32((i32) kind);
    return node_fs_regular_function(vm, mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(&vm->heap, prototype,
            mal_intrinsic_ascii(vm, name), arity, callback, &slot, 1)));
}

static MalValue node_fs_make_job_fn(
    MalVm *vm, MalObject *prototype, const char *name, i32 arity,
    MalNativeFunctionCallback callback, i32 kind, MalValue proto
) {
    MalValue slots[] = {mal_value_from_i32(kind), proto};
    return node_fs_regular_function(vm, mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(&vm->heap, prototype,
            mal_intrinsic_ascii(vm, name), arity, callback, slots, countof(slots))));
}

static const struct {
    const char *name;
    i32 arity;
    NodeFsJobKind kind;
    bool sync;
} node_fs_job_exports[] = {
    {"open", 4, NODE_FS_JOB_OPEN, false},
    {"close", 1, NODE_FS_JOB_CLOSE, false},
    {"read", 6, NODE_FS_JOB_READ, false},
    {"lstat", 1, NODE_FS_JOB_LSTAT, false},
    {"fstat", 1, NODE_FS_JOB_FSTAT, false},
    {"mkdir", 3, NODE_FS_JOB_MKDIR, false},
    {"copyFile", 4, NODE_FS_JOB_COPY_FILE, false},
    {"rm", 3, NODE_FS_JOB_RM, false},
    {"rmdir", 3, NODE_FS_JOB_RMDIR, false},
    {"chmod", 3, NODE_FS_JOB_CHMOD, false},
    {"fchmod", 3, NODE_FS_JOB_FCHMOD, false},
    {"utimes", 4, NODE_FS_JOB_UTIMES, false},
    {"futimes", 4, NODE_FS_JOB_FUTIMES, false},
    {"lutimes", 4, NODE_FS_JOB_LUTIMES, false},
    {"truncate", 3, NODE_FS_JOB_TRUNCATE, false},
    {"ftruncate", 1, NODE_FS_JOB_FTRUNCATE, false},
    {"chown", 4, NODE_FS_JOB_CHOWN, false},
    {"fchown", 4, NODE_FS_JOB_FCHOWN, false},
    {"lchown", 4, NODE_FS_JOB_LCHOWN, false},
    {"exists", 2, NODE_FS_JOB_EXISTS, false},
    {"readv", 4, NODE_FS_JOB_READV, false},
    {"writev", 4, NODE_FS_JOB_WRITEV, false},
    {"statfs", 3, NODE_FS_JOB_STATFS, false},
    {"mkdirSync", 2, NODE_FS_JOB_MKDIR, true},
    {"fchmodSync", 2, NODE_FS_JOB_FCHMOD, true},
    {"futimesSync", 3, NODE_FS_JOB_FUTIMES, true},
    {"lutimesSync", 3, NODE_FS_JOB_LUTIMES, true},
    {"truncateSync", 2, NODE_FS_JOB_TRUNCATE, true},
    {"chownSync", 3, NODE_FS_JOB_CHOWN, true},
    {"fchownSync", 3, NODE_FS_JOB_FCHOWN, true},
    {"lchownSync", 3, NODE_FS_JOB_LCHOWN, true},
};

#define NODE_FS_WATCH_EVENTS 32
// kqueue needs an open descriptor per watched entry, so large directories only report renames.
#define NODE_FS_WATCH_CHILD_LIMIT 256

typedef struct NodeFsWatchEvent {
    MalValue result;
    struct NodeFsWatchEvent *next;
} NodeFsWatchEvent;

typedef struct NodeFsWatcher {
    MalVm *vm;
    MalHost *host;
    MalValue receiver;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalHostHandle operation;
    MalOp read_op;
    int fd;
    int target_fd;
    char *path;
    char *basename;
    char **entries;
    int *entry_fds;
    usize entry_count;
    bool directory;
    bool buffer_names;
    bool closed;
    bool unreferenced;
    bool iterator;
    MalValue pending;
    NodeFsWatchEvent *queue_head;
    NodeFsWatchEvent *queue_tail;
    MalValue abort_reason;
    bool aborted;
    struct NodeFsWatcher *next;
} NodeFsWatcher;

typedef struct NodeFsStatWatcher {
    MalVm *vm;
    MalValue receiver;
    MalValue stats_proto;
    char *path;
    MalPosixStat previous;
    i64 timer;
    bool initially_missing;
    struct NodeFsStatWatcher *next;
} NodeFsStatWatcher;

// Watchers and their drain registration belong to this mutator's isolate; installed on first use.
static MAL_ISOLATE_LOCAL NodeFsWatcher *node_fs_watchers;
static MAL_ISOLATE_LOCAL NodeFsStatWatcher *node_fs_stat_watchers;
static MAL_ISOLATE_LOCAL MalValue node_fs_watcher_proto;
static MAL_ISOLATE_LOCAL MalValue node_fs_stat_watcher_proto;
static MAL_ISOLATE_LOCAL bool node_fs_watch_installed;

static MalValue node_fs_watch_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) text));
}

static void node_fs_watch_call(MalVm *vm, MalValue receiver, const char *name, MalValue *args, i32 argc) {
    MalValue roots[] = {receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) name), &roots[1])) {
        mal_vm_call_value(vm, roots[1], roots[0], args, argc);
    }
    mal_gc_unroot(&root);
}

static void node_fs_watch_listen(MalVm *vm, MalValue receiver, const char *event, MalValue callback) {
    if (!mal_value_is_callable(callback)) return;
    MalValue args[] = {node_fs_watch_ascii(vm, event), callback};
    MalRootSpan root;
    mal_gc_root(&root, args, 2);
    node_fs_watch_call(vm, receiver, "on", args, 2);
    mal_gc_unroot(&root);
}

static void node_fs_watch_scan_roots(MalVm *vm, void *data) {
    (void) data;
    if (mal_value_is_object(node_fs_watcher_proto)) mal_gc_mark_value(node_fs_watcher_proto);
    if (mal_value_is_object(node_fs_stat_watcher_proto)) mal_gc_mark_value(node_fs_stat_watcher_proto);
    for (NodeFsWatcher *state = node_fs_watchers; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(state->pending);
        mal_gc_mark_value(state->abort_reason);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
        for (NodeFsWatchEvent *event = state->queue_head; event != nullptr; event = event->next) {
            mal_gc_mark_value(event->result);
        }
    }
    for (NodeFsStatWatcher *state = node_fs_stat_watchers; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->receiver);
        mal_gc_mark_value(state->stats_proto);
    }
}

static NodeFsWatcher *node_fs_watcher_find(MalValue receiver) {
    for (NodeFsWatcher *state = node_fs_watchers; state != nullptr; state = state->next) {
        if (state->receiver == receiver) return state;
    }
    return nullptr;
}

static void node_fs_watcher_free(NodeFsWatcher *state) {
    NodeFsWatcher **link = &node_fs_watchers;
    while (*link != nullptr && *link != state) link = &(*link)->next;
    if (*link == state) *link = state->next;
    for (usize i = 0; i < state->entry_count; i++) {
        if (state->entry_fds != nullptr && state->entry_fds[i] >= 0) close(state->entry_fds[i]);
        free(state->entries[i]);
    }
    free(state->entries);
    free(state->entry_fds);
    while (state->queue_head != nullptr) {
        NodeFsWatchEvent *event = state->queue_head;
        state->queue_head = event->next;
        free(event);
    }
    free(state->path);
    free(state);
}

#if defined(__APPLE__)
static int node_fs_watch_compare(const void *left, const void *right) {
    return strcmp(*(char *const *) left, *(char *const *) right);
}

static bool node_fs_watch_list(const char *path, char ***out, usize *count) {
    DIR *dir = opendir(path);
    *out = nullptr;
    *count = 0;
    if (dir == nullptr) return false;
    usize capacity = 0;
    for (struct dirent *entry = readdir(dir); entry != nullptr; entry = readdir(dir)) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (*count == capacity) {
            capacity = capacity == 0 ? 16 : capacity * 2;
            char **grown = realloc(*out, capacity * sizeof(char *));
            if (grown == nullptr) break;
            *out = grown;
        }
        char *name = strdup(entry->d_name);
        if (name == nullptr) break;
        (*out)[(*count)++] = name;
    }
    closedir(dir);
    if (*count > 1) qsort(*out, *count, sizeof(char *), node_fs_watch_compare);
    return true;
}
#endif

static void node_fs_watch_ready(void *data) {
    NodeFsWatcher *state = data;
    if (state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_host_operation_progress(&state->host->tasks, state->operation, nullptr, nullptr);
}

static bool node_fs_watch_arm(NodeFsWatcher *state) {
    state->read_op = (MalOp) {.fd = state->fd, .interest = MAL_IO_READ,
        .waker = {.fn = node_fs_watch_ready, .data = state}};
    if (!mal_reactor_add_op(&state->host->reactor, &state->read_op)) return false;
    if (state->unreferenced) state->host->reactor.unreferenced_ops++;
    return true;
}

static void node_fs_watch_disarm(NodeFsWatcher *state) {
    if (state->read_op.active && state->unreferenced) state->host->reactor.unreferenced_ops--;
    (void) mal_reactor_cancel_op(&state->host->reactor, &state->read_op);
}

static void node_fs_watch_emit(MalVm *vm, NodeFsWatcher *state, const char *type, const char *name) {
    MalValue values[] = {node_fs_watch_ascii(vm, "change"), node_fs_watch_ascii(vm, type),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    if (state->buffer_names) {
        usize length = strlen(name);
        byte *bytes = malloc(length == 0 ? 1 : length);
        if (bytes != nullptr) memcpy(bytes, name, length);
        values[2] = bytes == nullptr ? mal_value_new_null() : mal_node_buffer_from_owned_bytes(vm, bytes, length);
    } else {
        values[2] = node_fs_string_from_cstr(vm, name);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return;
    }
    if (!state->iterator) {
        node_fs_watch_call(vm, state->receiver, "emit", values, 3);
    } else {
        MalObject *event = mal_intrinsic_new_object(vm);
        values[3] = mal_value_from_object(event);
        mal_intrinsic_define_data(vm, event, (const byte *) "eventType", values[1], NODE_FS_VISIBLE);
        mal_intrinsic_define_data(vm, event, (const byte *) "filename", values[2], NODE_FS_VISIBLE);
        values[3] = mal_vm_create_iter_result(vm, values[3], false);
        if (mal_value_is_object(state->pending)) {
            MalPromiseObject *promise = mal_value_to_promise_object(state->pending);
            state->pending = mal_value_new_undefined();
            mal_promise_fulfill(vm, promise, values[3]);
        } else {
            NodeFsWatchEvent *queued = calloc(1, sizeof(NodeFsWatchEvent));
            if (queued != nullptr) {
                queued->result = values[3];
                if (state->queue_tail != nullptr) state->queue_tail->next = queued;
                else state->queue_head = queued;
                state->queue_tail = queued;
            }
        }
    }
    mal_gc_unroot(&root);
}

#if defined(__APPLE__)
static int node_fs_watch_child(NodeFsWatcher *state, const char *name, usize watched) {
    if (watched >= NODE_FS_WATCH_CHILD_LIMIT) return -1;
    int fd = openat(state->target_fd, name, O_EVTONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    struct stat st;
    struct kevent change;
    EV_SET(&change, fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB, 0,
        (void *) (uintptr_t) (fd + 1));
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || kevent(state->fd, &change, 1, nullptr, 0, nullptr) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

static void node_fs_watch_rescan(MalVm *vm, NodeFsWatcher *state, bool announce) {
    char **entries;
    usize count;
    (void) node_fs_watch_list(state->path, &entries, &count);
    int *fds = count == 0 ? nullptr : malloc(count * sizeof(int));
    if (count > 0 && fds == nullptr) {
        for (usize i = 0; i < count; i++) free(entries[i]);
        free(entries);
        return;
    }
    usize left = 0, right = 0, watched = 0;
    while (left < state->entry_count || right < count) {
        int order = left == state->entry_count ? 1 : right == count ? -1
            : strcmp(state->entries[left], entries[right]);
        if (order == 0) {
            fds[right] = state->entry_fds[left];
            if (fds[right] >= 0) watched++;
            left++;
            right++;
            continue;
        }
        bool active = announce && !state->closed && vm->completion.kind != MAL_COMPLETION_THROW;
        if (order < 0) {
            if (state->entry_fds[left] >= 0) close(state->entry_fds[left]);
            if (active) node_fs_watch_emit(vm, state, "rename", state->entries[left]);
            left++;
        } else {
            fds[right] = node_fs_watch_child(state, entries[right], watched);
            if (fds[right] >= 0) watched++;
            if (active) node_fs_watch_emit(vm, state, "rename", entries[right]);
            right++;
        }
    }
    for (usize i = 0; i < state->entry_count; i++) free(state->entries[i]);
    free(state->entries);
    free(state->entry_fds);
    state->entries = entries;
    state->entry_fds = fds;
    state->entry_count = count;
}

static const char *node_fs_watch_child_name(const NodeFsWatcher *state, int fd) {
    for (usize i = 0; i < state->entry_count; i++) {
        if (state->entry_fds[i] == fd) return state->entries[i];
    }
    return nullptr;
}
#endif

static void node_fs_watch_receive(MalVm *vm, NodeFsWatcher *state) {
#if defined(__APPLE__)
    struct kevent events[NODE_FS_WATCH_EVENTS];
    struct timespec zero = {0};
    int ready = kevent(state->fd, nullptr, 0, events, NODE_FS_WATCH_EVENTS, &zero);
    for (int i = 0; i < ready && !state->closed && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        u32 flags = events[i].fflags;
        if (events[i].udata != nullptr) {
            const char *name = node_fs_watch_child_name(state, (int) ((uintptr_t) events[i].udata - 1));
            if (name != nullptr) node_fs_watch_emit(vm, state, "change", name);
            continue;
        }
        if (state->directory && (flags & NOTE_WRITE) != 0) node_fs_watch_rescan(vm, state, true);
        if ((flags & (NOTE_DELETE | NOTE_RENAME | NOTE_REVOKE)) != 0) {
            node_fs_watch_emit(vm, state, "rename", state->basename);
        } else if (!state->directory && (flags & (NOTE_WRITE | NOTE_EXTEND | NOTE_ATTRIB)) != 0) {
            node_fs_watch_emit(vm, state, "change", state->basename);
        }
    }
#elif defined(__linux__)
    _Alignas(struct inotify_event) char buffer[4096];
    ssize_t length = read(state->fd, buffer, sizeof(buffer));
    for (ssize_t offset = 0; offset < length && !state->closed && vm->completion.kind != MAL_COMPLETION_THROW;) {
        const struct inotify_event *event = (const struct inotify_event *) (buffer + offset);
        offset += (ssize_t) (sizeof(struct inotify_event) + event->len);
        const char *name = event->len > 0 ? event->name : state->basename;
        if ((event->mask & (IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE_SELF
                | IN_MOVE_SELF)) != 0) {
            node_fs_watch_emit(vm, state, "rename", name);
        } else if ((event->mask & (IN_MODIFY | IN_ATTRIB)) != 0) {
            node_fs_watch_emit(vm, state, "change", name);
        }
    }
#endif
    if (!state->closed) (void) node_fs_watch_arm(state);
}

static bool node_fs_watch_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr || mal_host_tasks_pending(&host->tasks) == 0) return false;
    MalHostTask peek;
    if (!mal_host_peek_task(&host->tasks, &peek)) return false;
    NodeFsWatcher *state = node_fs_watchers;
    while (state != nullptr && (state->vm != vm || state->operation != peek.operation)) state = state->next;
    if (state == nullptr) return false;
    MalHostTask task;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    (void) mal_host_task_take_data(&host->tasks, &task);
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        // An iterator outlives its handle until next() has consumed the buffered events or the abort.
        if (!state->iterator || (state->queue_head == nullptr && !state->aborted)) node_fs_watcher_free(state);
        else state->operation = 0;
    } else if (!state->closed) {
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_realm_switch(vm, state->realm);
#endif
        MalAsyncContextScope scope;
        mal_async_context_scope_enter(vm, &scope, state->async_context);
        node_fs_watch_receive(vm, state);
        mal_async_context_scope_exit(vm, &scope);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
    }
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static int node_fs_watch_open(NodeFsWatcher *state) {
    MalPosixStat st;
    int error = mal_posix_fs_stat(state->path, &st);
    if (error != 0) return error;
    state->directory = (st.mode & S_IFMT) == S_IFDIR;
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
    if (state->directory) node_fs_watch_rescan(nullptr, state, false);
#elif defined(__linux__)
    state->fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
    if (state->fd < 0) return errno;
    if (inotify_add_watch(state->fd, state->path, IN_ATTRIB | IN_CREATE | IN_MODIFY | IN_DELETE | IN_DELETE_SELF
            | IN_MOVE_SELF | IN_MOVED_FROM | IN_MOVED_TO) < 0) {
        return errno;
    }
#else
    return ENOSYS;
#endif
    return 0;
}

static void node_fs_watch_close_handle(NodeFsWatcher *state) {
    state->closed = true;
    if (state->operation != 0) {
        node_fs_watch_disarm(state);
        mal_host_operation_unbind(&state->host->tasks, state->operation, state);
        (void) mal_host_operation_complete(&state->host->tasks, state->operation, MAL_HOST_TERMINAL_OK,
            nullptr, nullptr);
    }
    if (state->fd >= 0) close(state->fd);
    if (state->target_fd >= 0) close(state->target_fd);
    state->fd = -1;
    state->target_fd = -1;
}

static MalValue node_fs_watch_tick(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue emit_args[] = {node_fs_watch_ascii(vm, "close")};
    node_fs_watch_call(vm, mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0),
        "emit", emit_args, 1);
    return mal_value_new_undefined();
}

static MalValue node_fs_watcher_close(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    NodeFsWatcher *state = node_fs_watcher_find(receiver);
    if (state == nullptr || state->closed) return mal_value_new_undefined();
    node_fs_watch_close_handle(state);
    MalRootSpan root;
    mal_gc_root(&root, &receiver, 1);
    MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "emitCloseNT"), node_fs_watch_tick, &receiver, 1));
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_watcher_set_ref(MalValue receiver, bool referenced) {
    NodeFsWatcher *state = node_fs_watcher_find(receiver);
    if (state == nullptr || state->closed || state->unreferenced == !referenced) return receiver;
    if (state->read_op.active) state->host->reactor.unreferenced_ops += referenced ? -1 : 1;
    state->unreferenced = !referenced;
    return receiver;
}

static MalValue node_fs_watcher_ref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    return node_fs_watcher_set_ref(receiver, true);
}

static MalValue node_fs_watcher_unref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    return node_fs_watcher_set_ref(receiver, false);
}

static MalValue node_fs_watch_new_emitter(MalVm *vm, MalValue *proto_slot, const char *const *methods,
    const MalNativeFunctionCallback *callbacks, usize method_count) {
    if (!mal_value_is_object(*proto_slot)) {
        *proto_slot = mal_value_from_object(mal_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
        for (usize i = 0; i < method_count; i++) {
            mal_intrinsic_define_method_n(vm, mal_value_to_object(*proto_slot), (const byte *) methods[i],
                0, callbacks[i]);
        }
    }
    MalValue object = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(*proto_slot)));
    MalRootSpan root;
    mal_gc_root(&root, &object, 1);
    mal_vm_call_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR], object, nullptr, 0);
    mal_gc_unroot(&root);
    return object;
}

static bool node_fs_watch_install(MalVm *vm) {
    if (!mal_value_is_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])) {
        node_fs_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) "node:events is unavailable",
            (const byte *) "ERR_INTERNAL_ASSERTION");
        return false;
    }
    if (!node_fs_watch_installed) {
        mal_gc_register_root_source(node_fs_watch_scan_roots, nullptr);
        mal_host_register_macrotask_drain(node_fs_watch_drain, false);
        node_fs_watch_installed = true;
    }
    return true;
}

static bool node_fs_watch_options(MalVm *vm, MalValue options, bool *persistent, bool *buffer_names,
    MalValue *signal) {
    *persistent = true;
    *buffer_names = false;
    *signal = mal_value_new_undefined();
    MalValue encoding = mal_value_new_undefined();
    if (mal_value_is_string(options)) {
        encoding = options;
    } else if (mal_value_is_object(options)) {
        MalValue value;
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "persistent"), &value)) {
            return false;
        }
        if (!mal_value_is_undefined(value)) *persistent = mal_value_is_truthy(value);
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "encoding"), &encoding)
            || !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "signal"), signal)) {
            return false;
        }
        if (!mal_value_is_undefined(*signal) && !mal_value_is_object(*signal)) {
            mal_node_throw_invalid_arg_type(vm, "options.signal", "an instance of AbortSignal", *signal);
            return false;
        }
    } else if (!mal_value_is_undefined(options) && !mal_value_is_null(options)) {
        mal_node_throw_invalid_arg_type(vm, "options", "of type string or an instance of Object", options);
        return false;
    }
    *buffer_names = mal_value_is_string(encoding)
        && mal_string_equals_ascii(mal_value_to_string(encoding), "buffer");
    return true;
}

static void node_fs_watch_listen_abort(MalVm *vm, MalValue signal, MalValue handler) {
    MalValue values[] = {signal, handler, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    if (mal_vm_get_property(vm, values[0], mal_intrinsic_string_key(vm, (const byte *) "aborted"), &values[2])
        && mal_value_is_truthy(values[2])) {
        mal_vm_call_value(vm, values[1], mal_value_new_undefined(), nullptr, 0);
    } else if (vm->completion.kind != MAL_COMPLETION_THROW) {
        values[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_intrinsic_define_data(vm, mal_value_to_object(values[3]), (const byte *) "once",
            mal_value_new_boolean(true), NODE_FS_VISIBLE);
        MalValue args[] = {node_fs_watch_ascii(vm, "abort"), values[1], values[3]};
        MalRootSpan args_root;
        mal_gc_root(&args_root, args, 3);
        node_fs_watch_call(vm, values[0], "addEventListener", args, 3);
        mal_gc_unroot(&args_root);
    }
    mal_gc_unroot(&root);
}

/* Opens the kernel watch; on failure throws Node's `watch` error and returns nullptr. */
static NodeFsWatcher *node_fs_watch_start(MalVm *vm, MalValue filename, MalValue receiver, bool persistent,
    bool buffer_names) {
    char *path = node_fs_path_cstr(vm, filename);
    if (path == nullptr) return nullptr;
    NodeFsWatcher *state = calloc(1, sizeof(NodeFsWatcher));
    if (state == nullptr) {
        free(path);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    state->fd = -1;
    state->target_fd = -1;
    state->path = path;
    const char *slash = strrchr(path, '/');
    state->basename = slash != nullptr && slash[1] != '\0' ? (char *) slash + 1 : path;
    state->buffer_names = buffer_names;
    state->unreferenced = !persistent;
    state->pending = mal_value_new_undefined();
    state->abort_reason = mal_value_new_undefined();
    int error = node_fs_watch_open(state);
    MalHost *host = mal_host(vm);
    state->host = host;
    if (error == 0 && (host == nullptr || !mal_host_operation_start(&host->tasks, &state->operation))) error = ENOMEM;
    if (error == 0 && (!mal_host_operation_bind(&host->tasks, state->operation, state) || !node_fs_watch_arm(state)
            || !mal_host_operation_activate(&host->tasks, state->operation))) {
        node_fs_watch_disarm(state);
        mal_host_operation_unbind(&host->tasks, state->operation, state);
        (void) mal_host_operation_abort_start(&host->tasks, state->operation);
        state->operation = 0;
        error = ENOMEM;
    }
    if (error != 0) {
        node_fs_throw_errno(vm, error, "watch", path);
        state->operation = 0;
        node_fs_watch_close_handle(state);
        node_fs_watcher_free(state);
        return nullptr;
    }
    state->vm = vm;
    state->receiver = receiver;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    state->next = node_fs_watchers;
    node_fs_watchers = state;
    return state;
}

static MalValue node_fs_watch_aborted(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue watcher = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return node_fs_watcher_close(vm, watcher, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue node_fs_watch(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined,
        argc > 2 ? args[2] : undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    if (mal_value_is_callable(roots[1])) {
        roots[2] = roots[1];
        roots[1] = undefined;
    }
    bool persistent, buffer_names;
    if (!node_fs_watch_install(vm) || !node_fs_watch_options(vm, roots[1], &persistent, &buffer_names, &roots[4])) {
        goto done;
    }
    static const char *const methods[] = {"close", "ref", "unref"};
    static const MalNativeFunctionCallback callbacks[] = {
        node_fs_watcher_close, node_fs_watcher_ref, node_fs_watcher_unref};
    roots[3] = node_fs_watch_new_emitter(vm, &node_fs_watcher_proto, methods, callbacks, countof(methods));
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    if (node_fs_watch_start(vm, roots[0], roots[3], persistent, buffer_names) == nullptr) goto done;
    node_fs_watch_listen(vm, roots[3], "change", roots[2]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    if (mal_value_is_object(roots[4])) {
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "onAborted"), node_fs_watch_aborted, &roots[3], 1));
        node_fs_watch_listen_abort(vm, roots[4], roots[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    result = roots[3];
done:
    mal_gc_unroot(&root);
    return result;
}

static NodeFsWatcher *node_fs_watch_iterator_state(MalValue callee) {
    MalValue iterator = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return node_fs_watcher_find(iterator);
}

static MalValue node_fs_watch_iterator_next(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    NodeFsWatcher *state = node_fs_watcher_find(receiver);
    MalValue values[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalValue promise = values[0];
    MalPromiseObject *object = mal_value_to_promise_object(promise);
    if (state != nullptr && state->aborted) {
        values[1] = state->abort_reason;
        if (state->operation == 0) node_fs_watcher_free(state);
        else state->aborted = false;
        mal_promise_reject(vm, object, mal_node_abort_error(vm, values[1]));
    } else if (state != nullptr && state->queue_head != nullptr) {
        NodeFsWatchEvent *event = state->queue_head;
        state->queue_head = event->next;
        if (state->queue_head == nullptr) state->queue_tail = nullptr;
        values[1] = event->result;
        MalValue value = values[1];
        free(event);
        if (state->queue_head == nullptr && state->closed && state->operation == 0 && !state->aborted) {
            node_fs_watcher_free(state);
        }
        mal_promise_fulfill(vm, object, value);
    } else if (state == nullptr || state->closed) {
        mal_promise_fulfill(vm, object, mal_vm_create_iter_result(vm, mal_value_new_undefined(), true));
    } else {
        state->pending = promise;
    }
    mal_gc_unroot(&root);
    return promise;
}

static void node_fs_watch_iterator_finish(MalVm *vm, NodeFsWatcher *state, bool aborted, MalValue reason) {
    if (state->closed) return;
    node_fs_watch_close_handle(state);
    while (state->queue_head != nullptr) {
        NodeFsWatchEvent *event = state->queue_head;
        state->queue_head = event->next;
        free(event);
    }
    state->queue_tail = nullptr;
    if (mal_value_is_object(state->pending)) {
        MalPromiseObject *promise = mal_value_to_promise_object(state->pending);
        state->pending = mal_value_new_undefined();
        if (aborted) mal_promise_reject(vm, promise, mal_node_abort_error(vm, reason));
        else mal_promise_fulfill(vm, promise, mal_vm_create_iter_result(vm, mal_value_new_undefined(), true));
    } else if (aborted) {
        state->aborted = true;
        state->abort_reason = reason;
    }
}

static MalValue node_fs_watch_iterator_return(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    NodeFsWatcher *state = node_fs_watcher_find(receiver);
    if (state != nullptr) node_fs_watch_iterator_finish(vm, state, false, mal_value_new_undefined());
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, &promise, 1);
    mal_promise_fulfill(vm, mal_value_to_promise_object(promise),
        mal_vm_create_iter_result(vm, mal_value_new_undefined(), true));
    mal_gc_unroot(&root);
    return promise;
}

static MalValue node_fs_watch_iterator_self(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    return receiver;
}

static MalValue node_fs_watch_iterator_aborted(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    NodeFsWatcher *state = node_fs_watch_iterator_state(callee);
    MalValue signal = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalValue reason = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &reason, 1);
    (void) mal_vm_get_property(vm, signal, mal_intrinsic_string_key(vm, (const byte *) "reason"), &reason);
    if (state != nullptr) node_fs_watch_iterator_finish(vm, state, true, reason);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_watch_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    bool persistent, buffer_names;
    if (!node_fs_watch_install(vm) || !node_fs_watch_options(vm, roots[1], &persistent, &buffer_names, &roots[3])) {
        goto done;
    }
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE])));
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[2]), (const byte *) "next", 0,
        node_fs_watch_iterator_next);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[2]), (const byte *) "return", 0,
        node_fs_watch_iterator_return);
    MalValue self = mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "[Symbol.asyncIterator]"), 0, node_fs_watch_iterator_self));
    MalPropertyDesc descriptor = {.value = self, .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE};
    mal_object_define_own(mal_value_to_object(roots[2]),
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &descriptor);
    NodeFsWatcher *state = node_fs_watch_start(vm, roots[0], roots[2], persistent, buffer_names);
    if (state == nullptr) goto done;
    state->iterator = true;
    if (mal_value_is_object(roots[3])) {
        MalValue slots[] = {roots[2], roots[3]};
        roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "onAborted"), node_fs_watch_iterator_aborted, slots, 2));
        node_fs_watch_listen_abort(vm, roots[3], roots[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}

static NodeFsStatWatcher *node_fs_stat_watcher_find_path(MalVm *vm, const char *path) {
    for (NodeFsStatWatcher *state = node_fs_stat_watchers; state != nullptr; state = state->next) {
        if (state->vm == vm && strcmp(state->path, path) == 0) return state;
    }
    return nullptr;
}

static void node_fs_stat_watcher_stop(NodeFsStatWatcher *state) {
    NodeFsStatWatcher **link = &node_fs_stat_watchers;
    while (*link != nullptr && *link != state) link = &(*link)->next;
    if (*link == state) *link = state->next;
    mal_host_clear_timeout(state->vm, state->timer);
    free(state->path);
    free(state);
}

static bool node_fs_stat_same(const MalPosixStat *left, const MalPosixStat *right) {
    return left->mtime_ms == right->mtime_ms && left->ctime_ms == right->ctime_ms && left->size == right->size
        && left->ino == right->ino && left->dev == right->dev && left->mode == right->mode
        && left->nlink == right->nlink && left->uid == right->uid && left->gid == right->gid;
}

static MalValue node_fs_stat_watcher_poll(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue watcher = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    NodeFsStatWatcher *state = node_fs_stat_watchers;
    while (state != nullptr && state->receiver != watcher) state = state->next;
    if (state == nullptr) return mal_value_new_undefined();
    MalPosixStat current = {0};
    if (mal_posix_fs_stat(state->path, &current) != 0) current = (MalPosixStat) {0};
    // Node reports a path missing at start once, with both Stats zeroed.
    bool report_missing = state->initially_missing && node_fs_stat_same(&current, &state->previous);
    state->initially_missing = false;
    if (!report_missing && node_fs_stat_same(&current, &state->previous)) return mal_value_new_undefined();
    MalPosixStat previous = state->previous;
    state->previous = current;
    MalValue values[] = {node_fs_watch_ascii(vm, "change"), watcher, mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalObject *proto = mal_value_to_object(state->stats_proto);
    values[2] = node_fs_make_stats(vm, proto, &current);
    values[3] = node_fs_make_stats(vm, proto, &previous);
    MalValue emit_args[] = {values[0], values[2], values[3]};
    node_fs_watch_call(vm, values[1], "emit", emit_args, 3);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue node_fs_stat_watcher_set_ref(MalVm *vm, MalValue receiver, bool referenced) {
    for (NodeFsStatWatcher *state = node_fs_stat_watchers; state != nullptr; state = state->next) {
        if (state->receiver == receiver) mal_host_timer_set_referenced(vm, state->timer, referenced);
    }
    return receiver;
}

static MalValue node_fs_stat_watcher_ref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return node_fs_stat_watcher_set_ref(vm, receiver, true);
}

static MalValue node_fs_stat_watcher_unref(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return node_fs_stat_watcher_set_ref(vm, receiver, false);
}

static MalValue node_fs_watch_file(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined,
        argc > 2 ? args[2] : undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    char *path = nullptr;
    if (mal_value_is_callable(roots[1])) {
        roots[2] = roots[1];
        roots[1] = undefined;
    }
    path = node_fs_path_cstr(vm, roots[0]);
    if (path == nullptr || !node_fs_watch_install(vm)) goto done;
    bool persistent = true;
    f64 interval = 5007;
    if (mal_value_is_object(roots[1])) {
        MalValue value;
        if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "persistent"), &value)) {
            goto done;
        }
        if (!mal_value_is_undefined(value)) persistent = mal_value_is_truthy(value);
        if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "interval"), &value)) {
            goto done;
        }
        if (mal_ops_is_number(value)) interval = mal_ops_to_number(value);
    }
    if (!mal_value_is_callable(roots[2])) {
        mal_node_throw_invalid_arg_type(vm, "listener", "of type function", roots[2]);
        goto done;
    }
    NodeFsStatWatcher *state = node_fs_stat_watcher_find_path(vm, path);
    if (state == nullptr) {
        static const char *const methods[] = {"ref", "unref"};
        static const MalNativeFunctionCallback callbacks[] = {node_fs_stat_watcher_ref, node_fs_stat_watcher_unref};
        roots[3] = node_fs_watch_new_emitter(vm, &node_fs_stat_watcher_proto, methods, callbacks, countof(methods));
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
        state = calloc(1, sizeof(NodeFsStatWatcher));
        if (state == nullptr) {
            mal_vm_throw_allocation_error(vm);
            goto done;
        }
        state->vm = vm;
        state->receiver = roots[3];
        state->stats_proto = mal_value_from_object(node_fs_slot_proto(vm, callee));
        state->path = path;
        path = nullptr;
        if (mal_posix_fs_stat(state->path, &state->previous) != 0) {
            state->previous = (MalPosixStat) {0};
            state->initially_missing = true;
        }
        state->next = node_fs_stat_watchers;
        node_fs_stat_watchers = state;
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "onchange"), node_fs_stat_watcher_poll, &roots[3], 1));
        state->timer = mal_host_set_interval(vm, roots[4], interval < 1 ? 1 : (i64) interval, nullptr, 0);
        if (!persistent) mal_host_timer_set_referenced(vm, state->timer, false);
    }
    roots[3] = state->receiver;
    node_fs_watch_listen(vm, roots[3], "change", roots[2]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    result = roots[3];
done:
    free(path);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_unwatch_file(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined, undefined, undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    char *path = node_fs_path_cstr(vm, roots[0]);
    NodeFsStatWatcher *state = path == nullptr ? nullptr : node_fs_stat_watcher_find_path(vm, path);
    free(path);
    if (state != nullptr) {
        roots[2] = state->receiver;
        MalValue name = node_fs_watch_ascii(vm, "change");
        MalValue call_args[] = {name, roots[1]};
        MalRootSpan args_root;
        mal_gc_root(&args_root, call_args, 2);
        if (mal_value_is_callable(roots[1])) node_fs_watch_call(vm, roots[2], "removeListener", call_args, 2);
        else node_fs_watch_call(vm, roots[2], "removeAllListeners", call_args, 1);
        MalValue count = undefined;
        if (vm->completion.kind != MAL_COMPLETION_THROW
            && mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "listenerCount"),
                &roots[3])) {
            MalCompletion counted = mal_vm_call_value(vm, roots[3], roots[2], call_args, 1);
            if (counted.kind == MAL_COMPLETION_NORMAL) count = counted.value;
        }
        mal_gc_unroot(&args_root);
        if (vm->completion.kind != MAL_COMPLETION_THROW && (!mal_ops_is_number(count)
                || mal_ops_to_number(count) == 0)) {
            node_fs_stat_watcher_stop(state);
        }
    }
    mal_gc_unroot(&root);
    return undefined;
}

static MalValue node_fs_export_realpath(
    MalVm *vm, MalObject *fn_proto, const char *name, bool sync) {
    MalNativeFunctionCallback callback = sync ? node_fs_job_sync : node_fs_job_callback;
    MalValue roots[] = {
        sync ? node_fs_make_fn(vm, fn_proto, name, 2, node_fs_realpath_sync)
            : node_fs_make_job_fn(vm, fn_proto, name, 3, callback, NODE_FS_JOB_REALPATH,
                mal_value_new_undefined()),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = node_fs_make_job_fn(vm, fn_proto, "", sync ? 2 : 3, callback, NODE_FS_JOB_REALPATH_NATIVE, mal_value_new_undefined());
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "native", roots[1],
        NODE_FS_VISIBLE);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_fs_export(
    MalVm *vm, MalObject *fn_proto, const char *name, const MalValue *protos) {
    for (usize i = 0; i < countof(node_fs_job_exports); i++) {
        if (strcmp(name, node_fs_job_exports[i].name) != 0) continue;
        NodeFsJobKind kind = node_fs_job_exports[i].kind;
        bool stats = kind == NODE_FS_JOB_LSTAT || kind == NODE_FS_JOB_FSTAT;
        return node_fs_make_job_fn(vm, fn_proto, name, node_fs_job_exports[i].arity,
            node_fs_job_exports[i].sync ? node_fs_job_sync : node_fs_job_callback, (i32) kind,
            stats ? protos[0] : mal_value_new_undefined());
    }
    if (strcmp(name, "readvSync") == 0 || strcmp(name, "writevSync") == 0) {
        return node_fs_make_job_fn(vm, fn_proto, name, 3, node_fs_vector_sync,
            (i32) (name[0] == 'r' ? NODE_FS_JOB_READV : NODE_FS_JOB_WRITEV),
            mal_value_new_undefined());
    }
    if (strcmp(name, "realpath") == 0 || strcmp(name, "realpathSync") == 0) {
        return node_fs_export_realpath(vm, fn_proto, name, strcmp(name, "realpathSync") == 0);
    }
    if (strcmp(name, "watch") == 0) return node_fs_make_fn(vm, fn_proto, name, 3, node_fs_watch);
    if (strcmp(name, "watchFile") == 0) return node_fs_make_fn_slot(vm, fn_proto, name, 3, node_fs_watch_file, protos[0]);
    if (strcmp(name, "unwatchFile") == 0) return node_fs_make_fn(vm, fn_proto, name, 2, node_fs_unwatch_file);
    if (strcmp(name, "writeFile") == 0 || strcmp(name, "appendFile") == 0) {
        bool append = strcmp(name, "appendFile") == 0;
        return node_fs_make_job_fn(vm, fn_proto, name, 4, node_fs_write_file_callback,
            (i32) (MAL_POSIX_OPEN_WRITE | MAL_POSIX_OPEN_CREATE
                | (append ? MAL_POSIX_OPEN_APPEND : MAL_POSIX_OPEN_TRUNCATE)),
            mal_value_new_undefined());
    }
    if (strcmp(name, "Stats") == 0) {
        return node_fs_make_constructor_slot(
            vm, fn_proto, "Stats", node_fs_stats_constructor, protos[0]);
    }
    if (strcmp(name, "access") == 0) {
        return node_fs_make_regular_fn(vm, fn_proto, "access", 3,
            node_fs_path_callback, NODE_FS_JOB_ACCESS);
    }
    if (strcmp(name, "unlink") == 0) {
        return node_fs_make_regular_fn(vm, fn_proto, "unlink", 2,
            node_fs_path_callback, NODE_FS_JOB_UNLINK);
    }
    if (strcmp(name, "rename") == 0) {
        return node_fs_make_regular_fn(vm, fn_proto, "rename", 3,
            node_fs_path_callback, NODE_FS_JOB_RENAME);
    }
    if (strcmp(name, "accessSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "accessSync", 2, node_fs_access_sync);
    }
    if (strcmp(name, "createReadStream") == 0) {
        return node_fs_make_fn_slot(vm, fn_proto, "createReadStream", 2,
            node_fs_create_read_stream, protos[3]);
    }
    if (strcmp(name, "createWriteStream") == 0) {
        return node_fs_make_fn_slot(vm, fn_proto, "createWriteStream", 2,
            node_fs_create_write_stream, protos[4]);
    }
    if (strcmp(name, "ReadStream") == 0) {
        return node_fs_make_constructor_slot(
            vm, fn_proto, "ReadStream", node_fs_create_read_stream, protos[3]);
    }
    if (strcmp(name, "WriteStream") == 0) {
        return node_fs_make_constructor_slot(
            vm, fn_proto, "WriteStream", node_fs_create_write_stream, protos[4]);
    }
    if (strcmp(name, "Dir") == 0) {
        return node_fs_make_constructor_slot(vm, fn_proto, "Dir", node_fs_dir_constructor, protos[2]);
    }
    if (strcmp(name, "Dirent") == 0) {
        return node_fs_make_constructor_slot(
            vm, fn_proto, "Dirent", node_fs_dirent_constructor, protos[1]);
    }
    if (strcmp(name, "opendirSync") == 0 || strcmp(name, "opendir") == 0) {
        MalValue slots[] = {protos[2], protos[1]};
        MalValue operation = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(&vm->heap, fn_proto,
                mal_intrinsic_ascii(vm, "opendirSync"), 2, node_fs_opendir_sync, slots,
                countof(slots)));
        if (strcmp(name, "opendirSync") == 0) return operation;
        MalRootSpan root;
        mal_gc_root(&root, &operation, 1);
        MalValue result = node_fs_make_fn_slot(
            vm, fn_proto, "opendir", 3, node_fs_callback_operation, operation);
        mal_gc_unroot(&root);
        return result;
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
    if (strcmp(name, "statfsSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "statfsSync", 1, node_fs_statfs_sync);
    }
    if (strcmp(name, "fstatSync") == 0) {
        return node_fs_make_fn_slot(
            vm, fn_proto, "fstatSync", 1, node_fs_fstat_sync, protos[0]);
    }
    if (strcmp(name, "fsyncSync") == 0) {
        return node_fs_regular_function(vm,
            node_fs_make_fn(vm, fn_proto, "fsyncSync", 1, node_fs_fsync_sync));
    }
    if (strcmp(name, "fdatasyncSync") == 0) {
        return node_fs_regular_function(vm,
            node_fs_make_fn(vm, fn_proto, "fdatasyncSync", 1, node_fs_fdatasync_sync));
    }
    if (strcmp(name, "fsync") == 0 || strcmp(name, "fdatasync") == 0) {
        return node_fs_make_regular_fn(vm, fn_proto, name, 2, node_fs_sync_callback,
            strcmp(name, "fsync") == 0 ? NODE_FS_JOB_FSYNC : NODE_FS_JOB_FDATASYNC);
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
    if (strcmp(name, "copyFileSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "copyFileSync", 2, node_fs_copy_file_sync);
    }
    if (strcmp(name, "cp") == 0) return node_fs_make_fn(vm, fn_proto, "cp", 4, node_fs_cp_callback);
    if (strcmp(name, "cpSync") == 0) return node_fs_make_fn(vm, fn_proto, "cpSync", 3, node_fs_cp_sync);
    if (strcmp(name, "glob") == 0) {
        return node_fs_make_fn_slot(vm, fn_proto, "glob", 3, node_fs_glob_callback, protos[1]);
    }
    if (strcmp(name, "globSync") == 0) {
        return node_fs_make_fn_slot(vm, fn_proto, "globSync", 2, node_fs_glob_sync, protos[1]);
    }
    if (strcmp(name, "renameSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "renameSync", 2, node_fs_rename_sync);
    }
    if (strcmp(name, "mkdtempSync") == 0) {
        return node_fs_regular_function(vm,
            node_fs_make_fn(vm, fn_proto, "mkdtempSync", 2, node_fs_mkdtemp_sync));
    }
    if (strcmp(name, "mkdtemp") == 0) {
        return node_fs_regular_function(vm,
            node_fs_make_fn(vm, fn_proto, "mkdtemp", 3, node_fs_mkdtemp_callback));
    }
    if (strcmp(name, "mkdtempDisposableSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "mkdtempDisposableSync", 2, node_fs_mkdtemp_disposable_sync);
    }
    if (strcmp(name, "rmSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "rmSync", 1, node_fs_rm_sync);
    }
    if (strcmp(name, "rmdirSync") == 0) {
        return node_fs_make_fn(vm, fn_proto, "rmdirSync", 1, node_fs_rmdir_sync);
    }
    return mal_value_new_undefined();
}

static MalValue node_fs_get_promises(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    return vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE];
}

static void node_fs_install_promises_slots(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count
) {
    for (i32 index = 0; index < count; index++) {
        if (strcmp(slots[index].name, "promises") == 0) {
            vm->globals[slots[index].slot] = vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE];
        }
    }
}

void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:fs", slots, count)) {
        node_fs_install_promises_slots(vm, slots, count);
        return;
    }
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:fs", slots, count, cached);
        node_fs_install_promises_slots(vm, slots, count);
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

    // The Stats, Dirent, Dir, ReadStream and WriteStream prototypes stay alive through
    // the export closure slots that hold them; root them until those closures are built.
    MalValue protos[5];
    for (usize i = 0; i < countof(protos); i++) protos[i] = mal_value_new_undefined();
    MalRootSpan proto_rs;
    mal_gc_root(&proto_rs, protos, countof(protos));

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

    MalObject *dir_proto = mal_object_new(&vm->heap, obj_proto);
    protos[2] = mal_value_from_object(dir_proto);
    mal_intrinsic_define_method_n(vm, dir_proto, "read", 1, node_fs_dir_read);
    mal_intrinsic_define_method_n(vm, dir_proto, "readSync", 0, node_fs_dir_read_sync);
    mal_intrinsic_define_method_n(vm, dir_proto, "close", 1, node_fs_dir_close);
    mal_intrinsic_define_method_n(vm, dir_proto, "closeSync", 0, node_fs_dir_close_sync);
    {
        MalValue iterator = node_fs_make_fn(vm, fn_proto, "[Symbol.asyncIterator]", 0,
            node_fs_dir_async_iterator);
        MalRootSpan iterator_root;
        mal_gc_root(&iterator_root, &iterator, 1);
        MalPropertyDesc descriptor = mal_intrinsic_data_desc(iterator,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(dir_proto,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &descriptor);
        mal_gc_unroot(&iterator_root);
    }
    protos[3] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE])));
    protos[4] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE])));

    static const char *names[] = {
        "Dir", "Dirent", "ReadStream", "WriteStream", "createWriteStream", "opendir",
        "opendirSync", "readv", "readvSync", "statfs", "writev", "writevSync",
        "Stats", "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync",
        "chown", "chownSync", "close", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync",
        "createReadStream", "exists", "existsSync", "fchmod", "fchmodSync", "fchown",
        "fchownSync", "fdatasync", "fdatasyncSync", "fstat", "fstatSync", "fsync", "fsyncSync",
        "ftruncate", "ftruncateSync", "futimes", "futimesSync", "glob", "globSync", "lchown", "lchownSync", "link",
        "linkSync", "lstat", "lstatSync", "lutimes", "lutimesSync", "mkdir", "mkdirSync",
        "mkdtemp", "mkdtempDisposableSync", "mkdtempSync", "open", "openSync", "read", "readFile", "readFileSync",
        "readlink", "readlinkSync", "readSync", "readdir", "readdirSync", "realpath",
        "realpathSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "statSync",
        "stat", "statfsSync", "symlink", "symlinkSync", "truncate", "truncateSync", "unlink",
        "unlinkSync", "unwatchFile", "utimes", "utimesSync", "watch", "watchFile", "write", "writeFile",
        "writeFileSync", "writeSync",
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
    static const struct {
        const char *alias;
        const char *name;
    } aliases[] = {{"FileReadStream", "ReadStream"}, {"FileWriteStream", "WriteStream"}};
    for (usize i = 0; i < countof(aliases); i++) {
        MalValue value = mal_value_new_undefined();
        mal_vm_get_property(vm, module, mal_intrinsic_string_key(vm, aliases[i].name), &value);
        mal_intrinsic_define_data(vm, mal_value_to_object(module), aliases[i].alias, value,
            NODE_FS_VISIBLE);
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
    mal_intrinsic_define_getter(vm, mal_value_to_object(module), "promises", "get",
        node_fs_get_promises, MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&constants_root);
    vm->intrinsics[MAL_INTRINSIC_NODE_FS_MODULE] = module;
    mal_node_module_publish(vm, "node:fs", nullptr, 0, module);
    // Capture the filesystem implementations before public export mutation can replace them.
    mal_host_install_node_fs_promises(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&module_root);
        mal_gc_unroot(&proto_rs);
        return;
    }
    mal_node_module_publish(vm, "node:fs", slots, count, module);
    node_fs_install_promises_slots(vm, slots, count);
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
    cached = vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:fs/promises", slots, count, cached);
        return;
    }
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
        {"opendir", "opendirSync", 2},
        {"readFile", "readFileSync", 1},
        {"readlink", "readlinkSync", 1},
        {"readdir", "readdirSync", 1},
        {"realpath", "realpathSync", 1},
        {"rm", "rmSync", 1},
        {"rmdir", "rmdirSync", 1},
        {"stat", "statSync", 1},
        {"symlink", "symlinkSync", 2},
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
    roots[1] = node_fs_make_fn(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]),
        "cp", 3, node_fs_cp_promise);
    mal_native_function_object_set_async(mal_value_to_native_function_object(roots[1]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "cp", roots[1], NODE_FS_VISIBLE);
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, "readdirSync"), &roots[1])) {
        mal_gc_unroot(&root);
        return;
    }
    MalValue dirent_proto = mal_native_function_object_get_slot(mal_value_to_native_function_object(roots[1]), 0);
    roots[1] = node_fs_make_fn_slot(vm, fn_proto, "glob", 1, node_fs_glob, dirent_proto);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "glob", roots[1], NODE_FS_VISIBLE);

    static const struct {
        const char *name;
        i32 arity;
        NodeFsJobKind kind;
    } paths[] = {
        {"access", 1, NODE_FS_JOB_ACCESS},
        {"unlink", 1, NODE_FS_JOB_UNLINK},
        {"rename", 2, NODE_FS_JOB_RENAME},
    };
    for (usize index = 0; index < countof(paths); index++) {
        MalValue kind = mal_value_from_i32((i32) paths[index].kind);
        roots[1] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, paths[index].name), paths[index].arity,
                node_fs_path_promise, &kind, 1));
        mal_native_function_object_set_async(mal_value_to_native_function_object(roots[1]));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), paths[index].name,
            roots[1], NODE_FS_VISIBLE);
    }

    static const struct {
        const char *name;
        i32 arity;
        NodeFsJobKind kind;
    } jobs[] = {
        {"chown", 3, NODE_FS_JOB_CHOWN},
        {"lchown", 3, NODE_FS_JOB_LCHOWN},
        {"lutimes", 3, NODE_FS_JOB_LUTIMES},
        {"statfs", 1, NODE_FS_JOB_STATFS},
        {"truncate", 1, NODE_FS_JOB_TRUNCATE},
    };
    for (usize index = 0; index < countof(jobs); index++) {
        MalValue job_slots[] = {mal_value_from_i32((i32) jobs[index].kind), mal_value_new_undefined()};
        roots[1] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, jobs[index].name), jobs[index].arity,
                node_fs_job_promise, job_slots, countof(job_slots)));
        mal_native_function_object_set_async(mal_value_to_native_function_object(roots[1]));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), jobs[index].name,
            roots[1], NODE_FS_VISIBLE);
    }

    roots[1] = node_fs_make_fn(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]),
        "mkdtemp", 2, node_fs_mkdtemp_promise);
    mal_native_function_object_set_async(mal_value_to_native_function_object(roots[1]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "mkdtemp", roots[1], NODE_FS_VISIBLE);
    roots[1] = node_fs_make_fn(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE]),
        "mkdtempDisposable", 2, node_fs_mkdtemp_disposable_promise);
    mal_native_function_object_set_async(mal_value_to_native_function_object(roots[1]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "mkdtempDisposable", roots[1],
        NODE_FS_VISIBLE);
    roots[1] = node_fs_make_fn(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]), "watch", 2, node_fs_watch_promise);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "watch", roots[1], NODE_FS_VISIBLE);

    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, "constants"), &roots[1])) {
        mal_gc_unroot(&root);
        return;
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), "constants", roots[1], NODE_FS_VISIBLE);

    vm->intrinsics[MAL_INTRINSIC_NODE_FS_PROMISES_MODULE] = roots[2];
    mal_node_module_publish(vm, "node:fs/promises", slots, count, roots[2]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
