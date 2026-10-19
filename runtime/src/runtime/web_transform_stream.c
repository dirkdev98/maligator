#include "web_transform_stream.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_data_view.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "array_object.h"
#include "array_buffer_object.h"
#include "ascii.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "text_buffer.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"
#include "web_readable_stream_object.h"
#if MAL_NODE
#include "mal_zlib.h"
#endif

enum {
    TS_ALGORITHM_JS,
    TS_ALGORITHM_ENCODE,
    TS_ALGORITHM_DECODE,
    TS_ALGORITHM_COMPRESS,
    TS_ALGORITHM_DECOMPRESS,
};

#define TS_VISIBLE (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static bool ts_throwing(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

static MalValue ts_take_throw(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    return error;
}

static MalKey ts_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static MalReadableStreamObject *ts_cell(MalValue value, MalReadableStreamKind kind) {
    if (!mal_value_is_readable_stream_object(value)) return nullptr;
    MalReadableStreamObject *cell = mal_value_to_readable_stream_object(value);
    return cell->kind == kind ? cell : nullptr;
}

static MalReadableStreamObject *ts_require(MalVm *vm, MalValue value, MalReadableStreamKind kind, const char *message) {
    MalReadableStreamObject *cell = ts_cell(value, kind);
    if (cell == nullptr) mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
    return cell;
}

static MalReadableStreamObject *ts_new_cell(MalVm *vm, MalReadableStreamKind kind, MalObject *prototype) {
    MalReadableStreamObject *object = mal_heap_alloc(
        &vm->heap, sizeof(MalReadableStreamObject), MAL_HEAP_READABLE_STREAM_OBJECT);
    mal_object_init(&vm->heap, &object->object, MAL_HEAP_READABLE_STREAM_OBJECT, prototype);
    object->kind = kind;
    memset(&object->as, 0, sizeof object->as);
    MalValue undefined = mal_value_new_undefined();
    if (kind == MAL_TRANSFORM_STREAM) {
        object->as.transform = (typeof(object->as.transform)) {
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, false,
        };
    } else if (kind == MAL_TRANSFORM_STREAM_DEFAULT_CONTROLLER) {
        object->as.transform_controller.stream = undefined;
        object->as.transform_controller.transformer = undefined;
        object->as.transform_controller.transform_method = undefined;
        object->as.transform_controller.flush_method = undefined;
        object->as.transform_controller.cancel_method = undefined;
        object->as.transform_controller.finish_promise = undefined;
        object->as.transform_controller.helper = undefined;
    } else {
        object->as.transform_wrapper.transform = undefined;
        object->as.transform_wrapper.helper = undefined;
    }
    return object;
}

static MalValue ts_promise(MalVm *vm) {
    return mal_value_from_promise_object(mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
}

static void ts_resolve(MalVm *vm, MalValue promise, MalValue value) {
    if (mal_value_to_promise_object(promise)->state != MAL_PROMISE_PENDING) return;
    mal_promise_settle_direct(vm, promise, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], false, value);
}

static void ts_reject(MalVm *vm, MalValue promise, MalValue reason) {
    if (mal_value_to_promise_object(promise)->state != MAL_PROMISE_PENDING) return;
    mal_promise_reject(vm, mal_value_to_promise_object(promise), reason);
}

static MalValue ts_settled(MalVm *vm, MalValue value, bool rejected) {
    MalValue roots[2] = {value, ts_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    if (rejected) ts_reject(vm, roots[1], roots[0]);
    else ts_resolve(vm, roots[1], roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue ts_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    if (slot_count == 0) {
        return mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, prototype, mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
    }
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, prototype, mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count));
}

static MalValue ts_slot(MalValue callee, i32 index) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), index);
}

static MalValue ts_promise_resolve(MalVm *vm, MalValue value) {
    if (mal_value_is_promise_object(value)) return value;
    return ts_settled(vm, value, false);
}

static MalValue ts_call_method(MalVm *vm, MalValue target, const char *name, const MalValue *args, i32 argc) {
    MalValue method;
    if (!mal_vm_get_property(vm, target, ts_key(vm, name), &method) || ts_throwing(vm)) {
        return mal_value_new_undefined();
    }
    MalCompletion result = mal_vm_call_value(vm, method, target, args, argc);
    return result.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result.value;
}

static MalReadableStreamObject *ts_stream_of(MalReadableStreamObject *controller) {
    return mal_value_to_readable_stream_object(controller->as.transform_controller.stream);
}

static void ts_set_backpressure(MalVm *vm, MalReadableStreamObject *stream, bool backpressure) {
    if (mal_value_is_promise_object(stream->as.transform.backpressure_promise)) {
        ts_resolve(vm, stream->as.transform.backpressure_promise, mal_value_new_undefined());
    }
    stream->as.transform.backpressure_promise = ts_promise(vm);
    stream->as.transform.backpressure = backpressure;
}

static void ts_clear_algorithms(MalReadableStreamObject *controller) {
    controller->as.transform_controller.transform_method = mal_value_new_undefined();
    controller->as.transform_controller.flush_method = mal_value_new_undefined();
    controller->as.transform_controller.cancel_method = mal_value_new_undefined();
    controller->as.transform_controller.cleared = true;
}

// WritableStreamDefaultControllerErrorIfNeeded, then TransformStreamUnblockWrite.
static void ts_error_writable_and_unblock(MalVm *vm, MalReadableStreamObject *stream, MalValue error) {
    MalValue roots[2] = {mal_value_from_readable_stream_object(stream), error};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue controller = stream->as.transform.controller;
    if (mal_value_is_readable_stream_object(controller)) ts_clear_algorithms(mal_value_to_readable_stream_object(controller));
    MalValue writable = stream->as.transform.writable;
    if (mal_writable_stream_is_stream(writable)
        && mal_value_to_readable_stream_object(writable)->as.writable_stream.state == MAL_READABLE_STREAM_READABLE) {
        ts_call_method(vm, stream->as.transform.writable_controller, "error", &roots[1], 1);
        if (ts_throwing(vm)) ts_take_throw(vm);
    }
    if (stream->as.transform.backpressure) ts_set_backpressure(vm, stream, false);
    mal_gc_unroot(&root);
}

