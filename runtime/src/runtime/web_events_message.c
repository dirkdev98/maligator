#include "web_events_message.h"

#if MAL_NODE

#include <stdio.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object_ops.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_events_object.h"
#include "web_surface.h"

enum { EVENT_SLOTS_SYMBOL = MAL_WEB_NODE_EVENT_COUNT };
static MAL_ISOLATE_LOCAL MalValue event_roots[] = {
    MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
};

MalKey mal_web_node_event_slots_key(void) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = event_roots[EVENT_SLOTS_SYMBOL]};
}

MalValue mal_web_node_event_slots(MalValue receiver) {
    if (!mal_value_is_object(receiver)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(receiver), mal_web_node_event_slots_key());
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static MalValue event_string(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, text, strlen(text)));
}

void mal_web_node_event_set(MalVm *vm, MalValue object, const char *name, MalValue value) {
    MalValue roots[] = {object, value, mal_web_node_event_slots(object)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_object(roots[2])) {
        roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        mal_object_set(mal_value_to_object(roots[0]), mal_web_node_event_slots_key(), roots[2]);
    }
    mal_object_set(mal_value_to_object(roots[2]), mal_intrinsic_string_key(vm, (const byte *) name), roots[1]);
    mal_gc_unroot(&root);
}

typedef enum WebEventFieldKind {
    WEB_EVENT_FIELD_NULL,
    WEB_EVENT_FIELD_STRING,
    WEB_EVENT_FIELD_NUMBER,
    WEB_EVENT_FIELD_BOOLEAN,
    WEB_EVENT_FIELD_ARRAY,
    WEB_EVENT_FIELD_UNDEFINED,
} WebEventFieldKind;

typedef struct WebEventField {
    const char *name;
    WebEventFieldKind kind;
} WebEventField;

static const WebEventField message_fields[] = {
    {"data", WEB_EVENT_FIELD_NULL}, {"origin", WEB_EVENT_FIELD_STRING},
    {"lastEventId", WEB_EVENT_FIELD_STRING}, {"source", WEB_EVENT_FIELD_NULL},
    {"ports", WEB_EVENT_FIELD_ARRAY},
};
static const WebEventField close_fields[] = {
    {"wasClean", WEB_EVENT_FIELD_BOOLEAN}, {"code", WEB_EVENT_FIELD_NUMBER},
    {"reason", WEB_EVENT_FIELD_STRING},
};
static const WebEventField error_fields[] = {
    {"message", WEB_EVENT_FIELD_STRING}, {"filename", WEB_EVENT_FIELD_STRING},
    {"lineno", WEB_EVENT_FIELD_NUMBER}, {"colno", WEB_EVENT_FIELD_NUMBER},
    {"error", WEB_EVENT_FIELD_UNDEFINED},
};

typedef struct WebEventClass {
    const char *name;
    i32 length;
    const WebEventField *fields;
    usize field_count;
} WebEventClass;

static const WebEventClass event_classes[] = {
    [MAL_WEB_NODE_MESSAGE_EVENT] = {"MessageEvent", 1, message_fields, countof(message_fields)},
    [MAL_WEB_NODE_CLOSE_EVENT] = {"CloseEvent", 1, close_fields, countof(close_fields)},
    [MAL_WEB_NODE_ERROR_EVENT] = {"ErrorEvent", 2, error_fields, countof(error_fields)},
};

static MalValue event_field_default(MalVm *vm, WebEventFieldKind kind) {
    switch (kind) {
    case WEB_EVENT_FIELD_NULL: return mal_value_new_null();
    case WEB_EVENT_FIELD_STRING: return event_string(vm, "");
    case WEB_EVENT_FIELD_NUMBER: return mal_value_from_i32(0);
    case WEB_EVENT_FIELD_BOOLEAN: return mal_value_new_boolean(false);
    case WEB_EVENT_FIELD_ARRAY: return mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    default: return mal_value_new_undefined();
    }
}

