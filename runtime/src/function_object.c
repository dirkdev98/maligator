#include "function_object.h"

#include <assert.h>

#include "gc.h"
#include "heap_string.h"
#include "value.h"

static_assert(sizeof(MalFunctionObject) % alignof(MalValue) == 0,
              "script function trailing metadata slots are misaligned");
static_assert(sizeof(MalNativeFunctionObject) % alignof(MalValue) == 0,
              "native function trailing metadata slots are misaligned");

/** Install the spec function metadata directly in a shared non-default shape. */
static void mal_function_init_metadata(
    MalObject *object,
    MalKey length_key,
    MalValue length,
    MalKey name_key,
    MalString *name,
    MalValue *coallocated_slots
) {
    assert(object->shape == mal_shape_empty());
    assert(object->slots == nullptr);
    assert(object->overflow == nullptr);
    assert(length_key.kind == MAL_KEY_STRING);
    assert(name == nullptr || name_key.kind == MAL_KEY_STRING);

    MalShape *shape = mal_shape_add_property(
        mal_shape_empty(), length_key, MAL_PROPERTY_CONFIGURABLE);
    MalValue values[2] = {length, mal_value_new_undefined()};
    u32 count = 1;
    if (name != nullptr) {
        shape = mal_shape_add_property(shape, name_key, MAL_PROPERTY_CONFIGURABLE);
        values[1] = mal_value_from_string(name);
        count = 2;
    }

    if (coallocated_slots == nullptr) {
        mal_object_set_shaped_values(object, shape, values, count);
        return;
    }
    object->shape = shape;
    object->slots = coallocated_slots;
    for (u32 i = 0; i < count; i++) {
        object->slots[i] = values[i];
    }
}

static void mal_native_function_init_state(
    MalHeap *heap,
    MalNativeFunctionObject *function,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback
) {
    mal_object_init(heap, &function->object, MAL_HEAP_NATIVE_FUNCTION_OBJECT, prototype);
    function->name = name;
    function->callback = callback;
    function->length = length;
    function->is_constructor = false;
    function->slots = nullptr;
    function->slot_count = 0;
#if MAL_REALMS
    function->realm = heap->current_realm;
#endif
}

static void mal_function_init_state(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index
) {
    mal_object_init(heap, &function->object, MAL_HEAP_FUNCTION_OBJECT, prototype);
    function->function_index = function_index;
    function->creation_env = nullptr;
#if MAL_REALMS
    function->realm = heap->current_realm;
#endif
}

static void mal_native_function_metadata_keys(
    MalHeap *heap,
    bool has_name,
    MalKey *length_key,
    MalKey *name_key
) {
    *length_key = (MalKey) {
        .kind = MAL_KEY_STRING,
        .value = mal_value_from_string(mal_string_new_ascii(heap, "length", 6)),
    };
    *name_key = (MalKey) {0};
    if (has_name) {
        *name_key = (MalKey) {
            .kind = MAL_KEY_STRING,
            .value = mal_value_from_string(mal_string_new_ascii(heap, "name", 4)),
        };
    }
}

void mal_function_object_init(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index,
    i32 length,
    MalString *name,
    MalKey length_key,
    MalKey name_key
) {
    mal_function_init_state(heap, function, prototype, function_index);
    mal_function_init_metadata(
        &function->object, length_key, mal_value_from_i32(length), name_key, name, nullptr);
}

MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    i32 function_index,
    i32 length,
    MalString *name,
    MalKey length_key,
    MalKey name_key
) {
    MalFunctionObject *function = mal_heap_alloc(
        heap, sizeof(MalFunctionObject) + 2 * sizeof(MalValue), MAL_HEAP_FUNCTION_OBJECT);
    mal_function_init_state(heap, function, prototype, function_index);
    mal_function_init_metadata(
        &function->object, length_key, mal_value_from_i32(length), name_key, name,
        (MalValue *) (function + 1));

    return function;
}

i32 mal_function_object_function_index(const MalFunctionObject *function) {
    return function->function_index;
}