static void ts_readable_error(MalVm *vm, MalReadableStreamObject *stream, MalValue error) {
    MalValue readable = stream->as.transform.readable;
    if (mal_value_is_readable_stream_object(readable)
        && mal_value_to_readable_stream_object(readable)->as.stream.state == MAL_READABLE_STREAM_READABLE) {
        ts_call_method(vm, stream->as.transform.readable_controller, "error", &error, 1);
        if (ts_throwing(vm)) ts_take_throw(vm);
    }
}

static void ts_error(MalVm *vm, MalReadableStreamObject *stream, MalValue error) {
    MalValue roots[2] = {mal_value_from_readable_stream_object(stream), error};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    ts_readable_error(vm, stream, roots[1]);
    ts_error_writable_and_unblock(vm, stream, roots[1]);
    mal_gc_unroot(&root);
}

static f64 ts_desired_size(MalVm *vm, MalReadableStreamObject *stream, bool *present) {
    MalValue size;
    *present = false;
    if (!mal_vm_get_property(vm, stream->as.transform.readable_controller, ts_key(vm, "desiredSize"), &size)) {
        return 0;
    }
    if (!mal_ops_is_number(size)) return 0;
    *present = true;
    return mal_ops_number_as_f64(size);
}

// TransformStreamDefaultControllerEnqueue; false leaves the readable's stored error thrown.
static bool ts_enqueue(MalVm *vm, MalReadableStreamObject *stream, MalValue chunk) {
    MalValue roots[2] = {mal_value_from_readable_stream_object(stream), chunk};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    ts_call_method(vm, stream->as.transform.readable_controller, "enqueue", &roots[1], 1);
    bool ok = !ts_throwing(vm);
    if (!ok) {
        MalValue error = ts_take_throw(vm);
        ts_error_writable_and_unblock(vm, stream, error);
        MalValue readable = stream->as.transform.readable;
        MalValue stored = mal_value_to_readable_stream_object(readable)->as.stream.stored_error;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW,
            .value = mal_value_is_undefined(stored) ? error : stored};
    } else {
        bool present;
        f64 desired = ts_desired_size(vm, stream, &present);
        bool backpressure = !present || desired <= 0;
        if (backpressure && !stream->as.transform.backpressure) ts_set_backpressure(vm, stream, true);
    }
    mal_gc_unroot(&root);
    return ok;
}

static bool ts_encode_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk);
static bool ts_decode_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk, bool flush);
static bool ts_zlib_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk, bool flush);

static MalValue ts_transform_algorithm(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk) {
    MalValue roots[2] = {mal_value_from_readable_stream_object(controller), chunk};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalValue result = mal_value_new_undefined();
    bool ok = true;
    switch (controller->as.transform_controller.algorithm) {
        case TS_ALGORITHM_ENCODE: ok = ts_encode_chunk(vm, controller, roots[1]); break;
        case TS_ALGORITHM_DECODE: ok = ts_decode_chunk(vm, controller, roots[1], false); break;
        case TS_ALGORITHM_COMPRESS:
        case TS_ALGORITHM_DECOMPRESS: ok = ts_zlib_chunk(vm, controller, roots[1], false); break;
        default:
            if (mal_value_is_callable(controller->as.transform_controller.transform_method)) {
                MalValue args[2] = {roots[1], roots[0]};
                MalCompletion called = mal_vm_call_value(vm, controller->as.transform_controller.transform_method,
                    controller->as.transform_controller.transformer, args, 2);
                if (called.kind == MAL_COMPLETION_THROW) ok = false;
                else result = called.value;
            } else {
                ok = ts_enqueue(vm, stream, roots[1]);
            }
    }
    MalValue promise = ok ? ts_promise_resolve(vm, result) : ts_settled(vm, ts_take_throw(vm), true);
    mal_gc_unroot(&root);
    return promise;
}

static MalValue ts_perform_rejected(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue reason = argc > 0 ? args[0] : mal_value_new_undefined();
    ts_error(vm, mal_value_to_readable_stream_object(ts_slot(callee, 0)), reason);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = reason};
    return mal_value_new_undefined();
}

static MalValue ts_perform_transform(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk) {
    MalValue roots[2] = {mal_value_from_readable_stream_object(controller), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    roots[1] = ts_transform_algorithm(vm, controller, chunk);
    MalValue result = mal_value_new_undefined();
    MalValue then;
    if (mal_vm_get_property(vm, roots[1], ts_key(vm, "then"), &then)) {
        MalValue handlers[2] = {MAL_VALUE_UNDEFINED, ts_function(vm, "", 1, ts_perform_rejected,
            &controller->as.transform_controller.stream, 1)};
        MalRootSpan handler_root;
        mal_gc_root(&handler_root, handlers, 2);
        MalCompletion chained = mal_vm_call_value(vm, then, roots[1], handlers, 2);
        if (chained.kind != MAL_COMPLETION_THROW) result = chained.value;
        mal_gc_unroot(&handler_root);
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue ts_sink_write_after_backpressure(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue pair = ts_slot(callee, 0);
    MalValue stream_value = mal_value_new_undefined(), chunk = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(pair), 0, &stream_value);
    mal_array_object_dense_get(mal_value_to_array_object(pair), 1, &chunk);
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(stream_value);
    MalReadableStreamObject *writable = mal_value_to_readable_stream_object(stream->as.transform.writable);
    if (writable->as.writable_stream.state != MAL_READABLE_STREAM_READABLE) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = writable->as.writable_stream.stored_error};
        return mal_value_new_undefined();
    }
    return ts_perform_transform(vm, mal_value_to_readable_stream_object(stream->as.transform.controller), chunk);
}

