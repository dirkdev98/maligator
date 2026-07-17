#include "builtin_json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_array.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

typedef struct MalJsonBuilder {
    MalVm *vm;
    c16 *code_units;
    usize length;
    usize capacity;
} MalJsonBuilder;

static bool mal_json_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static bool mal_json_builder_reserve(MalJsonBuilder *builder, usize extra) {
    usize required;
    if (!mal_checked_size_add(
            builder->length, extra, MAL_STRING_MAX_CODE_UNITS, &required)) {
        return mal_json_throw_string_length(builder->vm);
    }
    if (required <= builder->capacity) {
        return true;
    }
    usize capacity;
    usize bytes;
    if (!mal_checked_size_growth(
            builder->capacity, required, 64, MAL_STRING_MAX_CODE_UNITS, &capacity) ||
        !mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &bytes)) {
        return mal_json_throw_string_length(builder->vm);
    }
    c16 *grown = realloc(builder->code_units, bytes);
    if (grown == nullptr) {
        return mal_json_throw_string_length(builder->vm);
    }
    builder->code_units = grown;
    builder->capacity = capacity;
    return true;
}

static bool mal_json_builder_push(MalJsonBuilder *builder, c16 code_unit) {
    if (!mal_json_builder_reserve(builder, 1)) {
        return false;
    }
    builder->code_units[builder->length++] = code_unit;
    return true;
}

static bool mal_json_builder_push_ascii(MalJsonBuilder *builder, const byte *text) {
    usize length = strlen((const char *) text);
    if (!mal_json_builder_reserve(builder, length)) {
        return false;
    }
    for (usize i = 0; i < length; i++) {
        builder->code_units[builder->length++] = (c16) text[i];
    }
    return true;
}

static bool mal_json_builder_push_units(
    MalJsonBuilder *builder, const c16 *code_units, usize length
) {
    if (length == 0) {
        return true;
    }
    if (!mal_json_builder_reserve(builder, length)) {
        return false;
    }
    memcpy(builder->code_units + builder->length, code_units, sizeof(c16) * length);
    builder->length += length;
    return true;
}

static bool mal_json_builder_push_string(MalJsonBuilder *builder, const MalString *string) {
    return mal_json_builder_push_units(
        builder, mal_string_code_units(string), mal_string_length(string));
}

static bool mal_json_builder_push_quoted(MalJsonBuilder *builder, const MalString *string) {
    const c16 *code_units = mal_string_code_units(string);
    usize string_length = mal_string_length(string);
    usize quoted_length = 2;
    for (usize i = 0; i < string_length; i++) {
        c16 code_unit = code_units[i];
        usize width = 1;
        if (code_unit == '"' || code_unit == '\\' ||
            code_unit == '\b' || code_unit == '\f' || code_unit == '\n' ||
            code_unit == '\r' || code_unit == '\t') {
            width = 2;
        } else if (code_unit < 0x20) {
            width = 6;
        } else if (code_unit >= 0xD800 && code_unit <= 0xDFFF) {
            bool paired = code_unit <= 0xDBFF && i + 1 < string_length &&
                code_units[i + 1] >= 0xDC00 && code_units[i + 1] <= 0xDFFF;
            if (paired) {
                width = 2;
                i++;
            } else {
                width = 6;
            }
        }
        if (!mal_checked_size_add(
                quoted_length, width, MAL_STRING_MAX_CODE_UNITS, &quoted_length)) {
            return mal_json_throw_string_length(builder->vm);
        }
    }
    if (!mal_json_builder_reserve(builder, quoted_length)) {
        return false;
    }

    builder->code_units[builder->length++] = '"';
    for (usize i = 0; i < string_length; i++) {
        c16 code_unit = code_units[i];
        switch (code_unit) {
            case '"':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = '"';
                break;
            case '\\':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = '\\';
                break;
            case '\b':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = 'b';
                break;
            case '\f':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = 'f';
                break;
            case '\n':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = 'n';
                break;
            case '\r':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = 'r';
                break;
            case '\t':
                builder->code_units[builder->length++] = '\\';
                builder->code_units[builder->length++] = 't';
                break;
            default:
                if (code_unit < 0x20) {
                    byte buffer[8];
                    snprintf(buffer, sizeof(buffer), "\\u%04x", code_unit);
                    for (usize j = 0; j < 6; j++) {
                        builder->code_units[builder->length++] = buffer[j];
                    }
                } else if (code_unit >= 0xD800 && code_unit <= 0xDFFF) {
                    // QuoteJSONString escapes lone surrogates; a valid pair (high
                    // followed by low) passes through unescaped as the two units.
                    bool high = code_unit <= 0xDBFF;
                    bool paired = high && i + 1 < string_length &&
                        code_units[i + 1] >= 0xDC00 && code_units[i + 1] <= 0xDFFF;
                    if (paired) {
                        builder->code_units[builder->length++] = code_unit;
                        builder->code_units[builder->length++] = code_units[++i];
                    } else {
                        byte buffer[8];
                        snprintf(buffer, sizeof(buffer), "\\u%04x", code_unit);
                        for (usize j = 0; j < 6; j++) {
                            builder->code_units[builder->length++] = buffer[j];
                        }
                    }
                } else {
                    builder->code_units[builder->length++] = code_unit;
                }
                break;
        }
    }

    builder->code_units[builder->length++] = '"';
    return true;
}

