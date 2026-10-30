// Portions derived from Node.js lib/internal/streams/compose.js, lib/internal/streams/duplex.js, lib/internal/streams/duplexify.js, lib/internal/streams/from.js, lib/internal/streams/pipeline.js, lib/internal/streams/readable.js, lib/internal/streams/utils.js, lib/internal/streams/writable.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_stream.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "array_object.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_buffer.h"
#include "node_events.h"
#include "node_module.h"
#include "node_string_decoder.h"
#include "ascii.h"
#include "web_events_object.h"
#include "utf8.h"
#include "web_readable_stream_object.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "property_iter.h"
#include "property_store.h"
#include "text_buffer.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_ops.h"

#define STREAM_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define STREAM_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

static MalKey stream_static_key(MalVm *vm, const char *name) {
    return mal_intrinsic_static_string_key(vm, (const byte *) name);
}

static MalValue stream_own(MalVm *vm, MalValue object, const char *name) {
    if (!mal_value_is_object(object)) {
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup =
        mal_object_get_own_static(vm, mal_value_to_object(object), (const byte *) name);
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void stream_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_object_set(mal_value_to_object(object), stream_static_key(vm, name), value);
}

static bool stream_truthy_own(MalVm *vm, MalValue object, const char *name) {
    MalValue value = stream_own(vm, object, name);
    return mal_value_is_boolean(value) && mal_value_to_boolean(value);
}

static MalValue stream_array_at(MalArrayObject *array, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_array_object_dense_get(array, index, &value);
    return value;
}

static MalValue stream_new_array(MalVm *vm) {
    return mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
}

static bool stream_get(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    return mal_vm_get_static(vm, object, (const byte *) name, out);
}

// Readable decoding goes through a real node:string_decoder StringDecoder, as in Node.
static MalValue stream_new_decoder(MalVm *vm, MalValue encoding) {
    MalValue roots[2] = {encoding, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue result = mal_value_new_undefined();
    mal_host_install_node_string_decoder(vm, nullptr, 0, nullptr);
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && stream_get(vm, mal_node_module_get_cached(vm, "node:string_decoder"), "StringDecoder", &roots[1])
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalCompletion decoder = mal_vm_construct_value(vm, roots[1], roots, 1);
        if (decoder.kind != MAL_COMPLETION_THROW) result = decoder.value;
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_decoder_call(MalVm *vm, MalValue decoder, const char *method, MalValue chunk) {
    MalValue roots[2] = {decoder, chunk};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue function = mal_value_new_undefined();
    MalValue result = mal_value_new_undefined();
    if (stream_get(vm, roots[0], method, &function) && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalCompletion completion = mal_vm_call_value(
            vm, function, roots[0], roots + 1, mal_value_is_undefined(chunk) ? 0 : 1);
        if (completion.kind != MAL_COMPLETION_THROW) result = completion.value;
    }
    mal_gc_unroot(&root);
    return result;
}

static MalCompletion stream_call_method(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[] = {receiver, mal_value_new_undefined(), mal_value_new_undefined(),
                        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 2; i++) {
        roots[2 + i] = args[i];
    }
    if (!stream_get(vm, roots[0], name, &roots[1])) {
        MalCompletion completion = vm->completion;
        mal_gc_unroot(&root);
        return completion;
    }
    MalCompletion completion = mal_vm_call_value(
        vm, roots[1], roots[0], argc > 0 ? roots + 2 : nullptr, argc);
    mal_gc_unroot(&root);
    return completion;
}

static bool stream_emit(
    MalVm *vm, MalValue receiver, const char *name, const MalValue *args, i32 argc) {
    MalValue roots[4] = {
        receiver,
        stream_static_key(vm, name).value,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (i32 i = 0; i < argc && i < 2; i++) {
        roots[2 + i] = args[i];
    }
    MalCompletion completion =
        stream_call_method(vm, roots[0], "emit", roots + 1, argc + 1);
    bool emitted = completion.kind != MAL_COMPLETION_THROW
        && mal_value_is_boolean(completion.value)
        && mal_value_to_boolean(completion.value);
    mal_gc_unroot(&root);
    return emitted;
}

static void stream_init_events(MalVm *vm, MalValue receiver) {
    MalValue events = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &events, 1);
    stream_set(vm, receiver, "_events", events);
    stream_set(vm, receiver, "_eventsCount", mal_value_from_i32(0));
    stream_set(vm, receiver, "_maxListeners", mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static MalValue stream_option(MalVm *vm, MalValue options, const char *name) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(options)) {
        stream_get(vm, options, name, &value);
    }
    return value;
}

static f64 stream_default_high_water_mark(MalVm *vm, bool object_mode);

/* Node's ReadableState/WritableState: a Duplex also takes readableObjectMode/writableObjectMode. */
static void stream_init_readable(MalVm *vm, MalValue receiver, MalValue options, bool duplex) {
    MalValue roots[] = {
        receiver, options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = stream_new_array(vm);
    roots[5] = stream_new_array(vm);
    roots[6] = stream_option(vm, roots[1], "encoding");
    bool object_mode = mal_value_is_truthy(stream_option(vm, roots[1], "objectMode"))
        || (duplex && mal_value_is_truthy(stream_option(vm, roots[1], "readableObjectMode")));
    f64 high_water_mark = stream_default_high_water_mark(vm, object_mode);
    MalValue option_hwm = stream_option(vm, roots[1], "highWaterMark");
    if (mal_ops_is_number(option_hwm)) {
        f64 number = mal_ops_number_as_f64(option_hwm);
        if (isfinite(number) && number >= 0) high_water_mark = floor(number);
    }
    if (high_water_mark > INT32_MAX) high_water_mark = INT32_MAX;
    roots[4] = mal_value_new_null();
    roots[7] = mal_value_new_null();
    if (mal_value_is_string(roots[6])) {
        roots[4] = stream_new_decoder(vm, roots[6]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return;
        }
        roots[7] = stream_own(vm, roots[4], "encoding");
        if (!mal_value_is_string(roots[7])) roots[7] = roots[6];
    }
    stream_set(vm, roots[2], "encoding", roots[7]);
    stream_set(vm, roots[2], "decoder", roots[4]);
    stream_set(vm, roots[2], "ended", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "endEmitted", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "destroyed", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "objectMode", mal_value_new_boolean(object_mode));
    stream_set(vm, roots[2], "highWaterMark",
               mal_value_from_i32((i32) high_water_mark));
    stream_set(vm, roots[2], "reading", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "length", mal_value_from_i32(0));
    stream_set(vm, roots[0], "_readableState", roots[2]);
    stream_set(vm, roots[0], "_malReadableQueue", roots[3]);
    stream_set(vm, roots[0], "_malBlockedPipes", roots[5]);
    stream_set(vm, roots[0], "_malReadableIndex", mal_value_from_i32(0));
    stream_set(vm, roots[0], "_malFlowing", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malPaused", mal_value_new_boolean(true));
    stream_set(vm, roots[0], "_malReading", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malReadScheduled", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "readable", mal_value_new_boolean(true));
    stream_set(vm, roots[0], "readableEnded", mal_value_new_boolean(false));
    mal_gc_unroot(&root);
}

static void stream_init_writable(MalVm *vm, MalValue receiver, MalValue options, bool duplex) {
    MalValue roots[] = {
        receiver, options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = stream_new_array(vm);
    roots[4] = stream_new_array(vm);
    bool object_mode = mal_value_is_truthy(stream_option(vm, roots[1], "objectMode"))
        || (duplex && mal_value_is_truthy(stream_option(vm, roots[1], "writableObjectMode")));
    MalValue decode_strings = stream_option(vm, roots[1], "decodeStrings");
    bool should_decode_strings = !mal_value_is_boolean(decode_strings)
        || mal_value_to_boolean(decode_strings);
    f64 high_water_mark = stream_default_high_water_mark(vm, object_mode);
    MalValue option_hwm = stream_option(vm, roots[1], "highWaterMark");
    if (mal_ops_is_number(option_hwm)) {
        f64 number = mal_ops_number_as_f64(option_hwm);
        if (isfinite(number) && number >= 0) {
            high_water_mark = floor(number);
        }
    }
    if (high_water_mark > INT32_MAX) {
        high_water_mark = INT32_MAX;
    }
    stream_set(vm, roots[2], "ended", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "finished", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "destroyed", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "objectMode", mal_value_new_boolean(object_mode));
    stream_set(vm, roots[2], "decodeStrings",
               mal_value_new_boolean(should_decode_strings));
    stream_set(vm, roots[2], "highWaterMark", mal_value_from_i32((i32) high_water_mark));
    stream_set(vm, roots[2], "length", mal_value_from_i32(0));
    stream_set(vm, roots[2], "needDrain", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_writableState", roots[2]);
    stream_set(vm, roots[0], "_malWriteQueue", roots[3]);
    stream_set(vm, roots[0], "_malEndCallbacks", roots[4]);
    stream_set(vm, roots[0], "_malWriteIndex", mal_value_from_i32(0));
    stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malEnding", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malFinalStarted", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malFlushStarted", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malFinishScheduled", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malEndScheduled", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "_malBufferedLength", mal_value_from_i32(0));
    stream_set(vm, roots[0], "_malNeedDrain", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "writable", mal_value_new_boolean(true));
    stream_set(vm, roots[0], "writableEnded", mal_value_new_boolean(false));
    stream_set(vm, roots[0], "writableFinished", mal_value_new_boolean(false));
    mal_gc_unroot(&root);
}

static void stream_install_option_hook(
    MalVm *vm, MalValue receiver, MalValue options,
    const char *option_name, const char *method_name) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {receiver, options, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = stream_option(vm, roots[1], option_name);
    if (vm->completion.kind != MAL_COMPLETION_THROW
        && mal_value_is_callable(roots[2])) {
        stream_set(vm, roots[0], method_name, roots[2]);
    }
    mal_gc_unroot(&root);
}

static void stream_init_kind(
    MalVm *vm, MalValue receiver, MalValue options, i32 kind) {
    stream_init_events(vm, receiver);
    stream_set(vm, receiver, "destroyed", mal_value_new_boolean(false));
    stream_set(vm, receiver, "_malStreamKind", mal_value_from_i32(kind));
    // Node's autoDestroy defaults to true; only the opt-out is recorded.
    MalValue auto_destroy = mal_value_is_object(options) ? stream_option(vm, options, "autoDestroy") : mal_value_new_undefined();
    if (mal_value_is_boolean(auto_destroy) && !mal_value_to_boolean(auto_destroy)) {
        stream_set(vm, receiver, "_malNoAutoDestroy", mal_value_new_boolean(true));
    }
    if (kind == STREAM_READABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_init_readable(vm, receiver, options, kind != STREAM_READABLE);
    }
    if (kind == STREAM_WRITABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_init_writable(vm, receiver, options, kind != STREAM_WRITABLE);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    if (kind == STREAM_READABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_install_option_hook(vm, receiver, options, "read", "_read");
    }
    if (kind == STREAM_WRITABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_install_option_hook(vm, receiver, options, "write", "_write");
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_install_option_hook(vm, receiver, options, "final", "_final");
        }
    }
    if (kind == STREAM_TRANSFORM && vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_install_option_hook(vm, receiver, options, "transform", "_transform");
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_install_option_hook(vm, receiver, options, "flush", "_flush");
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_install_option_hook(vm, receiver, options, "destroy", "_destroy");
    }
    // lib/internal/streams/duplex.js: readable/writable false start that side already done.
    if (kind == STREAM_DUPLEX && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalValue roots[] = {receiver, options, mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        roots[2] = stream_option(vm, roots[1], "readable");
        if (mal_value_is_boolean(roots[2]) && !mal_value_to_boolean(roots[2])) {
            MalValue state = stream_own(vm, roots[0], "_readableState");
            stream_set(vm, roots[0], "readable", mal_value_new_boolean(false));
            stream_set(vm, roots[0], "readableEnded", mal_value_new_boolean(true));
            if (mal_value_is_object(state)) {
                stream_set(vm, state, "ended", mal_value_new_boolean(true));
                stream_set(vm, state, "endEmitted", mal_value_new_boolean(true));
            }
        }
        roots[2] = stream_option(vm, roots[1], "writable");
        if (mal_value_is_boolean(roots[2]) && !mal_value_to_boolean(roots[2])) {
            MalValue state = stream_own(vm, roots[0], "_writableState");
            stream_set(vm, roots[0], "writable", mal_value_new_boolean(false));
            stream_set(vm, roots[0], "writableEnded", mal_value_new_boolean(true));
            stream_set(vm, roots[0], "writableFinished", mal_value_new_boolean(true));
            if (mal_value_is_object(state)) {
                stream_set(vm, state, "ended", mal_value_new_boolean(true));
                stream_set(vm, state, "finished", mal_value_new_boolean(true));
            }
        }
        mal_gc_unroot(&root);
    }
}

static MalValue stream_construct(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee, i32 kind) {
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(new_target) && mal_value_is_object(receiver)) {
        stream_init_kind(vm, receiver, options, kind);
        return mal_value_new_undefined();
    }

    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalValue prototype_value = mal_vm_function_prototype(vm, target);
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalValue roots[] = {instance, options};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_init_kind(vm, roots[0], roots[1], kind);
    mal_gc_unroot(&root);
    return instance;
}

#define STREAM_CONSTRUCTOR(name, kind)                                             \
    static MalValue name(                                                          \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,               \
        MalValue new_target, MalValue callee) {                                     \
        return stream_construct(vm, receiver, args, argc, new_target, callee, kind); \
    }

STREAM_CONSTRUCTOR(stream_legacy_constructor, STREAM_LEGACY)
STREAM_CONSTRUCTOR(stream_readable_constructor, STREAM_READABLE)
STREAM_CONSTRUCTOR(stream_writable_constructor, STREAM_WRITABLE)
STREAM_CONSTRUCTOR(stream_duplex_constructor, STREAM_DUPLEX)
STREAM_CONSTRUCTOR(stream_transform_constructor, STREAM_TRANSFORM)
STREAM_CONSTRUCTOR(stream_pass_through_constructor, STREAM_TRANSFORM)

static MalValue stream_pass_through_transform(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {
        argc > 2 ? args[2] : mal_value_new_undefined(),
        mal_value_new_null(),
        argc > 0 ? args[0] : mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_vm_call_value(
        vm, roots[0], mal_value_new_undefined(), roots + 1, 2).value;
    mal_gc_unroot(&root);
    return result;
}

static bool stream_is_readable(MalVm *vm, MalValue receiver) {
    return mal_value_is_object(receiver)
        && mal_value_is_object(stream_own(vm, receiver, "_readableState"));
}

static bool stream_is_writable(MalVm *vm, MalValue receiver) {
    return mal_value_is_object(receiver)
        && mal_value_is_object(stream_own(vm, receiver, "_writableState"));
}

static void stream_require_readable(MalVm *vm, MalValue receiver) {
    if (!stream_is_readable(vm, receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Readable method called on incompatible receiver");
    }
}

static void stream_require_writable(MalVm *vm, MalValue receiver) {
    if (!stream_is_writable(vm, receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Writable method called on incompatible receiver");
    }
}

static void stream_readable_drain(MalVm *vm, MalValue receiver);
static void stream_iterator_drain(MalVm *vm, MalValue receiver);
static bool stream_iterator_demand(MalVm *vm, MalValue receiver);
static i32 stream_readable_bytes(MalVm *vm, MalValue receiver, MalValue chunk);
static void stream_schedule_pull(MalVm *vm, MalValue receiver);
static i32 stream_i32_own(MalVm *vm, MalValue receiver, const char *name, i32 fallback);
static void stream_emit_readable(MalVm *vm, MalValue receiver);
static void stream_emit_readable_now(MalVm *vm, MalValue receiver);
static void stream_maybe_read_more(MalVm *vm, MalValue receiver);
static void stream_finish_if_ready(MalVm *vm, MalValue receiver);
static void stream_process_writes(MalVm *vm, MalValue receiver);
static MalValue stream_run_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee);

enum {
    STREAM_TASK_WRITE_DONE,
    STREAM_TASK_FINISH,
    STREAM_TASK_END_READABLE,
    STREAM_TASK_PULL,
    STREAM_TASK_EMIT_READABLE,
    STREAM_TASK_READ_MORE,
    STREAM_TASK_READ_ZERO,
};

static void stream_enqueue_task(
    MalVm *vm, i32 action, MalValue receiver, MalValue callback,
    MalValue error, MalValue data, i32 mode, i32 chunk_size) {
    MalValue roots[] = {
        mal_value_from_i32(action), receiver, callback, error, data,
        mal_value_from_i32(mode), mal_value_from_i32(chunk_size),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[7] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "streamTask"),
            stream_run_task, roots, 7));
    mal_vm_enqueue_reaction_job(
        vm, roots[7], false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static void stream_schedule_readable_end(MalVm *vm, MalValue receiver) {
    if (stream_truthy_own(vm, receiver, "_malEndScheduled")
        || stream_truthy_own(vm, receiver, "readableEnded")) {
        return;
    }
    stream_set(vm, receiver, "_malEndScheduled", mal_value_new_boolean(true));
    stream_enqueue_task(
        vm, STREAM_TASK_END_READABLE, receiver, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
}

static void stream_schedule_pull(MalVm *vm, MalValue receiver) {
    MalValue state = stream_own(vm, receiver, "_readableState");
    if (!stream_is_readable(vm, receiver)
        || (!stream_truthy_own(vm, receiver, "_malFlowing") && !stream_iterator_demand(vm, receiver))
        || stream_truthy_own(vm, receiver, "_malReading")
        || stream_truthy_own(vm, receiver, "_malReadScheduled")
        || stream_truthy_own(vm, receiver, "destroyed")
        || stream_truthy_own(vm, state, "ended")) {
        return;
    }
    stream_set(vm, receiver, "_malReadScheduled", mal_value_new_boolean(true));
    stream_enqueue_task(
        vm, STREAM_TASK_PULL, receiver, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
}

static void stream_resume_core(MalVm *vm, MalValue receiver) {
    if (!stream_is_readable(vm, receiver) || stream_truthy_own(vm, receiver, "destroyed")) {
        return;
    }
    bool was_paused = stream_truthy_own(vm, receiver, "_malPaused");
    MalValue readable_state = stream_own(vm, receiver, "_readableState");
    stream_set(vm, receiver, "_malPaused", mal_value_new_boolean(false));
    // resume(): state.flowing = !state.readableListening.
    if (stream_truthy_own(vm, readable_state, "readableListening")) {
        if (was_paused) stream_emit(vm, receiver, "resume", nullptr, 0);
        return;
    }
    stream_set(vm, readable_state, "flowingFalse", mal_value_new_boolean(false));
    stream_set(vm, receiver, "_malFlowing", mal_value_new_boolean(true));
    if (was_paused) {
        stream_emit(vm, receiver, "resume", nullptr, 0);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_readable_drain(vm, receiver);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_schedule_pull(vm, receiver);
    }
}

static bool stream_pipe_contains(MalVm *vm, MalValue source, MalValue destination) {
    MalValue pipes = stream_own(vm, source, "_malPipes");
    if (mal_value_is_array_object(pipes)) {
        MalArrayObject *array = mal_value_to_array_object(pipes);
        u32 length = mal_array_object_length(array);
        for (u32 i = 0; i < length; i++) {
            if (mal_ops_same_value(stream_array_at(array, i), destination)) {
                return true;
            }
        }
    }
    return false;
}

static u32 stream_remove_blocked_pipe(
    MalVm *vm, MalValue source, MalValue destination, bool detach) {
    MalValue roots[] = {
        source, destination, stream_own(vm, source, "_malBlockedPipes"),
        stream_new_array(vm), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_array_object(roots[2])) {
        MalArrayObject *old = mal_value_to_array_object(roots[2]);
        MalArrayObject *next = mal_value_to_array_object(roots[3]);
        u32 length = mal_array_object_length(old);
        for (u32 i = 0; i < length; i++) {
            roots[4] = stream_array_at(old, i);
            MalValue blocked_destination =
                stream_own(vm, roots[4], "destination");
            if (mal_ops_same_value(blocked_destination, roots[1])) {
                if (detach) {
                    roots[5] = stream_own(vm, roots[4], "listener");
                    MalValue remove_args[] = {
                        mal_value_from_string(
                            mal_intrinsic_static_ascii(vm, (const byte *) "drain")),
                        roots[5],
                    };
                    stream_call_method(
                        vm, blocked_destination, "removeListener", remove_args, 2);
                }
                continue;
            }
            mal_array_object_store(
                next, mal_key_index(mal_array_object_length(next)), roots[4]);
        }
        stream_set(vm, roots[0], "_malBlockedPipes", roots[3]);
    }
    u32 remaining = mal_value_is_array_object(roots[3])
        ? mal_array_object_length(mal_value_to_array_object(roots[3]))
        : 0;
    mal_gc_unroot(&root);
    return remaining;
}

static MalValue stream_drain_resume(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue source = mal_native_function_object_get_slot(function, 0);
    MalValue destination = mal_native_function_object_get_slot(function, 1);
    u32 blocked = stream_remove_blocked_pipe(vm, source, destination, false);
    if (blocked == 0 && stream_pipe_contains(vm, source, destination)) {
        stream_resume_core(vm, source);
    }
    return mal_value_new_undefined();
}

static bool stream_pipe_is_blocked(
    MalVm *vm, MalValue source, MalValue destination) {
    MalValue blocked = stream_own(vm, source, "_malBlockedPipes");
    if (!mal_value_is_array_object(blocked)) {
        return false;
    }
    MalArrayObject *array = mal_value_to_array_object(blocked);
    u32 length = mal_array_object_length(array);
    for (u32 i = 0; i < length; i++) {
        MalValue record = stream_array_at(array, i);
        if (mal_ops_same_value(
                stream_own(vm, record, "destination"), destination)) {
            return true;
        }
    }
    return false;
}

static bool stream_pipe_chunk(MalVm *vm, MalValue source, MalValue chunk) {
    MalValue pipes = stream_own(vm, source, "_malPipes");
    if (!mal_value_is_array_object(pipes)) {
        return true;
    }
    MalValue roots[] = {source, chunk, pipes, mal_value_new_undefined(),
                        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *array = mal_value_to_array_object(roots[2]);
    u32 length = mal_array_object_length(array);
    bool flowing = true;
    for (u32 i = 0; i < length && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        roots[3] = stream_array_at(array, i);
        if (!mal_value_is_object(roots[3])) {
            continue;
        }
        MalCompletion write = stream_call_method(vm, roots[3], "write", &roots[1], 1);
        if (write.kind == MAL_COMPLETION_THROW) {
            break;
        }
        if (mal_value_is_boolean(write.value) && !mal_value_to_boolean(write.value)) {
            flowing = false;
            stream_set(vm, roots[0], "_malPaused", mal_value_new_boolean(true));
            stream_set(vm, roots[0], "_malFlowing", mal_value_new_boolean(false));
            if (stream_pipe_is_blocked(vm, roots[0], roots[3])) {
                continue;
            }
            MalValue slots[] = {roots[0], roots[3]};
            roots[4] = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots(
                    &vm->heap,
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                    mal_intrinsic_static_ascii(vm, (const byte *) "onDrain"),
                    stream_drain_resume, slots, countof(slots)));
            MalValue record = mal_value_from_object(mal_intrinsic_new_object(vm));
            MalRootSpan record_root;
            mal_gc_root(&record_root, &record, 1);
            stream_set(vm, record, "destination", roots[3]);
            stream_set(vm, record, "listener", roots[4]);
            MalValue blocked = stream_own(vm, roots[0], "_malBlockedPipes");
            MalArrayObject *blocked_array = mal_value_to_array_object(blocked);
            mal_array_object_store(
                blocked_array, mal_key_index(mal_array_object_length(blocked_array)),
                record);
            mal_gc_unroot(&record_root);
            MalValue drain_args[] = {
                mal_value_from_string(
                    mal_intrinsic_static_ascii(vm, (const byte *) "drain")),
                roots[4],
            };
            stream_call_method(vm, roots[3], "once", drain_args, 2);
        }
    }
    mal_gc_unroot(&root);
    return flowing;
}

static void stream_deliver_chunk(MalVm *vm, MalValue receiver, MalValue chunk) {
    stream_pipe_chunk(vm, receiver, chunk);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_emit(vm, receiver, "data", &chunk, 1);
    }
}

static void stream_end_pipes(MalVm *vm, MalValue receiver) {
    MalValue roots[] = {
        receiver, stream_own(vm, receiver, "_malPipes"), mal_value_new_undefined(),
    };
    if (!mal_value_is_array_object(roots[1])) {
        return;
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *pipes = mal_value_to_array_object(roots[1]);
    u32 length = mal_array_object_length(pipes);
    for (u32 i = 0; i < length && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        roots[2] = stream_array_at(pipes, i);
        if (mal_value_is_object(roots[2])) {
            stream_call_method(vm, roots[2], "end", nullptr, 0);
        }
    }
    roots[1] = stream_new_array(vm);
    stream_set(vm, roots[0], "_malPipes", roots[1]);
    mal_gc_unroot(&root);
}

static void stream_end_readable(MalVm *vm, MalValue receiver) {
    if (stream_truthy_own(vm, receiver, "readableEnded")) {
        return;
    }
    stream_set(vm, receiver, "readable", mal_value_new_boolean(false));
    stream_set(vm, receiver, "readableEnded", mal_value_new_boolean(true));
    MalValue state = stream_own(vm, receiver, "_readableState");
    stream_set(vm, state, "endEmitted", mal_value_new_boolean(true));
    stream_emit(vm, receiver, "end", nullptr, 0);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_end_pipes(vm, receiver);
    }
}

void mal_node_stream_end_readable(MalVm *vm, MalValue receiver) {
    stream_end_readable(vm, receiver);
}

static void stream_readable_drain(MalVm *vm, MalValue receiver) {
    MalValue roots[] = {
        receiver, stream_own(vm, receiver, "_malReadableQueue"),
        mal_value_new_undefined(),
    };
    if (!mal_value_is_array_object(roots[1])) {
        return;
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *queue = mal_value_to_array_object(roots[1]);
    MalValue index_value = stream_own(vm, roots[0], "_malReadableIndex");
    u32 index = mal_value_is_int32(index_value) && mal_value_to_i32(index_value) > 0
        ? (u32) mal_value_to_i32(index_value)
        : 0;
    while (index < mal_array_object_length(queue)
           && stream_truthy_own(vm, roots[0], "_malFlowing")
           && !stream_truthy_own(vm, roots[0], "destroyed")) {
        roots[2] = stream_array_at(queue, index);
        mal_array_object_store(queue, mal_key_index(index++), mal_value_new_undefined());
        MalValue readable_state = stream_own(vm, roots[0], "_readableState");
        MalValue buffered = stream_own(vm, readable_state, "length");
        i32 remaining = (mal_value_is_int32(buffered) ? mal_value_to_i32(buffered) : 0)
            - stream_readable_bytes(vm, roots[0], roots[2]);
        stream_set(vm, readable_state, "length", mal_value_from_i32(remaining > 0 ? remaining : 0));
        stream_set(vm, roots[0], "_malReadableIndex", mal_value_from_i32((i32) index));
        stream_deliver_chunk(vm, roots[0], roots[2]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            break;
        }
    }
    if (index == mal_array_object_length(queue)) {
        roots[1] = stream_new_array(vm);
        stream_set(vm, roots[0], "_malReadableQueue", roots[1]);
        stream_set(vm, roots[0], "_malReadableIndex", mal_value_from_i32(0));
        MalValue state = stream_own(vm, roots[0], "_readableState");
        if (stream_truthy_own(vm, state, "ended")
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_schedule_readable_end(vm, roots[0]);
        } else if (vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_schedule_pull(vm, roots[0]);
        }
    }
    mal_gc_unroot(&root);
}

static void stream_push_chunk(MalVm *vm, MalValue receiver, MalValue state, MalValue chunk) {
    if (stream_truthy_own(vm, receiver, "_malFlowing")) {
        stream_deliver_chunk(vm, receiver, chunk);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_schedule_pull(vm, receiver);
        }
    } else {
        MalValue queue_value = stream_own(vm, receiver, "_malReadableQueue");
        MalRootSpan root;
        mal_gc_root(&root, &queue_value, 1);
        MalArrayObject *queue = mal_value_to_array_object(queue_value);
        mal_array_object_store(queue, mal_key_index(mal_array_object_length(queue)), chunk);
        MalValue buffered = stream_own(vm, state, "length");
        i32 length = mal_value_is_int32(buffered) ? mal_value_to_i32(buffered) : 0;
        i32 added = stream_readable_bytes(vm, receiver, chunk);
        stream_set(vm, state, "length", mal_value_from_i32(added > INT32_MAX - length ? INT32_MAX : length + added));
        mal_gc_unroot(&root);
        if (stream_truthy_own(vm, state, "needReadable")) stream_emit_readable(vm, receiver);
        stream_maybe_read_more(vm, receiver);
        stream_iterator_drain(vm, receiver);
    }
}

static MalValue stream_push(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue state = stream_own(vm, receiver, "_readableState");
    stream_set(vm, receiver, "_malReading", mal_value_new_boolean(false));
    stream_set(vm, state, "reading", mal_value_new_boolean(false));
    MalValue decoder = stream_own(vm, state, "decoder");
    if (mal_value_is_object(decoder) && !stream_truthy_own(vm, state, "objectMode")
        && !stream_truthy_own(vm, state, "ended") && !stream_truthy_own(vm, receiver, "destroyed")) {
        if (mal_value_is_null(chunk)) {
            MalValue tail = stream_decoder_call(vm, decoder, "end", mal_value_new_undefined());
            if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
            if (mal_value_is_string(tail) && mal_string_length(mal_value_to_string(tail)) > 0) {
                MalRootSpan tail_root;
                mal_gc_root(&tail_root, &tail, 1);
                stream_push_chunk(vm, receiver, state, tail);
                mal_gc_unroot(&tail_root);
                if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
            }
        } else if (mal_value_is_typed_array_object(chunk)) {
            chunk = stream_decoder_call(vm, decoder, "write", chunk);
            if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
            if (!mal_value_is_string(chunk) || mal_string_length(mal_value_to_string(chunk)) == 0) {
                return mal_value_new_boolean(mal_node_stream_readable_capacity(vm, receiver) > 0);
            }
        }
    }
    if (mal_value_is_null(chunk)) {
        bool was_ended = stream_truthy_own(vm, state, "ended");
        stream_set(vm, state, "ended", mal_value_new_boolean(true));
        if (stream_truthy_own(vm, receiver, "_malFlowing")) {
            stream_readable_drain(vm, receiver);
        } else if (!was_ended && stream_truthy_own(vm, state, "readableListening")) {
            // onEofChunk: inside a synchronous _read the 'readable' event waits a tick.
            if (stream_truthy_own(vm, state, "sync")) {
                stream_emit_readable(vm, receiver);
            } else {
                stream_set(vm, state, "needReadable", mal_value_new_boolean(false));
                stream_set(vm, state, "emittedReadable", mal_value_new_boolean(true));
                stream_emit_readable_now(vm, receiver);
            }
        }
        stream_iterator_drain(vm, receiver);
        return mal_value_new_boolean(false);
    }
    if (stream_truthy_own(vm, state, "ended")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        return mal_value_new_boolean(false);
    }
    MalRootSpan chunk_root;
    mal_gc_root(&chunk_root, &chunk, 1);
    stream_push_chunk(vm, receiver, state, chunk);
    mal_gc_unroot(&chunk_root);
    return mal_value_new_boolean(mal_node_stream_readable_capacity(vm, receiver) > 0);
}

static MalValue stream_pause(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    stream_set(vm, receiver, "_malPaused", mal_value_new_boolean(true));
    stream_set(vm, receiver, "_malFlowing", mal_value_new_boolean(false));
    stream_set(vm, stream_own(vm, receiver, "_readableState"), "flowingFalse", mal_value_new_boolean(true));
    stream_emit(vm, receiver, "pause", nullptr, 0);
    return receiver;
}

static MalValue stream_resume(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    stream_resume_core(vm, receiver);
    return receiver;
}

static MalValue stream_is_paused(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    return mal_value_new_boolean(
        vm->completion.kind != MAL_COMPLETION_THROW
        && stream_truthy_own(vm, receiver, "_malPaused"));
}

static MalValue stream_set_encoding(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue encoding = argc > 0 ? args[0] : mal_value_new_undefined();
    MalString *string;
    if (!mal_vm_to_string(vm, encoding, &string)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        receiver, mal_value_from_string(string), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = stream_new_decoder(vm, roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[3] = stream_own(vm, roots[0], "_readableState");
    MalValue normalized = stream_own(vm, roots[2], "encoding");
    stream_set(vm, roots[3], "encoding", mal_value_is_string(normalized) ? normalized : roots[1]);
    stream_set(vm, roots[3], "decoder", roots[2]);
    // Node re-decodes buffered Buffers into one string chunk.
    roots[4] = stream_own(vm, roots[0], "_malReadableQueue");
    if (mal_value_is_array_object(roots[4])) {
        MalArrayObject *queue = mal_value_to_array_object(roots[4]);
        MalValue index_value = stream_own(vm, roots[0], "_malReadableIndex");
        u32 index = mal_value_is_int32(index_value) && mal_value_to_i32(index_value) > 0
            ? (u32) mal_value_to_i32(index_value) : 0;
        MalTextBuffer text = {0};
        bool any = false;
        for (u32 i = index; i < mal_array_object_length(queue); i++) {
            MalValue chunk = stream_array_at(queue, i);
            MalValue decoded = mal_value_is_typed_array_object(chunk)
                ? stream_decoder_call(vm, roots[2], "write", chunk) : chunk;
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            if (mal_value_is_string(decoded)) mal_text_buffer_append_string(&text, mal_value_to_string(decoded));
            any = true;
        }
        if (any && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalValue joined = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
            MalRootSpan joined_root;
            mal_gc_root(&joined_root, &joined, 1);
            roots[4] = stream_new_array(vm);
            mal_array_object_store(mal_value_to_array_object(roots[4]), mal_key_index(0), joined);
            stream_set(vm, roots[0], "_malReadableQueue", roots[4]);
            stream_set(vm, roots[0], "_malReadableIndex", mal_value_from_i32(0));
            mal_gc_unroot(&joined_root);
        } else {
            mal_text_buffer_dispose(&text);
        }
    }
    mal_gc_unroot(&root);
    return receiver;
}

static MalValue stream_on(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue base = mal_native_function_object_get_slot(function, 0);
    MalCompletion added = mal_vm_call_value(vm, base, receiver, args, argc);
    if (added.kind != MAL_COMPLETION_THROW && argc > 0
        && mal_value_is_string(args[0])) {
        MalString *event = mal_value_to_string(args[0]);
        MalString *data = mal_intrinsic_static_ascii(vm, (const byte *) "data");
        MalString *readable = mal_intrinsic_static_ascii(vm, (const byte *) "readable");
        MalValue state = stream_own(vm, receiver, "_readableState");
        if (mal_string_equals(event, data) && stream_is_readable(vm, receiver)) {
            // Node resumes on 'data' unless flowing was set false by pause() or a 'readable' listener.
            if (!stream_truthy_own(vm, state, "flowingFalse")) stream_resume_core(vm, receiver);
        } else if (mal_string_equals(event, readable) && stream_is_readable(vm, receiver)
            && !stream_truthy_own(vm, state, "endEmitted") && !stream_truthy_own(vm, state, "readableListening")) {
            stream_set(vm, state, "readableListening", mal_value_new_boolean(true));
            stream_set(vm, state, "needReadable", mal_value_new_boolean(true));
            stream_set(vm, state, "flowingFalse", mal_value_new_boolean(true));
            stream_set(vm, receiver, "_malFlowing", mal_value_new_boolean(false));
            stream_set(vm, state, "emittedReadable", mal_value_new_boolean(false));
            if (stream_i32_own(vm, state, "length", 0) > 0) {
                stream_emit_readable(vm, receiver);
            } else if (!stream_truthy_own(vm, receiver, "_malReading")) {
                // nReadingNextTick: one read(0) on the next tick.
                stream_enqueue_task(vm, STREAM_TASK_READ_ZERO, receiver, mal_value_new_undefined(),
                    mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
            }
        }
    }
    return added.value;
}

static MalValue stream_pipe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    MalValue destination = argc > 0 ? args[0] : mal_value_new_undefined();
    if (vm->completion.kind == MAL_COMPLETION_THROW || !mal_value_is_object(destination)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The pipe destination must be an object");
        }
        return mal_value_new_undefined();
    }
    MalValue roots[] = {receiver, destination, stream_own(vm, receiver, "_malPipes")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_array_object(roots[2])) {
        roots[2] = stream_new_array(vm);
        stream_set(vm, roots[0], "_malPipes", roots[2]);
    }
    MalArrayObject *pipes = mal_value_to_array_object(roots[2]);
    mal_array_object_store(pipes, mal_key_index(mal_array_object_length(pipes)), roots[1]);
    roots[2] = stream_own(vm, roots[1], "_malPipeSources");
    if (!mal_value_is_array_object(roots[2])) {
        roots[2] = stream_new_array(vm);
        stream_set(vm, roots[1], "_malPipeSources", roots[2]);
    }
    mal_array_object_store(mal_value_to_array_object(roots[2]),
        mal_key_index(mal_array_object_length(mal_value_to_array_object(roots[2]))), roots[0]);
    stream_emit(vm, roots[1], "pipe", roots, 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_resume_core(vm, roots[0]);
    }
    mal_gc_unroot(&root);
    return destination;
}

static MalValue stream_unpipe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue destination = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue roots[] = {
        receiver, destination, stream_own(vm, receiver, "_malPipes"),
        stream_new_array(vm), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_array_object(roots[2])) {
        MalArrayObject *old = mal_value_to_array_object(roots[2]);
        MalArrayObject *next = mal_value_to_array_object(roots[3]);
        u32 length = mal_array_object_length(old);
        for (u32 i = 0; i < length; i++) {
            roots[4] = stream_array_at(old, i);
            bool remove = mal_value_is_undefined(roots[1])
                || mal_ops_same_value(roots[1], roots[4]);
            if (remove) {
                stream_remove_blocked_pipe(vm, roots[0], roots[4], true);
                stream_emit(vm, roots[4], "unpipe", roots, 1);
            } else {
                mal_array_object_store(
                    next, mal_key_index(mal_array_object_length(next)), roots[4]);
            }
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                break;
            }
        }
        stream_set(vm, roots[0], "_malPipes", roots[3]);
        u32 pipe_count = mal_array_object_length(next);
        MalValue blocked = stream_own(vm, roots[0], "_malBlockedPipes");
        u32 blocked_count = mal_value_is_array_object(blocked)
            ? mal_array_object_length(mal_value_to_array_object(blocked))
            : 0;
        if (pipe_count == 0) {
            stream_set(vm, roots[0], "_malPaused", mal_value_new_boolean(true));
            stream_set(vm, roots[0], "_malFlowing", mal_value_new_boolean(false));
        } else if (blocked_count == 0
                   && vm->completion.kind != MAL_COMPLETION_THROW) {
            stream_resume_core(vm, roots[0]);
        }
    }
    mal_gc_unroot(&root);
    return receiver;
}

static void stream_clear_completion(MalVm *vm);

static MalValue stream_destroy_done(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(function, 2))) return mal_value_new_undefined();
    mal_native_function_object_set_slot(function, 2, mal_value_new_boolean(true));
    MalValue roots[3] = {
        mal_native_function_object_get_slot(function, 0),
        argc > 0 && !mal_value_is_nil(args[0]) ? args[0] : mal_native_function_object_get_slot(function, 1),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_nil(roots[1])) {
        stream_set(vm, roots[0], "_malStreamError", roots[1]);
        stream_iterator_drain(vm, roots[0]);
        stream_emit(vm, roots[0], "error", roots + 1, 1);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) stream_emit(vm, roots[0], "close", nullptr, 0);
    stream_set(vm, roots[0], "closed", mal_value_new_boolean(true));
    roots[2] = stream_own(vm, roots[0], "_malClosePromise");
    if (mal_value_is_promise_object(roots[2])) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[2]), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target; (void) callee;
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Stream.destroy called on incompatible receiver");
        return mal_value_new_undefined();
    }
    if (stream_truthy_own(vm, receiver, "destroyed")) return receiver;
    MalValue roots[4] = {receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, receiver, "destroyed", mal_value_new_boolean(true));
    stream_set(vm, receiver, "readable", mal_value_new_boolean(false));
    stream_set(vm, receiver, "writable", mal_value_new_boolean(false));
    stream_set(vm, receiver, "_malStreamError", roots[1]);
    MalValue readable_state = stream_own(vm, receiver, "_readableState");
    MalValue writable_state = stream_own(vm, receiver, "_writableState");
    if (mal_value_is_object(readable_state)) stream_set(vm, readable_state, "destroyed", mal_value_new_boolean(true));
    if (mal_value_is_object(writable_state)) stream_set(vm, writable_state, "destroyed", mal_value_new_boolean(true));
    stream_iterator_drain(vm, receiver);
    MalValue done_slots[] = {roots[0], roots[1], mal_value_new_boolean(false)};
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_static_ascii(vm, (const byte *) "destroyDone"), 1, stream_destroy_done, done_slots, countof(done_slots)));
    if (!stream_get(vm, roots[0], "_destroy", &roots[3])) goto finished;
    if (mal_value_is_callable(roots[3])) {
        MalValue destroy_args[] = {roots[1], roots[2]};
        MalCompletion completion = mal_vm_call_value(vm, roots[3], roots[0], destroy_args, 2);
        if (completion.kind == MAL_COMPLETION_THROW) {
            roots[1] = completion.value;
            stream_clear_completion(vm);
            mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), roots + 1, 1);
        }
    } else mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), nullptr, 0);
finished:
    mal_gc_unroot(&root);
    return receiver;
}

