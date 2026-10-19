#include "node_os.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <ctype.h>
#include <dlfcn.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pwd.h>
#include <stdio.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <net/if_dl.h>
#include <sys/sysctl.h>
#elif defined(__linux__)
#include <netpacket/packet.h>
#endif

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "posix_fs.h"
#include "posix_signal.h"
#include "value_ops.h"
#include "vm_ops.h"

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

#define OS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static void os_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value, OS_VISIBLE);
    mal_gc_unroot(&root);
}

static MalValue os_ascii(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) text, strlen(text)));
}

/* lib/internal/errors.js SystemError for a failed uv_os_* call. */
static void os_throw_system_error(MalVm *vm, const char *syscall, int err) {
    const char *code = mal_posix_fs_errno_name(err);
    const char *description = mal_posix_errno_description(err);
    char message[256];
    snprintf(message, sizeof message, "A system error occurred: %s returned %s (%s)",
        syscall, code, description);
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, "ERR_SYSTEM_ERROR");
    MalValue roots[] = {vm->completion.value, mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    os_set(vm, roots[1], "errno", mal_value_from_i32(-err));
    os_set(vm, roots[1], "code", os_ascii(vm, code));
    os_set(vm, roots[1], "message", os_ascii(vm, description));
    os_set(vm, roots[1], "syscall", os_ascii(vm, syscall));
    if (mal_value_is_object(roots[0])) {
        os_set(vm, roots[0], "name", os_ascii(vm, "SystemError"));
        os_set(vm, roots[0], "info", roots[1]);
        os_set(vm, roots[0], "errno", mal_value_from_i32(-err));
        os_set(vm, roots[0], "syscall", os_ascii(vm, syscall));
    }
    mal_gc_unroot(&root);
}

typedef struct OsLink {
    char name[IF_NAMESIZE + 1];
    unsigned char mac[6];
} OsLink;

static bool os_link_address(const struct ifaddrs *entry, OsLink *link) {
    if (entry->ifa_addr == nullptr) return false;
#if defined(__APPLE__)
    if (entry->ifa_addr->sa_family != AF_LINK) return false;
    const struct sockaddr_dl *address = (const struct sockaddr_dl *) entry->ifa_addr;
    memset(link->mac, 0, sizeof link->mac);
    if (address->sdl_alen == 6) memcpy(link->mac, LLADDR(address), 6);
#elif defined(__linux__)
    if (entry->ifa_addr->sa_family != AF_PACKET) return false;
    const struct sockaddr_ll *address = (const struct sockaddr_ll *) entry->ifa_addr;
    memset(link->mac, 0, sizeof link->mac);
    if (address->sll_halen == 6) memcpy(link->mac, address->sll_addr, 6);
#else
    return false;
#endif
    snprintf(link->name, sizeof link->name, "%s", entry->ifa_name);
    return true;
}

static u32 os_prefix_length(const unsigned char *mask, usize length) {
    u32 bits = 0;
    for (usize i = 0; i < length; i++) {
        for (unsigned char byte = mask[i]; byte & 0x80; byte = (unsigned char) (byte << 1)) bits++;
    }
    return bits;
}

