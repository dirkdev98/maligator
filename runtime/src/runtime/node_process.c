#include "node_process.h"

#if MAL_NODE

#include <errno.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/utsname.h>
#if defined(__APPLE__)
#include <mach/mach.h>
#elif defined(__GLIBC__)
#include <gnu/libc-version.h>
#endif

#include "array_object.h"
#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_bigint.h"
#include "host.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_events.h"
#include "node_buffer.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "posix_signal.h"
#include "property_store.h"
#include "table.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_host_timer.h"

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

// Fallback for stripped definitions whose source entry is not retained.
static const char mal_process_script_placeholder[] = "<compiled>";

// Decode `len` UTF-8 bytes into a fresh MalString value. argv / env / cwd arrive as
// OS byte strings; Node treats them as UTF-8, so a raw byte >= 0x80 becomes the
// matching code point (or U+FFFD when ill-formed) rather than a Latin-1 char.
static MalValue mal_process_utf8_string_n(MalVm *vm, const char *bytes, usize len) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) bytes, len);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
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
    mal_object_set(array, mal_key_index(index), element);
    mal_gc_unroot(&rs);
}

// process.argv = [OS argv0, compiled entry, OS argv1..].
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
    mal_process_set_element(
        vm, argv, 1,
        launch != nullptr && launch->script_path != nullptr
            ? launch->script_path
            : mal_process_script_placeholder);
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
        MalKey key;
        if (mal_vm_value_to_property_key(vm, name, &key)) {
            mal_object_set(env, key, value);
        }
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

static u64 mal_process_monotonic_ns(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
}

static MalValue mal_process_hrtime_bigint(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_from_bigint(mal_bigint_new(
        &vm->heap, (i128) mal_process_monotonic_ns()));
}

static MalValue mal_process_hrtime(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    u64 nanoseconds = mal_process_monotonic_ns();
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalObject *array = mal_value_to_object(result);
    mal_object_set(array, mal_key_index(0),
        mal_value_from_f64((f64) (nanoseconds / 1000000000ull)));
    mal_object_set(array, mal_key_index(1),
        mal_value_from_f64((f64) (nanoseconds % 1000000000ull)));
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_process_next_tick_task(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *task =
        mal_value_to_native_function_object(callee);
    i32 forwarded_count = task->slot_count - 1;
    MalValue callback = mal_native_function_object_get_slot(task, 0);
    MalCompletion completion = mal_vm_call_value(vm, callback,
        mal_value_new_undefined(),
        forwarded_count > 0 ? task->slots + 1 : nullptr,
        forwarded_count);
    return completion.value;
}

static MalValue mal_process_next_tick(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "nextTick callback must be a function");
        return mal_value_new_undefined();
    }
    MalValue task = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "nextTick"),
            mal_process_next_tick_task, args, argc));
    MalRootSpan root;
    mal_gc_root(&root, &task, 1);
    mal_vm_enqueue_reaction_job(vm, task, false,
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void mal_process_emit(MalVm *vm, const char *event, MalValue argument);

static bool mal_process_exit_code_number(MalVm *vm, MalValue value, f64 *number) {
    if (mal_value_is_string(value) && mal_string_length(mal_value_to_string(value)) > 0) {
        if (!mal_vm_to_number(vm, value, number)) return false;
    } else if (mal_ops_is_number(value)) {
        *number = mal_ops_number_as_f64(value);
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Exit code must be a number or numeric string");
        return false;
    }
    if (!isfinite(*number) || trunc(*number) != *number
        || fabs(*number) > 9007199254740991.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Exit code must be a safe integer");
        return false;
    }
    return true;
}

static MalValue mal_process_get_exit_code(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return mal_object_get_own(mal_value_to_object(state), mal_key_index(0)).desc.value;
}

static MalValue mal_process_set_exit_code(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_null(value)) value = mal_value_new_undefined();
    if (!mal_value_is_undefined(value)) {
        f64 number;
        if (!mal_process_exit_code_number(vm, value, &number)) return mal_value_new_undefined();
        value = mal_value_from_f64(number);
    }
    mal_object_set(mal_value_to_object(state), mal_key_index(0), value);
    return mal_value_new_undefined();
}

