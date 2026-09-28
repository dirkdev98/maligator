#include "builtin_json.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_array.h"
#include "checked_size.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"
#include "perf_stats.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "rooted_collection.h"
#include "shape.h"
#include "text_buffer.h"
#include "utf16.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

typedef struct MalJsonBuilder {
    MalVm *vm;
    MalTextBuffer buffer;
} MalJsonBuilder;

static bool mal_json_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static bool mal_json_builder_reserve(MalJsonBuilder *builder, usize extra) {
    return mal_text_buffer_reserve(&builder->buffer, extra) == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push(MalJsonBuilder *builder, c16 code_unit) {
    return mal_text_buffer_push(&builder->buffer, code_unit) == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_ascii(MalJsonBuilder *builder, const byte *text) {
    return mal_text_buffer_append_ascii(&builder->buffer, text) == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_units(
    MalJsonBuilder *builder, const c16 *code_units, usize length
) {
    return mal_text_buffer_append_units(
        &builder->buffer, code_units, length) == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_string(MalJsonBuilder *builder, const MalString *string) {
    return mal_text_buffer_append_string(
        &builder->buffer, string) == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_segment(
    MalJsonBuilder *builder, const MalStringSegment *segment,
    usize offset, usize length
) {
    MalTextBufferStatus status = segment->latin1
        ? mal_text_buffer_append_latin1(
            &builder->buffer, segment->latin1_units + offset, length)
        : mal_text_buffer_append_units(
            &builder->buffer, segment->utf16_units + offset, length);
    return status == MAL_TEXT_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_unicode_escape(
    MalJsonBuilder *builder, c16 code_unit
) {
    static const byte hex_digits[] = "0123456789abcdef";
    byte escaped[7] = {
        '\\', 'u', hex_digits[code_unit >> 12],
        hex_digits[(code_unit >> 8) & 0xf],
        hex_digits[(code_unit >> 4) & 0xf], hex_digits[code_unit & 0xf], 0,
    };
    return mal_json_builder_push_ascii(builder, escaped);
}

static bool mal_json_word_has_zero(u64 word) {
    return ((word - UINT64_C(0x0101010101010101)) & ~word &
        UINT64_C(0x8080808080808080)) != 0;
}

static usize mal_json_latin1_safe_run(const u8 *units, usize length) {
    usize position = 0;
    while (length - position >= sizeof(u64)) {
        u64 word;
        memcpy(&word, units + position, sizeof(word));
        bool control = ((word - UINT64_C(0x2020202020202020)) & ~word &
            UINT64_C(0x8080808080808080)) != 0;
        if (control ||
            mal_json_word_has_zero(word ^ UINT64_C(0x2222222222222222)) ||
            mal_json_word_has_zero(word ^ UINT64_C(0x5c5c5c5c5c5c5c5c))) {
            break;
        }
        position += sizeof(word);
    }
    while (position < length && units[position] >= 0x20 &&
        units[position] != '"' && units[position] != '\\') {
        position++;
    }
    return position;
}

static bool mal_json_halfword_has_zero(u64 word) {
    return ((word - UINT64_C(0x0001000100010001)) & ~word &
        UINT64_C(0x8000800080008000)) != 0;
}

static usize mal_json_utf16_unescaped_run(const c16 *units, usize length) {
    usize position = 0;
    while (length - position >= sizeof(u64) / sizeof(c16)) {
        u64 word;
        memcpy(&word, units + position, sizeof(word));
        bool control = ((word - UINT64_C(0x0020002000200020)) & ~word &
            UINT64_C(0x8000800080008000)) != 0;
        if (control ||
            mal_json_halfword_has_zero(word ^ UINT64_C(0x0022002200220022)) ||
            mal_json_halfword_has_zero(word ^ UINT64_C(0x005c005c005c005c))) break;
        position += sizeof(u64) / sizeof(c16);
    }
    while (position < length && units[position] >= 0x20 &&
        units[position] != '"' && units[position] != '\\') {
        position++;
    }
    return position;
}

static usize mal_json_utf16_safe_run(const c16 *units, usize length) {
    usize position = 0;
    // Short and escape-heavy runs stay scalar. Long ordinary runs inspect four
    // code units at once, stopping before any surrogate needs pair handling.
    while (position < length && position < 4) {
        MAL_PERF_COUNT(json_quote_utf16_scalar_probes);
        c16 unit = units[position];
        if (unit < 0x20 || unit == '"' || unit == '\\' ||
            mal_utf16_is_surrogate(unit)) return position;
        position++;
    }
    while (length - position >= sizeof(u64) / sizeof(c16)) {
        u64 word;
        memcpy(&word, units + position, sizeof(word));
        MAL_PERF_COUNT(string_unit_scan_word_blocks);
        bool control = ((word - UINT64_C(0x0020002000200020)) & ~word &
            UINT64_C(0x8000800080008000)) != 0;
        if (control ||
            mal_json_halfword_has_zero(word ^ UINT64_C(0x0022002200220022)) ||
            mal_json_halfword_has_zero(word ^ UINT64_C(0x005c005c005c005c)) ||
            mal_json_halfword_has_zero(
                (word & UINT64_C(0xf800f800f800f800)) ^
                UINT64_C(0xd800d800d800d800))) break;
        position += sizeof(u64) / sizeof(c16);
    }
    while (position < length) {
        MAL_PERF_COUNT(json_quote_utf16_scalar_probes);
        c16 unit = units[position];
        if (unit < 0x20 || unit == '"' || unit == '\\' ||
            mal_utf16_is_surrogate(unit)) break;
        position++;
    }
    return position;
}

static bool mal_json_builder_push_quoted(MalJsonBuilder *builder, const MalString *string) {
    if (!mal_json_builder_push(builder, '"')) return false;
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    c16 pending_high = 0;
    bool ok = true;
    while (ok && mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1) MAL_PERF_ADD(json_quote_latin1_code_units, segment.length);
        else MAL_PERF_ADD(json_quote_utf16_code_units, segment.length);
        usize position = 0;
        if (pending_high != 0) {
            c16 first = mal_string_segment_code_unit_at(&segment, 0);
            if (first >= 0xdc00 && first <= 0xdfff) {
                c16 pair[2] = {pending_high, first};
                ok = mal_json_builder_push_units(builder, pair, 2);
                position++;
            } else {
                ok = mal_json_builder_push_unicode_escape(builder, pending_high);
            }
            pending_high = 0;
        }
        while (ok && position < segment.length) {
            usize run = position;
            if (segment.latin1) {
                position += mal_json_latin1_safe_run(
                    segment.latin1_units + position, segment.length - position);
            } else {
                position += mal_json_utf16_safe_run(
                    segment.utf16_units + position, segment.length - position);
            }
            if (position > run && !mal_json_builder_push_segment(
                    builder, &segment, run, position - run)) {
                ok = false;
                break;
            }
            if (position == segment.length) break;
            c16 unit = mal_string_segment_code_unit_at(&segment, position++);
            switch (unit) {
                case '"': ok = mal_json_builder_push_ascii(builder, "\\\""); break;
                case '\\': ok = mal_json_builder_push_ascii(builder, "\\\\"); break;
                case '\b': ok = mal_json_builder_push_ascii(builder, "\\b"); break;
                case '\f': ok = mal_json_builder_push_ascii(builder, "\\f"); break;
                case '\n': ok = mal_json_builder_push_ascii(builder, "\\n"); break;
                case '\r': ok = mal_json_builder_push_ascii(builder, "\\r"); break;
                case '\t': ok = mal_json_builder_push_ascii(builder, "\\t"); break;
                default:
                    if (unit >= 0xd800 && unit <= 0xdbff) {
                        if (position == segment.length) {
                            // The matching low surrogate may be in the next leaf.
                            pending_high = unit;
                            break;
                        }
                        c16 next = mal_string_segment_code_unit_at(&segment, position);
                        if (next >= 0xdc00 && next <= 0xdfff) {
                            c16 pair[2] = {unit, next};
                            ok = mal_json_builder_push_units(builder, pair, 2);
                            position++;
                            break;
                        }
                    }
                    ok = mal_json_builder_push_unicode_escape(builder, unit);
                    break;
            }
        }
    }
    mal_string_iterator_dispose(&iterator);
    if (ok && pending_high != 0) {
        ok = mal_json_builder_push_unicode_escape(builder, pending_high);
    }
    return ok && mal_json_builder_push(builder, '"');
}

typedef struct MalJsonPointerEntry {
    const void *key;
    void *value;
} MalJsonPointerEntry;

typedef struct MalJsonPointerMap {
    MalJsonPointerEntry *entries;
    usize capacity;
    usize count;
    usize used;
} MalJsonPointerMap;

static usize mal_json_pointer_hash(const void *pointer) {
    u64 bits = (u64) (uintptr_t) pointer;
    bits ^= bits >> 33;
    bits *= UINT64_C(0xff51afd7ed558ccd);
    bits ^= bits >> 33;
    return (usize) bits;
}

static MalJsonPointerEntry *mal_json_pointer_find(
    MalJsonPointerMap *map, const void *key
) {
    if (map->capacity == 0) return nullptr;
    usize slot = mal_json_pointer_hash(key) & (map->capacity - 1);
    while (map->entries[slot].key != nullptr) {
        if (map->entries[slot].key == key) return &map->entries[slot];
        slot = (slot + 1) & (map->capacity - 1);
    }
    return nullptr;
}

static void mal_json_pointer_insert(
    MalJsonPointerMap *map, const void *key, void *value
) {
    if (map->used >= map->capacity - map->capacity / 4) {
        usize capacity = map->capacity == 0 ? 16 : map->capacity;
        if (map->count >= capacity / 2) {
            if (capacity > SIZE_MAX / 2) abort();
            capacity *= 2;
        }
        if (capacity > SIZE_MAX / sizeof(MalJsonPointerEntry)) abort();
        MalJsonPointerEntry *entries = calloc(capacity, sizeof(*entries));
        if (entries == nullptr) abort();
        for (usize i = 0; i < map->capacity; i++) {
            MalJsonPointerEntry entry = map->entries[i];
            if (entry.key == nullptr) continue;
            usize slot = mal_json_pointer_hash(entry.key) & (capacity - 1);
            while (entries[slot].key != nullptr) slot = (slot + 1) & (capacity - 1);
            entries[slot] = entry;
        }
        free(map->entries);
        map->entries = entries;
        map->capacity = capacity;
        map->used = map->count;
    }
    usize slot = mal_json_pointer_hash(key) & (map->capacity - 1);
    while (map->entries[slot].key != nullptr) {
        if (map->entries[slot].key == key) {
            map->entries[slot].value = value;
            return;
        }
        slot = (slot + 1) & (map->capacity - 1);
    }
    if (map->entries[slot].key == nullptr) map->used++;
    map->entries[slot] = (MalJsonPointerEntry) {.key = key, .value = value};
    map->count++;
}

static void mal_json_pointer_remove(MalJsonPointerMap *map, const void *key) {
    MalJsonPointerEntry *entry = mal_json_pointer_find(map, key);
    if (entry == nullptr) return;
    usize mask = map->capacity - 1;
    usize hole = (usize) (entry - map->entries);
    usize next = (hole + 1) & mask;
    while (map->entries[next].key != nullptr) {
        usize home = mal_json_pointer_hash(map->entries[next].key) & mask;
        if (((next - home) & mask) >= ((next - hole) & mask)) {
            map->entries[hole] = map->entries[next];
            hole = next;
        }
        next = (next + 1) & mask;
    }
    map->entries[hole] = (MalJsonPointerEntry) {0};
    map->count--;
    map->used--;
}

typedef struct MalJsonState {
    MalVm *vm;
    MalValue replacer_fn;
    bool has_property_list;
    MalRootedValueList property_list;
    const c16 *gap;
    usize gap_length;
    MalJsonPointerMap active;
} MalJsonState;

// Result of attempting to serialize a property: omitted (no output), written, or
// an abrupt throw (vm->completion holds the error).
typedef enum MalJsonResult {
    MAL_JSON_OMITTED,
    MAL_JSON_WROTE,
    MAL_JSON_THROW,
} MalJsonResult;

// Every JS Number value: tagged int32/f64 plus the static ±0, NaN, ±Infinity.
static bool mal_json_is_number(MalValue value) {
    return mal_value_is_int32(value) || mal_value_is_f64(value) ||
        value == MAL_VALUE_NEGATIVE_ZERO || mal_value_is_nan(value) ||
        value == MAL_VALUE_POSITIVE_INFINITY || value == MAL_VALUE_NEGATIVE_INFINITY;
}

static MalJsonResult mal_json_serialize_property(MalJsonState *state, MalJsonBuilder *builder, MalKey get_key, MalValue key_string, MalValue holder, usize depth);
static MalJsonResult mal_json_serialize_value(MalJsonState *state, MalJsonBuilder *builder, MalKey get_key, MalValue key_string, MalValue holder, MalValue value, usize depth);

static MalJsonResult mal_json_serialize_member(
    MalJsonState *state, MalJsonBuilder *builder, MalKey get_key,
    MalValue key_string, MalValue holder, bool has_value, MalValue value,
    usize depth, bool any);

/** Push "\n" followed by `depth` copies of the gap, when the gap is non-empty. */
static bool mal_json_push_indent(MalJsonState *state, MalJsonBuilder *builder, usize depth) {
    if (state->gap_length == 0) {
        return true;
    }
    usize gap_units;
    usize extra;
    if (!mal_checked_size_multiply(
            depth, state->gap_length, MAL_STRING_MAX_CODE_UNITS, &gap_units) ||
        !mal_checked_size_add(gap_units, 1, MAL_STRING_MAX_CODE_UNITS, &extra)) {
        return mal_json_throw_string_length(state->vm);
    }
    if (!mal_json_builder_reserve(builder, extra)) {
        return false;
    }
    if (!mal_json_builder_push(builder, '\n')) return false;
    for (usize i = 0; i < depth; i++) {
        if (!mal_json_builder_push_units(builder, state->gap, state->gap_length)) {
            return false;
        }
    }
    return true;
}

// The generic paths retain native frames across observable callbacks. Bound them
// independently of output size; plain serialization already uses heap frames.
#define MAL_JSON_MAX_RECURSION_DEPTH ((usize) 512)

static bool mal_json_throw_depth(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
        "JSON nesting exceeds the maximum depth");
    return false;
}

static inline bool mal_json_check_depth(MalVm *vm, usize depth) {
    // Fibers have smaller stacks, and sanitizer frames can be much larger.
    // Share the VM's reserved stack margin; the count also covers unknown bounds.
    if (depth >= MAL_JSON_MAX_RECURSION_DEPTH ||
        (vm->stack_limit != 0 &&
            (uptr) __builtin_frame_address(0) < vm->stack_limit)) {
        return mal_json_throw_depth(vm);
    }
    return true;
}

static bool mal_json_stack_push(MalJsonState *state, MalValue value) {
    MalObject *object = mal_value_to_object(value);
    if (mal_json_pointer_find(&state->active, object) != nullptr) {
        mal_vm_throw_error(state->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Converting circular structure to JSON");
        return false;
    }
    if (!mal_json_check_depth(state->vm, state->active.count)) return false;
    // The serializing frame roots every active object across callback reentry.
    mal_json_pointer_insert(&state->active, object, nullptr);
    return true;
}

/** SerializeJSONArray. */
static MalJsonResult mal_json_serialize_array(MalJsonState *state, MalJsonBuilder *builder, MalValue value, usize depth) {
    MalVm *vm = state->vm;
    if (!mal_json_stack_push(state, value)) {
        return MAL_JSON_THROW;
    }

    u32 length;
    if (!mal_builtin_array_this_length(vm, value, &length)) {
        return MAL_JSON_THROW;
    }

    if (!mal_json_builder_push(builder, '[')) {
        return MAL_JSON_THROW;
    }
    for (u32 index = 0; index < length; index++) {
        if (index > 0 && !mal_json_builder_push(builder, ',')) {
            return MAL_JSON_THROW;
        }
        if (!mal_json_push_indent(state, builder, depth + 1)) {
            return MAL_JSON_THROW;
        }

        MalKey get_key = mal_key_index(index);
        MalJsonResult result = mal_json_serialize_property(
            state, builder, get_key, mal_value_new_undefined(), value,
            depth + 1);
        if (result == MAL_JSON_THROW) {
            return MAL_JSON_THROW;
        }
        if (result == MAL_JSON_OMITTED) {
            // undefined / function / symbol elements serialize as null.
            if (!mal_json_builder_push_ascii(builder, "null")) {
                return MAL_JSON_THROW;
            }
        }
    }
    if (length > 0 && !mal_json_push_indent(state, builder, depth)) {
        return MAL_JSON_THROW;
    }
    if (!mal_json_builder_push(builder, ']')) {
        return MAL_JSON_THROW;
    }

    mal_json_pointer_remove(&state->active, mal_value_to_object(value));
    return MAL_JSON_WROTE;
}

/** SerializeJSONObject. */
static MalJsonResult mal_json_serialize_object(MalJsonState *state, MalJsonBuilder *builder, MalValue value, usize depth) {
    MalVm *vm = state->vm;
    if (!mal_json_stack_push(state, value)) {
        return MAL_JSON_THROW;
    }

    if (!mal_json_builder_push(builder, '{')) {
        return MAL_JSON_THROW;
    }
    bool any = false;

    bool ok = true;
    if (state->has_property_list) {
        for (usize i = 0; i < state->property_list.count && ok; i++) {
            MalValue key = state->property_list.values[i];
            // Canonicalize so a numeric key string ("0") resolves to the holder's
            // integer-indexed property rather than a missing string key.
            MalKey get_key;
            mal_vm_to_property_query(vm, key, &get_key);
            MalJsonResult result = mal_json_serialize_member(
                state, builder, get_key, key, value, false,
                mal_value_new_undefined(), depth + 1, any);
            if (result == MAL_JSON_THROW) {
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) continue;
            any = true;
        }
    } else {
        // K is EnumerableOwnProperties(value, KEY): snapshot [[OwnPropertyKeys]],
        // then resolve every enumerable own String key via [[GetOwnProperty]]
        // BEFORE any Get. Filtering and serialization must not interleave: a
        // getter run while serializing an earlier key may delete or redefine a
        // later key, but that key is already fixed in K, so SerializeJSONProperty
        // still Gets it (undefined for a deleted property) and runs the replacer.
        // Deferring the enumerability check into the loop would instead drop the
        // deleted key and would reorder Proxy getOwnPropertyDescriptor traps after
        // get traps.
        MalObject *object = mal_value_to_object(value);
        const MalShape *shape_snapshot = nullptr;
        if (object->header.type == MAL_HEAP_OBJECT &&
            !mal_object_has_public_overflow(object) && object->shape != nullptr) {
            shape_snapshot = object->shape;
            for (u32 i = 0; i < shape_snapshot->inline_count; i++) {
                if (!mal_value_is_string(shape_snapshot->props[i].key)) {
                    shape_snapshot = nullptr;
                    break;
                }
            }
        }

        MalRootedKeySnapshot own_keys = {0};
        MalRootedKeySnapshot keys = {0};
        bool has_rooted_snapshots = shape_snapshot == nullptr;
        if (has_rooted_snapshots) {
            mal_rooted_key_snapshot_init(&own_keys);
            mal_rooted_key_snapshot_init(&keys);
        }

        if (shape_snapshot == nullptr && object->header.type == MAL_HEAP_OBJECT) {
            // A plain ordinary object exposes exactly its shape/table properties.
            // Snapshot their already-available descriptors directly; exotics and
            // proxies retain the full [[OwnPropertyKeys]]/[[GetOwnProperty]] path.
            MalPropertyIter iter;
            mal_property_iter_init(
                &iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
            MalKey key;
            MalPropertyDesc desc;
            while (mal_property_iter_next(&iter, &key, &desc)) {
                if (key.kind != MAL_KEY_SYMBOL &&
                    (desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                    mal_rooted_key_snapshot_append(&keys, key);
                }
            }
        } else if (shape_snapshot == nullptr) {
            ok = mal_rooted_key_snapshot_own_keys(vm, value, &own_keys);
            for (usize i = 0; ok && i < own_keys.count; i++) {
                if (own_keys.keys[i].kind == MAL_KEY_SYMBOL) {
                    continue;
                }
                bool present;
                MalPropertyDesc desc;
                if (!mal_vm_get_own_property(
                        vm, value, own_keys.keys[i], &present, &desc)) {
                    ok = false;
                    break;
                }
                if (present && (desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                    mal_rooted_key_snapshot_append(
                        &keys, own_keys.keys[i]);
                }
            }
        }
        usize key_count = shape_snapshot != nullptr
            ? shape_snapshot->inline_count
            : keys.count;
        for (usize i = 0; ok && i < key_count; i++) {
            MalKey key;
            MalValue key_string;
            if (shape_snapshot != nullptr) {
                const MalShapeProp *prop = &shape_snapshot->props[i];
                if ((prop->attrs & MAL_PROPERTY_ENUMERABLE) == 0) {
                    continue;
                }
                key = mal_key_from_value(prop->key);
                key_string = prop->key;
            } else {
                key = keys.keys[i];
                key_string = mal_value_from_string(
                    mal_ops_to_string(&vm->heap, key.value));
            }
            bool direct = shape_snapshot != nullptr &&
                object->shape == shape_snapshot &&
                !mal_object_has_public_overflow(object);
            MalJsonResult result = mal_json_serialize_member(
                state, builder, key, key_string, value, direct,
                direct ? object->slots[shape_snapshot->props[i].slot]
                    : mal_value_new_undefined(), depth + 1, any);
            if (result == MAL_JSON_THROW) {
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) continue;
            any = true;
        }
        if (has_rooted_snapshots) {
            // Root spans are stack-linked: unwind the snapshots in reverse order.
            mal_rooted_key_snapshot_dispose(&keys);
            mal_rooted_key_snapshot_dispose(&own_keys);
        }
    }

    if (!ok) {
        return MAL_JSON_THROW;
    }

    if (any && !mal_json_push_indent(state, builder, depth)) {
        return MAL_JSON_THROW;
    }
    if (!mal_json_builder_push(builder, '}')) {
        return MAL_JSON_THROW;
    }

    mal_json_pointer_remove(&state->active, mal_value_to_object(value));
    return MAL_JSON_WROTE;
}

/**
 * SerializeJSONProperty(state, key, holder): Get(holder, key), apply toJSON and
 * the replacer function, unwrap primitive wrappers, then serialize. Writes the
 * serialization into `builder`; returns OMITTED for values JSON drops entirely
 * (undefined, callables, symbols) and THROW on an abrupt completion.
 */
static MalJsonResult mal_json_serialize_property(MalJsonState *state, MalJsonBuilder *builder, MalKey get_key, MalValue key_string, MalValue holder, usize depth) {
    MalVm *vm = state->vm;

    MalValue value;
    if (!mal_vm_get_property(vm, holder, get_key, &value)) {
        return MAL_JSON_THROW;
    }

    return mal_json_serialize_value(
        state, builder, get_key, key_string, holder, value, depth);
}

static MalValue mal_json_materialize_key_string(
    MalVm *vm, MalKey get_key, MalValue key_string
) {
    if (!mal_value_is_undefined(key_string)) {
        return key_string;
    }
    return mal_value_from_string(mal_ops_to_string(
        &vm->heap, mal_value_from_u32(mal_key_index_value(get_key))));
}

static bool mal_json_prepare_value(
    MalJsonState *state, MalKey get_key, MalValue key_string,
    MalValue holder, MalValue *value
) {
    MalVm *vm = state->vm;
    if (mal_value_is_object(*value) || mal_value_is_bigint(*value)) {
        MalValue to_json;
        if (!mal_vm_get_property(vm, *value, mal_intrinsic_string_key(vm, "toJSON"), &to_json)) {
            return false;
        }
        if (mal_value_is_callable(to_json)) {
            key_string = mal_json_materialize_key_string(vm, get_key, key_string);
            MalCompletion completion = mal_vm_call_value(vm, to_json, *value, &key_string, 1);
            if (completion.kind == MAL_COMPLETION_THROW) return false;
            *value = completion.value;
        }
    }
    if (mal_value_is_callable(state->replacer_fn)) {
        key_string = mal_json_materialize_key_string(vm, get_key, key_string);
        MalValue replacer_args[2] = {key_string, *value};
        MalCompletion completion = mal_vm_call_value(
            vm, state->replacer_fn, holder, replacer_args, 2);
        if (completion.kind == MAL_COMPLETION_THROW) return false;
        *value = completion.value;
    }
    if (mal_value_is_primitive_wrapper(*value)) {
        MalPrimitiveWrapperKind kind = mal_value_to_primitive_wrapper(*value)->kind;
        if (kind == MAL_PRIMITIVE_WRAPPER_NUMBER) {
            f64 number;
            if (!mal_vm_to_number(vm, *value, &number)) return false;
            *value = mal_ops_number_value(number);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_STRING) {
            MalString *string;
            if (!mal_vm_to_string(vm, *value, &string)) return false;
            *value = mal_value_from_string(string);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_BOOLEAN || kind == MAL_PRIMITIVE_WRAPPER_BIGINT) {
            *value = mal_value_to_primitive_wrapper(*value)->primitive_data;
        }
    }
    return true;
}

static bool mal_json_value_is_omitted(MalValue value) {
    return !mal_value_is_null(value) && !mal_value_is_boolean(value) &&
        !mal_value_is_string(value) && !mal_json_is_number(value) &&
        !mal_value_is_bigint(value) &&
        (!mal_value_is_object(value) || mal_value_is_callable(value));
}

static MalJsonResult mal_json_serialize_prepared(
    MalJsonState *state, MalJsonBuilder *builder, MalValue value, usize depth
) {
    MalVm *vm = state->vm;
    // A JSON.rawJSON object is emitted verbatim from its "rawJSON" text.
    if (mal_value_is_object(value) && mal_value_to_object(value)->is_raw_json) {
        MalValue raw;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, "rawJSON"), &raw)) {
            return MAL_JSON_THROW;
        }
        return mal_json_builder_push_string(builder, mal_value_to_string(raw))
            ? MAL_JSON_WROTE : MAL_JSON_THROW;
    }

    if (mal_value_is_null(value)) {
        return mal_json_builder_push_ascii(builder, "null")
            ? MAL_JSON_WROTE : MAL_JSON_THROW;
    }
    if (mal_value_is_boolean(value)) {
        return mal_json_builder_push_ascii(
            builder, mal_value_to_boolean(value) ? "true" : "false")
            ? MAL_JSON_WROTE : MAL_JSON_THROW;
    }
    if (mal_value_is_string(value)) {
        return mal_json_builder_push_quoted(builder, mal_value_to_string(value))
            ? MAL_JSON_WROTE : MAL_JSON_THROW;
    }
    if (mal_value_is_bigint(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Do not know how to serialize a BigInt");
        return MAL_JSON_THROW;
    }
    if (mal_json_is_number(value)) {
        f64 number = mal_ops_to_number(value);
        if (isfinite(number)) {
            if (!mal_json_builder_push_string(builder, mal_ops_to_string(&vm->heap, value))) {
                return MAL_JSON_THROW;
            }
        } else {
            if (!mal_json_builder_push_ascii(builder, "null")) {
                return MAL_JSON_THROW;
            }
        }
        return MAL_JSON_WROTE;
    }
    if (mal_value_is_object(value) && !mal_value_is_callable(value)) {
        bool is_array;
        if (!mal_vm_is_array(vm, value, &is_array)) {
            return MAL_JSON_THROW;
        }
        return is_array
            ? mal_json_serialize_array(state, builder, value, depth)
            : mal_json_serialize_object(state, builder, value, depth);
    }

    // undefined, callables, and symbols have no JSON serialization.
    return MAL_JSON_OMITTED;
}

static MalJsonResult mal_json_serialize_value(
    MalJsonState *state, MalJsonBuilder *builder, MalKey get_key,
    MalValue key_string, MalValue holder, MalValue value, usize depth
) {
    MalValue roots[3] = {key_string, holder, value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalJsonResult result = mal_json_prepare_value(
        state, get_key, roots[0], roots[1], &roots[2])
        ? mal_json_serialize_prepared(state, builder, roots[2], depth)
        : MAL_JSON_THROW;
    mal_gc_unroot(&span);
    return result;
}

static MalJsonResult mal_json_serialize_member(
    MalJsonState *state, MalJsonBuilder *builder, MalKey get_key,
    MalValue key_string, MalValue holder, bool has_value, MalValue value,
    usize depth, bool any
) {
    MalValue roots[3] = {key_string, holder, value};
    MalRootSpan span;
    mal_gc_root(&span, roots, 3);
    MalJsonResult result = MAL_JSON_THROW;
    if ((!has_value && !mal_vm_get_property(state->vm, roots[1], get_key, &roots[2])) ||
        !mal_json_prepare_value(state, get_key, roots[0], roots[1], &roots[2])) {
        goto done;
    }
    // Transformations may omit a member. Resolve them before reserving its key,
    // so an omitted large key cannot consume output space or throw a length error.
    if (mal_json_value_is_omitted(roots[2])) {
        result = MAL_JSON_OMITTED;
        goto done;
    }
    usize checkpoint = builder->buffer.length;
    if (!((!any || mal_json_builder_push(builder, ',')) &&
        mal_json_push_indent(state, builder, depth) &&
        mal_json_builder_push_quoted(builder, mal_value_to_string(roots[0])) &&
        mal_json_builder_push(builder, ':') &&
        (state->gap_length == 0 || mal_json_builder_push(builder, ' ')))) {
        goto done;
    }
    result = mal_json_serialize_prepared(state, builder, roots[2], depth);
    if (result != MAL_JSON_WROTE) {
        mal_text_buffer_truncate(&builder->buffer, checkpoint);
    }
done:
    mal_gc_unroot(&span);
    return result;
}

/** Build the PropertyList allow-list from an array replacer (spec step 4.b.ii). */
static bool mal_json_build_property_list(MalJsonState *state, MalValue replacer) {
    MalVm *vm = state->vm;
    u32 length;
    if (!mal_builtin_array_this_length(vm, replacer, &length)) {
        return false;
    }

    state->has_property_list = true;

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_vm_get_property(vm, replacer, mal_key_index(index), &element)) {
            return false;
        }

        bool use_item = false;
        if (mal_value_is_string(element)) {
            use_item = true;
        } else if (mal_json_is_number(element)) {
            use_item = true;
        } else if (mal_value_is_primitive_wrapper(element)) {
            MalPrimitiveWrapperKind kind = mal_value_to_primitive_wrapper(element)->kind;
            use_item = kind == MAL_PRIMITIVE_WRAPPER_STRING || kind == MAL_PRIMITIVE_WRAPPER_NUMBER;
        }
        if (!use_item) {
            continue;
        }

        MalString *item_string;
        if (!mal_vm_to_string(vm, element, &item_string)) {
            return false;
        }
        MalValue item = mal_value_from_string(item_string);

        bool duplicate = false;
        for (usize i = 0; i < state->property_list.count; i++) {
            if (mal_string_equals(mal_value_to_string(state->property_list.values[i]), mal_value_to_string(item))) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            mal_rooted_value_list_append(&state->property_list, item);
        }
    }
    return true;
}

typedef struct MalJsonKeyPlan {
    u32 slot;
    MalString *key;
    usize offset;
    usize length;
} MalJsonKeyPlan;

typedef struct MalJsonShapePlan {
    MalJsonBuilder escaped_keys;
    usize count;
    MalJsonKeyPlan keys[];
} MalJsonShapePlan;

typedef struct MalJsonFrame {
    MalValue value;
    union {
        MalJsonShapePlan *plan;
        const MalShape *shape;
    };
    usize position;
    usize count;
    bool array;
    bool any;
    bool cached_plan;
} MalJsonFrame;

#define MAL_JSON_PLAN_DATA_BUDGET ((usize) 64 * 1024)
#define MAL_JSON_PLAN_ENTRY_LIMIT ((usize) 256)

typedef struct MalJsonPlainState {
    MalVm *vm;
    MalKey to_json;
    MalJsonPointerMap shapes;
    MalJsonPointerMap prototypes;
    MalJsonPointerMap active;
    MalJsonFrame *frames;
    usize count;
    usize capacity;
    usize cache_data_bytes;
    usize prototype_eviction_slot;
} MalJsonPlainState;

static bool mal_json_plain_prototype(MalJsonPlainState *state, MalObject *prototype) {
    MalObject *current = prototype;
    while (current != nullptr) {
        if (mal_json_pointer_find(&state->prototypes, current) != nullptr) break;
        if ((current->header.type != MAL_HEAP_OBJECT &&
                current->header.type != MAL_HEAP_ARRAY_OBJECT) ||
            current->is_arguments ||
            mal_object_get_own(current, state->to_json).present) {
            return false;
        }
        current = current->prototype;
    }
    usize admitted = 0;
    while (prototype != current && admitted++ < MAL_JSON_PLAN_ENTRY_LIMIT) {
        if (state->prototypes.count == MAL_JSON_PLAN_ENTRY_LIMIT) {
            // Proofs are optional and independent of traversal frames. Rotate
            // eviction so changing prototype chains cannot grow this table.
            usize slot = state->prototype_eviction_slot;
            usize mask = state->prototypes.capacity - 1;
            while (state->prototypes.entries[slot].key == nullptr) {
                slot = (slot + 1) & mask;
            }
            mal_json_pointer_remove(
                &state->prototypes, state->prototypes.entries[slot].key);
            state->prototype_eviction_slot = (slot + 1) & mask;
        }
        mal_json_pointer_insert(&state->prototypes, prototype, nullptr);
        prototype = prototype->prototype;
    }
    return true;
}

static bool mal_json_plain_shape(
    MalJsonPlainState *state, MalObject *object, MalJsonFrame *frame
) {
    if (object->shape == nullptr || mal_object_has_public_overflow(object) ||
        object->is_arguments || object->is_raw_json) return false;
    MalJsonPointerEntry *cached = mal_json_pointer_find(&state->shapes, object->shape);
    if (cached != nullptr) {
        MAL_PERF_COUNT(json_shape_plan_hits);
        frame->plan = cached->value;
        frame->count = frame->plan->count;
        frame->cached_plan = true;
        return true;
    }
    const MalShape *shape = object->shape;
    usize count = 0;
    for (u32 i = 0; i < shape->inline_count; i++) {
        const MalShapeProp *prop = &shape->props[i];
        if ((prop->attrs & MAL_PROPERTY_ACCESSOR) != 0) return false;
        if (!mal_value_is_string(prop->key)) continue;
        if (mal_string_equals(mal_value_to_string(prop->key),
                mal_value_to_string(state->to_json.value))) return false;
        if ((prop->attrs & MAL_PROPERTY_ENUMERABLE) != 0) count++;
    }
    // Exhausting the optional cache does not discard output or enter the
    // observable serializer. Eligible immutable shapes can be walked directly.
    frame->shape = shape;
    frame->count = shape->inline_count;
    usize available = MAL_JSON_PLAN_DATA_BUDGET - state->cache_data_bytes;
    if (state->shapes.count >= MAL_JSON_PLAN_ENTRY_LIMIT ||
        available < sizeof(MalJsonShapePlan) ||
        count > (available - sizeof(MalJsonShapePlan)) / sizeof(MalJsonKeyPlan)) {
        return true;
    }
    usize bytes = sizeof(MalJsonShapePlan) + count * sizeof(MalJsonKeyPlan);
    MalJsonShapePlan *plan = calloc(1, bytes);
    if (plan == nullptr) abort();
    state->cache_data_bytes += bytes;
    MAL_PERF_COUNT(json_shape_plans);
    MAL_PERF_ADD(json_shape_plan_bytes, bytes);
    plan->escaped_keys.vm = state->vm;
    for (u32 i = 0; i < shape->inline_count; i++) {
        const MalShapeProp *prop = &shape->props[i];
        if (mal_value_is_string(prop->key) &&
            (prop->attrs & MAL_PROPERTY_ENUMERABLE) != 0) {
            plan->keys[plan->count++] = (MalJsonKeyPlan) {
                .slot = prop->slot, .key = mal_value_to_string(prop->key),
            };
        }
    }
    mal_json_pointer_insert(&state->shapes, object->shape, plan);
    frame->plan = plan;
    frame->count = plan->count;
    frame->cached_plan = true;
    return true;
}

static bool mal_json_plain_key(
    MalJsonPlainState *state, MalJsonBuilder *builder,
    MalJsonShapePlan *plan, MalJsonKeyPlan *key
) {
    if (key->length != 0) {
        MAL_PERF_COUNT(json_escaped_key_reuses);
        MalTextBuffer *keys = &plan->escaped_keys.buffer;
        MalTextBufferStatus status = keys->utf16
            ? mal_text_buffer_append_units(
                &builder->buffer, (const c16 *) keys->data + key->offset, key->length)
            : mal_text_buffer_append_latin1(
                &builder->buffer, (const u8 *) keys->data + key->offset, key->length);
        return status == MAL_TEXT_BUFFER_OK || mal_json_throw_string_length(builder->vm);
    }

    // Quote once into final output. Only retain its encoded range when the
    // exact buffer capacity, including a possible width promotion, fits.
    usize start = builder->buffer.length;
    if (!mal_json_builder_push_quoted(builder, key->key) ||
        !mal_json_builder_push(builder, ':')) return false;
    if (plan == nullptr || key->offset == SIZE_MAX) return true;
    usize length = builder->buffer.length - start;
    MalTextBuffer *keys = &plan->escaped_keys.buffer;
    usize required;
    usize capacity = keys->capacity;
    if (!mal_checked_size_add(
            keys->length, length, MAL_STRING_MAX_CODE_UNITS, &required)) {
        key->offset = SIZE_MAX;
        return true;
    }
    if (capacity == 0) {
        MalTextBuffer hint = {0};
        mal_text_buffer_hint_capacity(&hint, required);
        capacity = hint.capacity;
    } else if (!mal_checked_size_growth(
            capacity, required, capacity, MAL_STRING_MAX_CODE_UNITS, &capacity)) {
        key->offset = SIZE_MAX;
        return true;
    }
    usize old_bytes = keys->capacity * (keys->utf16 ? sizeof(c16) : sizeof(u8));
    usize available = MAL_JSON_PLAN_DATA_BUDGET - state->cache_data_bytes + old_bytes;
    if (capacity > available) {
        key->offset = SIZE_MAX;
        return true;
    }
    bool utf16 = keys->utf16;
    if (!utf16 && builder->buffer.utf16) {
        const c16 *units = (const c16 *) builder->buffer.data + start;
        for (usize i = 0; i < length; i++) {
            if (units[i] > UINT8_MAX) {
                utf16 = true;
                break;
            }
        }
    }
    if (capacity > available / (utf16 ? sizeof(c16) : sizeof(u8))) {
        key->offset = SIZE_MAX;
        return true;
    }
    if (keys->capacity == 0) mal_text_buffer_hint_capacity(keys, required);
    MalTextBufferStatus status = builder->buffer.utf16
        ? mal_text_buffer_append_units(
            keys, (const c16 *) builder->buffer.data + start, length)
        : mal_text_buffer_append_latin1(
            keys, (const u8 *) builder->buffer.data + start, length);
    if (status != MAL_TEXT_BUFFER_OK) return mal_json_throw_string_length(builder->vm);
    state->cache_data_bytes +=
        keys->capacity * (keys->utf16 ? sizeof(c16) : sizeof(u8)) - old_bytes;
    key->offset = required - length;
    key->length = length;
    MAL_PERF_ADD(json_escaped_key_code_units, length);
    return true;
}

static bool mal_json_plain_frame(
    MalJsonPlainState *state, MalValue value, MalJsonFrame *frame
) {
    MalObject *object = mal_value_to_object(value);
    *frame = (MalJsonFrame) {.value = value};
    if (object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = mal_value_to_array_object(value);
        if (array->dense_deopted || array->dense_maybe_holey ||
            array->dense_count != array->length ||
            mal_object_get_own(object, state->to_json).present) return false;
        frame->array = true;
        frame->count = array->length;
    } else if (object->header.type == MAL_HEAP_OBJECT) {
        if (!mal_json_plain_shape(state, object, frame)) return false;
    } else {
        return false;
    }
    return mal_json_plain_prototype(state, object->prototype);
}

static void mal_json_plain_dispose(MalJsonPlainState *state) {
    for (usize i = 0; i < state->shapes.capacity; i++) {
        MalJsonPointerEntry *entry = &state->shapes.entries[i];
        if (entry->key != nullptr) {
            MalJsonShapePlan *plan = entry->value;
            MAL_PERF_ADD(json_escaped_key_capacity_bytes,
                plan->escaped_keys.buffer.capacity * (plan->escaped_keys.buffer.utf16 ? 2 : 1));
            mal_text_buffer_dispose(&plan->escaped_keys.buffer);
            free(plan);
        }
    }
    MAL_PERF_ADD(json_plan_table_bytes,
        (state->shapes.capacity + state->prototypes.capacity) * sizeof(MalJsonPointerEntry));
    free(state->shapes.entries);
    free(state->prototypes.entries);
    free(state->active.entries);
    free(state->frames);
}

static MalValue mal_json_frame_key(const MalJsonFrame *frame, usize position) {
    if (frame->cached_plan) {
        return mal_value_from_string(frame->plan->keys[position].key);
    }
    const MalShapeProp *prop = &frame->shape->props[position];
    return mal_value_is_string(prop->key) &&
        (prop->attrs & MAL_PROPERTY_ENUMERABLE) != 0
        ? prop->key : mal_value_new_undefined();
}

static MalJsonResult mal_json_resume_generic(
    MalJsonPlainState *plain, MalJsonState *generic, MalJsonBuilder *builder
) {
    // Ancestor keys and array lengths were fixed before any callback. Retain
    // their holders and remaining keys even if reentry deletes the input graph.
    MalRootedValueList roots;
    mal_rooted_value_list_init(&roots);
    for (usize i = 0; i < plain->count; i++) {
        const MalJsonFrame *frame = &plain->frames[i];
        mal_rooted_value_list_append(&roots, frame->value);
        if (!frame->array) {
            for (usize k = frame->position; k < frame->count; k++) {
                MalValue key = mal_json_frame_key(frame, k);
                if (!mal_value_is_undefined(key)) {
                    mal_rooted_value_list_append(&roots, key);
                }
            }
        }
    }
    generic->active = plain->active;
    plain->active = (MalJsonPointerMap) {0};
    MalJsonResult result = MAL_JSON_THROW;
    if (plain->count > MAL_JSON_MAX_RECURSION_DEPTH) {
        mal_json_throw_depth(generic->vm);
        goto done;
    }
    while (plain->count != 0) {
        MalJsonFrame *frame = &plain->frames[plain->count - 1];
        while (frame->position < frame->count) {
            usize position = frame->position++;
            MalJsonResult member;
            if (frame->array) {
                if (frame->any && !mal_json_builder_push(builder, ',')) goto done;
                member = mal_json_serialize_property(generic, builder,
                    mal_key_index((u32) position), mal_value_new_undefined(),
                    frame->value, plain->count);
                if (member == MAL_JSON_OMITTED &&
                    !mal_json_builder_push_ascii(builder, "null")) goto done;
            } else {
                MalValue key = mal_json_frame_key(frame, position);
                if (mal_value_is_undefined(key)) continue;
                // Slots, descriptors, and prototypes can all change after the
                // first callback; only the original enumerable key list survives.
                member = mal_json_serialize_member(generic, builder,
                    mal_key_from_value(key), key, frame->value, false,
                    mal_value_new_undefined(), plain->count, frame->any);
                if (member == MAL_JSON_OMITTED) continue;
            }
            if (member == MAL_JSON_THROW) goto done;
            frame->any = true;
        }
        if (!mal_json_builder_push(builder, frame->array ? ']' : '}')) goto done;
        mal_json_pointer_remove(&generic->active, mal_value_to_object(frame->value));
        plain->count--;
    }
    result = MAL_JSON_WROTE;
done:
    mal_rooted_value_list_dispose(&roots);
    return result;
}

static bool mal_json_try_serialize_plain(
    MalJsonState *generic, MalJsonBuilder *builder, MalValue root,
    MalJsonResult *result
) {
    if (!mal_value_is_object(root) || mal_value_is_callable(generic->replacer_fn) ||
        generic->has_property_list || generic->gap_length != 0) return false;
    MalJsonPlainState state = {
        .vm = generic->vm,
        .to_json = mal_intrinsic_string_key(generic->vm, "toJSON"),
    };
    // Before fallback, descendants and prototypes remain reachable from root:
    // the plain traversal never invokes JS or changes a property.
    MalRootSpan span;
    mal_gc_root(&span, &root, 1);
    MalValue value = root;
    MalJsonFrame pending_frame;
    bool has_pending_frame = false;
    bool handled = true;
    *result = MAL_JSON_WROTE;
    while (true) {
        if (mal_value_is_object(value)) {
            MalObject *object = mal_value_to_object(value);
            MalJsonFrame frame;
            if (has_pending_frame) {
                frame = pending_frame;
                has_pending_frame = false;
            } else if (!mal_json_plain_frame(&state, value, &frame)) {
                goto unsupported;
            }
            if (mal_json_pointer_find(&state.active, object) != nullptr) {
                mal_vm_throw_error(generic->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Converting circular structure to JSON");
                goto failed;
            }
            mal_json_pointer_insert(&state.active, object, nullptr);
            if (state.count == state.capacity) {
                usize capacity;
                usize bytes;
                if (!mal_checked_size_growth(
                        state.capacity, state.count + 1, 16, SIZE_MAX, &capacity) ||
                    !mal_checked_size_multiply(
                        capacity, sizeof(MalJsonFrame), SIZE_MAX, &bytes)) abort();
                MalJsonFrame *frames = realloc(state.frames, bytes);
                if (frames == nullptr) abort();
                state.frames = frames;
                state.capacity = capacity;
            }
            state.frames[state.count++] = frame;
            if (!mal_json_builder_push(builder, frame.array ? '[' : '{')) goto failed;
        } else {
            // BigInt can inherit toJSON, so it must take the observable path.
            if (mal_value_is_bigint(value)) goto unsupported;
            MalJsonResult leaf = mal_json_serialize_prepared(generic, builder, value, 0);
            if (leaf == MAL_JSON_THROW) goto failed;
        }

        bool next = false;
        while (state.count != 0) {
            MalJsonFrame *frame = &state.frames[state.count - 1];
            if (frame->position == frame->count) {
                if (!mal_json_builder_push(builder, frame->array ? ']' : '}')) goto failed;
                mal_json_pointer_remove(&state.active, mal_value_to_object(frame->value));
                state.count--;
                continue;
            }
            MalJsonKeyPlan *key = nullptr;
            MalJsonKeyPlan uncached_key;
            if (frame->array) {
                MalArrayObject *array = mal_value_to_array_object(frame->value);
                value = array->elements[frame->position++];
                if (!mal_value_is_object(value) && mal_json_value_is_omitted(value)) {
                    value = mal_value_new_null();
                }
            } else {
                if (frame->cached_plan) {
                    key = &frame->plan->keys[frame->position++];
                } else {
                    const MalShapeProp *prop = &frame->shape->props[frame->position++];
                    if (!mal_value_is_string(prop->key) ||
                        (prop->attrs & MAL_PROPERTY_ENUMERABLE) == 0) continue;
                    uncached_key = (MalJsonKeyPlan) {
                        .slot = prop->slot, .key = mal_value_to_string(prop->key),
                    };
                    key = &uncached_key;
                }
                value = mal_value_to_object(frame->value)->slots[key->slot];
                if (!mal_value_is_object(value) && mal_json_value_is_omitted(value)) continue;
            }
            // An observable toJSON may omit this member. Prove its absence
            // before reserving a key that would then not belong to the output.
            if (mal_value_is_object(value)) {
                if (!mal_json_plain_frame(&state, value, &pending_frame)) goto unsupported_child;
                has_pending_frame = true;
            } else if (mal_value_is_bigint(value)) {
                goto unsupported_child;
            }
            if ((frame->any && !mal_json_builder_push(builder, ',')) ||
                (key != nullptr && !mal_json_plain_key(
                    &state, builder, frame->cached_plan ? frame->plan : nullptr, key))) goto failed;
            frame->any = true;
            next = true;
            break;
        }
        if (!next) break;
    }
    goto done;

unsupported_child:
    // The current member has no comma, key, or output yet. Generic completion
    // must read it before invoking any observable transformation exactly once.
    state.frames[state.count - 1].position--;
unsupported:
    MAL_PERF_COUNT(json_plain_fallbacks);
    if (state.count != 0) {
        *result = mal_json_resume_generic(&state, generic, builder);
    } else {
        handled = false;
    }
    goto done;
failed:
    *result = MAL_JSON_THROW;
done:
    mal_json_plain_dispose(&state);
    mal_gc_unroot(&span);
    return handled;
}

static MalValue mal_builtin_json_stringify(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue replacer = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue space = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    MalJsonState state = {0};
    state.vm = vm;
    state.replacer_fn = mal_value_new_undefined();
    mal_rooted_value_list_init(&state.property_list);

    // Replacer: a callable is the ReplacerFunction; an array builds the
    // PropertyList allow-list. Anything else is ignored.
    if (mal_value_is_object(replacer)) {
        if (mal_value_is_callable(replacer)) {
            state.replacer_fn = replacer;
        } else {
            bool is_array;
            if (!mal_vm_is_array(vm, replacer, &is_array)) {
                mal_rooted_value_list_dispose(&state.property_list);
                return mal_value_new_undefined();
            }
            if (is_array && !mal_json_build_property_list(&state, replacer)) {
                mal_rooted_value_list_dispose(&state.property_list);
                return mal_value_new_undefined();
            }
        }
    }

    // Space: unwrap a Number/String wrapper (ToNumber/ToString may run valueOf),
    // then a number yields min(10, ToInteger) spaces and a string its first 10
    // code units.
    c16 gap_buffer[10];
    if (mal_value_is_primitive_wrapper(space)) {
        MalPrimitiveWrapperKind kind = mal_value_to_primitive_wrapper(space)->kind;
        if (kind == MAL_PRIMITIVE_WRAPPER_NUMBER) {
            f64 number;
            if (!mal_vm_to_number(vm, space, &number)) {
                mal_rooted_value_list_dispose(&state.property_list);
                return mal_value_new_undefined();
            }
            space = mal_ops_number_value(number);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_STRING) {
            MalString *string_value;
            if (!mal_vm_to_string(vm, space, &string_value)) {
                mal_rooted_value_list_dispose(&state.property_list);
                return mal_value_new_undefined();
            }
            space = mal_value_from_string(string_value);
        }
    }
    if (mal_value_is_int32(space) || mal_value_is_f64(space) || space == MAL_VALUE_NEGATIVE_ZERO || mal_value_is_nan(space)) {
        f64 number = mal_ops_to_number(space);
        i32 count = isnan(number) ? 0 : (i32) fmin(10.0, fmax(0.0, trunc(number)));
        for (i32 i = 0; i < count; i++) {
            gap_buffer[i] = ' ';
        }
        state.gap = gap_buffer;
        state.gap_length = (usize) count;
    } else if (mal_value_is_string(space)) {
        MalString *string = mal_value_to_string(space);
        usize length = mal_string_length(string);
        if (length > 10) {
            length = 10;
        }
        mal_string_copy_range_to(string, 0, length, gap_buffer);
        state.gap = gap_buffer;
        state.gap_length = length;
    }

    MalValue empty_key = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    MalJsonBuilder builder = {.vm = vm};
    MalKey root_key = {.kind = MAL_KEY_STRING, .value = empty_key};
    MalValue holder = mal_value_new_undefined();
    MalJsonResult result;
    if (mal_json_try_serialize_plain(&state, &builder, value, &result)) {
        // The guarded traversal completed without observable hooks.
    } else if (mal_value_is_callable(state.replacer_fn)) {
        // A replacer observes the synthetic root holder as its `this` value.
        MalObject *wrapper = mal_intrinsic_new_object(vm);
        mal_intrinsic_define_data(
            vm, wrapper, "", value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
        holder = mal_value_from_object(wrapper);
        result = mal_json_serialize_property(
            &state, &builder, root_key, empty_key, holder, 0);
    } else {
        // Without a replacer, the wrapper's only observable work is reading
        // back the value just stored in it. Serialize the argument directly.
        result = mal_json_serialize_value(
            &state, &builder, root_key, empty_key, holder, value, 0);
    }

    mal_rooted_value_list_dispose(&state.property_list);
    free(state.active.entries);

    if (result != MAL_JSON_WROTE) {
        mal_text_buffer_dispose(&builder.buffer);
        return mal_value_new_undefined();
    }

    MalValue serialized = mal_value_from_string(
        mal_text_buffer_finish(&vm->heap, &builder.buffer));
    return serialized;
}

typedef enum MalJsonParseNodeKind {
    MAL_JSON_PARSE_PRIMITIVE,
    MAL_JSON_PARSE_ARRAY,
    MAL_JSON_PARSE_OBJECT,
} MalJsonParseNodeKind;

typedef struct MalJsonParseNode MalJsonParseNode;

typedef struct MalJsonParseChild {
    MalKey key;
    usize key_root_index;
    MalJsonParseNode *node;
} MalJsonParseChild;

struct MalJsonParseNode {
    MalJsonParseNodeKind kind;
    usize value_root_index;
    usize source_start;
    usize source_end;
    MalJsonParseChild *children;
    usize child_count;
    usize child_capacity;
    usize *key_index;
    usize key_index_capacity;
    MalJsonParseNode *dispose_next;
};

typedef struct MalJsonParseState {
    MalRootedValueList roots;
} MalJsonParseState;

typedef struct MalJsonParser {
    MalVm *vm;
    MalString *source;
    MalStringIterator iterator;
    MalStringSegment segment;
    usize segment_start;
    usize length;
    usize position;
    usize depth;
    MalJsonParseState *state;
} MalJsonParser;

static void mal_json_parser_init(MalJsonParser *parser) {
    if (!mal_string_try_get_segment(
            parser->source, 0, parser->length, &parser->segment)) {
        mal_string_iterator_init(&parser->iterator, parser->source, 0, parser->length);
        mal_string_iterator_next(&parser->iterator, &parser->segment);
    }
}

__attribute__((noinline))
static c16 mal_json_parser_unit_slow(MalJsonParser *parser, usize position) {
    if (position < parser->segment_start) {
        MAL_PERF_COUNT(json_parser_backward_seeks);
        mal_string_iterator_dispose(&parser->iterator);
        mal_string_iterator_init(
            &parser->iterator, parser->source, position, parser->length - position);
        parser->segment_start = position;
        mal_string_iterator_next(&parser->iterator, &parser->segment);
    }
    while (position - parser->segment_start >= parser->segment.length) {
        parser->segment_start += parser->segment.length;
        mal_string_iterator_next(&parser->iterator, &parser->segment);
    }
    return mal_string_segment_code_unit_at(
        &parser->segment, position - parser->segment_start);
}

static inline c16 mal_json_parser_unit(MalJsonParser *parser, usize position) {
    usize offset = position - parser->segment_start;
    if (offset < parser->segment.length) {
        return mal_string_segment_code_unit_at(&parser->segment, offset);
    }
    return mal_json_parser_unit_slow(parser, position);
}

// Raw JSON string runs may contain surrogate code units. Only controls, the
// delimiter, and backslashes interrupt a run; decoding escapes is a separate step.
static bool mal_json_parser_unescaped_run(
    MalJsonParser *parser, MalJsonBuilder *builder
) {
    while (parser->position < parser->length) {
        usize offset = parser->position - parser->segment_start;
        if (offset >= parser->segment.length) {
            mal_json_parser_unit_slow(parser, parser->position);
            offset = parser->position - parser->segment_start;
        }
        usize available = parser->segment.length - offset;
        usize run = parser->segment.latin1
            ? mal_json_latin1_safe_run(parser->segment.latin1_units + offset, available)
            : mal_json_utf16_unescaped_run(parser->segment.utf16_units + offset, available);
        if (builder != nullptr && run != 0 &&
            !mal_json_builder_push_segment(builder, &parser->segment, offset, run)) return false;
        parser->position += run;
        if (run < available) break;
    }
    return true;
}

static MalValue mal_json_parse_value(
    MalJsonParser *parser, MalJsonParseNode **node_out);

static MalJsonParseNode *mal_json_parse_node_new(
    MalJsonParser *parser, MalJsonParseNodeKind kind, MalValue value,
    usize source_start
) {
    if (parser->state == nullptr) {
        return nullptr;
    }
    MalJsonParseNode *node = calloc(1, sizeof(MalJsonParseNode));
    if (node == nullptr) {
        abort();
    }
    node->kind = kind;
    node->value_root_index = parser->state->roots.count;
    node->source_start = source_start;
    mal_rooted_value_list_append(&parser->state->roots, value);
    return node;
}

static void mal_json_parse_node_append(
    MalJsonParser *parser, MalJsonParseNode *parent, MalKey key,
    MalJsonParseNode *child
) {
    if (parent == nullptr) {
        return;
    }
    if (parent->child_count == parent->child_capacity) {
        usize capacity = parent->child_capacity == 0
            ? 8 : parent->child_capacity * 2;
        MalJsonParseChild *children = realloc(
            parent->children, sizeof(MalJsonParseChild) * capacity);
        if (children == nullptr) {
            abort();
        }
        parent->children = children;
        parent->child_capacity = capacity;
    }
    usize key_root_index = SIZE_MAX;
    if (key.kind == MAL_KEY_STRING || key.kind == MAL_KEY_SYMBOL) {
        key_root_index = parser->state->roots.count;
        mal_rooted_value_list_append(&parser->state->roots, key.value);
    }
    parent->children[parent->child_count++] = (MalJsonParseChild) {
        .key = key,
        .key_root_index = key_root_index,
        .node = child,
    };
}

static void mal_json_parse_node_dispose(MalJsonParseNode *node) {
    while (node != nullptr) {
        MalJsonParseNode *next = node->dispose_next;
        for (usize i = 0; i < node->child_count; i++) {
            MalJsonParseNode *child = node->children[i].node;
            if (child != nullptr) {
                child->dispose_next = next;
                next = child;
            }
        }
        free(node->key_index);
        free(node->children);
        free(node);
        node = next;
    }
}

static void mal_json_parse_error(MalJsonParser *parser) {
    mal_vm_throw_error(parser->vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Unexpected token in JSON");
}

static void mal_json_skip_whitespace(MalJsonParser *parser) {
    while (parser->position < parser->length) {
        c16 code_unit = mal_json_parser_unit(parser, parser->position);
        if (code_unit != ' ' && code_unit != '\t' && code_unit != '\n' && code_unit != '\r') {
            break;
        }
        parser->position++;
    }
}

static bool mal_json_consume(MalJsonParser *parser, c16 expected) {
    if (parser->position < parser->length && mal_json_parser_unit(parser, parser->position) == expected) {
        parser->position++;
        return true;
    }

    return false;
}

static bool mal_json_consume_keyword(MalJsonParser *parser, const byte *keyword) {
    usize length = 0;
    while (keyword[length] != '\0') {
        length++;
    }

    if (parser->position + length > parser->length) {
        return false;
    }
    for (usize i = 0; i < length; i++) {
        if (mal_json_parser_unit(parser, parser->position + i) != (c16) keyword[i]) {
            return false;
        }
    }

    parser->position += length;
    return true;
}

static MalValue mal_json_parse_string(MalJsonParser *parser) {
    // Borrow a token confined to this leaf; copy crossed segments as we visit
    // them, before advancing the cursor. Neither path descends from the root.
    usize start = parser->position;
    MalJsonBuilder builder = {.vm = parser->vm};
    while (parser->position < parser->length) {
        usize offset = parser->position - parser->segment_start;
        if (offset >= parser->segment.length) {
            mal_json_parser_unit_slow(parser, parser->position);
            offset = parser->position - parser->segment_start;
        }
        usize available = parser->segment.length - offset;
        usize run = parser->segment.latin1
            ? mal_json_latin1_safe_run(parser->segment.latin1_units + offset, available)
            : mal_json_utf16_unescaped_run(parser->segment.utf16_units + offset, available);
        parser->position += run;
        if (run < available && builder.buffer.length == 0 &&
            mal_string_segment_code_unit_at(&parser->segment, offset + run) == '"') {
            parser->position++;
            const MalStringIteratorPart *current = &parser->iterator.current;
            MalString *owner = current->string != nullptr
                ? (MalString *) current->string : parser->source;
            usize owner_offset = current->string != nullptr
                ? current->offset + offset : start;
            return mal_value_from_string(mal_string_new_slice(
                &parser->vm->heap, owner, owner_offset, run));
        }
        if (run != 0 && !mal_json_builder_push_segment(
                &builder, &parser->segment, offset, run)) goto length_error;
        if (run < available) break;
    }

    while (parser->position < parser->length) {
        if (!mal_json_parser_unescaped_run(parser, &builder)) goto length_error;
        if (parser->position == parser->length) break;
        c16 code_unit = mal_json_parser_unit(parser, parser->position++);
        if (code_unit == '"') {
            MalValue result = mal_value_from_string(
                mal_text_buffer_finish(&parser->vm->heap, &builder.buffer));
            return result;
        }

        if (code_unit < 0x20) {
            // JSONString may not contain unescaped control characters U+0000..U+001F.
            mal_text_buffer_dispose(&builder.buffer);
            mal_json_parse_error(parser);
            return mal_value_new_undefined();
        }

        if (parser->position >= parser->length) {
            break;
        }

        c16 escape = mal_json_parser_unit(parser, parser->position++);
        switch (escape) {
            case '"':
            case '\\':
            case '/':
                if (!mal_json_builder_push(&builder, escape)) goto length_error;
                break;
            case 'b':
                if (!mal_json_builder_push(&builder, '\b')) goto length_error;
                break;
            case 'f':
                if (!mal_json_builder_push(&builder, '\f')) goto length_error;
                break;
            case 'n':
                if (!mal_json_builder_push(&builder, '\n')) goto length_error;
                break;
            case 'r':
                if (!mal_json_builder_push(&builder, '\r')) goto length_error;
                break;
            case 't':
                if (!mal_json_builder_push(&builder, '\t')) goto length_error;
                break;
            case 'u': {
                if (parser->position + 4 > parser->length) {
                    mal_text_buffer_dispose(&builder.buffer);
                    mal_json_parse_error(parser);
                    return mal_value_new_undefined();
                }

                c16 value = 0;
                for (i32 i = 0; i < 4; i++) {
                    c16 digit = mal_json_parser_unit(parser, parser->position++);
                    value = (c16) (value << 4);
                    if (digit >= '0' && digit <= '9') {
                        value = (c16) (value + (digit - '0'));
                    } else if (digit >= 'a' && digit <= 'f') {
                        value = (c16) (value + (digit - 'a' + 10));
                    } else if (digit >= 'A' && digit <= 'F') {
                        value = (c16) (value + (digit - 'A' + 10));
                    } else {
                        mal_text_buffer_dispose(&builder.buffer);
                        mal_json_parse_error(parser);
                        return mal_value_new_undefined();
                    }
                }
                if (!mal_json_builder_push(&builder, value)) goto length_error;
                break;
            }
            default:
                mal_text_buffer_dispose(&builder.buffer);
                mal_json_parse_error(parser);
                return mal_value_new_undefined();
        }
    }

    mal_text_buffer_dispose(&builder.buffer);
    mal_json_parse_error(parser);
    return mal_value_new_undefined();

length_error:
    mal_text_buffer_dispose(&builder.buffer);
    return mal_value_new_undefined();
}

typedef struct MalJsonNumberToken {
    byte *data;
    usize length;
    usize capacity;
    byte inline_data[64];
} MalJsonNumberToken;

static inline void mal_json_number_token_push(MalJsonNumberToken *token, byte unit) {
    if (token->length == token->capacity) {
        if (token->capacity > SIZE_MAX / 2) abort();
        usize capacity = token->capacity * 2;
        byte *data = malloc(capacity);
        if (data == nullptr) abort();
        memcpy(data, token->data, token->length);
        if (token->data != token->inline_data) free(token->data);
        token->data = data;
        token->capacity = capacity;
    }
    token->data[token->length++] = unit;
}

static bool mal_json_number_consume(
    MalJsonParser *parser, MalJsonNumberToken *token, c16 expected
) {
    if (!mal_json_consume(parser, expected)) return false;
    mal_json_number_token_push(token, (byte) expected);
    return true;
}

static MalValue mal_json_parse_number(MalJsonParser *parser) {
    MalJsonNumberToken token;
    token.data = token.inline_data;
    token.length = 0;
    token.capacity = sizeof(token.inline_data);
    bool negative = mal_json_number_consume(parser, &token, '-');
    usize integer_digits = 0;
    u64 magnitude = 0;
    if (mal_json_number_consume(parser, &token, '0')) {
        // Leave subsequent leading-zero digits for the container's syntax check.
        integer_digits = 1;
    } else if (parser->position < parser->length &&
               (u32) (mal_json_parser_unit(parser, parser->position) - '1') < 9) {
        while (parser->position < parser->length) {
            u32 digit = (u32) (mal_json_parser_unit(parser, parser->position) - '0');
            if (digit >= 10) break;
            if (integer_digits < 16) magnitude = magnitude * 10 + digit;
            integer_digits++;
            mal_json_number_token_push(&token, (byte) ('0' + digit));
            parser->position++;
        }
    } else {
        goto syntax_error;
    }
    bool integer_literal = true;
    if (mal_json_number_consume(parser, &token, '.')) {
        integer_literal = false;
        usize fraction_start = parser->position;
        while (parser->position < parser->length) {
            c16 unit = mal_json_parser_unit(parser, parser->position);
            if ((u32) (unit - '0') >= 10) break;
            mal_json_number_token_push(&token, (byte) unit);
            parser->position++;
        }
        if (parser->position == fraction_start) goto syntax_error;
    }
    if (mal_json_number_consume(parser, &token, 'e') ||
        mal_json_number_consume(parser, &token, 'E')) {
        integer_literal = false;
        if (!mal_json_number_consume(parser, &token, '+')) {
            mal_json_number_consume(parser, &token, '-');
        }
        usize exponent_start = parser->position;
        while (parser->position < parser->length) {
            c16 unit = mal_json_parser_unit(parser, parser->position);
            if ((u32) (unit - '0') >= 10) break;
            mal_json_number_token_push(&token, (byte) unit);
            parser->position++;
        }
        if (parser->position == exponent_start) goto syntax_error;
    }

    MalValue value;
    if (integer_literal && integer_digits <= 16 &&
        magnitude <= (u64) MAL_NUMBER_MAX_SAFE_INTEGER) {
        f64 number = (f64) magnitude;
        value = negative && magnitude == 0 ? MAL_VALUE_NEGATIVE_ZERO
            : mal_ops_number_value(negative ? -number : number);
    } else {
        // This scratch terminator does not consume a JS string code unit, even
        // when the numeric token reaches the engine's full source-length limit.
        mal_json_number_token_push(&token, '\0');
        value = mal_ops_number_value(strtod(token.data, nullptr));
    }
    if (token.data != token.inline_data) free(token.data);
    return value;

syntax_error:
    if (token.data != token.inline_data) free(token.data);
    mal_json_parse_error(parser);
    return mal_value_new_undefined();
}

static MalValue mal_json_parse_array(
    MalJsonParser *parser, usize source_start, MalJsonParseNode **node_out
) {
    MalArrayObject *array = mal_intrinsic_new_array(parser->vm, 0);
    MalValue array_value = mal_value_from_array_object(array);
    MalRootSpan array_span;
    mal_gc_root(&array_span, &array_value, 1);
    MalJsonParseNode *node = mal_json_parse_node_new(
        parser, MAL_JSON_PARSE_ARRAY, array_value, source_start);
    *node_out = node;

    mal_json_skip_whitespace(parser);
    if (mal_json_consume(parser, ']')) {
        if (node != nullptr) {
            node->source_end = parser->position;
        }
        mal_gc_unroot(&array_span);
        return array_value;
    }

    u32 index = 0;
    while (true) {
        MalJsonParseNode *element_node = nullptr;
        MalValue element = mal_json_parse_value(parser, &element_node);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_json_parse_node_dispose(element_node);
            mal_gc_unroot(&array_span);
            return mal_value_new_undefined();
        }
        MalRootSpan element_span;
        mal_gc_root(&element_span, &element, 1);

        MalKey element_key = mal_key_index(index++);
        array = mal_value_to_array_object(array_value);
        if (!mal_array_object_fresh_dense_append(array, element)) {
            mal_array_object_store(array, element_key, element);
        }
        mal_json_parse_node_append(parser, node, element_key, element_node);
        mal_gc_unroot(&element_span);

        mal_json_skip_whitespace(parser);
        if (mal_json_consume(parser, ',')) {
            mal_json_skip_whitespace(parser);
            continue;
        }
        if (mal_json_consume(parser, ']')) {
            if (node != nullptr) {
                node->source_end = parser->position;
            }
            mal_gc_unroot(&array_span);
            return array_value;
        }

        mal_json_parse_error(parser);
        mal_gc_unroot(&array_span);
        return mal_value_new_undefined();
    }
}

typedef struct MalJsonObjectMembers {
    MalRootedKeySnapshot keys;
    MalRootedValueList values;
} MalJsonObjectMembers;

static void mal_json_object_members_init(MalJsonObjectMembers *members) {
    mal_rooted_key_snapshot_init(&members->keys);
    mal_rooted_value_list_init(&members->values);
}

static void mal_json_object_members_dispose(MalJsonObjectMembers *members) {
    mal_rooted_value_list_dispose(&members->values);
    mal_rooted_key_snapshot_dispose(&members->keys);
}

static MalValue mal_json_object_members_finalize(
    MalJsonParser *parser, MalJsonObjectMembers *members
) {
    if (members->keys.count == 0) {
        return mal_value_from_object(mal_intrinsic_new_object(parser->vm));
    }

    MalString *shape_keys[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
    MalValue shape_values[MAL_SHAPE_DYNAMIC_INLINE_SLOTS];
    u32 shape_count = 0;
    bool shaped = true;
    for (usize i = 0; i < members->keys.count; i++) {
        MalKey key = members->keys.keys[i];
        if (key.kind != MAL_KEY_STRING) {
            shaped = false;
            break;
        }

        MalString *string = mal_value_to_string(members->keys.roots[i]);
        u32 slot = 0;
        while (slot < shape_count &&
               !mal_string_equals(shape_keys[slot], string)) {
            slot++;
        }
        if (slot < shape_count) {
            // CreateDataProperty overwrites a duplicate without changing its
            // first insertion position.
            shape_values[slot] = members->values.values[i];
            continue;
        }
        if (shape_count == MAL_SHAPE_DYNAMIC_INLINE_SLOTS) {
            shaped = false;
            break;
        }
        shape_keys[shape_count] = string;
        shape_values[shape_count] = members->values.values[i];
        shape_count++;
    }

    if (shaped) {
        MalShape *shape =
            mal_shape_from_string_keys(&parser->vm->heap, shape_keys, shape_count);
        MalObject *prototype = mal_value_to_object(
            parser->vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        return mal_value_from_object(mal_object_new_shaped(
            &parser->vm->heap, prototype, shape, shape_values, shape_count));
    }

    MalValue object_value = mal_value_from_object(mal_intrinsic_new_object(parser->vm));
    MalRootSpan object_span;
    mal_gc_root(&object_span, &object_value, 1);
    for (usize i = 0; i < members->keys.count; i++) {
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            members->values.values[i],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(
            mal_value_to_object(object_value), members->keys.keys[i], &desc);
    }
    mal_gc_unroot(&object_span);
    return object_value;
}

static MalValue mal_json_parse_object_staged(
    MalJsonParser *parser, MalJsonParseNode **node_out
) {
    *node_out = nullptr;
    MalJsonObjectMembers members;
    mal_json_object_members_init(&members);

    mal_json_skip_whitespace(parser);
    if (mal_json_consume(parser, '}')) {
        MalValue result = mal_json_object_members_finalize(parser, &members);
        mal_json_object_members_dispose(&members);
        return result;
    }

    while (true) {
        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, '"')) {
            mal_json_parse_error(parser);
            goto fail;
        }

        MalValue key = mal_json_parse_string(parser);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            goto fail;
        }
        MalRootSpan key_span;
        mal_gc_root(&key_span, &key, 1);

        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, ':')) {
            mal_gc_unroot(&key_span);
            mal_json_parse_error(parser);
            goto fail;
        }

        MalKey property_key;
        if (!mal_vm_value_to_property_key(parser->vm, key, &property_key)) {
            mal_gc_unroot(&key_span);
            goto fail;
        }
        mal_rooted_key_snapshot_append(&members.keys, property_key);
        mal_gc_unroot(&key_span);

        MalJsonParseNode *value_node = nullptr;
        MalValue value = mal_json_parse_value(parser, &value_node);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_json_parse_node_dispose(value_node);
            goto fail;
        }
        mal_rooted_value_list_append(&members.values, value);

        mal_json_skip_whitespace(parser);
        if (mal_json_consume(parser, ',')) {
            continue;
        }
        if (mal_json_consume(parser, '}')) {
            MalValue result = mal_json_object_members_finalize(parser, &members);
            mal_json_object_members_dispose(&members);
            return result;
        }

        mal_json_parse_error(parser);
        goto fail;
    }

fail:
    mal_json_object_members_dispose(&members);
    return mal_value_new_undefined();
}

static MalValue mal_json_parse_object(
    MalJsonParser *parser, usize source_start, MalJsonParseNode **node_out
) {
    if (parser->state == nullptr) {
        return mal_json_parse_object_staged(parser, node_out);
    }

    MalObject *object = mal_intrinsic_new_object(parser->vm);
    MalValue object_value = mal_value_from_object(object);
    MalRootSpan object_span;
    mal_gc_root(&object_span, &object_value, 1);
    MalJsonParseNode *node = mal_json_parse_node_new(
        parser, MAL_JSON_PARSE_OBJECT, object_value, source_start);
    *node_out = node;

    mal_json_skip_whitespace(parser);
    if (mal_json_consume(parser, '}')) {
        if (node != nullptr) {
            node->source_end = parser->position;
        }
        mal_gc_unroot(&object_span);
        return object_value;
    }

    while (true) {
        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, '"')) {
            mal_json_parse_error(parser);
            mal_gc_unroot(&object_span);
            return mal_value_new_undefined();
        }

        MalValue key = mal_json_parse_string(parser);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&object_span);
            return mal_value_new_undefined();
        }
        MalRootSpan key_span;
        mal_gc_root(&key_span, &key, 1);

        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, ':')) {
            mal_gc_unroot(&key_span);
            mal_json_parse_error(parser);
            mal_gc_unroot(&object_span);
            return mal_value_new_undefined();
        }

        MalJsonParseNode *value_node = nullptr;
        MalValue value = mal_json_parse_value(parser, &value_node);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_json_parse_node_dispose(value_node);
            mal_gc_unroot(&key_span);
            mal_gc_unroot(&object_span);
            return mal_value_new_undefined();
        }
        MalRootSpan value_span;
        mal_gc_root(&value_span, &value, 1);

        object = mal_value_to_object(object_value);
        MalKey property_key;
        mal_vm_value_to_property_key(parser->vm, key, &property_key);
        // CreateDataProperty: JSON members become own properties, never
        // routed through inherited setters (notably __proto__).
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(object, property_key, &desc);
        mal_json_parse_node_append(parser, node, property_key, value_node);
        mal_gc_unroot(&value_span);
        mal_gc_unroot(&key_span);

        mal_json_skip_whitespace(parser);
        if (mal_json_consume(parser, ',')) {
            continue;
        }
        if (mal_json_consume(parser, '}')) {
            if (node != nullptr) {
                node->source_end = parser->position;
            }
            mal_gc_unroot(&object_span);
            return object_value;
        }

        mal_json_parse_error(parser);
        mal_gc_unroot(&object_span);
        return mal_value_new_undefined();
    }
}

