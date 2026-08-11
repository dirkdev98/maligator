#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "node_util.h"

#if MAL_NODE

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "promise_object.h"
#include "u16_buffer.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define UTIL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
#define UTIL_INSPECT_MAX_DEPTH 8

typedef MalU16Buffer MalUtilBuilder;

typedef struct MalUtilInspectState {
    MalVm *vm;
    MalUtilBuilder *builder;
    MalObject *ancestors[UTIL_INSPECT_MAX_DEPTH + 1];
    i32 max_depth;
} MalUtilInspectState;

static bool util_builder_units(
    MalUtilBuilder *builder, const c16 *units, usize length) {
    return mal_u16_buffer_append_units(builder, units, length) == MAL_U16_BUFFER_OK;
}

static bool util_builder_string(MalUtilBuilder *builder, const MalString *string) {
    return mal_u16_buffer_append_string(builder, string) == MAL_U16_BUFFER_OK;
}

static bool util_builder_ascii(MalUtilBuilder *builder, const char *ascii) {
    return mal_u16_buffer_append_ascii(
        builder, (const byte *) ascii) == MAL_U16_BUFFER_OK;
}

static bool util_builder_code_unit(MalUtilBuilder *builder, c16 unit) {
    return mal_u16_buffer_push(builder, unit) == MAL_U16_BUFFER_OK;
}

static MalValue util_builder_finish(MalVm *vm, MalUtilBuilder *builder) {
    if (builder->status != MAL_U16_BUFFER_OK) {
        mal_u16_buffer_dispose(builder);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Formatted output exceeds the string length limit");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_u16_buffer_finish(&vm->heap, builder));
}

static void util_inspect_value(
    MalUtilInspectState *state, MalValue value, i32 depth, bool quote_string);

static void util_inspect_quoted(
    MalUtilBuilder *builder, const MalString *string) {
    util_builder_code_unit(builder, '\'');
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit == '\'' || unit == '\\') {
            util_builder_code_unit(builder, '\\');
            util_builder_code_unit(builder, unit);
        } else if (unit == '\n') {
            util_builder_ascii(builder, "\\n");
        } else if (unit == '\r') {
            util_builder_ascii(builder, "\\r");
        } else if (unit == '\t') {
            util_builder_ascii(builder, "\\t");
        } else {
            util_builder_code_unit(builder, unit);
        }
    }
    util_builder_code_unit(builder, '\'');
}

static bool util_inspect_is_cycle(
    MalUtilInspectState *state, MalObject *object, i32 depth) {
    for (i32 i = 0; i < depth; i++) {
        if (state->ancestors[i] == object) {
            return true;
        }
    }
    return false;
}

static void util_inspect_array(
    MalUtilInspectState *state, MalArrayObject *array, i32 depth) {
    MalUtilBuilder *builder = state->builder;
    u32 length = mal_array_object_length(array);
    if (length == 0) {
        util_builder_ascii(builder, "[]");
        return;
    }
    util_builder_ascii(builder, "[ ");
    for (u32 i = 0; i < length; i++) {
        if (i > 0) {
            util_builder_ascii(builder, ", ");
        }
        MalPropertyResolution resolution = mal_object_resolve_property(
            (MalObject *) array,
            mal_key_index(i));
        if (resolution.found) {
            util_inspect_value(state, resolution.desc.value, depth + 1, true);
        } else {
            util_builder_ascii(builder, "<1 empty item>");
        }
    }
    util_builder_ascii(builder, " ]");
}

static void util_inspect_object(
    MalUtilInspectState *state, MalObject *object, i32 depth) {
    MalUtilBuilder *builder = state->builder;
    if (util_inspect_is_cycle(state, object, depth)) {
        util_builder_ascii(builder, "[Circular]");
        return;
    }
    if (depth > state->max_depth) {
        util_builder_ascii(builder, mal_value_is_array_object(
            mal_value_from_object(object)) ? "[Array]" : "[Object]");
        return;
    }
    state->ancestors[depth] = object;
    MalValue object_value = mal_value_from_object(object);
    if (mal_value_is_array_object(object_value)) {
        util_inspect_array(state, mal_value_to_array_object(object_value), depth);
        return;
    }
    if (mal_value_is_callable(object_value)) {
        util_builder_ascii(builder, "[Function");
        MalString *name = mal_vm_callable_name(state->vm, object_value);
        if (name != nullptr && mal_string_length(name) > 0) {
            util_builder_ascii(builder, ": ");
            util_builder_string(builder, name);
        }
        util_builder_code_unit(builder, ']');
        return;
    }

    MalPropertyIter iter;
    mal_property_iter_init(
        &iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    bool first = true;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }
        if (!first) {
            util_builder_ascii(builder, ", ");
        } else {
            util_builder_ascii(builder, "{ ");
        }
        first = false;
        util_builder_string(builder, mal_ops_to_string(&state->vm->heap, key.value));
        util_builder_ascii(builder, ": ");
        if ((desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
            util_builder_ascii(builder, mal_value_is_callable(desc.getter)
                ? "[Getter]" : "[Setter]");
        } else {
            util_inspect_value(state, desc.value, depth + 1, true);
        }
    }
    util_builder_ascii(builder, first ? "{}" : " }");
}

