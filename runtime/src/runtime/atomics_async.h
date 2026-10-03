#pragma once

#include "vm.h"

/*
 * Event-loop delivery for Atomics.waitAsync. Install once per isolate with a
 * host attached, on its mutator thread. Each pending wait is one list entry:
 * notify from any thread posts it to this isolate's mailbox and wakes the
 * reactor; the timeout is a reactor timer; settlement runs as a macrotask.
 * Isolate teardown (registered runtime cleanup) cancels every pending waiter;
 * in-flight cross-thread posts keep the mailbox alive until they land.
 */
bool mal_atomics_async_install(MalVm *vm);
