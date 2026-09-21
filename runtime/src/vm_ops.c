#include "vm_ops.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "arguments_object.h"
#include "async_function.h"
#include "bound_function_object.h"
#include "bigint128.h"
#include "builtin_array.h"
#include "builtin_typed_array.h"
#include "builtin_async_generator.h"
#include "builtin_async_iterator.h"
#include "builtin_boolean.h"
#include "builtin_date.h"
#include "builtin_function.h"
#include "builtin_iterator.h"
#include "builtin_map.h"
#include "builtin_math.h"
#include "builtin_number.h"
#include "builtin_object.h"
#include "builtin_promise.h"
#include "builtin_set.h"
#include "builtin_string.h"
#include "function_object.h"
#include "gc.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "map_object.h"
#include "promise_object.h"
#include "primordials.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "module_namespace_object.h"
#include "object_ops.h"
#include "primitive_wrapper_object.h"
#include "profile.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "shape.h"
#include "typed_array_object.h"
#include "value_ops.h"

MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out);

static bool mal_module_namespace_key_triggers(
    MalVm *vm,
    MalModuleNamespaceObject *ns,
    MalKey key
) {
    if (!ns->deferred || key.kind == MAL_KEY_SYMBOL) return false;
    return key.kind != MAL_KEY_STRING ||
        !mal_string_equals(
            mal_value_to_string(key.value),
            mal_intrinsic_ascii(vm, "then"));
}

static bool mal_module_namespace_ensure_for_key(
    MalVm *vm,
    MalModuleNamespaceObject *ns,
    MalKey key
) {
    return !mal_module_namespace_key_triggers(vm, ns, key) ||
        mal_module_namespace_ensure_evaluated(vm, ns);
}
static bool mal_vm_key_is_prototype(MalKey key);

static u64 g_stack_object_materializations = 0;

u64 mal_vm_stack_object_materialization_count(void) {
    return g_stack_object_materializations;
}

bool mal_vm_try_fresh_dense_indexed_fill_reserve(
    MalVm *vm, MalValue array_value, u32 needed
) {
    if (!mal_array_elements_protector || vm->semantic_epochs.array_elements == 0 ||
        !mal_value_is_array_object(array_value)) {
        MAL_PERF_COUNT(array_indexed_fill_guard_fallbacks);
        return false;
    }
    MalArrayObject *array = mal_value_to_array_object(array_value);
    MalValue prototype = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    if (!mal_value_is_array_object(prototype) ||
        array->object.prototype != mal_value_to_object(prototype)) {
        MAL_PERF_COUNT(array_indexed_fill_guard_fallbacks);
        return false;
    }
    if (!mal_array_object_fresh_dense_reserve_exact(array, needed)) {
        MAL_PERF_COUNT(array_indexed_fill_guard_fallbacks);
        return false;
    }

#if MAL_PERF_STATS
    if (mal_perf_stats_enabled) {
        u64 geometric_allocations = 0;
        u64 geometric_bytes = 0;
        u32 capacity = 0;
        while (capacity < needed) {
            capacity = capacity == 0 ? 4 : capacity * 2;
            geometric_allocations++;
            geometric_bytes += mal_heap_allocation_charge(sizeof(MalValue) * (usize) capacity);
        }
        u64 exact_bytes = mal_heap_allocation_charge(sizeof(MalValue) * (usize) needed);
        MAL_PERF_COUNT(array_indexed_fill_reserves);
        MAL_PERF_ADD(array_indexed_fill_reserved_slots, needed);
        MAL_PERF_ADD(
            array_indexed_fill_allocations_avoided,
            geometric_allocations == 0 ? 0 : geometric_allocations - 1
        );
        MAL_PERF_ADD(
            array_indexed_fill_raw_bytes_avoided,
            geometric_bytes > exact_bytes ? geometric_bytes - exact_bytes : 0
        );
    }
#endif
    return true;
}

static const i32 *mal_op_instruction_data(MalCallable *callable, i32 offset) {
    return callable->function->instruction_data + offset;
}

MalValue mal_vm_add(MalVm *vm, MalValue left, MalValue right) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_symbol(left) || mal_value_is_symbol(right)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value");
        return MAL_VALUE_UNDEFINED;
    }
    MalValue result;
    if (!mal_ops_add_checked(&vm->heap, left, right, &result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    return result;
}

MalValue mal_vm_concat_strings_known(MalVm *vm, MalString *left, MalString *right) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return MAL_VALUE_UNDEFINED;
    if (mal_string_length(left) == 0) return mal_value_from_string(right);
    if (mal_string_length(right) == 0) return mal_value_from_string(left);
    MalString *result;
    if (!mal_string_new_cons_checked(&vm->heap, left, right, &result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return MAL_VALUE_UNDEFINED;
    }
    return mal_value_from_string(result);
}

static bool mal_vm_string_to_array_index(MalString *string, u32 *index_out) {
    if (string->array_index_impossible) return false;
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);

    if (length == 0) {
        string->array_index_impossible = true;
        return false;
    }

    if (length > 1 && code_units[0] == '0') {
        string->array_index_impossible = true;
        return false;
    }

    u64 value = 0;
    for (usize i = 0; i < length; i++) {
        c16 code_unit = code_units[i];
        if (code_unit < '0' || code_unit > '9') {
            string->array_index_impossible = true;
            return false;
        }

        value = value * 10 + (u64) (code_unit - '0');
        if (value >= UINT32_MAX) {
            string->array_index_impossible = true;
            return false;
        }
    }

    *index_out = (u32) value;
    return true;
}

static i32 mal_vm_string_table_index(
    const MalString *string, const MalString *table, i32 count
) {
    if (count <= 0) return -1;
    uptr address = (uptr) string;
    uptr base = (uptr) table;
    if (address < base) return -1;
    usize offset = address - base;
    usize bytes = sizeof(MalString) * (usize) count;
    return offset < bytes && offset % sizeof(MalString) == 0
        ? (i32) (offset / sizeof(MalString))
        : -1;
}

/** Return this VM's canonical atom for a baked string constant, if applicable. */
static MalString *mal_vm_string_constant_atom(MalVm *vm, const MalString *string) {
    if (string->header.storage != MAL_HEAP_STORAGE_IMMORTAL) return nullptr;
    i32 index = mal_vm_string_table_index(
        string, vm->initial_string_constants,
        vm->initial_string_constant_count);
    if (index < 0) {
        index = mal_vm_string_table_index(
            string, vm->runtime_image->string_constants,
            vm->runtime_image->string_constant_count);
    }
    if (index < 0) return nullptr;
    MAL_PERF_COUNT(property_constant_atom_hits);
    return vm->string_constant_atoms[index];
}

bool mal_vm_string_is_canonical_numeric_index(MalVm *vm, MalString *string) {
    // CanonicalNumericIndexString (7.1.21): "-0" is canonical by fiat; otherwise
    // a string is canonical iff ToString(ToNumber(string)) reproduces it exactly.
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    if (length == 2 && units[0] == '-' && units[1] == '0') {
        return true;
    }
    f64 number = mal_ops_to_number(mal_value_from_string(string));
    // Canonicalize NaN before boxing: a raw NaN f64 aliases the NaN-boxed object
    // tag, so mal_value_from_f64(NaN) would produce a garbage value (stringifying to
    // "[object Object]") and wrongly reject "NaN" (a canonical numeric index string).
    MalString *round_trip = mal_ops_to_string(&vm->heap, mal_value_from_f64_convert_nan(number));
    return mal_string_equals(string, round_trip);
}

static bool mal_vm_string_to_property_key(MalVm *vm, MalValue value, MalKey *key_out) {
    u32 index = 0;
    if (mal_vm_string_to_array_index(mal_value_to_string(value), &index)) {
        *key_out = mal_key_index(index);
        return true;
    }

    MalString *string = mal_value_to_string(value);
    MalString *atom = mal_vm_string_constant_atom(vm, string);
    if (atom == nullptr) {
        atom = mal_property_atomize_string(vm, string);
    }
    *key_out = (MalKey) {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(atom),
    };
    return true;
}

bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out) {
    // Spec ToPropertyKey, running an object's @@toPrimitive / valueOf / toString.
    // The read-modify-write member lowering (compound assignment, ++/--) used to
    // double-fire this conversion; the compiler now hoists it to a single
    // toPropertyKey op whose string/symbol result re-keys here as a fast path, so
    // the bytecode access path can run the full conversion safely.
    return mal_vm_to_property_key(vm, value, key_out);
}

// Spec ToPropertyKey (7.1.19): key = ? ToPrimitive(value, string); if it is a
// Symbol return it, else return ? ToString(key). Unlike the bytecode shortcut
// above this runs the object's @@toPrimitive / valueOf / toString exactly once,
// so callers that convert a key a single time (the reflective Object/Reflect
// builtins) observe correct coercion. Returns false on an abrupt completion.
bool mal_vm_to_property_key(MalVm *vm, MalValue value, MalKey *key_out) {
    if (mal_value_is_int32(value) && mal_value_to_i32(value) >= 0) {
        *key_out = mal_key_index(mal_value_to_i32(value));
        return true;
    }
    if (mal_value_is_string(value)) {
        return mal_vm_string_to_property_key(vm, value, key_out);
    }
    if (mal_value_is_symbol(value)) {
        *key_out = (MalKey) {.kind = MAL_KEY_SYMBOL, .value = value};
        return true;
    }

    MalValue primitive;
    if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_STRING, &primitive)) {
        return false;
    }
    if (mal_value_is_symbol(primitive)) {
        *key_out = (MalKey) {.kind = MAL_KEY_SYMBOL, .value = primitive};
        return true;
    }
    MalString *string;
    if (!mal_vm_to_string(vm, primitive, &string)) {
        return false;
    }
    return mal_vm_string_to_property_key(vm, mal_value_from_string(string), key_out);
}

bool mal_vm_desc_read(MalVm *vm, MalPropertyDesc desc, MalValue receiver, MalValue *out) {
    if (!(desc.flags & MAL_PROPERTY_ACCESSOR)) {
        *out = desc.value;
        return true;
    }

    if (!mal_value_is_callable(desc.getter)) {
        // Set-only accessors read as undefined.
        *out = mal_value_new_undefined();
        return true;
    }

    MalCompletion completion = mal_vm_call_value(vm, desc.getter, receiver, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *out = completion.value;
    return true;
}

bool mal_vm_create_list_from_array_like(
    MalVm *vm, MalValue list, MalValue *inline_items, i32 inline_capacity,
    MalValue **items_out, i32 *count_out
) {
    *items_out = inline_items;
    *count_out = 0;
    if (!mal_value_is_object(list)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Arguments list must be an object");
        return false;
    }

    MalValue length_value;
    if (!mal_vm_get_property(
            vm, list, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH),
            &length_value)) {
        return false;
    }
    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) {
        return false;
    }

    f64 safe_length = mal_ops_number_to_length(length_number);
    if (safe_length > (f64) INT32_MAX) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Arguments list exceeds the maximum call size");
        return false;
    }
    i32 count = (i32) safe_length;
    if (count == 0) {
        return true;
    }

    MalValue *items = count <= inline_capacity
        ? inline_items
        : malloc(sizeof(MalValue) * (usize) count);
    if (items == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }

    // A fully packed ordinary Array contains only own default-data elements.
    // Once its non-overridable length has been read, copying those elements has
    // no user-code checkpoint to skip. Holes and every exotic array-like retain
    // the indexed Get loop below so inherited accessors and mutation order stay
    // observable.
    if (mal_value_is_array_object(list)) {
        const MalArrayObject *array = mal_value_to_array_object(list);
        bool packed = array->elements != nullptr &&
            array->dense_count >= (u32) count &&
            !array->dense_maybe_holey;
        if (packed) {
            memcpy(items, array->elements, sizeof(MalValue) * (usize) count);
            *items_out = items;
            *count_out = count;
            return true;
        }
    }

    MalRootSpan items_span;
    mal_gc_root(&items_span, items, 0);
    mal_gc_native_rooted_begin(vm);
    bool ok = true;
    for (i32 index = 0; index < count; index++) {
        items_span.count = index;
        if (!mal_vm_get_property(vm, list, mal_key_index((u32) index), &items[index])) {
            ok = false;
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&items_span);
    if (!ok) {
        if (items != inline_items) free(items);
        return false;
    }

    *items_out = items;
    *count_out = count;
    return true;
}

static MalValue mal_vm_own_key_value(MalVm *vm, MalKey key) {
    return key.kind == MAL_KEY_INDEX
        ? mal_value_from_string(mal_ops_to_string(&vm->heap, key.value))
        : key.value;
}

static void mal_vm_own_keys_append(MalArrayObject *keys, MalValue value) {
    u32 index = mal_array_object_length(keys);
    if (!mal_array_object_fresh_dense_append(keys, value)) {
        mal_array_object_store(keys, mal_key_index(index), value);
    }
}

static void mal_vm_own_keys_reserve(
    MalArrayObject *keys, const MalObject *object, usize exotic_count
) {
    usize count = exotic_count + object->shape->inline_count;
    if (object->overflow != nullptr) {
        count += mal_table_size(object->overflow);
    }
    if (object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        count += ((const MalArrayObject *) object)->dense_count;
    }
    if (count <= UINT32_MAX) {
        mal_array_object_fresh_dense_reserve_exact(keys, (u32) count);
    }
}

static bool mal_vm_script_function_has_prototype(MalVm *vm, MalValue value) {
    if (!mal_value_is_function_object(value)) {
        return false;
    }
    i32 index = mal_function_object_function_index(mal_value_to_function_object(value));
    const MalFunction *function = &vm->runtime_image->functions[index];
    return function->has_prototype && function->kind != MAL_FUNCTION_KIND_ASYNC;
}

bool mal_vm_own_property_keys(MalVm *vm, MalValue object_value, MalValue *keys_out) {
    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Own property keys require an object");
        return false;
    }
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_own_property_keys(
            vm, mal_value_to_proxy_object(object_value), keys_out);
    }


    // Script constructor/generator functions expose their prototype property
    // lazily. Reflection must include it even before an ordinary Get touched it.
    if (mal_vm_script_function_has_prototype(vm, object_value) &&
        !mal_object_get_own(
            mal_value_to_object(object_value), mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE))
             .present) {
        mal_vm_function_prototype(vm, object_value);
    }

    MalArrayObject *keys = mal_intrinsic_new_array(vm, 0);
    *keys_out = mal_value_from_array_object(keys);

    if (mal_value_is_module_namespace_object(object_value)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(object_value);
        if (!mal_module_namespace_ensure_evaluated(vm, ns)) return false;
        mal_array_object_fresh_dense_reserve_exact(
            keys, (u32) ns->export_count + 1);
        for (i32 i = 0; i < ns->export_count; i++) {
            mal_vm_own_keys_append(
                keys, mal_value_from_string(ns->exports[i].name));
        }
        mal_vm_own_keys_append(
            keys,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG).value);
        return true;
    }

    MalObject *object = mal_value_to_object(object_value);
    bool typed_array = mal_value_is_typed_array_object(object_value);
    u32 typed_array_length = typed_array
        ? mal_typed_array_object_length(
            mal_value_to_typed_array_object(object_value))
        : 0;
    MalPropertyDesc string_exotic;
    bool string_wrapper = mal_primitive_wrapper_string_exotic_own(
        &vm->heap, object, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH),
        &string_exotic);
    u32 string_length = string_wrapper
        ? (u32) mal_value_to_i32(string_exotic.value)
        : 0;
    usize exotic_count = (usize) typed_array_length + string_length;
    if (string_wrapper || mal_value_is_array_object(object_value)) {
        exotic_count++;
    }
    mal_vm_own_keys_reserve(keys, object, exotic_count);

    if (typed_array) {
        for (u32 index = 0; index < typed_array_length; index++) {
            mal_vm_own_keys_append(
                keys,
                mal_value_from_string(mal_ops_to_string(
                    &vm->heap, mal_value_from_i32((i32) index))));
        }
    }

    if (string_wrapper) {
        for (u32 index = 0; index < string_length; index++) {
            mal_vm_own_keys_append(
                keys,
                mal_value_from_string(mal_ops_to_string(
                    &vm->heap, mal_value_from_i32((i32) index))));
        }
    }

    bool length_pending = mal_value_is_array_object(object_value);
    bool string_length_pending = string_wrapper;
    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL && mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        if (typed_array && key.kind == MAL_KEY_INDEX) {
            continue;
        }
        if (string_wrapper && key.kind == MAL_KEY_INDEX) {
            u32 index = mal_key_index_value(key);
            if (index < string_length) {
                continue;
            }
        }
        if (string_length_pending && key.kind != MAL_KEY_INDEX) {
            mal_vm_own_keys_append(
                keys,
                mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
            string_length_pending = false;
        }
        if (length_pending && key.kind != MAL_KEY_INDEX) {
            mal_vm_own_keys_append(
                keys,
                mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
            length_pending = false;
        }
        mal_vm_own_keys_append(keys, mal_vm_own_key_value(vm, key));
    }
    if (length_pending) {
        mal_vm_own_keys_append(
            keys,
            mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
    }
    if (string_length_pending) {
        mal_vm_own_keys_append(
            keys,
            mal_value_from_string(mal_intrinsic_ascii(vm, "length")));
    }
    return true;
}

bool mal_vm_get_own_property(
    MalVm *vm, MalValue object_value, MalKey key, bool *present_out,
    MalPropertyDesc *desc_out) {
    *present_out = false;
    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Own property lookup requires an object");
        return false;
    }
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_get_own_property_descriptor(
            vm, mal_value_to_proxy_object(object_value), key, present_out, desc_out);
    }

    if (mal_vm_script_function_has_prototype(vm, object_value) &&
        mal_vm_key_is_prototype(key) &&
        !mal_object_get_own(mal_value_to_object(object_value), key).present) {
        mal_vm_function_prototype(vm, object_value);
        MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object_value), key);
        if (lookup.present) {
            *desc_out = lookup.desc;
            *present_out = true;
            return true;
        }
    }

    if (mal_value_is_module_namespace_object(object_value)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(object_value);
        if (!mal_module_namespace_ensure_for_key(vm, ns, key)) return false;
        MalKey tag = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG);
        if (key.kind == MAL_KEY_SYMBOL && key.value == tag.value) {
            *desc_out = (MalPropertyDesc) {
                .flags = MAL_PROPERTY_NONE,
                .value = mal_value_from_string(
                    mal_intrinsic_ascii(vm, ns->deferred ? "Deferred Module" : "Module")),
                .getter = mal_value_new_undefined(),
                .setter = mal_value_new_undefined(),
            };
            *present_out = true;
            return true;
        }
        if (key.kind == MAL_KEY_STRING) {
            MalString *name = mal_value_to_string(key.value);
            for (i32 i = 0; i < ns->export_count; i++) {
                if (mal_string_equals(name, ns->exports[i].name)) {
                    MalValue value = vm->globals[ns->exports[i].slot];
                    if (mal_value_is_empty(value)) {
                        mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                            "Cannot access module export before initialization");
                        return false;
                    }
                    *desc_out = (MalPropertyDesc) {
                        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE,
                        .value = value,
                        .getter = mal_value_new_undefined(),
                        .setter = mal_value_new_undefined(),
                    };
                    *present_out = true;
                    return true;
                }
            }
        }
        return true;
    }

    if (mal_value_is_typed_array_object(object_value) && key.kind == MAL_KEY_INDEX) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(object_value);
        u32 index = mal_key_index_value(key);
        if (index < mal_typed_array_object_length(array)) {
            MalPropertyFlags flags = MAL_PROPERTY_ENUMERABLE;
            if (!array->buffer->immutable) {
                flags |= MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
            }
            *desc_out = (MalPropertyDesc) {
                .flags = flags,
                .value = mal_typed_array_object_get(vm, array, index),
                .getter = mal_value_new_undefined(),
                .setter = mal_value_new_undefined(),
            };
            *present_out = true;
        }
        return true;
    }
    if (mal_value_is_typed_array_object(object_value) && key.kind == MAL_KEY_STRING &&
        mal_vm_string_is_canonical_numeric_index(vm, mal_value_to_string(key.value))) {
        return true;
    }

    if (mal_value_is_array_object(object_value) && mal_array_key_is_length(key)) {
        MalArrayObject *array = mal_value_to_array_object(object_value);
        *desc_out = (MalPropertyDesc) {
            .flags = array->length_writable ? MAL_PROPERTY_WRITABLE : MAL_PROPERTY_NONE,
            .value = mal_value_from_u32(mal_array_object_length(array)),
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
        *present_out = true;
        return true;
    }

    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap, mal_value_to_object(object_value), key, &string_exotic)) {
        *desc_out = string_exotic;
        *present_out = true;
        return true;
    }

    MalObject *object = mal_value_to_object(object_value);
    MalPropertyLookup lookup = mal_object_get_own(object, key);
    if (lookup.present) {
        *desc_out = lookup.desc;
        if (mal_object_is_mapped_arguments(object)) {
            MalArgumentsObject *arguments = (MalArgumentsObject *) object;
            i32 slot = mal_arguments_object_mapped_slot(arguments, key);
            if (slot >= 0) desc_out->value = arguments->env->slots[slot];
        }
        *present_out = true;
    }
    return true;
}

bool mal_vm_is_extensible_object(
    MalVm *vm, MalValue object_value, bool *extensible_out) {
    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "IsExtensible requires an object");
        return false;
    }
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_is_extensible(
            vm, mal_value_to_proxy_object(object_value), extensible_out);
    }
    *extensible_out = mal_object_is_extensible(mal_value_to_object(object_value));
    return true;
}

void mal_op_move(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.move.dst] = callable->registers[instruction->as.move.src];
}

void mal_op_base_construct_result(
    MalCallable *callable, const MalInstruction *instruction) {
    MalValue value = callable->registers[instruction->as.base_construct_result.value];
    callable->registers[instruction->as.base_construct_result.dst] =
        mal_value_is_object(value)
        ? value
        : callable->registers[instruction->as.base_construct_result.receiver];
}

void mal_op_create_number(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_create_f64(MalCallable *callable, const MalInstruction *instruction) {
    u64 bits = (u64) instruction->as.create_f64.bits_low |
        ((u64) instruction->as.create_f64.bits_high << 32);
    f64 value;
    memcpy(&value, &bits, sizeof(value));
    callable->registers[instruction->as.create_f64.dst] = mal_value_from_f64_convert_nan(value);
}

void mal_op_create_boolean(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_boolean.dst] = mal_value_new_boolean(instruction->as.create_boolean.value != 0);
}

void mal_op_create_string(MalCallable *callable, const MalInstruction *instruction) {
    // The string constant is an immortal, pre-hashed static; hand back a
    // pointer instead of allocating a fresh MalString per execution.
    MalString *string = &callable->vm->runtime_image->string_constants[instruction->as.create_string.string_index];
    callable->registers[instruction->as.create_string.dst] = mal_value_from_string(string);
}

void mal_op_create_bigint(MalCallable *callable, const MalInstruction *instruction) {
    // The bigint constant is an immortal static with its value baked at compile
    // time; hand back a pointer instead of parsing and allocating per execution.
    MalBigInt *bigint = &callable->vm->runtime_image->bigint_constants[instruction->as.create_bigint.bigint_index];
    callable->registers[instruction->as.create_bigint.dst] = mal_value_from_bigint(bigint);
}

static MalValue mal_op_value_operand(MalCallable *callable, i32 operand) {
    if (operand >= 0) return callable->registers[operand];
    switch (operand) {
        case MAL_VALUE_OPERAND_UNDEFINED: return MAL_VALUE_UNDEFINED;
        case MAL_VALUE_OPERAND_NULL: return MAL_VALUE_NULL;
        case MAL_VALUE_OPERAND_FALSE: return MAL_VALUE_FALSE;
        case MAL_VALUE_OPERAND_TRUE: return MAL_VALUE_TRUE;
    }
    if (operand <= MAL_VALUE_OPERAND_STRING_BASE
        && operand >= MAL_VALUE_OPERAND_STRING_MIN) {
        i32 index = MAL_VALUE_OPERAND_STRING_BASE - operand;
        return mal_value_from_string(&callable->vm->runtime_image->string_constants[index]);
    }
    if (operand <= MAL_VALUE_OPERAND_I28_BASE && operand >= MAL_VALUE_OPERAND_I28_MIN) {
        i32 payload = MAL_VALUE_OPERAND_I28_BASE - operand;
        i32 value = (payload & 1) == 0 ? payload / 2 : -(payload + 1) / 2;
        return mal_value_from_i32(value);
    }
    abort();
}

MalValue mal_vm_op_create_object(MalVm *vm) {
    MalObject *object = mal_object_try_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    if (object == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return MAL_VALUE_UNDEFINED;
    }
    MAL_PERF_COUNT(object_empty_creations);
    return mal_value_from_object(object);
}

MalValue mal_vm_op_create_base_construct_receiver(
    MalVm *vm, MalValue new_target, u8 capacity
) {
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        return MAL_VALUE_UNDEFINED;
    }
    return mal_value_from_object(
        mal_object_new_reserved(&vm->heap, prototype, capacity));
}

MalValue mal_vm_materialize_stack_object(MalVm *vm, const MalObject *source) {
    assert(source->header.type == MAL_HEAP_OBJECT);
    assert(source->header.storage == MAL_HEAP_STORAGE_IMMORTAL);
    assert(source->overflow == nullptr);
    u32 count = source->shape->inline_count;
    assert(count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert((count == 0) == (source->slots == nullptr));

    MalObject *object = mal_heap_try_alloc(
        &vm->heap, sizeof(MalObject) + sizeof(MalValue) * count, MAL_HEAP_OBJECT);
    if (object == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return MAL_VALUE_UNDEFINED;
    }

    // Preserve every ordinary-object internal field while retaining the fresh
    // managed header. The trailing slots belong to the same GC cell.
    MalHeapHeader header = object->header;
    *object = *source;
    object->header = header;
    object->slots_owned = false;
    object->slot_capacity = (u8) count;
    if (count == 0) {
        object->slots = nullptr;
    } else {
        object->slots = (MalValue *) (object + 1);
        memcpy(object->slots, source->slots, sizeof(MalValue) * count);
    }
    g_stack_object_materializations++;
    MAL_PERF_COUNT(stack_object_materializations);
    return mal_value_from_object(object);
}

MalValue mal_vm_create_object_shaped(MalVm *vm, MalShape *shape, const MalValue *values, u32 count) {
    // A static object literal: the final shape is known, so create the object
    // directly in that shape and bulk-fill its inline slots in key order, instead
    // of transitioning the shape property-by-property. No safepoint runs between
    // the allocation and the fill, so the half-initialized object is never visible
    // to the collector and caller-local `values` remain live through the copy.
    assert(count >= 1 && count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert(shape->inline_count == count);
    MAL_PERF_COUNT(object_shaped_creations);
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    return mal_value_from_object(
        mal_object_new_shaped(&vm->heap, prototype, shape, values, count));
}

void mal_op_create_object(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_object.dst] = mal_vm_op_create_object(callable->vm);
}

void mal_op_create_base_construct_receiver(
    MalCallable *callable, const MalInstruction *instruction
) {
    callable->registers[instruction->as.create_base_construct_receiver.dst] =
        mal_vm_op_create_base_construct_receiver(
            callable->vm,
            callable->registers[instruction->as.create_base_construct_receiver.new_target],
            (u8) instruction->as.create_base_construct_receiver.constructor_slot_reserve);
}

void mal_op_create_object_shaped(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_ensure_function_caches(
        callable->vm, callable->function_index);
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.create_object_shaped.data_offset);
    u32 count = (u32) data[0];
    const i32 *key_indices = &data[1];
    const i32 *value_registers = &data[1 + count];
    MalString *keys[MAL_SHAPE_MAX_INLINE_SLOTS];
    MalValue values[MAL_SHAPE_MAX_INLINE_SLOTS];
    MalShape **cache = &callable->vm->literal_shape_cache[callable->function_index][
        instruction->as.create_object_shaped.shape_cache_index];
    MalShape *shape = *cache;
    for (u32 i = 0; i < count; ++i) {
        values[i] = callable->registers[value_registers[i]];
    }
    // Shape transitions are immutable and interned. Reuse this bytecode site's
    // dense literal row instead of walking the same key sequence per allocation.
    if (shape == nullptr) {
        for (u32 i = 0; i < count; ++i) {
            keys[i] = callable->vm->string_constant_atoms[key_indices[i]];
        }
        shape = mal_shape_from_string_keys(&callable->vm->heap, keys, count);
        *cache = shape;
    }
    callable->registers[instruction->as.create_object_shaped.dst] =
        mal_vm_create_object_shaped(callable->vm, shape, values, count);
}

MalValue mal_vm_op_create_array(MalVm *vm, i32 length) {
    MalArrayObject *array = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(array, (u32) length);
    return mal_value_from_array_object(array);
}

void mal_op_create_array(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_array.dst] =
        mal_vm_op_create_array(callable->vm, instruction->as.create_array.length);
}

typedef struct MalLiteralBuildFrame {
    MalValue container;
    u32 remaining;
    u32 next_index;
    bool is_object;
} MalLiteralBuildFrame;

typedef struct MalLiteralCursor {
    const u32 *data;
    u32 count;
    u32 pos;
} MalLiteralCursor;

static bool mal_literal_read(MalLiteralCursor *cursor, u32 *out) {
    if (cursor->pos >= cursor->count) {
        return false;
    }
    *out = cursor->data[cursor->pos++];
    return true;
}

static bool mal_literal_decode_value(
    MalVm *vm, MalLiteralCursor *cursor, MalValue *out, bool *is_container,
    bool *is_object, u32 *child_count
) {
    u32 tag;
    if (!mal_literal_read(cursor, &tag)) {
        return false;
    }
    *is_container = false;
    *is_object = false;
    *child_count = 0;
    switch ((MalLiteralTemplateTag) tag) {
        case MAL_LITERAL_UNDEFINED:
            *out = MAL_VALUE_UNDEFINED;
            return true;
        case MAL_LITERAL_NULL:
            *out = mal_value_new_null();
            return true;
        case MAL_LITERAL_FALSE:
            *out = mal_value_new_boolean(false);
            return true;
        case MAL_LITERAL_TRUE:
            *out = mal_value_new_boolean(true);
            return true;
        case MAL_LITERAL_I32: {
            u32 bits;
            if (!mal_literal_read(cursor, &bits)) return false;
            *out = mal_value_from_i32((i32) bits);
            return true;
        }
        case MAL_LITERAL_F64: {
            u32 lo, hi;
            if (!mal_literal_read(cursor, &lo) || !mal_literal_read(cursor, &hi)) return false;
            u64 bits = (u64) lo | ((u64) hi << 32);
            f64 value;
            memcpy(&value, &bits, sizeof(value));
            *out = mal_value_from_f64_convert_nan(value);
            return true;
        }
        case MAL_LITERAL_STRING: {
            u32 index;
            if (!mal_literal_read(cursor, &index) || index >= (u32) vm->runtime_image->string_constant_count) {
                return false;
            }
            *out = mal_value_from_string(&vm->runtime_image->string_constants[index]);
            return true;
        }
        case MAL_LITERAL_BIGINT: {
            u32 index;
            if (!mal_literal_read(cursor, &index) || index >= (u32) vm->runtime_image->bigint_constant_count) {
                return false;
            }
            *out = mal_value_from_bigint(&vm->runtime_image->bigint_constants[index]);
            return true;
        }
        case MAL_LITERAL_HOLE:
            *out = mal_value_new_array_hole();
            return true;
        case MAL_LITERAL_ARRAY: {
            u32 count;
            if (!mal_literal_read(cursor, &count)) return false;
            MalArrayObject *array = mal_array_object_try_new(
                &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]));
            if (array == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return false;
            }
            mal_array_object_set_length(array, count);
            *out = mal_value_from_array_object(array);
            *is_container = true;
            *child_count = count;
            return true;
        }
        case MAL_LITERAL_OBJECT: {
            u32 count;
            if (!mal_literal_read(cursor, &count)) return false;
            *out = mal_vm_op_create_object(vm);
            if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
            *is_container = true;
            *is_object = true;
            *child_count = count;
            return true;
        }
        case MAL_LITERAL_KEY:
            return false;
    }
    return false;
}

MalValue mal_vm_query_static_data(MalVm *vm, i32 template_offset, i32 query_kind, MalValue needle, MalValue from_index) {
    const MalRuntimeImage *image = vm->runtime_image;
    if (template_offset < 0 || template_offset >= image->literal_template_data_count - 1 ||
        image->literal_template_data[template_offset] != MAL_LITERAL_ARRAY ||
        query_kind < 0 || query_kind > 3) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid static data query");
        return MAL_VALUE_UNDEFINED;
    }
    u32 length = image->literal_template_data[template_offset + 1];
    bool returns_index = query_kind >= 2;
    MalValue absent = returns_index ? mal_value_from_i32(-1) : MAL_VALUE_FALSE;
    if (query_kind != 1 && length == 0) return absent;
    MalValue roots[2] = { needle, from_index };
    MalRootSpan span;
    mal_gc_root(&span, roots, 2);
    u32 start = 0, end = length;
    if (query_kind == 1) {
        MalKey key;
        if (!mal_vm_to_property_key(vm, needle, &key)) {
            mal_gc_unroot(&span);
            return MAL_VALUE_UNDEFINED;
        }
        roots[0] = key.value;
    } else {
        f64 number;
        if (!mal_vm_to_number(vm, from_index, &number)) {
            mal_gc_unroot(&span);
            return MAL_VALUE_UNDEFINED;
        }
        if (query_kind == 3) {
            f64 integer = isnan(number) ? 0 : trunc(number);
            if (integer < 0) integer += length;
            if (integer < 0) end = 0;
            else if (integer < length) end = (u32) integer + 1;
        } else {
            start = (u32) mal_ops_number_clamp_relative(number, length);
        }
    }
    if (start >= end) {
        mal_gc_unroot(&span);
        return absent;
    }
    // Coercion can adopt an image; offsets still name the retained prefix of its relocated pools.
    MalLiteralCursor cursor = {
        .data = vm->runtime_image->literal_template_data,
        .count = (u32) vm->runtime_image->literal_template_data_count,
        .pos = (u32) template_offset + 2,
    };
    i32 found = -1;
    bool valid = true;
    bool numeric_needle = query_kind != 1 && mal_ops_is_number(roots[0]);
    f64 number_needle = numeric_needle ? mal_ops_number_as_f64(roots[0]) : 0;
    for (u32 index = 0; index < end; index++) {
        if (cursor.pos >= cursor.count) { valid = false; break; }
        u32 tag = cursor.data[cursor.pos];
        if ((tag >= MAL_LITERAL_ARRAY && tag != MAL_LITERAL_UNDEFINED) ||
            (query_kind == 1 && tag != MAL_LITERAL_STRING)) { valid = false; break; }
        bool equal;
        if (tag == MAL_LITERAL_I32) {
            cursor.pos++;
            u32 bits;
            if (!mal_literal_read(&cursor, &bits)) { valid = false; break; }
            equal = numeric_needle && number_needle == (i32) bits;
        } else if (tag == MAL_LITERAL_STRING) {
            cursor.pos++;
            u32 slot;
            if (!mal_literal_read(&cursor, &slot) ||
                slot >= (u32) vm->runtime_image->string_constant_count) { valid = false; break; }
            MalString *string = &vm->runtime_image->string_constants[slot];
            if (query_kind == 1 && mal_ops_is_number(roots[0])) {
                u32 key_index;
                equal = mal_vm_string_to_array_index(string, &key_index) &&
                    mal_ops_number_as_f64(roots[0]) == key_index;
            } else {
                equal = mal_value_is_string(roots[0]) &&
                    mal_string_equals(string, mal_value_to_string(roots[0]));
            }
        } else {
            MalValue element;
            bool container, object;
            u32 children;
            if (!mal_literal_decode_value(vm, &cursor, &element, &container, &object, &children)) { valid = false; break; }
            if (tag == MAL_LITERAL_HOLE) element = MAL_VALUE_UNDEFINED;
            equal = (!returns_index || tag != MAL_LITERAL_HOLE) &&
                (mal_ops_strict_equal_bool(element, roots[0]) ||
                    (query_kind == 0 && mal_value_is_nan(element) && mal_value_is_nan(roots[0])));
        }
        if (index >= start && equal) {
            found = (i32) index;
            // Primitive comparisons are effect-free; retaining the last match avoids a reverse offset table.
            if (query_kind != 3) break;
        }
        if (((index + 1) & 1023u) == 0 && mal_gc_poll) {
            mal_gc_safepoint(vm);
            cursor.data = vm->runtime_image->literal_template_data;
            cursor.count = (u32) vm->runtime_image->literal_template_data_count;
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                mal_gc_unroot(&span);
                return MAL_VALUE_UNDEFINED;
            }
        }
    }
    mal_gc_unroot(&span);
    if (!valid) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid static query payload");
        return MAL_VALUE_UNDEFINED;
    }
    return returns_index ? mal_value_from_i32(found) : mal_value_new_boolean(found >= 0);
}

