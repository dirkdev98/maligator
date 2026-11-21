#include "mal_bridge.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/event.h>
#endif

#include "array_object.h"
#include "builtin_data_view.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "host_registry.h"
#include "intrinsics.h"
#include "object.h"
#include "posix_fs.h"
#include "posix_process.h"
#include "profile.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value.h"
#include "vm_load.h"
#include "vm_ops.h"
#include "worker_manifest.h"
#include "workers.h"

#ifndef MAL_DEVELOPMENT_API
#define MAL_DEVELOPMENT_API 0
#endif

static const MalPropertyFlags MAL_BRIDGE_VISIBLE =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

#if MAL_DEVELOPMENT_API
static MalValue mal_bridge_string(MalVm *vm, const char *bytes) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) bytes, strlen(bytes));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static void mal_bridge_throw_utf8(MalVm *vm, MalIntrinsic prototype, const char *message) {
    MalValue value = mal_bridge_string(vm, message);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_vm_throw_error_value(vm, prototype, value);
    mal_gc_unroot(&root);
}

static char *mal_bridge_to_cstr(MalVm *vm, MalValue value, const char *argument) {
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
            "Bridge arguments must not contain null bytes");
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
    mal_bridge_throw_utf8(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        message != nullptr ? message : "Maligator host operation failed");
    free(message);
}

static MalValue mal_test_register_worker_manifest(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "mal._registerWorkerManifest requires a path");
        return mal_value_new_undefined();
    }
    char *path = mal_bridge_to_cstr(vm, args[0], "path");
    if (path == nullptr) return mal_value_new_undefined();
    mal_worker_manifest_register(vm, path);
    free(path);
    return mal_value_new_undefined();
}

static MalValue mal_test_run_wire_bytes(MalVm *vm, const u8 *bytes, usize length) {
    const char *error = "invalid VM wire";
    MalLoadedRuntimeImage *loaded = mal_runtime_image_load_with_host_resolver(
        bytes, length, &error, mal_host_resolve_installer);
    if (loaded == nullptr) {
        mal_bridge_throw_utf8(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, error);
        return mal_value_new_undefined();
    }

    mal_vm_retain_loaded_runtime_image(vm, loaded);
    const MalRuntimeImage *program = mal_loaded_runtime_image_get(loaded);
    i32 entry = mal_vm_splice_runtime_image(vm, program);
    if (entry < 0) return mal_value_new_undefined();
    mal_vm_run_program_host_installs(vm, program, &vm->launch);
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

    MalBufferSourceSpan span;
    if (mal_buffer_source_span(args[0], &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal._runWire requires an attached, in-bounds Uint8Array");
        return mal_value_new_undefined();
    }
    // The loader parses in place; a shared wire is parsed from a private snapshot.
    byte *owned;
    const u8 *bytes = (const u8 *) mal_buffer_source_span_private(&span, &owned);
    if (span.length > 0 && bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = mal_test_run_wire_bytes(vm, bytes, span.length);
    free(owned);
    return result;
}

static MalValue mal_test_run_wire_path(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal._runWirePath requires a path");
        return mal_value_new_undefined();
    }
    char *path = mal_bridge_to_cstr(vm, args[0], "path");
    if (path == nullptr) return mal_value_new_undefined();
    byte *bytes = nullptr;
    usize length = 0;
    int err = mal_posix_fs_read_file(path, &bytes, &length);
    if (err != 0) {
        mal_host_throw_errno(vm, err, "mal._runWirePath", "cannot read", path);
        free(path);
        free(bytes);
        return mal_value_new_undefined();
    }
    MalValue result = mal_test_run_wire_bytes(vm, (const u8 *) bytes, length);
    free(path);
    free(bytes);
    return result;
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

    char *executable = mal_bridge_to_cstr(vm, args[0], "executable");
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
        child_argv[i + 1] = mal_bridge_to_cstr(vm, argument, "argument");
        if (child_argv[i + 1] == nullptr) goto fail;
    }

    pid_t pid = mal_proc_fork();
    if (pid == 0) {
        (void) setpgid(0, 0);
        execv(executable, child_argv);
        _exit(127);
    }
    if (pid < 0) {
        mal_host_throw_errno(vm, errno, "mal.dev", "cannot spawn", executable);
        goto fail;
    }
    (void) setpgid(pid, pid);
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
    if (!(number > 0 && number <= (f64) INT32_MAX) || number != (f64) (pid_t) number) {
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
    bool force = argc >= 2 && mal_value_is_boolean(args[1]) && mal_value_to_boolean(args[1]);
    if (kill(-pid, force ? SIGKILL : SIGTERM) != 0 && errno != ESRCH) {
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

static MalValue mal_dev_wait_change(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 2 || !mal_value_is_array_object(args[0])
        || (!mal_value_is_int32(args[1]) && !mal_value_is_f64(args[1]))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal._waitDevelopmentChange requires a directory array and timeout");
        return mal_value_new_undefined();
    }
    f64 timeout_number = mal_value_is_int32(args[1])
        ? (f64) mal_value_to_i32(args[1]) : mal_value_to_f64(args[1]);
    if (timeout_number < 0 || timeout_number > 60000) timeout_number = 1000;
    long timeout_ms = (long) timeout_number;

#if defined(__APPLE__)
    u32 count = mal_array_object_length(mal_value_to_array_object(args[0]));
    int queue = kqueue();
    int *descriptors = calloc(count == 0 ? 1 : count, sizeof(int));
    struct kevent *changes = calloc(count == 0 ? 1 : count, sizeof(struct kevent));
    if (queue >= 0 && descriptors != nullptr && changes != nullptr) {
        u32 registered = 0;
        for (u32 i = 0; i < count; i++) {
            MalValue value;
            if (!mal_vm_get_property(vm, args[0], mal_key_index(i), &value)) break;
            char *directory = mal_bridge_to_cstr(vm, value, "directory");
            if (directory == nullptr) break;
            int descriptor = open(directory, O_EVTONLY);
            free(directory);
            if (descriptor < 0) continue;
            descriptors[registered] = descriptor;
            EV_SET(&changes[registered], (uintptr_t) descriptor, EVFILT_VNODE,
                EV_ADD | EV_ENABLE | EV_ONESHOT,
                NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_ATTRIB | NOTE_EXTEND,
                0, nullptr);
            registered++;
        }
        struct kevent event;
        struct timespec timeout = {
            .tv_sec = timeout_ms / 1000,
            .tv_nsec = (timeout_ms % 1000) * 1000000,
        };
        (void) kevent(queue, changes, (int) registered, &event, 1, &timeout);
        for (u32 i = 0; i < registered; i++) close(descriptors[i]);
    } else {
        struct timespec timeout = {
            .tv_sec = timeout_ms / 1000,
            .tv_nsec = (timeout_ms % 1000) * 1000000,
        };
        (void) nanosleep(&timeout, nullptr);
    }
    if (queue >= 0) close(queue);
    free(descriptors);
    free(changes);
#else
    struct timespec timeout = {
        .tv_sec = timeout_ms / 1000,
        .tv_nsec = (timeout_ms % 1000) * 1000000,
    };
    (void) nanosleep(&timeout, nullptr);
#endif
    return mal_value_new_undefined();
}
#endif

#if MAL_PROFILE
static bool mal_profile_phase_argument(MalVm *vm, const MalValue *args, i32 argc, u32 *out) {
    if (argc < 1 || !mal_value_is_int32(args[0])) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "mal profile phase ID must be a positive integer");
        return false;
    }
    i32 phase_id = mal_value_to_i32(args[0]);
    if (phase_id <= 0) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "mal profile phase ID must be positive");
        return false;
    }
    *out = (u32) phase_id;
    return true;
}

