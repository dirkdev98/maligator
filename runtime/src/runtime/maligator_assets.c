#include "maligator_assets.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "builtin_json.h"
#include "builtin_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "posix_fs.h"
#include "sha256.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value.h"
#include "vm_ops.h"

#define MAL_ASSET_COMPLETION_MARKER ".maligator-asset-complete"

/* A negative status no errno uses: the path exists but is not a regular file. */
#define ASSET_IRREGULAR (-1)

static const MalPropertyFlags ASSET_METHOD = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
static const MalPropertyFlags ASSET_FIELD = MAL_PROPERTY_ENUMERABLE;

static void asset_throw(MalVm *vm, MalIntrinsic prototype, const char *message) {
    MalString *text = mal_string_from_utf8(&vm->heap, (const byte *) message, strlen(message));
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    MalValue value = mal_value_from_string(text);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_vm_throw_error_value(vm, prototype, value);
    mal_gc_unroot(&root);
}

static void asset_throw_errno(MalVm *vm, int err, const char *operation, const char *path) {
    const char *reason = err == ASSET_IRREGULAR ? "not a regular file" : strerror(err);
    usize length = strlen(operation) + strlen(path) + strlen(reason) + 32;
    char *message = malloc(length);
    if (message == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    snprintf(message, length, "maligator:assets: %s '%s': %s", operation, path, reason);
    asset_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
    free(message);
}

/* A malloc'd UTF-8 copy of a string value, or null after throwing. */
static char *asset_cstr(MalVm *vm, MalValue value, const char *what) {
    if (!mal_value_is_string(value)) {
        char message[96];
        snprintf(message, sizeof message, "The \"%s\" argument must be a string", what);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
        return nullptr;
    }
    char *bytes = nullptr;
    usize length = 0;
    MalUtf8CStringResult result =
        mal_string_to_utf8_c_string(mal_value_to_string(value), &bytes, &length);
    if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Asset paths must not contain null bytes");
        return nullptr;
    }
    if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return bytes;
}

