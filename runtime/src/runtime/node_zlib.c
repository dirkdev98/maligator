#include "node_zlib.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "async_context.h"
#include "blocking_work.h"
#include "builtin_data_view.h"
#include "host.h"
#include "web_host_timer.h"

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
#define ZLIB_SHARED_INPUT_WINDOW 65536u
#define ZLIB_STATUS_TOO_LARGE (-100)
#define ZLIB_STATUS_NO_MEMORY (-101)
#define ZLIB_MAX_LENGTH 9007199254740991.0
#define ZLIB_BROTLI_PARAMS 7

enum {
    ZLIB_FLUSH_NONE = 0, ZLIB_FLUSH_SYNC = 2, ZLIB_FLUSH_FULL = 3, ZLIB_FLUSH_FINISH = 4,
    ZLIB_BROTLI_FLUSH = 1, ZLIB_BROTLI_FINISH = 2,
};

typedef struct ZlibKind {
    const char *class_name;
    const char *create;
    const char *sync;
    const char *async;
    u32 format;
    bool encode;
} ZlibKind;

static const ZlibKind zlib_kinds[] = {
    {"Deflate", "createDeflate", "deflateSync", "deflate", MAL_ZLIB_FORMAT_ZLIB, true},
    {"Inflate", "createInflate", "inflateSync", "inflate", MAL_ZLIB_FORMAT_ZLIB, false},
    {"Gzip", "createGzip", "gzipSync", "gzip", MAL_ZLIB_FORMAT_GZIP, true},
    {"Gunzip", "createGunzip", "gunzipSync", "gunzip", MAL_ZLIB_FORMAT_GZIP, false},
    {"DeflateRaw", "createDeflateRaw", "deflateRawSync", "deflateRaw", MAL_ZLIB_FORMAT_RAW, true},
    {"InflateRaw", "createInflateRaw", "inflateRawSync", "inflateRaw", MAL_ZLIB_FORMAT_RAW, false},
    {"Unzip", "createUnzip", "unzipSync", "unzip", MAL_ZLIB_FORMAT_UNZIP, false},
    {"BrotliCompress", "createBrotliCompress", "brotliCompressSync", "brotliCompress",
        MAL_ZLIB_FORMAT_BROTLI, true},
    {"BrotliDecompress", "createBrotliDecompress", "brotliDecompressSync", "brotliDecompress",
        MAL_ZLIB_FORMAT_BROTLI, false},
};

typedef struct ZlibOptions {
    i32 level;
    i32 window_bits;
    i32 flush;
    i32 finish_flush;
    usize chunk_size;
    usize max_output;
    bool info;
    bool has_param[ZLIB_BROTLI_PARAMS];
    u32 param[ZLIB_BROTLI_PARAMS];
} ZlibOptions;

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
    mal_gc_mark_value(state->marker);
}

static void zlib_store(MalNodeZlibObject *state, MalValue *slot, MalValue value) {
    mal_gc_write_barrier(*slot);
    *slot = value;
    mal_gc_card(&state->object.header, value);
}

static MalValue zlib_slot(MalValue callee, u32 index) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), index);
}

static MalNodeZlibObject *zlib_state_from_callee(MalValue callee) {
    return (MalNodeZlibObject *) mal_value_to_heap(zlib_slot(callee, 0));
}

static const ZlibKind *zlib_kind_from_callee(MalValue callee) {
    return &zlib_kinds[mal_value_to_i32(zlib_slot(callee, 0))];
}

static MalValue zlib_get(MalVm *vm, MalValue value, const char *name) {
    MalValue out = mal_value_new_undefined();
    mal_vm_get_property(vm, value, zlib_key(vm, name), &out);
    return out;
}

static void zlib_set(MalVm *vm, MalValue value, const char *name, MalValue item) {
    mal_object_set(mal_value_to_object(value), zlib_key(vm, name), item);
}

static void zlib_format_number(char *out, usize limit, f64 number) {
    if (isnan(number)) snprintf(out, limit, "NaN");
    else if (isinf(number)) snprintf(out, limit, number < 0 ? "-Infinity" : "Infinity");
    else if (floor(number) == number && fabs(number) < 1e21) snprintf(out, limit, "%.0f", number);
    else snprintf(out, limit, "%.17g", number);
}

/* Node's ERR_INVALID_ARG_TYPE "Received ..." suffix for the common value kinds. */
static void zlib_describe(MalVm *vm, MalValue value, char *out, usize limit) {
    if (mal_value_is_undefined(value)) { snprintf(out, limit, "undefined"); return; }
    if (mal_value_is_null(value)) { snprintf(out, limit, "null"); return; }
    if (mal_value_is_boolean(value)) {
        snprintf(out, limit, "type boolean (%s)", mal_value_to_boolean(value) ? "true" : "false");
        return;
    }
    if (mal_ops_is_number(value)) {
        char number[64];
        zlib_format_number(number, sizeof number, mal_ops_number_as_f64(value));
        snprintf(out, limit, "type number (%s)", number);
        return;
    }
    if (mal_value_is_string(value)) {
        usize length = 0;
        byte *text = mal_node_buffer_decode_string(vm, value, mal_value_new_undefined(), &length);
        if (text == nullptr) { snprintf(out, limit, "type string"); return; }
        if (length > 25) snprintf(out, limit, "type string ('%.25s...')", (const char *) text);
        else snprintf(out, limit, "type string ('%.*s')", (int) length, (const char *) text);
        free(text);
        return;
    }
    if (mal_value_is_callable(value)) { snprintf(out, limit, "function"); return; }
    if (mal_value_is_object(value)) {
        MalValue constructor = zlib_get(vm, value, "constructor");
        MalValue name = mal_value_is_object(constructor)
            ? zlib_get(vm, constructor, "name") : mal_value_new_undefined();
        usize length = 0;
        byte *text = mal_value_is_string(name)
            ? mal_node_buffer_decode_string(vm, name, mal_value_new_undefined(), &length) : nullptr;
        if (text != nullptr && length > 0)
            snprintf(out, limit, "an instance of %.*s", (int) length, (const char *) text);
        else snprintf(out, limit, "[Object: null prototype] {}");
        free(text);
        return;
    }
    snprintf(out, limit, "type %s", "symbol");
}

static void zlib_throw_arg_type(MalVm *vm, const char *name, const char *expected, MalValue value) {
    char received[160], message[512];
    zlib_describe(vm, value, received, sizeof received);
    snprintf(message, sizeof message, "The \"%s\" %s must be %s. Received %s", name,
        strchr(name, '.') != nullptr ? "property" : "argument", expected, received);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
}

static void zlib_throw_range(MalVm *vm, const char *name, const char *range, f64 received) {
    char number[64], message[512];
    zlib_format_number(number, sizeof number, received);
    snprintf(message, sizeof message,
        "The value of \"%s\" is out of range. It must be %s. Received %s", name, range, number);
    mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
}