/**
 * State threaded through SerializeJSONProperty: the replacer function (or
 * undefined), the optional PropertyList allow-list, the indentation gap, and the
 * cycle-detection stack of objects currently being serialized.
 */
typedef struct MalJsonState {
    MalVm *vm;
    MalValue replacer_fn;  // callable or undefined
    bool has_property_list;
    MalValue *property_list;  // allow-list of string keys
    usize property_list_count;
    const c16 *gap;  // indentation unit code units (NULL when empty)
    usize gap_length;
    MalValue *stack;  // objects on the active serialization path
    usize stack_count;
    usize stack_capacity;
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
    builder->code_units[builder->length++] = '\n';
    for (usize i = 0; i < depth; i++) {
        for (usize j = 0; j < state->gap_length; j++) {
            builder->code_units[builder->length++] = state->gap[j];
        }
    }
    return true;
}

/** IsArray (7.2.2): unwrap a Proxy to its target; a revoked Proxy throws. */
static bool mal_json_is_array(MalVm *vm, MalValue value, bool *out) {
    while (mal_value_is_proxy_object(value)) {
        MalValue target = mal_proxy_unwrap_target(value);
        if (mal_value_is_proxy_object(target) && target == value) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot perform IsArray on a revoked Proxy");
            return false;
        }
        value = target;
    }
    *out = mal_value_is_array_object(value);
    return true;
}