static MalValue asset_string(MalVm *vm, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static char *asset_join(const char *left, const char *right) {
    usize left_length = strlen(left);
    usize right_length = strlen(right);
    bool separator = left_length > 0 && left[left_length - 1] != '/';
    if (left_length > SIZE_MAX - right_length - (separator ? 2 : 1)) return nullptr;
    char *joined = malloc(left_length + right_length + (separator ? 2 : 1));
    if (joined == nullptr) return nullptr;
    memcpy(joined, left, left_length);
    usize offset = left_length;
    if (separator) joined[offset++] = '/';
    memcpy(joined + offset, right, right_length + 1);
    return joined;
}

/* A slash-separated path that stays below its directory. */
static bool asset_safe_relative_path(const char *path) {
    if (path[0] == '\0' || path[0] == '/') return false;
    const char *component = path;
    for (const char *cursor = path;; cursor++) {
        if (*cursor == '\\') return false;
        if (*cursor == '/' || *cursor == '\0') {
            usize length = (usize) (cursor - component);
            if (length == 0 || (length == 1 && component[0] == '.')
                || (length == 2 && component[0] == '.' && component[1] == '.')) {
                return false;
            }
            if (*cursor == '\0') return true;
            component = cursor + 1;
        }
    }
}

/*
 * Media types by extension. Text types carry their charset because the bytes are
 * served as written; anything unknown is opaque.
 */
const char *mal_asset_media_type(const char *path) {
    static const struct {
        const char *extension;
        const char *type;
    } types[] = {
        {"avif", "image/avif"},
        {"css", "text/css; charset=utf-8"},
        {"csv", "text/csv; charset=utf-8"},
        {"gif", "image/gif"},
        {"gz", "application/gzip"},
        {"htm", "text/html; charset=utf-8"},
        {"html", "text/html; charset=utf-8"},
        {"ico", "image/x-icon"},
        {"jpeg", "image/jpeg"},
        {"jpg", "image/jpeg"},
        {"js", "text/javascript; charset=utf-8"},
        {"json", "application/json"},
        {"map", "application/json"},
        {"md", "text/markdown; charset=utf-8"},
        {"mjs", "text/javascript; charset=utf-8"},
        {"mp3", "audio/mpeg"},
        {"mp4", "video/mp4"},
        {"ogg", "audio/ogg"},
        {"otf", "font/otf"},
        {"pdf", "application/pdf"},
        {"png", "image/png"},
        {"svg", "image/svg+xml"},
        {"ttf", "font/ttf"},
        {"txt", "text/plain; charset=utf-8"},
        {"wasm", "application/wasm"},
        {"wav", "audio/wav"},
        {"webm", "video/webm"},
        {"webmanifest", "application/manifest+json"},
        {"webp", "image/webp"},
        {"woff", "font/woff"},
        {"woff2", "font/woff2"},
        {"xml", "application/xml"},
        {"yaml", "application/yaml"},
        {"yml", "application/yaml"},
        {"zip", "application/zip"},
    };
    const char *name = strrchr(path, '/');
    name = name == nullptr ? path : name + 1;
    const char *dot = strrchr(name, '.');
    if (dot != nullptr && dot != name) {
        char extension[16];
        usize length = strlen(dot + 1);
        if (length > 0 && length < sizeof extension) {
            for (usize i = 0; i <= length; i++) {
                char c = dot[1 + i];
                extension[i] = c >= 'A' && c <= 'Z' ? (char) (c - 'A' + 'a') : c;
            }
            for (usize i = 0; i < countof(types); i++) {
                if (strcmp(types[i].extension, extension) == 0) return types[i].type;
            }
        }
    }
    return "application/octet-stream";
}

/*
 * The pattern dialect shared with the build-time collector (src/assets.ts): `*` and
 * `?` within one segment and `**` for any number of whole segments. Unless `dot` is
 * set, a wildcard never matches a segment that starts with a dot; a pattern segment
 * that spells the dot itself does.
 */
static bool asset_segment_match(
    const char *pattern, usize pattern_length, const char *value, usize value_length, bool dot) {
    if (!dot && value_length > 0 && value[0] == '.' && (pattern_length == 0 || pattern[0] != '.'))
        return false;
    usize p = 0;
    usize v = 0;
    usize star = SIZE_MAX;
    usize retry = 0;
    while (v < value_length) {
        if (p < pattern_length && (pattern[p] == '?' || pattern[p] == value[v])) {
            p++;
            v++;
        } else if (p < pattern_length && pattern[p] == '*') {
            star = p++;
            retry = v;
        } else if (star != SIZE_MAX) {
            p = star + 1;
            v = ++retry;
        } else {
            return false;
        }
    }
    while (p < pattern_length && pattern[p] == '*') p++;
    return p == pattern_length;
}

static usize asset_segment_length(const char *text) {
    const char *slash = strchr(text, '/');
    return slash == nullptr ? strlen(text) : (usize) (slash - text);
}

bool mal_asset_pattern_match(const char *pattern, const char *path, bool dot) {
    if (*pattern == '\0') return *path == '\0';
    usize pattern_length = asset_segment_length(pattern);
    const char *pattern_rest = pattern[pattern_length] == '/' ? pattern + pattern_length + 1
                                                              : pattern + pattern_length;
    if (pattern_length == 2 && pattern[0] == '*' && pattern[1] == '*') {
        if (mal_asset_pattern_match(pattern_rest, path, dot)) return true;
        if (*path == '\0' || (!dot && path[0] == '.')) return false;
        usize path_length = asset_segment_length(path);
        const char *path_rest = path[path_length] == '/' ? path + path_length + 1 : path + path_length;
        return mal_asset_pattern_match(pattern, path_rest, dot);
    }
    if (*path == '\0') return false;
    usize path_length = asset_segment_length(path);
    const char *path_rest = path[path_length] == '/' ? path + path_length + 1 : path + path_length;
    return asset_segment_match(pattern, pattern_length, path, path_length, dot)
        && mal_asset_pattern_match(pattern_rest, path_rest, dot);
}

/* A live directory declaration's membership rule. */
typedef struct AssetFilter {
    char *root;
    char **include;
    usize include_count;
    char **exclude;
    usize exclude_count;
    bool dot;
} AssetFilter;

static void asset_filter_dispose(AssetFilter *filter) {
    free(filter->root);
    for (usize i = 0; i < filter->include_count; i++) free(filter->include[i]);
    for (usize i = 0; i < filter->exclude_count; i++) free(filter->exclude[i]);
    free(filter->include);
    free(filter->exclude);
    *filter = (AssetFilter) {0};
}

static bool asset_filter_admits(const AssetFilter *filter, const char *path) {
    bool included = false;
    if (filter->include_count == 0) {
        included = mal_asset_pattern_match("**", path, filter->dot);
    } else {
        for (usize i = 0; !included && i < filter->include_count; i++)
            included = mal_asset_pattern_match(filter->include[i], path, filter->dot);
    }
    if (!included) return false;
    for (usize i = 0; i < filter->exclude_count; i++) {
        if (mal_asset_pattern_match(filter->exclude[i], path, filter->dot)) return false;
    }
    return true;
}

static bool asset_read_strings(MalVm *vm, MalValue owner, const char *name, char ***out, usize *count) {
    MalValue list;
    if (!mal_vm_get_property(vm, owner, mal_intrinsic_string_key(vm, (const byte *) name), &list))
        return false;
    *out = nullptr;
    *count = 0;
    if (mal_value_is_undefined(list)) return true;
    if (!mal_value_is_array_object(list)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Invalid embedded directory declaration");
        return false;
    }
    u32 length = mal_array_object_length(mal_value_to_array_object(list));
    char **strings = calloc(length == 0 ? 1 : length, sizeof(char *));
    if (strings == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    MalRootSpan root;
    mal_gc_root(&root, &list, 1);
    bool ok = true;
    u32 filled = 0;
    for (; ok && filled < length; filled++) {
        MalValue entry;
        ok = mal_vm_get_property(vm, list, mal_key_index(filled), &entry);
        if (ok) {
            strings[filled] = asset_cstr(vm, entry, name);
            ok = strings[filled] != nullptr;
        }
    }
    mal_gc_unroot(&root);
    if (!ok) {
        for (u32 i = 0; i < filled; i++) free(strings[i]);
        free(strings);
        return false;
    }
    *out = strings;
    *count = length;
    return true;
}

static bool asset_filter_read(MalVm *vm, MalValue declaration, AssetFilter *filter) {
    *filter = (AssetFilter) {0};
    MalRootSpan root;
    mal_gc_root(&root, &declaration, 1);
    MalValue value;
    bool ok = mal_vm_get_property(vm, declaration, mal_intrinsic_string_key(vm, (const byte *) "path"), &value);
    if (ok) {
        filter->root = asset_cstr(vm, value, "path");
        ok = filter->root != nullptr;
    }
    ok = ok && asset_read_strings(vm, declaration, "include", &filter->include, &filter->include_count);
    ok = ok && asset_read_strings(vm, declaration, "exclude", &filter->exclude, &filter->exclude_count);
    if (ok) {
        ok = mal_vm_get_property(vm, declaration, mal_intrinsic_string_key(vm, (const byte *) "dot"), &value);
        filter->dot = ok && mal_value_is_boolean(value) && mal_value_to_boolean(value);
    }
    mal_gc_unroot(&root);
    if (!ok) asset_filter_dispose(filter);
    return ok;
}

typedef struct AssetPathList {
    char **paths;
    usize count;
    usize capacity;
} AssetPathList;

static void asset_path_list_dispose(AssetPathList *list) {
    for (usize i = 0; i < list->count; i++) free(list->paths[i]);
    free(list->paths);
    *list = (AssetPathList) {0};
}

static int asset_path_compare(const void *left, const void *right) {
    // UTF-8 byte order is code point order.
    return strcmp(*(char *const *) left, *(char *const *) right);
}

/*
 * Collect the member paths below `relative`. A matching entry that is not a regular
 * file fails the listing, as it fails the build; symbolic links are never followed.
 */
static int asset_walk(
    const AssetFilter *filter, const char *relative, AssetPathList *out, char **failed_path) {
    char *directory = relative[0] == '\0' ? strdup(filter->root) : asset_join(filter->root, relative);
    if (directory == nullptr) return ENOMEM;
    MalPosixDirent *entries = nullptr;
    usize count = 0;
    int err = mal_posix_fs_readdir(directory, &entries, &count);
    if (err != 0) {
        *failed_path = directory;
        return err;
    }
    free(directory);
    for (usize i = 0; err == 0 && i < count; i++) {
        char *path = relative[0] == '\0' ? strdup(entries[i].name) : asset_join(relative, entries[i].name);
        if (path == nullptr) {
            err = ENOMEM;
            break;
        }
        if (entries[i].type == MAL_POSIX_FT_DIR) {
            err = asset_walk(filter, path, out, failed_path);
            free(path);
            continue;
        }
        if (!asset_filter_admits(filter, path)) {
            free(path);
            continue;
        }
        if (entries[i].type != MAL_POSIX_FT_FILE) {
            *failed_path = path;
            err = ASSET_IRREGULAR;
            break;
        }
        if (out->count == out->capacity) {
            usize capacity = out->capacity == 0 ? 16 : out->capacity * 2;
            char **grown = realloc(out->paths, capacity * sizeof(char *));
            if (grown == nullptr) {
                free(path);
                err = ENOMEM;
                break;
            }
            out->paths = grown;
            out->capacity = capacity;
        }
        out->paths[out->count++] = path;
    }
    mal_posix_fs_free_dirents(entries, count);
    return err;
}

static const MalAsset *asset_embedded(const MalVm *vm, i32 index) {
    return &vm->runtime_image->assets[index];
}

/* Read a file's bytes, failing on a missing or irregular file. */
static bool asset_read_live(MalVm *vm, const char *path, byte **out, usize *length) {
    MalPosixStat stats;
    int err = mal_posix_fs_stat(path, &stats);
    if (err == 0 && stats.type != MAL_POSIX_FT_FILE) err = ASSET_IRREGULAR;
    if (err == 0) err = mal_posix_fs_read_file(path, out, length);
    if (err != 0) {
        asset_throw_errno(vm, err, "cannot read", path);
        return false;
    }
    return true;
}

/* The bytes of a file handle; `owned` is set when the caller must free them. */
static bool asset_file_bytes(
    MalVm *vm, MalValue callee, const byte **bytes, usize *length, byte **owned) {
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue first = mal_native_function_object_get_slot(function, 0);
    MalValue second = mal_native_function_object_get_slot(function, 1);
    *owned = nullptr;
    if (mal_value_is_int32(first)) {
        const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
        const MalAssetFile *file = &asset->files[mal_value_to_i32(second)];
        *bytes = (const byte *) file->data;
        *length = file->length;
        return true;
    }
    char *path = asset_cstr(vm, first, "path");
    if (path == nullptr) return false;
    bool ok = asset_read_live(vm, path, owned, length);
    free(path);
    *bytes = *owned;
    return ok;
}

static MalValue asset_file_size(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue first = mal_native_function_object_get_slot(function, 0);
    if (mal_value_is_int32(first)) {
        const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
        i32 index = mal_value_to_i32(mal_native_function_object_get_slot(function, 1));
        return mal_value_from_f64((f64) asset->files[index].length);
    }
    char *path = asset_cstr(vm, first, "path");
    if (path == nullptr) return mal_value_new_undefined();
    MalPosixStat stats;
    int err = mal_posix_fs_stat(path, &stats);
    if (err == 0 && stats.type != MAL_POSIX_FT_FILE) err = ASSET_IRREGULAR;
    if (err != 0) asset_throw_errno(vm, err, "cannot read", path);
    free(path);
    return err == 0 ? mal_value_from_f64(stats.size) : mal_value_new_undefined();
}

static MalValue asset_file_digest(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue first = mal_native_function_object_get_slot(function, 0);
    if (mal_value_is_int32(first)) {
        const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
        i32 index = mal_value_to_i32(mal_native_function_object_get_slot(function, 1));
        return asset_string(vm, asset->files[index].digest);
    }
    const byte *bytes;
    usize length;
    byte *owned;
    if (!asset_file_bytes(vm, callee, &bytes, &length, &owned)) return mal_value_new_undefined();
    MalSha256 context;
    u8 digest[32];
    mal_sha256_init(&context);
    mal_sha256_update(&context, (const u8 *) bytes, length);
    mal_sha256_final(&context, digest);
    free(owned);
    char hex[65];
    for (usize i = 0; i < sizeof digest; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    return asset_string(vm, hex);
}

static MalValue asset_file_bytes_method(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    const byte *bytes;
    usize length;
    byte *owned;
    if (!asset_file_bytes(vm, callee, &bytes, &length, &owned)) return mal_value_new_undefined();
    if (length > UINT32_MAX) {
        free(owned);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "Asset is too large for an ArrayBuffer");
        return mal_value_new_undefined();
    }
    // TODO: view embedded bytes in place once ArrayBuffers can borrow static storage.
    MalArrayBufferObject *buffer = mal_array_buffer_object_new_uninitialized(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false, false);
    if (buffer == nullptr) {
        free(owned);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (length > 0) memcpy(buffer->data, bytes, length);
    free(owned);
    buffer->immutable = true;
    MalValue roots[1] = {mal_value_from_array_buffer_object(buffer)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 1);
    MalTypedArrayObject *view = mal_typed_array_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(view);
}

static MalValue asset_file_text_value(MalVm *vm, MalValue callee) {
    const byte *bytes;
    usize length;
    byte *owned;
    if (!asset_file_bytes(vm, callee, &bytes, &length, &owned)) return mal_value_new_undefined();
    const u8 *raw = (const u8 *) bytes;
    if (length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) {
        bytes += 3;
        length -= 3;
    }
    MalString *text = mal_string_from_utf8(&vm->heap, bytes, length);
    free(owned);
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(text);
}

static MalValue asset_file_text(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    return asset_file_text_value(vm, callee);
}

static MalValue asset_file_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue text = asset_file_text_value(vm, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &text, 1);
    MalValue result = mal_builtin_json_parse_intrinsic(vm, text);
    mal_gc_unroot(&root);
    return result;
}

/* The base directory of a materialization: options.baseDirectory or the temporary one. */
static bool asset_materialize_base(
    MalVm *vm, const MalValue *args, i32 argc, char **owned, const char **base) {
    *owned = nullptr;
    *base = mal_posix_fs_temporary_directory();
    if (argc < 1 || mal_value_is_undefined(args[0])) return true;
    if (!mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "The \"options\" argument must be an object");
        return false;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, args[0],
            mal_intrinsic_string_key(vm, (const byte *) "baseDirectory"), &value))
        return false;
    if (mal_value_is_undefined(value)) return true;
    *owned = asset_cstr(vm, value, "baseDirectory");
    if (*owned == nullptr) return false;
    if ((*owned)[0] == '\0') {
        free(*owned);
        *owned = nullptr;
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "The \"baseDirectory\" argument must not be empty");
        return false;
    }
    *base = *owned;
    return true;
}

