#pragma once

#include "vm.h"

/* Native node:events installer. The compiler references this symbol only when a
 * reached host-module export survives DCE. */
void mal_host_install_node_events(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/**
 * Notification that `receiver`'s listener set changed (added, removed, or
 * cleared wholesale). node:process uses it to keep POSIX signal dispositions in
 * step with its SIGINT / SIGTERM listeners.
 *
 * A native hook rather than a `newListener` / `removeListener` listener: those
 * are ordinary listeners, so `process.removeAllListeners()` would delete the
 * very bookkeeping that has to observe the deletion.
 */
typedef void (*MalNodeEventsChangeHook)(MalVm *vm, MalValue receiver);
void mal_node_events_set_change_hook(MalNodeEventsChangeHook hook);

/** Listener count for `event` on `receiver`; 0 when it holds no emitter state. */
u32 mal_node_events_listener_count(MalVm *vm, MalValue receiver, const char *event);
