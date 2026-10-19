#include "node_module_api.h"

#if MAL_NODE

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

static const char *node_module_builtin_names[] = {
#include "generated/node_builtin_modules.inc"
};

static bool node_module_matches_builtin(MalString *string, const char *name) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize offset = length >= 5 && units[0] == 'n' && units[1] == 'o'
            && units[2] == 'd' && units[3] == 'e' && units[4] == ':'
        ? 5
        : 0;
    usize name_length = strlen(name);
    if (strncmp(name, "node:", 5) == 0) {
        offset = 0;
    }
    if (length != offset + name_length) return false;
    for (usize i = 0; i < name_length; i++) {
        if (units[offset + i] != (byte) name[i]) return false;
    }
    return true;
}

static MalValue node_module_is_builtin(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        return mal_value_new_boolean(false);
    }
    MalString *string = mal_value_to_string(args[0]);
    for (usize i = 0; i < countof(node_module_builtin_names); i++) {
        if (node_module_matches_builtin(string, node_module_builtin_names[i])) {
            return mal_value_new_boolean(true);
        }
    }
    return mal_value_new_boolean(false);
}

static MalValue node_module_builtin_modules(MalVm *vm) {
    MalArrayObject *array = mal_intrinsic_new_dense_array(
        vm, countof(node_module_builtin_names));
    MalValue result = mal_value_from_array_object(array);
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (u32 i = 0; i < countof(node_module_builtin_names); i++) {
        const char *name = node_module_builtin_names[i];
        mal_array_object_store(
            array, mal_key_index(i),
            mal_value_from_string(mal_string_new_ascii(
                &vm->heap, (const byte *) name, strlen(name))));
    }
    mal_object_set_integrity_level((MalObject *) array, true);
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_module_dynamic_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Dynamic CommonJS loading is unavailable in an ahead-of-time image");
    return mal_value_new_undefined();
}

static void node_module_throw_not_found(MalVm *vm, MalString *id, const char *detail) {
    char *text = nullptr;
    usize length = 0;
    if (mal_string_to_utf8_c_string(id, &text, &length) != MAL_UTF8_C_STRING_OK) text = nullptr;
    char message[512];
    snprintf(message, sizeof message, "Cannot find module '%s'%s", text == nullptr ? "" : text, detail);
    free(text);
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "MODULE_NOT_FOUND");
}

// A created require's slots: the compiler-attached [table, filenames] of its module.
enum { REQUIRE_TABLE, REQUIRE_FILENAMES, REQUIRE_SLOT_COUNT };

static bool node_module_table_lookup(MalValue require, i32 slot, MalValue id, MalValue *out) {
    MalValue table = mal_native_function_object_get_slot(mal_value_to_native_function_object(require), slot);
    if (!mal_value_is_object(table)) return false;
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(table), mal_key_from_value(id));
    if (!found.present) return false;
    *out = found.desc.value;
    return true;
}

// Static edges arrive through the compiler-attached table: CommonJS modules by registry
// id, ES modules as a one-element array holding their evaluation thunk, built-ins as
// their exports. The image holds no loader for anything outside the graph.
static MalValue node_module_require(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue id = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(id)) {
        mal_node_throw_invalid_arg_type(vm, "id", "of type string", id);
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(id);
    if (mal_string_length(string) == 0) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The argument 'id' must be a non-empty string. Received ''", "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    MalValue target;
    if (node_module_table_lookup(callee, REQUIRE_TABLE, id, &target)) {
        if (mal_ops_is_number(target)) return mal_vm_cjs_require(vm, (i32) mal_ops_number_as_f64(target));
        if (!mal_value_is_array_object(target)) return target;
        MalValue evaluate = mal_value_new_undefined();
        mal_array_object_dense_get(mal_value_to_array_object(target), 0, &evaluate);
        MalCompletion completion = mal_vm_call_value(vm, evaluate, mal_value_new_undefined(), nullptr, 0);
        return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
    }
    for (usize i = 0; i < countof(node_module_builtin_names); i++) {
        const char *name = node_module_builtin_names[i];
        if (!node_module_matches_builtin(string, name)) continue;
        char canonical[64];
        snprintf(canonical, sizeof canonical, "%s%s", strncmp(name, "node:", 5) == 0 ? "" : "node:", name);
        MalValue module = mal_node_module_get_cached(vm, canonical);
        if (!mal_value_is_undefined(module)) return module;
        node_module_throw_not_found(vm, string, ": the built-in is not linked into this ahead-of-time image");
        return mal_value_new_undefined();
    }
    node_module_throw_not_found(vm, string,
        ": only built-in modules can be required dynamically from an ahead-of-time image");
    return mal_value_new_undefined();
}

