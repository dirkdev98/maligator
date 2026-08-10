#include "web_readable_stream_object.h"

#include <math.h>
#include <stdlib.h>

#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "promise_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static void ws_process_queue(MalVm *vm, MalReadableStreamObject *controller);

static MalCompletion ws_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined()};
}

static MalValue ws_take_type_error(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
    MalValue error = vm->completion.value;
    vm->completion = ws_normal();
    return error;
}

static MalValue ws_take_range_error(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message);
    MalValue error = vm->completion.value;
    vm->completion = ws_normal();
    return error;
}

static MalReadableStreamObject *ws_new(
    MalVm *vm, MalReadableStreamKind kind, MalObject *prototype) {
    MalReadableStreamObject *object = mal_heap_alloc(
        &vm->heap, sizeof(MalReadableStreamObject), MAL_HEAP_READABLE_STREAM_OBJECT);
    mal_object_init(&vm->heap, &object->object,
        MAL_HEAP_READABLE_STREAM_OBJECT, prototype);
    object->kind = kind;
    return object;
}

static bool ws_is_kind(MalValue value, MalReadableStreamKind kind) {
    return mal_value_is_readable_stream_object(value) &&
        mal_value_to_readable_stream_object(value)->kind == kind;
}

static MalReadableStreamObject *ws_require(
    MalVm *vm, MalValue value, MalReadableStreamKind kind, const byte *message) {
    if (!ws_is_kind(value, kind)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }
    return mal_value_to_readable_stream_object(value);
}

static MalPromiseObject *ws_new_promise(MalVm *vm) {
    return mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
}

static MalValue ws_settled_promise(MalVm *vm, MalValue value, bool rejected) {
    MalValue roots[2] = {value, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_value_from_promise_object(ws_new_promise(vm));
    if (rejected) {
        mal_promise_reject(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    } else {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    }
    mal_gc_unroot(&span);
    return roots[1];
}

static MalValue ws_resolved_promise(MalVm *vm) {
    return ws_settled_promise(vm, mal_value_new_undefined(), false);
}

static MalValue ws_rejected_promise(MalVm *vm, MalValue reason) {
    return ws_settled_promise(vm, reason, true);
}

static MalValue ws_rejected_type_error(MalVm *vm, const byte *message) {
    return ws_rejected_promise(vm, ws_take_type_error(vm, message));
}

static MalValue ws_callback(
    MalVm *vm, MalNativeFunctionCallback callback, MalValue slot) {
    MalObject *fn_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) ""),
        callback, &slot, 1));
}

static MalObject *ws_instance_prototype(
    MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(vm, new_target, fallback, &prototype)) {
        return nullptr;
    }
    return prototype;
}

static bool ws_get_method(
    MalVm *vm, MalValue object, const byte *name, MalValue *out) {
    if (!mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, name), out)) {
        return false;
    }
    if (!mal_value_is_undefined(*out) && !mal_value_is_callable(*out)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WritableStream underlying sink method is not callable");
        return false;
    }
    return true;
}

static MalReadableStreamObject *ws_controller_for(MalReadableStreamObject *stream) {
    return mal_value_to_readable_stream_object(stream->as.writable_stream.controller);
}

static MalReadableStreamObject *ws_writer_for(MalReadableStreamObject *stream) {
    if (mal_value_is_undefined(stream->as.writable_stream.writer)) return nullptr;
    return mal_value_to_readable_stream_object(stream->as.writable_stream.writer);
}

static void ws_set_ready_pending(MalVm *vm, MalReadableStreamObject *stream) {
    MalReadableStreamObject *writer = ws_writer_for(stream);
    if (writer == nullptr ||
        mal_value_to_promise_object(writer->as.writer.ready_promise)->state ==
            MAL_PROMISE_PENDING) {
        return;
    }
    writer->as.writer.ready_promise =
        mal_value_from_promise_object(ws_new_promise(vm));
    mal_gc_card(&writer->object.header, writer->as.writer.ready_promise);
}

static void ws_set_ready_fulfilled(MalVm *vm, MalReadableStreamObject *stream) {
    MalReadableStreamObject *writer = ws_writer_for(stream);
    if (writer == nullptr) return;
    MalPromiseObject *ready = mal_value_to_promise_object(writer->as.writer.ready_promise);
    if (ready->state == MAL_PROMISE_PENDING) {
        mal_promise_fulfill(vm, ready, mal_value_new_undefined());
    }
}

