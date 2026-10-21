#include "class_layout.h"

#include <stdlib.h>

#include "object_ops.h"
#include "perf_stats.h"
#include "shape.h"

static MalValue mal_class_layout_key(const MalVm *vm, i32 encoded) {
    return encoded >= 0
        ? mal_value_from_string(vm->string_constant_atoms[encoded])
        : vm->globals[~encoded];
}

/** The data value `key` resolves to from `prototype`, if no accessor or exotic object intervenes. */
static bool mal_class_layout_resolve(
    const MalObject *prototype, MalKey key, MalValue *out
) {
    for (const MalObject *cursor = prototype; cursor != nullptr;
         cursor = mal_object_prototype(cursor)) {
        if (cursor->header.type != MAL_HEAP_OBJECT) return false;
        MalPropertyLookup lookup = mal_object_get_own(cursor, key);
        if (!lookup.present) continue;
        if (lookup.desc.flags & MAL_PROPERTY_ACCESSOR) return false;
        *out = lookup.desc.value;
        return true;
    }
    return false;
}

static bool mal_class_layout_admits(
    MalVm *vm, const MalClassLayoutDesc *desc, const MalObject *object,
    const MalObject *prototype, MalValue *methods
) {
    const MalShape *shape = object->shape;
    if (shape->inline_count < (u32) desc->key_count) return false;
    for (i32 index = 0; index < desc->key_count; index++) {
        const MalShapeProp *prop = &shape->props[index];
        if (prop->key != mal_class_layout_key(vm, desc->keys[index]) ||
            prop->slot != (u32) index || (prop->attrs & MAL_PROPERTY_ACCESSOR) ||
            !(prop->attrs & MAL_PROPERTY_WRITABLE)) {
            return false;
        }
    }
    for (i32 index = 0; index < desc->method_count; index++) {
        MalKey key = {
            .kind = MAL_KEY_STRING,
            .value = mal_value_from_string(vm->string_constant_atoms[desc->methods[index * 2]]),
        };
        MalValue method;
        if (mal_shape_find(shape, key, MAL_SHAPE_FIND_GET_OWN) >= 0 ||
            !mal_class_layout_resolve(prototype, key, &method) ||
            !mal_vm_callee_has_index(vm, method, desc->methods[index * 2 + 1])) {
            return false;
        }
        methods[index] = method;
    }
    return true;
}

bool mal_vm_class_cell_learn(MalVm *vm, MalClassLayoutCell *cell, MalValue receiver) {
    if (cell->ic.shape != nullptr) return true;
    cell->probes++;
    const MalObject *object = mal_vm_as_object(receiver);
    if (object == nullptr || object->is_arguments || mal_object_has_public_overflow(object)) {
        return false;
    }
    // Neither an instance under construction nor another class's instance is
    // evidence against the layout, so neither spends an attempt.
    const MalClassLayoutDesc *desc = cell->desc;
    if (object->shape->inline_count < (u32) desc->key_count ||
        (desc->key_count > 0 &&
         object->shape->props[0].key != mal_class_layout_key(vm, desc->keys[0]))) {
        return false;
    }
    MalObject *prototype = mal_object_prototype(object);
    if (!mal_class_layout_admits(vm, desc, object, prototype, cell->methods)) {
        cell->attempts++;
        MAL_PERF_COUNT(class_layout_rejections);
        return false;
    }
    // A layout without methods only licenses own slots, which the shape alone decides.
    if (prototype != nullptr && desc->method_count > 0 &&
        !mal_object_register_prototype_cache(prototype, nullptr, &cell->ic, true)) {
        cell->attempts++;
        return false;
    }
    cell->ic.shape = object->shape;
    cell->ic.obj = prototype;
    cell->ic.key = desc->key_count > 0 ? mal_class_layout_key(vm, desc->keys[0]) : MAL_VALUE_UNDEFINED;
    MAL_PERF_COUNT(class_layout_admissions);
    return true;
}

void mal_vm_class_cells_init(MalVm *vm, const MalRuntimeImage *image) {
    vm->class_cells = nullptr;
    vm->class_cell_count = 0;
    if (image->class_layout_count <= 0) return;
    vm->class_cells = calloc((usize) image->class_layout_count, sizeof(MalClassLayoutCell));
    if (vm->class_cells == nullptr) abort();
    vm->class_cell_count = image->class_layout_count;
    for (i32 index = 0; index < image->class_layout_count; index++) {
        const MalClassLayoutDesc *desc = &image->class_layouts[index];
        MalClassLayoutCell *cell = &vm->class_cells[index];
        cell->desc = desc;
        if (desc->method_count > 0) {
            cell->methods = calloc((usize) desc->method_count, sizeof(MalValue));
            if (cell->methods == nullptr) abort();
        }
    }
}

void mal_vm_class_cells_free(MalVm *vm) {
    if (vm->class_cells == nullptr) return;
    for (i32 index = 0; index < vm->class_cell_count; index++) {
        mal_object_unregister_prototype_cache(&vm->class_cells[index].ic);
        free(vm->class_cells[index].methods);
    }
    free(vm->class_cells);
    vm->class_cells = nullptr;
    vm->class_cell_count = 0;
}