/** Push value to the cycle stack, throwing a TypeError if it is already present. */
static bool mal_json_stack_push(MalJsonState *state, MalValue value) {
    for (usize i = 0; i < state->stack_count; i++) {
        if (state->stack[i] == value) {
            mal_vm_throw_error(state->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Converting circular structure to JSON");
            return false;
        }
    }
    if (state->stack_count == state->stack_capacity) {
        state->stack_capacity = state->stack_capacity == 0 ? 16 : state->stack_capacity * 2;
        state->stack = realloc(state->stack, sizeof(MalValue) * state->stack_capacity);
    }
    state->stack[state->stack_count++] = value;
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

        MalKey get_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
        MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) index)));
        MalJsonResult result = mal_json_serialize_property(state, builder, get_key, key_string, value, depth + 1);
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

    state->stack_count--;
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
        for (usize i = 0; i < state->property_list_count && ok; i++) {
            MalValue key = state->property_list[i];
            // Canonicalize so a numeric key string ("0") resolves to the holder's
            // integer-indexed property rather than a missing string key.
            MalKey get_key;
            mal_vm_value_to_property_key(vm, key, &get_key);
            MalJsonBuilder member = {.vm = vm};
            MalJsonResult result = mal_json_serialize_property(state, &member, get_key, key, value, depth + 1);
            if (result == MAL_JSON_THROW) {
                free(member.code_units);
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) {
                free(member.code_units);
                continue;
            }
            bool appended = (!any || mal_json_builder_push(builder, ',')) &&
                mal_json_push_indent(state, builder, depth + 1) &&
                mal_json_builder_push_quoted(builder, mal_value_to_string(key)) &&
                mal_json_builder_push(builder, ':') &&
                (state->gap_length == 0 || mal_json_builder_push(builder, ' ')) &&
                mal_json_builder_push_units(builder, member.code_units, member.length);
            free(member.code_units);
            if (!appended) {
                ok = false;
                break;
            }
            any = true;
        }
    } else {
        // EnumerableOwnPropertyNames snapshots the key list before any value is
        // read, so a getter that adds or deletes properties mid-serialization
        // can't change which keys are visited.
        MalKey *keys = nullptr;
        usize key_count = 0;
        usize key_capacity = 0;
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL) {
                continue;
            }
            if (key_count == key_capacity) {
                key_capacity = key_capacity == 0 ? 16 : key_capacity * 2;
                keys = realloc(keys, sizeof(MalKey) * key_capacity);
            }
            keys[key_count++] = key;
        }

        for (usize i = 0; i < key_count; i++) {
            MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, keys[i].value));
            MalJsonBuilder member = {.vm = vm};
            MalJsonResult result = mal_json_serialize_property(state, &member, keys[i], key_string, value, depth + 1);
            if (result == MAL_JSON_THROW) {
                free(member.code_units);
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) {
                free(member.code_units);
                continue;
            }
            bool appended = (!any || mal_json_builder_push(builder, ',')) &&
                mal_json_push_indent(state, builder, depth + 1) &&
                mal_json_builder_push_quoted(builder, mal_value_to_string(key_string)) &&
                mal_json_builder_push(builder, ':') &&
                (state->gap_length == 0 || mal_json_builder_push(builder, ' ')) &&
                mal_json_builder_push_units(builder, member.code_units, member.length);
            free(member.code_units);
            if (!appended) {
                ok = false;
                break;
            }
            any = true;
        }
        free(keys);
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

    state->stack_count--;
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

    // toJSON: called on Objects and BigInts with the (string) key as its argument.
    if (mal_value_is_object(value) || mal_value_is_bigint(value)) {
        MalValue to_json;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, "toJSON"), &to_json)) {
            return MAL_JSON_THROW;
        }
        if (mal_value_is_callable(to_json)) {
            MalCompletion completion = mal_vm_call_value(vm, to_json, value, &key_string, 1);
            if (completion.kind == MAL_COMPLETION_THROW) {
                return MAL_JSON_THROW;
            }
            value = completion.value;
        }
    }

    if (mal_value_is_callable(state->replacer_fn)) {
        MalValue replacer_args[2] = {key_string, value};
        MalCompletion completion = mal_vm_call_value(vm, state->replacer_fn, holder, replacer_args, 2);
        if (completion.kind == MAL_COMPLETION_THROW) {
            return MAL_JSON_THROW;
        }
        value = completion.value;
    }

    // Unwrap a Number wrapper via ToNumber and a String wrapper via ToString (so
    // a user valueOf/toString runs and may throw); Boolean/BigInt wrappers take
    // their internal slot directly.
    if (mal_value_is_primitive_wrapper(value)) {
        MalPrimitiveWrapperKind kind = mal_value_to_primitive_wrapper(value)->kind;
        if (kind == MAL_PRIMITIVE_WRAPPER_NUMBER) {
            f64 number;
            if (!mal_vm_to_number(vm, value, &number)) {
                return MAL_JSON_THROW;
            }
            value = mal_ops_number_value(number);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_STRING) {
            MalString *string;
            if (!mal_vm_to_string(vm, value, &string)) {
                return MAL_JSON_THROW;
            }
            value = mal_value_from_string(string);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_BOOLEAN || kind == MAL_PRIMITIVE_WRAPPER_BIGINT) {
            value = mal_value_to_primitive_wrapper(value)->primitive_data;
        }
    }

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
        if (!mal_json_is_array(vm, value, &is_array)) {
            return MAL_JSON_THROW;
        }
        return is_array
            ? mal_json_serialize_array(state, builder, value, depth)
            : mal_json_serialize_object(state, builder, value, depth);
    }

    // undefined, callables, and symbols have no JSON serialization.
    return MAL_JSON_OMITTED;
}

