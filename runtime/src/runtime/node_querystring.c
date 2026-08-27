#include "node_querystring.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "hex.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "u16_buffer.h"
#include "utf16.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

#define QS_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue qs_empty_string(MalVm *vm) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ""));
}

static MalValue qs_builder_finish(MalVm *vm, MalU16Buffer *builder) {
    if (builder->status != MAL_U16_BUFFER_OK) {
        MalU16BufferStatus status = builder->status;
        mal_u16_buffer_dispose(builder);
        if (status == MAL_U16_BUFFER_LENGTH_OVERFLOW) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        } else {
            mal_vm_throw_allocation_error(vm);
        }
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_u16_buffer_finish(&vm->heap, builder));
}

static bool qs_contains(const c16 *units, usize length, c16 needle) {
    for (usize i = 0; i < length; i++) {
        if (units[i] == needle) return true;
    }
    return false;
}

static usize qs_find(
    const c16 *units, usize length, usize start,
    const c16 *needle, usize needle_length
) {
    if (needle_length == 0 || needle_length > length - start) return length;
    usize limit = length - needle_length;
    for (usize i = start; i <= limit; i++) {
        if (units[i] == needle[0]
            && memcmp(units + i, needle, needle_length * sizeof(c16)) == 0) {
            return i;
        }
    }
    return length;
}

/* Node's forgiving query-string decoder: malformed percent escapes remain
 * literal, while malformed UTF-8 becomes replacement characters. */
