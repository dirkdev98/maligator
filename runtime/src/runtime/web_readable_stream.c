#include "web_readable_stream_object.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "promise_object.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static void rs_call_pull_if_needed(MalVm *vm, MalReadableStreamObject *controller);
static MalReadableStreamObject *rs_acquire_reader(
    MalVm *vm, MalReadableStreamObject *stream, MalObject *prototype);

static MalCompletion rs_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static MalValue rs_take_type_error(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
    MalValue error = vm->completion.value;
    vm->completion = rs_normal();
    return error;
}

static MalValue rs_take_range_error(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message);
    MalValue error = vm->completion.value;
    vm->completion = rs_normal();
    return error;
}

static MalReadableStreamObject *rs_new(
    MalVm *vm, MalReadableStreamKind kind, MalObject *prototype) {
    MalReadableStreamObject *object = mal_heap_alloc(
        &vm->heap, sizeof(MalReadableStreamObject), MAL_HEAP_READABLE_STREAM_OBJECT);
    mal_object_init(&vm->heap, &object->object, MAL_HEAP_READABLE_STREAM_OBJECT, prototype);
    object->kind = kind;
    return object;
}

static bool rs_is_kind(MalValue value, MalReadableStreamKind kind) {
    return mal_value_is_readable_stream_object(value) &&
        mal_value_to_readable_stream_object(value)->kind == kind;
}

static MalReadableStreamObject *rs_require(
    MalVm *vm, MalValue value, MalReadableStreamKind kind, const byte *message) {
    if (!rs_is_kind(value, kind)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }
    return mal_value_to_readable_stream_object(value);
}

static MalPromiseObject *rs_new_promise(MalVm *vm) {
    return mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
}

static MalValue rs_resolved_promise(MalVm *vm, MalValue value) {
    MalValue roots[2] = {value, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_value_from_promise_object(rs_new_promise(vm));
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    mal_gc_unroot(&span);
    return roots[1];
}

static MalValue rs_rejected_promise(MalVm *vm, MalValue reason) {
    MalValue roots[2] = {reason, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_value_from_promise_object(rs_new_promise(vm));
    mal_promise_reject(vm, mal_value_to_promise_object(roots[1]), roots[0]);
    mal_gc_unroot(&span);
    return roots[1];
}

static MalValue rs_rejected_type_error(MalVm *vm, const byte *message) {
    MalValue error = rs_take_type_error(vm, message);
    return rs_rejected_promise(vm, error);
}

static MalValue rs_read_result(MalVm *vm, MalValue value, bool done) {
    MalValue roots[2] = {value, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[1]), (const byte *) "value", roots[0], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "done",
        mal_value_new_boolean(done), flags);
    mal_gc_unroot(&span);
    return roots[1];
}

static MalReadableStreamObject *rs_controller_for(MalReadableStreamObject *stream) {
    return mal_value_to_readable_stream_object(stream->as.stream.controller);
}

static MalReadableStreamObject *rs_reader_for(MalReadableStreamObject *stream) {
    if (mal_value_is_undefined(stream->as.stream.reader)) {
        return nullptr;
    }
    return mal_value_to_readable_stream_object(stream->as.stream.reader);
}

static void rs_clear_algorithms(MalReadableStreamObject *controller) {
    mal_gc_write_barrier(controller->as.controller.underlying_source);
    mal_gc_write_barrier(controller->as.controller.pull_method);
    mal_gc_write_barrier(controller->as.controller.cancel_method);
    mal_gc_write_barrier(controller->as.controller.size_algorithm);
    controller->as.controller.underlying_source = mal_value_new_undefined();
    controller->as.controller.pull_method = mal_value_new_undefined();
    controller->as.controller.cancel_method = mal_value_new_undefined();
    controller->as.controller.size_algorithm = mal_value_new_undefined();
}

static void rs_queue_clear(MalReadableStreamObject *controller) {
    MalReadableStreamQueueEntry *entry = controller->as.controller.queue_head;
    while (entry != nullptr) {
        MalReadableStreamQueueEntry *next = entry->next;
        mal_gc_write_barrier(entry->chunk);
        free(entry);
        entry = next;
    }
    controller->as.controller.queue_head = nullptr;
    controller->as.controller.queue_tail = nullptr;
    controller->as.controller.queue_total_size = 0;
}

static void rs_request_remove(
    MalReadableStreamObject *reader, MalReadableStreamReadRequest *request) {
    reader->as.reader.requests_head = request->next;
    if (reader->as.reader.requests_head == nullptr) {
        reader->as.reader.requests_tail = nullptr;
    }
    mal_gc_write_barrier(request->promise);
    free(request);
}

static void rs_close_stream(MalVm *vm, MalReadableStreamObject *stream) {
    if (stream->as.stream.state != MAL_READABLE_STREAM_READABLE) {
        return;
    }
    stream->as.stream.state = MAL_READABLE_STREAM_CLOSED;
    rs_clear_algorithms(rs_controller_for(stream));

    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader == nullptr) {
        return;
    }
    mal_promise_fulfill(
        vm, mal_value_to_promise_object(reader->as.reader.closed_promise), mal_value_new_undefined());
    while (reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        MalValue roots[2] = {request->promise, mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, roots, 2);
        roots[1] = rs_read_result(vm, mal_value_new_undefined(), true);
        rs_request_remove(reader, request);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[1]);
        mal_gc_unroot(&span);
    }
}

