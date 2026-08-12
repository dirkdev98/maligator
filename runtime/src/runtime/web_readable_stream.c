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
#include "web_events_object.h"

static void rs_call_pull_if_needed(MalVm *vm, MalReadableStreamObject *controller);
static void rs_invalidate_byob_request(MalReadableStreamObject *controller);
static MalValue rs_controller_enqueue_kind(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalReadableStreamKind kind,
    const byte *message, bool owned_byte_chunk);
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

static bool rs_is_controller_kind(MalValue value) {
    return rs_is_kind(value, MAL_READABLE_STREAM_DEFAULT_CONTROLLER) ||
        rs_is_kind(value, MAL_READABLE_BYTE_STREAM_CONTROLLER);
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
    if (!mal_value_is_typed_array_object(view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires a TypedArray");
        return false;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(view);
    if (mal_buffer_source_span(view, span_out) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires an attached TypedArray");
        return false;
    }
    if (span_out->length == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBReader.read requires a non-empty TypedArray");
        return false;
    }
    *array_out = array;
    return true;
}

static MalValue rs_byob_result_view(
    MalVm *vm, MalTypedArrayObject *destination, u32 byte_length) {
    u32 element_size = mal_typed_array_element_size(destination->kind);
    return mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        destination->object.prototype, destination->buffer, destination->kind,
        destination->byte_offset, byte_length / element_size, false));
}

static MalValue rs_transfer_typed_array_view(MalVm *vm, MalValue view) {
    MalTypedArrayObject *source = mal_value_to_typed_array_object(view);
    MalArrayBufferObject *source_buffer = source->buffer;
    if (source_buffer->detached || source_buffer->shared ||
        source_buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "A byte stream cannot transfer this ArrayBuffer");
        return mal_value_new_undefined();
    }

    MalValue roots[3] = {
        view, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalArrayBufferObject *transferred = mal_array_buffer_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        source_buffer->byte_length, source_buffer->byte_length, false, false);
    roots[1] = mal_value_from_array_buffer_object(transferred);
    if (source_buffer->byte_length > 0 && transferred->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Byte stream ArrayBuffer transfer allocation failed");
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    transferred->sensitive = source_buffer->sensitive;
    if (source_buffer->byte_length > 0) {
        memcpy(transferred->data, source_buffer->data, source_buffer->byte_length);
    }
    mal_array_buffer_object_detach(source_buffer);
    roots[2] = mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap, source->object.prototype, transferred, source->kind,
        source->byte_offset, source->length, source->length_tracking));
    MalValue result = roots[2];
    mal_gc_unroot(&span);
    return result;
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

static void rs_clear_algorithms_kind(
    MalReadableStreamObject *controller, bool invalidate_byob_request) {
    mal_gc_write_barrier(controller->as.controller.underlying_source);
    mal_gc_write_barrier(controller->as.controller.pull_method);
    mal_gc_write_barrier(controller->as.controller.cancel_method);
    mal_gc_write_barrier(controller->as.controller.size_algorithm);
    controller->as.controller.underlying_source = mal_value_new_undefined();
    controller->as.controller.pull_method = mal_value_new_undefined();
    controller->as.controller.cancel_method = mal_value_new_undefined();
    controller->as.controller.size_algorithm = mal_value_new_undefined();
    if (invalidate_byob_request) {
        rs_invalidate_byob_request(controller);
    }
}

static void rs_clear_algorithms(MalReadableStreamObject *controller) {
    rs_clear_algorithms_kind(controller, true);
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

static void rs_queue_append(MalReadableStreamObject *controller,
    MalValue chunk, usize byte_offset, f64 queue_size) {
    MalReadableStreamQueueEntry *entry = malloc(sizeof(MalReadableStreamQueueEntry));
    entry->next = nullptr;
    entry->chunk = chunk;
    entry->size = queue_size;
    entry->byte_offset = byte_offset;
    if (controller->as.controller.queue_tail == nullptr) {
        controller->as.controller.queue_head = entry;
    } else {
        controller->as.controller.queue_tail->next = entry;
    }
    controller->as.controller.queue_tail = entry;
    controller->as.controller.queue_total_size += queue_size;
    mal_gc_card(&controller->object.header, chunk);
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
    MalReadableStreamObject *controller = rs_controller_for(stream);
    MalReadableStreamObject *reader = rs_reader_for(stream);
    bool preserve_byob_request = controller->kind ==
            MAL_READABLE_BYTE_STREAM_CONTROLLER &&
        reader != nullptr && reader->as.reader.requests_head != nullptr &&
        mal_value_is_typed_array_object(reader->as.reader.requests_head->view);
    stream->as.stream.state = MAL_READABLE_STREAM_CLOSED;
    rs_clear_algorithms_kind(controller, !preserve_byob_request);

    if (reader == nullptr) {
        return;
    }
    mal_promise_fulfill(
        vm, mal_value_to_promise_object(reader->as.reader.closed_promise), mal_value_new_undefined());
    if (preserve_byob_request) {
        return;
    }
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
    controller->as.controller.byob_request = mal_value_new_undefined();
    controller->as.controller.queue_head = nullptr;
    controller->as.controller.queue_tail = nullptr;
    controller->as.controller.queue_total_size = length == 0 ? 0 : 1;
    controller->as.controller.high_water_mark = 1;
    controller->as.controller.auto_allocate_chunk_size = 0;
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
    if (controller->kind == MAL_READABLE_BYTE_STREAM_CONTROLLER) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(chunk, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "ReadableByteStreamController.enqueue requires an attached ArrayBufferView");
            return false;
        }
        *size_out = (f64) span.length;
        return true;
    }
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