static MalValue qs_decode_native(
    MalVm *vm, MalString *source, usize start, usize length,
    bool decode_spaces
) {
    const c16 *units = mal_string_code_units(source) + start;
    bool has_plus = decode_spaces && qs_contains(units, length, '+');
    bool has_percent = qs_contains(units, length, '%');
    if (!has_plus && !has_percent) {
        return mal_value_from_string(
            mal_string_new_slice(&vm->heap, source, start, length));
    }
    if (!has_percent) {
        c16 *decoded = mal_heap_alloc_raw(&vm->heap, length * sizeof(*decoded));
        for (usize i = 0; i < length; i++) {
            decoded[i] = units[i] == '+' ? ' ' : units[i];
        }
        return mal_value_from_string(
            mal_string_new_owned(&vm->heap, decoded, length));
    }

    usize utf8_length;
    byte *utf8 = mal_utf8_encode(units, length, &utf8_length);
    if (utf8 == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    byte *decoded = malloc(utf8_length == 0 ? 1 : utf8_length);
    if (decoded == nullptr) {
        free(utf8);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize output = 0;
    for (usize i = 0; i < utf8_length; i++) {
        if (decode_spaces && utf8[i] == '+') {
            decoded[output++] = ' ';
        } else if (utf8[i] == '%' && i + 2 < utf8_length) {
            i32 high = mal_hex_decode_digit((u8) utf8[i + 1]);
            i32 low = mal_hex_decode_digit((u8) utf8[i + 2]);
            if (high >= 0 && low >= 0) {
                decoded[output++] = (byte) ((high << 4) | low);
                i += 2;
            } else {
                decoded[output++] = utf8[i];
            }
        } else {
            decoded[output++] = utf8[i];
        }
    }
    free(utf8);
    MalString *string = mal_string_from_utf8(&vm->heap, decoded, output);
    free(decoded);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

static MalValue qs_prepare_custom_decode(
    MalVm *vm, MalString *source, usize start, usize length
) {
    const c16 *units = mal_string_code_units(source) + start;
    if (!qs_contains(units, length, '+')) {
        return mal_value_from_string(
            mal_string_new_slice(&vm->heap, source, start, length));
    }
    MalU16Buffer builder = {0};
    for (usize i = 0; i < length; i++) {
        if (units[i] == '+') {
            mal_u16_buffer_append_ascii(&builder, (const byte *) "%20");
        } else {
            mal_u16_buffer_push(&builder, units[i]);
        }
    }
    return qs_builder_finish(vm, &builder);
}

static bool qs_get_option(
    MalVm *vm, MalValue options, const char *name, MalValue *out
) {
    *out = mal_value_new_undefined();
    if (!mal_value_is_object(options)) return true;
    return mal_vm_get_property(
        vm, options, mal_intrinsic_string_key(vm, (const byte *) name), out);
}

static MalValue qs_decode_component(
    MalVm *vm, MalString *source, usize start, usize length, MalValue decoder
) {
    if (!mal_value_is_callable(decoder)) {
        return qs_decode_native(vm, source, start, length, true);
    }
    MalValue argument = qs_prepare_custom_decode(vm, source, start, length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, &argument, 1);
    MalCompletion completion = mal_vm_call_value(
        vm, decoder, mal_value_new_undefined(), &argument, 1);
    mal_gc_unroot(&root);
    return completion.value;
}

static MalValue qs_parse(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue roots[] = {
        mal_value_from_object(mal_object_new(&vm->heap, nullptr)),
        argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 3 ? args[3] : mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_string(roots[1])
        || mal_string_length(mal_value_to_string(roots[1])) == 0) {
        MalValue result = roots[0];
        mal_gc_unroot(&root);
        return result;
    }

    MalString *source = mal_value_to_string(roots[1]);
    MalString *separator = argc > 1 && mal_value_is_string(args[1])
            && mal_string_length(mal_value_to_string(args[1])) > 0
        ? mal_value_to_string(args[1])
        : mal_intrinsic_ascii(vm, (const byte *) "&");
    MalString *equal = argc > 2 && mal_value_is_string(args[2])
            && mal_string_length(mal_value_to_string(args[2])) > 0
        ? mal_value_to_string(args[2])
        : mal_intrinsic_ascii(vm, (const byte *) "=");

    f64 remaining = 1000;
    bool unlimited = false;
    if (!qs_get_option(vm, roots[2], "maxKeys", &roots[3])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (mal_ops_is_number(roots[3])) {
        remaining = mal_ops_number_as_f64(roots[3]);
        unlimited = !(remaining > 0);
    }
    if (!qs_get_option(vm, roots[2], "decodeURIComponent", &roots[3])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(roots[3])) roots[3] = mal_value_new_undefined();

    const c16 *units = mal_string_code_units(source);
    usize length = mal_string_length(source);
    const c16 *separator_units = mal_string_code_units(separator);
    usize separator_length = mal_string_length(separator);
    const c16 *equal_units = mal_string_code_units(equal);
    usize equal_length = mal_string_length(equal);
    usize start = 0;
    while (start < length && (unlimited || remaining > 0)) {
        usize end = qs_find(
            units, length, start, separator_units, separator_length);
        if (end == start) {
            start = end == length ? length : end + separator_length;
            continue;
        }
        usize assignment = qs_find(
            units, end, start, equal_units, equal_length);
        roots[4] = qs_decode_component(
            vm, source, start, assignment - start, roots[3]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        usize value_start = assignment < end ? assignment + equal_length : end;
        roots[5] = qs_decode_component(
            vm, source, value_start, end - value_start, roots[3]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }

        MalKey key;
        if (!mal_vm_value_to_property_key(vm, roots[4], &key)) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        MalPropertyLookup prior = mal_object_get_own(
            mal_value_to_object(roots[0]), key);
        if (!prior.present) {
            MalPropertyDesc desc = {.flags = QS_VISIBLE, .value = roots[5]};
            mal_object_define_own(mal_value_to_object(roots[0]), key, &desc);
        } else if (mal_value_is_array_object(prior.desc.value)) {
            MalArrayObject *array = mal_value_to_array_object(prior.desc.value);
            mal_array_object_store(
                array, mal_key_index((i32) mal_array_object_length(array)), roots[5]);
        } else {
            MalArrayObject *array = mal_intrinsic_new_dense_array(vm, 2);
            roots[4] = mal_value_from_array_object(array);
            mal_array_object_store(array, mal_key_index(0), prior.desc.value);
            mal_array_object_store(array, mal_key_index(1), roots[5]);
            MalPropertyDesc desc = {.flags = QS_VISIBLE, .value = roots[4]};
            mal_object_define_own(mal_value_to_object(roots[0]), key, &desc);
        }
        if (!unlimited) remaining -= 1;
        start = end == length ? length : end + separator_length;
    }
    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static bool qs_escape_allowed(u8 value) {
    return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z')
        || (value >= '0' && value <= '9') || value == '!' || value == '-'
        || value == '.' || value == '_' || value == '~' || value == '\''
        || value == '(' || value == ')' || value == '*';
}

static MalValue qs_escape_string(MalVm *vm, MalString *string) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    for (usize i = 0; i < length;) {
        u32 scalar;
        usize width;
        if (!mal_utf16_read_scalar(units, length, i, &scalar, &width)) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        i += width;
    }
    usize byte_length;
    byte *bytes = mal_utf8_encode(units, length, &byte_length);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    static const byte hex[] = "0123456789ABCDEF";
    MalU16Buffer builder = {0};
    for (usize i = 0; i < byte_length; i++) {
        u8 value = (u8) bytes[i];
        if (qs_escape_allowed(value)) {
            mal_u16_buffer_push(&builder, value);
        } else {
            mal_u16_buffer_push(&builder, '%');
            mal_u16_buffer_push(&builder, (c16) hex[value >> 4]);
            mal_u16_buffer_push(&builder, (c16) hex[value & 0x0f]);
        }
    }
    free(bytes);
    return qs_builder_finish(vm, &builder);
}

static MalValue qs_escape(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_vm_to_string(
            vm, argc > 0 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    return qs_escape_string(vm, string);
}

static MalValue qs_unescape(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue input = argc > 0 ? args[0] : mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &input, 1);
    MalString *string;
    if (!mal_vm_to_string(vm, input, &string)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    bool decode_spaces = argc > 1 && mal_value_is_truthy(args[1]);
    MalValue result = qs_decode_native(
        vm, string, 0, mal_string_length(string), decode_spaces);
    mal_gc_unroot(&root);
    return result;
}

static MalValue qs_unescape_buffer(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"string\" argument must be of type string");
        return mal_value_new_undefined();
    }
    MalString *string = mal_value_to_string(args[0]);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    byte *decoded = malloc(length == 0 ? 1 : length);
    if (decoded == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    bool decode_spaces = argc > 1 && mal_value_is_truthy(args[1]);
    usize output = 0;
    for (usize i = 0; i < length; i++) {
        if (decode_spaces && units[i] == '+') {
            decoded[output++] = ' ';
        } else if (units[i] == '%' && i + 2 < length) {
            i32 high = units[i + 1] <= 0xff
                ? mal_hex_decode_digit((u8) units[i + 1]) : -1;
            i32 low = units[i + 2] <= 0xff
                ? mal_hex_decode_digit((u8) units[i + 2]) : -1;
            if (high >= 0 && low >= 0) {
                decoded[output++] = (byte) ((high << 4) | low);
                i += 2;
            } else {
                decoded[output++] = (byte) units[i];
            }
        } else {
            decoded[output++] = (byte) units[i];
        }
    }
    return mal_node_buffer_from_owned_bytes(vm, decoded, output);
}

static MalValue qs_stringifiable(MalVm *vm, MalValue value) {
    if (mal_value_is_string(value)) return value;
    if (mal_value_is_boolean(value) || mal_value_is_bigint(value)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, value));
    }
    if (mal_ops_is_number(value)
        && isfinite(mal_ops_number_as_f64(value))) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, value));
    }
    return qs_empty_string(vm);
}