MalValue mal_readable_stream_from_bytes(
    MalVm *vm, const byte *bytes, usize length) {
    if (length > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStream byte source is too large");
        return mal_value_new_undefined();
    }
    MalValue roots[4] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);

    MalReadableStreamObject *stream = rs_new(vm, MAL_READABLE_STREAM,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_READABLE_STREAM_PROTOTYPE]));
    roots[0] = mal_value_from_readable_stream_object(stream);
    stream->as.stream.state = MAL_READABLE_STREAM_READABLE;
    stream->as.stream.controller = mal_value_new_undefined();
    stream->as.stream.reader = mal_value_new_undefined();
    stream->as.stream.stored_error = mal_value_new_undefined();
    stream->as.stream.disturbed = false;

    MalReadableStreamObject *controller = rs_new(vm,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE]));
    roots[1] = mal_value_from_readable_stream_object(controller);
    controller->as.controller.stream = roots[0];
    controller->as.controller.underlying_source = mal_value_new_undefined();
    controller->as.controller.pull_method = mal_value_new_undefined();
    controller->as.controller.cancel_method = mal_value_new_undefined();
    controller->as.controller.size_algorithm = mal_value_new_undefined();
    controller->as.controller.queue_head = nullptr;
    controller->as.controller.queue_tail = nullptr;
    controller->as.controller.queue_total_size = length == 0 ? 0 : 1;
    controller->as.controller.high_water_mark = 1;
    controller->as.controller.started = true;
    controller->as.controller.close_requested = true;
    controller->as.controller.pulling = false;
    controller->as.controller.pull_again = false;
    stream->as.stream.controller = roots[1];
    mal_gc_card(&stream->object.header, roots[1]);

    if (length == 0) {
        rs_close_stream(vm, stream);
        MalValue result = roots[0];
        mal_gc_unroot(&span);
        return result;
    }

    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false);
    roots[3] = mal_value_from_array_buffer_object(buffer);
    if (buffer->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStream byte source allocation failed");
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    memcpy(buffer->data, bytes, length);
    roots[2] = mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) length, false));

    MalReadableStreamQueueEntry *entry = malloc(sizeof(MalReadableStreamQueueEntry));
    if (entry == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStream queue allocation failed");
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    entry->next = nullptr;
    entry->chunk = roots[2];
    entry->size = 1;
    controller->as.controller.queue_head = entry;
    controller->as.controller.queue_tail = entry;
    mal_gc_card(&controller->object.header, roots[2]);

    MalValue result = roots[0];
    mal_gc_unroot(&span);
    return result;
}

bool mal_readable_stream_is_locked(MalValue value) {
    return rs_is_kind(value, MAL_READABLE_STREAM) &&
        !mal_value_is_undefined(
            mal_value_to_readable_stream_object(value)->as.stream.reader);
}

bool mal_readable_stream_is_disturbed(MalValue value) {
    return rs_is_kind(value, MAL_READABLE_STREAM) &&
        mal_value_to_readable_stream_object(value)->as.stream.disturbed;
}

bool mal_readable_stream_consume(MalVm *vm, MalValue value) {
    if (!rs_is_kind(value, MAL_READABLE_STREAM)) {
        return false;
    }
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(value);
    if (!mal_value_is_undefined(stream->as.stream.reader) ||
        stream->as.stream.disturbed) {
        return false;
    }
    if (rs_acquire_reader(vm, stream,
            mal_value_to_object(vm->intrinsics[
                MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE])) == nullptr) {
        return false;
    }
    stream->as.stream.disturbed = true;
    if (stream->as.stream.state == MAL_READABLE_STREAM_READABLE) {
        rs_queue_clear(rs_controller_for(stream));
        rs_close_stream(vm, stream);
    }
    return true;
}

static void rs_error_stream(
    MalVm *vm, MalReadableStreamObject *stream, MalValue error) {
    if (stream->as.stream.state != MAL_READABLE_STREAM_READABLE) {
        return;
    }
    stream->as.stream.state = MAL_READABLE_STREAM_ERRORED;
    mal_gc_write_barrier(stream->as.stream.stored_error);
    stream->as.stream.stored_error = error;
    mal_gc_card(&stream->object.header, error);
    MalReadableStreamObject *controller = rs_controller_for(stream);
    rs_queue_clear(controller);
    rs_clear_algorithms(controller);

    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader == nullptr) {
        return;
    }
    mal_promise_reject(vm, mal_value_to_promise_object(reader->as.reader.closed_promise), error);
    while (reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        MalValue promise = request->promise;
        MalRootSpan span;
        mal_gc_root(&span, &promise, 1);
        rs_request_remove(reader, request);
        mal_promise_reject(vm, mal_value_to_promise_object(promise), error);
        mal_gc_unroot(&span);
    }
}

static f64 rs_desired_size(MalReadableStreamObject *controller) {
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    if (stream->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        return NAN;
    }
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        return 0;
    }
    return controller->as.controller.high_water_mark -
        controller->as.controller.queue_total_size;
}

