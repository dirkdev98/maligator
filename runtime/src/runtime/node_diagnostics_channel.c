#include "node_diagnostics_channel.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "promise_object.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define DC_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define DC_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

/* Slots of the module state carried in every function's slot 0. */
enum {
    DC_CHANNEL_PROTOTYPE,
    DC_ACTIVE_PROTOTYPE,
    DC_TRACING_PROTOTYPE,
    DC_CHANNELS,
    DC_STATE_SLOTS,
};

static const char *const dc_trace_events[] = {"start", "end", "asyncStart", "asyncEnd", "error"};

static MalNativeFunctionObject *dc_state(MalValue callee) {
    return mal_value_to_native_function_object(
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
}

static MalValue dc_state_slot(MalValue callee, i32 index) {
    return mal_native_function_object_get_slot(dc_state(callee), index);
}

static MalValue dc_get(MalVm *vm, MalValue object, const char *name) {
    MalValue value = mal_value_new_undefined();
    if (mal_value_is_object(object)) {
        mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    }
    return value;
}

static void dc_set(MalVm *vm, MalValue object, const char *name, MalValue value, MalPropertyFlags flags) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(object), (const byte *) name, value, flags);
    mal_gc_unroot(&root);
}

static MalValue dc_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count));
}

static bool dc_is_channel(MalVm *vm, MalValue value, MalValue callee) {
    (void) vm;
    if (!mal_value_is_object(value)) return false;
    MalObject *prototype = mal_object_prototype(mal_value_to_object(value));
    return prototype == mal_value_to_object(dc_state_slot(callee, DC_CHANNEL_PROTOTYPE))
        || prototype == mal_value_to_object(dc_state_slot(callee, DC_ACTIVE_PROTOTYPE));
}

static bool dc_require_channel(MalVm *vm, MalValue receiver, MalValue callee) {
    if (dc_is_channel(vm, receiver, callee)) return true;
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Value of \"this\" must be of type Channel", "ERR_INVALID_THIS");
    return false;
}

static void dc_set_active(MalValue channel, MalValue callee, bool active) {
    mal_object_set_prototype(mal_value_to_object(channel), mal_value_to_object(
        dc_state_slot(callee, active ? DC_ACTIVE_PROTOTYPE : DC_CHANNEL_PROTOTYPE)));
}

static u32 dc_length(MalValue array) {
    return mal_value_is_array_object(array) ? mal_array_object_length(mal_value_to_array_object(array)) : 0;
}

static MalValue dc_item(MalValue array, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(array), index, &value);
    return value;
}

static bool dc_has_stores(MalVm *vm, MalValue channel) {
    return dc_length(dc_get(vm, channel, "_stores")) > 0;
}

/* Copy-on-write, so a publish that is iterating keeps its snapshot. */
static MalValue dc_copy_without(MalVm *vm, MalValue source, u32 skip, MalValue append) {
    u32 length = dc_length(source);
    MalValue roots[] = {source, append, mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 written = 0;
    for (u32 i = 0; i < length; i++) {
        if (i == skip) continue;
        mal_array_object_store(mal_value_to_array_object(roots[2]), mal_key_index(written++), dc_item(roots[0], i));
    }
    if (!mal_value_is_undefined(roots[1])) {
        mal_array_object_store(mal_value_to_array_object(roots[2]), mal_key_index(written), roots[1]);
    }
    mal_gc_unroot(&root);
    return roots[2];
}

static MalValue dc_rethrow(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW,
        .value = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0)};
    return mal_value_new_undefined();
}

/* A failing subscriber is reported later as an uncaught exception, never to the publisher. */
static void dc_defer_throw(MalVm *vm) {
    MalValue roots[] = {vm->completion.value, mal_value_new_undefined(), mal_value_new_undefined()};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[1] = dc_function(vm, "", 0, dc_rethrow, &roots[0], 1);
    roots[2] = dc_get(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], "setImmediate");
    if (mal_value_is_callable(roots[2])) {
        MalCompletion scheduled = mal_vm_call_value(vm, roots[2], mal_value_new_undefined(), &roots[1], 1);
        if (scheduled.kind == MAL_COMPLETION_THROW) {
            vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        }
    }
    mal_gc_unroot(&root);
}

