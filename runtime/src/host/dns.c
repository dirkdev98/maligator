#include "dns.h"

#include "host.h"
#include "net.h"
#include "profile.h"

#include <errno.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#define MAL_DNS_DEFAULT_WORKERS 2
#define MAL_DNS_DEFAULT_QUEUE_CAPACITY 64

typedef struct MalDnsAddress {
    struct sockaddr_storage storage;
    socklen_t length;
} MalDnsAddress;

struct MalDnsResult {
    char *hostname;
    char *service;
    MalDnsError error;
    MalDnsAddress *addresses;
    usize address_count;
};

typedef struct MalDnsRequest {
    struct MalDnsRequest *next;
    struct MalDnsRequest *all_next;
    MalHostHandle operation;
    MalDnsResult *result;
    bool cancelled;
    bool completed;
} MalDnsRequest;

typedef struct MalDnsState {
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    MalHost *host;
    MalDnsRequest *head;
    MalDnsRequest *tail;
    MalDnsRequest *requests;
    pthread_t *threads;
    usize thread_limit;
    usize thread_count;
    usize queue_capacity;
    usize queued;
    MalDnsResolver resolver;
    MalDnsResolverRelease resolver_release;
    void *resolver_data;
    bool pool_started;
    bool accepting;
    bool stopping;
} MalDnsState;

static void mal_dns_remove_request(MalDnsState *state, MalDnsRequest *request) {
    MalDnsRequest **link = &state->requests;
    while (*link != nullptr && *link != request) {
        link = &(*link)->all_next;
    }
    if (*link == request) {
        *link = request->all_next;
    }
}

static bool mal_dns_remove_queued(MalDnsState *state, MalDnsRequest *request) {
    MalDnsRequest *previous = nullptr;
    for (MalDnsRequest *queued = state->head;
        queued != nullptr;
        queued = queued->next) {
        if (queued != request) {
            previous = queued;
            continue;
        }
        if (previous == nullptr) {
            state->head = queued->next;
        } else {
            previous->next = queued->next;
        }
        if (state->tail == queued) {
            state->tail = previous;
        }
        state->queued--;
        mal_dns_remove_request(state, queued);
        return true;
    }
    return false;
}

static char *mal_dns_strdup(const char *value) {
    if (value == nullptr) {
        return nullptr;
    }
    usize length = strlen(value) + 1;
    char *copy = malloc(length);
    if (copy != nullptr) {
        memcpy(copy, value, length);
    }
    return copy;
}

static MalDnsResult *mal_dns_result_new(const char *hostname, const char *service) {
    MalDnsResult *result = calloc(1, sizeof(MalDnsResult));
    if (result == nullptr) {
        return nullptr;
    }
    result->hostname = mal_dns_strdup(hostname);
    result->service = mal_dns_strdup(service);
    if (result->hostname == nullptr || (service != nullptr && result->service == nullptr)) {
        mal_dns_result_release(result);
        return nullptr;
    }
    return result;
}

void mal_dns_result_release(MalDnsResult *result) {
    if (result == nullptr) {
        return;
    }
    free(result->hostname);
    free(result->service);
    free(result->addresses);
    free(result);
}

static void mal_dns_result_destroy(void *data) {
    mal_dns_result_release(data);
}

static int mal_dns_system_resolver(
    const char *hostname,
    const char *service,
    const struct addrinfo *hints,
    struct addrinfo **addresses,
    void *data) {
    (void) data;
    return getaddrinfo(hostname, service, hints, addresses);
}

static void mal_dns_system_resolver_release(struct addrinfo *addresses, void *data) {
    (void) data;
    freeaddrinfo(addresses);
}

static void mal_dns_set_system_error(MalDnsResult *result, int error) {
    result->error = (MalDnsError) {
        .kind = MAL_DNS_ERROR_SYSTEM,
        .system_errno = error,
    };
}