static void util_inspect_value(
    MalUtilInspectState *state, MalValue value, i32 depth, bool quote_string) {
    if (mal_value_is_string(value)) {
        if (quote_string) {
            util_inspect_quoted(state->builder, mal_value_to_string(value));
        } else {
            util_builder_string(state->builder, mal_value_to_string(value));
        }
    } else if (mal_value_is_object(value)) {
        util_inspect_object(state, mal_value_to_object(value), depth);
    } else {
        util_builder_string(
            state->builder, mal_ops_to_string(&state->vm->heap, value));
    }
}

static i32 util_inspect_depth(MalVm *vm, MalValue options) {
    if (!mal_value_is_object(options)) {
        return 2;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options,
            mal_intrinsic_string_key(vm, (const byte *) "depth"), &value)) {
        return 2;
    }
    if (mal_value_is_null(value)) {
        return UTIL_INSPECT_MAX_DEPTH;
    }
    if (!mal_ops_is_number(value)) {
        return 2;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number)) {
        return number > 0 ? UTIL_INSPECT_MAX_DEPTH : 0;
    }
    if (number < 0) {
        return 0;
    }
    return number > UTIL_INSPECT_MAX_DEPTH
        ? UTIL_INSPECT_MAX_DEPTH
        : (i32) trunc(number);
}

static MalValue util_inspect_result(
    MalVm *vm, MalValue value, MalValue options) {
    MalUtilBuilder builder = {0};
    MalUtilInspectState state = {
        .vm = vm,
        .builder = &builder,
        .max_depth = util_inspect_depth(vm, options),
    };
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    util_inspect_value(&state, value, 0, true);
    return util_builder_finish(vm, &builder);
}

static MalValue util_inspect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return util_inspect_result(vm,
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined());
}

static bool util_format_number(
    MalVm *vm, MalUtilBuilder *builder, MalValue value, char conversion) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    if (isnan(number)) {
        return util_builder_ascii(builder, "NaN");
    }
    if (isinf(number)) {
        return util_builder_ascii(builder, number < 0 ? "-Infinity" : "Infinity");
    }
    char text[64];
    if (conversion == 'i') {
        snprintf(text, sizeof(text), "%.0f", trunc(number));
    } else {
        snprintf(text, sizeof(text), "%.15g", number);
    }
    return util_builder_ascii(builder, text);
}

static bool util_format_argument(
    MalVm *vm, MalUtilBuilder *builder, MalValue value, c16 conversion,
    MalValue options) {
    if (conversion == 's') {
        MalString *string;
        if (!mal_vm_to_string(vm, value, &string)) {
            return false;
        }
        return util_builder_string(builder, string);
    }
    if (conversion == 'd' || conversion == 'f' || conversion == 'i') {
        return util_format_number(vm, builder, value, (char) conversion);
    }
    if (conversion == 'o' || conversion == 'O' || conversion == 'j') {
        MalValue inspected = util_inspect_result(vm, value, options);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        return util_builder_string(builder, mal_value_to_string(inspected));
    }
    return false;
}

