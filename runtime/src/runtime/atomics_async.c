#include "atomics_async.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

#include "builtin_atomics.h"
#include "function_object.h"
#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "promise_object.h"
#include "shared_memory.h"
#include "value_ops.h"
#include "vm.h"
#include "web_host_timer.h"

typedef struct AtomicsAsyncMailbox AtomicsAsyncMailbox;

// Owner-thread record for one pending waitAsync. `promise` is rooted by the
// isolate's root source until the record is settled.
typedef struct AtomicsAsyncRecord {
    struct AtomicsAsyncRecord *prev;
    struct AtomicsAsyncRecord *next;
    // Mailbox ready chain; written under the mailbox lock.
    struct AtomicsAsyncRecord *ready_next;
    AtomicsAsyncMailbox *mailbox;
    MalSharedAsyncWaiter *waiter;
    MalValue promise;
    // Owner-local id the timeout callback resolves through `pending`, so a
    // late timer never touches a record a notify already settled and freed.
    u64 id;
    // Unreferenced host timer for a finite timeout (0 = none). Like Node, a
    // pending waitAsync deadline never keeps the event loop alive by itself.
    i64 timer_id;
} AtomicsAsyncRecord;

// Shared between the owner and notifying threads. Each enqueued waiter holds
// one reference, so a notify racing teardown still has a live lock to post to.
struct AtomicsAsyncMailbox {
    _Atomic(u32) refcount;
    pthread_mutex_t lock;
    AtomicsAsyncRecord *ready_head;
    AtomicsAsyncRecord *ready_tail;
    // Cleared under `lock` at teardown; posts then only drop references.
    MalReactor *reactor;
};

typedef struct {
    AtomicsAsyncMailbox *mailbox;
    AtomicsAsyncRecord *pending;
    u64 next_id;
} AtomicsAsyncOwner;

static MAL_ISOLATE_LOCAL AtomicsAsyncOwner *g_owner;

static void mailbox_release(AtomicsAsyncMailbox *mailbox) {
    if (atomic_fetch_sub_explicit(&mailbox->refcount, 1, memory_order_acq_rel) != 1) {
        return;
    }
    pthread_mutex_destroy(&mailbox->lock);
    free(mailbox);
}

static void mailbox_push_ready(AtomicsAsyncMailbox *mailbox, AtomicsAsyncRecord *record) {
    record->ready_next = nullptr;
    if (mailbox->ready_tail != nullptr) {
        mailbox->ready_tail->ready_next = record;
    } else {
        mailbox->ready_head = record;
    }
    mailbox->ready_tail = record;
}

// MalSharedAsyncPost: runs on the notifying thread with no table lock held.
static void atomics_async_post(void *owner, MalSharedAsyncWaiter *waiter) {
    AtomicsAsyncMailbox *mailbox = owner;
    AtomicsAsyncRecord *record = (AtomicsAsyncRecord *) (uintptr_t) mal_shared_async_waiter_cookie(waiter);
    pthread_mutex_lock(&mailbox->lock);
    // After teardown cleared the reactor the record is already freed; only the
    // references below remain to drop.
    if (mailbox->reactor != nullptr) {
        mailbox_push_ready(mailbox, record);
        mal_reactor_wake(mailbox->reactor);
    }
    pthread_mutex_unlock(&mailbox->lock);
    // The owner's own reference keeps the waiter readable until it drains.
    mal_shared_async_waiter_release(waiter);
    mailbox_release(mailbox);
}

static void owner_unlink(AtomicsAsyncOwner *owner, AtomicsAsyncRecord *record) {
    if (record->prev != nullptr) {
        record->prev->next = record->next;
    } else {
        owner->pending = record->next;
    }
    if (record->next != nullptr) {
        record->next->prev = record->prev;
    }
}

static void atomics_async_settle(
    MalVm *vm, AtomicsAsyncOwner *owner, AtomicsAsyncRecord *record, MalSharedWaitResult result) {
    // Allocate while the record still roots the promise.
    MalValue text = mal_value_from_string(
        mal_intrinsic_ascii(vm, result == MAL_SHARED_WAIT_OK ? "ok" : "timed-out"));
    MalValue values[2] = {record->promise, text};
    MalRootSpan span;
    mal_gc_root(&span, values, 2);
    owner_unlink(owner, record);
    mal_shared_async_waiter_release(record->waiter);
    free(record);
    mal_promise_fulfill(vm, mal_value_to_promise_object(values[0]), values[1]);
    mal_gc_unroot(&span);
}

static bool atomics_async_drain(MalVm *vm) {
    AtomicsAsyncOwner *owner = g_owner;
    if (owner == nullptr) {
        return false;
    }
    AtomicsAsyncMailbox *mailbox = owner->mailbox;
    pthread_mutex_lock(&mailbox->lock);
    AtomicsAsyncRecord *record = mailbox->ready_head;
    if (record != nullptr) {
        mailbox->ready_head = record->ready_next;
        if (mailbox->ready_head == nullptr) {
            mailbox->ready_tail = nullptr;
        }
    }
    pthread_mutex_unlock(&mailbox->lock);
    if (record == nullptr) {
        return false;
    }
    if (record->timer_id != 0) {
        mal_host_clear_timeout(vm, record->timer_id);
    }
    atomics_async_settle(vm, owner, record, mal_shared_async_waiter_result(record->waiter));
    return true;
}

