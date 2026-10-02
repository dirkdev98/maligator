#include "node_zlib.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include "builtin_data_view.h"
#include "vm_ops.h"
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
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

static void zlib_trace(MalHeapHeader *cell) {
    MalNodeZlibObject *state = (MalNodeZlibObject *) cell;
    mal_gc_mark_value(state->input);
    mal_gc_mark_value(state->callback);
}

static void zlib_store(MalNodeZlibObject *state, MalValue *slot, MalValue value) {
    mal_gc_write_barrier(*slot);
    *slot = value;
    mal_gc_card(&state->object.header, value);
}

static MalNodeZlibObject *zlib_state_from_callee(MalValue callee) {
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue value = mal_native_function_object_get_slot(function, 0);
    return (MalNodeZlibObject *) mal_value_to_heap(value);
}

static void zlib_throw_code(MalVm *vm, const char *message, const char *code) {
    mal_vm_throw_error(vm, strcmp(code, "ERR_BUFFER_TOO_LARGE") == 0
        ? MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE : MAL_INTRINSIC_ERROR_PROTOTYPE, message);
    MalValue error = vm->completion.value;
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    mal_object_set(mal_value_to_object(error), zlib_key(vm, "code"),
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) code)));
    vm->completion.value = error;
    mal_gc_unroot(&root);
}

static void zlib_throw_status(MalVm *vm, i32 status) {
    zlib_throw_code(vm, status == MAL_ZLIB_STATUS_TRUNCATED
        ? "unexpected end of compressed data" : "invalid compressed data",
        status == MAL_ZLIB_STATUS_TRUNCATED ? "Z_BUF_ERROR"
        : status == MAL_ZLIB_STATUS_DATA_ERROR ? "Z_DATA_ERROR" : "Z_STREAM_ERROR");
}

static MalValue zlib_state_value(MalValue callee) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
}

static MalValue zlib_get(MalVm *vm, MalValue value, const char *name) {
    MalValue out = mal_value_new_undefined();
    mal_vm_get_property(vm, value, zlib_key(vm, name), &out);
    return out;
}

static void zlib_set(MalVm *vm, MalValue value, const char *name, MalValue item) {
    mal_object_set(mal_value_to_object(value), zlib_key(vm, name), item);
}

static void zlib_complete(MalVm *vm, MalValue state_value, MalValue error) {
    MalNodeZlibObject *state = (MalNodeZlibObject *) mal_value_to_heap(state_value);
    MalValue roots[] = {state_value, state->callback, error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    zlib_store(state, &state->input, mal_value_new_undefined());
    zlib_store(state, &state->callback, mal_value_new_undefined());
    if (mal_value_is_callable(roots[1])) mal_vm_call_value(vm, roots[1],
        mal_value_new_undefined(), mal_value_is_nil(error) ? nullptr : roots + 2,
        mal_value_is_nil(error) ? 0 : 1);
    mal_gc_unroot(&root);
}

static void zlib_stream_pump(MalVm *vm, MalValue state_value, MalValue receiver) {
    MalNodeZlibObject *state = (MalNodeZlibObject *) mal_value_to_heap(state_value);
    MalValue roots[] = {state_value, receiver, state->input, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (state->pumping || state->handle == nullptr || !mal_value_is_callable(state->callback)) goto finished;
    state->pumping = true;
    while (state->handle != nullptr && vm->completion.kind != MAL_COMPLETION_THROW) {
        i32 capacity = mal_node_stream_readable_capacity(vm, receiver);
        if (capacity <= 0) break;
        usize size = (usize) capacity < state->chunk_size ? (usize) capacity : state->chunk_size;
        byte *output = malloc(size);
        if (output == nullptr) { zlib_throw_code(vm, "decompression allocation failed", "ERR_BUFFER_TOO_LARGE"); break; }
        MalBufferSourceSpan span = {0};
        if (!state->finishing && (mal_buffer_source_span(roots[2], &span) != MAL_BUFFER_SOURCE_SPAN_OK || state->input_offset > span.length)) {
            free(output); zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT); break;
        }
        usize consumed = 0, produced = 0;
        i32 status = mal_zlib_pump(state->handle,
            (const uint8_t *)(span.data == nullptr ? nullptr : span.data + state->input_offset),
            span.length - state->input_offset, (uint8_t *)output, size, &consumed, &produced);
        state->input_offset += consumed;
        if (produced > 0) {
            roots[3] = mal_node_buffer_from_owned_bytes(vm, output, produced);
            mal_node_stream_push_chunk(vm, receiver, roots[3]);
        } else free(output);
        if (state->handle == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (status < 0) { zlib_throw_status(vm, status); break; }
        if (status != MAL_ZLIB_STATUS_NEED_OUTPUT && state->input_offset == span.length) {
            if (state->finishing) {
                status = mal_zlib_finish(state->handle);
                mal_zlib_free(&state->handle);
                if (status != MAL_ZLIB_STATUS_STREAM_END) { zlib_throw_status(vm, status); break; }
            }
            state->pumping = false;
            zlib_complete(vm, state_value, mal_value_new_undefined());
            goto finished;
        }
        if (consumed == 0 && produced == 0) { zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT); break; }
    }
    state->pumping = false;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[3] = vm->completion.value;
        vm->completion = (MalCompletion){.kind=MAL_COMPLETION_NORMAL,.value=mal_value_new_undefined()};
        mal_zlib_free(&state->handle);
        zlib_complete(vm, state_value, roots[3]);
    }
finished:
    mal_gc_unroot(&root);
}

