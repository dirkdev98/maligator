#include "builtin_json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_array.h"
#include "checked_size.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "property_iter.h"
#include "proxy_object.h"
#include "rooted_collection.h"
#include "u16_buffer.h"
#include "utf16.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

typedef struct MalJsonBuilder {
    MalVm *vm;
    MalU16Buffer buffer;
} MalJsonBuilder;

static bool mal_json_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static bool mal_json_builder_reserve(MalJsonBuilder *builder, usize extra) {
    return mal_u16_buffer_reserve(&builder->buffer, extra) == MAL_U16_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push(MalJsonBuilder *builder, c16 code_unit) {
    return mal_u16_buffer_push(&builder->buffer, code_unit) == MAL_U16_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_ascii(MalJsonBuilder *builder, const byte *text) {
    return mal_u16_buffer_append_ascii(&builder->buffer, text) == MAL_U16_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_units(
    MalJsonBuilder *builder, const c16 *code_units, usize length
) {
    return mal_u16_buffer_append_units(
        &builder->buffer, code_units, length) == MAL_U16_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
}

static bool mal_json_builder_push_string(MalJsonBuilder *builder, const MalString *string) {
    return mal_u16_buffer_append_string(
        &builder->buffer, string) == MAL_U16_BUFFER_OK ||
        mal_json_throw_string_length(builder->vm);
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
        } else if (mal_utf16_is_surrogate(code_unit)) {
            usize scalar_width;
            bool valid = mal_utf16_read_scalar(
                code_units, string_length, i, nullptr, &scalar_width);
            if (valid) {
                width = 2;
                i += scalar_width - 1;
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

    builder->buffer.data[builder->buffer.length++] = '"';
    for (usize i = 0; i < string_length; i++) {
        c16 code_unit = code_units[i];
        switch (code_unit) {
            case '"':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = '"';
                break;
            case '\\':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = '\\';
                break;
            case '\b':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = 'b';
                break;
            case '\f':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = 'f';
                break;
            case '\n':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = 'n';
                break;
            case '\r':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = 'r';
                break;
            case '\t':
                builder->buffer.data[builder->buffer.length++] = '\\';
                builder->buffer.data[builder->buffer.length++] = 't';
                break;
            default:
                if (code_unit < 0x20) {
                    byte buffer[8];
                    snprintf(buffer, sizeof(buffer), "\\u%04x", code_unit);
                    for (usize j = 0; j < 6; j++) {
                        builder->buffer.data[builder->buffer.length++] = buffer[j];
                    }
                } else if (mal_utf16_is_surrogate(code_unit)) {
                    // QuoteJSONString escapes lone surrogates; a valid pair (high
                    // followed by low) passes through unescaped as the two units.
                    usize scalar_width;
                    bool valid = mal_utf16_read_scalar(
                        code_units, string_length, i, nullptr, &scalar_width);
                    if (valid) {
                        builder->buffer.data[builder->buffer.length++] = code_unit;
                        builder->buffer.data[builder->buffer.length++] = code_units[++i];
                    } else {
                        byte buffer[8];
                        snprintf(buffer, sizeof(buffer), "\\u%04x", code_unit);
                        for (usize j = 0; j < 6; j++) {
                            builder->buffer.data[builder->buffer.length++] = buffer[j];
                        }
                    }
                } else {
                    builder->buffer.data[builder->buffer.length++] = code_unit;
                }
                break;
        }
    }

    builder->buffer.data[builder->buffer.length++] = '"';
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
    builder->buffer.data[builder->buffer.length++] = '\n';
    for (usize i = 0; i < depth; i++) {
        for (usize j = 0; j < state->gap_length; j++) {
            builder->buffer.data[builder->buffer.length++] = state->gap[j];
        }
    }
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

        MalKey get_key = mal_key_index(index);
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
                mal_u16_buffer_dispose(&member.buffer);
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) {
                mal_u16_buffer_dispose(&member.buffer);
                continue;
            }
            bool appended = (!any || mal_json_builder_push(builder, ',')) &&
                mal_json_push_indent(state, builder, depth + 1) &&
                mal_json_builder_push_quoted(builder, mal_value_to_string(key)) &&
                mal_json_builder_push(builder, ':') &&
                (state->gap_length == 0 || mal_json_builder_push(builder, ' ')) &&
                mal_json_builder_push_units(
                    builder, member.buffer.data, member.buffer.length);
            mal_u16_buffer_dispose(&member.buffer);
            if (!appended) {
                ok = false;
                break;
            }
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
        MalRootedKeySnapshot own_keys;
        mal_rooted_key_snapshot_init(&own_keys);
        ok = mal_rooted_key_snapshot_own_keys(vm, value, &own_keys);

        MalRootedKeySnapshot keys;
        mal_rooted_key_snapshot_init(&keys);
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
            if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }
            mal_rooted_key_snapshot_append(&keys, own_keys.keys[i]);
        }
        mal_rooted_key_snapshot_dispose(&own_keys);

        for (usize i = 0; ok && i < keys.count; i++) {
            MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, keys.keys[i].value));
            MalJsonBuilder member = {.vm = vm};
            MalJsonResult result = mal_json_serialize_property(state, &member, keys.keys[i], key_string, value, depth + 1);
            if (result == MAL_JSON_THROW) {
                mal_u16_buffer_dispose(&member.buffer);
                ok = false;
                break;
            }
            if (result == MAL_JSON_OMITTED) {
                mal_u16_buffer_dispose(&member.buffer);
                continue;
            }
            bool appended = (!any || mal_json_builder_push(builder, ',')) &&
                mal_json_push_indent(state, builder, depth + 1) &&
                mal_json_builder_push_quoted(builder, mal_value_to_string(key_string)) &&
                mal_json_builder_push(builder, ':') &&
                (state->gap_length == 0 || mal_json_builder_push(builder, ' ')) &&
                mal_json_builder_push_units(
                    builder, member.buffer.data, member.buffer.length);
            mal_u16_buffer_dispose(&member.buffer);
            if (!appended) {
                ok = false;
                break;
            }
            any = true;
        }
        mal_rooted_key_snapshot_dispose(&keys);
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
            if (!mal_vm_is_array(vm, replacer, &is_array)) {
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
        mal_u16_buffer_dispose(&builder.buffer);
        return mal_value_new_undefined();
    }

    MalValue serialized = mal_value_from_string(
        mal_u16_buffer_finish(&vm->heap, &builder.buffer));
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
};