void mal_op_query_static_data(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(callable, instruction->as.query_static_data.data_offset);
    callable->registers[instruction->as.query_static_data.dst] = mal_vm_query_static_data(
        callable->vm, data[0], data[1],
        callable->registers[instruction->as.query_static_data.needle],
        callable->registers[instruction->as.query_static_data.from_index]);
}

MalValue mal_vm_instantiate_literal_template(MalVm *vm, i32 template_offset, i32 cache_slot) {
    if (cache_slot < -1 || cache_slot >= vm->runtime_image->global_count) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid literal constant slot");
        return MAL_VALUE_UNDEFINED;
    }
    if (cache_slot >= 0 && !mal_value_is_undefined(vm->globals[cache_slot]))
        return vm->globals[cache_slot];
    MalValue result = mal_value_new_undefined();
    MalRootSpan result_root;
    mal_gc_root(&result_root, &result, 1);

    MalLiteralBuildFrame *frames = nullptr;
    MalValue *active = nullptr;
    u32 depth = 0;
    u32 capacity = 0;
    MalRootSpan active_root;
    mal_gc_root(&active_root, active, 0);

    const u32 data_count = (u32) vm->runtime_image->literal_template_data_count;
    MalLiteralCursor cursor = {
        .data = vm->runtime_image->literal_template_data,
        .count = data_count,
        .pos = template_offset >= 0 ? (u32) template_offset : data_count,
    };
    bool root_container, root_object;
    u32 root_children;
    bool ok = cursor.pos < data_count && mal_literal_decode_value(
        vm, &cursor, &result, &root_container, &root_object, &root_children);

    if (ok && root_container) {
        capacity = 8;
        frames = malloc(sizeof(MalLiteralBuildFrame) * capacity);
        active = malloc(sizeof(MalValue) * capacity);
        active_root.slots = active;
        if (frames == nullptr || active == nullptr) {
            mal_vm_throw_allocation_error(vm);
            ok = false;
        } else {
            frames[0] = (MalLiteralBuildFrame) {
                .container = result,
                .remaining = root_children,
                .next_index = 0,
                .is_object = root_object,
            };
            active[0] = result;
            depth = 1;
            active_root.count = 1;
        }
    }

    u32 built = 0;
    while (ok && depth > 0) {
        MalLiteralBuildFrame *parent = &frames[depth - 1];
        if (parent->remaining == 0) {
            depth--;
            active_root.count = (i32) depth;
            continue;
        }

        u32 key_index = 0;
        if (parent->is_object) {
            u32 key_tag;
            ok = mal_literal_read(&cursor, &key_tag) && key_tag == MAL_LITERAL_KEY &&
                 mal_literal_read(&cursor, &key_index) &&
                 key_index < (u32) vm->runtime_image->string_constant_count;
            if (!ok) break;
        }

        MalValue child;
        bool child_container, child_object;
        u32 child_count;
        ok = mal_literal_decode_value(
            vm, &cursor, &child, &child_container, &child_object, &child_count);
        if (!ok || (!parent->is_object && parent->next_index >= mal_value_to_array_object(parent->container)->length)) {
            ok = false;
            break;
        }

        if (parent->is_object) {
            MalKey key = {
                .kind = MAL_KEY_STRING,
                .value = mal_value_from_string(vm->string_constant_atoms[key_index]),
            };
            MalPropertyDesc desc = {
                .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
                .value = child,
            };
            ok = mal_object_define_own(mal_value_to_object(parent->container), key, &desc) ==
                 MAL_DEFINE_OWN_APPLIED;
        } else {
            MalArrayObject *array = mal_value_to_array_object(parent->container);
            ok = mal_array_object_dense_store(array, parent->next_index, child) == MAL_ARRAY_DENSE_APPLIED;
            parent->next_index++;
        }
        if (!ok) break;
        parent->remaining--;

        if (child_container) {
            if (depth == capacity) {
                capacity *= 2;
                MalLiteralBuildFrame *grown_frames = realloc(frames, sizeof(MalLiteralBuildFrame) * capacity);
                if (grown_frames == nullptr) {
                    mal_vm_throw_allocation_error(vm);
                    ok = false;
                    break;
                }
                frames = grown_frames;
                MalValue *grown_active = realloc(active, sizeof(MalValue) * capacity);
                if (grown_active == nullptr) {
                    mal_vm_throw_allocation_error(vm);
                    ok = false;
                    break;
                }
                active = grown_active;
                active_root.slots = active;
            }
            frames[depth] = (MalLiteralBuildFrame) {
                .container = child,
                .remaining = child_count,
                .next_index = 0,
                .is_object = child_object,
            };
            active[depth] = child;
            depth++;
            active_root.count = (i32) depth;
        }

        if ((++built & 1023u) == 0 && mal_gc_poll) {
            mal_gc_safepoint(vm);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                ok = false;
                break;
            }
        }
    }

    if (!ok) {
        if (vm->completion.kind != MAL_COMPLETION_THROW)
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid literal template");
        result = mal_value_new_undefined();
    }
    if (ok && cache_slot >= 0 && cursor.pos - (u32) template_offset <= MAL_LITERAL_CACHE_MAX_WORDS) {
        MalLiteralCacheEntry *entry = &vm->literal_cache_entries[vm->literal_cache_cursor];
        // Private instances carry no observable identity; active receivers remain independently rooted.
        if (vm->literal_cache_count == MAL_LITERAL_CACHE_CAPACITY) {
#if MAL_REALMS
            entry->realm->globals[entry->slot] = MAL_VALUE_UNDEFINED;
#else
            vm->globals[entry->slot] = MAL_VALUE_UNDEFINED;
#endif
        } else {
            vm->literal_cache_count++;
        }
        *entry = (MalLiteralCacheEntry) {
            .slot = cache_slot,
#if MAL_REALMS
            .realm = vm->current_realm,
#endif
        };
        vm->literal_cache_cursor = (vm->literal_cache_cursor + 1) % MAL_LITERAL_CACHE_CAPACITY;
        vm->globals[cache_slot] = result;
    }
    mal_gc_unroot(&active_root);
    mal_gc_unroot(&result_root);
    free(active);
    free(frames);
    return result;
}

void mal_op_instantiate_literal_template(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.instantiate_literal_template.dst] =
        mal_vm_instantiate_literal_template(
            callable->vm, instruction->as.instantiate_literal_template.template_offset,
            instruction->as.instantiate_literal_template.cache_slot);
}

// Every import of one module must observe the same namespace identity.
MalValue mal_vm_op_create_module_namespace(
    MalVm *vm, i32 cache_slot, i32 count, const i32 *name_indices, const i32 *slots
) {
    if (cache_slot >= 0 && !mal_value_is_undefined(vm->globals[cache_slot])) {
        return vm->globals[cache_slot];
    }
    MalModuleNamespaceExport *exports =
        count > 0 ? malloc(sizeof(MalModuleNamespaceExport) * (usize) count) : nullptr;
    if (count > 0 && exports == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    for (i32 i = 0; i < count; i++) {
        exports[i].name = &vm->runtime_image->string_constants[name_indices[i]];
        exports[i].slot = slots[i];
    }

    MalModuleNamespaceObject *ns = mal_module_namespace_object_new(&vm->heap, exports, count);
    MalValue result = mal_value_from_module_namespace_object(ns);
    if (cache_slot >= 0) vm->globals[cache_slot] = result;
    return result;
}

void mal_op_create_module_namespace(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.create_module_namespace.data_offset);
    i32 count = data[0];
    callable->registers[instruction->as.create_module_namespace.dst] = mal_vm_op_create_module_namespace(
        callable->vm,
        instruction->as.create_module_namespace.cache_slot,
        count,
        &data[1],
        &data[1 + count]
    );
}

// Build one of a tagged template's two string arrays. Each element is a frozen
// (enumerable, non-writable, non-configurable) data property; length is made
// non-writable. The array is left EXTENSIBLE so the caller can attach `.raw`
// before sealing — the caller flips extensibility off once it is done.
static MalArrayObject *mal_vm_build_template_string_array(MalVm *vm, const i32 *indices, i32 count) {
    MalArrayObject *array = mal_value_to_array_object(mal_vm_op_create_array(vm, 0));
    for (i32 i = 0; i < count; i++) {
        MalValue element = indices[i] < 0
                               ? mal_value_new_undefined()
                               : mal_value_from_string(&vm->runtime_image->string_constants[indices[i]]);
        MalKey key = mal_key_index(i);
        MalPropertyDesc desc = {.flags = MAL_PROPERTY_ENUMERABLE, .value = element};
        mal_object_define_own(&array->object, key, &desc);
    }
    mal_array_object_set_length(array, (u32) count);
    array->length_writable = false;
    return array;
}

// Shared by the interpreter op and the native backend: build (or return the
// cached) tagged-template strings object for one template site. Stable identity —
// built once, then the cached global slot is returned on every later evaluation.
// No user code runs, so it never throws.
MalValue mal_vm_op_create_template_object(
    MalVm *vm, i32 cache_slot, i32 count, const i32 *cooked_indices, const i32 *raw_indices
) {
    if (!mal_value_is_undefined(vm->globals[cache_slot])) {
        return vm->globals[cache_slot];
    }

    MalArrayObject *raw = mal_vm_build_template_string_array(vm, raw_indices, count);
    mal_object_set_extensible(&raw->object, false);

    MalArrayObject *cooked = mal_vm_build_template_string_array(vm, cooked_indices, count);

    // `raw` is a frozen, non-enumerable own property of the cooked array; attach
    // it before sealing the cooked array (a non-extensible object rejects it).
    MalKey raw_key = mal_intrinsic_string_key(vm, "raw");
    MalPropertyDesc raw_desc = {.flags = MAL_PROPERTY_NONE, .value = mal_value_from_array_object(raw)};
    mal_object_define_own(&cooked->object, raw_key, &raw_desc);
    mal_object_set_extensible(&cooked->object, false);

    MalValue result = mal_value_from_array_object(cooked);
    vm->globals[cache_slot] = result;
    return result;
}

void mal_op_create_template_object(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.create_template_object.data_offset);
    i32 count = data[0];
    callable->registers[instruction->as.create_template_object.dst] = mal_vm_op_create_template_object(
        callable->vm,
        instruction->as.create_template_object.cache_slot,
        count,
        &data[1],
        &data[1 + count]
    );
}

// Spec HasBinding for a `with` object environment record: HasProperty(O, P)
// filtered through O[@@unscopables] (a truthy entry hides the binding). A
// primitive with-expression provides nothing (no wrapper objects yet).
static bool mal_vm_with_has_binding(MalVm *vm, MalValue object, MalKey key) {
    if (!mal_value_is_object(object)) {
        return false;
    }
    if (!mal_vm_has_property(vm, object, key)) {
        return false;
    }

    MalKey unscopables_key = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_UNSCOPABLES);
    MalValue unscopables;
    if (mal_vm_get_property(vm, object, unscopables_key, &unscopables) &&
        mal_value_is_object(unscopables)) {
        MalValue blocked;
        if (mal_vm_get_property(vm, unscopables, key, &blocked) && mal_value_to_boolean(blocked)) {
            return false;
        }
    }
    return true;
}

// Shared by the interpreter op and the native backend: WithBaseObject. Returns a
// new `with` object environment record linked onto `parent` (the caller assigns it
// to its `env`), or null with a pending TypeError if the with-expression is null or
// undefined. Placing the with-object on the env chain (rather than a frame-local
// stack) means a closure created in the body captures it via its creation_env.
MalEnv *mal_vm_op_with_enter(MalVm *vm, MalEnv *parent, MalValue object) {
    if (mal_value_is_nil(object)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object"
        );
        return nullptr;
    }
    return mal_env_new_with_object(vm, parent, object);
}

void mal_op_with_enter(MalCallable *callable, const MalInstruction *instruction) {
    MalValue object = callable->registers[instruction->as.with_enter.object];
    MalEnv *env = mal_vm_op_with_enter(callable->vm, callable->env, object);
    if (env != nullptr) {
        callable->env = env;
    }
}

void mal_op_with_exit(MalCallable *callable, const MalInstruction *instruction) {
    (void) instruction;
    // Pop the with object environment record pushed by the matching WITH_ENTER.
    callable->env = callable->env->parent;
}

// Shared by the interpreter op and the native backend: resolve a name against the
// `with` object environment records on the env chain (innermost first). Returns the
// bound value, or the EMPTY sentinel on a miss (the compiled/interpreted fallback
// then reads the static binding). A getter / @@unscopables probe can throw; callers
// check the completion.
MalValue mal_vm_op_with_get(MalVm *vm, MalEnv *env, i32 name_string_index) {
    MalValue name = mal_value_from_string(&vm->runtime_image->string_constants[name_string_index]);
    MalKey key;
    if (mal_vm_value_to_property_key(vm, name, &key)) {
        for (MalEnv *e = env; e != nullptr; e = e->parent) {
            if (e->function_index != MAL_ENV_WITH_OBJECT) {
                continue;
            }
            MalValue object = e->slots[0];
            if (mal_vm_with_has_binding(vm, object, key)) {
                MalValue value;
                if (!mal_vm_get_property(vm, object, key, &value)) {
                    value = mal_value_new_undefined();
                }
                return value;
            }
        }
    }
    // Miss: the EMPTY sentinel tells the caller to use the static binding.
    return mal_value_new_empty();
}

void mal_op_with_get(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.with_get.dst] = mal_vm_op_with_get(
        callable->vm, callable->env, instruction->as.with_get.name_string_index
    );
}

// Shared: resolve the reference BASE (the with-object itself, not its value) so the
// caller reads/writes the property through it. EMPTY sentinel on a miss.
MalValue mal_vm_op_with_resolve_base(MalVm *vm, MalEnv *env, i32 name_string_index) {
    MalValue name = mal_value_from_string(&vm->runtime_image->string_constants[name_string_index]);
    MalKey key;
    if (mal_vm_value_to_property_key(vm, name, &key)) {
        for (MalEnv *e = env; e != nullptr; e = e->parent) {
            if (e->function_index != MAL_ENV_WITH_OBJECT) {
                continue;
            }
            MalValue object = e->slots[0];
            if (mal_vm_with_has_binding(vm, object, key)) {
                return object;
            }
        }
    }
    // Miss: the EMPTY sentinel tells the caller to use the static binding.
    return mal_value_new_empty();
}

void mal_op_with_resolve_base(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.with_resolve_base.dst] = mal_vm_op_with_resolve_base(
        callable->vm, callable->env, instruction->as.with_resolve_base.name_string_index
    );
}

// Shared: assign to a name found on a with-object environment record. Returns
// whether a binding was found (a miss lets the caller fall back to the static
// binding). `with` is sloppy-only, so a rejected set silently no-ops.
//
// Direct eval's marshaled scope carries a second env slot: a dirty tracker,
// keyed the same as the scope object, that records real Set evidence for its
// caller's writeback (rather than the caller inferring "was this assigned"
// from value equality, which is wrong for NaN and for a same-value Set through
// an accessor). Ordinary `with` env records have slot_count 1, so this is a
// no-op for them.
bool mal_vm_op_with_set(MalVm *vm, MalEnv *env, i32 name_string_index, MalValue value) {
    MalValue name = mal_value_from_string(&vm->runtime_image->string_constants[name_string_index]);
    MalKey key;
    if (mal_vm_value_to_property_key(vm, name, &key)) {
        for (MalEnv *e = env; e != nullptr; e = e->parent) {
            if (e->function_index != MAL_ENV_WITH_OBJECT) {
                continue;
            }
            MalValue object = e->slots[0];
            if (mal_vm_with_has_binding(vm, object, key)) {
                mal_vm_set_property(vm, object, key, value, object);
                if (e->slot_count > 1 && mal_value_is_object(e->slots[1])) {
                    mal_vm_set_property(
                        vm, e->slots[1], key, mal_value_new_boolean(true), e->slots[1]);
                }
                return true;
            }
        }
    }
    return false;
}

void mal_op_with_set(MalCallable *callable, const MalInstruction *instruction) {
    bool found = mal_vm_op_with_set(
        callable->vm, callable->env, instruction->as.with_set.name_string_index,
        callable->registers[instruction->as.with_set.value]
    );
    callable->registers[instruction->as.with_set.found] = mal_value_new_boolean(found);
}

void mal_op_is_empty(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.is_empty.dst] =
        mal_value_new_boolean(mal_value_is_empty(callable->registers[instruction->as.is_empty.src]));
}

void mal_op_create_undefined(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
}

void mal_op_create_empty(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_empty.dst] = mal_value_new_empty();
}

// Shared by the interpreter op and the native (render-native-c) backend: throw a
// ReferenceError naming the binding when `value` is the uninitialized sentinel.
// A no-op (no completion change) otherwise; callers check vm->completion.
void mal_vm_op_throw_if_tdz(MalVm *vm, MalValue value, i32 name_string_index) {
    if (mal_value_is_empty(value)) {
        MalString *constant = &vm->runtime_image->string_constants[name_string_index];
        MalValue message = mal_vm_add(
            vm, mal_value_from_string(constant),
            mal_value_from_string(mal_intrinsic_ascii(vm, "' before initialization")));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }
        message = mal_vm_add(
            vm, mal_value_from_string(mal_intrinsic_ascii(vm, "Cannot access '")), message);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }
        mal_vm_throw_error_value(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, message);
    }
}

void mal_op_throw_if_tdz(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_throw_if_tdz(
        callable->vm,
        callable->registers[instruction->as.throw_if_tdz.src],
        instruction->as.throw_if_tdz.name_string_index
    );
}

void mal_op_create_null(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_null.dst] = mal_value_new_null();
}

MalValue mal_vm_op_create_function(MalVm *vm, i32 function_index, MalEnv *creation_env) {
    // Generator/async-generator function objects inherit their respective
    // %GeneratorFunction.prototype% / %AsyncGenerator%.
    MalIntrinsic prototype_slot;
    switch (vm->runtime_image->functions[function_index].kind) {
        case MAL_FUNCTION_KIND_GENERATOR:
            prototype_slot = MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE;
            break;
        case MAL_FUNCTION_KIND_ASYNC_GENERATOR:
            prototype_slot = MAL_INTRINSIC_ASYNC_GENERATOR_FUNCTION_PROTOTYPE;
            break;
        case MAL_FUNCTION_KIND_ASYNC:
            prototype_slot = MAL_INTRINSIC_ASYNC_FUNCTION_PROTOTYPE;
            break;
        default:
            prototype_slot = MAL_INTRINSIC_FUNCTION_PROTOTYPE;
            break;
    }

    const MalFunction *definition = &vm->runtime_image->functions[function_index];
    MalString *name = definition->name_string_index >= 0 &&
            definition->name_string_index < vm->runtime_image->string_constant_count
        ? &vm->runtime_image->string_constants[definition->name_string_index]
        : mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY);
    MalFunctionObject *function = mal_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        function_index,
        definition->length,
        name,
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH),
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NAME)
    );
    // The closure captures the creating frame's environment chain so its body
    // resolves captured bindings by owner function index.
    function->creation_env = creation_env;

    return mal_value_from_function_object(function);
}

void mal_op_create_function(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_function.dst] = mal_vm_op_create_function(
        callable->vm,
        instruction->as.create_function.function_index,
        callable->env
    );
}

// SetFunctionName(func, key): give an anonymous function/class value a `name` own
// data property derived from a computed property key (spec NamedEvaluation): a
// String key names it directly, a Symbol key names it "[description]" (or "" when
// the symbol has no description). Redefines the "" name set at CREATE_FUNCTION
// (configurable), matching { writable:false, enumerable:false, configurable:true }.
// Shared by the interpreter op and the native backend: SetFunctionName(func, key,
// prefix) — install the "name" own data property. `key` is an already-evaluated
// property key (string/number/symbol), so no @@toPrimitive re-entry; only an
// over-limit assembled name can throw.
void mal_vm_op_set_function_name(MalVm *vm, MalValue func, MalValue key, u8 prefix) {
    if (!mal_value_is_object(func)) {
        return;
    }

    MalValue name_value;
    if (mal_value_is_symbol(key)) {
        MalString *description = mal_symbol_description(mal_value_to_symbol(key));
        if (description == nullptr) {
            name_value = mal_value_from_string(mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY));
        } else {
            name_value = mal_vm_add(
                vm, mal_value_from_string(description),
                mal_value_from_string(mal_intrinsic_ascii(vm, "]")));
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return;
            }
            name_value = mal_vm_add(
                vm, mal_value_from_string(mal_intrinsic_ascii(vm, "[")), name_value);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return;
            }
        }
    } else {
        // String / numeric-index key: its string form (the key is already an
        // evaluated primitive property key, so no @@toPrimitive re-entry).
        name_value = mal_value_from_string(mal_ops_to_string(&vm->heap, key));
    }

    // A getter/setter prefixes the name with "get "/"set " (SetFunctionName's
    // prefix), so `get [sym]` names the function "get [desc]".
    if (prefix != 0) {
        const char *text = prefix == 1 ? "get " : "set ";
        name_value = mal_vm_add(
            vm, mal_value_from_string(mal_intrinsic_ascii(vm, text)), name_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }
    }

    MalPropertyDesc name_desc = mal_intrinsic_data_desc(name_value, MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(mal_value_to_object(func), mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NAME), &name_desc);
}

void mal_op_set_function_name(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_set_function_name(
        callable->vm,
        callable->registers[instruction->as.set_function_name.func],
        callable->registers[instruction->as.set_function_name.key],
        instruction->as.set_function_name.prefix
    );
}

// Walk the environment chain to the activation that owns the captured binding
// and read its slot. Shared by the interpreter op and the native-C backend.
MalValue mal_vm_load_captured(MalEnv *env, i32 owner_function_index, i32 index) {
    for (; env != nullptr; env = env->parent) {
        if (env->function_index == owner_function_index) {
            return env->slots[index];
        }
    }

    return mal_value_new_undefined();
}

void mal_vm_store_captured(MalEnv *env, i32 owner_function_index, i32 index, MalValue value) {
    for (; env != nullptr; env = env->parent) {
        if (env->function_index == owner_function_index) {
            mal_gc_write_barrier(env->slots[index]); // SATB: shade the replaced capture
            env->slots[index] = value;
            mal_gc_card(&env->header, value); // old closure env -> young capture
            return;
        }
    }
}

void mal_op_load_captured(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_captured.dst] = mal_vm_load_captured(
        callable->env,
        instruction->as.load_captured.owner_function_index,
        instruction->as.load_captured.index
    );
}

void mal_op_guard_function_index(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.guard_function_index.dst] = mal_value_new_boolean(
        mal_vm_callee_has_index(
            callable->vm,
            callable->registers[instruction->as.guard_function_index.callee],
            instruction->as.guard_function_index.function_index
        )
    );
}

void mal_op_guard_base_constructor_layout(
    MalCallable *callable, const MalInstruction *instruction
) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.guard_base_constructor_layout.data_offset);
    callable->registers[instruction->as.guard_base_constructor_layout.dst] =
        mal_value_new_boolean(mal_vm_guard_base_constructor_layout(
            callable->vm,
            callable->registers[instruction->as.guard_base_constructor_layout.callee],
            instruction->as.guard_base_constructor_layout.function_index,
            data[0], &data[2], mal_vm_property_ic_at(callable, data[1])));
}

void mal_op_store_captured(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_store_captured(
        callable->env,
        instruction->as.store_captured.owner_function_index,
        instruction->as.store_captured.index,
        callable->registers[instruction->as.store_captured.src]
    );
}

// Enter a per-iteration loop scope: a fresh env whose parent is the current env,
// tagged with the synthetic scope id, becomes the activation's capture env.
void mal_op_env_push(MalCallable *callable, const MalInstruction *instruction) {
    callable->env = mal_env_new(
        callable->vm, callable->env, instruction->as.env_scope.scope_id, instruction->as.env_scope.slot_count
    );
}

// Copy the loop bindings forward into a fresh sibling env (same parent as the
// current scope env), per CreatePerIterationEnvironment. The old env stays alive
// for any closures that captured it this iteration.
void mal_op_env_copy(MalCallable *callable, const MalInstruction *instruction) {
    MalEnv *old = callable->env;
    i32 slot_count = instruction->as.env_scope.slot_count;
    MalEnv *fresh = mal_env_new(callable->vm, old->parent, instruction->as.env_scope.scope_id, slot_count);
    for (i32 i = 0; i < slot_count; i++) {
        fresh->slots[i] = old->slots[i];
    }
    callable->env = fresh;
}

// Leave the loop scope: restore the enclosing env.
void mal_op_env_pop(MalCallable *callable) {
    callable->env = callable->env->parent;
}

// Build an arguments object over `args`: an array
// of the call arguments plus an own @@iterator (%Array.prototype.values%) and a
// `callee` slot — poisoned for an unmapped object, otherwise exposing the
// function. Shared by the interpreter op and compiled code.
MalValue mal_create_arguments_object(
    MalVm *vm, const MalValue *args, i32 arg_count, MalValue callee, MalEnv *env,
    bool mapped, i32 mapped_argument_count, const i32 *mapped_argument_slots
) {
    // The arguments object is an ordinary object whose [[Prototype]] is
    // %Object.prototype% (CreateUnmappedArgumentsObject step 2 / mapped step 8) —
    // not %Array.prototype% and not null. It must NOT be an Array exotic: its
    // `length` is an ordinary data property (writable, non-enumerable,
    // configurable), so `arguments[i] = v` for i >= length adds an indexed
    // property WITHOUT changing length (unlike an array's magic length), and
    // Array.isArray(arguments) is false.
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *arguments = mapped
        ? (MalObject *) mal_arguments_object_new(
            &vm->heap, prototype, env, mapped_argument_slots,
            mapped_argument_count, arg_count)
        : mal_object_new(&vm->heap, prototype);
    arguments->is_arguments = true;

    // Indexed args first (enumerable, writable, configurable data properties)...
    for (i32 i = 0; i < arg_count; i++) {
        mal_object_set(
            arguments,
            mal_key_index(i),
            args[i]
        );
    }

    // ...then the own `length` data property: writable + configurable, but
    // non-enumerable (CreateUnmappedArgumentsObject step 4 / mapped step 22).
    MalPropertyDesc length_desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_from_i32(arg_count),
    };
    mal_object_define_own(arguments, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH), &length_desc);

    // Make the arguments object iterable: an own @@iterator = %Array.prototype.values%
    // (spec CreateUnmappedArgumentsObject), non-enumerable/writable/configurable.
    MalKey iterator_key = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR);
    MalValue array_values;
    if (mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE], iterator_key, &array_values)) {
        MalPropertyDesc iterator_desc = {
            .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE,
            .value = array_values,
        };
        mal_object_define_own((MalObject *) arguments, iterator_key, &iterator_desc);
    }

    // `callee`: an unmapped (strict) arguments object poisons it with
    // %ThrowTypeError% (non-enumerable, non-configurable); a mapped (sloppy)
    // one exposes the function as a writable, configurable data property.
    MalKey callee_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_CALLEE);
    if (!mapped) {
        MalValue thrower = vm->intrinsics[MAL_INTRINSIC_THROW_TYPE_ERROR];
        MalPropertyDesc callee_desc = {
            .flags = MAL_PROPERTY_ACCESSOR,
            .value = mal_value_new_undefined(),
            .getter = thrower,
            .setter = thrower,
        };
        mal_object_define_own(arguments, callee_key, &callee_desc);
    } else if (mal_value_is_callable(callee)) {
        MalPropertyDesc callee_desc = {
            .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE,
            .value = callee,
        };
        mal_object_define_own(arguments, callee_key, &callee_desc);
    }

    return mal_value_from_object(arguments);
}

void mal_op_create_arguments_object(MalCallable *callable, const MalInstruction *instruction) {
    if (!mal_value_is_undefined(callable->arguments_object)) {
        callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
        return;
    }

    callable->arguments_object = mal_create_arguments_object(
        callable->vm, callable->arguments, callable->argument_count,
        callable->callee, callable->env, callable->function->mapped_arguments,
        callable->function->mapped_argument_count,
        callable->function->mapped_argument_slots
    );
    callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
}

void mal_op_load_argument_count(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_argument_count.dst] =
        mal_value_from_i32(callable->argument_count);
}

void mal_op_load_argument(MalCallable *callable, const MalInstruction *instruction) {
    i32 index = instruction->as.load_argument.index;
    callable->registers[instruction->as.load_argument.dst] = index >= 0 && index < callable->argument_count
        ? callable->arguments[index]
        : mal_value_new_undefined();
}

void mal_op_load_static_argument(MalCallable *callable, const MalInstruction *instruction) {
    i32 index = instruction->as.load_static_argument.index;
    i32 direct = instruction->as.load_static_argument.direct;
    MalValue fallback = callable->registers[instruction->as.load_static_argument.fallback];
    if (index < callable->argument_count) {
        callable->registers[instruction->as.load_static_argument.dst] = direct >= 0
            ? callable->registers[direct]
            : callable->arguments[index];
        return;
    }

    if (mal_value_is_undefined(fallback)) {
        if (mal_value_is_undefined(callable->arguments_object)) {
            callable->arguments_object = mal_create_arguments_object(
                callable->vm, callable->arguments, callable->argument_count,
                callable->callee, callable->env, callable->function->mapped_arguments,
                callable->function->mapped_argument_count,
                callable->function->mapped_argument_slots
            );
        }
        fallback = callable->arguments_object;
    }
    callable->registers[instruction->as.load_static_argument.fallback] = fallback;
    callable->registers[instruction->as.load_static_argument.dst] = mal_vm_op_load_property(
        callable->vm, fallback, mal_value_from_i32(index)
    );
}

void mal_op_load_this(MalCallable *callable, const MalInstruction *instruction) {
    // GetThisBinding: `this` in a derived constructor is in a TDZ until super()
    // binds it. Reading it (directly, or as the receiver of a super property
    // reference) before then is a ReferenceError.
    if (mal_value_is_empty(callable->this_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
            "Must call super constructor in derived class before accessing 'this'");
        return;
    }
    callable->registers[instruction->as.load_this.dst] = callable->this_value;
}

void mal_op_load_new_target(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_new_target.dst] = callable->new_target;
}

void mal_op_load_callee(MalCallable *callable, const MalInstruction *instruction) {
    // The function object that pushed this frame — used to initialize a named
    // function expression's own-name binding to the closure.
    callable->registers[instruction->as.load_callee.dst] = callable->callee;
}

/**
 * A bound function's combined arguments aren't the region the caller marshaled
 * at `base`, so replace that region with them in place — restoring the calling
 * convention (args are the top arg_count slots) before the frame is pushed.
 * Leaves a pending RangeError (and the stack reset to base) on overflow.
 */
static void mal_vm_remarshal_bound_args(MalVm *vm, i32 base, const MalBoundResolution *resolution) {
    if (!resolution->args_merged) {
        return;
    }

    vm->value_stack_size = base;
    if (base + resolution->arg_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    for (i32 i = 0; i < resolution->arg_count; i++) {
        vm->value_stack[base + i] = resolution->args[i];
    }
    vm->value_stack_size = base + resolution->arg_count;
}

static MalInterpCallCacheEntry *mal_vm_interp_call_cache_entry(
    MalVm *vm, i32 caller_function_index, i32 call_ip
) {
    if (vm->interp_call_cache == nullptr) {
        vm->interp_call_cache = calloc(
            (usize) MAL_INTERP_CALL_CACHE_SIZE,
            sizeof(MalInterpCallCacheEntry));
        MAL_PERF_COUNT(interp_call_cache_allocations);
    }
    u32 hash = (u32) caller_function_index * 2654435761u ^ (u32) call_ip;
    hash ^= hash >> 16;
    return &vm->interp_call_cache[hash & (MAL_INTERP_CALL_CACHE_SIZE - 1u)];
}

static bool mal_vm_try_interp_call_targets(
    MalVm *vm, i32 exact_function_index,
    const i32 *guarded_function_indices, i32 guarded_function_count, MalValue callee,
    MalValue this_value, i32 base, i32 argument_count, i32 dst
) {
    if (!mal_value_is_function_object(callee)) {
        return false;
    }
    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    i32 actual_function_index = mal_function_object_function_index(function_object);
    i32 expected_function_index = -1;
    if (exact_function_index == actual_function_index) {
        expected_function_index = exact_function_index;
    } else {
        for (i32 i = 0; i < guarded_function_count; i++) {
            if (guarded_function_indices[i] == actual_function_index) {
                expected_function_index = actual_function_index;
                break;
            }
        }
    }
    if (expected_function_index < 0 ||
        expected_function_index >= vm->runtime_image->function_count) {
        return false;
    }

    const MalFunction *function = &vm->runtime_image->functions[expected_function_index];
    if (function->compiled != nullptr || function->is_class_constructor) {
        i32 caller_frame_index = vm->frame_count - 1;
        MalCompletion completion = mal_vm_call_exact_script(
            vm, expected_function_index, callee, this_value,
            &vm->value_stack[base], argument_count);
        if (completion.kind == MAL_COMPLETION_NORMAL) {
            vm->frames[caller_frame_index].registers[dst] = completion.value;
        }
        vm->value_stack_size = base;
        return true;
    }

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
    if (mal_vm_push_function_frame(
            vm, expected_function_index,
            mal_value_to_function_object(callee)->creation_env, this_value,
            argument_count, dst, vm->frame_count - 1)) {
        vm->frames[vm->frame_count - 1].callee = callee;
    } else {
        vm->value_stack_size = base;
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
    }
    return true;
}

static bool mal_vm_try_interp_construct_exact(
    MalVm *vm, i32 expected_function_index, MalValue callee,
    i32 base, i32 argument_count, i32 dst
) {
    if (expected_function_index < 0 ||
        expected_function_index >= vm->runtime_image->function_count ||
        !mal_value_is_function_object(callee)) {
        return false;
    }
    MalFunctionObject *function_object = mal_value_to_function_object(callee);
    if (mal_function_object_function_index(function_object) != expected_function_index) {
        return false;
    }
    const MalFunction *function = &vm->runtime_image->functions[expected_function_index];
    if (function->compiled != nullptr) {
        i32 caller_frame_index = vm->frame_count - 1;
        MalCompletion completion = mal_vm_construct_direct(
            vm, expected_function_index, callee,
            &vm->value_stack[base], argument_count);
        if (completion.kind == MAL_COMPLETION_NORMAL) {
            vm->frames[caller_frame_index].registers[dst] = completion.value;
        }
        vm->value_stack_size = base;
        return true;
    }
    if (function->kind != MAL_FUNCTION_KIND_NORMAL || !function->has_prototype) {
        return false;
    }

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
    MalValue this_value;
    if (function->is_derived_constructor) {
        this_value = mal_value_new_empty();
    } else {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, callee, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
            vm->value_stack_size = base;
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            return true;
        }
        this_value = mal_value_from_object(mal_object_new_reserved(
            &vm->heap, prototype, function->constructor_slot_reserve));
    }

    if (mal_vm_push_function_frame(
            vm, expected_function_index,
            mal_value_to_function_object(callee)->creation_env, this_value,
            argument_count, dst, vm->frame_count - 1)) {
        MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
        frame->is_construct = true;
        frame->callee = callee;
        frame->new_target = callee;
    } else {
        vm->value_stack_size = base;
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
    }
    return true;
}