static void stream_call_callback(
    MalVm *vm, MalValue callback, MalValue argument, bool has_argument) {
    if (!mal_value_is_callable(callback)) {
        return;
    }
    mal_vm_call_value(vm, callback, mal_value_new_undefined(),
                      has_argument ? &argument : nullptr, has_argument ? 1 : 0);
}

static void stream_clear_completion(MalVm *vm) {
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
}

static i32 stream_i32_own(
    MalVm *vm, MalValue receiver, const char *name, i32 fallback) {
    MalValue value = stream_own(vm, receiver, name);
    return mal_value_is_int32(value) ? mal_value_to_i32(value) : fallback;
}

static void stream_start_pull(MalVm *vm, MalValue receiver) {
    MalValue roots[] = {
        receiver, stream_own(vm, receiver, "_readableState"),
        stream_own(vm, receiver, "_malReadableQueue"),
        mal_value_new_undefined(),
    };
    if (!stream_is_readable(vm, roots[0])
        || (!stream_truthy_own(vm, roots[0], "_malFlowing") && !stream_iterator_demand(vm, roots[0]))
        || stream_truthy_own(vm, roots[0], "_malReading")
        || stream_truthy_own(vm, roots[0], "destroyed")
        || stream_truthy_own(vm, roots[1], "ended")) {
        return;
    }
    if (mal_value_is_array_object(roots[2])) {
        MalArrayObject *queue = mal_value_to_array_object(roots[2]);
        i32 raw_index = stream_i32_own(vm, roots[0], "_malReadableIndex", 0);
        u32 index = raw_index > 0 ? (u32) raw_index : 0;
        if (index < mal_array_object_length(queue)) return;
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_get(vm, roots[0], "_read", &roots[3])) {
        mal_gc_unroot(&root);
        return;
    }
    if (mal_value_is_callable(roots[3])) {
        stream_set(vm, roots[0], "_malReading", mal_value_new_boolean(true));
        stream_set(vm, roots[1], "reading", mal_value_new_boolean(true));
        MalValue size = mal_value_from_i32(
            stream_i32_own(vm, roots[1], "highWaterMark", 16384));
        mal_vm_call_value(vm, roots[3], roots[0], &size, 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            stream_clear_completion(vm);
            stream_destroy(vm, roots[0], &error, 1,
                           mal_value_new_undefined(), mal_value_new_undefined());
        }
    }
    mal_gc_unroot(&root);
}

static void stream_set_buffered_length(MalVm *vm, MalValue receiver, i32 length) {
    if (length < 0) {
        length = 0;
    }
    stream_set(vm, receiver, "_malBufferedLength", mal_value_from_i32(length));
    MalValue state = stream_own(vm, receiver, "_writableState");
    stream_set(vm, state, "length", mal_value_from_i32(length));
}

static i32 stream_chunk_size(MalVm *vm, MalValue receiver, MalValue chunk) {
    MalValue state = stream_own(vm, receiver, "_writableState");
    if (stream_truthy_own(vm, state, "objectMode")) {
        return 1;
    }
    if (mal_value_is_typed_array_object(chunk)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(chunk);
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The chunk argument is detached or out of bounds");
            return 0;
        }
        usize length = mal_typed_array_object_byte_length(array);
        return length > INT32_MAX ? INT32_MAX : (i32) length;
    }
    if (mal_value_is_data_view_object(chunk)) {
        MalValue byte_length;
        if (!stream_get(vm, chunk, "byteLength", &byte_length)) return 0;
        if (mal_ops_is_number(byte_length)) {
            f64 number = mal_ops_number_as_f64(byte_length);
            return number > INT32_MAX ? INT32_MAX : (i32) number;
        }
        return 0;
    }
    if (mal_value_is_string(chunk)) {
        usize length = mal_string_length(mal_value_to_string(chunk));
        return length > INT32_MAX ? INT32_MAX : (i32) length;
    }
    return 1;
}

static void stream_call_callbacks(
    MalVm *vm, MalValue callbacks, MalValue error, bool has_error) {
    if (!mal_value_is_array_object(callbacks)) {
        return;
    }
    MalArrayObject *array = mal_value_to_array_object(callbacks);
    u32 length = mal_array_object_length(array);
    for (u32 i = 0; i < length; i++) {
        stream_call_callback(vm, stream_array_at(array, i), error, has_error);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            break;
        }
    }
}

static void stream_clear_end_callbacks(
    MalVm *vm, MalValue receiver, MalValue error, bool has_error) {
    MalValue callbacks = stream_own(vm, receiver, "_malEndCallbacks");
    MalRootSpan root;
    mal_gc_root(&root, &callbacks, 1);
    stream_call_callbacks(vm, callbacks, error, has_error);
    callbacks = stream_new_array(vm);
    stream_set(vm, receiver, "_malEndCallbacks", callbacks);
    mal_gc_unroot(&root);
}

static void stream_fail_writes(
    MalVm *vm, MalValue receiver, MalValue current_callback, MalValue error) {
    MalValue roots[] = {
        receiver, current_callback, error,
        stream_own(vm, receiver, "_malWriteQueue"),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(false));
    stream_call_callback(vm, roots[1], roots[2], true);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return;
    }

    if (mal_value_is_array_object(roots[3])) {
        MalArrayObject *queue = mal_value_to_array_object(roots[3]);
        i32 raw_index = stream_i32_own(vm, roots[0], "_malWriteIndex", 0);
        u32 index = raw_index > 0 ? (u32) raw_index : 0;
        u32 length = mal_array_object_length(queue);
        for (u32 i = index; i < length; i++) {
            roots[4] = stream_array_at(queue, i);
            MalValue callback = stream_own(vm, roots[4], "callback");
            stream_call_callback(vm, callback, roots[2], true);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&root);
                return;
            }
        }
    }
    roots[3] = stream_new_array(vm);
    stream_set(vm, roots[0], "_malWriteQueue", roots[3]);
    stream_set(vm, roots[0], "_malWriteIndex", mal_value_from_i32(0));
    stream_set_buffered_length(vm, roots[0], 0);
    stream_clear_end_callbacks(vm, roots[0], roots[2], true);
    if (!stream_truthy_own(vm, roots[0], "destroyed")) {
        stream_destroy(vm, roots[0], roots + 2, 1,
                       mal_value_new_undefined(), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
}

static void stream_maybe_emit_drain(MalVm *vm, MalValue receiver) {
    if (stream_i32_own(vm, receiver, "_malBufferedLength", 0) != 0
        || !stream_truthy_own(vm, receiver, "_malNeedDrain")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        return;
    }
    stream_set(vm, receiver, "_malNeedDrain", mal_value_new_boolean(false));
    MalValue state = stream_own(vm, receiver, "_writableState");
    stream_set(vm, state, "needDrain", mal_value_new_boolean(false));
    stream_emit(vm, receiver, "drain", nullptr, 0);
}

static void stream_complete_write(
    MalVm *vm, MalValue receiver, MalValue callback, MalValue error,
    MalValue data, i32 mode, i32 chunk_size) {
    MalValue roots[] = {receiver, callback, error, data};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(false));
    if (mode == 0 && chunk_size > 0) {
        i32 buffered = stream_i32_own(vm, roots[0], "_malBufferedLength", 0);
        stream_set_buffered_length(vm, roots[0], buffered - chunk_size);
    }
    if (!mal_value_is_nil(roots[2])) {
        stream_fail_writes(vm, roots[0], roots[1], roots[2]);
        mal_gc_unroot(&root);
        return;
    }
    if (!mal_value_is_undefined(roots[3]) && !mal_value_is_null(roots[3])) {
        stream_push(vm, roots[0], roots + 3, 1,
                    mal_value_new_undefined(), mal_value_new_undefined());
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue push_error = vm->completion.value;
        stream_clear_completion(vm);
        stream_fail_writes(vm, roots[0], roots[1], push_error);
        mal_gc_unroot(&root);
        return;
    }
    if (mode == 1) {
        MalValue null_chunk = mal_value_new_null();
        stream_push(vm, roots[0], &null_chunk, 1,
                    mal_value_new_undefined(), mal_value_new_undefined());
    } else {
        stream_call_callback(vm, roots[1], mal_value_new_undefined(), false);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            stream_clear_completion(vm);
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_process_writes(vm, roots[0]);
        stream_maybe_emit_drain(vm, roots[0]);
        stream_finish_if_ready(vm, roots[0]);
    }
    mal_gc_unroot(&root);
}

static MalValue stream_transform_done(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalNativeFunctionObject *done = mal_value_to_native_function_object(callee);
    if (mal_value_to_boolean(mal_native_function_object_get_slot(done, 3))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(done, 3, mal_value_new_boolean(true));
    MalValue stream = mal_native_function_object_get_slot(done, 0);
    MalValue callback = mal_native_function_object_get_slot(done, 1);
    i32 mode = mal_value_to_i32(mal_native_function_object_get_slot(done, 2));
    i32 chunk_size = mal_value_to_i32(mal_native_function_object_get_slot(done, 4));
    stream_enqueue_task(
        vm, STREAM_TASK_WRITE_DONE, stream, callback,
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mode, chunk_size);
    return mal_value_new_undefined();
}

static MalValue stream_new_done(
    MalVm *vm, MalValue receiver, MalValue callback, i32 mode, i32 chunk_size) {
    MalValue slots[] = {
        receiver, callback, mal_value_from_i32(mode), mal_value_new_boolean(false),
        mal_value_from_i32(chunk_size),
    };
    return mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "done"),
            stream_transform_done, slots, countof(slots)));
}

static void stream_start_write(
    MalVm *vm, MalValue receiver, MalValue chunk,
    MalValue encoding, MalValue callback, i32 chunk_size) {
    MalValue roots[] = {
        receiver, chunk, encoding, callback, mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(true));
    roots[4] = stream_new_done(vm, roots[0], roots[3], 0, chunk_size);
    bool transform = false;
    MalValue kind = stream_own(vm, roots[0], "_malStreamKind");
    if (mal_value_is_int32(kind) && mal_value_to_i32(kind) == STREAM_TRANSFORM) {
        transform = true;
        roots[2] = mal_value_from_string(
            mal_intrinsic_static_ascii(vm, (const byte *) "buffer"));
        stream_get(vm, roots[0], "_transform", &roots[5]);
    } else {
        stream_get(vm, roots[0], "_write", &roots[5]);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        stream_clear_completion(vm);
        stream_transform_done(vm, mal_value_new_undefined(), &error, 1,
                              mal_value_new_undefined(), roots[4]);
        mal_gc_unroot(&root);
        return;
    }
    if (!mal_value_is_callable(roots[5])) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            transform
                ? "The _transform() method is not implemented"
                : "The _write() method is not implemented");
        MalValue error = vm->completion.value;
        stream_clear_completion(vm);
        stream_transform_done(vm, mal_value_new_undefined(), &error, 1,
                              mal_value_new_undefined(), roots[4]);
        mal_gc_unroot(&root);
        return;
    }
    MalValue call_args[] = {roots[1], roots[2], roots[4]};
    mal_vm_call_value(vm, roots[5], roots[0], call_args, 3);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = vm->completion.value;
        stream_clear_completion(vm);
        stream_transform_done(vm, mal_value_new_undefined(), &error, 1,
                              mal_value_new_undefined(), roots[4]);
    }
    mal_gc_unroot(&root);
}

static void stream_process_writes(MalVm *vm, MalValue receiver) {
    if (stream_truthy_own(vm, receiver, "_malWriteBusy")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        return;
    }
    MalValue roots[] = {
        receiver, stream_own(vm, receiver, "_malWriteQueue"),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    if (!mal_value_is_array_object(roots[1])) {
        return;
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue index_value = stream_own(vm, roots[0], "_malWriteIndex");
    u32 index = mal_value_is_int32(index_value) && mal_value_to_i32(index_value) > 0
        ? (u32) mal_value_to_i32(index_value)
        : 0;
    MalArrayObject *queue = mal_value_to_array_object(roots[1]);
    if (index < mal_array_object_length(queue)) {
        roots[2] = stream_array_at(queue, index++);
        stream_set(vm, roots[0], "_malWriteIndex", mal_value_from_i32((i32) index));
        roots[3] = stream_own(vm, roots[2], "chunk");
        roots[4] = stream_own(vm, roots[2], "encoding");
        MalValue callback = stream_own(vm, roots[2], "callback");
        i32 chunk_size = stream_i32_own(vm, roots[2], "size", 1);
        stream_start_write(
            vm, roots[0], roots[3], roots[4], callback, chunk_size);
    } else {
        roots[1] = stream_new_array(vm);
        stream_set(vm, roots[0], "_malWriteQueue", roots[1]);
        stream_set(vm, roots[0], "_malWriteIndex", mal_value_from_i32(0));
    }
    mal_gc_unroot(&root);
}

static void stream_enqueue_write(
    MalVm *vm, MalValue receiver, MalValue chunk,
    MalValue encoding, MalValue callback, i32 chunk_size) {
    MalValue roots[] = {
        receiver, chunk, encoding, callback,
        stream_own(vm, receiver, "_malWriteQueue"), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
    stream_set(vm, roots[5], "chunk", roots[1]);
    stream_set(vm, roots[5], "encoding", roots[2]);
    stream_set(vm, roots[5], "callback", roots[3]);
    stream_set(vm, roots[5], "size", mal_value_from_i32(chunk_size));
    MalArrayObject *queue = mal_value_to_array_object(roots[4]);
    mal_array_object_store(queue, mal_key_index(mal_array_object_length(queue)), roots[5]);
    mal_gc_unroot(&root);
}

static bool stream_decode_write_chunk(
    MalVm *vm, MalValue state, MalValue *chunk, MalValue *encoding) {
    if (!mal_value_is_string(*chunk)
        || !stream_truthy_own(vm, state, "decodeStrings")) {
        return true;
    }
    if (mal_value_is_undefined(
            vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR])) {
        mal_host_install_node_buffer(vm, nullptr, 0, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
    }
    MalValue roots[] = {
        state, *chunk, *encoding,
        vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR],
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_get(vm, roots[3], "from", &roots[4])) {
        mal_gc_unroot(&root);
        return false;
    }
    MalCompletion completion = mal_vm_call_value(
        vm, roots[4], roots[3], roots + 1, 2);
    if (completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return false;
    }
    roots[5] = completion.value;
    *chunk = roots[5];
    *encoding = mal_value_from_string(
        mal_intrinsic_static_ascii(vm, (const byte *) "buffer"));
    mal_gc_unroot(&root);
    return true;
}

static MalValue stream_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_writable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue encoding = mal_value_from_string(
        mal_intrinsic_ascii(vm, mal_value_is_string(chunk)
            ? (const byte *) "utf8"
            : (const byte *) "buffer"));
    MalValue callback = mal_value_new_undefined();
    if (argc > 1 && mal_value_is_callable(args[1])) {
        callback = args[1];
    } else {
        if (argc > 1 && mal_value_is_string(args[1])) {
            encoding = args[1];
        }
        if (argc > 2 && mal_value_is_callable(args[2])) {
            callback = args[2];
        }
    }
    MalValue state = stream_own(vm, receiver, "_writableState");
    bool object_mode = stream_truthy_own(vm, state, "objectMode");
    if (mal_value_is_null(chunk)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "May not write null values to stream");
        return mal_value_new_undefined();
    }
    if (!object_mode && !mal_value_is_string(chunk)
        && !mal_value_is_typed_array_object(chunk)
        && !mal_value_is_data_view_object(chunk)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The chunk argument must be a string or byte view");
        return mal_value_new_undefined();
    }
    if (!object_mode
        && !stream_decode_write_chunk(vm, state, &chunk, &encoding)) {
        return mal_value_new_undefined();
    }
    if (stream_truthy_own(vm, receiver, "_malEnding")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "write after end");
        return mal_value_new_boolean(false);
    }
    i32 chunk_size = stream_chunk_size(vm, receiver, chunk);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    i32 buffered = stream_i32_own(vm, receiver, "_malBufferedLength", 0);
    i32 next_buffered = chunk_size > INT32_MAX - buffered
        ? INT32_MAX
        : buffered + chunk_size;
    stream_set_buffered_length(vm, receiver, next_buffered);
    stream_enqueue_write(vm, receiver, chunk, encoding, callback, chunk_size);
    stream_process_writes(vm, receiver);
    i32 high_water_mark = stream_i32_own(vm, state, "highWaterMark", 16384);
    bool below = next_buffered < high_water_mark;
    if (!below) {
        stream_set(vm, receiver, "_malNeedDrain", mal_value_new_boolean(true));
        stream_set(vm, state, "needDrain", mal_value_new_boolean(true));
    }
    return mal_value_new_boolean(below);
}

