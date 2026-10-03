#include "workers.h"

#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "ascii.h"
#include "builtin_atomics.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "gc_process.h"
#include "host.h"
#include "intrinsics.h"
#include "node_immediate.h"
#include "object.h"
#include "heap_symbol.h"
#include "object_ops.h"
#include "promise_object.h"
#include "serialize.h"
#include "shared_memory.h"
#include "table.h"
#include "utf8.h"
#include "vm_load.h"
#include "vm_ops.h"
#include "atomics_async.h"
#include "host_registry.h"
#include "personality.h"
#include "web_events_object.h"
#include "web_globals.h"
#include "web_host_timer.h"
#include "web_url_object.h"

#define WORKERS_DEFAULT_MAX_MESSAGES 4096u
#define WORKERS_DEFAULT_MAX_BYTES (64ull << 20)
#define WORKERS_DEFAULT_MAX_MESSAGE_BYTES (16ull << 20)
#define WORKERS_PROCESS_MAX_MESSAGES 65536u
#define WORKERS_PROCESS_MAX_BYTES (512ull << 20)
#define WORKERS_STACK_BYTES (16u << 20)

enum {
    DESCRIPTOR_PORT_PENDING = 0x50505254u,
    DESCRIPTOR_PORT = 0x504f5254u,
    DESCRIPTOR_PORT_STALE = 0x5053544cu,
    DESCRIPTOR_URL = 0x55524c44u,
};

typedef enum WorkerReason { REASON_COMPLETED, REASON_TERMINATED, REASON_ERROR } WorkerReason;
typedef enum PostingPolicy { POST_TRANSACTIONAL, POST_NODE } PostingPolicy;

typedef struct Owner Owner;
typedef struct Channel Channel;

typedef struct Message {
    struct Message *next;
    MalSerializedValue *value;
    u64 bytes;
    // Process-unique; only `sender` may discard the message while it is queued.
    u64 ticket;
    const struct Endpoint *sender;
} Message;

typedef struct Endpoint {
    Channel *channel;
    PostingPolicy posting_policy;
    Message *head;
    Message *tail;
    u32 count;
    u32 reserved_count;
    u64 bytes;
    u32 max_count;
    u64 max_bytes;
    u64 max_message_bytes;
    // Receiving isolate; null while unbound (in transit inside a snapshot).
    Owner *owner;
    // Already linked on owner's ready chain (guarded by owner->mutex).
    bool ready_queued;
    bool close_pending;
    struct Endpoint *ready_next;
} Endpoint;

// Both endpoints share one mutex; a port pair is one ownership unit.
struct Channel {
    _Atomic(u32) refcount;
    pthread_mutex_t mutex;
    bool closed;
    Endpoint side[2];
};

typedef struct WorkerThread WorkerThread;

// Per-isolate mailbox reachable from producers. Producers hold a reference and
// post under `mutex`; teardown clears `reactor` first, after which posts only
// release their references.
struct Owner {
    _Atomic(u32) refcount;
    pthread_mutex_t mutex;
    MalReactor *reactor;
    Endpoint *ready_head;
    Endpoint *ready_tail;
    WorkerThread *events_head;
};

static Endpoint *endpoint_peer(Endpoint *endpoint) {
    Channel *channel = endpoint->channel;
    return endpoint == &channel->side[0] ? &channel->side[1] : &channel->side[0];
}

static void owner_retain(Owner *owner) {
    atomic_fetch_add_explicit(&owner->refcount, 1, memory_order_relaxed);
}

static void owner_release(Owner *owner) {
    if (owner == nullptr) return;
    if (atomic_fetch_sub_explicit(&owner->refcount, 1, memory_order_acq_rel) != 1) return;
    pthread_mutex_destroy(&owner->mutex);
    free(owner);
}

static Owner *owner_new(MalReactor *reactor) {
    Owner *owner = calloc(1, sizeof(Owner));
    if (owner == nullptr) return nullptr;
    atomic_init(&owner->refcount, 1);
    pthread_mutex_init(&owner->mutex, nullptr);
    owner->reactor = reactor;
    return owner;
}

static void channel_retain(Channel *channel) {
    atomic_fetch_add_explicit(&channel->refcount, 1, memory_order_relaxed);
}

// Process-wide bound on user messages across every channel and isolate, on top of each
// endpoint's own limits. A post reserves its slot before serialization runs getters
// and admits its bytes before commit; the Message then holds both until message_free,
// including while the receiver deserializes and dispatches it. Lock-free so producer,
// receiver and teardown threads release without a lock order; never holds JS values.
// Worker lifecycle events and error snapshots use the owner mailbox, not this quota.
static _Atomic(u32) g_process_messages;
static _Atomic(u64) g_process_bytes;

static bool process_reserve_message(void) {
    u32 current = atomic_load_explicit(&g_process_messages, memory_order_relaxed);
    do {
        if (current >= WORKERS_PROCESS_MAX_MESSAGES) return false;
    } while (!atomic_compare_exchange_weak_explicit(
        &g_process_messages, &current, current + 1, memory_order_relaxed, memory_order_relaxed));
    return true;
}

static void process_release_message(void) {
    u32 previous = atomic_fetch_sub_explicit(&g_process_messages, 1, memory_order_relaxed);
    if (previous == 0) abort();
}

// The total never exceeds the cap, so `cap - current` cannot wrap.
static bool process_admit_bytes(u64 bytes) {
    u64 current = atomic_load_explicit(&g_process_bytes, memory_order_relaxed);
    do {
        if (bytes > WORKERS_PROCESS_MAX_BYTES - current) return false;
    } while (!atomic_compare_exchange_weak_explicit(
        &g_process_bytes, &current, current + bytes, memory_order_relaxed, memory_order_relaxed));
    return true;
}

static void process_release_bytes(u64 bytes) {
    u64 previous = atomic_fetch_sub_explicit(&g_process_bytes, bytes, memory_order_relaxed);
    if (previous < bytes) abort();
}

// Every Message is admitted, so freeing it returns its process slot and bytes once.
static void message_free(Message *message) {
    u64 bytes = message->bytes;
    mal_serialized_value_release(message->value);
    free(message);
    process_release_bytes(bytes);
    process_release_message();
}

static void endpoint_drop_queue(Endpoint *endpoint) {
    Message *message = endpoint->head;
    endpoint->head = endpoint->tail = nullptr;
    endpoint->count = 0;
    endpoint->bytes = 0;
    while (message != nullptr) {
        Message *next = message->next;
        message_free(message);
        message = next;
    }
}

static void channel_release(Channel *channel) {
    if (channel == nullptr) return;
    if (atomic_fetch_sub_explicit(&channel->refcount, 1, memory_order_acq_rel) != 1) return;
    for (int i = 0; i < 2; i++) {
        endpoint_drop_queue(&channel->side[i]);
        owner_release(channel->side[i].owner);
    }
    pthread_mutex_destroy(&channel->mutex);
    free(channel);
}

static Channel *channel_new(u32 max_count, u64 max_bytes, u64 max_message_bytes,
    PostingPolicy posting_policy) {
    Channel *channel = calloc(1, sizeof(Channel));
    if (channel == nullptr) return nullptr;
    // One reference per endpoint handle; the endpoint wrappers or snapshot
    // descriptors own them.
    atomic_init(&channel->refcount, 2);
    pthread_mutex_init(&channel->mutex, nullptr);
    for (int i = 0; i < 2; i++) {
        Endpoint *endpoint = &channel->side[i];
        endpoint->channel = channel;
        endpoint->posting_policy = posting_policy;
        endpoint->max_count = max_count;
        endpoint->max_bytes = max_bytes;
        endpoint->max_message_bytes = max_message_bytes;
    }
    return channel;
}

// Caller holds channel->mutex (lock order: channel, then owner).
static void endpoint_notify_locked(Endpoint *endpoint) {
    Owner *owner = endpoint->owner;
    if (owner == nullptr) return;
    pthread_mutex_lock(&owner->mutex);
    if (owner->reactor != nullptr && !endpoint->ready_queued) {
        endpoint->ready_queued = true;
        endpoint->ready_next = nullptr;
        // The ready chain holds a channel reference until the drain pops it.
        channel_retain(endpoint->channel);
        if (owner->ready_tail != nullptr) owner->ready_tail->ready_next = endpoint;
        else owner->ready_head = endpoint;
        owner->ready_tail = endpoint;
        mal_reactor_wake(owner->reactor);
    }
    pthread_mutex_unlock(&owner->mutex);
}

// Bind `endpoint` to an isolate mailbox (or unbind with null) under the channel lock.
static void endpoint_bind(Endpoint *endpoint, Owner *owner) {
    Channel *channel = endpoint->channel;
    pthread_mutex_lock(&channel->mutex);
    Owner *previous = endpoint->owner;
    if (owner != nullptr) owner_retain(owner);
    endpoint->owner = owner;
    if (owner != nullptr && (endpoint->count > 0 || endpoint->close_pending)) {
        endpoint_notify_locked(endpoint);
    }
    pthread_mutex_unlock(&channel->mutex);
    owner_release(previous);
}

static void channel_close(Channel *channel) {
    pthread_mutex_lock(&channel->mutex);
    if (!channel->closed) {
        channel->closed = true;
        for (int i = 0; i < 2; i++) {
            channel->side[i].close_pending = true;
            endpoint_notify_locked(&channel->side[i]);
        }
    }
    pthread_mutex_unlock(&channel->mutex);
}

typedef enum AdmitResult {
    ADMIT_OK, ADMIT_CLOSED, ADMIT_FULL, ADMIT_TOO_LARGE, ADMIT_PROCESS_FULL, ADMIT_PROCESS_BYTES,
} AdmitResult;

// Reserve one endpoint and one process queue slot before serialization runs getters.
// count + reserved_count <= max_count, so the sum cannot wrap.
static AdmitResult endpoint_reserve(Endpoint *receiver) {
    Channel *channel = receiver->channel;
    pthread_mutex_lock(&channel->mutex);
    AdmitResult result = ADMIT_OK;
    if (channel->closed) result = ADMIT_CLOSED;
    else if (receiver->count + receiver->reserved_count >= receiver->max_count) result = ADMIT_FULL;
    else if (!process_reserve_message()) result = ADMIT_PROCESS_FULL;
    else receiver->reserved_count++;
    pthread_mutex_unlock(&channel->mutex);
    return result;
}

static void endpoint_unreserve(Endpoint *receiver) {
    Channel *channel = receiver->channel;
    pthread_mutex_lock(&channel->mutex);
    receiver->reserved_count--;
    pthread_mutex_unlock(&channel->mutex);
    process_release_message();
}

// Byte admission for a reserved slot, after getters and before commit detaches
// anything. A close during the getters is seen here, so the transfer list stays
// attached. On ADMIT_OK the bytes are accounted on both levels; otherwise both slot
// reservations are returned. receiver->bytes <= max_bytes, so the subtraction cannot wrap.
static AdmitResult endpoint_admit_bytes(Endpoint *receiver, u64 bytes) {
    Channel *channel = receiver->channel;
    pthread_mutex_lock(&channel->mutex);
    AdmitResult result = ADMIT_OK;
    if (channel->closed) result = ADMIT_CLOSED;
    else if (bytes > receiver->max_message_bytes) result = ADMIT_TOO_LARGE;
    else if (bytes > receiver->max_bytes - receiver->bytes) result = ADMIT_FULL;
    else if (!process_admit_bytes(bytes)) result = ADMIT_PROCESS_BYTES;
    if (result == ADMIT_OK) receiver->bytes += bytes;
    else receiver->reserved_count--;
    pthread_mutex_unlock(&channel->mutex);
    if (result != ADMIT_OK) process_release_message();
    return result;
}

// Undo a successful admission whose message was never built or committed.
static void endpoint_cancel_admitted(Endpoint *receiver, u64 bytes) {
    Channel *channel = receiver->channel;
    pthread_mutex_lock(&channel->mutex);
    receiver->reserved_count--;
    receiver->bytes -= bytes;
    pthread_mutex_unlock(&channel->mutex);
    process_release_bytes(bytes);
    process_release_message();
}

// Publish an admitted, committed message. A channel closed since admission drops it;
// its transfers are already committed, so the payload is lost with the channel.
static void endpoint_publish(Endpoint *receiver, Message *message) {
    Channel *channel = receiver->channel;
    pthread_mutex_lock(&channel->mutex);
    receiver->reserved_count--;
    if (channel->closed) {
        receiver->bytes -= message->bytes;
        pthread_mutex_unlock(&channel->mutex);
        message_free(message);
        return;
    }
    message->next = nullptr;
    if (receiver->tail != nullptr) receiver->tail->next = message;
    else receiver->head = message;
    receiver->tail = message;
    receiver->count++;
    endpoint_notify_locked(receiver);
    pthread_mutex_unlock(&channel->mutex);
}

static _Atomic(u64) g_next_ticket = 1;

// Remove a still-queued message `sender` posted to `receiver`. A popped (delivered
// or received) message is no longer discardable.
static bool endpoint_discard(Endpoint *receiver, const Endpoint *sender, u64 ticket) {
    Channel *channel = receiver->channel;
    Message *found = nullptr;
    pthread_mutex_lock(&channel->mutex);
    Message *previous = nullptr;
    for (Message *message = receiver->head; message != nullptr; previous = message, message = message->next) {
        if (message->ticket != ticket || message->sender != sender) continue;
        if (previous != nullptr) previous->next = message->next;
        else receiver->head = message->next;
        if (receiver->tail == message) receiver->tail = previous;
        receiver->count--;
        receiver->bytes -= message->bytes;
        found = message;
        break;
    }
    pthread_mutex_unlock(&channel->mutex);
    // Released outside the channel lock: releasing an owned port descriptor closes its channel.
    if (found != nullptr) message_free(found);
    return found != nullptr;
}

// The popped message keeps its process charge until the receiver frees it.
static Message *endpoint_pop(Endpoint *endpoint) {
    Channel *channel = endpoint->channel;
    pthread_mutex_lock(&channel->mutex);
    Message *message = endpoint->head;
    if (message != nullptr) {
        endpoint->head = message->next;
        if (endpoint->head == nullptr) endpoint->tail = nullptr;
        endpoint->count--;
        endpoint->bytes -= message->bytes;
    }
    pthread_mutex_unlock(&channel->mutex);
    return message;
}

static const MalWorkerEntry *g_entries;
static usize g_entry_count;
static const char *g_pool_entry;
static _Atomic(u32) g_live_workers;
static _Atomic(u32) g_next_thread_id = 1;

void mal_workers_register_entries(const MalWorkerEntry *entries, usize count) {
    g_entries = entries;
    g_entry_count = count;
}

u32 mal_workers_live_count(void) {
    return atomic_load_explicit(&g_live_workers, memory_order_acquire);
}

void mal_workers_set_pool_entry(const char *href) {
    g_pool_entry = href;
}

static const MalWorkerEntry *entry_lookup(const char *href) {
    for (usize i = 0; i < g_entry_count; i++) {
        if (strcmp(g_entries[i].href, href) == 0) return &g_entries[i];
    }
    return nullptr;
}