static MalValue ts_sink_start(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    stream->as.transform.writable_controller = argc > 0 ? args[0] : mal_value_new_undefined();
    return stream->as.transform.start_promise;
}

static MalValue ts_sink_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue stream_value = ts_slot(callee, 0);
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(stream_value);
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!stream->as.transform.backpressure) {
        return ts_perform_transform(vm, mal_value_to_readable_stream_object(stream->as.transform.controller), chunk);
    }
    MalValue roots[3] = {stream_value, chunk, mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0))};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalArrayObject *pair = mal_value_to_array_object(roots[2]);
    mal_array_object_store(pair, mal_key_index(0), roots[0]);
    mal_array_object_store(pair, mal_key_index(1), roots[1]);
    MalValue handler = ts_function(vm, "", 0, ts_sink_write_after_backpressure, &roots[2], 1);
    MalValue then;
    MalValue result = mal_value_new_undefined();
    MalValue handlers[2] = {handler, MAL_VALUE_UNDEFINED};
    MalRootSpan handler_root;
    mal_gc_root(&handler_root, handlers, 2);
    if (mal_vm_get_property(vm, stream->as.transform.backpressure_promise, ts_key(vm, "then"), &then)) {
        MalCompletion chained = mal_vm_call_value(vm, then, stream->as.transform.backpressure_promise, handlers, 2);
        if (chained.kind != MAL_COMPLETION_THROW) result = chained.value;
    }
    mal_gc_unroot(&handler_root);
    mal_gc_unroot(&root);
    return result;
}