static f64 mal_process_pending_exit_code(MalVm *vm, int default_code) {
    MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    MalValue value;
    if (!mal_value_is_object(process)
        || !mal_vm_get_property(vm, process,
            mal_intrinsic_string_key(vm, (const byte *) "exitCode"), &value)
        || mal_value_is_undefined(value)) return default_code;
    f64 number;
    return mal_process_exit_code_number(vm, value, &number) ? number : 1;
}

static int mal_process_status(f64 number) {
    int code = (int) fmod(number, 256.0);
    return code < 0 ? code + 256 : code;
}

static int mal_process_finish(MalVm *vm, int default_code) {
    MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    if (!mal_value_is_object(process)) return default_code;
    bool throwing = vm->completion.kind == MAL_COMPLETION_THROW;
    f64 number = throwing ? default_code : mal_process_pending_exit_code(vm, default_code);
    if (vm->completion.kind == MAL_COMPLETION_THROW) throwing = true;
    MalValue exiting;
    MalKey exiting_key = mal_intrinsic_string_key(vm, (const byte *) "_exiting");
    if (mal_vm_get_property(vm, process, exiting_key, &exiting)
        && !mal_value_is_truthy(exiting)) {
        mal_vm_set_property(vm, process, exiting_key, mal_value_new_boolean(true), process);
        MalCompletion completion = vm->completion;
        MalRootSpan completion_root;
        mal_gc_root(&completion_root, &completion.value, 1);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined()};
        mal_process_emit(vm, "exit", mal_value_from_f64(number));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&completion_root);
            return 1;
        }
        if (throwing) vm->completion = completion;
        mal_gc_unroot(&completion_root);
    }
    if (throwing) return default_code == 0 ? 1 : default_code;
    f64 final_code = mal_process_pending_exit_code(vm, default_code);
    return vm->completion.kind == MAL_COMPLETION_THROW ? 1 : mal_process_status(final_code);
}

static MalValue mal_process_exit(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;

    MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    if (argc > 0 && !mal_value_is_undefined(args[0]) && !mal_value_is_null(args[0])) {
        f64 number;
        if (!mal_process_exit_code_number(vm, args[0], &number)) return mal_value_new_undefined();
        mal_vm_set_property(vm, process,
            mal_intrinsic_string_key(vm, (const byte *) "exitCode"),
            mal_value_from_f64(number), process);
    }
    exit(mal_process_finish(vm, 0));
}

static int mal_process_signal_number(const MalString *signal) {
    usize length;
    byte *name = mal_string_to_utf8(signal, &length);
    if (name == nullptr) return 0;
    int number = strlen((const char *) name) == length
        ? mal_host_signal_number_named((const char *) name) : 0;
    free(name);
    return number;
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
    if (!isfinite(pid_number) || trunc(pid_number) != pid_number
        || pid_number < INT_MIN || pid_number > INT_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The value of \"pid\" is out of range");
        return mal_value_new_undefined();
    }
    int signal_number = SIGTERM;
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        if (mal_ops_is_number(args[1])) {
            f64 number = mal_ops_number_as_f64(args[1]);
            if (!isfinite(number) || trunc(number) != number || number < 0 || number > INT_MAX) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid signal number");
                return mal_value_new_undefined();
            }
            signal_number = (int) number;
        } else if (!mal_value_is_string(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The \"signal\" argument must be a string");
            return mal_value_new_undefined();
        } else {
            signal_number = mal_process_signal_number(mal_value_to_string(args[1]));
            if (signal_number == 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown signal");
                return mal_value_new_undefined();
            }
        }
    }
    if (kill((pid_t) pid_number, signal_number) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "process.kill failed");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(true);
}