static void zlib_throw_status(MalVm *vm, i32 status, usize max_output) {
    if (status == ZLIB_STATUS_TOO_LARGE) {
        char message[128];
        snprintf(message, sizeof message, "Cannot create a Buffer larger than %zu bytes", max_output);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_BUFFER_TOO_LARGE");
        return;
    }
    if (status == ZLIB_STATUS_NO_MEMORY) { mal_vm_throw_allocation_error(vm); return; }
    const char *message = status == MAL_ZLIB_STATUS_TRUNCATED ? "unexpected end of file"
        : status == MAL_ZLIB_STATUS_DATA_ERROR ? "invalid compressed data" : "stream error";
    const char *code = status == MAL_ZLIB_STATUS_TRUNCATED ? "Z_BUF_ERROR"
        : status == MAL_ZLIB_STATUS_DATA_ERROR ? "Z_DATA_ERROR" : "Z_STREAM_ERROR";
    i32 errno_value = status == MAL_ZLIB_STATUS_TRUNCATED ? -5
        : status == MAL_ZLIB_STATUS_DATA_ERROR ? -3 : -2;
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, code);
    MalValue error = vm->completion.value;
    MalRootSpan root;
    mal_gc_root(&root, &error, 1);
    mal_object_set(mal_value_to_object(error), zlib_key(vm, "errno"), mal_value_from_i32(errno_value));
    vm->completion.value = error;
    mal_gc_unroot(&root);
}

/* Node's checkRangesOrGetDefault: undefined and NaN select the default. */
static bool zlib_option_range(MalVm *vm, MalValue options, const char *name, const char *label,
    f64 lower, f64 upper, f64 fallback, f64 *out) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(options) && !mal_vm_get_property(vm, options, zlib_key(vm, name), &value))
        return false;
    *out = fallback;
    if (mal_value_is_undefined(value)) return true;
    if (!mal_ops_is_number(value)) { zlib_throw_arg_type(vm, label, "of type number", value); return false; }
    f64 number = mal_ops_number_as_f64(value);
    if (isnan(number)) return true;
    if (isinf(number)) { zlib_throw_range(vm, label, "a finite number", number); return false; }
    if (number < lower || number > upper) {
        char range[96], low[40], high[40];
        zlib_format_number(low, sizeof low, lower);
        zlib_format_number(high, sizeof high, upper);
        if (isinf(upper)) snprintf(range, sizeof range, ">= %s", low);
        else snprintf(range, sizeof range, ">= %s and <= %s", low, high);
        zlib_throw_range(vm, label, range, number);
        return false;
    }
    *out = number;
    return true;
}

static bool zlib_parse_options(MalVm *vm, const ZlibKind *kind, MalValue options, ZlibOptions *out) {
    memset(out, 0, sizeof *out);
    if (!mal_value_is_undefined(options) && !mal_value_is_null(options) && !mal_value_is_object(options)) {
        zlib_throw_arg_type(vm, "options", "of type object", options);
        return false;
    }
    bool brotli = kind->format == MAL_ZLIB_FORMAT_BROTLI;
    f64 value;
    if (!zlib_option_range(vm, options, "flush", "options.flush", 0, brotli ? 3 : 5, 0, &value)) return false;
    out->flush = (i32) value;
    if (!zlib_option_range(vm, options, "finishFlush", "options.finishFlush", 0, brotli ? 3 : 5,
            brotli ? ZLIB_BROTLI_FINISH : ZLIB_FLUSH_FINISH, &value)) return false;
    out->finish_flush = (i32) value;
    if (!zlib_option_range(vm, options, "chunkSize", "options.chunkSize", 64, INFINITY,
            ZLIB_OUTPUT_CHUNK, &value)) return false;
    out->chunk_size = value > INT32_MAX ? INT32_MAX : (usize) value;
    if (!zlib_option_range(vm, options, "maxOutputLength", "options.maxOutputLength", 1,
            ZLIB_MAX_LENGTH, ZLIB_MAX_LENGTH, &value)) return false;
    out->max_output = value >= (f64) SIZE_MAX ? SIZE_MAX : (usize) value;
    out->level = -1;
    out->window_bits = 15;
    if (mal_value_is_object(options)) {
        MalValue info = zlib_get(vm, options, "info");
        out->info = mal_value_is_truthy(info);
    }
    if (!brotli) {
        if (!zlib_option_range(vm, options, "windowBits", "options.windowBits",
                kind->format == MAL_ZLIB_FORMAT_GZIP ? 9 : kind->encode ? 8 : 0, 15, 15, &value)) return false;
        out->window_bits = (i32) value;
        if (!zlib_option_range(vm, options, "level", "options.level", -1, 9, -1, &value)) return false;
        out->level = (i32) value;
        // zlib-rs exposes neither knob through flate2; both are validated as Node does.
        if (!zlib_option_range(vm, options, "memLevel", "options.memLevel", 1, 9, 8, &value)) return false;
        if (!zlib_option_range(vm, options, "strategy", "options.strategy", 0, 4, 0, &value)) return false;
        return vm->completion.kind != MAL_COMPLETION_THROW;
    }
    MalValue params = mal_value_is_object(options) ? zlib_get(vm, options, "params") : mal_value_new_undefined();
    if (!mal_value_is_object(params)) return vm->completion.kind != MAL_COMPLETION_THROW;
    MalRootSpan root;
    mal_gc_root(&root, &params, 1);
    for (u32 id = 0; id < ZLIB_BROTLI_PARAMS; id++) {
        MalValue item = mal_value_new_undefined();
        if (!mal_vm_get_property(vm, params, mal_key_index(id), &item)) break;
        if (mal_value_is_undefined(item)) continue;
        if (mal_value_is_boolean(item)) item = mal_value_from_i32(mal_value_to_boolean(item) ? 1 : 0);
        if (!mal_ops_is_number(item)) {
            zlib_throw_arg_type(vm, "options.params[key]", "of type number", item);
            break;
        }
        f64 number = mal_ops_number_as_f64(item);
        out->has_param[id] = true;
        out->param[id] = number >= 0 && number <= UINT32_MAX ? (u32) number : UINT32_MAX;
    }
    mal_gc_unroot(&root);
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static i32 zlib_open(const ZlibKind *kind, const ZlibOptions *options, MalZlibStream **out) {
    i32 status = mal_zlib_create_codec(kind->format, kind->encode ? 1 : 0, options->level,
        options->window_bits, out);
    if (status < 0 || !kind->encode || kind->format != MAL_ZLIB_FORMAT_BROTLI) return status;
    for (u32 id = 0; id < ZLIB_BROTLI_PARAMS; id++) {
        if (options->has_param[id]
            && mal_zlib_set_brotli_param(*out, id, options->param[id]) < 0) {
            mal_zlib_free(out);
            return MAL_ZLIB_STATUS_INVALID_ARGUMENT;
        }
    }
    return status;
}

static void zlib_throw_init(MalVm *vm) {
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Initialization failed",
        "ERR_ZLIB_INITIALIZATION_FAILED");
}

