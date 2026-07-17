#pragma once

#include "./defaults.h"
#include "host_task.h"

#include <netdb.h>
#include <sys/socket.h>

typedef struct MalHost MalHost;

typedef struct MalDns {
    struct MalDnsState *state;
} MalDns;

typedef enum MalDnsStartResult {
    MAL_DNS_START_OK = 0,
    MAL_DNS_START_INVALID_ARGUMENT,
    MAL_DNS_START_SATURATED,
    MAL_DNS_START_SHUTDOWN,
    MAL_DNS_START_SYSTEM_ERROR,
} MalDnsStartResult;

typedef enum MalDnsErrorKind {
    MAL_DNS_ERROR_NONE = 0,
    MAL_DNS_ERROR_RESOLVER,
    MAL_DNS_ERROR_SYSTEM,
} MalDnsErrorKind;

typedef struct MalDnsError {
    MalDnsErrorKind kind;
    int resolver_code;
    int system_errno;
} MalDnsError;

/* Test/embedding resolver hook. Successful callbacks return a getaddrinfo-style
 * chain that the matching release callback owns. Both callbacks run on workers. */
typedef int (*MalDnsResolver)(
    const char *hostname,
    const char *service,
    const struct addrinfo *hints,
    struct addrinfo **addresses,
    void *data);
typedef void (*MalDnsResolverRelease)(struct addrinfo *addresses, void *data);

typedef struct MalDnsConfig {
    usize worker_count;
    usize queue_capacity;
    MalDnsResolver resolver;
    MalDnsResolverRelease resolver_release;
    void *resolver_data;
} MalDnsConfig;

typedef struct MalDnsResult MalDnsResult;

bool mal_dns_init(MalDns *dns, MalHost *host);
void mal_dns_shutdown(MalDns *dns);
void mal_dns_free(MalDns *dns);

/* Configuration is accepted only before the lazy worker pool has started. A
 * null resolver pair selects the platform getaddrinfo/freeaddrinfo implementation. */
bool mal_dns_configure(MalDns *dns, const MalDnsConfig *config);

/* On MAL_DNS_START_OK, operation receives a live integer handle and exactly one
 * terminal host task will follow. Other returns create no operation. */
MalDnsStartResult mal_dns_start(
    MalHost *host,
    const char *hostname,
    const char *service,
    MalHostHandle *operation);
bool mal_dns_cancel(MalHost *host, MalHostHandle operation);
/** Release worker records after their posted terminal has transferred or lost cancellation. */
void mal_dns_reap_completed(MalDns *dns);

const char *mal_dns_result_hostname(const MalDnsResult *result);
const char *mal_dns_result_service(const MalDnsResult *result);
MalDnsError mal_dns_result_error(const MalDnsResult *result);
usize mal_dns_result_address_count(const MalDnsResult *result);
const struct sockaddr *mal_dns_result_address(
    const MalDnsResult *result, usize index, socklen_t *length);
/* DNS terminal tasks own their result until mal_host_task_release. To retain the
 * payload longer, first use mal_host_task_take_data, then release it here. */
void mal_dns_result_release(MalDnsResult *result);

usize mal_dns_queued(MalDns *dns);
usize mal_dns_workers(MalDns *dns);
bool mal_dns_accepting(MalDns *dns);