// Slots: [require].
static MalValue node_module_require_resolve(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue id = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(id)) {
        mal_node_throw_invalid_arg_type(vm, "request", "of type string", id);
        return mal_value_new_undefined();
    }
    MalValue require = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue filename;
    if (node_module_table_lookup(require, REQUIRE_FILENAMES, id, &filename)) return filename;
    for (usize i = 0; i < countof(node_module_builtin_names); i++) {
        if (node_module_matches_builtin(mal_value_to_string(id), node_module_builtin_names[i])) return id;
    }
    node_module_throw_not_found(vm, mal_value_to_string(id),
        ": only built-in modules can be resolved dynamically from an ahead-of-time image");
    return mal_value_new_undefined();
}

static MalValue node_module_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

static MalValue node_module_create_require(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "createRequire filename must be a string");
        return mal_value_new_undefined();
    }

    MalValue slots[REQUIRE_SLOT_COUNT] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue roots[] = {
        mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "require"), 1,
            node_module_require, slots, countof(slots))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "resolve"), 1,
        node_module_require_resolve, &roots[0], 1));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "resolve", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue require = roots[0];
    mal_gc_unroot(&root);
    return require;
}

// (require, table, filenames): emitted after `createRequire(import.meta.url)`.
static MalValue node_module_attach_require_table(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 3 || !mal_value_is_native_function_object(args[0])) return mal_value_new_undefined();
    MalNativeFunctionObject *require = mal_value_to_native_function_object(args[0]);
    if (require->callback != node_module_require) return mal_value_new_undefined();
    mal_native_function_object_set_slot(require, REQUIRE_TABLE, args[1]);
    mal_native_function_object_set_slot(require, REQUIRE_FILENAMES, args[2]);
    return mal_value_new_undefined();
}

#define MODULE_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue module_utf8(MalVm *vm, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static char *module_c_string(MalVm *vm, MalValue value) {
    usize length = 0;
    byte *utf8 = mal_string_to_utf8(mal_value_to_string(value), &length);
    char *text = utf8 == nullptr ? nullptr : realloc(utf8, length + 1);
    if (text == nullptr) {
        free(utf8);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    text[length] = '\0';
    return text;
}

static MalValue module_null_record(MalVm *vm, const char *const *names, const MalValue *values, usize count) {
    MalValue record = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &record, 1);
    for (usize i = 0; i < count; i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(record), (const byte *) names[i], values[i], MODULE_VISIBLE);
    }
    mal_gc_unroot(&root);
    return record;
}

/* Programs are compiled ahead of time, so there is never a code cache to enable. */
static MalValue module_enable_compile_cache(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    const char *names[] = {"status", "message"};
    MalValue values[] = {mal_value_from_i32(3),
        module_utf8(vm, "Disabled for ahead-of-time compiled programs")};
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan result_root;
    mal_gc_root(&result_root, &result, 1);
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) names[i], values[i], MODULE_VISIBLE);
    }
    mal_gc_unroot(&result_root);
    mal_gc_unroot(&root);
    return result;
}

static MalValue module_noop(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_new_undefined();
}

static MalValue module_deregister(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_new_undefined();
}

