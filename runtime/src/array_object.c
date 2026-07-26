#include "array_object.h"

#include <stdlib.h>

#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"
#include "perf_stats.h"

// Largest gap (new index minus the current dense_count) the dense vector will span
// with holes. A store beyond this is treated as sparse: the array deoptimizes to
// table storage rather than allocate a mostly-hole vector.
#define MAL_ARRAY_DENSE_MAX_GAP 1024u

void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype) {
    mal_object_init(heap, &array->object, MAL_HEAP_ARRAY_OBJECT, prototype);
    array->length = 0;
    array->length_writable = true;
    array->elements = nullptr;
    array->capacity = 0;
    array->dense_count = 0;
    array->dense_deopted = false;
}

bool mal_array_object_is_dense(const MalArrayObject *array) {
    return array->elements != nullptr;
}

bool mal_array_object_dense_get(const MalArrayObject *array, u32 index, MalValue *out) {
    if (array->elements == nullptr || index >= array->dense_count) {
        return false;
    }
    MalValue value = array->elements[index];
    if (mal_value_is_array_hole(value)) {
        return false;
    }
    *out = value;
    return true;
}

bool mal_array_object_dense_has(const MalArrayObject *array, u32 index) {
    MalValue ignored;
    return mal_array_object_dense_get(array, index, &ignored);
}

bool mal_array_object_dense_reserve_exact(MalArrayObject *array, u32 needed) {
    if (needed <= array->capacity) {
        return true;
    }
    if ((usize) needed > SIZE_MAX / sizeof(MalValue)) {
        return false;
    }
    // Route the dense vector through the RAW space so its bytes count toward the
    // GC trigger (element-heavy workloads used to under-trigger) and so an empty
    // RAW block returns to the OS. gc_realloc_raw grows by alloc-new / copy /
    // free-old (RAW has no in-place grow); no safepoint runs inside it, so the
    // detached old buffer is never observed by the collector.
    MalValue *grown = gc_realloc_raw(
        mal_gc_current_heap(), array->elements, sizeof(MalValue) * (usize) needed);
    if (grown == nullptr) {
        return false;
    }
    array->elements = grown;
    array->capacity = needed;
    return true;
}

/** Ensure `elements` has room for at least `needed` slots (geometric growth). */
bool mal_array_object_dense_reserve(MalArrayObject *array, u32 needed) {
    if (needed <= array->capacity) {
        return true;
    }
    u32 capacity = array->capacity == 0 ? 4 : array->capacity;
    while (capacity < needed) {
        capacity *= 2;
    }
    return mal_array_object_dense_reserve_exact(array, capacity);
}

bool mal_array_object_fresh_dense_reserve_exact(MalArrayObject *array, u32 needed) {
    if (array->dense_deopted || !array->object.extensible || !array->length_writable ||
        array->length != 0 || array->dense_count != 0 || array->capacity != 0 ||
        array->elements != nullptr) {
        return false;
    }
    if (needed == 0) {
        return true;
    }
    if (!mal_array_object_dense_reserve_exact(array, needed)) {
        return false;
    }

    MAL_PERF_COUNT(array_fresh_dense_exact_reserves);
    MAL_PERF_ADD(array_fresh_dense_reserved_slots, needed);
#if MAL_PERF_STATS
    u64 geometric_capacity = 0;
    u64 geometric_growths = 0;
    if (mal_perf_stats_enabled) {
        while (geometric_capacity < needed) {
            geometric_capacity = geometric_capacity == 0 ? 4 : geometric_capacity * 2;
            geometric_growths++;
        }
    }
    MAL_PERF_ADD(array_fresh_dense_growths_avoided, geometric_growths);
#endif
    return true;
}

bool mal_array_object_fresh_dense_append(MalArrayObject *array, MalValue value) {
    u32 index = array->dense_count;
    if (array->dense_deopted || !array->object.extensible || !array->length_writable ||
        array->length != index) {
        MAL_PERF_COUNT(array_fresh_dense_fallbacks);
        return false;
    }

    bool grows = index == array->capacity;
    if (!mal_array_object_dense_reserve(array, index + 1)) {
        MAL_PERF_COUNT(array_fresh_dense_fallbacks);
        return false;
    }
    if (grows) {
        MAL_PERF_COUNT(array_fresh_dense_growths);
    }

    // This slot was outside the traced [0, dense_count) region, so no SATB deletion
    // barrier is needed. Publish the value before extending that traced region.
    array->elements[index] = value;
    array->dense_count = index + 1;
    array->length = index + 1;
    mal_gc_card(&array->object.header, value); // old array -> young element
    MAL_PERF_COUNT(array_fresh_dense_stores);
    return true;
}