static MalValue util_format_values(
    MalVm *vm, MalValue options, const MalValue *args, i32 argc) {
    MalUtilBuilder builder = {0};
    if (argc == 0) {
        return util_builder_finish(vm, &builder);
    }
    if (!mal_value_is_string(args[0])) {
        for (i32 i = 0; i < argc; i++) {
            if (i > 0) {
                util_builder_code_unit(&builder, ' ');
            }
            if (mal_value_is_string(args[i])) {
                util_builder_string(&builder, mal_value_to_string(args[i]));
                continue;
            }
            MalValue inspected = util_inspect_result(vm, args[i], options);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_u16_buffer_dispose(&builder);
                return mal_value_new_undefined();
            }
            util_builder_string(&builder, mal_value_to_string(inspected));
        }
        return util_builder_finish(vm, &builder);
    }

    MalString *format = mal_value_to_string(args[0]);
    const c16 *units = mal_string_code_units(format);
    usize length = mal_string_length(format);
    i32 next = 1;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit != '%' || i + 1 >= length) {
            util_builder_code_unit(&builder, unit);
            continue;
        }
        c16 conversion = units[i + 1];
        if (conversion == '%') {
            util_builder_code_unit(&builder, '%');
            i++;
        } else if (next < argc
            && (conversion == 's' || conversion == 'd' || conversion == 'f'
                || conversion == 'i' || conversion == 'j' || conversion == 'o'
                || conversion == 'O')) {
            if (!util_format_argument(
                    vm, &builder, args[next++], conversion, options)) {
                mal_u16_buffer_dispose(&builder);
                return mal_value_new_undefined();
            }
            i++;
        } else if (conversion == 'c') {
            if (next < argc) {
                next++;
            }
            i++;
        } else {
            util_builder_code_unit(&builder, unit);
        }
    }
    for (; next < argc; next++) {
        util_builder_code_unit(&builder, ' ');
        if (mal_value_is_string(args[next])) {
            util_builder_string(&builder, mal_value_to_string(args[next]));
        } else {
            MalValue inspected = util_inspect_result(vm, args[next], options);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_u16_buffer_dispose(&builder);
                return mal_value_new_undefined();
            }
            util_builder_string(&builder, mal_value_to_string(inspected));
        }
    }
    return util_builder_finish(vm, &builder);
}

static MalValue util_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return util_format_values(vm, mal_value_new_undefined(), args, argc);
}

static MalValue util_format_with_options(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return util_format_values(vm,
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0);
}

static MalValue util_inherits(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 2 || !mal_value_is_callable(args[0])
        || !mal_value_is_callable(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The constructor and super constructor must be functions");
        return mal_value_new_undefined();
    }
    MalValue super_prototype;
    if (!mal_vm_get_property(vm, args[1],
            mal_intrinsic_string_key(vm, (const byte *) "prototype"),
            &super_prototype)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_object(super_prototype) && !mal_value_is_null(super_prototype)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The super constructor prototype must be an object or null");
        return mal_value_new_undefined();
    }
    MalValue prototype = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_is_object(super_prototype)
            ? mal_value_to_object(super_prototype)
            : nullptr));
    MalRootSpan root;
    mal_gc_root(&root, &prototype, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(prototype),
        (const byte *) "constructor", args[0],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_vm_set_property(vm, args[0],
                  mal_intrinsic_string_key(vm, (const byte *) "super_"),
                  args[1], args[0])
        && mal_vm_set_property(vm, args[0],
            mal_intrinsic_string_key(vm, (const byte *) "prototype"),
            prototype, args[0]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static void util_print_warning(MalValue message) {
    if (!mal_value_is_string(message)) {
        return;
    }
    const MalString *string = mal_value_to_string(message);
    fputs("DeprecationWarning: ", stderr);
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        c16 unit = units[i];
        if (unit <= 0x7f) {
            fputc((char) unit, stderr);
        } else {
            fprintf(stderr, "\\u%04x", unit);
        }
    }
    fputc('\n', stderr);
}

static MalValue util_deprecated_call(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    MalNativeFunctionObject *wrapper =
        mal_value_to_native_function_object(callee);
    if (!mal_value_to_boolean(
            mal_native_function_object_get_slot(wrapper, 2))) {
        util_print_warning(mal_native_function_object_get_slot(wrapper, 1));
        mal_native_function_object_set_slot(
            wrapper, 2, mal_value_new_boolean(true));
    }
    MalValue target = mal_native_function_object_get_slot(wrapper, 0);
    MalCompletion completion = mal_value_is_undefined(new_target)
        ? mal_vm_call_value(vm, target, receiver, args, argc)
        : mal_vm_construct_value_with_target(vm, target, args, argc, new_target);
    return completion.value;
}

static MalValue util_deprecate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The function argument must be callable");
        return mal_value_new_undefined();
    }
    MalString *message_string;
    if (!mal_vm_to_string(vm,
            argc > 1 ? args[1] : mal_value_new_undefined(), &message_string)) {
        return mal_value_new_undefined();
    }
    MalValue slots[] = {
        args[0], mal_value_from_string(message_string), mal_value_new_boolean(false)};
    MalRootSpan root;
    mal_gc_root(&root, slots, countof(slots));
    MalNativeFunctionObject *wrapper =
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "deprecated"),
            util_deprecated_call, slots, countof(slots));
    MalValue wrapper_value = mal_value_from_native_function_object(wrapper);
    MalRootSpan wrapper_root;
    mal_gc_root(&wrapper_root, &wrapper_value, 1);
    if (mal_vm_is_constructor(vm, args[0])) {
        mal_native_function_object_set_constructor(wrapper);
        MalValue prototype;
        if (mal_vm_get_property(vm, args[0],
                mal_intrinsic_string_key(vm, (const byte *) "prototype"),
                &prototype)) {
            mal_intrinsic_define_data(vm, (MalObject *) wrapper,
                (const byte *) "prototype", prototype, MAL_PROPERTY_NONE);
        }
    }
    mal_gc_unroot(&wrapper_root);
    mal_gc_unroot(&root);
    return wrapper_value;
}

