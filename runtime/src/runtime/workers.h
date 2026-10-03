#pragma once

#include "vm.h"
#include "vm_load.h"

/*
 * JavaScript worker isolates and MessagePort transport.
 *
 * Each worker is one pinned native thread with its own VM, heap, host reactor and
 * module state. Ports are VM-free native endpoint pairs; messages cross threads
 * only as MalSerializedValue snapshots and are deserialized on the receiving
 * isolate's mutator. No language value is ever reachable from another thread.
 */

/* One statically compiled worker entry. `image` (baked, immutable, process life)
 * or `wire` (copied and loaded fresh per isolate, since splicing mutates it). */
typedef struct MalWorkerEntry {
    const char *href;
    const MalRuntimeImage *image;
    const byte *wire;
    usize wire_size;
    // Wire hosts supply their registry; baked images retain only reached installers.
    MalHostInstallerResolver resolve_installer;
} MalWorkerEntry;

/* Process-wide registry, set once before the first JS runs. The array and its
 * strings/images must stay valid for the process lifetime. */
void mal_workers_register_entries(const MalWorkerEntry *entries, usize count);

/* Canonical file URL of the pool helper entry (`poolEntry`); null when unset. */
void mal_workers_set_pool_entry(const char *href);

/* Worker threads in this process not yet joined. Zero means no isolate can read the
 * registry, so mal_workers_register_entries may replace it. */
u32 mal_workers_live_count(void);

/* maligator:internal/workers native exports (Worker, MessageChannel, MessagePort,
 * receiveMessageOnPort, capabilities, createWorkerUrl, parentPort, workerData,
 * poolEntry). */
void mal_host_install_maligator_internal_workers(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/* Install the calling isolate's worker state on its mutator, after
 * mal_host_attach. Idempotent; the installers call it lazily. */
bool mal_workers_install(MalVm *vm);

/* Terminate and join every worker this isolate started, then close its ports.
 * Call on the owner mutator before host detach / mal_vm_free and before a main
 * isolate returns from main (no worker thread may outlive the process image). */
void mal_workers_shutdown(MalVm *vm);

/* True on a worker isolate's mutator thread. */
bool mal_workers_is_worker(void);
/* Worker thread id of the calling isolate (0 on the main isolate). */
u32 mal_workers_thread_id(void);

/* Worker-local process.exit: record `code`, stop this isolate's loop and leave a
 * pending throw so the current JS unwinds. False on the main isolate. */
bool mal_workers_exit_current(MalVm *vm, int code);

/* MessagePort/WorkerUrl serializer hooks for structuredClone; installs the calling
 * isolate's worker state and returns null if that fails. The table is process-static
 * and sets `validate` (closed/moved listed ports) and `reject` (markAsUncloneable).
 * mal_workers_prepare_commit is mal_serialized_value_validate; mal_serialize_commit
 * revalidates on its own, so callers only need it when user code ran in between. */
typedef struct MalSerializeHooks MalSerializeHooks;
typedef struct MalSerializedValue MalSerializedValue;
const MalSerializeHooks *mal_workers_get_serialize_hooks(MalVm *vm);
bool mal_workers_prepare_commit(MalVm *vm, MalSerializedValue *snapshot, const char **error);

/* After mal_deserialize with these hooks: adopt transferred MessagePorts the value
 * did not reference, so their channels close only when the receiver wrappers are
 * collected rather than at snapshot release. Returns false with a pending throw. */
bool mal_workers_adopt_transferred(MalVm *vm, MalSerializedValue *snapshot);

/* Node markAsUncloneable: later clones of `object` (an object only) throw a
 * DataCloneError in this isolate. Primitives are ignored. */
void mal_workers_mark_uncloneable(MalVm *vm, MalValue object);

/* Node-flavoured surface shared with node:worker_threads. */
MalValue mal_workers_node_worker_constructor(MalVm *vm);
MalValue mal_workers_node_message_channel_constructor(MalVm *vm);
MalValue mal_workers_node_message_port_constructor(MalVm *vm);
MalValue mal_workers_receive_message_function(MalVm *vm);
MalValue mal_workers_parent_port(MalVm *vm);
MalValue mal_workers_worker_data(MalVm *vm);
