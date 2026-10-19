// Portions derived from Node.js lib/util.js (MIT); see THIRD_PARTY_NOTICES.md.
#include <math.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "node_util.h"
#include "node_inspect.h"
#include "node_deep_equal.h"
#include "node_dotenv.h"
#include "posix_fs.h"

#if MAL_NODE

#include "array_object.h"
#include "ascii.h"
#include "array_buffer_object.h"
#include "builtin_string.h"
#include "builtin_error.h"
#include "builtin_bigint.h"
#include "date_object.h"
#include "heap_symbol.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "node_util_mime.h"
#include "iterator_object.h"
#include "map_object.h"
#include "set_object.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "promise_object.h"
#include "builtin_promise.h"
#include "web_events_object.h"
#include "primitive_wrapper_object.h"
#include "proxy_object.h"
#include "typed_array_object.h"
#include "text_buffer.h"
#include "utf8.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define UTIL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

typedef MalTextBuffer MalUtilBuilder;

static bool util_builder_ascii(MalUtilBuilder *builder, const char *ascii) {
    return mal_text_buffer_append_ascii(
        builder, (const byte *) ascii) == MAL_TEXT_BUFFER_OK;
}

static bool util_builder_code_unit(MalUtilBuilder *builder, c16 unit) {
    return mal_text_buffer_push(builder, unit) == MAL_TEXT_BUFFER_OK;
}

