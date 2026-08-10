#include "web_readable_stream_object.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "ascii.h"
#include "builtin_data_view.h"
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
static MalReadableStreamObject *rs_acquire_reader_kind(MalVm *vm,
    MalReadableStreamObject *stream, MalObject *prototype,
    MalReadableStreamKind kind);

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

static bool rs_byob_view_is_valid(MalVm *vm, MalValue view,
    MalTypedArrayObject **array_out, MalBufferSourceSpan *span_out) {
    if (!mal_value_is_typed_array_object(view) ||
        mal_value_to_typed_array_object(view)->kind != MAL_TA_UINT8) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires a Uint8Array");
        return false;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(view);
    if (mal_buffer_source_span(view, span_out) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires an attached Uint8Array");
        return false;
    }
    if (span_out->length == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires a non-empty Uint8Array");
        return false;
    }
    *array_out = array;
    return true;
}

static MalValue rs_byob_result_view(
    MalVm *vm, MalTypedArrayObject *destination, u32 byte_length) {
    return mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        destination->buffer, MAL_TA_UINT8, destination->byte_offset,
        byte_length, false));
}

static bool rs_byob_fill(MalVm *vm, MalValue view, MalValue chunk,
    usize source_offset, MalValue *value_out, usize *consumed_out) {
    MalTypedArrayObject *destination;
    MalBufferSourceSpan destination_span;
    if (!rs_byob_view_is_valid(vm, view, &destination, &destination_span)) {
        return false;
    }
    MalBufferSourceSpan source_span;
    if (mal_buffer_source_span(chunk, &source_span) != MAL_BUFFER_SOURCE_SPAN_OK ||
        source_offset > source_span.length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "A byte ReadableStream must contain buffer-source chunks");
        return false;
    }
    usize remaining = source_span.length - source_offset;
    usize copied = remaining < destination_span.length
        ? remaining : destination_span.length;
    if (copied > 0) {
        memcpy(destination_span.data, source_span.data + source_offset, copied);
    }
    *value_out = rs_byob_result_view(vm, destination, (u32) copied);
    *consumed_out = copied;
    return true;
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
    mal_gc_write_barrier(request->view);
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
        MalValue roots[3] = {
            request->promise, request->view, mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 3);
        MalValue value = mal_value_new_undefined();
        if (!mal_value_is_undefined(roots[1])) {
            value = rs_byob_result_view(
                vm, mal_value_to_typed_array_object(roots[1]), 0);
        }
        roots[2] = rs_read_result(vm, value, true);
        rs_request_remove(reader, request);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]), roots[2]);
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
    stream->as.stream.byte_stream = true;

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
    entry->byte_offset = 0;
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
    stream->as.stream.byte_stream = false;

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