static void dc_publish(MalVm *vm, MalValue channel, MalValue data) {
    MalValue roots[] = {channel, data, dc_get(vm, channel, "_subscribers"), dc_get(vm, channel, "name"),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 length = dc_length(roots[2]);
    for (u32 i = 0; i < length; i++) {
        roots[4] = dc_item(roots[2], i);
        if (!mal_value_is_callable(roots[4])) continue;
        MalValue arguments[] = {roots[1], roots[3]};
        MalCompletion completion = mal_vm_call_value(vm, roots[4], mal_value_new_undefined(), arguments, 2);
        if (completion.kind == MAL_COMPLETION_THROW) {
            vm->completion = completion;
            dc_defer_throw(vm);
        }
    }
    mal_gc_unroot(&root);
}

static MalValue dc_channel_publish(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    dc_publish(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue dc_channel_subscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    MalValue subscription = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(subscription)) {
        mal_node_throw_invalid_arg_type(vm, "subscription", "of type function", subscription);
        return mal_value_new_undefined();
    }
    MalValue copy = dc_copy_without(vm, dc_get(vm, receiver, "_subscribers"), UINT32_MAX, subscription);
    dc_set(vm, receiver, "_subscribers", copy, DC_VISIBLE);
    dc_set_active(receiver, callee, true);
    return mal_value_new_undefined();
}

static MalValue dc_channel_unsubscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    MalValue subscription = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue subscribers = dc_get(vm, receiver, "_subscribers");
    u32 length = dc_length(subscribers);
    for (u32 i = 0; i < length; i++) {
        if (dc_item(subscribers, i) != subscription) continue;
        MalValue copy = dc_copy_without(vm, subscribers, i, mal_value_new_undefined());
        dc_set(vm, receiver, "_subscribers", copy, DC_VISIBLE);
        if (length == 1 && !dc_has_stores(vm, receiver)) dc_set_active(receiver, callee, false);
        return mal_value_new_boolean(true);
    }
    return mal_value_new_boolean(false);
}

/* _stores is an array of [store, transform] pairs in binding order. */
static MalValue dc_channel_bind_store(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        dc_get(vm, receiver, "_stores"), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 length = dc_length(roots[2]);
    u32 existing = UINT32_MAX;
    for (u32 i = 0; i < length; i++) {
        if (dc_item(dc_item(roots[2], i), 0) == roots[0]) existing = i;
    }
    MalValue pair[] = {roots[0], roots[1]};
    roots[3] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), pair, 2));
    roots[2] = dc_copy_without(vm, roots[2], existing, roots[3]);
    dc_set(vm, receiver, "_stores", roots[2], DC_VISIBLE);
    dc_set_active(receiver, callee, true);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue dc_channel_unbind_store(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    MalValue store = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue stores = dc_get(vm, receiver, "_stores");
    u32 length = dc_length(stores);
    for (u32 i = 0; i < length; i++) {
        if (dc_item(dc_item(stores, i), 0) != store) continue;
        MalValue copy = dc_copy_without(vm, stores, i, mal_value_new_undefined());
        dc_set(vm, receiver, "_stores", copy, DC_VISIBLE);
        if (length == 1 && dc_length(dc_get(vm, receiver, "_subscribers")) == 0) dc_set_active(receiver, callee, false);
        return mal_value_new_boolean(true);
    }
    return mal_value_new_boolean(false);
}

static MalValue dc_has_subscribers_getter(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) receiver, (void) args, (void) argc, (void) new_target;
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
}

/* Slots of one store-run step: the channel's data, the next step, the store, its transform. */
enum { DC_STEP_STATE, DC_STEP_DATA, DC_STEP_NEXT, DC_STEP_STORE, DC_STEP_TRANSFORM, DC_STEP_SLOTS };