// CPUs this process may use (affinity and cgroup quota), clamped so 4x cannot wrap.
static u32 workers_parallelism(void) {
    usize cpus = mal_gc_process_cpu_capacity();
    return cpus == 0 ? 1 : cpus > 4096 ? 4096 : (u32) cpus;
}

// Process cap on JavaScript threads; each has its own heap and stack.
static u32 workers_max(void) {
    u32 cap = workers_parallelism() * 4;
    return cap < 16 ? 16 : cap > 256 ? 256 : cap;
}

struct WorkerThread {
    _Atomic(u32) refcount;
    u32 id;
    const MalWorkerEntry *entry;
    char *name;
    // The parent's host personality, applied to the worker isolate.
    bool web_platform;
    bool node;
    // Child-side endpoint handle (the worker's parentPort); moved into the thread.
    Endpoint *child_endpoint;
    MalSerializedValue *data;
    MalSharedWaitInterrupt *interrupt;
    pthread_t thread;
    pthread_mutex_t mutex;
    pthread_cond_t start_cond;
    bool start_released;
    bool start_cancelled;
    _Atomic(bool) terminate_requested;
    // The worker isolate's thread-local termination/poll flags while its thread runs
    // (guarded by mutex); terminate() sets them so loops stop at their next poll.
    MalGcTerminationTarget *termination;
    MalGcPollTarget *poll;
    // Worker reactor while its loop can be woken; cleared before it is freed.
    MalReactor *reactor;
    // Parent mailbox; the thread holds one reference until its final post.
    Owner *parent;
    // Event bits posted to the parent (guarded by parent->mutex).
    bool online_pending;
    bool ready_pending;
    bool exit_pending;
    bool event_queued;
    WorkerThread *event_next;
    // Written by the worker thread before its exit post.
    int exit_code;
    WorkerReason reason;
    MalSerializedValue *error;
};

static void worker_thread_release(WorkerThread *thread) {
    if (atomic_fetch_sub_explicit(&thread->refcount, 1, memory_order_acq_rel) != 1) return;
    if (thread->data != nullptr) mal_serialized_value_release(thread->data);
    if (thread->error != nullptr) mal_serialized_value_release(thread->error);
    if (thread->interrupt != nullptr) mal_shared_wait_interrupt_free(thread->interrupt);
    pthread_mutex_destroy(&thread->mutex);
    pthread_cond_destroy(&thread->start_cond);
    free(thread->name);
    free(thread);
}

// Producer side: worker thread -> parent mailbox.
typedef enum ThreadEvent { THREAD_ONLINE, THREAD_READY, THREAD_EXIT } ThreadEvent;

static void worker_post_event(WorkerThread *thread, ThreadEvent event) {
    Owner *owner = thread->parent;
    pthread_mutex_lock(&owner->mutex);
    if (owner->reactor != nullptr) {
        if (event == THREAD_EXIT) thread->exit_pending = true;
        else if (event == THREAD_READY) thread->ready_pending = true;
        else thread->online_pending = true;
        if (!thread->event_queued) {
            thread->event_queued = true;
            atomic_fetch_add_explicit(&thread->refcount, 1, memory_order_relaxed);
            thread->event_next = owner->events_head;
            owner->events_head = thread;
        }
        mal_reactor_wake(owner->reactor);
    }
    pthread_mutex_unlock(&owner->mutex);
}

static void worker_request_terminate(WorkerThread *thread) {
    atomic_store_explicit(&thread->terminate_requested, true, memory_order_release);
    mal_shared_wait_interrupt_signal(thread->interrupt);
    pthread_mutex_lock(&thread->mutex);
    mal_gc_request_termination(thread->termination, thread->poll);
    if (thread->reactor != nullptr) mal_reactor_wake(thread->reactor);
    if (!thread->start_released) {
        thread->start_cancelled = true;
        thread->start_released = true;
        pthread_cond_signal(&thread->start_cond);
    }
    pthread_mutex_unlock(&thread->mutex);
}

// Per-isolate JavaScript state, touched only on this isolate's mutator. Worker and
// fixed values are roots; a port record's values are traced through its wrapper.

typedef enum EventKind { EVENT_MESSAGE, EVENT_MESSAGEERROR, EVENT_CLOSE, EVENT_ONLINE, EVENT_ERROR, EVENT_EXIT, EVENT_OTHER } EventKind;

typedef struct Listener {
    MalValue type;
    MalValue callback;
    bool once;
} Listener;

typedef struct Listeners {
    Listener *items;
    u32 count;
    u32 cap;
} Listeners;

typedef struct PortRecord {
    struct PortRecord *next;
    MalValue wrapper;
    MalValue onmessage;
    MalValue onmessageerror;
    // Node Worker whose emitter receives this port's events (internal port).
    MalValue forward;
    Endpoint *endpoint; // null once closed or transferred away
    PostingPolicy posting_policy;
    Listeners listeners;
    // The isolate's port list plus each pending transfer descriptor (mutator-local).
    u32 refs;
    bool closing;
    bool started;
    bool referenced;
    bool holds_work;
    bool closed_emitted;
} PortRecord;

typedef struct WorkerRecord {
    struct WorkerRecord *next;
    MalValue wrapper;
    MalValue port;
    MalValue ready;
    MalValue closed;
    MalValue terminations;
    WorkerThread *thread;
    Listeners listeners;
    bool node;
    bool referenced;
    bool holds_work;
    bool joined;
    bool online;
    bool ready_settled;
} WorkerRecord;

typedef struct UrlRecord {
    struct UrlRecord *next;
    MalValue descriptor;
    const MalWorkerEntry *entry;
} UrlRecord;

typedef struct Isolate {
    MalVm *vm;
    Owner *owner;
    PortRecord *ports;
    WorkerRecord *workers;
    UrlRecord *urls;
    MalValue port_prototype;
    MalValue node_port_prototype;
    MalValue worker_prototype;
    MalValue node_worker_prototype;
    MalValue port_constructor;
    MalValue channel_constructor;
    MalValue node_port_constructor;
    MalValue node_channel_constructor;
    MalValue worker_constructor;
    MalValue node_worker_constructor;
    MalValue receive_function;
    MalValue capabilities_function;
    MalValue create_url_function;
    MalValue parent_port;
    MalValue worker_data;
    // Private mark set by Node markAsUncloneable; created on first use.
    MalValue uncloneable;
    bool worker_data_ready;
    // Set on a worker isolate.
    WorkerThread *self;
    Endpoint *sending; // endpoint whose postMessage is serializing
} Isolate;

static MAL_ISOLATE_LOCAL Isolate *g_isolate;

static void listeners_mark(const Listeners *listeners) {
    for (u32 i = 0; i < listeners->count; i++) {
        mal_gc_mark_value(listeners->items[i].type);
        mal_gc_mark_value(listeners->items[i].callback);
    }
}

// The loop owns a started port while it is referenced (Node handle semantics) or
// still has a delivery or 'close' to dispatch. An unreferenced idle port lives only
// while JS reaches it; collecting it closes the channel.
static bool port_pinned(const PortRecord *port) {
    if (port->endpoint == nullptr || !port->started) return false;
    if (port->referenced || port->closing) return true;
    Channel *channel = port->endpoint->channel;
    pthread_mutex_lock(&channel->mutex);
    bool pending = port->endpoint->count > 0 || port->endpoint->close_pending;
    pthread_mutex_unlock(&channel->mutex);
    return pending;
}

static void workers_scan_roots(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    Isolate *iso = g_isolate;
    if (iso == nullptr) return;
    MalValue fixed[] = {
        iso->port_prototype, iso->node_port_prototype, iso->worker_prototype, iso->node_worker_prototype,
        iso->port_constructor, iso->channel_constructor, iso->worker_constructor,
        iso->node_port_constructor, iso->node_channel_constructor,
        iso->node_worker_constructor, iso->receive_function, iso->capabilities_function,
        iso->create_url_function, iso->parent_port, iso->worker_data, iso->uncloneable,
    };
    for (usize i = 0; i < countof(fixed); i++) mal_gc_mark_value(fixed[i]);
    for (PortRecord *port = iso->ports; port != nullptr; port = port->next) {
        if (port_pinned(port)) mal_gc_mark_value(port->wrapper);
    }
    for (WorkerRecord *worker = iso->workers; worker != nullptr; worker = worker->next) {
        mal_gc_mark_value(worker->wrapper);
        mal_gc_mark_value(worker->port);
        mal_gc_mark_value(worker->ready);
        mal_gc_mark_value(worker->closed);
        mal_gc_mark_value(worker->terminations);
        listeners_mark(&worker->listeners);
    }
    for (UrlRecord *url = iso->urls; url != nullptr; url = url->next) {
        mal_gc_mark_value(url->descriptor);
    }
}

static MalValue str_value(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text)));
}

static MalKey name_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static bool get_named(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    return mal_vm_get_property(vm, object, name_key(vm, name), out);
}

static char *value_to_cstring(MalValue value) {
    if (!mal_value_is_string(value)) return nullptr;
    usize length = 0;
    byte *bytes = mal_string_to_utf8(mal_value_to_string(value), &length);
    if (bytes == nullptr) return nullptr;
    char *text = malloc(length + 1);
    if (text != nullptr) {
        memcpy(text, bytes, length);
        text[length] = '\0';
    }
    free(bytes);
    return text;
}

static void throw_type(MalVm *vm, const char *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
}

static bool thrown(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

static void port_trace(void *native) {
    PortRecord *port = native;
    mal_gc_mark_value(port->onmessage);
    mal_gc_mark_value(port->onmessageerror);
    mal_gc_mark_value(port->forward);
    listeners_mark(&port->listeners);
}

static void port_record_release(PortRecord *port);

// Owner sweep or teardown, never JS. An unreachable port is unpinned, so it holds no
// loop work; dropping it closes the channel and the peer observes 'close'.
static void port_finalize(void *native) {
    PortRecord *port = native;
    port->wrapper = mal_value_new_undefined();
    if (port->endpoint != nullptr) {
        Endpoint *endpoint = port->endpoint;
        port->endpoint = nullptr;
        endpoint_bind(endpoint, nullptr);
        channel_close(endpoint->channel);
        channel_release(endpoint->channel);
    }
    Isolate *iso = g_isolate;
    if (iso != nullptr) {
        for (PortRecord **link = &iso->ports; *link != nullptr; link = &(*link)->next) {
            if (*link == port) {
                *link = port->next;
                port_record_release(port);
                break;
            }
        }
    }
}

static const MalEventTargetNativeOps g_port_ops = {.trace = port_trace, .finalize = port_finalize};

static PortRecord *port_record(MalValue value) {
    if (!mal_value_is_heap_type(value, MAL_HEAP_EVENT_TARGET_OBJECT)) return nullptr;
    MalEventTargetObject *object = (MalEventTargetObject *) mal_value_to_object(value);
    return object->native_ops == &g_port_ops ? object->native : nullptr;
}

// Detach a record from its live wrapper at isolate teardown; the wrapper stays an
// inert object whose methods reject it as a MessagePort.
static void port_detach_wrapper(PortRecord *port) {
    if (!mal_value_is_object(port->wrapper)) return;
    MalEventTargetObject *object = (MalEventTargetObject *) mal_value_to_object(port->wrapper);
    object->native = nullptr;
    object->native_ops = nullptr;
    port->wrapper = mal_value_new_undefined();
}

// Store a traced edge of a port wrapper (SATB for the old value, card for the new).
static void port_edge_store(PortRecord *port, MalValue *slot, MalValue value) {
    mal_gc_write_barrier(*slot);
    *slot = value;
    if (mal_value_is_object(port->wrapper)) mal_gc_card(&mal_value_to_object(port->wrapper)->header, value);
}

static WorkerRecord *worker_record(MalValue value) {
    if (g_isolate == nullptr || !mal_value_is_object(value)) return nullptr;
    for (WorkerRecord *worker = g_isolate->workers; worker != nullptr; worker = worker->next) {
        if (worker->wrapper == value) return worker;
    }
    return nullptr;
}

static UrlRecord *url_record(MalValue value) {
    if (g_isolate == nullptr || !mal_value_is_object(value)) return nullptr;
    for (UrlRecord *url = g_isolate->urls; url != nullptr; url = url->next) {
        if (url->descriptor == value) return url;
    }
    return nullptr;
}

static MalReactor *isolate_reactor(MalVm *vm) {
    return &mal_host(vm)->reactor;
}

// A started, referenced, open port keeps the owning loop alive (Node semantics).
static void port_update_work(MalVm *vm, PortRecord *port) {
    bool want = port->endpoint != nullptr && port->started && port->referenced;
    if (want == port->holds_work) return;
    port->holds_work = want;
    if (want) mal_reactor_retain_work(isolate_reactor(vm));
    else mal_reactor_release_work(isolate_reactor(vm));
}

static void worker_update_work(MalVm *vm, WorkerRecord *worker) {
    bool want = !worker->joined && worker->referenced;
    if (want == worker->holds_work) return;
    worker->holds_work = want;
    if (want) mal_reactor_retain_work(isolate_reactor(vm));
    else mal_reactor_release_work(isolate_reactor(vm));
}

typedef struct UrlDescriptor {
    char *href;
} UrlDescriptor;

// A transferred MessagePort. While PENDING it retains the sender record and a
// channel reference of its own, so a getter that closes or transfers the port
// cannot free the endpoint; commit moves the endpoint out of the record. PORT owns
// the endpoint until a receiver adopts it. STALE lost its endpoint to a commit
// that skipped validation and is never delivered.
typedef struct PortTransfer {
    Endpoint *endpoint;
    PortRecord *record;
    // Receiver record created by decode, until transferred_ports collects it.
    PortRecord *adopted;
} PortTransfer;

static MalValue url_descriptor_for(MalVm *vm, const MalWorkerEntry *entry);
static MalValue port_wrapper_new(MalVm *vm, Endpoint *endpoint);
static void port_record_release(PortRecord *port);

// close() and a committed transfer both end a port's transferability.
static bool port_transferable(const PortRecord *port) {
    return port->endpoint != nullptr && !port->closing;
}

static bool hooks_encode(void *data, MalVm *vm, MalValue value, bool transfer,
    MalSerializeHostDescriptor *out) {
    (void) data;
    (void) vm;
    PortRecord *port = port_record(value);
    if (port != nullptr) {
        // Ports clone only by transfer, and never into their own channel.
        if (!transfer || !port_transferable(port)) return false;
        Isolate *iso = g_isolate;
        if (iso->sending != nullptr && port->endpoint->channel == iso->sending->channel) return false;
        PortTransfer *moving = malloc(sizeof(PortTransfer));
        if (moving == nullptr) return false;
        moving->endpoint = port->endpoint;
        moving->record = port;
        moving->adopted = nullptr;
        channel_retain(port->endpoint->channel);
        port->refs++;
        out->kind = DESCRIPTOR_PORT_PENDING;
        out->resource = moving;
        return true;
    }
    UrlRecord *url = url_record(value);
    if (url != nullptr && !transfer) {
        UrlDescriptor *descriptor = malloc(sizeof(UrlDescriptor));
        if (descriptor == nullptr) return false;
        descriptor->href = strdup(url->entry->href);
        if (descriptor->href == nullptr) {
            free(descriptor);
            return false;
        }
        out->kind = DESCRIPTOR_URL;
        out->resource = descriptor;
        return true;
    }
    return false;
}

// A getter may have closed or transferred a listed port after encode.
static bool hooks_validate(void *data, MalVm *vm, const MalSerializeHostDescriptor *descriptor) {
    (void) data;
    (void) vm;
    if (descriptor->kind != DESCRIPTOR_PORT_PENDING) return true;
    const PortTransfer *moving = descriptor->resource;
    return moving->record->endpoint == moving->endpoint && port_transferable(moving->record);
}

static bool hooks_reject(void *data, MalVm *vm, MalValue object) {
    (void) data;
    Isolate *iso = g_isolate;
    (void) vm;
    if (iso == nullptr || mal_value_is_undefined(iso->uncloneable) || !mal_value_is_object(object)) return false;
    MalValue mark;
    return mal_table_get_private_value(
        mal_object_overflow(mal_value_to_object(object)), mal_value_to_symbol(iso->uncloneable), &mark);
}

void mal_workers_mark_uncloneable(MalVm *vm, MalValue object) {
    Isolate *iso = g_isolate;
    if (iso == nullptr || !mal_value_is_object(object) || hooks_reject(nullptr, vm, object)) return;
    if (mal_value_is_undefined(iso->uncloneable)) {
        iso->uncloneable = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    }
    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = iso->uncloneable};
    mal_object_add_private(mal_value_to_object(object), key, mal_value_new_boolean(true));
}