/* Materialize an embedded asset and return the path of `member`, or of the asset. */
static MalValue asset_materialize_embedded(
    MalVm *vm, const MalAsset *asset, const char *member, const MalValue *args, i32 argc) {
    char *owned_base;
    const char *base;
    if (!asset_materialize_base(vm, args, argc, &owned_base, &base)) return mal_value_new_undefined();
    char *materialized = nullptr;
    int err = mal_asset_materialize(asset, base, &materialized);
    if (err != 0) {
        asset_throw_errno(vm, err, "cannot materialize into", base);
        free(owned_base);
        return mal_value_new_undefined();
    }
    free(owned_base);
    char *path = member == nullptr ? materialized : asset_join(materialized, member);
    if (path != materialized) free(materialized);
    if (path == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = asset_string(vm, path);
    free(path);
    return result;
}

/* Outside a built executable the source itself is the materialization. */
static MalValue asset_materialize_live(MalVm *vm, MalValue path_value, bool directory) {
    char *path = asset_cstr(vm, path_value, "path");
    if (path == nullptr) return mal_value_new_undefined();
    MalPosixStat stats;
    int err = mal_posix_fs_stat(path, &stats);
    if (err == 0 && stats.type != (directory ? MAL_POSIX_FT_DIR : MAL_POSIX_FT_FILE))
        err = directory ? ENOTDIR : ASSET_IRREGULAR;
    if (err != 0) {
        asset_throw_errno(vm, err, "cannot materialize", path);
        free(path);
        return mal_value_new_undefined();
    }
    free(path);
    return path_value;
}

static MalValue asset_file_materialize(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue first = mal_native_function_object_get_slot(function, 0);
    if (!mal_value_is_int32(first)) return asset_materialize_live(vm, first, false);
    const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
    if (!asset->directory) return asset_materialize_embedded(vm, asset, nullptr, args, argc);
    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(function, 1));
    return asset_materialize_embedded(vm, asset, asset->files[index].path, args, argc);
}

