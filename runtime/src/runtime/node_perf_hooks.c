#include "node_perf_hooks.h"

#if MAL_NODE

#include <math.h>
#include <string.h>
#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "utf8.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "web_events_object.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "monotonic_clock.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "vm_ops.h"
#include "value_ops.h"
#include "web_host_timer.h"

#define PERF_HOOKS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

// Each isolate's timeOrigin starts with its own first use.
static MAL_ISOLATE_LOCAL i64 node_perf_hooks_origin_ns;
static MAL_ISOLATE_LOCAL MalValue perf_histogram_prototype;

static MalValue node_performance_now(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_from_f64(
        (f64) (mal_monotonic_now_ns() - node_perf_hooks_origin_ns) / 1.0e6);
}

typedef struct MalNodeDelayHistogram {
    i64 resolution_ms;
    i64 timer_id;
    i64 last_ns;
    bool enabled;
    u64 count;
    u64 exceeds;
    u64 min;
    u64 max;
    double mean;
    double m2;
    u64 buckets[2048];
} MalNodeDelayHistogram;

static MalNodeDelayHistogram *node_delay_state(MalValue callee) {
    MalValue buffer = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return (MalNodeDelayHistogram *) mal_value_to_array_buffer_object(buffer)->data;
}

static MalValue node_delay_sample(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    if (!state->enabled) return mal_value_new_undefined();
    i64 now = mal_monotonic_now_ns();
    u64 elapsed = (u64) (now - state->last_ns);
    state->last_ns = now;
    if (elapsed > UINT64_C(3600000000000)) state->exceeds++;
    if (elapsed < state->min) state->min = elapsed;
    if (elapsed > state->max) state->max = elapsed;
    double delta = (double) elapsed - state->mean;
    state->mean += delta / (double) ++state->count;
    state->m2 += delta * ((double) elapsed - state->mean);
    // Logarithmic buckets retain all samples with at most 2.2% quantile rounding.
    usize bucket = elapsed > 0 ? (usize) (log2((double) elapsed) * 32) : 0;
    if (bucket >= countof(state->buckets)) bucket = countof(state->buckets) - 1;
    state->buckets[bucket]++;
    state->timer_id = mal_host_set_timeout(vm, callee, state->resolution_ms, nullptr, 0);
    mal_host_timer_set_referenced(vm, state->timer_id, false);
    return mal_value_new_undefined();
}

static MalValue node_delay_enable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    if (state->enabled) return mal_value_new_boolean(false);
    state->enabled = true;
    state->last_ns = mal_monotonic_now_ns();
    MalValue buffer = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue task = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "eventLoopDelaySample"), node_delay_sample, &buffer, 1));
    MalRootSpan root;
    mal_gc_root(&root, &task, 1);
    state->timer_id = mal_host_set_timeout(vm, task, state->resolution_ms, nullptr, 0);
    mal_host_timer_set_referenced(vm, state->timer_id, false);
    mal_gc_unroot(&root);
    return mal_value_new_boolean(true);
}

static MalValue node_delay_disable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    bool enabled = state->enabled;
    state->enabled = false;
    mal_host_clear_timeout(vm, state->timer_id);
    return mal_value_new_boolean(enabled);
}

static MalValue node_delay_reset(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc; (void) nt;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    state->count = 0;
    state->exceeds = 0;
    state->min = INT64_MAX;
    state->max = 0;
    state->mean = state->m2 = 0;
    memset(state->buckets, 0, sizeof(state->buckets));
    return mal_value_new_undefined();
}

static MalValue node_delay_get(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc; (void) nt;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    i32 field = mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 1));
    double value = field == 0 ? (double) state->min : field == 1 ? (double) state->max
        : field == 2 ? (state->count > 0 ? state->mean : NAN)
        : field == 3 ? (state->count > 0 ? sqrt(state->m2 / (double) state->count) : NAN)
        : field == 4 ? (double) state->exceeds : (double) state->count;
    return mal_value_from_f64_convert_nan(value);
}

static MalValue node_delay_percentile(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt;
    double percent;
    if (argc == 0 || !mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Percentile must be a number");
        return mal_value_new_undefined();
    }
    percent = mal_ops_number_as_f64(args[0]);
    if (!isfinite(percent) || percent <= 0 || percent > 100) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Percentile must be in (0, 100]");
        return mal_value_new_undefined();
    }
    MalNodeDelayHistogram *state = node_delay_state(callee);
    if (state->count == 0) return mal_value_from_i32(0);
    u64 target = (u64) ceil((double) state->count * percent / 100);
    u64 count = 0;
    for (usize i = 0; i < countof(state->buckets); i++) {
        count += state->buckets[i];
        if (count >= target) return mal_value_from_f64(exp2((double) i / 32));
    }
    return mal_value_from_f64((double) state->max);
}

static MalValue node_histogram_new(MalVm *vm, i64 resolution, bool recordable);

static MalValue node_monitor_event_loop_delay(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    i64 resolution = 10;
    MalValue option;
    if (argc > 0 && mal_value_is_object(args[0])) {
        if (!mal_vm_get_property(vm, args[0],
                mal_intrinsic_string_key(vm, (const byte *) "resolution"), &option)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(option)) {
            double number;
            if (!mal_ops_is_number(option) || !mal_vm_to_number(vm, option, &number)
                || !isfinite(number) || trunc(number) != number || number <= 0 || number > INT32_MAX) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid histogram resolution");
                return mal_value_new_undefined();
            }
            resolution = (i64) number;
        }
    }
    return node_histogram_new(vm, resolution, false);
}

static MalValue perf_histogram_record(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee);
static MalValue perf_histogram_record_delta(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee);
/* Interval histograms sample the loop; recordable ones take explicit values. */
static MalValue node_histogram_new(MalVm *vm, i64 resolution, bool recordable) {
    MalValue roots[] = {mal_value_from_object(recordable
            ? mal_object_new(&vm->heap, mal_value_to_object(perf_histogram_prototype)) : mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = mal_value_from_array_buffer_object(mal_array_buffer_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        sizeof(MalNodeDelayHistogram), sizeof(MalNodeDelayHistogram), false, false));
    MalNodeDelayHistogram *state = (MalNodeDelayHistogram *) mal_value_to_array_buffer_object(roots[1])->data;
    if (state == nullptr) {
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    state->resolution_ms = resolution;
    state->min = INT64_MAX;
    static const char *numeric_names[] = {"min", "max", "mean", "stddev", "exceeds", "count"};
    for (usize i = 0; i < countof(numeric_names); i++) {
        MalValue slots[] = {roots[1], mal_value_from_i32((i32) i)};
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) numeric_names[i]), 0, node_delay_get, slots, 2));
        MalPropertyDesc descriptor = mal_intrinsic_accessor_desc(roots[2], mal_value_new_undefined(),
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(mal_value_to_object(roots[0]),
            mal_intrinsic_string_key(vm, (const byte *) numeric_names[i]), &descriptor);
    }
    const struct {const char *name; MalNativeFunctionCallback callback; i32 length;} delay_methods[] = {
        {"disable", node_delay_disable, 0}, {"enable", node_delay_enable, 0},
        {"reset", node_delay_reset, 0}, {"percentile", node_delay_percentile, 1},
    }, recordable_methods[] = {
        {"record", perf_histogram_record, 1}, {"recordDelta", perf_histogram_record_delta, 0},
        {"reset", node_delay_reset, 0}, {"percentile", node_delay_percentile, 1},
    };
    for (usize i = 0; i < countof(delay_methods); i++) {
        const char *name = recordable ? recordable_methods[i].name : delay_methods[i].name;
        MalNativeFunctionCallback callback = recordable ? recordable_methods[i].callback : delay_methods[i].callback;
        i32 length = recordable ? recordable_methods[i].length : delay_methods[i].length;
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name), length, callback, roots + 1, 1));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) name, roots[2], PERF_HOOKS_VISIBLE);
    }
    MalValue histogram = roots[0];
    mal_gc_unroot(&root);
    return histogram;
}


