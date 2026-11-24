#include "web_fetch_body.h"

#include <stdlib.h>

#include "array_object.h"
#include "builtin_data_view.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "intrinsics.h"
#include "typed_array_object.h"
#include "vm_ops.h"
#include "web_readable_stream_object.h"
#include "web_surface.h"

enum {
    MAL_FETCH_COLLECT_READER,
    MAL_FETCH_COLLECT_CHUNKS,
    MAL_FETCH_COLLECT_TOTAL,
    MAL_FETCH_COLLECT_RESOLVE,
    MAL_FETCH_COLLECT_REJECT,
    MAL_FETCH_COLLECT_SELF,
    MAL_FETCH_COLLECT_KIND,
    MAL_FETCH_COLLECT_ON_REJECTED,
    MAL_FETCH_COLLECT_SLOT_COUNT,
};

static void mal_fetch_call_settler(MalVm *vm, MalValue settler, MalValue value) {
    MalCompletion completion = mal_vm_call_value(
        vm, settler, mal_value_new_undefined(), &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
    }
}

static void mal_fetch_collect_reject_completion(
    MalVm *vm, MalNativeFunctionObject *function) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
    mal_fetch_call_settler(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_REJECT),
        error);
}

static MalValue mal_fetch_body_collect_rejected(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    mal_fetch_call_settler(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_REJECT),
        argc >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_fetch_body_collect_fulfilled(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue read_result = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalValue done;
    if (!mal_vm_get_property(vm, read_result,
            mal_intrinsic_string_key(vm, (const byte *) "done"), &done)) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }

    if (mal_value_is_truthy(done)) {
        MalValue chunks_value = mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_CHUNKS);
        MalArrayObject *chunks = mal_value_to_array_object(chunks_value);
        usize total = (usize) mal_value_to_f64(mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_TOTAL));
        byte *bytes = malloc(total == 0 ? 1 : total);
        if (bytes == nullptr) {
            mal_vm_throw_allocation_error(vm);
            mal_fetch_collect_reject_completion(vm, function);
            return mal_value_new_undefined();
        }
        usize offset = 0;
        for (u32 i = 0; i < mal_array_object_length(chunks); i++) {
            MalValue chunk;
            MalBufferSourceSpan chunk_span;
            if (!mal_array_object_dense_get(chunks, i, &chunk) ||
                mal_buffer_source_span(chunk, &chunk_span) != MAL_BUFFER_SOURCE_SPAN_OK) {
                free(bytes);
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Body stream chunk became unusable");
                mal_fetch_collect_reject_completion(vm, function);
                return mal_value_new_undefined();
            }
            mal_buffer_source_span_read(&chunk_span, 0, bytes + offset, chunk_span.length);
            offset += chunk_span.length;
        }
        MalValue body_self = mal_native_function_object_get_slot(
            function, MAL_FETCH_COLLECT_SELF);
        MalFetchBody body = {
            .owner = mal_value_to_object(body_self),
            .bytes = bytes,
            .length = total,
            .stream = nullptr,
        };
        MalFetchBodyConsumeKind kind = (MalFetchBodyConsumeKind) mal_value_to_i32(
            mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_KIND));
        MalValue result = mal_fetch_collect_conversion(vm, body_self, &body, kind);
        free(bytes);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_fetch_collect_reject_completion(vm, function);
        } else {
            mal_fetch_call_settler(vm,
                mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_RESOLVE),
                result);
        }
        return mal_value_new_undefined();
    }

    MalValue chunk;
    if (!mal_vm_get_property(vm, read_result,
            mal_intrinsic_string_key(vm, (const byte *) "value"), &chunk)) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_typed_array_object(chunk) ||
        mal_value_to_typed_array_object(chunk)->kind != MAL_TA_UINT8) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream yielded a non-Uint8Array chunk");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalBufferSourceSpan chunk_span;
    if (mal_buffer_source_span(chunk, &chunk_span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Body stream yielded an unusable Uint8Array chunk");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    usize total = (usize) mal_value_to_f64(mal_native_function_object_get_slot(
        function, MAL_FETCH_COLLECT_TOTAL));
    if (chunk_span.length > UINT32_MAX - total) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Body stream exceeds the supported size");
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    byte *owned_chunk;
    const byte *chunk_bytes = mal_buffer_source_span_private(&chunk_span, &owned_chunk);
    if (chunk_span.length > 0 && chunk_bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalValue copy = mal_fetch_new_uint8array(vm, chunk_bytes, chunk_span.length);
    free(owned_chunk);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    MalArrayObject *chunks = mal_value_to_array_object(
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_CHUNKS));
    if (!mal_array_object_store(chunks,
            mal_key_index(mal_array_object_length(chunks)), copy)) {
        mal_vm_throw_allocation_error(vm);
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(function, MAL_FETCH_COLLECT_TOTAL,
        mal_value_from_f64((f64) (total + chunk_span.length)));

    MalValue read_promise = mal_readable_stream_default_reader_read(vm,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_READER));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_fetch_collect_reject_completion(vm, function);
        return mal_value_new_undefined();
    }
    mal_promise_perform_then(vm, read_promise, callee,
        mal_native_function_object_get_slot(function, MAL_FETCH_COLLECT_ON_REJECTED),
        mal_value_new_undefined(), mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue mal_fetch_body_collect_stream(
    MalVm *vm, MalValue self, MalFetchBody *body, MalFetchBodyConsumeKind kind) {
    if (mal_readable_stream_is_locked(*body->stream)
        || mal_readable_stream_is_disturbed(*body->stream)) {
        return mal_fetch_reject_type_error(vm);
    }
    MalValue roots[8] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        self, *body->stream, mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan span;
    mal_gc_root(&span, roots, 8);
    if (!mal_promise_new_capability(vm,
            vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
            &roots[0], &roots[1], &roots[2])) {
        mal_gc_unroot(&span);
        return mal_value_new_undefined();
    }
    roots[3] = mal_readable_stream_acquire_default_reader(vm, roots[5]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        mal_fetch_call_settler(vm, roots[2], error);
        MalValue promise = roots[0];
        mal_gc_unroot(&span);
        return promise;
    }
    roots[4] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue rejected_slots[MAL_FETCH_COLLECT_SLOT_COUNT] = {
        roots[3], roots[4], mal_value_from_f64(0), roots[1], roots[2],
        self, mal_value_from_i32((i32) kind), mal_value_new_undefined(),
    };
    roots[6] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, mal_fetch_body_collect_rejected,
            rejected_slots, MAL_FETCH_COLLECT_SLOT_COUNT));
    MalValue fulfilled_slots[MAL_FETCH_COLLECT_SLOT_COUNT] = {
        roots[3], roots[4], mal_value_from_f64(0), roots[1], roots[2],
        self, mal_value_from_i32((i32) kind), roots[6],
    };
    roots[7] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            nullptr, mal_fetch_body_collect_fulfilled,
            fulfilled_slots, MAL_FETCH_COLLECT_SLOT_COUNT));
    MalValue read_promise = mal_readable_stream_default_reader_read(vm, roots[3]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        vm->completion = (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = mal_value_new_undefined(),
        };
        mal_fetch_call_settler(vm, roots[2], error);
    } else {
        mal_promise_perform_then(vm, read_promise, roots[7], roots[6],
            mal_value_new_undefined(), mal_value_new_undefined());
    }
    MalValue promise = roots[0];
    mal_gc_unroot(&span);
    return promise;
}

static const MalFetchStreamOps fetch_stream_operations = {
    .ensure = mal_web_streams_ensure,
    .from_bytes = mal_readable_stream_from_bytes,
    .from_node_body = mal_readable_stream_from_node_body,
    .consume = mal_readable_stream_consume,
    .proxy = mal_readable_stream_create_proxy,
    .tee = mal_readable_stream_tee,
    .collect = mal_fetch_body_collect_stream,
};

__attribute__((constructor))
static void register_fetch_streams(void) {
    mal_fetch_streams = &fetch_stream_operations;
}

void mal_host_install_web_fetch_streams(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    // Selection links the stream operations without publishing stream globals.
    (void) vm;
    (void) slots;
    (void) count;
    (void) launch;
}
