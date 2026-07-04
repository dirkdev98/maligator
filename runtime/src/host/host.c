#include "host.h"

#include <stdlib.h>

MalHost *mal_host_attach(MalVm *vm) {
    MalHost *host = calloc(1, sizeof(MalHost));
    mal_reactor_init(&host->reactor);
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
    // Only the reactor is the host's to free. The setTimeout task list is runtime
    // state (host_timer.c) — the entry runs mal_host_timers_free before detach — so
    // the host layer keeps no dependency on the runtime layer.
    mal_reactor_free(&host->reactor);
    free(host);
    vm->host = nullptr;
}