static MalValue zlib_transform(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state_value = zlib_state_value(callee);
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    state->input_offset = 0;
    zlib_store(state, &state->input, argc > 0 ? args[0] : mal_value_new_undefined());
    zlib_store(state, &state->callback, argc > 2 ? args[2] : mal_value_new_undefined());
    zlib_stream_pump(vm, state_value, receiver);
    return mal_value_new_undefined();
}

static MalValue zlib_read(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    zlib_stream_pump(vm, zlib_state_value(callee), receiver);
    zlib_set(vm, receiver, "_malReading", mal_value_new_boolean(false));
    zlib_set(vm, zlib_get(vm, receiver, "_readableState"), "reading", mal_value_new_boolean(false));
    return mal_value_new_undefined();
}

static MalValue zlib_flush(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state_value = zlib_state_value(callee);
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    state->finishing = true;
    state->input_offset = 0;
    zlib_store(state, &state->callback, argc > 0 ? args[0] : mal_value_new_undefined());
    zlib_stream_pump(vm, state_value, receiver);
    return mal_value_new_undefined();
}

static MalValue zlib_destroy(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue roots[] = {receiver, zlib_state_value(callee),
        zlib_get(vm, receiver, "_malPipeSources"), mal_value_new_undefined(),
        mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    mal_zlib_free(&state->handle);
    zlib_store(state, &state->input, mal_value_new_undefined());
    zlib_store(state, &state->callback, mal_value_new_undefined());
    if (mal_value_is_array_object(roots[2])) {
        MalArrayObject *array = mal_value_to_array_object(roots[2]);
        for (u32 i=0;i<mal_array_object_length(array);i++) {
            if (mal_vm_get_property(vm, roots[2], mal_key_index(i), roots+3)
                && mal_vm_get_property(vm, roots[3], zlib_key(vm,"destroy"), roots+4))
                mal_vm_call_value(vm, roots[4], roots[3], nullptr, 0);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_callable(roots[5]))
        mal_vm_call_value(vm, roots[5], mal_value_new_undefined(), roots+6, 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool zlib_option_size(MalVm *vm, MalValue options, const char *name, usize fallback, usize minimum, usize *out) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(options) && !mal_vm_get_property(vm, options, zlib_key(vm,name), &value)) return false;
    if (mal_value_is_undefined(value)) { *out=fallback; return true; }
    if (!mal_ops_is_number(value)) { mal_vm_throw_error(vm,MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,"zlib size option must be a number"); return false; }
    f64 number=mal_ops_number_as_f64(value);
    if (!isfinite(number) || floor(number)!=number || number<(f64)minimum || number>INT32_MAX) {
        mal_vm_throw_error(vm,MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,"zlib size option is out of range"); return false;
    }
    *out=(usize)number; return true;
}

static MalValue zlib_gunzip_sync(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    MalBufferSourceSpan span;
    if (argc==0 || mal_buffer_source_span(args[0], &span)!=MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm,MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,"gunzipSync input must be a BufferSource"); return mal_value_new_undefined();
    }
    usize maximum;
    if (!zlib_option_size(vm,argc>1?args[1]:mal_value_new_undefined(),"maxOutputLength",INT32_MAX,1,&maximum)) return mal_value_new_undefined();
    if (mal_buffer_source_span(args[0], &span)!=MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm,MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,"gunzipSync input became detached or out of bounds"); return mal_value_new_undefined();
    }
    MalZlibStream *handle=nullptr;
    mal_zlib_create(MAL_ZLIB_FORMAT_GZIP,&handle);
    usize capacity=maximum<ZLIB_OUTPUT_CHUNK?maximum:ZLIB_OUTPUT_CHUNK, length=0, offset=0;
    byte *output=malloc(capacity);
    if(output==nullptr) { mal_zlib_free(&handle); zlib_throw_code(vm,"decompression allocation failed","ERR_BUFFER_TOO_LARGE"); return mal_value_new_undefined(); }
    while(true) {
        byte probe;
        if(length==capacity && capacity<maximum) {
            usize next=capacity>maximum/2?maximum:capacity*2;
            byte *grown=realloc(output,next);
            if(grown==nullptr) { zlib_throw_code(vm,"decompression allocation failed","ERR_BUFFER_TOO_LARGE"); break; }
            output=grown; capacity=next;
        }
        usize consumed=0,produced=0;
        i32 status=mal_zlib_pump(handle,(const uint8_t *)(span.data==nullptr?nullptr:span.data+offset),span.length-offset,
            (uint8_t *)(length==maximum?&probe:output+length),length==maximum?1:capacity-length,&consumed,&produced);
        offset+=consumed;
        if(length==maximum && produced>0) { zlib_throw_code(vm,"Cannot create a Buffer larger than maxOutputLength","ERR_BUFFER_TOO_LARGE"); break; }
        length+=produced;
        if(status<0) { zlib_throw_status(vm,status); break; }
        if(status!=MAL_ZLIB_STATUS_NEED_OUTPUT && offset==span.length) {
            status=mal_zlib_finish(handle);
            if(status!=MAL_ZLIB_STATUS_STREAM_END) zlib_throw_status(vm,status);
            break;
        }
        if(consumed==0 && produced==0) { zlib_throw_status(vm,MAL_ZLIB_STATUS_INVALID_ARGUMENT); break; }
    }
    mal_zlib_free(&handle);
    if(vm->completion.kind==MAL_COMPLETION_THROW) {free(output); return mal_value_new_undefined();}
    return mal_node_buffer_from_owned_bytes(vm,output,length);
}

