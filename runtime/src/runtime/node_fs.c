#include "node_fs.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "posix_fs.h" // host layer: the POSIX syscalls + errno results
#include "property_store.h"
#include "table.h"
#include "text_encoding.h"
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
    usize count;
    c16 *units = mal_utf8_decode(bytes, len, &count);
    MalValue s = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
    free(units);
    return s;
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
    const c16 *units = mal_string_code_units(str);
    usize unit_len = mal_string_length(str);
    for (usize i = 0; i < unit_len; i++) {
        if (units[i] == 0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "filesystem path must not contain null bytes");
            return nullptr;
        }
    }
    usize len;
    byte *bytes = mal_utf8_encode(units, unit_len, &len);
    bytes[len] = '\0'; // mal_utf8_encode over-allocates (len*3+1), so the NUL always fits
    return (char *) bytes;
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
static void node_fs_throw_errno(MalVm *vm, int err, const char *syscall, const char *path) {
    const char *code = mal_posix_fs_errno_name(err);
    const char *desc = strerror(err);
    usize cap = strlen(code) + strlen(desc) + strlen(syscall) + strlen(path) + 16;
    char *message = malloc(cap);
    if (message != nullptr) {
        snprintf(message, cap, "%s: %s, %s '%s'", code, desc, syscall, path);
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
    }
}

static MalKey node_fs_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
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

/* A Stats object over `proto` carrying mtimeMs plus the hidden type marker the
 * predicates read. */
static MalValue node_fs_make_stats(MalVm *vm, MalObject *proto, const MalPosixStat *st) {
    MalObject *stats = mal_object_new(&vm->heap, proto);
    MalValue v = mal_value_from_object(stats);
    MalRootSpan rs;
    mal_gc_root(&rs, &v, 1);
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
    // Any encoding argument is accepted but ignored: this slice returns a UTF-8
    // string (there is no Buffer to hand back the raw bytes).
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
    MalValue result = node_fs_string_from_utf8(vm, data, len);
    free(data);
    return result;
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
        owned = mal_utf8_encode(mal_string_code_units(str), mal_string_length(str), &len);
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
        mal_object_set(array_obj, node_fs_index_key((u32) i), element);
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

void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
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

    MalObject *dirent_proto = mal_object_new(&vm->heap, obj_proto);
    protos[1] = mal_value_from_object(dirent_proto);
    mal_intrinsic_define_method_n(vm, dirent_proto, (const byte *) "isFile", 0, node_fs_is_file);
    mal_intrinsic_define_method_n(
        vm, dirent_proto, (const byte *) "isDirectory", 0, node_fs_is_directory);

    for (i32 i = 0; i < count; i++) {
        const char *name = slots[i].name;
        MalValue fn;
        if (strcmp(name, "existsSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "existsSync", 1, node_fs_exists_sync);
        } else if (strcmp(name, "readFileSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "readFileSync", 1, node_fs_read_file_sync);
        } else if (strcmp(name, "writeFileSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "writeFileSync", 2, node_fs_write_file_sync);
        } else if (strcmp(name, "statSync") == 0) {
            fn = node_fs_make_fn_slot(vm, fn_proto, "statSync", 1, node_fs_stat_sync, protos[0]);
        } else if (strcmp(name, "readdirSync") == 0) {
            fn = node_fs_make_fn_slot(
                vm, fn_proto, "readdirSync", 1, node_fs_readdir_sync, protos[1]);
        } else if (strcmp(name, "mkdirSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "mkdirSync", 1, node_fs_mkdir_sync);
        } else if (strcmp(name, "copyFileSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "copyFileSync", 2, node_fs_copy_file_sync);
        } else if (strcmp(name, "realpathSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "realpathSync", 1, node_fs_realpath_sync);
        } else if (strcmp(name, "mkdtempSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "mkdtempSync", 1, node_fs_mkdtemp_sync);
        } else if (strcmp(name, "rmSync") == 0) {
            fn = node_fs_make_fn(vm, fn_proto, "rmSync", 1, node_fs_rm_sync);
        } else {
            continue; // unknown export: leave the slot at its undefined init
        }
        vm->globals[slots[i].slot] = fn;
    }

    mal_gc_unroot(&proto_rs);
}

#endif /* MAL_NODE */
