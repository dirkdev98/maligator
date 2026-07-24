#include "builtin_async_generator.h"

#include <stdlib.h>

#include "builtin_eval.h"
#include "builtin_iterator.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "object.h"
#include "perf_stats.h"
#include "promise_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

#define MAL_ASYNC_GENERATOR_REQUEST_POOL_LIMIT 4096

static u64 g_request_allocations = 0;
static u64 g_request_reuses = 0;

u64 mal_async_generator_request_allocation_count(void) {
    return g_request_allocations;
}

u64 mal_async_generator_request_reuse_count(void) {
    return g_request_reuses;
}

static MalAsyncGeneratorRequest *mal_agen_request_new(MalVm *vm) {
    MalAsyncGeneratorRequest *request = vm->async_generator_request_pool;
    if (request == nullptr) {
        request = malloc(sizeof(MalAsyncGeneratorRequest));
        g_request_allocations++;
    } else {
        vm->async_generator_request_pool = request->next;
        vm->async_generator_request_pool_count--;
        g_request_reuses++;
    }
    request->next = nullptr;
    return request;
}

static void mal_agen_request_recycle(MalVm *vm, MalAsyncGeneratorRequest *request) {
    mal_gc_write_barrier(request->promise);
    mal_gc_write_barrier(request->promise_constructor);
    mal_gc_write_barrier(request->value);
    request->promise = mal_value_new_undefined();
    request->promise_constructor = mal_value_new_undefined();
    request->value = mal_value_new_undefined();
    request->mode = MAL_GENERATOR_RESUME_NEXT;

    if (vm->async_generator_request_pool_count >= MAL_ASYNC_GENERATOR_REQUEST_POOL_LIMIT) {
        free(request);
        return;
    }
    request->next = vm->async_generator_request_pool;
    vm->async_generator_request_pool = request;
    vm->async_generator_request_pool_count++;
}

void mal_async_generator_free_requests(MalVm *vm, MalAsyncGeneratorRequest *request) {
    while (request != nullptr) {
        MalAsyncGeneratorRequest *next = request->next;
        mal_agen_request_recycle(vm, request);
        request = next;
    }
}

void mal_async_generator_free_request_pool(MalVm *vm) {
    MalAsyncGeneratorRequest *request = vm->async_generator_request_pool;
    while (request != nullptr) {
        MalAsyncGeneratorRequest *next = request->next;
        free(request);
        request = next;
    }
    vm->async_generator_request_pool = nullptr;
    vm->async_generator_request_pool_count = 0;
}

static MalCompletion mal_agen_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

/** Detach and free the front request, returning its fields (or false if none). */
static bool mal_agen_dequeue(
    MalVm *vm,
    MalGeneratorObject *agen,
    MalValue *out_promise,
    MalValue *out_promise_constructor,
    i32 *out_mode,
    MalValue *out_value
) {
    MalAsyncGeneratorRequest *req = agen->agen_queue_head;
    if (req == nullptr) {
        return false;
    }
    agen->agen_queue_head = req->next;
    if (agen->agen_queue_head == nullptr) {
        agen->agen_queue_tail = nullptr;
    }
    *out_promise = req->promise;
    *out_promise_constructor = req->promise_constructor;
    *out_mode = req->mode;
    *out_value = req->value;
    mal_agen_request_recycle(vm, req);
    return true;
}