/** Build the PropertyList allow-list from an array replacer (spec step 4.b.ii). */
static bool mal_json_build_property_list(MalJsonState *state, MalValue replacer) {
    MalVm *vm = state->vm;
    u32 length;
    if (!mal_builtin_array_this_length(vm, replacer, &length)) {
        return false;
    }

    state->has_property_list = true;
    state->property_list = length > 0 ? malloc(sizeof(MalValue) * length) : nullptr;
    state->property_list_count = 0;

    for (u32 index = 0; index < length; index++) {
        MalValue element;
        if (!mal_vm_get_property(vm, replacer, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}, &element)) {
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
        for (usize i = 0; i < state->property_list_count; i++) {
            if (mal_string_equals(mal_value_to_string(state->property_list[i]), mal_value_to_string(item))) {
                duplicate = true;
                break;
            }
        }
        if (!duplicate) {
            state->property_list[state->property_list_count++] = item;
        }
    }
    return true;
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

    // Replacer: a callable is the ReplacerFunction; an array builds the
    // PropertyList allow-list. Anything else is ignored.
    if (mal_value_is_object(replacer)) {
        if (mal_value_is_callable(replacer)) {
            state.replacer_fn = replacer;
        } else {
            bool is_array;
            if (!mal_json_is_array(vm, replacer, &is_array)) {
                return mal_value_new_undefined();
            }
            if (is_array && !mal_json_build_property_list(&state, replacer)) {
                free(state.property_list);
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
                free(state.property_list);
                return mal_value_new_undefined();
            }
            space = mal_ops_number_value(number);
        } else if (kind == MAL_PRIMITIVE_WRAPPER_STRING) {
            MalString *string_value;
            if (!mal_vm_to_string(vm, space, &string_value)) {
                free(state.property_list);
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
        const c16 *units = mal_string_code_units(string);
        for (usize i = 0; i < length; i++) {
            gap_buffer[i] = units[i];
        }
        state.gap = gap_buffer;
        state.gap_length = length;
    }

    // Wrap the top-level value in {"": value} and serialize that property, so the
    // replacer/toJSON see the empty-string key and the root holder.
    MalObject *wrapper = mal_intrinsic_new_object(vm);
    MalValue empty_key = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    mal_intrinsic_define_data(vm, wrapper, "", value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    MalJsonBuilder builder = {.vm = vm};
    MalKey root_key = {.kind = MAL_KEY_STRING, .value = empty_key};
    MalJsonResult result = mal_json_serialize_property(&state, &builder, root_key, empty_key, mal_value_from_object(wrapper), 0);

    free(state.property_list);
    free(state.stack);

    if (result != MAL_JSON_WROTE) {
        free(builder.code_units);
        return mal_value_new_undefined();
    }

    MalValue serialized = mal_value_from_string(mal_string_new_copy(&vm->heap, builder.code_units, builder.length));
    free(builder.code_units);
    return serialized;
}

typedef struct MalJsonParser {
    MalVm *vm;
    const c16 *code_units;
    usize length;
    usize position;
} MalJsonParser;

static MalValue mal_json_parse_value(MalJsonParser *parser);

static void mal_json_parse_error(MalJsonParser *parser) {
    mal_vm_throw_error(parser->vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Unexpected token in JSON");
}

static void mal_json_skip_whitespace(MalJsonParser *parser) {
    while (parser->position < parser->length) {
        c16 code_unit = parser->code_units[parser->position];
        if (code_unit != ' ' && code_unit != '\t' && code_unit != '\n' && code_unit != '\r') {
            break;
        }
        parser->position++;
    }
}

static bool mal_json_consume(MalJsonParser *parser, c16 expected) {
    if (parser->position < parser->length && parser->code_units[parser->position] == expected) {
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
        if (parser->code_units[parser->position + i] != (c16) keyword[i]) {
            return false;
        }
    }

    parser->position += length;
    return true;
}

static MalValue mal_json_parse_string(MalJsonParser *parser) {
    // The opening quote was already consumed.
    MalJsonBuilder builder = {.vm = parser->vm};

    while (parser->position < parser->length) {
        c16 code_unit = parser->code_units[parser->position++];
        if (code_unit == '"') {
            MalValue result = mal_value_from_string(
                mal_string_new_copy(&parser->vm->heap, builder.code_units, builder.length)
            );
            free(builder.code_units);
            return result;
        }

        if (code_unit < 0x20) {
            // JSONString may not contain unescaped control characters U+0000..U+001F.
            free(builder.code_units);
            mal_json_parse_error(parser);
            return mal_value_new_undefined();
        }

        if (code_unit != '\\') {
            if (!mal_json_builder_push(&builder, code_unit)) {
                free(builder.code_units);
                return mal_value_new_undefined();
            }
            continue;
        }

        if (parser->position >= parser->length) {
            break;
        }

        c16 escape = parser->code_units[parser->position++];
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
                    free(builder.code_units);
                    mal_json_parse_error(parser);
                    return mal_value_new_undefined();
                }

                c16 value = 0;
                for (i32 i = 0; i < 4; i++) {
                    c16 digit = parser->code_units[parser->position++];
                    value = (c16) (value << 4);
                    if (digit >= '0' && digit <= '9') {
                        value = (c16) (value + (digit - '0'));
                    } else if (digit >= 'a' && digit <= 'f') {
                        value = (c16) (value + (digit - 'a' + 10));
                    } else if (digit >= 'A' && digit <= 'F') {
                        value = (c16) (value + (digit - 'A' + 10));
                    } else {
                        free(builder.code_units);
                        mal_json_parse_error(parser);
                        return mal_value_new_undefined();
                    }
                }
                if (!mal_json_builder_push(&builder, value)) goto length_error;
                break;
            }
            default:
                free(builder.code_units);
                mal_json_parse_error(parser);
                return mal_value_new_undefined();
        }
    }

    free(builder.code_units);
    mal_json_parse_error(parser);
    return mal_value_new_undefined();

length_error:
    free(builder.code_units);
    return mal_value_new_undefined();
}

static MalValue mal_json_parse_number(MalJsonParser *parser) {
    usize start = parser->position;

    mal_json_consume(parser, '-');
    while (parser->position < parser->length &&
           parser->code_units[parser->position] >= '0' && parser->code_units[parser->position] <= '9') {
        parser->position++;
    }
    if (mal_json_consume(parser, '.')) {
        while (parser->position < parser->length &&
               parser->code_units[parser->position] >= '0' && parser->code_units[parser->position] <= '9') {
            parser->position++;
        }
    }
    if (mal_json_consume(parser, 'e') || mal_json_consume(parser, 'E')) {
        if (!mal_json_consume(parser, '+')) {
            mal_json_consume(parser, '-');
        }
        while (parser->position < parser->length &&
               parser->code_units[parser->position] >= '0' && parser->code_units[parser->position] <= '9') {
            parser->position++;
        }
    }

    if (parser->position == start) {
        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }

    byte buffer[64];
    usize length = parser->position - start;
    if (length >= sizeof(buffer)) {
        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }
    for (usize i = 0; i < length; i++) {
        buffer[i] = (byte) parser->code_units[start + i];
    }
    buffer[length] = '\0';

    return mal_ops_number_value(strtod(buffer, nullptr));
}

static MalValue mal_json_parse_array(MalJsonParser *parser) {
    MalArrayObject *array = mal_intrinsic_new_array(parser->vm, 0);

    mal_json_skip_whitespace(parser);
    if (mal_json_consume(parser, ']')) {
        return mal_value_from_array_object(array);
    }

    u32 index = 0;
    while (true) {
        MalValue element = mal_json_parse_value(parser);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        mal_array_object_store(
            array,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index++)},
            element
        );

        mal_json_skip_whitespace(parser);
        if (mal_json_consume(parser, ',')) {
            mal_json_skip_whitespace(parser);
            continue;
        }
        if (mal_json_consume(parser, ']')) {
            return mal_value_from_array_object(array);
        }

        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }
}