MalPropertyStubEntry *mal_vm_property_stub_cache(MalVm *vm) {
    if (vm->property_stub == nullptr) {
        vm->property_stub = calloc(
            (usize) MAL_STUB_CACHE_SIZE, sizeof(MalPropertyStubEntry));
        MAL_PERF_COUNT(property_stub_cache_allocations);
    }
    return vm->property_stub;
}

MalInlineCache *mal_vm_inherited_property_stub_cache(MalVm *vm) {
    if (vm->inherited_property_stub == nullptr) {
        vm->inherited_property_stub = calloc(
            (usize) MAL_INHERITED_STUB_CACHE_SIZE, sizeof(MalInlineCache));
        MAL_PERF_COUNT(inherited_property_stub_cache_allocations);
        MAL_PERF_ADD(
            inherited_property_stub_cache_bytes,
            (u64) MAL_INHERITED_STUB_CACHE_SIZE * sizeof(MalInlineCache));
    }
    return vm->inherited_property_stub;
}

/**
 * Shared cold handler for a compiled static-name site's second-level inherited
 * or missing-chain row. The emitted always-inline prefix has already rejected
 * its local own/inherited/special handlers. Keeping full chain and table-handle
 * validation here avoids cloning it into every generated property access.
 */
bool mal_vm_inherited_stub_try_load_static(
    const MalVm *vm, MalValue receiver, const MalObject *object,
    const MalInlineCache *site, MalValue *out
) {
    if (object == nullptr || vm->inherited_property_stub == nullptr ||
        site->mode != MAL_IC_MODE_SHAPE || site->shape == nullptr ||
        site->slot == MAL_IC_VALUE_SLOT) {
        return false;
    }
    const MalInlineCache *stub =
        &vm->inherited_property_stub[mal_inherited_stub_hash(
            object->shape, object->prototype, site->key)];
    return mal_vm_inherited_try_load(receiver, site->key, stub, out);
}

/**
 * Enter a cached plain interpreted function through the same realm/frame seam as
 * the generic dispatcher. No collectable pointer is retained by the cache: the
 * closure environment is read from the exact live callee after the epoch guard.
 */
static bool mal_vm_try_interp_call_cached(
    MalVm *vm, i32 caller_function_index, i32 call_ip, MalValue callee,
    MalValue this_value, i32 base, i32 argument_count, i32 dst
) {
    u32 heap_epoch = vm->heap.epoch;
    MalInterpCallCacheEntry *entry = mal_vm_interp_call_cache_entry(
        vm, caller_function_index, call_ip);
    if (entry->heap_epoch != heap_epoch ||
        entry->caller_function_index != caller_function_index ||
        entry->call_ip != call_ip || entry->callee != callee ||
        entry->callee_function_index < 0) {
        return false;
    }

    // Fill admits only an ordinary direct interpreted function. Exact identity in
    // the same epoch means this is still that live function object and its index is
    // immutable.
    i32 function_index = entry->callee_function_index;
    MalFunctionObject *function_object = mal_value_to_function_object(callee);

#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, callee));
#endif
    if (mal_vm_push_function_frame(
            vm, function_index, function_object->creation_env, this_value,
            argument_count, dst, vm->frame_count - 1)) {
        vm->frames[vm->frame_count - 1].callee = callee;
    } else {
        vm->value_stack_size = base;
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
    }
    return true;
}

static void mal_vm_fill_interp_call_cache(
    MalVm *vm, i32 caller_function_index, i32 call_ip, MalValue callee
) {
    if (!mal_value_is_function_object(callee)) {
        return;
    }
    i32 function_index = mal_function_object_function_index(mal_value_to_function_object(callee));
    if (function_index < 0 || function_index >= vm->runtime_image->function_count ||
        vm->runtime_image->functions[function_index].compiled != nullptr ||
        vm->runtime_image->functions[function_index].is_class_constructor) {
        return;
    }

    u32 heap_epoch = vm->heap.epoch;
    MalInterpCallCacheEntry *entry = mal_vm_interp_call_cache_entry(
        vm, caller_function_index, call_ip);
    *entry = (MalInterpCallCacheEntry) {
        .callee = callee,
        .caller_function_index = caller_function_index,
        .call_ip = call_ip,
        .callee_function_index = function_index,
        .heap_epoch = heap_epoch,
    };
}

/**
 * Shared call dispatch: bound resolution, then script frame push or native
 * invocation. The arguments occupy the top `argument_count` value-stack slots
 * starting at `base`. The result register lives on the frame that was current
 * when the dispatch started.
 */
static void mal_vm_call_dispatch(MalVm *vm, MalValue callee, MalValue this_value, i32 base, i32 argument_count, i32 dst) {
    // A callable proxy routes [[Call]] through its apply trap. Snapshot the
    // caller frame by index — the trap may relocate the frame array.
    if (mal_value_is_proxy_object(callee)) {
        i32 caller_frame_index = vm->frame_count - 1;
        MalCompletion completion = mal_proxy_apply(vm, mal_value_to_proxy_object(callee), this_value, &vm->value_stack[base], argument_count);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
        } else {
            vm->frames[caller_frame_index].registers[dst] = completion.value;
        }
        vm->value_stack_size = base;
        return;
    }

    MalValue inline_args[MAL_BOUND_INLINE_ARGS];
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        callee, this_value, &vm->value_stack[base], argument_count, true,
        inline_args, countof(inline_args));

    if (mal_value_is_function_object(resolution.callee)) {
        mal_vm_remarshal_bound_args(vm, base, &resolution);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
            const MalFunction *function = &vm->runtime_image->functions[function_index];
            MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

#if MAL_REALMS
            // Enter the callee's realm for the body. The compiled arm restores before
            // returning to the caller frame; the interpreted arm keeps it entered and
            // lets the shared loop restore the caller's realm when the pushed frame
            // (stamped with this realm) returns or unwinds.
            MalRealm *saved_realm = vm->current_realm;
            mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif
            if (!mal_vm_require_ordinary_call_target(vm, function)) {
                vm->value_stack_size = base;
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
            } else if (function->compiled != nullptr) {
                // Native-backend function: invoke directly, no bytecode frame.
                // The C stack, not the value stack, bounds this recursion.
                i32 caller_frame_index = vm->frame_count - 1;
                MalValue result = mal_value_new_undefined();
                if (mal_vm_enter_compiled(vm, function_index)) {
                    MalValue this_value = mal_vm_callee_this(vm, function, resolution.this_value);
                    result = function->compiled(vm, this_value, &vm->value_stack[base], resolution.arg_count, mal_value_new_undefined(), env, resolution.callee, nullptr);
                    mal_vm_leave_compiled(vm);
                }
                vm->frames[caller_frame_index].registers[dst] = result;
                vm->value_stack_size = base;
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
            } else if (mal_vm_push_function_frame(vm, function_index, env, resolution.this_value, resolution.arg_count, dst, vm->frame_count - 1)) {
                vm->frames[vm->frame_count - 1].callee = resolution.callee;
            } else {
                vm->value_stack_size = base;
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
            }
        }
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionObject *native_function =
            mal_value_to_native_function_object(resolution.callee);
        MAL_PROFILE_NATIVE_CALL(vm, native_function);
        MalNativeFunctionCallback callback =
            mal_native_function_object_callback(native_function);
        // The callback may push frames and realloc the frame array, which
        // invalidates any frame pointers. Snapshot what we need and
        // re-resolve the frame afterwards.
        i32 caller_frame_index = vm->frame_count - 1;
        // A native builtin holds MalValue scratch in C locals the root scan
        // cannot see, and many re-enter JS for callbacks; count it as a live C
        // frame so a safepoint inside it does not collect (see gc_native_frames).
        // The receiver/args/new.target are rooted so a builtin that lifts that
        // suppression itself cannot lose them to a collection.
        MalCalleeRoots ncr;
        mal_gc_callee_roots_begin(&ncr, resolution.this_value, mal_value_new_undefined(),
                                  resolution.callee, resolution.args, resolution.arg_count);
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif
        vm->gc_native_frames++;
        MalValue result = callback(vm, resolution.this_value, resolution.args, resolution.arg_count, mal_value_new_undefined(), resolution.callee);
        vm->gc_native_frames--;
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
        mal_gc_callee_roots_end(&ncr);
        vm->frames[caller_frame_index].registers[dst] = result;
        vm->value_stack_size = base;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
        vm->value_stack_size = base;
    }

    free(resolution.owned_args);
}

/**
 * Shared construct dispatch, mirroring mal_vm_call_dispatch.
 */
static void mal_vm_construct_dispatch(MalVm *vm, MalValue callee, i32 base, i32 argument_count, i32 dst) {
    // A constructable proxy routes [[Construct]] through its construct trap, with
    // newTarget = the proxy itself (the spec forwards the proxy as new.target).
    if (mal_value_is_proxy_object(callee)) {
        i32 caller_frame_index = vm->frame_count - 1;
        MalCompletion completion = mal_proxy_construct(vm, mal_value_to_proxy_object(callee), &vm->value_stack[base], argument_count, callee);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
        } else {
            vm->frames[caller_frame_index].registers[dst] = completion.value;
        }
        vm->value_stack_size = base;
        return;
    }

    // The bound this is ignored when constructing.
    MalValue inline_args[MAL_BOUND_INLINE_ARGS];
    MalBoundResolution resolution = mal_bound_function_object_resolve(
        callee, mal_value_new_undefined(), &vm->value_stack[base], argument_count,
        false, inline_args, countof(inline_args));

    if (mal_value_is_function_object(resolution.callee)) {
        i32 callee_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        const MalFunction *callee_fn = &vm->runtime_image->functions[callee_index];
        if (callee_fn->kind != MAL_FUNCTION_KIND_NORMAL || !callee_fn->has_prototype) {
            // Not a constructor: generators/async (non-normal kind) and, among
            // normal-kind functions, methods/getters/setters/arrows (no prototype).
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            vm->value_stack_size = base;
            free(resolution.owned_args);
            return;
        }

        mal_vm_remarshal_bound_args(vm, base, &resolution);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(resolution.owned_args);
            return;
        }

        const MalFunction *function = &vm->runtime_image->functions[callee_index];

#if MAL_REALMS
        // Enter the constructor's realm BEFORE allocating the default `this`, so a
        // base constructor's instance is built from the constructor realm's
        // %Object.prototype%. The compiled arm restores before returning; the
        // interpreted arm keeps it entered and lets the shared loop restore the
        // caller's realm when the pushed construct frame returns or unwinds. Bound
        // resolution and remarshaling above ran in the caller realm.
        MalRealm *saved_realm = vm->current_realm;
        mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif

        // A derived constructor's `this` is uninitialized (the EMPTY sentinel)
        // until super() binds it; a base constructor gets `this` created from the
        // callee's prototype property (OrdinaryCreateFromConstructor).
        MalValue this_value;
        if (function->is_derived_constructor) {
            this_value = mal_value_new_empty();
        } else {
            MalObject *prototype;
            if (!mal_vm_get_prototype_from_constructor(
                    vm, resolution.callee, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
                vm->value_stack_size = base;
#if MAL_REALMS
                mal_vm_realm_switch_to(vm, saved_realm);
#endif
                free(resolution.owned_args);
                return;
            }
            this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        }
        MalEnv *env = mal_value_to_function_object(resolution.callee)->creation_env;

        if (function->compiled != nullptr) {
            // Native-backend constructor: invoke directly with the allocated
            // `this` and new_target = the constructor. A promoted-param guard that
            // bails reaches mal_vm_interpret_function, which re-runs as a construct
            // because new_target is an object.
            i32 caller_frame_index = vm->frame_count - 1;
            MalValue result = mal_value_new_undefined();
            if (mal_vm_enter_compiled(vm, callee_index)) {
                // The instance exists only as this_value until the body stores it,
                // so root it (plus new.target/args) for the call: a collection
                // inside the constructor would otherwise sweep it.
                MalCalleeRoots ncr;
                mal_gc_callee_roots_begin(&ncr, this_value, resolution.callee,
                                          resolution.callee, &vm->value_stack[base], resolution.arg_count);
                result = function->compiled(vm, this_value, &vm->value_stack[base], resolution.arg_count, resolution.callee, env, resolution.callee, nullptr);
                mal_gc_callee_roots_end(&ncr);
                mal_vm_leave_compiled(vm);
            }
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
            if (vm->completion.kind != MAL_COMPLETION_THROW &&
                function->is_derived_constructor) {
                if (mal_value_is_empty(result)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                        "Must call super constructor in derived class before returning from derived constructor");
                } else if (!mal_value_is_object(result)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                        "Derived constructors may only return an object or undefined");
                }
            }
            if (vm->completion.kind != MAL_COMPLETION_THROW) {
                vm->frames[caller_frame_index].registers[dst] = result;
            }
            vm->value_stack_size = base;
        } else if (mal_vm_push_function_frame(vm, callee_index, env, this_value, resolution.arg_count, dst, vm->frame_count - 1)) {
            vm->frames[vm->frame_count - 1].is_construct = true;
            // new.target is the constructor being invoked through `new`.
            vm->frames[vm->frame_count - 1].new_target = resolution.callee;
            // Realm stays entered: the pushed construct frame is stamped with it and
            // the shared loop restores the caller's realm when it returns/unwinds.
        } else {
            vm->value_stack_size = base;
#if MAL_REALMS
            mal_vm_realm_switch_to(vm, saved_realm);
#endif
        }
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        // Native constructors allocate their own this; new_target carries the
        // construct-ness signal. A native that does not implement [[Construct]]
        // (a prototype method, accessor, parseInt, …) is not new-able.
        if (!mal_native_function_object_is_constructor(mal_value_to_native_function_object(resolution.callee))) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            vm->value_stack_size = base;
            free(resolution.owned_args);
            return;
        }
        MalNativeFunctionObject *native_function =
            mal_value_to_native_function_object(resolution.callee);
        MAL_PROFILE_NATIVE_CALL(vm, native_function);
        MalNativeFunctionCallback callback =
            mal_native_function_object_callback(native_function);
        i32 caller_frame_index = vm->frame_count - 1;
        MalCalleeRoots ncr;
        mal_gc_callee_roots_begin(&ncr, mal_value_new_undefined(), resolution.callee,
                                  resolution.callee, resolution.args, resolution.arg_count);
#if MAL_REALMS
        // Native constructors allocate their own instance; enter their realm so those
        // default allocations come from it, and restore after.
        MalRealm *saved_realm = vm->current_realm;
        mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, resolution.callee));
#endif
        vm->gc_native_frames++;
        MalValue result = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count, resolution.callee, resolution.callee);
        vm->gc_native_frames--;
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
        mal_gc_callee_roots_end(&ncr);
        vm->frames[caller_frame_index].registers[dst] = result;
        vm->value_stack_size = base;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
        vm->value_stack_size = base;
    }

    free(resolution.owned_args);
}

/**
 * Marshal a spread-call array's elements onto the top of the value stack,
 * returning their count (the new top region for the call to adopt). Returns -1
 * with a pending RangeError on overflow.
 */
static i32 mal_vm_marshal_spread(MalVm *vm, MalValue array_value) {
    if (!mal_value_is_array_object(array_value)) {
        return 0;
    }

    u32 length = mal_array_object_length(mal_value_to_array_object(array_value));
    if (vm->value_stack_size + (i32) length > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return -1;
    }

    i32 base = vm->value_stack_size;
    for (u32 i = 0; i < length; i++) {
        MalValue element = mal_value_new_undefined();
        mal_builtin_array_try_get(vm, array_value, i, &element);
        vm->value_stack[base + (i32) i] = element;
    }
    vm->value_stack_size = base + (i32) length;
    return (i32) length;
}

/**
 * Marshal a single spread iterable. GetIterator is always observed first. A
 * captured builtin Array-values iterator over a fully dense Array has no
 * user-code checkpoints while it advances, so its elements can be copied
 * directly to the value stack. Every custom iterator, holey/deoptimized Array,
 * and over-capacity case follows the materializing path used by the general
 * spread lowering.
 */
static bool mal_vm_try_marshal_dense_array(
    MalVm *vm, MalArrayObject *array,
    MalIteratorObject *iterator, i32 *count_out) {
    u32 length = array->length;
    i32 available =
        vm->value_stack_capacity - vm->value_stack_size;
    bool dense = array->elements != nullptr
        && array->dense_count >= length
        && !array->dense_maybe_holey
        && length <= (u32) available;
    if (!dense) return false;

    i32 base = vm->value_stack_size;
    memcpy(
        &vm->value_stack[base], array->elements,
        (usize) length * sizeof(MalValue));
    vm->value_stack_size = base + (i32) length;
    if (iterator != nullptr) {
        iterator->index = length;
        iterator->done = true;
    }
    *count_out = (i32) length;
    return true;
}

static i32 mal_vm_marshal_spread_iterable(
    MalVm *vm, MalValue iterable) {
    MalValue method;
    if (!mal_vm_get_property(
            vm, iterable,
            mal_intrinsic_symbol_key(
                vm, MAL_INTRINSIC_SYMBOL_ITERATOR),
            &method)) {
        return -1;
    }
    if (mal_value_is_array_object(iterable)
        && mal_value_is_native_function_object(method)
        && mal_native_function_object_callback(
            mal_value_to_native_function_object(method))
            == mal_array_values_callback
#if MAL_REALMS
        && mal_value_to_native_function_object(method)->realm == vm->current_realm
#endif
        && mal_builtin_array_iterator_protocol_guard(vm)) {
        i32 count;
        if (mal_vm_try_marshal_dense_array(
                vm, mal_value_to_array_object(iterable),
                nullptr, &count)) {
            return count;
        }
    }

    MalIteratorRecord record;
    if (!mal_vm_get_iterator_from_method(
            vm, iterable, method, &record)) {
        return -1;
    }

    MalValue roots[4] = {
        record.iterator, record.next_method,
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, countof(roots));

    if (mal_value_is_iterator_object(record.iterator)
        && mal_value_is_native_function_object(record.next_method)
        && mal_native_function_object_callback(
            mal_value_to_native_function_object(record.next_method))
            == mal_array_iterator_next_callback) {
        MalIteratorObject *iterator =
            mal_value_to_iterator_object(record.iterator);
        if (iterator->kind == MAL_ITERATOR_ARRAY_VALUES
            && mal_value_is_heap_type(
                iterator->target, MAL_HEAP_ARRAY_OBJECT)) {
            MalArrayObject *array =
                (MalArrayObject *) mal_value_to_heap(iterator->target);
            i32 count;
            if (mal_vm_try_marshal_dense_array(
                    vm, array, iterator, &count)) {
                mal_gc_unroot(&roots_span);
                return count;
            }
        }
    }

    MalArrayObject *arguments = mal_intrinsic_new_array(vm, 0);
    roots[2] = mal_value_from_array_object(arguments);
    while (true) {
        bool done;
        if (!mal_vm_iterator_step_fast(
                vm, &record, &roots[3], &done)) {
            mal_gc_unroot(&roots_span);
            return -1;
        }
        if (done) break;
        if (!mal_array_object_fresh_dense_append(arguments, roots[3])) {
            mal_vm_throw_allocation_error(vm);
            mal_gc_unroot(&roots_span);
            return -1;
        }
    }

    i32 count = mal_vm_marshal_spread(vm, roots[2]);
    mal_gc_unroot(&roots_span);
    return count;
}

void mal_op_call(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    i32 caller_function_index = callable->function_index;
    i32 call_ip = callable->instruction_pointer - 1;
    MalValue callee = mal_op_value_operand(callable, instruction->as.call.callee);
    MalValue this_value = mal_op_value_operand(callable, instruction->as.call.this_value);
    i32 dst = instruction->as.call.dst;
    const i32 *data = mal_op_instruction_data(callable, instruction->as.call.data_offset);
    i32 argument_count = data[0];
    i32 exact_function_index = data[1];
    i32 guarded_function_count = data[2];
    const i32 *guarded_function_indices = &data[3];
    const i32 *arguments = &data[3 + guarded_function_count];

    // Marshal the arguments onto the top of the value stack; the callee adopts
    // that region as its register window (no temp allocation, no param copy).
    if (vm->value_stack_size + argument_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < argument_count; i++) {
        vm->value_stack[base + i] = mal_op_value_operand(callable, arguments[i]);
    }
    vm->value_stack_size = base + argument_count;

    if (mal_vm_try_interp_call_targets(
            vm, exact_function_index,
            guarded_function_indices, guarded_function_count, callee, this_value,
            base, argument_count, dst)) {
        return;
    }
    if (mal_vm_try_interp_call_cached(
            vm, caller_function_index, call_ip, callee, this_value,
            base, argument_count, dst)) {
        return;
    }
    mal_vm_call_dispatch(vm, callee, this_value, base, argument_count, dst);
    mal_vm_fill_interp_call_cache(vm, caller_function_index, call_ip, callee);
}

bool mal_op_call_guarded_math(
    MalCallable *callable, const MalInstruction *instruction
) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.call.data_offset);
    i32 argument_count = data[0];
    i32 guarded_function_count = data[2];
    const i32 *arguments = &data[3 + guarded_function_count];
    i32 math_tag = arguments[argument_count];
    MalValue callee = mal_op_value_operand(callable, instruction->as.call.callee);
    MalValue result;
    if (math_tag > 0) {
        MalMathUnaryOp operation = (MalMathUnaryOp) math_tag;
        if (!mal_builtin_math_unary_fast(
                callee, &operation,
                mal_op_value_operand(callable, arguments[0]), &result)) {
            return false;
        }
    } else if (math_tag < 0) {
        MalMathBinaryOp operation = (MalMathBinaryOp) -math_tag;
        if (!mal_builtin_math_binary_fast(
                callee, &operation,
                mal_op_value_operand(callable, arguments[0]),
                mal_op_value_operand(callable, arguments[1]), &result)) {
            return false;
        }
    } else {
        return false;
    }
    callable->registers[instruction->as.call.dst] = result;
    return true;
}

bool mal_op_call_guarded_builtin(
    MalCallable *callable, const MalInstruction *instruction
) {
    MalVm *vm = callable->vm;
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.call.data_offset);
    i32 argument_count = data[0];
    i32 guarded_function_count = data[2];
    const i32 *argument_operands = &data[3 + guarded_function_count];
    i32 operation = argument_operands[argument_count] -
        (MAL_MATH_UNARY_ROUND + 1);
    MalValue receiver = mal_op_value_operand(
        callable, instruction->as.call.this_value);
    if (operation >= MAL_GUARDED_BUILTIN_BOOLEAN_CALL &&
        operation <= MAL_GUARDED_BUILTIN_BOOLEAN_TO_STRING) {
        MalValue argument = argument_count == 0 ? MAL_VALUE_UNDEFINED
            : mal_op_value_operand(callable, argument_operands[0]);
        MalValue result;
        if (!mal_builtin_boolean_try_direct(vm,
                (MalBooleanOperation) (operation - MAL_GUARDED_BUILTIN_BOOLEAN_CALL),
                mal_op_value_operand(callable, instruction->as.call.callee),
                receiver, argument, &result)) return false;
        callable->registers[instruction->as.call.dst] = result;
        return true;
    }
    if (operation >= MAL_GUARDED_BUILTIN_NUMBER_IS_NAN &&
        operation <= MAL_GUARDED_BUILTIN_NUMBER_IS_SAFE_INTEGER) {
        MalValue callee = mal_op_value_operand(callable, instruction->as.call.callee);
        if (!mal_value_is_native_function_object(callee)) return false;
        MalNumberPredicate predicate = (MalNumberPredicate) (operation - MAL_GUARDED_BUILTIN_NUMBER_IS_NAN);
        MalValue argument = argument_count == 0 ? MAL_VALUE_UNDEFINED
            : mal_op_value_operand(callable, argument_operands[0]);
        MalValue result;
        if (!mal_builtin_number_predicate_try_direct(predicate, callee, argument, &result)) return false;
        callable->registers[instruction->as.call.dst] = result;
        return true;
    }
    if (operation >= MAL_GUARDED_BUILTIN_NUMBER_TO_FIXED &&
        operation <= MAL_GUARDED_BUILTIN_NUMBER_TO_PRECISION) {
        if (!mal_ops_is_number(receiver)) return false;
        MalNumberFormatMethod method = operation == MAL_GUARDED_BUILTIN_NUMBER_TO_FIXED
            ? MAL_NUMBER_FORMAT_FIXED : operation == MAL_GUARDED_BUILTIN_NUMBER_TO_EXPONENTIAL
            ? MAL_NUMBER_FORMAT_EXPONENTIAL : MAL_NUMBER_FORMAT_PRECISION;
        MalValue option = argument_count == 0 ? MAL_VALUE_UNDEFINED
            : mal_op_value_operand(callable, argument_operands[0]);
        MalValue result;
        if (!mal_builtin_number_format_try_direct(vm, method,
                mal_op_value_operand(callable, instruction->as.call.callee), receiver, option, &result)) return false;
        callable->registers[instruction->as.call.dst] = result;
        return true;
    }
    if (operation == MAL_GUARDED_BUILTIN_ARRAY_PUSH) {
        if (argument_count > 4) {
            MAL_PERF_COUNT(array_push_direct_fallbacks);
            return false;
        }
        MalValue arguments[4] = {
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
            mal_value_new_undefined(),
        };
        for (i32 i = 0; i < argument_count; i++) {
            arguments[i] = mal_op_value_operand(callable, argument_operands[i]);
        }
        MalValue result;
        if (!mal_builtin_array_push_try_direct(
                vm,
                mal_op_value_operand(callable, instruction->as.call.callee),
                receiver,
                arguments,
                argument_count,
                &result)) {
            MAL_PERF_COUNT(array_push_direct_fallbacks);
            return false;
        }
        MAL_PERF_COUNT(array_push_direct_hits);
        callable->registers[instruction->as.call.dst] = result;
        return true;
    }
    if (operation == MAL_GUARDED_BUILTIN_ARRAY_AT) {
        MalValue argument = argument_count == 0 ? MAL_VALUE_UNDEFINED
            : mal_op_value_operand(callable, argument_operands[0]);
        MalValue result;
        if (!mal_builtin_array_at_try_direct(
                vm,
                mal_op_value_operand(callable, instruction->as.call.callee),
                receiver,
                &argument,
                argument_count,
                &result)) {
            return false;
        }
        callable->registers[instruction->as.call.dst] = result;
        return true;
    }
    MalIntrinsic expected;
    bool receiver_matches;
    switch ((MalGuardedBuiltinCallOp) operation) {
        case MAL_GUARDED_BUILTIN_MAP_GET:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_GET;
            receiver_matches = mal_value_is_map_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_MAP_SET:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_SET;
            receiver_matches = mal_value_is_map_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_MAP_HAS:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_HAS;
            receiver_matches = mal_value_is_map_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_MAP_DELETE:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_DELETE;
            receiver_matches = mal_value_is_map_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_SET_ADD:
            expected = MAL_INTRINSIC_SET_PROTOTYPE_ADD;
            receiver_matches = mal_value_is_set_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_SET_HAS:
            expected = MAL_INTRINSIC_SET_PROTOTYPE_HAS;
            receiver_matches = mal_value_is_set_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        case MAL_GUARDED_BUILTIN_SET_DELETE:
            expected = MAL_INTRINSIC_SET_PROTOTYPE_DELETE;
            receiver_matches = mal_value_is_set_object(receiver) &&
                !mal_value_to_map_object(receiver)->weak;
            break;
        default:
            return false;
    }
    MalValue callee = mal_op_value_operand(callable, instruction->as.call.callee);
    if (!receiver_matches || callee != vm->intrinsics[expected]) return false;

    MalValue arguments[2] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    for (i32 i = 0; i < argument_count && i < 2; i++) {
        arguments[i] = mal_op_value_operand(callable, argument_operands[i]);
    }
    MalValue result;
    switch ((MalGuardedBuiltinCallOp) operation) {
        case MAL_GUARDED_BUILTIN_MAP_GET:
            result = mal_builtin_map_get_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_MAP_SET:
            result = mal_builtin_map_set_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_MAP_HAS:
            result = mal_builtin_map_has_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_MAP_DELETE:
            result = mal_builtin_map_delete_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_SET_ADD:
            result = mal_builtin_set_add_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_SET_HAS:
            result = mal_builtin_set_has_known(vm, receiver, arguments, argument_count);
            break;
        case MAL_GUARDED_BUILTIN_SET_DELETE:
            result = mal_builtin_set_delete_known(vm, receiver, arguments, argument_count);
            break;
        default:
            abort();
    }
    callable->registers[instruction->as.call.dst] = result;
    return true;
}

MalValue mal_vm_call_known_native(MalVm *vm, MalNativeFunctionCallback callback, i32 operation, MalValue receiver, const MalValue *args, i32 count, i32 flags) {
    static const i32 nodes[] = {
#define MAL_KNOWN_OPERATION(index, node) node,
#include "generated/known_primordials.inc"
#undef MAL_KNOWN_OPERATION
    };
    i32 mode = flags >> 1;
    bool construct = (flags & 1) != 0;
    if (operation < 0 || operation >= MAL_KNOWN_OPERATION_COUNT || flags < 0 || flags > 9 || (mode != 0 && count < 1)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid known operation");
        return MAL_VALUE_UNDEFINED;
    }
    MalCalleeRoots roots;
    mal_gc_callee_roots_begin(&roots, receiver, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, args, count);
    i32 base = vm->value_stack_size;
    MalValue result = MAL_VALUE_UNDEFINED;
    MalValue callee = mal_vm_load_primordial(vm, nodes[operation]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    roots.receiver_slots[2] = callee;
    // Reflect checks constructors before reading its array-like argument list.
    if (construct && mode < 3 && (!mal_vm_is_constructor(vm, callee) || !mal_vm_is_constructor(vm, receiver))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
        goto done;
    }
    if (mode != 0) {
        MalValue list = args[count - 1];
        i32 prefix = count - 1;
        if (prefix > vm->value_stack_capacity - base) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
            goto done;
        }
        for (i32 i = 0; i < prefix; i++) vm->value_stack[base + i] = args[i];
        vm->value_stack_size = base + prefix;
        i32 expanded = 0;
        if (mode == 1 || mode == 2) {
            if (!(mode == 2 && (mal_value_is_null(list) || mal_value_is_undefined(list)))) {
                MalValue inline_items[16];
                MalValue *items;
                if (!mal_vm_create_list_from_array_like(vm, list, inline_items, countof(inline_items), &items, &expanded)) goto done;
                if (expanded > vm->value_stack_capacity - vm->value_stack_size) {
                    if (items != inline_items) free(items);
                    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
                    goto done;
                }
                memcpy(&vm->value_stack[vm->value_stack_size], items, (usize) expanded * sizeof(MalValue));
                vm->value_stack_size += expanded;
                if (items != inline_items) free(items);
            }
        } else {
            expanded = mode == 3 ? mal_vm_marshal_spread(vm, list) : mal_vm_marshal_spread_iterable(vm, list);
            if (expanded < 0 || vm->completion.kind == MAL_COMPLETION_THROW) goto done;
        }
        args = &vm->value_stack[base];
        count = prefix + expanded;
    }
    MalCompletion completion = construct
        ? (callback == nullptr ? mal_vm_construct_value_with_target(vm, callee, args, count, receiver)
                               : mal_vm_construct_exact_native(vm, callback, callee, args, count, receiver))
        : (callback == nullptr ? mal_vm_call_value(vm, callee, receiver, args, count)
                               : mal_vm_call_exact_native(vm, callback, callee, receiver, args, count));
    if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
    result = completion.value;
done:
    vm->value_stack_size = base;
    mal_gc_callee_roots_end(&roots);
    return result;
}

MalValue mal_vm_call_known(MalVm *vm, i32 operation, MalValue receiver, const MalValue *args, i32 count, i32 flags) {
    return mal_vm_call_known_native(vm, nullptr, operation, receiver, args, count, flags);
}

void mal_op_call_known(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    const i32 *data = mal_op_instruction_data(callable, instruction->as.call_known.data_offset);
    i32 count = data[0];
    if (vm->value_stack_size + count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < count; i++) vm->value_stack[base + i] = mal_op_value_operand(callable, data[i + 1]);
    vm->value_stack_size = base + count;
    MalValue receiver = mal_op_value_operand(callable, instruction->as.call_known.this_value);
    MalValue result = mal_vm_call_known(vm, instruction->as.call_known.operation >> 4, receiver, &vm->value_stack[base], count, instruction->as.call_known.operation & 15);
    vm->value_stack_size = base;
    callable->registers[instruction->as.call_known.dst] = result;
}

void mal_op_call_spread(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call_spread.callee];
    MalValue this_value = callable->registers[instruction->as.call_spread.this_value];
    MalValue arguments_array = callable->registers[instruction->as.call_spread.arguments_array];
    i32 dst = instruction->as.call_spread.dst;

    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return;
    }

    mal_vm_call_dispatch(vm, callee, this_value, base, argument_count, dst);
}

void mal_op_call_spread_iterable(
    MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee =
        callable->registers[instruction->as.call_spread_iterable.callee];
    MalValue this_value =
        callable->registers[
            instruction->as.call_spread_iterable.this_value];
    MalValue iterable =
        callable->registers[
            instruction->as.call_spread_iterable.iterable];
    i32 dst = instruction->as.call_spread_iterable.dst;

    i32 base = vm->value_stack_size;
    i32 argument_count =
        mal_vm_marshal_spread_iterable(vm, iterable);
    if (argument_count < 0) return;

    mal_vm_call_dispatch(
        vm, callee, this_value, base, argument_count, dst);
}

// Shared spread call/construct for the native backend: marshal the spread array's
// elements onto the value stack (bounds-checked — RangeError on overflow), dispatch
// through the compiled calling convention, then pop the marshaled window and return
// the completion. The value stack is fixed-capacity (never realloc'd), so the args
// pointer stays valid across the call. A throw (overflow, or from the callee)
// arrives via the returned completion.
MalCompletion mal_vm_op_call_spread(
    MalVm *vm, MalValue callee, MalValue this_value, MalValue arguments_array
) {
    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return vm->completion;
    }
    MalCompletion completion =
        mal_vm_call_value(vm, callee, this_value, &vm->value_stack[base], argument_count);
    vm->value_stack_size = base;
    return completion;
}

MalCompletion mal_vm_op_call_spread_iterable(
    MalVm *vm, MalValue callee, MalValue this_value,
    MalValue iterable) {
    i32 base = vm->value_stack_size;
    i32 argument_count =
        mal_vm_marshal_spread_iterable(vm, iterable);
    if (argument_count < 0) return vm->completion;
    MalCompletion completion = mal_vm_call_value(
        vm, callee, this_value, &vm->value_stack[base],
        argument_count);
    vm->value_stack_size = base;
    return completion;
}

static bool mal_vm_rest_arguments_can_forward(
    MalVm *vm, MalValue callee, MalValue this_value, bool apply) {
    if (!apply) return mal_builtin_array_iterator_protocol_guard(vm);
    if (!mal_value_is_native_function_object(callee)) return false;
    MalNativeFunctionObject *native = mal_value_to_native_function_object(callee);
    if (mal_native_function_object_callback(native) != mal_builtin_function_prototype_apply) {
        return false;
    }
#if MAL_REALMS
    if (native->realm != vm->current_realm) return false;
#endif
    return mal_value_is_callable(this_value);
}

