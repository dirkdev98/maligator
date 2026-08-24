#include "promise_object.h"

#include <stdint.h>
#include <stdlib.h>

#include "async_context.h"
#include "gc.h"
#include "microtask.h"
#include "vm.h"

#define MAL_PROMISE_REACTION_POOL_LIMIT 4096
#define MAL_PROMISE_REACTION_BLOCK_SIZE 32768

static inline MalValue mal_promise_await_reaction_tag(void) {
    return mal_value_from_i32(INT32_MIN);
}

static inline MalValue mal_promise_async_generator_return_reaction_tag(void) {
    return mal_value_from_i32(INT32_MIN + 1);
}

static inline MalValue mal_promise_async_from_sync_reaction_tag(
    bool done,
    bool close_on_rejection
) {
    i32 flags = (done ? 1 : 0) | (close_on_rejection ? 2 : 0);
    return mal_value_from_i32(INT32_MIN + 2 + flags);
}

static bool mal_promise_is_async_from_sync_reaction_tag(
    MalValue value,
    bool *done,
    bool *close_on_rejection
) {
    if (!mal_value_is_int32(value)) {
        return false;
    }
    i32 tag = mal_value_to_i32(value);
    if (tag < INT32_MIN + 2 || tag > INT32_MIN + 5) {
        return false;
    }
    i32 flags = tag - (INT32_MIN + 2);
    *done = (flags & 1) != 0;
    *close_on_rejection = (flags & 2) != 0;
    return true;
}

struct MalPromiseReactionBlock {
    MalPromiseReactionBlock *next;
    MalPromiseReaction *free_list;
    u32 next_unused;
    u32 live_count;
    MalPromiseReaction reactions[];
};

static_assert(
    (MAL_PROMISE_REACTION_BLOCK_SIZE & (MAL_PROMISE_REACTION_BLOCK_SIZE - 1)) == 0,
    "Promise reaction block size must be a power of two");

#define MAL_PROMISE_REACTIONS_PER_BLOCK \
    ((u32) ((MAL_PROMISE_REACTION_BLOCK_SIZE - sizeof(MalPromiseReactionBlock)) / \
            sizeof(MalPromiseReaction)))

static bool mal_promise_reaction_block_has_capacity(const MalPromiseReactionBlock *block) {
    return block->free_list != nullptr || block->next_unused < MAL_PROMISE_REACTIONS_PER_BLOCK;
}

static MalPromiseReaction *mal_promise_allocate_reaction(MalVm *vm) {
    MalPromiseReactionBlock *block = vm->reaction_active_block;
    if (block == nullptr || !mal_promise_reaction_block_has_capacity(block)) {
        for (block = vm->reaction_blocks; block != nullptr; block = block->next) {
            if (mal_promise_reaction_block_has_capacity(block)) {
                break;
            }
        }
        if (block == nullptr) {
            block = aligned_alloc(
                MAL_PROMISE_REACTION_BLOCK_SIZE, MAL_PROMISE_REACTION_BLOCK_SIZE);
            block->next = vm->reaction_blocks;
            block->free_list = nullptr;
            block->next_unused = 0;
            block->live_count = 0;
            vm->reaction_blocks = block;
        }
        vm->reaction_active_block = block;
    }

    MalPromiseReaction *reaction;
    if (block->free_list != nullptr) {
        reaction = block->free_list;
        block->free_list = reaction->next;
    } else {
        reaction = &block->reactions[block->next_unused++];
    }
    block->live_count++;
    return reaction;
}

static void mal_promise_release_reaction(MalVm *vm, MalPromiseReaction *reaction) {
    MalPromiseReactionBlock *block = (MalPromiseReactionBlock *) (
        (uintptr_t) reaction & ~((uintptr_t) MAL_PROMISE_REACTION_BLOCK_SIZE - 1));
    reaction->next = block->free_list;
    block->free_list = reaction;
    block->live_count--;
    vm->reaction_active_block = block;
    if (block->live_count != 0) {
        return;
    }

    MalPromiseReactionBlock **link = &vm->reaction_blocks;
    while (*link != block) {
        link = &(*link)->next;
    }
    *link = block->next;
    vm->reaction_active_block = nullptr;
    free(block);
}

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

static void mal_promise_append_reaction_internal(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    MalPromiseReaction *reaction = vm->reaction_pool;
    if (reaction == nullptr) {
        reaction = mal_promise_allocate_reaction(vm);
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
#if MAL_NODE
    reaction->async_context = mal_async_context_capture(vm);
#endif

    if (promise->reactions_tail == nullptr) {
        promise->reactions_head = reaction;
    } else {
        promise->reactions_tail->next = reaction;
    }
    promise->reactions_tail = reaction;

    // Old promise gaining young refs: remember it so a minor collection traces
    // the native reaction list through the managed promise.
    mal_gc_card(&promise->object.header, on_fulfilled);
    mal_gc_card(&promise->object.header, on_rejected);
    mal_gc_card(&promise->object.header, cap_resolve);
    mal_gc_card(&promise->object.header, cap_reject);
#if MAL_NODE
    mal_gc_card(
        &promise->object.header,
        mal_async_internal_value((MalHeapHeader *) reaction->async_context));
#endif
}

void mal_promise_append_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
) {
    mal_promise_append_reaction_internal(
        vm, promise, on_fulfilled, on_rejected, cap_resolve, cap_reject);
}

void mal_promise_append_await_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue state
) {
    mal_promise_append_reaction_internal(
        vm,
        promise,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_promise_await_reaction_tag(),
        state);
}