static MalValue mal_process_get_builtin_module(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc == 0 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Builtin module id must be a string");
        return mal_value_new_undefined();
    }
    return mal_node_module_get_builtin(vm, mal_value_to_string(args[0]));
}

static MalValue mal_process_umask(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc == 0 || mal_value_is_undefined(args[0])) {
        mode_t mask = umask(0);
        umask(mask);
        return mal_value_from_i32((i32) mask);
    }
    f64 number = -1;
    if (mal_value_is_string(args[0])) {
        const MalString *string = mal_value_to_string(args[0]);
        const c16 *units = mal_string_code_units(string);
        usize length = mal_string_length(string);
        number = length == 0 ? -1 : 0;
        for (usize i = 0; i < length; i++) {
            if (units[i] < '0' || units[i] > '7') {
                number = -1;
                break;
            }
            number = number * 8 + units[i] - '0';
        }
    } else if (mal_ops_is_number(args[0])) {
        number = mal_ops_number_as_f64(args[0]);
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "umask must be a number or octal string");
        return mal_value_new_undefined();
    }
    if (!isfinite(number) || trunc(number) != number || number < 0 || number > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid umask");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) umask((mode_t) (u32) number));
}

static bool mal_process_rss_bytes(usize *bytes) {
#if defined(__APPLE__)
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t) &info, &count) != KERN_SUCCESS) {
        return false;
    }
    *bytes = (usize) info.resident_size;
    return true;
#elif defined(__linux__)
    FILE *file = fopen("/proc/self/statm", "r");
    if (file == nullptr) return false;
    unsigned long resident;
    int parsed = fscanf(file, "%*lu %lu", &resident);
    fclose(file);
    long page = sysconf(_SC_PAGESIZE);
    if (parsed != 1 || page <= 0) return false;
    *bytes = (usize) resident * (usize) page;
    return true;
#else
    (void) bytes;
    return false;
#endif
}

