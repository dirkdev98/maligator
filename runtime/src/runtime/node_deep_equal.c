#include "node_deep_equal.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "builtin_error.h"
#include "date_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "map_object.h"
#include "object.h"
#include "object_ops.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "set_object.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm_ops.h"

typedef struct DeepCtx {
    MalVm *vm;
    MalNodeDeepEqualMode mode;
    MalObject **path;
    usize path_count;
    usize path_capacity;
} DeepCtx;

typedef struct DeepKeys {
    MalValue *items;
    usize count;
    usize capacity;
    MalRootSpan root;
    bool rooted;
} DeepKeys;

enum { DEEP_FALSE = 0, DEEP_TRUE = 1, DEEP_THROW = -1 };

static i32 deep_equal(DeepCtx *ctx, MalValue a, MalValue b);

static bool deep_throwing(const DeepCtx *ctx) {
    return ctx->vm->completion.kind == MAL_COMPLETION_THROW;
}

static void deep_keys_push(DeepKeys *keys, MalValue key) {
    if (keys->count == keys->capacity) {
        usize capacity = keys->capacity == 0 ? 8 : keys->capacity * 2;
        MalValue *items = realloc(keys->items, capacity * sizeof(MalValue));
        if (items == nullptr) return;
        if (keys->rooted) mal_gc_unroot(&keys->root);
        for (usize i = keys->count; i < capacity; i++) items[i] = mal_value_new_undefined();
        keys->items = items;
        keys->capacity = capacity;
        mal_gc_root(&keys->root, keys->items, (i32) capacity);
        keys->rooted = true;
    }
    keys->items[keys->count++] = key;
}

static void deep_keys_dispose(DeepKeys *keys) {
    if (keys->rooted) mal_gc_unroot(&keys->root);
    free(keys->items);
}

static bool deep_is_object(MalValue value) {
    return mal_value_is_object(value) && !mal_value_is_callable(value);
}

static MalObject *deep_object(MalValue value) {
    return mal_value_to_object(mal_proxy_unwrap_target(value));
}

static bool deep_is_stack_key(MalValue key) {
    return mal_value_is_string(key) && mal_string_equals_ascii(mal_value_to_string(key), (const byte *) "stack");
}

// Own enumerable keys in OwnPropertyKeys order; `indices` false drops integer-indexed keys.
static void deep_collect_filtered(MalObject *object, DeepKeys *keys, bool strings, bool symbols, bool indices,
    bool skip_stack) {
    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc desc;
    if (strings) {
        mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL || (!indices && key.kind == MAL_KEY_INDEX)) continue;
            if ((desc.flags & MAL_PROPERTY_ENUMERABLE) == 0) continue;
            if (skip_stack && deep_is_stack_key(key.value)) continue;
            deep_keys_push(keys, key.value);
        }
    }
    if (symbols) {
        mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_SYMBOL_OWN_PROPERTY_ORDER);
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind != MAL_KEY_SYMBOL || (desc.flags & MAL_PROPERTY_ENUMERABLE) == 0) continue;
            deep_keys_push(keys, key.value);
        }
    }
}


