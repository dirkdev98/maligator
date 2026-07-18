#include "node_process.h"

#if MAL_NODE

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "table.h"
#include "text_encoding.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_globals.h"

// The process environment. On Darwin the real environ of an executable is reached
// through _NSGetEnviron(); the bare `extern char **environ` only resolves in a
// non-dylib main image, so the crt_externs form is the portable one here.
#if defined(__APPLE__)
#include <crt_externs.h>
static char **mal_process_environ(void) {
    return *_NSGetEnviron();
}
#else
extern char **environ;
static char **mal_process_environ(void) {
    return environ;
}
#endif

// The stable placeholder for process.argv[1] (the "script" slot). The entry module
// is baked into the definition at compile time and invisible to the runtime driver,
// so there is no real path to report — see MalHostLaunchContext.
static const char mal_process_script_placeholder[] = "<compiled>";

static MalKey mal_process_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

// Decode `len` UTF-8 bytes into a fresh MalString value. argv / env / cwd arrive as
// OS byte strings; Node treats them as UTF-8, so a raw byte >= 0x80 becomes the
// matching code point (or U+FFFD when ill-formed) rather than a Latin-1 char.
static MalValue mal_process_utf8_string_n(MalVm *vm, const char *bytes, usize len) {
    usize count;
    c16 *units = mal_utf8_decode((const byte *) bytes, len, &count);
    MalValue value = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
    free(units);
    return value;
}

static MalValue mal_process_utf8_string(MalVm *vm, const char *cstr) {
    return mal_process_utf8_string_n(vm, cstr, strlen(cstr));
}

// Store a UTF-8 C string as array element `index`, rooting the fresh string across
// the set (mal_object_set may allocate for a non-dense index).
static void mal_process_set_element(MalVm *vm, MalObject *array, u32 index, const char *utf8) {
    MalValue element = mal_process_utf8_string(vm, utf8);
    MalRootSpan rs;
    mal_gc_root(&rs, &element, 1);
    mal_object_set(array, mal_process_index_key(index), element);
    mal_gc_unroot(&rs);
}

// process.argv = [OS argv0, "<compiled>", OS argv1..]. The placeholder occupies the
// script slot; the remaining OS arguments follow, shifted by one.
static MalValue mal_process_build_argv(MalVm *vm, const MalHostLaunchContext *launch) {
    i32 os_argc = launch != nullptr ? launch->argc : 0;
    char **os_argv = launch != nullptr ? launch->argv : nullptr;

    // At least argv0 + the placeholder; a missing OS argv0 becomes an empty string.
    u32 length = (u32) (os_argc >= 1 ? os_argc : 1) + 1u;
    MalValue argv_val = mal_value_from_array_object(mal_intrinsic_new_array(vm, length));
    MalRootSpan rs;
    mal_gc_root(&rs, &argv_val, 1);
    MalObject *argv = (MalObject *) mal_value_to_array_object(argv_val);

    mal_process_set_element(vm, argv, 0, os_argc >= 1 ? os_argv[0] : "");
    mal_process_set_element(vm, argv, 1, mal_process_script_placeholder);
    for (i32 i = 1; i < os_argc; i++) {
        mal_process_set_element(vm, argv, (u32) i + 1u, os_argv[i]);
    }

    mal_gc_unroot(&rs);
    return argv_val;
}

// process.env: an enumerable own-property snapshot of the environment taken once at
// install. A plain object (not Node's live proxy) — sufficient for reads,
// Object.keys, and spread, which is all this slice promises.
static MalValue mal_process_build_env(MalVm *vm) {
    MalValue env_val = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan rs;
    mal_gc_root(&rs, &env_val, 1);
    MalObject *env = mal_value_to_object(env_val);

    char **entries = mal_process_environ();
    for (usize i = 0; entries != nullptr && entries[i] != nullptr; i++) {
        const char *entry = entries[i];
        const char *eq = strchr(entry, '=');
        // Skip a malformed entry with no '=' or an empty name ("=VALUE").
        if (eq == nullptr || eq == entry) {
            continue;
        }
        MalValue name = mal_process_utf8_string_n(vm, entry, (usize) (eq - entry));
        MalRootSpan name_rs;
        mal_gc_root(&name_rs, &name, 1);
        MalValue value = mal_process_utf8_string(vm, eq + 1);
        MalRootSpan value_rs;
        mal_gc_root(&value_rs, &value, 1);
        mal_object_set(env, mal_key_from_value(name), value);
        mal_gc_unroot(&value_rs);
        mal_gc_unroot(&name_rs);
    }

    mal_gc_unroot(&rs);
    return env_val;
}