static void mal_agen_settle(
    MalVm *vm,
    MalValue promise,
    MalValue promise_constructor,
    bool is_reject,
    MalValue value
) {
    MalValue roots[3] = {promise, promise_constructor, value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    vm->completion = mal_agen_normal();
    mal_promise_settle_direct(
        vm,
        roots[0],
        roots[1],
        is_reject,
        roots[2]);
    vm->completion = mal_agen_normal();
    mal_gc_unroot(&span);
}

static void mal_agen_resolve_result(
    MalVm *vm,
    MalValue promise,
    MalValue promise_constructor,
    MalValue value,
    bool done
) {
    MalValue roots[3] = {promise, promise_constructor, value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalValue result = mal_vm_create_iter_result(vm, roots[2], done);
    mal_agen_settle(vm, roots[0], roots[1], false, result);
    mal_gc_unroot(&span);
}

/** Await the front return completion without removing it from the FIFO queue. */
static void mal_agen_await_return(MalVm *vm, MalGeneratorObject *agen) {
    MalValue promise;
    if (!mal_promise_resolve_value(vm, agen->agen_queue_head->value, &promise)) {
        MalValue error = vm->completion.value;
        vm->completion = mal_agen_normal();
        agen->agen_running = false;

        MalValue request_promise;
        MalValue promise_constructor;
        i32 mode;
        MalValue request_value;
        mal_agen_dequeue(
            vm,
            agen,
            &request_promise,
            &promise_constructor,
            &mode,
            &request_value);
        mal_agen_settle(vm, request_promise, promise_constructor, true, error);
        mal_async_generator_resume_next(vm, agen);
        return;
    }

    // This is the runtime's draining-queue state: later requests remain queued
    // until the typed Promise reaction completes this return request.
    agen->agen_running = true;
    mal_promise_perform_async_generator_return(vm, promise, agen);
}

void mal_async_generator_await_return_complete(
    MalVm *vm,
    MalGeneratorObject *agen,
    bool is_reject,
    MalValue value
) {
    agen->agen_running = false;

    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue request_value;
    if (mal_agen_dequeue(
            vm, agen, &promise, &promise_constructor, &mode, &request_value)) {
        if (is_reject) {
            mal_agen_settle(vm, promise, promise_constructor, true, value);
        } else {
            mal_agen_resolve_result(vm, promise, promise_constructor, value, true);
        }
    }

    mal_async_generator_resume_next(vm, agen);
}

void mal_async_generator_resume_next(MalVm *vm, MalGeneratorObject *agen) {
    if (agen->agen_running) {
        return;
    }

    while (agen->agen_queue_head != nullptr) {
        // return()/throw() on a not-yet-started generator completes it.
        if (agen->state == MAL_GENERATOR_SUSPENDED_START && agen->agen_queue_head->mode != MAL_GENERATOR_RESUME_NEXT) {
            mal_generator_release_frame(vm, agen);
            agen->state = MAL_GENERATOR_COMPLETED;
        }

        if (agen->state == MAL_GENERATOR_COMPLETED) {
            if (agen->agen_queue_head->mode == MAL_GENERATOR_RESUME_RETURN) {
                mal_agen_await_return(vm, agen);
                return;
            }

            MalValue promise;
            MalValue promise_constructor;
            i32 mode;
            MalValue value;
            mal_agen_dequeue(
                vm, agen, &promise, &promise_constructor, &mode, &value);
            if (mode == MAL_GENERATOR_RESUME_THROW) {
                mal_agen_settle(vm, promise, promise_constructor, true, value);
            } else {
                // next() on a done generator yields { undefined, true }.
                mal_agen_resolve_result(
                    vm,
                    promise,
                    promise_constructor,
                    mal_value_new_undefined(),
                    true);
            }
            continue;
        }

        // Run the body for the front request. It either suspends at an await
        // (agen_running stays true; a microtask resumes it and a later yield/
        // return/throw settles this request) or settles synchronously through
        // the yield/return/throw hooks below (which recurse into resume_next).
        agen->agen_running = true;
        mal_vm_resume_generator(vm, agen, agen->agen_queue_head->value, agen->agen_queue_head->mode);
        return;
    }
}

void mal_async_generator_yield(MalVm *vm, MalGeneratorObject *agen) {
    agen->agen_running = false;

    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue value;
    if (mal_agen_dequeue(
            vm, agen, &promise, &promise_constructor, &mode, &value)) {
        mal_agen_resolve_result(
            vm, promise, promise_constructor, agen->yielded_value, false);
    }

    mal_async_generator_resume_next(vm, agen);
}

void mal_async_generator_return(MalVm *vm, MalGeneratorObject *agen, MalValue value) {
    agen->state = MAL_GENERATOR_COMPLETED;
    agen->agen_running = false;

    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue request_value;
    if (mal_agen_dequeue(
            vm, agen, &promise, &promise_constructor, &mode, &request_value)) {
        mal_agen_resolve_result(vm, promise, promise_constructor, value, true);
    }

    mal_async_generator_resume_next(vm, agen);
}

void mal_async_generator_throw_done(MalVm *vm, MalGeneratorObject *agen, MalValue reason) {
    agen->state = MAL_GENERATOR_COMPLETED;
    agen->agen_running = false;

    MalValue promise;
    MalValue promise_constructor;
    i32 mode;
    MalValue request_value;
    if (mal_agen_dequeue(
            vm, agen, &promise, &promise_constructor, &mode, &request_value)) {
        mal_agen_settle(vm, promise, promise_constructor, true, reason);
    }

    mal_async_generator_resume_next(vm, agen);
}

// --- Prototype methods -------------------------------------------------------

static MalValue mal_agen_enqueue_and_drive(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, i32 mode) {
    MalValue promise_constructor =
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
    MalPromiseObject *promise = mal_promise_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);
    MalRootSpan promise_root;
    mal_gc_root(&promise_root, &promise_value, 1);
    MAL_PERF_COUNT(promise_async_generator_direct_requests);

    // A non-async-generator receiver rejects the returned promise (not throws).
    if (!mal_value_is_generator_object(this_value) || !((MalGeneratorObject *) mal_value_to_heap(this_value))->is_async_generator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an async generator");
        MalValue error = vm->completion.value;
        mal_agen_settle(vm, promise_value, promise_constructor, true, error);
        mal_gc_unroot(&promise_root);
        return promise_value;
    }

    MalGeneratorObject *agen = (MalGeneratorObject *) mal_value_to_heap(this_value);

    MalAsyncGeneratorRequest *request = mal_agen_request_new(vm);
    request->promise = promise_value;
    request->promise_constructor = promise_constructor;
    request->mode = mode;
    request->value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    if (agen->agen_queue_tail == nullptr) {
        agen->agen_queue_head = request;
    } else {
        agen->agen_queue_tail->next = request;
    }
    agen->agen_queue_tail = request;
    // An old async generator gaining a queued request with young Promise,
    // constructor, or value refs: remember it so the minor traces the queue.
    mal_gc_remember_if_old(&agen->object.header);

    mal_async_generator_resume_next(vm, agen);
    mal_gc_unroot(&promise_root);
    return promise_value;
}

static MalValue mal_agen_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_agen_enqueue_and_drive(vm, this_value, args, arg_count, MAL_GENERATOR_RESUME_NEXT);
}

