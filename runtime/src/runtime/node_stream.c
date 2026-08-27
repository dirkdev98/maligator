#include "node_stream.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "microtask.h"
#include "node_buffer.h"
#include "node_events.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "property_store.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_ops.h"

#define STREAM_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define STREAM_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

static MalKey stream_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static MalValue stream_own(MalVm *vm, MalValue object, const char *name) {
    if (!mal_value_is_object(object)) {
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup =
        mal_object_get_own(mal_value_to_object(object), stream_key(vm, name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void stream_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    mal_object_set(mal_value_to_object(object), stream_key(vm, name), value);
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
    return mal_vm_get_property(vm, object, stream_key(vm, name), out);
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
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name)),
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

static void stream_init_readable(MalVm *vm, MalValue receiver, MalValue options) {
    MalValue roots[] = {
        receiver, options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = stream_new_array(vm);
    roots[5] = stream_new_array(vm);
    MalValue encoding = stream_option(vm, roots[1], "encoding");
    bool object_mode = mal_value_is_truthy(stream_option(vm, roots[1], "objectMode"));
    f64 high_water_mark = object_mode ? 16 : 16384;
    MalValue option_hwm = stream_option(vm, roots[1], "highWaterMark");
    if (mal_ops_is_number(option_hwm)) {
        f64 number = mal_ops_number_as_f64(option_hwm);
        if (isfinite(number) && number >= 0) high_water_mark = floor(number);
    }
    if (high_water_mark > INT32_MAX) high_water_mark = INT32_MAX;
    roots[4] = encoding;
    if (mal_value_is_string(encoding)) {
        roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
        stream_set(vm, roots[4], "encoding", encoding);
    }
    stream_set(vm, roots[2], "encoding",
               mal_value_is_string(encoding) ? encoding : mal_value_new_null());
    stream_set(vm, roots[2], "decoder",
               mal_value_is_string(encoding) ? roots[4] : mal_value_new_null());
    stream_set(vm, roots[2], "ended", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "endEmitted", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "destroyed", mal_value_new_boolean(false));
    stream_set(vm, roots[2], "objectMode", mal_value_new_boolean(object_mode));
    stream_set(vm, roots[2], "highWaterMark",
               mal_value_from_i32((i32) high_water_mark));
    stream_set(vm, roots[2], "reading", mal_value_new_boolean(false));
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

static void stream_init_writable(MalVm *vm, MalValue receiver, MalValue options) {
    MalValue roots[] = {
        receiver, options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[3] = stream_new_array(vm);
    roots[4] = stream_new_array(vm);
    bool object_mode = mal_value_is_truthy(stream_option(vm, roots[1], "objectMode"));
    MalValue decode_strings = stream_option(vm, roots[1], "decodeStrings");
    bool should_decode_strings = !mal_value_is_boolean(decode_strings)
        || mal_value_to_boolean(decode_strings);
    f64 high_water_mark = object_mode ? 16 : 16384;
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
    if (kind == STREAM_READABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_init_readable(vm, receiver, options);
    }
    if (kind == STREAM_WRITABLE || kind == STREAM_DUPLEX || kind == STREAM_TRANSFORM) {
        stream_init_writable(vm, receiver, options);
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
static void stream_schedule_pull(MalVm *vm, MalValue receiver);
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
            mal_intrinsic_ascii(vm, (const byte *) "streamTask"),
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
        || !stream_truthy_own(vm, receiver, "_malFlowing")
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
    stream_set(vm, receiver, "_malPaused", mal_value_new_boolean(false));
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
                            mal_intrinsic_ascii(vm, (const byte *) "drain")),
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
                    mal_intrinsic_ascii(vm, (const byte *) "onDrain"),
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
                    mal_intrinsic_ascii(vm, (const byte *) "drain")),
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
        roots[2] = stream_array_at(queue, index++);
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
    if (mal_value_is_null(chunk)) {
        stream_set(vm, state, "ended", mal_value_new_boolean(true));
        if (stream_truthy_own(vm, receiver, "_malFlowing")) {
            stream_readable_drain(vm, receiver);
        }
        return mal_value_new_boolean(false);
    }
    if (stream_truthy_own(vm, state, "ended")
        || stream_truthy_own(vm, receiver, "destroyed")) {
        return mal_value_new_boolean(false);
    }
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
        mal_gc_unroot(&root);
    }
    return mal_value_new_boolean(!stream_truthy_own(vm, receiver, "_malPaused"));
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
        receiver, mal_value_from_string(string),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    stream_set(vm, roots[2], "encoding", roots[1]);
    MalValue state = stream_own(vm, roots[0], "_readableState");
    stream_set(vm, state, "encoding", roots[1]);
    stream_set(vm, state, "decoder", roots[2]);
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
        MalString *data = mal_intrinsic_ascii(vm, (const byte *) "data");
        if (mal_string_equals(event, data) && stream_is_readable(vm, receiver)) {
            stream_resume_core(vm, receiver);
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

static MalValue stream_destroy(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Stream.destroy called on incompatible receiver");
        return mal_value_new_undefined();
    }
    if (stream_truthy_own(vm, receiver, "destroyed")) {
        return receiver;
    }
    stream_set(vm, receiver, "destroyed", mal_value_new_boolean(true));
    stream_set(vm, receiver, "readable", mal_value_new_boolean(false));
    stream_set(vm, receiver, "writable", mal_value_new_boolean(false));
    MalValue readable_state = stream_own(vm, receiver, "_readableState");
    MalValue writable_state = stream_own(vm, receiver, "_writableState");
    if (mal_value_is_object(readable_state)) {
        stream_set(vm, readable_state, "destroyed", mal_value_new_boolean(true));
    }
    if (mal_value_is_object(writable_state)) {
        stream_set(vm, writable_state, "destroyed", mal_value_new_boolean(true));
    }
    MalValue error = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_nil(error)) {
        stream_emit(vm, receiver, "error", &error, 1);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        stream_emit(vm, receiver, "close", nullptr, 0);
    }
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
        || !stream_truthy_own(vm, roots[0], "_malFlowing")
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
            mal_intrinsic_ascii(vm, (const byte *) "done"),
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
            mal_intrinsic_ascii(vm, (const byte *) "buffer"));
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
        mal_intrinsic_ascii(vm, (const byte *) "buffer"));
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
        }
    } else if (action == STREAM_TASK_PULL) {
        stream_set(vm, stream, "_malReadScheduled", mal_value_new_boolean(false));
        stream_start_pull(vm, stream);
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
            mal_intrinsic_ascii(vm, (const byte *) "streamCompletion"),
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
            mal_intrinsic_ascii(vm, (const byte *) "streamLifecycle"),
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
                mal_intrinsic_ascii(vm, (const byte *) "cleanup"), 0,
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
        bool valid = i == 0
            ? stream_is_readable(vm, roots[1])
            : (i == count - 1
                ? stream_is_writable(vm, roots[1])
                : stream_is_readable(vm, roots[1])
                    && stream_is_writable(vm, roots[1]));
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
    return stream_pipeline_common(vm, args, argc - 1, callback);
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
        mal_promise_fulfill(vm, promise, mal_value_new_undefined());
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
            mal_intrinsic_ascii(vm, (const byte *) "callback"),
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
    roots[2] = stream_pipeline_common(vm, args, argc, roots[1]);
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
    static const char *export_names[] = {
        "Stream", "Readable", "Writable", "Duplex", "Transform",
    };
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "PassThrough") == 0) {
            MalValue pass_through = mal_value_new_undefined();
            if (stream_get(
                    vm, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR],
                    "PassThrough", &pass_through)) {
                vm->globals[slots[i].slot] = pass_through;
            }
            continue;
        }
        if (strcmp(slots[i].name, "finished") == 0
            || strcmp(slots[i].name, "pipeline") == 0
            || strcmp(slots[i].name, "promises") == 0) {
            MalValue value = mal_value_new_undefined();
            if (stream_get(
                    vm, vm->intrinsics[MAL_INTRINSIC_NODE_STREAM_CONSTRUCTOR],
                    slots[i].name, &value)) {
                vm->globals[slots[i].slot] = value;
            }
            continue;
        }
        usize export_index = 0;
        if (strcmp(slots[i].name, "default") != 0) {
            for (; export_index < countof(export_names); export_index++) {
                if (strcmp(slots[i].name, export_names[export_index]) == 0) {
                    break;
                }
            }
        }
        if (export_index < countof(export_names)) {
            vm->globals[slots[i].slot] =
                vm->intrinsics[stream_constructor_slots[export_index]];
        }
    }
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
            mal_intrinsic_ascii(vm, (const byte *) "on"), 2, stream_on, &slot, 1);
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
        mal_node_module_publish(vm, slots, count, module);
    }
}

#endif /* MAL_NODE */