MalCompletion mal_vm_op_call_rest_arguments(
    MalVm *vm, MalValue callee, MalValue this_value, MalValue receiver,
    const MalValue *args, i32 arg_count, i32 start, bool apply) {
    i32 count = arg_count > start ? arg_count - start : 0;
    if (count <= vm->value_stack_capacity - vm->value_stack_size
        && mal_vm_rest_arguments_can_forward(vm, callee, this_value, apply)) {
        MAL_PERF_COUNT(rest_forward_calls);
        MAL_PERF_ADD(rest_forward_values, count);
        return mal_vm_call_value(vm, apply ? this_value : callee,
            apply ? receiver : this_value, count > 0 ? args + start : nullptr, count);
    }

    MalValue roots[4] = {callee, this_value, receiver, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[3] = mal_create_rest_arguments(vm, args, arg_count, start);
    MalCompletion completion;
    if (apply) {
        MalValue call_args[2] = {receiver, roots[3]};
        completion = mal_vm_call_value(vm, callee, this_value, call_args, 2);
    } else {
        completion = mal_vm_op_call_spread_iterable(vm, callee, this_value, roots[3]);
    }
    mal_gc_unroot(&root);
    return completion;
}

void mal_op_call_rest_arguments(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call_rest_arguments.callee];
    MalValue this_value = callable->registers[instruction->as.call_rest_arguments.this_value];
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.call_rest_arguments.data_offset);
    MalValue receiver = callable->registers[data[0]];
    i32 start = data[1];
    bool apply = data[2] != 0;
    i32 count = callable->argument_count > start ? callable->argument_count - start : 0;
    i32 base = vm->value_stack_size;
    if (count <= vm->value_stack_capacity - base
        && mal_vm_rest_arguments_can_forward(vm, callee, this_value, apply)) {
        MAL_PERF_COUNT(rest_forward_calls);
        MAL_PERF_ADD(rest_forward_values, count);
        MAL_PERF_ADD(rest_forward_copies, count);
        // Retain the iterative dispatcher so forwarded calls do not grow the C stack.
        if (count > 0) {
            memcpy(&vm->value_stack[base], callable->arguments + start,
                (usize) count * sizeof(MalValue));
        }
        vm->value_stack_size = base + count;
        if (apply) {
            callee = this_value;
            this_value = receiver;
        }
    } else {
        MalValue rest = mal_create_rest_arguments(
            vm, callable->arguments, callable->argument_count, start);
        MalRootSpan root;
        mal_gc_root(&root, &rest, 1);
        if (apply) {
            if (vm->value_stack_capacity - base < 2) {
                mal_gc_unroot(&root);
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                    "Maximum call stack size exceeded");
                return;
            }
            vm->value_stack[base] = receiver;
            vm->value_stack[base + 1] = rest;
            count = 2;
            vm->value_stack_size = base + count;
        } else {
            count = mal_vm_marshal_spread_iterable(vm, rest);
        }
        mal_gc_unroot(&root);
        if (count < 0) return;
    }
    mal_vm_call_dispatch(
        vm, callee, this_value, base, count, instruction->as.call_rest_arguments.dst);
}

MalCompletion mal_vm_op_construct_spread(MalVm *vm, MalValue callee, MalValue arguments_array) {
    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return vm->completion;
    }
    MalCompletion completion =
        mal_vm_construct_value(vm, callee, &vm->value_stack[base], argument_count);
    vm->value_stack_size = base;
    return completion;
}

void mal_op_construct(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = mal_op_value_operand(callable, instruction->as.construct.callee);
    i32 dst = instruction->as.construct.dst;
    const i32 *data = mal_op_instruction_data(callable, instruction->as.construct.data_offset);
    i32 argument_count = data[0];
    i32 exact_function_index = data[1];
    const i32 *arguments = &data[3];

    if (vm->value_stack_size + argument_count > vm->value_stack_capacity) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Maximum call stack size exceeded");
        return;
    }
    i32 base = vm->value_stack_size;
    for (i32 i = 0; i < argument_count; i++) {
        vm->value_stack[base + i] = mal_op_value_operand(callable, arguments[i]);
    }
    vm->value_stack_size = base + argument_count;

    if (mal_vm_try_interp_construct_exact(
            vm, exact_function_index, callee, base, argument_count, dst)) {
        return;
    }

    mal_vm_construct_dispatch(vm, callee, base, argument_count, dst);
}

void mal_op_construct_spread(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct_spread.callee];
    MalValue arguments_array = callable->registers[instruction->as.construct_spread.arguments_array];
    i32 dst = instruction->as.construct_spread.dst;

    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return;
    }

    mal_vm_construct_dispatch(vm, callee, base, argument_count, dst);
}

// Shared by the interpreter op and the native backend: `super(...args)`. Constructs
// the parent with the derived new.target and BindThisValue-binds the result as
// `this`. `current_this` is the (uninitialized EMPTY) binding; on success *this_out
// receives the bound `this` (which the caller stores back into its this binding and
// the dst register). Sets vm->completion and returns it on any throw.
MalCompletion mal_vm_op_construct_super(
    MalVm *vm, MalValue parent, MalValue arguments_array, MalValue new_target,
    MalValue current_this, MalValue *this_out
) {
    *this_out = current_this;
    // A super() with no new.target means the derived class constructor was invoked
    // without `new` (a class constructor has no [[Call]]); that is a TypeError.
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class constructor cannot be invoked without 'new'");
        return vm->completion;
    }
    // Marshal the super arguments onto the value stack (bounds-checked); the value
    // stack is fixed-capacity, so the args pointer stays valid across the construct.
    i32 base = vm->value_stack_size;
    i32 argument_count = mal_vm_marshal_spread(vm, arguments_array);
    if (argument_count < 0) {
        return vm->completion;
    }

    MalCompletion completion = mal_vm_construct_value_with_target(vm, parent, &vm->value_stack[base], argument_count, new_target);
    vm->value_stack_size = base;
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return completion;
    }

    // BindThisValue checks initialization after Construct, so a repeated super()
    // still runs the parent constructor's observable side effects first.
    if (!mal_value_is_empty(current_this)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, "Super constructor may only be called once");
        return vm->completion;
    }

    // BindThisValue: the derived constructor's `this` is the object the super
    // constructor produced. A non-object result only arises from the deliberate
    // lack of primitive wrapper objects (super to Number/String/Boolean returns
    // a primitive); keep the uninitialized binding as-is in that case.
    if (mal_value_is_object(completion.value)) {
        *this_out = completion.value;
    }
    return completion;
}

void mal_op_construct_super(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    // Frames may relocate while the parent constructor runs; address the caller
    // by index for the post-construct writes rather than holding `callable`.
    i32 caller_frame_index = vm->frame_count - 1;
    MalValue bound_this;
    MalCompletion completion = mal_vm_op_construct_super(
        vm,
        callable->registers[instruction->as.construct_super.parent],
        callable->registers[instruction->as.construct_super.arguments_array],
        callable->new_target,
        callable->this_value,
        &bound_this
    );
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return;
    }
    vm->frames[caller_frame_index].this_value = bound_this;
    vm->frames[caller_frame_index].registers[instruction->as.construct_super.dst] = bound_this;
}

void mal_op_construct_super_explicit(MalCallable *callable, const MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    i32 caller_frame_index = vm->frame_count - 1;
    MalValue bound_this;
    // Two-address encoding: dst carries current_this into the op and receives
    // the newly bound value. new_target is explicit because lexical arrows and
    // direct eval execute in frames that do not own the constructor environment.
    MalCompletion completion = mal_vm_op_construct_super(
        vm,
        callable->registers[instruction->as.construct_super_explicit.parent],
        callable->registers[instruction->as.construct_super_explicit.arguments_array],
        callable->registers[instruction->as.construct_super_explicit.new_target],
        callable->registers[instruction->as.construct_super_explicit.dst],
        &bound_this
    );
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return;
    }
    vm->frames[caller_frame_index].registers[instruction->as.construct_super_explicit.dst] = bound_this;
}

void mal_op_set_this(MalCallable *callable, const MalInstruction *instruction) {
    callable->this_value = callable->registers[instruction->as.set_this.value];
}

// GetThisBinding for a derived constructor: `this` is uninitialized (the EMPTY
// sentinel) until super() binds it; reading it before then is a ReferenceError.
// Shared by the interpreter op and the native backend; returns the binding (EMPTY
// on the throw path, which the caller ignores after checking the completion).
MalValue mal_vm_op_get_this(MalVm *vm, MalValue this_value) {
    if (mal_value_is_empty(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
            "Must call super constructor in derived class before accessing 'this'");
    }
    return this_value;
}

// Preserve the raw outcome needed by the compiled [[Construct]] seam: explicit
// objects/primitives remain distinguishable, while undefined becomes either the
// bound `this` or EMPTY when super() has not initialized it.
MalValue mal_vm_op_derived_construct_return(MalVm *vm, MalValue value, MalValue this_value) {
    (void) vm;
    return mal_value_is_undefined(value) ? this_value : value;
}

void mal_op_throw(MalCallable *callable, const MalInstruction *instruction) {
    callable->vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = callable->registers[instruction->as.thrown.value],
    };
}

void mal_op_catch(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.caught.dst] = callable->vm->completion.value;
    callable->vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static bool mal_vm_op_is_bigint_arith(MalBinaryOp op) {
    switch (op) {
        case MAL_BIN_ADD:
        case MAL_BIN_SUB:
        case MAL_BIN_MUL:
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
        case MAL_BIN_POW:
        case MAL_BIN_BIT_AND:
        case MAL_BIN_BIT_OR:
        case MAL_BIN_BIT_XOR:
        case MAL_BIN_SHL:
        case MAL_BIN_SHR:
        case MAL_BIN_USHR:
            return true;
        default:
            return false;
    }
}

// Arithmetic/bitwise/shift over BigInt operands. Mixing BigInt with any non-
// BigInt (other than string concatenation via `+`) throws TypeError, matching
// the spec's refusal to implicitly convert.
static MalValue mal_vm_bigint_arith(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right) {
    if (op == MAL_BIN_ADD && (mal_value_is_string(left) || mal_value_is_string(right))) {
        return mal_vm_add(vm, left, right);
    }

    if (!mal_value_is_bigint(left) || !mal_value_is_bigint(right)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot mix BigInt and other types, use explicit conversions");
        return mal_value_new_undefined();
    }

    i128 a = mal_bigint_value(mal_value_to_bigint(left));
    i128 b = mal_bigint_value(mal_value_to_bigint(right));
    i128 result = 0;

    switch (op) {
        case MAL_BIN_ADD:
            result = mal_bigint128_add(a, b);
            break;
        case MAL_BIN_SUB:
            result = mal_bigint128_subtract(a, b);
            break;
        case MAL_BIN_MUL:
            result = mal_bigint128_multiply(a, b);
            break;
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
            if (!(op == MAL_BIN_DIV
                    ? mal_bigint128_divide(a, b, &result)
                    : mal_bigint128_remainder(a, b, &result))) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Division by zero");
                return mal_value_new_undefined();
            }
            break;
        case MAL_BIN_POW: {
            if (b < 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Exponent must be non-negative");
                return mal_value_new_undefined();
            }
            result = mal_bigint128_exponentiate(a, b);
            break;
        }
        case MAL_BIN_BIT_AND:
            result = mal_bigint128_bit_and(a, b);
            break;
        case MAL_BIN_BIT_OR:
            result = mal_bigint128_bit_or(a, b);
            break;
        case MAL_BIN_BIT_XOR:
            result = mal_bigint128_bit_xor(a, b);
            break;
        case MAL_BIN_SHL:
            result = mal_bigint128_shift_left(a, b);
            break;
        case MAL_BIN_SHR:
            result = mal_bigint128_shift_right(a, b);
            break;
        case MAL_BIN_USHR:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "BigInts have no unsigned right shift, use >> instead");
            return mal_value_new_undefined();
        default:
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Unsupported BigInt operation");
            return mal_value_new_undefined();
    }

    return mal_value_from_bigint(mal_bigint_new(&vm->heap, result));
}

// Whether the operator's operands flow through ToNumeric (ToPrimitive(number)
// then ToNumber/ToBigInt): all arithmetic except `+` (which is ToPrimitive with
// no hint, handled separately), plus bitwise/shift. A Symbol operand therefore
// throws, and an object is reduced via valueOf/toString.
static bool mal_vm_op_is_numeric(MalBinaryOp op) {
    switch (op) {
        case MAL_BIN_SUB:
        case MAL_BIN_MUL:
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
        case MAL_BIN_POW:
        case MAL_BIN_BIT_AND:
        case MAL_BIN_BIT_OR:
        case MAL_BIN_BIT_XOR:
        case MAL_BIN_SHL:
        case MAL_BIN_SHR:
        case MAL_BIN_USHR:
            return true;
        default:
            return false;
    }
}

// Whether the operator is an abstract relational comparison (`<`/`<=`/`>`/`>=`),
// which runs ToPrimitive(number) on both operands.
static bool mal_vm_op_is_relational(MalBinaryOp op) {
    return op == MAL_BIN_LT || op == MAL_BIN_LTE || op == MAL_BIN_GT || op == MAL_BIN_GTE;
}

// The value-returning core of a binary operator, shared by the interpreter op
// (mal_op_binary) and the compiled-function backend. On a throwing operator
// (`in`/`instanceof` on bad operands, BigInt domain errors, a throwing valueOf/
// toString) it sets the pending completion and returns undefined; callers
// observe the throw via vm->completion.
MalValue mal_vm_binary_op(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right) {
    // Fast path: when both operands are already numbers, ToPrimitive/ToNumeric
    // are no-ops that cannot throw (numbers are primitive, never Symbol/BigInt/
    // object), so skip the entire coercion preamble and dispatch straight to the
    // numeric mal_ops_* below. This is the dominant case in arithmetic-heavy
    // loops running on the interpreter and removes two non-inlined coercion calls
    // per operation.
    const bool both_numbers = mal_ops_is_number(left) && mal_ops_is_number(right);

    // Coerce operands to primitives per the operator's abstract operation. This
    // is the VM-aware ToPrimitive (valueOf/toString/@@toPrimitive) the VM-less
    // mal_ops_* helpers cannot perform; primitives pass through unchanged.
    if (both_numbers) {
        // No coercion needed; fall through to the dispatch switch below.
    } else if (op == MAL_BIN_ADD) {
        // Spec EvaluateStringOrNumericBinaryExpression: ToPrimitive(no hint) on
        // both, in order. mal_vm_add / mal_vm_bigint_arith then decide string
        // concat vs numeric add on the resulting primitives.
        if (!mal_vm_to_primitive(vm, left, MAL_TO_PRIMITIVE_DEFAULT, &left) ||
            !mal_vm_to_primitive(vm, right, MAL_TO_PRIMITIVE_DEFAULT, &right)) {
            return mal_value_new_undefined();
        }
        // After ToPrimitive a String on either side means concatenation, even
        // when the other side is a BigInt (mal_vm_bigint_arith allows it).
    } else if (mal_vm_op_is_numeric(op)) {
        // ToNumeric on both: a Symbol throws, an object runs through valueOf/
        // toString, a BigInt stays a BigInt for the bigint dispatch below.
        if (!mal_vm_to_numeric(vm, left, &left) || !mal_vm_to_numeric(vm, right, &right)) {
            return mal_value_new_undefined();
        }
    } else if (mal_vm_op_is_relational(op)) {
        // Abstract relational comparison reduces both operands via ToPrimitive
        // (number hint). `>`/`>=` evaluate the right operand's ToPrimitive before
        // the left (spec LeftFirst=false), so a throwing valueOf surfaces in
        // source order; `<`/`<=` go left-to-right.
        bool left_first = !(op == MAL_BIN_GT || op == MAL_BIN_GTE);
        MalValue *first = left_first ? &left : &right;
        MalValue *second = left_first ? &right : &left;
        if (mal_value_is_object(*first) && !mal_vm_to_primitive(vm, *first, MAL_TO_PRIMITIVE_NUMBER, first)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_object(*second) && !mal_vm_to_primitive(vm, *second, MAL_TO_PRIMITIVE_NUMBER, second)) {
            return mal_value_new_undefined();
        }
        // Abstract relational comparison forbids Symbol operands (its ToNumeric
        // throws).
        if (mal_value_is_symbol(left) || mal_value_is_symbol(right)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a number");
            return mal_value_new_undefined();
        }
    } else if (op == MAL_BIN_EQ || op == MAL_BIN_NEQ) {
        // Abstract equality: an object operand is reduced via ToPrimitive ONLY
        // when the other operand is a primitive other than null/undefined
        // (Number/String/Boolean/BigInt/Symbol). An object-vs-null/undefined
        // comparison short-circuits to "not equal" with no coercion (so a
        // valueOf returning null does not make `obj == undefined` true), and an
        // object-vs-object comparison is by reference. The number hint picks the
        // valueOf-first order; a resulting Symbol stays a Symbol (identity-only).
        bool left_object = mal_value_is_object(left);
        bool right_object = mal_value_is_object(right);
        bool left_coercible_primitive = !left_object && !mal_value_is_nil(left);
        bool right_coercible_primitive = !right_object && !mal_value_is_nil(right);
        if (left_object && right_coercible_primitive &&
            !mal_vm_to_primitive(vm, left, MAL_TO_PRIMITIVE_NUMBER, &left)) {
            return mal_value_new_undefined();
        }
        if (right_object && left_coercible_primitive &&
            !mal_vm_to_primitive(vm, right, MAL_TO_PRIMITIVE_NUMBER, &right)) {
            return mal_value_new_undefined();
        }
    }

    // BigInt arithmetic/bitwise/shift is a separate domain (equality and
    // relational comparison stay in the shared mal_ops_* path below).
    if ((mal_value_is_bigint(left) || mal_value_is_bigint(right)) && mal_vm_op_is_bigint_arith(op)) {
        return mal_vm_bigint_arith(vm, op, left, right);
    }

    switch (op) {
        case MAL_BIN_ADD:
            return mal_vm_add(vm, left, right);
        case MAL_BIN_SUB:
            return mal_ops_subtract(left, right);
        case MAL_BIN_MUL:
            return mal_ops_multiply(left, right);
        case MAL_BIN_DIV:
            return mal_ops_divide(left, right);
        case MAL_BIN_REM:
            return mal_ops_remainder(left, right);
        case MAL_BIN_POW:
            return mal_ops_exponentiate(left, right);
        case MAL_BIN_BIT_AND:
            return mal_ops_bit_and(left, right);
        case MAL_BIN_BIT_OR:
            return mal_ops_bit_or(left, right);
        case MAL_BIN_BIT_XOR:
            return mal_ops_bit_xor(left, right);
        case MAL_BIN_SHL:
            return mal_ops_shift_left(left, right);
        case MAL_BIN_SHR:
            return mal_ops_shift_right(left, right);
        case MAL_BIN_USHR:
            return mal_ops_shift_right_unsigned(left, right);
        case MAL_BIN_LT:
            return mal_ops_less_than(left, right);
        case MAL_BIN_LTE:
            return mal_ops_less_equal(left, right);
        case MAL_BIN_GT:
            return mal_ops_greater_than(left, right);
        case MAL_BIN_GTE:
            return mal_ops_greater_equal(left, right);
        case MAL_BIN_EQ:
            return mal_ops_equal(left, right);
        case MAL_BIN_NEQ:
            return mal_ops_not_equal(left, right);
        case MAL_BIN_STRICT_EQ:
            return mal_ops_strict_equal(left, right);
        case MAL_BIN_STRICT_NEQ:
            return mal_ops_strict_not_equal(left, right);
        case MAL_BIN_IN: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot use 'in' operator on a non-object");
                return mal_value_new_undefined();
            }

            MalKey key;
            if (!mal_vm_value_to_property_key(vm, left, &key)) {
                return mal_value_new_boolean(false);
            }

            return mal_value_new_boolean(mal_vm_has_property(vm, right, key));
        }
        case MAL_BIN_INSTANCEOF: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not an object");
                return mal_value_new_undefined();
            }

            // Spec InstanceofOperator: a callable @@hasInstance method takes
            // the decision (the default lives on Function.prototype).
            MalValue method;
            if (!mal_vm_get_property(vm, right, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_HAS_INSTANCE), &method)) {
                return mal_value_new_undefined();
            }

            // GetMethod: a @@hasInstance that is present (not undefined/null) but
            // NOT callable is a TypeError — it does NOT silently fall through to
            // OrdinaryHasInstance.
            if (!mal_value_is_nil(method) && !mal_value_is_callable(method)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.hasInstance method is not callable");
                return mal_value_new_undefined();
            }

            if (mal_value_is_callable(method)) {
                MalCompletion completion = mal_vm_call_value(vm, method, right, &left, 1);
                return completion.kind == MAL_COMPLETION_NORMAL
                    ? mal_value_new_boolean(mal_value_is_truthy(completion.value))
                    : mal_value_new_undefined();
            }

            if (!mal_value_is_callable(right)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not callable");
                return mal_value_new_undefined();
            }

            return mal_value_new_boolean(mal_vm_ordinary_has_instance(vm, right, left));
        }
    }

    return mal_value_new_undefined();
}

void mal_op_binary(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.binary.dst] = mal_vm_binary_op(
        callable->vm,
        instruction->as.binary.op,
        callable->registers[instruction->as.binary.left],
        callable->registers[instruction->as.binary.right]
    );
}

MalTypeofResult mal_vm_typeof_result(MalValue value) {
    if (mal_value_is_undefined(value)) {
        return MAL_TYPEOF_UNDEFINED;
    }
    if (mal_value_is_null(value)) {
        return MAL_TYPEOF_OBJECT;
    }
    if (mal_value_is_boolean(value)) {
        return MAL_TYPEOF_BOOLEAN;
    }
    if (mal_value_is_string(value)) {
        return MAL_TYPEOF_STRING;
    }
    if (mal_value_is_symbol(value)) {
        return MAL_TYPEOF_SYMBOL;
    }
    if (mal_value_is_bigint(value)) {
        return MAL_TYPEOF_BIGINT;
    }
    if (mal_value_is_callable(value)) {
        return MAL_TYPEOF_FUNCTION;
    }
    if (mal_value_is_object(value)) {
        return MAL_TYPEOF_OBJECT;
    }

    return MAL_TYPEOF_NUMBER;
}

static const byte *mal_vm_typeof_tag(MalTypeofResult result) {
    switch (result) {
        case MAL_TYPEOF_UNDEFINED: return "undefined";
        case MAL_TYPEOF_OBJECT: return "object";
        case MAL_TYPEOF_BOOLEAN: return "boolean";
        case MAL_TYPEOF_NUMBER: return "number";
        case MAL_TYPEOF_STRING: return "string";
        case MAL_TYPEOF_SYMBOL: return "symbol";
        case MAL_TYPEOF_BIGINT: return "bigint";
        case MAL_TYPEOF_FUNCTION: return "function";
        case MAL_TYPEOF_RESULT_COUNT: break;
    }
    return "undefined";
}

// Value-returning core of a unary operator, shared by mal_op_unary and the
// compiled backend. Unary `+` on a BigInt throws (via vm->completion); the
// numeric unary ops (`-`/`+`/`~`) run their operand through ToNumeric (so an
// object's valueOf/toString and a Symbol's TypeError are honored) before the
// per-type arithmetic.
MalValue mal_vm_unary_op(MalVm *vm, MalUnaryOp op, MalValue value) {
    // UpdateExpression coercion: ToNumeric keeps a BigInt as a BigInt (unlike
    // unary `+`), running an object's valueOf and throwing on a Symbol exactly
    // once. INCREMENT/DECREMENT then act on that already-numeric value.
    if (op == MAL_UNARY_TO_NUMERIC) {
        MalValue numeric;
        if (!mal_vm_to_numeric(vm, value, &numeric)) {
            return mal_value_new_undefined();
        }
        return numeric;
    }
    if (op == MAL_UNARY_INCREMENT || op == MAL_UNARY_DECREMENT) {
        if (mal_value_is_bigint(value)) {
            i128 unit = op == MAL_UNARY_INCREMENT ? (i128) 1 : (i128) -1;
            return mal_value_from_bigint(mal_bigint_new(&vm->heap,
                mal_bigint128_add(mal_bigint_value(mal_value_to_bigint(value)), unit)));
        }
        f64 unit = op == MAL_UNARY_INCREMENT ? 1.0 : -1.0;
        return mal_value_from_f64_convert_nan(mal_ops_to_number(value) + unit);
    }
    // `!`, typeof, and the unary numeric ops all need an object operand reduced
    // to a primitive first; only the numeric ops require a *numeric* primitive,
    // so route just those through ToNumeric (which also throws on a Symbol).
    if (op == MAL_UNARY_NEGATE || op == MAL_UNARY_PLUS || op == MAL_UNARY_BIT_NOT) {
        if (mal_value_is_object(value) || mal_value_is_symbol(value)) {
            if (!mal_vm_to_numeric(vm, value, &value)) {
                return mal_value_new_undefined();
            }
        }
    }

    switch (op) {
        case MAL_UNARY_NOT:
            return mal_value_new_boolean(!mal_value_is_truthy(value));
        case MAL_UNARY_NEGATE:
            if (mal_value_is_bigint(value)) {
                return mal_value_from_bigint(mal_bigint_new(
                    &vm->heap, mal_bigint128_negate(mal_bigint_value(mal_value_to_bigint(value)))));
            }
            if (mal_value_is_int32(value) && mal_value_to_i32(value) != 0 && mal_value_to_i32(value) != INT32_MIN) {
                return mal_value_from_i32(-mal_value_to_i32(value));
            }
            // Keeps -0 and -INT32_MIN exact by going through f64.
            return mal_value_from_f64_convert_nan(-mal_ops_to_number(value));
        case MAL_UNARY_PLUS:
            if (mal_value_is_bigint(value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Cannot convert a BigInt value to a number");
                return mal_value_new_undefined();
            }
            return mal_ops_number_value(mal_ops_to_number(value));
        case MAL_UNARY_BIT_NOT:
            if (mal_value_is_bigint(value)) {
                return mal_value_from_bigint(mal_bigint_new(
                    &vm->heap, mal_bigint128_bit_not(mal_bigint_value(mal_value_to_bigint(value)))));
            }
            return mal_ops_bit_xor(value, mal_value_from_i32(-1));
        case MAL_UNARY_TO_STRING: {
            MalString *string;
            if (!mal_vm_to_string(vm, value, &string)) {
                return mal_value_new_undefined();
            }
            return mal_value_from_string(string);
        }
        case MAL_UNARY_TYPEOF: {
            const byte *tag = mal_vm_typeof_tag(mal_vm_typeof_result(value));
            usize length = 0;
            while (tag[length] != '\0') {
                length++;
            }
            return mal_value_from_string(mal_string_new_ascii(&vm->heap, tag, length));
        }
        case MAL_UNARY_TO_NUMERIC:
        case MAL_UNARY_INCREMENT:
        case MAL_UNARY_DECREMENT:
            break;
    }

    return mal_value_new_undefined();
}

void mal_op_unary(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.unary.dst] = mal_vm_unary_op(
        callable->vm,
        instruction->as.unary.op,
        callable->registers[instruction->as.unary.src]
    );
}

void mal_op_typeof_compare(MalCallable *callable, const MalInstruction *instruction) {
    bool result = mal_vm_typeof_compare(
        callable->registers[instruction->as.typeof_compare.src],
        instruction->as.typeof_compare.expected
    );
    callable->registers[instruction->as.typeof_compare.dst] =
        mal_value_new_boolean(instruction->as.typeof_compare.negated ? !result : result);
}

void mal_op_store_global(MalCallable *callable, const MalInstruction *instruction) {
    callable->vm->globals[instruction->as.store_global.index] = callable->registers[instruction->as.store_global.src];
}

void mal_op_load_global(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_global.dst] = callable->vm->globals[instruction->as.load_global.index];
}

void mal_op_load_primordial(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_intrinsic.dst] = mal_vm_load_primordial(callable->vm, instruction->as.load_intrinsic.intrinsic);
}

void mal_op_load_intrinsic(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_intrinsic.dst] = callable->vm->intrinsics[instruction->as.load_intrinsic.intrinsic];
}

static bool mal_vm_key_is_prototype(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    static const byte expected[] = "prototype";
    if (mal_string_length(string) != lengthof(expected)) {
        return false;
    }

    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < lengthof(expected); i++) {
        if (code_units[i] != (c16) expected[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Whether a function object is a generator (its definition's kind).
 */
static bool mal_vm_function_is_generator(MalVm *vm, MalValue function_value) {
    if (!mal_value_is_function_object(function_value)) {
        return false;
    }

    i32 index = mal_function_object_function_index(mal_value_to_function_object(function_value));
    return vm->runtime_image->functions[index].kind == MAL_FUNCTION_KIND_GENERATOR;
}

/**
 * Script functions get their prototype property created lazily on first use.
 * Ordinary functions get the spec-mandated constructor back reference and an
 * %Object.prototype%-backed object; generator functions get a
 * %GeneratorPrototype%-backed object with no constructor.
 */
MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value) {
    MalObject *function = mal_value_to_object(function_value);
    MalFunctionObject *function_object = mal_value_is_function_object(function_value)
        ? mal_value_to_function_object(function_value)
        : nullptr;
    MalKey key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE);

    MalPropertyLookup lookup = mal_object_get_own(function, key);
    if (lookup.present) {
        return lookup.desc.value;
    }

    MalFunctionKind kind = MAL_FUNCTION_KIND_NORMAL;
    bool is_class_constructor = false;
    if (function_object != nullptr) {
        i32 index = mal_function_object_function_index(function_object);
        kind = vm->runtime_image->functions[index].kind;
        is_class_constructor = vm->runtime_image->functions[index].is_class_constructor;
    }
    bool is_generator_kind = kind == MAL_FUNCTION_KIND_GENERATOR || kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR;

    MalIntrinsic parent_slot = kind == MAL_FUNCTION_KIND_ASYNC_GENERATOR ? MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE
        : kind == MAL_FUNCTION_KIND_GENERATOR                            ? MAL_INTRINSIC_GENERATOR_PROTOTYPE
                                                                         : MAL_INTRINSIC_OBJECT_PROTOTYPE;
#if MAL_REALMS
    MalValue parent_value = function_object != nullptr && function_object->realm != nullptr
        ? function_object->realm->intrinsics[parent_slot]
        : vm->intrinsics[parent_slot];
#else
    MalValue parent_value = vm->intrinsics[parent_slot];
#endif
    MalObject *parent = mal_value_to_object(parent_value);
    MalObject *prototype = mal_object_new(&vm->heap, parent);
    if (!is_generator_kind) {
        mal_intrinsic_define_data(vm, prototype, "constructor", function_value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    // MakeConstructor: a class constructor's prototype is non-writable (and
    // non-configurable, non-enumerable); an ordinary function's is writable.
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_object(prototype), is_class_constructor ? 0 : MAL_PROPERTY_WRITABLE);
    mal_object_define_own(function, key, &desc);
    return desc.value;
}

static bool mal_vm_value_is_number(MalValue value) {
    // ±Infinity and -0 are canonicalised to dedicated static tags (value.h), so
    // they are NOT is_f64 — enumerate them explicitly or a property access on
    // Infinity (e.g. `Infinity.toString()`) fails to route to %Number.prototype%.
    return mal_value_is_int32(value) || mal_value_is_f64_or_nan(value)
        || value == MAL_VALUE_NEGATIVE_ZERO || value == MAL_VALUE_POSITIVE_INFINITY
        || value == MAL_VALUE_NEGATIVE_INFINITY;
}

/**
 * Resolve the synthetic properties that have no backing slot in the ordinary
 * property tables: array length, callable length/name, and the lazily
 * materialized script function prototype. Shared by load, `in`, and delete so
 * the three operators agree on what exists.
 */
static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out) {
    if (mal_value_is_array_object(object_value) && mal_array_key_is_length(key)) {
        *value_out = mal_value_from_u32(mal_array_object_length(mal_value_to_array_object(object_value)));
        return true;
    }

    // Integer-indexed TypedArray reads bypass the property table. Only in-bounds
    // indices resolve here; an out-of-bounds index is not an own property, so it
    // falls through to the ordinary (empty) lookup, yielding undefined and a
    // correct `in` result.
    if (mal_value_is_typed_array_object(object_value) && key.kind == MAL_KEY_INDEX) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(object_value);
        u32 index = mal_key_index_value(key);
        if (index < mal_typed_array_object_length(array)) {
            *value_out = mal_typed_array_object_get(vm, array, index);
            return true;
        }
    }

    if (mal_value_is_callable(object_value)) {
        // length and name are materialized as real own data properties at
        // function creation (function_object.c / mal_vm_op_create_function /
        // Function.prototype.bind), so the reflective machinery and delete see
        // them; they are deliberately NOT resolved synthetically here.
        if (mal_value_is_function_object(object_value) && mal_vm_key_is_prototype(key)) {
            // A user-defined own `prototype` (a data value or accessor installed
            // via defineProperty/assignment) overrides the synthetic default:
            // defer to the ordinary [[Get]] so an accessor's getter actually runs
            // and a replaced data value is read.
            if (mal_object_get_own(mal_value_to_object(object_value), key).present) {
                return false;
            }
            // Methods, getters, setters and arrows are not constructors and own
            // no `prototype`; async (non-generator) functions likewise. Only
            // constructors and generators materialize one.
            i32 function_index = mal_function_object_function_index(mal_value_to_function_object(object_value));
            const MalFunction *fn = &vm->runtime_image->functions[function_index];
            if (fn->has_prototype && fn->kind != MAL_FUNCTION_KIND_ASYNC) {
                *value_out = mal_vm_function_prototype(vm, object_value);
                return true;
            }
        }
    }

    if (mal_value_is_module_namespace_object(object_value)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(object_value);
        if (!mal_module_namespace_ensure_for_key(vm, ns, key)) return false;

        // The phase-specific tag remains non-enumerable and non-configurable.
        MalKey tag = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG);
        if (key.kind == MAL_KEY_SYMBOL && key.value == tag.value) {
            *value_out = mal_value_from_string(
                mal_intrinsic_ascii(vm, ns->deferred ? "Deferred Module" : "Module"));
            return true;
        }

        // A string export reads its live global slot; an uninitialized binding
        // (still in its module's TDZ) throws ReferenceError.
        if (key.kind == MAL_KEY_STRING) {
            MalString *name = mal_value_to_string(key.value);
            for (i32 i = 0; i < ns->export_count; i++) {
                if (mal_string_equals(name, ns->exports[i].name)) {
                    // Return the live value, which may still be the TDZ sentinel;
                    // the GET path turns that into a ReferenceError, while
                    // HasProperty and delete must report the export as present
                    // without throwing.
                    *value_out = vm->globals[ns->exports[i].slot];
                    return true;
                }
            }
        }
    }

    return false;
}

static bool mal_vm_get_from_prototype_slot(MalVm *vm, MalIntrinsic prototype_slot, MalValue receiver, MalKey key, MalValue *out) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        key
    );
    if (!resolution.found) {
        *out = mal_value_new_undefined();
        return true;
    }

    return mal_vm_desc_read(vm, resolution.desc, receiver, out);
}

bool mal_vm_to_primitive(MalVm *vm, MalValue value, MalToPrimitiveHint hint, MalValue *out) {
    // A non-object is already primitive.
    if (!mal_value_is_object(value)) {
        *out = value;
        return true;
    }

    // A @@toPrimitive method, if present, takes precedence and is given the
    // hint string ("default"/"number"/"string").
    MalValue exotic;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
        return false;
    }
    if (!mal_value_is_nil(exotic)) {
        if (!mal_value_is_callable(exotic)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
            return false;
        }
        const byte *hint_name = hint == MAL_TO_PRIMITIVE_STRING
            ? "string"
            : (hint == MAL_TO_PRIMITIVE_NUMBER ? "number" : "default");
        MalValue hint_value = mal_value_from_string(mal_intrinsic_ascii(vm, hint_name));
        MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint_value, 1);
        if (result.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
        if (mal_value_is_object(result.value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
            return false;
        }
        *out = result.value;
        return true;
    }

    // OrdinaryToPrimitive: a string hint tries toString first, otherwise
    // valueOf leads (default and number hints share this order).
    const byte *methods[2];
    if (hint == MAL_TO_PRIMITIVE_STRING) {
        methods[0] = "toString";
        methods[1] = "valueOf";
    } else {
        methods[0] = "valueOf";
        methods[1] = "toString";
    }
    for (i32 i = 0; i < 2; i++) {
        MalValue method;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
            return false;
        }
        if (mal_value_is_callable(method)) {
            MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return false;
            }
            if (!mal_value_is_object(result.value)) {
                *out = result.value;
                return true;
            }
        }
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
    return false;
}