static MalReadableStreamObject *rs_acquire_reader_kind(MalVm *vm,
    MalReadableStreamObject *stream, MalObject *prototype,
    MalReadableStreamKind kind) {
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
        rs_new(vm, kind, prototype);
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

static MalReadableStreamObject *rs_acquire_reader(
    MalVm *vm, MalReadableStreamObject *stream, MalObject *prototype) {
    return rs_acquire_reader_kind(
        vm, stream, prototype, MAL_READABLE_STREAM_DEFAULT_READER);
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

static MalValue rs_byob_reader_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor ReadableStreamBYOBReader requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue stream_value = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalReadableStreamObject *stream = rs_require(vm, stream_value,
        MAL_READABLE_STREAM,
        "ReadableStreamBYOBReader requires a ReadableStream");
    if (stream == nullptr) {
        return mal_value_new_undefined();
    }
    if (!stream->as.stream.byte_stream) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader requires a byte stream");
        return mal_value_new_undefined();
    }
    MalObject *prototype = rs_instance_prototype(vm, new_target,
        MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *reader = rs_acquire_reader_kind(
        vm, stream, prototype, MAL_READABLE_STREAM_BYOB_READER);
    return reader == nullptr ? mal_value_new_undefined()
                             : mal_value_from_readable_stream_object(reader);
}

static MalReadableStreamObject *rs_require_reader(
    MalVm *vm, MalValue value, const byte *message) {
    if (!rs_is_kind(value, MAL_READABLE_STREAM_DEFAULT_READER) &&
        !rs_is_kind(value, MAL_READABLE_STREAM_BYOB_READER)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }
    return mal_value_to_readable_stream_object(value);
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
    bool byob = false;
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
            MalString *mode_string;
            if (!mal_vm_to_string(vm, mode, &mode_string)) {
                return mal_value_new_undefined();
            }
            if (!mal_string_equals_ascii(mode_string, "byob")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "ReadableStream reader mode must be 'byob'");
                return mal_value_new_undefined();
            }
            byob = true;
        }
    }
    if (byob && !stream->as.stream.byte_stream) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot acquire a BYOB reader for a non-byte stream");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *reader = byob
        ? rs_acquire_reader_kind(vm, stream,
            mal_value_to_object(vm->intrinsics[
                MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_PROTOTYPE]),
            MAL_READABLE_STREAM_BYOB_READER)
        : rs_acquire_reader(vm, stream,
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
        MalValue roots[4] = {
            chunk, request->promise, request->view, mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 4);
        if (!mal_value_is_undefined(roots[2])) {
            usize copied;
            MalValue result_view;
            if (!rs_byob_fill(vm, roots[2], roots[0], 0,
                    &result_view, &copied)) {
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            roots[3] = rs_read_result(vm, result_view, false);
            MalBufferSourceSpan source_span;
            (void) mal_buffer_source_span(roots[0], &source_span);
            if (copied < source_span.length) {
                MalReadableStreamQueueEntry *entry =
                    malloc(sizeof(MalReadableStreamQueueEntry));
                entry->next = nullptr;
                entry->chunk = roots[0];
                entry->size = 1;
                entry->byte_offset = copied;
                controller->as.controller.queue_head = entry;
                controller->as.controller.queue_tail = entry;
                controller->as.controller.queue_total_size = 1;
                mal_gc_card(&controller->object.header, roots[0]);
            }
        } else {
            roots[3] = rs_read_result(vm, roots[0], false);
        }
        rs_request_remove(reader, request);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), roots[3]);
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
        entry->byte_offset = 0;
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
    MalReadableStreamObject *reader = rs_require_reader(vm, self,
        (const byte *) "ReadableStream reader closed getter called on incompatible receiver");
    return reader == nullptr ? mal_value_new_undefined() : reader->as.reader.closed_promise;
}

