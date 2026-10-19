#include "node_module.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "gc.h"
#include "heap_string.h"
#include "posix_fs.h"
#include "utf8.h"

MalValue mal_node_module_get_cached(MalVm *vm, const char *id) {
    MalValue registry = vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES];
    if (mal_value_is_undefined(registry)) return mal_value_new_undefined();
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(registry),
        mal_intrinsic_string_key(vm, (const byte *) id));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

/* Process exports inherit EventEmitter data properties; installation must not invoke accessors. */
static bool mal_node_module_lookup(MalObject *object, MalKey key, MalValue *out) {
    for (; object != nullptr; object = mal_object_prototype(object)) {
        MalPropertyLookup found = mal_object_get_own(object, key);
        if (found.present) {
            if ((found.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
                return false;
            }
            *out = found.desc.value;
            return true;
        }
    }
    return false;
}

void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES])) {
        vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES] = mal_value_from_object(
            mal_object_new(&vm->heap, nullptr));
    }
    mal_intrinsic_define_data(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES]),
        (const byte *) id, module, MAL_PROPERTY_NONE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalValue found;
        if (mal_node_module_lookup(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name), &found)) {
            vm->globals[slots[i].slot] = found;
        }
    }
    mal_gc_unroot(&root);
}

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count) {
    MalValue module = mal_node_module_get_cached(vm, id);
    if (mal_value_is_undefined(module)) return false;
    mal_node_module_publish(vm, id, slots, count, module);
    return true;
}

void mal_node_throw_code(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    mal_vm_throw_error(vm, prototype, (const byte *) message);
    MalValue roots[] = {
        vm->completion.value, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) code)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "code",
            roots[1], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
}

static void mal_node_define_utf8(MalVm *vm, MalObject *object, const char *name, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) return;
    MalValue value = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, object, (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

void mal_node_throw_errno(
    MalVm *vm, int err, const char *syscall, const char *path, const char *dest) {
    const char *code = mal_posix_fs_errno_name(err);
    const char *description = mal_posix_errno_description(err);
    usize capacity = strlen(code) + strlen(description) + strlen(syscall)
        + (path == nullptr ? 0 : strlen(path)) + (dest == nullptr ? 0 : strlen(dest)) + 24;
    char *message = malloc(capacity);
    if (message == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    if (path == nullptr) {
        snprintf(message, capacity, "%s: %s, %s", code, description, syscall);
    } else if (dest == nullptr) {
        snprintf(message, capacity, "%s: %s, %s '%s'", code, description, syscall, path);
    } else {
        snprintf(message, capacity, "%s: %s, %s '%s' -> '%s'",
            code, description, syscall, path, dest);
    }
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) message, strlen(message));
    free(message);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    MalValue text = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &text, 1);
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, text);
    mal_gc_unroot(&root);
    MalValue thrown = vm->completion.value;
    if (!mal_value_is_object(thrown)) return;
    // The completion keeps the error reachable while its properties allocate.
    MalObject *error = mal_value_to_object(thrown);
    mal_intrinsic_define_data(vm, error, (const byte *) "errno", mal_value_from_i32(-err),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_node_define_utf8(vm, error, "code", code);
    mal_node_define_utf8(vm, error, "syscall", syscall);
    if (path != nullptr) mal_node_define_utf8(vm, error, "path", path);
    if (dest != nullptr) mal_node_define_utf8(vm, error, "dest", dest);
}

#endif