static MalValue util_builder_finish(MalVm *vm, MalUtilBuilder *builder) {
    if (builder->status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(builder);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Formatted output exceeds the string length limit");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, builder));
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
    MalValue original = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(original)) {
        mal_node_throw_invalid_arg_type(vm, "original", "of type function", original);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {original, mal_node_registered_symbol(vm, "nodejs.util.promisify.custom"),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalKey custom_key = mal_key_from_value(roots[1]);
    // An API such as child_process.exec names its own promise form under util.promisify.custom.
    if (!mal_vm_get_property(vm, roots[0], custom_key, &roots[2])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (mal_value_is_truthy(roots[2])) {
        if (!mal_value_is_callable(roots[2])) {
            mal_node_throw_invalid_arg_type(vm, "util.promisify.custom", "of type function", roots[2]);
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
    } else {
        roots[2] = mal_value_from_native_function_object(
            mal_native_function_object_new_with_slots(
                &vm->heap,
                mal_value_to_object(
                    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) "promisified"),
                util_promisified_call, &roots[0], 1));
    }
    MalPropertyDesc self = mal_intrinsic_data_desc(roots[2], MAL_PROPERTY_CONFIGURABLE);
    if (mal_value_is_object(roots[2])) mal_object_define_own(mal_value_to_object(roots[2]), custom_key, &self);
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
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
    MalVm *vm, const MalValue *args, i32 argc, MalValue new_target,
    MalUtilTypePredicate predicate) {
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
            return mal_value_new_undefined();
        }
        return mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    return mal_value_new_boolean(argc > 0 && predicate(args[0]));
}

#define UTIL_TYPE_PREDICATE(name, expression) \
    static bool util_type_check_##name(MalValue value) { return (expression); } \
    static MalValue util_types_##name( \
        MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        (void) receiver; (void) callee; \
        return util_type_predicate_result(vm, args, argc, new_target, util_type_check_##name); \
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
    mal_value_is_map_object(value))
UTIL_TYPE_PREDICATE(is_set,
    mal_value_is_set_object(value))
UTIL_TYPE_PREDICATE(is_weak_map,
    mal_value_is_weak_map_object(value))
UTIL_TYPE_PREDICATE(is_weak_set,
    mal_value_is_weak_set_object(value))
UTIL_TYPE_PREDICATE(is_reg_exp, mal_value_is_regexp_object(value))
UTIL_TYPE_PREDICATE(is_typed_array, mal_value_is_typed_array_object(value))
UTIL_TYPE_PREDICATE(is_boxed_primitive, mal_value_is_primitive_wrapper(value))
UTIL_TYPE_PREDICATE(is_arguments_object, mal_value_is_object(value)
    && mal_value_to_object(value)->is_arguments)
UTIL_TYPE_PREDICATE(is_big_int_object, mal_value_is_primitive_wrapper(value)
    && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_BIGINT)
UTIL_TYPE_PREDICATE(is_boolean_object, mal_value_is_primitive_wrapper(value)
    && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_BOOLEAN)
UTIL_TYPE_PREDICATE(is_number_object, mal_value_is_primitive_wrapper(value)
    && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_NUMBER)
UTIL_TYPE_PREDICATE(is_string_object, mal_value_is_primitive_wrapper(value)
    && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_STRING)
UTIL_TYPE_PREDICATE(is_symbol_object, mal_value_is_primitive_wrapper(value)
    && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_SYMBOL)
UTIL_TYPE_PREDICATE(is_generator_object, mal_value_is_generator_object(value))
UTIL_TYPE_PREDICATE(is_module_namespace_object,
    mal_value_is_module_namespace_object(value))
UTIL_TYPE_PREDICATE(is_proxy, mal_value_is_proxy_object(value))
UTIL_TYPE_PREDICATE(is_external, false)
UTIL_TYPE_PREDICATE(is_key_object, mal_node_key_object_brand != nullptr && mal_node_key_object_brand(value))
UTIL_TYPE_PREDICATE(is_crypto_key, mal_node_crypto_key_brand != nullptr && mal_node_crypto_key_brand(value))
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
UTIL_TYPE_PREDICATE(is_float16_array, false)

typedef struct MalNodeUtilTypeExport {
    const char *name;
    MalNativeFunctionCallback callback;
    bool javascript_wrapper;
} MalNodeUtilTypeExport;

static MalValue util_types_function_kind(
    MalVm *vm, const MalValue *args, i32 argc, bool async) {
    bool matches = false;
    if (async && argc > 0 && mal_value_is_native_function_object(args[0])) {
        matches = mal_native_function_object_is_async(
            mal_value_to_native_function_object(args[0]));
    } else if (argc > 0 && mal_value_is_function_object(args[0])) {
        i32 index = mal_function_object_function_index(mal_value_to_function_object(args[0]));
        if (index >= 0 && index < vm->runtime_image->function_count) {
            MalFunctionKind kind = vm->runtime_image->functions[index].kind;
            matches = kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR
                || kind == (async ? MAL_FUNCTION_KIND_ASYNC : MAL_FUNCTION_KIND_GENERATOR);
        }
    }
    return mal_value_new_boolean(matches);
}

static MalValue util_types_is_async_function(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return util_types_function_kind(vm, args, argc, true);
}

static MalValue util_types_is_generator_function(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return util_types_function_kind(vm, args, argc, false);
}

static MalValue util_types_is_native_error(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    return mal_value_new_boolean(argc > 0 && mal_builtin_value_has_error_data(vm, args[0]));
}

static const MalNodeUtilTypeExport util_type_exports[] = {
    {"isArgumentsObject", util_types_is_arguments_object},
    {"isNativeError", util_types_is_native_error},
    {"isAnyArrayBuffer", util_types_is_any_array_buffer},
    {"isArrayBuffer", util_types_is_array_buffer},
    {"isSharedArrayBuffer", util_types_is_shared_array_buffer},
    {"isDataView", util_types_is_data_view, true},
    {"isDate", util_types_is_date},
    {"isMap", util_types_is_map},
    {"isSet", util_types_is_set},
    {"isWeakMap", util_types_is_weak_map},
    {"isWeakSet", util_types_is_weak_set},
    {"isRegExp", util_types_is_reg_exp},
    {"isTypedArray", util_types_is_typed_array, true},
    {"isBoxedPrimitive", util_types_is_boxed_primitive},
    {"isAsyncFunction", util_types_is_async_function},
    {"isGeneratorFunction", util_types_is_generator_function},
    {"isBigIntObject", util_types_is_big_int_object},
    {"isBooleanObject", util_types_is_boolean_object},
    {"isNumberObject", util_types_is_number_object},
    {"isStringObject", util_types_is_string_object},
    {"isSymbolObject", util_types_is_symbol_object},
    {"isGeneratorObject", util_types_is_generator_object},
    {"isModuleNamespaceObject", util_types_is_module_namespace_object},
    {"isProxy", util_types_is_proxy},
    {"isExternal", util_types_is_external},
    {"isKeyObject", util_types_is_key_object, true},
    {"isCryptoKey", util_types_is_crypto_key, true},
    {"isMapIterator", util_types_is_map_iterator},
    {"isSetIterator", util_types_is_set_iterator},
    {"isInt8Array", util_types_is_int8_array, true},
    {"isUint8Array", util_types_is_uint8_array, true},
    {"isUint8ClampedArray", util_types_is_uint8_clamped_array, true},
    {"isInt16Array", util_types_is_int16_array, true},
    {"isUint16Array", util_types_is_uint16_array, true},
    {"isInt32Array", util_types_is_int32_array, true},
    {"isUint32Array", util_types_is_uint32_array, true},
    {"isFloat32Array", util_types_is_float32_array, true},
    {"isFloat64Array", util_types_is_float64_array, true},
    {"isBigInt64Array", util_types_is_big_int64_array, true},
    {"isBigUint64Array", util_types_is_big_uint64_array, true},
    {"isFloat16Array", util_types_is_float16_array, true},
};

static MalValue util_to_usv_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_vm_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    return mal_builtin_string_to_well_formed_known(vm, string);
}

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
    MalValue roots[] = {args[0], mal_value_from_object(mal_intrinsic_new_object(vm))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = mal_node_dotenv_parse(vm, mal_value_to_string(roots[0]), roots[1], false);
    MalValue result = ok ? roots[1] : mal_value_new_undefined();
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

typedef struct MalUtilStyle {
    const char *name;
    const char *open;
    const char *close;
} MalUtilStyle;

static const MalUtilStyle util_styles[] = {
    {"reset", "\x1b[0m", "\x1b[0m"}, {"bold", "\x1b[1m", "\x1b[22m"},
    {"dim", "\x1b[2m", "\x1b[22m"}, {"italic", "\x1b[3m", "\x1b[23m"},
    {"underline", "\x1b[4m", "\x1b[24m"}, {"inverse", "\x1b[7m", "\x1b[27m"},
    {"hidden", "\x1b[8m", "\x1b[28m"}, {"strikethrough", "\x1b[9m", "\x1b[29m"},
    {"black", "\x1b[30m", "\x1b[39m"}, {"red", "\x1b[31m", "\x1b[39m"},
    {"green", "\x1b[32m", "\x1b[39m"}, {"yellow", "\x1b[33m", "\x1b[39m"},
    {"blue", "\x1b[34m", "\x1b[39m"}, {"magenta", "\x1b[35m", "\x1b[39m"},
    {"cyan", "\x1b[36m", "\x1b[39m"}, {"white", "\x1b[37m", "\x1b[39m"},
    {"gray", "\x1b[90m", "\x1b[39m"}, {"grey", "\x1b[90m", "\x1b[39m"},
    {"blackBright", "\x1b[90m", "\x1b[39m"}, {"redBright", "\x1b[91m", "\x1b[39m"},
    {"greenBright", "\x1b[92m", "\x1b[39m"}, {"yellowBright", "\x1b[93m", "\x1b[39m"},
    {"blueBright", "\x1b[94m", "\x1b[39m"}, {"magentaBright", "\x1b[95m", "\x1b[39m"},
    {"cyanBright", "\x1b[96m", "\x1b[39m"}, {"whiteBright", "\x1b[97m", "\x1b[39m"},
    {"bgBlack", "\x1b[40m", "\x1b[49m"}, {"bgRed", "\x1b[41m", "\x1b[49m"},
    {"bgGreen", "\x1b[42m", "\x1b[49m"}, {"bgYellow", "\x1b[43m", "\x1b[49m"},
    {"bgBlue", "\x1b[44m", "\x1b[49m"}, {"bgMagenta", "\x1b[45m", "\x1b[49m"},
    {"bgCyan", "\x1b[46m", "\x1b[49m"}, {"bgWhite", "\x1b[47m", "\x1b[49m"},
    {"bgGray", "\x1b[100m", "\x1b[49m"}, {"bgGrey", "\x1b[100m", "\x1b[49m"},
    {"bgRedBright", "\x1b[101m", "\x1b[49m"}, {"bgGreenBright", "\x1b[102m", "\x1b[49m"},
    {"bgYellowBright", "\x1b[103m", "\x1b[49m"}, {"bgBlueBright", "\x1b[104m", "\x1b[49m"},
    {"bgMagentaBright", "\x1b[105m", "\x1b[49m"}, {"bgCyanBright", "\x1b[106m", "\x1b[49m"},
    {"bgWhiteBright", "\x1b[107m", "\x1b[49m"}, {"overline", "\x1b[53m", "\x1b[55m"},
    {"doubleunderline", "\x1b[21m", "\x1b[24m"},
};

static bool util_style_ascii_at(MalString *text, usize offset, const char *ascii) {
    usize length = strlen(ascii);
    if (offset + length > text->length) return false;
    for (usize i = 0; i < length; i++) {
        if (mal_string_code_unit_at(text, offset + i) != (u8) ascii[i]) return false;
    }
    return true;
}

static MalValue util_style_env(MalVm *vm, const char *name) {
    MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
    MalValue env, value;
    if (mal_value_is_object(process)
        && mal_vm_get_property(vm, process, mal_intrinsic_string_key(vm, (const byte *) "env"), &env)
        && mal_vm_get_property(vm, env, mal_intrinsic_string_key(vm, (const byte *) name), &value)) {
        return value;
    }
    const char *native = getenv(name);
    return native == nullptr ? mal_value_new_undefined()
        : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) native));
}

