#include "mal_assets.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "array_object.h"
#include "gc.h"
#include "heap_string.h"
#include "host_registry.h"
#include "intrinsics.h"
#include "object.h"
#include "posix_fs.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value.h"
#include "vm_load.h"
#include "vm_ops.h"

#define MAL_ASSET_COMPLETION_MARKER ".maligator-asset-complete"

static const MalPropertyFlags MAL_ASSET_VISIBLE =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

static MalValue mal_asset_string(MalVm *vm, const char *bytes) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) bytes, strlen(bytes));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static void mal_asset_throw_utf8(MalVm *vm, MalIntrinsic prototype, const char *message) {
    MalValue value = mal_asset_string(vm, message);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_vm_throw_error_value(vm, prototype, value);
    mal_gc_unroot(&root);
}

static char *mal_asset_to_cstr(MalVm *vm, MalValue value, const char *argument) {
    if (!mal_value_is_string(value)) {
        char message[96];
        snprintf(message, sizeof message, "The \"%s\" argument must be a string", argument);
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
        return nullptr;
    }
    usize length;
    char *bytes;
    MalUtf8CStringResult result = mal_string_to_utf8_c_string(
        mal_value_to_string(value), &bytes, &length);
    if (result == MAL_UTF8_C_STRING_EMBEDDED_NUL) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Asset names and paths must not contain null bytes");
        return nullptr;
    }
    if (result == MAL_UTF8_C_STRING_ALLOCATION_FAILED) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    return bytes;
}

static void mal_host_throw_errno(
    MalVm *vm, int err, const char *scope, const char *operation, const char *path) {
    const char *description = strerror(err);
    usize length = strlen(operation) + strlen(path) + strlen(description) + 32;
    char *message = malloc(length);
    if (message != nullptr) {
        snprintf(message, length, "%s: %s '%s': %s", scope, operation, path, description);
    }
    mal_asset_throw_utf8(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        message != nullptr ? message : "Maligator host operation failed");
    free(message);
}

static MalValue mal_test_run_wire(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || !mal_value_is_typed_array_object(args[0])) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal._runWire requires a Uint8Array");
        return mal_value_new_undefined();
    }

    MalTypedArrayObject *wire = mal_value_to_typed_array_object(args[0]);
    usize length = mal_typed_array_object_byte_length(wire);
    const u8 *bytes = wire->buffer->data + wire->byte_offset;
    const char *error = "invalid VM wire";
    MalLoadedDefinition *loaded = mal_vm_load_definition_with_host_resolver(
        bytes, length, &error, mal_host_resolve_installer);
    if (loaded == nullptr) {
        mal_asset_throw_utf8(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, error);
        return mal_value_new_undefined();
    }

    mal_vm_retain_loaded_definition(vm, loaded);
    const MalVmDefinition *definition = mal_loaded_definition_get(loaded);
    i32 entry = mal_vm_splice_definition(vm, definition);
    if (entry < 0) return mal_value_new_undefined();
    mal_vm_run_definition_host_installs(vm, definition, &vm->launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();

    MalValue callable = mal_vm_op_create_function(vm, entry, nullptr);
    MalRootSpan root;
    mal_gc_root(&root, &callable, 1);
    MalCompletion completion = mal_vm_call_value(
        vm, callable, mal_value_new_undefined(), nullptr, 0);
    mal_gc_unroot(&root);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }
    return completion.value;
}