// Shared reaction for flush/cancel completions. Slots: controller, mode (0 close, 1 abort, 2 cancel), reason.
static MalValue ts_finish_fulfilled(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalReadableStreamObject *controller = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    i32 mode = mal_value_to_i32(ts_slot(callee, 1));
    MalValue reason = ts_slot(callee, 2);
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalValue finish = controller->as.transform_controller.finish_promise;
    MalReadableStreamObject *readable = mal_value_to_readable_stream_object(stream->as.transform.readable);
    MalReadableStreamObject *writable = mal_value_to_readable_stream_object(stream->as.transform.writable);
    if (mode == 2) {
        if (writable->as.writable_stream.state == MAL_READABLE_STREAM_ERRORED) {
            ts_reject(vm, finish, writable->as.writable_stream.stored_error);
        } else {
            ts_error_writable_and_unblock(vm, stream, reason);
            ts_resolve(vm, finish, mal_value_new_undefined());
        }
    } else if (readable->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        ts_reject(vm, finish, readable->as.stream.stored_error);
    } else {
        if (mode == 0) {
            ts_call_method(vm, stream->as.transform.readable_controller, "close", nullptr, 0);
            if (ts_throwing(vm)) ts_take_throw(vm);
        } else {
            ts_readable_error(vm, stream, reason);
        }
        ts_resolve(vm, finish, mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue ts_finish_rejected(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalReadableStreamObject *controller = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    i32 mode = mal_value_to_i32(ts_slot(callee, 1));
    MalValue reason = argc > 0 ? args[0] : mal_value_new_undefined();
    MalReadableStreamObject *stream = ts_stream_of(controller);
    if (mode == 2) ts_error_writable_and_unblock(vm, stream, reason);
    else ts_readable_error(vm, stream, reason);
    ts_reject(vm, controller->as.transform_controller.finish_promise, reason);
    return mal_value_new_undefined();
}

static MalValue ts_finish(MalVm *vm, MalReadableStreamObject *controller, i32 mode, MalValue reason) {
    if (mal_value_is_promise_object(controller->as.transform_controller.finish_promise)) {
        return controller->as.transform_controller.finish_promise;
    }
    MalValue roots[4] = {mal_value_from_readable_stream_object(controller), reason, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    controller->as.transform_controller.finish_promise = ts_promise(vm);
    bool ok = true;
    MalValue result = mal_value_new_undefined();
    u8 algorithm = controller->as.transform_controller.algorithm;
    if (mode == 0 && algorithm != TS_ALGORITHM_JS) {
        ok = algorithm == TS_ALGORITHM_ENCODE ? ts_encode_chunk(vm, controller, mal_value_new_undefined())
            : algorithm == TS_ALGORITHM_DECODE ? ts_decode_chunk(vm, controller, mal_value_new_undefined(), true)
            : ts_zlib_chunk(vm, controller, mal_value_new_undefined(), true);
    } else {
        MalValue method = mode == 0 ? controller->as.transform_controller.flush_method
            : controller->as.transform_controller.cancel_method;
        if (mal_value_is_callable(method)) {
            MalValue arg = mode == 0 ? roots[0] : roots[1];
            MalCompletion called = mal_vm_call_value(vm, method, controller->as.transform_controller.transformer, &arg, 1);
            if (called.kind == MAL_COMPLETION_THROW) ok = false;
            else result = called.value;
        }
    }
    ts_clear_algorithms(controller);
    roots[2] = ok ? ts_promise_resolve(vm, result) : ts_settled(vm, ts_take_throw(vm), true);
    MalValue slots[3] = {roots[0], mal_value_from_i32(mode), roots[1]};
    MalValue handlers[2];
    handlers[0] = ts_function(vm, "", 0, ts_finish_fulfilled, slots, 3);
    MalRootSpan handler_root;
    handlers[1] = mal_value_new_undefined();
    mal_gc_root(&handler_root, handlers, 2);
    handlers[1] = ts_function(vm, "", 1, ts_finish_rejected, slots, 3);
    MalValue then;
    if (mal_vm_get_property(vm, roots[2], ts_key(vm, "then"), &then)) {
        mal_vm_call_value(vm, then, roots[2], handlers, 2);
    }
    mal_gc_unroot(&handler_root);
    MalValue finish = controller->as.transform_controller.finish_promise;
    mal_gc_unroot(&root);
    return finish;
}

static MalValue ts_sink_close(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    return ts_finish(vm, mal_value_to_readable_stream_object(stream->as.transform.controller), 0,
        mal_value_new_undefined());
}

static MalValue ts_sink_abort(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    return ts_finish(vm, mal_value_to_readable_stream_object(stream->as.transform.controller), 1,
        argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue ts_source_start(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    stream->as.transform.readable_controller = argc > 0 ? args[0] : mal_value_new_undefined();
    return stream->as.transform.start_promise;
}

static MalValue ts_source_pull(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    ts_set_backpressure(vm, stream, false);
    return stream->as.transform.backpressure_promise;
}

static MalValue ts_source_cancel(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(ts_slot(callee, 0));
    return ts_finish(vm, mal_value_to_readable_stream_object(stream->as.transform.controller), 2,
        argc > 0 ? args[0] : mal_value_new_undefined());
}

static bool ts_strategy(MalVm *vm, MalValue strategy, f64 default_hwm, MalValue *out) {
    MalValue roots[3] = {strategy, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    bool ok = true;
    if (mal_value_is_object(roots[0])) {
        ok = mal_vm_get_property(vm, roots[0], ts_key(vm, "highWaterMark"), &roots[1]) && !ts_throwing(vm)
            && mal_vm_get_property(vm, roots[0], ts_key(vm, "size"), &roots[2]) && !ts_throwing(vm);
    } else if (!mal_value_is_nil(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Strategy must be an object");
        ok = false;
    }
    if (ok) {
        MalObject *object = mal_intrinsic_new_object(vm);
        *out = mal_value_from_object(object);
        mal_intrinsic_define_data(vm, object, (const byte *) "highWaterMark",
            mal_value_is_undefined(roots[1]) ? mal_value_from_f64(default_hwm) : roots[1], TS_VISIBLE);
        if (!mal_value_is_undefined(roots[2])) {
            mal_intrinsic_define_data(vm, object, (const byte *) "size", roots[2], TS_VISIBLE);
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalObject *ts_prototype_of(MalVm *vm, MalValue new_target, MalValue callee) {
    MalValue prototype;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    if (mal_vm_get_property(vm, target, ts_key(vm, "prototype"), &prototype) && mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
}

// InitializeTransformStream plus SetUpTransformStreamDefaultController. `transformer` may be undefined.
static MalValue ts_create(MalVm *vm, MalObject *prototype, MalValue controller_prototype,
    MalValue transformer, MalValue writable_strategy,
    MalValue readable_strategy, u8 algorithm, MalValue start, MalValue transform, MalValue flush, MalValue cancel) {
    MalValue roots[12];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    roots[0] = transformer;
    roots[1] = writable_strategy;
    roots[2] = readable_strategy;
    roots[8] = start;
    roots[9] = transform;
    roots[10] = flush;
    roots[11] = cancel;
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalReadableStreamObject *stream = ts_new_cell(vm, MAL_TRANSFORM_STREAM, prototype);
    roots[3] = mal_value_from_readable_stream_object(stream);
    stream->as.transform.start_promise = ts_promise(vm);
    MalReadableStreamObject *controller = ts_new_cell(vm, MAL_TRANSFORM_STREAM_DEFAULT_CONTROLLER,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    roots[4] = mal_value_from_readable_stream_object(controller);
    if (mal_value_is_object(controller_prototype)) {
        mal_object_set_prototype((MalObject *) controller, mal_value_to_object(controller_prototype));
    }
    controller->as.transform_controller.stream = roots[3];
    controller->as.transform_controller.transformer = roots[0];
    controller->as.transform_controller.transform_method = roots[9];
    controller->as.transform_controller.flush_method = roots[10];
    controller->as.transform_controller.cancel_method = roots[11];
    controller->as.transform_controller.algorithm = algorithm;
    stream->as.transform.controller = roots[4];
    ts_set_backpressure(vm, stream, true);
    if (!ts_strategy(vm, roots[1], 1, &roots[5])) goto done;
    if (!ts_strategy(vm, roots[2], 0, &roots[6])) goto done;
    MalObject *sink = mal_intrinsic_new_object(vm);
    roots[7] = mal_value_from_object(sink);
    mal_intrinsic_define_data(vm, sink, (const byte *) "start", ts_function(vm, "start", 1, ts_sink_start, &roots[3], 1), TS_VISIBLE);
    mal_intrinsic_define_data(vm, sink, (const byte *) "write", ts_function(vm, "write", 2, ts_sink_write, &roots[3], 1), TS_VISIBLE);
    mal_intrinsic_define_data(vm, sink, (const byte *) "close", ts_function(vm, "close", 0, ts_sink_close, &roots[3], 1), TS_VISIBLE);
    mal_intrinsic_define_data(vm, sink, (const byte *) "abort", ts_function(vm, "abort", 1, ts_sink_abort, &roots[3], 1), TS_VISIBLE);
    MalValue writable_args[2] = {roots[7], roots[5]};
    MalCompletion writable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_WRITABLE_STREAM_CONSTRUCTOR], writable_args, 2);
    if (writable.kind == MAL_COMPLETION_THROW) goto done;
    stream->as.transform.writable = writable.value;
    MalObject *source = mal_intrinsic_new_object(vm);
    roots[7] = mal_value_from_object(source);
    mal_intrinsic_define_data(vm, source, (const byte *) "start", ts_function(vm, "start", 1, ts_source_start, &roots[3], 1), TS_VISIBLE);
    mal_intrinsic_define_data(vm, source, (const byte *) "pull", ts_function(vm, "pull", 1, ts_source_pull, &roots[3], 1), TS_VISIBLE);
    mal_intrinsic_define_data(vm, source, (const byte *) "cancel", ts_function(vm, "cancel", 1, ts_source_cancel, &roots[3], 1), TS_VISIBLE);
    MalValue readable_args[2] = {roots[7], roots[6]};
    MalCompletion readable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR], readable_args, 2);
    if (readable.kind == MAL_COMPLETION_THROW) goto done;
    stream->as.transform.readable = readable.value;
    MalValue started = mal_value_new_undefined();
    if (mal_value_is_callable(roots[8])) {
        MalCompletion called = mal_vm_call_value(vm, roots[8], roots[0], &roots[4], 1);
        if (called.kind == MAL_COMPLETION_THROW) goto done;
        started = called.value;
    }
    ts_resolve(vm, stream->as.transform.start_promise, started);
    result = roots[3];
done:
    mal_gc_unroot(&root);
    return result;
}

static bool ts_get_member(MalVm *vm, MalValue object, const char *name, MalValue *out, bool callable) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    if (!mal_vm_get_property(vm, object, ts_key(vm, name), out) || ts_throwing(vm)) return false;
    if (callable && !mal_value_is_undefined(*out) && !mal_value_is_callable(*out)) {
        char message[96];
        snprintf(message, sizeof message, "transformer.%s must be a function", name);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
        return false;
    }
    return true;
}

static MalValue ts_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor TransformStream cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[8];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    roots[0] = argc > 0 ? args[0] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (!mal_value_is_nil(roots[0]) && !mal_value_is_object(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "transformer must be an object");
        goto done;
    }
    MalValue readable_type, writable_type;
    if (!ts_get_member(vm, roots[0], "cancel", &roots[4], true)
        || !ts_get_member(vm, roots[0], "flush", &roots[3], true)
        || !ts_get_member(vm, roots[0], "readableType", &readable_type, false)
        || !ts_get_member(vm, roots[0], "start", &roots[1], true)
        || !ts_get_member(vm, roots[0], "transform", &roots[2], true)
        || !ts_get_member(vm, roots[0], "writableType", &writable_type, false)) {
        goto done;
    }
    if (!mal_value_is_undefined(readable_type)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "Invalid readableType specified");
        goto done;
    }
    if (!mal_value_is_undefined(writable_type)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "Invalid writableType specified");
        goto done;
    }
    result = ts_create(vm, ts_prototype_of(vm, new_target, callee), ts_slot(callee, 0), roots[0],
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined(),
        TS_ALGORITHM_JS, roots[1], roots[2], roots[3], roots[4]);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue ts_get_readable(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalReadableStreamObject *stream = ts_require(vm, self, MAL_TRANSFORM_STREAM,
        "TransformStream.prototype.readable called on an incompatible receiver");
    return stream == nullptr ? mal_value_new_undefined() : stream->as.transform.readable;
}

static MalValue ts_get_writable(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalReadableStreamObject *stream = ts_require(vm, self, MAL_TRANSFORM_STREAM,
        "TransformStream.prototype.writable called on an incompatible receiver");
    return stream == nullptr ? mal_value_new_undefined() : stream->as.transform.writable;
}

static MalReadableStreamObject *ts_require_controller(MalVm *vm, MalValue self) {
    return ts_require(vm, self, MAL_TRANSFORM_STREAM_DEFAULT_CONTROLLER,
        "TransformStreamDefaultController method called on an incompatible receiver");
}

static MalValue ts_controller_desired_size(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalReadableStreamObject *controller = ts_require_controller(vm, self);
    if (controller == nullptr) return mal_value_new_undefined();
    MalValue size;
    if (!mal_vm_get_property(vm, ts_stream_of(controller)->as.transform.readable_controller,
            ts_key(vm, "desiredSize"), &size)) {
        return mal_value_new_undefined();
    }
    return size;
}

static MalValue ts_controller_enqueue(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalReadableStreamObject *controller = ts_require_controller(vm, self);
    if (controller == nullptr) return mal_value_new_undefined();
    ts_enqueue(vm, ts_stream_of(controller), argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue ts_controller_error(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalReadableStreamObject *controller = ts_require_controller(vm, self);
    if (controller == nullptr) return mal_value_new_undefined();
    ts_error(vm, ts_stream_of(controller), argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue ts_controller_terminate(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalReadableStreamObject *controller = ts_require_controller(vm, self);
    if (controller == nullptr) return mal_value_new_undefined();
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalReadableStreamObject *readable = mal_value_to_readable_stream_object(stream->as.transform.readable);
    if (readable->as.stream.state == MAL_READABLE_STREAM_READABLE) {
        ts_call_method(vm, stream->as.transform.readable_controller, "close", nullptr, 0);
        if (ts_throwing(vm)) ts_take_throw(vm);
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "TransformStream terminated");
    MalValue error = ts_take_throw(vm);
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    ts_error_writable_and_unblock(vm, stream, error);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue ts_illegal_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Illegal constructor");
    return mal_value_new_undefined();
}

/* TextEncoderStream / TextDecoderStream / CompressionStream / DecompressionStream wrap a
 * TransformStream whose transform runs natively. */

static MalReadableStreamObject *ts_any_wrapper(MalValue self) {
    if (!mal_value_is_readable_stream_object(self)) return nullptr;
    MalReadableStreamObject *cell = mal_value_to_readable_stream_object(self);
    switch (cell->kind) {
        case MAL_TEXT_ENCODER_STREAM:
        case MAL_TEXT_DECODER_STREAM:
        case MAL_COMPRESSION_STREAM:
        case MAL_DECOMPRESSION_STREAM:
            return cell;
        default:
            return nullptr;
    }
}

static MalValue ts_wrapper_side(MalVm *vm, MalValue self, bool readable) {
    MalReadableStreamObject *wrapper = ts_any_wrapper(self);
    if (wrapper == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Illegal invocation");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *inner = mal_value_to_readable_stream_object(wrapper->as.transform_wrapper.transform);
    return readable ? inner->as.transform.readable : inner->as.transform.writable;
}

static MalValue ts_wrapper_readable(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    return ts_wrapper_side(vm, self, true);
}

static MalValue ts_wrapper_writable(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    return ts_wrapper_side(vm, self, false);
}

static MalReadableStreamObject *ts_wrapper_controller(MalReadableStreamObject *wrapper) {
    MalReadableStreamObject *inner = mal_value_to_readable_stream_object(wrapper->as.transform_wrapper.transform);
    return mal_value_to_readable_stream_object(inner->as.transform.controller);
}

static MalValue ts_wrapper_new(MalVm *vm, MalReadableStreamKind kind, MalValue new_target, MalValue callee,
    u8 algorithm, MalValue helper, void *codec) {
    MalValue roots[3] = {helper, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalReadableStreamObject *wrapper = ts_new_cell(vm, kind, ts_prototype_of(vm, new_target, callee));
    roots[1] = mal_value_from_readable_stream_object(wrapper);
    wrapper->as.transform_wrapper.helper = roots[0];
    MalValue undefined = mal_value_new_undefined();
    roots[2] = ts_create(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        ts_slot(callee, 0), undefined, undefined, undefined, algorithm, undefined, undefined, undefined, undefined);
    MalValue result = mal_value_new_undefined();
    if (!ts_throwing(vm) && mal_value_is_readable_stream_object(roots[2])) {
        wrapper->as.transform_wrapper.transform = roots[2];
        MalReadableStreamObject *controller = ts_wrapper_controller(wrapper);
        controller->as.transform_controller.helper = roots[0];
        controller->as.transform_controller.codec = codec;
        codec = nullptr;
        result = roots[1];
    }
#if MAL_NODE
    if (codec != nullptr) {
        MalZlibStream *handle = codec;
        mal_zlib_free(&handle);
    }
#else
    (void) codec;
#endif
    mal_gc_unroot(&root);
    return result;
}

// Encode one chunk, carrying a trailing high surrogate into the next chunk; undefined flushes.
static bool ts_encode_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk) {
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalTextBuffer text = {0};
    u32 pending = controller->as.transform_controller.pending_surrogate;
    controller->as.transform_controller.pending_surrogate = 0;
    if (pending != 0) mal_text_buffer_push(&text, (c16) pending);
    if (!mal_value_is_undefined(chunk) || pending == 0) {
        if (!mal_value_is_undefined(chunk)) {
            MalString *string;
            if (!mal_vm_to_string(vm, chunk, &string)) {
                mal_text_buffer_dispose(&text);
                return false;
            }
            mal_text_buffer_append_string(&text, string);
            if (text.length > 0) {
                c16 last = mal_text_buffer_code_unit_at(&text, text.length - 1);
                if (last >= 0xd800 && last <= 0xdbff) {
                    controller->as.transform_controller.pending_surrogate = last;
                    mal_text_buffer_truncate(&text, text.length - 1);
                }
            }
        }
    }
    if (text.length == 0) {
        mal_text_buffer_dispose(&text);
        return true;
    }
    MalValue roots[2] = {mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text)), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue encoder = controller->as.transform_controller.helper;
    roots[1] = ts_call_method(vm, encoder, "encode", &roots[0], 1);
    bool ok = !ts_throwing(vm) && ts_enqueue(vm, stream, roots[1]);
    mal_gc_unroot(&root);
    return ok;
}

static bool ts_decode_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk, bool flush) {
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalValue roots[3] = {chunk, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    bool ok = true;
    MalValue decoder = controller->as.transform_controller.helper;
    if (flush) {
        roots[1] = ts_call_method(vm, decoder, "decode", nullptr, 0);
    } else {
        MalObject *options = mal_intrinsic_new_object(vm);
        roots[2] = mal_value_from_object(options);
        mal_intrinsic_define_data(vm, options, (const byte *) "stream", mal_value_new_boolean(true), TS_VISIBLE);
        MalValue call_args[2] = {roots[0], roots[2]};
        roots[1] = ts_call_method(vm, decoder, "decode", call_args, 2);
    }
    if (ts_throwing(vm)) ok = false;
    else if (mal_value_is_string(roots[1]) && mal_string_length(mal_value_to_string(roots[1])) > 0) {
        ok = ts_enqueue(vm, stream, roots[1]);
    }
    mal_gc_unroot(&root);
    return ok;
}

#if MAL_NODE
static void ts_codec_free(void *codec) {
    MalZlibStream *handle = codec;
    mal_zlib_free(&handle);
}

static bool ts_zlib_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk, bool flush) {
    MalReadableStreamObject *stream = ts_stream_of(controller);
    MalZlibStream *codec = controller->as.transform_controller.codec;
    bool encode = controller->as.transform_controller.algorithm == TS_ALGORITHM_COMPRESS;
    MalBufferSourceSpan span = {0};
    if (!flush && mal_buffer_source_span(chunk, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "The \"chunk\" argument must be of type ArrayBuffer, Buffer, TypedArray, or DataView");
        return false;
    }
    usize length = span.length;
    if (codec == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "The compression stream is closed");
        return false;
    }
    byte *copy = nullptr;
    if (length > 0) {
        copy = malloc(length);
        if (copy == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        mal_buffer_source_span_read(&span, 0, copy, length);
    }
    usize capacity = 16384, used = 0, offset = 0;
    byte *output = malloc(capacity);
    i32 status = MAL_ZLIB_STATUS_NEED_INPUT;
    bool ok = output != nullptr;
    // Z_FINISH completes an encoder at flush; decoders confirm completeness through mal_zlib_finish.
    i32 mode = flush && encode ? 4 : 0;
    while (ok) {
        if (used == capacity) {
            byte *grown = realloc(output, capacity * 2);
            if (grown == nullptr) {
                ok = false;
                break;
            }
            output = grown;
            capacity *= 2;
        }
        usize consumed = 0, produced = 0;
        status = mal_zlib_pump(codec, (const uint8_t *) (copy == nullptr ? nullptr : copy + offset), length - offset,
            (uint8_t *) (output + used), capacity - used, mode, &consumed, &produced);
        offset += consumed;
        used += produced;
        if (status < 0 || status == MAL_ZLIB_STATUS_STREAM_END) break;
        if (status == MAL_ZLIB_STATUS_NEED_INPUT && offset == length) break;
        if (consumed == 0 && produced == 0 && status != MAL_ZLIB_STATUS_NEED_OUTPUT) break;
    }
    free(copy);
    if (ok && flush && !encode && status >= 0 && status != MAL_ZLIB_STATUS_STREAM_END) {
        status = mal_zlib_finish(codec);
    }
    if (ok && !flush && !encode && status == MAL_ZLIB_STATUS_STREAM_END && offset < length) {
        status = MAL_ZLIB_STATUS_DATA_ERROR;
    }
    if (!ok) {
        free(output);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    if (status < 0) {
        free(output);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) (status == MAL_ZLIB_STATUS_TRUNCATED
            ? "unexpected end of file" : "incorrect header check"));
        return false;
    }
    if (flush) {
        ts_codec_free(codec);
        controller->as.transform_controller.codec = nullptr;
    }
    bool result = true;
    if (used > 0) {
        MalValue bytes = mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, &bytes, 1);
        MalValue length_value = mal_value_from_i32((i32) used);
        MalCompletion made = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR],
            &length_value, 1);
        if (made.kind == MAL_COMPLETION_THROW) {
            result = false;
        } else {
            bytes = made.value;
            MalTypedArrayObject *array = mal_value_to_typed_array_object(bytes);
            memcpy(array->buffer->data + array->byte_offset, output, used);
            result = ts_enqueue(vm, stream, bytes);
        }
        mal_gc_unroot(&root);
    }
    free(output);
    return result;
}

static MalValue ts_zlib_constructor(MalVm *vm, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee, bool encode) {
    const char *name = encode ? "CompressionStream" : "DecompressionStream";
    if (mal_value_is_undefined(new_target)) {
        char message[96];
        snprintf(message, sizeof message, "Class constructor %s cannot be invoked without 'new'", name);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
        return mal_value_new_undefined();
    }
    MalString *format;
    if (!mal_vm_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &format)) return mal_value_new_undefined();
    u32 kind = 0;
    if (mal_string_equals_ascii(format, (const byte *) "gzip")) kind = MAL_ZLIB_FORMAT_GZIP;
    else if (mal_string_equals_ascii(format, (const byte *) "deflate")) kind = MAL_ZLIB_FORMAT_ZLIB;
    else if (mal_string_equals_ascii(format, (const byte *) "deflate-raw")) kind = MAL_ZLIB_FORMAT_RAW;
    if (kind == 0) {
        MalTextBuffer text = {0};
        mal_text_buffer_append_ascii(&text, (const byte *) "The provided value '");
        mal_text_buffer_append_string(&text, format);
        mal_text_buffer_append_ascii(&text, (const byte *) "' is not a valid enum value of type CompressionFormat.");
        MalValue message = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
        MalRootSpan root;
        mal_gc_root(&root, &message, 1);
        mal_vm_throw_error_value(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalZlibStream *codec = nullptr;
    if (mal_zlib_create_codec(kind, encode ? 1 : 0, -1, 15, &codec) < 0 || codec == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = ts_wrapper_new(vm, encode ? MAL_COMPRESSION_STREAM : MAL_DECOMPRESSION_STREAM, new_target,
        callee, encode ? TS_ALGORITHM_COMPRESS : TS_ALGORITHM_DECOMPRESS, mal_value_new_undefined(), codec);
    if (mal_value_is_readable_stream_object(result)) {
        ts_wrapper_controller(mal_value_to_readable_stream_object(result))->as.transform_controller.codec_free = ts_codec_free;
    }
    return result;
}

static MalValue ts_compression_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self;
    return ts_zlib_constructor(vm, args, argc, new_target, callee, true);
}

static MalValue ts_decompression_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self;
    return ts_zlib_constructor(vm, args, argc, new_target, callee, false);
}
#else
static bool ts_zlib_chunk(MalVm *vm, MalReadableStreamObject *controller, MalValue chunk, bool flush) {
    (void) vm; (void) controller; (void) chunk; (void) flush;
    return true;
}
#endif

static MalValue ts_text_encoder_stream_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self; (void) args; (void) argc;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor TextEncoderStream cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue constructor;
    if (!mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], ts_key(vm, "TextEncoder"), &constructor)) {
        return mal_value_new_undefined();
    }
    MalCompletion encoder = mal_vm_construct_value(vm, constructor, nullptr, 0);
    if (encoder.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return ts_wrapper_new(vm, MAL_TEXT_ENCODER_STREAM, new_target, callee, TS_ALGORITHM_ENCODE, encoder.value, nullptr);
}

static MalValue ts_text_decoder_stream_constructor(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) self;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor TextDecoderStream cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue constructor;
    if (!mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], ts_key(vm, "TextDecoder"), &constructor)) {
        return mal_value_new_undefined();
    }
    MalCompletion decoder = mal_vm_construct_value(vm, constructor, args, argc > 2 ? 2 : argc);
    if (decoder.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return ts_wrapper_new(vm, MAL_TEXT_DECODER_STREAM, new_target, callee, TS_ALGORITHM_DECODE, decoder.value, nullptr);
}

static MalValue ts_text_property(MalVm *vm, MalValue self, MalReadableStreamKind kind, const char *name) {
    MalReadableStreamObject *wrapper = ts_cell(self, kind);
    if (wrapper == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) "Illegal invocation");
        return mal_value_new_undefined();
    }
    MalValue value;
    if (!mal_vm_get_property(vm, wrapper->as.transform_wrapper.helper, ts_key(vm, name), &value)) {
        return mal_value_new_undefined();
    }
    return value;
}