static MalValue asset_function(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count));
}

static void asset_define_getter(
    MalVm *vm, MalObject *object, const char *name, const char *getter_name,
    MalNativeFunctionCallback callback, const MalValue *slots, i32 slot_count) {
    MalValue getter = asset_function(vm, getter_name, 0, callback, slots, slot_count);
    MalRootSpan root;
    mal_gc_root(&root, &getter, 1);
    MalPropertyDesc description =
        mal_intrinsic_accessor_desc(getter, mal_value_new_undefined(), ASSET_FIELD);
    mal_object_define_own(object, mal_intrinsic_string_key(vm, (const byte *) name), &description);
    mal_gc_unroot(&root);
}

static void asset_define_method(
    MalVm *vm, MalObject *object, const char *name, i32 length,
    MalNativeFunctionCallback callback, const MalValue *slots, i32 slot_count) {
    MalValue method = asset_function(vm, name, length, callback, slots, slot_count);
    MalRootSpan root;
    mal_gc_root(&root, &method, 1);
    mal_intrinsic_define_data(vm, object, (const byte *) name, method, ASSET_METHOD);
    mal_gc_unroot(&root);
}

/*
 * A frozen file handle. Embedded handles carry (asset index, file index); live ones
 * carry (absolute path, member path). A declared handle also keeps its declaration,
 * which says where `maligator:http` proxies it. Methods read their state from their
 * own slots, so a detached method keeps working.
 */