static MalValue rs_reader_read(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require_reader(vm, self,
        (const byte *) "ReadableStream reader read called on incompatible receiver");
    if (reader == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(reader->as.reader.stream)) {
        return rs_rejected_type_error(vm,
            (const byte *) "Cannot read from a released ReadableStream reader");
    }
    bool byob = reader->kind == MAL_READABLE_STREAM_BYOB_READER;
    MalValue view = mal_value_new_undefined();
    MalTypedArrayObject *destination = nullptr;
    MalBufferSourceSpan destination_span;
    if (byob) {
        view = argc >= 1 ? args[0] : mal_value_new_undefined();
        if (!rs_byob_view_is_valid(vm, view, &destination, &destination_span)) {
            return mal_value_new_undefined();
        }
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(reader->as.reader.stream);
    stream->as.stream.disturbed = true;
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        MalValue value = byob
            ? rs_byob_result_view(vm, destination, 0)
            : mal_value_new_undefined();
        MalValue result = rs_read_result(vm, value, true);
        return rs_resolved_promise(vm, result);
    }
    if (stream->as.stream.state == MAL_READABLE_STREAM_ERRORED) {
        return rs_rejected_promise(vm, stream->as.stream.stored_error);
    }
    MalReadableStreamObject *controller = rs_controller_for(stream);
    if (controller->as.controller.queue_head != nullptr) {
        MalReadableStreamQueueEntry *entry = controller->as.controller.queue_head;
        MalValue roots[4] = {
            entry->chunk, view, mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 4);
        bool consumed_entry = true;
        if (byob) {
            usize copied;
            if (!rs_byob_fill(vm, roots[1], roots[0],
                    entry->byte_offset, &roots[2], &copied)) {
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            MalBufferSourceSpan source_span;
            (void) mal_buffer_source_span(roots[0], &source_span);
            entry->byte_offset += copied;
            consumed_entry = entry->byte_offset == source_span.length;
        } else {
            roots[2] = roots[0];
            if (entry->byte_offset > 0 &&
                mal_value_is_typed_array_object(roots[0])) {
                MalTypedArrayObject *source =
                    mal_value_to_typed_array_object(roots[0]);
                u32 byte_length = mal_typed_array_object_byte_length(source);
                roots[2] = mal_value_from_typed_array_object(
                    mal_typed_array_object_new(&vm->heap,
                        mal_value_to_object(vm->intrinsics[
                            MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
                        source->buffer, MAL_TA_UINT8,
                        source->byte_offset + (u32) entry->byte_offset,
                        byte_length - (u32) entry->byte_offset, false));
            }
        }
        if (consumed_entry) {
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
        }
        roots[2] = rs_read_result(vm, roots[2], false);
        roots[3] = rs_resolved_promise(vm, roots[2]);
        if (controller->as.controller.close_requested &&
            controller->as.controller.queue_head == nullptr) {
            rs_close_stream(vm, stream);
        } else {
            rs_call_pull_if_needed(vm, controller);
        }
        mal_gc_unroot(&span);
        return roots[3];
    }

    MalValue promise = mal_value_from_promise_object(rs_new_promise(vm));
    MalReadableStreamReadRequest *request = malloc(sizeof(MalReadableStreamReadRequest));
    request->next = nullptr;
    request->promise = promise;
    request->view = view;
    if (reader->as.reader.requests_tail == nullptr) {
        reader->as.reader.requests_head = request;
    } else {
        reader->as.reader.requests_tail->next = request;
    }
    reader->as.reader.requests_tail = request;
    mal_gc_card(&reader->object.header, promise);
    mal_gc_card(&reader->object.header, view);
    rs_call_pull_if_needed(vm, controller);
    return promise;
}

MalValue mal_readable_stream_acquire_default_reader(MalVm *vm, MalValue value) {
    if (!mal_value_is_readable_stream_object(value) ||
        mal_value_to_readable_stream_object(value)->kind != MAL_READABLE_STREAM) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream is not a ReadableStream");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *reader = rs_acquire_reader(vm,
        mal_value_to_readable_stream_object(value),
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE]));
    if (reader != nullptr) {
        // Fetch's internal reader never exposes `closed`; its read loop observes
        // the same stored error, so suppress a duplicate unhandled rejection.
        mal_value_to_promise_object(reader->as.reader.closed_promise)->is_handled = true;
    }
    return reader == nullptr
        ? mal_value_new_undefined()
        : mal_value_from_readable_stream_object(reader);
}

MalValue mal_readable_stream_default_reader_read(MalVm *vm, MalValue value) {
    return rs_reader_read(vm, value, nullptr, 0,
        mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue rs_reader_cancel(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *reader = rs_require_reader(vm, self,
        (const byte *) "ReadableStream reader cancel called on incompatible receiver");
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
    MalReadableStreamObject *reader = rs_require_reader(vm, self,
        (const byte *) "ReadableStream reader releaseLock called on incompatible receiver");
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

static void rs_proxy_error_from_completion(
    MalVm *vm, MalValue controller_value) {
    MalValue error = vm->completion.value;
    vm->completion = rs_normal();
    rs_controller_error(vm, controller_value, &error, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue rs_proxy_read_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue controller = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalValue result = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue done;
    if (!mal_vm_get_property(vm, result,
            mal_intrinsic_string_key(vm, (const byte *) "done"), &done)) {
        rs_proxy_error_from_completion(vm, controller);
        return mal_value_new_undefined();
    }
    if (mal_value_is_truthy(done)) {
        return rs_controller_close(vm, controller, nullptr, 0,
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    MalValue chunk;
    if (!mal_vm_get_property(vm, result,
            mal_intrinsic_string_key(vm, (const byte *) "value"), &chunk)) {
        rs_proxy_error_from_completion(vm, controller);
        return mal_value_new_undefined();
    }
    MalValue enqueue_result = rs_controller_enqueue(vm, controller, &chunk, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        rs_proxy_error_from_completion(vm, controller);
    }
    return enqueue_result;
}

static MalValue rs_proxy_pull(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue reader = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalValue promise = rs_reader_read(vm, reader, nullptr, 0,
        mal_value_new_undefined(), mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW || argc < 1) {
        return promise;
    }
    MalValue callback = rs_callback(vm, rs_proxy_read_fulfilled, args[0]);
    mal_promise_perform_then(vm, promise, callback, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    return promise;
}

static MalValue rs_proxy_cancel(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalValue reader = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return rs_reader_cancel(vm, reader, args, argc,
        mal_value_new_undefined(), mal_value_new_undefined());
}

MalValue mal_readable_stream_create_proxy(MalVm *vm, MalValue value) {
    if (!rs_is_kind(value, MAL_READABLE_STREAM)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream is not a ReadableStream");
        return mal_value_new_undefined();
    }
    bool byte_stream =
        mal_value_to_readable_stream_object(value)->as.stream.byte_stream;
    MalValue roots[5] = {
        value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    MalReadableStreamObject *reader = rs_acquire_reader(vm,
        mal_value_to_readable_stream_object(value),
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE]));
    if (reader == nullptr) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_readable_stream_object(reader);
    mal_value_to_promise_object(reader->as.reader.closed_promise)->is_handled = true;
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_proxy_pull, &roots[1], 1));
    roots[4] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_proxy_cancel, &roots[1], 1));
    MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]),
        (const byte *) "pull", roots[3], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]),
        (const byte *) "cancel", roots[4], flags);
    MalValue proxy = rs_constructor(vm, mal_value_new_undefined(), &roots[2], 1,
        vm->intrinsics[MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR],
        mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        (void) rs_reader_release_lock(vm, roots[1], nullptr, 0,
            mal_value_new_undefined(), mal_value_new_undefined());
    } else if (byte_stream) {
        mal_value_to_readable_stream_object(proxy)->as.stream.byte_stream = true;
    }
    mal_gc_unroot(&span);
    return proxy;
}

