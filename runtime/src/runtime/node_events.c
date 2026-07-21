#include "node_events.h"

#if MAL_NODE

#include <math.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define EE_WEC (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalKey ee_name_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static bool ee_string_is(MalValue value, const char *ascii) {
    if (!mal_value_is_string(value)) {
        return false;
    }
    return mal_string_equals_ascii(mal_value_to_string(value), ascii);
}

static bool ee_require_receiver(MalVm *vm, MalValue receiver, MalObject **out) {
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "EventEmitter method called on incompatible receiver");
        return false;
    }
    *out = mal_value_to_object(receiver);
    return true;
}

/* EventEmitter intentionally uses Node's ordinary, visible state properties. This
 * makes EventEmitter.call(obj) and prototype mixins work without a new heap type;
 * the null-prototype event table and its listener arrays are traced normally. */
static MalObject *ee_events(MalVm *vm, MalValue receiver, bool create) {
    MalObject *object;
    if (!ee_require_receiver(vm, receiver, &object)) {
        return nullptr;
    }
    MalPropertyLookup lookup = mal_object_get_own(object, ee_name_key(vm, "_events"));
    if (lookup.present && mal_value_is_object(lookup.desc.value)) {
        return mal_value_to_object(lookup.desc.value);
    }
    if (!create) {
        return nullptr;
    }

    MalValue events_value = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &events_value, 1);
    mal_object_set(object, ee_name_key(vm, "_events"), events_value);
    mal_object_set(object, ee_name_key(vm, "_eventsCount"), mal_value_from_i32(0));
    if (!mal_object_get_own(object, ee_name_key(vm, "_maxListeners")).present) {
        mal_object_set(object, ee_name_key(vm, "_maxListeners"), mal_value_new_undefined());
    }
    mal_gc_unroot(&root);
    return mal_value_to_object(events_value);
}

static void ee_set_event_count(MalVm *vm, MalValue receiver, i32 count) {
    mal_object_set(mal_value_to_object(receiver), ee_name_key(vm, "_eventsCount"),
                   mal_value_from_i32(count));
}

static i32 ee_event_count(MalVm *vm, MalValue receiver) {
    MalPropertyLookup lookup =
        mal_object_get_own(mal_value_to_object(receiver), ee_name_key(vm, "_eventsCount"));
    return lookup.present && mal_value_is_int32(lookup.desc.value)
        ? mal_value_to_i32(lookup.desc.value)
        : 0;
}

static MalArrayObject *ee_listener_array(MalObject *events, MalKey event) {
    MalPropertyLookup lookup = mal_object_get_own(events, event);
    return lookup.present && mal_value_is_array_object(lookup.desc.value)
        ? mal_value_to_array_object(lookup.desc.value)
        : nullptr;
}

static MalValue ee_array_value(MalArrayObject *array, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_array_object_dense_get(array, index, &value);
    return value;
}

static MalValue ee_key_value(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }
    return key.value;
}

static bool ee_event_key(MalVm *vm, MalValue value, MalKey *out) {
    return mal_vm_to_property_key(vm, value, out);
}

static MalValue ee_once_wrapper(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee);

static bool ee_is_once_wrapper(MalValue value) {
    if (!mal_value_is_native_function_object(value)) {
        return false;
    }
    MalNativeFunctionObject *function = mal_value_to_native_function_object(value);
    return function->slot_count == 4
        && mal_native_function_object_callback(function) == ee_once_wrapper;
}

static MalValue ee_original_listener(MalValue raw) {
    return ee_is_once_wrapper(raw)
        ? mal_native_function_object_get_slot(mal_value_to_native_function_object(raw), 2)
        : raw;
}

static MalValue ee_copy_listeners(
    MalVm *vm, MalArrayObject *old, i32 remove_index, MalValue inserted, bool prepend) {
    u32 old_length = old == nullptr ? 0 : mal_array_object_length(old);
    u32 new_length = old_length + (mal_value_is_empty(inserted) ? 0u : 1u)
        - (remove_index >= 0 ? 1u : 0u);
    MalValue result =
        mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, new_length));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalArrayObject *array = mal_value_to_array_object(result);
    u32 destination = 0;
    if (!mal_value_is_empty(inserted) && prepend) {
        mal_array_object_store(array, mal_key_index(destination++), inserted);
    }
    for (u32 i = 0; i < old_length; i++) {
        if ((i32) i != remove_index) {
            mal_array_object_store(array, mal_key_index(destination++), ee_array_value(old, i));
        }
    }
    if (!mal_value_is_empty(inserted) && !prepend) {
        mal_array_object_store(array, mal_key_index(destination), inserted);
    }
    mal_gc_unroot(&root);
    return result;
}