static void mal_dns_resolve(MalDnsState *state, MalDnsResult *result) {
    struct addrinfo hints = {
        .ai_family = AF_UNSPEC,
        .ai_socktype = SOCK_STREAM,
    };
    struct addrinfo *resolved = nullptr;
    errno = 0;
    int resolver_code = state->resolver(
        result->hostname,
        result->service,
        &hints,
        &resolved,
        state->resolver_data);
    int system_errno = errno;
    if (resolver_code != 0) {
        result->error = (MalDnsError) {
            .kind = resolver_code == EAI_SYSTEM
                ? MAL_DNS_ERROR_SYSTEM
                : MAL_DNS_ERROR_RESOLVER,
            .resolver_code = resolver_code,
            .system_errno = resolver_code == EAI_SYSTEM ? system_errno : 0,
        };
        if (resolved != nullptr) {
            state->resolver_release(resolved, state->resolver_data);
        }
        return;
    }

    usize count = 0;
    for (const struct addrinfo *entry = resolved; entry != nullptr; entry = entry->ai_next) {
        if ((entry->ai_family == AF_INET || entry->ai_family == AF_INET6) &&
            entry->ai_addr != nullptr && entry->ai_addrlen <= sizeof(struct sockaddr_storage)) {
            count++;
        }
    }
    if (count == 0) {
        result->error = (MalDnsError) {
            .kind = MAL_DNS_ERROR_RESOLVER,
            .resolver_code = EAI_NONAME,
        };
        state->resolver_release(resolved, state->resolver_data);
        return;
    }
    if (count > SIZE_MAX / sizeof(MalDnsAddress)) {
        mal_dns_set_system_error(result, ENOMEM);
        state->resolver_release(resolved, state->resolver_data);
        return;
    }
    result->addresses = calloc(count, sizeof(MalDnsAddress));
    if (result->addresses == nullptr) {
        mal_dns_set_system_error(result, ENOMEM);
        state->resolver_release(resolved, state->resolver_data);
        return;
    }
    for (const struct addrinfo *entry = resolved; entry != nullptr; entry = entry->ai_next) {
        if ((entry->ai_family != AF_INET && entry->ai_family != AF_INET6) ||
            entry->ai_addr == nullptr ||
            entry->ai_addrlen > sizeof(struct sockaddr_storage)) {
            continue;
        }
        MalDnsAddress *address = &result->addresses[result->address_count++];
        address->length = entry->ai_addrlen;
        memcpy(&address->storage, entry->ai_addr, entry->ai_addrlen);
    }
    state->resolver_release(resolved, state->resolver_data);
}

static void *mal_dns_worker(void *data) {
    MalDnsState *state = data;
    for (;;) {
        pthread_mutex_lock(&state->mutex);
        while (state->head == nullptr && !state->stopping) {
            pthread_cond_wait(&state->ready, &state->mutex);
        }
        if (state->head == nullptr) {
            pthread_mutex_unlock(&state->mutex);
            return nullptr;
        }
        MalDnsRequest *request = state->head;
        state->head = request->next;
        if (state->head == nullptr) {
            state->tail = nullptr;
        }
        state->queued--;
        bool cancelled = request->cancelled;
        pthread_mutex_unlock(&state->mutex);

        MalHostHandle operation = request->operation;
        MalDnsResult *result = request->result;
        MalHostTerminalResult terminal = MAL_HOST_TERMINAL_ERROR;
        if (!cancelled) {
            mal_dns_resolve(state, result);
            terminal = result->error.kind == MAL_DNS_ERROR_NONE
                ? MAL_HOST_TERMINAL_OK
                : MAL_HOST_TERMINAL_ERROR;
        }

        bool posted = !cancelled && mal_host_post_complete(
            state->host, operation, terminal, result, mal_dns_result_destroy);
        if (!posted) {
            mal_dns_result_release(result);
        }

        pthread_mutex_lock(&state->mutex);
        request->result = nullptr;
        if (posted) {
            // The reaper may take a completed request as soon as the operation stops being active.
            request->completed = true;
        } else {
            mal_dns_remove_request(state, request);
        }
        pthread_mutex_unlock(&state->mutex);

        (void) mal_reactor_release_work(&state->host->reactor);
        if (!posted) {
            free(request);
        }
    }
}