static MalValue dc_store_step(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(self, DC_STEP_DATA),
        mal_native_function_object_get_slot(self, DC_STEP_NEXT),
        mal_native_function_object_get_slot(self, DC_STEP_STORE),
        mal_native_function_object_get_slot(self, DC_STEP_TRANSFORM), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    roots[4] = roots[0];
    if (mal_value_is_callable(roots[3])) {
        MalCompletion transformed = mal_vm_call_value(vm, roots[3], mal_value_new_undefined(), &roots[0], 1);
        if (transformed.kind == MAL_COMPLETION_THROW) {
            vm->completion = transformed;
            dc_defer_throw(vm);
            MalCompletion next = mal_vm_call_value(vm, roots[1], mal_value_new_undefined(), nullptr, 0);
            if (next.kind == MAL_COMPLETION_THROW) vm->completion = next;
            mal_gc_unroot(&root);
            return next.value;
        }
        roots[4] = transformed.value;
    }
    MalValue run_args[] = {roots[4], roots[1]};
    MalValue run = dc_get(vm, roots[2], "run");
    if (mal_value_is_callable(run)) {
        MalCompletion completion = mal_vm_call_value(vm, run, roots[2], run_args, 2);
        if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
        result = completion.value;
    }
    mal_gc_unroot(&root);
    return result;
}

/* The innermost step publishes, then calls fn with thisArg and the remaining arguments. */
static MalValue dc_store_body(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(self, 0), mal_native_function_object_get_slot(self, 1),
        mal_native_function_object_get_slot(self, 2), mal_native_function_object_get_slot(self, 3),
        mal_native_function_object_get_slot(self, 4)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) dc_publish(vm, roots[0], roots[1]);
    MalValue result = mal_value_new_undefined();
    u32 count = dc_length(roots[4]);
    MalValue call_args[16];
    if (count > countof(call_args)) count = countof(call_args);
    for (u32 i = 0; i < count; i++) call_args[i] = dc_item(roots[4], i);
    MalCompletion completion = mal_vm_call_value(vm, roots[2], roots[3], call_args, (i32) count);
    if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
    else result = completion.value;
    mal_gc_unroot(&root);
    return result;
}

/* runStores(data, fn, thisArg, ...args); `channel` is undefined when nothing is published. */
static MalValue dc_run_stores(MalVm *vm, MalValue channel, MalValue data, MalValue fn, MalValue this_arg,
    const MalValue *rest, i32 rest_count) {
    if (!mal_value_is_callable(fn)) {
        mal_node_throw_invalid_arg_type(vm, "fn", "of type function", fn);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {channel, data, fn, this_arg, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[4] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), rest, (u32) (rest_count > 0 ? rest_count : 0)));
    MalValue body_slots[] = {roots[0], roots[1], roots[2], roots[3], roots[4]};
    roots[5] = dc_function(vm, "", 0, dc_store_body, body_slots, countof(body_slots));
    MalValue stores = mal_value_is_object(roots[0]) ? dc_get(vm, roots[0], "_stores") : mal_value_new_undefined();
    roots[6] = stores;
    u32 length = dc_length(roots[6]);
    for (u32 i = 0; i < length; i++) {
        MalValue pair = dc_item(roots[6], i);
        MalValue step_slots[DC_STEP_SLOTS] = {mal_value_new_undefined(), roots[1], roots[5], dc_item(pair, 0),
            dc_item(pair, 1)};
        roots[5] = dc_function(vm, "", 0, dc_store_step, step_slots, DC_STEP_SLOTS);
    }
    MalCompletion completion = mal_vm_call_value(vm, roots[5], mal_value_new_undefined(), nullptr, 0);
    if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
    mal_gc_unroot(&root);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