static void ws_update_backpressure(MalVm *vm, MalReadableStreamObject *controller) {
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.writable_controller.stream);
    if (stream->as.writable_stream.state != MAL_READABLE_STREAM_READABLE) return;
    if (controller->as.writable_controller.queue_total_size >=
        controller->as.writable_controller.high_water_mark) {
        ws_set_ready_pending(vm, stream);
    } else {
        ws_set_ready_fulfilled(vm, stream);
    }
}

static void ws_free_request(MalWritableStreamWriteRequest *request) {
    mal_gc_write_barrier(request->chunk);
    mal_gc_write_barrier(request->promise);
    free(request);
}

static void ws_error_stream(
    MalVm *vm, MalReadableStreamObject *stream, MalValue reason) {
    if (stream->as.writable_stream.state != MAL_READABLE_STREAM_READABLE) return;
    MalValue roots[2] = {
        mal_value_from_readable_stream_object(stream), reason,
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    stream->as.writable_stream.state = MAL_READABLE_STREAM_ERRORED;
    stream->as.writable_stream.stored_error = roots[1];
    mal_gc_card(&stream->object.header, roots[1]);
    MalReadableStreamObject *controller = ws_controller_for(stream);
    MalReadableStreamObject *writer = ws_writer_for(stream);
    if (writer != nullptr) {
        MalPromiseObject *ready =
            mal_value_to_promise_object(writer->as.writer.ready_promise);
        if (ready->state == MAL_PROMISE_PENDING) mal_promise_reject(vm, ready, roots[1]);
    }
    MalWritableStreamWriteRequest *request =
        controller->as.writable_controller.queue_head;
    if (controller->as.writable_controller.writing && request != nullptr &&
        !request->close) {
        request = request->next;
        controller->as.writable_controller.queue_head->next = nullptr;
        controller->as.writable_controller.queue_tail =
            controller->as.writable_controller.queue_head;
    } else {
        controller->as.writable_controller.queue_head = nullptr;
        controller->as.writable_controller.queue_tail = nullptr;
    }
    while (request != nullptr) {
        MalWritableStreamWriteRequest *next = request->next;
        mal_promise_reject(vm, mal_value_to_promise_object(request->promise), roots[1]);
        ws_free_request(request);
        request = next;
    }
    if (!controller->as.writable_controller.writing) {
        controller->as.writable_controller.queue_total_size = 0;
    }
    if (writer != nullptr) {
        MalPromiseObject *closed =
            mal_value_to_promise_object(writer->as.writer.closed_promise);
        if (closed->state == MAL_PROMISE_PENDING) mal_promise_reject(vm, closed, roots[1]);
    }
    mal_gc_unroot(&span);
}

static void ws_finish_close(MalVm *vm, MalReadableStreamObject *stream) {
    if (stream->as.writable_stream.state != MAL_READABLE_STREAM_READABLE) return;
    stream->as.writable_stream.state = MAL_READABLE_STREAM_CLOSED;
    MalReadableStreamObject *writer = ws_writer_for(stream);
    if (writer != nullptr) {
        ws_set_ready_fulfilled(vm, stream);
        MalPromiseObject *closed =
            mal_value_to_promise_object(writer->as.writer.closed_promise);
        if (closed->state == MAL_PROMISE_PENDING) {
            mal_promise_fulfill(vm, closed, mal_value_new_undefined());
        }
    }
}

static MalValue ws_operation_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalValue controller_value = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    if (!ws_is_kind(controller_value, MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER)) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller =
        mal_value_to_readable_stream_object(controller_value);
    MalWritableStreamWriteRequest *request =
        controller->as.writable_controller.queue_head;
    controller->as.writable_controller.writing = false;
    if (request == nullptr) return mal_value_new_undefined();
    controller->as.writable_controller.queue_head = request->next;
    if (request->next == nullptr) controller->as.writable_controller.queue_tail = nullptr;
    if (!request->close) {
        controller->as.writable_controller.queue_total_size -= request->size;
        if (controller->as.writable_controller.queue_total_size < 0) {
            controller->as.writable_controller.queue_total_size = 0;
        }
    }
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(
        controller->as.writable_controller.stream);
    if (!request->close ||
        stream->as.writable_stream.state == MAL_READABLE_STREAM_READABLE) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(request->promise),
            mal_value_new_undefined());
        if (request->close) ws_finish_close(vm, stream);
    }
    ws_free_request(request);
    ws_update_backpressure(vm, controller);
    ws_process_queue(vm, controller);
    return mal_value_new_undefined();
}