/* finish()/endReadableNT autoDestroy: the other side must be done or absent. An explicit
 * _malAutoDestroyAfterEnd/_malAutoDestroyAfterFinish flag (fs, child_process) wins. */
static bool stream_auto_destroy_after(MalVm *vm, MalValue receiver, bool after_finish) {
    MalValue explicit_flag = stream_own(vm, receiver, after_finish ? "_malAutoDestroyAfterFinish" : "_malAutoDestroyAfterEnd");
    if (mal_value_is_boolean(explicit_flag)) return mal_value_to_boolean(explicit_flag);
    if (stream_truthy_own(vm, receiver, "_malNoAutoDestroy")) return false;
    if (after_finish) {
        MalValue state = stream_own(vm, receiver, "_readableState");
        return !mal_value_is_object(state) || stream_truthy_own(vm, state, "endEmitted")
            || !stream_truthy_own(vm, receiver, "readable");
    }
    MalValue state = stream_own(vm, receiver, "_writableState");
    return !mal_value_is_object(state) || stream_truthy_own(vm, state, "finished")
        || !stream_truthy_own(vm, receiver, "writable");
}

static void stream_emit_finish(MalVm *vm, MalValue receiver) {
    if (stream_truthy_own(vm, receiver, "writableFinished")) {
        return;
    }
    stream_set(vm, receiver, "writable", mal_value_new_boolean(false));
    stream_set(vm, receiver, "writableFinished", mal_value_new_boolean(true));
    MalValue state = stream_own(vm, receiver, "_writableState");
    stream_set(vm, state, "finished", mal_value_new_boolean(true));
    stream_clear_end_callbacks(
        vm, receiver, mal_value_new_undefined(), false);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_emit(vm, receiver, "finish", nullptr, 0);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW && !stream_truthy_own(vm, receiver, "destroyed")
        && stream_auto_destroy_after(vm, receiver, true)) {
        stream_destroy(vm, receiver, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
    }
}

static void stream_schedule_finish(MalVm *vm, MalValue receiver) {
    if (stream_truthy_own(vm, receiver, "_malFinishScheduled")
        || stream_truthy_own(vm, receiver, "writableFinished")) {
        return;
    }
    stream_set(vm, receiver, "_malFinishScheduled", mal_value_new_boolean(true));
    stream_enqueue_task(
        vm, STREAM_TASK_FINISH, receiver, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
}

static void stream_finish_if_ready(MalVm *vm, MalValue receiver) {
    if (!stream_truthy_own(vm, receiver, "_malEnding")
        || stream_truthy_own(vm, receiver, "_malWriteBusy")
        || stream_truthy_own(vm, receiver, "writableFinished")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        return;
    }
    MalValue queue = stream_own(vm, receiver, "_malWriteQueue");
    MalValue index_value = stream_own(vm, receiver, "_malWriteIndex");
    u32 index = mal_value_is_int32(index_value) && mal_value_to_i32(index_value) > 0
        ? (u32) mal_value_to_i32(index_value)
        : 0;
    if (mal_value_is_array_object(queue)
        && index < mal_array_object_length(mal_value_to_array_object(queue))) {
        stream_process_writes(vm, receiver);
        return;
    }
    MalValue kind = stream_own(vm, receiver, "_malStreamKind");
    bool transform = mal_value_is_int32(kind)
        && mal_value_to_i32(kind) == STREAM_TRANSFORM;
    if (transform && !stream_truthy_own(vm, receiver, "_malFlushStarted")) {
        stream_set(vm, receiver, "_malFlushStarted", mal_value_new_boolean(true));
        MalValue roots[] = {receiver, mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        roots[2] = stream_new_done(
            vm, roots[0], mal_value_new_undefined(), 1, 0);
        stream_get(vm, roots[0], "_flush", &roots[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            stream_clear_completion(vm);
            stream_transform_done(
                vm, mal_value_new_undefined(), &error, 1,
                mal_value_new_undefined(), roots[2]);
            mal_gc_unroot(&root);
            return;
        }
        if (mal_value_is_callable(roots[1])) {
            stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(true));
            mal_vm_call_value(vm, roots[1], roots[0], roots + 2, 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                MalValue error = vm->completion.value;
                stream_clear_completion(vm);
                stream_transform_done(
                    vm, mal_value_new_undefined(), &error, 1,
                    mal_value_new_undefined(), roots[2]);
            }
        } else {
            stream_transform_done(vm, mal_value_new_undefined(), nullptr, 0,
                                  mal_value_new_undefined(), roots[2]);
        }
        mal_gc_unroot(&root);
        return;
    }
    if (!transform && !stream_truthy_own(vm, receiver, "_malFinalStarted")) {
        stream_set(vm, receiver, "_malFinalStarted", mal_value_new_boolean(true));
        MalValue roots[] = {receiver, mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        roots[2] = stream_new_done(
            vm, roots[0], mal_value_new_undefined(), 2, 0);
        stream_get(vm, roots[0], "_final", &roots[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            stream_clear_completion(vm);
            stream_transform_done(
                vm, mal_value_new_undefined(), &error, 1,
                mal_value_new_undefined(), roots[2]);
            mal_gc_unroot(&root);
            return;
        }
        if (mal_value_is_callable(roots[1])) {
            stream_set(vm, roots[0], "_malWriteBusy", mal_value_new_boolean(true));
            mal_vm_call_value(vm, roots[1], roots[0], roots + 2, 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                MalValue error = vm->completion.value;
                stream_clear_completion(vm);
                stream_transform_done(
                    vm, mal_value_new_undefined(), &error, 1,
                    mal_value_new_undefined(), roots[2]);
            }
            mal_gc_unroot(&root);
            return;
        }
        mal_gc_unroot(&root);
    }
    // prefinish(): once _final (or a Transform's flush) has completed, before 'finish'.
    if (!stream_truthy_own(vm, receiver, "_malPrefinished")) {
        stream_set(vm, receiver, "_malPrefinished", mal_value_new_boolean(true));
        stream_emit(vm, receiver, "prefinish", nullptr, 0);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    }
    stream_schedule_finish(vm, receiver);
}

static void stream_append_end_callback(
    MalVm *vm, MalValue receiver, MalValue callback) {
    if (!mal_value_is_callable(callback)) {
        return;
    }
    MalValue callbacks = stream_own(vm, receiver, "_malEndCallbacks");
    MalRootSpan root;
    mal_gc_root(&root, &callbacks, 1);
    MalArrayObject *array = mal_value_to_array_object(callbacks);
    mal_array_object_store(
        array, mal_key_index(mal_array_object_length(array)), callback);
    mal_gc_unroot(&root);
}

static MalValue stream_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_writable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue callback = mal_value_new_undefined();
    for (i32 i = argc - 1; i >= 0; i--) {
        if (mal_value_is_callable(args[i])) {
            callback = args[i];
            break;
        }
    }
    bool has_chunk = argc > 0 && !mal_value_is_callable(args[0]);
    if (has_chunk && vm->completion.kind != MAL_COMPLETION_THROW) {
        i32 write_argc = argc;
        while (write_argc > 1 && mal_value_is_callable(args[write_argc - 1])) {
            write_argc--;
        }
        stream_write(vm, receiver, args, write_argc,
                     mal_value_new_undefined(), mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }
    stream_append_end_callback(vm, receiver, callback);
    stream_set(vm, receiver, "_malEnding", mal_value_new_boolean(true));
    stream_set(vm, receiver, "writableEnded", mal_value_new_boolean(true));
    MalValue state = stream_own(vm, receiver, "_writableState");
    stream_set(vm, state, "ended", mal_value_new_boolean(true));
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_finish_if_ready(vm, receiver);
    }
    return receiver;
}

/* Readable.prototype.read and the 'readable' event, translated from Node 26
 * lib/internal/streams/readable.js (read, howMuchToRead, fromList, emitReadable,
 * maybeReadMore) over this file's queue (_malReadableQueue from _malReadableIndex). */
static u32 stream_queue_start(MalVm *vm, MalValue receiver) {
    i32 index = stream_i32_own(vm, receiver, "_malReadableIndex", 0);
    return index > 0 ? (u32) index : 0;
}

static u32 stream_queue_count(MalVm *vm, MalValue receiver) {
    MalValue queue = stream_own(vm, receiver, "_malReadableQueue");
    if (!mal_value_is_array_object(queue)) return 0;
    u32 length = mal_array_object_length(mal_value_to_array_object(queue));
    u32 start = stream_queue_start(vm, receiver);
    return length > start ? length - start : 0;
}

static MalValue stream_queue_shift(MalVm *vm, MalValue receiver) {
    MalValue queue = stream_own(vm, receiver, "_malReadableQueue");
    if (!mal_value_is_array_object(queue)) return mal_value_new_undefined();
    MalArrayObject *array = mal_value_to_array_object(queue);
    u32 start = stream_queue_start(vm, receiver);
    if (start >= mal_array_object_length(array)) return mal_value_new_undefined();
    MalValue chunk = stream_array_at(array, start);
    MalRootSpan root;
    mal_gc_root(&root, &chunk, 1);
    mal_array_object_store(array, mal_key_index(start), mal_value_new_undefined());
    if (start + 1 >= mal_array_object_length(array)) {
        stream_set(vm, receiver, "_malReadableQueue", stream_new_array(vm));
        stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32(0));
    } else {
        stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32((i32) start + 1));
    }
    mal_gc_unroot(&root);
    return chunk;
}

static void stream_queue_unshift(MalVm *vm, MalValue receiver, MalValue chunk) {
    MalValue roots[] = {chunk, stream_own(vm, receiver, "_malReadableQueue")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 start = stream_queue_start(vm, receiver);
    if (start > 0) {
        mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(start - 1), roots[0]);
        stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32((i32) start - 1));
    } else {
        MalValue fresh = stream_new_array(vm);
        MalRootSpan fresh_root;
        mal_gc_root(&fresh_root, &fresh, 1);
        mal_array_object_store(mal_value_to_array_object(fresh), mal_key_index(0), roots[0]);
        u32 length = mal_value_is_array_object(roots[1]) ? mal_array_object_length(mal_value_to_array_object(roots[1])) : 0;
        for (u32 i = 0; i < length; i++) {
            mal_array_object_store(mal_value_to_array_object(fresh), mal_key_index(i + 1),
                stream_array_at(mal_value_to_array_object(roots[1]), i));
        }
        stream_set(vm, receiver, "_malReadableQueue", fresh);
        mal_gc_unroot(&fresh_root);
    }
    mal_gc_unroot(&root);
}

static i32 stream_state_i32(MalVm *vm, MalValue receiver, const char *name, i32 fallback) {
    return stream_i32_own(vm, stream_own(vm, receiver, "_readableState"), name, fallback);
}

static void stream_state_flag(MalVm *vm, MalValue receiver, const char *name, bool value) {
    stream_set(vm, stream_own(vm, receiver, "_readableState"), name, mal_value_new_boolean(value));
}

static bool stream_state_truthy(MalVm *vm, MalValue receiver, const char *name) {
    return stream_truthy_own(vm, stream_own(vm, receiver, "_readableState"), name);
}

static void stream_emit_readable(MalVm *vm, MalValue receiver) {
    stream_state_flag(vm, receiver, "needReadable", false);
    if (stream_state_truthy(vm, receiver, "emittedReadable")) return;
    stream_state_flag(vm, receiver, "emittedReadable", true);
    stream_enqueue_task(vm, STREAM_TASK_EMIT_READABLE, receiver, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
}

static void stream_emit_readable_now(MalVm *vm, MalValue receiver) {
    i32 length = stream_state_i32(vm, receiver, "length", 0);
    bool ended = stream_state_truthy(vm, receiver, "ended");
    if (!stream_truthy_own(vm, receiver, "destroyed") && !mal_value_is_object(stream_own(vm, receiver, "_malStreamError"))
        && (length > 0 || ended)) {
        stream_emit(vm, receiver, "readable", nullptr, 0);
        stream_state_flag(vm, receiver, "emittedReadable", false);
    }
    bool flowing = stream_truthy_own(vm, receiver, "_malFlowing");
    stream_state_flag(vm, receiver, "needReadable", !flowing && !stream_state_truthy(vm, receiver, "ended")
        && stream_state_i32(vm, receiver, "length", 0) <= stream_state_i32(vm, receiver, "highWaterMark", 16384));
}

static void stream_maybe_read_more(MalVm *vm, MalValue receiver) {
    if (!stream_state_truthy(vm, receiver, "readableListening") || stream_state_truthy(vm, receiver, "readingMore")) return;
    stream_state_flag(vm, receiver, "readingMore", true);
    stream_enqueue_task(vm, STREAM_TASK_READ_MORE, receiver, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), 0, 0);
}

static i32 stream_how_much_to_read(MalVm *vm, MalValue receiver, f64 n) {
    i32 length = stream_state_i32(vm, receiver, "length", 0);
    bool ended = stream_state_truthy(vm, receiver, "ended");
    if (n <= 0 || (length == 0 && ended)) return 0;
    if (stream_state_truthy(vm, receiver, "objectMode")) return 1;
    if (isnan(n)) {
        bool decoder = mal_value_is_object(stream_own(vm, stream_own(vm, receiver, "_readableState"), "decoder"));
        if ((!decoder || stream_truthy_own(vm, receiver, "_malFlowing")) && length > 0) {
            MalValue queue = stream_own(vm, receiver, "_malReadableQueue");
            MalValue first = stream_array_at(mal_value_to_array_object(queue), stream_queue_start(vm, receiver));
            return stream_readable_bytes(vm, receiver, first);
        }
        return length;
    }
    if (n <= length) return (i32) n;
    return ended ? length : 0;
}