static MalValue mal_agen_throw(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_agen_enqueue_and_drive(vm, this_value, args, arg_count, MAL_GENERATOR_RESUME_THROW);
}

static MalValue mal_agen_return(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_agen_enqueue_and_drive(vm, this_value, args, arg_count, MAL_GENERATOR_RESUME_RETURN);
}

static MalValue mal_agen_async_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return this_value;
}

// The AsyncGeneratorFunction constructor: assembles
// `(async function* anonymous(...){...})` and compiles it through the
// dynamic-function path, producing an async generator function with the proper
// %AsyncGeneratorFunction.prototype% wiring.
static MalValue mal_agen_function_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_construct_function(
        vm, args, arg_count, MAL_DYNAMIC_FUNCTION_ASYNC_GENERATOR, new_target, callee);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&args_span);
    return result;
}

static MalValue mal_async_iterator_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) callee;
    // Abstract: only constructable as a subclass super().
    if (mal_value_is_undefined(new_target) || new_target == vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR]) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Abstract class AsyncIterator not directly constructable");
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

// The AsyncFunction constructor: assembles `(async function anonymous(...){...})`
// and compiles it through the dynamic-function path, producing an async function
// with the proper %AsyncFunction.prototype% wiring.
static MalValue mal_async_function_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_construct_function(
        vm, args, arg_count, MAL_DYNAMIC_FUNCTION_ASYNC, new_target, callee);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&args_span);
    return result;
}