static MalValue util_style_text(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    if (argc < 2 || !mal_value_is_string(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "text must be a string");
        return mal_value_new_undefined();
    }
    bool array = mal_value_is_array_object(args[0]);
    u32 length = array ? mal_array_object_length(mal_value_to_array_object(args[0])) : 1;
    const MalUtilStyle **styles = length > 0 ? malloc((usize) length * sizeof(*styles)) : nullptr;
    if (length > 0 && styles == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    MalValue result = mal_value_new_undefined();
    for (u32 i = 0; i < length; i++) {
        MalValue format = args[0];
        if (array && !mal_vm_get_property(vm, args[0], mal_key_index(i), &format)) goto done;
        styles[i] = nullptr;
        if (mal_value_is_string(format)) {
            for (usize j = 0; j < countof(util_styles); j++) {
                if (mal_string_equals_ascii(mal_value_to_string(format), (const byte *) util_styles[j].name)) {
                    styles[i] = &util_styles[j]; break;
                }
            }
        }
        if (styles[i] == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unknown text style");
            goto done;
        }
    }
    bool color = false;
    bool validate = true;
    MalValue options = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue stream, value;
    if (mal_value_is_object(options)) {
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "validateStream"), &value)) goto done;
        validate = !mal_value_is_boolean(value) || mal_value_to_boolean(value);
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "stream"), &stream)) goto done;
    } else stream = mal_value_new_undefined();
    if (mal_value_is_undefined(stream)) {
        MalValue process = vm->intrinsics[MAL_INTRINSIC_NODE_PROCESS_MODULE];
        if (mal_value_is_object(process) && !mal_vm_get_property(vm, process,
                mal_intrinsic_string_key(vm, (const byte *) "stdout"), &stream)) goto done;
    }
    if (!validate) color = true;
    else {
        if (mal_value_is_object(stream)) {
            if (!mal_vm_get_property(vm, stream, mal_intrinsic_string_key(vm, (const byte *) "isTTY"), &value)) goto done;
            color = mal_value_is_truthy(value);
        }
        value = util_style_env(vm, "NO_COLOR");
        if (!mal_value_is_undefined(value)) color = false;
        value = util_style_env(vm, "NODE_DISABLE_COLORS");
        if (!mal_value_is_undefined(value)) color = false;
        value = util_style_env(vm, "FORCE_COLOR");
        if (!mal_value_is_undefined(value)) {
            color = !(mal_value_is_string(value)
                && mal_string_equals_ascii(mal_value_to_string(value), (const byte *) "0"));
        }
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    }
    if (!color || length == 0) { result = args[1]; goto done; }
    MalUtilBuilder builder = {0};
    for (u32 i = 0; i < length; i++) util_builder_ascii(&builder, styles[i]->open);
    MalString *text = mal_value_to_string(args[1]);
    for (usize at = 0; at < text->length;) {
        bool reopened = false;
        for (u32 i = 0; i < length; i++) {
            if (util_style_ascii_at(text, at, styles[i]->close)) {
                util_builder_ascii(&builder, styles[i]->open);
                at += strlen(styles[i]->close);
                reopened = true;
                break;
            }
        }
        if (!reopened) util_builder_code_unit(&builder, mal_string_code_unit_at(text, at++));
    }
    for (u32 i = length; i > 0; i--) util_builder_ascii(&builder, styles[i - 1]->close);
    result = util_builder_finish(vm, &builder);
 done:
    free(styles);
    return result;
}

static MalValue util_string_value(MalVm *vm, const char *text) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) text));
}

static MalValue util_is_deep_strict_equal(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    bool equal = false;
    if (!mal_node_deep_equal(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
            argc > 1 ? args[1] : mal_value_new_undefined(), MAL_NODE_DEEP_EQUAL_STRICT, &equal)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(equal);
}

static bool util_errno_argument(MalVm *vm, const MalValue *args, i32 argc, int *err) {
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_node_validate_number(vm, value, "err")) return false;
    f64 number = mal_ops_number_as_f64(value);
    if (!(number < 0) || trunc(number) != number) {
        mal_node_throw_out_of_range(vm, "err", "a negative integer", value);
        return false;
    }
    *err = (int) -number;
    return true;
}

static MalValue util_get_system_error_name(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    int err;
    if (!util_errno_argument(vm, args, argc, &err)) return mal_value_new_undefined();
    const char *name = mal_posix_fs_errno_name(err);
    if (strcmp(name, "UNKNOWN") != 0) return util_string_value(vm, name);
    char text[64];
    snprintf(text, sizeof text, "Unknown system error -%d", err);
    return util_string_value(vm, text);
}

static MalValue util_get_system_error_message(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    int err;
    if (!util_errno_argument(vm, args, argc, &err)) return mal_value_new_undefined();
    if (strcmp(mal_posix_fs_errno_name(err), "UNKNOWN") != 0) {
        return util_string_value(vm, mal_posix_errno_description(err));
    }
    char text[64];
    snprintf(text, sizeof text, "Unknown system error -%d", err);
    return util_string_value(vm, text);
}

static MalValue util_get_system_error_map(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    roots[0] = mal_value_from_object((MalObject *) mal_map_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE])));
    for (int err = 1; err < 512; err++) {
        const char *name = mal_posix_fs_errno_name(err);
        if (strcmp(name, "UNKNOWN") == 0) continue;
        roots[1] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        MalArrayObject *pair = mal_value_to_array_object(roots[1]);
        roots[2] = util_string_value(vm, name);
        mal_array_object_store(pair, mal_key_index(0), roots[2]);
        roots[2] = util_string_value(vm, mal_posix_errno_description(err));
        mal_array_object_store(pair, mal_key_index(1), roots[2]);
        mal_map_object_set(mal_value_to_map_object(roots[0]), mal_value_from_i32(-err), roots[1]);
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static const char util_ansi_pattern[] =
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]+)*"
    "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/\\#&.:=?%@~_]*)*)?(?:\\u0007|\\u001B\\u005C|\\u009C))"
    "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";

static MalValue util_strip_vt_control_characters(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(input)) {
        mal_node_throw_invalid_arg_type(vm, "str", "of type string", input);
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(input);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    bool control = false;
    for (usize i = 0; i < length && !control; i++) control = units[i] == 0x1b || units[i] == 0x9b;
    if (!control) return input;
    MalValue roots[4] = {input, util_string_value(vm, util_ansi_pattern), util_string_value(vm, "g"),
        MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    MalCompletion regexp = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR], roots + 1, 2);
    if (regexp.kind != MAL_COMPLETION_THROW) {
        roots[1] = regexp.value;
        roots[2] = util_string_value(vm, "");
        MalValue replace;
        if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "replace"), &replace)) {
            MalCompletion replaced = mal_vm_call_value(vm, replace, roots[0], roots + 1, 2);
            if (replaced.kind != MAL_COMPLETION_THROW) result = replaced.value;
        }
    }
    mal_gc_unroot(&root);
    return result;
}

static const struct {
    const char *name;
    int number;
} util_signals[] = {
    {"SIGHUP", SIGHUP}, {"SIGINT", SIGINT}, {"SIGQUIT", SIGQUIT}, {"SIGILL", SIGILL},
    {"SIGTRAP", SIGTRAP}, {"SIGABRT", SIGABRT}, {"SIGIOT", SIGIOT}, {"SIGBUS", SIGBUS},
    {"SIGFPE", SIGFPE}, {"SIGKILL", SIGKILL}, {"SIGUSR1", SIGUSR1}, {"SIGSEGV", SIGSEGV},
    {"SIGUSR2", SIGUSR2}, {"SIGPIPE", SIGPIPE}, {"SIGALRM", SIGALRM}, {"SIGTERM", SIGTERM},
    {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT}, {"SIGSTOP", SIGSTOP}, {"SIGTSTP", SIGTSTP},
    {"SIGTTIN", SIGTTIN}, {"SIGTTOU", SIGTTOU}, {"SIGURG", SIGURG}, {"SIGXCPU", SIGXCPU},
    {"SIGXFSZ", SIGXFSZ}, {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF}, {"SIGWINCH", SIGWINCH},
    {"SIGIO", SIGIO},
#ifdef SIGINFO
    {"SIGINFO", SIGINFO},
#endif
    {"SIGSYS", SIGSYS},
};