/* ---------------------------------------------------------------------------
 * User timing, observers, timerify, histograms.
 * --------------------------------------------------------------------------- */

enum {
    PERF_SYMBOL,
    PERF_ENTRY_PROTO,
    PERF_MARK_PROTO,
    PERF_MEASURE_PROTO,
    PERF_OBSERVER_PROTO,
    PERF_LIST_PROTO,
    PERF_BUFFER,
    PERF_OBSERVERS,
    PERF_PERFORMANCE,
    PERF_NODE_TIMING,
    PERF_HISTOGRAM_PROTO,
    PERF_STATE_COUNT,
};

/* Entry fields behind the private symbol: [name, entryType, startTime, duration, detail]. */
enum { ENTRY_NAME, ENTRY_TYPE, ENTRY_START, ENTRY_DURATION, ENTRY_DETAIL, ENTRY_FIELDS };
/* Observer fields: [callback, types, records, pending, buffered-type]. */
enum { OBSERVER_CALLBACK, OBSERVER_TYPES, OBSERVER_RECORDS, OBSERVER_PENDING, OBSERVER_FIELDS };

static MAL_ISOLATE_LOCAL MalValue perf_state[PERF_STATE_COUNT];
static MAL_ISOLATE_LOCAL bool perf_ready;
static MAL_ISOLATE_LOCAL f64 perf_bootstrap_ms;

static void perf_scan_roots(MalVm *vm, void *data) {
    (void) vm; (void) data;
    if (!perf_ready) return;
    for (usize i = 0; i < PERF_STATE_COUNT; i++) mal_gc_mark_value(perf_state[i]);
    mal_gc_mark_value(perf_histogram_prototype);
}

static f64 perf_now(void) {
    return (f64) (mal_monotonic_now_ns() - node_perf_hooks_origin_ns) / 1.0e6;
}

static MalValue perf_string(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) text));
}

static MalValue perf_array(MalVm *vm, const MalValue *values, u32 count) {
    return mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), values, count));
}

static u32 perf_length(MalValue array) {
    return mal_value_is_array_object(array) ? mal_array_object_length(mal_value_to_array_object(array)) : 0;
}

static MalValue perf_at(MalVm *vm, MalValue array, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_vm_get_property(vm, array, mal_key_index(index), &value);
    return value;
}

static void perf_push(MalValue array, MalValue value) {
    MalArrayObject *object = mal_value_to_array_object(array);
    mal_array_object_store(object, mal_key_index(mal_array_object_length(object)), value);
}

static MalValue perf_internal(MalValue object) {
    if (!perf_ready || !mal_value_is_object(object)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = perf_state[PERF_SYMBOL]});
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void perf_throw_code(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    mal_node_throw_code(vm, prototype, message, code);
}

static bool perf_string_is(MalValue value, MalValue other) {
    return mal_value_is_string(value) && mal_value_is_string(other)
        && mal_string_equals(mal_value_to_string(value), mal_value_to_string(other));
}


/* The "Received ..." suffix of Node's ERR_INVALID_ARG_TYPE for primitive values. */
static void perf_received(MalVm *vm, MalValue value, char *out, usize capacity) {
    if (mal_value_is_undefined(value)) { snprintf(out, capacity, "undefined"); return; }
    if (mal_value_is_null(value)) { snprintf(out, capacity, "null"); return; }
    if (mal_value_is_boolean(value)) {
        snprintf(out, capacity, "type boolean (%s)", mal_value_to_boolean(value) ? "true" : "false");
        return;
    }
    if (mal_ops_is_number(value)) {
        snprintf(out, capacity, "type number (%.17g)", mal_ops_number_as_f64(value));
        return;
    }
    if (mal_value_is_string(value)) {
        usize length;
        byte *utf8 = mal_string_to_utf8(mal_value_to_string(value), &length);
        snprintf(out, capacity, "type string ('%.*s')", (int) (length < 25 ? length : 25), utf8 != nullptr ? utf8 : "");
        free(utf8);
        return;
    }
    (void) vm;
    snprintf(out, capacity, mal_value_is_callable(value) ? "function" : "an instance of Object");
}

static MalValue perf_new_entry(MalVm *vm, MalValue prototype, MalValue name, const char *type, f64 start,
    f64 duration, MalValue detail) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(prototype))),
        name, detail, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue fields[ENTRY_FIELDS] = {roots[1], perf_string(vm, type), mal_value_from_f64(start),
        mal_value_from_f64(duration), roots[2]};
    roots[3] = perf_array(vm, fields, ENTRY_FIELDS);
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = perf_state[PERF_SYMBOL]},
        roots[3]);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue perf_field(MalVm *vm, MalValue entry, i32 field) {
    MalValue fields = perf_internal(entry);
    return mal_value_is_array_object(fields) ? perf_at(vm, fields, (u32) field) : mal_value_new_undefined();
}

static MalValue perf_entry_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    MalValue fields = perf_internal(receiver);
    if (!mal_value_is_array_object(fields)) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value of \"this\" must be of type PerformanceEntry",
            "ERR_INVALID_THIS");
        return mal_value_new_undefined();
    }
    i32 field = mal_value_to_i32(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    MalValue value = perf_at(vm, fields, (u32) field);
    return field == ENTRY_DETAIL && mal_value_is_undefined(value) ? mal_value_new_null() : value;
}

