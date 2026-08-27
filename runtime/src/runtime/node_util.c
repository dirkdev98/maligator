#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "node_util.h"

#if MAL_NODE

#include "array_object.h"
#include "array_buffer_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "iterator_object.h"
#include "map_object.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "promise_object.h"
#include "proxy_object.h"
#include "typed_array_object.h"
#include "u16_buffer.h"
#include "utf8.h"
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

static MalValue util_types_is_promise(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) new_target;
    (void) callee;
    return mal_value_new_boolean(
        argc > 0 && mal_value_is_promise_object(args[0]));
}

typedef enum MalUtilLegacyPredicate {
    UTIL_IS_ARRAY,
    UTIL_IS_BOOLEAN,
    UTIL_IS_BUFFER,
    UTIL_IS_FUNCTION,
    UTIL_IS_NULL,
    UTIL_IS_NULL_OR_UNDEFINED,
    UTIL_IS_NUMBER,
    UTIL_IS_OBJECT,
    UTIL_IS_STRING,
    UTIL_IS_SYMBOL,
    UTIL_IS_UNDEFINED,
} MalUtilLegacyPredicate;

static MalValue util_legacy_predicate(
    MalVm *vm, const MalValue *args, i32 argc, MalUtilLegacyPredicate kind) {
    (void) vm;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    bool result = false;
    switch (kind) {
        case UTIL_IS_ARRAY: result = mal_value_is_array_object(value); break;
        case UTIL_IS_BOOLEAN: result = mal_value_is_boolean(value); break;
        case UTIL_IS_BUFFER:
            result = mal_value_is_typed_array_object(value)
                && mal_value_to_typed_array_object(value)->is_buffer;
            break;
        case UTIL_IS_FUNCTION: result = mal_value_is_callable(value); break;
        case UTIL_IS_NULL: result = mal_value_is_null(value); break;
        case UTIL_IS_NULL_OR_UNDEFINED: result = mal_value_is_nil(value); break;
        case UTIL_IS_NUMBER: result = mal_ops_is_number(value); break;
        case UTIL_IS_OBJECT:
            result = mal_value_is_object(value) && !mal_value_is_callable(value);
            break;
        case UTIL_IS_STRING: result = mal_value_is_string(value); break;
        case UTIL_IS_SYMBOL: result = mal_value_is_symbol(value); break;
        case UTIL_IS_UNDEFINED: result = mal_value_is_undefined(value); break;
    }
    return mal_value_new_boolean(result);
}

#define UTIL_LEGACY_PREDICATE(name, kind) \
    static MalValue util_##name( \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        (void) receiver; (void) new_target; (void) callee; \
        return util_legacy_predicate(vm, args, argc, kind); \
    }

UTIL_LEGACY_PREDICATE(is_array, UTIL_IS_ARRAY)
UTIL_LEGACY_PREDICATE(is_boolean, UTIL_IS_BOOLEAN)
UTIL_LEGACY_PREDICATE(is_buffer, UTIL_IS_BUFFER)
UTIL_LEGACY_PREDICATE(is_function, UTIL_IS_FUNCTION)
UTIL_LEGACY_PREDICATE(is_null, UTIL_IS_NULL)
UTIL_LEGACY_PREDICATE(is_null_or_undefined, UTIL_IS_NULL_OR_UNDEFINED)
UTIL_LEGACY_PREDICATE(is_number, UTIL_IS_NUMBER)
UTIL_LEGACY_PREDICATE(is_object, UTIL_IS_OBJECT)
UTIL_LEGACY_PREDICATE(is_string, UTIL_IS_STRING)
UTIL_LEGACY_PREDICATE(is_symbol, UTIL_IS_SYMBOL)
UTIL_LEGACY_PREDICATE(is_undefined, UTIL_IS_UNDEFINED)

typedef bool (*MalUtilTypePredicate)(MalValue value);

static MalValue util_type_predicate_result(
    const MalValue *args, i32 argc, MalUtilTypePredicate predicate) {
    return mal_value_new_boolean(argc > 0 && predicate(args[0]));
}

#define UTIL_TYPE_PREDICATE(name, expression) \
    static bool util_type_check_##name(MalValue value) { return (expression); } \
    static MalValue util_types_##name( \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        (void) vm; (void) receiver; (void) new_target; (void) callee; \
        return util_type_predicate_result(args, argc, util_type_check_##name); \
    }

UTIL_TYPE_PREDICATE(is_any_array_buffer, mal_value_is_array_buffer_object(value))
UTIL_TYPE_PREDICATE(is_array_buffer,
    mal_value_is_array_buffer_object(value)
        && !mal_value_to_array_buffer_object(value)->shared)
UTIL_TYPE_PREDICATE(is_shared_array_buffer,
    mal_value_is_array_buffer_object(value)
        && mal_value_to_array_buffer_object(value)->shared)
UTIL_TYPE_PREDICATE(is_data_view, mal_value_is_data_view_object(value))
UTIL_TYPE_PREDICATE(is_date, mal_value_is_date_object(value))
UTIL_TYPE_PREDICATE(is_map,
    mal_value_is_map_object(value) && !mal_value_to_map_object(value)->weak)
UTIL_TYPE_PREDICATE(is_set,
    mal_value_is_set_object(value) && !mal_value_to_map_object(value)->weak)
UTIL_TYPE_PREDICATE(is_weak_map,
    mal_value_is_map_object(value) && mal_value_to_map_object(value)->weak)
UTIL_TYPE_PREDICATE(is_weak_set,
    mal_value_is_set_object(value) && mal_value_to_map_object(value)->weak)
UTIL_TYPE_PREDICATE(is_reg_exp, mal_value_is_regexp_object(value))
UTIL_TYPE_PREDICATE(is_typed_array, mal_value_is_typed_array_object(value))
UTIL_TYPE_PREDICATE(is_boxed_primitive, mal_value_is_primitive_wrapper(value))
UTIL_TYPE_PREDICATE(is_generator_object, mal_value_is_generator_object(value))
UTIL_TYPE_PREDICATE(is_module_namespace_object,
    mal_value_is_module_namespace_object(value))
UTIL_TYPE_PREDICATE(is_proxy, mal_value_is_proxy_object(value))
UTIL_TYPE_PREDICATE(is_external, false)
UTIL_TYPE_PREDICATE(is_key_object, false)
UTIL_TYPE_PREDICATE(is_crypto_key, false)
UTIL_TYPE_PREDICATE(is_map_iterator,
    mal_value_is_iterator_object(value)
        && mal_value_to_iterator_object(value)->kind <= MAL_ITERATOR_MAP_ENTRIES)
