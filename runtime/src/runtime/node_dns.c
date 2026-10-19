// Portions derived from Node.js lib/dns.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_dns.h"

#if MAL_NODE

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/time.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/random.h>
#include <sys/socket.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "async_context.h"
#include "blocking_work.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "host.h"
#include "intrinsics.h"
#include "node_module.h"
#include "microtask.h"
#include "object.h"
#include "posix_fs.h"
#include "builtin_promise.h"
#include "promise_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_host_timer.h"

#define DNS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define DNS_MAX_SERVERS 8

typedef enum NodeDnsOrder {
    NODE_DNS_ORDER_VERBATIM,
    NODE_DNS_ORDER_IPV4_FIRST,
    NODE_DNS_ORDER_IPV6_FIRST,
} NodeDnsOrder;

typedef enum NodeDnsKind {
    NODE_DNS_LOOKUP,
    NODE_DNS_LOOKUP_SERVICE,
    NODE_DNS_REVERSE,
    NODE_DNS_RESOLVE,
    // A DNS query for one record type other than A/AAAA, sent with res_nsend.
    NODE_DNS_QUERY,
} NodeDnsKind;

typedef struct NodeDnsAddress {
    char text[INET6_ADDRSTRLEN];
    int family;
} NodeDnsAddress;

/* Owned by the blocking-work pool between start and the terminal task. */
typedef struct NodeDnsJob {
    NodeDnsKind kind;
    char *host;
    int family;
    int flags;
    int port;
    int status;
    int system_errno;
    NodeDnsAddress *addresses;
    usize address_count;
    char name[NI_MAXHOST];
    char service[NI_MAXSERV];
    int rrtype;
    // Servers from setServers or /etc/resolv.conf, tried in order.
    struct sockaddr_storage servers[DNS_MAX_SERVERS];
    socklen_t server_lengths[DNS_MAX_SERVERS];
    usize server_count;
    u8 *answer;
    int answer_length;
    // c-ares style code for a query that produced no usable response.
    const char *query_error;
} NodeDnsJob;

typedef struct NodeDnsPending {
    struct NodeDnsPending *next;
    MalVm *vm;
    MalHostHandle operation;
    NodeDnsKind kind;
    bool all;
    bool ttl;
    NodeDnsOrder order;
    int family;
    char *syscall;
    char *host;
    MalValue callback;
    MalValue promise;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} NodeDnsPending;

static MAL_ISOLATE_LOCAL NodeDnsPending *dns_pending;
static MAL_ISOLATE_LOCAL bool dns_installed;
static MAL_ISOLATE_LOCAL NodeDnsOrder dns_default_order = NODE_DNS_ORDER_VERBATIM;
static MAL_ISOLATE_LOCAL char *dns_servers[DNS_MAX_SERVERS];
static MAL_ISOLATE_LOCAL int dns_server_ports[DNS_MAX_SERVERS];
static MAL_ISOLATE_LOCAL usize dns_server_count;
static MAL_ISOLATE_LOCAL bool dns_servers_loaded;

static MalValue dns_string(MalVm *vm, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static char *dns_c_string(MalVm *vm, MalValue value) {
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

static void dns_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value, DNS_VISIBLE);
    mal_gc_unroot(&root);
}

static MalValue dns_new_promise(MalVm *vm) {
    MalValue promise, resolve, reject;
    mal_promise_new_direct_capability(vm, &promise, &resolve, &reject);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : promise;
}

static void dns_settle_promise(MalVm *vm, MalValue promise, bool rejected, MalValue value) {
    mal_promise_settle_direct(
        vm, promise, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], rejected, value);
}

static int dns_ip_family(const char *text) {
    unsigned char buffer[sizeof(struct in6_addr)];
    if (inet_pton(AF_INET, text, buffer) == 1) return 4;
    if (inet_pton(AF_INET6, text, buffer) == 1) return 6;
    return 0;
}

/* libuv's UV_EAI_* errno values, which Node reports beside the code. */
static void dns_error_code(int status, int system_errno, const char **code, int *errno_out) {
    switch (status) {
        case EAI_NONAME:
#if defined(EAI_NODATA) && EAI_NODATA != EAI_NONAME
        case EAI_NODATA:
#endif
            *code = "ENOTFOUND";
            *errno_out = status == EAI_NONAME ? -3008 : -3007;
            return;
        case EAI_AGAIN: *code = "EAI_AGAIN"; *errno_out = -3001; return;
        case EAI_BADFLAGS: *code = "EAI_BADFLAGS"; *errno_out = -3002; return;
        case EAI_FAIL: *code = "EAI_FAIL"; *errno_out = -3004; return;
        case EAI_FAMILY: *code = "EAI_FAMILY"; *errno_out = -3005; return;
        case EAI_MEMORY: *code = "EAI_MEMORY"; *errno_out = -3006; return;
        case EAI_SERVICE: *code = "EAI_SERVICE"; *errno_out = -3010; return;
        case EAI_SOCKTYPE: *code = "EAI_SOCKTYPE"; *errno_out = -3011; return;
        case EAI_SYSTEM:
            *code = mal_posix_fs_errno_name(system_errno);
            *errno_out = -system_errno;
            return;
        default: *code = "EAI_FAIL"; *errno_out = -3004; return;
    }
}

/* lib/internal/errors.js DNSException: "<syscall> <code>[ <hostname>]", then own errno
 * (undefined for c-ares codes), code, syscall and a non-empty hostname, in that order. */
static MalValue dns_exception(MalVm *vm, const char *syscall, const char *code, int errno_value,
    const char *hostname) {
    if (hostname != nullptr && hostname[0] == '\0') hostname = nullptr;
    char message[512];
    if (hostname != nullptr) snprintf(message, sizeof message, "%s %s %s", syscall, code, hostname);
    else snprintf(message, sizeof message, "%s %s", syscall, code);
    MalValue error = dns_string(vm, message);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, error);
    error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    if (mal_value_is_object(error)) {
        dns_set(vm, error, "errno", errno_value != 0 ? mal_value_from_i32(errno_value) : mal_value_new_undefined());
        dns_set(vm, error, "code", dns_string(vm, code));
        dns_set(vm, error, "syscall", dns_string(vm, syscall));
        if (hostname != nullptr) dns_set(vm, error, "hostname", dns_string(vm, hostname));
    }
    mal_gc_unroot(&root);
    return error;
}

static void dns_job_free(void *data) {
    NodeDnsJob *job = data;
    if (job == nullptr) return;
    free(job->host);
    free(job->addresses);
    free(job->answer);
    free(job);
}

static int dns_af(int family) {
    return family == 4 ? AF_INET : family == 6 ? AF_INET6 : AF_UNSPEC;
}

static void dns_job_getaddrinfo(NodeDnsJob *job) {
    struct addrinfo hints = {
        .ai_family = dns_af(job->family),
        .ai_socktype = SOCK_STREAM,
        .ai_flags = job->flags,
    };
    struct addrinfo *resolved = nullptr;
    errno = 0;
    job->status = getaddrinfo(job->host, nullptr, &hints, &resolved);
    job->system_errno = errno;
    if (job->status != 0) return;
    usize count = 0;
    for (struct addrinfo *entry = resolved; entry != nullptr; entry = entry->ai_next) count++;
    job->addresses = calloc(count == 0 ? 1 : count, sizeof *job->addresses);
    if (job->addresses == nullptr) {
        job->status = EAI_MEMORY;
        freeaddrinfo(resolved);
        return;
    }
    for (struct addrinfo *entry = resolved; entry != nullptr; entry = entry->ai_next) {
        NodeDnsAddress *address = &job->addresses[job->address_count];
        const void *source = nullptr;
        if (entry->ai_family == AF_INET) {
            source = &((const struct sockaddr_in *) entry->ai_addr)->sin_addr;
            address->family = 4;
        } else if (entry->ai_family == AF_INET6) {
            source = &((const struct sockaddr_in6 *) entry->ai_addr)->sin6_addr;
            address->family = 6;
        }
        if (source != nullptr
            && inet_ntop(entry->ai_family, source, address->text, sizeof address->text) != nullptr) {
            job->address_count++;
        }
    }
    freeaddrinfo(resolved);
    if (job->address_count == 0) job->status = EAI_NONAME;
}