static MalValue stream_buffer_call(MalVm *vm, MalValue target, const char *name, const MalValue *args, i32 argc) {
    MalCompletion completion = stream_call_method(vm, target, name, args, argc);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

/* fromList: n bytes (or characters with a decoder), or one object in objectMode. */
static MalValue stream_from_list(MalVm *vm, MalValue receiver, i32 n) {
    if (stream_state_i32(vm, receiver, "length", 0) == 0 || stream_queue_count(vm, receiver) == 0) {
        return mal_value_new_null();
    }
    if (stream_state_truthy(vm, receiver, "objectMode")) return stream_queue_shift(vm, receiver);
    bool strings = mal_value_is_object(stream_own(vm, stream_own(vm, receiver, "_readableState"), "decoder"));
    MalValue roots[] = {receiver, stream_new_array(vm), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    i32 remaining = n;
    u32 parts = 0;
    while (remaining > 0 && stream_queue_count(vm, roots[0]) > 0) {
        roots[2] = stream_queue_shift(vm, roots[0]);
        i32 size = stream_readable_bytes(vm, roots[0], roots[2]);
        if (size > remaining) {
            MalValue split[] = {mal_value_from_i32(0), mal_value_from_i32(remaining)};
            if (mal_value_is_string(roots[2])) {
                MalString *text = mal_value_to_string(roots[2]);
                roots[3] = mal_value_from_string(mal_string_new_slice(&vm->heap, text, (usize) remaining,
                    mal_string_length(text) - (usize) remaining));
                stream_queue_unshift(vm, roots[0], roots[3]);
                roots[2] = mal_value_from_string(mal_string_new_slice(&vm->heap, mal_value_to_string(roots[2]), 0,
                    (usize) remaining));
            } else {
                roots[3] = stream_buffer_call(vm, roots[2], "slice", &split[1], 1);
                stream_queue_unshift(vm, roots[0], roots[3]);
                roots[2] = stream_buffer_call(vm, roots[2], "slice", split, 2);
            }
            size = remaining;
        }
        mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(parts++), roots[2]);
        remaining -= size;
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
    }
    MalValue result = mal_value_new_null();
    if (parts == 1) {
        result = stream_array_at(mal_value_to_array_object(roots[1]), 0);
    } else if (parts > 1 && strings) {
        MalTextBuffer text = {0};
        for (u32 i = 0; i < parts; i++) {
            MalValue part = stream_array_at(mal_value_to_array_object(roots[1]), i);
            if (mal_value_is_string(part)) mal_text_buffer_append_string(&text, mal_value_to_string(part));
        }
        result = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
    } else if (parts > 1) {
        MalValue args[] = {roots[1], mal_value_from_i32(n - remaining)};
        result = stream_buffer_call(vm, vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR], "concat", args, 2);
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_read_core(MalVm *vm, MalValue receiver, MalValue n_value) {
    MalValue roots[] = {receiver, stream_own(vm, receiver, "_readableState"), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_null();
    f64 n = NAN;
    if (!mal_value_is_undefined(n_value)) {
        if (mal_ops_is_number(n_value) && mal_ops_number_as_f64(n_value) == trunc(mal_ops_number_as_f64(n_value))) {
            n = mal_ops_number_as_f64(n_value);
        } else {
            // Number.parseInt(n, 10)
            MalString *text;
            if (!mal_vm_to_string(vm, n_value, &text)) goto done;
            // Base 10 only: "1e3" reads 1 and "0x10" reads 0, unlike strtod.
            const c16 *units = mal_string_code_units(text);
            usize length = mal_string_length(text), at = 0;
            while (at < length && (units[at] == ' ' || (units[at] >= '\t' && units[at] <= '\r') ||
                       units[at] == 0xa0 || units[at] == 0xfeff)) {
                at++;
            }
            bool negative = at < length && units[at] == '-';
            if (at < length && (units[at] == '-' || units[at] == '+')) at++;
            usize start = at;
            f64 value = 0;
            while (at < length && units[at] >= '0' && units[at] <= '9') value = value * 10 + (units[at++] - '0');
            n = at == start ? NAN : (negative ? -value : value);
        }
    }
    f64 n_orig = n;
    i32 hwm = stream_i32_own(vm, roots[1], "highWaterMark", 16384);
    if (n > hwm) {
        if (n > 0x40000000) {
            char message[160];
            snprintf(message, sizeof message,
                "The value of \"size\" is out of range. It must be <= 1GiB. Received %.0f", n);
            mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
            goto done;
        }
        u32 grown = (u32) n - 1;
        grown |= grown >> 1; grown |= grown >> 2; grown |= grown >> 4; grown |= grown >> 8; grown |= grown >> 16;
        hwm = (i32) (grown + 1);
        stream_set(vm, roots[1], "highWaterMark", mal_value_from_i32(hwm));
    }
    if (n != 0) stream_set(vm, roots[1], "emittedReadable", mal_value_new_boolean(false));
    i32 length = stream_i32_own(vm, roots[1], "length", 0);
    bool ended = stream_truthy_own(vm, roots[1], "ended");
    if (n == 0 && stream_truthy_own(vm, roots[1], "needReadable")
        && ((hwm != 0 ? length >= hwm : length > 0) || ended)) {
        if (length == 0 && ended) stream_schedule_readable_end(vm, roots[0]);
        else stream_emit_readable(vm, roots[0]);
        goto done;
    }
    i32 amount = stream_how_much_to_read(vm, roots[0], n);
    if (amount == 0 && ended) {
        if (length == 0) stream_schedule_readable_end(vm, roots[0]);
        goto done;
    }
    bool do_read = stream_truthy_own(vm, roots[1], "needReadable");
    if (length == 0 || length - amount < hwm) do_read = true;
    if (ended || stream_truthy_own(vm, roots[0], "_malReading") || stream_truthy_own(vm, roots[0], "destroyed")
        || mal_value_is_object(stream_own(vm, roots[0], "_malStreamError"))) {
        do_read = false;
    } else if (do_read && stream_get(vm, roots[0], "_read", &roots[2]) && mal_value_is_callable(roots[2])) {
        stream_set(vm, roots[0], "_malReading", mal_value_new_boolean(true));
        stream_set(vm, roots[1], "reading", mal_value_new_boolean(true));
        stream_set(vm, roots[1], "sync", mal_value_new_boolean(true));
        if (length == 0) stream_set(vm, roots[1], "needReadable", mal_value_new_boolean(true));
        MalValue size = mal_value_from_i32(hwm);
        mal_vm_call_value(vm, roots[2], roots[0], &size, 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            roots[3] = vm->completion.value;
            stream_clear_completion(vm);
            stream_destroy(vm, roots[0], &roots[3], 1, mal_value_new_undefined(), mal_value_new_undefined());
        }
        stream_set(vm, roots[1], "sync", mal_value_new_boolean(false));
        if (!stream_truthy_own(vm, roots[0], "_malReading")) amount = stream_how_much_to_read(vm, roots[0], n_orig);
    }
    if (amount > 0) result = stream_from_list(vm, roots[0], amount);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    length = stream_i32_own(vm, roots[1], "length", 0);
    hwm = stream_i32_own(vm, roots[1], "highWaterMark", 16384);
    if (mal_value_is_null(result)) {
        stream_set(vm, roots[1], "needReadable", mal_value_new_boolean(length <= hwm));
        amount = 0;
    } else {
        length -= amount;
        stream_set(vm, roots[1], "length", mal_value_from_i32(length < 0 ? 0 : length));
    }
    if (length <= 0) {
        if (!stream_truthy_own(vm, roots[1], "ended")) stream_set(vm, roots[1], "needReadable", mal_value_new_boolean(true));
        if (n_orig != amount && stream_truthy_own(vm, roots[1], "ended")) stream_schedule_readable_end(vm, roots[0]);
    }
    if (!mal_value_is_null(result)) {
        roots[3] = result;
        stream_pipe_chunk(vm, roots[0], roots[3]);
        if (vm->completion.kind != MAL_COMPLETION_THROW) stream_emit(vm, roots[0], "data", &roots[3], 1);
    }
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue stream_read_method(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    stream_require_readable(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return stream_read_core(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue stream_run_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    MalNativeFunctionObject *task = mal_value_to_native_function_object(callee);
    i32 action = mal_value_to_i32(mal_native_function_object_get_slot(task, 0));
    MalValue stream = mal_native_function_object_get_slot(task, 1);
    if (action == STREAM_TASK_WRITE_DONE) {
        stream_complete_write(
            vm, stream,
            mal_native_function_object_get_slot(task, 2),
            mal_native_function_object_get_slot(task, 3),
            mal_native_function_object_get_slot(task, 4),
            mal_value_to_i32(mal_native_function_object_get_slot(task, 5)),
            mal_value_to_i32(mal_native_function_object_get_slot(task, 6)));
    } else if (action == STREAM_TASK_FINISH) {
        stream_set(vm, stream, "_malFinishScheduled", mal_value_new_boolean(false));
        if (!stream_truthy_own(vm, stream, "destroyed")) {
            stream_emit_finish(vm, stream);
        }
    } else if (action == STREAM_TASK_END_READABLE) {
        stream_set(vm, stream, "_malEndScheduled", mal_value_new_boolean(false));
        if (!stream_truthy_own(vm, stream, "destroyed")) {
            stream_end_readable(vm, stream);
            if (vm->completion.kind != MAL_COMPLETION_THROW && !stream_truthy_own(vm, stream, "destroyed")
                && stream_auto_destroy_after(vm, stream, false))
                stream_destroy(vm, stream, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
        }
    } else if (action == STREAM_TASK_PULL) {
        stream_set(vm, stream, "_malReadScheduled", mal_value_new_boolean(false));
        stream_start_pull(vm, stream);
    } else if (action == STREAM_TASK_EMIT_READABLE) {
        stream_emit_readable_now(vm, stream);
    } else if (action == STREAM_TASK_READ_ZERO) {
        stream_read_core(vm, stream, mal_value_from_i32(0));
    } else if (action == STREAM_TASK_READ_MORE) {
        while (vm->completion.kind != MAL_COMPLETION_THROW && !stream_truthy_own(vm, stream, "_malReading")
            && !stream_state_truthy(vm, stream, "ended")
            && stream_state_i32(vm, stream, "length", 0) < stream_state_i32(vm, stream, "highWaterMark", 16384)) {
            i32 before = stream_state_i32(vm, stream, "length", 0);
            stream_read_core(vm, stream, mal_value_from_i32(0));
            if (before == stream_state_i32(vm, stream, "length", 0)) break;
        }
        stream_state_flag(vm, stream, "readingMore", false);
    }
    return mal_value_new_undefined();
}

typedef struct StreamMethod {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} StreamMethod;

static MalValue stream_function(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
}

enum {
    STREAM_COMPLETION_FINISHED,
    STREAM_COMPLETION_PIPELINE,
};

enum {
    STREAM_LIFECYCLE_END,
    STREAM_LIFECYCLE_FINISH,
    STREAM_LIFECYCLE_ERROR,
    STREAM_LIFECYCLE_CLOSE,
    STREAM_PIPELINE_ERROR,
    STREAM_PIPELINE_CLOSE,
    STREAM_PIPELINE_COMPLETE,
};

static MalValue stream_lifecycle_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee);

static void stream_array_push_value(MalArrayObject *array, MalValue value) {
    mal_array_object_store(
        array, mal_key_index(mal_array_object_length(array)), value);
}

static MalValue stream_new_error(
    MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    mal_vm_throw_error(vm, prototype, (const byte *) message);
    MalValue error = vm->completion.value;
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    stream_clear_completion(vm);
    if (code != nullptr && mal_value_is_object(error)) {
        stream_set(
            vm, error, "code",
            mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) code)));
    }
    mal_gc_unroot(&root);
    return error;
}

static MalValue stream_completion_task(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalRootSpan root;
    mal_gc_root(&root, &state, 1);
    if (stream_truthy_own(vm, state, "called")) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    stream_set(vm, state, "called", mal_value_new_boolean(true));
    stream_set(vm, state, "scheduled", mal_value_new_boolean(false));
    MalValue callback = stream_own(vm, state, "callback");
    MalValue error = stream_own(vm, state, "error");
    bool has_error = stream_truthy_own(vm, state, "hasError");
    i32 mode = stream_i32_own(
        vm, state, "mode", STREAM_COMPLETION_FINISHED);
    MalValue callback_args[] = {
        has_error ? error : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    if (mal_value_is_callable(callback)) {
        if (mode == STREAM_COMPLETION_PIPELINE) {
            mal_vm_call_value(
                vm, callback, mal_value_new_undefined(), callback_args, 2);
        } else {
            mal_vm_call_value(
                vm, callback, mal_value_new_undefined(),
                has_error ? callback_args : nullptr, has_error ? 1 : 0);
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void stream_schedule_completion(
    MalVm *vm, MalValue state, MalValue error, bool has_error) {
    if (stream_truthy_own(vm, state, "called")
        || stream_truthy_own(vm, state, "scheduled")) {
        return;
    }
    MalValue roots[] = {state, error, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "scheduled", mal_value_new_boolean(true));
    stream_set(vm, roots[0], "hasError", mal_value_new_boolean(has_error));
    stream_set(
        vm, roots[0], "error",
        has_error ? roots[1] : mal_value_new_undefined());
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "streamCompletion"),
            stream_completion_task, roots, 1));
    mal_vm_enqueue_reaction_job(
        vm, roots[2], false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    mal_gc_unroot(&root);
}

static bool stream_register_lifecycle_listener(
    MalVm *vm, MalValue state, MalValue stream, const char *event,
    i32 kind, i32 stream_index) {
    MalValue roots[] = {
        state,
        stream,
        mal_value_from_string(
            mal_intrinsic_ascii(vm, (const byte *) event)),
        mal_value_new_undefined(),
        stream_own(vm, state, "registrations"),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue slots[] = {
        roots[0], mal_value_from_i32(kind), mal_value_from_i32(stream_index),
    };
    roots[3] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "streamLifecycle"),
            stream_lifecycle_listener, slots, countof(slots)));
    MalValue on_args[] = {roots[2], roots[3]};
    stream_call_method(vm, roots[1], "on", on_args, 2);
    bool ok = vm->completion.kind != MAL_COMPLETION_THROW;
    if (ok && mal_value_is_array_object(roots[4])) {
        MalArrayObject *registrations = mal_value_to_array_object(roots[4]);
        stream_array_push_value(registrations, roots[1]);
        stream_array_push_value(registrations, roots[2]);
        stream_array_push_value(registrations, roots[3]);
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalValue stream_cleanup_finished(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    MalValue roots[] = {
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = stream_own(vm, roots[0], "registrations");
    if (mal_value_is_array_object(roots[1])) {
        MalArrayObject *registrations = mal_value_to_array_object(roots[1]);
        u32 length = mal_array_object_length(registrations);
        for (u32 i = 0; i + 2 < length; i += 3) {
            roots[2] = stream_array_at(registrations, i);
            MalValue remove_args[] = {
                stream_array_at(registrations, i + 1),
                stream_array_at(registrations, i + 2),
            };
            stream_call_method(vm, roots[2], "removeListener", remove_args, 2);
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[3] = stream_new_array(vm);
        stream_set(vm, roots[0], "registrations", roots[3]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool stream_option_enabled(
    MalVm *vm, MalValue options, const char *name, bool fallback) {
    if (mal_value_is_nil(options)) return fallback;
    MalValue value = stream_option(vm, options, name);
    return vm->completion.kind != MAL_COMPLETION_THROW
        && (!mal_value_is_boolean(value) || mal_value_to_boolean(value));
}

static bool stream_finished_common(
    MalVm *vm, MalValue stream, MalValue options, MalValue callback,
    MalValue *cleanup_out) {
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The callback argument must be a function");
        return false;
    }
    if (!mal_value_is_nil(options) && !mal_value_is_object(options)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The options argument must be an object");
        return false;
    }
    bool has_readable = stream_is_readable(vm, stream);
    bool has_writable = stream_is_writable(vm, stream);
    if (!has_readable && !has_writable) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The stream argument must be a Node.js stream");
        return false;
    }
    bool readable = has_readable
        && stream_option_enabled(vm, options, "readable", true);
    bool writable = has_writable
        && stream_option_enabled(vm, options, "writable", true);
    bool monitor_error = stream_option_enabled(vm, options, "error", true);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;

    MalValue roots[] = {
        stream, options, callback, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[4] = stream_new_array(vm);
    stream_set(vm, roots[3], "callback", roots[2]);
    stream_set(vm, roots[3], "registrations", roots[4]);
    stream_set(vm, roots[3], "mode",
               mal_value_from_i32(STREAM_COMPLETION_FINISHED));
    stream_set(vm, roots[3], "called", mal_value_new_boolean(false));
    stream_set(vm, roots[3], "scheduled", mal_value_new_boolean(false));
    stream_set(vm, roots[3], "readable", mal_value_new_boolean(readable));
    stream_set(vm, roots[3], "writable", mal_value_new_boolean(writable));
    stream_set(
        vm, roots[3], "readableDone",
        mal_value_new_boolean(!readable
            || stream_truthy_own(vm, roots[0], "readableEnded")));
    stream_set(
        vm, roots[3], "writableDone",
        mal_value_new_boolean(!writable
            || stream_truthy_own(vm, roots[0], "writableFinished")));

    bool ok = (!readable || stream_register_lifecycle_listener(
                   vm, roots[3], roots[0], "end", STREAM_LIFECYCLE_END, 0))
        && (!writable || stream_register_lifecycle_listener(
                   vm, roots[3], roots[0], "finish", STREAM_LIFECYCLE_FINISH, 0))
        && (!monitor_error || stream_register_lifecycle_listener(
                   vm, roots[3], roots[0], "error", STREAM_LIFECYCLE_ERROR, 0))
        && stream_register_lifecycle_listener(
            vm, roots[3], roots[0], "close", STREAM_LIFECYCLE_CLOSE, 0);
    if (ok) {
        MalValue slot = roots[3];
        roots[5] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots_arity(
                &vm->heap,
                mal_value_to_object(
                    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_static_ascii(vm, (const byte *) "cleanup"), 0,
                stream_cleanup_finished, &slot, 1));
        if (cleanup_out != nullptr) *cleanup_out = roots[5];
        bool done = stream_truthy_own(vm, roots[3], "readableDone")
            && stream_truthy_own(vm, roots[3], "writableDone");
        if (done) {
            stream_schedule_completion(
                vm, roots[3], mal_value_new_undefined(), false);
        } else if (stream_truthy_own(vm, roots[0], "destroyed")) {
            MalValue error = stream_new_error(
                vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Premature close", "ERR_STREAM_PREMATURE_CLOSE");
            stream_schedule_completion(vm, roots[3], error, true);
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

static MalValue stream_finished(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue stream = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options = argc > 2 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2
        ? args[2]
        : (argc > 1 ? args[1] : mal_value_new_undefined());
    MalValue cleanup = mal_value_new_undefined();
    if (!stream_finished_common(vm, stream, options, callback, &cleanup)) {
        return mal_value_new_undefined();
    }
    return cleanup;
}

static bool stream_pipeline_role_complete(
    MalVm *vm, MalValue stream, i32 index, i32 count) {
    return (index >= count - 1
            || stream_truthy_own(vm, stream, "readableEnded"))
        && (index <= 0
            || stream_truthy_own(vm, stream, "writableFinished"));
}

static void stream_pipeline_fail(
    MalVm *vm, MalValue state, MalValue error) {
    if (stream_truthy_own(vm, state, "called")
        || stream_truthy_own(vm, state, "scheduled")) {
        return;
    }
    MalValue roots[] = {
        state, error, stream_own(vm, state, "streams"),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_schedule_completion(vm, roots[0], roots[1], true);
    if (mal_value_is_array_object(roots[2])) {
        MalArrayObject *streams = mal_value_to_array_object(roots[2]);
        u32 length = mal_array_object_length(streams);
        for (u32 i = 0; i < length; i++) {
            roots[3] = stream_array_at(streams, i);
            if (mal_value_is_object(roots[3])
                && !stream_truthy_own(vm, roots[3], "destroyed")) {
                stream_destroy(
                    vm, roots[3], roots + 1, 1,
                    mal_value_new_undefined(), mal_value_new_undefined());
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    stream_clear_completion(vm);
                }
            }
        }
    }
    mal_gc_unroot(&root);
}

static MalValue stream_lifecycle_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalNativeFunctionObject *listener =
        mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(listener, 0),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (stream_truthy_own(vm, roots[0], "called")
        || stream_truthy_own(vm, roots[0], "scheduled")) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    i32 kind = mal_value_to_i32(
        mal_native_function_object_get_slot(listener, 1));
    if (kind == STREAM_LIFECYCLE_END) {
        stream_set(vm, roots[0], "readableDone", mal_value_new_boolean(true));
    } else if (kind == STREAM_LIFECYCLE_FINISH) {
        stream_set(vm, roots[0], "writableDone", mal_value_new_boolean(true));
    } else if (kind == STREAM_LIFECYCLE_ERROR) {
        stream_schedule_completion(vm, roots[0], roots[1], true);
    } else if (kind == STREAM_LIFECYCLE_CLOSE) {
        bool done = stream_truthy_own(vm, roots[0], "readableDone")
            && stream_truthy_own(vm, roots[0], "writableDone");
        if (!done) {
            roots[2] = stream_new_error(
                vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Premature close", "ERR_STREAM_PREMATURE_CLOSE");
            stream_schedule_completion(vm, roots[0], roots[2], true);
        }
    } else if (kind == STREAM_PIPELINE_ERROR) {
        stream_pipeline_fail(vm, roots[0], roots[1]);
    } else if (kind == STREAM_PIPELINE_CLOSE) {
        i32 index = mal_value_to_i32(
            mal_native_function_object_get_slot(listener, 2));
        roots[2] = stream_own(vm, roots[0], "streams");
        i32 count = mal_value_is_array_object(roots[2])
            ? (i32) mal_array_object_length(mal_value_to_array_object(roots[2]))
            : 0;
        MalValue stream = count > index
            ? stream_array_at(mal_value_to_array_object(roots[2]), (u32) index)
            : mal_value_new_undefined();
        if (!stream_pipeline_role_complete(vm, stream, index, count)) {
            MalValue error = stream_new_error(
                vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Premature close", "ERR_STREAM_PREMATURE_CLOSE");
            stream_pipeline_fail(vm, roots[0], error);
        }
    } else if (kind == STREAM_PIPELINE_COMPLETE) {
        stream_schedule_completion(
            vm, roots[0], mal_value_new_undefined(), false);
    }
    if ((kind == STREAM_LIFECYCLE_END || kind == STREAM_LIFECYCLE_FINISH)
        && stream_truthy_own(vm, roots[0], "readableDone")
        && stream_truthy_own(vm, roots[0], "writableDone")) {
        stream_schedule_completion(
            vm, roots[0], mal_value_new_undefined(), false);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool stream_prototype_chain_has(MalValue value, MalValue prototype) {
    if (!mal_value_is_object(value) || !mal_value_is_object(prototype)) return false;
    for (MalObject *cursor = mal_object_get_prototype(mal_value_to_object(value)); cursor != nullptr;
         cursor = mal_object_get_prototype(cursor)) {
        if (cursor == mal_value_to_object(prototype)) return true;
    }
    return false;
}

/* A stage qualifies by its state ([[Get]], as Node checks) or, for lazily initialized
 * streams such as crypto Hash whose state appears on first stream method call, by
 * inheriting the Readable/Writable prototypes. */
static bool stream_has_state(MalVm *vm, MalValue value, const char *name) {
    MalValue state = mal_value_new_undefined();
    if (mal_value_is_object(value) && stream_get(vm, value, name, &state) && mal_value_is_object(state)) return true;
    if (strcmp(name, "_readableState") == 0) {
        return stream_prototype_chain_has(value, vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_PROTOTYPE]);
    }
    return stream_prototype_chain_has(value, vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE])
        || stream_prototype_chain_has(value, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_PROTOTYPE]);
}

static bool stream_collect_pipeline_streams(
    MalVm *vm, const MalValue *args, i32 argc, MalValue *out) {
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    i32 count = argc;
    MalArrayObject *input = nullptr;
    if (argc == 1 && mal_value_is_array_object(args[0])) {
        input = mal_value_to_array_object(args[0]);
        count = (i32) mal_array_object_length(input);
    }
    if (count < 2) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The streams argument must contain at least two streams");
        mal_gc_unroot(&root);
        return false;
    }
    roots[0] = mal_value_from_array_object(
        mal_intrinsic_new_dense_array(vm, (u32) count));
    MalArrayObject *streams = mal_value_to_array_object(roots[0]);
    for (i32 i = 0; i < count; i++) {
        roots[1] = input != nullptr
            ? stream_array_at(input, (u32) i)
            : args[i];
        // Node checks through [[Get]], so a lazily initialized stream initializes here.
        bool readable_stage = stream_has_state(vm, roots[1], "_readableState");
        bool writable_stage = stream_has_state(vm, roots[1], "_writableState");
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return false;
        }
        bool valid = i == 0
            ? readable_stage
            : (i == count - 1 ? writable_stage : readable_stage && writable_stage);
        if (!valid) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Each pipeline stage must be a compatible Node.js stream");
            mal_gc_unroot(&root);
            return false;
        }
        mal_array_object_store(streams, mal_key_index((u32) i), roots[1]);
    }
    *out = roots[0];
    mal_gc_unroot(&root);
    return true;
}

static MalValue stream_pipeline_common(
    MalVm *vm, const MalValue *args, i32 argc, MalValue callback) {
    MalValue roots[] = {
        mal_value_new_undefined(), callback, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_collect_pipeline_streams(vm, args, argc, roots)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = stream_new_array(vm);
    MalArrayObject *streams = mal_value_to_array_object(roots[0]);
    i32 count = (i32) mal_array_object_length(streams);
    roots[4] = stream_array_at(streams, (u32) count - 1);
    stream_set(vm, roots[2], "callback", roots[1]);
    stream_set(vm, roots[2], "streams", roots[0]);
    stream_set(vm, roots[2], "registrations", roots[3]);
    stream_set(vm, roots[2], "mode",
               mal_value_from_i32(STREAM_COMPLETION_PIPELINE));
    stream_set(vm, roots[2], "called", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "scheduled", mal_value_new_boolean(false));

    bool ok = true;
    for (i32 i = 0; i < count && ok; i++) {
        roots[5] = stream_array_at(streams, (u32) i);
        ok = stream_register_lifecycle_listener(
            vm, roots[2], roots[5], "error", STREAM_PIPELINE_ERROR, i)
            && stream_register_lifecycle_listener(
                vm, roots[2], roots[5], "close", STREAM_PIPELINE_CLOSE, i);
    }
    if (ok) {
        ok = stream_register_lifecycle_listener(
            vm, roots[2], roots[4], "finish", STREAM_PIPELINE_COMPLETE,
            count - 1);
    }
    for (i32 i = 0; i + 1 < count && ok; i++) {
        roots[5] = stream_array_at(streams, (u32) i);
        roots[6] = stream_array_at(streams, (u32) i + 1);
        MalCompletion completion = stream_call_method(
            vm, roots[5], "pipe", roots + 6, 1);
        if (completion.kind == MAL_COMPLETION_THROW) {
            roots[6] = completion.value;
            stream_clear_completion(vm);
            stream_pipeline_fail(vm, roots[2], roots[6]);
            break;
        }
    }
    if (ok && stream_truthy_own(vm, roots[4], "writableFinished")) {
        stream_schedule_completion(
            vm, roots[2], mal_value_new_undefined(), false);
    }
    MalValue result = roots[4];
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_slot_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 count);
static bool stream_is_node_stream(MalVm *vm, MalValue value);
static bool stream_has_state(MalVm *vm, MalValue value, const char *name);
static MalValue df_duplexify(MalVm *vm, MalValue body, const char *name);
static MalValue stream_finished(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee);

/* pipeline() with function and iterable stages, translated from Node 26
 * lib/internal/streams/pipeline.js (pipelineImpl, finishImpl, pumpToNode). Pure Node
 * stream pipelines keep the pipe-based path above. State lives on one object: the
 * callback, first error, final value, outstanding finish count, the stream stages to
 * destroy on error, and the AbortController whose signal function stages receive. */
static bool pl_is_iterable(MalVm *vm, MalValue value, i32 which) {
    if (!mal_value_is_object(value) && !mal_value_is_string(value)) return false;
    MalValue method = mal_value_new_undefined();
    if (which != 2) {
        mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &method);
        if (mal_value_is_callable(method)) return true;
        if (which == 1) return false;
    }
    mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method);
    return mal_value_is_callable(method);
}

static bool pl_has_method(MalVm *vm, MalValue value, const char *name) {
    MalValue method = mal_value_new_undefined();
    return mal_value_is_object(value) && stream_get(vm, value, name, &method) && mal_value_is_callable(method);
}

/* lib/internal/streams/utils.js duck typing for web streams. The runtime's own
 * ReadableStream/WritableStream are recognized by brand first, since their native
 * implementation may expose Node-stream-like fields. */
static bool pl_is_runtime_web_stream(MalVm *vm, MalValue value) {
    return mal_value_is_readable_stream_object(value)
        || stream_prototype_chain_has(value, vm->intrinsics[MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE]);
}

static bool pl_is_web_readable(MalVm *vm, MalValue value) {
    if (mal_value_is_readable_stream_object(value)) return true;
    return mal_value_is_object(value) && !stream_is_node_stream(vm, value) && pl_has_method(vm, value, "pipeThrough")
        && pl_has_method(vm, value, "getReader") && pl_has_method(vm, value, "cancel");
}

static bool pl_is_web_writable(MalVm *vm, MalValue value) {
    if (stream_prototype_chain_has(value, vm->intrinsics[MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE])) return true;
    return mal_value_is_object(value) && !stream_is_node_stream(vm, value) && pl_has_method(vm, value, "getWriter")
        && pl_has_method(vm, value, "abort");
}

static bool pl_is_web_transform(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value) || pl_is_runtime_web_stream(vm, value)) return false;
    MalValue roots[] = {value, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_get(vm, roots[0], "readable", &roots[1]);
    stream_get(vm, roots[0], "writable", &roots[2]);
    bool branded = mal_value_is_readable_stream_object(roots[1])
        && stream_prototype_chain_has(roots[2], vm->intrinsics[MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE]);
    bool result = branded || (!stream_is_node_stream(vm, roots[0]) && mal_value_is_object(roots[1])
        && !mal_value_is_callable(roots[1]) && mal_value_is_object(roots[2]) && !mal_value_is_callable(roots[2]));
    mal_gc_unroot(&root);
    return result;
}

static MalValue pl_slot(MalValue callee, i32 index) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), index);
}

static MalValue pl_invoke_callback(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,
    MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = pl_slot(callee, 0);
    MalValue roots[] = {stream_own(vm, state, "callback"), stream_own(vm, state, "error"), stream_own(vm, state, "value")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue call_args[] = {mal_value_is_undefined(roots[1]) ? mal_value_new_undefined() : roots[1], roots[2]};
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), call_args, 2);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void pl_finish_impl(MalVm *vm, MalValue state, MalValue error, bool final) {
    MalValue roots[] = {state, error, stream_own(vm, state, "error"), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_truthy(roots[1])) {
        bool premature = false;
        if (mal_value_is_object(roots[2])) {
            MalValue code = stream_own(vm, roots[2], "code");
            premature = mal_value_is_string(code) && mal_string_equals_ascii(mal_value_to_string(code), "ERR_STREAM_PREMATURE_CLOSE");
        }
        if (!mal_value_is_truthy(roots[2]) || premature) {
            stream_set(vm, roots[0], "error", roots[1]);
            roots[2] = roots[1];
        }
    }
    if ((!mal_value_is_truthy(roots[2]) && !final) || stream_truthy_own(vm, roots[0], "called")) {
        mal_gc_unroot(&root);
        return;
    }
    roots[3] = stream_own(vm, roots[0], "destroys");
    if (mal_value_is_truthy(roots[2]) && !stream_truthy_own(vm, roots[0], "destroyed")) {
        stream_set(vm, roots[0], "destroyed", mal_value_new_boolean(true));
        for (u32 i = 0; i < mal_array_object_length(mal_value_to_array_object(roots[3])); i++) {
            MalValue target = stream_array_at(mal_value_to_array_object(roots[3]), i);
            if (stream_truthy_own(vm, target, "destroyed")) continue;
            MalValue destroy_args[] = {roots[2]};
            stream_call_method(vm, target, "destroy", destroy_args, 1);
            stream_clear_completion(vm);
        }
    }
    MalValue controller = stream_own(vm, roots[0], "controller");
    if (mal_value_is_object(controller)) {
        stream_call_method(vm, controller, "abort", nullptr, 0);
        stream_clear_completion(vm);
    }
    if (final) {
        stream_set(vm, roots[0], "called", mal_value_new_boolean(true));
        MalValue task = stream_slot_function(vm, "pipelineCallback", 0, pl_invoke_callback, &roots[0], 1);
        mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
}

static MalValue pl_finish(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    i32 remaining = stream_i32_own(vm, state, "finishCount", 0) - 1;
    stream_set(vm, state, "finishCount", mal_value_from_i32(remaining));
    pl_finish_impl(vm, state, argc > 0 ? args[0] : mal_value_new_undefined(), remaining == 0);
    return mal_value_new_undefined();
}

static MalValue pl_finish_function(MalVm *vm, MalValue state) {
    stream_set(vm, state, "finishCount", mal_value_from_i32(stream_i32_own(vm, state, "finishCount", 0) + 1));
    return stream_slot_function(vm, "finish", 1, pl_finish, &state, 1);
}

static void pl_pump_step(MalVm *vm, MalValue pump);
static MalValue pl_web_abort(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee);

static MalValue pl_pump_continue(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    pl_pump_step(vm, pl_slot(callee, 0));
    return mal_value_new_undefined();
}

static MalValue pl_pump_fail(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue pump = pl_slot(callee, 0);
    if (stream_truthy_own(vm, pump, "web")) return pl_web_abort(vm, self, args, argc, nt, callee);
    MalValue roots[] = {pump, argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue writable = stream_own(vm, roots[0], "writable");
    if (!stream_truthy_own(vm, writable, "destroyed")) {
        stream_call_method(vm, writable, "destroy", &roots[1], 1);
        stream_clear_completion(vm);
    }
    pl_finish_impl(vm, stream_own(vm, roots[0], "state"), roots[1], false);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_noop(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    return mal_value_new_undefined();
}

/* Runs `then` once writer.ready settles; a rejected ready aborts the pump. */
static void pl_web_after_ready(MalVm *vm, MalValue pump, MalValue then) {
    MalValue roots[] = {pump, then, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_get(vm, stream_own(vm, roots[0], "writer"), "ready", &roots[2]);
    roots[3] = stream_slot_function(vm, "", 1, pl_web_abort, &roots[0], 1);
    MalValue then_args[] = {roots[1], roots[3]};
    MalCompletion chained = stream_call_method(vm, roots[2], "then", then_args, 2);
    if (chained.kind == MAL_COMPLETION_THROW) {
        roots[2] = chained.value;
        stream_clear_completion(vm);
        pl_web_abort(vm, mal_value_new_undefined(), &roots[2], 1, mal_value_new_undefined(), roots[3]);
    }
    mal_gc_unroot(&root);
}

static MalValue pl_web_write_ready(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = stream_own(vm, roots[0], "chunk");
    MalCompletion written = stream_call_method(vm, stream_own(vm, roots[0], "writer"), "write", &roots[1], 1);
    if (written.kind == MAL_COMPLETION_THROW) {
        roots[1] = written.value;
        stream_clear_completion(vm);
        pl_web_abort(vm, mal_value_new_undefined(), &roots[1], 1, mal_value_new_undefined(), callee);
    } else {
        roots[2] = stream_function(vm, "", 0, pl_noop);
        stream_call_method(vm, written.value, "catch", &roots[2], 1);
        stream_clear_completion(vm);
        pl_pump_step(vm, roots[0]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_web_closed(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue finish = stream_own(vm, pl_slot(callee, 0), "finish");
    if (mal_value_is_callable(finish)) mal_vm_call_value(vm, finish, mal_value_new_undefined(), nullptr, 0);
    return mal_value_new_undefined();
}

static MalValue pl_web_done_ready(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_truthy_own(vm, roots[0], "end")) {
        pl_web_closed(vm, mal_value_new_undefined(), nullptr, 0, mal_value_new_undefined(), callee);
    } else {
        MalCompletion closed = stream_call_method(vm, stream_own(vm, roots[0], "writer"), "close", nullptr, 0);
        roots[1] = stream_slot_function(vm, "", 0, pl_web_closed, &roots[0], 1);
        roots[2] = stream_slot_function(vm, "", 1, pl_web_abort, &roots[0], 1);
        if (closed.kind == MAL_COMPLETION_THROW) {
            MalValue error = closed.value;
            stream_clear_completion(vm);
            mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &error, 1);
        } else {
            MalValue then_args[] = {roots[1], roots[2]};
            stream_call_method(vm, closed.value, "then", then_args, 2);
            stream_clear_completion(vm);
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* catch (err) { await writer.abort(err); finish(err) }: the abort outcome is not awaited here. */
static MalValue pl_web_abort(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_truthy_own(vm, roots[0], "aborted")) {
        stream_set(vm, roots[0], "aborted", mal_value_new_boolean(true));
        MalCompletion aborted = stream_call_method(vm, stream_own(vm, roots[0], "writer"), "abort", &roots[1], 1);
        if (aborted.kind == MAL_COMPLETION_THROW) stream_clear_completion(vm);
        else {
            MalValue noop = stream_function(vm, "", 0, pl_noop);
            stream_call_method(vm, aborted.value, "catch", &noop, 1);
            stream_clear_completion(vm);
        }
        MalValue finish = stream_own(vm, roots[0], "finish");
        if (mal_value_is_callable(finish)) mal_vm_call_value(vm, finish, mal_value_new_undefined(), &roots[1], 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_pump_result(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue writable = stream_own(vm, roots[0], "writable");
    MalValue done = mal_value_new_undefined();
    if (!mal_value_is_object(roots[1])) {
        roots[2] = stream_new_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object",
            "ERR_INVALID_RETURN_VALUE");
        pl_pump_fail(vm, mal_value_new_undefined(), &roots[2], 1, mal_value_new_undefined(), callee);
        goto done;
    }
    stream_get(vm, roots[1], "done", &done);
    if (mal_value_is_truthy(done) && stream_truthy_own(vm, roots[0], "web")) {
        roots[3] = stream_slot_function(vm, "", 0, pl_web_done_ready, &roots[0], 1);
        pl_web_after_ready(vm, roots[0], roots[3]);
        goto done;
    }
    if (mal_value_is_truthy(done)) {
        if (stream_truthy_own(vm, roots[0], "end")) {
            stream_call_method(vm, writable, "end", nullptr, 0);
        } else {
            MalValue finish = stream_own(vm, roots[0], "finish");
            if (mal_value_is_callable(finish)) mal_vm_call_value(vm, finish, mal_value_new_undefined(), nullptr, 0);
        }
        goto done;
    }
    stream_get(vm, roots[1], "value", &roots[2]);
    if (stream_truthy_own(vm, roots[0], "web")) {
        // pumpToWeb: await writer.ready, then write without awaiting the write itself.
        stream_set(vm, roots[0], "chunk", roots[2]);
        roots[3] = stream_slot_function(vm, "", 0, pl_web_write_ready, &roots[0], 1);
        pl_web_after_ready(vm, roots[0], roots[3]);
        goto done;
    }
    MalCompletion written = stream_call_method(vm, writable, "write", &roots[2], 1);
    if (written.kind == MAL_COMPLETION_THROW) {
        roots[2] = written.value;
        stream_clear_completion(vm);
        pl_pump_fail(vm, mal_value_new_undefined(), &roots[2], 1, mal_value_new_undefined(), callee);
        goto done;
    }
    roots[3] = stream_slot_function(vm, "", 0, pl_pump_continue, &roots[0], 1);
    if (mal_value_is_truthy(written.value)) {
        mal_vm_enqueue_reaction_job(vm, roots[3], false, mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined());
    } else {
        MalValue once_args[] = {mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "drain")), roots[3]};
        stream_call_method(vm, writable, "once", once_args, 2);
    }
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_pump_result(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee);

static MalValue pl_pump_sync_value(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,
    MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[1], "value", roots[0]);
    stream_set(vm, roots[1], "done", mal_value_new_boolean(false));
    pl_pump_result(vm, mal_value_new_undefined(), &roots[1], 1, mal_value_new_undefined(), callee);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void pl_pump_step(MalVm *vm, MalValue pump) {
    MalValue roots[] = {pump, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (stream_truthy_own(vm, stream_own(vm, roots[0], "state"), "destroyed")) goto done;
    MalCompletion next = stream_call_method(vm, stream_own(vm, roots[0], "iterator"), "next", nullptr, 0);
    MalValue result_fn = stream_slot_function(vm, "", 1, pl_pump_result, &roots[0], 1);
    roots[2] = result_fn;
    roots[3] = stream_slot_function(vm, "", 1, pl_pump_fail, &roots[0], 1);
    if (next.kind == MAL_COMPLETION_THROW) {
        roots[1] = next.value;
        stream_clear_completion(vm);
        mal_vm_call_value(vm, roots[3], mal_value_new_undefined(), &roots[1], 1);
        goto done;
    }
    roots[1] = next.value;
    // for await: every step (sync iterators included) resumes after a promise settles.
    MalValue resolved = mal_value_new_undefined();
    MalValue resolve_args[] = {roots[1]};
    MalValue promise_constructor = vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR];
    if (stream_truthy_own(vm, roots[0], "sync")) {
        stream_get(vm, roots[1], "value", &resolve_args[0]);
        MalValue done_value = mal_value_new_undefined();
        stream_get(vm, roots[1], "done", &done_value);
        if (mal_value_is_truthy(done_value)) {
            mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
            goto done;
        }
    }
    MalCompletion as_promise = stream_call_method(vm, promise_constructor, "resolve", resolve_args, 1);
    if (as_promise.kind == MAL_COMPLETION_THROW) {
        roots[1] = as_promise.value;
        stream_clear_completion(vm);
        mal_vm_call_value(vm, roots[3], mal_value_new_undefined(), &roots[1], 1);
        goto done;
    }
    resolved = as_promise.value;
    if (stream_truthy_own(vm, roots[0], "sync")) {
        // The awaited value becomes a {value, done:false} step result.
        roots[1] = resolved;
        roots[2] = stream_slot_function(vm, "", 1, pl_pump_sync_value, &roots[0], 1);
    }
    MalValue then_args[] = {roots[2], roots[3]};
    stream_call_method(vm, resolved, "then", then_args, 2);
    stream_clear_completion(vm);
done:
    mal_gc_unroot(&root);
}

static void pl_start_pump_into(MalVm *vm, MalValue state, MalValue iterable, MalValue writable, bool end, bool web);

static void pl_start_pump(MalVm *vm, MalValue state, MalValue iterable, MalValue writable, bool end) {
    pl_start_pump_into(vm, state, iterable, writable, end, false);
}

static void pl_start_pump_into(MalVm *vm, MalValue state, MalValue iterable, MalValue writable, bool end, bool web) {
    MalValue roots[] = {state, iterable, writable, mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool sync = !pl_is_iterable(vm, roots[1], 1);
    MalValue method = mal_value_new_undefined();
    mal_vm_get_property(vm, roots[1], mal_intrinsic_symbol_key(vm,
        sync ? MAL_INTRINSIC_SYMBOL_ITERATOR : MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &method);
    MalCompletion iterator = mal_vm_call_value(vm, method, roots[1], nullptr, 0);
    if (iterator.kind == MAL_COMPLETION_THROW) {
        roots[4] = iterator.value;
        stream_clear_completion(vm);
        pl_finish_impl(vm, roots[0], roots[4], false);
        mal_gc_unroot(&root);
        return;
    }
    stream_set(vm, roots[3], "iterator", iterator.value);
    stream_set(vm, roots[3], "state", roots[0]);
    stream_set(vm, roots[3], "writable", roots[2]);
    stream_set(vm, roots[3], "end", mal_value_new_boolean(end));
    stream_set(vm, roots[3], "sync", mal_value_new_boolean(sync));
    if (web) {
        // pumpToWeb writes through a writer of the WritableStream (a TransformStream's writable side).
        MalValue target = roots[2];
        if (pl_is_web_transform(vm, target)) stream_get(vm, target, "writable", &target);
        MalCompletion writer = stream_call_method(vm, target, "getWriter", nullptr, 0);
        if (writer.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return;
        }
        stream_set(vm, roots[3], "writer", writer.value);
        stream_set(vm, roots[3], "web", mal_value_new_boolean(true));
        stream_set(vm, roots[3], "finish", pl_finish_function(vm, roots[0]));
    } else if (!end) {
        stream_set(vm, roots[3], "finish", pl_finish_function(vm, roots[0]));
    }
    pl_pump_step(vm, roots[3]);
    mal_gc_unroot(&root);
}

static MalValue pl_run_finish(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue error = pl_slot(callee, 1);
    mal_vm_call_value(vm, pl_slot(callee, 0), mal_value_new_undefined(), &error, mal_value_is_undefined(error) ? 0 : 1);
    return mal_value_new_undefined();
}

static void pl_next_tick_finish(MalVm *vm, MalValue finish, MalValue error) {
    MalValue slots[] = {finish, error};
    MalValue task = stream_slot_function(vm, "", 0, pl_run_finish, slots, 2);
    mal_vm_enqueue_reaction_job(vm, task, false, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
}

/* Slots: state, the PassThrough destination, finish, end. */
static MalValue pl_consumer_fulfilled(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,
    MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), pl_slot(callee, 1), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "value", roots[2]);
    if (!mal_value_is_nil(roots[2])) stream_call_method(vm, roots[1], "write", &roots[2], 1);
    if (mal_value_is_truthy(pl_slot(callee, 3))) stream_call_method(vm, roots[1], "end", nullptr, 0);
    stream_clear_completion(vm);
    pl_next_tick_finish(vm, pl_slot(callee, 2), mal_value_new_undefined());
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_consumer_rejected(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,
    MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 1), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_call_method(vm, roots[0], "destroy", &roots[1], 1);
    stream_clear_completion(vm);
    pl_next_tick_finish(vm, pl_slot(callee, 2), roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue pl_outer_abort(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = pl_slot(callee, 0);
    pl_finish_impl(vm, state, mal_node_abort_error(vm, mal_value_new_undefined()), false);
    return mal_value_new_undefined();
}

static void pl_throw_return_value(MalVm *vm, const char *input, const char *name, MalValue value) {
    char received[256];
    mal_node_describe_received(vm, value, received, sizeof received);
    char message[512];
    snprintf(message, sizeof message, "Expected %s to be returned from the \"%s\" function but got %s.", input, name,
        received);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_RETURN_VALUE");
}

static MalValue pl_signal_options(MalVm *vm, MalValue signal) {
    MalValue roots[] = {signal, mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[1], "signal", roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

/* pipelineImpl for a stage list that contains functions or plain iterables. */
static MalValue pl_pipeline(MalVm *vm, MalValue stages, MalValue callback, bool end_option, MalValue outer_signal) {
    MalValue roots[] = {stages, callback, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    stream_set(vm, roots[2], "callback", roots[1]);
    stream_set(vm, roots[2], "finishCount", mal_value_from_i32(0));
    stream_set(vm, roots[2], "destroys", stream_new_array(vm));
    MalCompletion controller = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR], nullptr, 0);
    if (controller.kind == MAL_COMPLETION_THROW) goto done;
    stream_set(vm, roots[2], "controller", controller.value);
    stream_get(vm, controller.value, "signal", &roots[3]);
    if (mal_value_is_object(outer_signal)) {
        roots[4] = stream_slot_function(vm, "abort", 0, pl_outer_abort, &roots[2], 1);
        if (mal_abort_signal_is_aborted(outer_signal)) pl_next_tick_finish(vm, roots[4], mal_value_new_undefined());
        else mal_abort_signal_add_algorithm(outer_signal, roots[4]);
    }
    u32 count = mal_array_object_length(mal_value_to_array_object(roots[0]));
    for (u32 i = 0; i < count && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        roots[4] = stream_array_at(mal_value_to_array_object(roots[0]), i);
        bool reading = i + 1 < count;
        bool writing = i > 0;
        bool end = reading || end_option;
        bool node_stream = stream_is_node_stream(vm, roots[4]) && !pl_is_runtime_web_stream(vm, roots[4]);
        // With end: false the last stream never finishes; its feeding edge reports completion.
        if (node_stream && (reading || (writing && end))) {
            MalValue destroys = stream_own(vm, roots[2], "destroys");
            mal_array_object_store(mal_value_to_array_object(destroys),
                mal_key_index(mal_array_object_length(mal_value_to_array_object(destroys))), roots[4]);
            roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
            stream_set(vm, roots[5], "readable", mal_value_new_boolean(reading));
            stream_set(vm, roots[5], "writable", mal_value_new_boolean(writing && end));
            roots[6] = pl_finish_function(vm, roots[2]);
            MalValue eos_args[] = {roots[4], roots[5], roots[6]};
            stream_finished(vm, mal_value_new_undefined(), eos_args, 3, mal_value_new_undefined(), mal_value_new_undefined());
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
        if (i == 0) {
            if (mal_value_is_callable(roots[4])) {
                roots[5] = pl_signal_options(vm, roots[3]);
                MalCompletion called = mal_vm_call_value(vm, roots[4], mal_value_new_undefined(), &roots[5], 1);
                if (called.kind == MAL_COMPLETION_THROW) break;
                roots[7] = called.value;
                if (!pl_is_iterable(vm, roots[7], 0)) {
                    pl_throw_return_value(vm, "Iterable, AsyncIterable or Stream", "source", roots[7]);
                    break;
                }
            } else if (pl_is_iterable(vm, roots[4], 0) || stream_has_state(vm, roots[4], "_readableState")
                || pl_is_web_transform(vm, roots[4])) {
                roots[7] = roots[4];
            } else {
                roots[7] = df_duplexify(vm, roots[4], "body");
                if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            }
        } else if (mal_value_is_callable(roots[4])) {
            if (pl_is_web_transform(vm, roots[7])) stream_get(vm, roots[7], "readable", &roots[7]);
            MalValue call_args[] = {roots[7], pl_signal_options(vm, roots[3])};
            roots[5] = call_args[1];
            MalCompletion called = mal_vm_call_value(vm, roots[4], mal_value_new_undefined(), call_args, 2);
            if (called.kind == MAL_COMPLETION_THROW) break;
            roots[7] = called.value;
            if (reading) {
                if (!pl_is_iterable(vm, roots[7], 1)) {
                    char name[32];
                    snprintf(name, sizeof name, "transform[%u]", i - 1);
                    pl_throw_return_value(vm, "AsyncIterable", name, roots[7]);
                    break;
                }
            } else {
                roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
                stream_set(vm, roots[5], "objectMode", mal_value_new_boolean(true));
                MalValue pass_through = mal_value_new_undefined();
                stream_get(vm, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR], "PassThrough", &pass_through);
                MalCompletion pass = mal_vm_construct_value(vm, pass_through, &roots[5], 1);
                if (pass.kind == MAL_COMPLETION_THROW) break;
                roots[8] = pass.value;
                MalValue destroys = stream_own(vm, roots[2], "destroys");
                mal_array_object_store(mal_value_to_array_object(destroys),
                    mal_key_index(mal_array_object_length(mal_value_to_array_object(destroys))), roots[8]);
                MalValue then = mal_value_new_undefined();
                if (mal_value_is_object(roots[7])) stream_get(vm, roots[7], "then", &then);
                if (mal_value_is_callable(then)) {
                    roots[6] = pl_finish_function(vm, roots[2]);
                    MalValue slots[] = {roots[2], roots[8], roots[6], mal_value_new_boolean(end)};
                    MalValue handlers[] = {
                        stream_slot_function(vm, "", 1, pl_consumer_fulfilled, slots, 4), mal_value_new_undefined()};
                    MalRootSpan handler_root;
                    mal_gc_root(&handler_root, handlers, countof(handlers));
                    handlers[1] = stream_slot_function(vm, "", 1, pl_consumer_rejected, slots, 4);
                    mal_vm_call_value(vm, then, roots[7], handlers, 2);
                    mal_gc_unroot(&handler_root);
                    if (vm->completion.kind == MAL_COMPLETION_THROW) break;
                } else if (pl_is_iterable(vm, roots[7], 1)) {
                    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
                    stream_set(vm, roots[5], "readable", mal_value_new_boolean(false));
                    roots[6] = pl_finish_function(vm, roots[2]);
                    MalValue eos_args[] = {roots[8], roots[5], roots[6]};
                    stream_finished(vm, mal_value_new_undefined(), eos_args, 3, mal_value_new_undefined(),
                        mal_value_new_undefined());
                    pl_start_pump(vm, roots[2], roots[7], roots[8], end);
                } else {
                    pl_throw_return_value(vm, "AsyncIterable or Promise", "destination", roots[7]);
                    break;
                }
                roots[7] = roots[8];
            }
        } else if (node_stream) {
            if (stream_has_state(vm, roots[7], "_readableState") && stream_is_node_stream(vm, roots[7])
                && !pl_is_runtime_web_stream(vm, roots[7])) {
                MalValue pipe_args[] = {roots[4], mal_value_new_undefined()};
                i32 pipe_argc = 1;
                if (!end) {
                    roots[5] = mal_value_from_object(mal_intrinsic_new_object(vm));
                    stream_set(vm, roots[5], "end", mal_value_new_boolean(false));
                    pipe_args[1] = roots[5];
                    pipe_argc = 2;
                }
                MalCompletion piped = stream_call_method(vm, roots[7], "pipe", pipe_args, pipe_argc);
                if (piped.kind == MAL_COMPLETION_THROW) break;
            } else if (pl_is_web_transform(vm, roots[7])) {
                roots[5] = mal_value_new_undefined();
                stream_get(vm, roots[7], "readable", &roots[5]);
                pl_start_pump(vm, roots[2], roots[5], roots[4], end);
            } else if (pl_is_iterable(vm, roots[7], 0)) {
                pl_start_pump(vm, roots[2], roots[7], roots[4], end);
            } else {
                mal_node_throw_invalid_arg_type(vm, "val", "an instance of Readable, Iterable, or AsyncIterable", roots[7]);
                break;
            }
            roots[7] = roots[4];
        } else if (pl_is_web_readable(vm, roots[4]) || pl_is_web_writable(vm, roots[4]) || pl_is_web_transform(vm, roots[4])) {
            if (pl_is_web_transform(vm, roots[7])) {
                roots[5] = mal_value_new_undefined();
                stream_get(vm, roots[7], "readable", &roots[5]);
                pl_start_pump_into(vm, roots[2], roots[5], roots[4], end, true);
            } else if (stream_has_state(vm, roots[7], "_readableState") || pl_is_web_readable(vm, roots[7])
                || pl_is_iterable(vm, roots[7], 0)) {
                pl_start_pump_into(vm, roots[2], roots[7], roots[4], end, true);
            } else {
                mal_node_throw_invalid_arg_type(vm, "val",
                    "an instance of ReadableStream, TransformStream, Readable, Iterable, or AsyncIterable", roots[7]);
                break;
            }
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
            roots[7] = roots[4];
        } else {
            // pipelineImpl's last branch: ret = Duplex.from(stream), without connecting it.
            roots[7] = df_duplexify(vm, roots[4], "body");
            if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) result = roots[7];
done:
    mal_gc_unroot(&root);
    return result;
}

static bool pl_needs_general(MalVm *vm, MalValue stages) {
    u32 count = mal_array_object_length(mal_value_to_array_object(stages));
    for (u32 i = 0; i < count; i++) {
        MalValue stage = stream_array_at(mal_value_to_array_object(stages), i);
        if (!stream_is_node_stream(vm, stage) || pl_is_runtime_web_stream(vm, stage)) return true;
    }
    return false;
}

/* Collects pipeline(...streams) or pipeline([streams]) into an array. */
static MalValue pl_stage_array(MalVm *vm, const MalValue *args, i32 argc) {
    if (argc == 1 && mal_value_is_array_object(args[0])) return args[0];
    return mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), args, (u32) (argc < 0 ? 0 : argc)));
}

static MalValue stream_pipeline(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue callback = argc > 0
        ? args[argc - 1]
        : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The last pipeline argument must be a callback function");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {callback, pl_stage_array(vm, args, argc - 1)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_array_object_length(mal_value_to_array_object(roots[1])) >= 2 && pl_needs_general(vm, roots[1])
        ? pl_pipeline(vm, roots[1], roots[0], true, mal_value_new_undefined())
        : stream_pipeline_common(vm, args, argc - 1, roots[0]);
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_promise_callback(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalPromiseObject *promise = mal_value_to_promise_object(
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0));
    if (argc > 0 && !mal_value_is_nil(args[0])) {
        mal_promise_reject(vm, promise, args[0]);
    } else {
        // stream/promises pipeline resolves with the final async consumer's value.
        mal_promise_fulfill(vm, promise, argc > 1 ? args[1] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue stream_new_promise_callback(
    MalVm *vm, MalValue *promise_out) {
    MalValue roots[] = {
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "callback"),
            stream_promise_callback, roots, 1));
    *promise_out = roots[0];
    MalValue callback = roots[1];
    mal_gc_unroot(&root);
    return callback;
}

static MalValue stream_promises_finished(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = stream_new_promise_callback(vm, roots);
    if (!stream_finished_common(
            vm, roots[2], roots[3], roots[1], roots + 4)) {
        roots[4] = vm->completion.value;
        stream_clear_completion(vm);
        mal_promise_reject(
            vm, mal_value_to_promise_object(roots[0]), roots[4]);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_promises_pipeline(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = stream_new_promise_callback(vm, roots);
    // A trailing options object ({ signal, end }) is not a stage (lib/stream/promises.js).
    MalValue last = argc > 0 ? args[argc - 1] : mal_value_new_undefined();
    bool has_options = argc > 1 && mal_value_is_object(last) && !mal_value_is_callable(last)
        && !stream_is_node_stream(vm, last) && !pl_is_iterable(vm, last, 0) && !pl_is_web_readable(vm, last)
        && !pl_is_web_writable(vm, last) && !pl_is_web_transform(vm, last);
    MalValue options_roots[] = {pl_stage_array(vm, args, has_options ? argc - 1 : argc), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan options_root;
    mal_gc_root(&options_root, options_roots, countof(options_roots));
    bool end_option = true;
    if (has_options) {
        stream_get(vm, last, "signal", &options_roots[1]);
        stream_get(vm, last, "end", &options_roots[2]);
        end_option = !(mal_value_is_boolean(options_roots[2]) && !mal_value_to_boolean(options_roots[2]));
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[2] = mal_value_new_undefined();
    } else if (mal_array_object_length(mal_value_to_array_object(options_roots[0])) >= 2
        && (has_options || pl_needs_general(vm, options_roots[0]))) {
        roots[2] = pl_pipeline(vm, options_roots[0], roots[1], end_option, options_roots[1]);
    } else {
        roots[2] = stream_pipeline_common(vm, args, argc, roots[1]);
    }
    mal_gc_unroot(&options_root);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[2] = vm->completion.value;
        stream_clear_completion(vm);
        mal_promise_reject(
            vm, mal_value_to_promise_object(roots[0]), roots[2]);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static void stream_define_methods(
    MalVm *vm, MalObject *prototype,
    const StreamMethod *methods, usize count, MalValue *scratch) {
    for (usize i = 0; i < count; i++) {
        *scratch = stream_function(
            vm, methods[i].name, methods[i].length, methods[i].callback);
        mal_intrinsic_define_data(vm, prototype, (const byte *) methods[i].name,
                                  *scratch, STREAM_METHOD);
    }
}

static MalValue stream_constructor_value(
    MalVm *vm, const char *name, MalNativeFunctionCallback callback,
    MalValue prototype) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), 1, callback);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
                              prototype, MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype),
                              (const byte *) "constructor", value, STREAM_METHOD);
    return value;
}

static i32 stream_readable_bytes(MalVm *vm, MalValue receiver, MalValue chunk) {
    if (stream_truthy_own(vm, stream_own(vm, receiver, "_readableState"), "objectMode")) return 1;
    usize length = mal_value_is_typed_array_object(chunk)
        ? mal_typed_array_object_byte_length(mal_value_to_typed_array_object(chunk))
        : mal_value_is_string(chunk) ? mal_string_length(mal_value_to_string(chunk)) : 1;
    return length > INT32_MAX ? INT32_MAX : (i32) length;
}

i32 mal_node_stream_readable_capacity(MalVm *vm, MalValue receiver) {
    MalValue state = stream_own(vm, receiver, "_readableState");
    i32 high_water_mark = stream_i32_own(vm, state, "highWaterMark", 16384);
    i32 length = stream_i32_own(vm, state, "length", 0);
    return high_water_mark > length ? high_water_mark - length : 0;
}

bool mal_node_stream_push_chunk(MalVm *vm, MalValue receiver, MalValue chunk) {
    MalValue result = stream_push(vm, receiver, &chunk, 1, mal_value_new_undefined(), mal_value_new_undefined());
    return mal_value_is_truthy(result);
}

static bool stream_iterator_demand(MalVm *vm, MalValue receiver) {
    MalValue pending = stream_own(vm, receiver, "_malAsyncReads");
    return mal_value_is_array_object(pending)
        && stream_i32_own(vm, receiver, "_malAsyncReadIndex", 0) < (i32) mal_array_object_length(mal_value_to_array_object(pending));
}

static MalValue stream_iterator_result(MalVm *vm, MalValue value, bool done) {
    MalValue roots[] = {value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    stream_set(vm, roots[1], "value", roots[0]);
    stream_set(vm, roots[1], "done", mal_value_new_boolean(done));
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static void stream_iterator_drain(MalVm *vm, MalValue receiver) {
    MalValue roots[6] = {receiver, stream_own(vm, receiver, "_malAsyncReads"),
        stream_own(vm, receiver, "_malReadableQueue"), stream_own(vm, receiver, "_malStreamError"),
        mal_value_new_undefined(), mal_value_new_undefined()};
    if (!mal_value_is_array_object(roots[1])) return;
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *pending = mal_value_to_array_object(roots[1]);
    i32 pending_index = stream_i32_own(vm, receiver, "_malAsyncReadIndex", 0);
    bool destroyed = stream_truthy_own(vm, receiver, "destroyed");
    MalValue state = stream_own(vm, receiver, "_readableState");
    if (destroyed) {
        mal_array_object_set_length(mal_value_to_array_object(roots[2]), 0);
        stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32(0));
        stream_set(vm, state, "length", mal_value_from_i32(0));
    }
    while ((u32) pending_index < mal_array_object_length(pending)) {
        MalArrayObject *queue = mal_value_to_array_object(roots[2]);
        i32 index = stream_i32_own(vm, receiver, "_malReadableIndex", 0);
        bool has_chunk = !destroyed && (u32) index < mal_array_object_length(queue);
        bool ended = stream_truthy_own(vm, state, "ended");
        if (!has_chunk && !destroyed && !ended && mal_value_is_nil(roots[3])) break;
        roots[4] = stream_array_at(pending, (u32) pending_index);
        mal_array_object_store(pending, mal_key_index((u32) pending_index++), mal_value_new_undefined());
        stream_set(vm, receiver, "_malAsyncReadIndex", mal_value_from_i32(pending_index));
        if (!mal_value_is_nil(roots[3])) {
            mal_promise_reject(vm, mal_value_to_promise_object(roots[4]), roots[3]);
            continue;
        }
        roots[5] = mal_value_new_undefined();
        if (has_chunk) {
            roots[5] = stream_array_at(queue, (u32) index);
            mal_array_object_store(queue, mal_key_index((u32) index++), mal_value_new_undefined());
            stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32(index));
            i32 length = stream_i32_own(vm, state, "length", 0) - stream_readable_bytes(vm, receiver, roots[5]);
            stream_set(vm, state, "length", mal_value_from_i32(length > 0 ? length : 0));
            if ((u32) index == mal_array_object_length(queue)) {
                roots[2] = stream_new_array(vm);
                stream_set(vm, receiver, "_malReadableQueue", roots[2]);
                stream_set(vm, receiver, "_malReadableIndex", mal_value_from_i32(0));
            }
        } else if (ended && !destroyed) stream_schedule_readable_end(vm, receiver);
        roots[5] = stream_iterator_result(vm, roots[5], !has_chunk);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[4]), roots[5]);
    }
    if ((u32) pending_index == mal_array_object_length(pending)) {
        roots[1] = stream_new_array(vm);
        stream_set(vm, receiver, "_malAsyncReads", roots[1]);
        stream_set(vm, receiver, "_malAsyncReadIndex", mal_value_from_i32(0));
    } else if (!destroyed) stream_schedule_pull(vm, receiver);
    mal_gc_unroot(&root);
}

static MalValue stream_iterator_noop(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    return mal_value_new_undefined();
}

static MalValue stream_iterator_next(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue iterator = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue roots[] = {iterator, stream_own(vm, iterator, "stream"), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    if (stream_truthy_own(vm, roots[0], "done")) {
        roots[3] = stream_iterator_result(vm, mal_value_new_undefined(), true);
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[2]), roots[3]);
    } else {
        roots[3] = stream_own(vm, roots[1], "_malAsyncReads");
        if (!mal_value_is_array_object(roots[3])) {
            roots[3] = stream_new_array(vm);
            stream_set(vm, roots[1], "_malAsyncReads", roots[3]);
        }
        stream_array_push_value(mal_value_to_array_object(roots[3]), roots[2]);
        stream_iterator_drain(vm, roots[1]);
    }
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_iterator_closed(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue value = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return stream_iterator_result(vm, value, true);
}

static MalValue stream_iterator_return(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue iterator = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue roots[5] = {iterator, stream_own(vm, iterator, "stream"),
        argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "done", mal_value_new_boolean(true));
    roots[3] = stream_own(vm, roots[1], "_malClosePromise");
    if (!mal_value_is_promise_object(roots[3])) {
        roots[3] = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
        stream_set(vm, roots[1], "_malClosePromise", roots[3]);
        if (stream_truthy_own(vm, roots[1], "closed")) mal_promise_fulfill(vm, mal_value_to_promise_object(roots[3]), mal_value_new_undefined());
    }
    stream_destroy(vm, roots[1], nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
    roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_static_ascii(vm, (const byte *) "iteratorClosed"), 0, stream_iterator_closed, roots + 2, 1));
    MalCompletion completion = stream_call_method(vm, roots[3], "then", roots + 4, 1);
    MalValue result = completion.value;
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_iterator_self(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) nt; (void) callee;
    return self;
}

static MalValue stream_async_iterator(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    stream_require_readable(vm, self);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue roots[3] = {self, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_PROTOTYPE])));
    stream_set(vm, roots[1], "stream", roots[0]);
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_static_ascii(vm, (const byte *) "next"), 0, stream_iterator_next, roots + 1, 1));
    stream_set(vm, roots[1], "next", roots[2]);
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_static_ascii(vm, (const byte *) "return"), 1, stream_iterator_return, roots + 1, 1));
    stream_set(vm, roots[1], "return", roots[2]);
    roots[2] = stream_function(vm, "[Symbol.asyncIterator]", 0, stream_iterator_self);
    MalPropertyDesc descriptor = mal_intrinsic_data_desc(roots[2], STREAM_METHOD);
    mal_object_define_own(mal_value_to_object(roots[1]), mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &descriptor);
    if (!stream_truthy_own(vm, roots[0], "_malAsyncErrorHandled")) {
        stream_set(vm, roots[0], "_malAsyncErrorHandled", mal_value_new_boolean(true));
        roots[2] = stream_function(vm, "onIteratorError", 1, stream_iterator_noop);
        MalValue listener_args[] = {mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "error")), roots[2]};
        stream_call_method(vm, roots[0], "on", listener_args, 2);
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static void stream_from_await(MalVm *vm, MalValue stream, MalValue value, i32 mode);

static MalValue stream_from_rejected(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue receiver = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue error = argc > 0 ? args[0] : mal_value_new_undefined();
    i32 mode = mal_value_to_i32(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1));
    if (mode == 2) {
        MalValue done = stream_own(vm, receiver, "_malSourceDestroyDone");
        mal_vm_call_value(vm, done, mal_value_new_undefined(), &error, 1);
    } else stream_destroy(vm, receiver, &error, 1, mal_value_new_undefined(), mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue stream_from_fulfilled(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[3] = {mal_native_function_object_get_slot(function, 0),
        argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    i32 mode = mal_value_to_i32(mal_native_function_object_get_slot(function, 1));
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mode == 2) {
        roots[2] = stream_own(vm, roots[0], "_malSourceDestroyDone");
        mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), nullptr, 0);
    } else if (!stream_truthy_own(vm, roots[0], "destroyed")) {
        if (mode == 0) {
            if (!mal_value_is_object(roots[1])) mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result must be an object");
            else {
                MalValue done;
                if (stream_get(vm, roots[1], "done", &done) && !mal_value_is_truthy(done)) {
                    if (stream_get(vm, roots[1], "value", &roots[2])) stream_from_await(vm, roots[0], roots[2], 1);
                } else if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    roots[2] = mal_value_new_null();
                    stream_push(vm, roots[0], roots + 2, 1, mal_value_new_undefined(), mal_value_new_undefined());
                }
            }
        } else if (mal_value_is_null(roots[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "May not yield null values to a Readable");
        } else stream_push(vm, roots[0], roots + 1, 1, mal_value_new_undefined(), mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            roots[2] = vm->completion.value;
            stream_clear_completion(vm);
            stream_destroy(vm, roots[0], roots + 2, 1, mal_value_new_undefined(), mal_value_new_undefined());
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void stream_from_await(MalVm *vm, MalValue stream, MalValue value, i32 mode) {
    MalValue roots[5] = {stream, value, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_promise_resolve_value(vm, roots[1], &roots[2])) {
        MalValue slots[] = {roots[0], mal_value_from_i32(mode)};
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "sourceResolved"), 1, stream_from_fulfilled, slots, countof(slots)));
        roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "sourceRejected"), 1, stream_from_rejected, slots, countof(slots)));
        stream_call_method(vm, roots[2], "then", roots + 3, 2);
    }
    mal_gc_unroot(&root);
}

static MalValue stream_from_read(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue iterator = stream_own(vm, self, "_malSourceIterator");
    MalCompletion completion = stream_call_method(vm, iterator, "next", nullptr, 0);
    if (completion.kind != MAL_COMPLETION_THROW) stream_from_await(vm, self, completion.value, 0);
    return mal_value_new_undefined();
}

static MalValue stream_from_destroy(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue roots[4] = {self, stream_own(vm, self, "_malSourceIterator"),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "_malSourceDestroyDone", roots[2]);
    if (stream_get(vm, roots[1], "return", &roots[3]) && mal_value_is_callable(roots[3])) {
        MalCompletion completion = mal_vm_call_value(vm, roots[3], roots[1], nullptr, 0);
        if (completion.kind != MAL_COMPLETION_THROW) stream_from_await(vm, roots[0], completion.value, 2);
    } else if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), nullptr, 0);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_from(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[5] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_string(roots[0]) || (mal_value_is_typed_array_object(roots[0])
        && !mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE])
        && mal_object_get_prototype(mal_value_to_object(roots[0])) ==
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE]))) {
        roots[2] = stream_new_array(vm);
        mal_array_object_store(mal_value_to_array_object(roots[2]), mal_key_index(0), roots[0]);
        roots[0] = roots[2];
    }
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &roots[2])) goto finished;
    if (!mal_value_is_callable(roots[2])) {
        if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &roots[2])) goto finished;
    }
    if (!mal_value_is_callable(roots[2])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Readable.from expects an iterable");
        goto finished;
    }
    MalCompletion iterator = mal_vm_call_value(vm, roots[2], roots[0], nullptr, 0);
    if (iterator.kind == MAL_COMPLETION_THROW) goto finished;
    roots[2] = iterator.value;
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    stream_set(vm, roots[3], "objectMode", mal_value_new_boolean(true));
    if (mal_value_is_object(roots[1])) {
        static const char *names[] = {"objectMode", "highWaterMark", "encoding"};
        for (usize i = 0; i < countof(names); i++) {
            MalValue option = stream_option(vm, roots[1], names[i]);
            if (!mal_value_is_undefined(option)) stream_set(vm, roots[3], names[i], option);
        }
    }
    stream_set(vm, roots[3], "read", stream_function(vm, "fromRead", 1, stream_from_read));
    stream_set(vm, roots[3], "destroy", stream_function(vm, "fromDestroy", 2, stream_from_destroy));
    MalCompletion stream = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR], roots + 3, 1);
    if (stream.kind != MAL_COMPLETION_THROW) {
        roots[4] = stream.value;
        stream_set(vm, roots[4], "_malSourceIterator", roots[2]);
    }