MalArrayDenseStore mal_array_object_dense_store(MalArrayObject *array, u32 index, MalValue value) {
    // Overwrite within the existing dense region (shade the replaced reference).
    if (array->elements != nullptr && index < array->dense_count) {
        mal_gc_write_barrier(array->elements[index]);
        array->elements[index] = value;
        mal_gc_card(&array->object.header, value); // old array -> young element
        return MAL_ARRAY_DENSE_APPLIED;
    }

    // Extending (or lazily creating) the vector: reject a gap large enough that the
    // hole fill would waste memory — the caller deoptimizes to table storage.
    if (index >= array->dense_count + MAL_ARRAY_DENSE_MAX_GAP) {
        return MAL_ARRAY_DENSE_NEEDS_TABLE;
    }
    if (!mal_array_object_dense_reserve(array, index + 1)) {
        return MAL_ARRAY_DENSE_NEEDS_TABLE;
    }
    // Fill the gap [dense_count, index) with holes, then place the value.
    for (u32 i = array->dense_count; i < index; i++) {
        array->elements[i] = mal_value_new_array_hole();
    }
    array->elements[index] = value;
    array->dense_count = index + 1;
    mal_gc_card(&array->object.header, value); // old array -> young element
    return MAL_ARRAY_DENSE_APPLIED;
}

void mal_array_object_dense_delete(MalArrayObject *array, u32 index) {
    if (array->elements == nullptr || index >= array->dense_count) {
        return;
    }
    mal_gc_write_barrier(array->elements[index]);
    array->elements[index] = mal_value_new_array_hole();
}

MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype) {
    MalArrayObject *array = mal_heap_alloc(heap, sizeof(MalArrayObject), MAL_HEAP_ARRAY_OBJECT);
    mal_array_object_init(heap, array, prototype);

    return array;
}

u32 mal_array_object_length(const MalArrayObject *array) {
    return array->length;
}

/**
 * Spec ArraySetLength deletion: drop own index elements at or past
 * new_length, highest first, stopping at the first non-configurable one.
 * Returns the length actually achieved (one past a blocking element, or
 * new_length when all deletions succeeded).
 */
static u32 mal_array_object_shrink(MalArrayObject *array, u32 new_length) {
    MalTable *properties = mal_object_properties(&array->object);

    // Collect the index keys at or past new_length.
    u32 *indices = nullptr;
    usize count = 0;
    usize capacity = 0;

    MalTableIter iter;
    mal_table_iter_init(&iter, properties, MAL_TABLE_ITER_STORAGE);

    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        if (key.kind != MAL_KEY_INDEX) {
            continue;
        }

        u32 index = mal_key_index_value(key);
        if (index >= new_length) {
            if (count == capacity) {
                capacity = capacity == 0 ? 8 : capacity * 2;
                indices = realloc(indices, sizeof(u32) * capacity);
            }
            indices[count++] = index;
        }
    }

    // Descending order so a non-configurable element fixes the final length.
    for (usize i = 0; i < count; i++) {
        for (usize j = i + 1; j < count; j++) {
            if (indices[j] > indices[i]) {
                u32 tmp = indices[i];
                indices[i] = indices[j];
                indices[j] = tmp;
            }
        }
    }

    u32 achieved = new_length;
    for (usize i = 0; i < count; i++) {
        MalKey index_key = mal_key_index(indices[i]);
        if (!mal_object_delete_own(&array->object, index_key)) {
            achieved = indices[i] + 1;
            break;
        }
    }

    free(indices);
    return achieved;
}

void mal_array_object_set_length(MalArrayObject *array, u32 length) {
    if (length < array->length) {
        // Table sparse indices (only present on deopted arrays) may block the shrink
        // at a non-configurable element; dense elements are always configurable, so
        // they never block — just truncate the dense region to the achieved length.
        length = mal_array_object_shrink(array, length);
        if (array->elements != nullptr && array->dense_count > length) {
            // SATB: shrinking dense_count drops elements [length, dense_count) from
            // the traced region (trace walks only [0, dense_count)); shade each
            // dropped reference. Folds out off-cycle.
            for (u32 i = length; i < array->dense_count; i++) {
                mal_gc_write_barrier(array->elements[i]);
            }
            array->dense_count = length;
        }
    }

    array->length = length;
}