static bool ee_event_is(MalVm *vm, MalKey key, const char *name) {
    return key.kind == MAL_KEY_STRING
        && mal_string_equals(mal_value_to_string(key.value),
                             mal_intrinsic_ascii(vm, (const byte *) name));
}

static bool ee_emit_key(
    MalVm *vm, MalValue receiver, MalKey event, const MalValue *args, i32 argc) {
    MalObject *events = ee_events(vm, receiver, false);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    MalArrayObject *listeners = events == nullptr ? nullptr : ee_listener_array(events, event);
    u32 length = listeners == nullptr ? 0 : mal_array_object_length(listeners);
    if (length == 0) {
        if (ee_event_is(vm, event, "error")) {
            if (argc > 0) {
                vm->completion =
                    (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = args[0]};
            } else {
                mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                                   "Unhandled error event");
            }
        }
        return false;
    }

    MalValue snapshot = mal_value_from_array_object(listeners);
    MalRootSpan root;
    mal_gc_root(&root, &snapshot, 1);
    for (u32 i = 0; i < length; i++) {
        MalValue listener = ee_array_value(mal_value_to_array_object(snapshot), i);
        mal_vm_call_value(vm, listener, receiver, args, argc);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            break;
        }
    }
    mal_gc_unroot(&root);
    return true;
}

static bool ee_has_listeners(MalVm *vm, MalValue receiver, const char *name) {
    MalObject *events = ee_events(vm, receiver, false);
    if (events == nullptr) {
        return false;
    }
    MalArrayObject *array = ee_listener_array(events, ee_name_key(vm, name));
    return array != nullptr && mal_array_object_length(array) > 0;
}

static void ee_store_listener_array(MalVm *vm, MalValue receiver, MalObject *events,
                                    MalKey event, MalValue array, bool was_absent) {
    MalRootSpan root;
    mal_gc_root(&root, &array, 1);
    mal_object_set(events, event, array);
    if (was_absent) {
        ee_set_event_count(vm, receiver, ee_event_count(vm, receiver) + 1);
    }
    mal_gc_unroot(&root);
}

static MalValue ee_add(
    MalVm *vm, MalValue receiver, MalValue event_value, MalValue listener, bool prepend,
    bool once) {
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "EventEmitter method called on incompatible receiver");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(listener)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The listener argument must be a function");
        return mal_value_new_undefined();
    }
    MalKey event;
    if (!ee_event_key(vm, event_value, &event)) {
        return mal_value_new_undefined();
    }

    MalValue roots[] = {receiver, event.value, listener, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    ee_events(vm, roots[0], true);

    if (ee_has_listeners(vm, roots[0], "newListener")) {
        MalValue meta_args[] = {ee_key_value(vm, event), roots[2]};
        MalRootSpan meta_root;
        mal_gc_root(&meta_root, meta_args, countof(meta_args));
        ee_emit_key(vm, roots[0], ee_name_key(vm, "newListener"), meta_args, 2);
        mal_gc_unroot(&meta_root);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
    }

    MalObject *events = ee_events(vm, roots[0], true);
    MalArrayObject *old = ee_listener_array(events, event);
    bool absent = old == nullptr || mal_array_object_length(old) == 0;
    if (once) {
        MalValue slots[] = {roots[0], event.value, roots[2], mal_value_new_boolean(false)};
        MalNativeFunctionObject *wrapper = mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "bound onceWrapper"), ee_once_wrapper,
            slots, countof(slots));
        roots[3] = mal_value_from_native_function_object(wrapper);
        mal_intrinsic_define_data(vm, (MalObject *) wrapper, (const byte *) "listener",
                                  roots[2], EE_WEC);
    } else {
        roots[3] = roots[2];
    }
    MalValue next = ee_copy_listeners(vm, old, -1, roots[3], prepend);
    ee_store_listener_array(vm, roots[0], events, event, next, absent);
    mal_gc_unroot(&root);
    return receiver;
}