static void dns_job_getnameinfo(NodeDnsJob *job) {
    struct sockaddr_storage storage = {0};
    socklen_t length;
    if (dns_ip_family(job->host) == 6) {
        struct sockaddr_in6 *address = (struct sockaddr_in6 *) &storage;
        address->sin6_family = AF_INET6;
        address->sin6_port = htons((u16) job->port);
        inet_pton(AF_INET6, job->host, &address->sin6_addr);
        length = sizeof *address;
    } else {
        struct sockaddr_in *address = (struct sockaddr_in *) &storage;
        address->sin_family = AF_INET;
        address->sin_port = htons((u16) job->port);
        inet_pton(AF_INET, job->host, &address->sin_addr);
        length = sizeof *address;
    }
    errno = 0;
    job->status = getnameinfo((const struct sockaddr *) &storage, length,
        job->name, sizeof job->name, job->kind == NODE_DNS_REVERSE ? nullptr : job->service,
        job->kind == NODE_DNS_REVERSE ? 0 : sizeof job->service,
        job->kind == NODE_DNS_REVERSE ? NI_NAMEREQD : 0);
    job->system_errno = errno;
}

static void dns_load_servers(void);

#define DNS_ANSWER_CAPACITY 65536
#define DNS_QUERY_CAPACITY 512
// c-ares defaults that Node keeps: a 2 s attempt timeout and 4 tries per server.
#define DNS_ATTEMPT_TIMEOUT_MS 2000
#define DNS_TRIES 4

/* ares_query's message: one question with RD set, no EDNS. Names use presentation
 * form, so "\." and "\DDD" escapes become label bytes. Returns 0 for EBADNAME. */
static int dns_build_query(const char *name, int type, u16 id, u8 *out) {
    u8 header[] = {(u8) (id >> 8), (u8) id, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0};
    memcpy(out, header, sizeof header);
    usize used = sizeof header;
    usize label_start = used++;
    out[label_start] = 0;
    for (const char *c = name; *c != '\0'; c++) {
        u8 value = (u8) *c;
        if (value == '.') {
            if (out[label_start] == 0) {
                if (c[1] != '\0' || c != name) return 0;
                break;
            }
            if (c[1] == '\0') break;
            label_start = used++;
            out[label_start] = 0;
            continue;
        }
        if (value == '\\' && c[1] != '\0') {
            if (c[1] >= '0' && c[1] <= '9' && c[2] >= '0' && c[2] <= '9' && c[3] >= '0' && c[3] <= '9') {
                int code = (c[1] - '0') * 100 + (c[2] - '0') * 10 + (c[3] - '0');
                if (code > 255) return 0;
                value = (u8) code;
                c += 3;
            } else {
                value = (u8) *++c;
            }
        }
        if (out[label_start] == 63 || used + 6 > DNS_QUERY_CAPACITY || used - sizeof header >= 254) return 0;
        out[used++] = value;
        out[label_start]++;
    }
    if (out[label_start] != 0) out[used++] = 0;
    out[used++] = (u8) (type >> 8);
    out[used++] = (u8) type;
    out[used++] = 0;
    out[used++] = 1;
    return (int) used;
}

static int dns_socket(int family, int type) {
    int fd = socket(family, type, 0);
    if (fd >= 0) fcntl(fd, F_SETFD, FD_CLOEXEC);
    return fd;
}