static MalValue mal_json_parse_value(
    MalJsonParser *parser, MalJsonParseNode **node_out
) {
    mal_json_skip_whitespace(parser);
    usize source_start = parser->position;
    if (parser->position >= parser->length) {
        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }

    MalValue value;
    switch (mal_json_parser_unit(parser, parser->position)) {
        case '"':
            parser->position++;
            value = mal_json_parse_string(parser);
            goto primitive;
        case '[':
        case '{': {
            if (!mal_json_check_depth(parser->vm, parser->depth)) {
                return mal_value_new_undefined();
            }
            bool array = mal_json_parser_unit(parser, parser->position++) == '[';
            parser->depth++;
            value = array
                ? mal_json_parse_array(parser, source_start, node_out)
                : mal_json_parse_object(parser, source_start, node_out);
            parser->depth--;
            return value;
        }
        case 'n':
            if (mal_json_consume_keyword(parser, "null")) {
                value = mal_value_new_null();
                goto primitive;
            }
            break;
        case 't':
            if (mal_json_consume_keyword(parser, "true")) {
                value = mal_value_new_boolean(true);
                goto primitive;
            }
            break;
        case 'f':
            if (mal_json_consume_keyword(parser, "false")) {
                value = mal_value_new_boolean(false);
                goto primitive;
            }
            break;
        default:
            break;
    }

    value = mal_json_parse_number(parser);

primitive:
    if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalJsonParseNode *node = mal_json_parse_node_new(
        parser, MAL_JSON_PARSE_PRIMITIVE, value, source_start);
    if (node != nullptr) {
        node->source_end = parser->position;
    }
    *node_out = node;
    return value;
}