/* libuv's uv_interface_addresses: up-and-running interfaces, one entry per IPv4 or IPv6 address. */
static MalValue os_network_interfaces(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) args, (void) argc, (void) nt, (void) callee;
    struct ifaddrs *addresses = nullptr;
    if (getifaddrs(&addresses) != 0) {
        os_throw_system_error(vm, "uv_interface_addresses", errno);
        return mal_value_new_undefined();
    }
    usize link_count = 0;
    for (struct ifaddrs *entry = addresses; entry != nullptr; entry = entry->ifa_next) link_count++;
    OsLink *links = calloc(link_count == 0 ? 1 : link_count, sizeof *links);
    usize links_used = 0;
    for (struct ifaddrs *entry = addresses; links != nullptr && entry != nullptr; entry = entry->ifa_next) {
        if (os_link_address(entry, &links[links_used])) links_used++;
    }
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (struct ifaddrs *entry = addresses; entry != nullptr; entry = entry->ifa_next) {
        if (entry->ifa_addr == nullptr || (entry->ifa_flags & IFF_UP) == 0
            || (entry->ifa_flags & IFF_RUNNING) == 0) {
            continue;
        }
        int family = entry->ifa_addr->sa_family;
        if (family != AF_INET && family != AF_INET6) continue;
        char address[INET6_ADDRSTRLEN] = "", netmask[INET6_ADDRSTRLEN] = "", cidr[INET6_ADDRSTRLEN + 8];
        u32 prefix = 0;
        u32 scope = 0;
        if (family == AF_INET) {
            inet_ntop(AF_INET, &((const struct sockaddr_in *) entry->ifa_addr)->sin_addr, address, sizeof address);
            if (entry->ifa_netmask != nullptr) {
                const struct in_addr *mask = &((const struct sockaddr_in *) entry->ifa_netmask)->sin_addr;
                inet_ntop(AF_INET, mask, netmask, sizeof netmask);
                prefix = os_prefix_length((const unsigned char *) mask, sizeof *mask);
            }
        } else {
            const struct sockaddr_in6 *ip6 = (const struct sockaddr_in6 *) entry->ifa_addr;
            inet_ntop(AF_INET6, &ip6->sin6_addr, address, sizeof address);
            scope = ip6->sin6_scope_id;
            if (entry->ifa_netmask != nullptr) {
                const struct in6_addr *mask = &((const struct sockaddr_in6 *) entry->ifa_netmask)->sin6_addr;
                inet_ntop(AF_INET6, mask, netmask, sizeof netmask);
                prefix = os_prefix_length((const unsigned char *) mask, sizeof *mask);
            }
        }
        snprintf(cidr, sizeof cidr, "%s/%u", address, prefix);
        char mac[18] = "00:00:00:00:00:00";
        for (usize i = 0; i < links_used; i++) {
            if (strcmp(links[i].name, entry->ifa_name) != 0) continue;
            const unsigned char *m = links[i].mac;
            snprintf(mac, sizeof mac, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
            break;
        }
        MalPropertyLookup existing = mal_object_get_own(mal_value_to_object(roots[0]),
            mal_intrinsic_string_key(vm, (const byte *) entry->ifa_name));
        if (existing.present) {
            roots[1] = existing.desc.value;
        } else {
            roots[1] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
            os_set(vm, roots[0], entry->ifa_name, roots[1]);
        }
        roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
        os_set(vm, roots[2], "address", os_ascii(vm, address));
        os_set(vm, roots[2], "netmask", os_ascii(vm, netmask));
        os_set(vm, roots[2], "family", os_ascii(vm, family == AF_INET ? "IPv4" : "IPv6"));
        os_set(vm, roots[2], "mac", os_ascii(vm, mac));
        os_set(vm, roots[2], "internal", mal_value_new_boolean((entry->ifa_flags & IFF_LOOPBACK) != 0));
        os_set(vm, roots[2], "cidr", os_ascii(vm, cidr));
        if (family == AF_INET6) os_set(vm, roots[2], "scopeid", mal_value_from_u32(scope));
        MalArrayObject *list = mal_value_to_array_object(roots[1]);
        mal_array_object_store(list, mal_key_index(mal_array_object_length(list)), roots[2]);
    }
    free(links);
    freeifaddrs(addresses);
    mal_gc_unroot(&root);
    return roots[0];
}

static bool os_pid_argument(MalVm *vm, MalValue value, int *out) {
    if (mal_value_is_undefined(value)) {
        *out = 0;
        return true;
    }
    f64 number;
    if (!mal_node_validate_integer(vm, value, "pid", -2147483648.0, 2147483647.0, &number)) return false;
    *out = (int) number;
    return true;
}

static MalValue os_get_priority(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    int pid;
    if (!os_pid_argument(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &pid)) {
        return mal_value_new_undefined();
    }
    errno = 0;
    int priority = getpriority(PRIO_PROCESS, (id_t) pid);
    if (priority == -1 && errno != 0) {
        os_throw_system_error(vm, "uv_os_getpriority", errno);
        return mal_value_new_undefined();
    }
    return mal_value_from_i32(priority);
}