static MalValue util_convert_signal_to_exit_code(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue signal = argc > 0 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_string(signal)) {
        for (usize i = 0; i < countof(util_signals); i++) {
            if (mal_string_equals_ascii(mal_value_to_string(signal), (const byte *) util_signals[i].name)) {
                return mal_value_from_i32(128 + util_signals[i].number);
            }
        }
    }
    MalTextBuffer text = {0};
    mal_text_buffer_append_ascii(&text, (const byte *) "The argument 'signalCode' must be one of: ");
    for (usize i = 0; i < countof(util_signals); i++) {
        if (i > 0) mal_text_buffer_append_ascii(&text, (const byte *) ", ");
        mal_text_buffer_push(&text, '\'');
        mal_text_buffer_append_ascii(&text, (const byte *) util_signals[i].name);
        mal_text_buffer_push(&text, '\'');
    }
    mal_text_buffer_append_ascii(&text, (const byte *) ". Received ");
    MalNodeInspectOptions options = {.options = mal_value_new_undefined()};
    if (!mal_node_util_inspect_into(vm, &text, signal, &options)) {
        mal_text_buffer_dispose(&text);
        return mal_value_new_undefined();
    }
    MalString *message = mal_text_buffer_finish(&vm->heap, &text);
    usize byte_length;
    byte *bytes = mal_string_to_utf8(message, &byte_length);
    if (bytes != nullptr) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const char *) bytes, "ERR_INVALID_ARG_VALUE");
        free(bytes);
    }
    return mal_value_new_undefined();
}

static MalValue util_get_call_sites(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    return mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
}

static bool util_is_abort_signal(MalVm *vm, MalValue value) {
    MalValue aborted;
    return mal_value_is_object(value)
        && mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, (const byte *) "aborted"), &aborted)
        && mal_value_is_boolean(aborted);
}

static MalValue util_transferable_abort_signal(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue signal = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!util_is_abort_signal(vm, signal)) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_throw_invalid_arg_type(vm, "signal", "an instance of AbortSignal", signal);
        }
        return mal_value_new_undefined();
    }
    return signal;
}

static MalValue util_transferable_abort_controller(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    MalCompletion controller = mal_vm_construct_value(
        vm, vm->intrinsics[MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR], nullptr, 0);
    return controller.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : controller.value;
}

static MalValue util_aborted_listener(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target;
    MalValue promise = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalPromiseObject *object = mal_value_to_promise_object(promise);
    if (object->state == MAL_PROMISE_PENDING) mal_promise_fulfill(vm, object, mal_value_new_undefined());
    return mal_value_new_undefined();
}

static MalValue util_aborted(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[4] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    if (!util_is_abort_signal(vm, roots[0])) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_node_throw_invalid_arg_type(vm, "signal", "an instance of AbortSignal", roots[0]);
        }
        goto done;
    }
    if (!mal_value_is_object(roots[1])) {
        mal_node_throw_invalid_arg_type(vm, "resource", "of type object", roots[1]);
        goto done;
    }
    roots[2] = mal_value_from_object((MalObject *) mal_promise_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE])));
    MalValue aborted;
    mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "aborted"), &aborted);
    if (mal_value_is_truthy(aborted)) {
        mal_promise_fulfill(vm, mal_value_to_promise_object(roots[2]), mal_value_new_undefined());
    } else {
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) ""), 0, util_aborted_listener, &roots[2], 1));
        MalValue listen[2] = {util_string_value(vm, "abort"), roots[3]};
        MalRootSpan listen_root;
        mal_gc_root(&listen_root, listen, 2);
        MalValue add;
        if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "addEventListener"), &add)
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_call_value(vm, add, roots[0], listen, 2);
        }
        mal_gc_unroot(&listen_root);
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW) result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}

// callbackify reactions; slots: callback, settled kind (0 fulfilled, 1 rejected).
static MalValue util_callbackify_settled(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[3] = {mal_native_function_object_get_slot(function, 0),
        argc > 0 ? args[0] : mal_value_new_undefined(), MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    bool rejected = mal_value_to_i32(mal_native_function_object_get_slot(function, 1)) == 1;
    if (rejected) {
        if (!mal_value_is_truthy(roots[1])) {
            MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
            roots[2] = mal_value_from_object(error);
            mal_intrinsic_define_data(vm, error, (const byte *) "message",
                util_string_value(vm, "Promise was rejected with falsy value"), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
            mal_intrinsic_define_data(vm, error, (const byte *) "code",
                util_string_value(vm, "ERR_FALSY_VALUE_REJECTION"), UTIL_VISIBLE);
            mal_intrinsic_define_data(vm, error, (const byte *) "reason", roots[1], UTIL_VISIBLE);
            roots[1] = roots[2];
        }
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), &roots[1], 1);
    } else {
        MalValue call_args[2] = {mal_value_new_null(), roots[1]};
        mal_vm_call_value(vm, roots[0], mal_value_new_undefined(), call_args, 2);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue util_callbackified(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalValue original = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalValue callback = argc > 0 ? args[argc - 1] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_node_throw_invalid_arg_type(vm, "last argument", "of type function", callback);
        return mal_value_new_undefined();
    }
    MalValue roots[5] = {original, callback, receiver, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 5);
    MalCompletion result = mal_vm_call_value(vm, roots[0], roots[2], args, argc - 1);
    if (result.kind != MAL_COMPLETION_THROW) {
        roots[3] = result.value;
        MalValue handlers[2];
        for (i32 i = 0; i < 2; i++) {
            MalValue slots[2] = {roots[1], mal_value_from_i32(i)};
            handlers[i] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, (const byte *) ""), 1, util_callbackify_settled, slots, 2));
            if (i == 0) roots[4] = handlers[0];
        }
        handlers[0] = roots[4];
        MalRootSpan handler_root;
        mal_gc_root(&handler_root, handlers, 2);
        MalValue then;
        if (mal_value_is_promise_object(roots[3])
            && mal_vm_get_property(vm, roots[3], mal_intrinsic_string_key(vm, (const byte *) "then"), &then)
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_call_value(vm, then, roots[3], handlers, 2);
        } else if (vm->completion.kind != MAL_COMPLETION_THROW) {
            MalPromiseObject *resolved = mal_promise_object_new(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
            MalValue resolved_value = mal_value_from_object((MalObject *) resolved);
            MalRootSpan resolved_root;
            mal_gc_root(&resolved_root, &resolved_value, 1);
            mal_promise_fulfill(vm, resolved, roots[3]);
            if (mal_vm_get_property(vm, resolved_value, mal_intrinsic_string_key(vm, (const byte *) "then"), &then)) {
                mal_vm_call_value(vm, then, resolved_value, handlers, 2);
            }
            mal_gc_unroot(&resolved_root);
        }
        mal_gc_unroot(&handler_root);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue util_callbackify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue original = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(original)) {
        mal_node_throw_invalid_arg_type(vm, "original", "of type function", original);
        return mal_value_new_undefined();
    }
    MalString *name = mal_vm_callable_name(vm, original);
    MalTextBuffer text = {0};
    if (name != nullptr) mal_text_buffer_append_string(&text, name);
    mal_text_buffer_append_ascii(&text, (const byte *) "Callbackified");
    MalValue roots[2] = {original, mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text))};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue length;
    i32 arity = 1;
    if (mal_vm_get_property(vm, original, mal_intrinsic_string_key(vm, (const byte *) "length"), &length)
        && mal_ops_is_number(length)) {
        arity = (i32) mal_ops_number_as_f64(length) + 1;
    }
    MalValue result = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_value_to_string(roots[1]), arity, util_callbackified, &roots[0], 1));
    mal_gc_unroot(&root);
    return result;
}