static MalValue qs_encode_component(
    MalVm *vm, MalValue string, MalValue encoder
) {
    if (!mal_value_is_callable(encoder)) {
        return qs_escape_string(vm, mal_value_to_string(string));
    }
    MalCompletion completion = mal_vm_call_value(
        vm, encoder, mal_value_new_undefined(), &string, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue result = completion.value;
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    MalString *coerced;
    if (!mal_vm_to_string(vm, result, &coerced)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalValue value = mal_value_from_string(coerced);
    mal_gc_unroot(&root);
    return value;
}

static bool qs_append_pair(
    MalVm *vm, MalU16Buffer *builder, bool *first,
    MalString *separator, MalString *equal,
    MalValue encoded_key, MalValue value, MalValue encoder
) {
    MalValue roots[] = {
        encoded_key, qs_stringifiable(vm, value), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = qs_encode_component(vm, roots[1], encoder);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return false;
    }
    if (!*first) mal_u16_buffer_append_string(builder, separator);
    *first = false;
    mal_u16_buffer_append_string(builder, mal_value_to_string(roots[0]));
    mal_u16_buffer_append_string(builder, equal);
    mal_u16_buffer_append_string(builder, mal_value_to_string(roots[2]));
    mal_gc_unroot(&root);
    return builder->status == MAL_U16_BUFFER_OK;
}

static MalValue qs_stringify(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_object(args[0])) return qs_empty_string(vm);

    MalString *separator = argc > 1 && mal_value_is_string(args[1])
            && mal_string_length(mal_value_to_string(args[1])) > 0
        ? mal_value_to_string(args[1])
        : mal_intrinsic_ascii(vm, (const byte *) "&");
    MalString *equal = argc > 2 && mal_value_is_string(args[2])
            && mal_string_length(mal_value_to_string(args[2])) > 0
        ? mal_value_to_string(args[2])
        : mal_intrinsic_ascii(vm, (const byte *) "=");
    MalValue roots[] = {
        args[0], argc > 3 ? args[3] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!qs_get_option(vm, roots[1], "encodeURIComponent", &roots[2])) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(roots[2])) roots[2] = mal_value_new_undefined();

    MalObject *object = mal_value_to_object(roots[0]);
    usize capacity = 0;
    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc desc;
    mal_property_iter_init(
        &iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) capacity++;
    }
    MalKey *keys = capacity > 0 ? malloc(capacity * sizeof(*keys)) : nullptr;
    MalValue *key_values = capacity > 0
        ? malloc(capacity * sizeof(*key_values)) : nullptr;
    if (capacity > 0 && (keys == nullptr || key_values == nullptr)) {
        free(keys);
        free(key_values);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize key_count = 0;
    mal_property_iter_init(
        &iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) {
            keys[key_count] = key;
            key_values[key_count++] = key.value;
        }
    }
    MalRootSpan key_root;
    mal_gc_root(&key_root, key_values, (i32) key_count);
    MalU16Buffer builder = {0};
    bool first = true;
    bool ok = true;
    for (usize i = 0; i < key_count && ok; i++) {
        MalPropertyLookup lookup = mal_object_get_own(object, keys[i]);
        if (!lookup.present || !(lookup.desc.flags & MAL_PROPERTY_ENUMERABLE)) continue;
        if (!mal_vm_get_property(vm, roots[0], keys[i], &roots[3])) {
            ok = false;
            break;
        }
        MalString *key_string;
        if (!mal_vm_to_string(vm, key_values[i], &key_string)) {
            ok = false;
            break;
        }
        roots[4] = mal_value_from_string(key_string);
        roots[4] = qs_encode_component(vm, roots[4], roots[2]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            ok = false;
            break;
        }
        if (mal_value_is_array_object(roots[3])) {
            u32 length = mal_array_object_length(
                mal_value_to_array_object(roots[3]));
            for (u32 item = 0; item < length; item++) {
                MalValue element;
                if (!mal_vm_get_property(vm, roots[3], mal_key_index(item), &element)
                    || !qs_append_pair(vm, &builder, &first, separator, equal,
                        roots[4], element, roots[2])) {
                    ok = false;
                    break;
                }
            }
        } else {
            ok = qs_append_pair(vm, &builder, &first, separator, equal,
                roots[4], roots[3], roots[2]);
        }
    }
    mal_gc_unroot(&key_root);
    mal_gc_unroot(&root);
    free(keys);
    free(key_values);
    if (!ok) {
        if (builder.status != MAL_U16_BUFFER_OK
            && vm->completion.kind != MAL_COMPLETION_THROW) {
            return qs_builder_finish(vm, &builder);
        }
        mal_u16_buffer_dispose(&builder);
        return mal_value_new_undefined();
    }
    return qs_builder_finish(vm, &builder);
}