static bool ee_remove_one(
    MalVm *vm, MalValue receiver, MalKey event, MalValue listener, bool emit_meta) {
    MalObject *events = ee_events(vm, receiver, false);
    if (events == nullptr) {
        return false;
    }
    MalArrayObject *old = ee_listener_array(events, event);
    if (old == nullptr) {
        return false;
    }
    i32 found = -1;
    MalValue original = mal_value_new_undefined();
    for (i32 i = (i32) mal_array_object_length(old) - 1; i >= 0; i--) {
        MalValue raw = ee_array_value(old, (u32) i);
        MalValue candidate = ee_original_listener(raw);
        if (mal_ops_same_value(raw, listener) || mal_ops_same_value(candidate, listener)) {
            found = i;
            original = candidate;
            break;
        }
    }
    if (found < 0) {
        return false;
    }

    MalValue roots[] = {mal_value_from_array_object(old), original, event.value};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    u32 old_length = mal_array_object_length(old);
    if (old_length == 1) {
        mal_object_delete_own(events, event);
        ee_set_event_count(vm, receiver, ee_event_count(vm, receiver) - 1);
    } else {
        MalValue next = ee_copy_listeners(vm, old, found, mal_value_new_empty(), false);
        ee_store_listener_array(vm, receiver, events, event, next, false);
    }

    if (emit_meta && ee_has_listeners(vm, receiver, "removeListener")) {
        MalValue meta_args[] = {ee_key_value(vm, event), roots[1]};
        MalRootSpan meta_root;
        mal_gc_root(&meta_root, meta_args, countof(meta_args));
        ee_emit_key(vm, receiver, ee_name_key(vm, "removeListener"), meta_args, 2);
        mal_gc_unroot(&meta_root);
    }
    mal_gc_unroot(&root);
    return true;
}

static MalValue ee_once_wrapper(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    if (mal_value_to_boolean(mal_native_function_object_get_slot(function, 3))) {
        return mal_value_new_undefined();
    }
    mal_native_function_object_set_slot(function, 3, mal_value_new_boolean(true));
    MalValue receiver = mal_native_function_object_get_slot(function, 0);
    MalKey event = mal_key_from_value(mal_native_function_object_get_slot(function, 1));
    MalValue listener = mal_native_function_object_get_slot(function, 2);
    ee_remove_one(vm, receiver, event, callee, true);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return mal_vm_call_value(vm, listener, receiver, args, argc).value;
}

static MalValue ee_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) args;
    (void) argc;
    if (mal_value_is_undefined(new_target)) {
        ee_events(vm, receiver, true);
        return mal_value_new_undefined();
    }
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue prototype_value = mal_vm_function_prototype(vm, new_target);
    if (mal_value_is_object(prototype_value)) {
        prototype = mal_value_to_object(prototype_value);
    } else {
        prototype_value = mal_vm_function_prototype(vm, callee);
        if (mal_value_is_object(prototype_value)) {
            prototype = mal_value_to_object(prototype_value);
        }
    }
    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    ee_events(vm, instance, true);
    mal_gc_unroot(&root);
    return instance;
}

static MalValue ee_on(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_add(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
                  argc > 1 ? args[1] : mal_value_new_undefined(), false, false);
}

static MalValue ee_prepend_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_add(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
                  argc > 1 ? args[1] : mal_value_new_undefined(), true, false);
}

static MalValue ee_once(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_add(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
                  argc > 1 ? args[1] : mal_value_new_undefined(), false, true);
}

static MalValue ee_prepend_once_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_add(vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
                  argc > 1 ? args[1] : mal_value_new_undefined(), true, true);
}

static MalValue ee_emit(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    MalKey event;
    if (!ee_event_key(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &event)) {
        return mal_value_new_undefined();
    }
    MalValue event_root = event.value;
    MalRootSpan root;
    mal_gc_root(&root, &event_root, 1);
    bool emitted = ee_emit_key(vm, receiver, event, argc > 1 ? args + 1 : nullptr,
                               argc > 1 ? argc - 1 : 0);
    mal_gc_unroot(&root);
    return mal_value_new_boolean(emitted);
}

static MalValue ee_remove_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(receiver)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "EventEmitter method called on incompatible receiver");
        return mal_value_new_undefined();
    }
    MalValue listener = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_callable(listener)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The listener argument must be a function");
        return mal_value_new_undefined();
    }
    MalKey event;
    if (!ee_event_key(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &event)) {
        return mal_value_new_undefined();
    }
    MalValue event_root = event.value;
    MalRootSpan root;
    mal_gc_root(&root, &event_root, 1);
    ee_remove_one(vm, receiver, event, listener, true);
    mal_gc_unroot(&root);
    return receiver;
}