// Unreferenced host-timer callback: owner mutator, macrotask phase.
static MalValue atomics_async_timeout(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    AtomicsAsyncOwner *owner = g_owner;
    if (owner == nullptr) {
        return mal_value_new_undefined();
    }
    u64 id = (u64) mal_ops_number_as_f64(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    AtomicsAsyncRecord *record = owner->pending;
    while (record != nullptr && record->id != id) {
        record = record->next;
    }
    if (record == nullptr) {
        return mal_value_new_undefined();
    }
    record->timer_id = 0;
    // False means a notify won: its post is queued and the drain settles "ok".
    if (mal_shared_async_waiter_cancel(record->waiter, MAL_SHARED_WAIT_TIMED_OUT)) {
        // No post will arrive; drop the waiter's mailbox reference here.
        mailbox_release(owner->mailbox);
        atomics_async_settle(vm, owner, record, MAL_SHARED_WAIT_TIMED_OUT);
    }
    return mal_value_new_undefined();
}

static void atomics_async_scan_roots(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    if (g_owner == nullptr) {
        return;
    }
    for (AtomicsAsyncRecord *record = g_owner->pending; record != nullptr; record = record->next) {
        mal_gc_mark_value(record->promise);
    }
}

static bool atomics_async_wait(
    MalVm *vm, MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    f64 timeout_ms, MalSharedWaitResult *out_result, MalValue *out_promise) {
    AtomicsAsyncOwner *owner = g_owner;
    MalHost *host = mal_host(vm);
    if (owner == nullptr || host == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics.waitAsync: no event loop on this agent");
        return false;
    }
    AtomicsAsyncRecord *record = calloc(1, sizeof(AtomicsAsyncRecord));
    if (record == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Atomics.waitAsync: out of memory");
        return false;
    }
    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    record->promise = mal_value_from_promise_object(promise);
    record->mailbox = owner->mailbox;
    record->id = ++owner->next_id;
    // Link before enqueueing so the promise is rooted the moment a notify could
    // make the record reachable only through the mailbox.
    record->next = owner->pending;
    if (owner->pending != nullptr) {
        owner->pending->prev = record;
    }
    owner->pending = record;
    atomic_fetch_add_explicit(&owner->mailbox->refcount, 1, memory_order_relaxed);
    record->waiter = mal_shared_memory_wait_async(
        memory, offset, width, expected, atomics_async_post, owner->mailbox,
        (u64) (uintptr_t) record, out_result);
    if (record->waiter == nullptr) {
        mailbox_release(owner->mailbox);
        owner_unlink(owner, record);
        free(record);
        if (*out_result != MAL_SHARED_WAIT_NOT_EQUAL) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Atomics.waitAsync: out of memory");
            return false;
        }
        return true;
    }
    if (timeout_ms < 9.0e12) {
        MalValue callback[2] = {mal_value_new_undefined(), mal_ops_number_value((f64) record->id)};
        MalRootSpan span;
        mal_gc_root(&span, callback, 2);
        MalString *name = mal_intrinsic_ascii(vm, "");
        callback[0] = mal_value_from_string(name);
        callback[0] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            name, atomics_async_timeout, &callback[1], 1));
        record->timer_id = mal_host_set_timeout(vm, callback[0], (i64) ceil(timeout_ms), nullptr, 0);
        mal_gc_unroot(&span);
        mal_host_timer_set_referenced(vm, record->timer_id, false);
    }
    *out_promise = record->promise;
    return true;
}

static void atomics_async_free(MalVm *vm) {
    AtomicsAsyncOwner *owner = g_owner;
    if (owner == nullptr) {
        return;
    }
    AtomicsAsyncMailbox *mailbox = owner->mailbox;
    MalHost *host = mal_host(vm);
    mal_atomics_set_wait_async_hook(nullptr);
    // Stop deliveries first: a post that loses the race below sees no reactor
    // and only drops its references.
    pthread_mutex_lock(&mailbox->lock);
    mailbox->reactor = nullptr;
    mailbox->ready_head = nullptr;
    mailbox->ready_tail = nullptr;
    pthread_mutex_unlock(&mailbox->lock);
    AtomicsAsyncRecord *record = owner->pending;
    while (record != nullptr) {
        AtomicsAsyncRecord *next = record->next;
        if (record->timer_id != 0 && host != nullptr) {
            mal_host_clear_timeout(vm, record->timer_id);
        }
        if (mal_shared_async_waiter_cancel(record->waiter, MAL_SHARED_WAIT_INTERRUPTED)) {
            mailbox_release(mailbox);
        }
        mal_shared_async_waiter_release(record->waiter);
        free(record);
        record = next;
    }
    mailbox_release(mailbox);
    free(owner);
    g_owner = nullptr;
}

bool mal_atomics_async_install(MalVm *vm) {
    if (g_owner != nullptr) {
        return true;
    }
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        return false;
    }
    AtomicsAsyncOwner *owner = calloc(1, sizeof(AtomicsAsyncOwner));
    AtomicsAsyncMailbox *mailbox = calloc(1, sizeof(AtomicsAsyncMailbox));
    if (owner == nullptr || mailbox == nullptr) {
        free(owner);
        free(mailbox);
        return false;
    }
    atomic_init(&mailbox->refcount, 1);
    pthread_mutex_init(&mailbox->lock, nullptr);
    mailbox->reactor = &host->reactor;
    owner->mailbox = mailbox;
    if (!mal_vm_register_runtime_cleanup(vm, atomics_async_free)) {
        pthread_mutex_destroy(&mailbox->lock);
        free(mailbox);
        free(owner);
        return false;
    }
    g_owner = owner;
    mal_gc_register_root_source(atomics_async_scan_roots, nullptr);
    mal_host_register_macrotask_drain(atomics_async_drain, false);
    mal_atomics_set_wait_async_hook(atomics_async_wait);
    return true;
}