bool mal_vm_to_number(MalVm *vm, MalValue value, f64 *out) {
    // Numbers dominate coercion-heavy native call sites (Math, typed views,
    // string indices, and Date fields). Avoid the cross-TU ToPrimitive call
    // and its object test when the value is already known to be a Number.
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }

    // Objects first go through ToPrimitive(number): @@toPrimitive, else the
    // OrdinaryToPrimitive order valueOf → toString.
    MalValue primitive = value;
    if (mal_value_is_object(value)) {
        if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_NUMBER, &primitive)) {
            return false;
        }
    }

    // ToNumber proper: BigInt and Symbol are not convertible.
    if (mal_value_is_bigint(primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a BigInt value to a number");
        return false;
    }
    if (mal_value_is_symbol(primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a number");
        return false;
    }

    *out = mal_ops_to_number(primitive);
    return true;
}

bool mal_vm_to_string(MalVm *vm, MalValue value, MalString **out) {
    // String arguments dominate constructors, property helpers, URI methods,
    // and symbol-registry traffic. Preserve the existing string object and
    // avoid generic ToPrimitive dispatch for every primitive input.
    if (mal_value_is_string(value)) {
        *out = mal_value_to_string(value);
        return true;
    }

    // ToString(object) is ToPrimitive(string) then ToString of the primitive.
    MalValue primitive = value;
    if (mal_value_is_object(value)) {
        if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_STRING, &primitive)) {
            return false;
        }
    }

    // A Symbol has no string coercion (only String(sym) / sym.toString()).
    if (mal_value_is_symbol(primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
        return false;
    }

    *out = mal_value_is_boolean(primitive)
        ? mal_intrinsic_hot_ascii(vm, mal_value_to_boolean(primitive) ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE)
        : mal_ops_to_string(&vm->heap, primitive);
    return true;
}

bool mal_vm_to_numeric(MalVm *vm, MalValue value, MalValue *out) {
    // ToNumeric: ToPrimitive(number); a BigInt primitive stays a BigInt, every
    // other primitive goes through ToNumber.
    MalValue primitive;
    if (!mal_vm_to_primitive(vm, value, MAL_TO_PRIMITIVE_NUMBER, &primitive)) {
        return false;
    }

    if (mal_value_is_bigint(primitive)) {
        *out = primitive;
        return true;
    }

    if (mal_value_is_symbol(primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a number");
        return false;
    }

    *out = mal_ops_number_value(mal_ops_to_number(primitive));
    return true;
}

/**
 * OrdinaryGet with a proxy-aware prototype chain. Walks ordinary prototype links
 * (own table lookup at each, like mal_object_resolve_property); on reaching a
 * proxy link it delegates the remainder of the lookup to the proxy's [[Get]]
 * (its trap or forwarding), passing the original receiver. A plain
 * mal_object_resolve_property treats a proxy as an ordinary (empty) object, so an
 * object inheriting from a proxy would never see the proxy's exposed properties.
 * Returns false with a pending throw on an abrupt trap; on a clean miss returns
 * true with *out left as the caller's undefined.
 */
static bool mal_vm_ordinary_get(MalVm *vm, MalObject *start, MalKey key, MalValue receiver, MalValue *out) {
    for (MalObject *cursor = start; cursor != nullptr;) {
        bool present;
        MalPropertyDesc desc;
        if (cursor->header.type == MAL_HEAP_ARGUMENTS_OBJECT) {
            if (!mal_vm_get_own_property(vm, mal_value_from_object(cursor), key, &present, &desc)) {
                return false;
            }
        } else if (cursor->header.type == MAL_HEAP_OBJECT &&
                   cursor->shape->inline_count == 0 && cursor->overflow != nullptr) {
            MalPropertyRead read = mal_property_read(cursor->overflow, key);
            if (read.kind == MAL_PROPERTY_READ_DATA) {
                *out = read.value;
                return true;
            }
            if (read.kind == MAL_PROPERTY_READ_ACCESSOR) {
                desc = (MalPropertyDesc) {
                    .flags = MAL_PROPERTY_ACCESSOR,
                    .getter = read.value,
                };
                present = true;
            } else {
                present = false;
            }
        } else if (
            cursor->shape->inline_count == 0 && cursor->overflow == nullptr &&
            !(key.kind == MAL_KEY_INDEX && cursor->header.type == MAL_HEAP_ARRAY_OBJECT)
        ) {
            present = false;
        } else {
            MalPropertyLookup lookup = mal_object_get_own(cursor, key);
            present = lookup.present;
            desc = lookup.desc;
        }
        if (present) {
            return mal_vm_desc_read(vm, desc, receiver, out);
        }
        MalObject *parent = mal_object_get_prototype(cursor);
        if (parent == nullptr) {
            return true;
        }
        if (parent->header.type != MAL_HEAP_OBJECT) {
            // OrdinaryGet delegates to an exotic prototype's actual [[Get]], so
            // Proxy traps and synthetic own properties remain observable.
            return mal_vm_get_property_with_receiver(
                vm, mal_value_from_object(parent), key, receiver, out);
        }
        cursor = parent;
    }
    return true;
}

bool mal_vm_get_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *out) {
    return mal_vm_get_property_with_receiver(vm, object_value, key, object_value, out);
}

bool mal_vm_get_property_with_receiver(MalVm *vm, MalValue object_value, MalKey key, MalValue receiver, MalValue *out) {
    *out = mal_value_new_undefined();

    // A proxy routes [[Get]] through its handler trap (or its target).
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_get(vm, mal_value_to_proxy_object(object_value), key, receiver, out);
    }

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return false;
    }

    // Primitive receivers resolve against their prototype intrinsic, with
    // string length and index reads answered by the string itself.
    if (!mal_value_is_object(object_value)) {
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key)) {
                *out = mal_value_from_i32((i32) mal_string_length(string));
                return true;
            }

            if (key.kind == MAL_KEY_INDEX) {
                u32 index = mal_key_index_value(key);
                if ((usize) index < mal_string_length(string)) {
                    *out = mal_value_from_string(mal_intrinsic_code_unit(
                        vm, mal_string_code_units(string)[(usize) index]
                    ));
                }
                return true;
            }

            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_STRING_PROTOTYPE, receiver, key, out);
        }

        if (mal_vm_value_is_number(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_NUMBER_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_boolean(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_symbol(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_SYMBOL_PROTOTYPE, receiver, key, out);
        }

        if (mal_value_is_bigint(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_BIGINT_PROTOTYPE, receiver, key, out);
        }

        return true;
    }

    // Fast path: a present dense array element is an own writable data property,
    // so return it directly — skipping the synthetic/string-exotic/resolve machinery
    // and the prototype walk. A miss (hole or out-of-range) falls through to the full
    // path, which consults the prototype chain. This is the arr[i] read hot path.
    if (key.kind == MAL_KEY_INDEX && mal_value_heap_type(object_value) == MAL_HEAP_ARRAY_OBJECT) {
        const MalArrayObject *array = (const MalArrayObject *) mal_value_to_object(object_value);
        u32 index = mal_key_index_value(key);
        if (mal_array_object_dense_get(array, index, out)) {
            return true;
        }
    }

    // Fast path for an ordinary object: it has no synthetic properties (those
    // belong to arrays / typed arrays / functions / module namespaces) and is
    // not a string-wrapper exotic, so skip both of those probes and go straight
    // to the prototype-chain table lookup. This is the overwhelmingly common
    // shape (object literals, class instances) and the property-access hot path.
    if (mal_value_heap_type(object_value) == MAL_HEAP_OBJECT) {
        return mal_vm_ordinary_get(vm, mal_value_to_object(object_value), key, receiver, out);
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        if (mal_value_is_empty(synthetic)) {
            // A module-namespace export read while its binding is in the TDZ.
            mal_vm_throw_error(
                vm,
                MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE,
                "Cannot access module export before initialization"
            );
            *out = mal_value_new_undefined();
            return true;
        }
        *out = synthetic;
        return true;
    }

    // Integer-indexed exotic [[Get]] owns every canonical numeric key. Invalid
    // and out-of-bounds indices return undefined without consulting the
    // prototype chain.
    if (mal_value_is_typed_array_object(object_value) &&
        (key.kind == MAL_KEY_INDEX ||
         (key.kind == MAL_KEY_STRING &&
          mal_vm_string_is_canonical_numeric_index(
              vm, mal_value_to_string(key.value))))) {
        return true;
    }

    // A String wrapper exposes its [[StringData]] code units as own integer-
    // indexed single-char data properties plus a non-writable, non-configurable
    // own `length`. Other wrapper kinds (Number/Boolean/Symbol/BigInt) are
    // ordinary objects and fall through. An out-of-bounds index or any other key
    // falls through to the ordinary table + prototype-chain resolution below.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, mal_value_to_object(object_value), key, &string_exotic)) {
        return mal_vm_desc_read(vm, string_exotic, receiver, out);
    }

    return mal_vm_ordinary_get(vm, mal_value_to_object(object_value), key, receiver, out);
}

/**
 * Spec HasProperty(O, P): consults synthetic properties (array length, callable
 * prototype, in-bounds typed-array indices) and the ordinary prototype chain.
 * The caller has already verified O is an object.
 */
bool mal_vm_has_property(MalVm *vm, MalValue object_value, MalKey key) {
    // A proxy routes [[HasProperty]] through its handler trap (or its target).
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_has(vm, mal_value_to_proxy_object(object_value), key);
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        return true;
    }

    // Integer-indexed exotic [[HasProperty]] answers every canonical numeric
    // index itself. An invalid or out-of-bounds index is false; it must not fall
    // through to a same-named property on the TypedArray prototype.
    if (mal_value_is_typed_array_object(object_value) &&
        (key.kind == MAL_KEY_INDEX ||
         (key.kind == MAL_KEY_STRING &&
          mal_vm_string_is_canonical_numeric_index(
              vm, mal_value_to_string(key.value))))) {
        return false;
    }

    // String wrapper exotic index/length own properties precede the prototype
    // chain; forEach/indexOf and friends probe HasProperty per index.
    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(&vm->heap, mal_value_to_object(object_value), key, &string_exotic)) {
        return true;
    }

    for (MalObject *cursor = mal_value_to_object(object_value); cursor != nullptr;) {
        if (mal_object_get_own(cursor, key).present) {
            return true;
        }
        MalObject *parent = mal_object_get_prototype(cursor);
        if (parent == nullptr) {
            return false;
        }
        if (parent->header.type != MAL_HEAP_OBJECT) {
            // OrdinaryHasProperty delegates to an exotic prototype's actual
            // [[HasProperty]], rather than flattening it into table probes.
            return mal_vm_has_property(vm, mal_value_from_object(parent), key);
        }
        cursor = parent;
    }
    return false;
}

// ArraySetLength value handling (10.4.2.4 steps 3-15): ToUint32 must round-trip
// ToNumber (a fractional/negative/NaN/>= 2^32 length is a RangeError; ToNumber
// runs user coercion and may throw). A non-writable length only accepts its
// current value. Returns false (and on RangeError/abrupt, sets vm->completion)
// when the length is not fully set; a non-configurable element can block the
// shrink, leaving length at that element + 1.
static bool mal_vm_array_set_length(MalVm *vm, MalArrayObject *array, MalValue value) {
    f64 uint32_number;
    if (!mal_vm_to_number(vm, value, &uint32_number)) {
        return false;
    }
    u32 new_length = mal_ops_number_to_uint32(uint32_number);
    f64 number_length;
    if (!mal_vm_to_number(vm, value, &number_length)) {
        return false;
    }
    if ((f64) new_length != number_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid array length");
        return false;
    }
    if (!array->length_writable && new_length != mal_array_object_length(array)) {
        return false;
    }
    mal_array_object_set_length(array, new_length);
    return mal_array_object_length(array) == new_length;
}

static bool mal_vm_locked_primordial_allows_set(
    MalValue target, MalKey key
) {
    MalPropertyLookup own =
        mal_object_get_own(mal_value_to_object(target), key);
    return own.present &&
        (own.desc.flags & MAL_PROPERTY_ACCESSOR) &&
        (own.desc.flags & MAL_PROPERTY_LOCKED_SETTER) &&
        mal_value_is_callable(own.desc.setter);
}

/**
 * Spec [[Set]] returning the boolean success (never throwing on a plain
 * rejection) used by Reflect.set: an accessor invokes its setter with the
 * receiver, a writable data property (or absent property) is created/updated on
 * the receiver. A throwing user setter propagates through vm->completion.
 */
bool mal_vm_set_property(MalVm *vm, MalValue target, MalKey key, MalValue value, MalValue receiver) {
    // A proxy routes [[Set]] through its handler trap (or its target).
    if (mal_value_is_proxy_object(target)) {
        return mal_proxy_set(vm, mal_value_to_proxy_object(target), key, value, receiver);
    }
    if (mal_value_is_module_namespace_object(target)) return false;

    if (target == receiver && mal_value_is_object(target) &&
        mal_object_is_locked_primordial(mal_value_to_object(target))) {
        if (!mal_vm_locked_primordial_allows_set(target, key)) {
            mal_primordials_throw_property_mutation(
                vm, "Cannot assign locked primordial property '", key);
            return false;
        }
    }

    // IntegerIndexedElementSet coerces the value before checking index validity.
    // A valid index with a distinct receiver takes OrdinarySetWithOwnDescriptor
    // below; an invalid index with a distinct receiver is a successful no-op.
    if (mal_value_is_typed_array_object(target)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(target);
        if (key.kind == MAL_KEY_INDEX) {
            if (array->buffer->immutable) {
                return false;
            }
            u32 index = mal_key_index_value(key);
            if (target == receiver) {
                mal_typed_array_object_set(vm, array, index, value);
                return true;
            }
            if (index >= mal_typed_array_object_length(array)) {
                return true;
            }
        } else if (key.kind == MAL_KEY_STRING &&
                   mal_vm_string_is_canonical_numeric_index(
                       vm, mal_value_to_string(key.value))) {
            if (array->buffer->immutable) {
                return false;
            }
            if (target == receiver) {
                mal_typed_array_object_set(vm, array, UINT32_MAX, value);
            }
            return true;
        }
    }

    // Fast paths for an integer-index [[Set]] of a dense array (target is receiver),
    // skipping the prototype-chain resolve(s) the slow path performs.
    if (target == receiver && key.kind == MAL_KEY_INDEX &&
        mal_value_heap_type(target) == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) mal_value_to_object(target);
        u32 index = mal_key_index_value(key);
        if (index < UINT32_MAX) {
            // (a) Overwrite of a present element: an own writable data property shadows
            // any inherited accessor, so this is sound regardless of the prototype
            // chain or the protector.
            if (mal_array_object_dense_has(array, index) &&
                array->dense_elements_writable) {
                return mal_array_object_dense_store(array, index, value) ==
                    MAL_ARRAY_DENSE_APPLIED;
            }
            // (b) Fresh-index store (append / hole-fill): sound to store directly only
            // when no inherited indexed setter can intercept — the array keeps the
            // default %Array.prototype% and the fast-elements protector holds — and it
            // is extensible with a writable length (else the slow path must reject or
            // handle length specially). A too-sparse index (NEEDS_TABLE) falls through.
            if (!array->dense_deopted && mal_array_elements_protector &&
                array->object.extensible && array->length_writable &&
                array->object.prototype ==
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])) {
                if (mal_array_object_dense_store(array, index, value) ==
                    MAL_ARRAY_DENSE_APPLIED) {
                    if (index >= array->length) {
                        array->length = index + 1;
                    }
                    return true;
                }
            }
        }
    }

    bool own_present;
    MalPropertyDesc own_desc;
    if (!mal_vm_get_own_property(vm, target, key, &own_present, &own_desc)) {
        return false;
    }
    if (!own_present) {
        MalObject *parent = mal_object_get_prototype(mal_value_to_object(target));
        if (parent != nullptr) {
            // OrdinarySetWithOwnDescriptor step 2 preserves Receiver while
            // dispatching the prototype's actual [[Set]] internal method.
            return mal_vm_set_property(
                vm, mal_value_from_object(parent), key, value, receiver);
        }
        own_desc = mal_intrinsic_data_desc(
            mal_value_new_undefined(),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
    }

    if (own_present && (own_desc.flags & MAL_PROPERTY_PRIMORDIAL)) {
        mal_primordials_throw_property_mutation(
            vm, "Cannot assign locked primordial binding '", key);
        return false;
    }

    if (own_desc.flags & MAL_PROPERTY_ACCESSOR) {
        if (!mal_value_is_callable(own_desc.setter)) {
            return false;
        }
        MalCompletion completion =
            mal_vm_call_value(vm, own_desc.setter, receiver, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            return false;
        }
        return true;
    }

    if (!(own_desc.flags & MAL_PROPERTY_WRITABLE) &&
        !(own_desc.flags & MAL_PROPERTY_SHADOW_WRITABLE)) {
        return false;
    }
    if (!mal_value_is_object(receiver)) {
        return false;
    }
    // A proxy receiver routes the create/update of its own property through its
    // [[DefineOwnProperty]] (the defineProperty trap → its target), per the spec
    // OrdinarySetWithOwnDescriptor with Receiver being the proxy.
    if (mal_value_is_proxy_object(receiver)) {
        bool present;
        MalPropertyDesc rdesc;
        if (!mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(receiver), key, &present, &rdesc)) {
            return false;
        }
        MalObject *descriptor;
        if (present) {
            if ((rdesc.flags & MAL_PROPERTY_ACCESSOR) || !(rdesc.flags & MAL_PROPERTY_WRITABLE)) {
                return false;
            }
            descriptor = mal_intrinsic_new_object(vm);
            mal_intrinsic_define_data(vm, descriptor, "value", value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        } else {
            descriptor = mal_intrinsic_new_object(vm);
            MalPropertyFlags df = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
            mal_intrinsic_define_data(vm, descriptor, "value", value, df);
            mal_intrinsic_define_data(vm, descriptor, "writable", mal_value_new_boolean(true), df);
            mal_intrinsic_define_data(vm, descriptor, "enumerable", mal_value_new_boolean(true), df);
            mal_intrinsic_define_data(vm, descriptor, "configurable", mal_value_new_boolean(true), df);
        }
        bool ok = mal_proxy_define_own_property(vm, mal_value_to_proxy_object(receiver), key, mal_value_from_object(descriptor));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        return ok;
    }
    bool receiver_present;
    MalPropertyDesc receiver_desc;
    if (!mal_vm_get_own_property(
            vm, receiver, key, &receiver_present, &receiver_desc)) {
        return false;
    }
    if (receiver_present) {
        if (receiver_desc.flags & MAL_PROPERTY_PRIMORDIAL) {
            mal_primordials_throw_property_mutation(
                vm, "Cannot assign locked primordial binding '", key);
            return false;
        }
        if ((receiver_desc.flags & MAL_PROPERTY_ACCESSOR) ||
            !(receiver_desc.flags & MAL_PROPERTY_WRITABLE)) {
            return false;
        }
        if (mal_value_is_array_object(receiver) && mal_array_key_is_length(key)) {
            return mal_vm_array_set_length(
                vm, mal_value_to_array_object(receiver), value);
        }
        if (mal_value_is_array_object(receiver) && key.kind == MAL_KEY_INDEX) {
            return mal_array_object_set(
                mal_value_to_array_object(receiver), key, value);
        }
        if (mal_value_is_typed_array_object(receiver) && key.kind == MAL_KEY_INDEX) {
            u32 index = mal_key_index_value(key);
            mal_typed_array_object_set(
                vm, mal_value_to_typed_array_object(receiver), index, value);
            return vm->completion.kind != MAL_COMPLETION_THROW;
        }
        receiver_desc.value = value;
        bool applied = mal_object_define_own(
                           mal_value_to_object(receiver), key, &receiver_desc) ==
            MAL_DEFINE_OWN_APPLIED;
        if (applied &&
            mal_value_heap_type(receiver) == MAL_HEAP_ARGUMENTS_OBJECT) {
            MalArgumentsObject *arguments =
                (MalArgumentsObject *) mal_value_to_object(receiver);
            i32 slot = mal_arguments_object_mapped_slot(arguments, key);
            if (slot >= 0) {
                mal_gc_write_barrier(arguments->env->slots[slot]);
                arguments->env->slots[slot] = value;
                mal_gc_card(&arguments->env->header, value);
            }
        }
        return applied;
    }
    if (mal_value_is_module_namespace_object(receiver)) {
        return false;
    }
    if (mal_value_is_typed_array_object(receiver) &&
        (key.kind == MAL_KEY_INDEX ||
         (key.kind == MAL_KEY_STRING &&
          mal_vm_string_is_canonical_numeric_index(
              vm, mal_value_to_string(key.value))))) {
        return false;
    }
    if (mal_value_is_array_object(receiver) && key.kind == MAL_KEY_INDEX) {
        return mal_array_object_store(
            mal_value_to_array_object(receiver), key, value);
    }
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                   MAL_PROPERTY_CONFIGURABLE);
    if (mal_object_define_own(mal_value_to_object(receiver), key, &desc) !=
        MAL_DEFINE_OWN_APPLIED) {
        return false;
    }
    return true;
}

/**
 * Spec [[Delete]] returning the boolean success used by Reflect.deleteProperty
 * and the delete operator: a real own property is removed honoring
 * configurable; a non-configurable synthetic property (array length, callable
 * prototype) cannot be deleted. The caller has verified O is an object.
 */
bool mal_vm_delete_property(MalVm *vm, MalValue object_value, MalKey key) {
    // A proxy routes [[Delete]] through its handler trap (or its target).
    if (mal_value_is_proxy_object(object_value)) {
        return mal_proxy_delete(vm, mal_value_to_proxy_object(object_value), key);
    }

    MalObject *object = mal_value_to_object(object_value);
    if (mal_object_is_locked_primordial(object)) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, object_value, key, &present, &desc)) {
            return false;
        }
        if (!present) return true;
        mal_primordials_throw_property_mutation(
            vm, "Cannot delete locked primordial property '", key);
        return false;
    }

    MalPropertyLookup ordinary_own = mal_object_get_own(object, key);
    if (ordinary_own.present &&
        (ordinary_own.desc.flags & MAL_PROPERTY_PRIMORDIAL)) {
        mal_primordials_throw_property_mutation(
            vm, "Cannot delete locked primordial binding '", key);
        return false;
    }

    if (ordinary_own.present) {
        bool deleted = mal_object_delete_own(object, key);
        if (deleted && mal_object_is_mapped_arguments(object)) {
            mal_arguments_object_unmap((MalArgumentsObject *) object, key);
        }
        return deleted;
    }

    MalPropertyDesc string_exotic;
    if (mal_primitive_wrapper_string_exotic_own(
            &vm->heap, object, key, &string_exotic)) {
        return false;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        return false;
    }

    return mal_object_delete_own(object, key);
}

bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value) {
    // Bound functions defer to their wrapped target.
    while (mal_value_is_bound_function_object(target)) {
        target = mal_value_to_bound_function_object(target)->target;
    }

    if (!mal_value_is_callable(target)) {
        return false;
    }

    // Non-object values answer false before the prototype read.
    if (!mal_value_is_object(value)) {
        return false;
    }

    MalKey key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE);
    MalValue prototype_value = mal_value_new_undefined();
    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, target, key, &synthetic)) {
        prototype_value = synthetic;
    } else if (mal_value_is_object(target)) {
        // Spec OrdinaryHasInstance step 4: P = Get(C, "prototype"), a full [[Get]]
        // that INVOKES a getter-defined `.prototype` and (step 5, ReturnIfAbrupt)
        // propagates a throw. Reading the descriptor's value directly skipped the
        // getter (returning undefined → a spurious TypeError) and swallowed throws.
        if (!mal_vm_get_property(vm, target, key, &prototype_value)) {
            return false;
        }
    }

    if (!mal_value_is_object(prototype_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function has non-object prototype in instanceof check");
        return false;
    }

    // Walk value's prototype chain via [[GetPrototypeOf]] (proxy-aware): a proxy
    // link runs the getPrototypeOf trap, whose abrupt completion must propagate
    // (the caller observes vm->completion). value is already an object here.
    MalObject *prototype = mal_value_to_object(prototype_value);
    MalValue walk = value;
    while (true) {
        MalValue proto;
        if (mal_value_is_proxy_object(walk)) {
            if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(walk), &proto)) {
                return false; // trap threw — leave the throw pending
            }
        } else {
            MalObject *next = mal_object_get_prototype(mal_value_to_object(walk));
            proto = next != nullptr ? mal_value_from_object(next) : mal_value_new_null();
        }

        if (!mal_value_is_object(proto)) {
            return false;
        }
        if (mal_value_to_object(proto) == prototype) {
            return true;
        }
        walk = proto;
    }
}

bool mal_vm_is_constructor(MalVm *vm, MalValue value) {
    while (mal_value_is_bound_function_object(value)) {
        value = mal_value_to_bound_function_object(value)->target;
    }
    if (mal_value_is_proxy_object(value)) {
        // ProxyCreate fixes the presence of [[Construct]] from its target. A
        // revoked constructor proxy remains a constructor whose [[Construct]] throws.
        return mal_value_to_proxy_object(value)->constructor;
    }
    if (mal_value_is_native_function_object(value)) {
        return mal_native_function_object_is_constructor(mal_value_to_native_function_object(value));
    }
    if (mal_value_is_function_object(value)) {
        i32 index = mal_function_object_function_index(mal_value_to_function_object(value));
        const MalFunction *fn = &vm->runtime_image->functions[index];
        // A normal function or class constructor is a constructor; a
        // method/getter/setter/arrow (normal kind, no `prototype`) is not.
        return fn->kind == MAL_FUNCTION_KIND_NORMAL && fn->has_prototype;
    }
    return false;
}

bool mal_vm_is_array(MalVm *vm, MalValue value, bool *is_array_out) {
    while (mal_value_is_proxy_object(value)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(value);
        if (proxy->revoked || mal_value_is_null(proxy->handler)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Cannot perform IsArray on a revoked Proxy");
            return false;
        }
        value = proxy->target;
    }

    *is_array_out = mal_value_is_array_object(value);
    return true;
}

// Spec Set with an already-converted key (defined below); the store inline cache
// converts once and reuses it on the slow path to avoid a second ToPropertyKey.
static void mal_vm_op_store_property_keyed(
    MalVm *vm, MalValue object_value, MalKey key, MalValue value, bool strict);

// Spec Get with an already-converted property key — no further ToPropertyKey, so
// the inline cache can convert the key once and reuse it on the slow path.
static MalValue mal_vm_op_load_property_keyed(MalVm *vm, MalValue object_value, MalKey key) {
    MalValue value;
    if (mal_vm_get_property(vm, object_value, key, &value)) {
        return value;
    }
    return mal_value_new_undefined();
}

// Spec Get over a value with an already-evaluated key value, returning the
// result (undefined on a non-coercible key or a throw — the caller propagates
// vm->completion). Shared by the interpreter op and the native-C backend.
MalValue mal_vm_op_load_property(MalVm *vm, MalValue object_value, MalValue key_value) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return mal_value_new_undefined();
    }
    return mal_vm_op_load_property_keyed(vm, object_value, key);
}

static bool mal_ic_key_is_stable_string(MalValue key) {
    // Property-IC slow paths canonicalize string keys through vm->atoms before
    // reaching any recorder. The atom table is a VM root, so these identities
    // remain valid for exactly the same lifetime as the VM-owned cache rows.
    return mal_value_is_string(key);
}

/**
 * Attribute destructive cache-row replacement without changing shipping builds.
 * A populated property IC always owns a canonical nonzero string key; zero-key
 * rows are untouched allocation-time state and are not mode transitions.
 */
static void mal_perf_ic_note_replacement(const MalInlineCache *ic, u8 next_mode) {
#if MAL_PERF_STATS
    if (mal_perf_stats_enabled && ic->key != 0 &&
        ic->mode < MAL_PERF_IC_MODE_COUNT &&
        next_mode < MAL_PERF_IC_MODE_COUNT) {
        mal_perf_stats.ic_mode_replacements[ic->mode][next_mode]++;
    }
#else
    (void) ic;
    (void) next_mode;
#endif
}

static void mal_ic_detach_prototype_cache(MalInlineCache *ic) {
    if ((ic->mode == MAL_IC_MODE_INHERITED_VALUE && ic->poly_count > 0) ||
		ic->mode == MAL_IC_MODE_INHERITED_SLOT ||
		ic->mode == MAL_IC_MODE_INHERITED_TABLE ||
		(ic->mode == MAL_IC_MODE_TRANSITION && ic->obj != nullptr) ||
		ic->mode == MAL_IC_MODE_CONSTRUCTOR_LAYOUT ||
		(ic->mode == MAL_IC_MODE_MISSING &&
         ic->receiver_type == MAL_IC_MISSING_EXACT_CHAIN &&
         ic->poly_count > 0)) {
        mal_object_unregister_prototype_cache(ic);
    }
}

bool mal_vm_own_table_try_load(
    const MalObject *object, MalValue key, const MalInlineCache *ic, MalValue *out
) {
    if (object->header.type != MAL_HEAP_OBJECT || key != ic->key ||
        object->shape->inline_count != 0 || object->overflow == nullptr) {
        return false;
    }
    MalValue value;
    u8 flags;
    if (!mal_table_read_entry_hint(object->overflow, ic->entry, key, &value, &flags) ||
        (flags & MAL_PROPERTY_ACCESSOR)) {
        return false;
    }
    *out = value;
    MAL_PERF_COUNT(ic_load_own_table_hits);
    return true;
}

static void mal_ic_record_own_table(MalInlineCache *ic, MalValue key, void *entry) {
    mal_perf_ic_note_replacement(ic, MAL_IC_MODE_OWN_TABLE);
    mal_ic_detach_prototype_cache(ic);
    *ic = (MalInlineCache) {
        .key = key,
        .entry = entry,
        .mode = MAL_IC_MODE_OWN_TABLE,
    };
    MAL_PERF_COUNT(ic_load_own_table_fills);
}

static void mal_ic_record_special(
    MalVm *vm, MalInlineCache *ic, u8 mode, u8 prim_kind, MalValue key,
    MalValue value, const MalObject *prototype
) {
    mal_perf_ic_note_replacement(ic, mode);
    mal_ic_detach_prototype_cache(ic);
    ic->prototype = prototype;
    ic->key = key;
    ic->value = value;
    ic->slot = MAL_IC_VALUE_SLOT;
    ic->prim_kind = prim_kind;
    ic->poly_count = 0;
    ic->megamorphic = false;
    ic->mode = mode;
    ic->receiver_type = 0;
#if MAL_REALMS
    if (mode == MAL_IC_MODE_PRIMITIVE_VALUE) {
        ic->realm = vm->current_realm;
    } else {
        ic->obj = nullptr;
    }
#else
    ic->obj = nullptr;
    (void) vm;
#endif
}

/** Record a protector-gated own value on one exact watched intrinsic object. */
static void mal_ic_record_watched(
    MalInlineCache *ic, const MalObject *object, MalValue key, MalValue value
) {
    mal_perf_ic_note_replacement(ic, MAL_IC_MODE_SHAPE);
    mal_ic_detach_prototype_cache(ic);
    ic->shape = object->shape;
    ic->key = key;
    ic->value = value;
    ic->obj = object;
    ic->slot = MAL_IC_VALUE_SLOT;
    ic->prim_kind = 0;
    // A cache row may previously have held a shaped missing-chain entry. Clear
    // every own-slot discriminator so its prototype shapes/undefined slot words
    // cannot be reinterpreted as polymorphic own-slot rows after this mode switch.
    ic->poly_count = 0;
    ic->megamorphic = false;
    ic->mode = MAL_IC_MODE_SHAPE;
    ic->receiver_type = 0;
}

// Record a resolved plain-object data slot (shape -> slot for `key`) in the site
// cache. The primary (shape/slot) stays the first entry; a fixed-key site that
// sees another shape accumulates it into the polymorphic overflow, up to
// MAL_IC_POLY_EXTRA, after which the site is marked megamorphic and stops growing.
// A key change (computed-key site) or a site currently holding a protector-gated
// special entry (prim-method / watched-value) restarts monomorphic for this slot.
static void mal_ic_record(MalInlineCache *ic, const MalShape *shape, MalValue key, u32 slot) {
    mal_ic_detach_prototype_cache(ic);
    if (ic->mode != MAL_IC_MODE_SHAPE || key != ic->key || ic->shape == nullptr ||
        ic->slot == MAL_IC_VALUE_SLOT || ic->prim_kind != 0) {
        mal_perf_ic_note_replacement(ic, MAL_IC_MODE_SHAPE);
        ic->shape = shape;
        ic->key = key;
        ic->slot = slot;
        ic->prim_kind = 0;
        ic->mode = MAL_IC_MODE_SHAPE;
#if MAL_REALMS
        ic->realm = nullptr;
#endif
        ic->poly_count = 0;
        ic->megamorphic = false;
        return;
    }
    if (shape == ic->shape || ic->megamorphic) {
        return;
    }
    for (u8 i = 0; i < ic->poly_count; i++) {
        if (ic->poly_shape[i] == shape) {
            return;
        }
    }
    if (ic->poly_count < MAL_IC_POLY_EXTRA) {
        ic->poly_shape[ic->poly_count] = shape;
        mal_ic_set_poly_slot(ic, ic->poly_count, slot);
        ic->poly_count++;
    } else {
        ic->megamorphic = true;
    }
}

u64 mal_ic_recorded_prototype_epoch(const MalInlineCache *ic) {
    return mal_ic_unpack_prototype_epoch(ic);
}

void mal_vm_property_cache_invalidate(void *cache) {
    *(MalInlineCache *) cache = (MalInlineCache) {0};
}

/**
 * Attach this stable VM-owned site to every object whose mutation can invalidate
 * the resolved chain. Hits then need only the receiver's exact first-prototype
 * identity; mutations eagerly clear the dependent row.
 */
static bool mal_ic_record_local_prototype_chain(
    MalObject *receiver, MalObject *holder, MalInlineCache *ic,
    bool include_receiver
) {
    if (receiver->prototype == nullptr) {
        return false;
    }
    bool same_positive_chain =
        ((ic->mode == MAL_IC_MODE_INHERITED_VALUE && ic->poly_count > 0) ||
         ic->mode == MAL_IC_MODE_INHERITED_SLOT ||
         ic->mode == MAL_IC_MODE_INHERITED_TABLE) &&
        ic->poly_count > 0 &&
        ic->proto_object[0] == receiver->prototype &&
        ic->proto_object[1] == holder &&
        (!include_receiver ||
         (ic->receiver_type == MAL_IC_RECEIVER_DICTIONARY &&
          ic->obj == receiver));
    bool same_missing_chain =
        ic->mode == MAL_IC_MODE_MISSING &&
        ic->receiver_type == MAL_IC_MISSING_EXACT_CHAIN &&
        ic->poly_count > 0 &&
        ic->proto_object[0] == receiver->prototype &&
        holder == nullptr;
    if (!same_positive_chain && !same_missing_chain &&
        !mal_object_register_prototype_cache(
            receiver, holder, ic, include_receiver)) {
        return false;
    }
    ic->proto_object[0] = receiver->prototype;
    ic->proto_object[1] = holder;
    ic->poly_count = 1;
    return true;
}

/**
 * Record an ordinary-object fresh-property transition. The child shape and slot
 * are immutable VM-lifetime identities. When the receiver has a prototype,
 * register the row against the complete chain so any structural mutation
 * invalidates this shortcut before it can bypass [[Set]] semantics.
 */
static bool mal_ic_record_transition(
    MalObject *object, const MalShape *source, MalValue key,
    const MalShape *child, MalInlineCache *ic
) {
    if (object->prototype == nullptr) {
        mal_ic_detach_prototype_cache(ic);
    } else if (!(ic->mode == MAL_IC_MODE_TRANSITION &&
                 ic->obj == object->prototype) &&
               !mal_object_register_prototype_cache(
                   object, nullptr, ic, false)) {
        mal_vm_property_cache_invalidate(ic);
        return false;
    }
    mal_perf_ic_note_replacement(ic, MAL_IC_MODE_TRANSITION);
    ic->shape = source;
    ic->key = key;
    ic->obj = object->prototype;
    ic->poly_shape[0] = child;
    ic->slot = (u8) (child->inline_count - 1);
    ic->prim_kind = 0;
    ic->poly_count = 0;
    ic->megamorphic = false;
    ic->mode = MAL_IC_MODE_TRANSITION;
    ic->receiver_type = 0;
    return true;
}

/**
 * Whether OrdinarySet on a receiver with no own `key` may directly create the
 * default own data property. Exotic prototypes must dispatch their actual
 * [[Set]], accessors intercept, and non-writable inherited data rejects. A
 * writable inherited data property (or an absent property) permits creation.
 */
