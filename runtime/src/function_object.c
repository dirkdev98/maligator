#include "function_object.h"

#include <assert.h>

#include "gc.h"
#include "heap_string.h"
#include "profile.h"
#include "value.h"

static_assert(sizeof(MalFunctionObject) % alignof(MalValue) == 0,
              "script function capture displays are misaligned");
static_assert(sizeof(MalFunctionObject) <= 48, "closure exceeds the 48-byte size class");
static_assert(offsetof(MalClosureMetadata, storage) == 0,
              "borrowed storage must lead the definition's metadata");
static_assert(offsetof(MalFunctionObject, property_storage) == sizeof(MalObject),
              "external storage must follow the object prefix");
static_assert(offsetof(MalNativeFunctionObject, metadata) == sizeof(MalObject) + sizeof(void *),
              "native function fields must follow the prototype word");
static_assert(offsetof(MalNativeFunctionObject, trailing) % alignof(MalValue) == 0,
              "native function inline closure slots are misaligned");

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

static MalNativeFunctionObject *mal_native_function_alloc(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback,
    MalKey length_key,
    MalKey name_key,
    u32 inline_slots
) {
    assert(length_key.kind == MAL_KEY_STRING);
    assert(name == nullptr || name_key.kind == MAL_KEY_STRING);
    MalShape *shape = mal_function_object_metadata_shape(
        heap, length_key, name_key, name != nullptr);
    MalNativeFunctionObject *function = mal_heap_alloc_uninitialized(
        heap, sizeof(MalNativeFunctionObject) + inline_slots * sizeof(MalValue),
        MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    MalHeapHeader header = function->object.header;
    function->object = (MalObject) {
        .header = header,
        .extensible = true,
        .storage_kind = MAL_OBJECT_COMPACT,
        .slot_capacity = name == nullptr ? 1 : 2,
        // Property growth past the in-cell metadata must preserve the callable state.
        .inline_payload_eights = countof(function->metadata),
        .shape = shape,
    };
    function->property_storage = prototype;
    mal_object_mark_as_prototype(prototype);
    function->metadata[0] = mal_value_from_i32(length);
    if (name != nullptr) {
        function->metadata[1] = mal_value_from_string(name);
        mal_gc_card(&function->object.header, function->metadata[1]);
    }
    function->name = name;
    function->callback = callback;
    function->is_constructor = false;
    function->handles_new_target_prototype = false;
    function->is_async = false;
#if MAL_PROFILE && MAL_PERF_STATS
    function->profile_category = heap->profile_native_category;
#endif
    function->slots = nullptr;
    function->slot_count = 0;
    function->slots_inline = false;
#if MAL_REALMS
    function->realm = heap->current_realm;
#endif
    return function;
}

// Larger slot sets keep the cell in the small size classes and use a RAW vector.
#define MAL_NATIVE_FUNCTION_INLINE_SLOTS_MAX 16

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

MalShape *mal_function_object_metadata_shape(
    MalHeap *heap, MalKey length_key, MalKey name_key, bool named
) {
    return mal_function_metadata_shape(heap, mal_shape_root(heap), length_key, name_key, named);
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
    return mal_native_function_alloc(heap, prototype, name, length, callback, length_key, name_key, 0);
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
    MalKey length_key;
    MalKey name_key;
    mal_native_function_metadata_keys(heap, name != nullptr, &length_key, &name_key);
    return mal_native_function_object_new_with_slots_arity_keys(
        heap, prototype, name, length, callback, slots, slot_count, length_key, name_key);
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
    u32 inline_slots = slot_count > 0 && slot_count <= MAL_NATIVE_FUNCTION_INLINE_SLOTS_MAX
        ? (u32) slot_count : 0;
    MalNativeFunctionObject *function = mal_native_function_alloc(
        heap, prototype, name, length, callback, length_key, name_key, inline_slots);
    if (slot_count <= 0) return function;
    if (inline_slots != 0) {
        function->slots = function->trailing;
        function->slots_inline = true;
    } else {
        function->slots = mal_heap_alloc_raw_profiled(
            heap, sizeof(MalValue) * slot_count, MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION);
        mal_heap_cell_needs_finalizer(&function->object.header);
    }
    function->slot_count = slot_count;
    for (i32 i = 0; i < slot_count; i++) {
        function->slots[i] = slots[i];
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