void mal_promise_append_async_generator_return_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue generator,
    MalValue realm_anchor
) {
    mal_promise_append_reaction_internal(
        vm,
        promise,
        realm_anchor,
        mal_value_new_undefined(),
        mal_promise_async_generator_return_reaction_tag(),
        generator);
}

void mal_promise_append_async_from_sync_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue sync_iterator,
    MalValue result_promise,
    MalValue realm_anchor,
    bool done,
    bool close_on_rejection
) {
    mal_promise_append_reaction_internal(
        vm,
        promise,
        result_promise,
        realm_anchor,
        mal_promise_async_from_sync_reaction_tag(done, close_on_rejection),
        sync_iterator);
}

/** Free a pending reaction list without scheduling it. */
void mal_promise_free_reactions(MalVm *vm, MalPromiseReaction *list) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        mal_gc_write_barrier(list->on_fulfilled);
        mal_gc_write_barrier(list->on_rejected);
        mal_gc_write_barrier(list->cap_resolve);
        mal_gc_write_barrier(list->cap_reject);
#if MAL_NODE
        mal_gc_write_barrier(
            mal_async_internal_value((MalHeapHeader *) list->async_context));
#endif
        list->on_fulfilled = mal_value_new_undefined();
        list->on_rejected = mal_value_new_undefined();
        list->cap_resolve = mal_value_new_undefined();
        list->cap_reject = mal_value_new_undefined();
#if MAL_NODE
        list->async_context = nullptr;
#endif
        mal_promise_release_reaction(vm, list);
        list = next;
    }
}

/** Recycle a reaction whose outgoing edges were shaded before list detachment. */
static void mal_promise_recycle_barriered_reaction(
    MalVm *vm, MalPromiseReaction *reaction
) {
    reaction->on_fulfilled = mal_value_new_undefined();
    reaction->on_rejected = mal_value_new_undefined();
    reaction->cap_resolve = mal_value_new_undefined();
    reaction->cap_reject = mal_value_new_undefined();
#if MAL_NODE
    reaction->async_context = nullptr;
#endif

    if (vm->reaction_pool_count >= MAL_PROMISE_REACTION_POOL_LIMIT) {
        mal_promise_release_reaction(vm, reaction);
        return;
    }
    reaction->next = vm->reaction_pool;
    vm->reaction_pool = reaction;
    vm->reaction_pool_count++;
}

void mal_promise_free_reaction_pool(MalVm *vm) {
    MalPromiseReactionBlock *block = vm->reaction_blocks;
    while (block != nullptr) {
        MalPromiseReactionBlock *next = block->next;
        free(block);
        block = next;
    }
    vm->reaction_pool = nullptr;
    vm->reaction_pool_count = 0;
    vm->reaction_blocks = nullptr;
    vm->reaction_active_block = nullptr;
}

static void mal_promise_barrier_reactions(MalPromiseReaction *reaction) {
    for (; reaction != nullptr; reaction = reaction->next) {
        mal_gc_write_barrier(reaction->on_fulfilled);
        mal_gc_write_barrier(reaction->on_rejected);
        mal_gc_write_barrier(reaction->cap_resolve);
        mal_gc_write_barrier(reaction->cap_reject);
#if MAL_NODE
        mal_gc_write_barrier(
            mal_async_internal_value((MalHeapHeader *) reaction->async_context));
#endif
    }
}

/** Enqueue a reaction job per reaction, then free the list. */
static void mal_promise_trigger_reactions(MalVm *vm, MalPromiseReaction *list, bool is_reject, MalValue argument) {
    while (list != nullptr) {
        MalPromiseReaction *next = list->next;
        if (list->cap_resolve == mal_promise_await_reaction_tag()) {
#if MAL_NODE
            mal_vm_enqueue_await_job_in_context(
                vm, list->cap_reject, is_reject, argument, list->async_context);
#else
            mal_vm_enqueue_await_job(vm, list->cap_reject, is_reject, argument);
#endif
        } else if (list->cap_resolve == mal_promise_async_generator_return_reaction_tag()) {
#if MAL_NODE
            mal_vm_enqueue_async_generator_return_job_in_context(
                vm,
                list->cap_reject,
                list->on_fulfilled,
                is_reject,
                argument,
                list->async_context);
#else
            mal_vm_enqueue_async_generator_return_job(
                vm,
                list->cap_reject,
                list->on_fulfilled,
                is_reject,
                argument);
#endif
        } else {
            bool done;
            bool close_on_rejection;
            if (mal_promise_is_async_from_sync_reaction_tag(
                    list->cap_resolve, &done, &close_on_rejection)) {
#if MAL_NODE
                mal_vm_enqueue_async_from_sync_job_in_context(
                    vm,
                    list->cap_reject,
                    list->on_fulfilled,
                    list->on_rejected,
                    done,
                    close_on_rejection,
                    is_reject,
                    argument,
                    list->async_context);
#else
                mal_vm_enqueue_async_from_sync_job(
                    vm,
                    list->cap_reject,
                    list->on_fulfilled,
                    list->on_rejected,
                    done,
                    close_on_rejection,
                    is_reject,
                    argument);
#endif
            } else {
                MalValue handler = is_reject ? list->on_rejected : list->on_fulfilled;
#if MAL_NODE
                mal_vm_enqueue_reaction_job_in_context(
                    vm, handler, is_reject, list->cap_resolve, list->cap_reject,
                    argument, list->async_context);
#else
                mal_vm_enqueue_reaction_job(
                    vm, handler, is_reject, list->cap_resolve, list->cap_reject, argument);
#endif
            }
        }
        mal_promise_recycle_barriered_reaction(vm, list);
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