static bool zlib_strict_finish(const ZlibKind *kind, i32 finish_flush) {
    return !kind->encode && finish_flush
        == (kind->format == MAL_ZLIB_FORMAT_BROTLI ? ZLIB_BROTLI_FINISH : ZLIB_FLUSH_FINISH);
}

/* Runs a whole buffer through `codec` into one exactly sized allocation; shared by
 * the sync calls and the blocking-pool jobs. */
static i32 zlib_run(MalZlibStream *codec, const byte *input, usize length, i32 flush,
    bool strict, usize maximum, bool encode, byte **out, usize *out_length) {
    usize guess = encode ? length / 2 + 64 : length * 4 + 64;
    if (guess > ZLIB_OUTPUT_CHUNK * 64) guess = ZLIB_OUTPUT_CHUNK * 64;
    usize capacity = guess < maximum ? guess : maximum, used = 0, offset = 0;
    byte *output = malloc(capacity == 0 ? 1 : capacity);
    i32 status = output == nullptr ? ZLIB_STATUS_NO_MEMORY : MAL_ZLIB_STATUS_NEED_INPUT;
    while (output != nullptr) {
        byte probe;
        if (used == capacity && capacity < maximum) {
            usize next = capacity > maximum / 2 ? maximum : capacity * 2;
            byte *grown = realloc(output, next);
            if (grown == nullptr) { status = ZLIB_STATUS_NO_MEMORY; break; }
            output = grown;
            capacity = next;
        }
        bool probing = used == maximum;
        usize consumed = 0, produced = 0;
        status = mal_zlib_pump(codec, (const uint8_t *) (input == nullptr ? nullptr : input + offset),
            length - offset, (uint8_t *) (probing ? &probe : output + used), probing ? 1 : capacity - used, flush, &consumed, &produced);
        offset += consumed;
        if (probing && produced > 0) { status = ZLIB_STATUS_TOO_LARGE; break; }
        used += produced;
        if (status < 0 || status == MAL_ZLIB_STATUS_STREAM_END) break;
        if (status == MAL_ZLIB_STATUS_NEED_INPUT && offset == length) {
            if (strict) {
                status = mal_zlib_finish(codec);
                if (status == MAL_ZLIB_STATUS_STREAM_END) status = MAL_ZLIB_STATUS_NEED_INPUT;
            }
            break;
        }
        if (consumed == 0 && produced == 0 && status != MAL_ZLIB_STATUS_NEED_OUTPUT) {
            status = MAL_ZLIB_STATUS_INVALID_ARGUMENT;
            break;
        }
    }
    if (status < 0) { free(output); return status; }
    if (used < capacity) {
        byte *shrunk = realloc(output, used == 0 ? 1 : used);
        if (shrunk != nullptr) output = shrunk;
    }
    *out = output;
    *out_length = used;
    return MAL_ZLIB_STATUS_STREAM_END;
}

/* Borrows (or for strings and shared memory, copies) the input bytes. */
static bool zlib_input(MalVm *vm, MalValue value, const byte **bytes, usize *length, byte **owned) {
    *owned = nullptr;
    if (mal_value_is_string(value)) {
        *owned = mal_node_buffer_decode_string(vm, value, mal_value_new_undefined(), length);
        if (*owned == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        *bytes = *owned;
        return true;
    }
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(value, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        zlib_throw_arg_type(vm, "buffer",
            "of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer", value);
        return false;
    }
    *bytes = mal_buffer_source_span_private(&span, owned);
    *length = span.length;
    if (span.length > 0 && *bytes == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
    return true;
}

static MalValue zlib_create_transform(MalVm *vm, const ZlibKind *kind, MalValue options,
    MalValue prototype);

static MalValue zlib_sync(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt;
    const ZlibKind *kind = zlib_kind_from_callee(callee);
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue option_value = argc > 1 ? args[1] : mal_value_new_undefined();
    ZlibOptions options;
    if (!zlib_parse_options(vm, kind, option_value, &options)) return mal_value_new_undefined();
    const byte *bytes = nullptr;
    usize length = 0;
    byte *owned = nullptr;
    if (!zlib_input(vm, input, &bytes, &length, &owned)) return mal_value_new_undefined();
    MalZlibStream *codec = nullptr;
    if (zlib_open(kind, &options, &codec) < 0) {
        free(owned);
        zlib_throw_init(vm);
        return mal_value_new_undefined();
    }
    byte *output = nullptr;
    usize produced = 0;
    i32 status = zlib_run(codec, bytes, length, options.finish_flush,
        zlib_strict_finish(kind, options.finish_flush), options.max_output, kind->encode,
        &output, &produced);
    mal_zlib_free(&codec);
    free(owned);
    if (status < 0) { zlib_throw_status(vm, status, options.max_output); return mal_value_new_undefined(); }
    MalValue result = mal_node_buffer_from_owned_bytes(vm, output, produced);
    if (!options.info || vm->completion.kind == MAL_COMPLETION_THROW) return result;
    MalValue roots[] = {result, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    zlib_set(vm, roots[1], "buffer", roots[0]);
    roots[2] = zlib_create_transform(vm, kind, option_value, zlib_slot(callee, 1));
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        zlib_set(vm, roots[2], "bytesWritten", mal_value_from_f64((f64) length));
        zlib_set(vm, roots[1], "engine", roots[2]);
    }
    mal_gc_unroot(&root);
    return roots[1];
}

typedef struct ZlibJob {
    const ZlibKind *kind;
    ZlibOptions options;
    byte *input;
    usize length;
    byte *output;
    usize produced;
    i32 status;
} ZlibJob;

typedef struct ZlibPending {
    struct ZlibPending *next;
    MalVm *vm;
    MalHostHandle operation;
    MalValue callback;
    usize max_output;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} ZlibPending;

static MAL_ISOLATE_LOCAL ZlibPending *zlib_pending;
static MAL_ISOLATE_LOCAL bool zlib_async_installed;

static void zlib_job_free(void *data) {
    ZlibJob *job = data;
    if (job == nullptr) return;
    free(job->input);
    free(job->output);
    free(job);
}

static void zlib_job_run(void *data) {
    ZlibJob *job = data;
    MalZlibStream *codec = nullptr;
    if (zlib_open(job->kind, &job->options, &codec) < 0) {
        job->status = MAL_ZLIB_STATUS_INVALID_ARGUMENT;
        return;
    }
    job->status = zlib_run(codec, job->input, job->length, job->options.finish_flush,
        zlib_strict_finish(job->kind, job->options.finish_flush), job->options.max_output,
        job->kind->encode, &job->output, &job->produced);
    mal_zlib_free(&codec);
}

static void zlib_async_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (ZlibPending *state = zlib_pending; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        mal_gc_mark_value(state->callback);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static void zlib_async_free(MalVm *vm) {
    ZlibPending **link = &zlib_pending;
    while (*link != nullptr) {
        ZlibPending *state = *link;
        if (state->vm != vm) { link = &state->next; continue; }
        *link = state->next;
        free(state);
    }
}

static bool zlib_async_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    ZlibPending **link = &zlib_pending;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != task.operation))
        link = &(*link)->next;
    ZlibPending *state = *link;
    if (state == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    *link = state->next;
    MalValue roots[] = {state->callback, mal_value_new_null(), mal_value_new_undefined(),
        mal_async_internal_value((MalHeapHeader *) state->async_context)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, state->async_context);
    usize max_output = state->max_output;
    free(state);
    ZlibJob *job = mal_blocking_work_result_data(task.data);
    i32 status = task.result == MAL_HOST_TERMINAL_CANCELLED || job == nullptr
        ? MAL_ZLIB_STATUS_INVALID_ARGUMENT : job->status;
    if (status < 0) {
        zlib_throw_status(vm, status, max_output);
    } else {
        // The Buffer adopts the job's allocation, so the job must forget it first.
        byte *output = job->output;
        job->output = nullptr;
        roots[2] = mal_node_buffer_from_owned_bytes(vm, output, job->produced);
    }
    i32 count = 2;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        roots[1] = vm->completion.value;
        vm->completion = (MalCompletion){.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        count = 1;
    }
    mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), roots + 1, count);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