static MalValue dc_channel_run_stores(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!dc_require_channel(vm, receiver, callee)) return mal_value_new_undefined();
    bool active = mal_object_prototype(mal_value_to_object(receiver))
        == mal_value_to_object(dc_state_slot(callee, DC_ACTIVE_PROTOTYPE));
    return dc_run_stores(vm, active ? receiver : mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined(),
        argc > 2 ? args[2] : mal_value_new_undefined(), argc > 3 ? args + 3 : nullptr, argc > 3 ? argc - 3 : 0);
}

static bool dc_validate_name(MalVm *vm, MalValue name) {
    if (mal_value_is_string(name) || mal_value_is_symbol(name)) return true;
    mal_node_throw_invalid_arg_type(vm, "channel", "one of type string or symbol", name);
    return false;
}

static MalValue dc_lookup(MalVm *vm, MalValue callee, MalValue name) {
    MalPropertyLookup found = mal_object_get_own(
        mal_value_to_object(dc_state_slot(callee, DC_CHANNELS)), mal_key_from_value(name));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

static MalValue dc_channel_for(MalVm *vm, MalValue callee, MalValue name) {
    if (!dc_validate_name(vm, name)) return mal_value_new_undefined();
    MalValue existing = dc_lookup(vm, callee, name);
    if (!mal_value_is_undefined(existing)) return existing;
    MalValue roots[] = {name, mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(dc_state_slot(callee, DC_CHANNEL_PROTOTYPE))))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    dc_set(vm, roots[1], "_subscribers", mal_value_new_undefined(), DC_VISIBLE);
    dc_set(vm, roots[1], "_stores", mal_value_new_undefined(), DC_VISIBLE);
    dc_set(vm, roots[1], "name", roots[0], DC_VISIBLE);
    MalPropertyDesc desc = mal_intrinsic_data_desc(roots[1], DC_VISIBLE);
    mal_object_define_own(mal_value_to_object(dc_state_slot(callee, DC_CHANNELS)), mal_key_from_value(roots[0]), &desc);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue dc_module_channel(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    return dc_channel_for(vm, callee, argc > 0 ? args[0] : mal_value_new_undefined());
}

static MalValue dc_module_has_subscribers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue name = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!dc_validate_name(vm, name)) return mal_value_new_undefined();
    MalValue channel = dc_lookup(vm, callee, name);
    return mal_value_new_boolean(mal_value_is_object(channel)
        && mal_object_prototype(mal_value_to_object(channel))
            == mal_value_to_object(dc_state_slot(callee, DC_ACTIVE_PROTOTYPE)));
}

static MalValue dc_module_subscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue channel = dc_channel_for(vm, callee, argc > 0 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &channel, 1);
    MalValue subscription = argc > 1 ? args[1] : mal_value_new_undefined();
    dc_channel_subscribe(vm, channel, &subscription, 1, mal_value_new_undefined(), callee);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue dc_module_unsubscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue name = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!dc_validate_name(vm, name)) return mal_value_new_undefined();
    MalValue channel = dc_lookup(vm, callee, name);
    if (!mal_value_is_object(channel)) return mal_value_new_boolean(false);
    MalValue subscription = argc > 1 ? args[1] : mal_value_new_undefined();
    return dc_channel_unsubscribe(vm, channel, &subscription, 1, mal_value_new_undefined(), callee);
}

static MalValue dc_trace_channel(MalVm *vm, MalValue tracing, i32 index) {
    return dc_get(vm, tracing, dc_trace_events[index]);
}

static bool dc_channel_active(MalVm *vm, MalValue callee, MalValue channel) {
    (void) vm;
    return mal_value_is_object(channel) && mal_object_prototype(mal_value_to_object(channel))
        == mal_value_to_object(dc_state_slot(callee, DC_ACTIVE_PROTOTYPE));
}

static bool dc_tracing_active(MalVm *vm, MalValue callee, MalValue tracing) {
    for (usize i = 0; i < countof(dc_trace_events); i++) {
        if (dc_channel_active(vm, callee, dc_trace_channel(vm, tracing, (i32) i))) return true;
    }
    return false;
}

