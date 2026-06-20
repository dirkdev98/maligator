#include "./shape.h"

#include <stdlib.h>
#include <string.h>

#include "./heap_string.h"
#include "./value.h"

/** A transition edge: parent + (key, attrs) -> child. */
struct MalShapeTransition {
    MalKey key;
    u8 attrs;
    MalShape *child;
    MalShapeTransition *next;
};

/**
 * The immortal empty shape (0 properties). Baked into static storage like other
 * compile-time-immortal cells, so the future GC neither collects nor traces it.
 */
static MalShape g_empty_shape = {
    .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_SHAPE),
    .inline_count = 0,
    .props = nullptr,
    .parent = nullptr,
    .transitions = nullptr,
};

MalShape *mal_shape_empty(void) {
    return &g_empty_shape;
}

/* Key equality matching the table's rule: string keys by content, others by
 * value bits (MAL_KEY_SYMBOL/OBJECT compare pointer identity, INDEX/NUMBER/STATIC
 * compare bit pattern). Keep in sync with mal_table_key_equals (table.c). */
static bool mal_shape_key_equals(MalKey left, MalKey right) {
    if (left.kind != right.kind) {
        return false;
    }
    if (left.kind != MAL_KEY_STRING) {
        return left.value == right.value;
    }
    return mal_string_equals(mal_value_to_string(left.value), mal_value_to_string(right.value));
}

bool mal_shape_attrs_are_default(u8 attrs) {
    return attrs
        == (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

i32 mal_shape_find(const MalShape *shape, MalKey key) {
    for (u32 i = 0; i < shape->inline_count; ++i) {
        if (mal_shape_key_equals(shape->props[i].key, key)) {
            return (i32) i;
        }
    }
    return -1;
}

MalShape *mal_shape_from_string_keys(struct MalString **keys, u32 count) {
    MalShape *shape = mal_shape_empty();
    for (u32 i = 0; i < count; ++i) {
        MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(keys[i])};
        shape = mal_shape_add_property(
            shape, key,
            (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    }
    return shape;
}

MalShape *mal_shape_add_property(MalShape *shape, MalKey key, u8 attrs) {
    // Reuse an existing transition so all objects that add the same property in
    // the same order share one child shape (the interning that makes shapes pay).
    for (MalShapeTransition *t = shape->transitions; t != nullptr; t = t->next) {
        if (t->attrs == attrs && mal_shape_key_equals(t->key, key)) {
            return t->child;
        }
    }

    MalShape *child = malloc(sizeof(MalShape));
    child->header = (MalHeapHeader){.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC};
    child->inline_count = shape->inline_count + 1;
    child->props = malloc(sizeof(MalShapeProp) * child->inline_count);
    if (shape->inline_count > 0) {
        memcpy(child->props, shape->props, sizeof(MalShapeProp) * shape->inline_count);
    }
    child->props[shape->inline_count] = (MalShapeProp){
        .key = key,
        .attrs = attrs,
        .slot = shape->inline_count,
    };
    child->parent = shape;
    child->transitions = nullptr;

    MalShapeTransition *transition = malloc(sizeof(MalShapeTransition));
    transition->key = key;
    transition->attrs = attrs;
    transition->child = child;
    transition->next = shape->transitions;
    shape->transitions = transition;

    return child;
}