static MalValue perf_entry_to_json(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue fields = perf_internal(receiver);
    if (!mal_value_is_array_object(fields)) return mal_value_new_undefined();
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), fields};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const char *const names[] = {"name", "entryType", "startTime", "duration", "detail"};
    for (u32 i = 0; i < ENTRY_FIELDS; i++) {
        MalValue value = perf_at(vm, roots[1], i);
        if (i == ENTRY_DETAIL && mal_value_is_undefined(value)) value = mal_value_new_null();
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) names[i], value, PERF_HOOKS_VISIBLE);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue perf_observer_deliver(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt;
    MalValue roots[] = {mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = perf_internal(roots[0]);
    if (mal_value_is_array_object(roots[1])) {
        roots[2] = perf_at(vm, roots[1], OBSERVER_RECORDS);
        mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(OBSERVER_RECORDS), perf_array(vm, nullptr, 0));
        mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(OBSERVER_PENDING), mal_value_new_boolean(false));
        if (perf_length(roots[2]) > 0) {
            roots[3] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(perf_state[PERF_LIST_PROTO])));
            mal_object_set(mal_value_to_object(roots[3]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = perf_state[PERF_SYMBOL]},
                roots[2]);
            MalValue callback = perf_at(vm, roots[1], OBSERVER_CALLBACK);
            MalValue call_args[] = {roots[3], roots[0]};
            mal_vm_call_value(vm, callback, roots[0], call_args, 2);
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static bool perf_observer_wants(MalVm *vm, MalValue internal, MalValue type) {
    MalValue types = perf_at(vm, internal, OBSERVER_TYPES);
    for (u32 i = 0; i < perf_length(types); i++) {
        if (perf_string_is(perf_at(vm, types, i), type)) return true;
    }
    return false;
}

static void perf_observer_queue(MalVm *vm, MalValue observer, MalValue internal, MalValue entry) {
    MalValue roots[] = {observer, internal, entry, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    perf_push(perf_at(vm, roots[1], OBSERVER_RECORDS), roots[2]);
    if (!mal_value_is_truthy(perf_at(vm, roots[1], OBSERVER_PENDING))) {
        mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(OBSERVER_PENDING), mal_value_new_boolean(true));
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "deliverPerformanceEntries"), perf_observer_deliver, roots, 1));
        (void) mal_host_set_timeout(vm, roots[3], 0, nullptr, 0);
    }
    mal_gc_unroot(&root);
}

static bool perf_has_observer(MalVm *vm, const char *type) {
    MalValue name = perf_string(vm, type);
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    bool found = false;
    for (u32 i = 0; !found && i < perf_length(perf_state[PERF_OBSERVERS]); i++) {
        found = perf_observer_wants(vm, perf_internal(perf_at(vm, perf_state[PERF_OBSERVERS], i)), name);
    }
    mal_gc_unroot(&root);
    return found;
}

static void perf_enqueue(MalVm *vm, MalValue entry) {
    MalValue roots[] = {entry, perf_field(vm, entry, ENTRY_TYPE), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (u32 i = 0; i < perf_length(perf_state[PERF_OBSERVERS]); i++) {
        roots[2] = perf_at(vm, perf_state[PERF_OBSERVERS], i);
        roots[3] = perf_internal(roots[2]);
        if (mal_value_is_array_object(roots[3]) && perf_observer_wants(vm, roots[3], roots[1])) {
            perf_observer_queue(vm, roots[2], roots[3], roots[0]);
        }
    }
    mal_gc_unroot(&root);
}

static MalValue perf_validate_timestamp(MalVm *vm, MalValue value, bool *ok) {
    *ok = true;
    if (!mal_ops_is_number(value)) return value;
    f64 number = mal_ops_number_as_f64(value);
    if (number < 0 || isnan(number)) {
        char text[64];
        snprintf(text, sizeof(text), "%g is not a valid timestamp", number);
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, text, "ERR_PERFORMANCE_INVALID_TIMESTAMP");
        *ok = false;
    }
    return value;
}

/* Node stores structuredClone(detail); the global is the web platform's clone. */
static bool perf_clone_detail(MalVm *vm, MalValue *detail) {
    if (mal_value_is_nil(*detail)) {
        *detail = mal_value_new_null();
        return true;
    }
    MalValue clone;
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    if (!mal_value_is_object(global)
        || !mal_vm_get_property(vm, global, mal_intrinsic_string_key(vm, (const byte *) "structuredClone"), &clone)) {
        return false;
    }
    if (!mal_value_is_callable(clone)) return true;
    MalCompletion cloned = mal_vm_call_value(vm, clone, mal_value_new_undefined(), detail, 1);
    if (cloned.kind == MAL_COMPLETION_THROW) return false;
    *detail = cloned.value;
    return true;
}

static MalValue perf_mark(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), mal_value_new_null(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalString *name;
    if (!mal_vm_to_string(vm, roots[0], &name)) goto done;
    roots[0] = mal_value_from_string(name);
    f64 start = perf_now();
    MalValue options = argc > 1 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_object(options)) {
        MalValue value;
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "startTime"), &value)) goto done;
        if (!mal_value_is_undefined(value)) {
            if (!mal_ops_is_number(value)) {
                perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "The \"options.startTime\" property must be of type number", "ERR_INVALID_ARG_TYPE");
                goto done;
            }
            bool ok;
            perf_validate_timestamp(vm, value, &ok);
            if (!ok) goto done;
            start = mal_ops_number_as_f64(value);
        }
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "detail"), &roots[1])) goto done;
        if (!perf_clone_detail(vm, &roots[1])) goto done;
    }
    roots[2] = perf_new_entry(vm, perf_state[PERF_MARK_PROTO], roots[0], "mark", start, 0, roots[1]);
    perf_push(perf_state[PERF_BUFFER], roots[2]);
    perf_enqueue(vm, roots[2]);
    result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}

static const char *const PERF_NODE_TIMING_FIELDS[] = {
    "nodeStart", "v8Start", "bootstrapComplete", "environment", "loopStart", "loopExit", "idleTime"};