static MalValue dc_tracing_has_subscribers(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target;
    return mal_value_new_boolean(dc_tracing_active(vm, callee, receiver));
}

static MalValue dc_tracing_toggle(MalVm *vm, MalValue tracing, MalValue handlers, MalValue callee, bool subscribe) {
    bool done = true;
    MalValue roots[] = {tracing, handlers, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 0; i < countof(dc_trace_events) && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        roots[2] = dc_get(vm, roots[1], dc_trace_events[i]);
        if (mal_value_is_undefined(roots[2])) continue;
        roots[3] = dc_trace_channel(vm, roots[0], (i32) i);
        MalValue result = subscribe
            ? dc_channel_subscribe(vm, roots[3], &roots[2], 1, mal_value_new_undefined(), callee)
            : dc_channel_unsubscribe(vm, roots[3], &roots[2], 1, mal_value_new_undefined(), callee);
        if (!subscribe && !mal_value_is_truthy(result)) done = false;
    }
    mal_gc_unroot(&root);
    return subscribe ? mal_value_new_undefined() : mal_value_new_boolean(done);
}

static MalValue dc_tracing_subscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return dc_tracing_toggle(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), callee, true);
}

static MalValue dc_tracing_unsubscribe(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return dc_tracing_toggle(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), callee, false);
}

/* Slots of a traced body: state, tracing channel, context, fn, thisArg, args array. */
enum { DC_TRACE_STATE, DC_TRACE_TRACING, DC_TRACE_CONTEXT, DC_TRACE_FN, DC_TRACE_THIS, DC_TRACE_ARGS,
    DC_TRACE_PROMISE, DC_TRACE_SLOTS };

static void dc_trace_publish(MalVm *vm, MalNativeFunctionObject *self, i32 event) {
    MalValue tracing = mal_native_function_object_get_slot(self, DC_TRACE_TRACING);
    MalValue context = mal_native_function_object_get_slot(self, DC_TRACE_CONTEXT);
    MalCompletion saved = vm->completion;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalValue roots[] = {saved.value, dc_trace_channel(vm, tracing, event)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    dc_publish(vm, roots[1], context);
    if (vm->completion.kind != MAL_COMPLETION_THROW) vm->completion = (MalCompletion) {.kind = saved.kind, .value = roots[0]};
    mal_gc_unroot(&root);
}

static MalValue dc_promise_settled(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    bool rejected = mal_value_is_truthy(mal_native_function_object_get_slot(self, DC_TRACE_PROMISE));
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue context = mal_native_function_object_get_slot(self, DC_TRACE_CONTEXT);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    dc_set(vm, context, rejected ? "error" : "result", value, DC_VISIBLE);
    if (rejected) dc_trace_publish(vm, self, 4);
    dc_trace_publish(vm, self, 2);
    dc_trace_publish(vm, self, 3);
    mal_gc_unroot(&root);
    if (rejected && vm->completion.kind != MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = value};
        return mal_value_new_undefined();
    }
    return value;
}

