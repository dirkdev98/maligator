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

/* Baked images are immutable for the process lifetime; wire images are decoded
 * separately for each isolate because splicing mutates their decoded data. */
typedef struct MalWorkerEntry {
    const char *href;
    const MalRuntimeImage *image;
    const byte *wire;
    usize wire_size;
    // Wire hosts supply their registry; baked images retain only reached installers.
    MalHostInstallerResolver resolve_installer;
} MalWorkerEntry;

typedef struct MalWorkerDomain MalWorkerDomain;

/* Copies names and wire bytes; only baked images and installer functions remain
 * borrowed. A domain is immutable and may be retained across isolate threads. */
MalWorkerDomain *mal_worker_domain_new(
    const MalWorkerEntry *entries, usize count, const char *pool_entry);
void mal_worker_domain_retain(MalWorkerDomain *domain);
void mal_worker_domain_release(MalWorkerDomain *domain);

typedef struct MalWorkerDomainUsage {
    u32 live_domains;
    u64 wire_bytes;
} MalWorkerDomainUsage;

/* Native host diagnostics; fields are sampled independently during activity. */
MalWorkerDomainUsage mal_worker_domain_usage(void);

/* Owner-mutator only, after host attach. Existing descriptors and children retain
 * their original domain when this isolate installs a different generation. */
bool mal_workers_bind_domain(MalVm *vm, MalWorkerDomain *domain);

/* Startup-only default for compiled programs, sealed at the first worker install. */
void mal_workers_register_entries(const MalWorkerEntry *entries, usize count);

/* Startup-only canonical pool helper URL, belonging to the compiled default. */
void mal_workers_set_pool_entry(const char *href);

/* Worker threads in this process not yet joined, including every image domain. */
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

bool mal_workers_is_application(void);
bool mal_workers_application_ready(MalVm *vm);
#if MAL_DEVELOPMENT_API
void mal_workers_install_application_api(MalVm *vm, MalObject *mal);
#endif