static bool mal_dns_start_pool(MalDnsState *state) {
    if (state->pool_started) {
        return state->thread_count > 0;
    }
    state->pool_started = true;
    state->threads = calloc(state->thread_limit, sizeof(pthread_t));
    if (state->threads == nullptr) {
        return false;
    }
#if MAL_PROFILE
    sigset_t blocked, previous;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPROF);
    if (pthread_sigmask(SIG_BLOCK, &blocked, &previous) != 0) {
        free(state->threads);
        state->threads = nullptr;
        return false;
    }
#endif
    for (usize i = 0; i < state->thread_limit; i++) {
        if (pthread_create(&state->threads[state->thread_count], nullptr, mal_dns_worker, state) !=
            0) {
            break;
        }
        state->thread_count++;
    }
    if (state->thread_count > 0) mal_profile_mark_worker_cpu_possible();
#if MAL_PROFILE
    pthread_sigmask(SIG_SETMASK, &previous, nullptr);
#endif
    return state->thread_count > 0;
}

bool mal_dns_init(MalDns *dns, MalHost *host) {
    if (dns == nullptr || host == nullptr) {
        return false;
    }
    dns->state = nullptr;
    MalDnsState *state = calloc(1, sizeof(MalDnsState));
    if (state == nullptr) {
        return false;
    }
    if (pthread_mutex_init(&state->mutex, nullptr) != 0) {
        free(state);
        return false;
    }
    if (pthread_cond_init(&state->ready, nullptr) != 0) {
        pthread_mutex_destroy(&state->mutex);
        free(state);
        return false;
    }
    state->host = host;
    state->thread_limit = MAL_DNS_DEFAULT_WORKERS;
    state->queue_capacity = MAL_DNS_DEFAULT_QUEUE_CAPACITY;
    state->resolver = mal_dns_system_resolver;
    state->resolver_release = mal_dns_system_resolver_release;
    state->accepting = true;
    dns->state = state;
    return true;
}

bool mal_dns_configure(MalDns *dns, const MalDnsConfig *config) {
    if (dns == nullptr || dns->state == nullptr || config == nullptr ||
        config->worker_count == 0 || config->queue_capacity == 0 ||
        ((config->resolver == nullptr) != (config->resolver_release == nullptr))) {
        return false;
    }
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    bool configurable = state->accepting && !state->pool_started && state->queued == 0;
    if (configurable) {
        state->thread_limit = config->worker_count;
        state->queue_capacity = config->queue_capacity;
        state->resolver = config->resolver == nullptr
            ? mal_dns_system_resolver
            : config->resolver;
        state->resolver_release = config->resolver_release == nullptr
            ? mal_dns_system_resolver_release
            : config->resolver_release;
        state->resolver_data = config->resolver_data;
    }
    pthread_mutex_unlock(&state->mutex);
    return configurable;
}

static bool mal_dns_numeric_service(const char *service, u16 *port) {
    if (service == nullptr) {
        *port = 0;
        return true;
    }
    if (service[0] == '\0') {
        return false;
    }
    char *end = nullptr;
    errno = 0;
    unsigned long value = strtoul(service, &end, 10);
    if (errno != 0 || *end != '\0' || value > UINT16_MAX) {
        return false;
    }
    *port = (u16) value;
    return true;
}

static MalDnsResult *mal_dns_literal_result(const char *hostname, const char *service) {
    u16 port;
    if (!mal_dns_numeric_service(service, &port)) {
        return nullptr;
    }
    struct sockaddr_storage address;
    socklen_t length;
    if (!mal_net_parse_ip(hostname, port, &address, &length)) {
        return nullptr;
    }
    MalDnsResult *result = mal_dns_result_new(hostname, service);
    if (result == nullptr) {
        return nullptr;
    }
    result->addresses = calloc(1, sizeof(MalDnsAddress));
    if (result->addresses == nullptr) {
        mal_dns_result_release(result);
        return nullptr;
    }
    result->address_count = 1;
    result->addresses[0].storage = address;
    result->addresses[0].length = length;
    return result;
}