/* traceSync/tracePromise body: run fn, record result or error, publish end. */
static MalValue dc_trace_body(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    bool promise = !mal_value_is_undefined(mal_native_function_object_get_slot(self, DC_TRACE_PROMISE));
    MalValue roots[] = {mal_native_function_object_get_slot(self, DC_TRACE_FN),
        mal_native_function_object_get_slot(self, DC_TRACE_THIS), mal_native_function_object_get_slot(self, DC_TRACE_ARGS),
        mal_native_function_object_get_slot(self, DC_TRACE_CONTEXT), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 count = dc_length(roots[2]);
    MalValue call_args[16];
    if (count > countof(call_args)) count = countof(call_args);
    for (u32 i = 0; i < count; i++) call_args[i] = dc_item(roots[2], i);
    MalCompletion completion = mal_vm_call_value(vm, roots[0], roots[1], call_args, (i32) count);
    MalValue result = mal_value_new_undefined();
    if (completion.kind == MAL_COMPLETION_THROW) {
        roots[4] = completion.value;
        dc_set(vm, roots[3], "error", roots[4], DC_VISIBLE);
        dc_trace_publish(vm, self, 4);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[4]};
    } else if (!promise) {
        result = completion.value;
        dc_set(vm, roots[3], "result", result, DC_VISIBLE);
    } else {
        roots[4] = completion.value;
        MalValue resolve = dc_get(vm, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], "resolve");
        MalCompletion resolved = mal_vm_call_value(vm, resolve, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], &roots[4], 1);
        if (resolved.kind == MAL_COMPLETION_THROW) {
            vm->completion = resolved;
        } else {
            roots[4] = resolved.value;
            MalValue slots[DC_TRACE_SLOTS];
            for (i32 i = 0; i < DC_TRACE_SLOTS; i++) slots[i] = mal_native_function_object_get_slot(self, i);
            slots[DC_TRACE_PROMISE] = mal_value_new_boolean(false);
            roots[5] = dc_function(vm, "", 1, dc_promise_settled, slots, DC_TRACE_SLOTS);
            slots[DC_TRACE_PROMISE] = mal_value_new_boolean(true);
            roots[6] = dc_function(vm, "", 1, dc_promise_settled, slots, DC_TRACE_SLOTS);
            MalValue then_args[] = {roots[5], roots[6]};
            result = mal_vm_call_value(vm, dc_get(vm, roots[4], "then"), roots[4], then_args, 2).value;
        }
    }
    dc_trace_publish(vm, self, 1);
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

static MalValue dc_trace(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue callee, bool promise) {
    MalValue fn = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(fn)) {
        mal_node_throw_invalid_arg_type(vm, "fn", "of type function", fn);
        return mal_value_new_undefined();
    }
    MalValue this_arg = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!dc_tracing_active(vm, callee, receiver)) {
        MalCompletion completion = mal_vm_call_value(vm, fn, this_arg, argc > 3 ? args + 3 : nullptr, argc > 3 ? argc - 3 : 0);
        if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
        return completion.value;
    }
    MalValue slots[DC_TRACE_SLOTS];
    for (i32 i = 0; i < DC_TRACE_SLOTS; i++) slots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, slots, DC_TRACE_SLOTS);
    slots[DC_TRACE_STATE] = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    slots[DC_TRACE_TRACING] = receiver;
    slots[DC_TRACE_CONTEXT] = argc > 1 && !mal_value_is_undefined(args[1]) ? args[1]
        : mal_value_from_object(mal_intrinsic_new_object(vm));
    slots[DC_TRACE_FN] = fn;
    slots[DC_TRACE_THIS] = this_arg;
    slots[DC_TRACE_ARGS] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), argc > 3 ? args + 3 : nullptr,
        (u32) (argc > 3 ? argc - 3 : 0)));
    slots[DC_TRACE_PROMISE] = promise ? mal_value_new_boolean(true) : mal_value_new_undefined();
    MalValue body = dc_function(vm, "", 0, dc_trace_body, slots, DC_TRACE_SLOTS);
    MalValue start = dc_trace_channel(vm, receiver, 0);
    MalValue run_roots[] = {body, start};
    MalRootSpan run_root;
    mal_gc_root(&run_root, run_roots, countof(run_roots));
    MalValue result = dc_run_stores(vm, dc_channel_active(vm, callee, start) ? start : mal_value_new_undefined(),
        slots[DC_TRACE_CONTEXT], body, mal_value_new_undefined(), nullptr, 0);
    mal_gc_unroot(&run_root);
    mal_gc_unroot(&root);
    return result;
}

static MalValue dc_trace_sync(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return dc_trace(vm, receiver, args, argc, callee, false);
}

static MalValue dc_trace_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return dc_trace(vm, receiver, args, argc, callee, true);
}

