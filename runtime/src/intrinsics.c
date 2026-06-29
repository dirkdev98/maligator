#include "intrinsics.h"

#include <math.h>
#include <stdlib.h>

#include "builtin_array.h"
#include "builtin_array_buffer.h"
#include "builtin_async_generator.h"
#include "builtin_eval.h"
#include "builtin_bigint.h"
#include "builtin_boolean.h"
#include "builtin_console.h"
#include "builtin_data_view.h"
#include "builtin_date.h"
#include "builtin_intl.h"
#include "builtin_typed_array.h"
#include "builtin_error.h"
#include "builtin_function.h"
#include "builtin_generator.h"
#include "builtin_iterator.h"
#include "builtin_iterator_helpers.h"
#include "builtin_json.h"
#include "builtin_map.h"
#include "builtin_math.h"
#include "builtin_number.h"
#include "builtin_object.h"
#include "builtin_promise.h"
#include "builtin_proxy.h"
#include "builtin_regexp.h"
#include "builtin_reflect.h"
#include "builtin_finalization_registry.h"
#include "builtin_set.h"
#include "builtin_weak_ref.h"
#include "builtin_string.h"
#include "builtin_symbol.h"
#include "builtin_uri.h"
#include "heap_string.h"
#include "table.h"
#include "typed_array_object.h"
#include "vm.h"

// Longest internal key in the codebase is well under this; longer names fall
// back to a heap-converted probe buffer.
#define MAL_INTERN_STACK_MAX 64

MalString *mal_intrinsic_ascii(MalVm *vm, const byte *name) {
    usize length = 0;
    while (name[length] != '\0') {
        length++;
    }

    // Probe the atom table with a stack-allocated (or, for rare long names,
    // throwaway-heap) external key string so a hit costs no allocation. On a
    // miss, allocate the canonical atom once and store it as its own key.
    c16 stack_units[MAL_INTERN_STACK_MAX];
    c16 *heap_units = length > MAL_INTERN_STACK_MAX ? malloc(sizeof(c16) * length) : nullptr;
    c16 *units = heap_units != nullptr ? heap_units : stack_units;
    for (usize i = 0; i < length; i++) {
        units[i] = (u8) name[i];
    }

    MalString probe;
    mal_string_init_external(&probe, units, length);
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(&probe)};

    MalTableLookup lookup = mal_table_lookup(vm->atoms, key);
    if (lookup.present) {
        free(heap_units);
        return mal_value_to_string(mal_table_entry_key(vm->atoms, lookup.entry).value);
    }

    MalString *atom = mal_string_new_ascii(&vm->heap, name, length);
    MalKey atom_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(atom)};
    mal_table_upsert_entry(vm->atoms, atom_key);

    free(heap_units);
    return atom;
}

MalKey mal_intrinsic_string_key(MalVm *vm, const byte *name) {
    return (MalKey) {.kind = MAL_KEY_STRING, .value = mal_value_from_string(mal_intrinsic_ascii(vm, name))};
}

MalKey mal_intrinsic_symbol_key(MalVm *vm, MalIntrinsic symbol_slot) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = vm->intrinsics[symbol_slot]};
}

MalValue mal_intrinsic_define_symbol_method(
    MalVm *vm,
    MalObject *object,
    MalIntrinsic symbol_slot,
    const byte *display_name,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, display_name),
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, symbol_slot), &desc);
    return value;
}

MalPropertyDesc mal_intrinsic_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc) {
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

void mal_intrinsic_define_data(MalVm *vm, MalObject *object, const byte *name, MalValue value, MalPropertyFlags flags) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(object, mal_intrinsic_string_key(vm, name), &desc);
}

MalValue mal_intrinsic_define_method(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback callback) {
    return mal_intrinsic_define_method_n(vm, object, name, 0, callback);
}

MalValue mal_intrinsic_define_method_n(MalVm *vm, MalObject *object, const byte *name, i32 length, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        length,
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    mal_intrinsic_define_data(vm, object, name, value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return value;
}

MalValue mal_intrinsic_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return this_value;
}