static MalValue mal_profile_phase_begin(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    u32 phase_id;
    if (mal_profile_phase_argument(vm, args, argc, &phase_id)) {
        mal_profile_phase(vm, phase_id, true);
    }
    return mal_value_new_undefined();
}

static MalValue mal_profile_phase_end(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    u32 phase_id;
    if (mal_profile_phase_argument(vm, args, argc, &phase_id)) {
        mal_profile_phase(vm, phase_id, false);
    }
    return mal_value_new_undefined();
}
#endif

#if MAL_DEVELOPMENT_API
static void mal_install_development_api(MalVm *vm, MalObject *mal) {
    mal_workers_install_application_api(vm, mal);
    mal_intrinsic_define_method_n(vm, mal, (const byte *) "_registerWorkerManifest", 1, mal_test_register_worker_manifest);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_runWire", 1, mal_test_run_wire);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_runWirePath", 1, mal_test_run_wire_path);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_spawnDevelopmentProcess", 2, mal_dev_spawn);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_killDevelopmentProcess", 2, mal_dev_kill);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_developmentProcessStatus", 1, mal_dev_process_status);
    mal_intrinsic_define_method_n(
        vm, mal, (const byte *) "_waitDevelopmentChange", 2, mal_dev_wait_change);
}
#endif

void mal_host_install_maligator(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;

    MalValue roots[1] = {mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    roots[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
#if MAL_PROFILE
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]),
        (const byte *) "_profilePhaseBegin", 1, mal_profile_phase_begin);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]),
        (const byte *) "_profilePhaseEnd", 1, mal_profile_phase_end);
#endif
#if MAL_DEVELOPMENT_API
    mal_install_development_api(vm, mal_value_to_object(roots[0]));
#endif
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_data(
        vm, global_this, (const byte *) "mal", roots[0], MAL_BRIDGE_VISIBLE);
    mal_gc_unroot(&root_span);
}