static bool rs_chunk_size(MalVm *vm, MalReadableStreamObject *controller,
    MalValue chunk, f64 *size_out) {
    if (mal_value_is_undefined(controller->as.controller.size_algorithm)) {
        *size_out = 1;
        return true;
    }

    MalValue roots[4] = {
        mal_value_from_readable_stream_object(controller), chunk,
        controller->as.controller.size_algorithm, mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    MalCompletion call = mal_vm_call_value(
        vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
    if (call.kind == MAL_COMPLETION_THROW) {
        roots[3] = call.value;
        vm->completion = rs_normal();
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream), roots[3]);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
        mal_gc_unroot(&span);
        return false;
    }
    roots[3] = call.value;

    f64 chunk_size;
    if (!mal_vm_to_number(vm, roots[3], &chunk_size)) {
        roots[1] = vm->completion.value;
        vm->completion = rs_normal();
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream), roots[1]);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[1]};
        mal_gc_unroot(&span);
        return false;
    }
    if (!isfinite(chunk_size) || chunk_size < 0) {
        roots[3] = rs_take_range_error(
            vm, (const byte *) "ReadableStream chunk size must be finite and non-negative");
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream), roots[3]);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
        mal_gc_unroot(&span);
        return false;
    }
    *size_out = chunk_size;
    mal_gc_unroot(&span);
    return true;
}

static bool rs_should_call_pull(MalReadableStreamObject *controller) {
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    if (!controller->as.controller.started || controller->as.controller.close_requested ||
        stream->as.stream.state != MAL_READABLE_STREAM_READABLE) {
        return false;
    }
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader != nullptr && reader->as.reader.requests_head != nullptr) {
        return true;
    }
    return rs_desired_size(controller) > 0;
}

static MalValue rs_pull_fulfilled(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalValue controller_value =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (!rs_is_kind(controller_value, MAL_READABLE_STREAM_DEFAULT_CONTROLLER)) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller =
        mal_value_to_readable_stream_object(controller_value);
    controller->as.controller.pulling = false;
    if (controller->as.controller.pull_again) {
        controller->as.controller.pull_again = false;
        rs_call_pull_if_needed(vm, controller);
    }
    return mal_value_new_undefined();
}

static MalValue rs_pull_rejected(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue controller_value =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (!rs_is_kind(controller_value, MAL_READABLE_STREAM_DEFAULT_CONTROLLER)) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller =
        mal_value_to_readable_stream_object(controller_value);
    controller->as.controller.pulling = false;
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    rs_error_stream(vm, stream, argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_callback(
    MalVm *vm, MalNativeFunctionCallback callback, MalValue slot) {
    MalObject *fn_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) ""), callback, &slot, 1));
}

static void rs_call_pull_if_needed(MalVm *vm, MalReadableStreamObject *controller) {
    if (!rs_should_call_pull(controller)) {
        return;
    }
    if (controller->as.controller.pulling) {
        controller->as.controller.pull_again = true;
        return;
    }
    controller->as.controller.pulling = true;
    if (mal_value_is_undefined(controller->as.controller.pull_method)) {
        controller->as.controller.pulling = false;
        return;
    }

    MalValue roots[6] = {
        mal_value_from_readable_stream_object(controller),
        controller->as.controller.underlying_source,
        controller->as.controller.pull_method,
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 6);
    MalCompletion call = mal_vm_call_value(vm, roots[2], roots[1], roots, 1);
    if (call.kind == MAL_COMPLETION_THROW) {
        MalValue error = call.value;
        vm->completion = rs_normal();
        controller->as.controller.pulling = false;
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream), error);
        mal_gc_unroot(&span);
        return;
    }
    if (!mal_promise_resolve_value(vm, call.value, &roots[3])) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        controller->as.controller.pulling = false;
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream), error);
        mal_gc_unroot(&span);
        return;
    }
    roots[4] = rs_callback(vm, rs_pull_fulfilled, roots[0]);
    roots[5] = rs_callback(vm, rs_pull_rejected, roots[0]);
    mal_promise_perform_then(vm, roots[3], roots[4], roots[5],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
}

static MalValue rs_start_fulfilled(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalValue value =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (rs_is_kind(value, MAL_READABLE_STREAM_DEFAULT_CONTROLLER)) {
        MalReadableStreamObject *controller = mal_value_to_readable_stream_object(value);
        controller->as.controller.started = true;
        rs_call_pull_if_needed(vm, controller);
    }
    return mal_value_new_undefined();
}

static MalValue rs_start_rejected(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue value =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (rs_is_kind(value, MAL_READABLE_STREAM_DEFAULT_CONTROLLER)) {
        MalReadableStreamObject *controller = mal_value_to_readable_stream_object(value);
        controller->as.controller.started = true;
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream),
            argc >= 1 ? args[0] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static bool rs_get_method(
    MalVm *vm, MalValue object, const byte *name, MalValue *out) {
    if (!mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, name), out)) {
        return false;
    }
    if (!mal_value_is_undefined(*out) && !mal_value_is_callable(*out)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream underlying source method is not callable");
        return false;
    }
    return true;
}

static MalObject *rs_instance_prototype(
    MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(vm, new_target, fallback, &prototype)) {
        return nullptr;
    }
    return prototype;
}