typedef struct MalJsonParseState {
    MalRootedValueList roots;
} MalJsonParseState;

typedef struct MalJsonParser {
    MalVm *vm;
    const c16 *code_units;
    usize length;
    usize position;
    MalJsonParseState *state;
} MalJsonParser;

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
    if (node == nullptr) {
        return;
    }
    for (usize i = 0; i < node->child_count; i++) {
        mal_json_parse_node_dispose(node->children[i].node);
    }
    free(node->children);
    free(node);
}

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
                mal_u16_buffer_finish(&parser->vm->heap, &builder.buffer));
            return result;
        }

        if (code_unit < 0x20) {
            // JSONString may not contain unescaped control characters U+0000..U+001F.
            mal_u16_buffer_dispose(&builder.buffer);
            mal_json_parse_error(parser);
            return mal_value_new_undefined();
        }

        if (code_unit != '\\') {
            if (!mal_json_builder_push(&builder, code_unit)) {
                mal_u16_buffer_dispose(&builder.buffer);
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
                    mal_u16_buffer_dispose(&builder.buffer);
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
                        mal_u16_buffer_dispose(&builder.buffer);
                        mal_json_parse_error(parser);
                        return mal_value_new_undefined();
                    }
                }
                if (!mal_json_builder_push(&builder, value)) goto length_error;
                break;
            }
            default:
                mal_u16_buffer_dispose(&builder.buffer);
                mal_json_parse_error(parser);
                return mal_value_new_undefined();
        }
    }

    mal_u16_buffer_dispose(&builder.buffer);
    mal_json_parse_error(parser);
    return mal_value_new_undefined();

length_error:
    mal_u16_buffer_dispose(&builder.buffer);
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
        mal_array_object_store(
            array,
            element_key,
            element
        );
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