/* One UDP attempt: the reply with our id, 0 on timeout, -1 with errno on failure. */
static int dns_exchange_udp(const struct sockaddr *server, socklen_t length, const u8 *query, int query_length,
    u8 *answer) {
    int fd = dns_socket(server->sa_family, SOCK_DGRAM);
    if (fd < 0) return -1;
    if (connect(fd, server, length) != 0 || send(fd, query, (usize) query_length, 0) != query_length) {
        int saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    int result = 0;
    for (;;) {
        struct pollfd poller = {.fd = fd, .events = POLLIN};
        int ready = poll(&poller, 1, DNS_ATTEMPT_TIMEOUT_MS);
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) break;
        ssize_t received = recv(fd, answer, DNS_ANSWER_CAPACITY, 0);
        if (received < 0) {
            if (errno == EINTR) continue;
            result = -1;
            break;
        }
        // Connected UDP only accepts the server's datagrams; a stale id is skipped.
        if (received >= 12 && answer[0] == query[0] && answer[1] == query[1]) {
            result = (int) received;
            break;
        }
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}

static bool dns_io_all(int fd, u8 *data, usize length, bool writing) {
    while (length > 0) {
        ssize_t done = writing ? send(fd, data, length, 0) : recv(fd, data, length, 0);
        if (done < 0 && errno == EINTR) continue;
        if (done <= 0) return false;
        data += done;
        length -= (usize) done;
    }
    return true;
}

/* A truncated UDP reply is repeated over TCP, as c-ares does. */
static int dns_exchange_tcp(const struct sockaddr *server, socklen_t length, const u8 *query, int query_length,
    u8 *answer) {
    int fd = dns_socket(server->sa_family, SOCK_STREAM);
    if (fd < 0) return -1;
    struct timeval timeout = {.tv_sec = DNS_ATTEMPT_TIMEOUT_MS / 1000, .tv_usec = 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
    u8 prefix[2] = {(u8) (query_length >> 8), (u8) query_length};
    int result = -1;
    if (connect(fd, server, length) == 0 && dns_io_all(fd, prefix, 2, true)
        && dns_io_all(fd, (u8 *) query, (usize) query_length, true) && dns_io_all(fd, prefix, 2, false)) {
        usize size = (usize) (prefix[0] << 8 | prefix[1]);
        if (size >= 12 && dns_io_all(fd, answer, size, false)) result = (int) size;
    }
    int saved = errno;
    close(fd);
    errno = saved;
    return result;
}

/* ares_query semantics: no search list; SERVFAIL, NOTIMP and REFUSED move on to the
 * next server and are reported when no server does better. */
static void dns_job_query(NodeDnsJob *job) {
    u8 query[DNS_QUERY_CAPACITY];
    u16 id = 0;
    if (getentropy(&id, sizeof id) != 0) id = (u16) ((uintptr_t) job >> 4);
    int query_length = dns_build_query(job->host, job->rrtype, id, query);
    if (query_length == 0) {
        job->query_error = "EBADNAME";
        return;
    }
    job->answer = malloc(DNS_ANSWER_CAPACITY);
    if (job->answer == nullptr) {
        job->query_error = "ENOMEM";
        return;
    }
    if (job->server_count == 0) {
        struct sockaddr_in *loopback = (struct sockaddr_in *) &job->servers[0];
        loopback->sin_family = AF_INET;
        loopback->sin_port = htons(53);
        loopback->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        job->server_lengths[0] = sizeof *loopback;
        job->server_count = 1;
    }
    bool refused = false, failed_rcode = false;
    for (int attempt = 0; attempt < DNS_TRIES; attempt++) {
        bool timed_out = false;
        for (usize i = 0; i < job->server_count; i++) {
            const struct sockaddr *server = (const struct sockaddr *) &job->servers[i];
            errno = 0;
            int length = dns_exchange_udp(server, job->server_lengths[i], query, query_length, job->answer);
            if (length > 0 && (job->answer[2] & 0x02) != 0) {
                length = dns_exchange_tcp(server, job->server_lengths[i], query, query_length, job->answer);
            }
            if (length == 0) timed_out = true;
            if (length < 0) refused = refused || errno == ECONNREFUSED;
            if (length <= 0) continue;
            int rcode = job->answer[3] & 0x0F;
            job->answer_length = length;
            if (rcode != 2 && rcode != 4 && rcode != 5) return;
            failed_rcode = true;
        }
        if (failed_rcode || !timed_out) break;
    }
    if (failed_rcode) return;
    job->answer_length = 0;
    job->query_error = refused ? "ECONNREFUSED" : "ETIMEOUT";
}

static void dns_job_run(void *data) {
    NodeDnsJob *job = data;
    if (job->kind == NODE_DNS_LOOKUP || job->kind == NODE_DNS_RESOLVE) dns_job_getaddrinfo(job);
    else if (job->kind == NODE_DNS_QUERY) dns_job_query(job);
    else dns_job_getnameinfo(job);
}

static void dns_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (NodeDnsPending *state = dns_pending; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->callback);
        mal_gc_mark_value(state->promise);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static void dns_pending_free(NodeDnsPending *state) {
    free(state->syscall);
    free(state->host);
    free(state);
}

static MalValue dns_address_object(MalVm *vm, const NodeDnsAddress *address, bool ttl) {
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, 1);
    dns_set(vm, roots[0], "address", dns_string(vm, address->text));
    if (ttl) dns_set(vm, roots[0], "ttl", mal_value_from_i32(0));
    else dns_set(vm, roots[0], "family", mal_value_from_i32(address->family));
    mal_gc_unroot(&root);
    return roots[0];
}

/* Reorders in place, keeping the resolver's order within each family. */
static void dns_apply_order(NodeDnsJob *job, NodeDnsOrder order) {
    if (order == NODE_DNS_ORDER_VERBATIM || job->address_count < 2) return;
    int first = order == NODE_DNS_ORDER_IPV4_FIRST ? 4 : 6;
    NodeDnsAddress *sorted = malloc(job->address_count * sizeof *sorted);
    if (sorted == nullptr) return;
    usize used = 0;
    for (int pass = 0; pass < 2; pass++) {
        for (usize i = 0; i < job->address_count; i++) {
            if ((job->addresses[i].family == first) == (pass == 0)) sorted[used++] = job->addresses[i];
        }
    }
    memcpy(job->addresses, sorted, job->address_count * sizeof *sorted);
    free(sorted);
}

/* Fills out[0..count) with the callback arguments after the error. */
static i32 dns_success_values(MalVm *vm, NodeDnsPending *state, NodeDnsJob *job, MalValue *out) {
    if (state->kind == NODE_DNS_LOOKUP_SERVICE) {
        out[0] = dns_string(vm, job->name);
        out[1] = dns_string(vm, job->service);
        return 2;
    }
    if (state->kind == NODE_DNS_REVERSE) {
        MalArrayObject *names = mal_intrinsic_new_dense_array(vm, 0);
        out[0] = mal_value_from_array_object(names);
        MalValue name = dns_string(vm, job->name);
        mal_array_object_store(names, mal_key_index(0), name);
        return 1;
    }
    dns_apply_order(job, state->order);
    if (state->kind == NODE_DNS_LOOKUP && !state->all) {
        out[0] = dns_string(vm, job->addresses[0].text);
        out[1] = mal_value_from_i32(job->addresses[0].family);
        return 2;
    }
    MalArrayObject *list = mal_intrinsic_new_dense_array(vm, 0);
    out[0] = mal_value_from_array_object(list);
    u32 index = 0;
    for (usize i = 0; i < job->address_count; i++) {
        if (state->kind == NODE_DNS_RESOLVE && job->addresses[i].family != state->family) continue;
        MalValue item = state->kind == NODE_DNS_RESOLVE && !state->ttl
            ? dns_string(vm, job->addresses[i].text)
            : dns_address_object(vm, &job->addresses[i], state->kind == NODE_DNS_RESOLVE);
        mal_array_object_store(list, mal_key_index(index++), item);
    }
    return 1;
}

enum {
    DNS_T_NS = 2, DNS_T_CNAME = 5, DNS_T_SOA = 6, DNS_T_PTR = 12, DNS_T_MX = 15, DNS_T_TXT = 16,
    DNS_T_SRV = 33, DNS_T_NAPTR = 35, DNS_T_TLSA = 52, DNS_T_CAA = 257,
};
#define DNS_NAME_CAPACITY 1280

static int dns_query_type(MalString *rrtype) {
    static const struct {
        const char *name;
        int type;
    } types[] = {
        {"CAA", DNS_T_CAA}, {"CNAME", DNS_T_CNAME}, {"MX", DNS_T_MX}, {"NAPTR", DNS_T_NAPTR},
        {"NS", DNS_T_NS}, {"PTR", DNS_T_PTR}, {"SOA", DNS_T_SOA}, {"SRV", DNS_T_SRV},
        {"TLSA", DNS_T_TLSA}, {"TXT", DNS_T_TXT},
    };
    for (usize i = 0; i < countof(types); i++) {
        if (mal_string_equals_ascii(rrtype, types[i].name)) return types[i].type;
    }
    return 0;
}

static u16 dns_u16(const u8 *data) {
    return (u16) ((data[0] << 8) | data[1]);
}

static u32 dns_u32(const u8 *data) {
    return ((u32) data[0] << 24) | ((u32) data[1] << 16) | ((u32) data[2] << 8) | data[3];
}

/* Expands a possibly compressed name at *offset into presentation form, escaping like
 * c-ares ('.' and '\\' with a backslash, other unprintable bytes as \DDD). */
static bool dns_read_name(const u8 *message, usize length, usize *offset, char *out) {
    usize position = *offset;
    usize used = 0;
    bool jumped = false;
    for (u32 hops = 0;; hops++) {
        if (position >= length || hops > 128) return false;
        u8 label = message[position];
        if ((label & 0xC0) == 0xC0) {
            if (position + 1 >= length) return false;
            if (!jumped) *offset = position + 2;
            jumped = true;
            position = (usize) ((label & 0x3F) << 8) | message[position + 1];
            continue;
        }
        if ((label & 0xC0) != 0) return false;
        position++;
        if (label == 0) break;
        if (position + label > length) return false;
        if (used > 0) out[used++] = '.';
        for (u32 i = 0; i < label; i++) {
            u8 c = message[position + i];
            if (used + 5 >= DNS_NAME_CAPACITY) return false;
            if (c == '.' || c == '\\') {
                out[used++] = '\\';
                out[used++] = (char) c;
            } else if (c < 0x21 || c > 0x7e) {
                used += (usize) snprintf(out + used, 5, "\\%03u", c);
            } else {
                out[used++] = (char) c;
            }
        }
        position += label;
    }
    if (!jumped) *offset = position;
    out[used] = '\0';
    return true;
}

static MalValue dns_latin1(MalVm *vm, const u8 *bytes, usize length) {
    MalString *string = mal_string_new_latin1_copy(&vm->heap, bytes, length);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static MalValue dns_number(u32 value) {
    return value <= INT32_MAX ? mal_value_from_i32((i32) value) : mal_value_from_f64((f64) value);
}

/* One <character-string>: a length byte and that many bytes. */
static bool dns_character_string(const u8 *rdata, usize rdlength, usize *offset, const u8 **text,
    usize *text_length) {
    if (*offset >= rdlength || *offset + 1 + rdata[*offset] > rdlength) return false;
    *text_length = rdata[*offset];
    *text = rdata + *offset + 1;
    *offset += 1 + *text_length;
    return true;
}

/* Builds one Node result value for an answer record (cares_wrap.cc result shapes). */
static bool dns_record_value(MalVm *vm, const u8 *message, usize length, usize rdata_offset,
    u16 rdlength, int type, MalValue *out) {
    const u8 *rdata = message + rdata_offset;
    char name[DNS_NAME_CAPACITY];
    usize offset = rdata_offset;
    switch (type) {
    case DNS_T_CNAME:
    case DNS_T_NS:
    case DNS_T_PTR:
        if (!dns_read_name(message, length, &offset, name)) return false;
        *out = dns_string(vm, name);
        return true;
    case DNS_T_MX:
        if (rdlength < 3) return false;
        offset += 2;
        if (!dns_read_name(message, length, &offset, name)) return false;
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        dns_set(vm, *out, "exchange", dns_string(vm, name));
        dns_set(vm, *out, "priority", mal_value_from_i32(dns_u16(rdata)));
        dns_set(vm, *out, "type", dns_string(vm, "MX"));
        return true;
    case DNS_T_SRV:
        if (rdlength < 7) return false;
        offset += 6;
        if (!dns_read_name(message, length, &offset, name)) return false;
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        dns_set(vm, *out, "name", dns_string(vm, name));
        dns_set(vm, *out, "port", mal_value_from_i32(dns_u16(rdata + 4)));
        dns_set(vm, *out, "priority", mal_value_from_i32(dns_u16(rdata)));
        dns_set(vm, *out, "weight", mal_value_from_i32(dns_u16(rdata + 2)));
        dns_set(vm, *out, "type", dns_string(vm, "SRV"));
        return true;
    case DNS_T_TXT: {
        *out = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        usize position = 0;
        u32 index = 0;
        while (position < rdlength) {
            const u8 *text;
            usize text_length;
            if (!dns_character_string(rdata, rdlength, &position, &text, &text_length)) return false;
            MalValue chunk = dns_latin1(vm, text, text_length);
            mal_array_object_store(mal_value_to_array_object(*out), mal_key_index(index++), chunk);
        }
        return true;
    }
    case DNS_T_SOA: {
        char hostmaster[DNS_NAME_CAPACITY];
        if (!dns_read_name(message, length, &offset, name)
            || !dns_read_name(message, length, &offset, hostmaster)
            || offset + 20 > rdata_offset + rdlength) {
            return false;
        }
        const u8 *numbers = message + offset;
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        dns_set(vm, *out, "nsname", dns_string(vm, name));
        dns_set(vm, *out, "hostmaster", dns_string(vm, hostmaster));
        dns_set(vm, *out, "serial", dns_number(dns_u32(numbers)));
        dns_set(vm, *out, "refresh", dns_number(dns_u32(numbers + 4)));
        dns_set(vm, *out, "retry", dns_number(dns_u32(numbers + 8)));
        dns_set(vm, *out, "expire", dns_number(dns_u32(numbers + 12)));
        dns_set(vm, *out, "minttl", dns_number(dns_u32(numbers + 16)));
        dns_set(vm, *out, "type", mal_value_new_undefined());
        return true;
    }
    case DNS_T_NAPTR: {
        if (rdlength < 4) return false;
        usize position = 4;
        const u8 *texts[3];
        usize lengths[3];
        for (int i = 0; i < 3; i++) {
            if (!dns_character_string(rdata, rdlength, &position, &texts[i], &lengths[i])) return false;
        }
        offset = rdata_offset + position;
        if (!dns_read_name(message, length, &offset, name)) return false;
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        static const char *const keys[] = {"flags", "service", "regexp"};
        for (int i = 0; i < 3; i++) dns_set(vm, *out, keys[i], dns_latin1(vm, texts[i], lengths[i]));
        dns_set(vm, *out, "replacement", dns_string(vm, name));
        dns_set(vm, *out, "order", mal_value_from_i32(dns_u16(rdata)));
        dns_set(vm, *out, "preference", mal_value_from_i32(dns_u16(rdata + 2)));
        dns_set(vm, *out, "type", mal_value_new_undefined());
        return true;
    }
    case DNS_T_CAA: {
        if (rdlength < 2 || 2u + rdata[1] > rdlength || rdata[1] == 0) return false;
        char tag[256];
        memcpy(tag, rdata + 2, rdata[1]);
        tag[rdata[1]] = '\0';
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        dns_set(vm, *out, "critical", mal_value_from_i32(rdata[0]));
        dns_set(vm, *out, "type", dns_string(vm, "CAA"));
        usize value_offset = 2u + rdata[1];
        dns_set(vm, *out, tag, dns_latin1(vm, rdata + value_offset, rdlength - value_offset));
        return true;
    }
    case DNS_T_TLSA: {
        if (rdlength < 3) return false;
        *out = mal_value_from_object(mal_intrinsic_new_object(vm));
        dns_set(vm, *out, "certUsage", mal_value_from_i32(rdata[0]));
        dns_set(vm, *out, "selector", mal_value_from_i32(rdata[1]));
        dns_set(vm, *out, "match", mal_value_from_i32(rdata[2]));
        MalArrayBufferObject *data = mal_array_buffer_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
            (u32) (rdlength - 3), (u32) (rdlength - 3), false, false);
        if (data == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return true;
        }
        if (rdlength > 3) memcpy(data->data, rdata + 3, rdlength - 3);
        dns_set(vm, *out, "data", mal_value_from_object(&data->object));
        return true;
    }
    default:
        return false;
    }
}

/* Parses a query response into the callback value, or names its c-ares error code. */
static i32 dns_query_values(MalVm *vm, NodeDnsJob *job, MalValue *out, const char **code) {
    const u8 *message = job->answer;
    usize length = (usize) job->answer_length;
    *code = "EBADRESP";
    if (length < 12) return 0;
    switch (message[3] & 0x0F) {
    case 0: break;
    case 1: *code = "EFORMERR"; return 0;
    case 2: *code = "ESERVFAIL"; return 0;
    case 3: *code = "ENOTFOUND"; return 0;
    case 4: *code = "ENOTIMP"; return 0;
    case 5: *code = "EREFUSED"; return 0;
    default: return 0;
    }
    u16 questions = dns_u16(message + 4);
    u16 answers = dns_u16(message + 6);
    usize offset = 12;
    char name[DNS_NAME_CAPACITY];
    for (u16 i = 0; i < questions; i++) {
        if (!dns_read_name(message, length, &offset, name) || offset + 4 > length) return 0;
        offset += 4;
    }
    MalValue roots[] = {mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 found = 0;
    bool ok = true;
    for (u16 i = 0; i < answers && ok; i++) {
        if (!dns_read_name(message, length, &offset, name) || offset + 10 > length) {
            ok = false;
            break;
        }
        int type = dns_u16(message + offset);
        int klass = dns_u16(message + offset + 2);
        u16 rdlength = dns_u16(message + offset + 8);
        offset += 10;
        if (offset + rdlength > length) {
            ok = false;
            break;
        }
        if (type == job->rrtype && klass == 1) {
            ok = dns_record_value(vm, message, length, offset, rdlength, type, &roots[1]);
            if (ok && vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index(found++), roots[1]);
            }
        }
        offset += rdlength;
    }
    i32 count = 0;
    if (ok && found == 0) {
        *code = "ENODATA";
    } else if (ok) {
        *code = nullptr;
        out[0] = job->rrtype == DNS_T_SOA ? roots[1] : roots[0];
        count = 1;
    }
    mal_gc_unroot(&root);
    return count;
}

static void dns_settle(MalVm *vm, MalValue callback, MalValue promise, MalValue error,
    const MalValue *values, i32 count, bool lookup_object) {
    if (mal_value_is_promise_object(promise)) {
        MalValue result = count > 0 ? values[0] : mal_value_new_undefined();
        if (mal_value_is_nil(error) && lookup_object) {
            result = mal_value_from_object(mal_intrinsic_new_object(vm));
            MalRootSpan root;
            mal_gc_root(&root, &result, 1);
            dns_set(vm, result, count > 1 && mal_value_is_string(values[1]) ? "hostname" : "address",
                values[0]);
            dns_set(vm, result, count > 1 && mal_value_is_string(values[1]) ? "service" : "family",
                values[1]);
            mal_gc_unroot(&root);
        }
        dns_settle_promise(vm, promise, !mal_value_is_nil(error), mal_value_is_nil(error) ? result : error);
        return;
    }
    MalValue arguments[3] = {mal_value_is_nil(error) ? mal_value_new_null() : error};
    for (i32 i = 0; i < count && i < 2; i++) arguments[1 + i] = values[i];
    MalRootSpan root;
    mal_gc_root(&root, arguments, countof(arguments));
    mal_vm_call_value(vm, callback, mal_value_new_undefined(), arguments,
        mal_value_is_nil(error) ? 1 + count : 1);
    mal_gc_unroot(&root);
}

static bool dns_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    NodeDnsPending **link = &dns_pending;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    NodeDnsPending *state = *link;
    if (state == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    *link = state->next;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    MalValue roots[] = {state->callback, state->promise, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_async_internal_value((MalHeapHeader *) state->async_context)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, state->async_context);
    NodeDnsJob *job = mal_blocking_work_result_data(task.data);
    i32 count = 0;
    if (state->kind == NODE_DNS_QUERY && task.result != MAL_HOST_TERMINAL_CANCELLED && job != nullptr) {
        const char *code = job->query_error;
        if (code == nullptr) count = dns_query_values(vm, job, roots + 3, &code);
        if (code != nullptr && vm->completion.kind != MAL_COMPLETION_THROW) {
            count = 0;
            roots[2] = dns_exception(vm, state->syscall, code, 0, state->host);
        }
    } else if (task.result == MAL_HOST_TERMINAL_CANCELLED || job == nullptr || job->status != 0) {
        const char *code;
        int errno_value;
        dns_error_code(job == nullptr ? EAI_FAIL : job->status,
            job == nullptr ? 0 : job->system_errno, &code, &errno_value);
        roots[2] = dns_exception(vm, state->syscall, code, errno_value, state->host);
    } else {
        count = dns_success_values(vm, state, job, roots + 3);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[2] = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        count = 0;
    }
    bool lookup_object = (state->kind == NODE_DNS_LOOKUP && !state->all)
        || state->kind == NODE_DNS_LOOKUP_SERVICE;
    dns_pending_free(state);
    dns_settle(vm, roots[0], roots[1], mal_value_is_undefined(roots[2]) ? mal_value_new_null() : roots[2],
        roots + 3, count, lookup_object);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static void dns_install_async(void) {
    if (dns_installed) return;
    mal_gc_register_root_source(dns_scan_roots, nullptr);
    mal_host_register_macrotask_drain(dns_drain, false);
    dns_installed = true;
}

/* Starts `job` and returns the settled-later promise, or undefined for a callback. */
static MalValue dns_start(MalVm *vm, NodeDnsJob *job, NodeDnsPending *state, bool promise) {
    dns_install_async();
    MalValue result = mal_value_new_undefined();
    if (promise) {
        result = dns_new_promise(vm);
        if (mal_value_is_undefined(result)) {
            dns_job_free(job);
            dns_pending_free(state);
            return result;
        }
    }
    state->vm = vm;
    state->promise = result;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    MalBlockingWorkReservation reservation = {0};
    if (mal_host(vm) == nullptr
        || !mal_blocking_work_reserve(mal_host(vm), sizeof *job, &reservation)
        || !mal_blocking_work_start(mal_host(vm), dns_job_run, job, dns_job_free,
            &reservation, &state->operation)) {
        mal_blocking_work_reservation_release(&reservation);
        dns_job_free(job);
        dns_pending_free(state);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "DNS work could not be scheduled", "EAGAIN");
        return mal_value_new_undefined();
    }
    state->next = dns_pending;
    dns_pending = state;
    return result;
}

static MalValue dns_get(MalVm *vm, MalValue object, const char *name, bool *ok) {
    MalValue value = mal_value_new_undefined();
    *ok = mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    return value;
}

static void dns_throw_one_of(MalVm *vm, const char *name, const char *choices, MalValue value) {
    char received[320];
    mal_node_describe_received(vm, value, received, sizeof received);
    // validateOneOf prints the received value as inspect does, not as a type.
    const char *shown = strncmp(received, "type ", 5) == 0 && strchr(received, '(') != nullptr
        ? strchr(received, '(') + 1 : received;
    char message[640];
    snprintf(message, sizeof message, "The %s '%s' must be one of: %s. Received %.*s",
        strchr(name, '.') != nullptr ? "property" : "argument", name, choices,
        shown != received ? (int) (strlen(shown) - 1) : (int) strlen(shown), shown);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
}

static bool dns_family(MalVm *vm, MalValue value, const char *name, int *out) {
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        if (mal_string_equals_ascii(string, "IPv4")) { *out = 4; return true; }
        if (mal_string_equals_ascii(string, "IPv6")) { *out = 6; return true; }
    }
    if (mal_ops_is_number(value)) {
        f64 number = mal_ops_number_as_f64(value);
        if (number == 0 || number == 4 || number == 6) {
            *out = (int) number;
            return true;
        }
    }
    dns_throw_one_of(vm, name, "0, 4, 6", value);
    return false;
}