bool mal_workers_prepare_commit(MalVm *vm, MalSerializedValue *snapshot, const char **error) {
    return mal_serialized_value_validate(vm, snapshot, error);
}

// Infallible; the serializer passes no value, so the descriptor names the record.
static void hooks_commit(void *data, MalVm *vm, MalValue value, MalSerializeHostDescriptor *descriptor) {
    (void) data;
    (void) value;
    if (descriptor->kind != DESCRIPTOR_PORT_PENDING) return;
    PortTransfer *moving = descriptor->resource;
    PortRecord *port = moving->record;
    moving->record = nullptr;
    if (port->endpoint == moving->endpoint) {
        Endpoint *endpoint = port->endpoint;
        endpoint_bind(endpoint, nullptr);
        port->endpoint = nullptr;
        port_update_work(vm, port);
        channel_release(endpoint->channel); // the sender record's handle
        descriptor->kind = DESCRIPTOR_PORT;
    } else {
        descriptor->kind = DESCRIPTOR_PORT_STALE;
    }
    port_record_release(port);
}

static bool hooks_decode(void *data, MalVm *vm, MalSerializeHostDescriptor *descriptor, MalValue *out) {
    (void) data;
    if (descriptor->kind == DESCRIPTOR_PORT) {
        PortTransfer *moving = descriptor->resource;
        if (moving->endpoint == nullptr) {
            throw_type(vm, "transferred MessagePort was already received");
            return false;
        }
        MalValue wrapper = port_wrapper_new(vm, moving->endpoint);
        if (thrown(vm)) return false;
        // The wrapper adopted the descriptor's channel reference.
        moving->endpoint = nullptr;
        moving->adopted = port_record(wrapper);
        *out = wrapper;
        return true;
    }
    if (descriptor->kind == DESCRIPTOR_URL) {
        UrlDescriptor *url = descriptor->resource;
        const MalWorkerEntry *entry = entry_lookup(url->href);
        if (entry == nullptr) {
            throw_type(vm, "worker URL is not registered in this process");
            return false;
        }
        *out = url_descriptor_for(vm, entry);
        return !thrown(vm);
    }
    throw_type(vm, "MessagePort in message is no longer transferable");
    return false;
}

// PENDING descriptors exist only in uncommitted snapshots, which the sender
// mutator releases, so their record release stays mutator-local.
static void hooks_release(MalSerializeHostDescriptor *descriptor) {
    if (descriptor->resource == nullptr) return;
    if (descriptor->kind == DESCRIPTOR_URL) {
        UrlDescriptor *url = descriptor->resource;
        free(url->href);
        free(url);
    } else {
        PortTransfer *moving = descriptor->resource;
        if (moving->record != nullptr) port_record_release(moving->record);
        if (moving->endpoint != nullptr) {
            Channel *channel = moving->endpoint->channel;
            // A committed endpoint nobody adopted closes its channel.
            if (descriptor->kind == DESCRIPTOR_PORT) channel_close(channel);
            channel_release(channel);
        }
        free(moving);
    }
    descriptor->resource = nullptr;
}

static const MalSerializeHooks g_hooks = {
    .data = nullptr,
    .encode = hooks_encode,
    .commit = hooks_commit,
    .decode = hooks_decode,
    .release = hooks_release,
    .validate = hooks_validate,
    .reject = hooks_reject,
};

const MalSerializeHooks *mal_workers_get_serialize_hooks(MalVm *vm) {
    return mal_workers_install(vm) ? &g_hooks : nullptr;
}

// event.ports: every transferred port in transfer-list order, right after
// mal_deserialize and before any JS. Ports the payload did not reference (a Node
// reply port) are adopted here instead of closing when the snapshot is released.
static MalValue transferred_ports(MalVm *vm, MalSerializedValue *snapshot) {
    u32 count = mal_serialized_value_transfer_count(snapshot);
    MalValue *ports = malloc((count == 0 ? 1 : count) * sizeof(MalValue));
    if (ports == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i < count; i++) ports[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, ports, (i32) count);
    u32 n = 0;
    bool ok = true;
    for (u32 i = 0; i < count && ok; i++) {
        // Decode mutates only the PortTransfer resource, never the descriptor.
        MalSerializeHostDescriptor *descriptor =
            (MalSerializeHostDescriptor *) mal_serialized_value_transferred_host(snapshot, i);
        if (descriptor == nullptr || descriptor->kind != DESCRIPTOR_PORT || descriptor->resource == nullptr) continue;
        PortTransfer *moving = descriptor->resource;
        if (moving->endpoint != nullptr) {
            ok = hooks_decode(nullptr, vm, descriptor, &ports[n]);
            if (ok) n++;
        } else if (moving->adopted != nullptr) {
            ports[n++] = moving->adopted->wrapper;
        }
        moving->adopted = nullptr;
    }
    MalValue result = mal_value_new_undefined();
    if (ok) {
        result = mal_value_from_array_object(mal_array_object_new_from_values(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), ports, n));
    }
    mal_gc_unroot(&root);
    free(ports);
    return result;
}

bool mal_workers_adopt_transferred(MalVm *vm, MalSerializedValue *snapshot) {
    if (mal_serialized_value_transfer_count(snapshot) == 0) return true;
    transferred_ports(vm, snapshot);
    return !thrown(vm);
}

static bool listener_type_is(MalValue type, const char *name) {
    return mal_value_is_string(type) && mal_string_equals_ascii(mal_value_to_string(type), name);
}

// `owner` is the wrapper whose tracer reports these listeners.
static bool listeners_add(Listeners *listeners, MalValue owner, MalValue type, MalValue callback, bool once,
    bool prepend) {
    if (listeners->count == listeners->cap) {
        u32 cap = listeners->cap == 0 ? 4 : listeners->cap * 2;
        Listener *items = realloc(listeners->items, cap * sizeof(Listener));
        if (items == nullptr) return false;
        listeners->items = items;
        listeners->cap = cap;
    }
    if (prepend) {
        memmove(&listeners->items[1], &listeners->items[0], listeners->count * sizeof(Listener));
        listeners->items[0] = (Listener) {type, callback, once};
    } else {
        listeners->items[listeners->count] = (Listener) {type, callback, once};
    }
    listeners->count++;
    if (mal_value_is_object(owner)) {
        mal_gc_card(&mal_value_to_object(owner)->header, type);
        mal_gc_card(&mal_value_to_object(owner)->header, callback);
    }
    return true;
}

static void listeners_remove_at(Listeners *listeners, u32 index) {
    mal_gc_write_barrier(listeners->items[index].type);
    mal_gc_write_barrier(listeners->items[index].callback);
    memmove(&listeners->items[index], &listeners->items[index + 1],
        (listeners->count - index - 1) * sizeof(Listener));
    listeners->count--;
}

static u32 listeners_count(const Listeners *listeners, const char *name) {
    u32 count = 0;
    for (u32 i = 0; i < listeners->count; i++) {
        if (listener_type_is(listeners->items[i].type, name)) count++;
    }
    return count;
}

// Emit to a snapshot of matching listeners so listener edits during emit do not
// skip or repeat entries. Returns false if a listener threw.
static bool listeners_emit(MalVm *vm, Listeners *listeners, MalValue receiver, const char *name,
    const MalValue *args, i32 argc) {
    u32 count = listeners_count(listeners, name);
    if (count == 0) return true;
    MalValue *callbacks = malloc(count * sizeof(MalValue));
    if (callbacks == nullptr) return true;
    u32 n = 0;
    for (u32 i = 0; i < listeners->count;) {
        Listener *listener = &listeners->items[i];
        if (!listener_type_is(listener->type, name)) {
            i++;
            continue;
        }
        callbacks[n++] = listener->callback;
        if (listener->once) listeners_remove_at(listeners, i);
        else i++;
    }
    MalRootSpan root;
    mal_gc_root(&root, callbacks, n);
    bool ok = true;
    for (u32 i = 0; i < n && ok; i++) {
        mal_vm_call_value(vm, callbacks[i], receiver, args, argc);
        ok = !thrown(vm);
    }
    mal_gc_unroot(&root);
    free(callbacks);
    return ok;
}

// EventTarget listeners registered through addEventListener on the wrapper.
static bool event_target_emit(MalVm *vm, MalValue target, const char *name, MalValue event) {
    if (!mal_value_is_object(target)) return true;
    MalObject *object = mal_value_to_object(target);
    if (object->header.type != MAL_HEAP_EVENT_TARGET_OBJECT) return true;
    MalEventTargetObject *et = (MalEventTargetObject *) object;
    i32 count = et->count;
    if (count == 0) return true;
    // Slots 0 and 1 keep target and event alive: a handleEvent getter runs JS between calls.
    MalValue *callbacks = malloc(((usize) count + 2) * sizeof(MalValue));
    if (callbacks == nullptr) return true;
    callbacks[0] = target;
    callbacks[1] = event;
    i32 n = 2;
    for (i32 i = 0; i < count; i++) {
        MalEventListener *listener = &et->listeners[i];
        if (listener->removed || !mal_string_equals_ascii(listener->type, name)) continue;
        callbacks[n++] = listener->callback;
        if (listener->once) listener->removed = true;
    }
    MalRootSpan root;
    mal_gc_root(&root, callbacks, n);
    bool ok = true;
    for (i32 i = 2; i < n && ok; i++) {
        MalValue callback = callbacks[i];
        MalValue receiver = callbacks[0];
        if (!mal_value_is_callable(callback)) {
            MalValue handle;
            if (!get_named(vm, callback, "handleEvent", &handle)) {
                ok = false;
                break;
            }
            receiver = callback;
            callback = handle;
            if (!mal_value_is_callable(callback)) continue;
        }
        mal_vm_call_value(vm, callback, receiver, &callbacks[1], 1);
        ok = !thrown(vm);
    }
    mal_gc_unroot(&root);
    free(callbacks);
    return ok;
}

static MalValue message_event_new(MalVm *vm, const char *type, MalValue data, MalValue target, MalValue ports) {
    MalValue roots[] = {data, target, mal_value_new_undefined(), ports};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_event_new(vm, type, true);
    MalObject *event = mal_value_to_object(roots[2]);
    mal_intrinsic_define_data(vm, event, (const byte *) "type", str_value(vm, type), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "data", roots[0], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "target", roots[1], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "currentTarget", roots[1], MAL_PROPERTY_ENUMERABLE);
    if (strcmp(type, "close") != 0) {
        mal_intrinsic_define_data(vm, event, (const byte *) "origin", str_value(vm, ""), MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, event, (const byte *) "lastEventId", str_value(vm, ""), MAL_PROPERTY_ENUMERABLE);
        if (!mal_value_is_object(roots[3])) {
            roots[3] = mal_value_from_array_object(mal_array_object_new_from_values(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), &roots[3], 0));
        }
        // MessageEvent.ports is a frozen array.
        mal_object_set_integrity_level(mal_value_to_object(roots[3]), true);
        mal_intrinsic_define_data(vm, event, (const byte *) "ports", roots[3], MAL_PROPERTY_ENUMERABLE);
    }
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