finished:
    MalValue result = roots[4];
    mal_gc_unroot(&root);
    return result;
}

static f64 stream_default_high_water_mark(MalVm *vm, bool object_mode) {
    MalValue value = stream_own(vm, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR],
        object_mode ? "_malDefaultObjectHighWaterMark" : "_malDefaultHighWaterMark");
    return mal_ops_is_number(value) ? mal_ops_number_as_f64(value) : object_mode ? 16 : 65536;
}

static MalValue stream_get_default_hwm(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_value_from_f64(stream_default_high_water_mark(vm, argc > 0 && mal_value_is_truthy(args[0])));
}

static MalValue stream_set_default_hwm(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    f64 value;
    if (!mal_node_validate_integer(vm, argc > 1 ? args[1] : mal_value_new_undefined(), "value", 0,
            9007199254740991.0, &value)) {
        return mal_value_new_undefined();
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR]),
        (const byte *) (argc > 0 && mal_value_is_truthy(args[0])
            ? "_malDefaultObjectHighWaterMark" : "_malDefaultHighWaterMark"),
        mal_value_from_f64(value), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return mal_value_new_undefined();
}

static bool stream_probe(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    return stream_get(vm, object, name, out) && vm->completion.kind != MAL_COMPLETION_THROW;
}

static bool stream_is_node_stream(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) return false;
    MalValue state;
    if (stream_probe(vm, value, "_readableState", &state) && mal_value_is_object(state)) return true;
    if (stream_probe(vm, value, "_writableState", &state) && mal_value_is_object(state)) return true;
    MalValue on, method;
    return stream_probe(vm, value, "on", &on) && mal_value_is_callable(on)
        && ((stream_probe(vm, value, "write", &method) && mal_value_is_callable(method))
            || (stream_probe(vm, value, "pipe", &method) && mal_value_is_callable(method)));
}