static MalValue mal_dev_spawn(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 2 || !mal_value_is_array_object(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal._spawnDevelopmentProcess requires an executable and argument array");
        return mal_value_new_undefined();
    }

    char *executable = mal_asset_to_cstr(vm, args[0], "executable");
    if (executable == nullptr) return mal_value_new_undefined();
    u32 argument_count = mal_array_object_length(mal_value_to_array_object(args[1]));
    char **child_argv = calloc((usize) argument_count + 2, sizeof(char *));
    if (child_argv == nullptr) {
        free(executable);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    child_argv[0] = executable;
    for (u32 i = 0; i < argument_count; i++) {
        MalValue argument;
        if (!mal_vm_get_property(vm, args[1], mal_key_index(i), &argument)) goto fail;
        child_argv[i + 1] = mal_asset_to_cstr(vm, argument, "argument");
        if (child_argv[i + 1] == nullptr) goto fail;
    }

    pid_t pid = fork();
    if (pid == 0) {
        execv(executable, child_argv);
        _exit(127);
    }
    if (pid < 0) {
        mal_host_throw_errno(vm, errno, "mal.dev", "cannot spawn", executable);
        goto fail;
    }
    for (u32 i = 0; i < argument_count; i++) free(child_argv[i + 1]);
    free(child_argv);
    free(executable);
    return mal_value_from_f64((f64) pid);

fail:
    for (u32 i = 0; i < argument_count; i++) free(child_argv[i + 1]);
    free(child_argv);
    free(executable);
    return mal_value_new_undefined();
}

static bool mal_dev_pid(MalVm *vm, MalValue value, pid_t *pid) {
    if (!mal_value_is_f64(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "development process handle must be a number");
        return false;
    }
    f64 number = mal_value_to_f64(value);
    if (number <= 0 || number > (f64) INT32_MAX || number != (f64) (pid_t) number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "invalid development process handle");
        return false;
    }
    *pid = (pid_t) number;
    return true;
}