static void util_clear_completion(MalVm *vm) {
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_NORMAL,
        .value = mal_value_new_undefined(),
    };
}

static MalValue util_promisify_callback(
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
        mal_promise_fulfill(vm, promise,
            argc > 1 ? args[1] : mal_value_new_undefined());
    }
    return mal_value_new_undefined();
}

static MalValue util_promisified_call(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue roots[] = {
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        mal_value_from_promise_object(mal_promise_object_new(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "callback"),
            util_promisify_callback, roots + 1, 1));

    MalValue *call_args = malloc((usize) (argc + 1) * sizeof(MalValue));
    if (call_args == nullptr) {
        mal_vm_throw_allocation_error(vm);
        MalValue result = roots[1];
        mal_gc_unroot(&root);
        return result;
    }
    for (i32 i = 0; i < argc; i++) call_args[i] = args[i];
    call_args[argc] = roots[2];
    MalCompletion completion = mal_vm_call_value(
        vm, roots[0], receiver, call_args, argc + 1);
    free(call_args);
    if (completion.kind == MAL_COMPLETION_THROW) {
        util_clear_completion(vm);
        mal_promise_reject(
            vm, mal_value_to_promise_object(roots[1]), completion.value);
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

static MalValue util_promisify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The original argument must be a function");
        return mal_value_new_undefined();
    }
    MalValue original = args[0];
    MalRootSpan root;
    mal_gc_root(&root, &original, 1);
    MalValue wrapper = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "promisified"),
            util_promisified_call, &original, 1));
    mal_gc_unroot(&root);
    return wrapper;
}

typedef struct MalNodeUtilExport {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodeUtilExport;

static const MalNodeUtilExport util_exports[] = {
    {"deprecate", 3, util_deprecate},
    {"format", 1, util_format},
    {"formatWithOptions", 2, util_format_with_options},
    {"inherits", 2, util_inherits},
    {"inspect", 2, util_inspect},
    {"promisify", 1, util_promisify},
};

void mal_host_install_node_util(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue values[countof(util_exports) + 1];
    for (usize i = 0; i < countof(values); i++) {
        values[i] = mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, values, countof(values));
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    for (usize i = 0; i < countof(util_exports); i++) {
        const MalNodeUtilExport *export = &util_exports[i];
        values[i] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(&vm->heap, function_prototype,
                mal_intrinsic_ascii(vm, (const byte *) export->name),
                export->length, export->callback));
    }
    values[countof(util_exports)] =
        mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *namespace = mal_value_to_object(values[countof(util_exports)]);
    for (usize i = 0; i < countof(util_exports); i++) {
        mal_intrinsic_define_data(vm, namespace,
            (const byte *) util_exports[i].name, values[i], UTIL_VISIBLE);
    }

    for (i32 slot = 0; slot < count; slot++) {
        MalValue value = mal_value_new_undefined();
        for (usize i = 0; i < countof(util_exports); i++) {
            if (strcmp(slots[slot].name, util_exports[i].name) == 0) {
                value = values[i];
                break;
            }
        }
        if (strcmp(slots[slot].name, "default") == 0) {
            value = values[countof(util_exports)];
        }
        if (!mal_value_is_undefined(value)) {
            vm->globals[slots[slot].slot] = value;
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