// ErrorEvent shape for a worker's uncaught error: `error` is the thrown value as
// received (undefined included) and `message` its own string message, without JS.
static MalValue error_event_new(MalVm *vm, MalValue error, MalValue target) {
    MalValue roots[] = {error, target, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_event_new(vm, "error", true);
    MalObject *event = mal_value_to_object(roots[2]);
    roots[3] = str_value(vm, "");
    if (mal_value_is_string(roots[0])) {
        roots[3] = roots[0];
    } else if (mal_value_is_object(roots[0])) {
        MalPropertyLookup own = mal_object_get_own(mal_value_to_object(roots[0]), name_key(vm, "message"));
        if (own.present && (own.desc.flags & MAL_PROPERTY_ACCESSOR) == 0 && mal_value_is_string(own.desc.value)) {
            roots[3] = own.desc.value;
        }
    }
    mal_intrinsic_define_data(vm, event, (const byte *) "type", str_value(vm, "error"), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "target", roots[1], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "currentTarget", roots[1], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "error", roots[0], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "message", roots[3], MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "filename", str_value(vm, ""), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "lineno", mal_value_from_i32(0), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, event, (const byte *) "colno", mal_value_from_i32(0), MAL_PROPERTY_ENUMERABLE);
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

static bool port_dispatch(MalVm *vm, PortRecord *port, const char *name, MalValue data, MalValue ports) {
    MalValue roots[] = {port->wrapper, data, port->forward, mal_value_new_undefined(), ports};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = true;
    bool is_close = strcmp(name, "close") == 0;
    if (!mal_value_is_undefined(roots[2])) {
        WorkerRecord *worker = worker_record(roots[2]);
        if (worker != nullptr && !is_close) {
            ok = listeners_emit(vm, &worker->listeners, roots[2], name, &roots[1], 1);
        }
        mal_gc_unroot(&root);
        return ok;
    }
    ok = listeners_emit(vm, &port->listeners, roots[0], name, &roots[1], is_close ? 0 : 1);
    if (ok) {
        roots[3] = message_event_new(vm, name, roots[1], roots[0], roots[4]);
        ok = event_target_emit(vm, roots[0], name, roots[3]);
        // `port` may have been unlinked by a listener; recheck by identity.
        PortRecord *live = port_record(roots[0]);
        MalValue handler = live == nullptr ? mal_value_new_undefined()
            : strcmp(name, "message") == 0 ? live->onmessage
            : strcmp(name, "messageerror") == 0 ? live->onmessageerror
            : mal_value_new_undefined();
        if (ok && mal_value_is_callable(handler)) {
            mal_vm_call_value(vm, handler, roots[0], &roots[3], 1);
            ok = !thrown(vm);
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

static void port_record_release(PortRecord *port) {
    if (--port->refs != 0) return;
    free(port->listeners.items);
    free(port);
}

static void port_start(MalVm *vm, PortRecord *port) {
    if (port->started || port->endpoint == nullptr) return;
    port->started = true;
    port_update_work(vm, port);
    // Messages that arrived before start are delivered now.
    endpoint_bind(port->endpoint, g_isolate->owner);
}

static MalValue port_wrapper_new(MalVm *vm, Endpoint *endpoint) {
    Isolate *iso = g_isolate;
    PortRecord *port = calloc(1, sizeof(PortRecord));
    if (port == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "MessagePort: out of memory");
        return mal_value_new_undefined();
    }
    MalValue prototype = endpoint->posting_policy == POST_NODE
        ? iso->node_port_prototype : iso->port_prototype;
    MalEventTargetObject *object = mal_event_target_object_new(
        &vm->heap, mal_value_to_object(prototype));
    object->native = port;
    object->native_ops = &g_port_ops;
    port->wrapper = mal_value_from_object(&object->object);
    port->onmessage = mal_value_new_null();
    port->onmessageerror = mal_value_new_null();
    port->forward = mal_value_new_undefined();
    port->endpoint = endpoint;
    // The wrapper retains its policy after close or transfer removes the endpoint.
    port->posting_policy = endpoint->posting_policy;
    port->refs = 1;
    port->referenced = true;
    port->next = iso->ports;
    iso->ports = port;
    // Unstarted ports stay unbound until start(); arrivals still queue natively.
    return port->wrapper;
}

static PortRecord *this_port(MalVm *vm, MalValue receiver) {
    PortRecord *port = port_record(receiver);
    if (port == nullptr) throw_type(vm, "receiver is not a MessagePort");
    return port;
}

static void port_close_record(MalVm *vm, PortRecord *port) {
    (void) vm;
    if (port->endpoint == nullptr) return;
    port->closing = true;
    channel_close(port->endpoint->channel);
    // Still bound, so this isolate's drain observes close_pending and emits 'close'.
    if (!port->started) {
        port->started = true;
        endpoint_bind(port->endpoint, g_isolate->owner);
    }
}

static void throw_clone_error(MalVm *vm, const char *error, const char *fallback) {
    mal_dom_exception_throw(vm, (const byte *) (error != nullptr ? error : fallback), (const byte *) "DataCloneError");
}

static void throw_admission_error(MalVm *vm, AdmitResult admit) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
        admit == ADMIT_FULL ? "MessagePort queue limit reached"
        : admit == ADMIT_TOO_LARGE ? "message exceeds maxMessageBytes"
        : admit == ADMIT_PROCESS_FULL ? "process-wide queued message limit reached"
        : admit == ADMIT_PROCESS_BYTES ? "process-wide queued message byte limit reached"
        : "postMessage: out of memory");
}

static void commit_dropped_snapshot(MalVm *vm, MalSerializedValue *snapshot) {
    if (mal_serialize_commit(vm, snapshot)) return;
    const char *error = nullptr;
    mal_serialized_value_validate(vm, snapshot, &error);
    throw_clone_error(vm, error, "could not clone message");
}

// A port without a live peer (closed, peer closed or transferred away) still
// serializes, as HTML's post message steps and Node require: clone errors throw and
// transferred objects detach (transferred ports close), then the message is dropped.
// Nothing is queued, so no slot or byte reservation is taken.
static void post_unentangled(MalVm *vm, Endpoint *sender, MalValue value, MalValue transfer) {
    const char *error = nullptr;
    Isolate *iso = g_isolate;
    Endpoint *previous = iso->sending;
    // A getter may transfer the sending port away; `sending` must not dangle.
    if (sender != nullptr) channel_retain(sender->channel);
    iso->sending = sender;
    MalSerializedValue *snapshot = mal_serialize(vm, value, transfer, nullptr, &g_hooks, &error);
    iso->sending = previous;
    if (sender != nullptr) channel_release(sender->channel);
    if (snapshot == nullptr) {
        if (!thrown(vm)) throw_clone_error(vm, error, "could not clone message");
        return;
    }
    commit_dropped_snapshot(vm, snapshot);
    mal_serialized_value_release(snapshot);
}

// Serialize, admit and publish one message from `from`'s endpoint to its peer.
// Getters run inside mal_serialize; everything after it is native, so validation,
// admission and commit see one consistent state. Every exit returns the slot and
// byte reservations exactly once: before admission via endpoint_admit_bytes or
// endpoint_unreserve, after it via endpoint_cancel_admitted or the Message. Returns
// the message ticket, or 0 when nothing was queued (closed channel, sender moved
// away, or a pending throw).
static u64 endpoint_post(MalVm *vm, PortRecord *from, MalValue value, MalValue transfer) {
    Endpoint *sender = from->endpoint;
    Endpoint *receiver = endpoint_peer(sender);
    Channel *channel = sender->channel;
    AdmitResult admit = endpoint_reserve(receiver);
    if (admit == ADMIT_CLOSED) {
        post_unentangled(vm, sender, value, transfer);
        return 0;
    }
    if (admit != ADMIT_OK) {
        throw_admission_error(vm, admit);
        return 0;
    }
    // A getter may close or transfer the sending port; keep both endpoints alive.
    channel_retain(channel);
    from->refs++;
    MalSerializeLimits limits = {.max_bytes = receiver->max_message_bytes, .max_objects = 0};
    const char *error = nullptr;
    Isolate *iso = g_isolate;
    Endpoint *previous = iso->sending;
    iso->sending = sender;
    MalSerializedValue *snapshot = mal_serialize(vm, value, transfer, &limits, &g_hooks, &error);
    iso->sending = previous;
    u64 ticket = 0;
    if (snapshot == nullptr) {
        endpoint_unreserve(receiver);
        if (!thrown(vm)) throw_clone_error(vm, error, "could not clone message");
    } else if (from->endpoint != sender) {
        endpoint_unreserve(receiver);
        // Node commits serialization even when a getter moves the caller away.
        if (from->posting_policy == POST_NODE) commit_dropped_snapshot(vm, snapshot);
        mal_serialized_value_release(snapshot);
    } else {
        u64 bytes = mal_serialized_value_size(snapshot);
        admit = endpoint_admit_bytes(receiver, bytes);
        Message *message = admit == ADMIT_OK ? malloc(sizeof(Message)) : nullptr;
        // No JS ran since mal_serialize validated, so commit fails only if that
        // contract breaks; it then detaches nothing and the message is not published.
        bool committed = message != nullptr && mal_serialize_commit(vm, snapshot);
        if (!committed) {
            if (admit == ADMIT_OK) endpoint_cancel_admitted(receiver, bytes);
            if (message != nullptr) {
                error = nullptr;
                mal_serialized_value_validate(vm, snapshot, &error);
                throw_clone_error(vm, error, "could not clone message");
            } else if (admit == ADMIT_CLOSED) {
                if (from->posting_policy == POST_NODE) commit_dropped_snapshot(vm, snapshot);
            } else {
                throw_admission_error(vm, admit);
            }
            free(message);
            mal_serialized_value_release(snapshot);
        } else {
            message->value = snapshot;
            message->bytes = bytes;
            message->ticket = atomic_fetch_add_explicit(&g_next_ticket, 1, memory_order_relaxed);
            message->sender = sender;
            ticket = message->ticket;
            endpoint_publish(receiver, message);
        }
    }
    port_record_release(from);
    channel_release(channel);
    return ticket;
}

// postMessage(value, transfer | {transfer}) for both web and Node call shapes.
static MalValue transfer_argument(MalVm *vm, const MalValue *args, i32 argc) {
    if (argc < 2 || mal_value_is_undefined(args[1]) || mal_value_is_null(args[1])) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_array_object(args[1])) return args[1];
    MalValue transfer;
    if (!get_named(vm, args[1], "transfer", &transfer)) return mal_value_new_undefined();
    if (mal_value_is_undefined(transfer)) return mal_value_new_undefined();
    if (!mal_value_is_array_object(transfer)) {
        throw_type(vm, "transfer must be an array");
        return mal_value_new_undefined();
    }
    return transfer;
}

static MalValue port_post_message(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    PortRecord *port = this_port(vm, receiver);
    if (port == nullptr) return mal_value_new_undefined();
    MalValue transfer = transfer_argument(vm, args, argc);
    if (thrown(vm)) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (port->endpoint == nullptr) {
        post_unentangled(vm, nullptr, value, transfer);
        return mal_value_new_undefined();
    }
    u64 ticket = endpoint_post(vm, port, value, transfer);
    // Only the transactional pool mailbox exposes an internal _discard ticket.
    if (ticket == 0 || port->posting_policy == POST_NODE) return mal_value_new_undefined();
    return ticket <= INT32_MAX ? mal_value_from_i32((i32) ticket) : mal_value_from_f64((f64) ticket);
}

// Private: drop a message this port posted if the peer has not received it yet,
// returning its slot, bytes and snapshot (transferred ports close).
static MalValue port_discard_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    PortRecord *port = this_port(vm, receiver);
    if (port == nullptr || port->endpoint == nullptr || argc < 1) return mal_value_new_boolean(false);
    f64 number = mal_value_is_int32(args[0]) ? (f64) mal_value_to_i32(args[0])
        : mal_value_is_f64(args[0]) ? mal_value_to_f64(args[0]) : 0;
    if (!(number >= 1) || number > 9.0e15 || number != (f64) (u64) number) return mal_value_new_boolean(false);
    return mal_value_new_boolean(endpoint_discard(endpoint_peer(port->endpoint), port->endpoint, (u64) number));
}

static MalValue port_start_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    PortRecord *port = this_port(vm, receiver);
    if (port != nullptr) port_start(vm, port);
    return mal_value_new_undefined();
}

static MalValue port_close_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    PortRecord *port = this_port(vm, receiver);
    if (port != nullptr) port_close_record(vm, port);
    return mal_value_new_undefined();
}

static MalValue port_set_referenced(MalVm *vm, MalValue receiver, bool referenced) {
    PortRecord *port = this_port(vm, receiver);
    if (port == nullptr) return mal_value_new_undefined();
    port->referenced = referenced;
    port_update_work(vm, port);
    return port->posting_policy == POST_NODE ? mal_value_new_undefined() : receiver;
}

static MalValue port_ref_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return port_set_referenced(vm, receiver, true);
}

static MalValue port_unref_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return port_set_referenced(vm, receiver, false);
}

static MalValue port_has_ref_method(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    PortRecord *port = this_port(vm, receiver);
    return mal_value_new_boolean(port != nullptr && port->holds_work);
}

static Listeners *emitter_listeners(MalVm *vm, MalValue receiver, bool *is_port) {
    PortRecord *port = port_record(receiver);
    if (port != nullptr) {
        *is_port = true;
        return &port->listeners;
    }
    WorkerRecord *worker = worker_record(receiver);
    if (worker != nullptr) {
        *is_port = false;
        return &worker->listeners;
    }
    throw_type(vm, "receiver is not a MessagePort or Worker");
    return nullptr;
}

static MalValue emitter_add(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, bool once, bool prepend) {
    bool is_port = false;
    Listeners *listeners = emitter_listeners(vm, receiver, &is_port);
    if (listeners == nullptr) return mal_value_new_undefined();
    if (argc < 2 || !mal_value_is_string(args[0]) || !mal_value_is_callable(args[1])) {
        throw_type(vm, "listener must be a function");
        return mal_value_new_undefined();
    }
    if (!listeners_add(listeners, receiver, args[0], args[1], once, prepend)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "out of memory");
        return mal_value_new_undefined();
    }
    // Node starts a port when its first 'message' listener is attached.
    if (is_port && listener_type_is(args[0], "message")) port_start(vm, port_record(receiver));
    return receiver;
}

#define EMITTER_ADD(NAME, ONCE, PREPEND) \
    static MalValue NAME(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        (void) new_target; (void) callee; \
        return emitter_add(vm, receiver, args, argc, ONCE, PREPEND); \
    }
EMITTER_ADD(emitter_on, false, false)
EMITTER_ADD(emitter_once, true, false)
EMITTER_ADD(emitter_prepend, false, true)
EMITTER_ADD(emitter_prepend_once, true, true)
#undef EMITTER_ADD

static MalValue emitter_remove(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    bool is_port = false;
    Listeners *listeners = emitter_listeners(vm, receiver, &is_port);
    if (listeners == nullptr || argc < 2) return receiver;
    for (u32 i = listeners->count; i > 0; i--) {
        Listener *listener = &listeners->items[i - 1];
        if (listener->callback == args[1] && mal_value_is_string(args[0]) &&
            mal_string_equals(mal_value_to_string(listener->type), mal_value_to_string(args[0]))) {
            listeners_remove_at(listeners, i - 1);
            break;
        }
    }
    return receiver;
}

static MalValue emitter_remove_all(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    bool is_port = false;
    Listeners *listeners = emitter_listeners(vm, receiver, &is_port);
    if (listeners == nullptr) return receiver;
    for (u32 i = listeners->count; i > 0; i--) {
        if (argc == 0 || mal_value_is_undefined(args[0]) ||
            (mal_value_is_string(args[0]) &&
                mal_string_equals(mal_value_to_string(listeners->items[i - 1].type), mal_value_to_string(args[0])))) {
            listeners_remove_at(listeners, i - 1);
        }
    }
    return receiver;
}

static MalValue emitter_emit(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    bool is_port = false;
    Listeners *listeners = emitter_listeners(vm, receiver, &is_port);
    if (listeners == nullptr || argc < 1 || !mal_value_is_string(args[0])) return mal_value_new_boolean(false);
    char *name = value_to_cstring(args[0]);
    if (name == nullptr) return mal_value_new_boolean(false);
    bool any = listeners_count(listeners, name) > 0;
    listeners_emit(vm, listeners, receiver, name, args + 1, argc - 1);
    free(name);
    return mal_value_new_boolean(any);
}

static MalValue emitter_listener_count(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    bool is_port = false;
    Listeners *listeners = emitter_listeners(vm, receiver, &is_port);
    if (listeners == nullptr || argc < 1) return mal_value_from_i32(0);
    char *name = value_to_cstring(args[0]);
    u32 count = name != nullptr ? listeners_count(listeners, name) : 0;
    free(name);
    return mal_value_from_i32((i32) count);
}

static MalValue port_handler_get(MalVm *vm, MalValue receiver, bool error) {
    PortRecord *port = this_port(vm, receiver);
    if (port == nullptr) return mal_value_new_undefined();
    return error ? port->onmessageerror : port->onmessage;
}

static MalValue port_onmessage_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return port_handler_get(vm, receiver, false);
}

static MalValue port_onmessageerror_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return port_handler_get(vm, receiver, true);
}

static MalValue port_handler_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, bool error) {
    PortRecord *port = this_port(vm, receiver);
    if (port == nullptr) return mal_value_new_undefined();
    MalValue value = argc > 0 && mal_value_is_callable(args[0]) ? args[0] : mal_value_new_null();
    if (!error) {
        port_edge_store(port, &port->onmessage, value);
        // Setting onmessage implicitly starts the port (HTML).
        if (mal_value_is_callable(value)) port_start(vm, port);
    } else {
        port_edge_store(port, &port->onmessageerror, value);
    }
    return mal_value_new_undefined();
}