static MalValue mal_dev_kill(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    pid_t pid;
    if (argc < 1 || !mal_dev_pid(vm, args[0], &pid)) return mal_value_new_undefined();
    if (kill(pid, SIGTERM) != 0 && errno != ESRCH) {
        mal_host_throw_errno(vm, errno, "mal.dev", "cannot terminate process", "");
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static MalValue mal_dev_process_status(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    pid_t pid;
    if (argc < 1 || !mal_dev_pid(vm, args[0], &pid)) return mal_value_new_undefined();
    int status = 0;
    pid_t result = waitpid(pid, &status, WNOHANG);
    if (result == 0) return mal_value_new_undefined();
    if (result < 0) {
        if (errno == ECHILD) return mal_value_from_f64(0);
        mal_host_throw_errno(vm, errno, "mal.dev", "cannot wait for process", "");
        return mal_value_new_undefined();
    }
    int code = WIFEXITED(status) ? WEXITSTATUS(status)
        : WIFSIGNALED(status) ? 128 + WTERMSIG(status)
                              : 1;
    return mal_value_from_f64((f64) code);
}

static char *mal_asset_join(const char *left, const char *right) {
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

static bool mal_asset_safe_relative_path(const char *path) {
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

static const MalAsset *mal_asset_find(const MalVm *vm, const char *name) {
    for (i32 i = 0; i < vm->definition->asset_count; i++) {
        const MalAsset *asset = &vm->definition->assets[i];
        if (strcmp(asset->name, name) == 0) return asset;
    }
    return nullptr;
}

static const char *mal_asset_tmpdir(void) {
    const char *names[] = {"TMPDIR", "TMP", "TEMP"};
    for (usize i = 0; i < countof(names); i++) {
        const char *value = getenv(names[i]);
        if (value != nullptr && value[0] != '\0') return value;
    }
    return "/tmp";
}

static char *mal_asset_identity(const MalAsset *asset) {
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
static int mal_asset_cache_valid(
    const char *target, const char *identity, bool *out_exists, bool *out_valid) {
    *out_exists = false;
    *out_valid = false;
    bool private_directory = false;
    int err = mal_posix_fs_private_directory(target, &private_directory);
    if (err == ENOENT) return 0;
    if (err != 0) return err;
    *out_exists = true;
    if (!private_directory) return EACCES;

    char *marker = mal_asset_join(target, MAL_ASSET_COMPLETION_MARKER);
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

static int mal_asset_write_tree(const MalAsset *asset, const char *root, const char *identity) {
    for (i32 i = 0; i < asset->file_count; i++) {
        const MalAssetFile *file = &asset->files[i];
        if (!mal_asset_safe_relative_path(file->path)
            || strcmp(file->path, MAL_ASSET_COMPLETION_MARKER) == 0) {
            return EINVAL;
        }
        char *destination = mal_asset_join(root, file->path);
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

    char *marker = mal_asset_join(root, MAL_ASSET_COMPLETION_MARKER);
    if (marker == nullptr) return ENOMEM;
    int err = mal_posix_fs_write_file(
        marker, (const byte *) identity, strlen(identity));
    free(marker);
    return err;
}

static int mal_asset_materialize(
    const MalAsset *asset, const char *base, char **out_path) {
    int err = mal_posix_fs_mkdir(base, true);
    if (err != 0) return err;

    char *absolute_base = nullptr;
    err = mal_posix_fs_realpath(base, &absolute_base);
    if (err != 0) return err;
    char *identity = mal_asset_identity(asset);
    char *target = identity != nullptr ? mal_asset_join(absolute_base, identity) : nullptr;
    free(absolute_base);
    if (identity == nullptr || target == nullptr) {
        free(identity);
        free(target);
        return ENOMEM;
    }

    bool exists;
    bool valid;
    err = mal_asset_cache_valid(target, identity, &exists, &valid);
    if (err != 0) goto fail;
    if (valid) goto ready;
    if (exists) {
        err = mal_posix_fs_rm(target, true, false);
        if (err != 0 && err != ENOENT) goto fail;
    }

    char *temp_prefix = mal_asset_join(base, ".maligator-asset-tmp-");
    char *temp = nullptr;
    if (temp_prefix == nullptr) {
        err = ENOMEM;
        goto fail;
    }
    err = mal_posix_fs_mkdtemp(temp_prefix, &temp);
    free(temp_prefix);
    if (err != 0) goto fail;
    err = mal_asset_write_tree(asset, temp, identity);
    if (err == 0) err = mal_posix_fs_rename(temp, target);
    if (err != 0) {
        bool race_exists;
        bool race_valid;
        int race_err = mal_asset_cache_valid(target, identity, &race_exists, &race_valid);
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
        err = EINVAL;
        goto fail_without_identity;
    }
    *out_path = mal_asset_join(target, asset->files[0].path);
    free(target);
    return *out_path != nullptr ? 0 : ENOMEM;

fail:
    free(identity);
fail_without_identity:
    free(target);
    return err;
}

static MalValue mal_assets_materialize(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal.assets.materialize requires an asset name");
        return mal_value_new_undefined();
    }
    char *name = mal_asset_to_cstr(vm, args[0], "name");
    if (name == nullptr) return mal_value_new_undefined();
    const MalAsset *asset = mal_asset_find(vm, name);
    if (asset == nullptr) {
        usize length = strlen(name) + 48;
        char *message = malloc(length);
        if (message != nullptr) {
            snprintf(message, length, "Unknown configured asset \"%s\"", name);
        }
        mal_asset_throw_utf8(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            message != nullptr ? message : "Unknown configured asset");
        free(message);
        free(name);
        return mal_value_new_undefined();
    }
    free(name);

    const char *default_base = mal_asset_tmpdir();
    char *owned_base = nullptr;
    const char *base = default_base;
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        if (!mal_value_is_object(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The \"options\" argument must be an object");
            return mal_value_new_undefined();
        }
        MalValue value;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "baseDirectory"), &value)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(value)) {
            owned_base = mal_asset_to_cstr(vm, value, "baseDirectory");
            if (owned_base == nullptr) return mal_value_new_undefined();
            if (owned_base[0] == '\0') {
                free(owned_base);
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "The \"baseDirectory\" argument must not be empty");
                return mal_value_new_undefined();
            }
            base = owned_base;
        }
    }

    char *materialized = nullptr;
    int err = mal_asset_materialize(asset, base, &materialized);
    if (err != 0) {
        mal_host_throw_errno(
            vm, err, "mal.assets.materialize", "cannot materialize into", base);
        free(owned_base);
        free(materialized);
        return mal_value_new_undefined();
    }
    free(owned_base);
    MalValue result = mal_asset_string(vm, materialized);
    free(materialized);
    return result;
}

void mal_host_install_maligator(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;

    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    roots[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *mal = mal_value_to_object(roots[0]);
    MalObject *assets = mal_value_to_object(roots[1]);

    mal_intrinsic_define_method_n(
        vm, assets, (const byte *) "materialize", 1, mal_assets_materialize);
    mal_intrinsic_define_data(
        vm, mal, (const byte *) "assets", roots[1], MAL_ASSET_VISIBLE);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_runWire", 1, mal_test_run_wire);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_spawnDevelopmentProcess", 2, mal_dev_spawn);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_killDevelopmentProcess", 1, mal_dev_kill);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_developmentProcessStatus", 1, mal_dev_process_status);
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_data(
        vm, global_this, (const byte *) "mal", roots[0], MAL_ASSET_VISIBLE);
    mal_gc_unroot(&root_span);
}