static bool dns_boolean_option(MalVm *vm, MalValue options, const char *name, bool *out, bool *present) {
    bool ok;
    MalValue value = dns_get(vm, options, name, &ok);
    *present = false;
    if (!ok) return false;
    if (mal_value_is_nil(value)) return true;
    if (!mal_value_is_boolean(value)) {
        char property[32];
        snprintf(property, sizeof property, "options.%s", name);
        mal_node_throw_invalid_arg_type(vm, property, "of type boolean", value);
        return false;
    }
    *out = mal_value_is_truthy(value);
    *present = true;
    return true;
}

static bool dns_order_value(MalVm *vm, MalValue value, const char *name, NodeDnsOrder *out) {
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        if (mal_string_equals_ascii(string, "verbatim")) { *out = NODE_DNS_ORDER_VERBATIM; return true; }
        if (mal_string_equals_ascii(string, "ipv4first")) { *out = NODE_DNS_ORDER_IPV4_FIRST; return true; }
        if (mal_string_equals_ascii(string, "ipv6first")) { *out = NODE_DNS_ORDER_IPV6_FIRST; return true; }
    }
    dns_throw_one_of(vm, name, "'verbatim', 'ipv4first', 'ipv6first'", value);
    return false;
}

/* lib/dns.js lookup: argument parsing, the empty-host and IP-literal shortcuts, then getaddrinfo. */
static MalValue dns_lookup_impl(MalVm *vm, const MalValue *args, i32 argc, bool promise) {
    MalValue hostname = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    int family = 0, flags = 0;
    bool all = false, present;
    NodeDnsOrder order = dns_default_order;
    if (mal_value_is_truthy(hostname) && !mal_value_is_string(hostname)) {
        mal_node_throw_invalid_arg_type(vm, "hostname", "of type string", hostname);
        return mal_value_new_undefined();
    }
    if (!promise && mal_value_is_callable(options)) {
        callback = options;
    } else if (mal_ops_is_number(options)) {
        if (!promise && !mal_value_is_callable(callback)) {
            mal_node_throw_invalid_arg_type(vm, "callback", "of type function", callback);
            return mal_value_new_undefined();
        }
        if (!dns_family(vm, options, "family", &family)) return mal_value_new_undefined();
    } else if (!mal_value_is_undefined(options) && !mal_value_is_object(options)) {
        if (!promise && !mal_value_is_callable(argc == 2 ? options : callback)) {
            mal_node_throw_invalid_arg_type(vm, "callback", "of type function", argc == 2 ? options : callback);
            return mal_value_new_undefined();
        }
        mal_node_throw_invalid_arg_type(vm, "options", "of type object or integer", options);
        return mal_value_new_undefined();
    } else {
        if (!promise && !mal_value_is_callable(callback)) {
            mal_node_throw_invalid_arg_type(vm, "callback", "of type function", callback);
            return mal_value_new_undefined();
        }
        if (mal_value_is_object(options)) {
            bool ok;
            MalValue hints = dns_get(vm, options, "hints", &ok);
            if (!ok) return mal_value_new_undefined();
            if (!mal_value_is_nil(hints)) {
                if (!mal_node_validate_number(vm, hints, "options.hints")) return mal_value_new_undefined();
                flags = (int) mal_ops_number_to_uint32(mal_ops_number_as_f64(hints));
                if ((flags & ~(AI_ADDRCONFIG | AI_ALL | AI_V4MAPPED)) != 0) {
                    char message[96];
                    snprintf(message, sizeof message, "Invalid argument: hints");
                    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
                    return mal_value_new_undefined();
                }
            }
            MalValue family_value = dns_get(vm, options, "family", &ok);
            if (!ok) return mal_value_new_undefined();
            if (!mal_value_is_nil(family_value) && !dns_family(vm, family_value, "options.family", &family)) {
                return mal_value_new_undefined();
            }
            if (!dns_boolean_option(vm, options, "all", &all, &present)) return mal_value_new_undefined();
            bool verbatim;
            if (!dns_boolean_option(vm, options, "verbatim", &verbatim, &present)) return mal_value_new_undefined();
            if (present) order = verbatim ? NODE_DNS_ORDER_VERBATIM : NODE_DNS_ORDER_IPV4_FIRST;
            MalValue order_value = dns_get(vm, options, "order", &ok);
            if (!ok) return mal_value_new_undefined();
            if (!mal_value_is_nil(order_value) && !dns_order_value(vm, order_value, "options.order", &order)) {
                return mal_value_new_undefined();
            }
        }
    }
    if (!mal_value_is_truthy(hostname)) {
        char received[320];
        mal_node_describe_received(vm, hostname, received, sizeof received);
        const char *shown = strncmp(received, "type ", 5) == 0 && strchr(received, '(') != nullptr
            ? strchr(received, '(') + 1 : received;
        char message[400];
        snprintf(message, sizeof message,
            "The argument 'hostname' must be a non-empty string. Received %.*s",
            shown != received ? (int) (strlen(shown) - 1) : (int) strlen(shown), shown);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    NodeDnsPending *state = calloc(1, sizeof *state);
    if (state == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->kind = NODE_DNS_LOOKUP;
    state->all = all;
    state->order = order;
    state->callback = promise ? mal_value_new_undefined() : callback;
    char *host = dns_c_string(vm, hostname);
    if (host == nullptr) {
        free(state);
        return mal_value_new_undefined();
    }
    int literal = dns_ip_family(host);
    if (literal != 0) {
        // Node answers IP literals without the resolver, still asynchronously.
        MalValue roots[] = {callback, mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        i32 count = 2;
        if (all) {
            MalArrayObject *list = mal_intrinsic_new_dense_array(vm, 0);
            roots[2] = mal_value_from_array_object(list);
            NodeDnsAddress address = {.family = literal};
            snprintf(address.text, sizeof address.text, "%s", host);
            mal_array_object_store(list, mal_key_index(0), dns_address_object(vm, &address, false));
            count = 1;
        } else {
            roots[2] = dns_string(vm, host);
            roots[3] = mal_value_from_i32(literal);
        }
        free(host);
        free(state);
        MalValue result = mal_value_new_undefined();
        if (promise) {
            result = dns_new_promise(vm);
            if (!mal_value_is_undefined(result)) {
                roots[1] = result;
                dns_settle(vm, roots[0], roots[1], mal_value_new_null(), roots + 2, count, !all);
            }
        } else {
            MalValue job_args[] = {mal_value_new_null(), roots[2], roots[3]};
            MalValue bound;
            MalValue bind_args[] = {mal_value_new_undefined(), job_args[0], job_args[1], job_args[2]};
            if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "bind"), &bound)
                && mal_value_is_callable(bound)) {
                MalCompletion bound_call = mal_vm_call_value(vm, bound, roots[0], bind_args, 1 + 1 + count);
                if (bound_call.kind == MAL_COMPLETION_NORMAL) {
                    mal_vm_enqueue_reaction_job(vm, bound_call.value, false, mal_value_new_undefined(),
                        mal_value_new_undefined(), mal_value_new_undefined());
                }
            }
            result = mal_value_from_object(mal_intrinsic_new_object(vm));
        }
        mal_gc_unroot(&root);
        return result;
    }
    NodeDnsJob *job = calloc(1, sizeof *job);
    state->syscall = strdup("getaddrinfo");
    state->host = strdup(host);
    if (job == nullptr || state->syscall == nullptr || state->host == nullptr) {
        free(job);
        free(host);
        dns_pending_free(state);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    job->kind = NODE_DNS_LOOKUP;
    job->host = host;
    job->family = family;
    job->flags = flags;
    MalValue started = dns_start(vm, job, state, promise);
    if (promise || vm->completion.kind == MAL_COMPLETION_THROW) return started;
    return mal_value_from_object(mal_intrinsic_new_object(vm));
}

static MalValue dns_lookup(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_lookup_impl(vm, args, argc, false);
}

MalValue mal_node_dns_lookup(MalVm *vm, const MalValue *args, i32 argc) {
    return dns_lookup_impl(vm, args, argc, false);
}

static MalValue dns_promises_lookup(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_lookup_impl(vm, args, argc, true);
}

static MalValue dns_name_info(MalVm *vm, const MalValue *args, i32 argc, NodeDnsKind kind, bool promise) {
    MalValue address = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue callback = mal_value_new_undefined();
    int port = 0;
    if (kind == NODE_DNS_LOOKUP_SERVICE) {
        if (argc < 2) {
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "The \"address\", \"port\", and \"callback\" arguments must be specified",
                "ERR_MISSING_ARGS");
            return mal_value_new_undefined();
        }
        f64 number;
        if (!mal_node_validate_integer(vm, args[1], "port", 0, 65535, &number)) return mal_value_new_undefined();
        port = (int) number;
        callback = argc > 2 ? args[2] : mal_value_new_undefined();
    } else {
        callback = argc > 1 ? args[1] : mal_value_new_undefined();
    }
    if (!mal_value_is_string(address)) {
        mal_node_throw_invalid_arg_type(vm, kind == NODE_DNS_REVERSE ? "ip" : "address", "of type string", address);
        return mal_value_new_undefined();
    }
    if (!promise && !mal_value_is_callable(callback)) {
        mal_node_throw_invalid_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    char *host = dns_c_string(vm, address);
    if (host == nullptr) return mal_value_new_undefined();
    if (dns_ip_family(host) == 0) {
        char message[320];
        snprintf(message, sizeof message, "The argument '%s' is invalid. Received '%s'",
            kind == NODE_DNS_REVERSE ? "ip" : "address", host);
        free(host);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        return mal_value_new_undefined();
    }
    NodeDnsPending *state = calloc(1, sizeof *state);
    NodeDnsJob *job = calloc(1, sizeof *job);
    if (state != nullptr) {
        state->syscall = strdup(kind == NODE_DNS_REVERSE ? "getHostByAddr" : "getnameinfo");
        state->host = strdup(host);
    }
    if (state == nullptr || job == nullptr || state->syscall == nullptr || state->host == nullptr) {
        free(job);
        free(host);
        if (state != nullptr) dns_pending_free(state);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->kind = kind;
    state->callback = promise ? mal_value_new_undefined() : callback;
    job->kind = kind;
    job->host = host;
    job->port = port;
    return dns_start(vm, job, state, promise);
}

static MalValue dns_lookup_service(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_name_info(vm, args, argc, NODE_DNS_LOOKUP_SERVICE, false);
}

static MalValue dns_promises_lookup_service(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_name_info(vm, args, argc, NODE_DNS_LOOKUP_SERVICE, true);
}

static MalValue dns_reverse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_name_info(vm, args, argc, NODE_DNS_REVERSE, false);
}

static MalValue dns_promises_reverse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return dns_name_info(vm, args, argc, NODE_DNS_REVERSE, true);
}

