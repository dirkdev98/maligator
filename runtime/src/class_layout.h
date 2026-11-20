#pragma once

#include "./defaults.h"
#include "object.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Compiled class-member sites guard on a shared per-class cell instead of a
 * per-site inline cache. A cell admits one receiver shape whose leading slots
 * hold the layout's keys as writable data, and one prototype through which every
 * layout method resolves to its expected function. A field site then needs only
 * the shape compare; a method site also compares the prototype. Any change to
 * an object on that prototype chain zeroes `ic`, which closes both guards.
 *
 * Cells admit only `MAL_HEAP_OBJECT` receivers, but shapes are shared by every
 * object family: a String wrapper, arguments object or Map reaches the same
 * shapes, the empty root included, and may own virtual properties (`length`,
 * indices) outside them. So a guard must establish the heap type, not just the
 * shape and prototype. It does so without loading the type for compact receivers:
 * only ordinary-object allocators create compact storage under the object value
 * tag (Arrays and functions carry their own tags), exotic cells start embedded or
 * deferred, and storage only ever moves to external. An object-tagged compact
 * cell is therefore a `MAL_HEAP_OBJECT`, and other storage kinds read the type.
 */
typedef struct MalClassLayoutCell {
    /** `shape` and `obj` (the prototype) of the admitted receiver; zeroed by invalidation. */
    MalInlineCache ic;
    const MalClassLayoutDesc *desc;
    /** The resolved method values, parallel to `desc->methods`. */
    MalValue *methods;
    /** Receivers offered while unadmitted, and those among them that failed validation. */
    u32 probes;
    u32 attempts;
} MalClassLayoutCell;

/** Failed validations after which a cell stops admitting receivers. */
#define MAL_CLASS_CELL_ATTEMPTS 64u
/** Misses a never-admitted cell inspects before it stops costing every miss a call. */
#define MAL_CLASS_CELL_PROBES 65536u

/** The receiver of a class-member site, or null unless it carries the object value tag. */
static inline __attribute__((always_inline)) MalObject *mal_class_receiver(MalValue value) {
    if ((value & MAL_VALUE_CLASS_MASK) != MAL_VALUE_OBJECT) return nullptr;
    MalObject *object = (MalObject *) mal_value_to_heap(value);
    // Lets a guard's null test fold into the tag compare.
    __builtin_assume(object != nullptr);
    return object;
}

/** Whether an object-tagged receiver is a `MAL_HEAP_OBJECT`; compact storage proves it. */
static inline __attribute__((always_inline)) bool mal_class_receiver_is_ordinary(
    const MalObject *object
) {
    return __builtin_expect(object->storage_kind == MAL_OBJECT_COMPACT, 1) ||
        object->header.type == MAL_HEAP_OBJECT;
}

static inline __attribute__((always_inline)) bool mal_class_cell_matches_shape(
    const MalClassLayoutCell *cell, const MalObject *object
) {
    return object->shape == cell->ic.shape && mal_class_receiver_is_ordinary(object);
}

/** A method site also needs the prototype and no own name outside the shape. */
static inline __attribute__((always_inline)) bool mal_class_cell_matches(
    const MalClassLayoutCell *cell, const MalObject *object
) {
    return mal_class_cell_matches_shape(cell, object) &&
        !mal_object_has_public_overflow(object) &&
        mal_object_prototype(object) == cell->ic.obj;
}

static inline __attribute__((always_inline)) bool mal_class_cell_learnable(
    const MalClassLayoutCell *cell
) {
    return cell->ic.shape == nullptr && cell->attempts < MAL_CLASS_CELL_ATTEMPTS &&
        cell->probes < MAL_CLASS_CELL_PROBES;
}

// Generated class-member sites; `vm` is the enclosing compiled function's VM and
// `o` is the site's `mal_class_receiver`.
#if MAL_PERF_STATS
#define MAL_CLASS_COUNT(field) (mal_perf_stats_enabled ? (void) mal_perf_stats.field++ : (void) 0)
#else
#define MAL_CLASS_COUNT(field) ((void) 0)
#endif
#define MAL_CLASS_SLOT(o, l) \
    ((o) != nullptr && mal_class_cell_matches_shape(&vm->class_cells[l], (o)) && \
     (MAL_CLASS_COUNT(class_layout_slot_hits), true))
#define MAL_CLASS_METHOD(o, l) \
    ((o) != nullptr && mal_class_cell_matches(&vm->class_cells[l], (o)) && \
     (MAL_CLASS_COUNT(class_layout_method_hits), true))
// Only ordinary objects can be admitted, so other receivers must not spend probes.
#define MAL_CLASS_LEARN(o, v, l) \
    ((o) != nullptr && __builtin_expect(mal_class_cell_learnable(&vm->class_cells[l]), 0) && \
     (o)->header.type == MAL_HEAP_OBJECT \
         ? (void) mal_vm_class_cell_learn(vm, &vm->class_cells[l], (v)) : (void) 0)
#define MAL_CLASS_MISS(o, v, l) (MAL_CLASS_COUNT(class_layout_misses), MAL_CLASS_LEARN(o, v, l))

/** Admit `receiver`'s layout into the cell when it matches; never runs user code. */
bool mal_vm_class_cell_learn(MalVm *vm, MalClassLayoutCell *cell, MalValue receiver);

void mal_vm_class_cells_init(MalVm *vm, const MalRuntimeImage *image);
void mal_vm_class_cells_free(MalVm *vm);
