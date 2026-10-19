// Portions derived from Node.js lib/internal/mime.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_util_mime.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "ascii.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "map_object.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "text_buffer.h"
#include "utf8.h"
#include "vm_ops.h"

#define MIME_METHOD (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE)

enum { MIME_TYPE, MIME_SUBTYPE, MIME_PARAMS, MIME_FIELD_COUNT };

static bool mime_token(c16 unit) {
    if ((unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z') || (unit >= '0' && unit <= '9')) {
        return true;
    }
    return unit != 0 && unit < 0x80 && strchr("!#$%&'*+-.^_`|~", (int) unit) != nullptr;
}

static bool mime_quoted(c16 unit) {
    return unit == '\t' || (unit >= 0x20 && unit <= 0x7e) || (unit >= 0x80 && unit <= 0xff);
}

static bool mime_space(c16 unit) {
    return unit == '\r' || unit == '\n' || unit == '\t' || unit == ' ';
}

// Offset of the first unit in [start, end) failing `valid`, relative to start, or -1.
static i64 mime_invalid(const c16 *units, usize start, usize end, bool (*valid)(c16)) {
    for (usize i = start; i < end; i++) {
        if (!valid(units[i])) return (i64) (i - start);
    }
    return -1;
}

static usize mime_trailing_space(const c16 *units, usize start, usize end) {
    while (end > start && mime_space(units[end - 1])) end--;
    return end;
}

static usize mime_find(const c16 *units, usize start, usize end, c16 unit) {
    while (start < end && units[start] != unit) start++;
    return start;
}

// Node's toASCIILower: only ASCII letters change case.
static MalValue mime_lower(MalVm *vm, const c16 *units, usize start, usize end) {
    MalTextBuffer buffer = {0};
    for (usize i = start; i < end; i++) {
        c16 unit = units[i];
        mal_text_buffer_push(&buffer, unit >= 'A' && unit <= 'Z' ? (c16) (unit + 32) : unit);
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, &buffer));
}

static void mime_throw_syntax(MalVm *vm, const char *production, MalString *string, i64 index) {
    char *text = nullptr;
    usize length = 0;
    if (mal_string_to_utf8_c_string(string, &text, &length) != MAL_UTF8_C_STRING_OK) text = nullptr;
    usize capacity = strlen(production) + length + 64;
    char *message = malloc(capacity);
    if (message == nullptr) {
        free(text);
        mal_vm_throw_allocation_error(vm);
        return;
    }
    int written = snprintf(message, capacity, "The MIME syntax for a %s in \"%s\" is invalid", production,
        text == nullptr ? "" : text);
    if (index != -1 && written > 0) snprintf(message + written, capacity - (usize) written, " at %lld", (long long) index);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_MIME_SYNTAX");
    free(message);
    free(text);
}

static bool mime_to_string(MalVm *vm, MalValue value, MalValue *out) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) return false;
    *out = mal_value_from_string(string);
    return true;
}

static MalValue mime_get_field(MalValue object, MalValue brand) {
    if (!mal_value_is_object(object)) return mal_value_new_undefined();
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(object), mal_key_from_value(brand));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

static MalValue mime_brand(MalValue callee) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
}

static MalMapObject *mime_params_map(MalVm *vm, MalValue receiver, MalValue callee) {
    MalValue map = mime_get_field(receiver, mime_brand(callee));
    if (mal_value_is_map_object(map)) return (MalMapObject *) mal_value_to_object(map);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver must be an instance of class MIMEParams",
        "ERR_INVALID_THIS");
    return nullptr;
}

static MalValue mime_type_fields(MalVm *vm, MalValue receiver, MalValue callee) {
    MalValue fields = mime_get_field(receiver, mime_brand(callee));
    if (mal_value_is_array_object(fields)) return fields;
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver must be an instance of class MIMEType",
        "ERR_INVALID_THIS");
    return mal_value_new_undefined();
}