UTIL_TYPE_PREDICATE(is_set_iterator,
    mal_value_is_iterator_object(value)
        && mal_value_to_iterator_object(value)->kind >= MAL_ITERATOR_SET_VALUES
        && mal_value_to_iterator_object(value)->kind <= MAL_ITERATOR_SET_ENTRIES)

#define UTIL_TYPED_ARRAY_PREDICATE(name, expected_kind) \
    UTIL_TYPE_PREDICATE(name, mal_value_is_typed_array_object(value) \
        && mal_value_to_typed_array_object(value)->kind == (expected_kind))

UTIL_TYPED_ARRAY_PREDICATE(is_int8_array, MAL_TA_INT8)
UTIL_TYPED_ARRAY_PREDICATE(is_uint8_array, MAL_TA_UINT8)
UTIL_TYPED_ARRAY_PREDICATE(is_uint8_clamped_array, MAL_TA_UINT8_CLAMPED)
UTIL_TYPED_ARRAY_PREDICATE(is_int16_array, MAL_TA_INT16)
UTIL_TYPED_ARRAY_PREDICATE(is_uint16_array, MAL_TA_UINT16)
UTIL_TYPED_ARRAY_PREDICATE(is_int32_array, MAL_TA_INT32)
UTIL_TYPED_ARRAY_PREDICATE(is_uint32_array, MAL_TA_UINT32)
UTIL_TYPED_ARRAY_PREDICATE(is_float32_array, MAL_TA_FLOAT32)
UTIL_TYPED_ARRAY_PREDICATE(is_float64_array, MAL_TA_FLOAT64)
UTIL_TYPED_ARRAY_PREDICATE(is_big_int64_array, MAL_TA_BIGINT64)
UTIL_TYPED_ARRAY_PREDICATE(is_big_uint64_array, MAL_TA_BIGUINT64)

typedef struct MalNodeUtilTypeExport {
    const char *name;
    MalNativeFunctionCallback callback;
} MalNodeUtilTypeExport;

static const MalNodeUtilTypeExport util_type_exports[] = {
    {"isAnyArrayBuffer", util_types_is_any_array_buffer},
    {"isArrayBuffer", util_types_is_array_buffer},
    {"isSharedArrayBuffer", util_types_is_shared_array_buffer},
    {"isDataView", util_types_is_data_view},
    {"isDate", util_types_is_date},
    {"isMap", util_types_is_map},
    {"isSet", util_types_is_set},
    {"isWeakMap", util_types_is_weak_map},
    {"isWeakSet", util_types_is_weak_set},
    {"isRegExp", util_types_is_reg_exp},
    {"isTypedArray", util_types_is_typed_array},
    {"isBoxedPrimitive", util_types_is_boxed_primitive},
    {"isGeneratorObject", util_types_is_generator_object},
    {"isModuleNamespaceObject", util_types_is_module_namespace_object},
    {"isProxy", util_types_is_proxy},
    {"isExternal", util_types_is_external},
    {"isKeyObject", util_types_is_key_object},
    {"isCryptoKey", util_types_is_crypto_key},
    {"isMapIterator", util_types_is_map_iterator},
    {"isSetIterator", util_types_is_set_iterator},
    {"isInt8Array", util_types_is_int8_array},
    {"isUint8Array", util_types_is_uint8_array},
    {"isUint8ClampedArray", util_types_is_uint8_clamped_array},
    {"isInt16Array", util_types_is_int16_array},
    {"isUint16Array", util_types_is_uint16_array},
    {"isInt32Array", util_types_is_int32_array},
    {"isUint32Array", util_types_is_uint32_array},
    {"isFloat32Array", util_types_is_float32_array},
    {"isFloat64Array", util_types_is_float64_array},
    {"isBigInt64Array", util_types_is_big_int64_array},
    {"isBigUint64Array", util_types_is_big_uint64_array},
};

static MalValue util_debug_noop(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) vm;
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    return mal_value_new_undefined();
}

static MalValue util_debuglog(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalValue logger = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "debug"), 0,
            util_debug_noop));
    MalRootSpan root;
    mal_gc_root(&root, &logger, 1);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(logger), (const byte *) "enabled",
        mal_value_new_boolean(false), UTIL_VISIBLE);
    mal_gc_unroot(&root);
    return logger;
}

static bool util_env_space(c16 unit) {
    return unit == ' ' || unit == '\t';
}

