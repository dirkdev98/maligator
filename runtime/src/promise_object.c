#include "promise_object.h"

#include <stdlib.h>

#include "gc.h"
#include "microtask.h"
#include "vm.h"

#define MAL_PROMISE_REACTION_POOL_LIMIT 4096

MalPromiseObject *mal_promise_object_new(MalHeap *heap, MalObject *prototype) {
    MalPromiseObject *promise = mal_heap_alloc(heap, sizeof(MalPromiseObject), MAL_HEAP_PROMISE_OBJECT);
    mal_object_init(heap, &promise->object, MAL_HEAP_PROMISE_OBJECT, prototype);
    promise->state = MAL_PROMISE_PENDING;
    promise->is_handled = false;
    promise->result = mal_value_new_undefined();
    promise->reactions_head = nullptr;
    promise->reactions_tail = nullptr;
    promise->async_owner = nullptr;

    return promise;
}

void mal_promise_append_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    MalPromiseReaction *reaction = vm->reaction_pool;
    if (reaction == nullptr) {
        reaction = malloc(sizeof(MalPromiseReaction));
        mal_promise_note_reaction_allocation();
    } else {
        vm->reaction_pool = reaction->next;
        vm->reaction_pool_count--;
        mal_promise_note_reaction_reuse();
    }
    reaction->next = nullptr;
    reaction->cap_resolve = cap_resolve;
    reaction->cap_reject = cap_reject;
    reaction->on_fulfilled = on_fulfilled;
    reaction->on_rejected = on_rejected;

    if (promise->reactions_tail == nullptr) {
        promise->reactions_head = reaction;
    } else {
        promise->reactions_tail->next = reaction;
    }
    promise->reactions_tail = reaction;

    // Old promise gaining young refs: remember it so a minor collection traces
    // the malloc-owned list through the managed promise.
    mal_gc_card(&promise->object.header, on_fulfilled);
    mal_gc_card(&promise->object.header, on_rejected);
    mal_gc_card(&promise->object.header, cap_resolve);
    mal_gc_card(&promise->object.header, cap_reject);
}

/** Free a reaction list without scheduling it (the discarded-on-settle list). */
void mal_promise_free_reactions(MalPromiseReaction *list) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        mal_gc_write_barrier(list->on_fulfilled);
        mal_gc_write_barrier(list->on_rejected);
        mal_gc_write_barrier(list->cap_resolve);
        mal_gc_write_barrier(list->cap_reject);
        free(list);
        list = next;
    }
}

static void mal_promise_recycle_reaction(MalVm *vm, MalPromiseReaction *reaction) {
    mal_gc_write_barrier(reaction->on_fulfilled);
    mal_gc_write_barrier(reaction->on_rejected);
    mal_gc_write_barrier(reaction->cap_resolve);
    mal_gc_write_barrier(reaction->cap_reject);
    reaction->on_fulfilled = mal_value_new_undefined();
    reaction->on_rejected = mal_value_new_undefined();
    reaction->cap_resolve = mal_value_new_undefined();
    reaction->cap_reject = mal_value_new_undefined();

    if (vm->reaction_pool_count >= MAL_PROMISE_REACTION_POOL_LIMIT) {
        free(reaction);
        return;
    }
    reaction->next = vm->reaction_pool;
    vm->reaction_pool = reaction;
    vm->reaction_pool_count++;
}

void mal_promise_free_reaction_pool(MalVm *vm) {
    MalPromiseReaction *reaction = vm->reaction_pool;
    while (reaction != nullptr) {
        MalPromiseReaction *next = reaction->next;
        free(reaction);
        reaction = next;
    }
    vm->reaction_pool = nullptr;
    vm->reaction_pool_count = 0;
}

static void mal_promise_barrier_reactions(MalPromiseReaction *reaction) {
    for (; reaction != nullptr; reaction = reaction->next) {
        mal_gc_write_barrier(reaction->on_fulfilled);
        mal_gc_write_barrier(reaction->on_rejected);
        mal_gc_write_barrier(reaction->cap_resolve);
        mal_gc_write_barrier(reaction->cap_reject);
    }
}

/** Enqueue a reaction job per reaction, then free the list. */
static void mal_promise_trigger_reactions(MalVm *vm, MalPromiseReaction *list, bool is_reject, MalValue argument) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        MalValue handler = is_reject ? list->on_rejected : list->on_fulfilled;
        mal_vm_enqueue_reaction_job(
            vm, handler, is_reject, list->cap_resolve, list->cap_reject, argument);
        mal_promise_recycle_reaction(vm, list);
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

    MalPromiseReaction *reactions = promise->reactions_head;
    mal_promise_barrier_reactions(reactions);
    promise->reactions_head = nullptr;
    promise->reactions_tail = nullptr;
    mal_promise_trigger_reactions(vm, reactions, false, value);
}

void mal_promise_reject(MalVm *vm, MalPromiseObject *promise, MalValue reason) {
    if (promise->state != MAL_PROMISE_PENDING) {
        return;
    }

    promise->result = reason;
    mal_gc_card(&promise->object.header, reason); // old promise -> young result
    promise->state = MAL_PROMISE_REJECTED;

    MalPromiseReaction *reactions = promise->reactions_head;
    mal_promise_barrier_reactions(reactions);
    promise->reactions_head = nullptr;
    promise->reactions_tail = nullptr;

    // A promise that rejects with no handler attached is a candidate unhandled
    // rejection; the microtask checkpoint re-checks is_handled before reporting.
    if (!promise->is_handled) {
        mal_vm_note_unhandled_rejection(vm, mal_value_from_promise_object(promise));
    }

    mal_promise_trigger_reactions(vm, reactions, true, reason);
}