static bool mal_prototype_chain_allows_transition_store(
    const MalObject *prototype, MalKey key
) {
    for (const MalObject *cursor = prototype; cursor != nullptr; cursor = cursor->prototype) {
        if (cursor->header.type != MAL_HEAP_OBJECT) {
            return false;
        }
        MalPropertyLookup lookup = mal_object_get_own(cursor, key);
        if (!lookup.present) {
            continue;
        }
        return !(lookup.desc.flags & MAL_PROPERTY_ACCESSOR) &&
            (lookup.desc.flags &
             (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_SHADOW_WRITABLE));
    }
    return true;
}

bool mal_vm_guard_base_constructor_layout(
    MalVm *vm, MalValue callee, i32 function_index, i32 key_count,
    const i32 *key_string_indices, MalInlineCache *ic
) {
    if (!mal_vm_callee_has_index(vm, callee, function_index) || key_count < 1 ||
        key_count > MAL_SHAPE_MAX_INLINE_SLOTS) {
        return false;
    }
    MalFunctionObject *function = mal_value_to_function_object(callee);
    if (ic->mode == MAL_IC_MODE_CONSTRUCTOR_LAYOUT &&
        ic->obj == &function->object) {
        return true;
    }
    MalPropertyLookup prototype_property = mal_object_get_own(
        &function->object,
        mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE));
    if (!prototype_property.present ||
        (prototype_property.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        !mal_value_is_heap_type(prototype_property.desc.value, MAL_HEAP_OBJECT)) {
        return false;
    }
    MalObject *prototype = mal_value_to_object(prototype_property.desc.value);
    for (i32 index = 0; index < key_count; index++) {
        i32 string_index = key_string_indices[index];
        if (string_index < 0 || string_index >= vm->runtime_image->string_constant_count) {
            return false;
        }
        MalKey key = {
            .kind = MAL_KEY_STRING,
            .value = mal_value_from_string(vm->string_constant_atoms[string_index]),
        };
        if (!mal_prototype_chain_allows_transition_store(prototype, key)) return false;
    }
    mal_object_register_constructor_layout_cache(&function->object, prototype, ic);
    *ic = (MalInlineCache) {
        .obj = &function->object,
        .proto_object = {prototype},
        .mode = MAL_IC_MODE_CONSTRUCTOR_LAYOUT,
    };
    return true;
}

static bool mal_ic_can_apply_transition_store(const MalObject *object, MalKey key) {
	return mal_prototype_chain_allows_transition_store(object->prototype, key);
}

static bool mal_ic_try_record_inherited_slot(
    MalValue receiver, MalValue key_value, MalPropertyResolution resolution,
    MalInlineCache *ic, bool count_fill
) {
    if (!mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT) ||
        (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        return false;
    }

    MalObject *object = mal_value_to_object(receiver);
    bool dictionary_receiver = mal_object_has_public_overflow(object);
    if ((dictionary_receiver && object->shape->inline_count != 0) ||
        resolution.holder == nullptr ||
        resolution.holder->header.type != MAL_HEAP_OBJECT) {
        return false;
    }

    MalKey key = mal_key_from_value(key_value);
    if (dictionary_receiver && mal_object_get_own(object, key).present) {
        return false;
    }

    // Admit any-depth ordinary chains, including dictionary intermediates. Every
    // object reached after the receiver is marked as a prototype at attachment
    // time, so a later structural mutation invalidates the shared epoch.
    bool found_holder = false;
    for (MalObject *cursor = object->prototype; cursor != nullptr; cursor = cursor->prototype) {
        if (cursor->header.type != MAL_HEAP_OBJECT) {
            return false;
        }
        if (cursor == resolution.holder) {
            found_holder = true;
            break;
        }
    }
    if (!found_holder) {
        return false;
    }

    MalPropertyLookup own = mal_object_get_own(resolution.holder, key);
    if (!own.present || (own.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        own.desc.value != resolution.desc.value) {
        return false;
    }

    if (mal_ic_record_local_prototype_chain(
            object, resolution.holder, ic, dictionary_receiver)) {
        mal_perf_ic_note_replacement(ic, MAL_IC_MODE_INHERITED_VALUE);
        ic->shape = object->shape;
        ic->key = key_value;
        ic->value = resolution.desc.value;
        ic->slot = MAL_IC_VALUE_SLOT;
        ic->prim_kind = 0;
        ic->megamorphic = false;
        ic->mode = MAL_IC_MODE_INHERITED_VALUE;
        ic->receiver_type = dictionary_receiver
            ? MAL_IC_RECEIVER_DICTIONARY
            : MAL_HEAP_OBJECT;
        if (dictionary_receiver) ic->obj = object;
        if (count_fill) MAL_PERF_COUNT(ic_inherited_fills);
        return true;
    }

    u8 mode;
    u32 slot;
    if (!mal_object_has_public_overflow(resolution.holder)) {
        i32 index = mal_shape_find(
            resolution.holder->shape, key, MAL_SHAPE_FIND_LOAD_IC);
        if (index < 0) {
            return false;
        }
        mode = MAL_IC_MODE_INHERITED_SLOT;
        slot = resolution.holder->shape->props[index].slot;
    } else {
        if (own.entry == nullptr) {
            return false;
        }
        mode = MAL_IC_MODE_INHERITED_TABLE;
        ic->entry = own.entry;
        ic->table_handle_epoch = mal_table_handle_epoch(resolution.holder->overflow);
    }

    mal_perf_ic_note_replacement(ic, mode);
    ic->shape = object->shape;
    ic->key = key_value;
    ic->slot = slot;
    ic->prim_kind = 0;
    if (mal_prototype_chain_epoch == 0) {
        return false;
    }
    ic->proto_object[0] = object->prototype;
    ic->proto_object[1] = resolution.holder;
    mal_ic_set_recorded_prototype_epoch(ic, mal_prototype_chain_epoch);
    ic->poly_count = 0;
    ic->megamorphic = false;
    ic->mode = mode;
    ic->receiver_type = MAL_HEAP_OBJECT;
    if (count_fill) MAL_PERF_COUNT(ic_inherited_fills);
    return true;
}

static bool mal_ic_try_record_missing(
    MalValue receiver, MalValue key_value, MalInlineCache *ic, bool count_fill
) {
    if (!mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT)) {
        return false;
    }
    MalObject *object = mal_value_to_object(receiver);
    if (mal_object_has_public_overflow(object)) {
        return false;
    }

    const MalShape *prototype_shapes[MAL_IC_POLY_EXTRA];
    u32 depth = 0;
    bool shape_chain = true;
    for (MalObject *cursor = object->prototype; cursor != nullptr; cursor = cursor->prototype) {
        if (cursor->header.type != MAL_HEAP_OBJECT) {
            return false;
        }
        if (mal_object_has_public_overflow(cursor) || depth >= MAL_IC_POLY_EXTRA) {
            shape_chain = false;
        } else if (shape_chain) {
            prototype_shapes[depth] = cursor->shape;
        }
        depth++;
    }

    // An exact-chain entry is deliberately monomorphic. Replacing it at a site
    // that alternates dictionary/deep prototype objects turns every access into
    // a miss+refill; retain the first exact chain until a broader shaped-chain
    // entry becomes available. A later mutation of the same chain may refresh
    // its epoch normally.
    if (!shape_chain && ic->mode == MAL_IC_MODE_MISSING &&
        (ic->receiver_type == MAL_IC_MISSING_SHAPE_CHAIN ||
         ic->proto_object[0] != object->prototype)) {
        return false;
    }

    mal_perf_ic_note_replacement(ic, MAL_IC_MODE_MISSING);
    ic->shape = object->shape;
    ic->key = key_value;
    ic->slot = MAL_IC_VALUE_SLOT;
    ic->prim_kind = 0;
    if (shape_chain) {
        for (u32 i = 0; i < depth; i++) {
            ic->poly_shape[i] = prototype_shapes[i];
        }
        ic->poly_count = (u8) depth;
        ic->receiver_type = MAL_IC_MISSING_SHAPE_CHAIN;
    } else {
        if (!mal_ic_record_local_prototype_chain(
                object, nullptr, ic, false)) {
            if (mal_prototype_chain_epoch == 0) {
                return false;
            }
            ic->proto_object[0] = object->prototype;
            mal_ic_set_recorded_prototype_epoch(ic, mal_prototype_chain_epoch);
            ic->poly_count = 0;
        }
        ic->receiver_type = MAL_IC_MISSING_EXACT_CHAIN;
    }
    ic->megamorphic = false;
    ic->mode = MAL_IC_MODE_MISSING;
    if (count_fill) MAL_PERF_COUNT(ic_load_missing_fills);
    return true;
}

static void mal_ic_try_record_inherited(
    MalVm *vm, MalValue receiver, MalValue key_value, MalValue result, MalInlineCache *ic
) {
    if (!mal_value_is_object(receiver) || mal_value_is_proxy_object(receiver)) {
        MAL_PERF_COUNT(ic_inherited_reject_basic);
        return;
    }
    if (!mal_value_is_string(key_value)) {
        MAL_PERF_COUNT(ic_inherited_reject_key);
        return;
    }

    MalObject *object = mal_value_to_object(receiver);
    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        MAL_PERF_COUNT(ic_inherited_reject_resolution);
        return;
    }
    MalPropertyResolution resolution = mal_object_resolve_property(object, key);
    if (!resolution.found) {
        if (result == mal_value_new_undefined() &&
            mal_ic_try_record_missing(receiver, key_value, ic, true)) {
            MalObject *object = mal_value_to_object(receiver);
            MalInlineCache *stub =
                &mal_vm_inherited_property_stub_cache(vm)[mal_inherited_stub_hash(
                    object->shape, object->prototype, key_value)];
            if (stub != ic) {
                // A direct-mapped collision replaces the old independently
                // registered chain. Clearing first bypasses the per-site policy
                // that deliberately retains one exact deep-chain row.
                mal_ic_detach_prototype_cache(stub);
                *stub = (MalInlineCache) {0};
                (void) mal_ic_try_record_missing(
                    receiver, key_value, stub, false);
            }
            return;
        }
        MAL_PERF_COUNT(ic_inherited_reject_resolution);
        return;
    }
    if (resolution.own ||
        (resolution.desc.flags & MAL_PROPERTY_ACCESSOR) ||
        resolution.desc.value != result) {
        MAL_PERF_COUNT(ic_inherited_reject_resolution);
        return;
    }

    if (mal_ic_try_record_inherited_slot(
            receiver, key_value, resolution, ic, true)) {
        MalInlineCache *stub =
            &mal_vm_inherited_property_stub_cache(vm)[mal_inherited_stub_hash(
                object->shape, object->prototype, key_value)];
        if (stub != ic) {
            (void) mal_ic_try_record_inherited_slot(
                receiver, key_value, resolution, stub, false);
        }
        return;
    }

    if (!mal_primitive_method_protector) {
        MAL_PERF_COUNT(ic_inherited_reject_basic);
        return;
    }

    bool stable_chain = false;
    for (MalObject *cursor = object->prototype; cursor != nullptr; cursor = cursor->prototype) {
        if (!cursor->watched_method_proto) {
            break;
        }
        if (cursor == resolution.holder) {
            stable_chain = true;
            break;
        }
    }
    if (!stable_chain) {
        MAL_PERF_COUNT(ic_inherited_reject_chain);
        return;
    }

    mal_perf_ic_note_replacement(ic, MAL_IC_MODE_INHERITED_VALUE);
    mal_ic_detach_prototype_cache(ic);
    ic->shape = object->shape;
    ic->key = key_value;
    ic->value = result;
    ic->obj = object->prototype;
    ic->slot = MAL_IC_VALUE_SLOT;
    ic->prim_kind = 0;
    ic->poly_count = 0;
    ic->megamorphic = false;
    ic->mode = MAL_IC_MODE_INHERITED_VALUE;
    ic->receiver_type = (u8) object->header.type;
    MAL_PERF_COUNT(ic_inherited_fills);
}

static MalValue mal_vm_op_load_property_ic_impl(
    MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic,
    bool static_probe_missed
) {
    MAL_PERF_COUNT(ic_load_fallbacks);
    MalKey converted_key;
    bool key_converted = false;
    if (mal_value_is_string(key_value)) {
        if (!mal_vm_string_to_property_key(vm, key_value, &converted_key)) {
            return mal_value_new_undefined();
        }
        key_converted = true;
        if (converted_key.kind == MAL_KEY_STRING) {
            // All cache probes and fills below now use the VM-lifetime atom, not
            // the transient string instance supplied by a computed-key access.
            key_value = converted_key.value;
        }
    }
    MalValue special_value;
    if (!static_probe_missed &&
        mal_vm_special_try_load(vm, object_value, key_value, ic, &special_value)) {
        return special_value;
    }
    MalValue inherited_value;
    if (!static_probe_missed &&
        mal_vm_inherited_try_load(object_value, key_value, ic, &inherited_value)) {
        return inherited_value;
    }
    bool inherited_stub_already_probed =
        static_probe_missed &&
        mal_value_is_heap_type(object_value, MAL_HEAP_OBJECT) &&
        ic->mode == MAL_IC_MODE_SHAPE && ic->shape != nullptr &&
        ic->slot != MAL_IC_VALUE_SLOT;
    if (!inherited_stub_already_probed &&
        vm->inherited_property_stub != nullptr &&
        mal_value_is_heap_type(object_value, MAL_HEAP_OBJECT) &&
        mal_value_is_string(key_value)) {
        const MalObject *object = mal_value_to_object(object_value);
        const MalInlineCache *stub =
            &vm->inherited_property_stub[mal_inherited_stub_hash(
                object->shape, object->prototype, key_value)];
        if (mal_vm_inherited_try_load(
                object_value, key_value, stub, &inherited_value)) {
            return inherited_value;
        }
    }
    // Array `.length`: an exotic own field (not a shape slot, and arrays are not
    // MAL_HEAP_OBJECT). Read it directly and record an exact-key mode so subsequent
    // accesses can read the current length in the caller's inline fast path.
    if (mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT) && mal_value_is_string(key_value)
        && mal_array_key_is_length((MalKey){.kind = MAL_KEY_STRING, .value = key_value})) {
        if (mal_ic_key_is_stable_string(key_value)) {
            mal_ic_record_special(
                vm, ic, MAL_IC_MODE_ARRAY_LENGTH, 0, key_value,
                mal_value_new_undefined(), nullptr);
        }
        return mal_ops_number_value((f64) ((const MalArrayObject *) mal_value_to_heap(object_value))->length);
    }
    if (mal_value_is_string(key_value) &&
        mal_array_key_is_length((MalKey) {.kind = MAL_KEY_STRING, .value = key_value})) {
        MalTypedArrayObject *array;
        u32 length;
        if (mal_vm_admit_typed_array_length(vm, object_value, &array, &length)) {
            if (mal_ic_key_is_stable_string(key_value)) {
                mal_ic_record_special(
                    vm, ic, MAL_IC_MODE_TYPED_ARRAY_LENGTH, 0, key_value,
                    mal_value_new_undefined(), nullptr);
            }
            return mal_value_from_i32((i32) length);
        }
    }
    MalObject *slot_object = mal_vm_as_own_slot_object(object_value);
    if (slot_object != nullptr) {
        MalObject *object = slot_object;
        bool ordinary_static_probe_missed =
            static_probe_missed && object->header.type == MAL_HEAP_OBJECT;
        MalValue own_table_value;
        if (!ordinary_static_probe_missed &&
            ic->mode == MAL_IC_MODE_OWN_TABLE &&
            mal_vm_own_table_try_load(object, key_value, ic, &own_table_value)) {
            return own_table_value;
        }
        // Hit needs the same shape AND the same key: a computed-key site (o[k])
        // reuses one cache entry across different keys, so the key must match too.
        if (!ordinary_static_probe_missed &&
            ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape && key_value == ic->key) {
            if (ic->slot == MAL_IC_VALUE_SLOT) {
                // Watched-intrinsic own overflow property, cached by value. The
                // shape gate above is NOT sufficient (same-layout intrinsics share
                // a shape but differ in overflow values), so require exact object
                // identity too.
                if (mal_primitive_method_protector && object == ic->obj) {
                    MAL_PERF_COUNT(ic_load_watched_hits);
                    return ic->value;
                }
                // Protector broke or different watched object at this polymorphic
                // site: fall through and re-resolve (may re-fill for this object).
            } else {
                MAL_PERF_COUNT(ic_load_slow_mono_hits);
                return object->slots[ic->slot]; // same layout + key: slot still valid
            }
        }
        // Polymorphic overflow: a previously-seen alternate shape for the same key
        // (matches the inline fast path in mal_vm_indexed_fast_load).
        if (!ordinary_static_probe_missed &&
            ic->mode == MAL_IC_MODE_SHAPE && ic->poly_count > 0 &&
            ic->slot != MAL_IC_VALUE_SLOT && key_value == ic->key) {
            for (u8 i = 0; i < ic->poly_count; i++) {
                if (object->shape == ic->poly_shape[i]) {
                    MAL_PERF_COUNT(ic_load_poly_hits);
                    return object->slots[mal_ic_poly_slot(ic, i)];
                }
            }
        }
        // Megamorphic: consult the shared stub cache before a shape search (serves
        // the interpreter and any compiled access whose inline stub probe was cold).
        if (ic->megamorphic) {
            const MalPropertyStubEntry *e =
                &mal_vm_property_stub_cache(vm)[
                    mal_stub_hash(object->shape, key_value)];
            if (e->shape == object->shape && e->key == key_value) {
                MAL_PERF_COUNT(ic_load_mega_hits);
                return object->slots[e->slot];
            }
            MAL_PERF_COUNT(ic_load_mega_misses);
        }
        // Miss on a plain object. Convert the key ONCE (running any user
        // toString/valueOf exactly once) and reuse it for both the cache fill and
        // the slow path — never fall through to a re-converting generic op.
        MalKey key;
        if (key_converted) {
            key = converted_key;
        } else if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
            return mal_value_new_undefined();
        }
        if (key.kind == MAL_KEY_STRING) {
            i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_LOAD_IC);
            if (idx >= 0) {
                MAL_PERF_COUNT(ic_load_shape_hits);
                const MalShapeProp *prop = &object->shape->props[idx];
                // Canonical string atoms are rooted by the VM for the lifetime of
                // this VM-owned cache row, so pointer identity is ABA-safe even
                // when the source expression produced a collectable string.
                if (mal_ic_key_is_stable_string(key_value)) {
                    mal_ic_record(ic, object->shape, key_value, prop->slot);
                    MAL_PERF_COUNT(ic_load_shape_fills);
                    // Warm the shared stub cache so a megamorphic site's next access to
                    // this (shape,key) is an O(1) probe rather than another shape search.
                    MalPropertyStubEntry *stub =
                        &mal_vm_property_stub_cache(vm)[
                            mal_stub_hash(object->shape, key_value)];
                    stub->shape = object->shape;
                    stub->key = key_value;
                    stub->slot = prop->slot;
                    stub->attrs = prop->attrs;
                } else {
                    MAL_PERF_COUNT(ic_load_shape_uncacheable);
                }
                return object->slots[prop->slot];
            }
            // Own overflow-table data property on a watched intrinsic (String, Math,
            // JSON, Object, Array, …): its many static/namespace methods live in the
            // overflow table (no shape slot), so `String.fromCharCode` / `Math.floor`
            // would re-hash every call. Cache the value while the protector holds; any
            // mutation of a watched intrinsic clears it. Accessors are excluded
            // (their getter must run per access).
            if (object->watched_method_proto && mal_primitive_method_protector
                && mal_ic_key_is_stable_string(key_value)) {
                MalPropertyLookup own = mal_object_get_own(object, key);
                if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
                    mal_ic_record_watched(ic, object, key_value, own.desc.value);
                    MAL_PERF_COUNT(ic_load_watched_fills);
                    return own.desc.value;
                }
            }
        }
        if (object->header.type == MAL_HEAP_OBJECT &&
            object->shape->inline_count == 0 && object->overflow != nullptr &&
            key.kind == MAL_KEY_STRING) {
            MalValue result = mal_value_new_undefined();
            MalPropertyLookup own = mal_property_lookup(object->overflow, key);
            if (own.present) {
                if (!(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
                    if (mal_ic_key_is_stable_string(key_value)) {
                        mal_ic_record_own_table(ic, key_value, own.entry);
                    }
                    return own.desc.value;
                }
                mal_vm_desc_read(vm, own.desc, object_value, &result);
            } else if (object->prototype != nullptr) {
                mal_vm_get_property_with_receiver(
                    vm, mal_value_from_object(object->prototype), key, object_value, &result);
            }
            if (!own.present && vm->completion.kind != MAL_COMPLETION_THROW) {
                mal_ic_try_record_inherited(
                    vm, object_value, key_value, result, ic);
            }
            return result;
        }
        MAL_PERF_COUNT(ic_load_plain_generic);
        MalValue result = mal_vm_op_load_property_keyed(vm, object_value, key);
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_ic_try_record_inherited(vm, object_value, key_value, result, ic);
        }
        return result;
    }

    // Primitive-method inline cache: a method-name load on a string/number/boolean/
    // symbol/bigint resolves on that kind's prototype every time otherwise (the
    // dominant cost of string/number-method-heavy loops). Cache the resolved method
    // while `mal_primitive_method_protector` holds (no watched prototype mutated).
    u8 prim_kind = mal_vm_primitive_method_kind(object_value);
    if (prim_kind != 0) {
        if (prim_kind == MAL_PRIM_KIND_STRING && mal_value_is_string(key_value) &&
            mal_array_key_is_length((MalKey){.kind = MAL_KEY_STRING, .value = key_value})) {
            if (mal_ic_key_is_stable_string(key_value)) {
                mal_ic_record_special(
                    vm, ic, MAL_IC_MODE_STRING_LENGTH, 0, key_value,
                    mal_value_new_undefined(), nullptr);
            }
            return mal_value_from_i32((i32) mal_value_to_string(object_value)->length);
        }
        MalValue result = key_converted
            ? mal_vm_op_load_property_keyed(vm, object_value, converted_key)
            : mal_vm_op_load_property(vm, object_value, key_value);
        // Cache only a plain DATA method resolved on the (watched) prototype chain:
        // an immortal string key that is not a string-receiver exotic own (length /
        // canonical index, resolved on the value not the prototype) and not an
        // accessor (whose getter must run each time).
        if (mal_primitive_method_protector
            && vm->completion.kind != MAL_COMPLETION_THROW
            && mal_ic_key_is_stable_string(key_value)) {
            MalKey key = {.kind = MAL_KEY_STRING, .value = key_value};
            bool string_exotic = prim_kind == MAL_PRIM_KIND_STRING &&
                (mal_array_key_is_length(key) ||
                    mal_vm_string_is_canonical_numeric_index(vm, mal_value_to_string(key_value)));
            if (!string_exotic) {
                MalObject *proto =
                    mal_value_to_object(vm->intrinsics[mal_vm_primitive_method_proto_slot(prim_kind)]);
                MalPropertyResolution res = mal_object_resolve_property(proto, key);
                if (res.found && !(res.desc.flags & MAL_PROPERTY_ACCESSOR) &&
                    res.desc.value == result) {
                    mal_ic_record_special(
                        vm, ic, MAL_IC_MODE_PRIMITIVE_VALUE, prim_kind,
                        key_value, result, proto);
                    MAL_PERF_COUNT(ic_load_primitive_fills);
                }
            }
        } else {
            MAL_PERF_COUNT(ic_load_primitive_uncacheable);
        }
        return result;
    }

    // Watched-intrinsic constructor/function own property (String.fromCharCode,
    // Object.keys, Array.from, …): these are native-function objects, not
    // MAL_HEAP_OBJECT, so the object branch above skipped them. Cache their own
    // overflow-table methods by value while the protector holds (same rules as the
    // plain-object namespaces Math/JSON handled above). Non-watched objects fall
    // straight through (one predictable flag load).
    if (mal_value_is_object(object_value)) {
        MalObject *object = mal_value_to_object(object_value);
        if (object->watched_method_proto && mal_primitive_method_protector) {
            // Object identity — not just shape — because the typed-array
            // constructors share one shape yet differ in overflow values
            // (BYTES_PER_ELEMENT, name, …); shape+key alone would false-hit at a
            // polymorphic site iterating over constructors.
            if (ic->slot == MAL_IC_VALUE_SLOT && ic->mode == MAL_IC_MODE_SHAPE
#if MAL_REALMS
                && ic->prim_kind == 0
#endif
                && object == ic->obj && key_value == ic->key) {
                MAL_PERF_COUNT(ic_load_watched_hits);
                return ic->value;
            }
            if (mal_ic_key_is_stable_string(key_value)) {
                MalKey key = {.kind = MAL_KEY_STRING, .value = key_value};
                MalPropertyLookup own = mal_object_get_own(object, key);
                if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
                    mal_ic_record_watched(ic, object, key_value, own.desc.value);
                    MAL_PERF_COUNT(ic_load_watched_fills);
                    return own.desc.value;
                }
            }
        }
    }
    MAL_PERF_COUNT(ic_load_other_generic);
    MalValue result = key_converted
        ? mal_vm_op_load_property_keyed(vm, object_value, converted_key)
        : mal_vm_op_load_property(vm, object_value, key_value);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_ic_try_record_inherited(vm, object_value, key_value, result, ic);
    }
    return result;
}

MalValue mal_vm_op_load_property_ic(
    MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic
) {
    return mal_vm_op_load_property_ic_impl(
        vm, object_value, key_value, ic, false);
}

MalValue mal_vm_op_load_property_ic_static_miss(
    MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic
) {
    return mal_vm_op_load_property_ic_impl(
        vm, object_value, key_value, ic, true);
}

void mal_vm_op_store_property_ic(
    MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict, MalInlineCache *ic
) {
    MAL_PERF_COUNT(ic_store_fallbacks);
    if (mal_value_is_heap_type(object_value, MAL_HEAP_OBJECT)) {
        MalObject *object = (MalObject *) mal_value_to_heap(object_value);
        MalKey converted_key;
        bool key_converted = false;
        if (mal_value_is_string(key_value)) {
            if (!mal_vm_string_to_property_key(vm, key_value, &converted_key)) {
                return;
            }
            key_converted = true;
            if (converted_key.kind == MAL_KEY_STRING) {
                key_value = converted_key.value;
            }
        }
        if (ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape &&
            key_value == ic->key && ic->slot != MAL_IC_VALUE_SLOT) {
            MAL_PERF_COUNT(ic_store_slow_mono_hits);
            // hit: overwrite an existing shaped data slot (shape + key unchanged).
            // (A value-sentinel entry is a load-only cache — never index slots with it.)
            mal_gc_write_barrier(object->slots[ic->slot]);
            object->slots[ic->slot] = value;
            mal_gc_card(&object->header, value); // old object -> young value
            return;
        }
        // Polymorphic overflow: an alternate shape for the same key. Entries are only
        // added for default-writable data slots (below), so this overwrite is sound.
        if (ic->mode == MAL_IC_MODE_SHAPE && ic->poly_count > 0 && key_value == ic->key) {
            for (u8 i = 0; i < ic->poly_count; i++) {
                if (object->shape == ic->poly_shape[i]) {
                    MAL_PERF_COUNT(ic_store_poly_hits);
                    u8 slot = mal_ic_poly_slot(ic, i);
                    mal_gc_write_barrier(object->slots[slot]);
                    object->slots[slot] = value;
                    mal_gc_card(&object->header, value);
                    return;
                }
            }
        }
        // Once the inline four-way cache overflows, share the VM-wide shaped
        // property stub with loads. The attribute guard is part of the entry:
        // a load may have warmed a read-only slot, which must never become a
        // store hit.
        if (ic->mode == MAL_IC_MODE_SHAPE && ic->megamorphic) {
            const MalPropertyStubEntry *stub =
                &mal_vm_property_stub_cache(vm)[
                    mal_stub_hash(object->shape, key_value)];
            if (stub->shape == object->shape && stub->key == key_value &&
                mal_shape_attrs_are_default(stub->attrs)) {
                MAL_PERF_COUNT(ic_store_mega_hits);
                mal_gc_write_barrier(object->slots[stub->slot]);
                object->slots[stub->slot] = value;
                mal_gc_card(&object->header, value);
                return;
            }
            MAL_PERF_COUNT(ic_store_mega_misses);
        }
        // Convert the key ONCE (running any user toString/valueOf once) and reuse
        // it for the cache fill and the slow path — never re-convert via the
        // generic op (that would fire the key's side effect a second time).
        MalKey key;
        if (key_converted) {
            key = converted_key;
        } else if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
            return;
        }
        if (key.kind == MAL_KEY_STRING) {
            i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_STORE_IC);
            // Cache only a default (writable, enumerable, configurable) data slot;
            // a store to such a property cannot run a setter or change the shape.
            if (idx >= 0 && mal_shape_attrs_are_default(object->shape->props[idx].attrs)) {
                MAL_PERF_COUNT(ic_store_shape_hits);
                const MalShapeProp *prop = &object->shape->props[idx];
                // Canonical string atoms share the VM/cache lifetime. Accumulate
                // alternate shapes (polymorphic sites) like the load path.
                if (mal_ic_key_is_stable_string(key_value)) {
                    mal_ic_record(ic, object->shape, key_value, prop->slot);
                    MalPropertyStubEntry *stub =
                        &mal_vm_property_stub_cache(vm)[
                            mal_stub_hash(object->shape, key_value)];
                    stub->shape = object->shape;
                    stub->key = key_value;
                    stub->slot = prop->slot;
                    stub->attrs = prop->attrs;
                    MAL_PERF_COUNT(ic_store_shape_fills);
                } else {
                    MAL_PERF_COUNT(ic_store_shape_uncacheable);
                }
                if (mal_object_note_prototype_mutation(object)) {
                    MAL_PERF_COUNT(prototype_epoch_define_invalidations);
                }
                mal_gc_write_barrier(object->slots[prop->slot]);
                object->slots[prop->slot] = value;
                mal_gc_card(&object->header, value); // old object -> young value
                return;
            }
            if (idx < 0 && !mal_object_has_public_overflow(object) && object->extensible &&
                mal_shape_can_add_property(object->shape, key) &&
                mal_ic_key_is_stable_string(key_value) &&
                mal_ic_can_apply_transition_store(object, key)) {
                MalShape *source = object->shape;
                MalShape *child = mal_shape_add_property(
                    object->shape, key,
                    (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                          MAL_PROPERTY_CONFIGURABLE));
                if (object->watched_method_proto) {
                    mal_invalidate_primitive_method_protector();
                }
                if (mal_object_note_prototype_mutation(object)) {
                    MAL_PERF_COUNT(prototype_epoch_define_invalidations);
                }
                mal_object_grow_slots(
                    object, source->inline_count, child->inline_count);
                object->slots[child->inline_count - 1] = value;
                object->shape = child;
                mal_gc_card(&object->header, value);
                mal_gc_card(&object->header, key.value);
                if (mal_ic_record_transition(
                        object, source, key_value, child, ic)) {
                    MAL_PERF_COUNT(ic_store_transition_fills);
                }
                return;
            }
        }
        // Prototype setter / overflow / index / symbol key: store with the
        // converted key (no re-conversion).
        MAL_PERF_COUNT(ic_store_plain_generic);
        mal_vm_op_store_property_keyed(vm, object_value, key, value, strict);
        return;
    }
    MAL_PERF_COUNT(ic_store_other_generic);
    mal_vm_op_store_property(vm, object_value, key_value, value, strict);
}

void mal_op_load_property(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_property.dst] = mal_vm_indexed_fast_load(
        callable->vm,
        callable->registers[instruction->as.load_property.object],
        callable->registers[instruction->as.load_property.key],
        mal_vm_property_ic_at(callable, instruction->as.load_property.ic_index)
    );
}

void mal_op_load_property_static(MalCallable *callable, const MalInstruction *instruction) {
    MalValue key = mal_value_from_string(
        callable->vm->string_constant_atoms[
            instruction->as.load_property_static.string_index]);
    callable->registers[instruction->as.load_property_static.dst] = mal_vm_indexed_fast_load(
        callable->vm,
        callable->registers[instruction->as.load_property_static.object],
        key,
        mal_vm_property_ic_at(callable, instruction->as.load_property_static.ic_index)
    );
}

void mal_op_load_property_static_known_own_slot_fallback(
    MalCallable *callable, const MalInstruction *instruction
) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.load_property_static_known_own_slot.data_offset);
    MalValue key = mal_value_from_string(callable->vm->string_constant_atoms[data[0]]);
    callable->registers[instruction->as.load_property_static_known_own_slot.dst] =
        mal_vm_indexed_fast_load(
            callable->vm,
            callable->registers[
                instruction->as.load_property_static_known_own_slot.object],
            key,
            mal_vm_property_ic_at(
                callable,
                instruction->as.load_property_static_known_own_slot.ic_index));
}

// ToPropertyKey applied once and returned as a re-keyable value, so a
// read-modify-write member access (compound assignment, ++/--) converts the key
// (running its @@toPrimitive / valueOf / toString) exactly once and feeds the
// resulting string / symbol / index back into the load and the store. The base's
// object-coercibility is checked first (matching the spec: a null/undefined base
// throws before ToPropertyKey runs the key's user coercion). Already-key values
// pass through untouched. Signals a throw via vm->completion.
MalValue mal_vm_op_to_property_key(MalVm *vm, MalValue object_value, MalValue key_value) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return mal_value_new_undefined();
    }
    if ((mal_value_is_int32(key_value) && mal_value_to_i32(key_value) >= 0) ||
        mal_value_is_string(key_value) || mal_value_is_symbol(key_value)) {
        return key_value;
    }
    MalKey key;
    if (!mal_vm_to_property_key(vm, key_value, &key)) {
        return mal_value_new_undefined();
    }
    return key.value;
}

void mal_op_to_property_key(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.to_property_key.dst] = mal_vm_op_to_property_key(
        callable->vm,
        callable->registers[instruction->as.to_property_key.object],
        callable->registers[instruction->as.to_property_key.key]
    );
}

void mal_op_load_property_static_shape_case_fallback(
    MalCallable *callable, const MalInstruction *instruction
) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.load_property_static_shape_case.data_offset);
    MalValue key = mal_value_from_string(callable->vm->string_constant_atoms[data[0]]);
    callable->registers[instruction->as.load_property_static_shape_case.dst] =
        mal_vm_indexed_fast_load(
            callable->vm,
            callable->registers[instruction->as.load_property_static_shape_case.object],
            key,
            mal_vm_property_ic_at(callable, data[1]));
}