MalDnsStartResult mal_dns_start(
    MalHost *host,
    const char *hostname,
    const char *service,
    MalHostHandle *operation) {
    if (operation != nullptr) {
        *operation = 0;
    }
    if (host == nullptr || hostname == nullptr || hostname[0] == '\0' || operation == nullptr) {
        return MAL_DNS_START_INVALID_ARGUMENT;
    }
    MalDnsState *state = host->dns.state;
    if (state == nullptr) {
        return MAL_DNS_START_SHUTDOWN;
    }

    MalDnsResult *literal = mal_dns_literal_result(hostname, service);
    if (literal != nullptr) {
        pthread_mutex_lock(&state->mutex);
        if (!state->accepting) {
            pthread_mutex_unlock(&state->mutex);
            mal_dns_result_release(literal);
            return MAL_DNS_START_SHUTDOWN;
        }
        bool started = mal_host_operation_start(&host->tasks, operation);
        bool activated = started && mal_host_operation_activate(&host->tasks, *operation);
        bool completed = activated && mal_host_operation_complete(
            &host->tasks,
            *operation,
            MAL_HOST_TERMINAL_OK,
            literal,
            mal_dns_result_destroy);
        pthread_mutex_unlock(&state->mutex);
        if (completed) {
            return MAL_DNS_START_OK;
        }
        if (started && !activated) {
            (void) mal_host_operation_abort_start(&host->tasks, *operation);
        } else if (activated) {
            (void) mal_host_operation_cancel(&host->tasks, *operation);
        }
        *operation = 0;
        mal_dns_result_release(literal);
        return MAL_DNS_START_SYSTEM_ERROR;
    }

    MalDnsResult *result = mal_dns_result_new(hostname, service);
    MalDnsRequest *request = calloc(1, sizeof(MalDnsRequest));
    if (result == nullptr || request == nullptr) {
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SYSTEM_ERROR;
    }
    request->result = result;

    pthread_mutex_lock(&state->mutex);
    if (!state->accepting) {
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SHUTDOWN;
    }
    if (state->queued >= state->queue_capacity) {
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SATURATED;
    }
    if (!mal_dns_start_pool(state)) {
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SYSTEM_ERROR;
    }
    if (!mal_host_operation_start(&host->tasks, operation)) {
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SYSTEM_ERROR;
    }
    if (!mal_reactor_retain_work(&host->reactor)) {
        (void) mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SYSTEM_ERROR;
    }
    if (!mal_host_operation_activate(&host->tasks, *operation)) {
        (void) mal_reactor_release_work(&host->reactor);
        (void) mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        mal_dns_result_release(result);
        free(request);
        return MAL_DNS_START_SYSTEM_ERROR;
    }
    request->operation = *operation;
    if (state->tail == nullptr) {
        state->head = request;
    } else {
        state->tail->next = request;
    }
    state->tail = request;
    request->all_next = state->requests;
    state->requests = request;
    state->queued++;
    pthread_cond_signal(&state->ready);
    pthread_mutex_unlock(&state->mutex);
    return MAL_DNS_START_OK;
}

bool mal_dns_cancel(MalHost *host, MalHostHandle operation) {
    if (host == nullptr || host->dns.state == nullptr) {
        return false;
    }
    MalDnsState *state = host->dns.state;
    pthread_mutex_lock(&state->mutex);
    MalDnsRequest *matched = nullptr;
    bool queued = false;
    for (MalDnsRequest *request = state->requests;
        request != nullptr;
        request = request->all_next) {
        if (request->operation == operation) {
            request->cancelled = true;
            matched = request;
            queued = mal_dns_remove_queued(state, request);
            break;
        }
    }
    pthread_mutex_unlock(&state->mutex);
    if (matched == nullptr) {
        return false;
    }
    bool cancelled = mal_host_operation_cancel(&host->tasks, operation);
    if (queued) {
        mal_dns_result_release(matched->result);
        (void) mal_reactor_release_work(&host->reactor);
        free(matched);
    }
    return cancelled;
}