static MalValue dc_module_tracing_channel(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue spec = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(spec) && !mal_value_is_object(spec)) {
        mal_node_throw_invalid_arg_type(vm, "nameOrChannels", "of type string or an instance of TracingChannel or Object", spec);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {spec, mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(dc_state_slot(callee, DC_TRACING_PROTOTYPE)))), mal_value_new_undefined(),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 0; i < countof(dc_trace_events) && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        if (mal_value_is_string(roots[0])) {
            usize length = 0;
            byte *utf8 = mal_string_to_utf8(mal_value_to_string(roots[0]), &length);
            usize capacity = length + 32;
            char *name = malloc(capacity);
            if (name != nullptr) snprintf(name, capacity, "tracing:%.*s:%s", (int) length, (const char *) utf8, dc_trace_events[i]);
            free(utf8);
            MalString *string = name == nullptr ? nullptr : mal_string_from_utf8(&vm->heap, (const byte *) name, strlen(name));
            free(name);
            if (string == nullptr) {
                mal_vm_throw_allocation_error(vm);
                break;
            }
            roots[2] = dc_channel_for(vm, callee, mal_value_from_string(string));
        } else {
            roots[2] = dc_get(vm, roots[0], dc_trace_events[i]);
            if (!dc_is_channel(vm, roots[2], callee)) {
                char name[32];
                snprintf(name, sizeof name, "nameOrChannels.%s", dc_trace_events[i]);
                mal_node_throw_invalid_arg_type(vm, name, "an instance of Channel", roots[2]);
                break;
            }
        }
        MalPropertyDesc desc = mal_intrinsic_data_desc(roots[2], MAL_PROPERTY_NONE);
        mal_object_define_own(mal_value_to_object(roots[1]),
            mal_intrinsic_string_key(vm, (const byte *) dc_trace_events[i]), &desc);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
}

static MalValue dc_illegal_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor Channel cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    return dc_channel_for(vm, callee, argc > 0 ? args[0] : mal_value_new_undefined());
}

static void dc_define(MalVm *vm, MalObject *target, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue state, MalPropertyFlags flags) {
    MalValue function = dc_function(vm, name, length, callback, &state, 1);
    MalRootSpan root;
    mal_gc_root(&root, &function, 1);
    mal_intrinsic_define_data(vm, target, (const byte *) name, function, flags);
    mal_gc_unroot(&root);
}