static MalValue mal_process_cwd(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;

    char stack_buf[PATH_MAX];
    char *cwd = getcwd(stack_buf, sizeof stack_buf);
    if (cwd != nullptr) {
        return mal_process_utf8_string(vm, cwd);
    }

    // Path longer than PATH_MAX: grow until it fits (bounded), else fall back to "".
    char *heap_buf = nullptr;
    usize cap = sizeof stack_buf;
    while (cwd == nullptr && errno == ERANGE && cap < (1u << 20)) {
        cap *= 2;
        char *grown = realloc(heap_buf, cap);
        if (grown == nullptr) {
            break;
        }
        heap_buf = grown;
        cwd = getcwd(heap_buf, cap);
    }
    MalValue result = cwd != nullptr
        ? mal_process_utf8_string(vm, cwd)
        : mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) "", 0));
    free(heap_buf);
    return result;
}

static MalValue mal_process_exit(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;

    if (argc < 1 || mal_value_is_undefined(args[0])) {
        exit(0);
    }

    if (!mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"code\" argument must be of type number");
        return mal_value_new_undefined();
    }

    f64 num = mal_ops_number_as_f64(args[0]);
    if (!isfinite(num) || trunc(num) != num || num < -9007199254740991.0
        || num > 9007199254740991.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The value of \"code\" is out of range; it must be a safe integer");
        return mal_value_new_undefined();
    }

    // POSIX exposes only the low eight status bits. Reduce as a double first so
    // every accepted safe integer avoids an out-of-range conversion to C int.
    int code = (int) fmod(num, 256.0);
    if (code < 0) {
        code += 256;
    }
    exit(code);
}

static int mal_process_signal_number(const MalString *signal) {
    const c16 *units = mal_string_code_units(signal);
    usize len = mal_string_length(signal);
#define MAL_SIGNAL(name) \
    if (len == sizeof(#name) - 1) { \
        bool equal = true; \
        for (usize i = 0; i < len; i++) equal = equal && units[i] == (c16) (u8) #name[i]; \
        if (equal) return name; \
    }
    MAL_SIGNAL(SIGABRT)
    MAL_SIGNAL(SIGINT)
    MAL_SIGNAL(SIGKILL)
    MAL_SIGNAL(SIGTERM)
#undef MAL_SIGNAL
    return 0;
}

static MalValue mal_process_kill(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || !mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"pid\" argument must be of type number");
        return mal_value_new_undefined();
    }
    f64 pid_number = mal_ops_number_as_f64(args[0]);
    if (!isfinite(pid_number) || trunc(pid_number) != pid_number || pid_number <= 0
        || pid_number > INT_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The value of \"pid\" is out of range");
        return mal_value_new_undefined();
    }
    int signal_number = SIGTERM;
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        if (!mal_value_is_string(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The \"signal\" argument must be a string");
            return mal_value_new_undefined();
        }
        signal_number = mal_process_signal_number(mal_value_to_string(args[1]));
        if (signal_number == 0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown signal");
            return mal_value_new_undefined();
        }
    }
    if (kill((pid_t) pid_number, signal_number) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "process.kill failed");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(true);
}

static MalValue mal_process_stdio_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"chunk\" argument is required");
        return mal_value_new_undefined();
    }

    MalValue fd_value;
    if (!mal_vm_get_property(
            vm, self, mal_intrinsic_string_key(vm, (const byte *) "fd"), &fd_value)
        || !mal_ops_is_number(fd_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "stdio write called on incompatible receiver");
        return mal_value_new_undefined();
    }
    int fd = (int) mal_ops_number_as_f64(fd_value);
    if (fd != STDOUT_FILENO && fd != STDERR_FILENO) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "stdio stream has an invalid file descriptor");
        return mal_value_new_undefined();
    }

    MalString *string = mal_ops_to_string(&vm->heap, args[0]);
    usize length;
    byte *bytes = mal_utf8_encode(
        mal_string_code_units(string), mal_string_length(string), &length);
    usize offset = 0;
    while (offset < length) {
        ssize_t written = write(fd, bytes + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) {
            free(bytes);
            return mal_value_new_boolean(false);
        }
        offset += (usize) written;
    }
    free(bytes);
    return mal_value_new_boolean(true);
}