// Spec Set with an already-converted key — no further ToPropertyKey, so the
// store inline cache converts the key once and reuses it on the slow path.
static void mal_vm_op_store_property_keyed(
    MalVm *vm, MalValue object_value, MalKey key, MalValue value, bool strict
) {
    // A proxy routes the assignment through its [[Set]] (handler trap → target),
    // with the proxy itself as the receiver.
    if (mal_value_is_proxy_object(object_value)) {
        bool ok = mal_proxy_set(vm, mal_value_to_proxy_object(object_value), key, value, object_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }
        if (!ok && strict) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        }
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // Primitives never grow own properties; strict assignments throw.
        if (strict) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    if (mal_object_is_locked_primordial(mal_value_to_object(object_value)) &&
        !mal_vm_locked_primordial_allows_set(object_value, key)) {
        mal_primordials_throw_property_mutation(
            vm, "Cannot assign locked primordial property '", key);
        return;
    }

    // Integer-indexed TypedArray writes go through IntegerIndexedElementSet
    // (coerce, then write in-bounds; out-of-bounds is silently dropped) and
    // never define an ordinary property.
    if (mal_value_is_typed_array_object(object_value)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(object_value);
        if (key.kind == MAL_KEY_INDEX) {
            if (array->buffer->immutable) {
                if (strict) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
                }
                return;
            }
            mal_typed_array_object_set(vm, array, mal_key_index_value(key), value);
            return;
        } else if (key.kind == MAL_KEY_STRING &&
                   mal_vm_string_is_canonical_numeric_index(vm, mal_value_to_string(key.value))) {
            if (array->buffer->immutable) {
                if (strict) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
                }
                return;
            }
            // Invalid integer indices still coerce the value before the bounds
            // check, then drop the write without creating an ordinary property.
            mal_typed_array_object_set(vm, array, UINT32_MAX, value);
            return;
        }
    }

    // Fast paths for an integer-index store of a dense array — the arr[i]=v hot path —
    // skipping the prototype-chain resolve(s) the slow path below performs.
    if (key.kind == MAL_KEY_INDEX && mal_value_heap_type(object_value) == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) mal_value_to_object(object_value);
        u32 index = mal_key_index_value(key);
        if (index < UINT32_MAX) {
            // Overwrite of a present element: an own writable data property shadows
            // any inherited accessor — sound regardless of the prototype / protector.
            if (mal_array_object_dense_has(array, index) &&
                array->dense_elements_writable &&
                mal_array_object_dense_store(array, index, value) ==
                    MAL_ARRAY_DENSE_APPLIED) {
                return;
            }
            // Fresh-index store (append / hole-fill): sound to store directly only when
            // no inherited indexed setter can intercept (default %Array.prototype% +
            // the fast-elements protector) and the array is extensible with a writable
            // length. A too-sparse index (NEEDS_TABLE) falls through to the slow path.
            if (!array->dense_deopted && mal_array_elements_protector &&
                array->object.extensible && array->length_writable &&
                array->object.prototype ==
                    mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])) {
                if (mal_array_object_dense_store(array, index, value) ==
                    MAL_ARRAY_DENSE_APPLIED) {
                    if (index >= array->length) {
                        array->length = index + 1;
                    }
                    return;
                }
            }
        }
    }

    bool stored = mal_vm_set_property(vm, object_value, key, value, object_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return;
    }

    if (!stored && strict) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
    }
}

// Spec Set over a value with an already-evaluated key value, signalling a throw
// through vm->completion. Shared by the interpreter op and the native-C backend
// (which passes its statically-known strictness).
void mal_vm_op_store_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }
    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }
    mal_vm_op_store_property_keyed(vm, object_value, key, value, strict);
}

void mal_op_store_property(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_indexed_fast_store(
        callable->vm,
        callable->registers[instruction->as.store_property.object],
        callable->registers[instruction->as.store_property.key],
        callable->registers[instruction->as.store_property.value],
        callable->function->strict,
        mal_vm_property_ic_at(callable, instruction->as.store_property.ic_index)
    );
}

void mal_op_store_property_static(MalCallable *callable, const MalInstruction *instruction) {
    MalValue key = mal_value_from_string(
        callable->vm->string_constant_atoms[
            instruction->as.store_property_static.string_index]);
    mal_vm_indexed_fast_store(
        callable->vm,
        callable->registers[instruction->as.store_property_static.object],
        key,
        callable->registers[instruction->as.store_property_static.value],
        callable->function->strict,
        mal_vm_property_ic_at(callable, instruction->as.store_property_static.ic_index)
    );
}

void mal_op_store_property_static_known_own_slot_fallback(
    MalCallable *callable, const MalInstruction *instruction
) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.store_property_static_known_own_slot.data_offset);
    MalValue key = mal_value_from_string(callable->vm->string_constant_atoms[data[0]]);
    mal_vm_indexed_fast_store(
        callable->vm,
        callable->registers[
            instruction->as.store_property_static_known_own_slot.object],
        key,
        callable->registers[
            instruction->as.store_property_static_known_own_slot.value],
        callable->function->strict,
        mal_vm_property_ic_at(
            callable,
            instruction->as.store_property_static_known_own_slot.ic_index)
    );
}

// Shared by the interpreter op and the native backend: `super.p = value` /
// `super[k] = value`. `object` is the [[HomeObject]]'s prototype (the controlling
// descriptor's source); the write applies to `receiver` (the derived `this`). A
// setter can throw, and strict-mode rejections throw; sets vm->completion.
void mal_vm_op_store_super_property(
    MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, MalValue receiver, bool strict
) {
    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    bool stored = mal_vm_set_property(vm, object_value, key, value, receiver);
    if (!stored && vm->completion.kind != MAL_COMPLETION_THROW && strict) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot assign to read only property");
    }
}

MalValue mal_vm_op_load_super_property(
    MalVm *vm, MalValue base, MalValue key_value, MalValue receiver
) {
    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return mal_value_new_undefined();
    }
    // GetSuperBase may be null (extends null), but only after the computed key
    // has been converted as part of SuperProperty evaluation.
    if (mal_value_is_nil(base)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Cannot read properties of null or undefined");
        return mal_value_new_undefined();
    }
    MalValue out = mal_value_new_undefined();
    if (!mal_vm_get_property_with_receiver(vm, base, key, receiver, &out)) {
        return mal_value_new_undefined();
    }
    return out;
}

void mal_op_load_super_property(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_super_property.dst] =
        mal_vm_op_load_super_property(
            callable->vm,
            callable->registers[instruction->as.load_super_property.object],
            callable->registers[instruction->as.load_super_property.key],
            callable->registers[instruction->as.load_super_property.receiver]);
}

void mal_op_store_super_property(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_store_super_property(
        callable->vm,
        callable->registers[instruction->as.store_super_property.object],
        callable->registers[instruction->as.store_super_property.key],
        callable->registers[instruction->as.store_super_property.value],
        callable->registers[instruction->as.store_super_property.receiver],
        callable->function->strict
    );
}

void mal_op_get_iterator(MalCallable *callable, const MalInstruction *instruction) {
    MalValue source = callable->registers[instruction->as.get_iterator.source];

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(callable->vm, source, &record)) {
        return;
    }

    callable->registers[instruction->as.get_iterator.iterator_dst] = record.iterator;
    callable->registers[instruction->as.get_iterator.next_dst] = record.next_method;
}

void mal_op_get_async_iterator(MalCallable *callable, const MalInstruction *instruction) {
    MalValue source = callable->registers[instruction->as.get_async_iterator.source];

    MalIteratorRecord record;
    if (!mal_vm_get_async_iterator(callable->vm, source, &record)) {
        return;
    }

    callable->registers[instruction->as.get_async_iterator.iterator_dst] = record.iterator;
    callable->registers[instruction->as.get_async_iterator.next_dst] = record.next_method;
}

void mal_op_iterator_next(MalCallable *callable, const MalInstruction *instruction) {
    MalValue iterator = callable->registers[instruction->as.iterator_next.iterator];
    MalValue next = callable->registers[instruction->as.iterator_next.next];

    MalCompletion completion = mal_vm_call_value(callable->vm, next, iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return; // throw left pending; the run loop unwinds
    }
    callable->registers[instruction->as.iterator_next.result_dst] = completion.value;
}

void mal_op_iterator_step(MalCallable *callable, const MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_step.iterator],
        .next_method = callable->registers[instruction->as.iterator_step.next],
    };

    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(callable->vm, &record, &value, &done)) {
        return;
    }

    callable->registers[instruction->as.iterator_step.value_dst] = value;
    callable->registers[instruction->as.iterator_step.done_dst] = mal_value_new_boolean(done);
}

void mal_op_iterator_close(MalCallable *callable, const MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_close.iterator],
        .next_method = mal_value_new_undefined(),
    };

    if (instruction->as.iterator_close.normal) {
        // A normal-completion close: any throw it raises is left pending and the
        // interpreter's post-op unwinder propagates it.
        mal_vm_iterator_close_normal(callable->vm, &record);
    } else {
        mal_vm_iterator_close(callable->vm, &record);
    }
}

static MalValue mal_vm_for_in_key_string(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }

    return key.value;
}

// Build the for-in enumeration key array for `source` (EnumerateObjectProperties):
// the enumerable string keys reachable on the prototype chain, each visited once
// with nearer keys shadowing farther ones. Returns the result array. On a
// proxy-trap exception vm->completion is set to THROW and the partially-built
// array is returned; callers must check the completion before using the result.
MalValue mal_for_in_keys(MalVm *vm, MalValue source) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    // for-in over null/undefined performs no iteration.
    if (mal_value_is_nil(source)) {
        return mal_value_from_array_object(result);
    }

    // Strings expose their characters as enumerable index properties; without a
    // wrapper object we synthesize the index keys directly.
    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            mal_array_object_store(
                result,
                mal_key_index(count),
                mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i)))
            );
            count++;
        }
        return mal_value_from_array_object(result);
    }

    // A module namespace enumerates its sorted string exports (all enumerable).
    if (mal_value_is_module_namespace_object(source)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(source);
        if (!mal_module_namespace_ensure_evaluated(vm, ns)) {
            return mal_value_from_array_object(result);
        }
        for (i32 i = 0; i < ns->export_count; i++) {
            mal_array_object_store(
                result,
                mal_key_index(count),
                mal_value_from_string(ns->exports[i].name)
            );
            count++;
        }
        return mal_value_from_array_object(result);
    }

    // Numbers, booleans, and symbols have no enumerable own properties.
    if (!mal_value_is_object(source)) {
        return mal_value_from_array_object(result);
    }

    // EnumerateObjectProperties: walk the prototype chain visiting each string
    // key once. A key seen on a nearer object shadows the same key further up,
    // even when the nearer one is non-enumerable, so the shadow set records
    // every own key regardless of enumerability. A throwaway object reuses the
    // table's key equality for the set.
    MalObject *seen = mal_intrinsic_new_object(vm);
    MalPropertyDesc marker = mal_intrinsic_data_desc(mal_value_new_undefined(), 0);

    // A proxy source enumerates through its ownKeys + getOwnPropertyDescriptor
    // traps. The remaining-chain walk continues from the proxy's [[GetPrototypeOf]]
    // (which may itself be a proxy, but the ordinary walk below handles only plain
    // objects; a proxy-in-the-middle prototype is a pragmatic gap).
    if (mal_value_is_proxy_object(source)) {
        MalProxyObject *proxy = mal_value_to_proxy_object(source);
        MalValue keys_value;
        if (!mal_proxy_own_property_keys(vm, proxy, &keys_value)) {
            return mal_value_from_array_object(result);
        }
        MalArrayObject *keys = mal_value_to_array_object(keys_value);
        u32 key_count = mal_array_object_length(keys);
        for (u32 i = 0; i < key_count; i++) {
            MalValue key_value;
            if (!mal_vm_get_property(vm, keys_value, mal_key_index(i), &key_value)) {
                return mal_value_from_array_object(result);
            }
            if (!mal_value_is_string(key_value)) {
                continue;
            }
            MalKey key;
            if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
                return mal_value_from_array_object(result);
            }
            if (mal_object_get_own(seen, key).present) {
                continue;
            }
            mal_object_define_own(seen, key, &marker);
            bool present;
            MalPropertyDesc desc;
            if (!mal_proxy_get_own_property_descriptor(vm, proxy, key, &present, &desc)) {
                return mal_value_from_array_object(result);
            }
            if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }
            mal_array_object_store(result, mal_key_index(count), key_value);
            count++;
        }
        MalValue proto;
        if (!mal_proxy_get_prototype_of(vm, proxy, &proto)) {
            return mal_value_from_array_object(result);
        }
        if (!mal_value_is_object(proto) || mal_value_is_proxy_object(proto)) {
            return mal_value_from_array_object(result);
        }
        source = proto;
        // fall through to walk the (plain-object) prototype chain
    }

    for (MalObject *current = mal_value_to_object(source); current != nullptr;
         current = mal_object_get_prototype(current)) {
        // A String wrapper's exotic own keys (enumerable indices, then the
        // non-enumerable `length`) are not in the property table; surface them
        // first so they enumerate (indices) and shadow (length) like own keys.
        MalPropertyDesc string_exotic;
        if (current->header.type == MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT &&
            mal_primitive_wrapper_string_exotic_own(
                &vm->heap, current, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH), &string_exotic
            )) {
            u32 string_length = (u32) mal_value_to_i32(string_exotic.value);
            for (u32 i = 0; i < string_length; i++) {
                MalKey index_key = mal_key_index(i);
                if (mal_object_get_own(seen, index_key).present) {
                    continue;
                }
                mal_object_define_own(seen, index_key, &marker);
                mal_array_object_store(
                    result,
                    mal_key_index(count),
                    mal_vm_for_in_key_string(vm, index_key)
                );
                count++;
            }
            MalKey length_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH);
            if (!mal_object_get_own(seen, length_key).present) {
                mal_object_define_own(seen, length_key, &marker);
            }
        }

        // A TypedArray's exotic own keys are its enumerable integer indices,
        // also not table-backed; enumerate them ahead of the ordinary keys.
        if (current->header.type == MAL_HEAP_TYPED_ARRAY_OBJECT) {
            u32 typed_length = mal_typed_array_object_length((MalTypedArrayObject *) current);
            for (u32 i = 0; i < typed_length; i++) {
                MalKey index_key = mal_key_index(i);
                if (mal_object_get_own(seen, index_key).present) {
                    continue;
                }
                mal_object_define_own(seen, index_key, &marker);
                mal_array_object_store(
                    result,
                    mal_key_index(count),
                    mal_vm_for_in_key_string(vm, index_key)
                );
                count++;
            }
        }

        MalPropertyIter iter;
        mal_property_iter_init(&iter, current, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            // Symbol keys are not enumerated by for-in.
            if (key.kind == MAL_KEY_SYMBOL) {
                continue;
            }

            if (mal_object_get_own(seen, key).present) {
                continue;
            }
            mal_object_define_own(seen, key, &marker);

            if (!(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }

            mal_array_object_store(
                result,
                mal_key_index(count),
                mal_vm_for_in_key_string(vm, key)
            );
            count++;
        }
    }

    return mal_value_from_array_object(result);
}

void mal_op_for_in_keys(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.for_in_keys.dst] =
        mal_for_in_keys(callable->vm, callable->registers[instruction->as.for_in_keys.source]);
}

// Shared by the interpreter op and the native backend: read `object`'s internal
// [[Prototype]] slot (super-property base resolution). Reads the slot directly —
// no proxy [[GetPrototypeOf]] trap — so it never runs user code or throws.
MalValue mal_vm_op_load_prototype(MalVm *vm, MalValue object_value) {
    (void) vm;
    if (mal_value_is_object(object_value)) {
        MalObject *prototype = mal_object_get_prototype(mal_value_to_object(object_value));
        if (prototype != nullptr) {
            return mal_value_from_object(prototype);
        }
    }
    return mal_value_new_null();
}

void mal_op_load_prototype(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_prototype.dst] =
        mal_vm_op_load_prototype(callable->vm, callable->registers[instruction->as.load_prototype.object]);
}

/**
 * Store a delete result, upgrading failures to the strict-mode TypeError.
 */
// Shared by the interpreter op and the native backend: `delete object[key]`,
// returning the boolean result. A strict-mode failed delete throws TypeError
// (sets vm->completion); callers check completion.
MalValue mal_vm_op_delete_property(MalVm *vm, MalValue object_value, MalValue key_value, bool strict) {
    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
        return mal_value_new_boolean(true);
    }

    bool deleted;
    if (!mal_value_is_object(object_value)) {
        // The only own properties a primitive can carry live on strings:
        // length and the in-range indices, all non-configurable.
        deleted = true;
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key) ||
                (key.kind == MAL_KEY_INDEX && (usize) mal_key_index_value(key) < mal_string_length(string))) {
                deleted = false;
            }
        }
    } else {
        deleted = mal_vm_delete_property(vm, object_value, key);
    }

    if (!deleted && vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    if (!deleted && strict) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(deleted);
}

void mal_op_delete_property(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.delete_property.dst] = mal_vm_op_delete_property(
        callable->vm,
        callable->registers[instruction->as.delete_property.object],
        callable->registers[instruction->as.delete_property.key],
        callable->function->strict
    );
}

void mal_vm_op_load_undeclared(MalVm *vm, i32 name_string_index) {
    MalString *constant = &vm->runtime_image->string_constants[name_string_index];
    MalValue name = mal_value_from_string(constant);
    MalValue message = mal_vm_add(
        vm, name, mal_value_from_string(mal_intrinsic_ascii(vm, " is not defined")));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return;
    }
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, message);
}

void mal_op_load_undeclared(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_load_undeclared(callable->vm, instruction->as.load_undeclared.name_string_index);
}

static MalPropertyLookup mal_vm_global_dictionary_lookup(
    MalVm *vm, i32 name_string_index, MalObject **global_object_out, MalKey *key_out
) {
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    *global_object_out = nullptr;
    *key_out = (MalKey) {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(vm->string_constant_atoms[name_string_index]),
    };

    // The global object is ordinarily a plain object. Proxies/exotics, shaped
    // properties, and absent own tables stay on the generic MOP path.
    if (!mal_value_is_heap_type(global, MAL_HEAP_OBJECT)) {
        return (MalPropertyLookup) {.present = false, .entry = nullptr};
    }
    MalObject *global_object = (MalObject *) mal_value_to_heap(global);
    MalTable *table = global_object->overflow;
    if (table == nullptr) {
        return (MalPropertyLookup) {.present = false, .entry = nullptr};
    }

    if (vm->global_property_cache == nullptr) {
        vm->global_property_cache = calloc(
            (usize) MAL_GLOBAL_PROPERTY_CACHE_SIZE,
            sizeof(MalGlobalPropertyCacheEntry));
        MAL_PERF_COUNT(global_property_cache_allocations);
    }
    MalGlobalPropertyCacheEntry *cache = &vm->global_property_cache[
        (u32) name_string_index & (MAL_GLOBAL_PROPERTY_CACHE_SIZE - 1u)];
    if (cache->string_index == name_string_index
        && cache->realm_intrinsics == vm->intrinsics
        && cache->global_object == global_object
        && cache->table == table
        && mal_table_entry_matches(
            table, cache->entry, cache->table_handle_epoch, *key_out)) {
        *global_object_out = global_object;
        return (MalPropertyLookup) {
            .present = true,
            .entry = cache->entry,
            .desc = mal_property_entry_desc(table, cache->entry),
        };
    }

    MalPropertyLookup lookup = mal_property_lookup(table, *key_out);
    if (lookup.present) {
        *cache = (MalGlobalPropertyCacheEntry) {
            .realm_intrinsics = vm->intrinsics,
            .global_object = global_object,
            .table = table,
            .entry = lookup.entry,
            .table_handle_epoch = mal_table_handle_epoch(table),
            .string_index = name_string_index,
        };
        *global_object_out = global_object;
    }
    return lookup;
}

static MalGlobalEnvironment *mal_vm_global_environment(MalVm *vm) {
#if MAL_REALMS
    return &vm->current_realm->global_environment;
#else
    return &vm->global_environment;
#endif
}

static MalGlobalBinding *mal_vm_global_binding(MalVm *vm, i32 name_string_index) {
    MalGlobalEnvironment *environment = mal_vm_global_environment(vm);
    for (i32 i = 0; i < environment->count; i++) {
        MalGlobalBinding *binding = &environment->bindings[i];
        if (mal_string_equals(
                vm->string_constant_atoms[binding->name_string_index],
                vm->string_constant_atoms[name_string_index])) {
            return binding;
        }
    }
    return nullptr;
}

static void mal_vm_add_global_binding(MalVm *vm, i32 name_string_index, i32 index, bool immutable) {
    MalGlobalEnvironment *environment = mal_vm_global_environment(vm);
    if (environment->count == environment->capacity) {
        environment->capacity = environment->capacity ? environment->capacity * 2 : 16;
        environment->bindings = realloc(
            environment->bindings, (usize) environment->capacity * sizeof(MalGlobalBinding));
    }
    environment->bindings[environment->count++] = (MalGlobalBinding) {
        .name_string_index = name_string_index, .global_index = index, .immutable = immutable,
    };
}

void mal_vm_op_declare_global_lexical(
    MalVm *vm, i32 name_string_index, i32 index, bool immutable, bool check_only
) {
    if (check_only) {
        MalObject *global_object;
        MalKey key;
        MalPropertyLookup own = mal_vm_global_dictionary_lookup(
            vm, name_string_index, &global_object, &key);
        if (mal_vm_global_binding(vm, name_string_index) != nullptr ||
            (own.present && !(own.desc.flags & MAL_PROPERTY_CONFIGURABLE))) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot redeclare global lexical binding");
        }
        return;
    }
    mal_vm_add_global_binding(vm, name_string_index, index, immutable);
}

void mal_op_declare_global_lexical(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_declare_global_lexical(callable->vm, instruction->as.declare_global_lexical.name_string_index,
        instruction->as.declare_global_lexical.index, instruction->as.declare_global_lexical.immutable,
        instruction->as.declare_global_lexical.check_only);
}

MalValue mal_vm_op_load_global_property(MalVm *vm, i32 name_string_index) {
    MalGlobalBinding *binding = mal_vm_global_binding(vm, name_string_index);
    if (binding != nullptr && binding->global_index >= 0) {
        MalValue value = vm->globals[binding->global_index];
        if (mal_value_is_empty(value)) {
            mal_vm_op_load_undeclared(vm, name_string_index);
            return mal_value_new_undefined();
        }
        return value;
    }
    MalObject *global_object;
    MalKey key;
    MalPropertyLookup own = mal_vm_global_dictionary_lookup(
        vm, name_string_index, &global_object, &key);
    if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        return own.desc.value;
    }

    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    if (mal_vm_has_property(vm, global, key)) {
        MalValue out = mal_value_new_undefined();
        mal_vm_get_property(vm, global, key, &out);
        return out;
    }

    // Unresolved even on the global object: a ReferenceError, as in strict mode.
    mal_vm_op_load_undeclared(vm, name_string_index);
    return mal_value_new_undefined();
}

void mal_op_load_global_property(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.load_global_property.dst] =
        mal_vm_op_load_global_property(callable->vm, instruction->as.load_global_property.name_string_index);
}

void mal_vm_op_store_global_property(
    MalVm *vm, i32 name_string_index, MalValue value, bool strict,
    bool declaration, bool declaration_configurable
) {
    MalGlobalBinding *binding = mal_vm_global_binding(vm, name_string_index);
    if (binding != nullptr && binding->global_index >= 0) {
        if (declaration) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot redeclare global lexical binding");
        } else if (mal_value_is_empty(vm->globals[binding->global_index])) {
            mal_vm_op_load_undeclared(vm, name_string_index);
        } else if (binding->immutable) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Assignment to constant binding");
        } else {
            vm->globals[binding->global_index] = value;
        }
        return;
    }
    MalObject *global_object;
    MalKey key;
    MalPropertyLookup own = mal_vm_global_dictionary_lookup(
        vm, name_string_index, &global_object, &key);

    if (declaration) {
        // The compiler uses the unobservable EMPTY sentinel for a global function
        // declaration check. GlobalDeclarationInstantiation performs every check
        // before function objects are installed, and configurable accessors must
        // be replaced without invoking their setters.
        bool function_check = mal_value_is_empty(value);
        bool var_check = mal_value_is_null(value);
        bool function_initialization = !function_check && !var_check && !mal_value_is_undefined(value);
        if (own.present && (own.desc.flags & MAL_PROPERTY_PRIMORDIAL) &&
            (function_check || function_initialization)) {
            mal_primordials_throw_property_mutation(
                vm, "Cannot declare locked primordial binding '", key);
            return;
        }
        if (function_check) {
            if (!own.present) {
                global_object = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
                if (!mal_object_is_extensible(global_object)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot declare global function");
                }
                return;
            }
            if ((own.desc.flags & MAL_PROPERTY_CONFIGURABLE)
                || (!(own.desc.flags & MAL_PROPERTY_ACCESSOR)
                    && (own.desc.flags & MAL_PROPERTY_WRITABLE)
                    && (own.desc.flags & MAL_PROPERTY_ENUMERABLE))) {
                return;
            }
            mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot declare global function");
            return;
        }
        if (var_check) {
            if (!own.present) {
                global_object = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
                if (!mal_object_is_extensible(global_object)) {
                    mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Cannot declare global variable");
                }
            }
            return;
        }
        if (!function_check && !var_check && binding == nullptr) {
            mal_vm_add_global_binding(vm, name_string_index, -1, false);
        }
        if (own.present && !function_initialization) {
            return;
        }
        if (own.present && !(own.desc.flags & MAL_PROPERTY_CONFIGURABLE)) {
            own.desc.value = value;
            mal_property_write_entry(global_object->overflow, own.entry, &own.desc);
            mal_gc_card(&global_object->header, value);
            return;
        }
        global_object = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
        MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE;
        if (declaration_configurable) {
            flags |= MAL_PROPERTY_CONFIGURABLE;
        }
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            function_initialization ? value : mal_value_new_undefined(), flags);
        if (mal_object_define_own(global_object, key, &desc) != MAL_DEFINE_OWN_APPLIED) {
            mal_vm_throw_error(
                vm,
                MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE,
                function_initialization ? "Cannot declare global function" : "Cannot declare global variable");
        }
        return;
    }

    if (own.present
        && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)
        && (own.desc.flags & MAL_PROPERTY_WRITABLE)) {
        own.desc.value = value;
        mal_property_write_entry(global_object->overflow, own.entry, &own.desc);
        mal_gc_card(&global_object->header, value);
        return;
    }

    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    if (!own.present) {
        bool still_exists = mal_vm_has_property(vm, global, key);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        if (!still_exists && strict) {
            // Object Environment Record SetMutableBinding re-checks HasProperty:
            // a binding deleted between GetValue and PutValue is unresolvable.
            mal_vm_op_load_undeclared(vm, name_string_index);
            return;
        }
    }
    mal_vm_op_store_property(vm, global, key.value, value, strict);
}

MalValue mal_vm_op_global_binding_query(MalVm *vm, i32 name_string_index, u8 query) {
    MalGlobalBinding *binding = mal_vm_global_binding(vm, name_string_index);
    bool lexical = binding != nullptr && binding->global_index >= 0;
    MalValue global = vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS];
    MalKey key = {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(vm->string_constant_atoms[name_string_index]),
    };
    if (query == 1) return mal_value_new_boolean(lexical || mal_vm_has_property(vm, global, key));
    if (query == 2) {
        if (lexical) return mal_value_new_boolean(false);
        bool deleted = mal_vm_delete_property(vm, global, key);
        binding = mal_vm_global_binding(vm, name_string_index);
        if (deleted && binding != nullptr) {
            MalGlobalEnvironment *environment = mal_vm_global_environment(vm);
            i32 index = (i32) (binding - environment->bindings);
            environment->bindings[index] = environment->bindings[--environment->count];
        }
        return mal_value_new_boolean(deleted);
    }
    MalValue value = mal_value_new_undefined();
    if (lexical) value = mal_vm_op_load_global_property(vm, name_string_index);
    else mal_vm_get_property(vm, global, key, &value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    const byte *tag = mal_vm_typeof_tag(mal_vm_typeof_result(value));
    return mal_value_from_string(mal_intrinsic_ascii(vm, tag));
}

void mal_op_global_binding_query(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.global_binding_query.dst] = mal_vm_op_global_binding_query(
        callable->vm, instruction->as.global_binding_query.name_string_index, instruction->as.global_binding_query.query);
}

void mal_op_store_global_property(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_store_global_property(
        callable->vm,
        instruction->as.store_global_property.name_string_index,
        callable->registers[instruction->as.store_global_property.src],
        callable->function->strict,
        instruction->as.store_global_property.declaration,
        instruction->as.store_global_property.declaration_configurable
    );
}

void mal_vm_op_init_global_vars(
    MalVm *vm, i32 count, const i32 *name_string_indices, bool declaration_configurable
) {
    for (i32 i = 0; i < count; i++) {
        mal_vm_op_store_global_property(
            vm, name_string_indices[i], mal_value_new_undefined(), false, true,
            declaration_configurable);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    }
}

void mal_op_init_global_vars(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.init_global_vars.data_offset);
    mal_vm_op_init_global_vars(
        callable->vm, data[0], &data[1],
        instruction->as.init_global_vars.declaration_configurable);
}

// Shared by the interpreter op and the native backend: throw a TypeError when
// `value` is null or undefined (RequireObjectCoercible). Sets vm->completion.
void mal_vm_op_require_coercible(MalVm *vm, MalValue value) {
    if (mal_value_is_nil(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
    }
}

void mal_op_require_coercible(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_require_coercible(
        callable->vm,
        callable->registers[instruction->as.require_coercible.src]
    );
}

void mal_op_builtin_error(MalCallable *callable, const MalInstruction *instruction) {
    static const struct {
        MalIntrinsic prototype;
        const byte *message;
    } failures[] = {
#define MAL_KNOWN_BUILTIN_ERROR(name, prototype, message) { prototype, message },
#include "generated/known_builtin_errors.inc"
#undef MAL_KNOWN_BUILTIN_ERROR
    };
    const MalBuiltinError error = instruction->as.builtin_error.error;
    callable->registers[instruction->as.builtin_error.dst] = MAL_VALUE_UNDEFINED;
    mal_vm_throw_error(callable->vm, failures[error].prototype, failures[error].message);
}

void mal_op_precise_number_sum(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(callable, instruction->as.precise_number_sum.data_offset);
    f64 values[MAL_PRECISE_NUMBER_SUM_MAX_INPUTS];
    for (i32 index = 0; index < data[0]; index++)
        values[index] = mal_ops_number_as_f64(callable->registers[data[index + 1]]);
    f64 result = mal_builtin_math_sum_precise_numbers(callable->vm, values, (usize) data[0]);
    callable->registers[instruction->as.precise_number_sum.dst] = mal_ops_number_value(result);
}

void mal_op_prepared_string_compare(MalCallable *callable, const MalInstruction *instruction) {
    u32 plan = instruction->as.prepared_string_compare.locale_options;
    MalString *locale = &callable->vm->runtime_image->string_constants[plan >> 6];
    usize length = mal_string_length(locale);
    const c16 *units = mal_string_code_units(locale);
    byte bytes[128];
    for (usize i = 0; i < length; i++) bytes[i] = (byte) units[i];
    callable->registers[instruction->as.prepared_string_compare.dst] = mal_builtin_string_locale_compare_prepared(
        callable->vm, callable->registers[instruction->as.prepared_string_compare.left],
        callable->registers[instruction->as.prepared_string_compare.right], bytes, length,
        (u8) (plan & 63));
}

// ClassDefinitionEvaluation heritage check: the superclass must be null, or a
// constructor whose `prototype` is an object or null. Sets vm->completion on a
// violation (`extends 42`, `extends Math.abs`, `extends a-function-without-a
// -valid-prototype`). The null literal is handled at compile time and never
// reaches here; a runtime null value is accepted (protoParent is null).
void mal_vm_op_check_super_class(MalVm *vm, MalValue parent) {
    if (mal_value_is_null(parent)) {
        return;
    }
    if (!mal_vm_is_constructor(vm, parent)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Class extends value is not a constructor or null");
        return;
    }
    MalValue proto;
    if (!mal_vm_get_property(vm, parent, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_PROTOTYPE), &proto)) {
        return; // a `prototype` getter threw; propagate its completion
    }
    if (!mal_value_is_object(proto) && !mal_value_is_null(proto)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class extends value does not have valid prototype property");
    }
}

void mal_op_check_super_class(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_check_super_class(
        callable->vm,
        callable->registers[instruction->as.check_super_class.parent]
    );
}

MalValue mal_create_rest_arguments(MalVm *vm, const MalValue *args, i32 arg_count, i32 start) {
    i32 count = arg_count > start ? arg_count - start : 0;
    MAL_PERF_COUNT(rest_array_allocations);
    MAL_PERF_ADD(rest_array_values, count);

    MalArrayObject *rest = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    // Rest binding creates own data properties even over inherited accessors or read-only indices.
    if (count > 0 &&
        (!mal_array_object_fresh_dense_reserve_exact(rest, (u32) count) ||
         !mal_array_object_dense_build_values(rest, 0, args + start, (u32) count))) {
        abort();
    }

    return mal_value_from_array_object(rest);
}

void mal_op_create_rest_arguments(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_rest_arguments.dst] = mal_create_rest_arguments(
        callable->vm, callable->arguments, callable->argument_count,
        instruction->as.create_rest_arguments.start_index
    );
}

// Build the array-destructuring rest (`[a, ...rest] = source`): the source's
// elements from `start` onward as a fresh Array. Shared by the interpreter op and
// compiled code. On a null/undefined source or a throwing element read, sets
// vm->completion to THROW and returns undefined; callers must check.
MalValue mal_array_rest(MalVm *vm, MalValue source, u32 start) {
    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return mal_value_new_undefined();
    }

    // Legacy index-read implementation retained for the arrayRest opcode. Current
    // destructuring lowering uses the iterator protocol directly.
    u32 length;
    if (!mal_builtin_array_this_length(vm, source, &length)) {
        return mal_value_new_undefined();
    }

    u32 count = length > start ? length - start : 0;
    MalArrayObject *rest = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(rest, count);

    for (u32 i = 0; i < count; i++) {
        // Holes read as dense undefined elements, like the array iterator
        // yields them.
        MalValue element = mal_value_new_undefined();
        if (!mal_builtin_array_try_get(vm, source, start + i, &element) &&
            vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        mal_object_set(
            (MalObject *) rest,
            mal_key_index(i),
            element
        );
    }

    return mal_value_from_array_object(rest);
}

void mal_op_array_rest(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.array_rest.dst] = mal_array_rest(
        callable->vm,
        callable->registers[instruction->as.array_rest.src],
        (u32) instruction->as.array_rest.start_index
    );
}

// Shared by the interpreter op and the native backend: object rest/spread
// destructuring (`const {a, ...rest} = source`) — copy source's own enumerable
// properties (minus the excluded keys) onto a fresh object. A source getter or an
// excluded-key ToPropertyKey can throw: sets vm->completion and returns undefined,
// so callers must check the completion. `excluded_keys` are already-evaluated
// property-key values (the compiled caller boxes them from its registers).
MalValue mal_vm_op_copy_data_properties(
    MalVm *vm, MalValue source, const MalValue *excluded_keys, i32 excluded_count
) {
    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return mal_value_new_undefined();
    }

    MalKey excluded[excluded_count > 0 ? excluded_count : 1];
    MalValue excluded_roots[excluded_count > 0 ? excluded_count : 1];
    MalRootSpan excluded_span;
    i32 converted_count = 0;
    for (i32 i = 0; i < excluded_count; i++) {
        excluded_roots[i] = mal_value_new_undefined();
    }
    mal_gc_root(&excluded_span, excluded_roots, excluded_count);
    for (i32 i = 0; i < excluded_count; i++) {
        if (!mal_vm_value_to_property_key(vm, excluded_keys[i], &excluded[i])) {
            mal_gc_unroot(&excluded_span);
            return mal_value_new_undefined();
        }
        excluded_roots[i] = excluded[i].value;
        converted_count++;
    }

    #define MAL_COPY_KEY_EXCLUDED(candidate, result) do { \
        (result) = false; \
        for (i32 excluded_index = 0; excluded_index < converted_count; excluded_index++) { \
            MAL_PERF_COUNT(copy_data_linear_exclusion_checks); \
            if (excluded[excluded_index].kind == (candidate).kind && \
                mal_key_value_equals(excluded[excluded_index].value, (candidate).value)) { \
                (result) = true; \
                break; \
            } \
        } \
    } while (0)

    MalObject *prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    // Ordinary shaped records have only non-observable inline data properties.
    // Build the final result shape and slot payload directly; dictionaries,
    // symbols, indices, exotics, and non-enumerable layouts retain the iterator.
    if (mal_value_is_heap_type(source, MAL_HEAP_OBJECT)) {
        MalObject *source_object = mal_value_to_object(source);
        MalShape *source_shape = source_object->shape;
        if (!mal_object_has_public_overflow(source_object) &&
            source_shape->inline_count > 0) {
            MalShape *result_shape = mal_shape_root(&vm->heap);
            MalValue values[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
            u32 count = 0;
            bool eligible = source_shape->inline_count <= MAL_SHAPE_DYNAMIC_INLINE_SLOTS;
            for (u32 i = 0; eligible && i < source_shape->inline_count; i++) {
                const MalShapeProp *prop = &source_shape->props[i];
                MalKey key = mal_key_from_value(prop->key);
                if (key.kind != MAL_KEY_STRING) {
                    eligible = false;
                    break;
                }
                bool skip;
                MAL_COPY_KEY_EXCLUDED(key, skip);
                if (skip || (prop->attrs & MAL_PROPERTY_ENUMERABLE) == 0) {
                    continue;
                }
                result_shape = mal_shape_add_property(
                    result_shape, key,
                    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                        MAL_PROPERTY_CONFIGURABLE);
                values[count++] = source_object->slots[prop->slot];
            }
            if (eligible) {
                MalValue result = count == 0
                    ? mal_value_from_object(mal_object_new(&vm->heap, prototype))
                    : mal_value_from_object(mal_object_new_shaped(
                          &vm->heap, prototype, result_shape, values, count));
                MAL_PERF_COUNT(copy_data_shaped_hits);
                MAL_PERF_ADD(copy_data_shaped_slots, count);
                mal_gc_unroot(&excluded_span);
                return result;
            }
        }
    }

    MAL_PERF_COUNT(copy_data_fallbacks);
    MalObject *copy = mal_object_new(&vm->heap, prototype);
    MalValue copy_root = mal_value_from_object(copy);
    MalRootSpan copy_span;
    mal_gc_root(&copy_span, &copy_root, 1);
    bool ok = true;

    if (mal_value_is_string(source)) {
        // String sources expose their code units as own enumerable index
        // properties.
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalKey key = mal_key_index(i);
            bool skip;
            MAL_COPY_KEY_EXCLUDED(key, skip);
            if (skip) {
                continue;
            }

            mal_object_set(
                copy,
                key,
                mal_value_from_string(
                    mal_intrinsic_code_unit(vm, mal_string_code_units(string)[i])
                )
            );
        }
    } else if (mal_value_is_object(source)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            bool skip;
            MAL_COPY_KEY_EXCLUDED(key, skip);
            if (skip) {
                continue;
            }

            MalValue value;
            if (!mal_vm_desc_read(vm, desc, source, &value)) {
                ok = false;
                goto done;
            }

            mal_object_set(copy, key, value);
        }
    }
    // Other primitives carry no own enumerable properties.

