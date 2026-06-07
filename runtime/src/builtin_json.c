#include "builtin_json.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "heap_string.h"
#include "property_iter.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// Recursion guard standing in for proper cycle detection.
// TODO(json): track visited objects instead of bounding the depth.
#define MAL_JSON_MAX_DEPTH 200

typedef struct MalJsonBuilder {
    c16 *code_units;
    usize length;
    usize capacity;
} MalJsonBuilder;

static void mal_json_builder_push(MalJsonBuilder *builder, c16 code_unit) {
    if (builder->length == builder->capacity) {
        builder->capacity = builder->capacity == 0 ? 64 : builder->capacity * 2;
        builder->code_units = realloc(builder->code_units, sizeof(c16) * builder->capacity);
    }

    builder->code_units[builder->length++] = code_unit;
}

static void mal_json_builder_push_ascii(MalJsonBuilder *builder, const byte *text) {
    for (usize i = 0; text[i] != '\0'; i++) {
        mal_json_builder_push(builder, (c16) text[i]);
    }
}

static void mal_json_builder_push_string(MalJsonBuilder *builder, const MalString *string) {
    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        mal_json_builder_push(builder, code_units[i]);
    }
}

static void mal_json_builder_push_quoted(MalJsonBuilder *builder, const MalString *string) {
    mal_json_builder_push(builder, '"');

    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        c16 code_unit = code_units[i];
        switch (code_unit) {
            case '"':
                mal_json_builder_push_ascii(builder, "\\\"");
                break;
            case '\\':
                mal_json_builder_push_ascii(builder, "\\\\");
                break;
            case '\b':
                mal_json_builder_push_ascii(builder, "\\b");
                break;
            case '\f':
                mal_json_builder_push_ascii(builder, "\\f");
                break;
            case '\n':
                mal_json_builder_push_ascii(builder, "\\n");
                break;
            case '\r':
                mal_json_builder_push_ascii(builder, "\\r");
                break;
            case '\t':
                mal_json_builder_push_ascii(builder, "\\t");
                break;
            default:
                if (code_unit < 0x20) {
                    byte buffer[8];
                    snprintf(buffer, sizeof(buffer), "\\u%04x", code_unit);
                    mal_json_builder_push_ascii(builder, buffer);
                } else {
                    mal_json_builder_push(builder, code_unit);
                }
                break;
        }
    }

    mal_json_builder_push(builder, '"');
}

/**
 * Serialize a value into the builder. Returns false for values that JSON
 * omits entirely (undefined and functions).
 */
static bool mal_json_stringify_value(MalVm *vm, MalJsonBuilder *builder, MalValue value, i32 depth) {
    if (depth > MAL_JSON_MAX_DEPTH) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Maximum JSON depth exceeded, possibly a circular structure");
        return false;
    }

    if (mal_value_is_undefined(value) || mal_value_is_callable(value)) {
        return false;
    }

    if (mal_value_is_null(value)) {
        mal_json_builder_push_ascii(builder, "null");
        return true;
    }

    if (mal_value_is_boolean(value)) {
        mal_json_builder_push_ascii(builder, mal_value_to_boolean(value) ? "true" : "false");
        return true;
    }

    if (mal_value_is_string(value)) {
        mal_json_builder_push_quoted(builder, mal_value_to_string(value));
        return true;
    }

    if (mal_value_is_array_object(value)) {
        MalArrayObject *array = mal_value_to_array_object(value);
        u32 length = mal_array_object_length(array);

        mal_json_builder_push(builder, '[');
        for (u32 index = 0; index < length; index++) {
            if (index > 0) {
                mal_json_builder_push(builder, ',');
            }

            MalPropertyResolution resolution = mal_object_resolve_property(
                (MalObject *) array,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}
            );
            MalValue element = mal_value_new_undefined();
            if (resolution.found && !mal_vm_desc_read(vm, resolution.desc, value, &element)) {
                return false;
            }
            // Holes, undefined and functions serialize as null inside arrays.
            if (!mal_json_stringify_value(vm, builder, element, depth + 1)) {
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    return false;
                }
                mal_json_builder_push_ascii(builder, "null");
            }
        }
        mal_json_builder_push(builder, ']');
        return true;
    }

    if (mal_value_is_object(value)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        mal_json_builder_push(builder, '{');
        MalKey key;
        MalPropertyDesc desc;
        bool first = true;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_SYMBOL) {
                continue;
            }

            // Probe the value first so omitted members don't leave a key.
            MalValue member_value;
            if (!mal_vm_desc_read(vm, desc, value, &member_value)) {
                return false;
            }

            MalJsonBuilder member = {0};
            if (!mal_json_stringify_value(vm, &member, member_value, depth + 1)) {
                free(member.code_units);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    return false;
                }
                continue;
            }

            if (!first) {
                mal_json_builder_push(builder, ',');
            }
            first = false;

            mal_json_builder_push_quoted(builder, mal_ops_to_string(&vm->heap, key.value));
            mal_json_builder_push(builder, ':');
            for (usize i = 0; i < member.length; i++) {
                mal_json_builder_push(builder, member.code_units[i]);
            }
            free(member.code_units);
        }
        mal_json_builder_push(builder, '}');
        return true;
    }

    // Numbers: non-finite values serialize as null.
    f64 number = mal_ops_to_number(value);
    if (isnan(number) || isinf(number)) {
        mal_json_builder_push_ascii(builder, "null");
        return true;
    }

    mal_json_builder_push_string(builder, mal_ops_to_string(&vm->heap, value));
    return true;
}

static MalValue mal_builtin_json_stringify(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    MalJsonBuilder builder = {0};

    bool serialized = mal_json_stringify_value(
        vm,
        &builder,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        0
    );

    if (!serialized) {
        free(builder.code_units);
        return mal_value_new_undefined();
    }

    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, builder.code_units, builder.length));
    free(builder.code_units);
    return result;
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
    MalJsonBuilder builder = {0};

    while (parser->position < parser->length) {
        c16 code_unit = parser->code_units[parser->position++];
        if (code_unit == '"') {
            MalValue result = mal_value_from_string(
                mal_string_new_copy(&parser->vm->heap, builder.code_units, builder.length)
            );
            free(builder.code_units);
            return result;
        }

        if (code_unit != '\\') {
            mal_json_builder_push(&builder, code_unit);
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
                mal_json_builder_push(&builder, escape);
                break;
            case 'b':
                mal_json_builder_push(&builder, '\b');
                break;
            case 'f':
                mal_json_builder_push(&builder, '\f');
                break;
            case 'n':
                mal_json_builder_push(&builder, '\n');
                break;
            case 'r':
                mal_json_builder_push(&builder, '\r');
                break;
            case 't':
                mal_json_builder_push(&builder, '\t');
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
                mal_json_builder_push(&builder, value);
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

static MalValue mal_builtin_json_parse(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    MalString *text = mal_ops_to_string(&vm->heap, arg_count >= 1 ? args[0] : mal_value_new_undefined());

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

    return result;
}

void mal_builtin_json_install(MalVm *vm) {
    MalObject *json = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_JSON] = mal_value_from_object(json);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "JSON")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(json, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method(vm, json, "stringify", mal_builtin_json_stringify);
    mal_intrinsic_define_method(vm, json, "parse", mal_builtin_json_parse);
}