/* Slot 0 of every resolve function names its record type; slot 1 marks the promise API. */
static MalValue dns_resolve_typed(MalVm *vm, MalValue callee, const MalValue *args, i32 argc,
    MalString *rrtype) {
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    bool promise = mal_value_is_truthy(mal_native_function_object_get_slot(function, 1));
    MalValue hostname = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options = mal_value_new_undefined();
    MalValue callback = mal_value_new_undefined();
    if (argc > 1 && mal_value_is_callable(args[argc - 1]) && !promise) {
        callback = args[argc - 1];
        if (argc > 2) options = args[1];
    } else if (argc > 1) {
        options = args[1];
    }
    if (!mal_value_is_string(hostname)) {
        mal_node_throw_invalid_arg_type(vm, "name", "of type string", hostname);
        return mal_value_new_undefined();
    }
    if (!promise && !mal_value_is_callable(callback)) {
        mal_node_throw_invalid_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    bool ttl = false, present;
    if (mal_value_is_object(options) && !dns_boolean_option(vm, options, "ttl", &ttl, &present)) {
        return mal_value_new_undefined();
    }
    int family = mal_string_equals_ascii(rrtype, "A") ? 4 : mal_string_equals_ascii(rrtype, "AAAA") ? 6 : 0;
    int query_type = family == 0 ? dns_query_type(rrtype) : 0;
    char *host = dns_c_string(vm, hostname);
    if (host == nullptr) return mal_value_new_undefined();
    char syscall[32];
    usize type_length = 0;
    byte *type_utf8 = mal_string_to_utf8(rrtype, &type_length);
    snprintf(syscall, sizeof syscall, "query%c%.*s", type_length > 0 ? type_utf8[0] : 'A',
        type_length > 1 ? (int) type_length - 1 : 0, type_length > 1 ? (const char *) type_utf8 + 1 : "");
    for (char *c = syscall + 6; *c != '\0'; c++) {
        if (*c >= 'A' && *c <= 'Z') *c = (char) (*c - 'A' + 'a');
    }
    free(type_utf8);
    NodeDnsPending *state = calloc(1, sizeof *state);
    if (state != nullptr) {
        state->syscall = strdup(syscall);
        state->host = strdup(host);
    }
    if (state == nullptr || state->syscall == nullptr || state->host == nullptr) {
        free(host);
        if (state != nullptr) dns_pending_free(state);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->kind = query_type != 0 ? NODE_DNS_QUERY : NODE_DNS_RESOLVE;
    state->family = family;
    state->ttl = ttl;
    state->callback = promise ? mal_value_new_undefined() : callback;
    if (family == 0 && query_type == 0) {
        // ANY is not queried: most servers refuse it (RFC 8482).
        MalValue roots[] = {callback, mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        roots[2] = dns_exception(vm, state->syscall, "ENOTIMP", 0, state->host);
        free(host);
        dns_pending_free(state);
        MalValue result = mal_value_new_undefined();
        if (promise) {
            result = dns_new_promise(vm);
            if (!mal_value_is_undefined(result)) {
                dns_settle_promise(vm, result, true, roots[2]);
            }
        } else {
            MalValue bound;
            MalValue bind_args[] = {mal_value_new_undefined(), roots[2]};
            if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "bind"), &bound)
                && mal_value_is_callable(bound)) {
                MalCompletion bound_call = mal_vm_call_value(vm, bound, roots[0], bind_args, 2);
                if (bound_call.kind == MAL_COMPLETION_NORMAL) {
                    mal_vm_enqueue_reaction_job(vm, bound_call.value, false, mal_value_new_undefined(),
                        mal_value_new_undefined(), mal_value_new_undefined());
                }
            }
        }
        mal_gc_unroot(&root);
        return result;
    }
    NodeDnsJob *job = calloc(1, sizeof *job);
    if (job == nullptr) {
        free(host);
        dns_pending_free(state);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    job->kind = state->kind;
    job->host = host;
    job->family = family;
    job->rrtype = query_type;
    dns_load_servers();
    for (usize i = 0; i < dns_server_count; i++) {
        struct sockaddr_storage *storage = &job->servers[job->server_count];
        if (dns_ip_family(dns_servers[i]) == 6) {
            struct sockaddr_in6 *server = (struct sockaddr_in6 *) storage;
            server->sin6_family = AF_INET6;
            server->sin6_port = htons((u16) dns_server_ports[i]);
            inet_pton(AF_INET6, dns_servers[i], &server->sin6_addr);
            job->server_lengths[job->server_count] = sizeof *server;
        } else {
            struct sockaddr_in *server = (struct sockaddr_in *) storage;
            server->sin_family = AF_INET;
            server->sin_port = htons((u16) dns_server_ports[i]);
            inet_pton(AF_INET, dns_servers[i], &server->sin_addr);
            job->server_lengths[job->server_count] = sizeof *server;
        }
        job->server_count++;
    }
    MalValue started = dns_start(vm, job, state, promise);
    if (promise || vm->completion.kind == MAL_COMPLETION_THROW) return started;
    return mal_value_new_undefined();
}

static MalValue dns_resolve_fixed(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue type = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return dns_resolve_typed(vm, callee, args, argc, mal_value_to_string(type));
}

/* lib/dns.js and lib/internal/dns/promises.js resolve(): the callback form takes a
 * function in place of rrtype, the promise form defaults an undefined rrtype to 'A'. */
static MalValue dns_resolve(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    bool promise = mal_value_is_truthy(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1));
    MalValue rrtype = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_value_is_string(rrtype)) {
        if ((promise && mal_value_is_undefined(rrtype)) || (!promise && mal_value_is_callable(rrtype))) {
            callback = rrtype;
            rrtype = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "A"));
        } else {
            mal_node_throw_invalid_arg_type(vm, "rrtype", "of type string", rrtype);
            return mal_value_new_undefined();
        }
    }
    MalValue rooted[] = {rrtype, callback};
    MalRootSpan root;
    mal_gc_root(&root, rooted, countof(rooted));
    static const char *const known[] = {"A", "AAAA", "ANY", "CAA", "CNAME", "MX", "NAPTR", "NS",
        "PTR", "SOA", "SRV", "TLSA", "TXT"};
    bool valid = false;
    for (usize i = 0; i < countof(known); i++) {
        if (mal_string_equals_ascii(mal_value_to_string(rooted[0]), known[i])) valid = true;
    }
    MalValue result = mal_value_new_undefined();
    if (!valid) {
        char received[320];
        mal_node_describe_received(vm, rooted[0], received, sizeof received);
        char message[400];
        snprintf(message, sizeof message, "The argument 'rrtype' is invalid. Received %s", received);
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
    } else {
        MalValue shifted[] = {argc > 0 ? args[0] : mal_value_new_undefined(), rooted[1]};
        result = dns_resolve_typed(vm, callee, shifted, promise ? 1 : 2, mal_value_to_string(rooted[0]));
    }
    mal_gc_unroot(&root);
    return result;
}