/* getMark: numbers pass through, nodeTiming milestones and the latest mark of a name resolve. */
static bool perf_get_mark(MalVm *vm, MalValue name, f64 *out) {
    if (mal_ops_is_number(name)) {
        bool ok;
        perf_validate_timestamp(vm, name, &ok);
        if (ok) *out = mal_ops_number_as_f64(name);
        return ok;
    }
    MalString *text;
    if (!mal_vm_to_string(vm, name, &text)) return false;
    MalValue key = mal_value_from_string(text);
    MalRootSpan root;
    mal_gc_root(&root, &key, 1);
    for (usize i = 0; i < countof(PERF_NODE_TIMING_FIELDS); i++) {
        if (mal_string_equals_ascii(text, PERF_NODE_TIMING_FIELDS[i])) {
            MalValue value;
            bool ok = mal_vm_get_property(vm, perf_state[PERF_NODE_TIMING],
                mal_intrinsic_string_key(vm, (const byte *) PERF_NODE_TIMING_FIELDS[i]), &value);
            if (ok) *out = mal_ops_is_number(value) ? mal_ops_number_as_f64(value) : 0;
            mal_gc_unroot(&root);
            return ok;
        }
    }
    MalValue buffer = perf_state[PERF_BUFFER];
    for (u32 i = perf_length(buffer); i > 0; i--) {
        MalValue entry = perf_at(vm, buffer, i - 1);
        MalValue type = perf_field(vm, entry, ENTRY_TYPE);
        if (mal_value_is_string(type) && mal_string_equals_ascii(mal_value_to_string(type), "mark")
            && perf_string_is(perf_field(vm, entry, ENTRY_NAME), key)) {
            *out = mal_ops_number_as_f64(perf_field(vm, entry, ENTRY_START));
            mal_gc_unroot(&root);
            return true;
        }
    }
    char message[256];
    char name_text[160];
    usize length;
    byte *utf8 = mal_string_to_utf8(text, &length);
    snprintf(name_text, sizeof(name_text), "%.*s", (int) (length < 150 ? length : 150), utf8 != nullptr ? utf8 : "");
    free(utf8);
    snprintf(message, sizeof(message), "The \"%s\" performance mark has not been set", name_text);
    mal_dom_exception_throw(vm, (const byte *) message, (const byte *) "SyntaxError");
    mal_gc_unroot(&root);
    return false;
}

static MalValue perf_measure(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    MalValue undefined = mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : undefined, argc > 1 ? args[1] : undefined, argc > 2 ? args[2] : undefined,
        undefined, undefined, undefined, mal_value_new_null(), undefined};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = undefined;
    MalString *name;
    if (!mal_vm_to_string(vm, roots[0], &name)) goto done;
    roots[0] = mal_value_from_string(name);
    if (mal_value_is_null(roots[1])) roots[1] = undefined;
    bool options_valid = false;
    if (mal_value_is_object(roots[1])) {
        if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "start"), &roots[3])
            || !mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "end"), &roots[4])
            || !mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "duration"), &roots[5])
            || !mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "detail"), &roots[6])) {
            goto done;
        }
        if (!perf_clone_detail(vm, &roots[6])) goto done;
        options_valid = !mal_value_is_undefined(roots[3]) || !mal_value_is_undefined(roots[4]);
    }
    if (options_valid) {
        if (!mal_value_is_undefined(roots[2])) {
            perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "endMark must not be specified",
                "ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS");
            goto done;
        }
        if (!mal_value_is_undefined(roots[3]) && !mal_value_is_undefined(roots[4]) && !mal_value_is_undefined(roots[5])) {
            perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Must not have options.start, options.end, and options.duration specified",
                "ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS");
            goto done;
        }
    }
    f64 end = 0, start = 0, duration = 0;
    if (!mal_value_is_undefined(roots[2])) {
        if (!perf_get_mark(vm, roots[2], &end)) goto done;
    } else if (options_valid && !mal_value_is_undefined(roots[4])) {
        if (!perf_get_mark(vm, roots[4], &end)) goto done;
    } else if (options_valid && !mal_value_is_undefined(roots[3]) && !mal_value_is_undefined(roots[5])) {
        f64 base;
        if (!perf_get_mark(vm, roots[3], &base) || !perf_get_mark(vm, roots[5], &duration)) goto done;
        end = base + duration;
    } else {
        end = perf_now();
    }
    if (mal_value_is_string(roots[1])) {
        if (!perf_get_mark(vm, roots[1], &start)) goto done;
    } else if (options_valid && !mal_value_is_undefined(roots[3])) {
        if (!perf_get_mark(vm, roots[3], &start)) goto done;
    } else if (options_valid && !mal_value_is_undefined(roots[5])) {
        if (!perf_get_mark(vm, roots[5], &duration)) goto done;
        start = end - duration;
    }
    roots[7] = perf_new_entry(vm, perf_state[PERF_MEASURE_PROTO], roots[0], "measure", start, end - start, roots[6]);
    perf_push(perf_state[PERF_BUFFER], roots[7]);
    perf_enqueue(vm, roots[7]);
    result = roots[7];
done:
    mal_gc_unroot(&root);
    return result;
}

/* Entries from `source` matching the optional name/type, ordered by startTime. */
static MalValue perf_filter(MalVm *vm, MalValue source, MalValue name, MalValue type) {
    u32 count = perf_length(source);
    MalValue *values = calloc(count > 0 ? count : 1, sizeof(MalValue));
    if (values == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    MalValue roots[] = {source, name, type};
    MalRootSpan root, values_root;
    mal_gc_root(&root, roots, countof(roots));
    u32 kept = 0;
    for (u32 i = 0; i < count; i++) {
        MalValue entry = perf_at(vm, roots[0], i);
        if (!mal_value_is_undefined(roots[1]) && !perf_string_is(perf_field(vm, entry, ENTRY_NAME), roots[1])) continue;
        if (!mal_value_is_undefined(roots[2]) && !perf_string_is(perf_field(vm, entry, ENTRY_TYPE), roots[2])) continue;
        f64 start = mal_ops_number_as_f64(perf_field(vm, entry, ENTRY_START));
        u32 at = kept++;
        while (at > 0 && mal_ops_number_as_f64(perf_field(vm, values[at - 1], ENTRY_START)) > start) {
            values[at] = values[at - 1];
            at--;
        }
        values[at] = entry;
    }
    mal_gc_root(&values_root, values, (i32) kept);
    MalValue array = perf_array(vm, values, kept);
    mal_gc_unroot(&values_root);
    mal_gc_unroot(&root);
    free(values);
    return array;
}

static bool perf_name_arg(MalVm *vm, const MalValue *args, i32 argc, i32 index, MalValue *out) {
    *out = mal_value_new_undefined();
    if (argc <= index || mal_value_is_undefined(args[index])) return true;
    MalString *text;
    if (!mal_vm_to_string(vm, args[index], &text)) return false;
    *out = mal_value_from_string(text);
    return true;
}

static MalValue perf_entries_source(MalValue receiver) {
    MalValue internal = perf_internal(receiver);
    return mal_value_is_array_object(internal) && !mal_value_is_undefined(internal) && receiver != perf_state[PERF_PERFORMANCE]
        ? internal : perf_state[PERF_BUFFER];
}

static MalValue perf_get_entries(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    return perf_filter(vm, perf_entries_source(receiver), mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue perf_get_entries_by_name(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue name, type;
    if (argc < 1) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"name\" argument must be specified", "ERR_MISSING_ARGS");
        return mal_value_new_undefined();
    }
    if (!perf_name_arg(vm, args, argc, 0, &name)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &name, 1);
    bool ok = perf_name_arg(vm, args, argc, 1, &type);
    mal_gc_unroot(&root);
    return ok ? perf_filter(vm, perf_entries_source(receiver), name, type) : mal_value_new_undefined();
}

static MalValue perf_get_entries_by_type(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue type;
    if (argc < 1) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"type\" argument must be specified", "ERR_MISSING_ARGS");
        return mal_value_new_undefined();
    }
    if (!perf_name_arg(vm, args, argc, 0, &type)) return mal_value_new_undefined();
    return perf_filter(vm, perf_entries_source(receiver), mal_value_new_undefined(), type);
}