static bool util_diff_strings(MalVm *vm, MalValue value, const char *name, MalValue *items, bool *is_string) {
    *is_string = mal_value_is_string(value);
    if (*is_string) {
        *items = value;
        return true;
    }
    if (!mal_value_is_array_object(value)) {
        mal_node_throw_invalid_arg_type(vm, name, "of type string or an instance of Array", value);
        return false;
    }
    MalArrayObject *array = mal_value_to_array_object(value);
    for (u32 i = 0; i < mal_array_object_length(array); i++) {
        MalValue item = mal_value_new_undefined();
        mal_array_object_dense_get(array, i, &item);
        if (!mal_value_is_string(item)) {
            char label[48];
            snprintf(label, sizeof label, "%s[%u]", name, i);
            mal_node_throw_invalid_arg_type(vm, label, "of type string", item);
            return false;
        }
    }
    *items = value;
    return true;
}

typedef struct UtilDiffData {
    MalValue actual;
    MalValue expected;
    bool strings;
} UtilDiffData;

static MalValue util_diff_item(MalValue source, bool strings, usize index, MalVm *vm) {
    if (strings) {
        MalTextBuffer text = {0};
        mal_text_buffer_push(&text, mal_string_code_units(mal_value_to_string(source))[index]);
        return mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
    }
    MalValue item = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(source), (u32) index, &item);
    return item;
}

static bool util_diff_equal(void *opaque, usize i, usize j) {
    const UtilDiffData *data = opaque;
    if (data->strings) {
        return mal_string_code_units(mal_value_to_string(data->actual))[i]
            == mal_string_code_units(mal_value_to_string(data->expected))[j];
    }
    MalValue a = mal_value_new_undefined(), b = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(data->actual), (u32) i, &a);
    mal_array_object_dense_get(mal_value_to_array_object(data->expected), (u32) j, &b);
    return mal_string_equals(mal_value_to_string(a), mal_value_to_string(b));
}

static MalValue util_diff(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target; (void) callee;
    MalValue roots[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue result = mal_value_new_undefined();
    bool actual_string, expected_string;
    if (!util_diff_strings(vm, argc > 0 ? args[0] : mal_value_new_undefined(), "actual", &roots[0], &actual_string)
        || !util_diff_strings(vm, argc > 1 ? args[1] : mal_value_new_undefined(), "expected", &roots[1], &expected_string)) {
        goto done;
    }
    bool strings = actual_string && expected_string;
    if (actual_string != expected_string) {
        mal_node_throw_invalid_arg_type(vm, "expected", actual_string ? "of type string" : "an instance of Array", roots[1]);
        goto done;
    }
    usize count_a = strings ? mal_string_length(mal_value_to_string(roots[0]))
        : mal_array_object_length(mal_value_to_array_object(roots[0]));
    usize count_e = strings ? mal_string_length(mal_value_to_string(roots[1]))
        : mal_array_object_length(mal_value_to_array_object(roots[1]));
    UtilDiffData data = {roots[0], roots[1], strings};
    MalNodeDiffOp *ops = nullptr;
    usize count = 0;
    if (!mal_node_myers_diff(count_a, count_e, util_diff_equal, &data, &ops, &count)) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    roots[2] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
    MalArrayObject *list = mal_value_to_array_object(roots[2]);
    for (usize step = count; step > 0; step--) {
        const MalNodeDiffOp *op = &ops[step - 1];
        roots[3] = mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0));
        MalArrayObject *pair = mal_value_to_array_object(roots[3]);
        mal_array_object_store(pair, mal_key_index(0), mal_value_from_i32(op->op));
        MalValue item = op->op == -1 ? util_diff_item(roots[1], strings, op->expected, vm)
            : util_diff_item(roots[0], strings, op->actual, vm);
        mal_array_object_store(pair, mal_key_index(1), item);
        mal_array_object_store(list, mal_key_index(mal_array_object_length(list)), roots[3]);
    }
    free(ops);
    result = roots[2];
done:
    mal_gc_unroot(&root);
    return result;
}


/* lib/util.js _extend: own enumerable keys copied last-to-first, with strict-mode sets. */
static MalValue util_extend(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue roots[] = {argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    if (!mal_value_is_object(roots[1]) || mal_value_is_callable(roots[1])) return roots[0];
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue object_constructor = vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    if (mal_vm_get_property(vm, object_constructor, mal_intrinsic_string_key(vm, (const byte *) "keys"), &roots[2])) {
        MalCompletion keys = mal_vm_call_value(vm, roots[2], object_constructor, &roots[1], 1);
        roots[2] = keys.value;
    }
    MalValue length_value;
    if (vm->completion.kind != MAL_COMPLETION_THROW && mal_vm_get_property(vm, roots[2],
            mal_intrinsic_string_key(vm, (const byte *) "length"), &length_value)
        && mal_value_is_int32(length_value)) {
        for (i32 i = mal_value_to_i32(length_value) - 1; i >= 0; i--) {
            if (!mal_vm_get_property(vm, roots[2], mal_key_index((u32) i), &roots[3])) break;
            MalKey key;
            if (!mal_vm_to_property_key(vm, roots[3], &key)) break;
            if (!mal_vm_get_property(vm, roots[1], key, &roots[4])) break;
            if (!mal_value_is_object(roots[0])) {
                char message[256];
                MalString *name = mal_value_to_string(roots[3]);
                usize name_length = 0;
                byte *name_utf8 = mal_string_to_utf8(name, &name_length);
                if (mal_value_is_nil(roots[0])) {
                    snprintf(message, sizeof message, "Cannot set properties of %s (setting '%.*s')",
                        mal_value_is_null(roots[0]) ? "null" : "undefined", (int) name_length,
                        name_utf8 != nullptr ? name_utf8 : "");
                } else {
                    snprintf(message, sizeof message, "Cannot create property '%.*s' on a primitive value",
                        (int) name_length, name_utf8 != nullptr ? name_utf8 : "");
                }
                free(name_utf8);
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
                break;
            }
            if (!mal_vm_set_property(vm, roots[0], key, roots[4], roots[0])) {
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                        "Cannot assign to read only property of object");
                }
                break;
            }
        }
    }
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue util_mark_promise_as_handled(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue promise = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_promise_object(promise)) {
        mal_node_throw_invalid_arg_type(vm, "promise", "an instance of Promise", promise);
        return mal_value_new_undefined();
    }
    mal_value_to_promise_object(promise)->is_handled = true;
    return mal_value_new_undefined();
}

/* util.debounce, translated from Node 26 lib/util.js. The closure variables live on one
 * state object in slot 0 of every helper; the timer is a Node Timeout object. */
static MalValue util_st(MalVm *vm, MalValue state, const char *name) {
    MalValue value = mal_value_new_undefined();
    mal_vm_get_property(vm, state, mal_intrinsic_string_key(vm, (const byte *) name), &value);
    return value;
}

static void util_st_set(MalVm *vm, MalValue state, const char *name, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, mal_value_to_object(state), (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

static MalValue util_slot_state(MalValue callee) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
}

static MalValue util_abort_error_for(MalVm *vm, MalValue reason, const char *message) {
    MalValue error = mal_node_abort_error(vm, reason);
    if (message != nullptr && mal_value_is_object(error)) {
        MalRootSpan root;
        mal_gc_root(&root, &error, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "message",
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) message)),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_gc_unroot(&root);
    }
    if (mal_value_is_undefined(reason) && mal_value_is_object(error)) {
        mal_object_delete_own(mal_value_to_object(error), mal_intrinsic_string_key(vm, (const byte *) "cause"));
    }
    return error;
}

