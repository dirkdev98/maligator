#include "function_object.h"

#include "heap_string.h"
#include "object_ops.h"
#include "value.h"

// Built-in functions expose `name` as an own data property
// { writable: false, enumerable: false, configurable: true } that the
// descriptor/hasOwnProperty machinery can see (the synthetic resolver alone is
// invisible to them). length stays synthetic until natives carry real arities.
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
    MalNativeFunctionCallback callback
) {
    mal_object_init(heap, &function->object, MAL_HEAP_NATIVE_FUNCTION_OBJECT, prototype);
    function->name = name;
    function->callback = callback;
    mal_native_function_define_name(heap, &function->object, name);
}

MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_heap_alloc(heap, sizeof(MalNativeFunctionObject), MAL_HEAP_NATIVE_FUNCTION_OBJECT);
    mal_native_function_object_init(heap, function, prototype, name, callback);

    return function;
}

MalString *mal_native_function_object_name(const MalNativeFunctionObject *function) {
    return function->name;
}

MalNativeFunctionCallback mal_native_function_object_callback(const MalNativeFunctionObject *function) {
    return function->callback;
}