static bool rs_copy_byte_chunk(MalVm *vm, MalValue chunk, MalValue *chunk_out) {
    if (!mal_value_is_typed_array_object(chunk) &&
        !mal_value_is_data_view_object(chunk)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableByteStreamController.enqueue requires an ArrayBufferView");
        return false;
    }
    MalBufferSourceSpan source;
    if (mal_buffer_source_span(chunk, &source) != MAL_BUFFER_SOURCE_SPAN_OK ||
        source.length > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableByteStreamController.enqueue requires an attached ArrayBufferView");
        return false;
    }
    if (mal_value_is_typed_array_object(chunk)) {
        MalValue roots[2] = {chunk, mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, roots, 2);
        roots[1] = rs_transfer_typed_array_view(vm, roots[0]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&span);
            return false;
        }
        MalTypedArrayObject *transferred =
            mal_value_to_typed_array_object(roots[1]);
        *chunk_out = mal_value_from_typed_array_object(
            mal_typed_array_object_new(&vm->heap,
                mal_value_to_object(vm->intrinsics[
                    MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
                transferred->buffer, MAL_TA_UINT8, transferred->byte_offset,
                (u32) source.length, false));
        mal_gc_unroot(&span);
        return true;
    }
    MalValue roots[2] = {chunk, mal_value_new_undefined()};
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) source.length, (u32) source.length, false, false);
    roots[1] = mal_value_from_array_buffer_object(buffer);
    if (source.length > 0 && buffer->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Readable byte stream chunk allocation failed");
        mal_gc_unroot(&span);
        return false;
    }
    if (source.length > 0) {
        memcpy(buffer->data, source.data, source.length);
    }
    *chunk_out = mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, (u32) source.length, false));
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
    if (!rs_is_controller_kind(controller_value)) {
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
    if (!rs_is_controller_kind(controller_value)) {
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
        roots[3] = rs_rejected_promise(vm, error);
    } else if (!mal_promise_resolve_value(vm, call.value, &roots[3])) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        roots[3] = rs_rejected_promise(vm, error);
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
    if (rs_is_controller_kind(value)) {
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
    if (rs_is_controller_kind(value)) {
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
    if (!mal_value_is_undefined(roots[0]) && !mal_value_is_object(roots[0])) {
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
    bool high_water_mark_set = false;
    bool byte_source = false;
    u32 auto_allocate_chunk_size = 0;
    if (mal_value_is_object(roots[1])) {
        MalValue hwm;
        if (!mal_vm_get_property(vm, roots[1],
                mal_intrinsic_string_key(vm, (const byte *) "highWaterMark"), &hwm)) {
            goto fail;
        }
        if (!mal_value_is_undefined(hwm)) {
            high_water_mark_set = true;
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

    MalValue source = mal_value_is_undefined(roots[0]) ? mal_value_new_undefined() : roots[0];
    roots[2] = source;
    if (mal_value_is_object(source)) {
        MalValue type;
        if (!mal_vm_get_property(vm, source,
                mal_intrinsic_string_key(vm, (const byte *) "type"), &type)) {
            goto fail;
        }
        if (!mal_value_is_undefined(type)) {
            roots[6] = type;
            MalString *type_string;
            if (!mal_vm_to_string(vm, roots[6], &type_string)) {
                goto fail;
            }
            if (!mal_string_equals_ascii(type_string, "bytes")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "ReadableStream source type must be 'bytes'");
                goto fail;
            }
            byte_source = true;
            MalValue auto_allocate;
            if (!mal_vm_get_property(vm, source,
                    mal_intrinsic_string_key(vm,
                        (const byte *) "autoAllocateChunkSize"),
                    &auto_allocate)) {
                goto fail;
            }
            if (!mal_value_is_undefined(auto_allocate)) {
                f64 raw_auto_allocate;
                if (!mal_vm_to_number(vm, auto_allocate, &raw_auto_allocate)) {
                    goto fail;
                }
                if (!isfinite(raw_auto_allocate) || raw_auto_allocate <= 0 ||
                    floor(raw_auto_allocate) != raw_auto_allocate ||
                    raw_auto_allocate > UINT32_MAX) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                        "ReadableStream autoAllocateChunkSize must be a positive integer");
                    goto fail;
                }
                auto_allocate_chunk_size = (u32) raw_auto_allocate;
            }
        }
        if (!rs_get_method(vm, source, (const byte *) "start", &roots[3]) ||
            !rs_get_method(vm, source, (const byte *) "pull", &roots[4]) ||
            !rs_get_method(vm, source, (const byte *) "cancel", &roots[5])) {
            goto fail;
        }
    }

    if (byte_source) {
        if (!mal_value_is_undefined(roots[9])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "ReadableStream byte sources cannot use a strategy size function");
            goto fail;
        }
        if (!high_water_mark_set) {
            high_water_mark = 0;
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
    stream->as.stream.byte_stream = byte_source;

    MalReadableStreamObject *controller = rs_new(vm,
        byte_source ? MAL_READABLE_BYTE_STREAM_CONTROLLER
                    : MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        mal_value_to_object(vm->intrinsics[byte_source
                ? MAL_INTRINSIC_READABLE_BYTE_STREAM_CONTROLLER_PROTOTYPE
                : MAL_INTRINSIC_READABLE_STREAM_DEFAULT_CONTROLLER_PROTOTYPE]));
    roots[7] = mal_value_from_readable_stream_object(controller);
    controller->as.controller.stream = roots[6];
    controller->as.controller.underlying_source = roots[2];
    controller->as.controller.pull_method = roots[4];
    controller->as.controller.cancel_method = roots[5];
    controller->as.controller.size_algorithm = roots[9];
    controller->as.controller.byob_request = mal_value_new_undefined();
    controller->as.controller.queue_head = nullptr;
    controller->as.controller.queue_tail = nullptr;
    controller->as.controller.queue_total_size = 0;
    controller->as.controller.high_water_mark = high_water_mark;
    controller->as.controller.auto_allocate_chunk_size = auto_allocate_chunk_size;
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

static MalValue rs_byte_controller_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "ReadableByteStreamController cannot be constructed directly");
    return mal_value_new_undefined();
}

static MalValue rs_byob_request_constructor(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "ReadableStreamBYOBRequest cannot be constructed directly");
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
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
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
    MalReadableStreamObject *reader = rs_reader_for(stream);
    rs_invalidate_byob_request(controller);
    while (reader != nullptr && reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        MalValue pending_roots[2] = {
            request->promise, mal_value_new_undefined(),
        };
        MalRootSpan pending_span;
        mal_gc_root(&pending_span, pending_roots, 2);
        pending_roots[1] = rs_read_result(
            vm, mal_value_new_undefined(), true);
        rs_request_remove(reader, request);
        mal_promise_fulfill(vm,
            mal_value_to_promise_object(pending_roots[0]), pending_roots[1]);
        mal_gc_unroot(&pending_span);
    }
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

static MalValue rs_controller_get_desired_size_kind(MalVm *vm, MalValue self,
    MalReadableStreamKind kind, const byte *message) {
    MalReadableStreamObject *controller = rs_require(vm, self, kind, message);
    if (controller == nullptr) {
        return mal_value_new_undefined();
    }
    f64 desired = rs_desired_size(controller);
    return isnan(desired) ? mal_value_new_null() : mal_value_from_f64_convert_nan(desired);
}

static MalValue rs_controller_get_desired_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_controller_get_desired_size_kind(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        (const byte *) "ReadableStreamDefaultController.desiredSize getter called on incompatible receiver");
}

static MalValue rs_byte_controller_get_desired_size(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_controller_get_desired_size_kind(vm, self,
        MAL_READABLE_BYTE_STREAM_CONTROLLER,
        (const byte *) "ReadableByteStreamController.desiredSize getter called on incompatible receiver");
}

static MalValue rs_byte_controller_get_byob_request(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *controller = rs_require(vm, self,
        MAL_READABLE_BYTE_STREAM_CONTROLLER,
        (const byte *) "ReadableByteStreamController.byobRequest getter called on incompatible receiver");
    if (controller == nullptr) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(controller->as.controller.byob_request)) {
        return controller->as.controller.byob_request;
    }
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(controller->as.controller.stream);
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader == nullptr || reader->as.reader.requests_head == nullptr ||
        !mal_value_is_typed_array_object(reader->as.reader.requests_head->view)) {
        return mal_value_new_null();
    }

    MalValue roots[3] = {
        self, reader->as.reader.requests_head->view, mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalTypedArrayObject *source = mal_value_to_typed_array_object(roots[1]);
    u32 byte_length = mal_typed_array_object_byte_length(source);
    u32 bytes_filled = (u32) reader->as.reader.requests_head->bytes_filled;
    roots[2] = mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        source->buffer, MAL_TA_UINT8, source->byte_offset + bytes_filled,
        byte_length - bytes_filled, false));
    MalReadableStreamObject *request = rs_new(vm, MAL_READABLE_STREAM_BYOB_REQUEST,
        mal_value_to_object(vm->intrinsics[
            MAL_INTRINSIC_READABLE_STREAM_BYOB_REQUEST_PROTOTYPE]));
    request->as.byob_request.controller = roots[0];
    request->as.byob_request.view = roots[2];
    controller->as.controller.byob_request =
        mal_value_from_readable_stream_object(request);
    mal_gc_card(&request->object.header, roots[0]);
    mal_gc_card(&request->object.header, roots[2]);
    mal_gc_card(&controller->object.header, controller->as.controller.byob_request);
    MalValue result = controller->as.controller.byob_request;
    mal_gc_unroot(&span);
    return result;
}

static MalReadableStreamObject *rs_require_byob_request(
    MalVm *vm, MalValue self, const byte *message) {
    return rs_require(vm, self, MAL_READABLE_STREAM_BYOB_REQUEST, message);
}

static void rs_invalidate_byob_request(MalReadableStreamObject *controller) {
    MalValue request_value = controller->as.controller.byob_request;
    if (rs_is_kind(request_value, MAL_READABLE_STREAM_BYOB_REQUEST)) {
        MalReadableStreamObject *request =
            mal_value_to_readable_stream_object(request_value);
        mal_gc_write_barrier(request->as.byob_request.controller);
        mal_gc_write_barrier(request->as.byob_request.view);
        request->as.byob_request.controller = mal_value_new_undefined();
        request->as.byob_request.view = mal_value_new_null();
    }
    mal_gc_write_barrier(request_value);
    controller->as.controller.byob_request = mal_value_new_undefined();
}

static MalValue rs_byob_request_get_view(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalReadableStreamObject *request = rs_require_byob_request(vm, self,
        (const byte *) "ReadableStreamBYOBRequest.view getter called on incompatible receiver");
    return request == nullptr ? mal_value_new_undefined()
                              : request->as.byob_request.view;
}