/** CreateDataProperty through the holder's actual [[DefineOwnProperty]]. */
static bool mal_json_internalize_set(MalVm *vm, MalValue holder, MalKey key, MalValue value) {
    MalPropertyDescriptorParse desc = {
        .has_value = true,
        .has_writable = true,
        .has_enumerable = true,
        .has_configurable = true,
        .desc = mal_intrinsic_data_desc(
            value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE),
    };
    (void) mal_builtin_object_define_own_property_parsed(vm, holder, key, &desc);
    // InternalizeJSONProperty performs ? CreateDataProperty: a normal false is
    // ignored, while an abrupt completion propagates.
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

static bool mal_json_parse_child_key_equals(
    MalJsonParseState *state, const MalJsonParseChild *child, MalKey key
) {
    if (child->key.kind != key.kind) {
        return false;
    }
    if (key.kind == MAL_KEY_INDEX) {
        return mal_key_index_value(child->key) == mal_key_index_value(key);
    }
    MalValue child_value = state->roots.values[child->key_root_index];
    if (key.kind == MAL_KEY_STRING) {
        return mal_string_equals(
            mal_value_to_string(child_value), mal_value_to_string(key.value));
    }
    return child_value == key.value;
}

static MalJsonParseNode *mal_json_parse_array_child(
    MalJsonParseNode *node, u32 index
) {
    if (node == nullptr || node->kind != MAL_JSON_PARSE_ARRAY ||
        index >= node->child_count) {
        return nullptr;
    }
    return node->children[index].node;
}

static usize mal_json_parse_key_hash(MalKey key) {
    if (key.kind == MAL_KEY_STRING) {
        return (usize) mal_string_hash(mal_value_to_string(key.value));
    }
    return mal_json_pointer_hash((const void *) (uintptr_t) key.value);
}

static MalJsonParseNode *mal_json_parse_object_child(
    MalJsonParseState *state, MalJsonParseNode *node, MalKey key
) {
    if (node == nullptr || node->kind != MAL_JSON_PARSE_OBJECT ||
        node->child_count == 0) {
        return nullptr;
    }
    if (node->key_index == nullptr) {
        usize capacity = 16;
        while (capacity / 2 < node->child_count) {
            if (capacity > SIZE_MAX / 2) abort();
            capacity *= 2;
        }
        node->key_index = calloc(capacity, sizeof(*node->key_index));
        if (node->key_index == nullptr) abort();
        node->key_index_capacity = capacity;
        MAL_PERF_ADD(json_reviver_index_entries, node->child_count);
        for (usize i = 0; i < node->child_count; i++) {
            MalJsonParseChild *child = &node->children[i];
            usize slot = mal_json_parse_key_hash(child->key) & (capacity - 1);
            for (;;) {
                MAL_PERF_COUNT(json_reviver_index_probes);
                if (node->key_index[slot] == 0 ||
                    mal_json_parse_child_key_equals(state,
                        &node->children[node->key_index[slot] - 1], child->key)) break;
                slot = (slot + 1) & (capacity - 1);
            }
            // Keep the final duplicate's token without changing property order.
            node->key_index[slot] = i + 1;
        }
    }
    usize mask = node->key_index_capacity - 1;
    usize slot = mal_json_parse_key_hash(key) & mask;
    for (;;) {
        MAL_PERF_COUNT(json_reviver_index_probes);
        if (node->key_index[slot] == 0) break;
        MalJsonParseChild *child = &node->children[node->key_index[slot] - 1];
        if (mal_json_parse_child_key_equals(state, child, key)) return child->node;
        slot = (slot + 1) & mask;
    }
    return nullptr;
}

/**
 * InternalizeJSONProperty(holder, name, reviver): recurse into the value's
 * elements/properties (deleting members the reviver maps to undefined, replacing
 * the rest), then call the reviver with (name, value) and `holder` as `this`.
 * Returns false with a pending throw on any abrupt completion.
 */
static bool mal_json_internalize(
    MalVm *vm, MalValue reviver, MalValue holder, MalValue name,
    MalJsonParseState *parse_state, MalJsonParseNode *parse_node,
    MalValue *out, usize depth
) {
    // Get(holder, name): `name` is a String (ToString of the array index or the
    // object key). Canonicalize it to a property key so a numeric index string
    // ("0","1",…) resolves to the dense array element — a raw MAL_KEY_STRING never
    // reaches the dense-element vector and would read undefined. `name` itself stays
    // the String for the reviver's key argument below.
    MalValue roots[6] = {
        reviver, holder, name, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 6);
    bool ok = false;
    MalKey get_key;
    if (!mal_vm_value_to_property_key(vm, roots[2], &get_key)) {
        goto done;
    }
    if (!mal_vm_get_property(vm, roots[1], get_key, &roots[3])) {
        goto done;
    }
    if (parse_node != nullptr && !mal_ops_same_value(
            roots[3], parse_state->roots.values[parse_node->value_root_index])) {
        parse_node = nullptr;
    }

    if (mal_value_is_object(roots[3])) {
        if (!mal_json_check_depth(vm, depth)) goto done;
        bool is_array;
        if (!mal_vm_is_array(vm, roots[3], &is_array)) {
            goto done;
        }
        if (is_array) {
            u32 length;
            if (!mal_builtin_array_this_length(vm, roots[3], &length)) {
                goto done;
            }
            for (u32 i = 0; i < length; i++) {
                MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i)));
                MalValue new_element;
                MalJsonParseNode *element_node = mal_json_parse_array_child(
                    parse_node, i);
                if (!mal_json_internalize(
                        vm, roots[0], roots[3], key_string,
                        parse_state, element_node, &new_element, depth + 1)) {
                    goto done;
                }
                MalKey element_key = mal_key_index(i);
                if (mal_value_is_undefined(new_element)) {
                    if (!mal_vm_delete_property(vm, roots[3], element_key) && vm->completion.kind == MAL_COMPLETION_THROW) {
                        goto done;
                    }
                } else if (!mal_json_internalize_set(vm, roots[3], element_key, new_element)) {
                    goto done;
                }
            }
        } else {
            // EnumerableOwnProperties snapshots [[OwnPropertyKeys]], then checks
            // each string key's current [[GetOwnProperty]] descriptor.
            MalRootedKeySnapshot own_keys;
            MalRootedKeySnapshot keys;
            mal_rooted_key_snapshot_init(&own_keys);
            mal_rooted_key_snapshot_init(&keys);
            bool keys_ok = mal_rooted_key_snapshot_own_keys(
                vm, roots[3], &own_keys);
            for (usize i = 0; keys_ok && i < own_keys.count; i++) {
                if (own_keys.keys[i].kind == MAL_KEY_SYMBOL) {
                    continue;
                }
                bool present;
                MalPropertyDesc desc;
                if (!mal_vm_get_own_property(
                        vm, roots[3], own_keys.keys[i], &present, &desc)) {
                    keys_ok = false;
                    break;
                }
                if (present && (desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                    mal_rooted_key_snapshot_append(&keys, own_keys.keys[i]);
                }
            }
            for (usize i = 0; keys_ok && i < keys.count; i++) {
                MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, keys.keys[i].value));
                MalValue new_element;
                MalJsonParseNode *property_node = mal_json_parse_object_child(
                    parse_state, parse_node, keys.keys[i]);
                if (!mal_json_internalize(
                        vm, roots[0], roots[3], key_string,
                        parse_state, property_node, &new_element, depth + 1)) {
                    keys_ok = false;
                    break;
                }
                if (mal_value_is_undefined(new_element)) {
                    if (!mal_vm_delete_property(vm, roots[3], keys.keys[i]) && vm->completion.kind == MAL_COMPLETION_THROW) {
                        keys_ok = false;
                        break;
                    }
                } else if (!mal_json_internalize_set(vm, roots[3], keys.keys[i], new_element)) {
                    keys_ok = false;
                    break;
                }
            }
            // Root spans are stack-linked: unwind the snapshots in reverse order.
            mal_rooted_key_snapshot_dispose(&keys);
            mal_rooted_key_snapshot_dispose(&own_keys);
            if (!keys_ok) {
                goto done;
            }
        }
    }

    roots[4] = mal_value_from_object(mal_intrinsic_new_object(vm));
    if (parse_node != nullptr && !mal_value_is_object(roots[3])) {
        MalString *source = mal_value_to_string(parse_state->roots.values[0]);
        roots[5] = mal_value_from_string(mal_string_new_slice(
            &vm->heap, source, parse_node->source_start,
            parse_node->source_end - parse_node->source_start));
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[4]), "source", roots[5],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
    }
    MalValue reviver_args[3] = {roots[2], roots[3], roots[4]};
    MalCompletion completion = mal_vm_call_value(
        vm, roots[0], roots[1], reviver_args, 3);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        goto done;
    }
    *out = completion.value;
    ok = true;

