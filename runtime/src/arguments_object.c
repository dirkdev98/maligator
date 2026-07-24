#include "arguments_object.h"

#include "gc.h"

MalArgumentsObject *mal_arguments_object_new(
    MalHeap *heap, MalObject *prototype, MalEnv *env,
    const i32 *parameter_map, i32 map_count, i32 argument_count) {
    MalArgumentsObject *arguments = mal_heap_alloc(
        heap, sizeof(MalArgumentsObject) + sizeof(i32) * (usize) map_count,
        MAL_HEAP_ARGUMENTS_OBJECT);
    mal_object_init(heap, &arguments->object, MAL_HEAP_ARGUMENTS_OBJECT, prototype);
    arguments->object.is_arguments = true;
    arguments->env = env;
    mal_gc_remember_if_old(&arguments->object.header);
    arguments->map_count = map_count;
    for (i32 i = 0; i < map_count; i++) {
        arguments->parameter_map[i] = i < argument_count ? parameter_map[i] : -1;
    }
    return arguments;
}