void mal_intrinsic_define_species(MalVm *vm, MalObject *constructor) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "get [Symbol.species]"),
            mal_intrinsic_species_getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &desc);
}

MalObject *mal_intrinsic_new_object(MalVm *vm) {
    return mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
}

MalArrayObject *mal_intrinsic_new_array(MalVm *vm, u32 length) {
    MalArrayObject *array = mal_array_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]));
    mal_array_object_set_length(array, length);
    return array;
}

static void mal_intrinsics_init_global_this(MalVm *vm);

/**
 * %Function.prototype% is itself a function that accepts any arguments and
 * returns undefined, but has no [[Construct]].
 */
static MalValue mal_intrinsic_function_prototype_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype is not a constructor");
    }

    return mal_value_new_undefined();
}

/**
 * The CommonJS `require` handed to module wrappers. The compiler resolves a
 * static `require("specifier")` to its module id and calls this with that
 * (int32) id; a non-id argument means an unresolved/dynamic require, which this
 * build does not support.
 */
static MalValue mal_intrinsic_cjs_require_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    if (arg_count < 1 || !mal_value_is_int32(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "dynamic require is not supported");
        return mal_value_new_undefined();
    }

    return mal_vm_cjs_require(vm, mal_value_to_i32(args[0]));
}

void mal_intrinsics_init(MalVm *vm) {
    // The prototypes are created upfront, so the builtin install passes can
    // reference them in any order.
    MalObject *object_prototype = mal_object_new(&vm->heap, nullptr);
    MalObject *function_prototype = (MalObject *) mal_native_function_object_new(
        &vm->heap,
        object_prototype,
        mal_string_new_ascii(&vm->heap, "", 0),
        mal_intrinsic_function_prototype_callback
    );
    MalObject *array_prototype = (MalObject *) mal_array_object_new(&vm->heap, object_prototype);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE] = mal_value_from_object(object_prototype);
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE] = mal_value_from_object(function_prototype);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE] = mal_value_from_object(array_prototype);

    // Watch %Array.prototype% and %Object.prototype% for the array fast-elements
    // protector: an integer-index define on, or reparenting of, either invalidates it
    // (see mal_array_elements_protector). Their builtin methods are string-keyed, so
    // installing them below does not trip the protector.
    object_prototype->fast_elements_proto = true;
    array_prototype->fast_elements_proto = true;
    // Cache %Array.prototype% for the inline array store fast path (default-proto check).
    mal_array_prototype_object = array_prototype;

    mal_builtin_object_install(vm);
    // Well-known symbols install before any pass that defines symbol-keyed
    // properties (Function.prototype[@@hasInstance], iterator wiring,
    // toStringTag); the iterator prototypes install before the passes that
    // expose iteration methods over them.
    mal_builtin_symbol_install(vm);
    mal_builtin_bigint_install(vm);
    mal_builtin_function_install(vm);
    mal_builtin_iterator_install(vm);
    mal_builtin_iterator_helpers_install(vm);
    mal_builtin_generator_install(vm);
    mal_builtin_async_generator_install(vm);
    mal_builtin_array_install(vm);
    mal_builtin_map_install(vm);
    mal_builtin_set_install(vm);
    mal_builtin_weak_ref_install(vm);
    mal_builtin_finalization_registry_install(vm);
    mal_builtin_array_buffer_install(vm);
    mal_builtin_typed_array_install(vm);
    mal_builtin_data_view_install(vm);
    mal_builtin_error_install(vm);
    mal_builtin_string_install(vm);
    mal_builtin_number_install(vm);
    mal_builtin_boolean_install(vm);
    mal_builtin_math_install(vm);
    mal_builtin_json_install(vm);
    mal_builtin_reflect_install(vm);
    mal_builtin_proxy_install(vm);
    mal_builtin_console_install(vm);
    mal_builtin_promise_install(vm);
    mal_builtin_date_install(vm);
    mal_builtin_regexp_install(vm);
    mal_builtin_intl_install(vm);
    mal_builtin_uri_install(vm);

    // Flag the built-in constructors as implementing [[Construct]]. Everything
    // else (prototype methods, accessors, plain functions like parseInt) is a
    // non-constructor, so `new method()` throws and IsConstructor reports false.
    static const MalIntrinsic constructor_slots[] = {
        MAL_INTRINSIC_OBJECT_CONSTRUCTOR,
        MAL_INTRINSIC_ARRAY_CONSTRUCTOR,
        MAL_INTRINSIC_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_STRING_CONSTRUCTOR,
        MAL_INTRINSIC_NUMBER_CONSTRUCTOR,
        MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR,
        MAL_INTRINSIC_SYMBOL_CONSTRUCTOR,
        MAL_INTRINSIC_BIGINT_CONSTRUCTOR,
        MAL_INTRINSIC_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_SET_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR,
        MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR,
        MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR,
        MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR,
        MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR,
        MAL_INTRINSIC_TYPED_ARRAY_CONSTRUCTOR,
        MAL_INTRINSIC_PROMISE_CONSTRUCTOR,
        MAL_INTRINSIC_DATE_CONSTRUCTOR,
        MAL_INTRINSIC_REGEXP_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR,
        MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR,
        MAL_INTRINSIC_ITERATOR_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR,
        MAL_INTRINSIC_GENERATOR_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR,
        MAL_INTRINSIC_ASYNC_FUNCTION_CONSTRUCTOR,
    };
    for (usize i = 0; i < countof(constructor_slots); i++) {
        MalValue value = vm->intrinsics[constructor_slots[i]];
        if (mal_value_is_native_function_object(value)) {
            mal_native_function_object_set_constructor(mal_value_to_native_function_object(value));
        }
    }
    // The per-kind TypedArray constructors are contiguous in MalTypedArrayKind order.
    for (i32 kind = 0; kind < MAL_TA_KIND_COUNT; kind++) {
        MalValue value = vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_CONSTRUCTOR_BASE + kind];
        if (mal_value_is_native_function_object(value)) {
            mal_native_function_object_set_constructor(mal_value_to_native_function_object(value));
        }
    }

    vm->intrinsics[MAL_INTRINSIC_NAN_VALUE] = mal_value_new_nan();
    vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE] = mal_value_from_f64_convert_nan(INFINITY);

    // The CommonJS `require` native (not exposed on globalThis); passed to module
    // wrappers by mal_vm_cjs_require.
    vm->intrinsics[MAL_INTRINSIC_CJS_REQUIRE] = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "require"),
            1,
            mal_intrinsic_cjs_require_callback
        )
    );

    mal_intrinsics_init_global_this(vm);
}