static MalValue asset_file_handle(
    MalVm *vm, MalValue first, MalValue second, MalValue declaration, const char *member) {
    MalValue roots[5] = {
        first, second, declaration, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *handle = mal_value_to_object(roots[3]);
    roots[4] = asset_string(vm, member);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_intrinsic_define_data(vm, handle, (const byte *) "path", roots[4], ASSET_FIELD);
        roots[4] = asset_string(vm, mal_asset_media_type(member));
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_intrinsic_define_data(vm, handle, (const byte *) "type", roots[4], ASSET_FIELD);
        asset_define_getter(vm, handle, "size", "get size", asset_file_size, roots, 3);
        asset_define_getter(vm, handle, "digest", "get digest", asset_file_digest, roots, 3);
        asset_define_method(vm, handle, "bytes", 0, asset_file_bytes_method, roots, 3);
        asset_define_method(vm, handle, "text", 0, asset_file_text, roots, 3);
        asset_define_method(vm, handle, "json", 0, asset_file_json, roots, 3);
        asset_define_method(vm, handle, "materialize", 1, asset_file_materialize, roots, 3);
        mal_builtin_object_set_integrity(vm, roots[3], true);
    }
    MalValue result = roots[3];
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* A live member handle: the absolute path below the declared root and the member path. */
static MalValue asset_live_member(MalVm *vm, const char *root, const char *member) {
    char *absolute = asset_join(root, member);
    if (absolute == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue values[2] = {asset_string(vm, absolute), mal_value_new_undefined()};
    free(absolute);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, values, countof(values));
    values[1] = asset_string(vm, member);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW
        ? mal_value_new_undefined()
        : asset_file_handle(vm, values[0], values[1], mal_value_new_undefined(), member);
    mal_gc_unroot(&span);
    return result;
}

static bool asset_list_live(MalVm *vm, MalValue declaration, AssetFilter *filter, AssetPathList *list) {
    if (!asset_filter_read(vm, declaration, filter)) return false;
    *list = (AssetPathList) {0};
    char *failed = nullptr;
    int err = asset_walk(filter, "", list, &failed);
    if (err == ASSET_IRREGULAR && failed != nullptr) {
        usize length = strlen(failed) + strlen(filter->root) + 64;
        char *message = malloc(length);
        if (message != nullptr)
            snprintf(message, length, "maligator:assets: '%s' in '%s' is not a regular file",
                failed, filter->root);
        asset_throw(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            message != nullptr ? message : "maligator:assets: irregular file");
        free(message);
    } else if (err != 0) {
        asset_throw_errno(vm, err, "cannot list", failed != nullptr ? failed : filter->root);
    }
    free(failed);
    if (err != 0) {
        asset_path_list_dispose(list);
        asset_filter_dispose(filter);
        return false;
    }
    if (list->count > 1) qsort(list->paths, list->count, sizeof(char *), asset_path_compare);
    return true;
}

static MalValue asset_directory_files(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalValue roots[2] = {state, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (mal_value_is_int32(state)) {
        const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(state));
        roots[1] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, (u32) asset->file_count));
        for (i32 i = 0; i < asset->file_count; i++) {
            MalValue handle = asset_file_handle(
                vm, state, mal_value_from_i32(i), mal_value_new_undefined(), asset->files[i].path);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index((u32) i), handle);
        }
    } else {
        AssetFilter filter;
        AssetPathList list;
        if (!asset_list_live(vm, state, &filter, &list)) goto done;
        roots[1] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, (u32) list.count));
        for (usize i = 0; i < list.count; i++) {
            MalValue handle = asset_live_member(vm, filter.root, list.paths[i]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index((u32) i), handle);
        }
        asset_path_list_dispose(&list);
        asset_filter_dispose(&filter);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    mal_builtin_object_set_integrity(vm, roots[1], true);
    result = roots[1];
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue asset_directory_get(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    char *member = asset_cstr(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "path");
    if (member == nullptr) return mal_value_new_undefined();
    MalValue result = mal_value_new_undefined();
    if (!asset_safe_relative_path(member)) {
        free(member);
        return result;
    }
    MalRootSpan root;
    mal_gc_root(&root, &state, 1);
    if (mal_value_is_int32(state)) {
        const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(state));
        for (i32 i = 0; i < asset->file_count; i++) {
            if (strcmp(asset->files[i].path, member) != 0) continue;
            result = asset_file_handle(
                vm, state, mal_value_from_i32(i), mal_value_new_undefined(), asset->files[i].path);
            break;
        }
    } else {
        AssetFilter filter;
        if (asset_filter_read(vm, state, &filter)) {
            char *absolute = asset_join(filter.root, member);
            MalPosixStat stats;
            if (absolute == nullptr) {
                mal_vm_throw_allocation_error(vm);
            } else if (asset_filter_admits(&filter, member)
                && mal_posix_fs_lstat(absolute, &stats) == 0
                && (stats.mode & 0170000) == 0100000) {
                result = asset_live_member(vm, filter.root, member);
            }
            free(absolute);
            asset_filter_dispose(&filter);
        }
    }
    mal_gc_unroot(&root);
    free(member);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue asset_directory_materialize(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    if (mal_value_is_int32(state))
        return asset_materialize_embedded(vm, asset_embedded(vm, mal_value_to_i32(state)), nullptr, args, argc);
    MalRootSpan root;
    mal_gc_root(&root, &state, 1);
    MalValue path;
    MalValue result = mal_value_new_undefined();
    if (mal_vm_get_property(vm, state, mal_intrinsic_string_key(vm, (const byte *) "path"), &path))
        result = asset_materialize_live(vm, path, true);
    mal_gc_unroot(&root);
    return result;
}