/* The module graph is fixed at compile time, so runtime hooks have nothing left to resolve. */
static MalValue module_register_hooks(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue hooks = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(hooks)) {
        mal_node_throw_invalid_arg_type(vm, "hooks", "of type object", hooks);
        return mal_value_new_undefined();
    }
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(result), (const byte *) "deregister", 0, module_deregister);
    mal_gc_unroot(&root);
    return result;
}

static MalValue module_get_source_maps_support(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    const char *names[] = {"enabled", "nodeModules", "generatedCode"};
    MalValue values[] = {mal_value_new_boolean(false), mal_value_new_boolean(false), mal_value_new_boolean(false)};
    return module_null_record(vm, names, values, countof(values));
}

static MalValue module_set_source_maps_support(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue enabled = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_boolean(enabled)) mal_node_throw_invalid_arg_type(vm, "enabled", "of type boolean", enabled);
    return mal_value_new_undefined();
}

/* Module._nodeModulePaths: every ancestor's node_modules, skipping node_modules segments. */
static MalValue module_node_module_paths(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue from = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(from)) {
        mal_node_throw_invalid_arg_type(vm, "from", "of type string", from);
        return mal_value_new_undefined();
    }
    char *path = module_c_string(vm, from);
    if (path == nullptr) return mal_value_new_undefined();
    char resolved[PATH_MAX];
    if (path[0] == '/') snprintf(resolved, sizeof resolved, "%s", path);
    else {
        char cwd[PATH_MAX];
        snprintf(resolved, sizeof resolved, "%s/%s", getcwd(cwd, sizeof cwd) != nullptr ? cwd : "", path);
    }
    free(path);
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    u32 index = 0;
    usize length = strlen(resolved);
    while (length > 1 && resolved[length - 1] == '/') resolved[--length] = '\0';
    for (;;) {
        char *slash = strrchr(resolved, '/');
        const char *segment = slash == nullptr ? resolved : slash + 1;
        if (strcmp(segment, "node_modules") != 0) {
            char entry[PATH_MAX + 16];
            snprintf(entry, sizeof entry, "%s/node_modules", strcmp(resolved, "/") == 0 ? "" : resolved);
            mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index++), module_utf8(vm, entry));
        }
        if (slash == nullptr || slash == resolved) break;
        *slash = '\0';
    }
    if (strcmp(resolved, "/") != 0) {
        mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index), module_utf8(vm, "/node_modules"));
    }
    mal_gc_unroot(&root);
    return result;
}

static bool module_exists(const char *path) {
    struct stat info;
    return stat(path, &info) == 0;
}

static void module_dirname(char *path) {
    char *slash = strrchr(path, '/');
    if (slash == nullptr) path[0] = '\0';
    else if (slash == path) path[1] = '\0';
    else *slash = '\0';
}

/* Turns a file: URL or path into a path; false for any other URL scheme. */
static bool module_path_from(const char *text, char *out, usize capacity) {
    if (strncmp(text, "file://", 7) == 0) {
        const char *path = text + 7;
        usize written = 0;
        for (const char *c = path; *c != '\0' && written + 1 < capacity; c++) {
            if (*c == '%' && c[1] != '\0' && c[2] != '\0') {
                char hex[3] = {c[1], c[2], '\0'};
                out[written++] = (char) strtol(hex, nullptr, 16);
                c += 2;
            } else {
                out[written++] = *c;
            }
        }
        out[written] = '\0';
        return true;
    }
    if (strstr(text, "://") != nullptr || strncmp(text, "data:", 5) == 0) return false;
    snprintf(out, capacity, "%s", text);
    return true;
}