static MalValue ws_operation_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue controller_value = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    if (!ws_is_kind(controller_value, MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER)) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller =
        mal_value_to_readable_stream_object(controller_value);
    controller->as.writable_controller.writing = false;
    MalValue reason = argc >= 1 ? args[0] : mal_value_new_undefined();
    ws_error_stream(vm,
        mal_value_to_readable_stream_object(controller->as.writable_controller.stream),
        reason);
    return mal_value_new_undefined();
}

static void ws_process_queue(MalVm *vm, MalReadableStreamObject *controller) {
    if (!controller->as.writable_controller.started ||
        controller->as.writable_controller.writing ||
        controller->as.writable_controller.queue_head == nullptr) {
        return;
    }
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(
        controller->as.writable_controller.stream);
    if (stream->as.writable_stream.state != MAL_READABLE_STREAM_READABLE) return;
    MalWritableStreamWriteRequest *request =
        controller->as.writable_controller.queue_head;
    MalValue method = request->close
        ? controller->as.writable_controller.close_method
        : controller->as.writable_controller.write_method;
    MalValue roots[7] = {
        mal_value_from_readable_stream_object(controller),
        controller->as.writable_controller.underlying_sink,
        method, request->chunk, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 7);
    controller->as.writable_controller.writing = true;
    if (mal_value_is_undefined(method)) {
        roots[4] = ws_resolved_promise(vm);
        goto settle;
    }
    MalCompletion call;
    if (request->close) {
        call = mal_vm_call_value(vm, roots[2], roots[1], nullptr, 0);
    } else {
        MalValue call_args[2] = {roots[3], roots[0]};
        call = mal_vm_call_value(vm, roots[2], roots[1], call_args, 2);
    }
    if (call.kind == MAL_COMPLETION_THROW) {
        MalValue error = call.value;
        vm->completion = ws_normal();
        roots[4] = ws_rejected_promise(vm, error);
    } else if (!mal_promise_resolve_value(vm, call.value, &roots[4])) {
        MalValue error = vm->completion.value;
        vm->completion = ws_normal();
        roots[4] = ws_rejected_promise(vm, error);
    }
settle:
    roots[5] = ws_callback(vm, ws_operation_fulfilled, roots[0]);
    roots[6] = ws_callback(vm, ws_operation_rejected, roots[0]);
    mal_promise_perform_then(vm, roots[4], roots[5], roots[6],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
}

static MalValue ws_start_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalValue value = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    if (ws_is_kind(value, MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER)) {
        MalReadableStreamObject *controller = mal_value_to_readable_stream_object(value);
        controller->as.writable_controller.started = true;
        ws_process_queue(vm, controller);
    }
    return mal_value_new_undefined();
}

