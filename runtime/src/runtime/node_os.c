#include "node_os.h"

#if MAL_NODE

#include <ctype.h>
#include <pwd.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <sys/sysctl.h>
#endif

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"

static MalValue os_release(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *release = uname(&info) == 0 ? info.release : "";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) release, strlen(release)));
}

static MalValue os_hostname(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *hostname = uname(&info) == 0 ? info.nodename : "";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) hostname, strlen(hostname)));
}

static MalValue os_type(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *type = uname(&info) == 0 ? info.sysname : "";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) type, strlen(type)));
}

static MalValue os_uname_field(MalVm *vm, const char *field) {
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) field, strlen(field)));
}

static MalValue os_machine(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    struct utsname info;
    return os_uname_field(vm, uname(&info) == 0 ? info.machine : "");
}

static MalValue os_version(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    struct utsname info;
    return os_uname_field(vm, uname(&info) == 0 ? info.version : "");
}

static MalValue os_memory(bool available) {
#if defined(__APPLE__)
    u64 bytes = 0;
    if (available) {
        vm_statistics64_data_t statistics;
        mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
        mach_port_t host = mach_host_self();
        vm_size_t page_size = 0;
        if (host_page_size(host, &page_size) != KERN_SUCCESS
            || host_statistics64(host, HOST_VM_INFO64,
                (host_info64_t) &statistics, &count) != KERN_SUCCESS) {
            return mal_value_from_i32(0);
        }
        bytes = (u64) statistics.free_count * (u64) page_size;
    } else {
        size_t length = sizeof(bytes);
        if (sysctlbyname("hw.memsize", &bytes, &length, nullptr, 0) != 0) {
            return mal_value_from_i32(0);
        }
    }
    return mal_value_from_f64_convert_nan((f64) bytes);
#elif defined(_SC_AVPHYS_PAGES) && defined(_SC_PHYS_PAGES)
    long pages = sysconf(available ? _SC_AVPHYS_PAGES : _SC_PHYS_PAGES);
    long page_size = sysconf(_SC_PAGESIZE);
    if (pages < 0 || page_size < 0) return mal_value_from_i32(0);
    return mal_value_from_f64_convert_nan((f64) pages * (f64) page_size);
#else
    (void) available;
    return mal_value_from_i32(0);
#endif
}

static MalValue os_freemem(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc;
    (void) new_target; (void) callee;
    return os_memory(true);
}

static MalValue os_totalmem(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc;
    (void) new_target; (void) callee;
    return os_memory(false);
}

static MalValue os_uptime(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc;
    (void) new_target; (void) callee;
    struct timespec time = {0};
#ifdef CLOCK_BOOTTIME
    clock_gettime(CLOCK_BOOTTIME, &time);
#else
    clock_gettime(CLOCK_MONOTONIC, &time);
#endif
    return mal_value_from_f64_convert_nan(
        (f64) time.tv_sec + (f64) time.tv_nsec / 1000000000.0);
}

static MalValue os_loadavg(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    double averages[3] = {0};
    if (getloadavg(averages, 3) < 0) memset(averages, 0, sizeof(averages));
    MalArrayObject *array = mal_intrinsic_new_dense_array(vm, 3);
    for (i32 i = 0; i < 3; i++) {
        mal_array_object_store(array, mal_key_index(i),
            mal_value_from_f64_convert_nan(averages[i]));
    }
    return mal_value_from_array_object(array);
}

static void os_user_info_string(
    MalVm *vm, MalObject *object, const char *name, const char *value) {
    mal_intrinsic_define_data(vm, object, (const byte *) name,
        os_uname_field(vm, value != nullptr ? value : ""),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

static MalValue os_user_info(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    struct passwd *entry = getpwuid(geteuid());
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalObject *object = mal_value_to_object(result);
    os_user_info_string(vm, object, "username", entry != nullptr ? entry->pw_name : "");
    os_user_info_string(vm, object, "homedir", entry != nullptr ? entry->pw_dir : "");
    os_user_info_string(vm, object, "shell", entry != nullptr ? entry->pw_shell : "");
    u32 flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, object, (const byte *) "uid",
        mal_value_from_i32((i32) geteuid()), flags);
    mal_intrinsic_define_data(vm, object, (const byte *) "gid",
        mal_value_from_i32((i32) getegid()), flags);
    mal_gc_unroot(&root);
    return result;
}

static MalValue os_homedir(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    const char *directory = getenv("HOME");
    if (directory == nullptr || directory[0] == '\0') {
        struct passwd *entry = getpwuid(geteuid());
        directory = entry != nullptr ? entry->pw_dir : "";
    }
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) directory, strlen(directory)));
}

