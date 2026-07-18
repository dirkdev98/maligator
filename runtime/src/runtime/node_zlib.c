#include "node_zlib.h"

#if MAL_NODE

#include <limits.h>
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "mal_zlib.h"
#include "node_buffer.h"
#include "node_stream.h"
#include "node_zlib_object.h"
#include "object.h"
#include "property_store.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_ops.h"

#define ZLIB_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define ZLIB_OUTPUT_CHUNK 16384u

static MalKey zlib_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static void zlib_finalize(MalHeapHeader *cell) {
    MalNodeZlibObject *state = (MalNodeZlibObject *) cell;
    mal_zlib_free(&state->handle);
}

static MalNodeZlibObject *zlib_state_from_callee(MalValue callee) {
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue value = mal_native_function_object_get_slot(function, 0);
    return (MalNodeZlibObject *) mal_value_to_heap(value);
}

static void zlib_throw_status(MalVm *vm, i32 status) {
    const char *message = status == MAL_ZLIB_STATUS_TRUNCATED
        ? "unexpected end of compressed data"
        : status == MAL_ZLIB_STATUS_DATA_ERROR
            ? "invalid compressed data"
            : "decompression failed";
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
}

static bool zlib_reserve(MalVm *vm, byte **bytes, usize *capacity, usize length) {
    if (*capacity - length >= ZLIB_OUTPUT_CHUNK) return true;
    if (length > INT32_MAX - ZLIB_OUTPUT_CHUNK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "decompressed data is too large");
        return false;
    }
    usize next = length + ZLIB_OUTPUT_CHUNK;
    byte *grown = realloc(*bytes, next);
    if (grown == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "decompression allocation failed");
        return false;
    }
    *bytes = grown;
    *capacity = next;
    return true;
}

static bool zlib_pump_all(
    MalVm *vm, MalNodeZlibObject *state, const byte *input, usize input_length,
    byte **output, usize *output_length) {
    usize capacity = 0;
    usize consumed_total = 0;
    *output = nullptr;
    *output_length = 0;
    while (true) {
        if (!zlib_reserve(vm, output, &capacity, *output_length)) {
            free(*output);
            *output = nullptr;
            *output_length = 0;
            return false;
        }
        usize consumed = 0;
        usize produced = 0;
        i32 status = mal_zlib_pump(
            state->handle,
            input == nullptr ? nullptr : input + consumed_total,
            input_length - consumed_total,
            *output + *output_length, capacity - *output_length,
            &consumed, &produced);
        consumed_total += consumed;
        *output_length += produced;
        if (status < 0) {
            free(*output);
            *output = nullptr;
            *output_length = 0;
            mal_zlib_free(&state->handle);
            zlib_throw_status(vm, status);
            return false;
        }
        if (status == MAL_ZLIB_STATUS_STREAM_END) return true;
        if (status == MAL_ZLIB_STATUS_NEED_OUTPUT || consumed_total < input_length) {
            if (consumed == 0 && produced == 0) {
                free(*output);
                *output = nullptr;
                *output_length = 0;
                mal_zlib_free(&state->handle);
                zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT);
                return false;
            }
            continue;
        }
        return true;
    }
}

static MalValue zlib_call_done(
    MalVm *vm, MalValue callback, byte *bytes, usize length) {
    if (length == 0) {
        free(bytes);
        return mal_vm_call_value(
            vm, callback, mal_value_new_undefined(), nullptr, 0).value;
    }
    MalValue roots[] = {
        callback, mal_value_new_null(),
        mal_node_buffer_from_owned_bytes(vm, bytes, length),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        result = mal_vm_call_value(
            vm, roots[0], mal_value_new_undefined(), roots + 1, 2).value;
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue zlib_transform(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_value_is_typed_array_object(chunk)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "zlib input must be a Buffer or Uint8Array");
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *view = mal_value_to_typed_array_object(chunk);
    if (view->kind != MAL_TA_UINT8 || mal_typed_array_object_is_out_of_bounds(view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "zlib input must be a Buffer or Uint8Array");
        return mal_value_new_undefined();
    }
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    if (state->handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                           "zlib stream is already closed");
        return mal_value_new_undefined();
    }
    byte *bytes;
    usize length;
    const byte *input = view->buffer->data == nullptr
        ? nullptr
        : view->buffer->data + view->byte_offset;
    if (!zlib_pump_all(vm, state, input, mal_typed_array_object_byte_length(view),
                       &bytes, &length)) {
        return mal_value_new_undefined();
    }
    return zlib_call_done(vm, callback, bytes, length);
}