static MalValue zlib_async(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt;
    const ZlibKind *kind = zlib_kind_from_callee(callee);
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue option_value = argc > 2 ? args[1] : mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : argc > 1 ? args[1] : mal_value_new_undefined();
    if (argc == 2 && mal_value_is_callable(args[1])) option_value = mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        zlib_throw_arg_type(vm, "callback", "of type function", callback);
        return mal_value_new_undefined();
    }
    ZlibJob *job = calloc(1, sizeof *job);
    if (job == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    job->kind = kind;
    if (!zlib_parse_options(vm, kind, option_value, &job->options)) { free(job); return mal_value_new_undefined(); }
    const byte *bytes = nullptr;
    byte *owned = nullptr;
    if (!zlib_input(vm, input, &bytes, &job->length, &owned)) { free(job); return mal_value_new_undefined(); }
    if (owned == nullptr && job->length > 0) {
        // Workers cannot retain borrowed pointers into detachable or resizable VM buffers.
        owned = malloc(job->length);
        if (owned == nullptr) { free(job); mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
        memcpy(owned, bytes, job->length);
    }
    job->input = owned;
    ZlibPending *state = calloc(1, sizeof *state);
    MalBlockingWorkReservation reservation = {0};
    if (state == nullptr) { zlib_job_free(job); mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    state->vm = vm;
    state->callback = callback;
    state->max_output = job->options.max_output;
    state->async_context = mal_async_context_capture(vm);
#if MAL_REALMS
    state->realm = vm->current_realm;
#endif
    if (!mal_blocking_work_reserve(mal_host(vm), sizeof *job + job->length, &reservation)
        || !mal_blocking_work_start(mal_host(vm), zlib_job_run, job, zlib_job_free,
            &reservation, &state->operation)) {
        mal_blocking_work_reservation_release(&reservation);
        zlib_job_free(job);
        free(state);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "zlib work could not be scheduled", "EAGAIN");
        return mal_value_new_undefined();
    }
    state->next = zlib_pending;
    zlib_pending = state;
    return mal_value_new_undefined();
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
    const ZlibKind kind = {.format = state->format, .encode = state->encode};
    i32 flush = state->finishing ? state->finish_flush : state->chunk_flush;
    while (state->handle != nullptr && vm->completion.kind != MAL_COMPLETION_THROW) {
        i32 capacity = mal_node_stream_readable_capacity(vm, receiver);
        if (capacity <= 0) break;
        usize size = (usize) capacity < state->chunk_size ? (usize) capacity : state->chunk_size;
        byte *output = malloc(size);
        if (output == nullptr) { zlib_throw_status(vm, ZLIB_STATUS_NO_MEMORY, 0); break; }
        MalBufferSourceSpan span = {0};
        if (!state->finishing && (mal_buffer_source_span(roots[2], &span) != MAL_BUFFER_SOURCE_SPAN_OK || state->input_offset > span.length)) {
            free(output); zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT, 0); break;
        }
        usize consumed = 0, produced = 0;
        const byte *input = span.data == nullptr ? nullptr : span.data + state->input_offset;
        usize input_length = span.length - state->input_offset;
        // The codec reads its input in place, so shared input is fed through a
        // bounded private window; unconsumed bytes are re-read next step.
        byte *window = nullptr;
        if (span.shared && input_length > 0) {
            if (input_length > ZLIB_SHARED_INPUT_WINDOW) input_length = ZLIB_SHARED_INPUT_WINDOW;
            window = malloc(input_length);
            if (window == nullptr) { free(output); zlib_throw_status(vm, ZLIB_STATUS_NO_MEMORY, 0); break; }
            mal_buffer_source_span_read(&span, state->input_offset, window, input_length);
            input = window;
        }
        i32 status = mal_zlib_pump(state->handle, (const uint8_t *)input,
            input_length, (uint8_t *)output, size, flush, &consumed, &produced);
        free(window);
        state->input_offset += consumed;
        state->bytes_written += (double) consumed;
        if (produced > 0) {
            roots[3] = mal_node_buffer_from_owned_bytes(vm, output, produced);
            mal_node_stream_push_chunk(vm, receiver, roots[3]);
        } else free(output);
        if (state->handle == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (status < 0) { zlib_throw_status(vm, status, 0); break; }
        bool drained = status == MAL_ZLIB_STATUS_STREAM_END
            || (status == MAL_ZLIB_STATUS_NEED_INPUT && state->input_offset == span.length);
        if (drained) {
            if (state->finishing) {
                status = zlib_strict_finish(&kind, state->finish_flush)
                    ? mal_zlib_finish(state->handle) : MAL_ZLIB_STATUS_STREAM_END;
                mal_zlib_free(&state->handle);
                if (status != MAL_ZLIB_STATUS_STREAM_END) { zlib_throw_status(vm, status, 0); break; }
            } else if (state->has_pending_level) {
                state->has_pending_level = false;
                mal_zlib_set_level(state->handle, state->pending_level);
            }
            state->pumping = false;
            zlib_set(vm, receiver, "bytesWritten", mal_value_from_f64(state->bytes_written));
            zlib_complete(vm, state_value, mal_value_new_undefined());
            goto finished;
        }
        if (consumed == 0 && produced == 0 && status != MAL_ZLIB_STATUS_NEED_OUTPUT) {
            zlib_throw_status(vm, MAL_ZLIB_STATUS_INVALID_ARGUMENT, 0);
            break;
        }
    }
    state->pumping = false;
    zlib_set(vm, receiver, "bytesWritten", mal_value_from_f64(state->bytes_written));
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
    MalValue state_value = zlib_slot(callee, 0);
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    MalValue chunk = argc > 0 ? args[0] : mal_value_new_undefined();
    state->input_offset = 0;
    state->chunk_flush = mal_value_is_heap(chunk) && mal_value_is_heap(state->marker)
        && mal_value_to_heap(chunk) == mal_value_to_heap(state->marker)
        ? state->marker_flush : state->flush;
    zlib_store(state, &state->input, chunk);
    zlib_store(state, &state->callback, argc > 2 ? args[2] : mal_value_new_undefined());
    zlib_stream_pump(vm, state_value, receiver);
    return mal_value_new_undefined();
}

static MalValue zlib_read(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    zlib_stream_pump(vm, zlib_slot(callee, 0), receiver);
    zlib_set(vm, receiver, "_malReading", mal_value_new_boolean(false));
    zlib_set(vm, zlib_get(vm, receiver, "_readableState"), "reading", mal_value_new_boolean(false));
    return mal_value_new_undefined();
}

static MalValue zlib_flush(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    MalValue state_value = zlib_slot(callee, 0);
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
    MalValue roots[] = {receiver, zlib_slot(callee, 0),
        zlib_get(vm, receiver, "_malPipeSources"), mal_value_new_undefined(),
        mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNodeZlibObject *state = zlib_state_from_callee(callee);
    mal_zlib_free(&state->handle);
    zlib_store(state, &state->input, mal_value_new_undefined());
    zlib_store(state, &state->callback, mal_value_new_undefined());
    zlib_set(vm, receiver, "_closed", mal_value_new_boolean(true));
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

static MalValue zlib_native(MalVm *vm, const char *name, MalNativeFunctionCallback callback,
    MalValue *slots, u32 count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), callback, slots, count));
}