static bool deep_own_enumerable(MalObject *object, MalValue key) {
    MalPropertyResolution found = mal_object_resolve_property(object, mal_key_from_value(key));
    return found.found && found.own && (found.desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
}

static bool deep_has_own(MalObject *object, MalValue key) {
    MalPropertyResolution found = mal_object_resolve_property(object, mal_key_from_value(key));
    return found.found && found.own;
}

static i32 deep_get(DeepCtx *ctx, MalValue object, MalValue key, MalValue *out) {
    if (!mal_vm_get_property(ctx->vm, object, mal_key_from_value(key), out) || deep_throwing(ctx)) {
        return DEEP_THROW;
    }
    return DEEP_TRUE;
}

static i32 deep_get_named(DeepCtx *ctx, MalValue object, const char *name, MalValue *out) {
    if (!mal_vm_get_property(ctx->vm, object, mal_intrinsic_string_key(ctx->vm, (const byte *) name), out)
        || deep_throwing(ctx)) {
        return DEEP_THROW;
    }
    return DEEP_TRUE;
}

static const char *deep_builtin_tag(MalVm *vm, MalValue value) {
    if (mal_value_is_array_object(value)) return "Array";
    MalObject *object = mal_value_to_object(value);
    if (object->is_arguments) return "Arguments";
    if (mal_value_is_callable(value)) return "Function";
    if (mal_builtin_value_has_error_data(vm, value)) return "Error";
    if (mal_value_is_primitive_wrapper(value)) {
        switch (mal_value_to_primitive_wrapper(value)->kind) {
            case MAL_PRIMITIVE_WRAPPER_BOOLEAN: return "Boolean";
            case MAL_PRIMITIVE_WRAPPER_NUMBER: return "Number";
            case MAL_PRIMITIVE_WRAPPER_STRING: return "String";
            default: return "Object";
        }
    }
    if (mal_value_is_date_object(value)) return "Date";
    if (mal_value_is_regexp_object(value)) return "RegExp";
    return "Object";
}

// Object.prototype.toString's tag: Symbol.toStringTag when it is a string, else the builtin tag.
static i32 deep_tag(DeepCtx *ctx, MalValue value, MalValue *tag, const char **builtin) {
    *builtin = deep_builtin_tag(ctx->vm, value);
    MalValue symbol = ctx->vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (deep_get(ctx, value, symbol, tag) != DEEP_TRUE) return DEEP_THROW;
    if (!mal_value_is_string(*tag)) *tag = mal_value_new_undefined();
    return DEEP_TRUE;
}

static bool deep_tags_equal(MalValue tag_a, const char *builtin_a, MalValue tag_b, const char *builtin_b) {
    if (mal_value_is_string(tag_a) || mal_value_is_string(tag_b)) {
        if (mal_value_is_string(tag_a) && mal_value_is_string(tag_b)) {
            return mal_string_equals(mal_value_to_string(tag_a), mal_value_to_string(tag_b));
        }
        MalValue tag = mal_value_is_string(tag_a) ? tag_a : tag_b;
        const char *builtin = mal_value_is_string(tag_a) ? builtin_b : builtin_a;
        MalString *string = mal_value_to_string(tag);
        usize length = strlen(builtin);
        if (mal_string_length(string) != length) return false;
        const c16 *units = mal_string_code_units(string);
        for (usize i = 0; i < length; i++) {
            if (units[i] != (c16) builtin[i]) return false;
        }
        return true;
    }
    return strcmp(builtin_a, builtin_b) == 0;
}

static i32 deep_path_check(DeepCtx *ctx, MalObject *a, MalObject *b) {
    bool has_a = false, has_b = false;
    for (usize i = 0; i < ctx->path_count; i++) {
        if (ctx->path[i] == a) has_a = true;
        if (ctx->path[i] == b) has_b = true;
    }
    if (!has_a && !has_b) return -2;
    return has_a && has_b ? DEEP_TRUE : DEEP_FALSE;
}

static bool deep_path_push(DeepCtx *ctx, MalObject *a, MalObject *b) {
    if (ctx->path_count + 2 > ctx->path_capacity) {
        usize capacity = ctx->path_capacity == 0 ? 32 : ctx->path_capacity * 2;
        MalObject **path = realloc(ctx->path, capacity * sizeof(MalObject *));
        if (path == nullptr) return false;
        ctx->path = path;
        ctx->path_capacity = capacity;
    }
    ctx->path[ctx->path_count++] = a;
    ctx->path[ctx->path_count++] = b;
    return true;
}

static i32 deep_values_at(DeepCtx *ctx, MalValue a, MalValue b, MalValue key) {
    MalValue values[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, values, 2);
    i32 result = deep_get(ctx, a, key, &values[0]);
    if (result == DEEP_TRUE) result = deep_get(ctx, b, key, &values[1]);
    if (result == DEEP_TRUE) result = deep_equal(ctx, values[0], values[1]);
    mal_gc_unroot(&root);
    return result;
}

static i32 deep_partial_set(DeepCtx *ctx, MalSetObject *set_a, MalSetObject *set_b) {
    DeepKeys candidates = {0};
    MalValue item = MAL_VALUE_UNDEFINED;
    MalRootSpan root;
    mal_gc_root(&root, &item, 1);
    i32 result = DEEP_TRUE;
    MalSetIter iter;
    mal_set_iter_init(&iter, mal_set_object_storage(set_a));
    while (mal_set_iter_next(&iter, &item)) {
        if (deep_is_object(item)) deep_keys_push(&candidates, item);
    }
    mal_set_iter_init(&iter, mal_set_object_storage(set_b));
    while (result == DEEP_TRUE && mal_set_iter_next(&iter, &item)) {
        if (mal_set_object_has(set_a, item)) continue;
        if (!deep_is_object(item)) {
            result = DEEP_FALSE;
            break;
        }
        bool matched = false;
        for (usize i = 0; i < candidates.count && !matched; i++) {
            i32 equal = deep_equal(ctx, candidates.items[i], item);
            if (equal == DEEP_THROW) result = DEEP_THROW;
            if (equal == DEEP_TRUE) {
                candidates.items[i] = candidates.items[--candidates.count];
                matched = true;
            }
        }
        if (!matched && result == DEEP_TRUE) result = DEEP_FALSE;
    }
    mal_gc_unroot(&root);
    deep_keys_dispose(&candidates);
    return result;
}

static i32 deep_set_equiv(DeepCtx *ctx, MalValue a, MalValue b) {
    MalSetObject *set_a = mal_value_to_set_object(a);
    MalSetObject *set_b = mal_value_to_set_object(b);
    if (ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL) return deep_partial_set(ctx, set_a, set_b);
    DeepKeys pending = {0};
    MalValue item = MAL_VALUE_UNDEFINED;
    MalRootSpan root;
    mal_gc_root(&root, &item, 1);
    i32 result = DEEP_TRUE;
    MalSetIter iter;
    mal_set_iter_init(&iter, mal_set_object_storage(set_a));
    while (mal_set_iter_next(&iter, &item)) {
        if (deep_is_object(item)) {
            if (!mal_set_object_has(set_b, item)) deep_keys_push(&pending, item);
        } else if (!mal_set_object_has(set_b, item)) {
            if (ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE) {
                result = DEEP_FALSE;
                goto done;
            }
            deep_keys_push(&pending, item);
        }
    }
    mal_set_iter_init(&iter, mal_set_object_storage(set_b));
    while (mal_set_iter_next(&iter, &item)) {
        if (mal_set_object_has(set_a, item)) continue;
        if (!deep_is_object(item) && ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE) continue;
        bool matched = false;
        for (usize i = 0; i < pending.count; i++) {
            i32 equal = deep_equal(ctx, pending.items[i], item);
            if (equal == DEEP_THROW) {
                result = DEEP_THROW;
                goto done;
            }
            if (equal == DEEP_TRUE) {
                pending.items[i] = pending.items[--pending.count];
                matched = true;
                break;
            }
        }
        if (!matched) {
            result = DEEP_FALSE;
            goto done;
        }
    }
    result = pending.count == 0 || ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL ? DEEP_TRUE : DEEP_FALSE;
done:
    mal_gc_unroot(&root);
    deep_keys_dispose(&pending);
    return result;
}

static i32 deep_partial_map(DeepCtx *ctx, MalMapObject *map_a, MalMapObject *map_b) {
    MalValue pair[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, pair, 2);
    i32 result = DEEP_TRUE;
    MalMapIter iter;
    mal_map_iter_init(&iter, mal_map_object_storage(map_b));
    while (result == DEEP_TRUE && mal_map_iter_next(&iter, &pair[0], &pair[1])) {
        if (!mal_map_object_has(map_a, pair[0])) {
            result = DEEP_FALSE;
            break;
        }
        result = deep_equal(ctx, mal_map_object_get(map_a, pair[0]), pair[1]);
    }
    mal_gc_unroot(&root);
    return result;
}

static i32 deep_map_equiv(DeepCtx *ctx, MalValue a, MalValue b) {
    MalMapObject *map_a = mal_value_to_map_object(a);
    MalMapObject *map_b = mal_value_to_map_object(b);
    if (ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL) return deep_partial_map(ctx, map_a, map_b);
    DeepKeys pending = {0};
    MalValue pair[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, pair, 3);
    i32 result = DEEP_TRUE;
    MalMapIter iter;
    mal_map_iter_init(&iter, mal_map_object_storage(map_a));
    while (mal_map_iter_next(&iter, &pair[0], &pair[1])) {
        if (deep_is_object(pair[0])) {
            deep_keys_push(&pending, pair[0]);
            continue;
        }
        bool present = mal_map_object_has(map_b, pair[0]);
        i32 equal = present ? deep_equal(ctx, pair[1], mal_map_object_get(map_b, pair[0])) : DEEP_FALSE;
        if (equal == DEEP_THROW) {
            result = DEEP_THROW;
            goto done;
        }
        if (equal == DEEP_FALSE) {
            if (ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE) {
                result = DEEP_FALSE;
                goto done;
            }
            deep_keys_push(&pending, pair[0]);
        }
    }
    mal_map_iter_init(&iter, mal_map_object_storage(map_b));
    while (mal_map_iter_next(&iter, &pair[0], &pair[1])) {
        if (!deep_is_object(pair[0])) {
            if (ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE) continue;
            if (mal_map_object_has(map_a, pair[0])) {
                i32 equal = deep_equal(ctx, mal_map_object_get(map_a, pair[0]), pair[1]);
                if (equal == DEEP_THROW) {
                    result = DEEP_THROW;
                    goto done;
                }
                if (equal == DEEP_TRUE) continue;
            }
        }
        bool matched = false;
        for (usize i = 0; i < pending.count; i++) {
            i32 equal = deep_equal(ctx, pending.items[i], pair[0]);
            if (equal == DEEP_TRUE) {
                pair[2] = mal_map_object_get(map_a, pending.items[i]);
                equal = deep_equal(ctx, pair[2], pair[1]);
            }
            if (equal == DEEP_THROW) {
                result = DEEP_THROW;
                goto done;
            }
            if (equal == DEEP_TRUE) {
                pending.items[i] = pending.items[--pending.count];
                matched = true;
                break;
            }
        }
        if (!matched) {
            result = DEEP_FALSE;
            goto done;
        }
    }
    result = pending.count == 0 || ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL ? DEEP_TRUE : DEEP_FALSE;
done:
    mal_gc_unroot(&root);
    deep_keys_dispose(&pending);
    return result;
}

static bool deep_bytes(MalValue value, const byte **data, usize *length) {
    if (mal_value_is_typed_array_object(value)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            *data = nullptr;
            *length = 0;
            return true;
        }
        MalArrayBufferObject *buffer = array->buffer;
        *data = buffer->data + array->byte_offset;
        *length = mal_typed_array_object_byte_length(array);
        return true;
    }
    if (mal_value_is_data_view_object(value)) return false;
    if (mal_value_is_array_buffer_object(value)) {
        MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(value);
        *data = buffer->detached ? nullptr : buffer->data;
        *length = buffer->detached ? 0 : buffer->byte_length;
        return true;
    }
    return false;
}

