#include "function_object.h"

#include <assert.h>

#include "gc.h"
#include "heap_string.h"
#include "profile.h"
#include "value.h"

static_assert(sizeof(MalFunctionObject) % alignof(MalValue) == 0,
              "script function trailing metadata slots are misaligned");
static_assert(sizeof(MalNativeFunctionObject) % alignof(MalValue) == 0,
              "native function trailing metadata slots are misaligned");

static MalShape *mal_function_metadata_shape(
    MalHeap *heap, const MalShape *base, MalKey length_key, MalKey name_key, bool named
) {
    usize index = (named ? 1 : 0) +
        (heap->native_function_length_key != nullptr &&
         length_key.value == mal_value_from_string(heap->native_function_length_key) ? 2 : 0);
    MalShape *shape = heap->function_metadata_shapes[index].shape;
    // The shape's own keys stay alive with it, so identical key pointers prove the
    // same transitions; an equal key in another string merely misses.
    if (shape != nullptr && heap->function_metadata_shapes[index].base == base &&
        shape->props[0].key == length_key.value &&
        (!named || shape->props[1].key == name_key.value)) {
        return shape;
    }
    shape = mal_shape_add_property((MalShape *) base, length_key, MAL_PROPERTY_CONFIGURABLE);
    if (named) shape = mal_shape_add_property(shape, name_key, MAL_PROPERTY_CONFIGURABLE);
    heap->function_metadata_shapes[index].base = base;
    heap->function_metadata_shapes[index].shape = shape;
    return shape;
}

/** Install the spec function metadata directly in a shared non-default shape. */
static void mal_function_init_metadata(
    MalHeap *heap,
    MalObject *object,
    MalKey length_key,
    MalValue length,
    MalKey name_key,
    MalString *name,
    MalValue *coallocated_slots
) {
    assert(object->shape->inline_count == 0);
    assert(mal_object_fields(object) == nullptr);
    assert(mal_object_overflow(object) == nullptr);
    assert(length_key.kind == MAL_KEY_STRING);
    assert(name == nullptr || name_key.kind == MAL_KEY_STRING);

    MalShape *shape = mal_function_metadata_shape(
        heap, object->shape, length_key, name_key, name != nullptr);
    MalValue values[2] = {length, mal_value_new_undefined()};
    u32 count = 1;
    if (name != nullptr) {
        values[1] = mal_value_from_string(name);
        count = 2;
    }

    if (coallocated_slots == nullptr) {
        mal_object_set_shaped_values(object, shape, values, count);
        return;
    }
    object->shape = shape;
    mal_object_set_fields_pointer(object, coallocated_slots);
    object->slot_capacity = (u8) count;
    for (u32 i = 0; i < count; i++) {
        mal_object_field_initialize(object, shape, i, values[i]);
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
    function->handles_new_target_prototype = false;
    function->is_async = false;
#if MAL_PROFILE && MAL_PERF_STATS
    function->profile_category = heap->profile_native_category;
#endif
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
        .value = mal_value_from_string(heap->native_function_length_key),
    };
    *name_key = (MalKey) {0};
    if (has_name) {
        *name_key = (MalKey) {
            .kind = MAL_KEY_STRING,
            .value = mal_value_from_string(heap->native_function_name_key),
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
        heap, &function->object, length_key, mal_value_from_i32(length), name_key, name, nullptr);
}

MalShape *mal_function_object_metadata_shape(
    MalHeap *heap, MalKey length_key, MalKey name_key, bool named
) {
    return mal_function_metadata_shape(heap, mal_shape_root(heap), length_key, name_key, named);
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
        heap, &function->object, length_key, mal_value_from_i32(length), name_key, name, nullptr);
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
        heap, &function->object, length_key, mal_value_from_i32(length), name_key, name,
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
        function->slots = mal_heap_alloc_raw_profiled(
            heap, sizeof(MalValue) * slot_count,
            MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION);
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
        heap, &function->object, length_key, mal_value_from_i32(length), name_key, name,
        (MalValue *) (function + 1));
    if (slot_count > 0) {
        function->slots = mal_heap_alloc_raw_profiled(
            heap, sizeof(MalValue) * slot_count,
            MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION);
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

bool mal_native_function_object_is_constructor(const MalNativeFunctionObject *function) {
    return function->is_constructor;
}

void mal_native_function_object_set_constructor(MalNativeFunctionObject *function) {
    function->is_constructor = true;
}

bool mal_native_function_object_is_async(const MalNativeFunctionObject *function) {
    return function->is_async;
}

void mal_native_function_object_set_async(MalNativeFunctionObject *function) {
    function->is_async = true;
}

bool mal_native_function_object_handles_new_target_prototype(
    const MalNativeFunctionObject *function
) {
    return function->handles_new_target_prototype;
}

void mal_native_function_object_set_handles_new_target_prototype(
    MalNativeFunctionObject *function
) {
    function->handles_new_target_prototype = true;
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