static MalValue mime_field(MalValue fields, u32 index) {
    MalValue value = mal_value_new_undefined();
    mal_array_object_dense_get(mal_value_to_array_object(fields), index, &value);
    return value;
}

static void mime_set_field(MalValue fields, u32 index, MalValue value) {
    mal_array_object_store(mal_value_to_array_object(fields), mal_key_index(index), value);
}

static MalValue mime_new_map(MalVm *vm) {
    return mal_value_from_object((MalObject *) mal_map_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE])));
}

// MIMEParams#parse over units [start, end): first occurrence of each valid name wins.
static void mime_parse_params(MalVm *vm, MalMapObject *map, const c16 *units, usize start, usize length) {
    MalValue roots[] = {mal_value_from_object((MalObject *) map), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    usize end = mime_trailing_space(units, start, length);
    usize position = start;
    MalTextBuffer value = {0};
    bool value_valid = true;
    while (position < end) {
        while (position < length && mime_space(units[position])) position++;
        usize name_end = position;
        while (name_end < length && units[name_end] != ';' && units[name_end] != '=') name_end++;
        usize name_start = position;
        position = name_end;
        if (position < end) {
            c16 unit = units[position++];
            if (unit == ';') continue;
        }
        if (position >= end) break;
        mal_text_buffer_truncate(&value, 0);
        value_valid = true;
        if (units[position] == '"') {
            position++;
            // QUOTED_VALUE_PATTERN: escapes keep the next unit, a lone trailing backslash stays.
            while (position < length && units[position] != '"') {
                c16 unit = units[position++];
                if (unit == '\\' && position < length) unit = units[position++];
                value_valid = value_valid && mime_quoted(unit);
                mal_text_buffer_push(&value, unit);
            }
            if (position < length) position++;
        } else {
            usize value_end = mime_find(units, position, length, ';');
            usize trimmed = mime_trailing_space(units, position, value_end);
            usize value_start = position;
            position = value_end;
            if (trimmed == value_start) continue;
            value_valid = mime_invalid(units, value_start, trimmed, mime_quoted) == -1;
            mal_text_buffer_append_units(&value, units + value_start, trimmed - value_start);
        }
        if (name_end > name_start && value_valid && mime_invalid(units, name_start, name_end, mime_token) == -1) {
            roots[1] = mime_lower(vm, units, name_start, name_end);
            if (!mal_map_object_has(map, roots[1])) {
                roots[2] = mal_value_from_string(mal_text_buffer_copy(&vm->heap, &value));
                mal_map_object_set(map, roots[1], roots[2]);
            }
        }
        position++;
    }
    mal_text_buffer_dispose(&value);
    mal_gc_unroot(&root);
}

static void mime_append_value(MalTextBuffer *out, MalString *value) {
    const c16 *units = mal_string_code_units(value);
    usize length = mal_string_length(value);
    if (length == 0) {
        mal_text_buffer_append_ascii(out, (const byte *) "\"\"");
        return;
    }
    if (mime_invalid(units, 0, length, mime_token) == -1) {
        mal_text_buffer_append_units(out, units, length);
        return;
    }
    mal_text_buffer_push(out, '"');
    for (usize i = 0; i < length; i++) {
        if (units[i] == '"' || units[i] == '\\') mal_text_buffer_push(out, '\\');
        mal_text_buffer_push(out, units[i]);
    }
    mal_text_buffer_push(out, '"');
}

static void mime_append_params(MalTextBuffer *out, MalMapObject *map) {
    MalMapIter iter;
    mal_map_iter_init(&iter, mal_map_object_storage(map));
    MalValue key;
    MalValue value;
    bool first = true;
    while (mal_map_iter_next(&iter, &key, &value)) {
        if (!first) mal_text_buffer_push(out, ';');
        first = false;
        MalString *name = mal_value_to_string(key);
        mal_text_buffer_append_units(out, mal_string_code_units(name), mal_string_length(name));
        mal_text_buffer_push(out, '=');
        mime_append_value(out, mal_value_to_string(value));
    }
}

static MalValue mime_finish(MalVm *vm, MalTextBuffer *buffer) {
    if (buffer->status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(buffer);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, buffer));
}