/**
 * Host-provided forced-collection hook for the test262 harness's `$262.gc()`.
 * Installed on globalThis only under MAL_HOST_GC (see
 * mal_intrinsics_init_global_this); the harness prelude captures it into the
 * `$262.gc` closure and then deletes the global, so test bodies see a clean
 * global object.
 */
static MalValue mal_intrinsic_host_gc(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    mal_gc_collect(vm);
    return mal_value_new_undefined();
}

/**
 * Diagnostic: the heap's surviving-byte count from the last collection (updated
 * by the sweep). Lets GC unit tests assert reclamation quantitatively. Installed
 * alongside the gc hook under MAL_HOST_GC; the harness prelude deletes it.
 */
static MalValue mal_intrinsic_gc_live_bytes(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_value_from_f64((f64) vm->heap.live_bytes);
}

/**
 * Expose the intrinsics as properties of a globalThis namespace object.
 */
static void mal_intrinsics_init_global_this(MalVm *vm) {
    MalObject *global_this = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS] = mal_value_from_object(global_this);

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, global_this, "globalThis", vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], flags);
    mal_intrinsic_define_data(vm, global_this, "Object", vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Array", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Function", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Error", vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "TypeError", vm->intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "RangeError", vm->intrinsics[MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ReferenceError", vm->intrinsics[MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SyntaxError", vm->intrinsics[MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "EvalError", vm->intrinsics[MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "URIError", vm->intrinsics[MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "String", vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Number", vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Boolean", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Symbol", vm->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt", vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Map", vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Set", vm->intrinsics[MAL_INTRINSIC_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakMap", vm->intrinsics[MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakSet", vm->intrinsics[MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakRef", vm->intrinsics[MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "FinalizationRegistry", vm->intrinsics[MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ArrayBuffer", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SharedArrayBuffer", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8ClampedArray", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigUint64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "DataView", vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "parseInt", vm->intrinsics[MAL_INTRINSIC_PARSE_INT], flags);
    mal_intrinsic_define_data(vm, global_this, "parseFloat", vm->intrinsics[MAL_INTRINSIC_PARSE_FLOAT], flags);
    mal_intrinsic_define_data(vm, global_this, "isNaN", vm->intrinsics[MAL_INTRINSIC_IS_NAN], flags);
    mal_intrinsic_define_data(vm, global_this, "isFinite", vm->intrinsics[MAL_INTRINSIC_IS_FINITE], flags);
    mal_intrinsic_define_data(vm, global_this, "Math", vm->intrinsics[MAL_INTRINSIC_MATH], flags);
    mal_intrinsic_define_data(vm, global_this, "JSON", vm->intrinsics[MAL_INTRINSIC_JSON], flags);
    mal_intrinsic_define_data(vm, global_this, "Reflect", vm->intrinsics[MAL_INTRINSIC_REFLECT], flags);
    mal_intrinsic_define_data(vm, global_this, "Proxy", vm->intrinsics[MAL_INTRINSIC_PROXY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "console", vm->intrinsics[MAL_INTRINSIC_CONSOLE], flags);
    mal_intrinsic_define_data(vm, global_this, "Promise", vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Date", vm->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "RegExp", vm->intrinsics[MAL_INTRINSIC_REGEXP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Intl", vm->intrinsics[MAL_INTRINSIC_INTL], flags);
    mal_intrinsic_define_data(vm, global_this, "AggregateError", vm->intrinsics[MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Iterator", vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "AsyncIterator", vm->intrinsics[MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "decodeURI", vm->intrinsics[MAL_INTRINSIC_DECODE_URI], flags);
    mal_intrinsic_define_data(vm, global_this, "decodeURIComponent", vm->intrinsics[MAL_INTRINSIC_DECODE_URI_COMPONENT], flags);
    mal_intrinsic_define_data(vm, global_this, "encodeURI", vm->intrinsics[MAL_INTRINSIC_ENCODE_URI], flags);
    mal_intrinsic_define_data(vm, global_this, "encodeURIComponent", vm->intrinsics[MAL_INTRINSIC_ENCODE_URI_COMPONENT], flags);
    mal_intrinsic_define_data(vm, global_this, "NaN", vm->intrinsics[MAL_INTRINSIC_NAN_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "Infinity", vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "undefined", mal_value_new_undefined(), MAL_PROPERTY_NONE);

    // Runtime eval / new Function: a baked self-hosted compiler spliced on first
    // use (builtin_eval.c).
    mal_intrinsics_init_eval(vm, global_this);

    // Host forced-collection hook for the test262 `$262.gc()`. Only present when
    // the harness asks (MAL_HOST_GC); the prelude captures it then deletes the
    // global, so it never pollutes a test body's global object.
    if (getenv("MAL_HOST_GC") != nullptr) {
        mal_intrinsic_define_method(vm, global_this, "__mal_collect_garbage", mal_intrinsic_host_gc);
        mal_intrinsic_define_method(vm, global_this, "__mal_gc_live_bytes", mal_intrinsic_gc_live_bytes);
    }
}