static MalValue mal_json_parse_object(
    MalJsonParser *parser, usize source_start, MalJsonParseNode **node_out
) {
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
    if (mal_json_consume(parser, '"')) {
        value = mal_json_parse_string(parser);
        goto primitive;
    }
    if (mal_json_consume(parser, '[')) {
        return mal_json_parse_array(parser, source_start, node_out);
    }
    if (mal_json_consume(parser, '{')) {
        return mal_json_parse_object(parser, source_start, node_out);
    }
    if (mal_json_consume_keyword(parser, "null")) {
        value = mal_value_new_null();
        goto primitive;
    }
    if (mal_json_consume_keyword(parser, "true")) {
        value = mal_value_new_boolean(true);
        goto primitive;
    }
    if (mal_json_consume_keyword(parser, "false")) {
        value = mal_value_new_boolean(false);
        goto primitive;
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

static MalJsonParseNode *mal_json_parse_object_child(
    MalJsonParseState *state, MalJsonParseNode *node, MalKey key
) {
    if (node == nullptr || node->kind != MAL_JSON_PARSE_OBJECT) {
        return nullptr;
    }
    // JSON duplicate names overwrite earlier values. The parse record matching
    // the resulting property is therefore the last child with that key.
    for (usize i = node->child_count; i > 0; i--) {
        MalJsonParseChild *child = &node->children[i - 1];
        if (mal_json_parse_child_key_equals(state, child, key)) {
            return child->node;
        }
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
    MalValue *out
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
                        parse_state, element_node, &new_element)) {
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
            mal_rooted_key_snapshot_dispose(&own_keys);

            for (usize i = 0; keys_ok && i < keys.count; i++) {
                MalValue key_string = mal_value_from_string(mal_ops_to_string(&vm->heap, keys.keys[i].value));
                MalValue new_element;
                MalJsonParseNode *property_node = mal_json_parse_object_child(
                    parse_state, parse_node, keys.keys[i]);
                if (!mal_json_internalize(
                        vm, roots[0], roots[3], key_string,
                        parse_state, property_node, &new_element)) {
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
            mal_rooted_key_snapshot_dispose(&keys);
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
        .code_units = mal_string_code_units(text),
        .length = mal_string_length(text),
        .position = 0,
        .state = track_source ? &parse_state : nullptr,
    };

    MalJsonParseNode *root_node = nullptr;
    MalValue result = mal_json_parse_value(&parser, &root_node);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_json_parse_node_dispose(root_node);
        if (track_source) {
            mal_rooted_value_list_dispose(&parse_state.roots);
        }
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
                &parse_state, root_node, &revived)) {
            mal_json_parse_node_dispose(root_node);
            mal_rooted_value_list_dispose(&parse_state.roots);
            mal_gc_unroot(&text_span);
            return mal_value_new_undefined();
        }
        mal_json_parse_node_dispose(root_node);
        mal_rooted_value_list_dispose(&parse_state.roots);
        mal_gc_unroot(&text_span);
        return revived;
    }

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
    const c16 *units = mal_string_code_units(text);
    if (length == 0 || mal_json_is_json_whitespace(units[0]) || mal_json_is_json_whitespace(units[length - 1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        return mal_value_new_undefined();
    }

    // Validate as a complete JSON text (rejecting trailing content).
    MalValue text_value = mal_value_from_string(text);
    MalRootSpan text_span;
    mal_gc_root(&text_span, &text_value, 1);
    MalJsonParser parser = {
        .vm = vm,
        .code_units = units,
        .length = length,
        .position = 0,
        .state = nullptr,
    };
    MalJsonParseNode *root_node = nullptr;
    mal_json_parse_value(&parser, &root_node);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }
    mal_json_skip_whitespace(&parser);
    if (parser.position != length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, "Invalid raw JSON text");
        mal_gc_unroot(&text_span);
        return mal_value_new_undefined();
    }

    MalObject *object = mal_object_new(&vm->heap, nullptr);
    mal_intrinsic_define_data(
        vm, object, "rawJSON", text_value,
        MAL_PROPERTY_ENUMERABLE);
    object->is_raw_json = true;
    object->extensible = false;
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