static bool stream_flag(MalVm *vm, MalValue object, const char *name) {
    MalValue value;
    return stream_probe(vm, object, name, &value) && mal_value_is_truthy(value);
}

static i32 stream_destroyed_state(MalVm *vm, MalValue stream) {
    if (!stream_is_node_stream(vm, stream)) return -1;
    MalValue state;
    stream_probe(vm, stream, "_writableState", &state);
    if (!mal_value_is_object(state)) stream_probe(vm, stream, "_readableState", &state);
    return stream_flag(vm, stream, "destroyed") || stream_flag(vm, state, "destroyed");
}

typedef enum StreamPredicate {
    STREAM_IS_READABLE,
    STREAM_IS_WRITABLE,
    STREAM_IS_ERRORED,
    STREAM_IS_DESTROYED,
    STREAM_IS_DISTURBED,
} StreamPredicate;

static MalValue stream_predicate(MalVm *vm, MalValue stream, StreamPredicate predicate) {
    MalValue value, state;
    switch (predicate) {
        case STREAM_IS_READABLE:
            if (!stream_probe(vm, stream, "readable", &value) || !mal_value_is_boolean(value)) return mal_value_new_null();
            if (stream_destroyed_state(vm, stream) == 1) return mal_value_new_boolean(false);
            stream_probe(vm, stream, "_readableState", &state);
            return mal_value_new_boolean(mal_value_is_object(state) && mal_value_to_boolean(value)
                && !stream_flag(vm, state, "endEmitted"));
        case STREAM_IS_WRITABLE:
            if (!stream_probe(vm, stream, "writable", &value) || !mal_value_is_boolean(value)) return mal_value_new_null();
            if (stream_destroyed_state(vm, stream) == 1) return mal_value_new_boolean(false);
            stream_probe(vm, stream, "_writableState", &state);
            return mal_value_new_boolean(mal_value_is_object(state) && mal_value_to_boolean(value)
                && !stream_flag(vm, stream, "writableEnded") && !stream_flag(vm, state, "ended"));
        case STREAM_IS_ERRORED: {
            MalValue readable_state, writable_state;
            stream_probe(vm, stream, "_readableState", &readable_state);
            stream_probe(vm, stream, "_writableState", &writable_state);
            return mal_value_new_boolean(stream_flag(vm, stream, "readableErrored")
                || stream_flag(vm, stream, "writableErrored")
                || stream_flag(vm, readable_state, "errorEmitted") || stream_flag(vm, writable_state, "errorEmitted")
                || stream_flag(vm, readable_state, "errored") || stream_flag(vm, writable_state, "errored"));
        }
        case STREAM_IS_DESTROYED: {
            i32 destroyed = stream_destroyed_state(vm, stream);
            return destroyed < 0 ? mal_value_new_null() : mal_value_new_boolean(destroyed == 1);
        }
        case STREAM_IS_DISTURBED:
            return mal_value_new_boolean(stream_flag(vm, stream, "readableDidRead")
                || stream_flag(vm, stream, "readableAborted"));
    }
    return mal_value_new_null();
}

#define STREAM_PREDICATE(name, predicate_kind) \
    static MalValue name(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) { \
        (void) self; (void) nt; (void) callee; \
        MalValue result = stream_predicate(vm, argc > 0 ? args[0] : mal_value_new_undefined(), predicate_kind); \
        return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result; \
    }

STREAM_PREDICATE(stream_is_readable_fn, STREAM_IS_READABLE)
STREAM_PREDICATE(stream_is_writable_fn, STREAM_IS_WRITABLE)
STREAM_PREDICATE(stream_is_errored_fn, STREAM_IS_ERRORED)
STREAM_PREDICATE(stream_is_destroyed_fn, STREAM_IS_DESTROYED)
STREAM_PREDICATE(stream_is_disturbed_fn, STREAM_IS_DISTURBED)

static MalValue stream_abort_error(MalVm *vm, MalValue signal);

static MalValue stream_destroy_fn(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[2] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    if (!mal_value_is_object(roots[0]) || stream_destroyed_state(vm, roots[0]) == 1) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue readable_state;
    stream_probe(vm, roots[0], "_readableState", &readable_state);
    // Node's destroyer aborts an unfinished stream when no error is given.
    if (mal_value_is_undefined(roots[1]) && !stream_flag(vm, readable_state, "endEmitted")
        && !stream_flag(vm, roots[0], "writableFinished")) {
        roots[1] = stream_abort_error(vm, mal_value_new_undefined());
    }
    stream_call_method(vm, roots[0], "destroy", &roots[1], 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_abort_error(MalVm *vm, MalValue signal) {
    MalValue roots[2] = {signal, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    roots[1] = mal_value_from_object(error);
    mal_intrinsic_define_data(vm, error, (const byte *) "message",
        mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "The operation was aborted")),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "name",
        mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "AbortError")),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, error, (const byte *) "code",
        mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "ABORT_ERR")), STREAM_VISIBLE);
    MalValue reason;
    if (stream_probe(vm, roots[0], "reason", &reason)) {
        mal_intrinsic_define_data(vm, error, (const byte *) "cause", reason,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue stream_abort_listener(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[2] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue error = stream_abort_error(vm, roots[1]);
    stream_call_method(vm, roots[0], "destroy", &error, 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_add_abort_signal(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[3] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalValue aborted;
    if (!mal_value_is_object(roots[0]) || !stream_probe(vm, roots[0], "aborted", &aborted)
        || !mal_value_is_boolean(aborted)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_throw_invalid_arg_type(vm, "signal", "an instance of AbortSignal", roots[0]);
        }
        return mal_value_new_undefined();
    }
    if (!stream_is_node_stream(vm, roots[1])) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_throw_invalid_arg_type(vm, "stream",
                "an instance of ReadableStream, WritableStream, or Stream", roots[1]);
        }
        return mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    if (mal_value_to_boolean(aborted)) {
        MalValue error = stream_abort_error(vm, roots[0]);
        stream_call_method(vm, roots[1], "destroy", &error, 1);
    } else {
        MalValue slots[2] = {roots[1], roots[0]};
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "onAbort"), 0, stream_abort_listener, slots, 2));
        MalValue listen[2] = {mal_value_from_string(mal_intrinsic_static_ascii(vm, (const byte *) "abort")), roots[2]};
        stream_call_method(vm, roots[0], "addEventListener", listen, 2);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
}

// Readable state getters; slot 0 names the _readableState field.
/* Slot 0 names the state field; slot 1 is true for _writableState getters. */
static MalValue stream_state_getter(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    MalValue field = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    bool writable = mal_value_is_truthy(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1));
    MalValue state = stream_own(vm, self, writable ? "_writableState" : "_readableState");
    if (!mal_value_is_object(state) || !mal_value_is_string(field)) return mal_value_new_undefined();
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(state), mal_key_from_value(field));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

// duplexPair side hooks; slot 0 is a two-element array holding both sides, slot 1 this side's index.
static MalValue stream_pair_other(MalNativeFunctionObject *function) {
    MalValue sides = mal_native_function_object_get_slot(function, 0);
    i32 index = mal_value_to_i32(mal_native_function_object_get_slot(function, 1));
    return stream_array_at(mal_value_to_array_object(sides), (u32) (1 - index));
}

static MalValue stream_pair_write(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_pair_other(mal_value_to_native_function_object(callee)),
        argc > 0 ? args[0] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    stream_call_method(vm, roots[0], "push", &roots[1], 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_callable(roots[2])) {
        mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_pair_final(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_pair_other(mal_value_to_native_function_object(callee)),
        mal_value_new_null(), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    stream_call_method(vm, roots[0], "push", &roots[1], 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_callable(roots[2])) {
        mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_pair_read(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    return mal_value_new_undefined();
}

static MalValue stream_duplex_pair(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[4] = {stream_new_array(vm), mal_value_new_undefined(), mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    static const struct { const char *name; i32 length; MalNativeFunctionCallback callback; } hooks[] = {
        {"write", 3, stream_pair_write}, {"final", 1, stream_pair_final}, {"read", 1, stream_pair_read},
    };
    for (i32 side = 0; side < 2 && vm->completion.kind != MAL_COMPLETION_THROW; side++) {
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        if (mal_value_is_object(roots[3])) {
            MalPropertyIter iter;
            MalKey key;
            MalPropertyDesc desc;
            mal_property_iter_init(&iter, mal_value_to_object(roots[3]), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
            while (mal_property_iter_next(&iter, &key, &desc)) {
                if ((desc.flags & MAL_PROPERTY_ACCESSOR) == 0) mal_object_set(mal_value_to_object(roots[1]), key, desc.value);
            }
        }
        for (usize i = 0; i < countof(hooks); i++) {
            MalValue slots[2] = {roots[0], mal_value_from_i32(side)};
            roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) hooks[i].name), hooks[i].length, hooks[i].callback, slots, 2));
            stream_set(vm, roots[1], hooks[i].name, roots[2]);
        }
        MalCompletion duplex = mal_vm_construct_value(
            vm, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR], &roots[1], 1);
        if (duplex.kind == MAL_COMPLETION_THROW) break;
        mal_array_object_store(mal_value_to_array_object(roots[0]), mal_key_index((u32) side), duplex.value);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_slot_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, count));
}

static MalValue stream_slot(MalValue callee, i32 index) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), index);
}

// Readable.toWeb listeners and source hooks; slot 0 is the Node readable.
static MalValue stream_to_web_data(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    roots[2] = stream_own(vm, roots[0], "_malWebController");
    MalValue state = stream_own(vm, roots[0], "_readableState");
    if (mal_value_is_typed_array_object(roots[1]) && !stream_truthy_own(vm, state, "objectMode")) {
        MalTypedArrayObject *source = mal_value_to_typed_array_object(roots[1]);
        u32 length = mal_typed_array_object_byte_length(source);
        MalValue length_value = mal_value_from_i32((i32) length);
        MalCompletion copy = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR],
            &length_value, 1);
        if (copy.kind == MAL_COMPLETION_THROW) goto done;
        MalTypedArrayObject *target = mal_value_to_typed_array_object(copy.value);
        memcpy(target->buffer->data + target->byte_offset, source->buffer->data + source->byte_offset, length);
        roots[1] = copy.value;
    }
    stream_call_method(vm, roots[2], "enqueue", &roots[1], 1);
    MalValue desired;
    if (vm->completion.kind != MAL_COMPLETION_THROW && stream_get(vm, roots[2], "desiredSize", &desired)
        && mal_ops_is_number(desired) && mal_ops_number_as_f64(desired) <= 0) {
        stream_call_method(vm, roots[0], "pause", nullptr, 0);
    }
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_to_web_end(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[2] = {stream_own(vm, stream_slot(callee, 0), "_malWebController"),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    bool error = mal_value_to_i32(stream_slot(callee, 1)) == 1;
    if (error) stream_call_method(vm, roots[0], "error", &roots[1], 1);
    else stream_call_method(vm, roots[0], "close", nullptr, 0);
    if (vm->completion.kind == MAL_COMPLETION_THROW) vm->completion = (MalCompletion) {MAL_COMPLETION_NORMAL, MAL_VALUE_UNDEFINED};
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_to_web_start(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    stream_set(vm, stream_slot(callee, 0), "_malWebController", argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue stream_to_web_pull(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    stream_call_method(vm, stream_slot(callee, 0), "resume", nullptr, 0);
    return mal_value_new_undefined();
}

static MalValue stream_to_web_cancel(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue reason = argc > 0 ? args[0] : mal_value_new_undefined();
    stream_call_method(vm, stream_slot(callee, 0), "destroy", &reason, 1);
    return mal_value_new_undefined();
}

static MalValue stream_readable_to_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[5] = {argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 5);
    MalValue result = mal_value_new_undefined();
    MalValue state = stream_own(vm, roots[0], "_readableState");
    if (!mal_value_is_object(state)) {
        mal_node_throw_invalid_arg_type(vm, "streamReadable", "an instance of Readable", roots[0]);
        goto done;
    }
    bool object_mode = stream_truthy_own(vm, state, "objectMode");
    MalValue hwm = stream_own(vm, state, "highWaterMark");
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const struct { const char *name; i32 length; MalNativeFunctionCallback callback; } hooks[] = {
        {"start", 1, stream_to_web_start}, {"pull", 1, stream_to_web_pull}, {"cancel", 1, stream_to_web_cancel},
    };
    for (usize i = 0; i < countof(hooks); i++) {
        roots[2] = stream_slot_function(vm, hooks[i].name, hooks[i].length, hooks[i].callback, &roots[0], 1);
        stream_set(vm, roots[1], hooks[i].name, roots[2]);
    }
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    stream_set(vm, roots[3], "highWaterMark", mal_ops_is_number(hwm) ? hwm : mal_value_from_i32(object_mode ? 16 : 65536));
    if (!object_mode) {
        MalValue strategy_args = roots[3];
        MalCompletion strategy = mal_vm_construct_value(vm,
            vm->intrinsics[MAL_INTRINSIC_BYTE_LENGTH_QUEUING_STRATEGY_CONSTRUCTOR], &strategy_args, 1);
        if (strategy.kind == MAL_COMPLETION_THROW) goto done;
        roots[3] = strategy.value;
    }
    MalValue construct_args[2] = {roots[1], roots[3]};
    MalCompletion readable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_READABLE_STREAM_CONSTRUCTOR],
        construct_args, 2);
    if (readable.kind == MAL_COMPLETION_THROW) goto done;
    roots[4] = readable.value;
    static const char *const events[] = {"data", "end", "error"};
    for (i32 i = 0; i < 3 && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        MalValue slots[2] = {roots[0], mal_value_from_i32(i == 2 ? 1 : 0)};
        roots[2] = i == 0 ? stream_slot_function(vm, "onData", 1, stream_to_web_data, slots, 1)
            : stream_slot_function(vm, "onFinished", 1, stream_to_web_end, slots, 2);
        MalValue listen[2] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) events[i])), roots[2]};
        stream_call_method(vm, roots[0], "on", listen, 2);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) result = roots[4];
done:
    mal_gc_unroot(&root);
    return result;
}