static MalValue rs_constructor(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor ReadableStream requires 'new'");
        return mal_value_new_undefined();
    }

    MalValue roots[10] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        argc >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 10);
    if (!mal_value_is_nil(roots[0]) && !mal_value_is_object(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream underlyingSource must be an object");
        goto fail;
    }
    if (!mal_value_is_nil(roots[1]) && !mal_value_is_object(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream strategy must be an object");
        goto fail;
    }

    f64 high_water_mark = 1;
    if (mal_value_is_object(roots[1])) {
        MalValue hwm;
        if (!mal_vm_get_property(vm, roots[1],
                mal_intrinsic_string_key(vm, (const byte *) "highWaterMark"), &hwm)) {
            goto fail;
        }
        if (!mal_value_is_undefined(hwm)) {
            if (!mal_vm_to_number(vm, hwm, &high_water_mark)) {
                goto fail;
            }
            if (isnan(high_water_mark) || high_water_mark < 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "ReadableStream highWaterMark must be non-negative");
                goto fail;
            }
        }
        if (!mal_vm_get_property(vm, roots[1],
                mal_intrinsic_string_key(vm, (const byte *) "size"), &roots[9])) {
            goto fail;
        }
        if (!mal_value_is_undefined(roots[9]) && !mal_value_is_callable(roots[9])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "ReadableStream strategy size must be callable");
            goto fail;
        }
    }

    MalValue source = mal_value_is_nil(roots[0]) ? mal_value_new_undefined() : roots[0];
    roots[2] = source;
    if (mal_value_is_object(source)) {
        MalValue type;
        if (!mal_vm_get_property(vm, source,
                mal_intrinsic_string_key(vm, (const byte *) "type"), &type)) {
            goto fail;
        }
        if (!mal_value_is_undefined(type)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "ReadableStream byte sources are not supported");
            goto fail;
        }
        if (!rs_get_method(vm, source, (const byte *) "start", &roots[3]) ||
            !rs_get_method(vm, source, (const byte *) "pull", &roots[4]) ||
            !rs_get_method(vm, source, (const byte *) "cancel", &roots[5])) {
            goto fail;
        }
    }

    MalObject *stream_proto =
        rs_instance_prototype(vm, new_target, MAL_INTRINSIC_READABLE_STREAM_PROTOTYPE);
    if (stream_proto == nullptr) {
        goto fail;
    }
    MalReadableStreamObject *stream = rs_new(vm, MAL_READABLE_STREAM, stream_proto);
    roots[6] = mal_value_from_readable_stream_object(stream);
    stream->as.stream.state = MAL_READABLE_STREAM_READABLE;
    stream->as.stream.controller = mal_value_new_undefined();
    stream->as.stream.reader = mal_value_new_undefined();
    stream->as.stream.stored_error = mal_value_new_undefined();
    stream->as.stream.disturbed = false;

    MalReadableStreamObject *controller = rs_new(vm,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE]));
    roots[7] = mal_value_from_readable_stream_object(controller);
    controller->as.controller.stream = roots[6];
    controller->as.controller.underlying_source = roots[2];
    controller->as.controller.pull_method = roots[4];
    controller->as.controller.cancel_method = roots[5];
    controller->as.controller.size_algorithm = roots[9];
    controller->as.controller.queue_head = nullptr;
    controller->as.controller.queue_tail = nullptr;
    controller->as.controller.queue_total_size = 0;
    controller->as.controller.high_water_mark = high_water_mark;
    controller->as.controller.started = false;
    controller->as.controller.close_requested = false;
    controller->as.controller.pulling = false;
    controller->as.controller.pull_again = false;
    stream->as.stream.controller = roots[7];
    mal_gc_card(&stream->object.header, roots[7]);

    MalValue start_result = mal_value_new_undefined();
    if (!mal_value_is_undefined(roots[3])) {
        MalCompletion call = mal_vm_call_value(vm, roots[3], roots[2], &roots[7], 1);
        if (call.kind == MAL_COMPLETION_THROW) {
            goto fail;
        }
        start_result = call.value;
    }
    if (!mal_promise_resolve_value(vm, start_result, &roots[8])) {
        goto fail;
    }
    roots[3] = rs_callback(vm, rs_start_fulfilled, roots[7]);
    roots[4] = rs_callback(vm, rs_start_rejected, roots[7]);
    mal_promise_perform_then(vm, roots[8], roots[3], roots[4],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
    return roots[6];

fail:
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static MalValue rs_strategy_constructor(MalVm *vm, const MalValue *args, i32 argc,
    MalValue new_target, MalReadableStreamKind kind, MalIntrinsic prototype_slot) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Queuing strategy constructor requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    if (!mal_value_is_object(roots[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Queuing strategy init must be an object");
        goto fail;
    }
    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "highWaterMark"),
            &roots[1])) {
        goto fail;
    }
    if (mal_value_is_undefined(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Queuing strategy highWaterMark is required");
        goto fail;
    }
    f64 high_water_mark;
    if (!mal_vm_to_number(vm, roots[1], &high_water_mark)) {
        goto fail;
    }
    MalObject *prototype = rs_instance_prototype(vm, new_target, prototype_slot);
    if (prototype == nullptr) {
        goto fail;
    }
    MalReadableStreamObject *strategy = rs_new(vm, kind, prototype);
    strategy->as.strategy.high_water_mark = high_water_mark;
    mal_gc_unroot(&span);
    return mal_value_from_readable_stream_object(strategy);

fail:
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static MalValue rs_count_strategy_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    return rs_strategy_constructor(vm, args, argc, new_target,
        MAL_COUNT_QUEUING_STRATEGY, MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_PROTOTYPE);
}