static MalValue perf_clear(MalVm *vm, const MalValue *args, i32 argc, const char *type_name) {
    MalValue name;
    if (!perf_name_arg(vm, args, argc, 0, &name)) return mal_value_new_undefined();
    MalValue roots[] = {name, perf_string(vm, type_name), perf_array(vm, nullptr, 0)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue buffer = perf_state[PERF_BUFFER];
    for (u32 i = 0; i < perf_length(buffer); i++) {
        MalValue entry = perf_at(vm, buffer, i);
        bool drop = perf_string_is(perf_field(vm, entry, ENTRY_TYPE), roots[1])
            && (mal_value_is_undefined(roots[0]) || perf_string_is(perf_field(vm, entry, ENTRY_NAME), roots[0]));
        if (!drop) perf_push(roots[2], entry);
    }
    perf_state[PERF_BUFFER] = roots[2];
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue perf_clear_marks(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    return perf_clear(vm, args, argc, "mark");
}

static MalValue perf_clear_measures(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    return perf_clear(vm, args, argc, "measure");
}

/* Loop milestones the runtime does not record are approximated by the module's first use. */
static MalValue perf_event_loop_utilization(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    f64 active = perf_now() - perf_bootstrap_ms;
    f64 idle = 0;
    MalValue first = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue second = argc > 1 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_object(first)) {
        MalValue idle_value, active_value;
        MalValue base = mal_value_is_object(second) ? second : first;
        if (!mal_vm_get_property(vm, base, mal_intrinsic_string_key(vm, (const byte *) "idle"), &idle_value)
            || !mal_vm_get_property(vm, base, mal_intrinsic_string_key(vm, (const byte *) "active"), &active_value)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_object(second)) {
            MalValue first_idle, first_active;
            if (!mal_vm_get_property(vm, first, mal_intrinsic_string_key(vm, (const byte *) "idle"), &first_idle)
                || !mal_vm_get_property(vm, first, mal_intrinsic_string_key(vm, (const byte *) "active"), &first_active)) {
                return mal_value_new_undefined();
            }
            idle = mal_ops_number_as_f64(first_idle) - mal_ops_number_as_f64(idle_value);
            active = mal_ops_number_as_f64(first_active) - mal_ops_number_as_f64(active_value);
        } else {
            idle -= mal_ops_number_as_f64(idle_value);
            active -= mal_ops_number_as_f64(active_value);
        }
    }
    MalValue result = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) "idle", mal_value_from_f64(idle), PERF_HOOKS_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) "active", mal_value_from_f64(active), PERF_HOOKS_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(result), (const byte *) "utilization",
        mal_value_from_f64(idle + active > 0 ? active / (idle + active) : 0), PERF_HOOKS_VISIBLE);
    mal_gc_unroot(&root);
    return result;
}

static MalValue perf_node_timing_duration(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) receiver; (void) args; (void) argc; (void) nt; (void) callee;
    return mal_value_from_f64(perf_now());
}

static MalValue perf_to_json(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "nodeTiming", perf_state[PERF_NODE_TIMING],
        PERF_HOOKS_VISIBLE);
    if (mal_vm_get_property(vm, receiver, mal_intrinsic_string_key(vm, (const byte *) "timeOrigin"), &roots[1])) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "timeOrigin", roots[1], PERF_HOOKS_VISIBLE);
    }
    roots[1] = perf_event_loop_utilization(vm, receiver, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined());
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "eventLoopUtilization", roots[1],
        PERF_HOOKS_VISIBLE);
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue perf_timerified(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    MalValue target = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    f64 start = perf_now();
    MalCompletion completion = mal_value_is_undefined(nt)
        ? mal_vm_call_value(vm, target, receiver, args, argc)
        : mal_vm_construct_value(vm, target, args, argc);
    if (completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    f64 end = perf_now();
    MalValue roots[] = {completion.value, target, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (perf_has_observer(vm, "function")) {
        if (mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "name"), &roots[2])) {
            roots[3] = perf_array(vm, args, (u32) argc);
            roots[3] = perf_new_entry(vm, perf_state[PERF_ENTRY_PROTO], roots[2], "function", start, end - start, roots[3]);
            perf_enqueue(vm, roots[3]);
        }
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue perf_timerify(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt; (void) callee;
    MalValue fn = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(fn)) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"fn\" argument must be of type function",
            "ERR_INVALID_ARG_TYPE");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {fn, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue name = mal_value_new_undefined(), length = mal_value_from_i32(0);
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "name"), &name)) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
    roots[1] = name;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "length"), &length)) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
    MalString *base;
    if (!mal_vm_to_string(vm, roots[1], &base)) { mal_gc_unroot(&root); return mal_value_new_undefined(); }
    usize base_length;
    byte *base_utf8 = mal_string_to_utf8(base, &base_length);
    byte *display = malloc(base_length + 12);
    if (base_utf8 == nullptr || display == nullptr) {
        free(base_utf8); free(display);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    memcpy(display, "timerified ", 11);
    memcpy(display + 11, base_utf8, base_length);
    free(base_utf8);
    MalNativeFunctionObject *wrapper = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_string_from_utf8(&vm->heap, display, base_length + 11),
        mal_ops_is_number(length) ? (i32) mal_ops_number_as_f64(length) : 0, perf_timerified, roots, 1);
    free(display);
    mal_native_function_object_set_constructor(wrapper);
    roots[2] = mal_value_from_native_function_object(wrapper);
    mal_gc_unroot(&root);
    return roots[2];
}

static MalValue perf_observer_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) callee;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(nt)) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor PerformanceObserver cannot be invoked without 'new'", "ERR_CONSTRUCT_CALL_REQUIRED");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(callback)) {
        char received[96];
        char message[160];
        perf_received(vm, callback, received, sizeof(received));
        snprintf(message, sizeof(message), "The \"callback\" argument must be of type function. Received %s", received);
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(perf_state[PERF_OBSERVER_PROTO]))),
        callback, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = perf_array(vm, nullptr, 0);
    roots[3] = perf_array(vm, nullptr, 0);
    MalValue fields[OBSERVER_FIELDS] = {roots[1], roots[2], roots[3], mal_value_new_boolean(false)};
    roots[4] = perf_array(vm, fields, OBSERVER_FIELDS);
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = perf_state[PERF_SYMBOL]}, roots[4]);
    mal_gc_unroot(&root);
    return roots[0];
}