enum {
    RS_TEE_READER,
    RS_TEE_CONTROLLER_1,
    RS_TEE_CONTROLLER_2,
    RS_TEE_READING,
    RS_TEE_CANCELED_1,
    RS_TEE_CANCELED_2,
    RS_TEE_REASON_1,
    RS_TEE_REASON_2,
    RS_TEE_CANCEL_PROMISE_1,
    RS_TEE_CANCEL_RESOLVE_1,
    RS_TEE_CANCEL_REJECT_1,
    RS_TEE_CANCEL_PROMISE_2,
    RS_TEE_CANCEL_RESOLVE_2,
    RS_TEE_CANCEL_REJECT_2,
    RS_TEE_CLOSED,
    RS_TEE_SLOT_COUNT,
};

static MalValue rs_tee_state_callback(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_undefined();
}

static bool rs_tee_branch_canceled(
    MalNativeFunctionObject *state, i32 branch) {
    return mal_value_is_truthy(mal_native_function_object_get_slot(
        state, branch == 1 ? RS_TEE_CANCELED_1 : RS_TEE_CANCELED_2));
}

static MalValue rs_tee_branch_controller(
    MalNativeFunctionObject *state, i32 branch) {
    return mal_native_function_object_get_slot(
        state, branch == 1 ? RS_TEE_CONTROLLER_1 : RS_TEE_CONTROLLER_2);
}

static void rs_tee_call_settler(
    MalVm *vm, MalValue settler, MalValue value) {
    if (mal_value_is_undefined(settler)) return;
    MalCompletion completion = mal_vm_call_value(
        vm, settler, mal_value_new_undefined(), &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = rs_normal();
    }
}

static void rs_tee_settle_cancellations(
    MalVm *vm, MalNativeFunctionObject *state, bool reject, MalValue value) {
    for (i32 branch = 1; branch <= 2; branch++) {
        i32 promise_slot = branch == 1
            ? RS_TEE_CANCEL_PROMISE_1 : RS_TEE_CANCEL_PROMISE_2;
        if (mal_value_is_undefined(
                mal_native_function_object_get_slot(state, promise_slot))) {
            continue;
        }
        i32 settler_slot;
        if (branch == 1) {
            settler_slot = reject
                ? RS_TEE_CANCEL_REJECT_1 : RS_TEE_CANCEL_RESOLVE_1;
        } else {
            settler_slot = reject
                ? RS_TEE_CANCEL_REJECT_2 : RS_TEE_CANCEL_RESOLVE_2;
        }
        rs_tee_call_settler(vm,
            mal_native_function_object_get_slot(state, settler_slot), value);
    }
}