static MalValue mal_json_parse_object(MalJsonParser *parser) {
    MalObject *object = mal_intrinsic_new_object(parser->vm);

    mal_json_skip_whitespace(parser);
    if (mal_json_consume(parser, '}')) {
        return mal_value_from_object(object);
    }

    while (true) {
        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, '"')) {
            mal_json_parse_error(parser);
            return mal_value_new_undefined();
        }

        MalValue key = mal_json_parse_string(parser);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        mal_json_skip_whitespace(parser);
        if (!mal_json_consume(parser, ':')) {
            mal_json_parse_error(parser);
            return mal_value_new_undefined();
        }

        MalValue value = mal_json_parse_value(parser);
        if (parser->vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        MalKey property_key;
        mal_vm_value_to_property_key(parser->vm, key, &property_key);
        // CreateDataProperty: JSON members become own properties, never
        // routed through inherited setters (notably __proto__).
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(object, property_key, &desc);

        mal_json_skip_whitespace(parser);
        if (mal_json_consume(parser, ',')) {
            continue;
        }
        if (mal_json_consume(parser, '}')) {
            return mal_value_from_object(object);
        }

        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }
}

static MalValue mal_json_parse_value(MalJsonParser *parser) {
    mal_json_skip_whitespace(parser);
    if (parser->position >= parser->length) {
        mal_json_parse_error(parser);
        return mal_value_new_undefined();
    }

    if (mal_json_consume(parser, '"')) {
        return mal_json_parse_string(parser);
    }
    if (mal_json_consume(parser, '[')) {
        return mal_json_parse_array(parser);
    }
    if (mal_json_consume(parser, '{')) {
        return mal_json_parse_object(parser);
    }
    if (mal_json_consume_keyword(parser, "null")) {
        return mal_value_new_null();
    }
    if (mal_json_consume_keyword(parser, "true")) {
        return mal_value_new_boolean(true);
    }
    if (mal_json_consume_keyword(parser, "false")) {
        return mal_value_new_boolean(false);
    }

    return mal_json_parse_number(parser);
}