/* A frozen directory handle over an asset index or a live declaration object. */
static MalValue asset_directory_handle(MalVm *vm, MalValue state) {
    MalValue roots[2] = {state, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *handle = mal_value_to_object(roots[1]);
    asset_define_method(vm, handle, "files", 0, asset_directory_files, roots, 1);
    asset_define_method(vm, handle, "get", 1, asset_directory_get, roots, 1);
    asset_define_method(vm, handle, "materialize", 1, asset_directory_materialize, roots, 1);
    mal_builtin_object_set_integrity(vm, roots[1], true);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static i32 asset_find(const MalVm *vm, const char *name) {
    for (i32 i = 0; i < vm->runtime_image->asset_count; i++) {
        if (strcmp(vm->runtime_image->assets[i].name, name) == 0) return i;
    }
    return -1;
}

static MalValue asset_install_one(MalVm *vm, const char *data) {
    if (data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Missing embedded asset declaration");
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {asset_string(vm, data), mal_value_new_undefined()};
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    roots[1] = mal_builtin_json_parse_intrinsic(vm, roots[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    MalValue kind;
    MalValue path;
    if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "kind"), &kind))
        goto done;
    bool directory = mal_value_is_string(kind)
        && mal_string_equals_ascii(mal_value_to_string(kind), "directory");
    MalValue name_value;
    if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "name"), &name_value))
        goto done;
    char *asset_name = asset_cstr(vm, name_value, "name");
    if (asset_name == nullptr) goto done;
    i32 index = asset_find(vm, asset_name);
    free(asset_name);
    // A built executable embeds every declaration it can reach, so a miss there is a
    // packaging defect rather than a reason to read the build machine's files.
    if (index < 0 && vm->runtime_image->asset_count > 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "maligator:assets: this executable does not embed a declared asset");
        goto done;
    }
    if (directory) {
        if (index < 0) {
            mal_builtin_object_set_integrity(vm, roots[1], true);
            result = asset_directory_handle(vm, roots[1]);
        } else {
            result = asset_directory_handle(vm, mal_value_from_i32(index));
        }
        goto done;
    }
    if (index >= 0) {
        const MalAsset *asset = asset_embedded(vm, index);
        result = asset_file_handle(vm, mal_value_from_i32(index), mal_value_from_i32(0),
            mal_value_new_undefined(), asset->files[0].path);
        goto done;
    }
    if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "path"), &path))
        goto done;
    char *absolute = asset_cstr(vm, path, "path");
    if (absolute == nullptr) goto done;
    const char *name = strrchr(absolute, '/');
    roots[0] = path;
    mal_builtin_object_set_integrity(vm, roots[1], true);
    MalValue declaration = roots[1];
    MalValue member[2] = {declaration, asset_string(vm, name == nullptr ? absolute : name + 1)};
    MalRootSpan member_root;
    mal_gc_root(&member_root, member, countof(member));
    if (vm->completion.kind != MAL_COMPLETION_THROW)
        result = asset_file_handle(
            vm, roots[0], member[1], member[0], name == nullptr ? absolute : name + 1);
    mal_gc_unroot(&member_root);
    free(absolute);
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* Which handle `value` is, recognized by its own materialize method. */
static MalNativeFunctionObject *asset_handle_method(MalVm *vm, MalValue value, bool *directory) {
    if (!mal_value_is_object(value)) return nullptr;
    MalValue method;
    if (!mal_vm_get_property(vm, value,
            mal_intrinsic_string_key(vm, (const byte *) "materialize"), &method)
        || !mal_value_is_native_function_object(method))
        return nullptr;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(method);
    MalNativeFunctionCallback callback = mal_native_function_object_callback(function);
    if (callback != asset_file_materialize && callback != asset_directory_materialize)
        return nullptr;
    *directory = callback == asset_directory_materialize;
    return function;
}

