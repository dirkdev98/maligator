#include "function_object.h"

#include "heap_string.h"
#include "object_ops.h"
#include "value.h"

// Built-in functions expose `name` and `length` as own data properties
// { writable: false, enumerable: false, configurable: true } that the
// descriptor/hasOwnProperty/delete machinery can see (the synthetic resolver
// alone is invisible to them, and would also defeat configurable:true delete).
static void mal_native_function_define_name(MalHeap *heap, MalObject *object, MalString *name) {
    if (name == nullptr) {
        return;
    }
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_from_string(name),
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(mal_string_new_ascii(heap, "name", 4))};
    mal_object_define_own(object, key, &desc);
}

static void mal_native_function_define_length(MalHeap *heap, MalObject *object, i32 length) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_from_i32(length),
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(mal_string_new_ascii(heap, "length", 6))};
    mal_object_define_own(object, key, &desc);
}

void mal_function_object_init(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index
) {
    mal_object_init(heap, &function->object, MAL_HEAP_FUNCTION_OBJECT, prototype);
    function->function_index = function_index;
    function->creation_env = nullptr;
}

MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    i32 function_index
) {
    MalFunctionObject *function = mal_heap_alloc(heap, sizeof(MalFunctionObject), MAL_HEAP_FUNCTION_OBJECT);
    mal_function_object_init(heap, function, prototype, function_index);

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
    mal_object_init(heap, &function->object, MAL_HEAP_NATIVE_FUNCTION_OBJECT, prototype);
    function->name = name;
    function->callback = callback;
    function->length = length;
    function->is_constructor = false;
    function->slots = nullptr;
    function->slot_count = 0;
    // Per spec (CreateBuiltinFunction / SetFunctionLength then SetFunctionName),
    // `length` is the earlier own property and `name` follows it.
    mal_native_function_define_length(heap, &function->object, length);
    mal_native_function_define_name(heap, &function->object, name);
}

MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_heap_alloc(heap, sizeof(MalNativeFunctionObject), MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    mal_native_function_object_init(heap, function, prototype, name, 0, callback);

    return function;
}

MalNativeFunctionObject *mal_native_function_object_new_arity(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_heap_alloc(heap, sizeof(MalNativeFunctionObject), MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    mal_native_function_object_init(heap, function, prototype, name, length, callback);

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
    MalNativeFunctionObject *function = mal_native_function_object_new(heap, prototype, name, callback);
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
        function->slots[index] = value;
    }
}