/* module.findPackageJSON(specifier[, base]) for paths, file: URLs and bare package names. */
static MalValue module_find_package_json(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue specifier = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue base = argc > 1 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_object(specifier)) {
        MalValue href;
        if (!mal_vm_get_property(vm, specifier, mal_intrinsic_string_key(vm, (const byte *) "href"), &href)) {
            return mal_value_new_undefined();
        }
        specifier = href;
    }
    if (!mal_value_is_string(specifier)) {
        // Node coerces the specifier into a URL against a data: base, which fails.
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid URL", "ERR_INVALID_URL");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(base) && !mal_value_is_string(base)) {
        mal_node_throw_invalid_arg_type(vm, "base", "of type string or an instance of URL", base);
        return mal_value_new_undefined();
    }
    char *text = module_c_string(vm, specifier);
    char *base_text = mal_value_is_string(base) ? module_c_string(vm, base) : nullptr;
    if (text == nullptr || (mal_value_is_string(base) && base_text == nullptr)) {
        free(text);
        free(base_text);
        return mal_value_new_undefined();
    }
    char base_path[PATH_MAX] = "";
    bool have_base = base_text != nullptr && module_path_from(base_text, base_path, sizeof base_path);
    if (have_base && base_path[0] != '\0' && base_path[strlen(base_path) - 1] != '/') module_dirname(base_path);
    char target[PATH_MAX * 2];
    bool relative = text[0] == '.' && (text[1] == '\0' || text[1] == '/' || (text[1] == '.' && (text[2] == '\0' || text[2] == '/')));
    bool bare = !relative && text[0] != '/' && strncmp(text, "file:", 5) != 0;
    MalValue result = mal_value_new_undefined();
    if (bare) {
        char package[PATH_MAX] = "";
        // A scoped name keeps its first two segments; deeper subpaths share the package root.
        const char *end = strchr(text[0] == '@' && strchr(text, '/') != nullptr ? strchr(text, '/') + 1 : text, '/');
        snprintf(package, sizeof package, "%.*s", end == nullptr ? (int) strlen(text) : (int) (end - text), text);
        char directory[PATH_MAX];
        snprintf(directory, sizeof directory, "%s", have_base ? base_path : ".");
        for (;;) {
            snprintf(target, sizeof target, "%s/node_modules/%s/package.json",
                strcmp(directory, "/") == 0 ? "" : directory, package);
            if (module_exists(target)) {
                result = module_utf8(vm, target);
                break;
            }
            if (strcmp(directory, "/") == 0 || directory[0] == '\0' || strcmp(directory, ".") == 0) break;
            module_dirname(directory);
        }
        if (mal_value_is_undefined(result)) {
            char message[PATH_MAX * 2 + 64];
            snprintf(message, sizeof message, "Cannot find package '%s' imported from %s", package,
                base_text != nullptr ? base_text : "undefined");
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_MODULE_NOT_FOUND");
        }
    } else {
        char path[PATH_MAX];
        if (!module_path_from(text, path, sizeof path)) path[0] = '\0';
        if (relative) snprintf(target, sizeof target, "%s/%s", base_path, path);
        else snprintf(target, sizeof target, "%s", path);
        char resolved[PATH_MAX];
        if ((relative && !have_base) || realpath(target, resolved) == nullptr) {
            char message[PATH_MAX * 3 + 64];
            snprintf(message, sizeof message, "Cannot find module '%s' imported from %s", target,
                base_text != nullptr ? base_text : "undefined");
            mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_MODULE_NOT_FOUND");
        } else {
            module_dirname(resolved);
            for (;;) {
                snprintf(target, sizeof target, "%s/package.json", strcmp(resolved, "/") == 0 ? "" : resolved);
                if (module_exists(target)) {
                    result = module_utf8(vm, target);
                    break;
                }
                if (strcmp(resolved, "/") == 0 || resolved[0] == '\0') break;
                module_dirname(resolved);
            }
        }
    }
    free(text);
    free(base_text);
    return result;
}