int mal_asset_member(MalVm *vm, MalValue handle, const char *member, MalAssetMember *out) {
    *out = (MalAssetMember) {0};
    bool directory = false;
    MalNativeFunctionObject *method = asset_handle_method(vm, handle, &directory);
    if (method == nullptr) {
        if (vm->completion.kind != MAL_COMPLETION_THROW)
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "Expected a handle from maligator:assets");
        return -1;
    }
    MalValue first = mal_native_function_object_get_slot(method, 0);
    if (!directory) {
        if (mal_value_is_int32(first)) {
            const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
            out->embedded = &asset->files[mal_value_to_i32(mal_native_function_object_get_slot(method, 1))];
            out->path = strdup(out->embedded->path);
        } else {
            out->live_path = asset_cstr(vm, first, "path");
            if (out->live_path == nullptr) return -1;
            out->path = asset_cstr(vm, mal_native_function_object_get_slot(method, 1), "path");
        }
    } else {
        if (!asset_safe_relative_path(member)) return 0;
        if (mal_value_is_int32(first)) {
            const MalAsset *asset = asset_embedded(vm, mal_value_to_i32(first));
            for (i32 i = 0; i < asset->file_count && out->embedded == nullptr; i++) {
                if (strcmp(asset->files[i].path, member) == 0) out->embedded = &asset->files[i];
            }
            if (out->embedded == nullptr) return 0;
        } else {
            AssetFilter filter;
            if (!asset_filter_read(vm, first, &filter)) return -1;
            MalPosixStat stats;
            char *absolute = asset_join(filter.root, member);
            bool found = absolute != nullptr && asset_filter_admits(&filter, member)
                && mal_posix_fs_lstat(absolute, &stats) == 0 && (stats.mode & 0170000) == 0100000;
            asset_filter_dispose(&filter);
            if (!found) {
                free(absolute);
                return 0;
            }
            out->live_path = absolute;
        }
        out->path = strdup(member);
    }
    if (out->path == nullptr) {
        mal_asset_member_dispose(out);
        mal_vm_throw_allocation_error(vm);
        return -1;
    }
    return 1;
}

void mal_asset_member_dispose(MalAssetMember *member) {
    free(member->live_path);
    free(member->path);
    *member = (MalAssetMember) {0};
}

char *mal_asset_proxy_url(MalVm *vm, MalValue handle) {
    bool directory = false;
    MalNativeFunctionObject *method = asset_handle_method(vm, handle, &directory);
    if (method == nullptr) return nullptr;
    MalValue declaration = mal_native_function_object_get_slot(method, directory ? 0 : 2);
    MalValue url;
    if (!mal_value_is_object(declaration)
        || !mal_vm_get_property(vm, declaration,
            mal_intrinsic_string_key(vm, (const byte *) "proxy"), &url)
        || !mal_value_is_string(url))
        return nullptr;
    return asset_cstr(vm, url, "proxy");
}