static MalValue os_set_priority(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self, (void) nt, (void) callee;
    MalValue pid_value = argc > 1 ? args[0] : mal_value_new_undefined();
    MalValue priority_value = argc > 1 ? args[1] : argc > 0 ? args[0] : mal_value_new_undefined();
    int pid;
    f64 priority;
    if (!os_pid_argument(vm, pid_value, &pid)
        || !mal_node_validate_integer(vm, priority_value, "priority", -20, 19, &priority)) {
        return mal_value_new_undefined();
    }
    if (setpriority(PRIO_PROCESS, (id_t) pid, (int) priority) != 0) {
        os_throw_system_error(vm, "uv_os_setpriority", errno);
    }
    return mal_value_new_undefined();
}

/* The errno names os.constants.errno lists, each present only where the platform defines it. */
static const struct {
    const char *name;
    int value;
} os_errno_constants[] = {
#define OS_ERRNO(name) {#name, name},
    OS_ERRNO(E2BIG) OS_ERRNO(EACCES) OS_ERRNO(EADDRINUSE) OS_ERRNO(EADDRNOTAVAIL)
    OS_ERRNO(EAFNOSUPPORT) OS_ERRNO(EAGAIN) OS_ERRNO(EALREADY) OS_ERRNO(EBADF)
    OS_ERRNO(EBADMSG) OS_ERRNO(EBUSY) OS_ERRNO(ECANCELED) OS_ERRNO(ECHILD)
    OS_ERRNO(ECONNABORTED) OS_ERRNO(ECONNREFUSED) OS_ERRNO(ECONNRESET) OS_ERRNO(EDEADLK)
    OS_ERRNO(EDESTADDRREQ) OS_ERRNO(EDOM) OS_ERRNO(EDQUOT) OS_ERRNO(EEXIST) OS_ERRNO(EFAULT)
    OS_ERRNO(EFBIG) OS_ERRNO(EHOSTUNREACH) OS_ERRNO(EIDRM) OS_ERRNO(EILSEQ) OS_ERRNO(EINPROGRESS)
    OS_ERRNO(EINTR) OS_ERRNO(EINVAL) OS_ERRNO(EIO) OS_ERRNO(EISCONN) OS_ERRNO(EISDIR)
    OS_ERRNO(ELOOP) OS_ERRNO(EMFILE) OS_ERRNO(EMLINK) OS_ERRNO(EMSGSIZE)
#ifdef EMULTIHOP
    OS_ERRNO(EMULTIHOP)
#endif
    OS_ERRNO(ENAMETOOLONG) OS_ERRNO(ENETDOWN) OS_ERRNO(ENETRESET) OS_ERRNO(ENETUNREACH)
    OS_ERRNO(ENFILE) OS_ERRNO(ENOBUFS)
#ifdef ENODATA
    OS_ERRNO(ENODATA)
#endif
    OS_ERRNO(ENODEV) OS_ERRNO(ENOENT) OS_ERRNO(ENOEXEC) OS_ERRNO(ENOLCK)
#ifdef ENOLINK
    OS_ERRNO(ENOLINK)
#endif
    OS_ERRNO(ENOMEM) OS_ERRNO(ENOMSG) OS_ERRNO(ENOPROTOOPT) OS_ERRNO(ENOSPC)
#ifdef ENOSR
    OS_ERRNO(ENOSR)
#endif
#ifdef ENOSTR
    OS_ERRNO(ENOSTR)
#endif
    OS_ERRNO(ENOSYS) OS_ERRNO(ENOTCONN) OS_ERRNO(ENOTDIR) OS_ERRNO(ENOTEMPTY) OS_ERRNO(ENOTSOCK)
    OS_ERRNO(ENOTSUP) OS_ERRNO(ENOTTY) OS_ERRNO(ENXIO) OS_ERRNO(EOPNOTSUPP) OS_ERRNO(EOVERFLOW)
    OS_ERRNO(EPERM) OS_ERRNO(EPIPE) OS_ERRNO(EPROTO) OS_ERRNO(EPROTONOSUPPORT) OS_ERRNO(EPROTOTYPE)
    OS_ERRNO(ERANGE) OS_ERRNO(EROFS) OS_ERRNO(ESPIPE) OS_ERRNO(ESRCH) OS_ERRNO(ESTALE)
#ifdef ETIME
    OS_ERRNO(ETIME)
#endif
    OS_ERRNO(ETIMEDOUT) OS_ERRNO(ETXTBSY) OS_ERRNO(EWOULDBLOCK) OS_ERRNO(EXDEV)
#undef OS_ERRNO
};