static MalValue util_parse_env(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The content argument must be a string");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        args[0],
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalString *source = mal_value_to_string(roots[0]);
    const c16 *units = mal_string_code_units(source);
    usize length = mal_string_length(source);
    usize cursor = 0;
    while (cursor < length) {
        usize line_end = cursor;
        while (line_end < length && units[line_end] != '\n'
               && units[line_end] != '\r') {
            line_end++;
        }
        usize start = cursor;
        while (start < line_end && util_env_space(units[start])) start++;
        if (start < line_end && units[start] != '#') {
            if (line_end - start >= 7
                && units[start] == 'e' && units[start + 1] == 'x'
                && units[start + 2] == 'p' && units[start + 3] == 'o'
                && units[start + 4] == 'r' && units[start + 5] == 't'
                && util_env_space(units[start + 6])) {
                start += 7;
                while (start < line_end && util_env_space(units[start])) start++;
            }
            usize equals = start;
            while (equals < line_end && units[equals] != '=') equals++;
            usize key_end = equals;
            while (key_end > start && util_env_space(units[key_end - 1])) key_end--;
            if (equals < line_end && key_end > start) {
                usize value_start = equals + 1;
                while (value_start < line_end && util_env_space(units[value_start])) {
                    value_start++;
                }
                usize value_end = line_end;
                if (value_start < value_end
                    && (units[value_start] == '\'' || units[value_start] == '"')) {
                    c16 quote = units[value_start++];
                    if (value_end > value_start && units[value_end - 1] == quote) {
                        value_end--;
                    }
                } else {
                    for (usize i = value_start; i < value_end; i++) {
                        if (units[i] == '#') {
                            value_end = i;
                            break;
                        }
                    }
                    while (value_end > value_start
                           && util_env_space(units[value_end - 1])) {
                        value_end--;
                    }
                }
                roots[2] = mal_value_from_string(mal_string_new_slice(
                    &vm->heap, source, start, key_end - start));
                roots[3] = mal_value_from_string(mal_string_new_slice(
                    &vm->heap, source, value_start, value_end - value_start));
                mal_object_set(mal_value_to_object(roots[1]),
                    mal_key_from_value(roots[2]), roots[3]);
            }
        }
        cursor = line_end;
        if (cursor < length && units[cursor] == '\r') cursor++;
        if (cursor < length && units[cursor] == '\n') cursor++;
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}

/* --------------------------------------------------------------------------
 * util.parseArgs.
 *
 * This follows Node's three observable phases: validate the configuration,
 * classify argv into tokens, then store values/positionals and apply defaults.
 * The returned values object intentionally has a null prototype.
 * -------------------------------------------------------------------------- */

typedef enum MalUtilParseOptionType {
    UTIL_PARSE_STRING,
    UTIL_PARSE_BOOLEAN,
} MalUtilParseOptionType;

typedef struct MalUtilParseOption {
    usize roots_index;
    MalUtilParseOptionType type;
    bool has_short;
    c16 short_name;
    bool multiple;
    bool has_default;
} MalUtilParseOption;

enum MalUtilParseRoot {
    UTIL_PARSE_CONFIG,
    UTIL_PARSE_ARGS,
    UTIL_PARSE_OPTIONS,
    UTIL_PARSE_RESULT,
    UTIL_PARSE_VALUES,
    UTIL_PARSE_POSITIONALS,
    UTIL_PARSE_TOKENS,
    UTIL_PARSE_KEYS,
    UTIL_PARSE_CURRENT,
    UTIL_PARSE_NEXT,
    UTIL_PARSE_NAME,
    UTIL_PARSE_RAW_NAME,
    UTIL_PARSE_VALUE,
    UTIL_PARSE_TEMP,
    UTIL_PARSE_TEMP_2,
    UTIL_PARSE_ROOT_COUNT,
};

typedef struct MalUtilParseState {
    MalVm *vm;
    MalValue *roots;
    MalUtilParseOption *options;
    MalValue *option_roots;
    usize option_count;
    bool strict;
    bool allow_positionals;
    bool return_tokens;
    bool allow_negative;
} MalUtilParseState;

static bool util_parse_string_equals_ascii(MalValue value, const char *ascii) {
    if (!mal_value_is_string(value)) return false;
    MalString *string = mal_value_to_string(value);
    usize length = strlen(ascii);
    if (mal_string_length(string) != length) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] != (byte) ascii[i]) return false;
    }
    return true;
}

static bool util_parse_string_starts_ascii(
    MalValue value, const char *ascii) {
    if (!mal_value_is_string(value)) return false;
    MalString *string = mal_value_to_string(value);
    usize prefix_length = strlen(ascii);
    if (mal_string_length(string) < prefix_length) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < prefix_length; i++) {
        if (units[i] != (byte) ascii[i]) return false;
    }
    return true;
}

static MalValue util_parse_slice(
    MalVm *vm, MalValue value, usize start, usize length) {
    return mal_value_from_string(mal_string_new_slice(
        &vm->heap, mal_value_to_string(value), start, length));
}

static MalValue util_parse_short_string(MalVm *vm, c16 short_name) {
    return mal_value_from_string(
        mal_string_new_copy(&vm->heap, &short_name, 1));
}

static MalValue util_parse_raw_short(MalVm *vm, c16 short_name) {
    c16 units[] = {'-', short_name};
    return mal_value_from_string(
        mal_string_new_copy(&vm->heap, units, countof(units)));
}

static bool util_parse_get_own(
    MalVm *vm, MalValue object, MalKey key, bool *present, MalValue *out) {
    *present = false;
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(object)) return true;
    MalPropertyDesc desc;
    if (!mal_vm_get_own_property(vm, object, key, present, &desc)) return false;
    if (!*present) return true;
    return mal_vm_get_property(vm, object, key, out);
}

static bool util_parse_get_own_ascii(
    MalVm *vm, MalValue object, const char *name, bool *present,
    MalValue *out) {
    return util_parse_get_own(vm, object,
        mal_intrinsic_string_key(vm, (const byte *) name), present, out);
}

static bool util_parse_is_record(MalVm *vm, MalValue value, bool *result) {
    *result = false;
    if (!mal_value_is_object(value) || mal_value_is_callable(value)) return true;
    bool is_array;
    if (!mal_vm_is_array(vm, value, &is_array)) return false;
    *result = !is_array;
    return true;
}

static bool util_parse_array_length(
    MalVm *vm, MalValue value, u32 *length, MalValue *temp) {
    if (mal_value_is_array_object(value)) {
        *length = mal_array_object_length(mal_value_to_array_object(value));
        return true;
    }
    if (!mal_vm_get_property(vm, value,
            mal_intrinsic_string_key(vm, (const byte *) "length"), temp)) {
        return false;
    }
    f64 number;
    if (!mal_vm_to_number(vm, *temp, &number)) return false;
    number = mal_ops_number_to_length(number);
    *length = number > UINT32_MAX ? UINT32_MAX : (u32) number;
    return true;
}

static bool util_parse_array_append(MalValue array_value, MalValue value) {
    MalArrayObject *array = mal_value_to_array_object(array_value);
    return mal_array_object_store(
        array, mal_key_index(mal_array_object_length(array)), value);
}

static bool util_parse_throw(MalVm *vm, const char *message) {
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
    return false;
}

static bool util_parse_throw_code(
    MalVm *vm, const char *message, const char *code) {
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
    if (vm->completion.kind == MAL_COMPLETION_THROW
        && mal_value_is_object(vm->completion.value)) {
        MalValue roots[] = {
            vm->completion.value,
            mal_value_from_string(
                mal_intrinsic_ascii(vm, (const byte *) code)),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
            (const byte *) "code", roots[1], UTIL_VISIBLE);
        mal_gc_unroot(&root);
    }
    return false;
}