static void dns_load_servers(void) {
    if (dns_servers_loaded) return;
    dns_servers_loaded = true;
    FILE *file = fopen("/etc/resolv.conf", "r");
    if (file == nullptr) return;
    char line[512];
    while (fgets(line, sizeof line, file) != nullptr && dns_server_count < DNS_MAX_SERVERS) {
        char address[64];
        if (sscanf(line, " nameserver %63s", address) == 1 && dns_ip_family(address) != 0) {
            dns_servers[dns_server_count] = strdup(address);
            dns_server_ports[dns_server_count] = 53;
            if (dns_servers[dns_server_count] != nullptr) dns_server_count++;
        }
    }
    fclose(file);
}

static MalValue dns_get_servers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    dns_load_servers();
    MalArrayObject *list = mal_intrinsic_new_dense_array(vm, 0);
    MalValue result = mal_value_from_array_object(list);
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (usize i = 0; i < dns_server_count; i++) {
        char text[INET6_ADDRSTRLEN + 16];
        bool v6 = dns_ip_family(dns_servers[i]) == 6;
        if (dns_server_ports[i] == 53) snprintf(text, sizeof text, "%s", dns_servers[i]);
        else snprintf(text, sizeof text, v6 ? "[%s]:%d" : "%s:%d", dns_servers[i], dns_server_ports[i]);
        mal_array_object_store(list, mal_key_index((u32) i), dns_string(vm, text));
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue dns_set_servers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue list = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_array_object(list)) {
        mal_node_throw_invalid_arg_type(vm, "servers", "an instance of Array", list);
        return mal_value_new_undefined();
    }
    u32 length = mal_array_object_length(mal_value_to_array_object(list));
    char *parsed[DNS_MAX_SERVERS] = {0};
    int ports[DNS_MAX_SERVERS] = {0};
    usize count = 0;
    for (u32 i = 0; i < length; i++) {
        MalValue item;
        if (!mal_vm_get_property(vm, list, mal_key_index(i), &item)) goto failed;
        char name[32];
        snprintf(name, sizeof name, "servers[%u]", i);
        if (!mal_value_is_string(item)) {
            mal_node_throw_invalid_arg_type(vm, name, "of type string", item);
            goto failed;
        }
        char *text = dns_c_string(vm, item);
        if (text == nullptr) goto failed;
        // "[v6]:port" and "v4:port" carry a port; a bare address uses 53.
        char *address = text;
        int port = 53;
        if (address[0] == '[') {
            address++;
            char *end = strchr(address, ']');
            if (end != nullptr) {
                *end = '\0';
                if (end[1] == ':') port = atoi(end + 2);
            }
        } else if (strchr(address, ':') == strrchr(address, ':') && strchr(address, ':') != nullptr) {
            char *colon = strchr(address, ':');
            *colon = '\0';
            port = atoi(colon + 1);
        }
        if (dns_ip_family(address) == 0) {
            char message[320];
            snprintf(message, sizeof message, "Invalid IP address: %s", text);
            free(text);
            mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_IP_ADDRESS");
            goto failed;
        }
        if (count < DNS_MAX_SERVERS) {
            ports[count] = port;
            parsed[count++] = strdup(address);
        }
        free(text);
    }
    dns_load_servers();
    for (usize i = 0; i < dns_server_count; i++) free(dns_servers[i]);
    for (usize i = 0; i < count; i++) {
        dns_servers[i] = parsed[i];
        dns_server_ports[i] = ports[i];
    }
    dns_server_count = count;
    return mal_value_new_undefined();