static i32 util_array_length(MalValue array) {
    return mal_value_is_array_object(array) ? (i32) mal_array_object_length(mal_value_to_array_object(array)) : 0;
}

static MalValue util_array_get(MalVm *vm, MalValue array, i32 index) {
    MalValue value = mal_value_new_undefined();
    mal_vm_get_property(vm, array, mal_key_index((u32) index), &value);
    return value;
}

/* Each pending call is a Promise settled directly, like PromiseWithResolvers' resolve/reject. */
static void util_settle_calls(MalVm *vm, MalValue calls, const char *which, MalValue value) {
    MalValue roots[] = {calls, value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool rejected = strcmp(which, "reject") == 0;
    for (i32 i = 0; i < util_array_length(roots[0]); i++) {
        roots[2] = util_array_get(vm, roots[0], i);
        mal_promise_settle_direct(vm, roots[2], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], rejected, roots[1]);
        util_clear_completion(vm);
    }
    mal_gc_unroot(&root);
}

static void util_debounce_reject_pending(MalVm *vm, MalValue state, MalValue error) {
    MalValue roots[] = {state, error, util_st(vm, state, "pending")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    util_st_set(vm, roots[0], "pending", mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)));
    util_settle_calls(vm, roots[2], "reject", roots[1]);
    mal_gc_unroot(&root);
}

static MalValue util_timer_call(MalVm *vm, MalValue target, const char *name, const MalValue *args, i32 argc) {
    MalValue function = mal_value_new_undefined();
    mal_vm_get_property(vm, target, mal_intrinsic_string_key(vm, (const byte *) name), &function);
    if (!mal_value_is_callable(function)) return mal_value_new_undefined();
    return mal_vm_call_value(vm, function, target, args, argc).value;
}

static void util_debounce_clear_timer(MalVm *vm, MalValue state) {
    MalValue timeout = util_st(vm, state, "timeout");
    if (!mal_value_is_undefined(timeout)) {
        MalRootSpan root;
        mal_gc_root(&root, &timeout, 1);
        util_timer_call(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], "clearTimeout", &timeout, 1);
        mal_gc_unroot(&root);
    }
    util_st_set(vm, state, "timeout", mal_value_new_undefined());
}

static void util_debounce_cancel_with_error(MalVm *vm, MalValue state, MalValue error) {
    if (mal_value_is_undefined(util_st(vm, state, "timeout"))) return;
    MalValue roots[] = {state, error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    util_debounce_clear_timer(vm, roots[0]);
    util_st_set(vm, roots[0], "args", mal_value_new_undefined());
    util_debounce_reject_pending(vm, roots[0], roots[1]);
    mal_gc_unroot(&root);
}

static void util_debounce_abort(MalVm *vm, MalValue state) {
    MalValue roots[] = {state, util_st(vm, state, "abortError")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_undefined(roots[1])) {
        roots[1] = util_abort_error_for(vm, mal_abort_signal_reason(util_st(vm, roots[0], "signal")), nullptr);
        util_st_set(vm, roots[0], "abortError", roots[1]);
    }
    util_debounce_cancel_with_error(vm, roots[0], roots[1]);
    mal_gc_unroot(&root);
}

static bool util_debounce_signal_aborted(MalVm *vm, MalValue state) {
    MalValue signal = util_st(vm, state, "signal");
    return !mal_value_is_undefined(signal) && mal_abort_signal_is_aborted(signal);
}

static void util_debounce_invoke(MalVm *vm, MalValue state, MalValue call_args, MalValue calls) {
    MalValue roots[] = {state, call_args, calls, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (util_debounce_signal_aborted(vm, roots[0])) {
        util_debounce_abort(vm, roots[0]);
        util_settle_calls(vm, roots[2], "reject", util_st(vm, roots[0], "abortError"));
        mal_gc_unroot(&root);
        return;
    }
    i32 count = util_array_length(roots[1]);
    MalValue *values = calloc(count == 0 ? 1 : (usize) count, sizeof(MalValue));
    if (values == nullptr) {
        mal_vm_throw_allocation_error(vm);
        mal_gc_unroot(&root);
        return;
    }
    MalRootSpan values_root;
    mal_gc_root(&values_root, values, count);
    for (i32 i = 0; i < count; i++) values[i] = util_array_get(vm, roots[1], i);
    MalCompletion completion = mal_vm_call_value(vm, util_st(vm, roots[0], "fn"), util_st(vm, roots[0], "debounced"),
        values, count);
    mal_gc_unroot(&values_root);
    free(values);
    roots[3] = completion.value;
    bool threw = completion.kind == MAL_COMPLETION_THROW;
    util_clear_completion(vm);
    util_settle_calls(vm, roots[2], threw ? "reject" : "resolve", roots[3]);
    mal_gc_unroot(&root);
}

static void util_debounce_invoke_pending(MalVm *vm, MalValue state) {
    MalValue roots[] = {state, util_st(vm, state, "args"), util_st(vm, state, "pending")};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    util_st_set(vm, roots[0], "args", mal_value_new_undefined());
    util_st_set(vm, roots[0], "pending", mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)));
    if (util_array_length(roots[2]) != 0) util_debounce_invoke(vm, roots[0], roots[1], roots[2]);
    mal_gc_unroot(&root);
}

static MalValue util_debounce_on_timeout(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalValue state = util_slot_state(callee);
    util_st_set(vm, state, "timeout", mal_value_new_undefined());
    util_debounce_invoke_pending(vm, state);
    return mal_value_new_undefined();
}

static void util_debounce_start_timer(MalVm *vm, MalValue state) {
    MalValue roots[] = {state, util_st(vm, state, "onTimeout"), util_st(vm, state, "wait"), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = util_timer_call(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], "setTimeout", roots + 1, 2);
    if (!mal_value_is_truthy(util_st(vm, roots[0], "refed"))) util_timer_call(vm, roots[3], "unref", nullptr, 0);
    util_st_set(vm, roots[0], "timeout", roots[3]);
    mal_gc_unroot(&root);
}

static MalValue util_new_promise(MalVm *vm) {
    MalValue promise, resolve, reject;
    mal_promise_new_direct_capability(vm, &promise, &resolve, &reject);
    return promise;
}