bool mal_array_key_is_length(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    const c16 *code_units = mal_string_code_units(string);
    return mal_string_length(string) == 6 &&
        code_units[0] == 'l' &&
        code_units[1] == 'e' &&
        code_units[2] == 'n' &&
        code_units[3] == 'g' &&
        code_units[4] == 't' &&
        code_units[5] == 'h';
}

/**
 * "length" and ordinary-key tail shared by the index-define store and the index
 * [[Set]] variant. Only the integer-index branch differs between them.
 */
static bool mal_array_object_store_tail(MalArrayObject *array, MalKey key, MalValue value) {
    if (mal_array_key_is_length(key)) {
        // Accept an int32 or an f64 that is a valid array length (some callers
        // pass 𝔽(len) as a double); other numbers are left for [[Set]] to ignore.
        f64 number = mal_value_is_int32(value)
            ? (f64) mal_value_to_i32(value)
            : (mal_value_is_f64(value) ? mal_value_to_f64(value) : -1.0);
        if (number >= 0 && (f64) (u32) number == number) {
            u32 new_length = (u32) number;
            // This is the array [[Set]] path (arrays don't override [[Set]], so a
            // write delegates here). OrdinarySetWithOwnDescriptor rejects any write
            // to a non-writable data property regardless of whether the new value
            // equals the current one, so `Set(frozenArray, "length", len)` fails and
            // the caller throws (e.g. `Object.freeze([]).push()` must throw).
            if (!array->length_writable) {
                return false;
            }
            mal_array_object_set_length(array, new_length);
            // ArraySetLength returns false when a non-configurable element blocks
            // the shrink (set_length then leaves length at that element + 1).
            return array->length == new_length;
        }
        return true;
    }

    return mal_object_set(&array->object, key, value);
}

bool mal_array_object_store(MalArrayObject *array, MalKey key, MalValue value) {
    if (key.kind == MAL_KEY_INDEX) {
        u32 index = mal_key_index_value(key);
        bool grows = index >= array->length;
        // Growing an index past length also writes length, which is refused when
        // length is non-writable.
        if (grows && !array->length_writable) {
            return false;
        }
        // CreateDataProperty, NOT [[Set]]: this is the internal result-array
        // populator (CreateArrayFromList and friends — Object.keys, spread,
        // Array.from, regexp match arrays, ...). It must define an own element and
        // ignore the prototype chain, so a poisoned inherited index on
        // Array.prototype (a non-writable data or accessor "0") cannot intercept
        // the write. A default-data define at an integer index still takes the
        // dense fast path, so nothing here costs the common case. The element is
        // defined FIRST and the length grow committed only on success: a
        // non-extensible array rejects a fresh index and must not bump length
        // (ArrayDefineOwnProperty 10.4.2.1 steps 3-4).
        MalPropertyDesc desc = {
            .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
            .value = value,
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
        if (mal_object_define_own(&array->object, key, &desc) != MAL_DEFINE_OWN_APPLIED) {
            return false;
        }
        if (grows) {
            array->length = index + 1;
        }
        return true;
    }

    return mal_array_object_store_tail(array, key, value);
}

bool mal_array_object_set(MalArrayObject *array, MalKey key, MalValue value) {
    if (key.kind == MAL_KEY_INDEX) {
        u32 index = mal_key_index_value(key);
        bool grows = index >= array->length;
        if (grows && !array->length_writable) {
            return false;
        }
        // Genuine [[Set]]: OrdinarySet walks the prototype chain, so an inherited
        // non-writable data property or a getter-only accessor at this index
        // rejects the write (e.g. `Array.prototype.push` onto an array that
        // inherits a frozen index must throw). Store first, commit length only on
        // success (ArrayDefineOwnProperty 10.4.2.1 steps 3-4).
        if (!mal_object_set(&array->object, key, value)) {
            return false;
        }
        if (grows) {
            array->length = index + 1;
        }
        return true;
    }

    return mal_array_object_store_tail(array, key, value);
}