// Readable.fromWeb read hook and reader reactions; slot 0 is the Node readable, slot 1 the web reader.
static MalValue stream_from_web_settled(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    if (mal_value_to_i32(stream_slot(callee, 1)) == 1) {
        stream_call_method(vm, roots[0], "destroy", &roots[1], 1);
    } else {
        MalValue done = mal_value_new_undefined();
        stream_get(vm, roots[1], "done", &done);
        if (mal_value_is_truthy(done)) {
            roots[2] = mal_value_new_null();
        } else {
            stream_get(vm, roots[1], "value", &roots[2]);
        }
        stream_call_method(vm, roots[0], "push", &roots[2], 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_from_web_read(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[4] = {stream_own(vm, stream_slot(callee, 0), "_malWebReadable"), stream_slot(callee, 0),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalCompletion read = stream_call_method(vm, roots[1], "read", nullptr, 0);
    if (read.kind != MAL_COMPLETION_THROW) {
        roots[2] = read.value;
        MalValue handlers[2];
        MalValue fulfilled_slots[2] = {roots[0], mal_value_from_i32(0)};
        MalValue rejected_slots[2] = {roots[0], mal_value_from_i32(1)};
        handlers[0] = stream_slot_function(vm, "", 1, stream_from_web_settled, fulfilled_slots, 2);
        roots[3] = handlers[0];
        handlers[1] = stream_slot_function(vm, "", 1, stream_from_web_settled, rejected_slots, 2);
        MalRootSpan handler_root;
        mal_gc_root(&handler_root, handlers, 2);
        stream_call_method(vm, roots[2], "then", handlers, 2);
        mal_gc_unroot(&handler_root);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_readable_from_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[5] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 5);
    MalValue result = mal_value_new_undefined();
    if (!mal_value_is_readable_stream_object(roots[0])) {
        mal_node_throw_invalid_arg_type(vm, "readableStream", "an instance of ReadableStream", roots[0]);
        goto done;
    }
    MalCompletion reader = stream_call_method(vm, roots[0], "getReader", nullptr, 0);
    if (reader.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = reader.value;
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const char *const names[] = {"highWaterMark", "encoding", "objectMode", "signal"};
    for (usize i = 0; i < countof(names); i++) {
        MalValue option = stream_option(vm, roots[1], names[i]);
        if (!mal_value_is_undefined(option)) stream_set(vm, roots[3], names[i], option);
    }
    roots[4] = stream_slot_function(vm, "read", 0, stream_from_web_read, &roots[2], 1);
    stream_set(vm, roots[3], "read", roots[4]);
    MalCompletion readable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR],
        &roots[3], 1);
    if (readable.kind == MAL_COMPLETION_THROW) goto done;
    stream_set(vm, roots[2], "_malWebReadable", readable.value);
    result = readable.value;
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_new_promise(MalVm *vm) {
    return mal_value_from_object((MalObject *) mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
}

// Settles slot 0's promise: slot 1 is 0 to fulfill, 1 to reject with the first argument.
static MalValue stream_settle_slot(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalPromiseObject *promise = mal_value_to_promise_object(stream_slot(callee, 0));
    if (promise->state != MAL_PROMISE_PENDING) return mal_value_new_undefined();
    if (mal_value_to_i32(stream_slot(callee, 1)) == 1) {
        mal_promise_reject(vm, promise, argc > 0 ? args[0] : mal_value_new_undefined());
    } else {
        mal_promise_fulfill(vm, promise, mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static void stream_once_settle(MalVm *vm, MalValue emitter, const char *event, MalValue promise, bool reject) {
    MalValue slots[2] = {promise, mal_value_from_i32(reject ? 1 : 0)};
    MalValue listen[2] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, listen, 2);
    listen[1] = stream_slot_function(vm, "", 1, stream_settle_slot, slots, 2);
    stream_call_method(vm, emitter, "once", listen, 2);
    mal_gc_unroot(&root);
}

static MalValue stream_writable_web_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue result = mal_value_new_undefined();
    MalCompletion written = stream_call_method(vm, roots[0], "write", &roots[1], 1);
    if (written.kind != MAL_COMPLETION_THROW && mal_value_is_boolean(written.value)
        && !mal_value_to_boolean(written.value)) {
        roots[2] = stream_new_promise(vm);
        stream_once_settle(vm, roots[0], "drain", roots[2], false);
        stream_once_settle(vm, roots[0], "error", roots[2], true);
        result = roots[2];
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_writable_web_close(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[2] = {stream_slot(callee, 0), stream_new_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    stream_once_settle(vm, roots[0], "finish", roots[1], false);
    stream_once_settle(vm, roots[0], "error", roots[1], true);
    stream_call_method(vm, roots[0], "end", nullptr, 0);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_writable_web_abort(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue reason = argc > 0 ? args[0] : mal_value_new_undefined();
    stream_call_method(vm, stream_slot(callee, 0), "destroy", &reason, 1);
    return mal_value_new_undefined();
}

static MalValue stream_writable_to_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[4] = {argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    if (!mal_value_is_object(stream_own(vm, roots[0], "_writableState"))) {
        mal_node_throw_invalid_arg_type(vm, "streamWritable", "an instance of Writable", roots[0]);
        goto done;
    }
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const struct { const char *name; i32 length; MalNativeFunctionCallback callback; } hooks[] = {
        {"write", 1, stream_writable_web_write}, {"close", 0, stream_writable_web_close},
        {"abort", 1, stream_writable_web_abort},
    };
    for (usize i = 0; i < countof(hooks); i++) {
        roots[2] = stream_slot_function(vm, hooks[i].name, hooks[i].length, hooks[i].callback, &roots[0], 1);
        stream_set(vm, roots[1], hooks[i].name, roots[2]);
    }
    MalCompletion writable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_WRITABLE_STREAM_CONSTRUCTOR],
        &roots[1], 1);
    if (writable.kind != MAL_COMPLETION_THROW) result = writable.value;
done:
    mal_gc_unroot(&root);
    return result;
}

// Writable.fromWeb hooks; slot 0 is the web writer. The Node callback settles after the web write.
static MalValue stream_callback_settled(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue callback = stream_slot(callee, 0);
    MalValue error = mal_value_to_i32(stream_slot(callee, 1)) == 1 && argc > 0 ? args[0] : mal_value_new_null();
    if (mal_value_is_callable(callback)) mal_vm_call_value(vm, callback, mal_value_new_undefined(), &error, 1);
    return mal_value_new_undefined();
}

static void stream_then_callback(MalVm *vm, MalValue promise, MalValue callback) {
    MalValue roots[3] = {promise, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue fulfilled[2] = {callback, mal_value_from_i32(0)};
    MalValue rejected[2] = {callback, mal_value_from_i32(1)};
    roots[1] = stream_slot_function(vm, "", 1, stream_callback_settled, fulfilled, 2);
    roots[2] = stream_slot_function(vm, "", 1, stream_callback_settled, rejected, 2);
    stream_call_method(vm, roots[0], "then", roots + 1, 2);
    mal_gc_unroot(&root);
}

static MalValue stream_web_writer_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[3] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 2 ? args[2] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalCompletion written = stream_call_method(vm, roots[0], "write", &roots[1], 1);
    if (written.kind != MAL_COMPLETION_THROW) stream_then_callback(vm, written.value, roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_web_writer_final(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[2] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalCompletion closed = stream_call_method(vm, roots[0], "close", nullptr, 0);
    if (closed.kind != MAL_COMPLETION_THROW) stream_then_callback(vm, closed.value, roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_writable_from_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[4] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    if (!mal_writable_stream_is_stream(roots[0])) {
        mal_node_throw_invalid_arg_type(vm, "writableStream", "an instance of WritableStream", roots[0]);
        goto done;
    }
    MalCompletion writer = stream_call_method(vm, roots[0], "getWriter", nullptr, 0);
    if (writer.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = writer.value;
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const char *const names[] = {"highWaterMark", "decodeStrings", "objectMode", "signal"};
    for (usize i = 0; i < countof(names); i++) {
        MalValue option = stream_option(vm, roots[1], names[i]);
        if (!mal_value_is_undefined(option)) stream_set(vm, roots[3], names[i], option);
    }
    MalValue hook = stream_slot_function(vm, "write", 3, stream_web_writer_write, &roots[2], 1);
    stream_set(vm, roots[3], "write", hook);
    hook = stream_slot_function(vm, "final", 1, stream_web_writer_final, &roots[2], 1);
    stream_set(vm, roots[3], "final", hook);
    MalCompletion writable = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR],
        &roots[3], 1);
    if (writable.kind != MAL_COMPLETION_THROW) result = writable.value;
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_duplex_to_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    MalValue roots[3] = {argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue result = mal_value_new_undefined();
    roots[1] = stream_readable_to_web(vm, self, roots, 1, nt, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = stream_writable_to_web(vm, self, roots, 1, nt, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    MalObject *pair = mal_intrinsic_new_object(vm);
    result = mal_value_from_object(pair);
    mal_intrinsic_define_data(vm, pair, (const byte *) "writable", roots[2], STREAM_VISIBLE);
    mal_intrinsic_define_data(vm, pair, (const byte *) "readable", roots[1], STREAM_VISIBLE);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue stream_duplex_from_web(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalValue roots[6] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalValue readable = stream_option(vm, roots[0], "readable");
    roots[4] = readable;
    MalValue writable = stream_option(vm, roots[0], "writable");
    roots[5] = writable;
    if (!mal_value_is_readable_stream_object(roots[4]) || !mal_writable_stream_is_stream(roots[5])) {
        mal_node_throw_invalid_arg_type(vm, "pair", "an object with readable and writable web streams", roots[0]);
        goto done;
    }
    MalCompletion reader = stream_call_method(vm, roots[4], "getReader", nullptr, 0);
    if (reader.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = reader.value;
    MalCompletion writer = stream_call_method(vm, roots[5], "getWriter", nullptr, 0);
    if (writer.kind == MAL_COMPLETION_THROW) goto done;
    roots[3] = writer.value;
    MalValue options = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[4] = options;
    static const char *const names[] = {"allowHalfOpen", "decodeStrings", "encoding", "highWaterMark",
        "objectMode", "signal"};
    for (usize i = 0; i < countof(names); i++) {
        MalValue option = stream_option(vm, roots[1], names[i]);
        if (!mal_value_is_undefined(option)) stream_set(vm, roots[4], names[i], option);
    }
    MalValue hook = stream_slot_function(vm, "read", 0, stream_from_web_read, &roots[2], 1);
    stream_set(vm, roots[4], "read", hook);
    hook = stream_slot_function(vm, "write", 3, stream_web_writer_write, &roots[3], 1);
    stream_set(vm, roots[4], "write", hook);
    hook = stream_slot_function(vm, "final", 1, stream_web_writer_final, &roots[3], 1);
    stream_set(vm, roots[4], "final", hook);
    MalCompletion duplex = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR],
        &roots[4], 1);
    if (duplex.kind == MAL_COMPLETION_THROW) goto done;
    stream_set(vm, roots[2], "_malWebReadable", duplex.value);
    result = duplex.value;
done:
    mal_gc_unroot(&root);
    return result;
}

/* stream.compose, translated from Node 26 lib/internal/streams/compose.js for Node
 * stream stages. Every hook closes over one state object (slot 0) that holds d, head,
 * tail and the ondrain/onfinish/onclose continuations, as the JS closure does. */
static bool stream_predicate_true(MalVm *vm, MalValue value, StreamPredicate kind) {
    return mal_value_is_truthy(stream_predicate(vm, value, kind));
}

static MalValue stream_compose_take(MalVm *vm, MalValue state, const char *name) {
    MalValue value = stream_own(vm, state, name);
    stream_set(vm, state, name, mal_value_new_null());
    return value;
}

static void stream_compose_call(MalVm *vm, MalValue callback, const MalValue *args, i32 argc) {
    MalValue roots[] = {callback, argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), roots + 1, argc);
    mal_gc_unroot(&root);
}

static MalValue stream_compose_onfinished(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = stream_compose_take(vm, roots[0], "onclose");
    if (mal_value_is_truthy(roots[2])) {
        stream_compose_call(vm, roots[2], &roots[1], 1);
    } else if (mal_value_is_truthy(roots[1])) {
        stream_call_method(vm, stream_own(vm, roots[0], "d"), "destroy", &roots[1], 1);
    } else if (!mal_value_is_truthy(stream_own(vm, roots[0], "readable"))
        && !mal_value_is_truthy(stream_own(vm, roots[0], "writable"))) {
        stream_call_method(vm, stream_own(vm, roots[0], "d"), "destroy", nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_compose_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion written = stream_call_method(vm, stream_own(vm, roots[0], "head"), "write", roots + 1, 2);
    if (written.kind != MAL_COMPLETION_THROW) {
        if (mal_value_is_truthy(written.value)) stream_compose_call(vm, roots[3], nullptr, 0);
        else stream_set(vm, roots[0], "ondrain", roots[3]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_compose_final(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion ended = stream_call_method(vm, stream_own(vm, roots[0], "head"), "end", nullptr, 0);
    if (ended.kind != MAL_COMPLETION_THROW) stream_set(vm, roots[0], "onfinish", roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Slot 1 selects the continuation to run once and clear: 0 for ondrain, 1 for onfinish. */
static MalValue stream_compose_continue(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    const char *field = mal_value_to_i32(stream_slot(callee, 1)) == 0 ? "ondrain" : "onfinish";
    if (mal_value_is_truthy(stream_own(vm, roots[0], field))) {
        roots[1] = stream_compose_take(vm, roots[0], field);
        stream_compose_call(vm, roots[1], nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_compose_read(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    stream_call_method(vm, stream_own(vm, stream_slot(callee, 0), "tail"), "resume", nullptr, 0);
    return mal_value_new_undefined();
}

static MalValue stream_compose_data(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion pushed = stream_call_method(vm, stream_own(vm, roots[0], "d"), "push", &roots[1], 1);
    if (pushed.kind != MAL_COMPLETION_THROW && !mal_value_is_truthy(pushed.value)) {
        stream_call_method(vm, stream_own(vm, roots[0], "tail"), "pause", nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue stream_compose_end(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue end = mal_value_new_null();
    stream_call_method(vm, stream_own(vm, stream_slot(callee, 0), "d"), "push", &end, 1);
    return mal_value_new_undefined();
}

static MalValue stream_compose_destroy(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {stream_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool closed = mal_value_is_null(stream_own(vm, roots[0], "onclose"));
    if (!mal_value_is_truthy(roots[1]) && !closed) roots[1] = stream_abort_error(vm, mal_value_new_undefined());
    stream_set(vm, roots[0], "ondrain", mal_value_new_null());
    stream_set(vm, roots[0], "onfinish", mal_value_new_null());
    MalValue tail = stream_own(vm, roots[0], "tail");
    if (stream_is_node_stream(vm, tail)) stream_call_method(vm, tail, "destroy", &roots[1], 1);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        if (closed) stream_compose_call(vm, roots[2], &roots[1], 1);
        else stream_set(vm, roots[0], "onclose", roots[2]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool stream_compose_listen(MalVm *vm, MalValue target, const char *event, MalValue listener) {
    MalValue roots[] = {target, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) event)), listener};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion added = stream_call_method(vm, roots[0], "on", roots + 1, 2);
    mal_gc_unroot(&root);
    return added.kind != MAL_COMPLETION_THROW;
}

static void stream_compose_invalid(MalVm *vm, i32 index, MalValue value, const char *reason) {
    char name[32];
    snprintf(name, sizeof name, "streams[%d]", index);
    char received[256];
    mal_node_describe_received(vm, value, received, sizeof received);
    char message[400];
    snprintf(message, sizeof message, "The argument '%s' %s. Received %s", name, reason, received);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
}

static MalValue stream_compose(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc == 0) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"streams\" argument must be specified",
            "ERR_MISSING_ARGS");
        return mal_value_new_undefined();
    }
    if (argc == 1) return df_duplexify(vm, args[0], "body");
    MalValue stages = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), args, (u32) argc));
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        stages};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalArrayObject *stage_array = mal_value_to_array_object(roots[6]);
    if (mal_value_is_callable(args[0])) {
        roots[1] = df_duplexify(vm, args[0], "body");
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
        mal_array_object_store(stage_array, mal_key_index(0), roots[1]);
    }
    if (mal_value_is_callable(args[argc - 1])) {
        roots[1] = df_duplexify(vm, args[argc - 1], "body");
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
        mal_array_object_store(stage_array, mal_key_index((u32) argc - 1), roots[1]);
    }
    for (i32 n = 0; n < argc; n++) {
        MalValue stage = stream_array_at(stage_array, (u32) n);
        if (!stream_is_node_stream(vm, stage)) continue;
        if (n < argc - 1 && !stream_predicate_true(vm, stage, STREAM_IS_READABLE)) {
            stream_compose_invalid(vm, n, args[n], "must be readable");
            goto done;
        }
        if (n > 0 && !stream_predicate_true(vm, stage, STREAM_IS_WRITABLE)) {
            stream_compose_invalid(vm, n, args[n], "must be writable");
            goto done;
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    MalValue head = stream_array_at(stage_array, 0);
    stream_set(vm, roots[0], "head", head);
    stream_set(vm, roots[0], "onclose", mal_value_new_undefined());
    roots[1] = stream_slot_function(vm, "onfinished", 1, stream_compose_onfinished, &roots[0], 1);
    MalValue tail = pl_needs_general(vm, roots[6]) ? pl_pipeline(vm, roots[6], roots[1], true, mal_value_new_undefined())
        : stream_pipeline_common(vm, &roots[6], 1, roots[1]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = tail;
    stream_set(vm, roots[0], "tail", tail);
    bool writable = stream_predicate_true(vm, head, STREAM_IS_WRITABLE);
    bool readable = stream_predicate_true(vm, tail, STREAM_IS_READABLE);
    stream_set(vm, roots[0], "writable", mal_value_new_boolean(writable));
    stream_set(vm, roots[0], "readable", mal_value_new_boolean(readable));
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalValue head_mode = mal_value_new_undefined(), tail_mode = mal_value_new_undefined();
    if (mal_value_is_object(head)) stream_probe(vm, head, "writableObjectMode", &head_mode);
    if (mal_value_is_object(tail)) stream_probe(vm, tail, "readableObjectMode", &tail_mode);
    stream_set(vm, roots[3], "writableObjectMode", mal_value_new_boolean(mal_value_is_truthy(head_mode)));
    stream_set(vm, roots[3], "readableObjectMode", mal_value_new_boolean(mal_value_is_truthy(tail_mode)));
    stream_set(vm, roots[3], "writable", mal_value_new_boolean(writable));
    stream_set(vm, roots[3], "readable", mal_value_new_boolean(readable));
    MalCompletion constructed = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR], &roots[3], 1);
    if (constructed.kind == MAL_COMPLETION_THROW) goto done;
    roots[4] = constructed.value;
    stream_set(vm, roots[0], "d", roots[4]);
    if (writable) {
        roots[5] = stream_slot_function(vm, "_write", 3, stream_compose_write, &roots[0], 1);
        stream_set(vm, roots[4], "_write", roots[5]);
        roots[5] = stream_slot_function(vm, "_final", 1, stream_compose_final, &roots[0], 1);
        stream_set(vm, roots[4], "_final", roots[5]);
        MalValue drain_slots[] = {roots[0], mal_value_from_i32(0)};
        roots[5] = stream_slot_function(vm, "", 0, stream_compose_continue, drain_slots, 2);
        if (!stream_compose_listen(vm, head, "drain", roots[5])) goto done;
        MalValue finish_slots[] = {roots[0], mal_value_from_i32(1)};
        roots[5] = stream_slot_function(vm, "", 0, stream_compose_continue, finish_slots, 2);
        MalValue eos_args[] = {tail, roots[5]};
        stream_finished(vm, mal_value_new_undefined(), eos_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    if (readable) {
        roots[5] = stream_slot_function(vm, "_read", 0, stream_compose_read, &roots[0], 1);
        stream_set(vm, roots[4], "_read", roots[5]);
        roots[5] = stream_slot_function(vm, "", 1, stream_compose_data, &roots[0], 1);
        if (!stream_compose_listen(vm, tail, "data", roots[5])) goto done;
        roots[5] = stream_slot_function(vm, "", 0, stream_compose_end, &roots[0], 1);
        if (!stream_compose_listen(vm, tail, "end", roots[5])) goto done;
    }
    roots[5] = stream_slot_function(vm, "_destroy", 2, stream_compose_destroy, &roots[0], 1);
    stream_set(vm, roots[4], "_destroy", roots[5]);
    result = roots[4];
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* Readable.prototype.wrap and Readable.wrap, translated from Node 26
 * lib/internal/streams/readable.js. Hook slots: 0 the wrapping Readable, 1 the old-style
 * source, 2 a state object holding `paused`. */
static MalValue wrap_on_data(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), pl_slot(callee, 1), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion pushed = stream_call_method(vm, roots[0], "push", &roots[2], 1);
    MalValue pause = mal_value_new_undefined();
    stream_get(vm, roots[1], "pause", &pause);
    if (pushed.kind != MAL_COMPLETION_THROW && !mal_value_is_truthy(pushed.value) && mal_value_is_truthy(pause)) {
        stream_set(vm, pl_slot(callee, 2), "paused", mal_value_new_boolean(true));
        stream_call_method(vm, roots[1], "pause", nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue wrap_on_end(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue end = mal_value_new_null();
    stream_call_method(vm, pl_slot(callee, 0), "push", &end, 1);
    return mal_value_new_undefined();
}

/* 'error' (errorOrDestroy), 'close' and 'destroy' all destroy the wrapper; slot 3 marks error. */
static MalValue wrap_on_destroying(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 && mal_value_is_truthy(pl_slot(callee, 3)) ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!stream_truthy_own(vm, roots[0], "destroyed")) {
        stream_call_method(vm, roots[0], "destroy", &roots[1], mal_value_is_undefined(roots[1]) ? 0 : 1);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue wrap_read(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = pl_slot(callee, 2);
    MalValue resume = mal_value_new_undefined();
    stream_get(vm, pl_slot(callee, 1), "resume", &resume);
    if (stream_truthy_own(vm, state, "paused") && mal_value_is_truthy(resume)) {
        stream_set(vm, state, "paused", mal_value_new_boolean(false));
        stream_call_method(vm, pl_slot(callee, 1), "resume", nullptr, 0);
    }
    return mal_value_new_undefined();
}

static MalValue wrap_bound_call(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    return mal_vm_call_value(vm, pl_slot(callee, 1), pl_slot(callee, 0), args, argc).value;
}

static MalValue stream_wrap_method(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue roots[] = {self, argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[2], "paused", mal_value_new_boolean(false));
    static const struct {
        const char *event;
        MalNativeFunctionCallback callback;
        bool error;
    } handlers[] = {
        {"data", wrap_on_data, false}, {"end", wrap_on_end, false}, {"error", wrap_on_destroying, true},
        {"close", wrap_on_destroying, false}, {"destroy", wrap_on_destroying, false},
    };
    for (usize i = 0; i < countof(handlers) && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        MalValue slots[] = {roots[0], roots[1], roots[2], mal_value_new_boolean(handlers[i].error)};
        roots[3] = stream_slot_function(vm, "", 1, handlers[i].callback, slots, 4);
        stream_compose_listen(vm, roots[1], handlers[i].event, roots[3]);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    MalValue read_slots[] = {roots[0], roots[1], roots[2]};
    roots[3] = stream_slot_function(vm, "_read", 0, wrap_read, read_slots, 3);
    stream_set(vm, roots[0], "_read", roots[3]);
    // Copy the source's own function properties that the wrapper lacks, bound to the source.
    roots[3] = mal_value_new_undefined();
    if (mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR],
            mal_intrinsic_static_string_key(vm, (const byte *) "keys"), &roots[3])) {
        MalCompletion keys = mal_vm_call_value(vm, roots[3], vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], &roots[1], 1);
        if (keys.kind == MAL_COMPLETION_THROW) goto done;
        roots[3] = keys.value;
        u32 count = mal_array_object_length(mal_value_to_array_object(roots[3]));
        for (u32 i = 0; i < count; i++) {
            MalValue key_value = stream_array_at(mal_value_to_array_object(roots[3]), i);
            MalKey key;
            if (!mal_vm_to_property_key(vm, key_value, &key)) goto done;
            MalValue existing = mal_value_new_undefined();
            MalValue method = mal_value_new_undefined();
            if (!mal_vm_get_property(vm, roots[0], key, &existing)) goto done;
            if (!mal_value_is_undefined(existing)) continue;
            if (!mal_vm_get_property(vm, roots[1], key, &method)) goto done;
            if (!mal_value_is_callable(method)) continue;
            MalValue slots[] = {roots[1], method};
            roots[4] = stream_slot_function(vm, "bound", 0, wrap_bound_call, slots, 2);
            mal_vm_set_property(vm, roots[0], key, roots[4], roots[0]);
        }
    }
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[0];
}

static MalValue wrap_destroy(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue destroy = mal_value_new_undefined();
    stream_get(vm, roots[0], "destroy", &destroy);
    if (mal_value_is_callable(destroy)) {
        mal_vm_call_value(vm, destroy, roots[0], &roots[1], mal_value_is_undefined(roots[1]) ? 0 : 1);
        stream_clear_completion(vm);
    }
    mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Readable.wrap(src, options): objectMode defaults to src.readableObjectMode ?? src.objectMode ?? true. */
static MalValue stream_readable_wrap_static(MalVm *vm, MalValue src, MalValue options) {
    MalValue roots[] = {src, options, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalValue mode = mal_value_new_undefined();
    stream_get(vm, roots[0], "readableObjectMode", &mode);
    if (mal_value_is_nil(mode)) stream_get(vm, roots[0], "objectMode", &mode);
    stream_set(vm, roots[2], "objectMode", mal_value_is_nil(mode) ? mal_value_new_boolean(true) : mode);
    if (mal_value_is_object(roots[1])) {
        MalValue assign = mal_value_new_undefined();
        stream_get(vm, vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], "assign", &assign);
        MalValue assign_args[] = {roots[2], roots[1]};
        MalCompletion assigned = mal_vm_call_value(vm, assign, vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], assign_args, 2);
        if (assigned.kind == MAL_COMPLETION_THROW) goto done;
    }
    stream_set(vm, roots[2], "destroy", stream_slot_function(vm, "destroy", 2, wrap_destroy, &roots[0], 1));
    MalCompletion constructed = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR],
        &roots[2], 1);
    if (constructed.kind == MAL_COMPLETION_THROW) goto done;
    roots[3] = constructed.value;
    result = stream_wrap_method(vm, roots[3], &roots[0], 1, mal_value_new_undefined(), mal_value_new_undefined());
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue stream_readable_wrap_fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,
    MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return stream_readable_wrap_static(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
}

/* Duplex.from, translated from Node 26 lib/internal/streams/duplexify.js (duplexify,
 * fromAsyncGen, _duplexify) and the Duplex form of lib/internal/streams/from.js. */
static MalValue df_duplexify(MalVm *vm, MalValue body, const char *name);

static bool df_callable_property(MalVm *vm, MalValue value, const char *name) {
    MalValue property = mal_value_new_undefined();
    return mal_value_is_object(value) && stream_get(vm, value, name, &property) && mal_value_is_callable(property);
}

/* lib/internal/streams/utils.js isReadableNodeStream. */
static bool df_is_readable(MalVm *vm, MalValue value) {
    if (!df_callable_property(vm, value, "pipe") || !df_callable_property(vm, value, "on")) return false;
    bool writable_state = stream_has_state(vm, value, "_writableState");
    bool readable_state = stream_has_state(vm, value, "_readableState");
    if (!writable_state) return true;
    if (!readable_state) return false;
    MalValue state = mal_value_new_undefined(), readable = mal_value_new_undefined();
    stream_get(vm, value, "_readableState", &state);
    stream_get(vm, state, "readable", &readable);
    return !(mal_value_is_boolean(readable) && !mal_value_to_boolean(readable));
}

/* isWritableNodeStream. */
static bool df_is_writable(MalVm *vm, MalValue value) {
    if (!df_callable_property(vm, value, "write") || !df_callable_property(vm, value, "on")) return false;
    if (!stream_has_state(vm, value, "_readableState")) return true;
    MalValue state = mal_value_new_undefined(), writable = mal_value_new_undefined();
    stream_get(vm, value, "_writableState", &state);
    if (mal_value_is_object(state)) stream_get(vm, state, "writable", &writable);
    return !(mal_value_is_boolean(writable) && !mal_value_to_boolean(writable));
}

/* isDuplexNodeStream. */
static bool df_is_duplex(MalVm *vm, MalValue value) {
    return df_callable_property(vm, value, "pipe") && stream_has_state(vm, value, "_readableState")
        && df_callable_property(vm, value, "on") && df_callable_property(vm, value, "write");
}

static bool df_has_prototype(MalVm *vm, MalValue value, MalIntrinsic slot) {
    return stream_prototype_chain_has(value, vm->intrinsics[slot]);
}

static MalValue df_construct(MalVm *vm, MalValue options) {
    MalCompletion constructed = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR], &options, 1);
    return constructed.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : constructed.value;
}

/* from(Duplex, iterable, opts): objectMode, highWaterMark 1, reading from the iterator. */
static MalValue df_from_iterable(MalVm *vm, MalValue iterable, MalValue extra) {
    MalValue roots[] = {iterable, extra, mal_value_new_undefined(), mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    bool async = pl_is_iterable(vm, roots[0], 1);
    mal_vm_get_property(vm, roots[0], mal_intrinsic_symbol_key(vm,
        async ? MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR : MAL_INTRINSIC_SYMBOL_ITERATOR), &roots[2]);
    MalCompletion iterator = mal_vm_call_value(vm, roots[2], roots[0], nullptr, 0);
    if (iterator.kind == MAL_COMPLETION_THROW) goto done;
    roots[2] = iterator.value;
    stream_set(vm, roots[3], "objectMode", mal_value_new_boolean(true));
    stream_set(vm, roots[3], "highWaterMark", mal_value_from_i32(1));
    if (mal_value_is_object(roots[1])) {
        static const char *const names[] = {"writable", "write", "final"};
        for (usize i = 0; i < countof(names); i++) {
            MalValue option = stream_option(vm, roots[1], names[i]);
            if (!mal_value_is_undefined(option)) stream_set(vm, roots[3], names[i], option);
        }
    }
    stream_set(vm, roots[3], "read", stream_function(vm, "fromRead", 1, stream_from_read));
    // from.js replaces any destroy option with its iterator-closing _destroy.
    stream_set(vm, roots[3], "destroy", stream_function(vm, "fromDestroy", 2, stream_from_destroy));
    roots[4] = df_construct(vm, roots[3]);
    if (mal_value_is_object(roots[4])) {
        stream_set(vm, roots[4], "_malSourceIterator", roots[2]);
        result = roots[4];
    }
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* fromAsyncGen's source generator: slot 0 is the shared state object. `pending` is the
 * promise write()/final() settle with {chunk, done, cb}; it is replaced after each chunk. */
static MalValue df_new_pending(MalVm *vm, MalValue state) {
    MalValue promise = mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    stream_set(vm, state, "pending", promise);
    stream_set(vm, state, "hasResolve", mal_value_new_boolean(true));
    return promise;
}

static void df_settle_pending(MalVm *vm, MalValue state, MalValue message) {
    MalValue roots[] = {state, message};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "hasResolve", mal_value_new_boolean(false));
    MalValue pending = stream_own(vm, roots[0], "pending");
    if (mal_value_is_promise_object(pending)) mal_promise_fulfill(vm, mal_value_to_promise_object(pending), roots[1]);
    mal_gc_unroot(&root);
}

static MalValue df_message(MalVm *vm, MalValue chunk, bool done, MalValue cb) {
    MalValue roots[] = {chunk, cb, mal_value_from_object(mal_object_new(&vm->heap, nullptr))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[2], "chunk", roots[0]);
    stream_set(vm, roots[2], "done", mal_value_new_boolean(done));
    stream_set(vm, roots[2], "cb", roots[1]);
    mal_gc_unroot(&root);
    return roots[2];
}

static MalValue df_iter_result(MalVm *vm, MalValue value, bool done) {
    MalValue roots[] = {value, mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[1], "value", roots[0]);
    stream_set(vm, roots[1], "done", mal_value_new_boolean(done));
    mal_gc_unroot(&root);
    return roots[1];
}

/* Slots: state, the next() result promise. Runs when `pending` settles. */
static MalValue df_source_received(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), pl_slot(callee, 1), argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPromiseObject *result = mal_value_to_promise_object(roots[1]);
    roots[3] = stream_own(vm, roots[2], "cb");
    if (mal_value_is_callable(roots[3])) pl_next_tick_finish(vm, roots[3], mal_value_new_undefined());
    if (stream_truthy_own(vm, roots[2], "done")) {
        stream_set(vm, roots[0], "finished", mal_value_new_boolean(true));
        mal_promise_fulfill(vm, result, df_iter_result(vm, mal_value_new_undefined(), true));
    } else {
        MalValue signal = stream_own(vm, roots[0], "signal");
        if (mal_value_is_object(signal) && mal_abort_signal_is_aborted(signal)) {
            stream_set(vm, roots[0], "finished", mal_value_new_boolean(true));
            mal_promise_reject(vm, result, mal_node_abort_error(vm, mal_abort_signal_reason(signal)));
        } else {
            df_new_pending(vm, roots[0]);
            mal_promise_fulfill(vm, result, df_iter_result(vm, stream_own(vm, roots[2], "chunk"), false));
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_source_next(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue pending = stream_own(vm, roots[0], "pending");
    if (stream_truthy_own(vm, roots[0], "finished") || !mal_value_is_promise_object(pending)) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[1]), df_iter_result(vm, mal_value_new_undefined(), true));
    } else {
        // write()/final() keep settling this promise until a received chunk replaces it.
        MalValue slots[] = {roots[0], roots[1]};
        roots[2] = stream_slot_function(vm, "", 1, df_source_received, slots, 2);
        MalValue then_args[] = {roots[2], mal_value_new_undefined()};
        stream_call_method(vm, pending, "then", then_args, 2);
        stream_clear_completion(vm);
    }
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue df_source_return(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    stream_set(vm, state, "finished", mal_value_new_boolean(true));
    MalValue roots[] = {mal_value_from_promise_object(mal_promise_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_promise_fulfill(vm, mal_value_to_promise_object(roots[0]),
        df_iter_result(vm, argc > 0 ? args[0] : mal_value_new_undefined(), true));
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue df_source_iterator(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) args; (void) argc; (void) nt; (void) callee;
    return self;
}

static MalValue df_gen_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    MalValue message = df_message(vm, argc > 0 ? args[0] : mal_value_new_undefined(), false,
        argc > 2 ? args[2] : mal_value_new_undefined());
    df_settle_pending(vm, state, message);
    return mal_value_new_undefined();
}

static MalValue df_gen_final(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    df_settle_pending(vm, state, df_message(vm, mal_value_new_undefined(), true, argc > 0 ? args[0] : mal_value_new_undefined()));
    return mal_value_new_undefined();
}

static MalValue df_noop(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt; (void) callee;
    return mal_value_new_undefined();
}

static MalValue df_gen_destroy(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue controller = stream_own(vm, roots[0], "controller");
    stream_call_method(vm, controller, "abort", &roots[1], 1);
    stream_clear_completion(vm);
    if (stream_truthy_own(vm, roots[0], "hasResolve")) {
        df_settle_pending(vm, roots[0], df_message(vm, mal_value_new_undefined(), true,
            stream_function(vm, "cb", 0, df_noop)));
    }
    mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Then-handlers for an async function body; slot 0 is the hook state. */
static MalValue df_body_fulfilled(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_nil(value)) {
        pl_throw_return_value(vm, "nully", "body", value);
        return mal_value_new_undefined();
    }
    if (!stream_truthy_own(vm, state, "finalized")) {
        MalValue d = stream_own(vm, state, "d");
        if (mal_value_is_object(d) && !stream_truthy_own(vm, d, "destroyed")) stream_call_method(vm, d, "destroy", nullptr, 0);
    }
    return mal_value_new_undefined();
}

static MalValue df_body_rejected(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue state = pl_slot(callee, 0);
    MalValue error = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue d = stream_own(vm, state, "d");
    if (mal_value_is_object(d) && !stream_truthy_own(vm, d, "destroyed")) stream_call_method(vm, d, "destroy", &error, 1);
    stream_clear_completion(vm);
    return mal_value_new_undefined();
}

/* final(cb) of an async-function sink: end the source, then report the body's outcome. */
static MalValue df_final_settled(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    bool rejected = mal_value_is_truthy(pl_slot(callee, 2));
    pl_next_tick_finish(vm, pl_slot(callee, 1), rejected && argc > 0 ? args[0] : mal_value_new_null());
    return mal_value_new_undefined();
}

static MalValue df_final_after_source(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = pl_slot(callee, 0);
    MalValue roots[] = {state, pl_slot(callee, 1), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue ok_slots[] = {roots[0], roots[1], mal_value_new_boolean(false)};
    roots[2] = stream_slot_function(vm, "", 1, df_final_settled, ok_slots, 3);
    MalValue fail_slots[] = {roots[0], roots[1], mal_value_new_boolean(true)};
    roots[3] = stream_slot_function(vm, "", 1, df_final_settled, fail_slots, 3);
    MalValue then_args[] = {roots[2], roots[3]};
    stream_call_method(vm, stream_own(vm, roots[0], "bodyPromise"), "then", then_args, 2);
    stream_clear_completion(vm);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_sink_final(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[0], "finalized", mal_value_new_boolean(true));
    MalValue slots[] = {roots[0], roots[1]};
    roots[2] = stream_slot_function(vm, "", 0, df_final_after_source, slots, 2);
    df_settle_pending(vm, roots[0], df_message(vm, mal_value_new_undefined(), true, roots[2]));
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_from_function(MalVm *vm, MalValue body, const char *name) {
    MalValue roots[] = {body, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalCompletion controller = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR], nullptr, 0);
    if (controller.kind == MAL_COMPLETION_THROW) goto done;
    stream_set(vm, roots[1], "controller", controller.value);
    stream_get(vm, controller.value, "signal", &roots[2]);
    stream_set(vm, roots[1], "signal", roots[2]);
    df_new_pending(vm, roots[1]);
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[4] = stream_slot_function(vm, "next", 0, df_source_next, &roots[1], 1);
    stream_set(vm, roots[3], "next", roots[4]);
    roots[4] = stream_slot_function(vm, "return", 1, df_source_return, &roots[1], 1);
    stream_set(vm, roots[3], "return", roots[4]);
    roots[4] = stream_slot_function(vm, "[Symbol.asyncIterator]", 0, df_source_iterator, &roots[1], 1);
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(roots[4], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(mal_value_to_object(roots[3]), mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR),
        &iterator_desc);
    MalValue call_args[] = {roots[3], pl_signal_options(vm, roots[2])};
    roots[4] = call_args[1];
    MalCompletion called = mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), call_args, 2);
    if (called.kind == MAL_COMPLETION_THROW) goto done;
    roots[5] = called.value;
    if (df_is_duplex(vm, roots[5])) {
        result = roots[5];
        goto done;
    }
    roots[6] = mal_value_from_object(mal_intrinsic_new_object(vm));
    stream_set(vm, roots[6], "write", stream_slot_function(vm, "write", 3, df_gen_write, &roots[1], 1));
    if (pl_is_iterable(vm, roots[5], 0)) {
        stream_set(vm, roots[6], "final", stream_slot_function(vm, "final", 1, df_gen_final, &roots[1], 1));
        result = df_from_iterable(vm, roots[5], roots[6]);
        goto done;
    }
    MalValue then = mal_value_new_undefined();
    if (mal_value_is_object(roots[5])) stream_get(vm, roots[5], "then", &then);
    if (mal_value_is_callable(then)) {
        MalValue handlers[] = {stream_slot_function(vm, "", 1, df_body_fulfilled, &roots[1], 1), mal_value_new_undefined()};
        MalRootSpan handler_root;
        mal_gc_root(&handler_root, handlers, countof(handlers));
        handlers[1] = stream_slot_function(vm, "", 1, df_body_rejected, &roots[1], 1);
        MalCompletion chained = mal_vm_call_value(vm, then, roots[5], handlers, 2);
        mal_gc_unroot(&handler_root);
        if (chained.kind == MAL_COMPLETION_THROW) goto done;
        stream_set(vm, roots[1], "bodyPromise", chained.value);
        stream_set(vm, roots[6], "objectMode", mal_value_new_boolean(true));
        stream_set(vm, roots[6], "readable", mal_value_new_boolean(false));
        stream_set(vm, roots[6], "final", stream_slot_function(vm, "final", 1, df_sink_final, &roots[1], 1));
        stream_set(vm, roots[6], "destroy", stream_slot_function(vm, "destroy", 2, df_gen_destroy, &roots[1], 1));
        roots[5] = df_construct(vm, roots[6]);
        if (!mal_value_is_object(roots[5])) goto done;
        stream_set(vm, roots[1], "d", roots[5]);
        result = roots[5];
        goto done;
    }
    pl_throw_return_value(vm, "Iterable, AsyncIterable or AsyncFunction", name, roots[5]);
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

/* _duplexify({ readable, writable }): hooks close over a state object (slot 0) holding
 * d, r, w and the ondrain/onfinish/onreadable/onclose continuations. */
static MalValue df_take(MalVm *vm, MalValue state, const char *name) {
    MalValue value = stream_own(vm, state, name);
    stream_set(vm, state, name, mal_value_new_null());
    return value;
}

static void df_destroyer(MalVm *vm, MalValue stream, MalValue error) {
    if (!mal_value_is_object(stream) || stream_truthy_own(vm, stream, "destroyed")) return;
    MalValue roots[] = {stream, error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_call_method(vm, roots[0], "destroy", &roots[1], mal_value_is_undefined(roots[1]) ? 0 : 1);
    stream_clear_completion(vm);
    mal_gc_unroot(&root);
}

static void df_onfinished(MalVm *vm, MalValue state, MalValue error) {
    MalValue roots[] = {state, error, df_take(vm, state, "onclose")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_callable(roots[2])) {
        mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
    } else if (mal_value_is_truthy(roots[1])) {
        df_destroyer(vm, stream_own(vm, roots[0], "d"), roots[1]);
    }
    mal_gc_unroot(&root);
}

/* Slot 1 is true for the writable side's eos. */
static MalValue df_side_done(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool writable_side = mal_value_is_truthy(pl_slot(callee, 1));
    if (mal_value_is_truthy(roots[1])) df_destroyer(vm, stream_own(vm, roots[0], writable_side ? "r" : "w"), roots[1]);
    df_onfinished(vm, roots[0], roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_pair_write(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalCompletion written = stream_call_method(vm, stream_own(vm, roots[0], "w"), "write", roots + 1, 2);
    if (written.kind != MAL_COMPLETION_THROW) {
        if (mal_value_is_truthy(written.value)) mal_vm_call_value(vm, roots[3], mal_value_new_undefined(), nullptr, 0);
        else stream_set(vm, roots[0], "ondrain", roots[3]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_pair_final(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_call_method(vm, stream_own(vm, roots[0], "w"), "end", nullptr, 0);
    stream_set(vm, roots[0], "onfinish", roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* Slot 1 names the continuation: 0 ondrain, 1 onfinish, 2 onreadable. */
static MalValue df_pair_continue(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    static const char *const fields[] = {"ondrain", "onfinish", "onreadable"};
    const char *field = fields[mal_value_to_i32(pl_slot(callee, 1))];
    MalValue state = pl_slot(callee, 0);
    if (mal_value_is_callable(stream_own(vm, state, field))) {
        MalValue callback = df_take(vm, state, field);
        MalRootSpan root;
        mal_gc_root(&root, &callback, 1);
        MalValue d = stream_own(vm, state, "d");
        mal_vm_call_value(vm, callback, d, nullptr, 0);
        mal_gc_unroot(&root);
    }
    return mal_value_new_undefined();
}

static MalValue df_pair_read(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue r = stream_own(vm, roots[0], "r");
    MalValue d = stream_own(vm, roots[0], "d");
    for (;;) {
        MalCompletion read = stream_call_method(vm, r, "read", nullptr, 0);
        if (read.kind == MAL_COMPLETION_THROW) break;
        roots[1] = read.value;
        if (mal_value_is_null(roots[1])) {
            stream_set(vm, roots[0], "onreadable", callee);
            break;
        }
        MalCompletion pushed = stream_call_method(vm, d, "push", &roots[1], 1);
        if (pushed.kind == MAL_COMPLETION_THROW || !mal_value_is_truthy(pushed.value)) break;
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_pair_end(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    MalValue end = mal_value_new_null();
    stream_call_method(vm, stream_own(vm, pl_slot(callee, 0), "d"), "push", &end, 1);
    return mal_value_new_undefined();
}

static MalValue df_pair_destroy(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool closed = mal_value_is_null(stream_own(vm, roots[0], "onclose"));
    if (!mal_value_is_truthy(roots[1]) && !closed) roots[1] = mal_node_abort_error(vm, mal_value_new_undefined());
    stream_set(vm, roots[0], "onreadable", mal_value_new_null());
    stream_set(vm, roots[0], "ondrain", mal_value_new_null());
    stream_set(vm, roots[0], "onfinish", mal_value_new_null());
    if (closed) {
        mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
    } else {
        stream_set(vm, roots[0], "onclose", roots[2]);
        df_destroyer(vm, stream_own(vm, roots[0], "w"), roots[1]);
        df_destroyer(vm, stream_own(vm, roots[0], "r"), roots[1]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_pair(MalVm *vm, MalValue r, MalValue w) {
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), r, w,
        mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (mal_value_is_truthy(roots[1]) && !df_callable_property(vm, roots[1], "read")) {
        roots[1] = stream_readable_wrap_static(vm, roots[1], mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    bool readable = mal_value_is_object(roots[1]) && stream_predicate_true(vm, roots[1], STREAM_IS_READABLE);
    bool writable = mal_value_is_object(roots[2]) && stream_predicate_true(vm, roots[2], STREAM_IS_WRITABLE);
    stream_set(vm, roots[0], "r", roots[1]);
    stream_set(vm, roots[0], "w", roots[2]);
    stream_set(vm, roots[0], "onclose", mal_value_new_undefined());
    MalValue mode = mal_value_new_undefined();
    if (mal_value_is_object(roots[1])) stream_probe(vm, roots[1], "readableObjectMode", &mode);
    stream_set(vm, roots[3], "readableObjectMode", mal_value_new_boolean(mal_value_is_truthy(mode)));
    mode = mal_value_new_undefined();
    if (mal_value_is_object(roots[2])) stream_probe(vm, roots[2], "writableObjectMode", &mode);
    stream_set(vm, roots[3], "writableObjectMode", mal_value_new_boolean(mal_value_is_truthy(mode)));
    stream_set(vm, roots[3], "readable", mal_value_new_boolean(readable));
    stream_set(vm, roots[3], "writable", mal_value_new_boolean(writable));
    roots[4] = df_construct(vm, roots[3]);
    if (!mal_value_is_object(roots[4])) goto done;
    stream_set(vm, roots[0], "d", roots[4]);
    if (writable) {
        MalValue slots[] = {roots[0], mal_value_new_boolean(true)};
        roots[5] = stream_slot_function(vm, "", 1, df_side_done, slots, 2);
        MalValue eos_args[] = {roots[2], roots[5]};
        stream_finished(vm, mal_value_new_undefined(), eos_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
        stream_set(vm, roots[4], "_write", stream_slot_function(vm, "_write", 3, df_pair_write, &roots[0], 1));
        stream_set(vm, roots[4], "_final", stream_slot_function(vm, "_final", 1, df_pair_final, &roots[0], 1));
        MalValue drain_slots[] = {roots[0], mal_value_from_i32(0)};
        roots[5] = stream_slot_function(vm, "", 0, df_pair_continue, drain_slots, 2);
        stream_compose_listen(vm, roots[2], "drain", roots[5]);
        MalValue finish_slots[] = {roots[0], mal_value_from_i32(1)};
        roots[5] = stream_slot_function(vm, "", 0, df_pair_continue, finish_slots, 2);
        stream_compose_listen(vm, roots[2], "finish", roots[5]);
    }
    if (readable) {
        MalValue slots[] = {roots[0], mal_value_new_boolean(false)};
        roots[5] = stream_slot_function(vm, "", 1, df_side_done, slots, 2);
        MalValue eos_args[] = {roots[1], roots[5]};
        stream_finished(vm, mal_value_new_undefined(), eos_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
        MalValue readable_slots[] = {roots[0], mal_value_from_i32(2)};
        roots[5] = stream_slot_function(vm, "", 0, df_pair_continue, readable_slots, 2);
        stream_compose_listen(vm, roots[1], "readable", roots[5]);
        roots[5] = stream_slot_function(vm, "", 0, df_pair_end, &roots[0], 1);
        stream_compose_listen(vm, roots[1], "end", roots[5]);
        stream_set(vm, roots[4], "_read", stream_slot_function(vm, "_read", 0, df_pair_read, &roots[0], 1));
    }
    stream_set(vm, roots[4], "_destroy", stream_slot_function(vm, "_destroy", 2, df_pair_destroy, &roots[0], 1));
    result = roots[4];
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue df_promise_fulfilled(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalValue roots[] = {pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_nil(roots[1])) stream_call_method(vm, roots[0], "push", &roots[1], 1);
    MalValue end = mal_value_new_null();
    stream_call_method(vm, roots[0], "push", &end, 1);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue df_promise_rejected(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    df_destroyer(vm, pl_slot(callee, 0), argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue df_from_promise(MalVm *vm, MalValue body, MalValue then) {
    MalValue roots[] = {body, then, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[2], "objectMode", mal_value_new_boolean(true));
    stream_set(vm, roots[2], "writable", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "read", stream_function(vm, "read", 0, df_noop));
    roots[3] = df_construct(vm, roots[2]);
    if (mal_value_is_object(roots[3])) {
        roots[4] = stream_slot_function(vm, "", 1, df_promise_fulfilled, &roots[3], 1);
        roots[5] = stream_slot_function(vm, "", 1, df_promise_rejected, &roots[3], 1);
        MalValue handlers[] = {roots[4], roots[5]};
        mal_vm_call_value(vm, roots[1], roots[0], handlers, 2);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[3];
}

static MalValue df_from_web(MalVm *vm, MalNativeFunctionCallback converter, MalValue body) {
    return converter(vm, mal_value_new_undefined(), &body, 1, mal_value_new_undefined(), mal_value_new_undefined());
}

static bool df_is_web_writable(MalVm *vm, MalValue value) {
    return df_has_prototype(vm, value, MAL_INTRINSIC_WRITABLE_STREAM_PROTOTYPE);
}

static MalValue df_duplexify(MalVm *vm, MalValue body, const char *name) {
    MalValue roots[] = {body, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    bool readable = df_is_readable(vm, roots[0]);
    bool writable = df_is_writable(vm, roots[0]);
    if (df_is_duplex(vm, roots[0])) {
        result = roots[0];
    } else if (readable) {
        result = df_pair(vm, roots[0], mal_value_new_undefined());
    } else if (writable) {
        result = df_pair(vm, mal_value_new_undefined(), roots[0]);
    } else if (stream_is_node_stream(vm, roots[0])) {
        result = df_pair(vm, mal_value_new_undefined(), mal_value_new_undefined());
    } else if (mal_value_is_readable_stream_object(roots[0])) {
        roots[1] = df_from_web(vm, stream_readable_from_web, roots[0]);
        if (vm->completion.kind != MAL_COMPLETION_THROW) result = df_pair(vm, roots[1], mal_value_new_undefined());
    } else if (df_is_web_writable(vm, roots[0])) {
        roots[1] = df_from_web(vm, stream_writable_from_web, roots[0]);
        if (vm->completion.kind != MAL_COMPLETION_THROW) result = df_pair(vm, mal_value_new_undefined(), roots[1]);
    } else if (mal_value_is_callable(roots[0])) {
        result = df_from_function(vm, roots[0], name);
    } else if (df_has_prototype(vm, roots[0], MAL_INTRINSIC_BLOB_PROTOTYPE)) {
        MalCompletion buffer = stream_call_method(vm, roots[0], "arrayBuffer", nullptr, 0);
        if (buffer.kind != MAL_COMPLETION_THROW) result = df_duplexify(vm, buffer.value, name);
    } else if (pl_is_iterable(vm, roots[0], 0)) {
        roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
        stream_set(vm, roots[1], "writable", mal_value_new_boolean(false));
        result = df_from_iterable(vm, roots[0], roots[1]);
    } else {
        if (mal_value_is_object(roots[0])) {
            stream_get(vm, roots[0], "readable", &roots[1]);
            stream_get(vm, roots[0], "writable", &roots[2]);
        }
        if (mal_value_is_readable_stream_object(roots[1]) && df_is_web_writable(vm, roots[2])) {
            result = df_from_web(vm, stream_duplex_from_web, roots[0]);
        } else if ((mal_value_is_object(roots[1]) && !mal_value_is_callable(roots[1]))
            || (mal_value_is_object(roots[2]) && !mal_value_is_callable(roots[2]))) {
            if (mal_value_is_truthy(roots[1]) && !df_is_readable(vm, roots[1])) roots[1] = df_duplexify(vm, roots[1], name);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            if (mal_value_is_truthy(roots[2]) && !df_is_writable(vm, roots[2])) roots[2] = df_duplexify(vm, roots[2], name);
            if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
            result = df_pair(vm, mal_value_is_truthy(roots[1]) ? roots[1] : mal_value_new_undefined(),
                mal_value_is_truthy(roots[2]) ? roots[2] : mal_value_new_undefined());
        } else {
            if (mal_value_is_object(roots[0])) stream_get(vm, roots[0], "then", &roots[3]);
            if (mal_value_is_callable(roots[3])) {
                result = df_from_promise(vm, roots[0], roots[3]);
            } else {
                mal_node_throw_invalid_arg_type(vm, name,
                    "of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, "
                    "AsyncIterable, or Promise or { readable, writable } pair", roots[0]);
            }
        }
    }
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue stream_duplex_from(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return df_duplexify(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "body");
}

static const MalIntrinsic stream_constructor_slots[] = {
    MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_READABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_WRITABLE_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_DUPLEX_CONSTRUCTOR,
    MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR,
};

static const MalIntrinsic stream_prototype_slots[] = {
    MAL_INTRINSIC_NODE_STREAM_PROTOTYPE,
    MAL_INTRINSIC_NODE_READABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_WRITABLE_PROTOTYPE,
    MAL_INTRINSIC_NODE_DUPLEX_PROTOTYPE,
    MAL_INTRINSIC_NODE_TRANSFORM_PROTOTYPE,
};

static void stream_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count) {
    mal_node_module_publish(vm, "node:stream", slots, count, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR]);
}

void mal_host_install_node_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (!mal_value_is_undefined(
            vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR])) {
        stream_install_exports(vm, slots, count);
        return;
    }

    /* Ensure the current realm's EventEmitter graph without borrowing a caller's
     * global slot. This also makes count-zero internal installation safe. */
    mal_host_install_node_events(vm, nullptr, 0, launch);

    MalValue roots[21];
    for (usize i = 0; i < countof(roots); i++) {
        roots[i] = mal_value_new_undefined();
    }
    roots[0] = vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR];
    roots[1] = vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE];
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    if (!mal_value_is_object(roots[1])) {
        mal_gc_unroot(&root);
        return;
    }
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[1])));
    roots[3] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[2])));
    roots[4] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[2])));
    roots[5] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[3])));
    roots[6] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(roots[5])));

    roots[7] = stream_constructor_value(
        vm, "Stream", stream_legacy_constructor, roots[2]);
    roots[8] = stream_constructor_value(
        vm, "Readable", stream_readable_constructor, roots[3]);
    roots[9] = stream_constructor_value(
        vm, "Writable", stream_writable_constructor, roots[4]);
    roots[10] = stream_constructor_value(
        vm, "Duplex", stream_duplex_constructor, roots[5]);
    roots[11] = stream_constructor_value(
        vm, "Transform", stream_transform_constructor, roots[6]);
    roots[13] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[6])));
    roots[14] = stream_constructor_value(
        vm, "PassThrough", stream_pass_through_constructor, roots[13]);

    mal_object_set_prototype(mal_value_to_object(roots[8]), mal_value_to_object(roots[7]));
    mal_object_set_prototype(mal_value_to_object(roots[9]), mal_value_to_object(roots[7]));
    mal_object_set_prototype(mal_value_to_object(roots[10]), mal_value_to_object(roots[8]));
    mal_object_set_prototype(mal_value_to_object(roots[11]), mal_value_to_object(roots[10]));
    mal_object_set_prototype(mal_value_to_object(roots[14]), mal_value_to_object(roots[11]));

    static const StreamMethod stream_methods[] = {
        {"destroy", 1, stream_destroy},
    };
    static const StreamMethod readable_methods[] = {
        {"isPaused", 0, stream_is_paused},
        {"pause", 0, stream_pause},
        {"pipe", 1, stream_pipe},
        {"push", 1, stream_push},
        {"read", 1, stream_read_method},
        {"wrap", 1, stream_wrap_method},
        {"resume", 0, stream_resume},
        {"setEncoding", 1, stream_set_encoding},
        {"unpipe", 1, stream_unpipe},
    };
    static const StreamMethod writable_methods[] = {
        {"end", 1, stream_end},
        {"write", 1, stream_write},
    };
    stream_define_methods(vm, mal_value_to_object(roots[2]), stream_methods,
                          countof(stream_methods), &roots[12]);
    stream_define_methods(vm, mal_value_to_object(roots[3]), readable_methods,
                          countof(readable_methods), &roots[12]);
    stream_define_methods(vm, mal_value_to_object(roots[4]), writable_methods,
                          countof(writable_methods), &roots[12]);
    stream_define_methods(vm, mal_value_to_object(roots[5]), writable_methods,
                          countof(writable_methods), &roots[12]);
    static const StreamMethod pass_through_methods[] = {
        {"_transform", 3, stream_pass_through_transform},
    };
    stream_define_methods(
        vm, mal_value_to_object(roots[13]), pass_through_methods,
        countof(pass_through_methods), &roots[15]);

    MalValue base_on;
    if (stream_get(vm, roots[1], "on", &base_on)) {
        MalValue slot = base_on;
        MalNativeFunctionObject *on = mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_static_ascii(vm, (const byte *) "on"), 2, stream_on, &slot, 1);
        roots[12] = mal_value_from_native_function_object(on);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
                                  (const byte *) "on", roots[12], STREAM_METHOD);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
                                  (const byte *) "addListener", roots[12], STREAM_METHOD);
    }
    static const char *flowing_listener_methods[] = {
        "once", "prependListener", "prependOnceListener",
    };
    for (usize i = 0; i < countof(flowing_listener_methods); i++) {
        MalValue base;
        if (!stream_get(vm, roots[1], flowing_listener_methods[i], &base)) {
            break;
        }
        MalValue slot = base;
        MalNativeFunctionObject *method = mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) flowing_listener_methods[i]),
            2, stream_on, &slot, 1);
        roots[12] = mal_value_from_native_function_object(method);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
                                  (const byte *) flowing_listener_methods[i],
                                  roots[12], STREAM_METHOD);
    }

    static const char *const state_getters[][2] = {
        {"readableHighWaterMark", "highWaterMark"}, {"readableEncoding", "encoding"},
        {"readableObjectMode", "objectMode"}, {"readableLength", "length"},
        {"writableHighWaterMark", "highWaterMark"}, {"writableObjectMode", "objectMode"},
        {"writableLength", "length"},
    };
    for (usize i = 0; i < countof(state_getters); i++) {
        bool writable = state_getters[i][0][0] == 'w';
        MalValue slots[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) state_getters[i][1])),
            mal_value_new_boolean(writable)};
        roots[12] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) state_getters[i][0]), 0, stream_state_getter, slots, 2));
        MalPropertyDesc accessor = {
            .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
            .value = mal_value_new_undefined(),
            .getter = roots[12],
            .setter = mal_value_new_undefined(),
        };
        // Writable getters live on Writable.prototype and Duplex.prototype (Node copies them).
        if (writable) {
            mal_object_define_own(mal_value_to_object(roots[4]), stream_static_key(vm, state_getters[i][0]), &accessor);
            mal_object_define_own(mal_value_to_object(roots[5]), stream_static_key(vm, state_getters[i][0]), &accessor);
        } else {
            mal_object_define_own(mal_value_to_object(roots[3]), stream_static_key(vm, state_getters[i][0]), &accessor);
        }
    }
    roots[12] = stream_function(vm, "from", 2, stream_from);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[8]), "from", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "wrap", 2, stream_readable_wrap_fn);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[8]), "wrap", roots[12], STREAM_METHOD);
    // Node assigns an anonymous function: Duplex.from.name is "".
    roots[12] = stream_function(vm, "", 1, stream_duplex_from);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[10]), "from", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "toWeb", 1, stream_readable_to_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[8]), "toWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "fromWeb", 2, stream_readable_from_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[8]), "fromWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "toWeb", 1, stream_writable_to_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[9]), "toWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "fromWeb", 2, stream_writable_from_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[9]), "fromWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "toWeb", 1, stream_duplex_to_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[10]), "toWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "fromWeb", 2, stream_duplex_from_web);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[10]), "fromWeb", roots[12], STREAM_METHOD);
    roots[12] = stream_function(vm, "[Symbol.asyncIterator]", 0, stream_async_iterator);
    MalPropertyDesc async_iterator = mal_intrinsic_data_desc(roots[12], STREAM_METHOD);
    mal_object_define_own(mal_value_to_object(roots[3]), mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &async_iterator);

    static const char *export_names[] = {
        "Stream", "Readable", "Writable", "Duplex", "Transform",
    };
    for (usize i = 0; i < countof(export_names); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
                                  (const byte *) export_names[i], roots[7 + i],
                                  STREAM_VISIBLE);
        vm->intrinsics[stream_constructor_slots[i]] = roots[7 + i];
        vm->intrinsics[stream_prototype_slots[i]] = roots[2 + i];
    }
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[7]), (const byte *) "PassThrough", roots[14],
        STREAM_VISIBLE);
    roots[16] = stream_function(vm, "finished", 3, stream_finished);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
                              (const byte *) "finished", roots[16],
                              STREAM_VISIBLE);
    roots[17] = stream_function(vm, "pipeline", 0, stream_pipeline);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
                              (const byte *) "pipeline", roots[17],
                              STREAM_VISIBLE);
    roots[18] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[19] = stream_function(
        vm, "finished", 2, stream_promises_finished);
    roots[20] = stream_function(
        vm, "pipeline", 0, stream_promises_pipeline);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[18]),
                              (const byte *) "finished", roots[19],
                              STREAM_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[18]),
                              (const byte *) "pipeline", roots[20],
                              STREAM_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]),
                              (const byte *) "promises", roots[18],
                              STREAM_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROMISES_MODULE] = roots[18];
    static const StreamMethod helpers[] = {
        {"isReadable", 1, stream_is_readable_fn}, {"isWritable", 1, stream_is_writable_fn},
        {"isErrored", 1, stream_is_errored_fn}, {"isDestroyed", 1, stream_is_destroyed_fn},
        {"isDisturbed", 1, stream_is_disturbed_fn}, {"destroy", 2, stream_destroy_fn},
        {"addAbortSignal", 2, stream_add_abort_signal}, {"duplexPair", 1, stream_duplex_pair},
        {"compose", 0, stream_compose},
        {"getDefaultHighWaterMark", 1, stream_get_default_hwm},
        {"setDefaultHighWaterMark", 2, stream_set_default_hwm},
    };
    for (usize i = 0; i < countof(helpers); i++) {
        roots[12] = stream_function(vm, helpers[i].name, helpers[i].length, helpers[i].callback);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[7]), (const byte *) helpers[i].name,
                                  roots[12], STREAM_VISIBLE);
    }
    stream_install_exports(vm, slots, count);
    mal_gc_unroot(&root);
}