static MalValue os_constant_table(MalVm *vm, const char *const *names, const int *values, usize count) {
    MalValue table = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &table, 1);
    for (usize i = 0; i < count; i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(table), (const byte *) names[i],
            mal_value_from_i32(values[i]), MAL_PROPERTY_ENUMERABLE);
    }
    mal_gc_unroot(&root);
    return table;
}

static void os_install_constants(MalVm *vm, MalObject *constants) {
    mal_intrinsic_define_data(vm, constants, (const byte *) "UV_UDP_REUSEADDR", mal_value_from_i32(4),
        MAL_PROPERTY_ENUMERABLE);
    static const char *const dlopen_names[] = {"RTLD_LAZY", "RTLD_NOW", "RTLD_GLOBAL", "RTLD_LOCAL"};
    static const int dlopen_values[] = {RTLD_LAZY, RTLD_NOW, RTLD_GLOBAL, RTLD_LOCAL};
    mal_intrinsic_define_data(vm, constants, (const byte *) "dlopen",
        os_constant_table(vm, dlopen_names, dlopen_values, countof(dlopen_names)), MAL_PROPERTY_ENUMERABLE);
    const char *errno_names[countof(os_errno_constants)];
    int errno_values[countof(os_errno_constants)];
    for (usize i = 0; i < countof(os_errno_constants); i++) {
        errno_names[i] = os_errno_constants[i].name;
        errno_values[i] = os_errno_constants[i].value;
    }
    mal_intrinsic_define_data(vm, constants, (const byte *) "errno",
        os_constant_table(vm, errno_names, errno_values, countof(errno_names)), MAL_PROPERTY_ENUMERABLE);
}

static void os_install_priority(MalVm *vm, MalObject *constants) {
    static const char *const names[] = {"PRIORITY_LOW", "PRIORITY_BELOW_NORMAL", "PRIORITY_NORMAL",
        "PRIORITY_ABOVE_NORMAL", "PRIORITY_HIGH", "PRIORITY_HIGHEST"};
    static const int values[] = {19, 10, 0, -7, -14, -20};
    mal_intrinsic_define_data(vm, constants, (const byte *) "priority",
        os_constant_table(vm, names, values, countof(names)), MAL_PROPERTY_ENUMERABLE);
}

void mal_host_install_node_os(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:os", slots, count)) return;
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
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module), (const byte *) "networkInterfaces", 0,
            os_network_interfaces);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module), (const byte *) "getPriority", 1,
            os_get_priority);
        mal_intrinsic_define_method_n(vm, mal_value_to_object(module), (const byte *) "setPriority", 2,
            os_set_priority);
        MalValue constants = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        MalRootSpan constants_root;
        mal_gc_root(&constants_root, &constants, 1);
        os_install_constants(vm, mal_value_to_object(constants));
        MalValue signals = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        MalRootSpan signals_root;
        mal_gc_root(&signals_root, &signals, 1);
        for (i32 i = 0; mal_host_signal_constant_name(i) != nullptr; i++) {
            mal_intrinsic_define_data(vm, mal_value_to_object(signals),
                (const byte *) mal_host_signal_constant_name(i),
                mal_value_from_i32(mal_host_signal_constant_number(i)),
                MAL_PROPERTY_ENUMERABLE);
        }
        mal_intrinsic_define_data(vm, mal_value_to_object(constants),
            (const byte *) "signals", signals, MAL_PROPERTY_ENUMERABLE);
        os_install_priority(vm, mal_value_to_object(constants));
        mal_intrinsic_define_data(vm, mal_value_to_object(module),
            (const byte *) "constants", constants, MAL_PROPERTY_ENUMERABLE);
        mal_gc_unroot(&signals_root);
        mal_gc_unroot(&constants_root);
        vm->intrinsics[MAL_INTRINSIC_NODE_OS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:os", slots, count, module);
}

#endif /* MAL_NODE */