static MalValue mime_params_to_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    if (map == nullptr) return mal_value_new_undefined();
    MalTextBuffer buffer = {0};
    mime_append_params(&buffer, map);
    return mime_finish(vm, &buffer);
}

static bool mime_params_name(MalVm *vm, const MalValue *args, i32 argc, MalValue *out) {
    MalValue name;
    if (!mime_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &name)) return false;
    MalString *string = mal_value_to_string(name);
    *out = mime_lower(vm, mal_string_code_units(string), 0, mal_string_length(string));
    return true;
}

static MalValue mime_params_get(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    MalValue name;
    if (map == nullptr || !mime_params_name(vm, args, argc, &name)) return mal_value_new_undefined();
    return mal_map_object_has(map, name) ? mal_map_object_get(map, name) : mal_value_new_null();
}

static MalValue mime_params_has(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    MalValue name;
    if (map == nullptr || !mime_params_name(vm, args, argc, &name)) return mal_value_new_undefined();
    return mal_value_new_boolean(mal_map_object_has(map, name));
}

static MalValue mime_params_delete(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    MalValue name;
    if (map != nullptr && mime_params_name(vm, args, argc, &name)) (void) mal_map_object_delete(map, name);
    return mal_value_new_undefined();
}

static MalValue mime_params_set(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (map == nullptr || !mime_params_name(vm, args, argc, &roots[0])
        || !mime_to_string(vm, argc > 1 ? args[1] : mal_value_new_undefined(), &roots[1])) goto done;
    MalString *name = mal_value_to_string(roots[0]);
    MalString *value = mal_value_to_string(roots[1]);
    i64 invalid = mime_invalid(mal_string_code_units(name), 0, mal_string_length(name), mime_token);
    if (mal_string_length(name) == 0 || invalid != -1) {
        mime_throw_syntax(vm, "parameter name", name, invalid);
        goto done;
    }
    invalid = mime_invalid(mal_string_code_units(value), 0, mal_string_length(value), mime_quoted);
    if (invalid != -1) {
        mime_throw_syntax(vm, "parameter value", value, invalid);
        goto done;
    }
    mal_map_object_set(map, roots[0], roots[1]);
done:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

// Slots: [brand, Map.prototype method name].
static MalValue mime_params_iterate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target;
    MalMapObject *map = mime_params_map(vm, receiver, callee);
    if (map == nullptr) return mal_value_new_undefined();
    MalValue method = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalCompletion completion = mal_vm_call_value(vm, method, mal_value_from_object((MalObject *) map), nullptr, 0);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
}

static MalValue mime_params_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor MIMEParams cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_object(mal_object_new(&vm->heap, prototype)), mime_new_map(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalPropertyDesc descriptor = mal_intrinsic_data_desc(roots[1], MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[0]), mal_key_from_value(mime_brand(callee)), &descriptor);
    mal_gc_unroot(&root);
    return roots[0];
}

