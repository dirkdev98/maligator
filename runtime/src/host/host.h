#pragma once

#include "./defaults.h"
#include "reactor.h"
#include "vm.h"

/*
 * The host context (isolate_todo.md — the "host" layer). Holds the platform
 * services an embedder provides: the I/O reactor now, threads/clock later. It is
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
    struct MalHostTimer *timers;
    i64 timer_next_id;
} MalHost;

/* Create a host context and attach it to the isolate (`vm->host`). */
MalHost *mal_host_attach(MalVm *vm);

/* Detach + tear down the host context (call before mal_vm_free). */
void mal_host_detach(MalVm *vm);

/* The host context of an isolate (null if none attached). */
static inline MalHost *mal_host(MalVm *vm) {
    return (MalHost *) vm->host;
}