static MalValue util_debounce_reject(MalVm *vm, MalValue error) {
    MalValue roots[] = {error, util_new_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_promise_settle_direct(vm, roots[1], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], true, roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue util_debounced_call(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue roots[] = {util_slot_state(callee), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (util_debounce_signal_aborted(vm, roots[0])) util_debounce_abort(vm, roots[0]);
    roots[1] = util_st(vm, roots[0], "abortError");
    if (!mal_value_is_undefined(roots[1])) {
        result = util_debounce_reject(vm, roots[1]);
        goto done;
    }
    bool invoke_now = mal_value_is_truthy(util_st(vm, roots[0], "leading"))
        && mal_value_is_undefined(util_st(vm, roots[0], "timeout"));
    if (!mal_value_is_undefined(util_st(vm, roots[0], "timeout"))) {
        roots[2] = util_st(vm, roots[0], "pending");
        i32 pending = util_array_length(roots[2]);
        if (pending != 0) {
            MalValue last = util_array_get(vm, roots[2], pending - 1);
            if (mal_value_is_promise_object(last)) mal_value_to_promise_object(last)->is_handled = true;
            if (mal_value_is_truthy(util_st(vm, roots[0], "rejectOnCancel"))) {
                roots[3] = util_abort_error_for(vm, mal_value_new_undefined(), "The debounced call was superseded");
                util_debounce_reject_pending(vm, roots[0], roots[3]);
            }
        }
        util_timer_call(vm, util_st(vm, roots[0], "timeout"), "refresh", nullptr, 0);
    } else {
        util_debounce_start_timer(vm, roots[0]);
    }
    if (util_debounce_signal_aborted(vm, roots[0])) {
        util_debounce_abort(vm, roots[0]);
        result = util_debounce_reject(vm, util_st(vm, roots[0], "abortError"));
        goto done;
    }
    roots[3] = util_new_promise(vm);
    roots[4] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), args, (u32) argc));
    if (invoke_now) {
        roots[2] = mal_value_from_array_object(mal_array_object_new_from_values(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), &roots[3], 1));
        util_debounce_invoke(vm, roots[0], roots[4], roots[2]);
    } else {
        roots[2] = util_st(vm, roots[0], "pending");
        mal_vm_set_property(vm, roots[2], mal_key_index((u32) util_array_length(roots[2])), roots[3], roots[2]);
        util_st_set(vm, roots[0], "args", roots[4]);
    }
    result = roots[3];
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue util_debounce_cancel(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalValue state = util_slot_state(callee);
    if (mal_value_is_undefined(util_st(vm, state, "timeout"))) return mal_value_new_undefined();
    MalValue error = util_abort_error_for(vm, argc > 0 ? args[0] : mal_value_new_undefined(), nullptr);
    util_debounce_cancel_with_error(vm, state, error);
    return mal_value_new_undefined();
}

static MalValue util_debounce_flush(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalValue state = util_slot_state(callee);
    if (util_array_length(util_st(vm, state, "pending")) == 0) return mal_value_new_undefined();
    util_debounce_clear_timer(vm, state);
    util_debounce_invoke_pending(vm, state);
    return mal_value_new_undefined();
}

static MalValue util_debounce_set_ref(MalVm *vm, MalValue callee, bool referenced) {
    MalValue state = util_slot_state(callee);
    util_st_set(vm, state, "refed", mal_value_new_boolean(referenced));
    MalValue timeout = util_st(vm, state, "timeout");
    if (!mal_value_is_undefined(timeout)) util_timer_call(vm, timeout, referenced ? "ref" : "unref", nullptr, 0);
    return util_st(vm, state, "debounced");
}

static MalValue util_debounce_ref(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    return util_debounce_set_ref(vm, callee, true);
}

static MalValue util_debounce_unref(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    return util_debounce_set_ref(vm, callee, false);
}

static MalValue util_debounce_on_abort(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    util_debounce_abort(vm, util_slot_state(callee));
    return mal_value_new_undefined();
}

static MalValue util_debounce_pending_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalValue pending = util_st(vm, util_slot_state(callee), "pending");
    i32 count = util_array_length(pending);
    return count == 0 ? mal_value_new_null() : util_array_get(vm, pending, count - 1);
}

static MalValue util_debounce_pending_count_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    return mal_value_from_i32(util_array_length(util_st(vm, util_slot_state(callee), "pending")));
}

static bool util_validate_boolean_option(MalVm *vm, MalValue value, const char *name) {
    if (mal_value_is_boolean(value)) return true;
    mal_node_throw_invalid_arg_type(vm, name, "of type boolean", value);
    return false;
}

static MalValue util_debounce(MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue fn = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue options = argc > 2 ? args[2] : mal_value_new_undefined();
    if (!mal_value_is_callable(fn)) {
        mal_node_throw_invalid_arg_type(vm, "fn", "of type function", fn);
        return mal_value_new_undefined();
    }
    f64 wait;
    if (!mal_node_validate_integer(vm, argc > 1 ? args[1] : mal_value_new_undefined(), "wait", 0, 2147483647.0, &wait)) {
        return mal_value_new_undefined();
    }
    bool has_options = !mal_value_is_undefined(options);
    if (has_options && (!mal_value_is_object(options) || mal_value_is_array_object(options) || mal_value_is_callable(options))) {
        mal_node_throw_invalid_arg_type(vm, "options", "of type object", options);
        return mal_value_new_undefined();
    }
    MalValue roots[] = {fn, options, mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    roots[3] = has_options ? util_st(vm, roots[1], "leading") : mal_value_new_undefined();
    roots[4] = has_options ? util_st(vm, roots[1], "rejectOnCancel") : mal_value_new_undefined();
    roots[5] = has_options ? util_st(vm, roots[1], "signal") : mal_value_new_undefined();
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    if (mal_value_is_undefined(roots[3])) roots[3] = mal_value_new_boolean(false);
    if (mal_value_is_undefined(roots[4])) roots[4] = mal_value_new_boolean(false);
    if (!util_validate_boolean_option(vm, roots[3], "options.leading")
        || !util_validate_boolean_option(vm, roots[4], "options.rejectOnCancel")) {
        goto done;
    }
    if (!mal_value_is_undefined(roots[5]) && !(mal_value_is_event_target_object(roots[5])
        && mal_value_to_event_target_object(roots[5])->is_abort_signal)) {
        mal_node_throw_invalid_arg_type(vm, "options.signal", "an instance of AbortSignal", roots[5]);
        goto done;
    }
    if (!mal_value_is_undefined(roots[5]) && mal_abort_signal_is_aborted(roots[5])) {
        MalValue error = util_abort_error_for(vm, mal_abort_signal_reason(roots[5]), nullptr);
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = error};
        goto done;
    }
    util_st_set(vm, roots[2], "fn", roots[0]);
    util_st_set(vm, roots[2], "wait", mal_value_from_f64(wait));
    util_st_set(vm, roots[2], "leading", roots[3]);
    util_st_set(vm, roots[2], "rejectOnCancel", roots[4]);
    util_st_set(vm, roots[2], "signal", roots[5]);
    util_st_set(vm, roots[2], "pending", mal_value_from_array_object(mal_intrinsic_new_dense_array(vm, 0)));
    util_st_set(vm, roots[2], "refed", mal_value_new_boolean(true));
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    roots[6] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        function_prototype, mal_intrinsic_ascii(vm, (const byte *) ""), 0, util_debounce_on_timeout, &roots[2], 1));
    util_st_set(vm, roots[2], "onTimeout", roots[6]);
    roots[6] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        function_prototype, mal_intrinsic_ascii(vm, (const byte *) "debounced"), 0, util_debounced_call, &roots[2], 1));
    util_st_set(vm, roots[2], "debounced", roots[6]);
    MalObject *debounced = mal_value_to_object(roots[6]);
    static const struct {
        const char *name;
        i32 length;
        MalNativeFunctionCallback callback;
    } methods[] = {
        {"cancel", 1, util_debounce_cancel}, {"flush", 0, util_debounce_flush},
        {"ref", 0, util_debounce_ref}, {"unref", 0, util_debounce_unref},
    };
    for (usize i = 0; i < countof(methods); i++) {
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            function_prototype, mal_intrinsic_ascii(vm, (const byte *) methods[i].name), methods[i].length,
            methods[i].callback, &roots[2], 1));
        mal_intrinsic_define_data(vm, debounced, (const byte *) methods[i].name, roots[3],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        function_prototype, mal_intrinsic_ascii(vm, (const byte *) "get"), 0, util_debounce_pending_get, &roots[2], 1));
    MalPropertyDesc pending = {.flags = MAL_PROPERTY_ACCESSOR, .getter = roots[3], .setter = mal_value_new_undefined()};
    mal_object_define_own(debounced, mal_intrinsic_string_key(vm, (const byte *) "pending"), &pending);
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        function_prototype, mal_intrinsic_ascii(vm, (const byte *) "get"), 0, util_debounce_pending_count_get,
        &roots[2], 1));
    MalPropertyDesc pending_count = {.flags = MAL_PROPERTY_ACCESSOR, .getter = roots[3], .setter = mal_value_new_undefined()};
    mal_object_define_own(debounced, mal_intrinsic_string_key(vm, (const byte *) "pendingCount"), &pending_count);
    roots[3] = util_st(vm, roots[0], "length");
    roots[4] = util_st(vm, roots[0], "name");
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    mal_intrinsic_define_data(vm, debounced, (const byte *) "length", roots[3], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, debounced, (const byte *) "name", roots[4], MAL_PROPERTY_CONFIGURABLE);
    if (!mal_value_is_undefined(roots[5])) {
        roots[3] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
            function_prototype, mal_intrinsic_ascii(vm, (const byte *) "abort"), 0, util_debounce_on_abort, &roots[2], 1));
        mal_abort_signal_add_algorithm(roots[5], roots[3]);
    }
    result = roots[6];