static MalValue ws_start_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue value = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    if (ws_is_kind(value, MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER)) {
        MalReadableStreamObject *controller = mal_value_to_readable_stream_object(value);
        controller->as.writable_controller.started = true;
        ws_error_stream(vm,
            mal_value_to_readable_stream_object(
                controller->as.writable_controller.stream),
            argc >= 1 ? args[0] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue ws_constructor(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor WritableStream requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[13] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        argc >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 13);
    if (!mal_value_is_nil(roots[1]) && !mal_value_is_object(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WritableStream strategy must be an object");
        goto fail;
    }
    f64 high_water_mark = 1;
    if (mal_value_is_object(roots[1])) {
        if (!mal_vm_get_property(vm, roots[1],
                mal_intrinsic_string_key(vm, (const byte *) "size"), &roots[6])) {
            goto fail;
        }
        if (!mal_value_is_undefined(roots[6]) && !mal_value_is_callable(roots[6])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "WritableStream strategy size must be callable");
            goto fail;
        }
        MalValue hwm;
        if (!mal_vm_get_property(vm, roots[1],
                mal_intrinsic_string_key(vm, (const byte *) "highWaterMark"), &hwm)) {
            goto fail;
        }
        if (!mal_value_is_undefined(hwm)) {
            if (!mal_vm_to_number(vm, hwm, &high_water_mark)) goto fail;
            if (isnan(high_water_mark) || high_water_mark < 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "WritableStream highWaterMark must be non-negative");
                goto fail;
            }
        }
    }
    if (!mal_value_is_nil(roots[0]) && !mal_value_is_object(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WritableStream underlyingSink must be an object");
        goto fail;
    }
    roots[2] = mal_value_is_nil(roots[0]) ? mal_value_new_undefined() : roots[0];
    if (mal_value_is_object(roots[2])) {
        MalValue type;
        if (!mal_vm_get_property(vm, roots[2],
                mal_intrinsic_string_key(vm, (const byte *) "type"), &type)) goto fail;
        if (!mal_value_is_undefined(type)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "WritableStream sink types are not supported");
            goto fail;
        }
        if (!ws_get_method(vm, roots[2], (const byte *) "start", &roots[3]) ||
            !ws_get_method(vm, roots[2], (const byte *) "write", &roots[4]) ||
            !ws_get_method(vm, roots[2], (const byte *) "close", &roots[5]) ||
            !ws_get_method(vm, roots[2], (const byte *) "abort", &roots[7])) {
            goto fail;
        }
    }
    MalObject *stream_proto = ws_instance_prototype(
        vm, new_target, MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE);
    if (stream_proto == nullptr) goto fail;
    MalReadableStreamObject *stream = ws_new(vm, MAL_WRITABLE_STREAM, stream_proto);
    roots[8] = mal_value_from_readable_stream_object(stream);
    stream->as.writable_stream.state = MAL_READABLE_STREAM_READABLE;
    stream->as.writable_stream.controller = mal_value_new_undefined();
    stream->as.writable_stream.writer = mal_value_new_undefined();
    stream->as.writable_stream.stored_error = mal_value_new_undefined();
    MalReadableStreamObject *controller = ws_new(vm,
        MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE]));
    roots[9] = mal_value_from_readable_stream_object(controller);
    controller->as.writable_controller.stream = roots[8];
    controller->as.writable_controller.underlying_sink = roots[2];
    controller->as.writable_controller.write_method = roots[4];
    controller->as.writable_controller.close_method = roots[5];
    controller->as.writable_controller.abort_method = roots[7];
    controller->as.writable_controller.size_algorithm = roots[6];
    controller->as.writable_controller.queue_head = nullptr;
    controller->as.writable_controller.queue_tail = nullptr;
    controller->as.writable_controller.queue_total_size = 0;
    controller->as.writable_controller.high_water_mark = high_water_mark;
    controller->as.writable_controller.started = false;
    controller->as.writable_controller.writing = false;
    controller->as.writable_controller.close_requested = false;
    stream->as.writable_stream.controller = roots[9];
    mal_gc_card(&stream->object.header, roots[9]);
    MalValue start_result = mal_value_new_undefined();
    if (!mal_value_is_undefined(roots[3])) {
        MalCompletion call = mal_vm_call_value(vm, roots[3], roots[2], &roots[9], 1);
        if (call.kind == MAL_COMPLETION_THROW) goto fail;
        start_result = call.value;
    }
    if (!mal_promise_resolve_value(vm, start_result, &roots[10])) goto fail;
    roots[11] = ws_callback(vm, ws_start_fulfilled, roots[9]);
    roots[12] = ws_callback(vm, ws_start_rejected, roots[9]);
    mal_promise_perform_then(vm, roots[10], roots[11], roots[12],
        mal_value_new_undefined(), mal_value_new_undefined());
    MalValue result = roots[8];
    mal_gc_unroot(&span);
    return result;
fail:
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static MalValue ws_get_locked(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = ws_require(vm, self, MAL_WRITABLE_STREAM,
        "WritableStream.locked called on incompatible receiver");
    if (stream == nullptr) return mal_value_new_undefined();
    return mal_value_new_boolean(!mal_value_is_undefined(stream->as.writable_stream.writer));
}