void mal_dns_reap_completed(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) return;
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    MalDnsRequest **link = &state->requests;
    while (*link != nullptr) {
        MalDnsRequest *request = *link;
        if (!request->completed ||
            mal_host_operation_state(&state->host->tasks, request->operation) ==
                MAL_HOST_OPERATION_ACTIVE) {
            link = &request->all_next;
            continue;
        }
        *link = request->all_next;
        free(request);
    }
    pthread_mutex_unlock(&state->mutex);
}

void mal_dns_shutdown(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) {
        return;
    }
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    state->accepting = false;
    if (state->stopping) {
        pthread_mutex_unlock(&state->mutex);
        return;
    }
    state->stopping = true;
    MalDnsRequest *queued = state->head;
    state->head = nullptr;
    state->tail = nullptr;
    state->queued = 0;
    for (MalDnsRequest *request = queued; request != nullptr; request = request->next) {
        mal_dns_remove_request(state, request);
    }
    for (MalDnsRequest *request = state->requests;
        request != nullptr;
        request = request->all_next) {
        request->cancelled = true;
        (void) mal_host_operation_cancel(&state->host->tasks, request->operation);
    }
    for (MalDnsRequest *request = queued; request != nullptr; request = request->next) {
        request->cancelled = true;
        (void) mal_host_operation_cancel(&state->host->tasks, request->operation);
    }
    usize thread_count = state->thread_count;
    pthread_cond_broadcast(&state->ready);
    pthread_mutex_unlock(&state->mutex);

    while (queued != nullptr) {
        MalDnsRequest *next = queued->next;
        mal_dns_result_release(queued->result);
        (void) mal_reactor_release_work(&state->host->reactor);
        free(queued);
        queued = next;
    }

    for (usize i = 0; i < thread_count; i++) {
        (void) pthread_join(state->threads[i], nullptr);
    }
    pthread_mutex_lock(&state->mutex);
    state->thread_count = 0;
    pthread_mutex_unlock(&state->mutex);
}

void mal_dns_free(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) {
        return;
    }
    mal_dns_shutdown(dns);
    MalDnsState *state = dns->state;
    MalDnsRequest *request = state->requests;
    while (request != nullptr) {
        MalDnsRequest *next = request->all_next;
        mal_dns_result_release(request->result);
        free(request);
        request = next;
    }
    free(state->threads);
    pthread_cond_destroy(&state->ready);
    pthread_mutex_destroy(&state->mutex);
    free(state);
    dns->state = nullptr;
}

const char *mal_dns_result_hostname(const MalDnsResult *result) {
    return result == nullptr ? nullptr : result->hostname;
}

const char *mal_dns_result_service(const MalDnsResult *result) {
    return result == nullptr ? nullptr : result->service;
}

MalDnsError mal_dns_result_error(const MalDnsResult *result) {
    return result == nullptr
        ? (MalDnsError) {.kind = MAL_DNS_ERROR_SYSTEM, .system_errno = EINVAL}
        : result->error;
}

usize mal_dns_result_address_count(const MalDnsResult *result) {
    return result == nullptr ? 0 : result->address_count;
}

const struct sockaddr *mal_dns_result_address(
    const MalDnsResult *result, usize index, socklen_t *length) {
    if (result == nullptr || index >= result->address_count) {
        return nullptr;
    }
    if (length != nullptr) {
        *length = result->addresses[index].length;
    }
    return (const struct sockaddr *) &result->addresses[index].storage;
}

usize mal_dns_queued(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) {
        return 0;
    }
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    usize queued = state->queued;
    pthread_mutex_unlock(&state->mutex);
    return queued;
}

usize mal_dns_workers(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) {
        return 0;
    }
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    usize workers = state->thread_count;
    pthread_mutex_unlock(&state->mutex);
    return workers;
}

bool mal_dns_accepting(MalDns *dns) {
    if (dns == nullptr || dns->state == nullptr) {
        return false;
    }
    MalDnsState *state = dns->state;
    pthread_mutex_lock(&state->mutex);
    bool accepting = state->accepting;
    pthread_mutex_unlock(&state->mutex);
    return accepting;
}