static MalValue rs_byte_length_strategy_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    return rs_strategy_constructor(vm, args, argc, new_target,
        MAL_BYTE_LENGTH_QUEUING_STRATEGY,
        MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_PROTOTYPE);
}

static MalValue rs_strategy_high_water_mark(
    MalVm *vm, MalValue self, MalReadableStreamKind kind, const byte *message) {
    MalReadableStreamObject *strategy = rs_require(vm, self, kind, message);
    return strategy == nullptr
        ? mal_value_new_undefined()
        : mal_value_from_f64_convert_nan(strategy->as.strategy.high_water_mark);
}

static MalValue rs_count_strategy_get_high_water_mark(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_strategy_high_water_mark(vm, self, MAL_COUNT_QUEUING_STRATEGY,
        (const byte *) "CountQueuingStrategy.highWaterMark getter called on incompatible receiver");
}

static MalValue rs_byte_length_strategy_get_high_water_mark(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_strategy_high_water_mark(vm, self, MAL_BYTE_LENGTH_QUEUING_STRATEGY,
        (const byte *) "ByteLengthQueuingStrategy.highWaterMark getter called on incompatible receiver");
}

static MalValue rs_count_strategy_get_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (rs_require(vm, self, MAL_COUNT_QUEUING_STRATEGY,
            (const byte *) "CountQueuingStrategy.size getter called on incompatible receiver") == nullptr) {
        return mal_value_new_undefined();
    }
    return vm->intrinsics[MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_SIZE];
}

static MalValue rs_byte_length_strategy_get_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (rs_require(vm, self, MAL_BYTE_LENGTH_QUEUING_STRATEGY,
            (const byte *) "ByteLengthQueuingStrategy.size getter called on incompatible receiver") == nullptr) {
        return mal_value_new_undefined();
    }
    return vm->intrinsics[MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_SIZE];
}

static MalValue rs_count_strategy_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_from_i32(1);
}

static MalValue rs_byte_length_strategy_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue chunk = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue byte_length;
    if (!mal_vm_get_property(vm, chunk,
            mal_intrinsic_string_key(vm, (const byte *) "byteLength"), &byte_length)) {
        return mal_value_new_undefined();
    }
    return byte_length;
}

static MalReadableStreamObject *rs_acquire_reader(
    MalVm *vm, MalReadableStreamObject *stream, MalObject *prototype) {
    if (!mal_value_is_undefined(stream->as.stream.reader)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream is already locked");
        return nullptr;
    }
    MalValue roots[3] = {
        mal_value_from_readable_stream_object(stream),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalReadableStreamObject *reader =
        rs_new(vm, MAL_READABLE_STREAM_DEFAULT_READER, prototype);
    roots[1] = mal_value_from_readable_stream_object(reader);
    roots[2] = mal_value_from_promise_object(rs_new_promise(vm));
    reader->as.reader.stream = roots[0];
    reader->as.reader.closed_promise = roots[2];
    reader->as.reader.requests_head = nullptr;
    reader->as.reader.requests_tail = nullptr;
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        mal_promise_fulfill(
            vm, mal_value_to_promise_object(roots[2]), mal_value_new_undefined());
    } else if (stream->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        mal_promise_reject(vm, mal_value_to_promise_object(roots[2]),
            stream->as.stream.stored_error);
    }
    stream->as.stream.reader = roots[1];
    mal_gc_card(&stream->object.header, roots[1]);
    mal_gc_unroot(&span);
    return reader;
}

static MalValue rs_reader_constructor(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor ReadableStreamDefaultReader requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue stream_value = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalReadableStreamObject *stream = rs_require(vm, stream_value, MAL_READABLE_STREAM,
        "ReadableStreamDefaultReader requires a ReadableStream");
    if (stream == nullptr) {
        return mal_value_new_undefined();
    }
    MalObject *prototype = rs_instance_prototype(vm, new_target,
        MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *reader = rs_acquire_reader(vm, stream, prototype);
    return reader == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(reader);
}

static MalValue rs_controller_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "ReadableStreamDefaultController cannot be constructed directly");
    return mal_value_new_undefined();
}

static MalValue rs_get_locked(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = rs_require(vm, self, MAL_READABLE_STREAM,
        "ReadableStream.locked getter called on incompatible receiver");
    return stream == nullptr ? mal_value_new_undefined()
                             : mal_value_new_boolean(
                                   !mal_value_is_undefined(stream->as.stream.reader));
}

static MalValue rs_get_reader(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = rs_require(vm, self, MAL_READABLE_STREAM,
        "ReadableStream.getReader called on incompatible receiver");
    if (stream == nullptr) {
        return mal_value_new_undefined();
    }
    if (argc >= 1 && !mal_value_is_nil(args[0])) {
        if (!mal_value_is_object(args[0])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "ReadableStream getReader options must be an object");
            return mal_value_new_undefined();
        }
        MalValue mode;
        if (!mal_vm_get_property(vm, args[0],
                mal_intrinsic_string_key(vm, (const byte *) "mode"), &mode)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(mode)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "ReadableStream BYOB readers are not supported");
            return mal_value_new_undefined();
        }
    }
    MalReadableStreamObject *reader = rs_acquire_reader(vm, stream,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE]));
    return reader == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(reader);
}