static void rs_tee_error_active_branches(
    MalVm *vm, MalNativeFunctionObject *state, MalValue error) {
    for (i32 branch = 1; branch <= 2; branch++) {
        if (rs_tee_branch_canceled(state, branch)) continue;
        MalValue controller = rs_tee_branch_controller(state, branch);
        if (!mal_value_is_undefined(controller)) {
            (void) rs_controller_error(vm, controller, &error, 1,
                mal_value_new_undefined(), mal_value_new_undefined());
        }
    }
}

static MalValue rs_tee_read_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    MalValue state_value = mal_native_function_object_get_slot(callback, 0);
    MalNativeFunctionObject *state =
        mal_value_to_native_function_object(state_value);
    mal_native_function_object_set_slot(
        state, RS_TEE_READING, mal_value_new_boolean(false));
    MalValue result = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue done;
    if (!mal_vm_get_property(vm, result,
            mal_intrinsic_string_key(vm, (const byte *) "done"), &done)) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        mal_native_function_object_set_slot(
            state, RS_TEE_CLOSED, mal_value_new_boolean(true));
        rs_tee_error_active_branches(vm, state, error);
        rs_tee_settle_cancellations(
            vm, state, false, mal_value_new_undefined());
        return mal_value_new_undefined();
    }
    if (mal_value_is_truthy(done)) {
        mal_native_function_object_set_slot(
            state, RS_TEE_CLOSED, mal_value_new_boolean(true));
        for (i32 branch = 1; branch <= 2; branch++) {
            if (rs_tee_branch_canceled(state, branch)) continue;
            MalValue controller = rs_tee_branch_controller(state, branch);
            if (!mal_value_is_undefined(controller)) {
                (void) rs_controller_close(vm, controller, nullptr, 0,
                    mal_value_new_undefined(), mal_value_new_undefined());
            }
        }
        rs_tee_settle_cancellations(
            vm, state, false, mal_value_new_undefined());
        return mal_value_new_undefined();
    }

    MalValue chunk;
    if (!mal_vm_get_property(vm, result,
            mal_intrinsic_string_key(vm, (const byte *) "value"), &chunk)) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        mal_native_function_object_set_slot(
            state, RS_TEE_CLOSED, mal_value_new_boolean(true));
        rs_tee_error_active_branches(vm, state, error);
        rs_tee_settle_cancellations(
            vm, state, false, mal_value_new_undefined());
        return mal_value_new_undefined();
    }
    for (i32 branch = 1; branch <= 2; branch++) {
        if (rs_tee_branch_canceled(state, branch)) continue;
        MalValue controller = rs_tee_branch_controller(state, branch);
        if (mal_value_is_undefined(controller)) continue;
        (void) rs_controller_enqueue(vm, controller, &chunk, 1,
            mal_value_new_undefined(), mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            vm->completion = rs_normal();
            mal_native_function_object_set_slot(
                state, RS_TEE_CLOSED, mal_value_new_boolean(true));
            rs_tee_error_active_branches(vm, state, error);
            rs_tee_settle_cancellations(
                vm, state, false, mal_value_new_undefined());
            break;
        }
    }
    return mal_value_new_undefined();
}

