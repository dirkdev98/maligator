#include "promise_object.h"

#include <stdlib.h>

#include "gc.h"
#include "microtask.h"
#include "vm.h"

MalPromiseObject *mal_promise_object_new(MalHeap *heap, MalObject *prototype) {
    MalPromiseObject *promise = mal_heap_alloc(heap, sizeof(MalPromiseObject), MAL_HEAP_PROMISE_OBJECT);
    mal_object_init(heap, &promise->object, MAL_HEAP_PROMISE_OBJECT, prototype);
    promise->state = MAL_PROMISE_PENDING;
    promise->is_handled = false;
    promise->result = mal_value_new_undefined();
    promise->fulfill_reactions = nullptr;
    promise->reject_reactions = nullptr;
    promise->async_owner = nullptr;

    return promise;
}

void mal_promise_append_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    bool on_reject,
    MalValue handler,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    MalPromiseReaction *reaction = malloc(sizeof(MalPromiseReaction));
    mal_promise_note_reaction_allocation();
    reaction->next = nullptr;
    reaction->handler = handler;
    reaction->cap_resolve = cap_resolve;
    reaction->cap_reject = cap_reject;

    // Append at the tail so reactions fire in registration order.
    MalPromiseReaction **list = on_reject ? &promise->reject_reactions : &promise->fulfill_reactions;
    while (*list != nullptr) {
        list = &(*list)->next;
    }
    *list = reaction;

    // Old promise gaining a reaction with young handler/capability refs: remember
    // it so the minor collector traces its reaction lists (trace_cell walks them).
    mal_gc_card(&promise->object.header, handler);
    mal_gc_card(&promise->object.header, cap_resolve);
    mal_gc_card(&promise->object.header, cap_reject);
}

/** Free a reaction list without scheduling it (the discarded-on-settle list). */
void mal_promise_free_reactions(MalPromiseReaction *list) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        // SATB: settling discards the opposite-outcome reactions; their handler /
        // capability refs (traced via the promise) are dropped from the heap graph,
        // so shade them. Inert when this runs from the promise finalizer (marking is
        // inactive during sweep).
        mal_gc_write_barrier(list->handler);
        mal_gc_write_barrier(list->cap_resolve);
        mal_gc_write_barrier(list->cap_reject);
        free(list);
        list = next;
    }
}

/** Enqueue a reaction job per reaction, then free the list. */
static void mal_promise_trigger_reactions(MalVm *vm, MalPromiseReaction *list, bool is_reject, MalValue argument) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        mal_vm_enqueue_reaction_job(vm, list->handler, is_reject, list->cap_resolve, list->cap_reject, argument);
        free(list);
        list = next;
    }
}

void mal_promise_fulfill(MalVm *vm, MalPromiseObject *promise, MalValue value) {
    if (promise->state != MAL_PROMISE_PENDING) {
        return;
    }

    promise->result = value;
    mal_gc_card(&promise->object.header, value); // old promise -> young result
    promise->state = MAL_PROMISE_FULFILLED;

    MalPromiseReaction *fulfill = promise->fulfill_reactions;
    promise->fulfill_reactions = nullptr;
    mal_promise_free_reactions(promise->reject_reactions);
    promise->reject_reactions = nullptr;

    mal_promise_trigger_reactions(vm, fulfill, false, value);
}

void mal_promise_reject(MalVm *vm, MalPromiseObject *promise, MalValue reason) {
    if (promise->state != MAL_PROMISE_PENDING) {
        return;
    }

    promise->result = reason;
    mal_gc_card(&promise->object.header, reason); // old promise -> young result
    promise->state = MAL_PROMISE_REJECTED;

    MalPromiseReaction *reject = promise->reject_reactions;
    promise->reject_reactions = nullptr;
    mal_promise_free_reactions(promise->fulfill_reactions);
    promise->fulfill_reactions = nullptr;

    // A promise that rejects with no handler attached is a candidate unhandled
    // rejection; the microtask checkpoint re-checks is_handled before reporting.
    if (!promise->is_handled) {
        mal_vm_note_unhandled_rejection(vm, mal_value_from_promise_object(promise));
    }

    mal_promise_trigger_reactions(vm, reject, true, reason);
}