// Slots: [brand, MIMEParams prototype].
static MalValue mime_type_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Class constructor MIMEType cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype;
    if (!mime_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &roots[0])
        || !mal_vm_get_prototype_from_constructor(vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        goto done;
    }
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalString *string = mal_value_to_string(roots[0]);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize position = 0;
    while (position < length && mime_space(units[position])) position++;
    usize type_end = mime_find(units, position, length, '/');
    i64 invalid = mime_invalid(units, position, type_end, mime_token);
    if (type_end == position || invalid != -1 || type_end == length) {
        mime_throw_syntax(vm, "type", string, invalid);
        goto done;
    }
    roots[2] = mime_lower(vm, units, position, type_end);
    position = type_end + 1;
    usize subtype_end = mime_find(units, position, length, ';');
    usize trimmed = mime_trailing_space(units, position, subtype_end);
    invalid = mime_invalid(units, position, trimmed, mime_token);
    if (trimmed == position || invalid != -1) {
        mime_throw_syntax(vm, "subtype", string, invalid);
        goto done;
    }
    roots[3] = mime_lower(vm, units, position, trimmed);
    position = subtype_end < length ? subtype_end + 1 : length;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    roots[4] = mal_value_from_object(mal_object_new(&vm->heap,
        mal_value_to_object(mal_native_function_object_get_slot(function, 1))));
    MalValue map = mime_new_map(vm);
    MalPropertyDesc descriptor = mal_intrinsic_data_desc(map, MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[4]), mal_key_from_value(mime_brand(callee)), &descriptor);
    mime_parse_params(vm, (MalMapObject *) mal_value_to_object(map), units, position, length);
    MalValue fields = mal_value_from_array_object(mal_intrinsic_new_array(vm, MIME_FIELD_COUNT));
    mime_set_field(fields, MIME_TYPE, roots[2]);
    mime_set_field(fields, MIME_SUBTYPE, roots[3]);
    mime_set_field(fields, MIME_PARAMS, roots[4]);
    descriptor = mal_intrinsic_data_desc(fields, MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(roots[1]), mal_key_from_value(mime_brand(callee)), &descriptor);
    result = roots[1];
done:
    mal_gc_unroot(&root);
    return result;
}

// Slots: [brand, MIMEType constructor].
static MalValue mime_type_parse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) new_target;
    MalValue constructor = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 1);
    MalValue argument = argc > 0 ? args[0] : mal_value_new_undefined();
    MalCompletion completion = mal_vm_construct_value(vm, constructor, &argument, 1);
    if (completion.kind != MAL_COMPLETION_THROW) return completion.value;
    MalValue error = completion.value;
    MalValue code = mal_value_new_undefined();
    if (mal_value_is_object(error)) {
        MalPropertyLookup found = mal_object_get_own(mal_value_to_object(error), mal_intrinsic_string_key(vm, "code"));
        if (found.present) code = found.desc.value;
    }
    if (!mal_value_is_string(code) || !mal_string_equals_ascii(mal_value_to_string(code), "ERR_INVALID_MIME_SYNTAX")) {
        return mal_value_new_undefined();
    }
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return mal_value_new_null();
}

static MalValue mime_type_get(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee, u32 index) {
    (void) args; (void) argc; (void) new_target;
    MalValue fields = mime_type_fields(vm, receiver, callee);
    return mal_value_is_undefined(fields) ? fields : mime_field(fields, index);
}

static MalValue mime_type_get_type(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return mime_type_get(vm, receiver, args, argc, new_target, callee, MIME_TYPE);
}

static MalValue mime_type_get_subtype(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return mime_type_get(vm, receiver, args, argc, new_target, callee, MIME_SUBTYPE);
}

static MalValue mime_type_get_params(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    return mime_type_get(vm, receiver, args, argc, new_target, callee, MIME_PARAMS);
}

static MalValue mime_type_set(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue callee, u32 index) {
    MalValue fields = mime_type_fields(vm, receiver, callee);
    MalValue roots[] = {fields, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(fields)
        && mime_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &roots[1])) {
        MalString *string = mal_value_to_string(roots[1]);
        const c16 *units = mal_string_code_units(string);
        usize length = mal_string_length(string);
        i64 invalid = mime_invalid(units, 0, length, mime_token);
        if (length == 0 || invalid != -1) {
            mime_throw_syntax(vm, index == MIME_TYPE ? "type" : "subtype", string, invalid);
        } else {
            mime_set_field(roots[0], index, mime_lower(vm, units, 0, length));
        }
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mime_type_set_type(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mime_type_set(vm, receiver, args, argc, callee, MIME_TYPE);
}

static MalValue mime_type_set_subtype(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) new_target;
    return mime_type_set(vm, receiver, args, argc, callee, MIME_SUBTYPE);
}