static MalValue rs_tee_read_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(callback, 0));
    MalValue error = argc >= 1 ? args[0] : mal_value_new_undefined();
    mal_native_function_object_set_slot(
        state, RS_TEE_READING, mal_value_new_boolean(false));
    mal_native_function_object_set_slot(
        state, RS_TEE_CLOSED, mal_value_new_boolean(true));
    rs_tee_error_active_branches(vm, state, error);
    rs_tee_settle_cancellations(
        vm, state, false, mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_tee_cancel_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(callback, 0));
    rs_tee_settle_cancellations(
        vm, state, false, mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_tee_cancel_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(callback, 0));
    rs_tee_settle_cancellations(vm, state, true,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_tee_pull(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *pull = mal_value_to_native_function_object(callee);
    MalValue state_value = mal_native_function_object_get_slot(pull, 0);
    MalNativeFunctionObject *state =
        mal_value_to_native_function_object(state_value);
    i32 branch = mal_value_to_i32(
        mal_native_function_object_get_slot(pull, 1));
    if (argc >= 1) {
        mal_native_function_object_set_slot(state,
            branch == 1 ? RS_TEE_CONTROLLER_1 : RS_TEE_CONTROLLER_2,
            args[0]);
    }
    if (mal_value_is_truthy(mal_native_function_object_get_slot(
            state, RS_TEE_CLOSED)) ||
        mal_value_is_truthy(mal_native_function_object_get_slot(
            state, RS_TEE_READING))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(
        state, RS_TEE_READING, mal_value_new_boolean(true));
    MalValue promise = rs_reader_read(vm,
        mal_native_function_object_get_slot(state, RS_TEE_READER),
        nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_native_function_object_set_slot(
            state, RS_TEE_READING, mal_value_new_boolean(false));
        return promise;
    }
    MalValue fulfilled = rs_callback(vm, rs_tee_read_fulfilled, state_value);
    MalValue rejected = rs_callback(vm, rs_tee_read_rejected, state_value);
    mal_promise_perform_then(vm, promise, fulfilled, rejected,
        mal_value_new_undefined(), mal_value_new_undefined());
    return promise;
}

static MalValue rs_tee_cancel(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *cancel = mal_value_to_native_function_object(callee);
    MalValue state_value = mal_native_function_object_get_slot(cancel, 0);
    MalNativeFunctionObject *state =
        mal_value_to_native_function_object(state_value);
    i32 branch = mal_value_to_i32(
        mal_native_function_object_get_slot(cancel, 1));
    i32 canceled_slot = branch == 1 ? RS_TEE_CANCELED_1 : RS_TEE_CANCELED_2;
    i32 reason_slot = branch == 1 ? RS_TEE_REASON_1 : RS_TEE_REASON_2;
    i32 promise_slot = branch == 1
        ? RS_TEE_CANCEL_PROMISE_1 : RS_TEE_CANCEL_PROMISE_2;
    i32 resolve_slot = branch == 1
        ? RS_TEE_CANCEL_RESOLVE_1 : RS_TEE_CANCEL_RESOLVE_2;
    i32 reject_slot = branch == 1
        ? RS_TEE_CANCEL_REJECT_1 : RS_TEE_CANCEL_REJECT_2;
    if (!mal_value_is_undefined(
            mal_native_function_object_get_slot(state, promise_slot))) {
        return mal_native_function_object_get_slot(state, promise_slot);
    }

    MalValue promise;
    MalValue resolve;
    MalValue reject;
    if (!mal_promise_new_capability(vm,
            vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
            &promise, &resolve, &reject)) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(state, promise_slot, promise);
    mal_native_function_object_set_slot(state, resolve_slot, resolve);
    mal_native_function_object_set_slot(state, reject_slot, reject);
    mal_native_function_object_set_slot(
        state, canceled_slot, mal_value_new_boolean(true));
    mal_native_function_object_set_slot(state, reason_slot,
        argc >= 1 ? args[0] : mal_value_new_undefined());

    if (mal_value_is_truthy(mal_native_function_object_get_slot(
            state, RS_TEE_CLOSED))) {
        rs_tee_call_settler(vm, resolve, mal_value_new_undefined());
        return promise;
    }
    if (!rs_tee_branch_canceled(state, 1) ||
        !rs_tee_branch_canceled(state, 2)) {
        return promise;
    }

    MalValue reasons = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
    MalRootSpan span;
    mal_gc_root(&span, &reasons, 1);
    MalArrayObject *array = mal_value_to_array_object(reasons);
    mal_array_object_store(array, mal_key_index(0),
        mal_native_function_object_get_slot(state, RS_TEE_REASON_1));
    mal_array_object_store(array, mal_key_index(1),
        mal_native_function_object_get_slot(state, RS_TEE_REASON_2));
    mal_native_function_object_set_slot(
        state, RS_TEE_CLOSED, mal_value_new_boolean(true));
    MalValue cancel_promise = rs_reader_cancel(vm,
        mal_native_function_object_get_slot(state, RS_TEE_READER),
        &reasons, 1, mal_value_new_undefined(), mal_value_new_undefined());
    MalValue fulfilled = rs_callback(vm, rs_tee_cancel_fulfilled, state_value);
    MalValue rejected = rs_callback(vm, rs_tee_cancel_rejected, state_value);
    mal_promise_perform_then(vm, cancel_promise, fulfilled, rejected,
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
    return promise;
}

static MalValue rs_tee_make_branch(
    MalVm *vm, MalValue state, i32 branch) {
    MalValue roots[5] = {
        state, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalValue slots[2] = {state, mal_value_from_i32(branch)};
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_tee_pull, slots, 2));
    roots[3] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_tee_cancel, slots, 2));
    MalPropertyFlags flags =
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]),
        (const byte *) "pull", roots[2], flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]),
        (const byte *) "cancel", roots[3], flags);
    roots[4] = rs_constructor(vm, mal_value_new_undefined(), &roots[1], 1,
        vm->intrinsics[MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR],
        mal_value_new_undefined());
    MalValue result = roots[4];
    mal_gc_unroot(&span);
    return result;
}

