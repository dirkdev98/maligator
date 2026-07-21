#include "./shape.h"

#include <stdlib.h>
#include <string.h>

#include "./value.h"

/** A transition edge: parent + (key, attrs) -> child. */
struct MalShapeTransition {
    MalValue key;
    MalShape *child;
    MalShapeTransition *next;
    u8 attrs;
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

bool mal_shape_attrs_are_default(u8 attrs) {
    return attrs
        == (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

i32 mal_shape_find(const MalShape *shape, MalKey key) {
    for (u32 i = 0; i < shape->inline_count; ++i) {
        if (mal_key_value_equals(shape->props[i].key, key.value)) {
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
        if (t->attrs == attrs && mal_key_value_equals(t->key, key.value)) {
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
        .key = key.value,
        .attrs = attrs,
        .slot = shape->inline_count,
    };
    child->parent = shape;
    child->transitions = nullptr;

    MalShapeTransition *transition = malloc(sizeof(MalShapeTransition));
    transition->key = key.value;
    transition->attrs = attrs;
    transition->child = child;
    transition->next = shape->transitions;
    shape->transitions = transition;

    return child;
}

static void mal_shape_visit_child_keys(MalShape *shape, void (*visit)(MalValue)) {
    for (MalShapeTransition *transition = shape->transitions;
         transition != nullptr; transition = transition->next) {
        visit(transition->key);
        mal_shape_visit_child_keys(transition->child, visit);
    }
}

void mal_shape_visit_transition_keys(void (*visit)(MalValue)) {
    mal_shape_visit_child_keys(&g_empty_shape, visit);
}
