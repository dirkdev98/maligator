#include "builtin_async_generator.h"

#include <stdlib.h>

#include "builtin_eval.h"
#include "builtin_iterator.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static MalCompletion mal_agen_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

/** Detach and free the front request, returning its fields (or false if none). */
static bool mal_agen_dequeue(MalGeneratorObject *agen, MalValue *out_resolve, MalValue *out_reject, i32 *out_mode, MalValue *out_value) {
    MalAsyncGeneratorRequest *req = agen->agen_queue_head;
    if (req == nullptr) {
        return false;
    }
    agen->agen_queue_head = req->next;
    if (agen->agen_queue_head == nullptr) {
        agen->agen_queue_tail = nullptr;
    }
    *out_resolve = req->resolve;
    *out_reject = req->reject;
    *out_mode = req->mode;
    *out_value = req->value;
    // SATB: the request node (traced via the async generator) is freed here; its
    // settle capability + resume value are dropped from the heap graph, so shade
    // them before the node goes away. Folds out off-cycle.
    mal_gc_write_barrier(req->resolve);
    mal_gc_write_barrier(req->reject);
    mal_gc_write_barrier(req->value);
    free(req);
    return true;
}

static void mal_agen_settle_resolve(MalVm *vm, MalValue resolve, MalValue value) {
    vm->completion = mal_agen_normal();
    mal_vm_call_value(vm, resolve, mal_value_new_undefined(), &value, 1);
    vm->completion = mal_agen_normal();
}

void mal_async_generator_resume_next(MalVm *vm, MalGeneratorObject *agen) {
    if (agen->agen_running) {
        return;
    }

    while (agen->agen_queue_head != nullptr) {
        // return()/throw() on a not-yet-started generator completes it.
        if (agen->state == MAL_GENERATOR_SUSPENDED_START && agen->agen_queue_head->mode != MAL_GENERATOR_RESUME_NEXT) {
            agen->state = MAL_GENERATOR_COMPLETED;
        }

        if (agen->state == MAL_GENERATOR_COMPLETED) {
            MalValue resolve;
            MalValue reject;
            i32 mode;
            MalValue value;
            mal_agen_dequeue(agen, &resolve, &reject, &mode, &value);
            if (mode == MAL_GENERATOR_RESUME_THROW) {
                vm->completion = mal_agen_normal();
                mal_vm_call_value(vm, reject, mal_value_new_undefined(), &value, 1);
                vm->completion = mal_agen_normal();
            } else {
                // next() on a done generator yields { undefined, true }; return()
                // yields { value, true }.
                MalValue result = mal_vm_create_iter_result(vm, mode == MAL_GENERATOR_RESUME_RETURN ? value : mal_value_new_undefined(), true);
                mal_agen_settle_resolve(vm, resolve, result);
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

    MalValue resolve;
    MalValue reject;
    i32 mode;
    MalValue value;
    if (mal_agen_dequeue(agen, &resolve, &reject, &mode, &value)) {
        MalValue result = mal_vm_create_iter_result(vm, agen->yielded_value, false);
        mal_agen_settle_resolve(vm, resolve, result);
    }

    mal_async_generator_resume_next(vm, agen);
}

void mal_async_generator_return(MalVm *vm, MalGeneratorObject *agen, MalValue value) {
    agen->state = MAL_GENERATOR_COMPLETED;
    agen->agen_running = false;

    MalValue resolve;
    MalValue reject;
    i32 mode;
    MalValue request_value;
    if (mal_agen_dequeue(agen, &resolve, &reject, &mode, &request_value)) {
        MalValue result = mal_vm_create_iter_result(vm, value, true);
        mal_agen_settle_resolve(vm, resolve, result);
    }

    mal_async_generator_resume_next(vm, agen);
}

void mal_async_generator_throw_done(MalVm *vm, MalGeneratorObject *agen, MalValue reason) {
    agen->state = MAL_GENERATOR_COMPLETED;
    agen->agen_running = false;

    MalValue resolve;
    MalValue reject;
    i32 mode;
    MalValue request_value;
    if (mal_agen_dequeue(agen, &resolve, &reject, &mode, &request_value)) {
        vm->completion = mal_agen_normal();
        mal_vm_call_value(vm, reject, mal_value_new_undefined(), &reason, 1);
        vm->completion = mal_agen_normal();
    }

    mal_async_generator_resume_next(vm, agen);
}

// --- Prototype methods -------------------------------------------------------

static MalValue mal_agen_enqueue_and_drive(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, i32 mode) {
    MalValue cap_promise;
    MalValue cap_resolve;
    MalValue cap_reject;
    if (!mal_promise_new_capability(vm, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], &cap_promise, &cap_resolve, &cap_reject)) {
        return mal_value_new_undefined();
    }

    // A non-async-generator receiver rejects the returned promise (not throws).
    if (!mal_value_is_generator_object(this_value) || !((MalGeneratorObject *) mal_value_to_heap(this_value))->is_async_generator) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an async generator");
        MalValue error = vm->completion.value;
        vm->completion = mal_agen_normal();
        mal_vm_call_value(vm, cap_reject, mal_value_new_undefined(), &error, 1);
        vm->completion = mal_agen_normal();
        return cap_promise;
    }

    MalGeneratorObject *agen = (MalGeneratorObject *) mal_value_to_heap(this_value);

    MalAsyncGeneratorRequest *request = malloc(sizeof(MalAsyncGeneratorRequest));
    request->next = nullptr;
    request->resolve = cap_resolve;
    request->reject = cap_reject;
    request->mode = mode;
    request->value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    if (agen->agen_queue_tail == nullptr) {
        agen->agen_queue_head = request;
    } else {
        agen->agen_queue_tail->next = request;
    }
    agen->agen_queue_tail = request;
    // An old async generator gaining a queued request with young capability/value
    // refs: remember it so the minor traces its request queue (trace walks it).
    mal_gc_remember_if_old(&agen->object.header);

    mal_async_generator_resume_next(vm, agen);
    return cap_promise;
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
    (void) new_target;
    (void) callee;
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_construct_function(
        vm, args, arg_count, MAL_DYNAMIC_FUNCTION_ASYNC_GENERATOR);
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
    (void) new_target;
    (void) callee;
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_construct_function(vm, args, arg_count, MAL_DYNAMIC_FUNCTION_ASYNC);
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