bool mal_readable_stream_tee(
    MalVm *vm, MalValue value, MalValue *branch1_out, MalValue *branch2_out) {
    if (!rs_is_kind(value, MAL_READABLE_STREAM)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream is not a ReadableStream");
        return false;
    }
    bool byte_stream =
        mal_value_to_readable_stream_object(value)->as.stream.byte_stream;
    MalValue roots[5] = {
        value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    MalReadableStreamObject *reader = rs_acquire_reader(vm,
        mal_value_to_readable_stream_object(value),
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_DEFAULT_READER_PROTOTYPE]));
    if (reader == nullptr) {
        mal_gc_unroot(&span);
        return false;
    }
    roots[1] = mal_value_from_readable_stream_object(reader);
    mal_value_to_promise_object(reader->as.reader.closed_promise)->is_handled = true;
    MalValue slots[RS_TEE_SLOT_COUNT];
    for (i32 i = 0; i < RS_TEE_SLOT_COUNT; i++) {
        slots[i] = mal_value_new_undefined();
    }
    slots[RS_TEE_READER] = roots[1];
    slots[RS_TEE_READING] = mal_value_new_boolean(false);
    slots[RS_TEE_CANCELED_1] = mal_value_new_boolean(false);
    slots[RS_TEE_CANCELED_2] = mal_value_new_boolean(false);
    slots[RS_TEE_CLOSED] = mal_value_new_boolean(false);
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_tee_state_callback, slots, RS_TEE_SLOT_COUNT));
    roots[3] = rs_tee_make_branch(vm, roots[2], 1);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    roots[4] = rs_tee_make_branch(vm, roots[2], 2);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto fail;
    if (byte_stream) {
        mal_value_to_readable_stream_object(roots[3])->as.stream.byte_stream = true;
        mal_value_to_readable_stream_object(roots[4])->as.stream.byte_stream = true;
    }
    *branch1_out = roots[3];
    *branch2_out = roots[4];
    mal_gc_unroot(&span);
    return true;

fail:
    if (reader->as.reader.requests_head == nullptr) {
        (void) rs_reader_release_lock(vm, roots[1], nullptr, 0,
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    mal_gc_unroot(&span);
    return false;
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
        case MAL_READABLE_STREAM_BYOB_READER:
            mal_gc_mark_value(object->as.reader.stream);
            mal_gc_mark_value(object->as.reader.closed_promise);
            for (MalReadableStreamReadRequest *request = object->as.reader.requests_head;
                 request != nullptr; request = request->next) {
                mal_gc_mark_value(request->promise);
                mal_gc_mark_value(request->view);
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
    } else if (object->kind == MAL_READABLE_STREAM_DEFAULT_READER ||
        object->kind == MAL_READABLE_STREAM_BYOB_READER) {
        MalReadableStreamReadRequest *request = object->as.reader.requests_head;
        while (request != nullptr) {
            MalReadableStreamReadRequest *next = request->next;
            mal_gc_write_barrier(request->promise);
            mal_gc_write_barrier(request->view);
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

    MalObject *byob_reader_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableStreamBYOBReader", 1, rs_byob_reader_constructor,
        MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_STREAM_BYOB_READER_PROTOTYPE);
    rs_define_getter(vm, byob_reader_proto, (const byte *) "closed",
        (const byte *) "get closed", rs_reader_get_closed);
    mal_intrinsic_define_method_n(
        vm, byob_reader_proto, (const byte *) "cancel", 1, rs_reader_cancel);
    mal_intrinsic_define_method_n(
        vm, byob_reader_proto, (const byte *) "read", 1, rs_reader_read);
    mal_intrinsic_define_method_n(vm, byob_reader_proto,
        (const byte *) "releaseLock", 0, rs_reader_release_lock);

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