static MalReadableStreamObject *ws_acquire_writer(
    MalVm *vm, MalReadableStreamObject *stream, MalObject *prototype) {
    if (!mal_value_is_undefined(stream->as.writable_stream.writer)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WritableStream is already locked");
        return nullptr;
    }
    MalValue roots[4] = {
        mal_value_from_readable_stream_object(stream),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalReadableStreamObject *writer =
        ws_new(vm, MAL_WRITABLE_STREAM_DEFAULT_WRITER, prototype);
    roots[1] = mal_value_from_readable_stream_object(writer);
    roots[2] = mal_value_from_promise_object(ws_new_promise(vm));
    roots[3] = mal_value_from_promise_object(ws_new_promise(vm));
    writer->as.writer.stream = roots[0];
    writer->as.writer.closed_promise = roots[2];
    writer->as.writer.ready_promise = roots[3];
    MalReadableStreamObject *controller = ws_controller_for(stream);
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_CLOSED) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[2]),
            mal_value_new_undefined());
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[3]),
            mal_value_new_undefined());
    } else if (stream->as.writable_stream.state == MAL_READABLE_STREAM_ERRORED) {
        mal_promise_reject(vm, mal_value_to_promise_object(roots[2]),
            stream->as.writable_stream.stored_error);
        mal_promise_reject(vm, mal_value_to_promise_object(roots[3]),
            stream->as.writable_stream.stored_error);
    } else if (controller->as.writable_controller.queue_total_size <
        controller->as.writable_controller.high_water_mark) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[3]),
            mal_value_new_undefined());
    }
    stream->as.writable_stream.writer = roots[1];
    mal_gc_card(&stream->object.header, roots[1]);
    mal_gc_unroot(&span);
    return writer;
}

static MalValue ws_writer_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor WritableStreamDefaultWriter requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue stream_value = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalReadableStreamObject *stream = ws_require(vm, stream_value, MAL_WRITABLE_STREAM,
        "WritableStreamDefaultWriter requires a WritableStream");
    if (stream == nullptr) return mal_value_new_undefined();
    MalObject *prototype = ws_instance_prototype(vm, new_target,
        MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_PROTOTYPE);
    if (prototype == nullptr) return mal_value_new_undefined();
    MalReadableStreamObject *writer = ws_acquire_writer(vm, stream, prototype);
    return writer == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(writer);
}

static MalValue ws_get_writer(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = ws_require(vm, self, MAL_WRITABLE_STREAM,
        "WritableStream.getWriter called on incompatible receiver");
    if (stream == nullptr) return mal_value_new_undefined();
    MalReadableStreamObject *writer = ws_acquire_writer(vm, stream,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_PROTOTYPE]));
    return writer == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(writer);
}

static MalReadableStreamObject *ws_require_writer(MalVm *vm, MalValue self) {
    return ws_require(vm, self, MAL_WRITABLE_STREAM_DEFAULT_WRITER,
        "WritableStreamDefaultWriter method called on incompatible receiver");
}

static MalValue ws_writer_get_closed(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    return writer == nullptr ? mal_value_new_undefined() : writer->as.writer.closed_promise;
}

static MalValue ws_writer_get_ready(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    return writer == nullptr ? mal_value_new_undefined() : writer->as.writer.ready_promise;
}

static MalValue ws_writer_get_desired_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    if (writer == nullptr) return mal_value_new_undefined();
    if (mal_value_is_undefined(writer->as.writer.stream)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "WritableStreamDefaultWriter has been released");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(writer->as.writer.stream);
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_ERRORED) {
        return mal_value_new_null();
    }
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_CLOSED) {
        return mal_value_from_i32(0);
    }
    MalReadableStreamObject *controller = ws_controller_for(stream);
    return mal_value_from_f64_convert_nan(
        controller->as.writable_controller.high_water_mark -
        controller->as.writable_controller.queue_total_size);
}

