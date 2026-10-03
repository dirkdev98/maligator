#include "node_perf_hooks.h"

#if MAL_NODE

#include <math.h>
#include <string.h>
#include "array_buffer_object.h"
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
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)),
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
    const struct {const char *name; MalNativeFunctionCallback callback; i32 length;} methods[] = {
        {"disable", node_delay_disable, 0}, {"enable", node_delay_enable, 0},
        {"reset", node_delay_reset, 0}, {"percentile", node_delay_percentile, 1},
    };
    for (usize i = 0; i < countof(methods); i++) {
        roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) methods[i].name), methods[i].length,
            methods[i].callback, roots + 1, 1));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) methods[i].name, roots[2], PERF_HOOKS_VISIBLE);
    }
    MalValue histogram = roots[0];
    mal_gc_unroot(&root);
    return histogram;
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
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
		mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(roots[1]), (const byte *) "now", 0,
        node_performance_now);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "performance",
        roots[1], PERF_HOOKS_VISIBLE);
	roots[2] = mal_intrinsic_define_method_n(
		vm, mal_value_to_object(roots[0]), (const byte *) "monitorEventLoopDelay", 1,
		node_monitor_event_loop_delay);
    vm->intrinsics[MAL_INTRINSIC_NODE_PERF_HOOKS_MODULE] = roots[0];
    mal_node_module_publish(vm, "node:perf_hooks", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