static MalValue mal_process_memory_rss(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    usize bytes;
    if (!mal_process_rss_bytes(&bytes)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Current RSS measurement is unavailable");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) bytes);
}

static _Thread_local usize mal_process_array_buffer_bytes;

static void mal_process_count_array_buffers(MalHeapHeader *header) {
    if ((header->mark & MAL_MARK_FREE) == 0 && header->type == MAL_HEAP_ARRAY_BUFFER_OBJECT) {
        MalArrayBufferObject *buffer = (MalArrayBufferObject *) header;
        if (!buffer->detached) mal_process_array_buffer_bytes += buffer->allocation_capacity;
    }
}

static MalValue mal_process_memory_usage(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    usize rss;
    if (!mal_process_rss_bytes(&rss)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Current RSS measurement is unavailable");
        return mal_value_new_undefined();
    }
    MalHeapUsage usage = mal_heap_usage(&vm->heap);
    mal_process_array_buffer_bytes = 0;
    mal_heap_walk_cells(&vm->heap, mal_process_count_array_buffers);
    usize buffers = mal_process_array_buffer_bytes;
    const usize values[] = {rss, usage.chunk_mapped_bytes + usage.managed_large_bytes,
        usage.managed_owned_bytes, usage.raw_owned_bytes + buffers, buffers};
    const char *names[] = {"rss", "heapTotal", "heapUsed", "external", "arrayBuffers"};
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (usize i = 0; i < countof(names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) names[i],
            mal_value_from_f64((f64) values[i]),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_process_active_resources(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    MalHost *host = mal_host(vm);
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    u32 index = 0;
    for (MalHostTimer *timer = host->timers; timer != nullptr; timer = timer->next) {
        if (timer->referenced && !timer->cancelled) {
            mal_process_set_element(vm, mal_value_to_object(result), index++, "Timeout");
        }
    }
    for (i32 i = 0; i < host->reactor.pending_ops; i++) {
        mal_process_set_element(vm, mal_value_to_object(result), index++, "IO");
    }
    usize tasks = atomic_load_explicit(&host->reactor.retained_work, memory_order_acquire);
    for (usize i = 0; i < tasks; i++) {
        mal_process_set_element(vm, mal_value_to_object(result), index++, "HostTask");
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_process_get_report(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *header = mal_value_to_object(roots[1]);
    MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    const char *metadata[] = {"arch", "platform"};
    for (usize i = 0; i < countof(metadata); i++) {
        MalValue value;
        if (mal_vm_get_property(vm, process, mal_intrinsic_string_key(vm, (const byte *) metadata[i]), &value)) {
            mal_intrinsic_define_data(vm, header, (const byte *) metadata[i], value, MAL_PROPERTY_ENUMERABLE);
        }
    }
    mal_intrinsic_define_data(vm, header, (const byte *) "processId",
        mal_value_from_i32((i32) getpid()), MAL_PROPERTY_ENUMERABLE);
    struct utsname system;
    if (uname(&system) == 0) {
        mal_intrinsic_define_data(vm, header, (const byte *) "osName",
            mal_process_utf8_string(vm, system.sysname), MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, header, (const byte *) "osRelease",
            mal_process_utf8_string(vm, system.release), MAL_PROPERTY_ENUMERABLE);
    }
#if defined(__GLIBC__)
    mal_intrinsic_define_data(vm, header, (const byte *) "glibcVersionRuntime",
        mal_process_utf8_string(vm, gnu_get_libc_version()), MAL_PROPERTY_ENUMERABLE);
#endif
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "header",
        roots[1], MAL_PROPERTY_ENUMERABLE);
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_process_stdio_complete(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    MalValue callback = mal_native_function_object_get_slot(task, 1);
    MalValue error = mal_native_function_object_get_slot(task, 2);
    if (mal_value_is_callable(callback)) {
        mal_vm_call_value(vm, callback, mal_value_new_undefined(),
            mal_value_is_undefined(error) ? nullptr : &error,
            mal_value_is_undefined(error) ? 0 : 1);
    }
    if (!mal_value_is_undefined(error) && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalValue stream = mal_native_function_object_get_slot(task, 0);
        MalValue emit;
        MalValue arguments[] = {
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "error")), error,
        };
        MalRootSpan root;
        mal_gc_root(&root, arguments, countof(arguments));
        if (mal_vm_get_property(vm, stream,
                mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_EMIT), &emit)) {
            mal_vm_call_value(vm, emit, stream, arguments, 2);
        }
        mal_gc_unroot(&root);
    }
    return mal_value_new_undefined();
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
    f64 fd_number = mal_ops_number_as_f64(fd_value);
    if (fd_number != STDOUT_FILENO && fd_number != STDERR_FILENO) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "stdio stream has an invalid file descriptor");
        return mal_value_new_undefined();
    }
    int fd = (int) fd_number;

    MalValue callback = argc > 1 && mal_value_is_callable(args[1]) ? args[1]
        : argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_value_is_undefined(callback) && !mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Write callback must be a function");
        return mal_value_new_undefined();
    }
    byte *owned = nullptr;
    const byte *bytes;
    usize length = 0;
    if (mal_value_is_string(args[0])) {
        if (argc > 1 && mal_value_is_string(args[1])
            && !mal_node_buffer_encoding_is_known(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown write encoding");
            return mal_value_new_undefined();
        }
        owned = mal_node_buffer_decode_string(vm, args[0],
            argc > 1 && mal_value_is_string(args[1]) ? args[1] : mal_value_new_undefined(), &length);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        bytes = owned;
    } else if (mal_value_is_typed_array_object(args[0])) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(args[0], &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid write buffer");
            return mal_value_new_undefined();
        }
        bytes = span.data;
        length = span.length;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Write chunk must be a string or Uint8Array");
        return mal_value_new_undefined();
    }
    if (bytes == nullptr && length > 0) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    int write_error = 0;
    usize offset = 0;
    while (offset < length) {
        ssize_t written = write(fd, bytes + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) {
            write_error = errno;
            break;
        }
        offset += (usize) written;
    }
    free(owned);
    MalValue roots[] = {self, callback, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (write_error != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, strerror(write_error));
        roots[2] = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined()};
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "code",
            mal_process_utf8_string(vm, write_error == EPIPE ? "EPIPE" : "EIO"),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    if (write_error != 0 || mal_value_is_callable(callback)) {
        roots[3] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) "writeComplete"),
                mal_process_stdio_complete, roots, 3));
        mal_vm_enqueue_reaction_job(vm, roots[3], false,
            mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return mal_value_new_boolean(write_error == 0);
}