static MalValue ws_enqueue(MalVm *vm, MalReadableStreamObject *stream,
    MalValue chunk, bool close) {
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_ERRORED) {
        return ws_rejected_promise(vm, stream->as.writable_stream.stored_error);
    }
    MalReadableStreamObject *controller = ws_controller_for(stream);
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_CLOSED ||
        controller->as.writable_controller.close_requested) {
        return ws_rejected_type_error(vm, "WritableStream is closing or closed");
    }
    MalValue roots[4] = {
        mal_value_from_readable_stream_object(stream), chunk,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    f64 chunk_size = 1;
    if (!close && !mal_value_is_undefined(controller->as.writable_controller.size_algorithm)) {
        MalCompletion call = mal_vm_call_value(vm,
            controller->as.writable_controller.size_algorithm,
            mal_value_new_undefined(), &roots[1], 1);
        if (call.kind == MAL_COMPLETION_THROW) {
            vm->completion = ws_normal();
            ws_error_stream(vm, stream, call.value);
            MalValue result = ws_rejected_promise(vm, call.value);
            mal_gc_unroot(&span);
            return result;
        }
        if (!mal_vm_to_number(vm, call.value, &chunk_size)) {
            MalValue error = vm->completion.value;
            vm->completion = ws_normal();
            ws_error_stream(vm, stream, error);
            MalValue result = ws_rejected_promise(vm, error);
            mal_gc_unroot(&span);
            return result;
        }
        if (!isfinite(chunk_size) || chunk_size < 0) {
            MalValue error = ws_take_range_error(vm,
                "WritableStream chunk size must be finite and non-negative");
            ws_error_stream(vm, stream, error);
            MalValue result = ws_rejected_promise(vm, error);
            mal_gc_unroot(&span);
            return result;
        }
    }
    roots[2] = mal_value_from_promise_object(ws_new_promise(vm));
    MalWritableStreamWriteRequest *request = calloc(1, sizeof(*request));
    if (request == nullptr) abort();
    request->chunk = roots[1];
    request->promise = roots[2];
    request->size = chunk_size;
    request->close = close;
    if (controller->as.writable_controller.queue_tail == nullptr) {
        controller->as.writable_controller.queue_head = request;
    } else {
        controller->as.writable_controller.queue_tail->next = request;
    }
    controller->as.writable_controller.queue_tail = request;
    if (close) {
        controller->as.writable_controller.close_requested = true;
    } else {
        controller->as.writable_controller.queue_total_size += chunk_size;
    }
    mal_gc_card(&controller->object.header, roots[1]);
    mal_gc_card(&controller->object.header, roots[2]);
    ws_update_backpressure(vm, controller);
    ws_process_queue(vm, controller);
    MalValue result = roots[2];
    mal_gc_unroot(&span);
    return result;
}

static MalValue ws_writer_write(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    if (writer == nullptr) return mal_value_new_undefined();
    if (mal_value_is_undefined(writer->as.writer.stream)) {
        return ws_rejected_type_error(vm, "WritableStreamDefaultWriter has been released");
    }
    return ws_enqueue(vm, mal_value_to_readable_stream_object(writer->as.writer.stream),
        argc >= 1 ? args[0] : mal_value_new_undefined(), false);
}

static MalValue ws_writer_close(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    if (writer == nullptr) return mal_value_new_undefined();
    if (mal_value_is_undefined(writer->as.writer.stream)) {
        return ws_rejected_type_error(vm, "WritableStreamDefaultWriter has been released");
    }
    return ws_enqueue(vm, mal_value_to_readable_stream_object(writer->as.writer.stream),
        mal_value_new_undefined(), true);
}

static MalValue ws_abort_stream(
    MalVm *vm, MalReadableStreamObject *stream, MalValue reason) {
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_CLOSED) {
        return ws_resolved_promise(vm);
    }
    if (stream->as.writable_stream.state == MAL_READABLE_STREAM_ERRORED) {
        return ws_resolved_promise(vm);
    }
    MalValue roots[4] = {
        mal_value_from_readable_stream_object(stream), reason,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalReadableStreamObject *controller = ws_controller_for(stream);
    MalValue abort_method = controller->as.writable_controller.abort_method;
    MalValue sink = controller->as.writable_controller.underlying_sink;
    ws_error_stream(vm, stream, roots[1]);
    if (mal_value_is_undefined(abort_method)) {
        roots[2] = ws_resolved_promise(vm);
    } else {
        MalCompletion call = mal_vm_call_value(vm, abort_method, sink, &roots[1], 1);
        if (call.kind == MAL_COMPLETION_THROW) {
            vm->completion = ws_normal();
            roots[2] = ws_rejected_promise(vm, call.value);
        } else if (!mal_promise_resolve_value(vm, call.value, &roots[2])) {
            MalValue error = vm->completion.value;
            vm->completion = ws_normal();
            roots[2] = ws_rejected_promise(vm, error);
        }
    }
    MalValue result = roots[2];
    mal_gc_unroot(&span);
    return result;
}