static MalValue node_event_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue slot = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    const WebEventClass *event_class = &event_classes[mal_value_to_i32(slot)];
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class constructor cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalCompletion made = mal_vm_construct_value_with_target(
        vm, vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR], args, argc > 2 ? 2 : argc, new_target);
    if (made.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue roots[] = {made.value, argc > 1 ? args[1] : MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    for (usize i = 0; i < event_class->field_count; i++) {
        const WebEventField *field = &event_class->fields[i];
        roots[2] = mal_value_new_undefined();
        if (mal_value_is_object(roots[1])
            && !mal_vm_get_property(vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) field->name), &roots[2])) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        if (mal_value_is_undefined(roots[2])) {
            roots[2] = event_field_default(vm, field->kind);
        } else if (field->kind == WEB_EVENT_FIELD_BOOLEAN) {
            roots[2] = mal_value_new_boolean(mal_value_is_truthy(roots[2]));
        } else if (field->kind == WEB_EVENT_FIELD_STRING && !mal_value_is_string(roots[2])) {
            MalString *text = mal_ops_to_string(&vm->heap, roots[2]);
            if (text == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&root);
                return mal_value_new_undefined();
            }
            roots[2] = mal_value_from_string(text);
        } else if (field->kind == WEB_EVENT_FIELD_NUMBER && !mal_ops_is_number(roots[2])) {
            roots[2] = mal_value_from_f64(mal_ops_to_number(roots[2]));
        }
        mal_web_node_event_set(vm, roots[0], field->name, roots[2]);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue node_event_field(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args, (void) argc, (void) new_target;
    MalValue name = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue fields = mal_web_node_event_slots(receiver);
    if (!mal_value_is_object(fields)) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal invocation", "ERR_INVALID_THIS");
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(fields), mal_key_from_value(name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static MalValue event_class_new(MalVm *vm, MalWebNodeEventKind kind) {
    const WebEventClass *event_class = &event_classes[kind];
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_PROTOTYPE]));
    MalValue roots[] = {mal_value_from_object(prototype), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue slot = mal_value_from_i32((i32) kind);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR]),
        mal_intrinsic_ascii(vm, (const byte *) event_class->name), event_class->length, node_event_constructor, &slot, 1);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, (const byte *) "constructor", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    for (usize i = 0; i < event_class->field_count; i++) {
        const char *name = event_class->fields[i].name;
        char getter_name[48];
        snprintf(getter_name, sizeof getter_name, "get %s", name);
        roots[2] = event_string(vm, name);
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) getter_name), 0, node_event_field, &roots[2], 1));
        MalPropertyDesc desc = mal_intrinsic_accessor_desc(roots[3], mal_value_new_undefined(),
            MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(prototype, mal_key_from_value(roots[2]), &desc);
    }
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue event_get_constructor(MalVm *vm, MalValue prototype) {
    if (!mal_value_is_object(prototype)) return mal_value_new_undefined();
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(prototype),
        mal_intrinsic_string_key(vm, (const byte *) "constructor"));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void event_scan_roots(MalVm *vm, void *data) {
    (void) vm;
    (void) data;
    mal_gc_mark_values(event_roots, countof(event_roots));
}

bool mal_web_node_events_ensure(MalVm *vm) {
    if (mal_value_is_object(event_roots[MAL_WEB_NODE_MESSAGE_EVENT])) return true;
    if (!mal_value_is_object(vm->intrinsics[MAL_INTRINSIC_EVENT_CONSTRUCTOR])
        || !mal_value_is_object(vm->intrinsics[MAL_INTRINSIC_EVENT_PROTOTYPE])) {
        return false;
    }
    mal_gc_register_root_source(event_scan_roots, nullptr);
    event_roots[EVENT_SLOTS_SYMBOL] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    MalValue constructor = MAL_VALUE_UNDEFINED;
    MalRootSpan root;
    mal_gc_root(&root, &constructor, 1);
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    for (usize i = 0; i < countof(event_classes); i++) {
        constructor = event_class_new(vm, (MalWebNodeEventKind) i);
        event_roots[i] = mal_vm_function_prototype(vm, constructor);
        mal_intrinsic_define_data(vm, global, (const byte *) event_classes[i].name, constructor,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return true;
}

void mal_web_node_events_export(MalVm *vm, MalObject *module) {
    MalObject *global = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    for (usize i = 0; i < countof(event_classes); i++) {
        MalValue constructor = event_get_constructor(vm, event_roots[i]);
        // Node exposes ErrorEvent only as a global.
        if (i != MAL_WEB_NODE_ERROR_EVENT) {
            mal_intrinsic_define_data(vm, module, (const byte *) event_classes[i].name, constructor,
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        }
        mal_intrinsic_define_data(vm, global, (const byte *) event_classes[i].name, constructor,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
}

void mal_host_install_web_node_events(MalVm *vm, const MalHostInstallSlot *slots,
    i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    if (mal_web_events_ensure(vm) != nullptr) (void) mal_web_node_events_ensure(vm);
}

MalValue mal_web_node_event_new(MalVm *vm, MalWebNodeEventKind kind, const char *type) {
    MalValue event = mal_event_new(vm, type, false);
    mal_object_set_prototype(mal_value_to_object(event), mal_value_to_object(event_roots[kind]));
    return event;
}

MalValue mal_web_message_event_new(
    MalVm *vm, const char *type, MalValue data, MalValue ports, MalValue source) {
    MalValue roots[] = {data, ports, source, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_web_node_events_ensure(vm)) {
        roots[3] = mal_web_node_event_new(vm, MAL_WEB_NODE_MESSAGE_EVENT, type);
        mal_web_node_event_set(vm, roots[3], "data", roots[0]);
        mal_web_node_event_set(vm, roots[3], "origin", event_string(vm, ""));
        mal_web_node_event_set(vm, roots[3], "lastEventId", event_string(vm, ""));
        mal_web_node_event_set(vm, roots[3], "source", roots[2]);
        mal_web_node_event_set(vm, roots[3], "ports", roots[1]);
    }
    mal_gc_unroot(&root);
    return roots[3];
}

#endif /* MAL_NODE */