static MalValue zlib_create_transform(MalVm *vm, const ZlibKind *kind, MalValue option_value,
    MalValue prototype) {
    mal_host_install_node_stream(vm, nullptr, 0, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    ZlibOptions options;
    usize high_water_mark;
    if (!zlib_parse_options(vm, kind, option_value, &options)) return mal_value_new_undefined();
    f64 mark;
    if (!zlib_option_range(vm, option_value, "readableHighWaterMark", "options.readableHighWaterMark",
            1, INT32_MAX, options.chunk_size, &mark)) return mal_value_new_undefined();
    high_water_mark = (usize) mark;
    MalZlibStream *handle = nullptr;
    if (zlib_open(kind, &options, &handle) < 0) { zlib_throw_init(vm); return mal_value_new_undefined(); }

    MalValue roots[5] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), prototype,
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
    state->marker = mal_value_new_undefined();
    state->chunk_size = options.chunk_size;
    state->input_offset = 0;
    state->bytes_written = 0;
    state->format = kind->format;
    state->encode = kind->encode;
    state->flush = options.flush;
    state->finish_flush = options.finish_flush;
    state->chunk_flush = options.flush;
    state->marker_flush = options.flush;
    state->pending_level = options.level;
    state->has_pending_level = false;
    state->finishing = false;
    state->pumping = false;
    roots[0] = mal_value_from_heap((MalHeapHeader *) state);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[2] = zlib_native(vm, "zlibTransform", zlib_transform, roots, 1);
    zlib_set(vm, roots[1], "transform", roots[2]);
    roots[2] = zlib_native(vm, "zlibFlush", zlib_flush, roots, 1);
    zlib_set(vm, roots[1], "flush", roots[2]);
    zlib_set(vm, roots[1], "highWaterMark", mal_value_from_i32((i32) high_water_mark));
    roots[2] = zlib_native(vm, "zlibRead", zlib_read, roots, 1);
    zlib_set(vm, roots[1], "read", roots[2]);
    roots[2] = zlib_native(vm, "zlibDestroy", zlib_destroy, roots, 1);
    zlib_set(vm, roots[1], "destroy", roots[2]);
    MalCompletion completion = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR], roots + 1, 1);
    roots[3] = completion.value;
    if (vm->completion.kind != MAL_COMPLETION_THROW && mal_value_is_object(roots[3])) {
        if (mal_value_is_object(roots[4]))
            mal_object_set_prototype_pointer(mal_value_to_object(roots[3]), mal_value_to_object(roots[4]));
        zlib_set(vm, roots[3], "_handle", roots[0]);
        zlib_set(vm, roots[3], "bytesWritten", mal_value_from_i32(0));
        zlib_set(vm, roots[3], "_closed", mal_value_new_boolean(false));
        zlib_set(vm, roots[3], "_level", mal_value_from_i32(options.level));
        zlib_set(vm, roots[3], "_strategy", mal_value_from_i32(0));
        zlib_set(vm, roots[3], "_chunkSize", mal_value_from_f64((f64) options.chunk_size));
        zlib_set(vm, roots[3], "_defaultFlushFlag", mal_value_from_i32(options.flush));
        zlib_set(vm, roots[3], "_finishFlushFlag", mal_value_from_i32(options.finish_flush));
        zlib_set(vm, roots[3], "_defaultFullFlushFlag", mal_value_from_i32(
            kind->format == MAL_ZLIB_FORMAT_BROTLI ? ZLIB_BROTLI_FLUSH : ZLIB_FLUSH_FULL));
        zlib_set(vm, roots[3], "_maxOutputLength", mal_value_from_f64((f64) options.max_output));
    }
    MalValue result = roots[3];
    mal_gc_unroot(&root);
    return result;
}

static MalValue zlib_create(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt;
    return zlib_create_transform(vm, zlib_kind_from_callee(callee),
        argc > 0 ? args[0] : mal_value_new_undefined(), zlib_slot(callee, 1));
}

static MalNodeZlibObject *zlib_this_state(MalVm *vm, MalValue receiver) {
    MalValue handle = mal_value_is_object(receiver) ? zlib_get(vm, receiver, "_handle")
        : mal_value_new_undefined();
    if (!mal_value_is_heap_type(handle, MAL_HEAP_NODE_ZLIB_OBJECT)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Illegal invocation", "ERR_INVALID_THIS");
        return nullptr;
    }
    return (MalNodeZlibObject *) mal_value_to_heap(handle);
}