void mal_host_install_maligator_assets(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        MalValue handle = asset_install_one(vm, slots[i].data);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        vm->globals[slots[i].slot] = handle;
    }
}

static char *asset_identity(const MalAsset *asset) {
    usize hash_length = strlen(asset->hash);
    usize version_length = strlen(asset->version);
    if (hash_length > SIZE_MAX - version_length - 2) return nullptr;
    char *identity = malloc(hash_length + version_length + 2);
    if (identity == nullptr) return nullptr;
    memcpy(identity, asset->hash, hash_length);
    identity[hash_length] = '-';
    memcpy(identity + hash_length + 1, asset->version, version_length + 1);
    return identity;
}

/* A marker is trusted only below a private directory owned by this user. */
static int asset_cache_valid(
    const char *target, const char *identity, bool *out_exists, bool *out_valid) {
    *out_exists = false;
    *out_valid = false;
    bool private_directory = false;
    int err = mal_posix_fs_private_directory(target, &private_directory);
    if (err == ENOENT) return 0;
    if (err != 0) return err;
    *out_exists = true;
    if (!private_directory) return EACCES;

    char *marker = asset_join(target, MAL_ASSET_COMPLETION_MARKER);
    if (marker == nullptr) return ENOMEM;
    byte *contents = nullptr;
    usize length = 0;
    err = mal_posix_fs_read_file(marker, &contents, &length);
    free(marker);
    if (err == ENOENT) return 0;
    if (err != 0) return err;
    *out_valid = length == strlen(identity) && memcmp(contents, identity, length) == 0;
    free(contents);
    return 0;
}

static int asset_write_tree(const MalAsset *asset, const char *root, const char *identity) {
    for (i32 i = 0; i < asset->file_count; i++) {
        const MalAssetFile *file = &asset->files[i];
        if (!asset_safe_relative_path(file->path)
            || strcmp(file->path, MAL_ASSET_COMPLETION_MARKER) == 0) {
            return EINVAL;
        }
        char *destination = asset_join(root, file->path);
        if (destination == nullptr) return ENOMEM;
        char *slash = strrchr(destination, '/');
        if (slash != nullptr) {
            *slash = '\0';
            int err = mal_posix_fs_mkdir(destination, true);
            *slash = '/';
            if (err != 0) {
                free(destination);
                return err;
            }
        }
        int err = mal_posix_fs_write_file(destination, (const byte *) file->data, file->length);
        free(destination);
        if (err != 0) return err;
    }

    char *marker = asset_join(root, MAL_ASSET_COMPLETION_MARKER);
    if (marker == nullptr) return ENOMEM;
    int err = mal_posix_fs_write_file(marker, (const byte *) identity, strlen(identity));
    free(marker);
    return err;
}

int mal_asset_materialize(const MalAsset *asset, const char *base, char **out_path) {
    int err = mal_posix_fs_mkdir(base, true);
    if (err != 0) return err;

    char *absolute_base = nullptr;
    err = mal_posix_fs_realpath(base, &absolute_base);
    if (err != 0) return err;
    char *identity = asset_identity(asset);
    char *target = identity != nullptr ? asset_join(absolute_base, identity) : nullptr;
    free(absolute_base);
    if (identity == nullptr || target == nullptr) {
        free(identity);
        free(target);
        return ENOMEM;
    }

    bool exists;
    bool valid;
    err = asset_cache_valid(target, identity, &exists, &valid);
    if (err != 0) goto fail;
    if (valid) goto ready;
    if (exists) {
        err = mal_posix_fs_rm(target, true, false);
        if (err != 0 && err != ENOENT) goto fail;
    }

    char *temp_prefix = asset_join(base, ".maligator-asset-tmp-");
    char *temp = nullptr;
    if (temp_prefix == nullptr) {
        err = ENOMEM;
        goto fail;
    }
    err = mal_posix_fs_mkdtemp(temp_prefix, &temp);
    free(temp_prefix);
    if (err != 0) {
        free(temp);
        goto fail;
    }
    err = asset_write_tree(asset, temp, identity);
    if (err == 0) err = mal_posix_fs_rename(temp, target);
    if (err != 0) {
        bool race_exists;
        bool race_valid;
        int race_err = asset_cache_valid(target, identity, &race_exists, &race_valid);
        mal_posix_fs_rm(temp, true, true);
        free(temp);
        if (race_err == 0 && race_valid) {
            err = 0;
            goto ready;
        }
        if (race_err != 0) err = race_err;
        goto fail;
    }
    free(temp);

ready:
    free(identity);
    if (asset->directory) {
        *out_path = target;
        return 0;
    }
    if (asset->file_count != 1) {
        free(target);
        return EINVAL;
    }
    *out_path = asset_join(target, asset->files[0].path);
    free(target);
    return *out_path != nullptr ? 0 : ENOMEM;

fail:
    free(identity);
    free(target);
    return err;
}