static void dc_define_getter(MalVm *vm, MalObject *target, const char *name, MalNativeFunctionCallback callback,
    MalValue state, MalValue extra) {
    MalValue slots[] = {state, extra};
    char getter_name[48];
    snprintf(getter_name, sizeof getter_name, "get %s", name);
    MalValue getter = dc_function(vm, getter_name, 0, callback, slots, countof(slots));
    MalRootSpan root;
    mal_gc_root(&root, &getter, 1);
    MalPropertyDesc desc = mal_intrinsic_accessor_desc(getter, mal_value_new_undefined(), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(target, mal_intrinsic_string_key(vm, (const byte *) name), &desc);
    mal_gc_unroot(&root);
}

/* lib/diagnostics_channel.js: channels are shared by name, become ActiveChannel while they
 * have subscribers or stores, and TracingChannel groups the five tracing:<name>:* events. */
void mal_host_install_node_diagnostics_channel(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:diagnostics_channel", slots, count)) return;
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_DIAGNOSTICS_CHANNEL_MODULE];
    if (mal_value_is_undefined(module)) {
        MalObject *object_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
            mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        roots[1] = mal_value_from_object(mal_object_new(&vm->heap, object_prototype));
        roots[2] = mal_value_from_object(mal_object_new(&vm->heap, object_prototype));
        roots[3] = mal_value_from_object(mal_object_new(&vm->heap, object_prototype));
        roots[4] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        MalValue state_slots[DC_STATE_SLOTS] = {
            [DC_CHANNEL_PROTOTYPE] = roots[1],
            [DC_ACTIVE_PROTOTYPE] = roots[2],
            [DC_TRACING_PROTOTYPE] = roots[3],
            [DC_CHANNELS] = roots[4],
        };
        MalValue state = dc_function(vm, "", 0, dc_illegal_constructor, state_slots, DC_STATE_SLOTS);
        MalRootSpan state_root;
        mal_gc_root(&state_root, &state, 1);
        static const struct {
            const char *name;
            i32 length;
            MalNativeFunctionCallback callback;
        } channel_methods[] = {
            {"subscribe", 1, dc_channel_subscribe}, {"unsubscribe", 1, dc_channel_unsubscribe},
            {"bindStore", 2, dc_channel_bind_store}, {"unbindStore", 1, dc_channel_unbind_store},
            {"publish", 1, dc_channel_publish}, {"runStores", 3, dc_channel_run_stores},
        };
        for (i32 active = 0; active < 2; active++) {
            MalObject *prototype = mal_value_to_object(roots[1 + active]);
            for (usize i = 0; i < countof(channel_methods); i++) {
                dc_define(vm, prototype, channel_methods[i].name, channel_methods[i].length,
                    channel_methods[i].callback, state, DC_METHOD);
            }
            dc_define_getter(vm, prototype, "hasSubscribers", dc_has_subscribers_getter, state,
                mal_value_new_boolean(active == 1));
        }
        MalNativeFunctionObject *channel_ctor = mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "Channel"), 1, dc_illegal_constructor, &state, 1);
        mal_native_function_object_set_constructor(channel_ctor);
        MalValue ctor = mal_value_from_native_function_object(channel_ctor);
        MalRootSpan ctor_root;
        mal_gc_root(&ctor_root, &ctor, 1);
        mal_intrinsic_define_data(vm, (MalObject *) channel_ctor, (const byte *) "prototype", roots[1], MAL_PROPERTY_NONE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "constructor", ctor, DC_METHOD);
        // ActiveChannel shares Channel's surface, and its instances still satisfy instanceof Channel.
        mal_object_set_prototype(mal_value_to_object(roots[2]), mal_value_to_object(roots[1]));
        MalValue active_ctor = dc_function(vm, "ActiveChannel", 1, dc_illegal_constructor, &state, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[2]), (const byte *) "constructor", active_ctor, DC_METHOD);
        MalObject *tracing = mal_value_to_object(roots[3]);
        dc_define(vm, tracing, "subscribe", 1, dc_tracing_subscribe, state, DC_METHOD);
        dc_define(vm, tracing, "unsubscribe", 1, dc_tracing_unsubscribe, state, DC_METHOD);
        dc_define(vm, tracing, "traceSync", 4, dc_trace_sync, state, DC_METHOD);
        dc_define(vm, tracing, "tracePromise", 4, dc_trace_promise, state, DC_METHOD);
        dc_define_getter(vm, tracing, "hasSubscribers", dc_tracing_has_subscribers, state, mal_value_new_undefined());
        MalObject *exports = mal_value_to_object(roots[0]);
        dc_define(vm, exports, "channel", 1, dc_module_channel, state, DC_VISIBLE);
        dc_define(vm, exports, "hasSubscribers", 1, dc_module_has_subscribers, state, DC_VISIBLE);
        dc_define(vm, exports, "subscribe", 2, dc_module_subscribe, state, DC_VISIBLE);
        dc_define(vm, exports, "tracingChannel", 1, dc_module_tracing_channel, state, DC_VISIBLE);
        dc_define(vm, exports, "unsubscribe", 2, dc_module_unsubscribe, state, DC_VISIBLE);
        mal_intrinsic_define_data(vm, exports, (const byte *) "Channel", ctor, DC_VISIBLE);
        mal_gc_unroot(&ctor_root);
        mal_gc_unroot(&state_root);
        module = roots[0];
        vm->intrinsics[MAL_INTRINSIC_NODE_DIAGNOSTICS_CHANNEL_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:diagnostics_channel", slots, count, module);
}

#endif /* MAL_NODE */