static MalValue rs_cancel_fulfilled(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalValue promise =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (mal_value_is_promise_object(promise)) {
        mal_promise_fulfill(
            vm, mal_value_to_promise_object(promise), mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue rs_cancel_rejected(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue promise =
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    if (mal_value_is_promise_object(promise)) {
        mal_promise_reject(vm, mal_value_to_promise_object(promise),
            argc >= 1 ? args[0] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue rs_cancel_internal(
    MalVm *vm, MalReadableStreamObject *stream, MalValue reason) {
    stream->as.stream.disturbed = true;
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        return rs_resolved_promise(vm, mal_value_new_undefined());
    }
    if (stream->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        return rs_rejected_promise(vm, stream->as.stream.stored_error);
    }
    MalReadableStreamObject *controller = rs_controller_for(stream);
    MalValue roots[7] = {
        mal_value_from_readable_stream_object(stream), reason,
        controller->as.controller.underlying_source,
        controller->as.controller.cancel_method,
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 7);
    rs_queue_clear(controller);
    rs_close_stream(vm, stream);
    if (mal_value_is_undefined(roots[3])) {
        roots[4] = rs_resolved_promise(vm, mal_value_new_undefined());
        mal_gc_unroot(&span);
        return roots[4];
    }

    roots[4] = mal_value_from_promise_object(rs_new_promise(vm));
    MalCompletion call = mal_vm_call_value(vm, roots[3], roots[2], &roots[1], 1);
    if (call.kind == MAL_COMPLETION_THROW) {
        MalValue error = call.value;
        vm->completion = rs_normal();
        mal_promise_reject(vm, mal_value_to_promise_object(roots[4]), error);
        mal_gc_unroot(&span);
        return roots[4];
    }
    if (!mal_promise_resolve_value(vm, call.value, &roots[5])) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        mal_promise_reject(vm, mal_value_to_promise_object(roots[4]), error);
        mal_gc_unroot(&span);
        return roots[4];
    }
    roots[1] = rs_callback(vm, rs_cancel_fulfilled, roots[4]);
    roots[2] = rs_callback(vm, rs_cancel_rejected, roots[4]);
    mal_promise_perform_then(vm, roots[5], roots[1], roots[2],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
    return roots[4];
}

static MalValue rs_cancel(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *stream = rs_require(vm, self, MAL_READABLE_STREAM,
        "ReadableStream.cancel called on incompatible receiver");
    if (stream == nullptr) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(stream->as.stream.reader)) {
        return rs_rejected_type_error(vm, (const byte *) "Cannot cancel a locked ReadableStream");
    }
    return rs_cancel_internal(
        vm, stream, argc >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue rs_controller_get_desired_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        "ReadableStreamDefaultController.desiredSize getter called on incompatible receiver");
    if (controller == nullptr) {
        return mal_value_new_undefined();
    }
    f64 desired = rs_desired_size(controller);
    return isnan(desired) ? mal_value_new_null() : mal_value_from_f64_convert_nan(desired);
}

static MalValue rs_controller_enqueue(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        "ReadableStreamDefaultController.enqueue called on incompatible receiver");
    if (controller == nullptr) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    if (controller->as.controller.close_requested ||
        stream->as.stream.state != MAL_READABLE_STREAM_READABLE) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot enqueue into a closing or non-readable stream");
        return mal_value_new_undefined();
    }
    MalValue chunk = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader != nullptr && reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        MalValue roots[3] = {chunk, request->promise, mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, roots, 3);
        roots[2] = rs_read_result(vm, roots[0], false);
        rs_request_remove(reader, request);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), roots[2]);
        mal_gc_unroot(&span);
    } else {
        f64 chunk_size;
        if (!rs_chunk_size(vm, controller, chunk, &chunk_size)) {
            return mal_value_new_undefined();
        }
        MalReadableStreamQueueEntry *entry = malloc(sizeof(MalReadableStreamQueueEntry));
        entry->next = nullptr;
        entry->chunk = chunk;
        entry->size = chunk_size;
        if (controller->as.controller.queue_tail == nullptr) {
            controller->as.controller.queue_head = entry;
        } else {
            controller->as.controller.queue_tail->next = entry;
        }
        controller->as.controller.queue_tail = entry;
        controller->as.controller.queue_total_size += chunk_size;
        mal_gc_card(&controller->object.header, chunk);
    }
    rs_call_pull_if_needed(vm, controller);
    return mal_value_new_undefined();
}

static MalValue rs_controller_close(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        "ReadableStreamDefaultController.close called on incompatible receiver");
    if (controller == nullptr) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    if (controller->as.controller.close_requested ||
        stream->as.stream.state != MAL_READABLE_STREAM_READABLE) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot close a closing or non-readable stream");
        return mal_value_new_undefined();
    }
    if (controller->as.controller.queue_head == nullptr) {
        rs_close_stream(vm, stream);
    } else {
        controller->as.controller.close_requested = true;
    }
    return mal_value_new_undefined();
}