static void perf_observer_detach(MalVm *vm, MalValue observer) {
    MalValue kept = perf_array(vm, nullptr, 0);
    MalRootSpan root;
    mal_gc_root(&root, &kept, 1);
    for (u32 i = 0; i < perf_length(perf_state[PERF_OBSERVERS]); i++) {
        MalValue other = perf_at(vm, perf_state[PERF_OBSERVERS], i);
        if (other != observer) perf_push(kept, other);
    }
    perf_state[PERF_OBSERVERS] = kept;
    mal_gc_unroot(&root);
}

static MalValue perf_observer_observe(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt; (void) callee;
    MalValue internal = perf_internal(receiver);
    MalValue options = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_array_object(internal)) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation", "ERR_INVALID_THIS");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {receiver, internal, options, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_object(roots[2])) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The \"options\" argument must be of type object",
            "ERR_INVALID_ARG_TYPE");
        goto done;
    }
    if (!mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "entryTypes"), &roots[3])
        || !mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "type"), &roots[4])
        || !mal_vm_get_property(vm, roots[2], mal_intrinsic_string_key(vm, (const byte *) "buffered"), &roots[5])) {
        goto done;
    }
    if (mal_value_is_undefined(roots[3]) && mal_value_is_undefined(roots[4])) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"options.entryTypes\" and \"options.type\" arguments must be specified", "ERR_MISSING_ARGS");
        goto done;
    }
    if (!mal_value_is_undefined(roots[3]) && !mal_value_is_undefined(roots[4])) {
        // Node renders the received array with util.inspect; string entries cover its common form.
        char message[512];
        usize used = (usize) snprintf(message, sizeof(message),
            "The property 'options.entryTypes' options.entryTypes can not set with options.type together. Received [");
        u32 count = perf_length(roots[3]);
        for (u32 i = 0; i < count && used < sizeof(message) - 64; i++) {
            MalValue item = perf_at(vm, roots[3], i);
            char text[64] = "";
            if (mal_value_is_string(item)) {
                usize length;
                byte *utf8 = mal_string_to_utf8(mal_value_to_string(item), &length);
                snprintf(text, sizeof(text), "'%.*s'", (int) (length < 40 ? length : 40), utf8 != nullptr ? utf8 : "");
                free(utf8);
            }
            used += (usize) snprintf(message + used, sizeof(message) - used, "%s %s", i > 0 ? "," : "", text);
        }
        snprintf(message + used, sizeof(message) - used, count > 0 ? " ]" : "]");
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
        goto done;
    }
    static const char *const supported[] = {"dns", "function", "gc", "http", "http2", "mark", "measure", "net", "quic", "resource"};
    roots[6] = perf_array(vm, nullptr, 0);
    u32 requested = mal_value_is_undefined(roots[3]) ? 1 : perf_length(roots[3]);
    for (u32 i = 0; i < requested; i++) {
        MalValue type = mal_value_is_undefined(roots[3]) ? roots[4] : perf_at(vm, roots[3], i);
        if (!mal_value_is_string(type)) continue;
        for (usize j = 0; j < countof(supported); j++) {
            if (mal_string_equals_ascii(mal_value_to_string(type), supported[j])) perf_push(roots[6], type);
        }
    }
    mal_array_object_store(mal_value_to_array_object(roots[1]), mal_key_index(OBSERVER_TYPES), roots[6]);
    perf_observer_detach(vm, roots[0]);
    if (perf_length(roots[6]) > 0) perf_push(perf_state[PERF_OBSERVERS], roots[0]);
    if (!mal_value_is_undefined(roots[4]) && mal_value_is_truthy(roots[5]) && perf_length(roots[6]) > 0) {
        MalValue buffer = perf_state[PERF_BUFFER];
        for (u32 i = 0; i < perf_length(buffer); i++) {
            MalValue entry = perf_at(vm, buffer, i);
            if (perf_string_is(perf_field(vm, entry, ENTRY_TYPE), roots[4])) perf_observer_queue(vm, roots[0], roots[1], entry);
        }
    }
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue perf_observer_disconnect(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue internal = perf_internal(receiver);
    if (mal_value_is_array_object(internal)) {
        perf_observer_detach(vm, receiver);
        mal_array_object_store(mal_value_to_array_object(internal), mal_key_index(OBSERVER_RECORDS), perf_array(vm, nullptr, 0));
    }
    return mal_value_new_undefined();
}

static MalValue perf_observer_take_records(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue internal = perf_internal(receiver);
    if (!mal_value_is_array_object(internal)) return perf_array(vm, nullptr, 0);
    MalValue records = perf_at(vm, internal, OBSERVER_RECORDS);
    MalRootSpan root;
    mal_gc_root(&root, &records, 1);
    mal_array_object_store(mal_value_to_array_object(internal), mal_key_index(OBSERVER_RECORDS), perf_array(vm, nullptr, 0));
    mal_gc_unroot(&root);
    return records;
}

static MalValue perf_illegal_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt; (void) callee;
    perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal constructor", "ERR_ILLEGAL_CONSTRUCTOR");
    return mal_value_new_undefined();
}

static MalValue perf_histogram_record(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) nt;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    f64 number;
    if (!mal_ops_is_number(value)) {
        perf_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"val\" argument must be of type number or bigint", "ERR_INVALID_ARG_TYPE");
        return mal_value_new_undefined();
    }
    // Node 26.12 validates with a minimum of 0 rather than 1.
    if (!mal_node_validate_integer(vm, value, "val", 0, 9007199254740991.0, &number)) {
        return mal_value_new_undefined();
    }
    MalNodeDelayHistogram *state = node_delay_state(callee);
    u64 sample = (u64) number;
    if (sample < state->min) state->min = sample;
    if (sample > state->max) state->max = sample;
    double delta = (double) sample - state->mean;
    state->mean += delta / (double) ++state->count;
    state->m2 += delta * ((double) sample - state->mean);
    usize bucket = (usize) (log2((double) sample) * 32);
    if (bucket >= countof(state->buckets)) bucket = countof(state->buckets) - 1;
    state->buckets[bucket]++;
    return mal_value_new_undefined();
}

static MalValue perf_histogram_record_delta(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc;
    MalNodeDelayHistogram *state = node_delay_state(callee);
    i64 now = mal_monotonic_now_ns();
    if (state->last_ns != 0) {
        MalValue sample = mal_value_from_f64((f64) (now - state->last_ns > 0 ? now - state->last_ns : 1));
        perf_histogram_record(vm, receiver, &sample, 1, nt, callee);
    }
    state->last_ns = now;
    return mal_value_new_undefined();
}

static MalValue perf_create_histogram(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) nt; (void) callee;
    return node_histogram_new(vm, 0, true);
}