static MalValue rs_byob_request_respond(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *request = rs_require_byob_request(vm, self,
        (const byte *) "ReadableStreamBYOBRequest.respond called on incompatible receiver");
    if (request == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(request->as.byob_request.controller) ||
        !mal_value_is_typed_array_object(request->as.byob_request.view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest is no longer active");
        return mal_value_new_undefined();
    }
    f64 raw;
    if (!mal_vm_to_number(vm,
            argc >= 1 ? args[0] : mal_value_new_undefined(), &raw)) {
        return mal_value_new_undefined();
    }
    if (!isfinite(raw) || raw < 0 || floor(raw) != raw || raw > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest.respond requires a valid byte count");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller = mal_value_to_readable_stream_object(
        request->as.byob_request.controller);
    MalReadableStreamObject *stream = mal_value_to_readable_stream_object(
        controller->as.controller.stream);
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader == nullptr || reader->as.reader.requests_head == nullptr ||
        !mal_value_is_typed_array_object(reader->as.reader.requests_head->view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest has no pending read");
        return mal_value_new_undefined();
    }
    MalReadableStreamReadRequest *read_request = reader->as.reader.requests_head;
    MalValue roots[5] = {
        self, read_request->view, read_request->promise,
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    roots[1] = rs_transfer_typed_array_view(vm, roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    mal_gc_write_barrier(read_request->view);
    read_request->view = roots[1];
    mal_gc_card(&reader->object.header, roots[1]);
    MalTypedArrayObject *destination = mal_value_to_typed_array_object(roots[1]);
    u32 requested = (u32) raw;
    u32 total_capacity = mal_typed_array_object_byte_length(destination);
    u32 bytes_filled = (u32) read_request->bytes_filled;
    u32 capacity = total_capacity - bytes_filled;
    if (requested > capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest.respond byte count exceeds the view");
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    read_request->bytes_filled += requested;
    u32 element_size = mal_typed_array_element_size(destination->kind);
    u32 total_filled = (u32) read_request->bytes_filled;
    u32 committed = total_filled - (total_filled % element_size);
    rs_invalidate_byob_request(controller);
    if (stream->as.stream.state == MAL_READABLE_STREAM_CLOSED) {
        roots[3] = rs_read_result(vm,
            rs_byob_result_view(vm, destination, committed), true);
        rs_request_remove(reader, read_request);
        mal_promise_fulfill(vm,
            mal_value_to_promise_object(roots[2]), roots[3]);
        while (reader->as.reader.requests_head != nullptr) {
            MalReadableStreamReadRequest *next = reader->as.reader.requests_head;
            roots[1] = next->view;
            roots[2] = next->promise;
            MalTypedArrayObject *next_destination =
                mal_value_to_typed_array_object(roots[1]);
            roots[3] = rs_read_result(vm,
                rs_byob_result_view(vm, next_destination, 0), true);
            rs_request_remove(reader, next);
            mal_promise_fulfill(vm,
                mal_value_to_promise_object(roots[2]), roots[3]);
        }
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    if (committed == 0) {
        rs_call_pull_if_needed(vm, controller);
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    u32 remainder = total_filled - committed;
    if (remainder > 0) {
        roots[4] = mal_value_from_typed_array_object(mal_typed_array_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[
                MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
            destination->buffer, MAL_TA_UINT8,
            destination->byte_offset + committed, remainder, false));
    }
    roots[3] = rs_read_result(vm,
        rs_byob_result_view(vm, destination, committed), false);
    rs_request_remove(reader, read_request);
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[2]), roots[3]);
    if (remainder > 0) {
        (void) rs_controller_enqueue_kind(vm,
            mal_value_from_readable_stream_object(controller), &roots[4], 1,
            MAL_READABLE_BYTE_STREAM_CONTROLLER,
            (const byte *) "ReadableByteStreamController.enqueue called on incompatible receiver",
            true);
    } else {
        rs_call_pull_if_needed(vm, controller);
    }
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static MalValue rs_byob_request_respond_with_new_view(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalReadableStreamObject *request = rs_require_byob_request(vm, self,
        (const byte *) "ReadableStreamBYOBRequest.respondWithNewView called on incompatible receiver");
    if (request == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue view = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalBufferSourceSpan view_span;
    if (!mal_value_is_typed_array_object(view) ||
        mal_buffer_source_span(view, &view_span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest.respondWithNewView requires an attached TypedArray");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *controller = mal_value_is_undefined(
            request->as.byob_request.controller)
        ? nullptr
        : mal_value_to_readable_stream_object(request->as.byob_request.controller);
    if (controller == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest is no longer active");
        return mal_value_new_undefined();
    }
    MalReadableStreamObject *reader = rs_reader_for(
        mal_value_to_readable_stream_object(controller->as.controller.stream));
    if (reader == nullptr || reader->as.reader.requests_head == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest has no pending read");
        return mal_value_new_undefined();
    }
    MalReadableStreamReadRequest *read_request = reader->as.reader.requests_head;
    MalTypedArrayObject *original =
        mal_value_to_typed_array_object(read_request->view);
    MalTypedArrayObject *replacement = mal_value_to_typed_array_object(view);
    u32 original_byte_length = original->length *
        mal_typed_array_element_size(original->kind);
    u32 remaining_offset = original->byte_offset + (u32) read_request->bytes_filled;
    usize remaining_length = original_byte_length - read_request->bytes_filled;
    bool replaces_buffer = replacement->buffer != original->buffer;
    if (replacement->byte_offset != remaining_offset ||
        view_span.length > remaining_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStreamBYOBRequest replacement view must cover the pending buffer region");
        return mal_value_new_undefined();
    }
    if (replaces_buffer) {
        MalValue roots[2] = {view, mal_value_new_undefined()};
        MalRootSpan span;
        mal_gc_root(&span, roots, 2);
        roots[1] = mal_value_from_typed_array_object(mal_typed_array_object_new(
            &vm->heap, original->object.prototype, replacement->buffer,
            original->kind, original->byte_offset, original->length,
            original->length_tracking));
        mal_gc_write_barrier(read_request->view);
        read_request->view = roots[1];
        mal_gc_card(&reader->object.header, roots[1]);
        mal_gc_unroot(&span);
    }
    MalValue count = mal_value_from_f64_convert_nan((f64) view_span.length);
    return rs_byob_request_respond(vm, self, &count, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue rs_controller_enqueue_kind(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalReadableStreamKind kind,
    const byte *message, bool owned_byte_chunk) {
    MalReadableStreamObject *controller = rs_require(vm, self, kind, message);
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
    if (kind == MAL_READABLE_BYTE_STREAM_CONTROLLER && !owned_byte_chunk) {
        MalValue byte_chunk;
        if (!rs_copy_byte_chunk(vm, chunk, &byte_chunk)) {
            return mal_value_new_undefined();
        }
        chunk = byte_chunk;
    }
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (reader != nullptr && reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        MalValue roots[5] = {
            chunk, request->promise, request->view,
            mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 5);
        if (!mal_value_is_undefined(roots[2])) {
            roots[2] = rs_transfer_typed_array_view(vm, roots[2]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            mal_gc_write_barrier(request->view);
            request->view = roots[2];
            mal_gc_card(&reader->object.header, roots[2]);
            MalTypedArrayObject *destination;
            MalBufferSourceSpan destination_span;
            if (!rs_byob_view_is_valid(vm, roots[2],
                    &destination, &destination_span)) {
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            MalBufferSourceSpan source_span;
            if (mal_buffer_source_span(roots[0], &source_span) !=
                MAL_BUFFER_SOURCE_SPAN_OK) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "A byte ReadableStream must contain attached buffer-source chunks");
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            usize capacity = destination_span.length - request->bytes_filled;
            usize copied = source_span.length < capacity
                ? source_span.length : capacity;
            if (copied > 0) {
                memcpy(destination_span.data + request->bytes_filled,
                    source_span.data, copied);
            }
            request->bytes_filled += copied;
            usize element_size = mal_typed_array_element_size(destination->kind);
            usize committed = request->bytes_filled -
                (request->bytes_filled % element_size);
            if (committed == 0) {
                if (copied < source_span.length) {
                    rs_queue_append(controller, roots[0], copied,
                        (f64) (source_span.length - copied));
                }
                rs_invalidate_byob_request(controller);
                mal_gc_unroot(&span);
                rs_call_pull_if_needed(vm, controller);
                return mal_value_new_undefined();
            }
            usize remainder = request->bytes_filled - committed;
            if (remainder > 0) {
                roots[4] = mal_value_from_typed_array_object(
                    mal_typed_array_object_new(&vm->heap,
                        mal_value_to_object(vm->intrinsics[
                            MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
                        destination->buffer, MAL_TA_UINT8,
                        destination->byte_offset + (u32) committed,
                        (u32) remainder, false));
                rs_queue_append(controller, roots[4], 0, (f64) remainder);
            }
            if (copied < source_span.length) {
                rs_queue_append(controller, roots[0], copied,
                    (f64) (source_span.length - copied));
            }
            roots[3] = rs_read_result(vm,
                rs_byob_result_view(vm, destination, (u32) committed), false);
        } else {
            roots[3] = rs_read_result(vm, roots[0], false);
        }
        rs_invalidate_byob_request(controller);
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
    reader = rs_reader_for(stream);
    if (kind == MAL_READABLE_BYTE_STREAM_CONTROLLER && reader != nullptr &&
        reader->as.reader.requests_head != nullptr &&
        controller->as.controller.queue_head != nullptr) {
        MalReadableStreamQueueEntry *entry = controller->as.controller.queue_head;
        MalValue queued = entry->chunk;
        MalRootSpan queued_span;
        mal_gc_root(&queued_span, &queued, 1);
        if (entry->byte_offset > 0) {
            MalTypedArrayObject *source =
                mal_value_to_typed_array_object(queued);
            u32 byte_length = mal_typed_array_object_byte_length(source);
            queued = mal_value_from_typed_array_object(
                mal_typed_array_object_new(&vm->heap,
                    mal_value_to_object(vm->intrinsics[
                        MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
                    source->buffer, MAL_TA_UINT8,
                    source->byte_offset + (u32) entry->byte_offset,
                    byte_length - (u32) entry->byte_offset, false));
        }
        controller->as.controller.queue_head = entry->next;
        if (controller->as.controller.queue_head == nullptr) {
            controller->as.controller.queue_tail = nullptr;
        }
        controller->as.controller.queue_total_size -= entry->size;
        mal_gc_write_barrier(entry->chunk);
        free(entry);
        (void) rs_controller_enqueue_kind(vm, self, &queued, 1, kind,
            message, true);
        mal_gc_unroot(&queued_span);
        return mal_value_new_undefined();
    }
    rs_call_pull_if_needed(vm, controller);
    return mal_value_new_undefined();
}

static MalValue rs_controller_enqueue(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    return rs_controller_enqueue_kind(vm, self, args, argc,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        (const byte *) "ReadableStreamDefaultController.enqueue called on incompatible receiver",
        false);
}

static MalValue rs_byte_controller_enqueue(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    return rs_controller_enqueue_kind(vm, self, args, argc,
        MAL_READABLE_BYTE_STREAM_CONTROLLER,
        (const byte *) "ReadableByteStreamController.enqueue called on incompatible receiver",
        false);
}

static MalValue rs_controller_close_kind(MalVm *vm, MalValue self,
    MalReadableStreamKind kind, const byte *message) {
    MalReadableStreamObject *controller = rs_require(vm, self, kind, message);
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
    MalReadableStreamObject *reader = rs_reader_for(stream);
    if (kind == MAL_READABLE_BYTE_STREAM_CONTROLLER && reader != nullptr &&
        reader->as.reader.requests_head != nullptr &&
        !mal_value_is_undefined(reader->as.reader.requests_head->view) &&
        reader->as.reader.requests_head->bytes_filled > 0) {
        MalValue error = rs_take_type_error(vm,
            (const byte *) "Cannot close a byte stream with an incomplete element");
        rs_error_stream(vm, stream, error);
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_THROW,
            .value = error,
        };
        return mal_value_new_undefined();
    }
    if (controller->as.controller.queue_head == nullptr) {
        rs_close_stream(vm, stream);
    } else {
        controller->as.controller.close_requested = true;
    }
    return mal_value_new_undefined();
}

static MalValue rs_controller_close(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_controller_close_kind(vm, self,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        (const byte *) "ReadableStreamDefaultController.close called on incompatible receiver");
}

static MalValue rs_byte_controller_close(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return rs_controller_close_kind(vm, self,
        MAL_READABLE_BYTE_STREAM_CONTROLLER,
        (const byte *) "ReadableByteStreamController.close called on incompatible receiver");
}

static MalValue rs_controller_error_kind(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalReadableStreamKind kind,
    const byte *message) {
    MalReadableStreamObject *controller = rs_require(vm, self, kind, message);
    if (controller != nullptr) {
        rs_error_stream(vm,
            mal_value_to_readable_stream_object(controller->as.controller.stream),
            argc >= 1 ? args[0] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue rs_controller_error(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    return rs_controller_error_kind(vm, self, args, argc,
        MAL_READABLE_STREAM_DEFAULT_CONTROLLER,
        (const byte *) "ReadableStreamDefaultController.error called on incompatible receiver");
}

static MalValue rs_byte_controller_error(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    return rs_controller_error_kind(vm, self, args, argc,
        MAL_READABLE_BYTE_STREAM_CONTROLLER,
        (const byte *) "ReadableByteStreamController.error called on incompatible receiver");
}

static MalValue rs_auto_allocate_view(MalVm *vm, u32 byte_length) {
    MalValue buffer_value = mal_value_new_undefined();
    MalRootSpan span;
    mal_gc_root(&span, &buffer_value, 1);
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        byte_length, byte_length, false, false);
    buffer_value = mal_value_from_array_buffer_object(buffer);
    if (byte_length > 0 && buffer->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "ReadableStream auto-allocated view allocation failed");
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    MalValue view = mal_value_from_typed_array_object(mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, 0, byte_length, false));
    mal_gc_unroot(&span);
    return view;
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
            MalValue error = vm->completion.value;
            vm->completion = rs_normal();
            return rs_rejected_promise(vm, error);
        }
        view = rs_transfer_typed_array_view(vm, view);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            vm->completion = rs_normal();
            return rs_rejected_promise(vm, error);
        }
        destination = mal_value_to_typed_array_object(view);
        (void) mal_buffer_source_span(view, &destination_span);
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
    usize initial_bytes_filled = 0;
    if (byob && controller->as.controller.queue_head != nullptr) {
        MalValue roots[4] = {
            view, mal_value_new_undefined(),
            mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 4);
        usize copied = 0;
        while (controller->as.controller.queue_head != nullptr &&
            copied < destination_span.length) {
            MalReadableStreamQueueEntry *entry =
                controller->as.controller.queue_head;
            MalBufferSourceSpan source_span;
            if (mal_buffer_source_span(entry->chunk, &source_span) !=
                    MAL_BUFFER_SOURCE_SPAN_OK ||
                entry->byte_offset > source_span.length) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "A byte ReadableStream must contain attached buffer-source chunks");
                mal_gc_unroot(&span);
                return mal_value_new_undefined();
            }
            usize available = source_span.length - entry->byte_offset;
            usize capacity = destination_span.length - copied;
            usize take = available < capacity ? available : capacity;
            if (take > 0) {
                memcpy(destination_span.data + copied,
                    source_span.data + entry->byte_offset, take);
            }
            copied += take;
            entry->byte_offset += take;
            entry->size -= (f64) take;
            controller->as.controller.queue_total_size -= (f64) take;
            if (entry->byte_offset == source_span.length) {
                controller->as.controller.queue_head = entry->next;
                if (controller->as.controller.queue_head == nullptr) {
                    controller->as.controller.queue_tail = nullptr;
                }
                mal_gc_write_barrier(entry->chunk);
                free(entry);
            }
        }
        if (controller->as.controller.queue_total_size < 0) {
            controller->as.controller.queue_total_size = 0;
        }
        u32 element_size = mal_typed_array_element_size(destination->kind);
        usize committed = copied - (copied % element_size);
        usize remainder = copied - committed;
        if (committed > 0) {
            if (remainder > 0) {
                roots[3] = mal_value_from_typed_array_object(
                    mal_typed_array_object_new(&vm->heap,
                        mal_value_to_object(vm->intrinsics[
                            MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
                        destination->buffer, MAL_TA_UINT8,
                        destination->byte_offset + (u32) committed,
                        (u32) remainder, false));
            }
            roots[1] = rs_read_result(vm,
                rs_byob_result_view(vm, destination, (u32) committed), false);
            roots[2] = rs_resolved_promise(vm, roots[1]);
            if (remainder > 0) {
                rs_queue_append(controller, roots[3], 0, (f64) remainder);
            } else if (controller->as.controller.close_requested &&
                controller->as.controller.queue_head == nullptr) {
                rs_close_stream(vm, stream);
            } else {
                rs_call_pull_if_needed(vm, controller);
            }
            MalValue result = roots[2];
            mal_gc_unroot(&span);
            return result;
        }
        initial_bytes_filled = copied;
        if (controller->as.controller.close_requested) {
            MalValue error = rs_take_type_error(vm,
                (const byte *) "A byte stream closed with an incomplete element");
            rs_error_stream(vm, stream, error);
            MalValue rejected = rs_rejected_promise(vm, error);
            mal_gc_unroot(&span);
            return rejected;
        }
        mal_gc_unroot(&span);
    } else if (controller->as.controller.queue_head != nullptr) {
        MalReadableStreamQueueEntry *entry = controller->as.controller.queue_head;
        MalValue roots[4] = {
            entry->chunk, view, mal_value_new_undefined(), mal_value_new_undefined(),
        };
        MalRootSpan span;
        mal_gc_root(&span, roots, 4);
        bool consumed_entry = true;
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

    if (!byob && controller->kind == MAL_READABLE_BYTE_STREAM_CONTROLLER &&
        controller->as.controller.auto_allocate_chunk_size > 0) {
        view = rs_auto_allocate_view(
            vm, controller->as.controller.auto_allocate_chunk_size);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }
    MalValue request_roots[2] = {view, mal_value_new_undefined()};
    MalRootSpan request_span;
    mal_gc_root(&request_span, request_roots, 2);
    request_roots[1] = mal_value_from_promise_object(rs_new_promise(vm));
    MalReadableStreamReadRequest *request = malloc(sizeof(MalReadableStreamReadRequest));
    request->next = nullptr;
    request->promise = request_roots[1];
    request->view = request_roots[0];
    request->bytes_filled = initial_bytes_filled;
    if (reader->as.reader.requests_tail == nullptr) {
        reader->as.reader.requests_head = request;
    } else {
        reader->as.reader.requests_tail->next = request;
    }
    reader->as.reader.requests_tail = request;
    mal_gc_card(&reader->object.header, request_roots[1]);
    mal_gc_card(&reader->object.header, request_roots[0]);
    rs_call_pull_if_needed(vm, controller);
    MalValue promise = request_roots[1];
    mal_gc_unroot(&request_span);
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

MalValue mal_readable_stream_default_reader_closed(MalValue value) {
    return mal_value_to_readable_stream_object(value)->as.reader.closed_promise;
}

bool mal_readable_stream_default_reader_is_readable(MalValue value) {
    MalReadableStreamObject *reader = mal_value_to_readable_stream_object(value);
    return !mal_value_is_undefined(reader->as.reader.stream) &&
        mal_value_to_readable_stream_object(reader->as.reader.stream)->as.stream.state ==
            MAL_READABLE_STREAM_READABLE;
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
    MalReadableStreamObject *stream =
        mal_value_to_readable_stream_object(reader->as.reader.stream);
    MalValue roots[3] = {
        self, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    roots[1] = rs_take_type_error(
        vm, (const byte *) "ReadableStream reader was released");
    while (reader->as.reader.requests_head != nullptr) {
        MalReadableStreamReadRequest *request = reader->as.reader.requests_head;
        roots[2] = request->promise;
        rs_request_remove(reader, request);
        mal_promise_reject(
            vm, mal_value_to_promise_object(roots[2]), roots[1]);
    }
    MalPromiseObject *closed;
    if (stream->as.stream.state == MAL_READABLE_STREAM_READABLE) {
        closed = mal_value_to_promise_object(reader->as.reader.closed_promise);
        closed->is_handled = true;
        mal_promise_reject(vm, closed, roots[1]);
    } else {
        roots[2] = rs_rejected_promise(vm, roots[1]);
        closed = mal_value_to_promise_object(roots[2]);
        closed->is_handled = true;
        mal_gc_write_barrier(reader->as.reader.closed_promise);
        reader->as.reader.closed_promise = roots[2];
        mal_gc_card(&reader->object.header, roots[2]);
    }
    mal_gc_write_barrier(stream->as.stream.reader);
    stream->as.stream.reader = mal_value_new_undefined();
    mal_gc_write_barrier(reader->as.reader.stream);
    reader->as.reader.stream = mal_value_new_undefined();
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

MalValue mal_readable_stream_default_reader_cancel(
    MalVm *vm, MalValue value, MalValue reason) {
    return rs_reader_cancel(vm, value, &reason, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

void mal_readable_stream_default_reader_release(MalVm *vm, MalValue value) {
    (void) rs_reader_release_lock(vm, value, nullptr, 0,
        mal_value_new_undefined(), mal_value_new_undefined());
}

enum {
    RS_PIPE_READER,
    RS_PIPE_WRITER,
    RS_PIPE_PROMISE,
    RS_PIPE_REASON,
    RS_PIPE_FLAGS,
    RS_PIPE_SHUTTING_DOWN,
    RS_PIPE_SETTLED,
    RS_PIPE_READING,
    RS_PIPE_SOURCE_CLOSED,
    RS_PIPE_PENDING_WRITE,
    RS_PIPE_SIGNAL,
    RS_PIPE_ABORT_PENDING_ACTIONS,
    RS_PIPE_ABORT_DESTINATION_ERROR,
    RS_PIPE_ABORT_DESTINATION_ERROR_SET,
    RS_PIPE_ABORT_SOURCE_ERROR,
    RS_PIPE_ABORT_SOURCE_ERROR_SET,
    RS_PIPE_SLOT_COUNT,
};

enum {
    RS_PIPE_PREVENT_CLOSE = 1 << 0,
    RS_PIPE_PREVENT_ABORT = 1 << 1,
    RS_PIPE_PREVENT_CANCEL = 1 << 2,
};

static void rs_pipe_abort_begin(
    MalVm *vm, MalNativeFunctionObject *state, MalValue reason);

static MalValue rs_pipe_state_callback(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *state = mal_value_to_native_function_object(callee);
    if (!mal_readable_stream_default_reader_is_readable(
            mal_native_function_object_get_slot(state, RS_PIPE_READER)) ||
        !mal_writable_stream_default_writer_is_writable(
            mal_native_function_object_get_slot(state, RS_PIPE_WRITER))) {
        return mal_value_new_undefined();
    }
    rs_pipe_abort_begin(vm, state,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalNativeFunctionObject *rs_pipe_state(MalValue callee) {
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    return mal_value_to_native_function_object(
        mal_native_function_object_get_slot(callback, 0));
}

static bool rs_pipe_state_bool(MalNativeFunctionObject *state, i32 slot) {
    return mal_value_is_truthy(mal_native_function_object_get_slot(state, slot));
}

static bool rs_pipe_has_flag(MalNativeFunctionObject *state, i32 flag) {
    i32 flags = mal_value_to_i32(
        mal_native_function_object_get_slot(state, RS_PIPE_FLAGS));
    return (flags & flag) != 0;
}

static void rs_pipe_settle(
    MalVm *vm, MalNativeFunctionObject *state, bool rejected, MalValue value) {
    if (rs_pipe_state_bool(state, RS_PIPE_SETTLED)) return;
    mal_native_function_object_set_slot(
        state, RS_PIPE_SETTLED, mal_value_new_boolean(true));
    MalValue roots[5] = {
        mal_value_from_native_function_object(state),
        mal_native_function_object_get_slot(state, RS_PIPE_READER),
        mal_native_function_object_get_slot(state, RS_PIPE_WRITER),
        value, mal_native_function_object_get_slot(state, RS_PIPE_SIGNAL),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 5);
    if (!mal_value_is_undefined(roots[4])) {
        mal_abort_signal_remove_algorithm(roots[4], roots[0]);
    }
    mal_readable_stream_default_reader_release(vm, roots[1]);
    mal_writable_stream_default_writer_release(vm, roots[2]);
    MalPromiseObject *promise = mal_value_to_promise_object(
        mal_native_function_object_get_slot(state, RS_PIPE_PROMISE));
    if (rejected) mal_promise_reject(vm, promise, roots[3]);
    else mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    mal_gc_unroot(&span);
}

static void rs_pipe_attach(MalVm *vm, MalValue promise,
    MalNativeFunctionCallback fulfilled_callback,
    MalNativeFunctionCallback rejected_callback,
    MalValue state_value) {
    MalValue roots[4] = {
        promise, state_value, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    if (fulfilled_callback != nullptr) {
        roots[2] = rs_callback(vm, fulfilled_callback, roots[1]);
    }
    if (rejected_callback != nullptr) {
        roots[3] = rs_callback(vm, rejected_callback, roots[1]);
    }
    mal_promise_perform_then(vm, roots[0], roots[2], roots[3],
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&span);
}

static MalValue rs_pipe_action_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *state = rs_pipe_state(callee);
    rs_pipe_settle(vm, state, true,
        mal_native_function_object_get_slot(state, RS_PIPE_REASON));
    return mal_value_new_undefined();
}

static MalValue rs_pipe_action_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_settle(vm, rs_pipe_state(callee), true,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static void rs_pipe_abort_action_finished(MalVm *vm,
    MalNativeFunctionObject *state, bool destination, bool rejected,
    MalValue error) {
    if (rejected) {
        mal_native_function_object_set_slot(state,
            destination ? RS_PIPE_ABORT_DESTINATION_ERROR
                        : RS_PIPE_ABORT_SOURCE_ERROR,
            error);
        mal_native_function_object_set_slot(state,
            destination ? RS_PIPE_ABORT_DESTINATION_ERROR_SET
                        : RS_PIPE_ABORT_SOURCE_ERROR_SET,
            mal_value_new_boolean(true));
    }
    i32 pending = mal_value_to_i32(mal_native_function_object_get_slot(
        state, RS_PIPE_ABORT_PENDING_ACTIONS)) - 1;
    mal_native_function_object_set_slot(state, RS_PIPE_ABORT_PENDING_ACTIONS,
        mal_value_from_i32(pending));
    if (pending != 0) return;
    MalValue reason = mal_native_function_object_get_slot(state, RS_PIPE_REASON);
    if (rs_pipe_state_bool(state, RS_PIPE_ABORT_DESTINATION_ERROR_SET)) {
        reason = mal_native_function_object_get_slot(
            state, RS_PIPE_ABORT_DESTINATION_ERROR);
    } else if (rs_pipe_state_bool(state, RS_PIPE_ABORT_SOURCE_ERROR_SET)) {
        reason = mal_native_function_object_get_slot(
            state, RS_PIPE_ABORT_SOURCE_ERROR);
    }
    rs_pipe_settle(vm, state, true, reason);
}

static MalValue rs_pipe_abort_destination_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    rs_pipe_abort_action_finished(vm, rs_pipe_state(callee), true, false,
        mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_abort_destination_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_abort_action_finished(vm, rs_pipe_state(callee), true, true,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_abort_source_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    rs_pipe_abort_action_finished(vm, rs_pipe_state(callee), false, false,
        mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_abort_source_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_abort_action_finished(vm, rs_pipe_state(callee), false, true,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static void rs_pipe_abort_run_actions(
    MalVm *vm, MalNativeFunctionObject *state) {
    bool abort_destination = !rs_pipe_has_flag(state, RS_PIPE_PREVENT_ABORT) &&
        mal_writable_stream_default_writer_is_writable(
            mal_native_function_object_get_slot(state, RS_PIPE_WRITER));
    bool cancel_source = !rs_pipe_has_flag(state, RS_PIPE_PREVENT_CANCEL) &&
        mal_readable_stream_default_reader_is_readable(
            mal_native_function_object_get_slot(state, RS_PIPE_READER));
    i32 pending = (abort_destination ? 1 : 0) + (cancel_source ? 1 : 0);
    mal_native_function_object_set_slot(state, RS_PIPE_ABORT_PENDING_ACTIONS,
        mal_value_from_i32(pending));
    if (pending == 0) {
        rs_pipe_settle(vm, state, true,
            mal_native_function_object_get_slot(state, RS_PIPE_REASON));
        return;
    }
    MalValue state_value = mal_value_from_native_function_object(state);
    MalValue reason = mal_native_function_object_get_slot(state, RS_PIPE_REASON);
    if (abort_destination) {
        MalValue action = mal_writable_stream_default_writer_abort(vm,
            mal_native_function_object_get_slot(state, RS_PIPE_WRITER), reason);
        rs_pipe_attach(vm, action, rs_pipe_abort_destination_fulfilled,
            rs_pipe_abort_destination_rejected, state_value);
    }
    if (cancel_source) {
        MalValue action = mal_readable_stream_default_reader_cancel(vm,
            mal_native_function_object_get_slot(state, RS_PIPE_READER), reason);
        rs_pipe_attach(vm, action, rs_pipe_abort_source_fulfilled,
            rs_pipe_abort_source_rejected, state_value);
    }
}

static MalValue rs_pipe_abort_write_settled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    rs_pipe_abort_run_actions(vm, rs_pipe_state(callee));
    return mal_value_new_undefined();
}

static void rs_pipe_abort_begin(
    MalVm *vm, MalNativeFunctionObject *state, MalValue reason) {
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) return;
    mal_native_function_object_set_slot(
        state, RS_PIPE_SHUTTING_DOWN, mal_value_new_boolean(true));
    mal_native_function_object_set_slot(state, RS_PIPE_REASON, reason);
    MalValue pending_write = mal_native_function_object_get_slot(
        state, RS_PIPE_PENDING_WRITE);
    if (mal_value_is_undefined(pending_write)) {
        rs_pipe_abort_run_actions(vm, state);
    } else {
        rs_pipe_attach(vm, pending_write, rs_pipe_abort_write_settled,
            rs_pipe_abort_write_settled,
            mal_value_from_native_function_object(state));
    }
}

static void rs_pipe_shutdown_source_error(
    MalVm *vm, MalNativeFunctionObject *state, MalValue reason) {
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) return;
    mal_native_function_object_set_slot(
        state, RS_PIPE_SHUTTING_DOWN, mal_value_new_boolean(true));
    mal_native_function_object_set_slot(state, RS_PIPE_REASON, reason);
    if (rs_pipe_has_flag(state, RS_PIPE_PREVENT_ABORT)) {
        rs_pipe_settle(vm, state, true, reason);
        return;
    }
    MalValue state_value = mal_value_from_native_function_object(state);
    MalValue action = mal_writable_stream_default_writer_abort(vm,
        mal_native_function_object_get_slot(state, RS_PIPE_WRITER), reason);
    rs_pipe_attach(vm, action, rs_pipe_action_fulfilled,
        rs_pipe_action_rejected, state_value);
}

static void rs_pipe_shutdown_destination_error(
    MalVm *vm, MalNativeFunctionObject *state, MalValue reason) {
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) return;
    mal_native_function_object_set_slot(
        state, RS_PIPE_SHUTTING_DOWN, mal_value_new_boolean(true));
    mal_native_function_object_set_slot(state, RS_PIPE_REASON, reason);
    if (rs_pipe_has_flag(state, RS_PIPE_PREVENT_CANCEL)) {
        rs_pipe_settle(vm, state, true, reason);
        return;
    }
    MalValue state_value = mal_value_from_native_function_object(state);
    MalValue action = mal_readable_stream_default_reader_cancel(vm,
        mal_native_function_object_get_slot(state, RS_PIPE_READER), reason);
    rs_pipe_attach(vm, action, rs_pipe_action_fulfilled,
        rs_pipe_action_rejected, state_value);
}

static void rs_pipe_pump(MalVm *vm, MalNativeFunctionObject *state);

static MalValue rs_pipe_destination_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_shutdown_destination_error(vm, rs_pipe_state(callee),
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_close_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    rs_pipe_settle(vm, rs_pipe_state(callee), false,
        mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_close_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_settle(vm, rs_pipe_state(callee), true,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static void rs_pipe_shutdown_source_closed(
    MalVm *vm, MalNativeFunctionObject *state) {
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) return;
    mal_native_function_object_set_slot(
        state, RS_PIPE_SHUTTING_DOWN, mal_value_new_boolean(true));
    if (rs_pipe_has_flag(state, RS_PIPE_PREVENT_CLOSE)) {
        MalValue pending_write = mal_native_function_object_get_slot(
            state, RS_PIPE_PENDING_WRITE);
        if (mal_value_is_undefined(pending_write)) {
            rs_pipe_settle(vm, state, false, mal_value_new_undefined());
        } else {
            rs_pipe_attach(vm, pending_write, rs_pipe_close_fulfilled,
                rs_pipe_close_rejected,
                mal_value_from_native_function_object(state));
        }
        return;
    }
    MalValue action = mal_writable_stream_default_writer_close(vm,
        mal_native_function_object_get_slot(state, RS_PIPE_WRITER));
    rs_pipe_attach(vm, action, rs_pipe_close_fulfilled,
        rs_pipe_close_rejected, mal_value_from_native_function_object(state));
}

static MalValue rs_pipe_source_closed(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *state = rs_pipe_state(callee);
    if (rs_pipe_state_bool(state, RS_PIPE_READING)) {
        mal_native_function_object_set_slot(
            state, RS_PIPE_SOURCE_CLOSED, mal_value_new_boolean(true));
    } else {
        rs_pipe_shutdown_source_closed(vm, state);
    }
    return mal_value_new_undefined();
}

static MalValue rs_pipe_read_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *state = rs_pipe_state(callee);
    mal_native_function_object_set_slot(
        state, RS_PIPE_READING, mal_value_new_boolean(false));
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) {
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "done"), &roots[1])) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        rs_pipe_shutdown_source_error(vm, state, error);
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    if (mal_value_is_truthy(roots[1])) {
        rs_pipe_shutdown_source_closed(vm, state);
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "value"), &roots[1])) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        rs_pipe_shutdown_source_error(vm, state, error);
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[2] = mal_writable_stream_default_writer_write(vm,
        mal_native_function_object_get_slot(state, RS_PIPE_WRITER), roots[1]);
    mal_native_function_object_set_slot(
        state, RS_PIPE_PENDING_WRITE, roots[2]);
    rs_pipe_attach(vm, roots[2], nullptr,
        rs_pipe_destination_rejected,
        mal_value_from_native_function_object(state));
    if (rs_pipe_state_bool(state, RS_PIPE_SOURCE_CLOSED)) {
        rs_pipe_shutdown_source_closed(vm, state);
    } else {
        rs_pipe_pump(vm, state);
    }
    mal_gc_unroot(&span);
    return mal_value_new_undefined();
}

static MalValue rs_pipe_source_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    rs_pipe_shutdown_source_error(vm, rs_pipe_state(callee),
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue rs_pipe_ready_fulfilled(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *state = rs_pipe_state(callee);
    if (rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(
        state, RS_PIPE_READING, mal_value_new_boolean(true));
    MalValue promise = mal_readable_stream_default_reader_read(vm,
        mal_native_function_object_get_slot(state, RS_PIPE_READER));
    rs_pipe_attach(vm, promise, rs_pipe_read_fulfilled,
        rs_pipe_source_rejected, mal_value_from_native_function_object(state));
    return mal_value_new_undefined();
}

static void rs_pipe_pump(MalVm *vm, MalNativeFunctionObject *state) {
    MalValue ready = mal_writable_stream_default_writer_ready(
        mal_native_function_object_get_slot(state, RS_PIPE_WRITER));
    rs_pipe_attach(vm, ready, rs_pipe_ready_fulfilled,
        rs_pipe_destination_rejected,
        mal_value_from_native_function_object(state));
}

static MalValue rs_pipe_destination_closed(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *state = rs_pipe_state(callee);
    if (!rs_pipe_state_bool(state, RS_PIPE_SHUTTING_DOWN)) {
        rs_pipe_shutdown_destination_error(vm, state,
            rs_take_type_error(vm,
                (const byte *) "WritableStream closed before piping completed"));
    }
    return mal_value_new_undefined();
}

static bool rs_pipe_options(MalVm *vm, MalValue options,
    i32 *flags_out, MalValue *signal_out) {
    *flags_out = 0;
    *signal_out = mal_value_new_undefined();
    if (mal_value_is_nil(options)) return true;
    const byte *names[] = {
        (const byte *) "preventAbort",
        (const byte *) "preventCancel",
        (const byte *) "preventClose",
        (const byte *) "signal",
    };
    i32 bits[] = {
        RS_PIPE_PREVENT_ABORT, RS_PIPE_PREVENT_CANCEL,
        RS_PIPE_PREVENT_CLOSE, 0,
    };
    for (i32 index = 0; index < 4; index++) {
        MalValue value;
        if (!mal_vm_get_property(vm, options,
                mal_intrinsic_string_key(vm, names[index]), &value)) {
            return false;
        }
        if (index < 3) {
            if (mal_value_is_truthy(value)) *flags_out |= bits[index];
        } else {
            *signal_out = value;
        }
    }
    if (!mal_value_is_undefined(*signal_out)) {
        if (!mal_value_is_event_target_object(*signal_out) ||
            !mal_value_to_event_target_object(*signal_out)->is_abort_signal) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "ReadableStream pipe signal must be an AbortSignal");
            return false;
        }
    }
    return true;
}

static MalValue rs_pipe_start(MalVm *vm, MalValue source,
    MalValue destination, i32 flags, MalValue signal) {
    MalValue roots[6] = {
        source, destination, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 6);
    roots[2] = mal_readable_stream_acquire_default_reader(vm, roots[0]);
    roots[3] = mal_writable_stream_acquire_default_writer(vm, roots[1]);
    roots[4] = mal_value_from_promise_object(rs_new_promise(vm));
    MalValue slots[RS_PIPE_SLOT_COUNT] = {
        roots[2], roots[3], roots[4], mal_value_new_undefined(),
        mal_value_from_i32(flags), mal_value_new_boolean(false),
        mal_value_new_boolean(false), mal_value_new_boolean(false),
        mal_value_new_boolean(false), mal_value_new_undefined(), signal,
        mal_value_from_i32(0), mal_value_new_undefined(),
        mal_value_new_boolean(false), mal_value_new_undefined(),
        mal_value_new_boolean(false),
    };
    roots[5] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, rs_pipe_state_callback, slots, RS_PIPE_SLOT_COUNT));
    if (!mal_value_is_undefined(signal)) {
        if (mal_abort_signal_is_aborted(signal)) {
            rs_pipe_abort_begin(vm,
                mal_value_to_native_function_object(roots[5]),
                mal_abort_signal_reason(signal));
        } else {
            mal_abort_signal_add_algorithm(signal, roots[5]);
        }
    }
    MalValue reader_closed = mal_readable_stream_default_reader_closed(roots[2]);
    rs_pipe_attach(vm, reader_closed, rs_pipe_source_closed,
        rs_pipe_source_rejected, roots[5]);
    MalValue closed = mal_writable_stream_default_writer_closed(roots[3]);
    rs_pipe_attach(vm, closed, rs_pipe_destination_closed,
        rs_pipe_destination_rejected, roots[5]);
    if (!rs_pipe_state_bool(mal_value_to_native_function_object(roots[5]),
            RS_PIPE_SHUTTING_DOWN)) {
        rs_pipe_pump(vm, mal_value_to_native_function_object(roots[5]));
    }
    MalValue result = roots[4];
    mal_gc_unroot(&span);
    return result;
}

static MalValue rs_pipe_to(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    if (!rs_is_kind(self, MAL_READABLE_STREAM)) {
        return rs_rejected_type_error(vm,
            (const byte *) "ReadableStream.pipeTo called on incompatible receiver");
    }
    MalValue destination = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_writable_stream_is_stream(destination)) {
        return rs_rejected_type_error(vm,
            (const byte *) "ReadableStream.pipeTo requires a WritableStream");
    }
    MalValue options = argc >= 2 ? args[1] : mal_value_new_undefined();
    i32 flags;
    MalValue signal;
    if (!rs_pipe_options(vm, options, &flags, &signal)) {
        MalValue error = vm->completion.value;
        vm->completion = rs_normal();
        return rs_rejected_promise(vm, error);
    }
    if (mal_readable_stream_is_locked(self) ||
        mal_writable_stream_is_locked(destination)) {
        return rs_rejected_type_error(vm,
            (const byte *) "Cannot pipe a locked stream");
    }
    return rs_pipe_start(vm, self, destination, flags, signal);
}

static MalValue rs_pipe_through(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    if (!rs_is_kind(self, MAL_READABLE_STREAM)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream.pipeThrough called on incompatible receiver");
        return mal_value_new_undefined();
    }
    MalValue roots[4] = {
        argc >= 1 ? args[0] : mal_value_new_undefined(),
        argc >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "readable"), &roots[2])) {
        goto fail;
    }
    if (!rs_is_kind(roots[2], MAL_READABLE_STREAM)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream.pipeThrough readable must be a ReadableStream");
        goto fail;
    }
    if (!mal_vm_get_property(vm, roots[0],
            mal_intrinsic_string_key(vm, (const byte *) "writable"), &roots[3])) {
        goto fail;
    }
    if (!mal_writable_stream_is_stream(roots[3])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ReadableStream.pipeThrough writable must be a WritableStream");
        goto fail;
    }
    i32 flags;
    MalValue signal;
    if (!rs_pipe_options(vm, roots[1], &flags, &signal)) goto fail;
    if (mal_readable_stream_is_locked(self) ||
        mal_writable_stream_is_locked(roots[3])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot pipe a locked stream");
        goto fail;
    }
    roots[0] = rs_pipe_start(vm, self, roots[3], flags, signal);
    mal_value_to_promise_object(roots[0])->is_handled = true;
    MalValue result = roots[2];
    mal_gc_unroot(&span);
    return result;
fail:
    mal_gc_unroot(&span);
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

static bool rs_tee_both_branches_canceled(MalNativeFunctionObject *state) {
    return rs_tee_branch_canceled(state, 1) &&
        rs_tee_branch_canceled(state, 2);
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

static void rs_tee_fail(
    MalVm *vm, MalNativeFunctionObject *state, MalValue error) {
    if (mal_value_is_truthy(mal_native_function_object_get_slot(
            state, RS_TEE_CLOSED))) {
        return;
    }
    mal_native_function_object_set_slot(
        state, RS_TEE_READING, mal_value_new_boolean(false));
    mal_native_function_object_set_slot(
        state, RS_TEE_CLOSED, mal_value_new_boolean(true));
    rs_tee_error_active_branches(vm, state, error);
    rs_tee_settle_cancellations(
        vm, state, false, mal_value_new_undefined());
}

static MalValue rs_tee_reader_closed_rejected(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *callback = mal_value_to_native_function_object(callee);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(
        mal_native_function_object_get_slot(callback, 0));
    rs_tee_fail(vm, state,
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
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
        // Canceling the original stream resolves its pending read before the
        // source cancel algorithm settles. In that path the branch promises
        // must follow the cancel result instead of resolving from this read.
        if (!rs_tee_both_branches_canceled(state)) {
            rs_tee_settle_cancellations(
                vm, state, false, mal_value_new_undefined());
        }
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
    rs_tee_fail(vm, state, error);
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
    MalValue roots[6] = {
        value, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 6);
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
    roots[5] = rs_callback(vm, rs_tee_reader_closed_rejected, roots[2]);
    mal_promise_perform_then(vm, reader->as.reader.closed_promise,
        mal_value_new_undefined(), roots[5],
        mal_value_new_undefined(), mal_value_new_undefined());
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

static MalValue rs_tee(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalValue roots[4] = {
        self, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 4);
    if (!mal_readable_stream_tee(vm, roots[0], &roots[1], &roots[2])) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[3] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
    MalArrayObject *branches = mal_value_to_array_object(roots[3]);
    mal_array_object_store(branches, mal_key_index(0), roots[1]);
    mal_array_object_store(branches, mal_key_index(1), roots[2]);
    MalValue result = roots[3];
    mal_gc_unroot(&span);
    return result;
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
        case MAL_READABLE_BYTE_STREAM_CONTROLLER:
            mal_gc_mark_value(object->as.controller.stream);
            mal_gc_mark_value(object->as.controller.underlying_source);
            mal_gc_mark_value(object->as.controller.pull_method);
            mal_gc_mark_value(object->as.controller.cancel_method);
            mal_gc_mark_value(object->as.controller.size_algorithm);
            mal_gc_mark_value(object->as.controller.byob_request);
            for (MalReadableStreamQueueEntry *entry = object->as.controller.queue_head;
                 entry != nullptr; entry = entry->next) {
                mal_gc_mark_value(entry->chunk);
            }
            break;
        case MAL_READABLE_STREAM_BYOB_REQUEST:
            mal_gc_mark_value(object->as.byob_request.controller);
            mal_gc_mark_value(object->as.byob_request.view);
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
        case MAL_WRITABLE_STREAM:
            mal_gc_mark_value(object->as.writable_stream.controller);
            mal_gc_mark_value(object->as.writable_stream.writer);
            mal_gc_mark_value(object->as.writable_stream.stored_error);
            break;
        case MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER:
            mal_gc_mark_value(object->as.writable_controller.stream);
            mal_gc_mark_value(object->as.writable_controller.underlying_sink);
            mal_gc_mark_value(object->as.writable_controller.write_method);
            mal_gc_mark_value(object->as.writable_controller.close_method);
            mal_gc_mark_value(object->as.writable_controller.abort_method);
            mal_gc_mark_value(object->as.writable_controller.size_algorithm);
            for (MalWritableStreamWriteRequest *request =
                     object->as.writable_controller.queue_head;
                 request != nullptr; request = request->next) {
                mal_gc_mark_value(request->chunk);
                mal_gc_mark_value(request->promise);
            }
            break;
        case MAL_WRITABLE_STREAM_DEFAULT_WRITER:
            mal_gc_mark_value(object->as.writer.stream);
            mal_gc_mark_value(object->as.writer.closed_promise);
            mal_gc_mark_value(object->as.writer.ready_promise);
            break;
    }
}

static void rs_finalize(MalHeapHeader *cell) {
    MalReadableStreamObject *object = (MalReadableStreamObject *) cell;
    if (object->kind == MAL_READABLE_STREAM_DEFAULT_CONTROLLER ||
        object->kind == MAL_READABLE_BYTE_STREAM_CONTROLLER) {
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
    } else if (object->kind == MAL_WRITABLE_STREAM_DEFAULT_CONTROLLER) {
        MalWritableStreamWriteRequest *request =
            object->as.writable_controller.queue_head;
        while (request != nullptr) {
            MalWritableStreamWriteRequest *next = request->next;
            mal_gc_write_barrier(request->chunk);
            mal_gc_write_barrier(request->promise);
            free(request);
            request = next;
        }
        object->as.writable_controller.queue_head = nullptr;
        object->as.writable_controller.queue_tail = nullptr;
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
    mal_intrinsic_define_method_n(
        vm, stream_proto, (const byte *) "pipeThrough", 1, rs_pipe_through);
    mal_intrinsic_define_method_n(
        vm, stream_proto, (const byte *) "pipeTo", 1, rs_pipe_to);
    mal_intrinsic_define_method_n(
        vm, stream_proto, (const byte *) "tee", 0, rs_tee);

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

    MalObject *byte_controller_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableByteStreamController", 0,
        rs_byte_controller_constructor,
        MAL_INTRINSIC_READABLE_BYTE_STREAM_CONTROLLER_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_BYTE_STREAM_CONTROLLER_PROTOTYPE);
    rs_define_getter(vm, byte_controller_proto, (const byte *) "byobRequest",
        (const byte *) "get byobRequest", rs_byte_controller_get_byob_request);
    rs_define_getter(vm, byte_controller_proto, (const byte *) "desiredSize",
        (const byte *) "get desiredSize", rs_byte_controller_get_desired_size);
    mal_intrinsic_define_method_n(vm, byte_controller_proto,
        (const byte *) "close", 0, rs_byte_controller_close);
    mal_intrinsic_define_method_n(vm, byte_controller_proto,
        (const byte *) "enqueue", 1, rs_byte_controller_enqueue);
    mal_intrinsic_define_method_n(vm, byte_controller_proto,
        (const byte *) "error", 1, rs_byte_controller_error);

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

    MalObject *byob_request_proto = rs_install_class(vm, global_this,
        (const byte *) "ReadableStreamBYOBRequest", 2,
        rs_byob_request_constructor,
        MAL_INTRINSIC_READABLE_STREAM_BYOB_REQUEST_CONSTRUCTOR,
        MAL_INTRINSIC_READABLE_STREAM_BYOB_REQUEST_PROTOTYPE);
    rs_define_getter(vm, byob_request_proto, (const byte *) "view",
        (const byte *) "get view", rs_byob_request_get_view);
    mal_intrinsic_define_method_n(vm, byob_request_proto,
        (const byte *) "respond", 1, rs_byob_request_respond);
    mal_intrinsic_define_method_n(vm, byob_request_proto,
        (const byte *) "respondWithNewView", 1,
        rs_byob_request_respond_with_new_view);

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