static MalValue zlib_flush(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    if (state->handle == nullptr) {
        return mal_vm_call_value(
            vm, callback, mal_value_new_undefined(), nullptr, 0).value;
    }
    byte *bytes;
    usize length;
    if (!zlib_pump_all(vm, state, nullptr, 0, &bytes, &length)) {
        return mal_value_new_undefined();
    }
    i32 status = mal_zlib_finish(state->handle);
    mal_zlib_free(&state->handle);
    if (status != MAL_ZLIB_STATUS_STREAM_END) {
        free(bytes);
        zlib_throw_status(vm, status);
        return mal_value_new_undefined();
    }
    return zlib_call_done(vm, callback, bytes, length);
}

static MalValue zlib_create_transform(MalVm *vm, u32 format) {
    mal_host_install_node_stream(vm, nullptr, 0, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalZlibStream *handle = nullptr;
    if (mal_zlib_create(format, &handle) != MAL_ZLIB_STATUS_NEED_INPUT) {
        zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT);
        return mal_value_new_undefined();
    }

    MalValue roots[4] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeZlibObject *state = mal_heap_alloc(
        &vm->heap, sizeof(MalNodeZlibObject), MAL_HEAP_NODE_ZLIB_OBJECT);
    mal_object_init(
        &vm->heap, &state->object, MAL_HEAP_NODE_ZLIB_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    state->handle = handle;
    roots[0] = mal_value_from_heap((MalHeapHeader *) state);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "zlibTransform"),
            zlib_transform, roots, 1));
    roots[3] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "zlibFlush"),
            zlib_flush, roots, 1));
    mal_object_set(mal_value_to_object(roots[1]), zlib_key(vm, "transform"), roots[2]);
    mal_object_set(mal_value_to_object(roots[1]), zlib_key(vm, "flush"), roots[3]);
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR], roots + 1, 1);
    MalValue result = completion.value;
    mal_gc_unroot(&root);
    return result;
}

#define ZLIB_FACTORY(name, format)                                             \
    static MalValue name(                                                     \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,          \
        MalValue new_target, MalValue callee) {                                \
        (void) receiver; (void) args; (void) argc;                             \
        (void) new_target; (void) callee;                                      \
        return zlib_create_transform(vm, format);                              \
    }

ZLIB_FACTORY(zlib_create_inflate, MAL_ZLIB_FORMAT_ZLIB)
ZLIB_FACTORY(zlib_create_gunzip, MAL_ZLIB_FORMAT_GZIP)
ZLIB_FACTORY(zlib_create_brotli_decompress, MAL_ZLIB_FORMAT_BROTLI)

static void zlib_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalPropertyLookup lookup = mal_object_get_own(
            mal_value_to_object(module), zlib_key(vm, slots[i].name));
        if (lookup.present) vm->globals[slots[i].slot] = lookup.desc.value;
    }
}

void mal_host_install_node_zlib(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_ZLIB_MODULE];
    if (!mal_value_is_undefined(cached)) {
        zlib_install_exports(vm, slots, count, cached);
        return;
    }
    mal_gc_register_finalizer(MAL_HEAP_NODE_ZLIB_OBJECT, zlib_finalize);
    MalValue roots[2] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
    } factories[] = {
        {"createInflate", zlib_create_inflate},
        {"createGunzip", zlib_create_gunzip},
        {"createBrotliDecompress", zlib_create_brotli_decompress},
    };
    for (usize i = 0; i < countof(factories); i++) {
        roots[1] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) factories[i].name), 0,
                factories[i].callback));
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[0]), (const byte *) factories[i].name,
            roots[1], ZLIB_VISIBLE);
    }
    vm->intrinsics[MAL_INTRINSIC_NODE_ZLIB_MODULE] = roots[0];
    zlib_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