static MalValue perf_class(MalVm *vm, MalObject *module, const char *name, MalValue prototype,
    MalNativeFunctionCallback construct) {
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), 0, construct);
    mal_native_function_object_set_constructor(constructor);
    MalValue value = mal_value_from_native_function_object(constructor);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", prototype, MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype), (const byte *) "constructor", value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue tag_key = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (mal_value_is_symbol(tag_key)) {
        MalPropertyDesc tag = {.value = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) name)),
            .flags = MAL_PROPERTY_CONFIGURABLE};
        mal_object_define_own(mal_value_to_object(prototype), mal_key_from_value(tag_key), &tag);
    }
    if (module != nullptr) mal_intrinsic_define_data(vm, module, (const byte *) name, value, PERF_HOOKS_VISIBLE);
    mal_gc_unroot(&root);
    return value;
}

static MalValue perf_prototype(MalVm *vm, MalValue parent) {
    return mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(parent)));
}

static void perf_method(MalVm *vm, MalValue object, const char *name, i32 length, MalNativeFunctionCallback callback) {
    mal_intrinsic_define_method_n(vm, mal_value_to_object(object), (const byte *) name, length, callback);
}

static void perf_entry_accessors(MalVm *vm, MalValue prototype, i32 first, i32 last) {
    static const char *const names[] = {"name", "entryType", "startTime", "duration", "detail"};
    for (i32 field = first; field <= last; field++) {
        MalValue slot = mal_value_from_i32(field);
        MalValue getter = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) names[field]), 0, perf_entry_getter, &slot, 1));
        MalRootSpan root;
        mal_gc_root(&root, &getter, 1);
        MalPropertyDesc descriptor = mal_intrinsic_accessor_desc(getter, mal_value_new_undefined(),
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(mal_value_to_object(prototype), mal_intrinsic_string_key(vm, (const byte *) names[field]),
            &descriptor);
        mal_gc_unroot(&root);
    }
}

static MalValue perf_node_timing_to_json(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), receiver};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    static const char *const base[] = {"name", "entryType", "startTime", "duration"};
    for (usize i = 0; i < countof(base) + countof(PERF_NODE_TIMING_FIELDS); i++) {
        const char *name = i < countof(base) ? base[i] : PERF_NODE_TIMING_FIELDS[i - countof(base)];
        MalValue value;
        if (!mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) name), &value)) break;
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) name, value, PERF_HOOKS_VISIBLE);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

/* nodeTiming milestones the runtime does not record are approximated: process start
 * and V8/environment setup are the time origin, bootstrap and loop start are this
 * module's first use, and idle time stays 0 because the reactor does not expose waits. */
static MalValue perf_node_timing(MalVm *vm) {
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, mal_value_to_object(perf_state[PERF_ENTRY_PROTO]))),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue fields[ENTRY_FIELDS] = {perf_string(vm, "node"), perf_string(vm, "node"), mal_value_from_i32(0),
        mal_value_from_i32(0), mal_value_new_null()};
    roots[1] = perf_array(vm, fields, ENTRY_FIELDS);
    mal_object_set(mal_value_to_object(roots[0]), (MalKey) {.kind = MAL_KEY_SYMBOL, .value = perf_state[PERF_SYMBOL]}, roots[1]);
    mal_intrinsic_define_accessor_n(vm, mal_value_to_object(roots[0]), mal_intrinsic_string_key(vm, (const byte *) "duration"),
        (const byte *) "get duration", 0, perf_node_timing_duration, nullptr, 0, nullptr,
        MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    const f64 values[] = {0, 0, perf_bootstrap_ms, 0, perf_bootstrap_ms, -1, 0};
    for (usize i = 0; i < countof(PERF_NODE_TIMING_FIELDS); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) PERF_NODE_TIMING_FIELDS[i],
            mal_value_from_f64(values[i]), MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[0]), (const byte *) "toJSON", 0, perf_node_timing_to_json);
    mal_gc_unroot(&root);
    return roots[0];
}

/* Node defines the perf classes as globals; they appear once perf_hooks is linked in. */
static void node_perf_hooks_define_globals(MalVm *vm, MalValue module) {
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    static const char *const classes[] = {"Performance", "PerformanceEntry", "PerformanceMark", "PerformanceMeasure",
        "PerformanceObserver", "PerformanceObserverEntryList", "PerformanceResourceTiming"};
    for (usize i = 0; i < countof(classes); i++) {
        MalValue value;
        if (!mal_vm_get_property(vm, module, mal_intrinsic_string_key(vm, (const byte *) classes[i]), &value)) return;
        mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) classes[i], value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
}