static MalValue ws_writer_abort(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    if (writer == nullptr) return mal_value_new_undefined();
    if (mal_value_is_undefined(writer->as.writer.stream)) {
        return ws_rejected_type_error(vm, "WritableStreamDefaultWriter has been released");
    }
    return ws_abort_stream(vm,
        mal_value_to_readable_stream_object(writer->as.writer.stream),
        argc >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue ws_writer_release(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *writer = ws_require_writer(vm, self);
    if (writer == nullptr) return mal_value_new_undefined();
    if (mal_value_is_undefined(writer->as.writer.stream)) return mal_value_new_undefined();
    MalValue roots[2] = {self,
        ws_take_type_error(vm, "WritableStreamDefaultWriter lock released")};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(writer->as.writer.stream);
    MalPromiseObject *ready = mal_value_to_promise_object(writer->as.writer.ready_promise);
    if (ready->state == MAL_PROMISE_PENDING) mal_promise_reject(vm, ready, roots[1]);
    else {
        MalValue replacement = ws_rejected_promise(vm, roots[1]);
        mal_gc_write_barrier(writer->as.writer.ready_promise);
        writer->as.writer.ready_promise = replacement;
        mal_gc_card(&writer->object.header, replacement);
    }
    MalPromiseObject *closed = mal_value_to_promise_object(writer->as.writer.closed_promise);
    if (closed->state == MAL_PROMISE_PENDING) mal_promise_reject(vm, closed, roots[1]);
    else {
        MalValue replacement = ws_rejected_promise(vm, roots[1]);
        mal_gc_write_barrier(writer->as.writer.closed_promise);
        writer->as.writer.closed_promise = replacement;
        mal_gc_card(&writer->object.header, replacement);
    }
    stream->as.writable_stream.writer = mal_value_new_undefined();
    writer->as.writer.stream = mal_value_new_undefined();
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

bool mal_writable_stream_is_stream(MalValue value) {
    return ws_is_kind(value, MAL_WRITABLE_STREAM);
}

bool mal_writable_stream_is_locked(MalValue value) {
    return ws_is_kind(value, MAL_WRITABLE_STREAM) &&
        !mal_value_is_undefined(
            mal_value_to_readable_stream_object(value)->as.writable_stream.writer);
}

MalValue mal_writable_stream_acquire_default_writer(MalVm *vm, MalValue value) {
    MalReadableStreamObject *stream = ws_require(vm, value, MAL_WRITABLE_STREAM,
        "Expected a WritableStream");
    if (stream == nullptr) return mal_value_new_undefined();
    MalReadableStreamObject *writer = ws_acquire_writer(vm, stream,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_PROTOTYPE]));
    return writer == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(writer);
}

MalValue mal_writable_stream_default_writer_ready(MalValue value) {
    return mal_value_to_readable_stream_object(value)->as.writer.ready_promise;
}

MalValue mal_writable_stream_default_writer_closed(MalValue value) {
    return mal_value_to_readable_stream_object(value)->as.writer.closed_promise;
}

MalValue mal_writable_stream_default_writer_write(
    MalVm *vm, MalValue value, MalValue chunk) {
    return ws_writer_write(vm, value, &chunk, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

MalValue mal_writable_stream_default_writer_close(MalVm *vm, MalValue value) {
    return ws_writer_close(vm, value, nullptr, 0,
        mal_value_new_undefined(), mal_value_new_undefined());
}

MalValue mal_writable_stream_default_writer_abort(
    MalVm *vm, MalValue value, MalValue reason) {
    return ws_writer_abort(vm, value, &reason, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

void mal_writable_stream_default_writer_release(MalVm *vm, MalValue value) {
    MalReadableStreamObject *writer = mal_value_to_readable_stream_object(value);
    mal_value_to_promise_object(writer->as.writer.ready_promise)->is_handled = true;
    mal_value_to_promise_object(writer->as.writer.closed_promise)->is_handled = true;
    (void) ws_writer_release(vm, value, nullptr, 0,
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_value_to_promise_object(writer->as.writer.ready_promise)->is_handled = true;
    mal_value_to_promise_object(writer->as.writer.closed_promise)->is_handled = true;
}

static MalValue ws_stream_abort(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = ws_require(vm, self, MAL_WRITABLE_STREAM,
        "WritableStream.abort called on incompatible receiver");
    if (stream == nullptr) return mal_value_new_undefined();
    if (!mal_value_is_undefined(stream->as.writable_stream.writer)) {
        return ws_rejected_type_error(vm, "Cannot abort a locked WritableStream");
    }
    return ws_abort_stream(vm, stream,
        argc >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue ws_stream_close(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = ws_require(vm, self, MAL_WRITABLE_STREAM,
        "WritableStream.close called on incompatible receiver");
    if (stream == nullptr) return mal_value_new_undefined();
    if (!mal_value_is_undefined(stream->as.writable_stream.writer)) {
        return ws_rejected_type_error(vm, "Cannot close a locked WritableStream");
    }
    return ws_enqueue(vm, stream, mal_value_new_undefined(), true);
}

static MalValue ws_controller_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Illegal WritableStreamDefaultController constructor");
    return mal_value_new_undefined();
}

static MalValue ws_controller_error(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = ws_require(vm, self,
        MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER,
        "WritableStreamDefaultController.error called on incompatible receiver");
    if (controller == nullptr) return mal_value_new_undefined();
    ws_error_stream(vm,
        mal_value_to_readable_stream_object(controller->as.writable_controller.stream),
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue ws_controller_get_signal(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (ws_require(vm, self, MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER,
            "WritableStreamDefaultController.signal called on incompatible receiver") ==
        nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

static void ws_define_getter(MalVm *vm, MalObject *prototype, const byte *name,
    const byte *display_name, MalNativeFunctionCallback callback) {
    MalObject *fn_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap, fn_proto, mal_intrinsic_ascii(vm, display_name), callback)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, name), &desc);
}

static MalObject *ws_install_class(MalVm *vm, MalObject *global_this,
    const byte *name, i32 length, MalNativeFunctionCallback callback,
    MalIntrinsic constructor_slot, MalIntrinsic prototype_slot) {
    MalObject *prototype = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name), length, callback);
    mal_native_function_object_set_constructor(constructor);
    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
        vm->intrinsics[prototype_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor",
        vm->intrinsics[constructor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, name)), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
    mal_intrinsic_define_data(vm, global_this, name, vm->intrinsics[constructor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return prototype;
}

void mal_writable_stream_install(MalVm *vm, MalObject *global_this) {
    MalObject *stream_proto = ws_install_class(vm, global_this,
        (const byte *) "WritableStream", 0, ws_constructor,
        MAL_INTRINSIC_WRITABLE_STREAM_CONSTRUCTOR,
        MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE);
    ws_define_getter(vm, stream_proto, (const byte *) "locked",
        (const byte *) "get locked", ws_get_locked);
    mal_intrinsic_define_method_n(vm, stream_proto,
        (const byte *) "abort", 1, ws_stream_abort);
    mal_intrinsic_define_method_n(vm, stream_proto,
        (const byte *) "close", 0, ws_stream_close);
    mal_intrinsic_define_method_n(vm, stream_proto,
        (const byte *) "getWriter", 0, ws_get_writer);

    MalObject *controller_proto = ws_install_class(vm, global_this,
        (const byte *) "WritableStreamDefaultController", 0,
        ws_controller_constructor,
        MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_CONTROLLER_CONSTRUCTOR,
        MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE);
    ws_define_getter(vm, controller_proto, (const byte *) "signal",
        (const byte *) "get signal", ws_controller_get_signal);
    mal_intrinsic_define_method_n(vm, controller_proto,
        (const byte *) "error", 1, ws_controller_error);

    MalObject *writer_proto = ws_install_class(vm, global_this,
        (const byte *) "WritableStreamDefaultWriter", 1,
        ws_writer_constructor,
        MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_CONSTRUCTOR,
        MAL_INTRINSIC_WRITABLE_STREAM_DEFAULT_WRITER_PROTOTYPE);
    ws_define_getter(vm, writer_proto, (const byte *) "closed",
        (const byte *) "get closed", ws_writer_get_closed);
    ws_define_getter(vm, writer_proto, (const byte *) "desiredSize",
        (const byte *) "get desiredSize", ws_writer_get_desired_size);
    ws_define_getter(vm, writer_proto, (const byte *) "ready",
        (const byte *) "get ready", ws_writer_get_ready);
    mal_intrinsic_define_method_n(vm, writer_proto,
        (const byte *) "abort", 1, ws_writer_abort);
    mal_intrinsic_define_method_n(vm, writer_proto,
        (const byte *) "close", 0, ws_writer_close);
    mal_intrinsic_define_method_n(vm, writer_proto,
        (const byte *) "releaseLock", 0, ws_writer_release);
    mal_intrinsic_define_method_n(vm, writer_proto,
        (const byte *) "write", 1, ws_writer_write);
}