static MalValue port_onmessage_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    return port_handler_set(vm, receiver, args, argc, false);
}

static MalValue port_onmessageerror_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    return port_handler_set(vm, receiver, args, argc, true);
}

static MalValue new_message_port_illegal(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    throw_type(vm, "Illegal constructor");
    return mal_value_new_undefined();
}

static bool queue_limits(MalVm *vm, MalValue options, u32 *max_count, u64 *max_bytes, u64 *max_message);

static MalValue channel_construct_with_policy(MalVm *vm, const MalValue *args, i32 argc,
    MalValue new_target, PostingPolicy posting_policy) {
    if (mal_value_is_undefined(new_target)) {
        throw_type(vm, "Class constructor MessageChannel cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    // Bounds apply to each direction of this channel, independent of any worker's options.
    u32 max_count;
    u64 max_bytes, max_message;
    MalValue options = posting_policy == POST_TRANSACTIONAL && argc > 0
        ? args[0] : mal_value_new_undefined();
    if (!queue_limits(vm, options, &max_count, &max_bytes, &max_message)) {
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(vm, new_target,
            MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) return mal_value_new_undefined();
    Channel *channel = channel_new(max_count, max_bytes, max_message, posting_policy);
    if (channel == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "MessageChannel: out of memory");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = port_wrapper_new(vm, &channel->side[0]);
    roots[1] = port_wrapper_new(vm, &channel->side[1]);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "port1", roots[0],
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "port2", roots[1],
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

static MalValue channel_construct(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    return channel_construct_with_policy(vm, args, argc, new_target, POST_TRANSACTIONAL);
}

static MalValue node_channel_construct(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    return channel_construct_with_policy(vm, args, argc, new_target, POST_NODE);
}

// receiveMessageOnPort(port) -> {message} | undefined, synchronous, unstarted ok.
static MalValue receive_message_on_port(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    PortRecord *port = argc > 0 ? port_record(args[0]) : nullptr;
    if (port == nullptr) {
        throw_type(vm, "The \"port\" argument must be a MessagePort instance");
        return mal_value_new_undefined();
    }
    if (port->endpoint == nullptr) return mal_value_new_undefined();
    Message *message = endpoint_pop(port->endpoint);
    if (message == nullptr) return mal_value_new_undefined();
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Node exposes no event.ports here; unreferenced transferred ports are adopted so
    // their channels close when the receiver wrappers are collected, not now.
    bool ok = mal_deserialize_take(vm, message->value, &g_hooks, &roots[0]) &&
        mal_workers_adopt_transferred(vm, message->value);
    message_free(message);
    MalValue result = mal_value_new_undefined();
    if (ok) {
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "message", roots[0],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        result = roots[1];
    }
    mal_gc_unroot(&root);
    return result;
}

static MAL_ISOLATE_LOCAL WorkerThread *g_self_thread;
static MAL_ISOLATE_LOCAL bool g_exit_requested;
static MAL_ISOLATE_LOCAL int g_exit_code;
// The async entry (top-level await) rejected; the loop stops without terminating.
static MAL_ISOLATE_LOCAL bool g_startup_rejected;

bool mal_workers_is_worker(void) {
    return g_self_thread != nullptr;
}

u32 mal_workers_thread_id(void) {
    return g_self_thread != nullptr ? g_self_thread->id : 0;
}

static bool worker_termination_check(MalVm *vm) {
    (void) vm;
    return mal_gc_terminating() || g_startup_rejected;
}

bool mal_workers_exit_current(MalVm *vm, int code) {
    if (g_self_thread == nullptr) return false;
    // The first exit wins; a later exit or terminate() cannot change the code.
    if (!g_exit_requested && !mal_gc_terminating()) {
        g_exit_requested = true;
        g_exit_code = code;
    }
    mal_gc_request_termination(mal_gc_current_termination_target(), mal_gc_current_poll_target());
    mal_shared_wait_interrupt_signal(g_self_thread->interrupt);
    // Uncatchable: catch entries refuse a terminating throw, so JS unwinds to the run boundary.
    mal_gc_poll_termination(vm);
    return true;
}

static MalValue startup_fulfilled(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    if (!worker_termination_check(vm)) worker_post_event(g_self_thread, THREAD_READY);
    return mal_value_new_undefined();
}

// The reason stays in the rooted entry promise; worker_thread_main reads it after the loop.
static MalValue startup_rejected(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    g_startup_rejected = true;
    return mal_value_new_undefined();
}

// Posts READY once module evaluation completed, including top-level await. While
// evaluation is pending, native observers settle it from the ordinary loop.
static void worker_observe_startup(MalVm *vm) {
    if (!mal_value_is_promise_object(vm->entry_async_promise)) {
        worker_post_event(g_self_thread, THREAD_READY);
        return;
    }
    MalPromiseObject *entry = mal_value_to_promise_object(vm->entry_async_promise);
    // The worker reports a rejection to its parent; it is never an unhandled rejection.
    entry->is_handled = true;
    if (entry->state == MAL_PROMISE_FULFILLED) {
        worker_post_event(g_self_thread, THREAD_READY);
        return;
    }
    if (entry->state == MAL_PROMISE_REJECTED) {
        g_startup_rejected = true;
        return;
    }
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) ""), 1, startup_fulfilled));
    roots[1] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) ""), 1, startup_rejected));
    mal_promise_perform_then(vm, vm->entry_async_promise, roots[0], roots[1],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
}

// The isolate never ran module code, so the child endpoint is still owned by the thread.
static void worker_drop_child_endpoint(WorkerThread *thread) {
    if (thread->child_endpoint == nullptr) return;
    Channel *child = thread->child_endpoint->channel;
    thread->child_endpoint = nullptr;
    channel_close(child);
    channel_release(child);
}

static MalSerializedValue *worker_serialize_error(MalVm *vm, MalValue error) {
    const char *message = nullptr;
    MalSerializedValue *snapshot = mal_serialize(vm, error, mal_value_new_undefined(), nullptr, nullptr, &message);
    if (snapshot != nullptr) return snapshot;
    // Unclonable error (or a throwing getter): fall back to its string form.
    vm->completion.kind = MAL_COMPLETION_NORMAL;
    MalValue text = str_value(vm, "Uncaught exception in worker (not cloneable)");
    return mal_serialize(vm, text, mal_value_new_undefined(), nullptr, nullptr, &message);
}

// Thread-local flags die with this thread, so terminate() must stop reaching them
// before the exit post lets the parent join.
static void worker_thread_finish(WorkerThread *thread) {
    pthread_mutex_lock(&thread->mutex);
    thread->termination = nullptr;
    thread->poll = nullptr;
    pthread_mutex_unlock(&thread->mutex);
    worker_post_event(thread, THREAD_EXIT);
    Owner *parent = thread->parent;
    thread->parent = nullptr;
    owner_release(parent);
    worker_thread_release(thread);
}

static void *worker_thread_main(void *arg) {
    WorkerThread *thread = arg;
    sigset_t all;
    sigfillset(&all);
    pthread_sigmask(SIG_BLOCK, &all, nullptr);

    pthread_mutex_lock(&thread->mutex);
    while (!thread->start_released) pthread_cond_wait(&thread->start_cond, &thread->mutex);
    bool cancelled = thread->start_cancelled;
    thread->termination = mal_gc_current_termination_target();
    thread->poll = mal_gc_current_poll_target();
    if (atomic_load_explicit(&thread->terminate_requested, memory_order_acquire)) {
        mal_gc_request_termination(thread->termination, thread->poll);
    }
    pthread_mutex_unlock(&thread->mutex);

    thread->reason = REASON_COMPLETED;
    thread->exit_code = 0;
    MalLoadedRuntimeImage *loaded = nullptr;
    const MalRuntimeImage *image = thread->entry->image;
    if (!cancelled && image == nullptr && thread->entry->wire != nullptr) {
        // Splicing mutates loaded wire data, so each isolate loads its own copy.
        const char *error = "ok";
        loaded = mal_runtime_image_load_with_host_resolver(
            (const u8 *) thread->entry->wire, thread->entry->wire_size, &error, mal_host_resolve_installer);
        image = loaded != nullptr ? mal_loaded_runtime_image_get(loaded) : nullptr;
    }
    MalVm *vm = cancelled || image == nullptr ? nullptr : calloc(1, sizeof(MalVm));
    g_self_thread = thread;
    if (vm != nullptr) {
        mal_vm_init(vm, image);
        vm->entry_errors_forwarded = true;
        if (mal_host_attach(vm) == nullptr) {
            mal_vm_free(vm);
            free(vm);
            vm = nullptr;
        }
    }
    if (vm == nullptr) {
        g_self_thread = nullptr;
        worker_drop_child_endpoint(thread);
        if (loaded != nullptr) mal_loaded_runtime_image_free(loaded);
        thread->reason = cancelled ? REASON_TERMINATED : REASON_ERROR;
        thread->exit_code = 1;
        worker_thread_finish(thread);
        return nullptr;
    }
    mal_runtime_personality_install(vm, thread->web_platform, thread->node);
    mal_atomics_set_agent(true, thread->interrupt);
    bool installed = mal_workers_install(vm);
    mal_host_set_termination_check(worker_termination_check);
    pthread_mutex_lock(&thread->mutex);
    thread->reactor = &mal_host(vm)->reactor;
    pthread_mutex_unlock(&thread->mutex);

    char *argv0 = "maligator-worker";
    MalHostLaunchContext launch = {.argc = 1, .argv = &argv0, .script_path = thread->entry->href};
    if (installed) {
        mal_vm_run_host_installs(vm, &launch);
    } else {
        worker_drop_child_endpoint(thread);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "worker isolate: out of memory");
    }
    MalCallable *callable = nullptr;
    if (!thrown(vm) && !worker_termination_check(vm)) {
        // Node's 'online' precedes module evaluation; raw `ready` follows all of it.
        worker_post_event(thread, THREAD_ONLINE);
        callable = mal_vm_create_callable(vm, 0);
        mal_vm_run(vm, callable);
        if (!thrown(vm) && !worker_termination_check(vm)) {
            worker_observe_startup(vm);
            mal_host_run_event_loop(vm);
        }
    }
    MalPromiseObject *entry = mal_value_is_promise_object(vm->entry_async_promise)
        ? mal_value_to_promise_object(vm->entry_async_promise) : nullptr;
    if (g_exit_requested) {
        thread->exit_code = g_exit_code;
        thread->reason = REASON_COMPLETED;
    } else if (atomic_load_explicit(&thread->terminate_requested, memory_order_acquire)) {
        thread->exit_code = 1;
        thread->reason = REASON_TERMINATED;
    } else if (thrown(vm) || (entry != nullptr && entry->state != MAL_PROMISE_FULFILLED)) {
        // A rejected entry reports its reason as thrown, undefined included. An entry
        // still pending when the loop ran out of work never finished evaluating.
        MalValue error = vm->completion.value;
        if (!thrown(vm) && entry->state == MAL_PROMISE_REJECTED) {
            error = entry->result;
        } else if (!thrown(vm)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "worker module evaluation did not settle (unresolved top-level await)");
            error = vm->completion.value;
        }
        vm->completion.kind = MAL_COMPLETION_NORMAL;
        MalRootSpan root;
        mal_gc_root(&root, &error, 1);
        thread->error = worker_serialize_error(vm, error);
        mal_gc_unroot(&root);
        thread->exit_code = 1;
        thread->reason = REASON_ERROR;
    } else {
        thread->exit_code = mal_host_finish_process(vm, 0);
    }
    vm->completion.kind = MAL_COMPLETION_NORMAL;
    g_startup_rejected = false;

    // Close producers into this isolate before its reactor goes away.
    pthread_mutex_lock(&thread->mutex);
    thread->reactor = nullptr;
    pthread_mutex_unlock(&thread->mutex);
    mal_workers_shutdown(vm);
    if (callable != nullptr) mal_vm_free_callable(callable);
#if MAL_NODE
    mal_node_immediates_free(vm);
#endif
    mal_host_timers_free(vm);
    mal_host_detach(vm);
    mal_vm_free(vm);
    free(vm);
    if (loaded != nullptr) mal_loaded_runtime_image_free(loaded);
    mal_atomics_set_agent(false, nullptr);
    g_self_thread = nullptr;
    worker_thread_finish(thread);
    return nullptr;
}

static MalValue promise_new(MalVm *vm) {
    return mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
}

static MalValue worker_exit_value(MalVm *vm, WorkerRecord *worker, MalValue error, bool has_error) {
    WorkerThread *thread = worker->thread;
    if (worker->node) return mal_value_from_i32(thread->exit_code);
    MalValue roots[] = {error, mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *exit = mal_value_to_object(roots[1]);
    const char *reason = thread->reason == REASON_COMPLETED ? "completed"
        : thread->reason == REASON_TERMINATED ? "terminated" : "error";
    mal_intrinsic_define_data(vm, exit, (const byte *) "id", mal_value_from_i32((i32) thread->id), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, exit, (const byte *) "code", mal_value_from_i32(thread->exit_code), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, exit, (const byte *) "reason", str_value(vm, reason), MAL_PROPERTY_ENUMERABLE);
    if (has_error) {
        mal_intrinsic_define_data(vm, exit, (const byte *) "error", roots[0], MAL_PROPERTY_ENUMERABLE);
    }
    mal_object_set_integrity_level(exit, true);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static void worker_unlink(Isolate *iso, WorkerRecord *worker) {
    for (WorkerRecord **link = &iso->workers; *link != nullptr; link = &(*link)->next) {
        if (*link == worker) {
            *link = worker->next;
            return;
        }
    }
}

// Joins the finished thread, releases its process slot, then settles promises
// and emits Node events. The record stays for `threadId`/terminate() callers
// until the wrapper itself is unreachable from our lists (dropped here).
static bool worker_finish(MalVm *vm, WorkerRecord *worker) {
    WorkerThread *thread = worker->thread;
    pthread_join(thread->thread, nullptr);
    atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
    worker->joined = true;
    worker_update_work(vm, worker);
    MalValue roots[] = {worker->wrapper, mal_value_new_undefined(), mal_value_new_undefined(),
        worker->closed, worker->terminations, worker->port, worker->ready};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // Close the parent side so the internal port does not keep the loop alive.
    PortRecord *port = port_record(roots[5]);
    if (port != nullptr && port->endpoint != nullptr) port_close_record(vm, port);
    // A thrown undefined is still an error; only a missing snapshot means none.
    bool has_error = thread->error != nullptr;
    if (has_error && !mal_deserialize_take(vm, thread->error, nullptr, &roots[1])) {
        roots[1] = vm->completion.value;
        vm->completion.kind = MAL_COMPLETION_NORMAL;
    }
    roots[2] = worker_exit_value(vm, worker, roots[1], has_error);
    if (!worker->ready_settled) {
        // Startup failed or was terminated; the same failure is also reported through closed.
        worker->ready_settled = true;
        MalValue reason = roots[1];
        if (!has_error) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "worker exited before it was ready");
            reason = vm->completion.value;
            vm->completion.kind = MAL_COMPLETION_NORMAL;
        }
        MalPromiseObject *ready = mal_value_to_promise_object(roots[6]);
        ready->is_handled = true;
        mal_promise_reject(vm, ready, reason);
    }
    bool ok = true;
    if (worker->node) {
        if (thread->reason == REASON_ERROR) {
            ok = listeners_emit(vm, &worker->listeners, roots[0], "error", &roots[1], 1);
        }
        if (ok) ok = listeners_emit(vm, &worker->listeners, roots[0], "exit", &roots[2], 1);
    } else {
        if (thread->reason == REASON_ERROR) {
            MalValue event = error_event_new(vm, roots[1], roots[0]);
            ok = event_target_emit(vm, roots[0], "error", event);
        }
    }
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[3]), roots[2]);
    if (mal_value_is_object(roots[4])) {
        MalValue length_value;
        if (get_named(vm, roots[4], "length", &length_value) && mal_value_is_int32(length_value)) {
            for (i32 i = 0; i < mal_value_to_i32(length_value); i++) {
                MalValue pending;
                if (!mal_vm_get_property(vm, roots[4], mal_key_index((u32) i), &pending)) break;
                mal_promise_fulfill(vm, mal_value_to_promise_object(pending), roots[2]);
            }
        }
    }
    worker_unlink(g_isolate, worker);
    free(worker->listeners.items);
    worker_thread_release(thread);
    free(worker);
    mal_gc_unroot(&root);
    return ok;
}