done:
    mal_gc_unroot(&roots_span);
    return ok;
}

static MalValue mal_builtin_json_parse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // ToString(text) through the VM so an object argument runs toString/valueOf
    // (which may throw) and a Symbol throws a TypeError.
    MalString *text;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &text)) {
        return mal_value_new_undefined();
    }
    MalValue text_value = mal_value_from_string(text);
    MalRootSpan text_span;
    mal_gc_root(&text_span, &text_value, 1);

    MalValue reviver = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    bool track_source = mal_value_is_callable(reviver);

    MalJsonParseState parse_state = {0};
    if (track_source) {
        mal_rooted_value_list_init(&parse_state.roots);
        mal_rooted_value_list_append(&parse_state.roots, text_value);
    }
    MalJsonParser parser = {
        .vm = vm,
        .source = text,
        .length = mal_string_length(text),
        .position = 0,
        .state = track_source ? &parse_state : nullptr,
    };

    mal_json_parser_init(&parser);
    MalJsonParseNode *root_node = nullptr;
    MalValue result = mal_json_parse_value(&parser, &root_node);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_json_parse_node_dispose(root_node);
        if (track_source) {
            mal_rooted_value_list_dispose(&parse_state.roots);
        }
        mal_string_iterator_dispose(&parser.iterator);
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }
    if (track_source) {
        result = parse_state.roots.values[root_node->value_root_index];
    }

    mal_json_skip_whitespace(&parser);
    if (parser.position != parser.length) {
        mal_json_parse_error(&parser);
        mal_json_parse_node_dispose(root_node);
        if (track_source) {
            mal_rooted_value_list_dispose(&parse_state.roots);
        }
        mal_string_iterator_dispose(&parser.iterator);
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }

    // A callable reviver walks the result bottom-up via InternalizeJSONProperty,
    // rooted in {"" : result}.
    if (track_source) {
        MalObject *root = mal_intrinsic_new_object(vm);
        MalValue empty_key = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        mal_intrinsic_define_data(vm, root, "", result, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        MalValue revived;
        if (!mal_json_internalize(
                vm, reviver, mal_value_from_object(root), empty_key,
                &parse_state, root_node, &revived, 0)) {
            mal_json_parse_node_dispose(root_node);
            mal_rooted_value_list_dispose(&parse_state.roots);
            mal_string_iterator_dispose(&parser.iterator);
            mal_gc_unroot(&text_span);
            return mal_value_new_undefined();
        }
        mal_json_parse_node_dispose(root_node);
        mal_rooted_value_list_dispose(&parse_state.roots);
        mal_string_iterator_dispose(&parser.iterator);
        mal_gc_unroot(&text_span);
        return revived;
    }

    mal_string_iterator_dispose(&parser.iterator);
    mal_gc_unroot(&text_span);
    return result;
}