static void ee_remove_all_key(MalVm *vm, MalValue receiver, MalKey event) {
    MalObject *events = ee_events(vm, receiver, false);
    MalArrayObject *array = events == nullptr ? nullptr : ee_listener_array(events, event);
    u32 length = array == nullptr ? 0 : mal_array_object_length(array);
    if (length == 0) {
        return;
    }
    MalValue snapshot = mal_value_from_array_object(array);
    MalRootSpan root;
    mal_gc_root(&root, &snapshot, 1);
    for (i32 i = (i32) length - 1;
         i >= 0 && vm->completion.kind != MAL_COMPLETION_THROW; i--) {
        MalValue raw = ee_array_value(mal_value_to_array_object(snapshot), (u32) i);
        ee_remove_one(vm, receiver, event, raw, true);
    }
    mal_gc_unroot(&root);
}

static MalValue ee_event_names_value(MalVm *vm, MalValue receiver) {
    MalObject *events = ee_events(vm, receiver, false);
    if (events == nullptr) {
        return mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    }
    i32 count = ee_event_count(vm, receiver);
    MalValue result = mal_value_from_array_object(
        mal_intrinsic_new_dense_array(vm, count > 0 ? (u32) count : 0));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalPropertyIter iter;
    mal_property_iter_init(&iter, events, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    u32 index = 0;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (mal_value_is_array_object(desc.value)
            && mal_array_object_length(mal_value_to_array_object(desc.value)) > 0) {
            mal_array_object_store(mal_value_to_array_object(result), mal_key_index(index++),
                                   ee_key_value(vm, key));
        }
    }
    mal_array_object_set_length(mal_value_to_array_object(result), index);
    mal_gc_unroot(&root);
    return result;
}

static MalValue ee_remove_all_listeners(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    if (ee_events(vm, receiver, false) == nullptr) {
        return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
                                                           : receiver;
    }
    if (argc > 0) {
        MalKey event;
        if (!ee_event_key(vm, args[0], &event)) {
            return mal_value_new_undefined();
        }
        MalValue event_root = event.value;
        MalRootSpan root;
        mal_gc_root(&root, &event_root, 1);
        ee_remove_all_key(vm, receiver, event);
        mal_gc_unroot(&root);
        return receiver;
    }

    if (!ee_has_listeners(vm, receiver, "removeListener")) {
        MalValue fresh = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        MalRootSpan root;
        mal_gc_root(&root, &fresh, 1);
        mal_object_set(mal_value_to_object(receiver), ee_name_key(vm, "_events"), fresh);
        ee_set_event_count(vm, receiver, 0);
        mal_gc_unroot(&root);
        return receiver;
    }

    MalValue names = ee_event_names_value(vm, receiver);
    MalRootSpan root;
    mal_gc_root(&root, &names, 1);
    MalArrayObject *array = mal_value_to_array_object(names);
    u32 length = mal_array_object_length(array);
    for (u32 i = 0; i < length && vm->completion.kind != MAL_COMPLETION_THROW; i++) {
        MalValue name = ee_array_value(array, i);
        if (ee_string_is(name, "removeListener")) {
            continue;
        }
        MalKey event;
        if (ee_event_key(vm, name, &event)) {
            ee_remove_all_key(vm, receiver, event);
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        ee_remove_all_key(vm, receiver, ee_name_key(vm, "removeListener"));
    }
    mal_gc_unroot(&root);
    return receiver;
}

static MalValue ee_listeners_common(
    MalVm *vm, MalValue receiver, MalValue event_value, bool raw) {
    MalKey event;
    if (!ee_event_key(vm, event_value, &event)) {
        return mal_value_new_undefined();
    }
    MalObject *events = ee_events(vm, receiver, false);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalArrayObject *old = events == nullptr ? nullptr : ee_listener_array(events, event);
    u32 length = old == nullptr ? 0 : mal_array_object_length(old);
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, length));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (u32 i = 0; i < length; i++) {
        MalValue listener = ee_array_value(old, i);
        mal_array_object_store(mal_value_to_array_object(result), mal_key_index(i),
                               raw ? listener : ee_original_listener(listener));
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue ee_listeners(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_listeners_common(
        vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), false);
}

static MalValue ee_raw_listeners(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return ee_listeners_common(
        vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(), true);
}