/** CreateDataProperty for an ordinary parsed holder: the parsed object/array
 * has only default writable/enumerable/configurable data properties, so a plain
 * [[DefineOwnProperty]] (array-aware for index keys) matches the spec here. */
static bool mal_json_internalize_set(MalVm *vm, MalValue holder, MalKey key, MalValue value) {
    return mal_vm_set_property(vm, holder, key, value, holder);
}

/**
 * InternalizeJSONProperty(holder, name, reviver): recurse into the value's
 * elements/properties (deleting members the reviver maps to undefined, replacing
 * the rest), then call the reviver with (name, value) and `holder` as `this`.
 * Returns false with a pending throw on any abrupt completion.
 */
static bool mal_json_internalize(MalVm *vm, MalValue reviver, MalValue holder, MalValue name, MalValue *out) {
    // Get(holder, name): `name` is a String (ToString of the array index or the
    // object key). Canonicalize it to a property key so a numeric index string
    // ("0","1",…) resolves to the dense array element — a raw MAL_KEY_STRING never
    // reaches the dense-element vector and would read undefined. `name` itself stays
    // the String for the reviver's key argument below.
    MalValue value;
    MalKey get_key;
    if (!mal_vm_value_to_property_key(vm, name, &get_key)) {
        return false;
    }
    if (!mal_vm_get_property(vm, holder, get_key, &value)) {
        return false;
    }

    if (mal_value_is_object(value)) {
        bool is_array;
        if (!mal_json_is_array(vm, value, &is_array)) {
            return false;
        }
        if (is_array) {
            u32 length;
            if (!mal_builtin_array_this_length(vm, value, &length)) {
                return false;
            }
            for (u32 i = 0; i < length; i++) {
                MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i)));
                MalValue new_element;
                if (!mal_json_internalize(vm, reviver, value, key_string, &new_element)) {
                    return false;
                }
                MalKey element_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
                if (mal_value_is_undefined(new_element)) {
                    if (!mal_vm_delete_property(vm, value, element_key) && vm->completion.kind == MAL_COMPLETION_THROW) {
                        return false;
                    }
                } else if (!mal_json_internalize_set(vm, value, element_key, new_element)) {
                    return false;
                }
            }
        } else {
            // Snapshot the enumerable own keys before recursing.
            MalKey *keys = nullptr;
            usize key_count = 0;
            usize key_capacity = 0;
            MalPropertyIter iter;
            mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
            MalKey iter_key;
            MalPropertyDesc desc;
            while (mal_property_iter_next(&iter, &iter_key, &desc)) {
                if (iter_key.kind == MAL_KEY_SYMBOL) {
                    continue;
                }
                if (key_count == key_capacity) {
                    key_capacity = key_capacity == 0 ? 16 : key_capacity * 2;
                    keys = realloc(keys, sizeof(MalKey) * key_capacity);
                }
                keys[key_count++] = iter_key;
            }

            bool ok = true;
            for (usize i = 0; i < key_count; i++) {
                MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, keys[i].value));
                MalValue new_element;
                if (!mal_json_internalize(vm, reviver, value, key_string, &new_element)) {
                    ok = false;
                    break;
                }
                if (mal_value_is_undefined(new_element)) {
                    if (!mal_vm_delete_property(vm, value, keys[i]) && vm->completion.kind == MAL_COMPLETION_THROW) {
                        ok = false;
                        break;
                    }
                } else if (!mal_json_internalize_set(vm, value, keys[i], new_element)) {
                    ok = false;
                    break;
                }
            }
            free(keys);
            if (!ok) {
                return false;
            }
        }
    }

    MalValue reviver_args[2] = {name, value};
    MalCompletion completion = mal_vm_call_value(vm, reviver, holder, reviver_args, 2);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    *out = completion.value;
    return true;
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

    MalJsonParser parser = {
        .vm = vm,
        .code_units = mal_string_code_units(text),
        .length = mal_string_length(text),
        .position = 0,
    };

    MalValue result = mal_json_parse_value(&parser);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    mal_json_skip_whitespace(&parser);
    if (parser.position != parser.length) {
        mal_json_parse_error(&parser);
        return mal_value_new_undefined();
    }

    // A callable reviver walks the result bottom-up via InternalizeJSONProperty,
    // rooted in {"" : result}.
    MalValue reviver = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_callable(reviver)) {
        MalObject *root = mal_intrinsic_new_object(vm);
        MalValue empty_key = mal_value_from_string(mal_intrinsic_ascii(vm, ""));
        mal_intrinsic_define_data(vm, root, "", result, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        MalValue revived;
        if (!mal_json_internalize(vm, reviver, mal_value_from_object(root), empty_key, &revived)) {
            return mal_value_new_undefined();
        }
        return revived;
    }

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
    const c16 *units = mal_string_code_units(text);
    if (length == 0 || mal_json_is_json_whitespace(units[0]) || mal_json_is_json_whitespace(units[length - 1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        return mal_value_new_undefined();
    }

    // Validate as a complete JSON text (rejecting trailing content).
    MalJsonParser parser = {.vm = vm, .code_units = units, .length = length, .position = 0};
    mal_json_parse_value(&parser);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    mal_json_skip_whitespace(&parser);
    if (parser.position != length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        return mal_value_new_undefined();
    }

    MalObject *object = mal_object_new(&vm->heap, nullptr);
    mal_intrinsic_define_data(vm, object, "rawJSON", mal_value_from_string(text), MAL_PROPERTY_ENUMERABLE);
    object->is_raw_json = true;
    object->extensible = false;
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