static i32 deep_typed_arrays(DeepCtx *ctx, MalValue a, MalValue b) {
    if (!mal_value_is_typed_array_object(b)) return DEEP_FALSE;
    MalTypedArrayObject *array_a = mal_value_to_typed_array_object(a);
    MalTypedArrayObject *array_b = mal_value_to_typed_array_object(b);
    if (array_a->kind != array_b->kind) return DEEP_FALSE;
    u32 length_a = mal_typed_array_object_length(array_a);
    u32 length_b = mal_typed_array_object_length(array_b);
    if (ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL && length_a != length_b) {
        if (length_a < length_b) return DEEP_FALSE;
        for (u32 i = 0, j = 0; j < length_b; i++) {
            if (i == length_a) return DEEP_FALSE;
            MalValue x = mal_typed_array_object_get(ctx->vm, array_a, i);
            MalValue y = mal_typed_array_object_get(ctx->vm, array_b, j);
            if (mal_ops_same_value(x, y)) j++;
        }
        return DEEP_TRUE;
    }
    if (length_a != length_b) return DEEP_FALSE;
    if (ctx->mode == MAL_NODE_DEEP_EQUAL_LOOSE
        && (array_a->kind == MAL_TA_FLOAT32 || array_a->kind == MAL_TA_FLOAT64)) {
        for (u32 i = 0; i < length_a; i++) {
            f64 x = mal_ops_number_as_f64(mal_typed_array_object_get(ctx->vm, array_a, i));
            f64 y = mal_ops_number_as_f64(mal_typed_array_object_get(ctx->vm, array_b, i));
            if (x != y) return DEEP_FALSE;
        }
        return DEEP_TRUE;
    }
    const byte *data_a, *data_b;
    usize bytes_a, bytes_b;
    deep_bytes(a, &data_a, &bytes_a);
    deep_bytes(b, &data_b, &bytes_b);
    return bytes_a == bytes_b && (bytes_a == 0 || memcmp(data_a, data_b, bytes_a) == 0) ? DEEP_TRUE : DEEP_FALSE;
}