static MalValue mal_process_emit_warning(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"warning\" argument is required");
        return mal_value_new_undefined();
    }
    MalString *warning;
    if (!mal_vm_to_string(vm, args[0], &warning)) {
        return mal_value_new_undefined();
    }
    usize length;
    byte *bytes = mal_string_to_utf8(warning, &length);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize offset = 0;
    while (offset < length) {
        ssize_t written = write(STDERR_FILENO, bytes + offset, length - offset);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) break;
        offset += (usize) written;
    }
    free(bytes);
    const byte newline = '\n';
    while (write(STDERR_FILENO, &newline, 1) < 0 && errno == EINTR) {}
    return mal_value_new_undefined();
}

static bool mal_process_hooks_registered;

/* The installed process object. Read from the intrinsic rather than globalThis
 * so a program that reassigns the `process` global keeps its emitter identity. */
static MalValue mal_process_object(MalVm *vm) {
    return vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
}

/* Call the JS-visible `emit`, so a subclassed or patched emit still sees the
 * host-originated events. */
static void mal_process_emit(MalVm *vm, const char *event, MalValue argument) {
    MalValue roots[] = {mal_process_object(vm), mal_value_new_undefined(),
                        mal_value_new_undefined(), argument};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        roots[2] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event));
        if (mal_vm_get_property(
                vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_EMIT), &roots[1])
            && mal_value_is_callable(roots[1])) {
            mal_vm_call_value(vm, roots[1], roots[0], roots + 2, 2);
        }
    }
    mal_gc_unroot(&root);
}

static void mal_process_sync_signal(MalVm *vm, MalHostSignal signal) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        return;
    }
    u32 listeners = mal_node_events_listener_count(
        vm, mal_process_object(vm), mal_host_signal_name(signal));
    if (listeners > 0) {
        (void) mal_host_signal_listen(&host->reactor, signal);
    } else {
        mal_host_signal_unlisten(signal);
    }
}

/* node:events change hook: re-derive both dispositions from the current listener
 * counts. Re-deriving rather than tracking transitions is what makes
 * removeAllListeners() — which clears every event at once — come out right. */
static void mal_process_listeners_changed(MalVm *vm, MalValue receiver) {
    MalValue process = mal_process_object(vm);
    if (!mal_value_is_object(process) || !mal_value_is_object(receiver)
        || mal_value_to_object(receiver) != mal_value_to_object(process)) {
        return;
    }
    for (int i = 0; i < MAL_HOST_SIGNAL_COUNT; i++) {
        mal_process_sync_signal(vm, (MalHostSignal) i);
    }
}

/* Macrotask source: deliver at most one flagged signal per turn so microtasks
 * drain between deliveries, like any other macrotask. */
static bool mal_process_drain_signals(MalVm *vm) {
    for (int i = 0; i < MAL_HOST_SIGNAL_COUNT; i++) {
        MalHostSignal signal = (MalHostSignal) i;
        if (!mal_host_signal_take(signal)) {
            continue;
        }
        const char *name = mal_host_signal_name(signal);
        MalValue argument =
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name));
        MalRootSpan root;
        mal_gc_root(&root, &argument, 1);
        mal_process_emit(vm, name, argument);
        mal_gc_unroot(&root);
        return true;
    }
    return false;
}