void mal_host_install_node_perf_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:perf_hooks", slots, count)) return;
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE];
    if (!mal_value_is_undefined(cached)) {
        mal_node_module_publish(vm, "node:perf_hooks", slots, count, cached);
        return;
    }
    if (node_perf_hooks_origin_ns == 0) {
        node_perf_hooks_origin_ns = mal_monotonic_now_ns();
    }
    for (usize i = 0; i < PERF_STATE_COUNT; i++) perf_state[i] = mal_value_new_undefined();
    perf_histogram_prototype = mal_value_new_undefined();
    if (!perf_ready) mal_gc_register_root_source(perf_scan_roots, nullptr);
    perf_ready = true;
    perf_bootstrap_ms = perf_now();
    MalValue object_prototype = vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *module = mal_value_to_object(roots[0]);
    perf_state[PERF_SYMBOL] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    perf_state[PERF_BUFFER] = perf_array(vm, nullptr, 0);
    perf_state[PERF_OBSERVERS] = perf_array(vm, nullptr, 0);

    perf_state[PERF_ENTRY_PROTO] = perf_prototype(vm, object_prototype);
    perf_entry_accessors(vm, perf_state[PERF_ENTRY_PROTO], ENTRY_NAME, ENTRY_DETAIL);
    perf_method(vm, perf_state[PERF_ENTRY_PROTO], "toJSON", 0, perf_entry_to_json);
    perf_class(vm, module, "PerformanceEntry", perf_state[PERF_ENTRY_PROTO], perf_illegal_constructor);
    perf_state[PERF_MARK_PROTO] = perf_prototype(vm, perf_state[PERF_ENTRY_PROTO]);
    perf_class(vm, module, "PerformanceMark", perf_state[PERF_MARK_PROTO], perf_illegal_constructor);
    perf_state[PERF_MEASURE_PROTO] = perf_prototype(vm, perf_state[PERF_ENTRY_PROTO]);
    perf_class(vm, module, "PerformanceMeasure", perf_state[PERF_MEASURE_PROTO], perf_illegal_constructor);
    roots[1] = perf_prototype(vm, perf_state[PERF_ENTRY_PROTO]);
    perf_class(vm, module, "PerformanceResourceTiming", roots[1], perf_illegal_constructor);

    perf_state[PERF_LIST_PROTO] = perf_prototype(vm, object_prototype);
    perf_method(vm, perf_state[PERF_LIST_PROTO], "getEntries", 0, perf_get_entries);
    perf_method(vm, perf_state[PERF_LIST_PROTO], "getEntriesByName", 1, perf_get_entries_by_name);
    perf_method(vm, perf_state[PERF_LIST_PROTO], "getEntriesByType", 1, perf_get_entries_by_type);
    perf_class(vm, module, "PerformanceObserverEntryList", perf_state[PERF_LIST_PROTO], perf_illegal_constructor);

    perf_state[PERF_OBSERVER_PROTO] = perf_prototype(vm, object_prototype);
    perf_method(vm, perf_state[PERF_OBSERVER_PROTO], "observe", 1, perf_observer_observe);
    perf_method(vm, perf_state[PERF_OBSERVER_PROTO], "disconnect", 0, perf_observer_disconnect);
    perf_method(vm, perf_state[PERF_OBSERVER_PROTO], "takeRecords", 0, perf_observer_take_records);
    roots[1] = perf_class(vm, module, "PerformanceObserver", perf_state[PERF_OBSERVER_PROTO], perf_observer_constructor);
    {
        static const char *const supported[] = {"dns", "function", "gc", "http", "http2", "mark", "measure", "net", "quic", "resource"};
        MalValue names[countof(supported)];
        for (usize i = 0; i < countof(supported); i++) names[i] = mal_value_new_undefined();
        MalRootSpan names_root;
        mal_gc_root(&names_root, names, (i32) countof(names));
        for (usize i = 0; i < countof(supported); i++) names[i] = perf_string(vm, supported[i]);
        roots[2] = perf_array(vm, names, (u32) countof(names));
        mal_gc_unroot(&names_root);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "supportedEntryTypes", roots[2],
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    perf_histogram_prototype = perf_prototype(vm, object_prototype);
    perf_class(vm, nullptr, "RecordableHistogram", perf_histogram_prototype, perf_illegal_constructor);

    // One performance object: the web platform's global when present, else a new one published as the global.
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    MalValue existing = mal_value_new_undefined();
    if (mal_value_is_object(global)) {
        (void) mal_vm_get_property(vm, global, mal_intrinsic_string_key(vm, (const byte *) "performance"), &existing);
    }
    bool shared = mal_value_is_object(existing);
    if (shared) {
        // Marks must share the clock of the web platform's performance.now().
        MalValue now_fn, now_value;
        if (mal_vm_get_property(vm, existing, mal_intrinsic_string_key(vm, (const byte *) "now"), &now_fn)
            && mal_value_is_callable(now_fn)) {
            MalCompletion now = mal_vm_call_value(vm, now_fn, existing, nullptr, 0);
            now_value = now.value;
            if (now.kind != MAL_COMPLETION_THROW && mal_ops_is_number(now_value)) {
                node_perf_hooks_origin_ns = mal_monotonic_now_ns() - (i64) (mal_ops_number_as_f64(now_value) * 1.0e6);
                perf_bootstrap_ms = perf_now();
            }
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return;
        }
    }
    roots[2] = shared ? existing : mal_value_from_object(mal_intrinsic_new_object(vm));
    perf_state[PERF_PERFORMANCE] = roots[2];
    MalValue performance_prototype = perf_prototype(vm,
        mal_value_from_object(mal_object_get_prototype(mal_value_to_object(roots[2]))));
    perf_class(vm, module, "Performance", performance_prototype, perf_illegal_constructor);
    mal_object_set_prototype(mal_value_to_object(roots[2]), mal_value_to_object(performance_prototype));
    static const struct { const char *name; i32 length; MalNativeFunctionCallback callback; } methods[] = {
        {"mark", 1, perf_mark}, {"measure", 1, perf_measure}, {"getEntries", 0, perf_get_entries},
        {"getEntriesByName", 1, perf_get_entries_by_name}, {"getEntriesByType", 1, perf_get_entries_by_type},
        {"clearMarks", 0, perf_clear_marks}, {"clearMeasures", 0, perf_clear_measures},
        {"eventLoopUtilization", 0, perf_event_loop_utilization}, {"timerify", 1, perf_timerify},
        {"toJSON", 0, perf_to_json},
    };
    for (usize i = 0; i < countof(methods); i++) {
        perf_method(vm, performance_prototype, methods[i].name, methods[i].length, methods[i].callback);
    }
    if (!shared) {
        mal_intrinsic_define_method_n(vm, mal_value_to_object(roots[2]), (const byte *) "now", 0, node_performance_now);
        struct timespec wall;
        clock_gettime(CLOCK_REALTIME, &wall);
        f64 origin = (f64) wall.tv_sec * 1000.0 + (f64) wall.tv_nsec / 1.0e6 - perf_now();
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "timeOrigin", mal_value_from_f64(origin),
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        if (mal_value_is_object(global)) {
            mal_intrinsic_define_data(vm, mal_value_to_object(global), (const byte *) "performance", roots[2],
                PERF_HOOKS_VISIBLE);
        }
    }
    perf_state[PERF_NODE_TIMING] = perf_node_timing(vm);
    mal_intrinsic_define_data(vm, mal_value_to_object(performance_prototype), (const byte *) "nodeTiming",
        perf_state[PERF_NODE_TIMING], MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, module, (const byte *) "performance", roots[2], PERF_HOOKS_VISIBLE);

    static const struct { const char *name; i32 length; MalNativeFunctionCallback callback; } functions[] = {
        {"monitorEventLoopDelay", 1, node_monitor_event_loop_delay}, {"createHistogram", 1, perf_create_histogram},
        {"eventLoopUtilization", 0, perf_event_loop_utilization}, {"timerify", 1, perf_timerify},
    };
    for (usize i = 0; i < countof(functions); i++) {
        mal_intrinsic_define_method_n(vm, module, (const byte *) functions[i].name, functions[i].length, functions[i].callback);
    }
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    static const struct { const char *name; i32 value; } constants[] = {
        {"NODE_PERFORMANCE_GC_MAJOR", 4}, {"NODE_PERFORMANCE_GC_MINOR", 1},
        {"NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP", 2}, {"NODE_PERFORMANCE_GC_INCREMENTAL", 8},
        {"NODE_PERFORMANCE_GC_WEAKCB", 16}, {"NODE_PERFORMANCE_GC_FLAGS_NO", 0},
        {"NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED", 2}, {"NODE_PERFORMANCE_GC_FLAGS_FORCED", 4},
        {"NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING", 8},
        {"NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE", 16},
        {"NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY", 32}, {"NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE", 64},
    };
    for (usize i = 0; i < countof(constants); i++) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) constants[i].name,
            mal_value_from_i32(constants[i].value), MAL_PROPERTY_ENUMERABLE);
    }
    mal_intrinsic_define_data(vm, module, (const byte *) "constants", roots[1], PERF_HOOKS_VISIBLE);
    vm->intrinsics[MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE] = roots[0];
    node_perf_hooks_define_globals(vm, roots[0]);
    mal_node_module_publish(vm, "node:perf_hooks", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