#define TS_TEXT_GETTER(fn, kind, name) \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) { \
        (void) args; (void) argc; (void) nt; (void) callee; \
        return ts_text_property(vm, self, kind, name); \
    }

TS_TEXT_GETTER(ts_encoder_stream_encoding, MAL_TEXT_ENCODER_STREAM, "encoding")
TS_TEXT_GETTER(ts_decoder_stream_encoding, MAL_TEXT_DECODER_STREAM, "encoding")
TS_TEXT_GETTER(ts_decoder_stream_fatal, MAL_TEXT_DECODER_STREAM, "fatal")
TS_TEXT_GETTER(ts_decoder_stream_ignore_bom, MAL_TEXT_DECODER_STREAM, "ignoreBOM")

static void ts_define_getter(MalVm *vm, MalObject *prototype, const char *name, MalNativeFunctionCallback callback) {
    char display[64];
    snprintf(display, sizeof display, "get %s", name);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = ts_function(vm, display, 0, callback, nullptr, 0),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, ts_key(vm, name), &desc);
}

// Every constructor carries the TransformStreamDefaultController prototype in slot 0.
static MalObject *ts_install_class(MalVm *vm, MalObject *global_this, const char *name, i32 length,
    MalNativeFunctionCallback callback, MalValue *roots, MalValue controller_prototype) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    roots[0] = mal_value_from_object(prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, &controller_prototype, 1);
    mal_native_function_object_set_constructor(constructor);
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name)),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
    mal_intrinsic_define_data(vm, global_this, (const byte *) name, roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return prototype;
}

