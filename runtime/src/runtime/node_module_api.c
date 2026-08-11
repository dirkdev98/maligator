#include "node_module_api.h"

#if MAL_NODE

#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static const char *node_module_builtin_names[] = {
    "assert", "assert/strict", "async_hooks", "buffer", "child_process",
    "cluster", "crypto", "diagnostics_channel", "dns", "domain", "events",
    "fs", "fs/promises", "http", "http2", "https", "inspector", "module",
    "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process",
    "querystring", "readline", "stream", "string_decoder", "timers",
    "timers/promises", "tls", "tty", "url", "util", "v8", "vm",
    "worker_threads", "zlib", "node:sqlite",
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

    MalValue require = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "require"), 1,
            node_module_dynamic_unavailable));
    MalRootSpan root;
    mal_gc_root(&root, &require, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(require),
        "resolve", 1, node_module_dynamic_unavailable);
    mal_gc_unroot(&root);
    return require;
}

void mal_host_install_node_module(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
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
        vm->intrinsics[MAL_INTRINSIC_NODE_MODULE_API_MODULE] = roots[0];
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