// Node's keyCheck + objEquiv for ordinary, array-like, Set and Map objects.
static i32 deep_keys_equal(DeepCtx *ctx, MalValue a, MalValue b, bool array_like, i32 iteration) {
    MalObject *object_a = deep_object(a);
    MalObject *object_b = deep_object(b);
    bool symbols = ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE;
    DeepKeys keys_a = {0}, keys_b = {0};
    i32 result = DEEP_TRUE;
    // Errors never compare stacks; an assigned stack can be an own enumerable property here.
    bool skip_stack = mal_builtin_value_has_error_data(ctx->vm, a);
    deep_collect_filtered(object_b, &keys_b, true, symbols, !array_like, skip_stack);
    deep_collect_filtered(object_a, &keys_a, true, symbols, !array_like, skip_stack);
    if (ctx->mode != MAL_NODE_DEEP_EQUAL_PARTIAL && keys_a.count != keys_b.count) {
        result = DEEP_FALSE;
        goto done;
    }
    for (usize i = 0; i < keys_b.count; i++) {
        if (!deep_own_enumerable(object_a, keys_b.items[i])) {
            result = DEEP_FALSE;
            goto done;
        }
    }
    i32 cycle = deep_path_check(ctx, object_a, object_b);
    if (cycle != -2) {
        result = cycle;
        goto done;
    }
    if (!deep_path_push(ctx, object_a, object_b)) goto done;
    if (iteration == 1) {
        result = deep_set_equiv(ctx, a, b);
    } else if (iteration == 2) {
        result = deep_map_equiv(ctx, a, b);
    } else if (mal_value_is_array_object(a)) {
        u32 length_a = mal_array_object_length(mal_value_to_array_object(a));
        u32 length_b = mal_array_object_length(mal_value_to_array_object(b));
        if (ctx->mode == MAL_NODE_DEEP_EQUAL_PARTIAL) {
            // Partial arrays match expected elements in order against a subsequence of actual.
            u32 j = 0;
            for (u32 i = 0; i < length_a && j < length_b && result != DEEP_THROW; i++) {
                MalValue key = mal_value_from_i32((i32) j);
                MalValue key_a = mal_value_from_i32((i32) i);
                MalValue values[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
                MalRootSpan root;
                mal_gc_root(&root, values, 2);
                if (deep_get(ctx, a, key_a, &values[0]) != DEEP_TRUE || deep_get(ctx, b, key, &values[1]) != DEEP_TRUE) {
                    result = DEEP_THROW;
                } else {
                    i32 equal = deep_equal(ctx, values[0], values[1]);
                    if (equal == DEEP_THROW) result = DEEP_THROW;
                    else if (equal == DEEP_TRUE) j++;
                }
                mal_gc_unroot(&root);
            }
            if (result != DEEP_THROW && j < length_b) result = DEEP_FALSE;
        } else {
            for (u32 i = 0; i < length_a && result == DEEP_TRUE; i++) {
                MalValue key = mal_value_from_i32((i32) i);
                bool own_a = deep_has_own(object_a, key);
                bool own_b = i < length_b && deep_has_own(object_b, key);
                if (own_a != own_b) result = DEEP_FALSE;
                else if (own_a) result = deep_values_at(ctx, a, b, key);
            }
        }
    }
    for (usize i = 0; i < keys_b.count && result == DEEP_TRUE; i++) {
        result = deep_values_at(ctx, a, b, keys_b.items[i]);
    }
    ctx->path_count -= 2;
done:
    deep_keys_dispose(&keys_a);
    deep_keys_dispose(&keys_b);
    return result;
}

static i32 deep_errors(DeepCtx *ctx, MalValue a, MalValue b) {
    MalValue values[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, values, 4);
    i32 result = DEEP_TRUE;
    static const char *const fields[] = {"message", "name"};
    for (usize i = 0; i < countof(fields) && result == DEEP_TRUE; i++) {
        if (deep_get_named(ctx, a, fields[i], &values[0]) != DEEP_TRUE
            || deep_get_named(ctx, b, fields[i], &values[1]) != DEEP_TRUE) {
            result = DEEP_THROW;
        } else if (!mal_ops_strict_equal_bool(values[0], values[1])) {
            result = DEEP_FALSE;
        }
    }
    static const char *const nested[] = {"cause", "errors"};
    for (usize i = 0; i < countof(nested) && result == DEEP_TRUE; i++) {
        MalValue key = mal_value_from_string(mal_intrinsic_ascii(ctx->vm, (const byte *) nested[i]));
        values[2] = key;
        bool own_a = deep_has_own(deep_object(a), key);
        bool own_b = deep_has_own(deep_object(b), key);
        if (own_a != own_b) {
            result = DEEP_FALSE;
        } else if (own_a && !deep_own_enumerable(deep_object(a), key)) {
            result = deep_values_at(ctx, a, b, values[2]);
        }
    }
    mal_gc_unroot(&root);
    return result;
}

static i32 deep_boxed(MalValue a, MalValue b) {
    if (!mal_value_is_primitive_wrapper(b)) return DEEP_FALSE;
    MalPrimitiveWrapperObject *wrapper_a = mal_value_to_primitive_wrapper(a);
    MalPrimitiveWrapperObject *wrapper_b = mal_value_to_primitive_wrapper(b);
    if (wrapper_a->kind != wrapper_b->kind) return DEEP_FALSE;
    if (wrapper_a->kind == MAL_PRIMITIVE_WRAPPER_SYMBOL) {
        return wrapper_a->primitive_data == wrapper_b->primitive_data ? DEEP_TRUE : DEEP_FALSE;
    }
    return mal_ops_same_value(wrapper_a->primitive_data, wrapper_b->primitive_data) ? DEEP_TRUE : DEEP_FALSE;
}

static i32 deep_regexps(DeepCtx *ctx, MalValue a, MalValue b) {
    if (!mal_value_is_regexp_object(b)) return DEEP_FALSE;
    static const char *const fields[] = {"source", "flags", "lastIndex"};
    MalValue values[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, values, 2);
    i32 result = DEEP_TRUE;
    for (usize i = 0; i < countof(fields) && result == DEEP_TRUE; i++) {
        if (deep_get_named(ctx, a, fields[i], &values[0]) != DEEP_TRUE
            || deep_get_named(ctx, b, fields[i], &values[1]) != DEEP_TRUE) {
            result = DEEP_THROW;
        } else if (!mal_ops_strict_equal_bool(values[0], values[1])) {
            result = DEEP_FALSE;
        }
    }
    mal_gc_unroot(&root);
    return result;
}

static i32 deep_objects(DeepCtx *ctx, MalValue a, MalValue b) {
    MalVm *vm = ctx->vm;
    MalObject *object_a = deep_object(a);
    MalObject *object_b = deep_object(b);
    if (ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE
        && mal_object_get_prototype(object_a) != mal_object_get_prototype(object_b)) {
        return DEEP_FALSE;
    }
    MalValue tags[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, tags, 2);
    const char *builtin_a, *builtin_b;
    i32 result = deep_tag(ctx, a, &tags[0], &builtin_a);
    if (result == DEEP_TRUE) result = deep_tag(ctx, b, &tags[1], &builtin_b);
    if (result == DEEP_TRUE && !deep_tags_equal(tags[0], builtin_a, tags[1], builtin_b)) result = DEEP_FALSE;
    mal_gc_unroot(&root);
    if (result != DEEP_TRUE) return result;
    a = mal_proxy_unwrap_target(a);
    b = mal_proxy_unwrap_target(b);
    if (mal_value_is_array_object(a)) {
        if (!mal_value_is_array_object(b)) return DEEP_FALSE;
        u32 length_a = mal_array_object_length(mal_value_to_array_object(a));
        u32 length_b = mal_array_object_length(mal_value_to_array_object(b));
        if (length_a != length_b && (ctx->mode != MAL_NODE_DEEP_EQUAL_PARTIAL || length_a < length_b)) {
            return DEEP_FALSE;
        }
        return deep_keys_equal(ctx, a, b, true, 0);
    }
    if (strcmp(builtin_a, "Object") == 0 && !mal_value_is_string(tags[0])
        && !mal_value_is_typed_array_object(a) && !mal_value_is_set_object(a) && !mal_value_is_map_object(a)
        && !mal_value_is_array_buffer_object(a) && !mal_value_is_data_view_object(a)
        && !mal_value_is_weak_map_object(a) && !mal_value_is_weak_set_object(a)
        && !mal_value_is_promise_object(a)) {
        if (mal_value_is_array_object(b) || mal_value_is_typed_array_object(b) || mal_value_is_set_object(b)
            || mal_value_is_map_object(b) || mal_value_is_array_buffer_object(b)
            || mal_value_is_date_object(b) || mal_value_is_regexp_object(b)) {
            return DEEP_FALSE;
        }
        return deep_keys_equal(ctx, a, b, false, 0);
    }
    if (mal_value_is_date_object(a)) {
        if (!mal_value_is_date_object(b)) return DEEP_FALSE;
        f64 time_a = mal_value_to_date_object(a)->date_value;
        f64 time_b = mal_value_to_date_object(b)->date_value;
        if (!(time_a == time_b || (isnan(time_a) && isnan(time_b)))) return DEEP_FALSE;
    } else if (mal_value_is_regexp_object(a)) {
        result = deep_regexps(ctx, a, b);
        if (result != DEEP_TRUE) return result;
    } else if (mal_value_is_typed_array_object(a)) {
        result = deep_typed_arrays(ctx, a, b);
        if (result != DEEP_TRUE) return result;
        return deep_keys_equal(ctx, a, b, true, 0);
    } else if (mal_value_is_data_view_object(a)) {
        if (!mal_value_is_data_view_object(b)) return DEEP_FALSE;
    } else if (mal_value_is_set_object(a)) {
        if (!mal_value_is_set_object(b)) return DEEP_FALSE;
        usize size_a = mal_set_object_size(mal_value_to_set_object(a));
        usize size_b = mal_set_object_size(mal_value_to_set_object(b));
        if (size_a != size_b && (ctx->mode != MAL_NODE_DEEP_EQUAL_PARTIAL || size_a < size_b)) return DEEP_FALSE;
        return deep_keys_equal(ctx, a, b, false, 1);
    } else if (mal_value_is_map_object(a)) {
        if (!mal_value_is_map_object(b)) return DEEP_FALSE;
        usize size_a = mal_map_object_size(mal_value_to_map_object(a));
        usize size_b = mal_map_object_size(mal_value_to_map_object(b));
        if (size_a != size_b && (ctx->mode != MAL_NODE_DEEP_EQUAL_PARTIAL || size_a < size_b)) return DEEP_FALSE;
        return deep_keys_equal(ctx, a, b, false, 2);
    } else if (mal_value_is_array_buffer_object(a)) {
        if (!mal_value_is_array_buffer_object(b)) return DEEP_FALSE;
        const byte *data_a, *data_b;
        usize bytes_a, bytes_b;
        deep_bytes(a, &data_a, &bytes_a);
        deep_bytes(b, &data_b, &bytes_b);
        if (bytes_a != bytes_b || (bytes_a > 0 && memcmp(data_a, data_b, bytes_a) != 0)) return DEEP_FALSE;
    } else if (mal_builtin_value_has_error_data(vm, a)) {
        if (!mal_builtin_value_has_error_data(vm, b)) return DEEP_FALSE;
        result = deep_errors(ctx, a, b);
        if (result != DEEP_TRUE) return result;
    } else if (mal_value_is_primitive_wrapper(a)) {
        result = deep_boxed(a, b);
        if (result != DEEP_TRUE) return result;
    } else if (mal_value_is_array_object(b) || mal_value_is_typed_array_object(b) || mal_value_is_set_object(b)
        || mal_value_is_map_object(b) || mal_value_is_date_object(b) || mal_value_is_regexp_object(b)
        || mal_value_is_array_buffer_object(b) || mal_value_is_primitive_wrapper(b)
        || mal_builtin_value_has_error_data(vm, b)) {
        return DEEP_FALSE;
    }
    return deep_keys_equal(ctx, a, b, false, 0);
}

static bool deep_number_is_nan(MalValue value) {
    return mal_ops_is_number(value) && isnan(mal_ops_number_as_f64(value));
}

static i32 deep_equal(DeepCtx *ctx, MalValue a, MalValue b) {
    if (mal_ops_strict_equal_bool(a, b)) {
        if (ctx->mode == MAL_NODE_DEEP_EQUAL_LOOSE || !mal_ops_is_number(a)) return DEEP_TRUE;
        return mal_ops_same_value(a, b) ? DEEP_TRUE : DEEP_FALSE;
    }
    if (ctx->mode != MAL_NODE_DEEP_EQUAL_LOOSE) {
        if (mal_ops_is_number(a)) return deep_number_is_nan(a) && deep_number_is_nan(b) ? DEEP_TRUE : DEEP_FALSE;
        if (!deep_is_object(a) || !deep_is_object(b)) return DEEP_FALSE;
    } else {
        if (!deep_is_object(a)) {
            if (deep_is_object(b)) return DEEP_FALSE;
            if (mal_value_is_object(a) || mal_value_is_object(b)) return DEEP_FALSE;
            if (mal_value_is_truthy(mal_ops_equal(a, b))) return DEEP_TRUE;
            return deep_number_is_nan(a) && deep_number_is_nan(b) ? DEEP_TRUE : DEEP_FALSE;
        }
        if (!deep_is_object(b)) return DEEP_FALSE;
    }
    return deep_objects(ctx, a, b);
}

bool mal_node_deep_equal(
    MalVm *vm, MalValue actual, MalValue expected, MalNodeDeepEqualMode mode, bool *equal) {
    DeepCtx ctx = {.vm = vm, .mode = mode};
    MalValue roots[2] = {actual, expected};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    i32 result = deep_equal(&ctx, roots[0], roots[1]);
    mal_gc_unroot(&root);
    free(ctx.path);
    *equal = result == DEEP_TRUE;
    return result != DEEP_THROW;
}

bool mal_node_myers_diff(
    usize actual_count, usize expected_count, MalNodeDiffEqual equal, void *data,
    MalNodeDiffOp **ops, usize *op_count) {
    *ops = nullptr;
    *op_count = 0;
    usize max = actual_count + expected_count;
    if (max == 0) return true;
    usize width = 2 * max + 1;
    i64 *v = calloc(width, sizeof(i64));
    i64 *trace = nullptr;
    usize levels = 0;
    bool found = false;
    if (v == nullptr) return false;
    for (usize level = 0; level <= max && !found; level++) {
        i64 *grown = realloc(trace, (levels + 1) * width * sizeof(i64));
        if (grown == nullptr) {
            free(trace);
            free(v);
            return false;
        }
        trace = grown;
        memcpy(trace + levels * width, v, width * sizeof(i64));
        levels++;
        i64 d = (i64) level;
        for (i64 k = -d; k <= d; k += 2) {
            usize offset = (usize) (k + (i64) max);
            i64 x = (k == -d || (k != d && v[offset - 1] < v[offset + 1])) ? v[offset + 1] : v[offset - 1] + 1;
            i64 y = x - k;
            while (x < (i64) actual_count && y < (i64) expected_count && equal(data, (usize) x, (usize) y)) {
                x++;
                y++;
            }
            v[offset] = x;
            if (x >= (i64) actual_count && y >= (i64) expected_count) {
                found = true;
                break;
            }
        }
    }
    free(v);
    MalNodeDiffOp *result = malloc((max + 1) * sizeof(MalNodeDiffOp));
    if (result == nullptr) {
        free(trace);
        return false;
    }
    usize count = 0;
    i64 x = (i64) actual_count, y = (i64) expected_count;
    for (i64 level = (i64) levels - 1; level >= 0; level--) {
        const i64 *row = trace + (usize) level * width;
        i64 k = x - y;
        usize offset = (usize) (k + (i64) max);
        i64 previous_k = (k == -level || (k != level && row[offset - 1] < row[offset + 1])) ? k + 1 : k - 1;
        i64 previous_x = row[previous_k + (i64) max];
        i64 previous_y = previous_x - previous_k;
        while (x > previous_x && y > previous_y) {
            result[count++] = (MalNodeDiffOp) {0, (usize) (x - 1), (usize) (y - 1)};
            x--;
            y--;
        }
        if (level > 0) {
            if (x > previous_x) {
                result[count++] = (MalNodeDiffOp) {1, (usize) (x - 1), 0};
                x--;
            } else {
                result[count++] = (MalNodeDiffOp) {-1, 0, (usize) (y - 1)};
                y--;
            }
        }
    }
    free(trace);
    *ops = result;
    *op_count = count;
    return true;
}

#endif /* MAL_NODE */