MalValue mal_builtin_json_parse_intrinsic(MalVm *vm, MalValue text) {
    return mal_builtin_json_parse(
        vm, mal_value_new_undefined(), &text, 1,
        mal_value_new_undefined(), mal_value_new_undefined());
}

static bool mal_json_is_json_whitespace(c16 c) {
    return c == ' ' || c == '\t' || c == '\n' || c == '\r';
}

/** JSON.isRawJSON(O): true iff O is an object with the [[IsRawJSON]] slot. */
static MalValue mal_builtin_json_is_raw_json(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    return mal_value_new_boolean(mal_value_is_object(value) && mal_value_to_object(value)->is_raw_json);
}

/**
 * JSON.rawJSON(text): ToString, reject empty / whitespace-edged / invalid JSON,
 * then return a frozen null-prototype object carrying the text as "rawJSON" and
 * the internal [[IsRawJSON]] marker.
 */
static MalValue mal_builtin_json_raw_json(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *text;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &text)) {
        return mal_value_new_undefined();
    }
    usize length = mal_string_length(text);
    if (length == 0 ||
        mal_json_is_json_whitespace(mal_string_code_unit_at(text, 0)) ||
        mal_json_is_json_whitespace(mal_string_code_unit_at(text, length - 1))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        return mal_value_new_undefined();
    }

    // Validate as a complete JSON text (rejecting trailing content).
    MalValue text_value = mal_value_from_string(text);
    MalRootSpan text_span;
    mal_gc_root(&text_span, &text_value, 1);
    MalJsonParser parser = {
        .vm = vm,
        .source = text,
        .length = length,
        .position = 0,
        .state = nullptr,
    };
    mal_json_parser_init(&parser);
    MalJsonParseNode *root_node = nullptr;
    mal_json_parse_value(&parser, &root_node);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_string_iterator_dispose(&parser.iterator);
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }
    mal_json_skip_whitespace(&parser);
    if (parser.position != length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        mal_string_iterator_dispose(&parser.iterator);
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }

    MalObject *object = mal_object_new(&vm->heap, nullptr);
    mal_intrinsic_define_data(
        vm, object, "rawJSON", text_value,
        MAL_PROPERTY_ENUMERABLE);
    object->is_raw_json = true;
    object->extensible = false;
    mal_string_iterator_dispose(&parser.iterator);
    mal_gc_unroot(&text_span);
    return mal_value_from_object(object);
}

void mal_builtin_json_install(MalVm *vm) {
    MalObject *json = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_JSON] = mal_value_from_object(json);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "JSON")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(json, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method_n(vm, json, "stringify", 3, mal_builtin_json_stringify);
    mal_intrinsic_define_method_n(vm, json, "parse", 2, mal_builtin_json_parse);
    mal_intrinsic_define_method_n(vm, json, "rawJSON", 1, mal_builtin_json_raw_json);
    mal_intrinsic_define_method_n(vm, json, "isRawJSON", 1, mal_builtin_json_is_raw_json);
}

#include "generated/known_native_builtin_json_c.inc"