/* Writes the stream's flush marker so the flush is ordered after pending writes. */
static void zlib_write_marker(MalVm *vm, MalValue receiver, MalNodeZlibObject *state,
    i32 kind, MalValue callback) {
    MalValue roots[] = {receiver, callback, state->marker, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_undefined(roots[2])) {
        roots[2] = mal_node_buffer_from_owned_bytes(vm, malloc(1), 0);
        if (vm->completion.kind != MAL_COMPLETION_THROW) zlib_store(state, &state->marker, roots[2]);
    }
    state->marker_flush = kind;
    MalValue ended = zlib_get(vm, receiver, "writableEnded");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    if (mal_value_is_truthy(ended)) {
        if (mal_value_is_callable(roots[1])) {
            roots[3] = zlib_get(vm, receiver, "once");
            MalValue once_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "end")), roots[1]};
            if (mal_value_is_callable(roots[3])) mal_vm_call_value(vm, roots[3], receiver, once_args, 2);
        }
        goto done;
    }
    roots[3] = zlib_get(vm, receiver, "write");
    MalValue write_args[] = {roots[2], roots[1]};
    if (mal_value_is_callable(roots[3]))
        mal_vm_call_value(vm, roots[3], receiver, write_args, mal_value_is_callable(roots[1]) ? 2 : 1);
done:
    mal_gc_unroot(&root);
}

static MalValue zlib_method_flush(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalNodeZlibObject *state = zlib_this_state(vm, receiver);
    if (state == nullptr) return mal_value_new_undefined();
    MalValue kind = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue callback = argc > 1 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_callable(kind) || (mal_value_is_undefined(kind) && mal_value_is_undefined(callback))) {
        callback = kind;
        kind = mal_value_new_undefined();
    }
    i32 flush = state->format == MAL_ZLIB_FORMAT_BROTLI ? ZLIB_BROTLI_FLUSH : ZLIB_FLUSH_FULL;
    if (mal_ops_is_number(kind)) flush = (i32) mal_ops_number_as_f64(kind);
    zlib_write_marker(vm, receiver, state, flush, callback);
    return mal_value_new_undefined();
}

static MalValue zlib_method_params(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalNodeZlibObject *state = zlib_this_state(vm, receiver);
    if (state == nullptr) return mal_value_new_undefined();
    MalValue holder = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &holder, 1);
    zlib_set(vm, holder, "level", argc > 0 ? args[0] : mal_value_new_undefined());
    zlib_set(vm, holder, "strategy", argc > 1 ? args[1] : mal_value_new_undefined());
    f64 level, strategy;
    bool valid = zlib_option_range(vm, holder, "level", "level", -1, 9, -1, &level)
        && zlib_option_range(vm, holder, "strategy", "strategy", 0, 4, 0, &strategy);
    mal_gc_unroot(&root);
    if (!valid) return mal_value_new_undefined();
    MalValue callback = argc > 2 ? args[2] : mal_value_new_undefined();
    if (state->encode && state->format != MAL_ZLIB_FORMAT_BROTLI) {
        state->pending_level = (i32) level;
        state->has_pending_level = true;
    }
    zlib_set(vm, receiver, "_level", mal_value_from_f64(level));
    zlib_set(vm, receiver, "_strategy", mal_value_from_f64(strategy));
    zlib_write_marker(vm, receiver, state, ZLIB_FLUSH_SYNC, callback);
    return mal_value_new_undefined();
}

static MalValue zlib_method_reset(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalNodeZlibObject *state = zlib_this_state(vm, receiver);
    if (state == nullptr) return mal_value_new_undefined();
    if (state->handle == nullptr || mal_zlib_reset(state->handle) < 0)
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "zlib binding closed", "ERR_ZLIB_BINDING_CLOSED");
    return mal_value_new_undefined();
}

static MalValue zlib_method_close(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue roots[] = {receiver, argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_callable(roots[1])) {
        roots[2] = zlib_get(vm, receiver, "once");
        MalValue once_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "close")), roots[1]};
        if (mal_value_is_callable(roots[2])) mal_vm_call_value(vm, roots[2], receiver, once_args, 2);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[2] = zlib_get(vm, receiver, "destroy");
        if (mal_value_is_callable(roots[2])) mal_vm_call_value(vm, roots[2], receiver, nullptr, 0);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue zlib_crc32(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    MalValue data = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue initial = argc > 1 ? args[1] : mal_value_new_undefined();
    u32 value = 0;
    if (!mal_value_is_undefined(initial)) {
        if (!mal_ops_is_number(initial)) {
            zlib_throw_arg_type(vm, "value", "of type number", initial);
            return mal_value_new_undefined();
        }
        f64 number = mal_ops_number_as_f64(initial);
        if (!(number >= 0 && number <= UINT32_MAX && floor(number) == number)) {
            if (floor(number) != number) zlib_throw_range(vm, "value", "an integer", number);
            else zlib_throw_range(vm, "value", ">= 0 && <= 4294967295", number);
            return mal_value_new_undefined();
        }
        value = (u32) number;
    }
    if (!mal_value_is_string(data)) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(data, &span) != MAL_BUFFER_SOURCE_SPAN_OK || mal_value_is_array_buffer_object(data)) {
            zlib_throw_arg_type(vm, "data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
            return mal_value_new_undefined();
        }
    }
    const byte *bytes = nullptr;
    usize length = 0;
    byte *owned = nullptr;
    if (!zlib_input(vm, data, &bytes, &length, &owned)) return mal_value_new_undefined();
    value = mal_zlib_crc32(value, (const uint8_t *) bytes, length);
    free(owned);
    return mal_value_from_f64((f64) value);
}