static void worker_requeue_exit(Owner *owner, WorkerThread *thread) {
    pthread_mutex_lock(&owner->mutex);
    thread->exit_pending = true;
    if (!thread->event_queued) {
        thread->event_queued = true;
        atomic_fetch_add_explicit(&thread->refcount, 1, memory_order_relaxed);
        thread->event_next = owner->events_head;
        owner->events_head = thread;
    }
    if (owner->reactor != nullptr) mal_reactor_wake(owner->reactor);
    pthread_mutex_unlock(&owner->mutex);
}

static bool workers_drain(MalVm *vm) {
    Isolate *iso = g_isolate;
    if (iso == nullptr) return false;
    Owner *owner = iso->owner;
    pthread_mutex_lock(&owner->mutex);
    WorkerThread *thread = owner->events_head;
    if (thread != nullptr) {
        owner->events_head = thread->event_next;
        thread->event_queued = false;
        bool online = thread->online_pending;
        bool ready = thread->ready_pending;
        bool exited = thread->exit_pending;
        thread->online_pending = false;
        thread->ready_pending = false;
        thread->exit_pending = false;
        pthread_mutex_unlock(&owner->mutex);
        WorkerRecord *worker = iso->workers;
        while (worker != nullptr && worker->thread != thread) worker = worker->next;
        bool ok = true;
        if (worker != nullptr && online && !worker->online) {
            worker->online = true;
            if (worker->node) ok = listeners_emit(vm, &worker->listeners, worker->wrapper, "online", nullptr, 0);
        }
        if (worker != nullptr && ready && !worker->ready_settled) {
            worker->ready_settled = true;
            mal_promise_fulfill(vm, mal_value_to_promise_object(worker->ready), mal_value_new_undefined());
        }
        if (worker != nullptr && exited) {
            // A throwing 'online' listener must not lose the exit: finish on the next drain.
            if (ok) worker_finish(vm, worker);
            else worker_requeue_exit(owner, thread);
        }
        worker_thread_release(thread);
        return true;
    }
    Endpoint *endpoint = owner->ready_head;
    if (endpoint != nullptr) {
        owner->ready_head = endpoint->ready_next;
        if (owner->ready_head == nullptr) owner->ready_tail = nullptr;
        endpoint->ready_queued = false;
    }
    pthread_mutex_unlock(&owner->mutex);
    if (endpoint == nullptr) return false;
    Channel *channel = endpoint->channel;
    PortRecord *port = iso->ports;
    while (port != nullptr && port->endpoint != endpoint) port = port->next;
    if (port == nullptr || !port->started) {
        // Transferred away or not started: leave the queue for its next owner.
        channel_release(channel);
        return true;
    }
    Message *message = endpoint_pop(endpoint);
    if (message != nullptr) {
        // One message per macrotask; requeue so other sources interleave fairly.
        pthread_mutex_lock(&channel->mutex);
        if (endpoint->count > 0 || endpoint->close_pending) endpoint_notify_locked(endpoint);
        pthread_mutex_unlock(&channel->mutex);
        MalValue values[] = {mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, values, countof(values));
        bool decoded = mal_deserialize_take(vm, message->value, &g_hooks, &values[0]);
        if (decoded) {
            values[1] = transferred_ports(vm, message->value);
            decoded = !thrown(vm);
        }
        if (decoded) {
            port_dispatch(vm, port, "message", values[0], values[1]);
        } else {
            values[0] = vm->completion.value;
            vm->completion.kind = MAL_COMPLETION_NORMAL;
            port_dispatch(vm, port, "messageerror", values[0], mal_value_new_undefined());
        }
        mal_gc_unroot(&root);
        message_free(message);
        channel_release(channel);
        return true;
    }
    pthread_mutex_lock(&channel->mutex);
    bool closing = endpoint->close_pending && !port->closed_emitted;
    pthread_mutex_unlock(&channel->mutex);
    if (closing) {
        // Rooted first: without its endpoint the port is no longer pinned.
        MalValue wrapper = port->wrapper;
        MalRootSpan root;
        mal_gc_root(&root, &wrapper, 1);
        port->closed_emitted = true;
        endpoint_bind(endpoint, nullptr);
        port->endpoint = nullptr;
        port_update_work(vm, port);
        // The record stays linked and branded like a transferred-away port, so later
        // close/ref/start/listener calls are no-ops rather than brand failures;
        // port_finalize frees it with the wrapper.
        port_dispatch(vm, port, "close", mal_value_new_undefined(), mal_value_new_undefined());
        mal_gc_unroot(&root);
        channel_release(channel); // the wrapper's endpoint handle
    }
    channel_release(channel); // the ready-chain reference
    return true;
}

static bool option_u64(MalVm *vm, MalValue options, const char *name, u64 fallback, u64 *out) {
    MalValue value;
    *out = fallback;
    if (!get_named(vm, options, name, &value)) return false;
    if (mal_value_is_undefined(value)) return true;
    f64 number = mal_value_is_int32(value) ? (f64) mal_value_to_i32(value)
        : mal_value_is_f64(value) ? mal_value_to_f64(value) : -1;
    if (!(number >= 1) || number > 9.0e15) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "worker queue limit must be a positive integer");
        return false;
    }
    *out = (u64) number;
    return true;
}

static bool queue_limits(MalVm *vm, MalValue options, u32 *max_count, u64 *max_bytes, u64 *max_message) {
    u64 count;
    if (!option_u64(vm, options, "maxQueuedMessages", WORKERS_DEFAULT_MAX_MESSAGES, &count) ||
        !option_u64(vm, options, "maxQueuedBytes", WORKERS_DEFAULT_MAX_BYTES, max_bytes) ||
        !option_u64(vm, options, "maxMessageBytes", WORKERS_DEFAULT_MAX_MESSAGE_BYTES, max_message)) {
        return false;
    }
    if (count > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "maxQueuedMessages is too large");
        return false;
    }
    *max_count = (u32) count;
    return true;
}

// file://<path> with the WHATWG path percent-encode set (plus the characters Node's
// pathToFileURL escapes), matching the compiler's registry hrefs. Existing escapes in
// a URL input and its query/fragment delimiters are kept; a raw path also escapes
// '%', '#' and '?'. Uppercase hex, as URL emits.
typedef enum UrlSet { URL_SET_PATH, URL_SET_QUERY, URL_SET_FRAGMENT, URL_SET_FILE_PATH } UrlSet;

// WHATWG percent-encode sets for a special (file:) URL; URL_SET_FILE_PATH adds what
// Node's pathToFileURL escapes in a raw filesystem path.
static bool url_escapes(unsigned char c, UrlSet set) {
    if (c <= 0x20 || c >= 0x7f || c == '"' || c == '<' || c == '>') return true;
    switch (set) {
    case URL_SET_FRAGMENT: return c == '`';
    case URL_SET_QUERY: return c == '#' || c == '\'';
    case URL_SET_PATH: return c == '#' || c == '?' || c == '`' || c == '{' || c == '}';
    case URL_SET_FILE_PATH:
        return c == '#' || c == '?' || c == '`' || c == '{' || c == '}' || c == '%' || c == '\\';
    }
    return false;
}

static char *url_append(char *out, const char *text, usize length, UrlSet set) {
    static const char hex[] = "0123456789ABCDEF";
    for (usize i = 0; i < length; i++) {
        unsigned char c = (unsigned char) text[i];
        if (url_escapes(c, set)) {
            *out++ = '%';
            *out++ = hex[c >> 4];
            *out++ = hex[c & 15];
        } else {
            *out++ = (char) c;
        }
    }
    return out;
}

static bool ascii_iequal(const char *text, usize length, const char *expected) {
    if (strlen(expected) != length) return false;
    for (usize i = 0; i < length; i++) {
        if (mal_ascii_to_lower((u8) text[i]) != (u8) expected[i]) return false;
    }
    return true;
}

// 1 for a "." segment, 2 for "..", else 0. URL paths also accept %2e spellings.
static int segment_dots(const char *segment, usize length, bool url) {
    if (length == 1 && segment[0] == '.') return 1;
    if (length == 2 && segment[0] == '.' && segment[1] == '.') return 2;
    if (!url) return 0;
    if (ascii_iequal(segment, length, "%2e")) return 1;
    if (ascii_iequal(segment, length, ".%2e") || ascii_iequal(segment, length, "%2e.") ||
        ascii_iequal(segment, length, "%2e%2e")) return 2;
    return 0;
}

// Remove dot segments from an absolute path in place. URL paths keep empty
// segments and end in '/' after a final dot segment; filesystem paths follow
// path.resolve plus pathToFileURL's trailing-separator rule.
static void path_remove_dots(char *path, bool url) {
    usize total = strlen(path);
    bool trailing_separator = total > 0 && path[total - 1] == '/';
    usize length = 0;
    const char *in = path;
    while (*in == '/') {
        const char *segment = in + 1;
        const char *end = strchr(segment, '/');
        if (end == nullptr) end = segment + strlen(segment);
        usize size = (usize) (end - segment);
        bool last = *end == '\0';
        int dots = segment_dots(segment, size, url);
        if (dots == 2) {
            while (length > 0 && path[--length] != '/') {}
        }
        if (dots != 0 || (!url && size == 0)) {
            if (url && last) path[length++] = '/';
        } else {
            memmove(path + length, in, size + 1);
            length += size + 1;
        }
        in = end;
    }
    if (!url && trailing_separator && (length == 0 || path[length - 1] != '/')) path[length++] = '/';
    if (length == 0) path[length++] = '/';
    path[length] = '\0';
}

// pathToFileURL for an absolute POSIX path.
static char *file_url_from_path(const char *path) {
    char *normalized = strdup(path);
    if (normalized == nullptr) return nullptr;
    path_remove_dots(normalized, false);
    usize length = strlen(normalized);
    char *url = malloc(7 + length * 3 + 1);
    if (url != nullptr) {
        memcpy(url, "file://", 7);
        *url_append(url + 7, normalized, length, URL_SET_FILE_PATH) = '\0';
    }
    free(normalized);
    return url;
}

static usize url_scheme_length(const char *text) {
    if (!mal_ascii_is_alpha((u8) text[0])) return 0;
    usize i = 1;
    while (mal_ascii_is_alphanumeric((u8) text[i]) || text[i] == '+' || text[i] == '-' || text[i] == '.') i++;
    return text[i] == ':' ? i : 0;
}

// `new URL(reference, base).href` restricted to file: results, as the compiler
// computes worker entry hrefs. `base` is null or a canonical file: href. Query and
// fragment stay part of the href, so lookup never silently matches another
// entry's pathname. Null for non-file results, a non-local host, or no base.
static char *file_url_resolve(const char *reference, const char *base) {
    usize start = 0;
    usize end = strlen(reference);
    while (start < end && (u8) reference[start] <= 0x20) start++;
    while (end > start && (u8) reference[end - 1] <= 0x20) end--;
    usize base_length = base != nullptr ? strlen(base) : 0;
    // Room for base + '/' + reference before escaping.
    char *work = malloc(base_length + (end - start) + 2);
    if (work == nullptr) return nullptr;
    usize ref_length = 0;
    char *ref = work + base_length + 1;
    for (usize i = start; i < end; i++) {
        if (reference[i] != '\t' && reference[i] != '\n' && reference[i] != '\r') ref[ref_length++] = reference[i];
    }
    ref[ref_length] = '\0';
    // Special URLs treat '\' as a path separator before any query or fragment.
    for (char *p = ref; *p != '\0' && *p != '?' && *p != '#'; p++) {
        if (*p == '\\') *p = '/';
    }
    usize scheme = url_scheme_length(ref);
    const char *rest = ref;
    if (scheme != 0) {
        if (!ascii_iequal(ref, scheme, "file")) {
            free(work);
            return nullptr;
        }
        rest = ref + scheme + 1;
        // "file:x" is relative to a file base; without one it is "file:///x".
        if (base == nullptr && rest[0] != '/') {
            ref[scheme] = '/';
            rest = ref + scheme;
        }
    } else if (base == nullptr) {
        free(work);
        return nullptr;
    }
    const char *base_path = base != nullptr ? base + 7 : "/";
    if (rest[0] == '/' && rest[1] == '/') {
        const char *host = rest + 2;
        usize host_length = strcspn(host, "/?#");
        if (host_length != 0 && !ascii_iequal(host, host_length, "localhost")) {
            free(work);
            return nullptr;
        }
        rest = host + host_length;
        base_path = "/";
    }
    // Assemble the unescaped path + query + fragment into `work`.
    usize length = 0;
    usize base_path_length = strcspn(base_path, "?#");
    if (rest[0] == '/') {
        memmove(work, rest, strlen(rest) + 1);
    } else if (rest[0] == '\0' || rest[0] == '?' || rest[0] == '#') {
        // A query replaces the base query; an empty reference or a fragment keeps it.
        usize keep = rest[0] == '?' ? base_path_length
            : base_path_length + strcspn(base_path + base_path_length, "#");
        memmove(work + keep, rest, strlen(rest) + 1);
        memcpy(work, base_path, keep);
    } else {
        const char *slash = base_path;
        for (const char *p = base_path; p < base_path + base_path_length; p++) {
            if (*p == '/') slash = p;
        }
        length = (usize) (slash - base_path) + 1;
        memmove(work + length, rest, strlen(rest) + 1);
        memcpy(work, base_path, length);
    }
    if (work[0] != '/') {
        memmove(work + 1, work, strlen(work) + 1);
        work[0] = '/';
    }
    usize path_length = strcspn(work, "?#");
    char *suffix = strdup(work + path_length);
    work[path_length] = '\0';
    char *url = nullptr;
    if (suffix != nullptr) {
        path_remove_dots(work, true);
        url = malloc(7 + (strlen(work) + strlen(suffix)) * 3 + 1);
    }
    if (url != nullptr) {
        memcpy(url, "file://", 7);
        char *out = url_append(url + 7, work, strlen(work), URL_SET_PATH);
        usize query_length = strcspn(suffix, "#");
        if (query_length > 0) {
            *out++ = '?';
            out = url_append(out, suffix + 1, query_length - 1, URL_SET_QUERY);
        }
        if (suffix[query_length] == '#') {
            *out++ = '#';
            out = url_append(out, suffix + query_length + 1, strlen(suffix + query_length + 1),
                URL_SET_FRAGMENT);
        }
        *out = '\0';
    }
    free(suffix);
    free(work);
    return url;
}