static bool util_parse_build_main_args(
    MalVm *vm, MalValue *out, MalValue *temp) {
    i32 os_argc = vm->launch.argc;
    char **os_argv = vm->launch.argv;
    u32 length = os_argc > 1 ? (u32) (os_argc - 1) : 0;
    *out = mal_value_from_array_object(mal_intrinsic_new_array(vm, length));
    for (u32 i = 0; i < length; i++) {
        const char *arg = os_argv != nullptr && os_argv[i + 1] != nullptr
            ? os_argv[i + 1]
            : "";
        MalString *string = mal_string_from_utf8(
            &vm->heap, (const byte *) arg, strlen(arg));
        if (string == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        *temp = mal_value_from_string(string);
        if (!mal_array_object_store(
                mal_value_to_array_object(*out), mal_key_index(i), *temp)) {
            return util_parse_throw(vm, "Unable to store command line argument");
        }
    }
    return true;
}

static bool util_parse_validate_default_array(
    MalVm *vm, MalValue value, MalUtilParseOptionType type, MalValue *temp) {
    bool is_array;
    if (!mal_vm_is_array(vm, value, &is_array)) return false;
    if (!is_array) {
        return util_parse_throw_code(vm,
            "Option default must be an array when multiple is true",
            "ERR_INVALID_ARG_TYPE");
    }
    u32 length;
    if (!util_parse_array_length(vm, value, &length, temp)) return false;
    for (u32 i = 0; i < length; i++) {
        if (!mal_vm_get_property(vm, value, mal_key_index(i), temp)) return false;
        bool valid = type == UTIL_PARSE_STRING
            ? mal_value_is_string(*temp)
            : mal_value_is_boolean(*temp);
        if (!valid) {
            return util_parse_throw_code(vm,
                "Option default array contains a value of the wrong type",
                "ERR_INVALID_ARG_TYPE");
        }
    }
    return true;
}

static i32 util_parse_find_long(
    const MalUtilParseState *state, MalValue name) {
    if (!mal_value_is_string(name)) return -1;
    MalString *needle = mal_value_to_string(name);
    for (usize i = 0; i < state->option_count; i++) {
        MalValue candidate =
            state->option_roots[state->options[i].roots_index];
        if (mal_string_equals(needle, mal_value_to_string(candidate))) {
            return (i32) i;
        }
    }
    return -1;
}

static i32 util_parse_find_short(
    const MalUtilParseState *state, c16 short_name) {
    for (usize i = 0; i < state->option_count; i++) {
        if (state->options[i].has_short
            && state->options[i].short_name == short_name) {
            return (i32) i;
        }
    }
    return -1;
}

static MalValue util_parse_option_name(
    const MalUtilParseState *state, i32 option_index) {
    return state->option_roots[state->options[option_index].roots_index];
}

static bool util_parse_define_token_property(
    MalUtilParseState *state, MalObject *token, const char *name,
    MalValue value) {
    mal_intrinsic_define_data(state->vm, token, (const byte *) name,
        value, UTIL_VISIBLE);
    return state->vm->completion.kind != MAL_COMPLETION_THROW;
}

static bool util_parse_append_option_token(
    MalUtilParseState *state, MalValue name, MalValue raw_name, u32 index,
    MalValue value, bool inline_value) {
    if (!state->return_tokens) return true;
    state->roots[UTIL_PARSE_TEMP] =
        mal_value_from_object(mal_intrinsic_new_object(state->vm));
    MalObject *token = mal_value_to_object(state->roots[UTIL_PARSE_TEMP]);
    if (!util_parse_define_token_property(state, token, "kind",
            mal_value_from_string(mal_intrinsic_ascii(state->vm, "option")))
        || !util_parse_define_token_property(state, token, "name", name)
        || !util_parse_define_token_property(
            state, token, "rawName", raw_name)
        || !util_parse_define_token_property(state, token, "index",
            mal_ops_number_value((f64) index))
        || !util_parse_define_token_property(state, token, "value", value)
        || !util_parse_define_token_property(state, token, "inlineValue",
            mal_value_is_undefined(value)
                ? mal_value_new_undefined()
                : mal_value_new_boolean(inline_value))) {
        return false;
    }
    return util_parse_array_append(
        state->roots[UTIL_PARSE_TOKENS], state->roots[UTIL_PARSE_TEMP]);
}

static bool util_parse_append_positional_token(
    MalUtilParseState *state, MalValue value, u32 index) {
    if (state->return_tokens) {
        state->roots[UTIL_PARSE_TEMP] =
            mal_value_from_object(mal_intrinsic_new_object(state->vm));
        MalObject *token = mal_value_to_object(state->roots[UTIL_PARSE_TEMP]);
        if (!util_parse_define_token_property(state, token, "kind",
                mal_value_from_string(
                    mal_intrinsic_ascii(state->vm, "positional")))
            || !util_parse_define_token_property(state, token, "index",
                mal_ops_number_value((f64) index))
            || !util_parse_define_token_property(state, token, "value", value)
            || !util_parse_array_append(state->roots[UTIL_PARSE_TOKENS],
                state->roots[UTIL_PARSE_TEMP])) {
            return false;
        }
    }
    if (!state->allow_positionals) {
        return util_parse_throw_code(state->vm,
            "Unexpected positional argument",
            "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
    }
    return util_parse_array_append(
        state->roots[UTIL_PARSE_POSITIONALS], value);
}

static bool util_parse_append_terminator_token(
    MalUtilParseState *state, u32 index) {
    if (!state->return_tokens) return true;
    state->roots[UTIL_PARSE_TEMP] =
        mal_value_from_object(mal_intrinsic_new_object(state->vm));
    MalObject *token = mal_value_to_object(state->roots[UTIL_PARSE_TEMP]);
    if (!util_parse_define_token_property(state, token, "kind",
            mal_value_from_string(
                mal_intrinsic_ascii(state->vm, "option-terminator")))
        || !util_parse_define_token_property(state, token, "index",
            mal_ops_number_value((f64) index))) {
        return false;
    }
    return util_parse_array_append(
        state->roots[UTIL_PARSE_TOKENS], state->roots[UTIL_PARSE_TEMP]);
}

static bool util_parse_store_option(
    MalUtilParseState *state, MalValue name, MalValue value,
    i32 option_index) {
    if (util_parse_string_equals_ascii(name, "__proto__")) return true;
    MalKey key = mal_key_from_value(name);
    MalObject *values = mal_value_to_object(state->roots[UTIL_PARSE_VALUES]);
    bool multiple = option_index >= 0
        && state->options[option_index].multiple;
    if (!multiple) return mal_object_set(values, key, value);

    MalPropertyLookup current = mal_object_get_own(values, key);
    if (current.present && mal_value_is_array_object(current.desc.value)) {
        return util_parse_array_append(current.desc.value, value);
    }
    state->roots[UTIL_PARSE_TEMP_2] = mal_value_from_array_object(
        mal_intrinsic_new_array(state->vm, 0));
    if (!util_parse_array_append(state->roots[UTIL_PARSE_TEMP_2], value)) {
        return false;
    }
    return mal_object_set(values, key, state->roots[UTIL_PARSE_TEMP_2]);
}

static bool util_parse_process_option(
    MalUtilParseState *state, MalValue name, MalValue raw_name, u32 index,
    MalValue value, bool inline_value) {
    bool has_value = !mal_value_is_undefined(value);
    i32 validation_index = util_parse_find_long(state, name);
    if (state->strict && validation_index < 0 && state->allow_negative
        && util_parse_string_starts_ascii(name, "no-")) {
        MalString *string = mal_value_to_string(name);
        state->roots[UTIL_PARSE_TEMP_2] = util_parse_slice(state->vm, name, 3,
            mal_string_length(string) - 3);
        i32 negative_index = util_parse_find_long(
            state, state->roots[UTIL_PARSE_TEMP_2]);
        if (negative_index >= 0
            && state->options[negative_index].type == UTIL_PARSE_BOOLEAN) {
            validation_index = negative_index;
        }
    }
    if (state->strict && validation_index < 0) {
        return util_parse_throw_code(
            state->vm, "Unknown option", "ERR_PARSE_ARGS_UNKNOWN_OPTION");
    }
    if (state->strict && validation_index >= 0) {
        MalUtilParseOption *option = &state->options[validation_index];
        if (option->type == UTIL_PARSE_STRING
            && (!has_value || !mal_value_is_string(value))) {
            return util_parse_throw_code(state->vm,
                "String option argument is missing",
                "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
        }
        if (option->type == UTIL_PARSE_BOOLEAN && has_value) {
            return util_parse_throw_code(state->vm,
                "Boolean option does not take an argument",
                "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
        }
        if (option->type == UTIL_PARSE_STRING && !inline_value
            && mal_value_is_string(value)) {
            MalString *string = mal_value_to_string(value);
            const c16 *units = mal_string_code_units(string);
            if (mal_string_length(string) > 1 && units[0] == '-') {
                return util_parse_throw_code(state->vm,
                    "Option argument is ambiguous",
                    "ERR_PARSE_ARGS_INVALID_OPTION_VALUE");
            }
        }
    }

    MalValue stored_name = name;
    MalValue stored_value = has_value ? value : mal_value_new_boolean(true);
    if (state->allow_negative && !has_value
        && util_parse_string_starts_ascii(name, "no-")) {
        MalString *string = mal_value_to_string(name);
        state->roots[UTIL_PARSE_TEMP_2] = util_parse_slice(state->vm, name, 3,
            mal_string_length(string) - 3);
        stored_name = state->roots[UTIL_PARSE_TEMP_2];
        stored_value = mal_value_new_boolean(false);
    }
    i32 stored_index = util_parse_find_long(state, stored_name);
    if (!util_parse_append_option_token(state, stored_name, raw_name,
            index, value, inline_value)) {
        return false;
    }
    return util_parse_store_option(
        state, stored_name, stored_value, stored_index);
}

static bool util_parse_validate_options(
    MalUtilParseState *state, MalRootSpan *option_root,
    bool *option_rooted) {
    MalVm *vm = state->vm;
    if (!mal_vm_own_property_keys(
            vm, state->roots[UTIL_PARSE_OPTIONS],
            &state->roots[UTIL_PARSE_KEYS])) {
        return false;
    }
    u32 key_count = mal_array_object_length(
        mal_value_to_array_object(state->roots[UTIL_PARSE_KEYS]));
    if (key_count > INT32_MAX / 2) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    if (key_count == 0) return true;
    state->options = calloc(key_count, sizeof(MalUtilParseOption));
    state->option_roots = malloc(
        sizeof(MalValue) * (usize) key_count * 2);
    if (state->options == nullptr || state->option_roots == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    for (usize i = 0; i < (usize) key_count * 2; i++) {
        state->option_roots[i] = mal_value_new_undefined();
    }
    mal_gc_root(option_root, state->option_roots, (i32) key_count * 2);
    *option_rooted = true;

    for (u32 key_index = 0; key_index < key_count; key_index++) {
        MalValue key_value;
        if (!mal_array_object_dense_get(
                mal_value_to_array_object(state->roots[UTIL_PARSE_KEYS]),
                key_index, &key_value)) {
            continue;
        }
        if (!mal_value_is_string(key_value)) continue;
        MalKey key = mal_key_from_value(key_value);
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, state->roots[UTIL_PARSE_OPTIONS],
                key, &present, &desc)) {
            return false;
        }
        if (!present || (desc.flags & MAL_PROPERTY_ENUMERABLE) == 0) continue;
        if (!mal_vm_get_property(vm, state->roots[UTIL_PARSE_OPTIONS], key,
                &state->roots[UTIL_PARSE_CURRENT])) {
            return false;
        }
        bool is_record;
        if (!util_parse_is_record(
                vm, state->roots[UTIL_PARSE_CURRENT], &is_record)) {
            return false;
        }
        if (!is_record) {
            return util_parse_throw_code(vm,
                "Option configuration must be an object",
                "ERR_INVALID_ARG_TYPE");
        }

        MalUtilParseOption *option = &state->options[state->option_count];
        option->roots_index = state->option_count * 2;
        state->option_roots[option->roots_index] = key_value;
        bool type_present;
        if (!util_parse_get_own_ascii(vm, state->roots[UTIL_PARSE_CURRENT],
                "type", &type_present, &state->roots[UTIL_PARSE_TEMP])) {
            return false;
        }
        if (!type_present) {
            return util_parse_throw_code(vm,
                "Option type must be 'string' or 'boolean'",
                "ERR_INVALID_ARG_TYPE");
        }
        if (util_parse_string_equals_ascii(
                state->roots[UTIL_PARSE_TEMP], "string")) {
            option->type = UTIL_PARSE_STRING;
        } else if (util_parse_string_equals_ascii(
                       state->roots[UTIL_PARSE_TEMP], "boolean")) {
            option->type = UTIL_PARSE_BOOLEAN;
        } else {
            return util_parse_throw_code(vm,
                "Option type must be 'string' or 'boolean'",
                "ERR_INVALID_ARG_TYPE");
        }

        bool property_present;
        if (!util_parse_get_own_ascii(vm, state->roots[UTIL_PARSE_CURRENT],
                "short", &property_present, &state->roots[UTIL_PARSE_TEMP])) {
            return false;
        }
        if (property_present) {
            if (!mal_value_is_string(state->roots[UTIL_PARSE_TEMP])
                || mal_string_length(mal_value_to_string(
                       state->roots[UTIL_PARSE_TEMP])) != 1) {
                return util_parse_throw_code(vm,
                    "Option short name must be a single character",
                    "ERR_INVALID_ARG_VALUE");
            }
            option->has_short = true;
            option->short_name = mal_string_code_units(mal_value_to_string(
                state->roots[UTIL_PARSE_TEMP]))[0];
        }

        if (!util_parse_get_own_ascii(vm, state->roots[UTIL_PARSE_CURRENT],
                "multiple", &property_present, &state->roots[UTIL_PARSE_TEMP])) {
            return false;
        }
        if (property_present) {
            if (!mal_value_is_boolean(state->roots[UTIL_PARSE_TEMP])) {
                return util_parse_throw_code(vm,
                    "Option multiple flag must be a boolean",
                    "ERR_INVALID_ARG_TYPE");
            }
            option->multiple = mal_value_to_boolean(
                state->roots[UTIL_PARSE_TEMP]);
        }

        if (!util_parse_get_own_ascii(vm, state->roots[UTIL_PARSE_CURRENT],
                "default", &property_present, &state->roots[UTIL_PARSE_TEMP])) {
            return false;
        }
        if (property_present
            && !mal_value_is_undefined(state->roots[UTIL_PARSE_TEMP])) {
            bool valid;
            if (option->multiple) {
                valid = util_parse_validate_default_array(vm,
                    state->roots[UTIL_PARSE_TEMP], option->type,
                    &state->roots[UTIL_PARSE_TEMP_2]);
            } else {
                valid = option->type == UTIL_PARSE_STRING
                    ? mal_value_is_string(state->roots[UTIL_PARSE_TEMP])
                    : mal_value_is_boolean(state->roots[UTIL_PARSE_TEMP]);
                if (!valid) {
                    util_parse_throw_code(vm,
                        "Option default has the wrong type",
                        "ERR_INVALID_ARG_TYPE");
                }
            }
            if (!valid) return false;
            option->has_default = true;
            state->option_roots[option->roots_index + 1] =
                state->roots[UTIL_PARSE_TEMP];
        }
        state->option_count++;
    }
    return true;
}

static bool util_parse_read_arg(
    MalUtilParseState *state, u32 index, MalValue *out) {
    return mal_vm_get_property(
        state->vm, state->roots[UTIL_PARSE_ARGS], mal_key_index(index), out);
}

static bool util_parse_tokens(MalUtilParseState *state, u32 arg_count) {
    for (u32 index = 0; index < arg_count; index++) {
        if (!util_parse_read_arg(
                state, index, &state->roots[UTIL_PARSE_CURRENT])) {
            return false;
        }
        MalValue arg = state->roots[UTIL_PARSE_CURRENT];
        if (!mal_value_is_string(arg)) {
            if (mal_value_is_nil(arg)) {
                return util_parse_throw(
                    state->vm, "Argument array contains null or undefined");
            }
            if (!util_parse_append_positional_token(state, arg, index)) {
                return false;
            }
            continue;
        }
        MalString *string = mal_value_to_string(arg);
        const c16 *units = mal_string_code_units(string);
        usize length = mal_string_length(string);

        if (length == 2 && units[0] == '-' && units[1] == '-') {
            if (!util_parse_append_terminator_token(state, index)) return false;
            for (u32 positional = index + 1; positional < arg_count;
                 positional++) {
                if (!util_parse_read_arg(state, positional,
                        &state->roots[UTIL_PARSE_CURRENT])
                    || !util_parse_append_positional_token(state,
                        state->roots[UTIL_PARSE_CURRENT], positional)) {
                    return false;
                }
            }
            return true;
        }

        if (length == 2 && units[0] == '-' && units[1] != '-') {
            i32 option_index = util_parse_find_short(state, units[1]);
            state->roots[UTIL_PARSE_NAME] = option_index >= 0
                ? util_parse_option_name(state, option_index)
                : util_parse_short_string(state->vm, units[1]);
            state->roots[UTIL_PARSE_RAW_NAME] = arg;
            state->roots[UTIL_PARSE_VALUE] = mal_value_new_undefined();
            bool inline_value = false;
            if (option_index >= 0
                && state->options[option_index].type == UTIL_PARSE_STRING
                && index + 1 < arg_count) {
                if (!util_parse_read_arg(
                        state, index + 1, &state->roots[UTIL_PARSE_NEXT])) {
                    return false;
                }
                if (!mal_value_is_nil(state->roots[UTIL_PARSE_NEXT])) {
                    state->roots[UTIL_PARSE_VALUE] =
                        state->roots[UTIL_PARSE_NEXT];
                    index++;
                }
            }
            if (!util_parse_process_option(state,
                    state->roots[UTIL_PARSE_NAME],
                    state->roots[UTIL_PARSE_RAW_NAME], index -
                        (!mal_value_is_undefined(state->roots[UTIL_PARSE_VALUE]) ? 1 : 0),
                    state->roots[UTIL_PARSE_VALUE], inline_value)) {
                return false;
            }
            continue;
        }

        if (length > 2 && units[0] == '-' && units[1] != '-') {
            i32 first_option = util_parse_find_short(state, units[1]);
            bool first_is_string = first_option >= 0
                && state->options[first_option].type == UTIL_PARSE_STRING;
            if (first_is_string) {
                state->roots[UTIL_PARSE_NAME] =
                    util_parse_option_name(state, first_option);
                state->roots[UTIL_PARSE_RAW_NAME] =
                    util_parse_raw_short(state->vm, units[1]);
                state->roots[UTIL_PARSE_VALUE] =
                    util_parse_slice(state->vm, arg, 2, length - 2);
                if (!util_parse_process_option(state,
                        state->roots[UTIL_PARSE_NAME],
                        state->roots[UTIL_PARSE_RAW_NAME], index,
                        state->roots[UTIL_PARSE_VALUE], true)) {
                    return false;
                }
                continue;
            }

            u32 group_index = index;
            for (usize group = 1; group < length; group++) {
                i32 option_index = util_parse_find_short(state, units[group]);
                state->roots[UTIL_PARSE_NAME] = option_index >= 0
                    ? util_parse_option_name(state, option_index)
                    : util_parse_short_string(state->vm, units[group]);
                state->roots[UTIL_PARSE_RAW_NAME] =
                    util_parse_raw_short(state->vm, units[group]);
                state->roots[UTIL_PARSE_VALUE] = mal_value_new_undefined();
                bool inline_value = false;
                if (option_index >= 0
                    && state->options[option_index].type == UTIL_PARSE_STRING) {
                    if (group + 1 < length) {
                        state->roots[UTIL_PARSE_VALUE] = util_parse_slice(
                            state->vm, arg, group + 1, length - group - 1);
                        inline_value = true;
                    } else if (index + 1 < arg_count) {
                        if (!util_parse_read_arg(state, index + 1,
                                &state->roots[UTIL_PARSE_NEXT])) {
                            return false;
                        }
                        if (!mal_value_is_nil(state->roots[UTIL_PARSE_NEXT])) {
                            state->roots[UTIL_PARSE_VALUE] =
                                state->roots[UTIL_PARSE_NEXT];
                            index++;
                        }
                    }
                }
                if (!util_parse_process_option(state,
                        state->roots[UTIL_PARSE_NAME],
                        state->roots[UTIL_PARSE_RAW_NAME], group_index,
                        state->roots[UTIL_PARSE_VALUE], inline_value)) {
                    return false;
                }
                if (!mal_value_is_undefined(state->roots[UTIL_PARSE_VALUE])) {
                    break;
                }
            }
            continue;
        }

        if (length > 2 && units[0] == '-' && units[1] == '-') {
            usize equals = length;
            for (usize i = 3; i < length; i++) {
                if (units[i] == '=') {
                    equals = i;
                    break;
                }
            }
            if (equals < length) {
                state->roots[UTIL_PARSE_NAME] =
                    util_parse_slice(state->vm, arg, 2, equals - 2);
                state->roots[UTIL_PARSE_RAW_NAME] =
                    util_parse_slice(state->vm, arg, 0, equals);
                state->roots[UTIL_PARSE_VALUE] = util_parse_slice(
                    state->vm, arg, equals + 1, length - equals - 1);
                if (!util_parse_process_option(state,
                        state->roots[UTIL_PARSE_NAME],
                        state->roots[UTIL_PARSE_RAW_NAME], index,
                        state->roots[UTIL_PARSE_VALUE], true)) {
                    return false;
                }
                continue;
            }

            state->roots[UTIL_PARSE_NAME] =
                util_parse_slice(state->vm, arg, 2, length - 2);
            state->roots[UTIL_PARSE_RAW_NAME] = arg;
            state->roots[UTIL_PARSE_VALUE] = mal_value_new_undefined();
            i32 option_index = util_parse_find_long(
                state, state->roots[UTIL_PARSE_NAME]);
            u32 option_arg_index = index;
            if (option_index >= 0
                && state->options[option_index].type == UTIL_PARSE_STRING
                && index + 1 < arg_count) {
                if (!util_parse_read_arg(
                        state, index + 1, &state->roots[UTIL_PARSE_NEXT])) {
                    return false;
                }
                if (!mal_value_is_nil(state->roots[UTIL_PARSE_NEXT])) {
                    state->roots[UTIL_PARSE_VALUE] =
                        state->roots[UTIL_PARSE_NEXT];
                    index++;
                }
            }
            if (!util_parse_process_option(state,
                    state->roots[UTIL_PARSE_NAME],
                    state->roots[UTIL_PARSE_RAW_NAME], option_arg_index,
                    state->roots[UTIL_PARSE_VALUE], false)) {
                return false;
            }
            continue;
        }

        if (!util_parse_append_positional_token(state, arg, index)) return false;
    }
    return true;
}

static bool util_parse_apply_defaults(MalUtilParseState *state) {
    MalObject *values = mal_value_to_object(state->roots[UTIL_PARSE_VALUES]);
    for (usize i = 0; i < state->option_count; i++) {
        MalUtilParseOption *option = &state->options[i];
        if (!option->has_default) continue;
        MalValue name = state->option_roots[option->roots_index];
        if (util_parse_string_equals_ascii(name, "__proto__")) continue;
        MalKey key = mal_key_from_value(name);
        MalPropertyLookup current = mal_object_get_own(values, key);
        if (!current.present || mal_value_is_undefined(current.desc.value)) {
            if (!mal_object_set(values, key,
                    state->option_roots[option->roots_index + 1])) {
                return false;
            }
        }
    }
    return true;
}

static MalValue util_parse_args(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[UTIL_PARSE_ROOT_COUNT];
    for (usize i = 0; i < countof(roots); i++) {
        roots[i] = mal_value_new_undefined();
    }
    roots[UTIL_PARSE_CONFIG] =
        argc > 0 ? args[0] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalUtilParseState state = {.vm = vm, .roots = roots};
    MalRootSpan option_root;
    bool option_rooted = false;
    bool ok = true;

    if (mal_value_is_null(roots[UTIL_PARSE_CONFIG])) {
        util_parse_throw(vm, "Cannot convert undefined or null to object");
        ok = false;
        goto done;
    }

    bool present;
    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG], "args",
            &present, &roots[UTIL_PARSE_ARGS])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_ARGS])) {
        if (!util_parse_build_main_args(
                vm, &roots[UTIL_PARSE_ARGS], &roots[UTIL_PARSE_TEMP])) {
            ok = false;
            goto done;
        }
    }

    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG], "strict",
            &present, &roots[UTIL_PARSE_TEMP])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_TEMP])) {
        state.strict = true;
    } else if (!mal_value_is_boolean(roots[UTIL_PARSE_TEMP])) {
        util_parse_throw_code(vm, "The strict argument must be a boolean",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    } else {
        state.strict = mal_value_to_boolean(roots[UTIL_PARSE_TEMP]);
    }

    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG],
            "allowPositionals", &present, &roots[UTIL_PARSE_TEMP])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_TEMP])) {
        state.allow_positionals = !state.strict;
    } else if (!mal_value_is_boolean(roots[UTIL_PARSE_TEMP])) {
        util_parse_throw_code(vm,
            "The allowPositionals argument must be a boolean",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    } else {
        state.allow_positionals =
            mal_value_to_boolean(roots[UTIL_PARSE_TEMP]);
    }

    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG], "tokens",
            &present, &roots[UTIL_PARSE_TEMP])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_TEMP])) {
        state.return_tokens = false;
    } else if (!mal_value_is_boolean(roots[UTIL_PARSE_TEMP])) {
        util_parse_throw_code(vm, "The tokens argument must be a boolean",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    } else {
        state.return_tokens = mal_value_to_boolean(roots[UTIL_PARSE_TEMP]);
    }

    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG],
            "allowNegative", &present, &roots[UTIL_PARSE_TEMP])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_TEMP])) {
        state.allow_negative = false;
    } else if (!mal_value_is_boolean(roots[UTIL_PARSE_TEMP])) {
        util_parse_throw_code(vm,
            "The allowNegative argument must be a boolean",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    } else {
        state.allow_negative = mal_value_to_boolean(roots[UTIL_PARSE_TEMP]);
    }

    if (!util_parse_get_own_ascii(vm, roots[UTIL_PARSE_CONFIG], "options",
            &present, &roots[UTIL_PARSE_OPTIONS])) {
        ok = false;
        goto done;
    }
    if (!present || mal_value_is_nil(roots[UTIL_PARSE_OPTIONS])) {
        roots[UTIL_PARSE_OPTIONS] =
            mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    }

    bool is_args_array;
    if (!mal_vm_is_array(vm, roots[UTIL_PARSE_ARGS], &is_args_array)) {
        ok = false;
        goto done;
    }
    if (!is_args_array) {
        util_parse_throw_code(vm, "The args argument must be an Array",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    }
    bool options_record;
    if (!util_parse_is_record(
            vm, roots[UTIL_PARSE_OPTIONS], &options_record)) {
        ok = false;
        goto done;
    }
    if (!options_record) {
        util_parse_throw_code(vm, "The options argument must be an object",
            "ERR_INVALID_ARG_TYPE");
        ok = false;
        goto done;
    }
    if (!util_parse_validate_options(&state, &option_root, &option_rooted)) {
        ok = false;
        goto done;
    }

    roots[UTIL_PARSE_VALUES] =
        mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    roots[UTIL_PARSE_POSITIONALS] =
        mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    roots[UTIL_PARSE_TOKENS] =
        mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    roots[UTIL_PARSE_RESULT] =
        mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *result = mal_value_to_object(roots[UTIL_PARSE_RESULT]);
    mal_intrinsic_define_data(vm, result, (const byte *) "values",
        roots[UTIL_PARSE_VALUES], UTIL_VISIBLE);
    mal_intrinsic_define_data(vm, result, (const byte *) "positionals",
        roots[UTIL_PARSE_POSITIONALS], UTIL_VISIBLE);
    if (state.return_tokens) {
        mal_intrinsic_define_data(vm, result, (const byte *) "tokens",
            roots[UTIL_PARSE_TOKENS], UTIL_VISIBLE);
    }

    u32 arg_count;
    if (!util_parse_array_length(
            vm, roots[UTIL_PARSE_ARGS], &arg_count,
            &roots[UTIL_PARSE_TEMP])
        || !util_parse_tokens(&state, arg_count)
        || !util_parse_apply_defaults(&state)) {
        ok = false;
    }

done:
    if (option_rooted) mal_gc_unroot(&option_root);
    free(state.option_roots);
    free(state.options);
    MalValue value = ok
        ? roots[UTIL_PARSE_RESULT]
        : mal_value_new_undefined();
    mal_gc_unroot(&root);
    return value;
}

typedef struct MalNodeUtilExport {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodeUtilExport;

static const MalNodeUtilExport util_exports[] = {
    {"deprecate", 3, util_deprecate},
    {"debuglog", 2, util_debuglog},
    {"format", 1, util_format},
    {"formatWithOptions", 2, util_format_with_options},
    {"inherits", 2, util_inherits},
    {"inspect", 2, util_inspect},
    {"isArray", 1, util_is_array},
    {"isBoolean", 1, util_is_boolean},
    {"isBuffer", 1, util_is_buffer},
    {"isFunction", 1, util_is_function},
    {"isNull", 1, util_is_null},
    {"isNullOrUndefined", 1, util_is_null_or_undefined},
    {"isNumber", 1, util_is_number},
    {"isObject", 1, util_is_object},
    {"isString", 1, util_is_string},
    {"isSymbol", 1, util_is_symbol},
    {"isUndefined", 1, util_is_undefined},
    {"parseArgs", 0, util_parse_args},
    {"parseEnv", 1, util_parse_env},
    {"promisify", 1, util_promisify},
};

void mal_host_install_node_util(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    const usize types_index = countof(util_exports);
    const usize namespace_index = types_index + 1;
    MalValue values[countof(util_exports) + 2];
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
	values[types_index] = mal_value_from_object(mal_intrinsic_new_object(vm));
	values[namespace_index] = mal_value_from_native_function_object(
		mal_native_function_object_new_arity(&vm->heap, function_prototype,
			mal_intrinsic_ascii(vm, (const byte *) "isPromise"), 1,
			util_types_is_promise));
	mal_intrinsic_define_data(vm, mal_value_to_object(values[types_index]),
		(const byte *) "isPromise", values[namespace_index], UTIL_VISIBLE);
	for (usize i = 0; i < countof(util_type_exports); i++) {
		const MalNodeUtilTypeExport *export = &util_type_exports[i];
		values[namespace_index] = mal_value_from_native_function_object(
			mal_native_function_object_new_arity(&vm->heap, function_prototype,
				mal_intrinsic_ascii(vm, (const byte *) export->name), 1,
				export->callback));
		mal_intrinsic_define_data(vm, mal_value_to_object(values[types_index]),
			(const byte *) export->name, values[namespace_index], UTIL_VISIBLE);
	}
	values[namespace_index] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *namespace = mal_value_to_object(values[namespace_index]);
    for (usize i = 0; i < countof(util_exports); i++) {
        mal_intrinsic_define_data(vm, namespace,
            (const byte *) util_exports[i].name, values[i], UTIL_VISIBLE);
    }
	mal_intrinsic_define_data(vm, namespace,
		(const byte *) "types", values[types_index], UTIL_VISIBLE);

    for (i32 slot = 0; slot < count; slot++) {
        MalValue value = mal_value_new_undefined();
        for (usize i = 0; i < countof(util_exports); i++) {
            if (strcmp(slots[slot].name, util_exports[i].name) == 0) {
                value = values[i];
                break;
            }
        }
        if (strcmp(slots[slot].name, "default") == 0) {
			value = values[namespace_index];
		} else if (strcmp(slots[slot].name, "types") == 0) {
			value = values[types_index];
        }
        if (!mal_value_is_undefined(value)) {
            vm->globals[slots[slot].slot] = value;
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
