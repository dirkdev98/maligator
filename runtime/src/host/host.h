#pragma once

#include "./defaults.h"
#include "argon2.h"
#include "dns.h"
#include "host_task.h"
#include "reactor.h"
#include "vm.h"

/*
 * The host context (the "host" layer in docs/roadmaps/isolate-reactor.md). Holds
 * the platform services an embedder provides: the I/O reactor now, threads/clock later. It is
 * attached to an isolate via `vm->host` (an opaque `void *` on the engine side, so
 * the engine has no host/reactor type dependency), letting host-layer code and
 * runtime native functions reach platform services from just a `MalVm *`.
 *
 * (For now it also carries the setTimeout task list, which is really *runtime*
 * state; splitting a distinct runtime context out is a later increment. Pre-1.0,
 * AGENTS.md: interfaces may change.)
 */
typedef struct MalHost {
    MalReactor reactor;
    MalHostTasks tasks;
    MalHostPostedTasks posted_tasks;
    MalDns dns;
    MalArgon2 argon2;
    struct MalHttpClient *http_clients;
    struct MalTcpConnection *tcp_connections;
    struct MalHostTimer *timers;
    struct MalHostTimer *timers_tail;
    struct MalHostTimer *ready_timers;
    struct MalHostTimer *ready_timers_tail;
    struct MalNodeHttpRequestState *ready_http_requests;
    struct MalNodeHttpRequestState *ready_http_requests_tail;
    usize pending_http_completions;
    i64 timer_next_id;

    /** Runtime-owned external assets installed for in-process development tests. */
    void *development_assets;
    void (*development_assets_free)(void *assets);
} MalHost;

/* Standalone lifecycle for embedders and host-only tests. */
bool mal_host_init(MalHost *host);
void mal_host_free(MalHost *host);

/* Create a host context and attach it to the isolate (`vm->host`). */
MalHost *mal_host_attach(MalVm *vm);

/* Detach + tear down the host context (call before mal_vm_free). */
void mal_host_detach(MalVm *vm);

/* Cross-thread completion path. Payloads are host-owned plain C data, never VM
 * values. These calls only transfer queue batches; runtime dispatch stays above. */
bool mal_host_post_progress(
    MalHost *host,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy);
bool mal_host_post_complete(
    MalHost *host,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy);
usize mal_host_drain_posted(MalHost *host);
void mal_host_shutdown(MalHost *host);
bool mal_host_has_pending_work(MalHost *host);

/* The host context of an isolate (null if none attached). */
static inline MalHost *mal_host(MalVm *vm) {
    return (MalHost *) vm->host;
}