static MalValue rs_controller_error(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        "ReadableStreamDefaultController.error called on incompatible receiver");
    if (controller != nullptr) {
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream),
            argc >= 1 ? args[0] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue rs_reader_get_closed(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_READER,
        "ReadableStreamDefaultReader.closed getter called on incompatible receiver");
    return reader == nullptr ? mal_value_new_undefined() : reader->as.reader.closed_promise;
}

static MalValue rs_reader_read(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_READER,
        "ReadableStreamDefaultReader.read called on incompatible receiver");
    if (reader == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(reader->as.reader.stream)) {
        return rs_rejected_type_error(vm,
            (const byte *) "Cannot read from a released ReadableStream reader");
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(reader->as.reader.stream);
    stream->as.stream.disturbed = true;
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        MalValue result = rs_read_result(vm, mal_value_new_undefined(), true);
        return rs_resolved_promise(vm, result);
    }
    if (stream->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        return rs_rejected_promise(vm, stream->as.stream.stored_error);
    }
    MalReadableStreamObject *controller = rs_controller_for(stream);
    if (controller->as.controller.queue_head != nullptr) {
        MalReadableStreamQueueEntry *entry = controller->as.controller.queue_head;
        MalValue roots[3] = {
            entry->chunk, mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 3);
        controller->as.controller.queue_head = entry->next;
        if (controller->as.controller.queue_head == nullptr) {
            controller->as.controller.queue_tail = nullptr;
        }
        controller->as.controller.queue_total_size -= entry->size;
        if (controller->as.controller.queue_total_size < 0) {
            controller->as.controller.queue_total_size = 0;
        }
        mal_gc_write_barrier(entry->chunk);
        free(entry);
        roots[1] = rs_read_result(vm, roots[0], false);
        roots[2] = rs_resolved_promise(vm, roots[1]);
        if (controller->as.controller.close_requested &&
            controller->as.controller.queue_head == nullptr) {
            rs_close_stream(vm, stream);
        } else {
            rs_call_pull_if_needed(vm, controller);
        }
        mal_gc_unroot(&span);
        return roots[2];
    }

    MalValue promise = mal_value_from_promise_object(rs_new_promise(vm));
    MalReadableStreamReadRequest *request = malloc(sizeof(MalReadableStreamReadRequest));
    request->next = nullptr;
    request->promise = promise;
    if (reader->as.reader.requests_tail == nullptr) {
        reader->as.reader.requests_head = request;
    } else {
        reader->as.reader.requests_tail->next = request;
    }
    reader->as.reader.requests_tail = request;
    mal_gc_card(&reader->object.header, promise);
    rs_call_pull_if_needed(vm, controller);
    return promise;
}