static MalValue zlib_create_transform(MalVm *vm, u32 format, MalValue options) {
    mal_host_install_node_stream(vm, nullptr, 0, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    usize chunk_size, high_water_mark;
    if (!zlib_option_size(vm, options, "chunkSize", ZLIB_OUTPUT_CHUNK, 64, &chunk_size)
        || !zlib_option_size(vm, options, "readableHighWaterMark", ZLIB_OUTPUT_CHUNK, 1, &high_water_mark)) return mal_value_new_undefined();
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
    state->input = mal_value_new_undefined();
    state->callback = mal_value_new_undefined();
    state->chunk_size = chunk_size;
    state->input_offset = 0;
    state->finishing = false;
    state->pumping = false;
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
    zlib_set(vm, roots[1], "highWaterMark", mal_value_from_i32((i32) high_water_mark));
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm,"zlibRead"), zlib_read, roots, 1));
    zlib_set(vm, roots[1], "read", roots[2]);
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm,"zlibDestroy"), zlib_destroy, roots, 1));
    zlib_set(vm, roots[1], "destroy", roots[3]);
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
        return zlib_create_transform(vm, format, argc > 0 ? args[0] : mal_value_new_undefined());                              \
    }

ZLIB_FACTORY(zlib_create_inflate, MAL_ZLIB_FORMAT_ZLIB)
ZLIB_FACTORY(zlib_create_gunzip, MAL_ZLIB_FORMAT_GZIP)
ZLIB_FACTORY(zlib_create_brotli_decompress, MAL_ZLIB_FORMAT_BROTLI)

static MalValue zlib_create_gzip_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Gzip compression is not supported by this host");
    return mal_value_new_undefined();
}

static MalValue zlib_deflate_unavailable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
        "Deflate compression is not supported by this host");
    return mal_value_new_undefined();
}

static void zlib_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    mal_node_module_publish(vm, "node:zlib", slots, count, module);
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
    mal_gc_register_tracer(MAL_HEAP_NODE_ZLIB_OBJECT, zlib_trace);
    MalValue roots[3] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
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
        {"gunzipSync", zlib_gunzip_sync},
        {"createBrotliDecompress", zlib_create_brotli_decompress},
		{"createGzip", zlib_create_gzip_unavailable},
		{"deflate", zlib_deflate_unavailable},
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

    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const struct {
        const char *name;
        i32 value;
    } constants[] = {
        {"Z_SYNC_FLUSH", 2},
        {"BROTLI_OPERATION_FLUSH", 1},
        {"ZSTD_e_flush", 1},
    };
    for (usize i = 0; i < countof(constants); i++) {
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[2]), (const byte *) constants[i].name,
            mal_value_from_f64((f64) constants[i].value), MAL_PROPERTY_ENUMERABLE);
    }
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "constants", roots[2],
        ZLIB_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_ZLIB_MODULE] = roots[0];
    zlib_install_exports(vm, slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