done:
    mal_gc_unroot(&copy_span);
    mal_gc_unroot(&excluded_span);
    #undef MAL_COPY_KEY_EXCLUDED
    return ok ? mal_value_from_object(copy) : mal_value_new_undefined();
}

void mal_op_copy_data_properties(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.copy_data_properties.data_offset);
    i32 excluded_count = data[0];
    const i32 *excluded = &data[1];
    // Marshal the excluded-key registers into a contiguous buffer for the shared
    // op. The values alias rooted frame registers and no collection runs before
    // the op consumes them (allocation only requests a poll), so the copies stay live.
    MalValue excluded_keys[excluded_count > 0 ? excluded_count : 1];
    for (i32 i = 0; i < excluded_count; i++) {
        excluded_keys[i] = callable->registers[excluded[i]];
    }

    MalValue result = mal_vm_op_copy_data_properties(
        callable->vm, callable->registers[instruction->as.copy_data_properties.src],
        excluded_keys, excluded_count
    );
    if (callable->vm->completion.kind != MAL_COMPLETION_THROW) {
        callable->registers[instruction->as.copy_data_properties.dst] = result;
    }
}

static bool mal_vm_try_merge_shaped_data_properties(
    MalVm *vm, MalValue target_value, MalValue source
) {
    if (!mal_value_is_heap_type(target_value, MAL_HEAP_OBJECT)
        || !mal_value_is_heap_type(source, MAL_HEAP_OBJECT)) {
        return false;
    }
    MalObject *target = mal_value_to_object(target_value);
    MalObject *source_object = mal_value_to_object(source);
    if (target->shape != mal_shape_root(&vm->heap)
        || target->slots != nullptr
        || mal_object_has_public_overflow(target)
        || !target->extensible
        || source_object->shape == nullptr
        || source_object->slots == nullptr
        || mal_object_has_public_overflow(source_object)) {
        return false;
    }
    u32 source_count = source_object->shape->inline_count;
    if (source_count == 0 || source_count > MAL_SHAPE_DYNAMIC_INLINE_SLOTS) {
        return false;
    }
    MalShape *target_shape = target->shape;
    MalShape *source_shape = source_object->shape;
    uptr cache_hash = ((uptr) target_shape >> 4) ^ ((uptr) source_shape >> 4);
    MalShapeCopyCacheEntry *cached =
        &vm->shape_copy_cache[cache_hash & (MAL_SHAPE_COPY_CACHE_CAPACITY - 1)];
    MAL_PERF_COUNT(merge_shape_cache_probes);
    if (cached->source_shape == source_shape
        && cached->append_plan.source == target_shape
        && cached->append_plan.final != nullptr) {
        MAL_PERF_COUNT(merge_shape_cache_hits);
        const MalValue *values = source_object->slots;
        MalValue projected[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
        if (!cached->identity_projection) {
            for (u32 i = 0; i < cached->count; ++i) {
                projected[i] = source_object->slots[cached->source_slots[i]];
            }
            values = projected;
        }
        if (!mal_object_try_append_shaped_values(
                target, &cached->append_plan, values, cached->count)) {
            return false;
        }
        MAL_PERF_COUNT(merge_data_shaped_hits);
        MAL_PERF_ADD(merge_data_shaped_slots, cached->count);
        return true;
    }
    MAL_PERF_COUNT(merge_shape_cache_misses);
    const u8 default_attrs = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
        MAL_PROPERTY_CONFIGURABLE;
    bool needs_normalization = false;
    for (u32 i = 0; i < source_count; ++i) {
        const MalShapeProp *prop = &source_object->shape->props[i];
        if (!mal_value_is_string(prop->key)) return false;
        needs_normalization |= prop->attrs != default_attrs;
    }
    if (!needs_normalization) {
        MalShapeAppendPlan plan;
        if (!mal_object_append_plan_init(
                &plan, target_shape, source_shape, source_count)
            || !mal_object_try_append_shaped_values(
                target, &plan, source_object->slots, source_count)) {
            return false;
        }
        *cached = (MalShapeCopyCacheEntry) {
            .source_shape = source_shape,
            .append_plan = plan,
            .count = source_count,
            .identity_projection = true,
        };
        MAL_PERF_COUNT(merge_shape_cache_builds);
        MAL_PERF_COUNT(merge_data_shaped_hits);
        MAL_PERF_ADD(merge_data_shaped_slots, source_count);
        return true;
    }
    MalShape *result_shape = target_shape;
    MalValue values[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
    u8 source_slots[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
    u32 count = 0;
    for (u32 i = 0; i < source_count; ++i) {
        const MalShapeProp *prop = &source_object->shape->props[i];
        MalKey key = mal_key_from_value(prop->key);
        if (key.kind != MAL_KEY_STRING) {
            return false;
        }
        if ((prop->attrs & MAL_PROPERTY_ENUMERABLE) == 0) continue;
        result_shape = mal_shape_add_property(result_shape, key, default_attrs);
        values[count] = source_object->slots[prop->slot];
        source_slots[count++] = (u8) prop->slot;
    }
    if (count == 0) return true;
    MalShapeAppendPlan plan;
    if (!mal_object_append_plan_init(
            &plan, target_shape, result_shape, count)
        || !mal_object_try_append_shaped_values(
            target, &plan, values, count)) {
        return false;
    }
    *cached = (MalShapeCopyCacheEntry) {
        .source_shape = source_shape,
        .append_plan = plan,
        .count = count,
        .identity_projection = false,
    };
    memcpy(cached->source_slots, source_slots, count);
    MAL_PERF_COUNT(merge_shape_cache_builds);
    MAL_PERF_COUNT(merge_data_shaped_hits);
    MAL_PERF_ADD(merge_data_shaped_slots, count);
    return true;
}

// Shared by the interpreter op and the native backend: object spread
// (`{...source}`) — copy source's own enumerable properties onto target with
// CreateDataProperty semantics. A throwing getter sets vm->completion.
void mal_vm_op_merge_data_properties(MalVm *vm, MalValue target_value, MalValue source) {
    // Spreading null/undefined contributes nothing.
    if (mal_value_is_nil(source)) {
        return;
    }

    MalObject *target = mal_value_to_object(target_value);

    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalPropertyDesc desc = mal_intrinsic_data_desc(
                mal_value_from_string(
                    mal_intrinsic_code_unit(vm, mal_string_code_units(string)[i])
                ),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
            );
            mal_object_define_own(target, mal_key_index(i), &desc);
        }
        return;
    }

    if (!mal_value_is_object(source)) {
        return;
    }

    if (mal_vm_try_merge_shaped_data_properties(vm, target_value, source)) {
        return;
    }
    MAL_PERF_COUNT(merge_data_fallbacks);

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        MalValue value;
        if (!mal_vm_desc_read(vm, desc, source, &value)) {
            return;
        }

        // CreateDataProperty: own enumerable data property, no inherited setters.
        MalPropertyDesc data = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(target, key, &data);
    }
}

void mal_op_merge_data_properties(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_merge_data_properties(
        callable->vm,
        callable->registers[instruction->as.merge_data_properties.target],
        callable->registers[instruction->as.merge_data_properties.src]
    );
}

// Shared by the interpreter op and the native backend: define a getter or setter
// on an object literal / class. Cannot run user code, so no completion to check.
void mal_vm_op_define_accessor(
    MalVm *vm, MalValue object_value, MalValue key_value, MalValue accessor, bool enumerable, bool is_setter
) {
    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }

    MalObject *object = mal_value_to_object(object_value);

    // Merge into an existing own accessor so get/set pairs land in a single
    // descriptor; literal definitions are enumerable, class ones are not.
    MalPropertyFlags flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE;
    if (enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_new_undefined(), flags);
    MalPropertyLookup existing = mal_object_get_own(object, key);
    if (existing.present && (existing.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        desc = existing.desc;
    }

    if (is_setter) {
        desc.setter = accessor;
    } else {
        desc.getter = accessor;
    }

    // DefinePropertyOrThrow: a rejected define (e.g. a static accessor named
    // 'prototype', which is non-configurable on the constructor) throws. The
    // object-literal and fresh-prototype callers only define configurable own
    // properties, which never reject.
    if (mal_object_define_own(object, key, &desc) != MAL_DEFINE_OWN_APPLIED) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot redefine property");
    }
}

void mal_op_define_accessor(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_define_accessor(
        callable->vm,
        callable->registers[instruction->as.define_accessor.object],
        callable->registers[instruction->as.define_accessor.key],
        callable->registers[instruction->as.define_accessor.accessor],
        instruction->as.define_accessor.enumerable,
        instruction->as.define_accessor.is_setter
    );
}

static void mal_vm_define_property_key(MalVm *vm, MalValue object_value, MalKey key,
                                       MalValue value, bool enumerable, bool writable,
                                       bool configurable) {
    MalPropertyFlags flags = MAL_PROPERTY_NONE;
    if (writable) {
        flags |= MAL_PROPERTY_WRITABLE;
    }
    if (configurable) {
        flags |= MAL_PROPERTY_CONFIGURABLE;
    }
    if (enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    // CreateDataProperty is [[DefineOwnProperty]]: a proxy receiver (e.g. a
    // public class field installed on the object a derived class's super()
    // returned) routes through the defineProperty trap rather than writing the
    // proxy exotic's own slots, which no reads consult.
    if (mal_value_is_proxy_object(object_value)) {
        MalObject *descriptor = mal_intrinsic_new_object(vm);
        MalPropertyFlags df = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;
        mal_intrinsic_define_data(vm, descriptor, "value", value, df);
        mal_intrinsic_define_data(vm, descriptor, "writable", mal_value_new_boolean(true), df);
        mal_intrinsic_define_data(vm, descriptor, "enumerable", mal_value_new_boolean(enumerable), df);
        mal_intrinsic_define_data(vm, descriptor, "configurable", mal_value_new_boolean(true), df);
        bool ok = mal_proxy_define_own_property(vm, mal_value_to_proxy_object(object_value), key, mal_value_from_object(descriptor));
        // CreateDataPropertyOrThrow: a trap that rejects (returns false) without
        // itself throwing still surfaces a TypeError.
        if (!ok && vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot define property on proxy");
        }
        return;
    }

    if (mal_value_is_module_namespace_object(object_value)) {
        MalModuleNamespaceObject *ns =
            mal_value_to_module_namespace_object(object_value);
        if (!mal_module_namespace_ensure_for_key(vm, ns, key)) return;
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot create property on module namespace object");
        return;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    if (mal_object_define_own(mal_value_to_object(object_value), key, &desc) != MAL_DEFINE_OWN_APPLIED) {
        // CreateDataPropertyOrThrow: a rejected define (e.g. a public class field
        // on a receiver a prior initializer froze) surfaces a TypeError. The op's
        // other callers target fresh extensible objects, which never reject.
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on non-extensible object");
        return;
    }
    // Array exotic [[DefineOwnProperty]]: defining an index at or past length
    // grows length (CreateDataProperty on a fresh array must keep length in step).
    if (mal_value_is_array_object(object_value) && key.kind == MAL_KEY_INDEX) {
        MalArrayObject *array = mal_value_to_array_object(object_value);
        u32 index = mal_key_index_value(key);
        if (index >= mal_array_object_length(array)) {
            mal_array_object_set_length(array, index + 1);
        }
    }
}

void mal_vm_op_define_property(MalVm *vm, MalValue object_value, MalValue key_value,
                               MalValue value, bool enumerable, bool writable,
                               bool configurable) {
    MalKey key;
    if (!mal_value_is_object(object_value) ||
        !mal_vm_value_to_property_key(vm, key_value, &key)) {
        return;
    }
    mal_vm_define_property_key(
        vm, object_value, key, value, enumerable, writable, configurable);
}

void mal_vm_op_define_property_static(MalVm *vm, MalValue object_value,
                                      i32 string_index, MalValue value,
                                      bool enumerable, bool writable,
                                      bool configurable) {
    if (!mal_value_is_object(object_value)) return;
    MalKey key = {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(vm->string_constant_atoms[string_index]),
    };
    mal_vm_define_property_key(
        vm, object_value, key, value, enumerable, writable, configurable);
}

void mal_vm_op_define_property_static_cached(
    MalVm *vm, MalDefinePropertyCache *cache, MalValue object_value,
    i32 string_index, MalValue value, bool enumerable, bool writable,
    bool configurable
) {
    if (!mal_value_is_heap_type(object_value, MAL_HEAP_OBJECT) ||
        !enumerable || !writable || !configurable) {
        mal_vm_op_define_property_static(
            vm, object_value, string_index, value,
            enumerable, writable, configurable);
        return;
    }

    MalObject *object = mal_value_to_object(object_value);
    if (cache->heap_identity == vm->heap.identity &&
        cache->heap_epoch == vm->heap.epoch &&
        mal_object_try_append_shaped_values(object, &cache->append, &value, 1)) {
        MAL_PERF_COUNT(define_property_transition_hits);
        return;
    }

    MalShape *source = object->shape;
    MalKey key = {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(vm->string_constant_atoms[string_index]),
    };
    mal_vm_define_property_key(
        vm, object_value, key, value, enumerable, writable, configurable);
    if (vm->completion.kind == MAL_COMPLETION_THROW || object->shape == source ||
        object->shape->inline_count == 0 ||
        object->shape->props[object->shape->inline_count - 1].key != key.value ||
        !mal_object_append_plan_init(&cache->append, source, object->shape, 1)) {
        return;
    }
    cache->heap_identity = vm->heap.identity;
    cache->heap_epoch = vm->heap.epoch;
    MAL_PERF_COUNT(define_property_transition_fills);
}

void mal_op_define_property(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_define_property(
        callable->vm,
        callable->registers[instruction->as.define_property.object],
        callable->registers[instruction->as.define_property.key],
        callable->registers[instruction->as.define_property.value],
        instruction->as.define_property.enumerable,
        instruction->as.define_property.writable,
        instruction->as.define_property.configurable
    );
}

/**
 * The shared error for reading or writing a private member on a receiver that
 * was not branded by the declaring class (PrivateElementFind returned empty).
 */
static const byte *const mal_private_absent_message =
    "Cannot access private member on an object whose class did not declare it";

// Shared by the interpreter op and the native backend: a fresh unique private
// name (a hidden private symbol). Never throws.
MalValue mal_vm_op_create_private_name(MalVm *vm) {
    return mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
}

void mal_op_create_private_name(MalCallable *callable, const MalInstruction *instruction) {
    callable->registers[instruction->as.create_private_name.dst] =
        mal_vm_op_create_private_name(callable->vm);
}

void mal_vm_op_create_private_names(
    MalVm *vm, MalEnv *env, i32 owner_function_index, i32 count, const i32 *captured_indices
) {
    for (i32 i = 0; i < count; i++) {
        mal_vm_store_captured(
            env, owner_function_index, captured_indices[i], mal_vm_op_create_private_name(vm));
    }
}

void mal_op_create_private_names(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.create_private_names.data_offset);
    mal_vm_op_create_private_names(
        callable->vm, callable->env,
        instruction->as.create_private_names.owner_function_index, data[0], &data[1]);
}

// Shared by the interpreter op and the native backend: AddPrivateName — install a
// private field/method/brand on a freshly built instance or class object. A second
// install of the same name on one object throws; sets vm->completion.
void mal_vm_op_define_private(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value) {
    // The receiver is always a freshly built instance or the class object.
    if (!mal_value_is_object(object_value)) {
        return;
    }

    MalObject *object = mal_value_to_object(object_value);
    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};

    if (!mal_object_add_private(object, key, value)) {
        // AddPrivateName rejects installing the same private element twice on
        // one object (re-entrant construction of the same this).
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot initialize the same private member twice on an object"
        );
    }
}

void mal_op_define_private(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_define_private(
        callable->vm,
        callable->registers[instruction->as.define_private.object],
        callable->registers[instruction->as.define_private.key],
        callable->registers[instruction->as.define_private.value]
    );
}

void mal_vm_op_init_private_fields(
    MalVm *vm, MalValue object_value, i32 count, const MalValue *keys
) {
    for (i32 i = 0; i < count; i++) {
        mal_vm_op_define_private(vm, object_value, keys[i], mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    }
}

void mal_op_init_private_fields(MalCallable *callable, const MalInstruction *instruction) {
    const i32 *data = mal_op_instruction_data(
        callable, instruction->as.init_private_fields.data_offset);
    for (i32 i = 0; i < data[0]; i++) {
        mal_vm_op_define_private(
            callable->vm,
            callable->registers[instruction->as.init_private_fields.object],
            callable->registers[data[i + 1]], mal_value_new_undefined());
        if (callable->vm->completion.kind == MAL_COMPLETION_THROW) return;
    }
}

// Shared by the interpreter op and the native backend: PrivateGet. A receiver not
// branded by the declaring class throws; sets vm->completion and returns undefined.
MalValue mal_vm_op_load_private(MalVm *vm, MalValue object_value, MalValue key_value) {
    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return mal_value_new_undefined();
    }

    MalValue value;
    if (!mal_table_get_private_value(
            mal_value_to_object(object_value)->overflow, mal_value_to_symbol(key_value), &value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return mal_value_new_undefined();
    }

    return value;
}

void mal_op_load_private(MalCallable *callable, const MalInstruction *instruction) {
    MalValue result = mal_vm_op_load_private(
        callable->vm,
        callable->registers[instruction->as.load_private.object],
        callable->registers[instruction->as.load_private.key]
    );
    if (callable->vm->completion.kind != MAL_COMPLETION_THROW) {
        callable->registers[instruction->as.load_private.dst] = result;
    }
}

// Shared by the interpreter op and the native backend: PrivateSet. Requires the
// private name to already be installed on the receiver, else throws.
void mal_vm_op_store_private(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value) {
    if (!mal_value_is_object(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    MalObject *object = mal_value_to_object(object_value);
    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};
    MalPropertyLookup lookup = mal_object_get_own(object, key);
    if (!lookup.present) {
        // PrivateSet requires the private name to already be installed.
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, mal_private_absent_message);
        return;
    }

    // SATB: PrivateSet overwrites an already-installed data field (checked above),
    // so shade the old value that mal_property_set_value is about to replace.
    mal_gc_write_barrier(lookup.desc.value);
    mal_property_set_value(object->overflow, key, value);
    mal_gc_card(&object->header, value); // old instance -> young private field value
}

void mal_op_store_private(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_store_private(
        callable->vm,
        callable->registers[instruction->as.store_private.object],
        callable->registers[instruction->as.store_private.key],
        callable->registers[instruction->as.store_private.value]
    );
}

// Shared by the interpreter op and the native backend: the ergonomic brand check
// `#x in obj`. `#x in <non-object>` throws; otherwise returns the presence boolean.
MalValue mal_vm_op_has_private(MalVm *vm, MalValue object_value, MalValue key_value) {
    if (!mal_value_is_object(object_value)) {
        // `#x in <non-object>` throws (ergonomic brand check step 6).
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Cannot use 'in' to check for a private member of a non-object"
        );
        return mal_value_new_undefined();
    }

    MalKey key = {.kind = MAL_KEY_SYMBOL, .value = key_value};
    bool present = mal_object_get_own(mal_value_to_object(object_value), key).present;
    return mal_value_new_boolean(present);
}

void mal_op_has_private(MalCallable *callable, const MalInstruction *instruction) {
    MalValue result = mal_vm_op_has_private(
        callable->vm,
        callable->registers[instruction->as.has_private.object],
        callable->registers[instruction->as.has_private.key]
    );
    if (callable->vm->completion.kind != MAL_COMPLETION_THROW) {
        callable->registers[instruction->as.has_private.dst] = result;
    }
}

// Shared by the interpreter op and the native backend: set [[Prototype]] for an
// object literal `__proto__:` member or class heritage wiring.
void mal_vm_op_set_prototype(MalVm *vm, MalValue object_value, MalValue prototype_value, bool literal) {
    (void) vm;
    if (!mal_value_is_object(object_value)) {
        return;
    }

    if (literal && !mal_value_is_object(prototype_value) && !mal_value_is_null(prototype_value)) {
        // B.3.1: object literal `__proto__:` members ignore other values.
        return;
    }

    MalObject *prototype = mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value) : nullptr;
    mal_object_set_prototype(mal_value_to_object(object_value), prototype);
}

void mal_op_set_prototype(MalCallable *callable, const MalInstruction *instruction) {
    mal_vm_op_set_prototype(
        callable->vm,
        callable->registers[instruction->as.set_prototype.object],
        callable->registers[instruction->as.set_prototype.prototype],
        instruction->as.set_prototype.literal
    );
}

// ---------------------------------------------------------------------------
// Compiled coroutines (native-backend generators & async).
// ---------------------------------------------------------------------------

MalValue *mal_coroutine_alloc_registers(MalVm *vm, i32 slot_count) {
    return mal_vm_alloc_coroutine_buffer(vm, slot_count);
}

static MalValue *mal_compiled_coroutine_arguments(
    MalVm *vm, const MalValue *arguments, i32 argument_count, bool retain_arguments
) {
    if (!retain_arguments || argument_count == 0) {
        return nullptr;
    }
    MalValue *owned = mal_vm_alloc_coroutine_buffer(vm, argument_count);
    for (i32 i = 0; i < argument_count; i++) {
        owned[i] = arguments[i];
    }
    return owned;
}

MalObject *mal_vm_generator_instance_prototype(
    MalVm *vm, MalValue callee, bool is_async_generator
) {
    MalObject *fallback = mal_value_to_object(vm->intrinsics[
        is_async_generator
            ? MAL_INTRINSIC_ASYNC_GENERATOR_PROTOTYPE
            : MAL_INTRINSIC_GENERATOR_PROTOTYPE
    ]);
    if (!mal_value_is_object(callee)) return fallback;

    MalKey prototype_key = mal_intrinsic_hot_string_key(
        vm, MAL_HOT_KEY_PROTOTYPE);
    if (!mal_value_is_proxy_object(callee)) {
        MalPropertyLookup own = mal_object_get_own(
            mal_value_to_object(callee), prototype_key);
        if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
            return mal_value_is_object(own.desc.value)
                ? mal_value_to_object(own.desc.value)
                : fallback;
        }
    }

    MalValue prototype_value;
    if (mal_vm_get_property(vm, callee, prototype_key, &prototype_value) &&
        mal_value_is_object(prototype_value)) {
        return mal_value_to_object(prototype_value);
    }
    return fallback;
}

MalGeneratorObject *mal_vm_op_generator_start_compiled(
    MalVm *vm, MalValue callee, i32 function_index, MalValue this_value, MalEnv *env,
    MalValue *registers, const MalValue *arguments, i32 argument_count,
    bool retain_arguments, i32 resume_ip, bool is_async_generator) {
    MalValue *owned_arguments = mal_compiled_coroutine_arguments(
        vm, arguments, argument_count, retain_arguments
    );
    // The instance inherits the generator function's own .prototype (which
    // inherits %GeneratorPrototype% / %AsyncGeneratorPrototype%), else the
    // intrinsic prototype. `registers` is already published as a GC root by the
    // caller, so a getter on .prototype cannot sweep the pending activation.
    MalObject *generator_prototype = mal_vm_generator_instance_prototype(
        vm, callee, is_async_generator);

    MalGeneratorObject *generator = is_async_generator
        ? mal_generator_object_new_async(&vm->heap, generator_prototype, true)
        : mal_generator_object_new(&vm->heap, generator_prototype);

    // Adopt the register buffer and any argument slice needed after suspension.
    generator->frame.vm = vm;
    generator->frame.function_index = function_index;
    generator->frame.function = &vm->live_runtime_image.functions[function_index];
    generator->frame.registers = registers;
    generator->frame.arguments = owned_arguments;
    generator->frame.argument_count = generator->frame.function->needs_arguments
        ? argument_count
        : 0;
    generator->frame.stack_base = -1;
    generator->frame.this_value = this_value;
    generator->frame.arguments_object = mal_value_new_undefined();
    generator->frame.callee = callee;
    generator->frame.generator = generator;
    generator->frame.env = env;
    generator->frame.is_construct = false;
    generator->frame.new_target = mal_value_new_undefined();
    generator->frame.instruction_pointer = resume_ip;
    generator->frame.gc_safepoint_ip = -1;
    generator->frame.return_register = -1;
    generator->frame.caller_frame_index = -1;
#if MAL_REALMS
    generator->frame.realm = vm->current_realm;
#endif
    generator->state = MAL_GENERATOR_SUSPENDED_START;

    // The generator now owns a frame of (possibly young) register values; if it is
    // old, remember it so a minor collection traces that frame.
    mal_gc_remember_if_old(&generator->object.header);
    return generator;
}

void mal_vm_op_yield_compiled(
    MalVm *vm, MalGeneratorObject *generator, MalValue yielded, i32 value_dst,
    i32 mode_dst, i32 resume_ip, MalEnv *env) {
    // SATB: yielded_value + frame.env are traced heap fields being overwritten;
    // shade the previous contents (the register buffer is mutated in place, so its
    // slots are root state until suspend and need no shade here).
    mal_gc_write_barrier(generator->yielded_value);
    generator->yielded_value = yielded;
    generator->resume_value_register = value_dst;
    generator->resume_mode_register = mode_dst;
    generator->state = MAL_GENERATOR_SUSPENDED_YIELD;
    // The register buffer is mutated in place (it is gen->frame.registers), so only
    // the resume point and the current env need saving for a later resume.
    generator->frame.instruction_pointer = resume_ip;
    if (generator->frame.env != nullptr) {
        mal_gc_write_barrier(mal_value_from_heap(&generator->frame.env->header));
    }
    generator->frame.env = env;
    mal_gc_remember_if_old(&generator->object.header);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // An async generator's yield settles the front request promise with
    // { value, done: false } and drives the next request (the yielded value was
    // already awaited by the compiler-inserted await preceding this yield).
    if (generator->is_async_generator) {
        mal_async_generator_yield(vm, generator);
    }
}

void mal_vm_op_terminal_yield_compiled(
    MalVm *vm, MalGeneratorObject *generator, MalValue yielded) {
    mal_gc_write_barrier(generator->yielded_value);
    generator->yielded_value = yielded;
    generator->state = MAL_GENERATOR_COMPLETED;
    generator->terminal_yield_pending = true;
    mal_gc_remember_if_old(&generator->object.header);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

void mal_vm_op_coroutine_return_compiled(MalVm *vm, MalGeneratorObject *generator, MalValue value) {
    // COMPLETED before freeing: the finalizer frees the buffers only while
    // suspended, so marking first keeps a swept-after-completion object from
    // double-freeing (matching the interpreter's RETURN + finalizer contract).
    generator->state = MAL_GENERATOR_COMPLETED;

    if (generator->is_async_generator) {
        // Completing the async generator settles the front request { value, done: true }.
        mal_async_generator_return(vm, generator, value);
    } else if (generator->is_async) {
        // Resolving the result promise is the async function's return.
        mal_async_function_settle_return(vm, generator, value);
    } else {
        // Plain generator: the .next() driver reads the value from the completion.
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    }

    // Release after routing: settle_* re-enters the VM (mal_vm_call_value), and the
    // compiled frame's root frame is still linked over this buffer until the caller
    // unlinks it, so recycling first could expose cleared/reused storage there.
    // SATB: the frame just went COMPLETED (tracer now skips it) and its buffer is
    // released here, so shade the activation's live edges before they leave the graph.
    mal_generator_release_frame(vm, generator);
}

void mal_vm_op_coroutine_throw_compiled(MalVm *vm, MalGeneratorObject *generator, MalValue *registers) {
    if (generator == nullptr) {
        // A generator's parameter prologue threw before GENERATOR_START adopted the
        // buffer: no coroutine object exists, so release the orphaned buffer and let
        // the throw propagate synchronously to the caller (params are evaluated
        // eagerly at call time, before the generator is created).
        mal_vm_release_coroutine_buffer(vm, registers);
        return;
    }

    // Capture the pending exception, then reset the completion to NORMAL *before*
    // settling: settle_* / throw_done re-enter the VM via mal_vm_call_value, which
    // must not run the reject reaction with a pending THROW (it would swallow it).
    // This mirrors the interpreter's async-uncaught-throw handler (vm.c).
    MalValue reason = vm->completion.value;
    generator->state = MAL_GENERATOR_COMPLETED;

    if (generator->is_async_generator) {
        // Reject the front request with the pending exception and settle the agen.
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_async_generator_throw_done(vm, generator, reason);
    } else if (generator->is_async) {
        // The async function's body threw: reject its result promise rather than
        // propagate (the async body's implicit try/catch).
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        mal_async_function_settle_throw(vm, generator, reason);
    }
    // Plain generator: leave vm->completion == THROW(reason) for the .next() caller
    // to re-raise.

    // Free after routing (see mal_vm_op_coroutine_return_compiled) — the root frame
    // is still linked over this buffer during the settle above.
    // SATB: shade the completed activation's edges before its buffer leaves the graph.
    mal_generator_release_frame(vm, generator);
}

MalGeneratorObject *mal_vm_op_async_start_compiled(
    MalVm *vm, MalValue callee, i32 function_index, MalValue this_value, MalEnv *env,
    MalValue *registers, const MalValue *arguments, i32 argument_count,
    bool retain_arguments, MalValue *out_promise) {
    MalValue *owned_arguments = mal_compiled_coroutine_arguments(
        vm, arguments, argument_count, retain_arguments
    );
    MalPromiseObject *promise = mal_promise_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);
    MalRootSpan promise_root;
    mal_gc_root(&promise_root, &promise_value, 1);

    // The hidden async state reuses the generator suspendable-frame object.
    MalGeneratorObject *state = mal_generator_object_new_async(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        false);
    state->async_data->promise = promise_value;
    state->state = MAL_GENERATOR_EXECUTING;
    // Link the result promise back to this async state for async stack stitching.
    promise = mal_value_to_promise_object(promise_value);
    promise->async_owner = state;
    mal_promise_note_direct_async_result();

    state->frame.vm = vm;
    state->frame.function_index = function_index;
    state->frame.function = &vm->live_runtime_image.functions[function_index];
    state->frame.registers = registers;
    state->frame.arguments = owned_arguments;
    state->frame.argument_count = state->frame.function->needs_arguments
        ? argument_count
        : 0;
    state->frame.stack_base = -1;
    state->frame.this_value = this_value;
    state->frame.arguments_object = mal_value_new_undefined();
    state->frame.callee = callee;
    state->frame.generator = state;
    state->frame.env = env;
    state->frame.is_construct = false;
    state->frame.new_target = mal_value_new_undefined();
    state->frame.instruction_pointer = -1; // set at each await
    state->frame.gc_safepoint_ip = -1;
    state->frame.return_register = -1;
    state->frame.caller_frame_index = -1;
#if MAL_REALMS
    state->frame.realm = vm->current_realm;
#endif

    mal_gc_remember_if_old(&state->object.header);

    *out_promise = promise_value;
    mal_gc_unroot(&promise_root);
    return state;
}

void mal_vm_op_await_compiled(
    MalVm *vm, MalGeneratorObject *state, MalValue awaited, i32 value_dst, i32 mode_dst,
    i32 resume_ip, MalEnv *env) {
    state->resume_value_register = value_dst;
    state->resume_mode_register = mode_dst;
    state->state = MAL_GENERATOR_SUSPENDED_YIELD;
    state->frame.instruction_pointer = resume_ip;
    // SATB: frame.env is a traced heap field being overwritten; shade the previous env.
    if (state->frame.env != nullptr) {
        mal_gc_write_barrier(mal_value_from_heap(&state->frame.env->header));
    }
    state->frame.env = env;
    mal_gc_remember_if_old(&state->object.header);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    // Hook the settlement continuation; when the awaited value settles a microtask
    // resumes this state. (If PromiseResolve throws, this resumes synchronously with
    // a throw — a nested resume of the same compiled function, which then returns.)
    mal_async_function_await(vm, state, awaited);
}

MalCompletion mal_builtin_sort_numeric(
    MalVm *vm, MalCallCache *fallback_cache, bool copy, bool via_call, i32 function_index,
    MalNumericSortComparator comparator, MalValue callee, MalValue receiver,
    const MalValue *args, i32 arg_count
) {
    MalNativeFunctionCallback expected = mal_value_is_native_function_object(callee)
        ? mal_native_function_object_callback(mal_value_to_native_function_object(callee)) : nullptr;
    if (arg_count != (via_call ? 2 : 1))
        return mal_vm_call_cached(vm, fallback_cache, callee, receiver, args, arg_count);
    MalValue sort_callee = via_call ? receiver : callee;
    MalValue sort_receiver = via_call ? args[0] : receiver;
    MalValue callback = args[via_call ? 1 : 0];
    MalNativeFunctionCallback sort = mal_value_is_native_function_object(sort_callee)
        ? mal_native_function_object_callback(mal_value_to_native_function_object(sort_callee)) : nullptr;
    bool array_sort = sort == (copy ? mal_builtin_array_to_sorted : mal_builtin_array_sort);
    bool typed_sort = sort == (copy ? mal_builtin_typed_array_to_sorted : mal_builtin_typed_array_sort);
    bool admitted = comparator != nullptr && function_index >= 0 &&
        function_index < vm->runtime_image->function_count &&
        (!via_call || expected == mal_builtin_function_prototype_call) &&
        ((array_sort && mal_value_is_array_object(sort_receiver)) ||
         (typed_sort && mal_value_is_typed_array_object(sort_receiver) &&
          mal_value_to_typed_array_object(sort_receiver)->kind < MAL_TA_BIGINT64)) &&
        mal_value_is_function_object(callback) &&
        mal_function_object_function_index(mal_value_to_function_object(callback)) == function_index;
#if MAL_REALMS
    admitted = admitted && mal_vm_callee_realm(vm, callee) == vm->current_realm &&
        mal_vm_callee_realm(vm, sort_callee) == vm->current_realm;
#endif
    if (!admitted) return mal_vm_call_cached(vm, fallback_cache, callee, receiver, args, arg_count);
    MalExactScriptCall exact = {
        .previous = vm->exact_script_call,
        .callee = callback,
        .function_index = function_index,
        .numeric_sort_comparator = comparator,
        .function = &vm->runtime_image->functions[function_index],
        .env = mal_value_to_function_object(callback)->creation_env,
    };
    vm->exact_script_call = &exact;
    MalCompletion completion = mal_vm_call_exact_native(vm, expected, callee, receiver, args, arg_count);
    vm->exact_script_call = exact.previous;
    return completion;
}