failed:
    for (usize i = 0; i < count; i++) free(parsed[i]);
    return mal_value_new_undefined();
}

static MalValue dns_get_default_result_order(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    static const char *const names[] = {"verbatim", "ipv4first", "ipv6first"};
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) names[dns_default_order]));
}

static MalValue dns_set_default_result_order(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    NodeDnsOrder order;
    if (dns_order_value(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "dnsOrder", &order)) {
        dns_default_order = order;
    }
    return mal_value_new_undefined();
}

static MalValue dns_resolver_constructor(
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

static MalValue dns_resolver_cancel(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return mal_value_new_undefined();
}

static void dns_define_function(MalVm *vm, MalObject *target, const char *name, i32 length,
    MalNativeFunctionCallback callback, MalValue slot0, MalValue slot1) {
    MalValue slots[] = {slot0, slot1};
    MalValue function = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, countof(slots)));
    MalRootSpan root;
    mal_gc_root(&root, &function, 1);
    mal_intrinsic_define_data(vm, target, (const byte *) name, function, DNS_VISIBLE);
    mal_gc_unroot(&root);
}

/* Installs the query API shared by the module, Resolver.prototype and their promise forms. */
static void dns_install_queries(MalVm *vm, MalObject *target, bool promise) {
    MalValue flag = mal_value_new_boolean(promise);
    static const struct {
        const char *name;
        const char *type;
    } typed[] = {
        {"resolve4", "A"}, {"resolve6", "AAAA"}, {"resolveAny", "ANY"}, {"resolveCaa", "CAA"},
        {"resolveCname", "CNAME"}, {"resolveMx", "MX"}, {"resolveNaptr", "NAPTR"},
        {"resolveNs", "NS"}, {"resolvePtr", "PTR"}, {"resolveSoa", "SOA"}, {"resolveSrv", "SRV"},
        {"resolveTlsa", "TLSA"}, {"resolveTxt", "TXT"},
    };
    for (usize i = 0; i < countof(typed); i++) {
        dns_define_function(vm, target, typed[i].name, promise ? 2 : 3, dns_resolve_fixed,
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) typed[i].type)), flag);
    }
    dns_define_function(vm, target, "resolve", promise ? 2 : 3, dns_resolve, mal_value_new_undefined(), flag);
    dns_define_function(vm, target, "reverse", promise ? 1 : 2,
        promise ? dns_promises_reverse : dns_reverse, mal_value_new_undefined(), flag);
    dns_define_function(vm, target, "getServers", 0, dns_get_servers, mal_value_new_undefined(), flag);
    dns_define_function(vm, target, "setServers", 1, dns_set_servers, mal_value_new_undefined(), flag);
}