static void mime_append_essence(MalTextBuffer *out, MalValue fields) {
    MalString *type = mal_value_to_string(mime_field(fields, MIME_TYPE));
    MalString *subtype = mal_value_to_string(mime_field(fields, MIME_SUBTYPE));
    mal_text_buffer_append_units(out, mal_string_code_units(type), mal_string_length(type));
    mal_text_buffer_push(out, '/');
    mal_text_buffer_append_units(out, mal_string_code_units(subtype), mal_string_length(subtype));
}

static MalValue mime_type_essence(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target;
    MalValue fields = mime_type_fields(vm, receiver, callee);
    if (mal_value_is_undefined(fields)) return fields;
    MalTextBuffer buffer = {0};
    mime_append_essence(&buffer, fields);
    return mime_finish(vm, &buffer);
}

static MalValue mime_type_to_string(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) args; (void) argc; (void) new_target;
    MalValue fields = mime_type_fields(vm, receiver, callee);
    if (mal_value_is_undefined(fields)) return fields;
    MalTextBuffer buffer = {0};
    mime_append_essence(&buffer, fields);
    MalValue map = mime_get_field(mime_field(fields, MIME_PARAMS), mime_brand(callee));
    if (mal_value_is_object(map) && mal_map_object_size((MalMapObject *) mal_value_to_object(map)) > 0) {
        mal_text_buffer_push(&buffer, ';');
        mime_append_params(&buffer, (MalMapObject *) mal_value_to_object(map));
    }
    return mime_finish(vm, &buffer);
}

static MalValue mime_function(MalVm *vm, const char *name, i32 arity, MalNativeFunctionCallback callback,
    MalValue brand, MalValue extra) {
    MalValue slots[] = {brand, extra};
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), arity, callback, slots, countof(slots)));
}

static MalValue mime_class(MalVm *vm, const char *name, i32 arity, MalNativeFunctionCallback callback,
    MalValue brand, MalValue extra, MalValue prototype) {
    MalValue roots[] = {prototype, mime_function(vm, name, arity, callback, brand, extra)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *function = mal_value_to_native_function_object(roots[1]);
    mal_native_function_object_set_constructor(function);
    mal_native_function_object_set_handles_new_target_prototype(function);
    mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "constructor", roots[1], MIME_METHOD);
    mal_gc_unroot(&root);
    return roots[1];
}

static void mime_define(MalVm *vm, MalValue target, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, mal_value_to_object(target), (const byte *) name, value, MIME_METHOD);
}

static void mime_define_accessor(MalVm *vm, MalValue prototype, const char *name, MalNativeFunctionCallback getter,
    MalNativeFunctionCallback setter, MalValue brand) {
    char getter_name[32];
    char setter_name[32];
    snprintf(getter_name, sizeof getter_name, "get %s", name);
    snprintf(setter_name, sizeof setter_name, "set %s", name);
    MalValue functions[] = {mime_function(vm, getter_name, 0, getter, brand, mal_value_new_undefined()),
        mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, functions, countof(functions));
    if (setter != nullptr) functions[1] = mime_function(vm, setter_name, 1, setter, brand, mal_value_new_undefined());
    MalPropertyDesc descriptor = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .getter = functions[0],
        .setter = functions[1],
    };
    mal_object_define_own(mal_value_to_object(prototype), mal_intrinsic_string_key(vm, (const byte *) name), &descriptor);
    mal_gc_unroot(&root);
}