static void ts_define_method(MalVm *vm, MalObject *prototype, const char *name, i32 length,
    MalNativeFunctionCallback callback) {
    mal_intrinsic_define_data(vm, prototype, (const byte *) name, ts_function(vm, name, length, callback, nullptr, 0),
        TS_VISIBLE);
}

void mal_transform_stream_install(MalVm *vm, MalObject *global_this) {
    MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue undefined = mal_value_new_undefined();
    MalObject *controller = ts_install_class(vm, global_this, "TransformStreamDefaultController", 0,
        ts_illegal_constructor, roots, undefined);
    roots[2] = mal_value_from_object(controller);
    ts_define_getter(vm, controller, "desiredSize", ts_controller_desired_size);
    ts_define_method(vm, controller, "enqueue", 0, ts_controller_enqueue);
    ts_define_method(vm, controller, "error", 0, ts_controller_error);
    ts_define_method(vm, controller, "terminate", 0, ts_controller_terminate);
    MalObject *stream = ts_install_class(vm, global_this, "TransformStream", 0, ts_constructor, roots, roots[2]);
    ts_define_getter(vm, stream, "readable", ts_get_readable);
    ts_define_getter(vm, stream, "writable", ts_get_writable);
    MalObject *encoder = ts_install_class(vm, global_this, "TextEncoderStream", 0,
        ts_text_encoder_stream_constructor, roots, roots[2]);
    ts_define_getter(vm, encoder, "encoding", ts_encoder_stream_encoding);
    ts_define_getter(vm, encoder, "readable", ts_wrapper_readable);
    ts_define_getter(vm, encoder, "writable", ts_wrapper_writable);
    MalObject *decoder = ts_install_class(vm, global_this, "TextDecoderStream", 0,
        ts_text_decoder_stream_constructor, roots, roots[2]);
    ts_define_getter(vm, decoder, "encoding", ts_decoder_stream_encoding);
    ts_define_getter(vm, decoder, "fatal", ts_decoder_stream_fatal);
    ts_define_getter(vm, decoder, "ignoreBOM", ts_decoder_stream_ignore_bom);
    ts_define_getter(vm, decoder, "readable", ts_wrapper_readable);
    ts_define_getter(vm, decoder, "writable", ts_wrapper_writable);
#if MAL_NODE
    MalObject *compression = ts_install_class(vm, global_this, "CompressionStream", 1,
        ts_compression_constructor, roots, roots[2]);
    ts_define_getter(vm, compression, "readable", ts_wrapper_readable);
    ts_define_getter(vm, compression, "writable", ts_wrapper_writable);
    MalObject *decompression = ts_install_class(vm, global_this, "DecompressionStream", 1,
        ts_decompression_constructor, roots, roots[2]);
    ts_define_getter(vm, decompression, "readable", ts_wrapper_readable);
    ts_define_getter(vm, decompression, "writable", ts_wrapper_writable);
#endif
    mal_gc_unroot(&root);
}