static void mal_agen_define_tag(MalVm *vm, MalObject *object, const byte *tag) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &desc);
}

void mal_builtin_async_generator_install(MalVm *vm) {
    // %AsyncIteratorPrototype%: [Symbol.asyncIterator]() { return this }.
    MalObject *async_iterator_prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE] = mal_value_from_object(async_iterator_prototype);
    mal_intrinsic_define_symbol_method(vm, async_iterator_prototype, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR, "[Symbol.asyncIterator]", mal_agen_async_iterator);

    // %AsyncIterator% global (abstract constructor), with AsyncIterator.prototype.
    MalNativeFunctionObject *async_iterator = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "AsyncIterator"),
        0,
        mal_async_iterator_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR] = mal_value_from_native_function_object(async_iterator);
    mal_intrinsic_define_data(vm, (MalObject *) async_iterator, "prototype", mal_value_from_object(async_iterator_prototype), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, async_iterator_prototype, "constructor", mal_value_from_native_function_object(async_iterator), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_agen_define_tag(vm, async_iterator_prototype, "AsyncIterator");

    // %AsyncGeneratorPrototype%: next/throw/return, inheriting %AsyncIteratorPrototype%.
    MalObject *prototype = mal_object_new(&vm->heap, async_iterator_prototype);
    vm->intrinsics[MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE] = mal_value_from_object(prototype);
    mal_intrinsic_define_method_n(vm, prototype, "next", 1, mal_agen_next);
    mal_intrinsic_define_method_n(vm, prototype, "throw", 1, mal_agen_throw);
    mal_intrinsic_define_method_n(vm, prototype, "return", 1, mal_agen_return);
    mal_agen_define_tag(vm, prototype, "AsyncGenerator");

    // %AsyncGenerator% (=AsyncGeneratorFunction.prototype), inheriting %Function.prototype%.
    MalObject *async_generator = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE] = mal_value_from_object(async_generator);
    mal_agen_define_tag(vm, async_generator, "AsyncGeneratorFunction");
    mal_intrinsic_define_data(vm, async_generator, "prototype", mal_value_from_object(prototype), MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", mal_value_from_object(async_generator), MAL_PROPERTY_CONFIGURABLE);

    // %AsyncGeneratorFunction% constructor (inherits %Function%, length 1). Its
    // `prototype` (%AsyncGeneratorFunction.prototype%) is non-configurable.
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, "AsyncGeneratorFunction"),
        1,
        mal_agen_function_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", mal_value_from_object(async_generator), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, async_generator, "constructor", mal_value_from_native_function_object(constructor), MAL_PROPERTY_CONFIGURABLE);

    // %AsyncFunction.prototype% / %AsyncFunction%: the [[Prototype]] of ordinary
    // async functions. No methods — async functions are not iterators.
    MalObject *async_function_prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE] = mal_value_from_object(async_function_prototype);
    mal_agen_define_tag(vm, async_function_prototype, "AsyncFunction");

    // %AsyncFunction% constructor (inherits %Function%, length 1). Its
    // `prototype` (%AsyncFunction.prototype%) is non-configurable.
    MalNativeFunctionObject *async_function = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, "AsyncFunction"),
        1,
        mal_async_function_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_ASYNC_FUNCTION_CONSTRUCTOR] = mal_value_from_native_function_object(async_function);
    mal_intrinsic_define_data(vm, (MalObject *) async_function, "prototype", mal_value_from_object(async_function_prototype), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, async_function_prototype, "constructor", mal_value_from_native_function_object(async_function), MAL_PROPERTY_CONFIGURABLE);
}