static MalValue os_endianness(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    const u16 marker = 1;
    const char *result = *(const byte *) &marker == 1 ? "LE" : "BE";
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) result, 2));
}

static MalValue os_arch(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *machine = uname(&info) == 0 ? info.machine : "unknown";
    const char *arch = machine;
    if (strcmp(machine, "x86_64") == 0 || strcmp(machine, "amd64") == 0) {
        arch = "x64";
    } else if (strcmp(machine, "aarch64") == 0 || strcmp(machine, "arm64") == 0) {
        arch = "arm64";
    } else if (strcmp(machine, "i386") == 0 || strcmp(machine, "i486") == 0
               || strcmp(machine, "i586") == 0 || strcmp(machine, "i686") == 0) {
        arch = "ia32";
    } else if (strncmp(machine, "arm", 3) == 0) {
        arch = "arm";
    }
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) arch, strlen(arch)));
}

static MalValue os_platform(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    struct utsname info;
    const char *system = uname(&info) == 0 ? info.sysname : "unknown";
    usize length = strlen(system);
    byte *lower = malloc(length == 0 ? 1 : length);
    if (lower == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Platform string allocation failed");
        return mal_value_new_undefined();
    }
    for (usize i = 0; i < length; i++) lower[i] = (byte) tolower((u8) system[i]);
    MalValue result = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, lower, length));
    free(lower);
    return result;
}

static MalValue os_tmpdir(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    static const char *names[] = {"TMPDIR", "TMP", "TEMP"};
    const char *directory = nullptr;
    for (usize i = 0; i < countof(names); i++) {
        const char *candidate = getenv(names[i]);
        if (candidate != nullptr && candidate[0] != '\0') {
            directory = candidate;
            break;
        }
    }
    if (directory == nullptr) directory = "/tmp";
    usize length = strlen(directory);
    while (length > 1 && directory[length - 1] == '/') length--;
    return mal_value_from_string(mal_string_new_ascii(
        &vm->heap, (const byte *) directory, length));
}

static long os_parallelism(void) {
    long count = sysconf(_SC_NPROCESSORS_ONLN);
    return count > 0 ? count : 1;
}

static MalValue os_available_parallelism(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    long count = os_parallelism();
    return mal_value_from_i32(count > INT32_MAX ? INT32_MAX : (i32) count);
}

static MalValue os_cpus(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    long parallelism = os_parallelism();
    u32 count = parallelism > UINT32_MAX ? UINT32_MAX : (u32) parallelism;
    MalValue roots[] = {
        mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, count)),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    struct utsname info;
    const char *model = uname(&info) == 0 ? info.machine : "unknown";
    for (u32 i = 0; i < count; i++) {
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[1]), (const byte *) "model",
            mal_value_from_string(mal_string_new_ascii(
                &vm->heap, (const byte *) model, strlen(model))),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[1]), (const byte *) "speed",
            mal_value_from_i32(0),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        static const char *time_names[] = {
            "user", "nice", "sys", "idle", "irq",
        };
        for (usize j = 0; j < countof(time_names); j++) {
            mal_intrinsic_define_data(
                vm, mal_value_to_object(roots[2]),
                (const byte *) time_names[j], mal_value_from_i32(0),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE
                    | MAL_PROPERTY_CONFIGURABLE);
        }
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[1]), (const byte *) "times", roots[2],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_array_object_store(
            mal_value_to_array_object(roots[0]), mal_key_index(i), roots[1]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

void mal_host_install_node_os(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "hostname", 0,
            os_hostname);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "homedir", 0,
            os_homedir);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "type", 0, os_type);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "endianness", 0,
            os_endianness);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "arch", 0, os_arch);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "release", 0, os_release);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "platform", 0,
            os_platform);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "tmpdir", 0, os_tmpdir);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "availableParallelism", 0,
            os_available_parallelism);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "cpus", 0, os_cpus);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "machine", 0, os_machine);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "version", 0, os_version);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "freemem", 0, os_freemem);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "totalmem", 0, os_totalmem);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "uptime", 0, os_uptime);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "loadavg", 0, os_loadavg);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "userInfo", 0, os_user_info);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(module), (const byte *) "EOL",
            mal_value_from_string(mal_string_new_ascii(
                &vm->heap, (const byte *) "\n", 1)),
            MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(module), (const byte *) "devNull",
            mal_value_from_string(mal_string_new_ascii(
                &vm->heap, (const byte *) "/dev/null", 9)),
            MAL_PROPERTY_ENUMERABLE);
        vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