static char *canonical_href(MalVm *vm, MalValue specifier) {
    MalValue href = specifier;
    if (mal_value_is_object(specifier)) {
        UrlRecord *url = url_record(specifier);
        if (url != nullptr) return strdup(url->entry->href);
        if (!get_named(vm, specifier, "href", &href)) return nullptr;
    }
    char *text = value_to_cstring(href);
    if (text == nullptr) {
        if (!thrown(vm)) throw_type(vm, "worker entry must be a registered URL or absolute path");
        return nullptr;
    }
    // Node accepts an absolute filesystem path for a file entry (pathToFileURL).
    char *url = text[0] == '/' ? file_url_from_path(text)
        : url_scheme_length(text) != 0 ? file_url_resolve(text, nullptr)
        : nullptr;
    if (url == nullptr) return text;
    free(text);
    return url;
}

static MalValue url_descriptor_for(MalVm *vm, const MalWorkerEntry *entry) {
    Isolate *iso = g_isolate;
    for (UrlRecord *url = iso->urls; url != nullptr; url = url->next) {
        if (url->entry == entry) return url->descriptor;
    }
    UrlRecord *record = calloc(1, sizeof(UrlRecord));
    if (record == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "out of memory");
        return mal_value_new_undefined();
    }
    MalValue descriptor = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &descriptor, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(descriptor), (const byte *) "href",
        str_value(vm, entry->href), MAL_PROPERTY_ENUMERABLE);
    mal_object_set_integrity_level(mal_value_to_object(descriptor), true);
    record->descriptor = descriptor;
    record->entry = entry;
    record->next = iso->urls;
    iso->urls = record;
    mal_gc_unroot(&root);
    return descriptor;
}

// Resolve `specifier` against `base` (file URLs only) and return the registered
// entry's frozen descriptor. Unregistered entries throw: workers are static.
static MalValue create_worker_url(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    char *specifier = argc > 0 ? value_to_cstring(args[0]) : nullptr;
    char *base = argc > 1 ? canonical_href(vm, args[1]) : nullptr;
    if (thrown(vm) || specifier == nullptr) {
        free(specifier);
        free(base);
        if (!thrown(vm)) throw_type(vm, "createWorkerUrl: specifier must be a string");
        return mal_value_new_undefined();
    }
    // A non-file base resolves nothing the compiler could have registered.
    bool file_base = base != nullptr && strncmp(base, "file://", 7) == 0;
    char *resolved = base == nullptr || file_base ? file_url_resolve(specifier, base) : nullptr;
    free(specifier);
    free(base);
    const MalWorkerEntry *entry = resolved != nullptr ? entry_lookup(resolved) : nullptr;
    free(resolved);
    if (entry == nullptr) {
        throw_type(vm, "createWorkerUrl: entry is not a statically registered worker module");
        return mal_value_new_undefined();
    }
    return url_descriptor_for(vm, entry);
}

static MalValue capabilities_function(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalObject *object = mal_value_to_object(result);
    mal_intrinsic_define_data(vm, object, (const byte *) "threads", mal_value_new_boolean(true), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "sharedMemory", mal_value_new_boolean(true), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "parallelism",
        mal_value_from_i32((i32) workers_parallelism()), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, object, (const byte *) "maxWorkers",
        mal_value_from_i32((i32) workers_max()), MAL_PROPERTY_ENUMERABLE);
    mal_object_set_integrity_level(object, true);
    mal_gc_unroot(&root);
    return result;
}

static bool option_named(MalVm *vm, MalValue options, const char *first, const char *second, MalValue *out) {
    if (!get_named(vm, options, first, out)) return false;
    if (mal_value_is_undefined(*out) && second != nullptr) return get_named(vm, options, second, out);
    return true;
}

// new Worker(url, options), raw or Node-flavoured.
static bool option_is_empty_list(MalVm *vm, MalValue value, bool *empty) {
    *empty = mal_value_is_undefined(value);
    if (*empty || !mal_value_is_array_object(value)) return true;
    MalValue length;
    if (!get_named(vm, value, "length", &length)) return false;
    *empty = mal_value_is_int32(length) && mal_value_to_i32(length) == 0;
    return true;
}

// Node options whose effect this runtime cannot provide are rejected, not ignored.
// Neutral defaults (undefined, [], false, a resourceLimits object without limits)
// pass so pools that forward their own defaults keep working.
static bool node_options_supported(MalVm *vm, MalValue options) {
    static const char *const lists[] = {"execArgv", "argv"};
    for (usize i = 0; i < countof(lists); i++) {
        MalValue value;
        bool empty;
        if (!get_named(vm, options, lists[i], &value) || !option_is_empty_list(vm, value, &empty)) return false;
        if (!empty) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                i == 0 ? "Worker execArgv is not supported" : "Worker argv is not supported");
            return false;
        }
    }
    static const char *const flags[] = {"stdin", "stdout", "stderr", "eval"};
    for (usize i = 0; i < countof(flags); i++) {
        MalValue value;
        if (!get_named(vm, options, flags[i], &value)) return false;
        if (mal_value_is_truthy(value)) {
            char message[64];
            snprintf(message, sizeof(message), "Worker option %s is not supported", flags[i]);
            throw_type(vm, message);
            return false;
        }
    }
    MalValue limits;
    if (!get_named(vm, options, "resourceLimits", &limits)) return false;
    static const char *const limit_names[] = {
        "maxOldGenerationSizeMb", "maxYoungGenerationSizeMb", "codeRangeSizeMb", "stackSizeMb"};
    for (usize i = 0; i < countof(limit_names); i++) {
        MalValue value;
        if (!get_named(vm, limits, limit_names[i], &value)) return false;
        if (!mal_value_is_undefined(value)) {
            throw_type(vm, "Worker resourceLimits are not supported");
            return false;
        }
    }
    return true;
}

static MalValue worker_construct(MalVm *vm, const MalValue *args, i32 argc, MalValue new_target, bool node) {
    Isolate *iso = g_isolate;
    if (mal_value_is_undefined(new_target)) {
        throw_type(vm, "Class constructor Worker cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    char *href = canonical_href(vm, argc > 0 ? args[0] : mal_value_new_undefined());
    if (href == nullptr) return mal_value_new_undefined();
    const MalWorkerEntry *entry = entry_lookup(href);
    free(href);
    if (entry == nullptr) {
        throw_type(vm, "Worker entry is not a statically registered worker module");
        return mal_value_new_undefined();
    }
    MalValue data = mal_value_new_undefined();
    MalValue transfer = mal_value_new_undefined();
    MalValue name = mal_value_new_undefined();
    MalValue env = mal_value_new_undefined();
    u32 max_count;
    u64 max_bytes, max_message;
    if (!option_named(vm, options, node ? "workerData" : "data", nullptr, &data) ||
        !option_named(vm, options, node ? "transferList" : "transfer", nullptr, &transfer) ||
        !get_named(vm, options, "name", &name) || !get_named(vm, options, "env", &env) ||
        !queue_limits(vm, options, &max_count, &max_bytes, &max_message) ||
        (node && !node_options_supported(vm, options))) {
        return mal_value_new_undefined();
    }
    if (node && !mal_value_is_undefined(env)) {
        // Each isolate has its own process.env, so neither a copied map nor SHARE_ENV's
        // live sharing can be honored.
        MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE];
        MalValue share = mal_value_new_undefined();
        if (mal_value_is_object(module) && !get_named(vm, module, "SHARE_ENV", &share)) return mal_value_new_undefined();
        throw_type(vm, mal_value_is_symbol(env) && env == share ? "Worker env SHARE_ENV is not supported"
            : "Worker env is not supported");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(transfer) && !mal_value_is_array_object(transfer)) {
        throw_type(vm, "transfer list must be an array");
        return mal_value_new_undefined();
    }
    u32 live = atomic_fetch_add_explicit(&g_live_workers, 1, memory_order_acq_rel);
    if (live >= workers_max()) {
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "worker thread limit reached");
        return mal_value_new_undefined();
    }
    MalSerializeLimits limits = {.max_bytes = max_message, .max_objects = 0};
    const char *error = nullptr;
    MalSerializedValue *snapshot = mal_serialize(vm, data, transfer, &limits, &g_hooks, &error);
    WorkerThread *thread = snapshot != nullptr ? calloc(1, sizeof(WorkerThread)) : nullptr;
    Channel *channel = thread != nullptr ? channel_new(max_count, max_bytes, max_message,
        node ? POST_NODE : POST_TRANSACTIONAL) : nullptr;
    MalSharedWaitInterrupt *interrupt = channel != nullptr ? mal_shared_wait_interrupt_new() : nullptr;
    WorkerRecord *worker = interrupt != nullptr ? calloc(1, sizeof(WorkerRecord)) : nullptr;
    if (worker == nullptr) {
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        if (interrupt != nullptr) mal_shared_wait_interrupt_free(interrupt);
        if (channel != nullptr) {
            channel_release(channel);
            channel_release(channel);
        }
        free(thread);
        if (snapshot != nullptr) {
            mal_serialized_value_release(snapshot);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Worker: out of memory");
        } else if (!thrown(vm)) {
            mal_dom_exception_throw(vm, (const byte *) (error != nullptr ? error : "could not clone workerData"),
                (const byte *) "DataCloneError");
        }
        return mal_value_new_undefined();
    }
    atomic_init(&thread->refcount, 2); // parent record + thread body
    thread->id = atomic_fetch_add_explicit(&g_next_thread_id, 1, memory_order_relaxed);
    thread->entry = entry;
    thread->web_platform = vm->host_web_platform;
    thread->node = vm->host_node;
    thread->name = value_to_cstring(name);
    thread->child_endpoint = &channel->side[1];
    thread->data = snapshot;
    thread->interrupt = interrupt;
    thread->parent = iso->owner;
    owner_retain(iso->owner);
    pthread_mutex_init(&thread->mutex, nullptr);
    pthread_cond_init(&thread->start_cond, nullptr);

    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue proto = node ? iso->node_worker_prototype : iso->worker_prototype;
    roots[0] = mal_value_from_object(&mal_event_target_object_new(&vm->heap, mal_value_to_object(proto))->object);
    roots[1] = port_wrapper_new(vm, &channel->side[0]);
    roots[2] = promise_new(vm);
    roots[3] = promise_new(vm);
    worker->wrapper = roots[0];
    worker->port = roots[1];
    worker->ready = roots[2];
    worker->closed = roots[3];
    worker->terminations = mal_value_new_undefined();
    worker->thread = thread;
    worker->node = node;
    worker->referenced = true;
    worker->next = iso->workers;
    iso->workers = worker;
    PortRecord *port = port_record(roots[1]);
    if (port == nullptr) {
        // port_wrapper_new threw; nothing was spawned or committed.
        worker_unlink(iso, worker);
        channel_close(channel);
        channel_release(channel);
        channel_release(channel);
        owner_release(thread->parent);
        thread->parent = nullptr;
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        worker_thread_release(thread);
        worker_thread_release(thread);
        free(worker);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (node) port_edge_store(port, &port->forward, roots[0]);
    // The parent port starts immediately; Worker events need no explicit start.
    port_start(vm, port);

    pthread_attr_t attributes;
    pthread_attr_init(&attributes);
    pthread_attr_setstacksize(&attributes, WORKERS_STACK_BYTES);
    int spawn = pthread_create(&thread->thread, &attributes, worker_thread_main, thread);
    pthread_attr_destroy(&attributes);
    if (spawn != 0) {
        // Nothing was committed: the transfer list stays attached to the sender.
        worker_unlink(iso, worker);
        port_close_record(vm, port);
        channel_release(channel); // child handle
        owner_release(thread->parent);
        thread->parent = nullptr;
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        worker_thread_release(thread);
        worker_thread_release(thread);
        free(worker->listeners.items);
        free(worker);
        mal_gc_unroot(&root);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not start worker thread");
        return mal_value_new_undefined();
    }
    // Commit transfers before the worker may deserialize, then release the gate.
    bool committed = mal_serialize_commit(vm, snapshot);
    pthread_mutex_lock(&thread->mutex);
    if (!committed) {
        // Uncommitted descriptors hold sender records, so release them here, not on the thread.
        thread->data = nullptr;
        thread->start_cancelled = true;
    }
    thread->start_released = true;
    pthread_cond_signal(&thread->start_cond);
    pthread_mutex_unlock(&thread->mutex);
    if (!committed) {
        // The cancelled thread closes the child side and posts an exit nobody claims.
        pthread_join(thread->thread, nullptr);
        worker_unlink(iso, worker);
        port_close_record(vm, port);
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        worker_thread_release(thread);
        free(worker->listeners.items);
        free(worker);
        error = nullptr;
        mal_serialized_value_validate(vm, snapshot, &error);
        mal_serialized_value_release(snapshot);
        mal_gc_unroot(&root);
        throw_clone_error(vm, error, "could not clone workerData");
        return mal_value_new_undefined();
    }
    worker_update_work(vm, worker);

    MalObject *object = mal_value_to_object(roots[0]);
    if (node) {
        mal_intrinsic_define_data(vm, object, (const byte *) "threadId",
            mal_value_from_i32((i32) thread->id), MAL_PROPERTY_ENUMERABLE);
    } else {
        mal_intrinsic_define_data(vm, object, (const byte *) "id", mal_value_from_i32((i32) thread->id), MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, object, (const byte *) "ready", roots[2], MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, object, (const byte *) "closed", roots[3], MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, object, (const byte *) "port", roots[1], MAL_PROPERTY_ENUMERABLE);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue worker_construct_raw(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    return worker_construct(vm, args, argc, new_target, false);
}

static MalValue worker_construct_node(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    return worker_construct(vm, args, argc, new_target, true);
}

static WorkerRecord *this_worker(MalVm *vm, MalValue receiver) {
    WorkerRecord *worker = worker_record(receiver);
    if (worker == nullptr) throw_type(vm, "receiver is not a live Worker");
    return worker;
}

static MalValue worker_terminate(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    WorkerRecord *worker = worker_record(receiver);
    if (worker != nullptr) {
        worker->referenced = true;
        worker_update_work(vm, worker);
    }
    if (worker != nullptr && !worker->node) {
        // Raw terminate() is idempotent: every call observes the one exit record.
        worker_request_terminate(worker->thread);
        return worker->closed;
    }
    if (worker == nullptr) {
        // Joined: the record is gone but the raw wrapper's immutable `closed` keeps the
        // exit record. A joined Node worker resolves undefined, as Node does after 'exit'.
        MalValue closed;
        if (!get_named(vm, receiver, "closed", &closed)) return mal_value_new_undefined();
        if (mal_value_is_promise_object(closed)) return closed;
        MalValue settled = promise_new(vm);
        mal_promise_fulfill(vm, mal_value_to_promise_object(settled), mal_value_new_undefined());
        return settled;
    }
    MalValue promise = promise_new(vm);
    MalRootSpan root;
    mal_gc_root(&root, &promise, 1);
    if (!mal_value_is_object(worker->terminations)) {
        worker->terminations = mal_value_from_object(&mal_array_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]))->object);
    }
    MalValue length_value;
    i32 length = 0;
    if (get_named(vm, worker->terminations, "length", &length_value) && mal_value_is_int32(length_value)) {
        length = mal_value_to_i32(length_value);
    }
    mal_vm_set_property(vm, worker->terminations, mal_key_index((u32) length), promise, worker->terminations);
    worker_request_terminate(worker->thread);
    mal_gc_unroot(&root);
    return promise;
}