static MalValue dns_build_resolver(MalVm *vm, bool promise) {
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    dns_install_queries(vm, mal_value_to_object(roots[0]), promise);
    dns_define_function(vm, mal_value_to_object(roots[0]), "cancel", 0, dns_resolver_cancel,
        mal_value_new_undefined(), mal_value_new_undefined());
    MalNativeFunctionObject *resolver = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "Resolver"), 0, dns_resolver_constructor);
    mal_native_function_object_set_constructor(resolver);
    roots[1] = mal_value_from_native_function_object(resolver);
    mal_intrinsic_define_data(vm, (MalObject *) resolver, (const byte *) "prototype", roots[0],
        MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return roots[1];
}

/* Fills a module object: the lookup family, the query API, a Resolver and Node's constants. */
static void dns_fill_module(MalVm *vm, MalObject *module, bool promise) {
    dns_define_function(vm, module, "lookup", promise ? 2 : 3,
        promise ? dns_promises_lookup : dns_lookup, mal_value_new_undefined(), mal_value_new_undefined());
    dns_define_function(vm, module, "lookupService", promise ? 2 : 3,
        promise ? dns_promises_lookup_service : dns_lookup_service,
        mal_value_new_undefined(), mal_value_new_undefined());
    dns_define_function(vm, module, "getDefaultResultOrder", 0, dns_get_default_result_order,
        mal_value_new_undefined(), mal_value_new_undefined());
    dns_define_function(vm, module, "setDefaultResultOrder", 1, dns_set_default_result_order,
        mal_value_new_undefined(), mal_value_new_undefined());
    dns_install_queries(vm, module, promise);
    MalValue resolver = dns_build_resolver(vm, promise);
    MalRootSpan root;
    mal_gc_root(&root, &resolver, 1);
    mal_intrinsic_define_data(vm, module, (const byte *) "Resolver", resolver, DNS_VISIBLE);
    mal_gc_unroot(&root);
    static const char *const codes[] = {"NODATA", "FORMERR", "SERVFAIL", "NOTFOUND", "NOTIMP",
        "REFUSED", "BADQUERY", "BADNAME", "BADFAMILY", "BADRESP", "CONNREFUSED", "TIMEOUT", "EOF",
        "FILE", "NOMEM", "DESTRUCTION", "BADSTR", "BADFLAGS", "NONAME", "BADHINTS",
        "NOTINITIALIZED", "LOADIPHLPAPI", "ADDRGETNETWORKPARAMS", "CANCELLED"};
    for (usize i = 0; i < countof(codes); i++) {
        char value[32];
        snprintf(value, sizeof value, "E%s", codes[i]);
        mal_intrinsic_define_data(vm, module, (const byte *) codes[i],
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) value)), DNS_VISIBLE);
    }
    if (!promise) {
        mal_intrinsic_define_data(vm, module, (const byte *) "ADDRCONFIG", mal_value_from_i32(AI_ADDRCONFIG), DNS_VISIBLE);
        mal_intrinsic_define_data(vm, module, (const byte *) "ALL", mal_value_from_i32(AI_ALL), DNS_VISIBLE);
        mal_intrinsic_define_data(vm, module, (const byte *) "V4MAPPED", mal_value_from_i32(AI_V4MAPPED), DNS_VISIBLE);
    }
}

static MalValue dns_promises_module(MalVm *vm) {
    MalValue cached = mal_node_module_get_cached(vm, "node:dns/promises");
    if (!mal_value_is_undefined(cached)) return cached;
    MalValue module = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    dns_fill_module(vm, mal_value_to_object(module), true);
    mal_node_module_publish(vm, "node:dns/promises", nullptr, 0, module);
    mal_gc_unroot(&root);
    return module;
}

void mal_host_install_node_dns(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:dns", slots, count)) return;
    (void) launch;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    dns_fill_module(vm, mal_value_to_object(roots[0]), false);
    roots[1] = dns_promises_module(vm);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "promises", roots[1],
        DNS_VISIBLE);
    mal_node_module_publish(vm, "node:dns", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_dns_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:dns/promises", slots, count)) return;
    MalValue module = dns_promises_module(vm);
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    mal_node_module_publish(vm, "node:dns/promises", slots, count, module);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