/* Node's globalPaths: $HOME/.node_modules, $HOME/.node_libraries and <prefix>/lib/node. */
static MalValue module_global_paths(MalVm *vm) {
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    u32 index = 0;
    const char *home = getenv("HOME");
    char entry[PATH_MAX + 32];
    if (home != nullptr && home[0] != '\0') {
        snprintf(entry, sizeof entry, "%s/.node_modules", home);
        mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index++), module_utf8(vm, entry));
        snprintf(entry, sizeof entry, "%s/.node_libraries", home);
        mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index++), module_utf8(vm, entry));
    }
    const char *prefix = getenv("NODE_PREFIX");
    snprintf(entry, sizeof entry, "%s/lib/node", prefix != nullptr ? prefix : "/usr/local");
    mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index), module_utf8(vm, entry));
    mal_gc_unroot(&root);
    return result;
}

static void module_install_extras(MalVm *vm, MalObject *module) {
    static const struct {
        const char *name;
        i32 length;
        MalNativeFunctionCallback callback;
    } methods[] = {
        {"enableCompileCache", 1, module_enable_compile_cache},
        {"flushCompileCache", 0, module_noop},
        {"getCompileCacheDir", 0, module_noop},
        {"syncBuiltinESMExports", 0, module_noop},
        {"register", 3, module_noop},
        {"registerHooks", 1, module_register_hooks},
        {"findSourceMap", 1, module_noop},
        {"getSourceMapsSupport", 0, module_get_source_maps_support},
        {"setSourceMapsSupport", 2, module_set_source_maps_support},
        {"findPackageJSON", 2, module_find_package_json},
        {"_nodeModulePaths", 1, module_node_module_paths},
    };
    for (usize i = 0; i < countof(methods); i++) {
        mal_intrinsic_define_method_n(vm, module, (const byte *) methods[i].name, methods[i].length,
            methods[i].callback);
    }
    const char *status_names[] = {"FAILED", "ENABLED", "ALREADY_ENABLED", "DISABLED"};
    MalValue status_values[] = {mal_value_from_i32(0), mal_value_from_i32(1), mal_value_from_i32(2),
        mal_value_from_i32(3)};
    MalValue roots[] = {module_null_record(vm, status_names, status_values, countof(status_values)),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    const char *constant_names[] = {"compileCacheStatus"};
    roots[1] = module_null_record(vm, constant_names, roots, 1);
    mal_intrinsic_define_data(vm, module, (const byte *) "constants", roots[1], MODULE_VISIBLE);
    roots[2] = module_global_paths(vm);
    mal_intrinsic_define_data(vm, module, (const byte *) "globalPaths", roots[2], MODULE_VISIBLE);
    mal_gc_unroot(&root);
}

void mal_host_install_node_module(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:module", slots, count)) return;
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_MODULE_API_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[] = {
            mal_value_new_undefined(),
            mal_value_from_object(mal_intrinsic_new_object(vm)),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        MalNativeFunctionObject *constructor =
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, "Module"), 2, node_module_constructor);
        mal_native_function_object_set_constructor(constructor);
        roots[0] = mal_value_from_native_function_object(constructor);
        module = roots[0];
        mal_intrinsic_define_data(
            vm, (MalObject *) constructor, "prototype", roots[1],
            MAL_PROPERTY_NONE);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[1]), "constructor", roots[0],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[1]), "require", 1,
            node_module_dynamic_unavailable);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]),
            "createRequire", 1, node_module_create_require);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]),
            "isBuiltin", 1, node_module_is_builtin);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(roots[0]), "_resolveFilename", 2,
            node_module_dynamic_unavailable);
        roots[2] = node_module_builtin_modules(vm);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[0]), "builtinModules", roots[2],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE
                | MAL_PROPERTY_CONFIGURABLE);
        module_install_extras(vm, mal_value_to_object(roots[0]));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "Module", roots[0],
            MODULE_VISIBLE);
        vm->intrinsics[MAL_INTRINSIC_NODE_MODULE_API_MODULE] = roots[0];
        vm->intrinsics[MAL_INTRINSIC_ATTACH_REQUIRE_TABLE] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, ""), 3, node_module_attach_require_table));
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:module", slots, count, module);
}

#endif /* MAL_NODE */