static bool mal_process_emit_before_exit(MalVm *vm) {
    // An uncaught top-level exception is a fatal error, not a clean drain.
    if (vm->completion.kind == MAL_COMPLETION_THROW
        || mal_node_events_listener_count(vm, mal_process_object(vm), "beforeExit") == 0) {
        return false;
    }
    mal_process_emit(vm, "beforeExit", mal_value_from_f64(mal_process_pending_exit_code(vm, 0)));
    return true;
}

static MalValue mal_process_stdio_columns(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue fd;
    struct winsize dimensions;
    if (!mal_vm_get_property(vm, self,
            mal_intrinsic_string_key(vm, (const byte *) "fd"), &fd)
        || !mal_ops_is_number(fd)
        || ioctl((int) mal_ops_number_as_f64(fd), TIOCGWINSZ, &dimensions) != 0) {
        return mal_value_new_undefined();
    }
    return mal_value_from_i32(dimensions.ws_col);
}

static MalValue mal_process_build_stdio(MalVm *vm, int fd) {
    const MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue stream_value = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE])));
    MalRootSpan root;
    mal_gc_root(&root, &stream_value, 1);
    MalObject *stream = mal_value_to_object(stream_value);
    mal_intrinsic_define_data(
        vm, stream, (const byte *) "fd", mal_value_from_i32(fd), flags);
    mal_intrinsic_define_data(vm, stream, (const byte *) "isTTY",
        mal_value_new_boolean(isatty(fd) == 1), flags);
    if (fd != STDIN_FILENO) {
        mal_intrinsic_define_method_n(
            vm, stream, (const byte *) "write", 1, mal_process_stdio_write);
        mal_intrinsic_define_getter(vm, stream, (const byte *) "columns",
            (const byte *) "get columns", mal_process_stdio_columns,
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return stream_value;
}

void mal_host_install_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:process", slots, count)) return;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:process", slots, count, cached);
        return;
    }
    // Materialize the realm's EventEmitter first so `process` can inherit from it
    // whichever of the two installers the program's manifest reaches first.
    mal_host_install_node_events(vm, nullptr, 0, launch);
    MalValue emitter_prototype = vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE];
    MalObject *process_prototype = mal_value_is_object(emitter_prototype)
        ? mal_value_to_object(emitter_prototype)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    MalValue process_val =
        mal_value_from_object(mal_object_new(&vm->heap, process_prototype));
    MalRootSpan root;
    mal_gc_root(&root, &process_val, 1);
    MalObject *process = mal_value_to_object(process_val);
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install_node(vm, global_this);
    struct sigaction ignored = {.sa_handler = SIG_IGN};
    sigemptyset(&ignored.sa_mask);
    sigaction(SIGPIPE, &ignored, nullptr);

    if (!mal_process_hooks_registered) {
        mal_node_events_set_change_hook(mal_process_listeners_changed);
        mal_host_register_macrotask_drain(mal_process_drain_signals, true);
        mal_host_register_idle_notify(mal_process_emit_before_exit);
        mal_host_register_exit_notify(mal_process_finish);
        mal_process_hooks_registered = true;
    }

    const MalPropertyFlags data_flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    MalValue exit_roots[] = {
        mal_value_from_array_object(mal_intrinsic_new_array(vm, 1)),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan exit_root;
    mal_gc_root(&exit_root, exit_roots, countof(exit_roots));
    mal_object_set(mal_value_to_object(exit_roots[0]), mal_key_index(0), mal_value_new_undefined());
    exit_roots[1] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "get exitCode"), 0,
            mal_process_get_exit_code, exit_roots, 1));
    exit_roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "set exitCode"), 1,
            mal_process_set_exit_code, exit_roots, 1));
    MalPropertyDesc exit_descriptor = mal_intrinsic_accessor_desc(exit_roots[1], exit_roots[2],
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(process, mal_intrinsic_string_key(vm, (const byte *) "exitCode"),
        &exit_descriptor);
    mal_gc_unroot(&exit_root);
    mal_intrinsic_define_data(vm, process, (const byte *) "_exiting",
        mal_value_new_boolean(false), data_flags);

    // argv / env are built detached then defined; root each across the define, which
    // may allocate (shape transition) after taking the value.
    MalValue argv = mal_process_build_argv(vm, launch);
    MalRootSpan argv_root;
    mal_gc_root(&argv_root, &argv, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "argv", argv, data_flags);
    mal_gc_unroot(&argv_root);

    const char *executable = launch != nullptr && launch->argc > 0
        && launch->argv != nullptr && launch->argv[0] != nullptr
        ? launch->argv[0]
        : "";
    MalValue exec_path = mal_process_utf8_string(vm, executable);
    MalRootSpan exec_path_root;
    mal_gc_root(&exec_path_root, &exec_path, 1);
    mal_intrinsic_define_data(
        vm, process, (const byte *) "execPath", exec_path, data_flags);
    mal_gc_unroot(&exec_path_root);

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
    MalValue stdin_value = mal_process_build_stdio(vm, STDIN_FILENO);
    MalRootSpan stdin_root;
    mal_gc_root(&stdin_root, &stdin_value, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "stdin", stdin_value, data_flags);
    mal_gc_unroot(&stdin_root);

    MalValue versions = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan versions_root;
    mal_gc_root(&versions_root, &versions, 1);
    mal_intrinsic_define_data(vm, process, (const byte *) "versions",
        versions, data_flags);
    mal_gc_unroot(&versions_root);
    MalValue release = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan release_root;
    mal_gc_root(&release_root, &release, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(release), (const byte *) "name",
        mal_process_utf8_string(vm, "maligator"), data_flags);
    mal_intrinsic_define_data(vm, process, (const byte *) "release", release, data_flags);
    mal_gc_unroot(&release_root);

    mal_intrinsic_define_method_n(vm, process, (const byte *) "cwd", 0, mal_process_cwd);
    mal_intrinsic_define_method_n(
        vm, process, (const byte *) "nextTick", 1, mal_process_next_tick);
    MalValue hrtime = mal_intrinsic_define_method_n(
        vm, process, (const byte *) "hrtime", 1, mal_process_hrtime);
    MalRootSpan hrtime_root;
    mal_gc_root(&hrtime_root, &hrtime, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(hrtime),
        (const byte *) "bigint", 0, mal_process_hrtime_bigint);
    mal_gc_unroot(&hrtime_root);
    mal_intrinsic_define_method_n(
        vm, process, (const byte *) "emitWarning", 1, mal_process_emit_warning);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "exit", 1, mal_process_exit);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "kill", 2, mal_process_kill);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "umask", 1, mal_process_umask);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "getBuiltinModule", 1,
        mal_process_get_builtin_module);
    MalValue memory = mal_intrinsic_define_method_n(vm, process, (const byte *) "memoryUsage", 0,
        mal_process_memory_usage);
    MalRootSpan memory_root;
    mal_gc_root(&memory_root, &memory, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(memory), (const byte *) "rss", 0,
        mal_process_memory_rss);
    mal_gc_unroot(&memory_root);
    mal_intrinsic_define_method_n(vm, process, (const byte *) "getActiveResourcesInfo", 0,
        mal_process_active_resources);
    MalValue report = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan report_root;
    mal_gc_root(&report_root, &report, 1);
    mal_intrinsic_define_method_n(vm, mal_value_to_object(report), (const byte *) "getReport", 0,
        mal_process_get_report);
    mal_intrinsic_define_data(vm, process, (const byte *) "report", report, data_flags);
    mal_gc_unroot(&report_root);
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
    mal_intrinsic_define_data(vm, global_this, (const byte *) "global",
        vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], data_flags);

    vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE] = process_val;
    mal_node_module_publish(vm, "node:process", slots, count, process_val);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