void mal_host_install_node_querystring(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_QUERYSTRING_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[] = {
            mal_value_from_object(mal_intrinsic_new_object(vm)),
            mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined(), mal_value_new_undefined(),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        MalObject *function_prototype = mal_value_to_object(
            vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
#define QS_FUNCTION(index, name, length, callback) \
        roots[index] = mal_value_from_native_function_object( \
            mal_native_function_object_new_arity(&vm->heap, function_prototype, \
                mal_intrinsic_ascii(vm, (const byte *) name), length, callback))
        QS_FUNCTION(1, "unescapeBuffer", 2, qs_unescape_buffer);
        QS_FUNCTION(2, "unescape", 2, qs_unescape);
        QS_FUNCTION(3, "escape", 1, qs_escape);
        QS_FUNCTION(4, "stringify", 4, qs_stringify);
        QS_FUNCTION(5, "parse", 4, qs_parse);
#undef QS_FUNCTION
        MalObject *object = mal_value_to_object(roots[0]);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "unescapeBuffer", roots[1], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "unescape", roots[2], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "escape", roots[3], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "stringify", roots[4], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "encode", roots[4], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "parse", roots[5], QS_VISIBLE);
        mal_intrinsic_define_data(vm, object,
            (const byte *) "decode", roots[5], QS_VISIBLE);
        module = roots[0];
        vm->intrinsics[MAL_INTRINSIC_NODE_QUERYSTRING_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