void mal_native_function_object_init(
    MalHeap *heap,
    MalNativeFunctionObject *function,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback
) {
    mal_native_function_init_state(heap, function, prototype, name, length, callback);
    // Per spec (CreateBuiltinFunction / SetFunctionLength then SetFunctionName),
    // `length` is the earlier own property and `name` follows it.
    MalKey length_key;
    MalKey name_key;
    mal_native_function_metadata_keys(heap, name != nullptr, &length_key, &name_key);
    mal_function_init_metadata(
        &function->object, length_key, mal_value_from_i32(length), name_key, name, nullptr);
}

MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
) {
    return mal_native_function_object_new_arity(heap, prototype, name, 0, callback);
}

MalNativeFunctionObject *mal_native_function_object_new_arity(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback
) {
    MalKey length_key;
    MalKey name_key;
    mal_native_function_metadata_keys(heap, name != nullptr, &length_key, &name_key);
    u32 metadata_count = name == nullptr ? 1 : 2;
    MalNativeFunctionObject *function = mal_heap_alloc(
        heap, sizeof(MalNativeFunctionObject) + metadata_count * sizeof(MalValue),
        MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    mal_native_function_init_state(heap, function, prototype, name, length, callback);
    mal_function_init_metadata(
        &function->object, length_key, mal_value_from_i32(length), name_key, name,
        (MalValue *) (function + 1));

    return function;
}

MalNativeFunctionObject *mal_native_function_object_new_with_slots(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count
) {
    return mal_native_function_object_new_with_slots_arity(
        heap, prototype, name, 0, callback, slots, slot_count);
}

MalNativeFunctionObject *mal_native_function_object_new_with_slots_arity(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count
) {
    MalNativeFunctionObject *function =
        mal_native_function_object_new_arity(heap, prototype, name, length, callback);
    if (slot_count > 0) {
        function->slots = mal_heap_alloc_raw(heap, sizeof(MalValue) * slot_count);
        function->slot_count = slot_count;
        for (i32 i = 0; i < slot_count; i++) {
            function->slots[i] = slots[i];
        }
    }

    return function;
}

MalNativeFunctionObject *mal_native_function_object_new_with_slots_arity_keys(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count,
    MalKey length_key,
    MalKey name_key
) {
    u32 metadata_count = name == nullptr ? 1 : 2;
    MalNativeFunctionObject *function =
        mal_heap_alloc(heap, sizeof(MalNativeFunctionObject) + metadata_count * sizeof(MalValue),
                       MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    mal_native_function_init_state(heap, function, prototype, name, length, callback);
    mal_function_init_metadata(
        &function->object, length_key, mal_value_from_i32(length), name_key, name,
        (MalValue *) (function + 1));
    if (slot_count > 0) {
        function->slots = mal_heap_alloc_raw(heap, sizeof(MalValue) * slot_count);
        function->slot_count = slot_count;
        for (i32 i = 0; i < slot_count; i++) {
            function->slots[i] = slots[i];
        }
    }
    return function;
}

MalString *mal_native_function_object_name(const MalNativeFunctionObject *function) {
    return function->name;
}

MalNativeFunctionCallback mal_native_function_object_callback(const MalNativeFunctionObject *function) {
    return function->callback;
}

bool mal_native_function_object_is_constructor(const MalNativeFunctionObject *function) {
    return function->is_constructor;
}

void mal_native_function_object_set_constructor(MalNativeFunctionObject *function) {
    function->is_constructor = true;
}

MalValue mal_native_function_object_get_slot(const MalNativeFunctionObject *function, i32 index) {
    if (index < 0 || index >= function->slot_count) {
        return mal_value_new_undefined();
    }
    return function->slots[index];
}

void mal_native_function_object_set_slot(MalNativeFunctionObject *function, i32 index, MalValue value) {
    if (index >= 0 && index < function->slot_count) {
        // SATB: internal-slot closures (promise combinators, from-async step
        // machine, proxy revoke) re-store their slots; all slots are initialized at
        // construction, so shade the dropped value. Folds out off-cycle.
        mal_gc_write_barrier(function->slots[index]);
        function->slots[index] = value;
        // Generational: an old internal-slot closure gaining a young slot value
        // needs a remembered-set entry or a minor sweep frees the young target.
        mal_gc_card(&function->object.header, value);
    }
}
