#include "worker_manifest.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_json.h"
#include "gc.h"
#include "heap_string.h"
#include "hex.h"
#include "host_registry.h"
#include "intrinsics.h"
#include "object.h"
#include "sha256.h"
#include "utf8.h"
#include "workers.h"


typedef struct WorkerManifest {
    struct WorkerManifest *next;
    MalWorkerEntry *entries;
    usize count;
    char *pool_entry;
} WorkerManifest;

static WorkerManifest *manifests;

static void manifest_free(WorkerManifest *manifest) {
    if (manifest == nullptr) return;
    for (usize index = 0; index < manifest->count; index++) {
        free((void *) manifest->entries[index].href);
        free((void *) manifest->entries[index].wire);
    }
    free(manifest->entries);
    free(manifest->pool_entry);
    free(manifest);
}

void mal_worker_manifest_clear(void) {
    mal_workers_register_entries(nullptr, 0);
    mal_workers_set_pool_entry(nullptr);
    while (manifests != nullptr) {
        WorkerManifest *manifest = manifests;
        manifests = manifest->next;
        manifest_free(manifest);
    }
}

static void manifest_cleanup(MalVm *vm) {
    mal_workers_shutdown(vm);
    mal_worker_manifest_clear();
}

static byte *manifest_read(const char *path, usize limit, usize *length) {
    FILE *file = fopen(path, "rb");
    if (file == nullptr) return nullptr;
    if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return nullptr; }
    long size = ftell(file);
    if (size < 0 || (u64) size > limit || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return nullptr;
    }
    byte *bytes = malloc((usize) size + 1);
    if (bytes == nullptr || fread(bytes, 1, (usize) size, file) != (usize) size) {
        free(bytes);
        fclose(file);
        return nullptr;
    }
    fclose(file);
    bytes[size] = 0;
    *length = (usize) size;
    return bytes;
}

static MalValue manifest_property(MalVm *vm, MalValue object, const char *name) {
    if (!mal_value_is_object(object)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object), mal_intrinsic_string_key(vm, (const byte *) name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static char *manifest_string(MalValue value) {
    if (!mal_value_is_string(value)) return nullptr;
    char *string = nullptr;
    usize length;
    if (mal_string_to_utf8_c_string(mal_value_to_string(value), &string, &length) != MAL_UTF8_C_STRING_OK) return nullptr;
    return string;
}

static char *manifest_wire_path(const char *manifest_path, const char *wire_path) {
    if (wire_path[0] == '/') return strdup(wire_path);
    const char *slash = strrchr(manifest_path, '/');
    usize prefix = slash == nullptr ? 0 : (usize) (slash - manifest_path) + 1;
    usize length = strlen(wire_path);
    if (length > SIZE_MAX - prefix - 1) return nullptr;
    char *result = malloc(prefix + length + 1);
    if (result == nullptr) return nullptr;
    memcpy(result, manifest_path, prefix);
    memcpy(result + prefix, wire_path, length + 1);
    return result;
}

bool mal_worker_manifest_register(MalVm *vm, const char *path) {
    if (mal_workers_live_count() != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Worker manifest cannot change while workers are live");
        return false;
    }
    usize length = 0;
    byte *bytes = manifest_read(path, 16 * 1024 * 1024, &length);
    if (bytes == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Could not read worker manifest");
        return false;
    }
    MalString *text = mal_string_from_utf8(&vm->heap, bytes, length);
    free(bytes);
    if (text == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
    MalValue roots[] = {mal_value_from_string(text), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_builtin_json_parse_intrinsic(vm, roots[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) { mal_gc_unroot(&root); return false; }
    MalValue schema = manifest_property(vm, roots[0], "schema");
    roots[1] = manifest_property(vm, roots[0], "entries");
    if (!mal_value_is_int32(schema) || mal_value_to_i32(schema) != 1 || !mal_value_is_array_object(roots[1])) goto invalid;
    u32 count = mal_array_object_length(mal_value_to_array_object(roots[1]));
    if (count > 4096) goto invalid;
    WorkerManifest *manifest = calloc(1, sizeof(WorkerManifest));
    if (manifest == nullptr) goto invalid;
    manifest->entries = calloc(count == 0 ? 1 : count, sizeof(MalWorkerEntry));
    if (manifest->entries == nullptr) { manifest_free(manifest); goto invalid; }
    manifest->count = count;
    u64 total_bytes = 0;
    for (u32 index = 0; index < count; index++) {
        if (!mal_array_object_dense_get(mal_value_to_array_object(roots[1]), index, &roots[2])) goto failed;
        char *href = manifest_string(manifest_property(vm, roots[2], "href"));
        char *wire_path = manifest_string(manifest_property(vm, roots[2], "wirePath"));
        char *digest = manifest_string(manifest_property(vm, roots[2], "sha256"));
        manifest->entries[index].href = href;
        if (href == nullptr || strncmp(href, "file:", 5) != 0 || wire_path == nullptr || digest == nullptr || strlen(digest) != 64) {
            free(wire_path); free(digest); goto failed;
        }
        for (u32 previous = 0; previous < index; previous++) {
            if (strcmp(manifest->entries[previous].href, href) == 0) { free(wire_path); free(digest); goto failed; }
        }
        char *resolved = manifest_wire_path(path, wire_path);
        free(wire_path);
        if (resolved == nullptr) { free(digest); goto failed; }
        usize wire_size = 0;
        byte *wire = manifest_read(resolved, 256 * 1024 * 1024, &wire_size);
        free(resolved);
        if (wire == nullptr) { free(digest); goto failed; }
        manifest->entries[index].wire = wire;
        manifest->entries[index].wire_size = wire_size;
        manifest->entries[index].resolve_installer = mal_host_resolve_installer;
        total_bytes += wire_size;
        if (total_bytes > 512ull * 1024 * 1024) { free(digest); goto failed; }
        MalSha256 hash;
        u8 actual[32];
        byte hex[64];
        mal_sha256_init(&hash);
        mal_sha256_update(&hash, (const u8 *) wire, wire_size);
        mal_sha256_final(&hash, actual);
        mal_hex_encode_lower((const byte *) actual, sizeof(actual), hex);
        bool matches = memcmp(hex, digest, sizeof(hex)) == 0;
        free(digest);
        if (!matches) goto failed;
    }
    roots[2] = manifest_property(vm, roots[0], "poolEntry");
    if (!mal_value_is_undefined(roots[2])) {
        manifest->pool_entry = manifest_string(roots[2]);
        if (manifest->pool_entry == nullptr) goto failed;
        bool found = false;
        for (usize index = 0; index < manifest->count; index++) {
            if (strcmp(manifest->entries[index].href, manifest->pool_entry) == 0) found = true;
        }
        if (!found) goto failed;
    }
    if (!mal_vm_register_runtime_cleanup(vm, manifest_cleanup)) goto failed;
    // Existing descriptors retain their registry entry even after a test installs a new image.
    manifest->next = manifests;
    manifests = manifest;
    mal_workers_register_entries(manifest->entries, manifest->count);
    mal_workers_set_pool_entry(manifest->pool_entry);
    mal_gc_unroot(&root);
    return true;
failed:
    manifest_free(manifest);
invalid:
    mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid worker manifest or worker wire digest");
    mal_gc_unroot(&root);
    return false;
}