done:
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result;
}

typedef struct MalNodeUtilExport {
    const char *name;
    i32 length;
    MalNativeFunctionCallback callback;
} MalNodeUtilExport;

static const MalNodeUtilExport util_exports[] = {
    {"_extend", 2, util_extend},
    {"aborted", 2, util_aborted},
    {"callbackify", 1, util_callbackify},
    {"convertProcessSignalToExitCode", 1, util_convert_signal_to_exit_code},
    {"deprecate", 3, util_deprecate},
    {"diff", 2, util_diff},
    {"getCallSites", 0, util_get_call_sites},
    {"getSystemErrorMap", 0, util_get_system_error_map},
    {"getSystemErrorMessage", 1, util_get_system_error_message},
    {"getSystemErrorName", 1, util_get_system_error_name},
    {"isDeepStrictEqual", 2, util_is_deep_strict_equal},
    {"markPromiseAsHandled", 1, util_mark_promise_as_handled},
    {"stripVTControlCharacters", 1, util_strip_vt_control_characters},
    {"transferableAbortController", 0, util_transferable_abort_controller},
    {"transferableAbortSignal", 1, util_transferable_abort_signal},
    {"debounce", 2, util_debounce},
    {"debuglog", 2, util_debuglog},
    {"format", 1, mal_node_util_format},
    {"formatWithOptions", 2, mal_node_util_format_with_options},
    {"inherits", 2, util_inherits},
    {"inspect", 2, mal_node_util_inspect},
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
    {"styleText", 2, util_style_text},
    {"toUSVString", 1, util_to_usv_string},
};

void mal_host_install_node_util(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:util", slots, count)) return;
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
    for (usize i = 0; i < countof(util_exports); i++) {
        if (strcmp(util_exports[i].name, "inspect") == 0) {
            mal_node_inspect_install_tables(vm, mal_value_to_object(values[i]));
        } else if (strcmp(util_exports[i].name, "_extend") == 0) {
            // Node wraps _extend in deprecate(..., 'DEP0060'): named "deprecated", length 2.
            MalValue slots[] = {values[i],
                mal_value_from_string(mal_intrinsic_ascii(vm,
                    (const byte *) "The `util._extend` API is deprecated. Please use Object.assign() instead.")),
                mal_value_new_boolean(false)};
            MalRootSpan slot_root;
            mal_gc_root(&slot_root, slots, countof(slots));
            values[i] = mal_value_from_native_function_object(
                mal_native_function_object_new_with_slots_arity(&vm->heap, function_prototype,
                    mal_intrinsic_ascii(vm, (const byte *) "deprecated"), 2, util_deprecated_call,
                    slots, countof(slots)));
            mal_gc_unroot(&slot_root);
        } else if (strcmp(util_exports[i].name, "promisify") == 0) {
            mal_intrinsic_define_data(vm, mal_value_to_object(values[i]), (const byte *) "custom",
                mal_node_registered_symbol(vm, "nodejs.util.promisify.custom"), UTIL_VISIBLE);
        }
    }
	values[types_index] = mal_value_from_object(mal_intrinsic_new_object(vm));
	values[namespace_index] = mal_value_from_native_function_object(
		mal_native_function_object_new_arity(&vm->heap, function_prototype,
			mal_intrinsic_ascii(vm, ""), 0,
			util_types_is_promise));
	mal_intrinsic_define_data(vm, mal_value_to_object(values[types_index]),
		(const byte *) "isPromise", values[namespace_index], UTIL_VISIBLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(values[types_index]),
        "isArrayBufferView", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_IS_VIEW], UTIL_VISIBLE);
	for (usize i = 0; i < countof(util_type_exports); i++) {
		const MalNodeUtilTypeExport *export = &util_type_exports[i];
		values[namespace_index] = mal_value_from_native_function_object(
			mal_native_function_object_new_arity(&vm->heap, function_prototype,
				mal_intrinsic_ascii(vm, export->javascript_wrapper ? export->name : ""),
                export->javascript_wrapper ? 1 : 0,
				export->callback));
        if (export->javascript_wrapper) {
            MalNativeFunctionObject *function = mal_value_to_native_function_object(values[namespace_index]);
            mal_native_function_object_set_constructor(function);
            mal_native_function_object_set_handles_new_target_prototype(function);
            MalValue prototype = mal_value_from_object(mal_intrinsic_new_object(vm));
            MalRootSpan prototype_root;
            mal_gc_root(&prototype_root, &prototype, 1);
            mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", prototype,
                MAL_PROPERTY_WRITABLE);
            mal_intrinsic_define_data(vm, mal_value_to_object(prototype), "constructor",
                values[namespace_index], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
            mal_gc_unroot(&prototype_root);
        }
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
    mal_node_util_mime_install(vm, namespace);
    for (usize i = 0; i < countof(util_exports); i++) {
        if (strcmp(util_exports[i].name, "debuglog") == 0) {
            mal_intrinsic_define_data(vm, namespace, (const byte *) "debug", values[i], UTIL_VISIBLE);
        }
    }
    static const char *const util_globals[] = {"TextDecoder", "TextEncoder"};
    for (usize i = 0; i < countof(util_globals); i++) {
        MalPropertyLookup global = mal_object_get_own(
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]),
            mal_intrinsic_string_key(vm, (const byte *) util_globals[i]));
        if (global.present && (global.desc.flags & MAL_PROPERTY_ACCESSOR) == 0) {
            mal_intrinsic_define_data(vm, namespace, (const byte *) util_globals[i], global.desc.value, UTIL_VISIBLE);
        }
    }

    mal_node_module_publish(vm, "node:util/types", nullptr, 0, values[types_index]);
    mal_node_module_publish(vm, "node:util", slots, count, values[namespace_index]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_util_types(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:util/types", slots, count)) return;
    mal_host_install_node_util(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    (void) mal_node_module_install_cached(vm, "node:util/types", slots, count);
}

#endif /* MAL_NODE */