static MalValue worker_post_message(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    WorkerRecord *worker = this_worker(vm, receiver);
    if (worker == nullptr) return mal_value_new_undefined();
    PortRecord *port = port_record(worker->port);
    if (port == nullptr || port->endpoint == nullptr) return mal_value_new_undefined();
    MalValue transfer = transfer_argument(vm, args, argc);
    if (thrown(vm)) return mal_value_new_undefined();
    endpoint_post(vm, port, argc > 0 ? args[0] : mal_value_new_undefined(), transfer);
    return mal_value_new_undefined();
}

static MalValue worker_set_referenced(MalVm *vm, MalValue receiver, bool referenced) {
    WorkerRecord *worker = worker_record(receiver);
    if (worker == nullptr) return receiver;
    worker->referenced = referenced;
    PortRecord *port = port_record(worker->port);
    if (port != nullptr) {
        port->referenced = referenced;
        port_update_work(vm, port);
    }
    worker_update_work(vm, worker);
    return receiver;
}

static MalValue worker_ref(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return worker_set_referenced(vm, receiver, true);
}

static MalValue worker_unref(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target; (void) callee;
    return worker_set_referenced(vm, receiver, false);
}

static MalValue worker_has_ref(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) new_target; (void) callee;
    WorkerRecord *worker = worker_record(receiver);
    return mal_value_new_boolean(worker != nullptr && worker->holds_work);
}

static MalValue define_constructor(MalVm *vm, const char *name, i32 arity, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) name), arity, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(value), (const byte *) "prototype", prototype, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype), (const byte *) "constructor", value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return value;
}

static void define_method(MalVm *vm, MalObject *object, const char *name, i32 arity,
    MalNativeFunctionCallback callback) {
    mal_intrinsic_define_method_n(vm, object, (const byte *) name, arity, callback);
}

static void define_emitter_methods(MalVm *vm, MalObject *prototype) {
    define_method(vm, prototype, "on", 2, emitter_on);
    define_method(vm, prototype, "addListener", 2, emitter_on);
    define_method(vm, prototype, "once", 2, emitter_once);
    define_method(vm, prototype, "prependListener", 2, emitter_prepend);
    define_method(vm, prototype, "prependOnceListener", 2, emitter_prepend_once);
    define_method(vm, prototype, "off", 2, emitter_remove);
    define_method(vm, prototype, "removeListener", 2, emitter_remove);
    define_method(vm, prototype, "removeAllListeners", 1, emitter_remove_all);
    define_method(vm, prototype, "emit", 1, emitter_emit);
    define_method(vm, prototype, "listenerCount", 1, emitter_listener_count);
}

static MalValue prototype_new(MalVm *vm) {
    MalValue event_target = vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE];
    MalObject *parent = mal_value_is_object(event_target) ? mal_value_to_object(event_target)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    return mal_value_from_object(mal_object_new(&vm->heap, parent));
}

static void workers_cleanup(MalVm *vm) {
    mal_workers_shutdown(vm);
}

static void define_port_methods(MalVm *vm, MalObject *prototype, PostingPolicy posting_policy) {
    define_method(vm, prototype, "postMessage", 1, port_post_message);
    if (posting_policy == POST_TRANSACTIONAL) define_method(vm, prototype, "_discard", 1, port_discard_method);
    define_method(vm, prototype, "start", 0, port_start_method);
    define_method(vm, prototype, "close", 0, port_close_method);
    define_method(vm, prototype, "ref", 0, port_ref_method);
    define_method(vm, prototype, "unref", 0, port_unref_method);
    define_method(vm, prototype, "hasRef", 0, port_has_ref_method);
    define_emitter_methods(vm, prototype);
    mal_intrinsic_define_accessor_n(vm, prototype, name_key(vm, "onmessage"),
        (const byte *) "get onmessage", 0, port_onmessage_get,
        (const byte *) "set onmessage", 1, port_onmessage_set,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_accessor_n(vm, prototype, name_key(vm, "onmessageerror"),
        (const byte *) "get onmessageerror", 0, port_onmessageerror_get,
        (const byte *) "set onmessageerror", 1, port_onmessageerror_set,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

bool mal_workers_install(MalVm *vm) {
    if (g_isolate != nullptr) return true;
    MalHost *host = mal_host(vm);
    if (host == nullptr) return false;
    // Ports and workers are EventTargets even when no personality installed events.
    mal_runtime_events_ensure(vm);
    Isolate *iso = calloc(1, sizeof(Isolate));
    Owner *owner = owner_new(&host->reactor);
    if (iso == nullptr || owner == nullptr || !mal_vm_register_runtime_cleanup(vm, workers_cleanup)) {
        free(iso);
        owner_release(owner);
        return false;
    }
    iso->vm = vm;
    iso->owner = owner;
    MalValue undefined = mal_value_new_undefined();
    iso->port_prototype = iso->worker_prototype = iso->node_worker_prototype = undefined;
    iso->node_port_prototype = iso->node_port_constructor = iso->node_channel_constructor = undefined;
    iso->port_constructor = iso->channel_constructor = iso->worker_constructor = undefined;
    iso->node_worker_constructor = iso->receive_function = iso->capabilities_function = undefined;
    iso->create_url_function = undefined;
    iso->parent_port = mal_value_new_null();
    iso->worker_data = undefined;
    iso->uncloneable = undefined;
    iso->self = g_self_thread;
    g_isolate = iso;
    mal_gc_register_root_source(workers_scan_roots, nullptr);
    mal_host_register_macrotask_drain(workers_drain, false);

    iso->port_prototype = prototype_new(vm);
    define_port_methods(vm, mal_value_to_object(iso->port_prototype), POST_TRANSACTIONAL);
    iso->node_port_prototype = prototype_new(vm);
    define_port_methods(vm, mal_value_to_object(iso->node_port_prototype), POST_NODE);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    iso->port_constructor = define_constructor(vm, "MessagePort", 0, new_message_port_illegal, iso->port_prototype);
    iso->node_port_constructor = define_constructor(vm, "MessagePort", 0, new_message_port_illegal, iso->node_port_prototype);
    MalValue channel_prototype = mal_value_from_object(mal_intrinsic_new_object(vm));
    iso->worker_prototype = channel_prototype; // rooted until replaced below
    iso->channel_constructor = define_constructor(vm, "MessageChannel", 0, channel_construct, channel_prototype);
    channel_prototype = mal_value_from_object(mal_intrinsic_new_object(vm));
    iso->worker_prototype = channel_prototype;
    iso->node_channel_constructor = define_constructor(vm, "MessageChannel", 0, node_channel_construct, channel_prototype);

    iso->worker_prototype = prototype_new(vm);
    MalObject *worker_proto = mal_value_to_object(iso->worker_prototype);
    mal_intrinsic_define_method_n(vm, worker_proto, (const byte *) "terminate", 0, worker_terminate);
    define_method(vm, worker_proto, "ref", 0, worker_ref);
    define_method(vm, worker_proto, "unref", 0, worker_unref);
    mal_intrinsic_define_method_n(vm, worker_proto, (const byte *) "hasRef", 0, worker_has_ref);
    iso->worker_constructor = define_constructor(vm, "Worker", 1, worker_construct_raw, iso->worker_prototype);

    iso->node_worker_prototype = prototype_new(vm);
    MalObject *node_proto = mal_value_to_object(iso->node_worker_prototype);
    mal_intrinsic_define_method_n(vm, node_proto, (const byte *) "terminate", 0, worker_terminate);
    mal_intrinsic_define_method_n(vm, node_proto, (const byte *) "postMessage", 1, worker_post_message);
    define_method(vm, node_proto, "ref", 0, worker_ref);
    define_method(vm, node_proto, "unref", 0, worker_unref);
    mal_intrinsic_define_method_n(vm, node_proto, (const byte *) "hasRef", 0, worker_has_ref);
    define_emitter_methods(vm, node_proto);
    iso->node_worker_constructor = define_constructor(vm, "Worker", 1, worker_construct_node, iso->node_worker_prototype);

    iso->receive_function = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "receiveMessageOnPort"), 1,
        receive_message_on_port));
    iso->capabilities_function = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "capabilities"), 0,
        capabilities_function));
    iso->create_url_function = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, (const byte *) "createWorkerUrl"), 2,
        create_worker_url));

    if (iso->self != nullptr) {
        Endpoint *endpoint = iso->self->child_endpoint;
        iso->self->child_endpoint = nullptr;
        iso->parent_port = port_wrapper_new(vm, endpoint);
    }
    return true;
}

MalValue mal_workers_worker_data(MalVm *vm) {
    Isolate *iso = g_isolate;
    if (iso == nullptr || iso->worker_data_ready) return iso != nullptr ? iso->worker_data : mal_value_new_undefined();
    iso->worker_data_ready = true;
    if (iso->self == nullptr || iso->self->data == nullptr) {
        iso->worker_data = mal_value_new_null();
        return iso->worker_data;
    }
    MalValue value = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    if (!mal_deserialize_take(vm, iso->self->data, &g_hooks, &value)) value = mal_value_new_undefined();
    else mal_workers_adopt_transferred(vm, iso->self->data);
    mal_serialized_value_release(iso->self->data);
    iso->self->data = nullptr;
    iso->worker_data = value;
    mal_gc_unroot(&root);
    return value;
}

MalValue mal_workers_parent_port(MalVm *vm) {
    (void) vm;
    return g_isolate != nullptr ? g_isolate->parent_port : mal_value_new_null();
}

MalValue mal_workers_node_worker_constructor(MalVm *vm) {
    (void) vm;
    return g_isolate != nullptr ? g_isolate->node_worker_constructor : mal_value_new_undefined();
}

MalValue mal_workers_node_message_channel_constructor(MalVm *vm) {
    (void) vm;
    return g_isolate != nullptr ? g_isolate->node_channel_constructor : mal_value_new_undefined();
}

MalValue mal_workers_node_message_port_constructor(MalVm *vm) {
    (void) vm;
    return g_isolate != nullptr ? g_isolate->node_port_constructor : mal_value_new_undefined();
}

MalValue mal_workers_receive_message_function(MalVm *vm) {
    (void) vm;
    return g_isolate != nullptr ? g_isolate->receive_function : mal_value_new_undefined();
}

void mal_workers_shutdown(MalVm *vm) {
    Isolate *iso = g_isolate;
    if (iso == nullptr) return;
    // Children first: terminate, then join each (their final posts may race the
    // mailbox teardown below and only drop references).
    for (WorkerRecord *worker = iso->workers; worker != nullptr; worker = worker->next) {
        worker_request_terminate(worker->thread);
    }
    while (iso->workers != nullptr) {
        WorkerRecord *worker = iso->workers;
        iso->workers = worker->next;
        pthread_join(worker->thread->thread, nullptr);
        atomic_fetch_sub_explicit(&g_live_workers, 1, memory_order_acq_rel);
        if (worker->holds_work) mal_reactor_release_work(isolate_reactor(vm));
        worker_thread_release(worker->thread);
        free(worker->listeners.items);
        free(worker);
    }
    Owner *owner = iso->owner;
    pthread_mutex_lock(&owner->mutex);
    owner->reactor = nullptr;
    Endpoint *ready = owner->ready_head;
    WorkerThread *events = owner->events_head;
    owner->ready_head = owner->ready_tail = nullptr;
    owner->events_head = nullptr;
    pthread_mutex_unlock(&owner->mutex);
    while (ready != nullptr) {
        Endpoint *next = ready->ready_next;
        ready->ready_queued = false;
        channel_release(ready->channel);
        ready = next;
    }
    while (events != nullptr) {
        WorkerThread *next = events->event_next;
        worker_thread_release(events);
        events = next;
    }
    while (iso->ports != nullptr) {
        PortRecord *port = iso->ports;
        iso->ports = port->next;
        if (port->endpoint != nullptr) {
            Channel *channel = port->endpoint->channel;
            channel_close(channel);
            endpoint_bind(port->endpoint, nullptr);
            channel_release(channel);
        }
        if (port->holds_work) mal_reactor_release_work(isolate_reactor(vm));
        // The heap outlives this state; its teardown finalizers must not reach the record.
        port_detach_wrapper(port);
        port_record_release(port);
    }
    while (iso->urls != nullptr) {
        UrlRecord *url = iso->urls;
        iso->urls = url->next;
        free(url);
    }
    owner_release(owner);
    g_isolate = nullptr;
    free(iso);
}

static MalValue worker_fail_current(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    if (!mal_workers_exit_current(vm, 1)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "No current worker to fail");
    }
    return mal_value_new_undefined();
}

void mal_host_install_maligator_internal_workers(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    // The public pool cancels tasks with AbortController even on a minimal host, where
    // an earlier lazy events ensure may have built the classes without global names.
    if (!vm->host_web_platform && !vm->host_node) mal_runtime_events_install_globals(vm);
    if (thrown(vm)) return;
    if (!mal_workers_install(vm)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "maligator:workers requires a host event loop");
        return;
    }
    Isolate *iso = g_isolate;
    for (i32 i = 0; i < count; i++) {
        const char *name = slots[i].name;
        MalValue value = mal_value_new_undefined();
        if (strcmp(name, "Worker") == 0) value = iso->worker_constructor;
        else if (strcmp(name, "MessageChannel") == 0) value = iso->channel_constructor;
        else if (strcmp(name, "MessagePort") == 0) value = iso->port_constructor;
        else if (strcmp(name, "receiveMessageOnPort") == 0) value = iso->receive_function;
        else if (strcmp(name, "capabilities") == 0) value = iso->capabilities_function;
        else if (strcmp(name, "createWorkerUrl") == 0) value = iso->create_url_function;
        else if (strcmp(name, "parentPort") == 0) value = iso->parent_port;
        else if (strcmp(name, "workerData") == 0) value = mal_workers_worker_data(vm);
        else if (strcmp(name, "failCurrent") == 0) {
            value = mal_value_from_native_function_object(mal_native_function_object_new_arity(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) "failCurrent"), 0, worker_fail_current));
        }
        else if (strcmp(name, "poolEntry") == 0) {
            const MalWorkerEntry *entry = g_pool_entry != nullptr ? entry_lookup(g_pool_entry) : nullptr;
            value = entry != nullptr ? url_descriptor_for(vm, entry) : mal_value_new_null();
        }
        if (thrown(vm)) return;
        vm->globals[slots[i].slot] = value;
    }
}