static MalValue mal_process_build_stdio(MalVm *vm, int fd) {
    const MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue stream_value = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &stream_value, 1);
    MalObject *stream = mal_value_to_object(stream_value);
    mal_intrinsic_define_data(
        vm, stream, (const byte *) "fd", mal_value_from_i32(fd), flags);
    mal_intrinsic_define_data(vm, stream, (const byte *) "isTTY",
        mal_value_new_boolean(isatty(fd) == 1), flags);
    mal_intrinsic_define_method_n(
        vm, stream, (const byte *) "write", 1, mal_process_stdio_write);
    mal_gc_unroot(&root);
    return stream_value;
}

void mal_host_install_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    MalValue process_val = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &process_val, 1);
    MalObject *process = mal_value_to_object(process_val);
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);

#if !MAL_WEB_PLATFORM
    mal_text_encoding_globals_install(vm, global_this);
#endif

    const MalPropertyFlags data_flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    // argv / env are built detached then defined; root each across the define, which
    // may allocate (shape transition) after taking the value.
    MalValue argv = mal_process_build_argv(vm, launch);
    MalRootSpan argv_root;
    mal_gc_root(&argv_root, &argv, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "argv", argv, data_flags);
    mal_gc_unroot(&argv_root);

    MalValue env = mal_process_build_env(vm);
    MalRootSpan env_root;
    mal_gc_root(&env_root, &env, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "env", env, data_flags);
    mal_gc_unroot(&env_root);

    MalValue stdout_value = mal_process_build_stdio(vm, STDOUT_FILENO);
    MalRootSpan stdout_root;
    mal_gc_root(&stdout_root, &stdout_value, 1);
    mal_intrinsic_define_data(
        vm, process, (const byte *) "stdout", stdout_value, data_flags);
    mal_gc_unroot(&stdout_root);

    MalValue stderr_value = mal_process_build_stdio(vm, STDERR_FILENO);
    MalRootSpan stderr_root;
    mal_gc_root(&stderr_root, &stderr_value, 1);
    mal_intrinsic_define_data(
        vm, process, (const byte *) "stderr", stderr_value, data_flags);
    mal_gc_unroot(&stderr_root);

    mal_intrinsic_define_method_n(vm, process, (const byte *) "cwd", 0, mal_process_cwd);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "exit", 1, mal_process_exit);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "kill", 2, mal_process_kill);
    mal_intrinsic_define_data(
        vm, process, (const byte *) "pid", mal_value_from_f64((f64) getpid()), data_flags);
#if defined(__APPLE__)
    MalValue platform = mal_process_utf8_string(vm, "darwin");
#elif defined(__linux__)
    MalValue platform = mal_process_utf8_string(vm, "linux");
#else
    MalValue platform = mal_process_utf8_string(vm, "unknown");
#endif
    MalRootSpan platform_root;
    mal_gc_root(&platform_root, &platform, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "platform", platform, data_flags);
    mal_gc_unroot(&platform_root);
#if defined(__aarch64__) || defined(__arm64__)
    MalValue arch = mal_process_utf8_string(vm, "arm64");
#elif defined(__x86_64__)
    MalValue arch = mal_process_utf8_string(vm, "x64");
#else
    MalValue arch = mal_process_utf8_string(vm, "unknown");
#endif
    MalRootSpan arch_root;
    mal_gc_root(&arch_root, &arch, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "arch", arch, data_flags);
    mal_gc_unroot(&arch_root);

    // A free `process` identifier resolves through the ordinary global object, so
    // publish the same writable/configurable property observed by globalThis.process.
    mal_intrinsic_define_data(
        vm, global_this, (const byte *) "process", process_val, data_flags);

    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
