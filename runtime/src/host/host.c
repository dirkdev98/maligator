#include "host.h"

#include <stdlib.h>

static bool mal_host_wake(void *data) {
    return mal_reactor_wake(data);
}

static void mal_host_wake_drain(void *data) {
    (void) mal_host_drain_posted(data);
}

MalHost *mal_host_attach(MalVm *vm) {
    MalHost *host = calloc(1, sizeof(MalHost));
    if (host == nullptr) {
        return nullptr;
    }
    mal_reactor_init(&host->reactor);
    if (host->reactor.backend_fd < 0 || host->reactor.wake_write_fd < 0) {
        mal_reactor_free(&host->reactor);
        free(host);
        return nullptr;
    }
    mal_host_tasks_init(&host->tasks);
    if (!mal_host_posted_tasks_init(
            &host->posted_tasks, mal_host_wake, &host->reactor)) {
        mal_reactor_free(&host->reactor);
        free(host);
        return nullptr;
    }
    mal_reactor_set_waker(
        &host->reactor, (MalWaker) {.fn = mal_host_wake_drain, .data = host});
    host->timers = nullptr;
    host->timer_next_id = 1;
    vm->host = host;
    return host;
}

void mal_host_detach(MalVm *vm) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        return;
    }
    mal_host_shutdown(host);
    mal_reactor_set_waker(&host->reactor, (MalWaker) {0});
    mal_host_posted_tasks_free(&host->posted_tasks);
    mal_host_tasks_free(&host->tasks);
    // The setTimeout task list is runtime state (host_timer.c); the entry frees it
    // before detach, so the host layer keeps no dependency on the runtime layer.
    mal_reactor_free(&host->reactor);
    free(host);
    vm->host = nullptr;
}

bool mal_host_post_progress(
    MalHost *host,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy) {
    return host != nullptr && mal_host_posted_progress(
        &host->posted_tasks, operation, data, destroy);
}

bool mal_host_post_complete(
    MalHost *host,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy) {
    return host != nullptr && mal_host_posted_complete(
        &host->posted_tasks, operation, result, data, destroy);
}

usize mal_host_drain_posted(MalHost *host) {
    return host == nullptr
        ? 0
        : mal_host_posted_drain(&host->posted_tasks, &host->tasks);
}

void mal_host_shutdown(MalHost *host) {
    if (host != nullptr) {
        (void) mal_host_posted_shutdown(&host->posted_tasks, &host->tasks);
    }
}

bool mal_host_has_pending_work(MalHost *host) {
    return host != nullptr &&
        (mal_reactor_has_pending(&host->reactor) ||
            mal_host_posted_pending(&host->posted_tasks) > 0 ||
            mal_host_tasks_pending(&host->tasks) > 0 ||
            mal_host_operations_pending(&host->tasks) > 0);
}