static void zlib_define_function(MalVm *vm, MalValue module, const char *name,
    MalNativeFunctionCallback callback, MalValue *slots, u32 count, u32 arity, bool constructor) {
    MalNativeFunctionObject *native = mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), callback, slots, count);
    if (constructor) mal_native_function_object_set_constructor(native);
    MalValue function = mal_value_from_native_function_object(native);
    MalRootSpan root;
    mal_gc_root(&root, &function, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(function), (const byte *) "length",
        mal_value_from_i32((i32) arity), MAL_PROPERTY_CONFIGURABLE);
    if (constructor) {
        mal_intrinsic_define_data(vm, mal_value_to_object(function), (const byte *) "prototype",
            slots[1], MAL_PROPERTY_WRITABLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(slots[1]), (const byte *) "constructor",
            function, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(module), (const byte *) name, function, ZLIB_VISIBLE);
    mal_gc_unroot(&root);
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
    mal_host_install_node_stream(vm, nullptr, 0, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    mal_gc_register_finalizer(MAL_HEAP_NODE_ZLIB_OBJECT, zlib_finalize);
    mal_gc_register_tracer(MAL_HEAP_NODE_ZLIB_OBJECT, zlib_trace);
    if (!zlib_async_installed) {
        mal_gc_register_root_source(zlib_async_scan_roots, nullptr);
        mal_host_register_macrotask_drain(zlib_async_drain, false);
        zlib_async_installed = true;
    }
    if (!mal_vm_register_runtime_cleanup(vm, zlib_async_free)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "Could not register node:zlib runtime cleanup");
        return;
    }
    enum { MODULE, BASE, SLOT_KIND, SLOT_PROTO, TEMP, CONSTANTS, ROOT_COUNT };
    MalValue roots[ROOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[MODULE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[BASE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[TEMP] = zlib_get(vm, vm->intrinsics[MAL_INTRINSIC_NODE_TRANSFORM_CONSTRUCTOR], "prototype");
    if (mal_value_is_object(roots[TEMP]))
        mal_object_set_prototype_pointer(mal_value_to_object(roots[BASE]), mal_value_to_object(roots[TEMP]));
    static const struct {
        const char *name;
        MalNativeFunctionCallback callback;
        u32 arity;
    } methods[] = {
        {"flush", zlib_method_flush, 2},
        {"params", zlib_method_params, 3},
        {"reset", zlib_method_reset, 0},
        {"close", zlib_method_close, 1},
    };
    for (usize i = 0; i < countof(methods); i++) {
        roots[TEMP] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) methods[i].name), methods[i].arity,
            methods[i].callback));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[BASE]), (const byte *) methods[i].name,
            roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    for (usize i = 0; i < countof(zlib_kinds); i++) {
        roots[SLOT_KIND] = mal_value_from_i32((i32) i);
        roots[SLOT_PROTO] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_object_set_prototype_pointer(mal_value_to_object(roots[SLOT_PROTO]), mal_value_to_object(roots[BASE]));
        zlib_define_function(vm, roots[MODULE], zlib_kinds[i].class_name, zlib_create,
            roots + SLOT_KIND, 2, 1, true);
        zlib_define_function(vm, roots[MODULE], zlib_kinds[i].create, zlib_create,
            roots + SLOT_KIND, 2, 1, false);
        zlib_define_function(vm, roots[MODULE], zlib_kinds[i].sync, zlib_sync,
            roots + SLOT_KIND, 2, 2, false);
        zlib_define_function(vm, roots[MODULE], zlib_kinds[i].async, zlib_async,
            roots + SLOT_KIND, 1, 3, false);
    }
    zlib_define_function(vm, roots[MODULE], "crc32", zlib_crc32, nullptr, 0, 2, false);

    roots[CONSTANTS] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const struct {
        const char *name;
        f64 value;
    } constants[] = {
        {"Z_NO_FLUSH", 0},
        {"Z_PARTIAL_FLUSH", 1},
        {"Z_SYNC_FLUSH", 2},
        {"Z_FULL_FLUSH", 3},
        {"Z_FINISH", 4},
        {"Z_BLOCK", 5},
        {"Z_OK", 0},
        {"Z_STREAM_END", 1},
        {"Z_NEED_DICT", 2},
        {"Z_ERRNO", -1},
        {"Z_STREAM_ERROR", -2},
        {"Z_DATA_ERROR", -3},
        {"Z_MEM_ERROR", -4},
        {"Z_BUF_ERROR", -5},
        {"Z_VERSION_ERROR", -6},
        {"Z_NO_COMPRESSION", 0},
        {"Z_BEST_SPEED", 1},
        {"Z_BEST_COMPRESSION", 9},
        {"Z_DEFAULT_COMPRESSION", -1},
        {"Z_FILTERED", 1},
        {"Z_HUFFMAN_ONLY", 2},
        {"Z_RLE", 3},
        {"Z_FIXED", 4},
        {"Z_DEFAULT_STRATEGY", 0},
        {"ZLIB_VERNUM", 4897},
        {"DEFLATE", 1},
        {"INFLATE", 2},
        {"GZIP", 3},
        {"GUNZIP", 4},
        {"DEFLATERAW", 5},
        {"INFLATERAW", 6},
        {"UNZIP", 7},
        {"BROTLI_DECODE", 8},
        {"BROTLI_ENCODE", 9},
        {"ZSTD_DECOMPRESS", 11},
        {"ZSTD_COMPRESS", 10},
        {"Z_MIN_WINDOWBITS", 8},
        {"Z_MAX_WINDOWBITS", 15},
        {"Z_DEFAULT_WINDOWBITS", 15},
        {"Z_MIN_CHUNK", 64},
        {"Z_MAX_CHUNK", INFINITY},
        {"Z_DEFAULT_CHUNK", 16384},
        {"Z_MIN_MEMLEVEL", 1},
        {"Z_MAX_MEMLEVEL", 9},
        {"Z_DEFAULT_MEMLEVEL", 8},
        {"Z_MIN_LEVEL", -1},
        {"Z_MAX_LEVEL", 9},
        {"Z_DEFAULT_LEVEL", -1},
        {"BROTLI_OPERATION_PROCESS", 0},
        {"BROTLI_OPERATION_FLUSH", 1},
        {"BROTLI_OPERATION_FINISH", 2},
        {"BROTLI_OPERATION_EMIT_METADATA", 3},
        {"BROTLI_PARAM_MODE", 0},
        {"BROTLI_MODE_GENERIC", 0},
        {"BROTLI_MODE_TEXT", 1},
        {"BROTLI_MODE_FONT", 2},
        {"BROTLI_DEFAULT_MODE", 0},
        {"BROTLI_PARAM_QUALITY", 1},
        {"BROTLI_MIN_QUALITY", 0},
        {"BROTLI_MAX_QUALITY", 11},
        {"BROTLI_DEFAULT_QUALITY", 11},
        {"BROTLI_PARAM_LGWIN", 2},
        {"BROTLI_MIN_WINDOW_BITS", 10},
        {"BROTLI_MAX_WINDOW_BITS", 24},
        {"BROTLI_LARGE_MAX_WINDOW_BITS", 30},
        {"BROTLI_DEFAULT_WINDOW", 22},
        {"BROTLI_PARAM_LGBLOCK", 3},
        {"BROTLI_MIN_INPUT_BLOCK_BITS", 16},
        {"BROTLI_MAX_INPUT_BLOCK_BITS", 24},
        {"BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING", 4},
        {"BROTLI_PARAM_SIZE_HINT", 5},
        {"BROTLI_PARAM_LARGE_WINDOW", 6},
        {"BROTLI_PARAM_NPOSTFIX", 7},
        {"BROTLI_PARAM_NDIRECT", 8},
        {"BROTLI_DECODER_RESULT_ERROR", 0},
        {"BROTLI_DECODER_RESULT_SUCCESS", 1},
        {"BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT", 2},
        {"BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT", 3},
        {"BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION", 0},
        {"BROTLI_DECODER_PARAM_LARGE_WINDOW", 1},
        {"BROTLI_DECODER_NO_ERROR", 0},
        {"BROTLI_DECODER_SUCCESS", 1},
        {"BROTLI_DECODER_NEEDS_MORE_INPUT", 2},
        {"BROTLI_DECODER_NEEDS_MORE_OUTPUT", 3},
        {"BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE", -1},
        {"BROTLI_DECODER_ERROR_FORMAT_RESERVED", -2},
        {"BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE", -3},
        {"BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET", -4},
        {"BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME", -5},
        {"BROTLI_DECODER_ERROR_FORMAT_CL_SPACE", -6},
        {"BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE", -7},
        {"BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT", -8},
        {"BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1", -9},
        {"BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2", -10},
        {"BROTLI_DECODER_ERROR_FORMAT_TRANSFORM", -11},
        {"BROTLI_DECODER_ERROR_FORMAT_DICTIONARY", -12},
        {"BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS", -13},
        {"BROTLI_DECODER_ERROR_FORMAT_PADDING_1", -14},
        {"BROTLI_DECODER_ERROR_FORMAT_PADDING_2", -15},
        {"BROTLI_DECODER_ERROR_FORMAT_DISTANCE", -16},
        {"BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET", -19},
        {"BROTLI_DECODER_ERROR_INVALID_ARGUMENTS", -20},
        {"BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES", -21},
        {"BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS", -22},
        {"BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP", -25},
        {"BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1", -26},
        {"BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2", -27},
        {"BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES", -30},
        {"BROTLI_DECODER_ERROR_UNREACHABLE", -31},
        {"ZSTD_e_continue", 0},
        {"ZSTD_e_flush", 1},
        {"ZSTD_e_end", 2},
        {"ZSTD_fast", 1},
        {"ZSTD_dfast", 2},
        {"ZSTD_greedy", 3},
        {"ZSTD_lazy", 4},
        {"ZSTD_lazy2", 5},
        {"ZSTD_btlazy2", 6},
        {"ZSTD_btopt", 7},
        {"ZSTD_btultra", 8},
        {"ZSTD_btultra2", 9},
        {"ZSTD_c_compressionLevel", 100},
        {"ZSTD_c_windowLog", 101},
        {"ZSTD_c_hashLog", 102},
        {"ZSTD_c_chainLog", 103},
        {"ZSTD_c_searchLog", 104},
        {"ZSTD_c_minMatch", 105},
        {"ZSTD_c_targetLength", 106},
        {"ZSTD_c_strategy", 107},
        {"ZSTD_c_enableLongDistanceMatching", 160},
        {"ZSTD_c_ldmHashLog", 161},
        {"ZSTD_c_ldmMinMatch", 162},
        {"ZSTD_c_ldmBucketSizeLog", 163},
        {"ZSTD_c_ldmHashRateLog", 164},
        {"ZSTD_c_contentSizeFlag", 200},
        {"ZSTD_c_checksumFlag", 201},
        {"ZSTD_c_dictIDFlag", 202},
        {"ZSTD_c_nbWorkers", 400},
        {"ZSTD_c_jobSize", 401},
        {"ZSTD_c_overlapLog", 402},
        {"ZSTD_d_windowLogMax", 100},
        {"ZSTD_CLEVEL_DEFAULT", 3},
        {"ZSTD_error_no_error", 0},
        {"ZSTD_error_GENERIC", 1},
        {"ZSTD_error_prefix_unknown", 10},
        {"ZSTD_error_version_unsupported", 12},
        {"ZSTD_error_frameParameter_unsupported", 14},
        {"ZSTD_error_frameParameter_windowTooLarge", 16},
        {"ZSTD_error_corruption_detected", 20},
        {"ZSTD_error_checksum_wrong", 22},
        {"ZSTD_error_literals_headerWrong", 24},
        {"ZSTD_error_dictionary_corrupted", 30},
        {"ZSTD_error_dictionary_wrong", 32},
        {"ZSTD_error_dictionaryCreation_failed", 34},
        {"ZSTD_error_parameter_unsupported", 40},
        {"ZSTD_error_parameter_combination_unsupported", 41},
        {"ZSTD_error_parameter_outOfBound", 42},
        {"ZSTD_error_tableLog_tooLarge", 44},
        {"ZSTD_error_maxSymbolValue_tooLarge", 46},
        {"ZSTD_error_maxSymbolValue_tooSmall", 48},
        {"ZSTD_error_stabilityCondition_notRespected", 50},
        {"ZSTD_error_stage_wrong", 60},
        {"ZSTD_error_init_missing", 62},
        {"ZSTD_error_memory_allocation", 64},
        {"ZSTD_error_workSpace_tooSmall", 66},
        {"ZSTD_error_dstSize_tooSmall", 70},
        {"ZSTD_error_srcSize_wrong", 72},
        {"ZSTD_error_dstBuffer_null", 74},
        {"ZSTD_error_noForwardProgress_destFull", 80},
        {"ZSTD_error_noForwardProgress_inputEmpty", 82},
    };
    for (usize i = 0; i < countof(constants); i++) {
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[CONSTANTS]), (const byte *) constants[i].name,
            mal_value_from_f64(constants[i].value), MAL_PROPERTY_ENUMERABLE);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[MODULE]), (const byte *) "constants",
        roots[CONSTANTS], ZLIB_VISIBLE);
    static const struct {
        const char *name;
        i32 value;
    } codes[] = {
        {"Z_OK", 0}, {"Z_STREAM_END", 1}, {"Z_NEED_DICT", 2}, {"Z_ERRNO", -1},
        {"Z_STREAM_ERROR", -2}, {"Z_DATA_ERROR", -3}, {"Z_MEM_ERROR", -4},
        {"Z_BUF_ERROR", -5}, {"Z_VERSION_ERROR", -6},
    };
    roots[CONSTANTS] = mal_value_from_object(mal_intrinsic_new_object(vm));
    for (usize i = 0; i < countof(codes); i++) {
        char index[8];
        snprintf(index, sizeof index, "%d", codes[i].value);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[CONSTANTS]), (const byte *) codes[i].name,
            mal_value_from_i32(codes[i].value), MAL_PROPERTY_ENUMERABLE);
        // Non-negative codes are array-index keys, which string-keyed defines would not produce.
        MalPropertyDesc name = mal_intrinsic_data_desc(
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) codes[i].name)),
            MAL_PROPERTY_ENUMERABLE);
        mal_object_define_own(mal_value_to_object(roots[CONSTANTS]),
            codes[i].value >= 0 ? mal_key_index((u32) codes[i].value)
                : mal_intrinsic_string_key(vm, (const byte *) index),
            &name);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[MODULE]), (const byte *) "codes",
        roots[CONSTANTS], ZLIB_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_ZLIB_MODULE] = roots[MODULE];
    zlib_install_exports(vm, slots, count, roots[MODULE]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