static i32 ee_listener_count_value(
    MalVm *vm, MalValue receiver, MalValue event_value, MalValue listener) {
    MalKey event;
    if (!ee_event_key(vm, event_value, &event)) {
        return 0;
    }
    MalObject *events = ee_events(vm, receiver, false);
    if (events == nullptr) {
        return 0;
    }
    MalArrayObject *array = ee_listener_array(events, event);
    u32 length = array == nullptr ? 0 : mal_array_object_length(array);
    if (mal_value_is_undefined(listener)) {
        return (i32) length;
    }
    i32 count = 0;
    for (u32 i = 0; i < length; i++) {
        MalValue raw = ee_array_value(array, i);
        if (mal_ops_same_value(raw, listener)
            || mal_ops_same_value(ee_original_listener(raw), listener)) {
            count++;
        }
    }
    return count;
}

static MalValue ee_listener_count(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_value_from_i32(ee_listener_count_value(
        vm, receiver, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined()));
}

static MalValue ee_static_listener_count(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return mal_value_from_i32(ee_listener_count_value(
        vm, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined()));
}

static MalValue ee_event_names(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return ee_event_names_value(vm, receiver);
}

static MalValue ee_set_max_listeners(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) new_target;
    (void) callee;
    MalObject *object;
    if (!ee_require_receiver(vm, receiver, &object)) {
        return mal_value_new_undefined();
    }
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The maxListeners argument must be a number");
        return mal_value_new_undefined();
    }
    f64 number = mal_ops_number_as_f64(value);
    if (isnan(number) || number < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The maxListeners argument must be non-negative");
        return mal_value_new_undefined();
    }
    ee_events(vm, receiver, true);
    mal_object_set(object, ee_name_key(vm, "_maxListeners"), value);
    return receiver;
}

static MalValue ee_get_max_listeners(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalObject *object;
    if (!ee_require_receiver(vm, receiver, &object)) {
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup =
        mal_object_get_own(object, ee_name_key(vm, "_maxListeners"));
    return lookup.present && mal_ops_is_number(lookup.desc.value) ? lookup.desc.value
                                                                  : mal_value_from_i32(10);
}

typedef struct MalNodeEventsMethod {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodeEventsMethod;

static MalValue ee_new_function(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback) {
    return mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback));
}

void mal_host_install_node_events(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR];
    if (!mal_value_is_undefined(cached)) {
        for (i32 i = 0; i < count; i++) {
            if (strcmp(slots[i].name, "EventEmitter") == 0
                || strcmp(slots[i].name, "default") == 0) {
                vm->globals[slots[i].slot] = cached;
            }
        }
        return;
    }
    static const MalNodeEventsMethod methods[] = {
        {"emit", 1, ee_emit},
        {"eventNames", 0, ee_event_names},
        {"getMaxListeners", 0, ee_get_max_listeners},
        {"listenerCount", 1, ee_listener_count},
        {"listeners", 1, ee_listeners},
        {"once", 2, ee_once},
        {"prependListener", 2, ee_prepend_listener},
        {"prependOnceListener", 2, ee_prepend_once_listener},
        {"rawListeners", 1, ee_raw_listeners},
        {"removeAllListeners", 0, ee_remove_all_listeners},
        {"setMaxListeners", 1, ee_set_max_listeners},
    };

    MalValue roots[4] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    MalObject *prototype = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    roots[0] = mal_value_from_object(prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) "EventEmitter"), 1, ee_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_CONSTRUCTOR] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_EVENT_EMITTER_PROTOTYPE] = roots[0];

    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
                              roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    for (usize i = 0; i < countof(methods); i++) {
        roots[2] = ee_new_function(vm, methods[i].name, methods[i].length,
                                   methods[i].callback);
        mal_intrinsic_define_data(vm, prototype, (const byte *) methods[i].name,
                                  roots[2], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    roots[2] = ee_new_function(vm, "addListener", 2, ee_on);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "addListener", roots[2],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "on", roots[2],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[3] = ee_new_function(vm, "removeListener", 2, ee_remove_listener);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "removeListener", roots[3],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "off", roots[3],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue static_count = ee_new_function(vm, "listenerCount", 2,
                                             ee_static_listener_count);
    MalRootSpan static_root;
    mal_gc_root(&static_root, &static_count, 1);
    mal_intrinsic_define_data(vm, (MalObject *) constructor,
                              (const byte *) "listenerCount", static_count, EE_WEC);
    mal_intrinsic_define_data(vm, (MalObject *) constructor,
                              (const byte *) "EventEmitter", roots[1], EE_WEC);
    mal_gc_unroot(&static_root);

    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "EventEmitter") == 0
            || strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[1];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