void mal_node_util_mime_install(MalVm *vm, MalObject *util) {
    enum { BRAND, PARAMS_PROTO, PARAMS_CTOR, TYPE_PROTO, TYPE_CTOR, TEMP, ROOT_COUNT };
    MalValue roots[ROOT_COUNT];
    for (usize i = 0; i < ROOT_COUNT; i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[BRAND] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[PARAMS_PROTO] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[PARAMS_CTOR] = mime_class(vm, "MIMEParams", 0, mime_params_constructor, roots[BRAND],
        mal_value_new_undefined(), roots[PARAMS_PROTO]);
    static const struct {
        const char *name;
        i32 arity;
        MalNativeFunctionCallback callback;
    } params_methods[] = {
        {"delete", 1, mime_params_delete},
        {"get", 1, mime_params_get},
        {"has", 1, mime_params_has},
        {"set", 2, mime_params_set},
    };
    for (usize i = 0; i < countof(params_methods); i++) {
        roots[TEMP] = mime_function(vm, params_methods[i].name, params_methods[i].arity, params_methods[i].callback,
            roots[BRAND], mal_value_new_undefined());
        mime_define(vm, roots[PARAMS_PROTO], params_methods[i].name, roots[TEMP]);
    }
    static const char *const iterators[] = {"entries", "keys", "values"};
    for (usize i = 0; i < countof(iterators); i++) {
        MalValue method = mal_value_new_undefined();
        (void) mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE],
            mal_intrinsic_string_key(vm, (const byte *) iterators[i]), &method);
        roots[TEMP] = mime_function(vm, iterators[i], 0, mime_params_iterate, roots[BRAND], method);
        mime_define(vm, roots[PARAMS_PROTO], iterators[i], roots[TEMP]);
        if (i == 0) {
            MalPropertyDesc descriptor = mal_intrinsic_data_desc(roots[TEMP], MIME_METHOD);
            mal_object_define_own(mal_value_to_object(roots[PARAMS_PROTO]),
                mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &descriptor);
        }
    }
    roots[TEMP] = mime_function(vm, "toString", 0, mime_params_to_string, roots[BRAND], mal_value_new_undefined());
    mime_define(vm, roots[PARAMS_PROTO], "toString", roots[TEMP]);
    mime_define(vm, roots[PARAMS_PROTO], "toJSON", roots[TEMP]);

    roots[TYPE_PROTO] = mal_value_from_object(mal_intrinsic_new_object(vm));
    roots[TYPE_CTOR] = mime_class(vm, "MIMEType", 1, mime_type_constructor, roots[BRAND], roots[PARAMS_PROTO],
        roots[TYPE_PROTO]);
    roots[TEMP] = mime_function(vm, "parse", 1, mime_type_parse, roots[BRAND], roots[TYPE_CTOR]);
    mime_define(vm, roots[TYPE_CTOR], "parse", roots[TEMP]);
    mime_define_accessor(vm, roots[TYPE_PROTO], "type", mime_type_get_type, mime_type_set_type, roots[BRAND]);
    mime_define_accessor(vm, roots[TYPE_PROTO], "subtype", mime_type_get_subtype, mime_type_set_subtype,
        roots[BRAND]);
    mime_define_accessor(vm, roots[TYPE_PROTO], "essence", mime_type_essence, nullptr, roots[BRAND]);
    mime_define_accessor(vm, roots[TYPE_PROTO], "params", mime_type_get_params, nullptr, roots[BRAND]);
    roots[TEMP] = mime_function(vm, "toString", 0, mime_type_to_string, roots[BRAND], mal_value_new_undefined());
    mime_define(vm, roots[TYPE_PROTO], "toString", roots[TEMP]);
    mime_define(vm, roots[TYPE_PROTO], "toJSON", roots[TEMP]);

    mal_intrinsic_define_data(vm, util, "MIMEType", roots[TYPE_CTOR], MIME_METHOD | MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, util, "MIMEParams", roots[PARAMS_CTOR], MIME_METHOD | MAL_PROPERTY_ENUMERABLE);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