static MalValue rs_reader_cancel(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_READER,
        "ReadableStreamDefaultReader.cancel called on incompatible receiver");
    if (reader == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(reader->as.reader.stream)) {
        return rs_rejected_type_error(vm,
            (const byte *) "Cannot cancel with a released ReadableStream reader");
    }
    return rs_cancel_internal(vm,
        mal_value_to_readable_stream_object(reader->as.reader.stream),
        argc >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue rs_reader_release_lock(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require(vm, self,
        MAL_READABLE_STREAM_DEFAULT_READER,
        "ReadableStreamDefaultReader.releaseLock called on incompatible receiver");
    if (reader == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(reader->as.reader.stream)) {
        return mal_value_new_undefined();
    }
    if (reader->as.reader.requests_head != nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot release a reader with pending read requests");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(reader->as.reader.stream);
    MalValue error = rs_take_type_error(
        vm, (const byte *) "ReadableStream reader was released");
    MalPromiseObject *closed;
    if (stream->as.stream.state == MAL_READABLE_STREAM_READABLE) {
        closed = mal_value_to_promise_object(reader->as.reader.closed_promise);
        closed->is_handled = true;
        mal_promise_reject(vm, closed, error);
    } else {
        MalValue replacement = rs_rejected_promise(vm, error);
        closed = mal_value_to_promise_object(replacement);
        closed->is_handled = true;
        mal_gc_write_barrier(reader->as.reader.closed_promise);
        reader->as.reader.closed_promise = replacement;
        mal_gc_card(&reader->object.header, replacement);
    }
    mal_gc_write_barrier(stream->as.stream.reader);
    stream->as.stream.reader = mal_value_new_undefined();
    mal_gc_write_barrier(reader->as.reader.stream);
    reader->as.reader.stream = mal_value_new_undefined();
    return mal_value_new_undefined();
}

static void rs_trace(MalHeapHeader *cell) {
    MalReadableStreamObject *object = (MalReadableStreamObject *) cell;
    switch (object->kind) {
        case MAL_READABLE_STREAM:
            mal_gc_mark_value(object->as.stream.controller);
            mal_gc_mark_value(object->as.stream.reader);
            mal_gc_mark_value(object->as.stream.stored_error);
            break;
        case MAL_READABLE_STREAM_DEFAULT_CONTROLLER:
            mal_gc_mark_value(object->as.controller.stream);
            mal_gc_mark_value(object->as.controller.underlying_source);
            mal_gc_mark_value(object->as.controller.pull_method);
            mal_gc_mark_value(object->as.controller.cancel_method);
            mal_gc_mark_value(object->as.controller.size_algorithm);
            for (MalReadableStreamQueueEntry *entry = object->as.controller.queue_head;
                 entry != nullptr; entry = entry->next) {
                mal_gc_mark_value(entry->chunk);
            }
            break;
        case MAL_READABLE_STREAM_DEFAULT_READER:
            mal_gc_mark_value(object->as.reader.stream);
            mal_gc_mark_value(object->as.reader.closed_promise);
            for (MalReadableStreamReadRequest *request = object->as.reader.requests_head;
                 request != nullptr; request = request->next) {
                mal_gc_mark_value(request->promise);
            }
            break;
        case MAL_COUNT_QUEUING_STRATEGY:
        case MAL_BYTE_LENGTH_QUEUING_STRATEGY:
            break;
    }
}

static void rs_finalize(MalHeapHeader *cell) {
    MalReadableStreamObject *object = (MalReadableStreamObject *) cell;
    if (object->kind == MAL_READABLE_STREAM_DEFAULT_CONTROLLER) {
        rs_queue_clear(object);
    } else if (object->kind == MAL_READABLE_STREAM_DEFAULT_READER) {
        MalReadableStreamReadRequest *request = object->as.reader.requests_head;
        while (request != nullptr) {
            MalReadableStreamReadRequest *next = request->next;
            mal_gc_write_barrier(request->promise);
            free(request);
            request = next;
        }
        object->as.reader.requests_head = nullptr;
        object->as.reader.requests_tail = nullptr;
    }
}

static void rs_define_getter(MalVm *vm, MalObject *prototype, const byte *name,
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

static MalObject *rs_install_class(MalVm *vm, MalObject *global_this,
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
        vm->intrinsics[constructor_slot], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, name)), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
    mal_intrinsic_define_data(vm, global_this, name, vm->intrinsics[constructor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return prototype;
}

void mal_readable_stream_install(MalVm *vm, MalObject *global_this) {
    MalObject *stream_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableStream", 0, rs_constructor,
        MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_STREAM_PROTOTYPE);
    rs_define_getter(vm, stream_proto, (const byte *) "locked",
        (const byte *) "get locked", rs_get_locked);
    mal_intrinsic_define_method_n(
        vm, stream_proto, (const byte *) "cancel", 1, rs_cancel);
    mal_intrinsic_define_method_n(
        vm, stream_proto, (const byte *) "getReader", 0, rs_get_reader);

    MalObject *controller_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableStreamDefaultController", 0, rs_controller_constructor,
        MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE);
    rs_define_getter(vm, controller_proto, (const byte *) "desiredSize",
        (const byte *) "get desiredSize", rs_controller_get_desired_size);
    mal_intrinsic_define_method_n(
        vm, controller_proto, (const byte *) "close", 0, rs_controller_close);
    mal_intrinsic_define_method_n(
        vm, controller_proto, (const byte *) "enqueue", 1, rs_controller_enqueue);
    mal_intrinsic_define_method_n(
        vm, controller_proto, (const byte *) "error", 1, rs_controller_error);

    MalObject *reader_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableStreamDefaultReader", 1, rs_reader_constructor,
        MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE);
    rs_define_getter(vm, reader_proto, (const byte *) "closed",
        (const byte *) "get closed", rs_reader_get_closed);
    mal_intrinsic_define_method_n(
        vm, reader_proto, (const byte *) "cancel", 1, rs_reader_cancel);
    mal_intrinsic_define_method_n(
        vm, reader_proto, (const byte *) "read", 0, rs_reader_read);
    mal_intrinsic_define_method_n(
        vm, reader_proto, (const byte *) "releaseLock", 0, rs_reader_release_lock);

    MalObject *function_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    vm->intrinsics[MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_SIZE] =
        mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, function_proto, mal_intrinsic_ascii(vm, (const byte *) "size"),
            0, rs_count_strategy_size));
    vm->intrinsics[MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_SIZE] =
        mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, function_proto, mal_intrinsic_ascii(vm, (const byte *) "size"),
            1, rs_byte_length_strategy_size));

    MalObject *count_strategy_proto = rs_install_class(vm, global_this,
        (const byte *) "CountQueuingStrategy", 1, rs_count_strategy_constructor,
        MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_CONSTRUCTOR,
        MAL_INTRINSIC_COUNT_QUEUING_STRATEGY_PROTOTYPE);
    rs_define_getter(vm, count_strategy_proto, (const byte *) "highWaterMark",
        (const byte *) "get highWaterMark", rs_count_strategy_get_high_water_mark);
    rs_define_getter(vm, count_strategy_proto, (const byte *) "size",
        (const byte *) "get size", rs_count_strategy_get_size);

    MalObject *byte_strategy_proto = rs_install_class(vm, global_this,
        (const byte *) "ByteLengthQueuingStrategy", 1,
        rs_byte_length_strategy_constructor,
        MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_CONSTRUCTOR,
        MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_PROTOTYPE);
    rs_define_getter(vm, byte_strategy_proto, (const byte *) "highWaterMark",
        (const byte *) "get highWaterMark", rs_byte_length_strategy_get_high_water_mark);
    rs_define_getter(vm, byte_strategy_proto, (const byte *) "size",
        (const byte *) "get size", rs_byte_length_strategy_get_size);

    mal_gc_register_tracer(MAL_HEAP_READABLE_STREAM_OBJECT, rs_trace);
    mal_gc_register_finalizer(MAL_HEAP_READABLE_STREAM_OBJECT, rs_finalize);
}
