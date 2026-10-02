#pragma once

#include "vm.h"

typedef enum MalNodeStreamKind {
    STREAM_LEGACY,
    STREAM_READABLE,
    STREAM_WRITABLE,
    STREAM_DUPLEX,
    STREAM_TRANSFORM,
} MalNodeStreamKind;

/* Curated in-memory node:stream installer. */
void mal_host_install_node_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Promise wrappers shared with Stream.promises. */
void mal_host_install_node_stream_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Complete a host-backed readable after its final queued chunk was delivered. */
void mal_node_stream_end_readable(MalVm *vm, MalValue receiver);

// Host producers stop at readable capacity and resume through their _read hook.
i32 mal_node_stream_readable_capacity(MalVm *vm, MalValue receiver);
bool mal_node_stream_push_chunk(MalVm *vm, MalValue receiver, MalValue chunk);
