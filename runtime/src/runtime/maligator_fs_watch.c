#include "maligator_fs.h"

#include <stdlib.h>
#include <string.h>

#include "fs_watch.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "utf8.h"
#include "vm_ops.h"

static void fs_watch_notify(MalVm *vm, MalFsWatch *watch, MalFsWatchKind kind,
    const char *relative, void *data) {
    (void) data;
    static const char *const names[] = {
        [MAL_FS_WATCH_CREATE] = "create",
        [MAL_FS_WATCH_MODIFY] = "modify",
        [MAL_FS_WATCH_DELETE] = "delete",
        [MAL_FS_WATCH_RENAME] = "rename",
    };
    MalValue args[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    args[0] = mal_value_from_string(mal_intrinsic_ascii(vm, names[kind]));
    MalString *path = mal_string_from_utf8(&vm->heap, (const byte *) relative, strlen(relative));
    if (path == nullptr) {
        mal_vm_throw_allocation_error(vm);
    } else {
        args[1] = mal_value_from_string(path);
        vm->completion = mal_vm_call_value(
            vm, mal_fs_watch_owner(watch), mal_value_new_undefined(), args, countof(args));
    }
    mal_gc_unroot(&root);
}

static void fs_watch_error(MalVm *vm, MalFsWatch *watch, int error, void *data) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue args[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, args, countof(args));
    args[0] = mal_value_from_string(mal_intrinsic_ascii(vm, "error"));
    args[2] = mal_fs_failure(vm, error, "watch", data, nullptr);
    if (vm->completion.kind != MAL_COMPLETION_THROW)
        vm->completion = mal_vm_call_value(
            vm, mal_fs_watch_owner(watch), mal_value_new_undefined(), args, countof(args));
    mal_gc_unroot(&root);
}

static void fs_watch_release_path(void *data, bool teardown) {
    (void) teardown;
    free(data);
}

static MalValue fs_watch_open_binding(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    if (argc < 3 || !mal_value_is_callable(args[2])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Invalid watch listener");
        return undefined;
    }
    char *path = mal_fs_path(vm, args[0]);
    if (path == nullptr) return undefined;
    static const MalFsWatchCallbacks callbacks = {
        .event = fs_watch_notify,
        .error = fs_watch_error,
        .release = fs_watch_release_path,
    };
    MalFsWatch *watch;
    int error = mal_fs_watch_start(vm, path, mal_value_is_truthy(args[1]), true,
        true, args[2], &callbacks, path, &watch);
    if (error != 0) {
        MalValue failure = mal_fs_failure(vm, error, "watch", path, nullptr);
        free(path);
        if (vm->completion.kind != MAL_COMPLETION_THROW)
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = failure};
    }
    return undefined;
}

static MalValue fs_watch_close_binding(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc > 0 && mal_value_is_callable(args[0])) mal_fs_watch_stop(mal_fs_watch_find(vm, args[0]));
    return mal_value_new_undefined();
}

void mal_host_install_maligator_internal_fs_watch(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        bool open = strcmp(slots[i].name, "openWatch") == 0;
        vm->globals[slots[i].slot] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, slots[i].name), open ? 3 : 1,
                open ? fs_watch_open_binding : fs_watch_close_binding));
    }
}