void mal_host_install_node_stream_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    mal_host_install_node_stream(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue module =
        vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_PROMISES_MODULE];
    if (!mal_value_is_undefined(module)) {
        mal_node_module_publish(vm, "node:stream/promises", slots, count, module);
    }
}

enum {
    CONSUME_TEXT,
    CONSUME_JSON,
    CONSUME_BUFFER,
    CONSUME_BYTES,
    CONSUME_ARRAY_BUFFER,
    CONSUME_BLOB,
};

static MalValue consume_concat(MalVm *vm, MalValue chunks) {
    MalValue roots[3] = {chunks, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue result = mal_value_new_undefined();
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR])) {
        mal_host_install_node_buffer(vm, nullptr, 0, nullptr);
    }
    roots[2] = vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR];
    MalArrayObject *list = mal_value_to_array_object(roots[0]);
    for (u32 i = 0; vm->completion.kind != MAL_COMPLETION_THROW && i < mal_array_object_length(list); i++) {
        MalValue chunk = stream_array_at(list, i);
        if (mal_value_is_typed_array_object(chunk)) continue;
        MalCompletion converted = stream_call_method(vm, roots[2], "from", &chunk, 1);
        if (converted.kind == MAL_COMPLETION_THROW) break;
        mal_array_object_store(list, mal_key_index(i), converted.value);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        MalCompletion joined = stream_call_method(vm, roots[2], "concat", roots, 1);
        if (joined.kind != MAL_COMPLETION_THROW) result = joined.value;
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue consume_finish(MalVm *vm, MalValue chunks, i32 kind) {
    MalValue roots[3] = {chunks, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalValue result = mal_value_new_undefined();
    if (kind == CONSUME_BLOB) {
        MalValue blob;
        if (stream_get(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], "Blob", &blob)
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalCompletion made = mal_vm_construct_value(vm, blob, roots, 1);
            if (made.kind != MAL_COMPLETION_THROW) result = made.value;
        }
        goto done;
    }
    roots[1] = consume_concat(vm, roots[0]);
    if (vm->completion.kind == MAL_COMPLETION_THROW || !mal_value_is_typed_array_object(roots[1])) goto done;
    MalTypedArrayObject *buffer = mal_value_to_typed_array_object(roots[1]);
    if (kind == CONSUME_BUFFER) {
        result = roots[1];
    } else if (kind == CONSUME_BYTES || kind == CONSUME_ARRAY_BUFFER) {
        MalValue args[3] = {mal_value_new_undefined(), mal_value_from_i32((i32) buffer->byte_offset),
            mal_value_from_i32((i32) mal_typed_array_object_length(buffer))};
        if (!stream_get(vm, roots[1], "buffer", &args[0])) goto done;
        roots[2] = args[0];
        if (kind == CONSUME_BYTES) {
            MalCompletion bytes = mal_vm_construct_value(
                vm, vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR], args, 3);
            if (bytes.kind != MAL_COMPLETION_THROW) result = bytes.value;
        } else {
            MalValue range[2] = {args[1], mal_value_from_i32((i32) (buffer->byte_offset
                + mal_typed_array_object_length(buffer)))};
            MalCompletion slice = stream_call_method(vm, roots[2], "slice", range, 2);
            if (slice.kind != MAL_COMPLETION_THROW) result = slice.value;
        }
    } else {
        MalCompletion text = stream_call_method(vm, roots[1], "toString", nullptr, 0);
        if (text.kind == MAL_COMPLETION_THROW) goto done;
        result = text.value;
        if (kind == CONSUME_JSON) {
            roots[2] = text.value;
            MalCompletion parsed = stream_call_method(vm, vm->intrinsics[MAL_INTRINSIC_JSON], "parse", &roots[2], 1);
            result = parsed.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : parsed.value;
        }
    }
done:
    mal_gc_unroot(&root);
    return result;
}

// Listener slots: 0 the chunk array, 1 the promise, 2 the consumer kind.
static MalValue consume_listener(MalVm *vm, MalValue self, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[4] = {mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1), mal_native_function_object_get_slot(function, 3),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalPromiseObject *promise = mal_value_to_promise_object(roots[1]);
    i32 event = mal_value_to_i32(roots[2]);
    if (promise->state != MAL_PROMISE_PENDING) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (event == 0) {
        MalArrayObject *chunks = mal_value_to_array_object(roots[0]);
        mal_array_object_store(chunks, mal_key_index(mal_array_object_length(chunks)), roots[3]);
    } else if (event == 1) {
        MalValue result = consume_finish(vm, roots[0],
            mal_value_to_i32(mal_native_function_object_get_slot(function, 2)));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            MalValue error = vm->completion.value;
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
            mal_promise_reject(vm, promise, error);
        } else {
            mal_promise_fulfill(vm, promise, result);
        }
    } else {
        mal_promise_reject(vm, promise, roots[3]);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue consume_stream(MalVm *vm, MalValue stream, i32 kind) {
    MalValue roots[4] = {stream, mal_value_new_undefined(), stream_new_array(vm), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    roots[1] = mal_value_from_object((MalObject *) mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalValue on;
    if (!mal_value_is_object(roots[0]) || !stream_get(vm, roots[0], "on", &on) || !mal_value_is_callable(on)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_throw_invalid_arg_type(vm, "stream", "an instance of Readable", roots[0]);
        }
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    static const char *const events[] = {"data", "end", "error"};
    for (i32 i = 0; i < 3 && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        MalValue slots[4] = {roots[2], roots[1], mal_value_from_i32(kind), mal_value_from_i32(i)};
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) events[i]), 1, consume_listener, slots, 4));
        MalValue listen[2] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) events[i])), roots[3]};
        stream_call_method(vm, roots[0], "on", listen, 2);
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
    mal_gc_unroot(&root);
    return result;
}

#define STREAM_CONSUMER(name, consumer_kind) \
    static MalValue name(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) { \
        (void) self; (void) nt; (void) callee; \
        return consume_stream(vm, argc > 0 ? args[0] : mal_value_new_undefined(), consumer_kind); \
    }

STREAM_CONSUMER(stream_consume_text, CONSUME_TEXT)
STREAM_CONSUMER(stream_consume_json, CONSUME_JSON)
STREAM_CONSUMER(stream_consume_buffer, CONSUME_BUFFER)
STREAM_CONSUMER(stream_consume_bytes, CONSUME_BYTES)
STREAM_CONSUMER(stream_consume_array_buffer, CONSUME_ARRAY_BUFFER)
STREAM_CONSUMER(stream_consume_blob, CONSUME_BLOB)

void mal_host_install_node_stream_consumers(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:stream/consumers", slots, count)) return;
    static const StreamMethod consumers[] = {
        {"arrayBuffer", 1, stream_consume_array_buffer}, {"blob", 1, stream_consume_blob},
        {"buffer", 1, stream_consume_buffer}, {"bytes", 1, stream_consume_bytes},
        {"text", 1, stream_consume_text}, {"json", 1, stream_consume_json},
    };
    MalValue roots[2] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    for (usize i = 0; i < countof(consumers); i++) {
        roots[1] = stream_function(vm, consumers[i].name, consumers[i].length, consumers[i].callback);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) consumers[i].name,
                                  roots[1], STREAM_VISIBLE);
    }
    mal_node_module_publish(vm, "node:stream/consumers", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_stream_web(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:stream/web", slots, count)) return;
    static const char *const names[] = {
        "ReadableStream", "ReadableStreamDefaultReader", "ReadableStreamBYOBReader",
        "ReadableStreamBYOBRequest", "ReadableByteStreamController", "ReadableStreamDefaultController",
        "TransformStream", "TransformStreamDefaultController", "WritableStream",
        "WritableStreamDefaultWriter", "WritableStreamDefaultController", "ByteLengthQueuingStrategy",
        "CountQueuingStrategy", "TextEncoderStream", "TextDecoderStream", "CompressionStream",
        "DecompressionStream",
    };
    MalValue roots[1] = {mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, 1);
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    for (usize i = 0; i < countof(names); i++) {
        MalPropertyLookup found = mal_object_get_own(global, stream_static_key(vm, names[i]));
        if (!found.present || (found.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) continue;
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) names[i],
                                  found.desc.value, STREAM_VISIBLE);
    }
    mal_node_module_publish(vm, "node:stream/web", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
