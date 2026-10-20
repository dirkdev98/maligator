// Portions derived from Node.js lib/internal/util/inspect.js (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_module.h"

#if MAL_NODE

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "heap_bigint.h"
#include "heap_symbol.h"
#include "intern_store.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "gc.h"
#include "heap_string.h"
#include "posix_fs.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm_ops.h"

MalValue mal_node_module_get_cached(MalVm *vm, const char *id) {
    MalValue registry = vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES];
    if (mal_value_is_undefined(registry)) return mal_value_new_undefined();
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(registry),
        mal_intrinsic_string_key(vm, (const byte *) id));
    return found.present ? found.desc.value : mal_value_new_undefined();
}

/* Process exports inherit EventEmitter data properties; installation must not invoke accessors. */
static bool mal_node_module_lookup(MalObject *object, MalKey key, MalValue *out) {
    for (; object != nullptr; object = mal_object_prototype(object)) {
        MalPropertyLookup found = mal_object_get_own(object, key);
        if (found.present) {
            if ((found.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
                return false;
            }
            *out = found.desc.value;
            return true;
        }
    }
    return false;
}

void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module) {
    MalRootSpan root;
    mal_gc_root(&root, &module, 1);
    if (mal_value_is_undefined(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES])) {
        vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES] = mal_value_from_object(
            mal_object_new(&vm->heap, nullptr));
    }
    mal_intrinsic_define_data(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUILTIN_MODULES]),
        (const byte *) id, module, MAL_PROPERTY_NONE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module;
            continue;
        }
        MalValue found;
        if (mal_node_module_lookup(
                mal_value_to_object(module),
                mal_intrinsic_string_key(vm, (const byte *) slots[i].name), &found)) {
            vm->globals[slots[i].slot] = found;
        }
    }
    mal_gc_unroot(&root);
}

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count) {
    MalValue module = mal_node_module_get_cached(vm, id);
    if (mal_value_is_undefined(module)) return false;
    mal_node_module_publish(vm, id, slots, count, module);
    return true;
}

MalNodeBrandCheck mal_node_key_object_brand;
MalNodeBrandCheck mal_node_crypto_key_brand;

void mal_node_throw_code(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code) {
    MalString *text = mal_string_from_utf8(&vm->heap, (const byte *) message, strlen(message));
    if (text == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    MalValue text_value = mal_value_from_string(text);
    MalRootSpan text_root;
    mal_gc_root(&text_root, &text_value, 1);
    mal_vm_throw_error_value(vm, prototype, text_value);
    mal_gc_unroot(&text_root);
    MalValue roots[] = {
        vm->completion.value, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) code)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "code",
            roots[1], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
}

static void mal_node_copy_utf8(const MalString *string, char *out, usize capacity) {
    usize length = 0;
    byte *utf8 = mal_string_to_utf8((MalString *) string, &length);
    if (utf8 == nullptr) {
        out[0] = '\0';
        return;
    }
    if (length >= capacity) {
        length = capacity - 1;
        while (length > 0 && ((u8) utf8[length] & 0xc0) == 0x80) length--;
    }
    memcpy(out, utf8, length);
    out[length] = '\0';
    free(utf8);
}

/* util.inspect of a number: String(n), except that -0 keeps its sign. */
static void mal_node_number_text(MalVm *vm, f64 number, char *out, usize capacity) {
    if (number == 0 && signbit(number)) {
        snprintf(out, capacity, "-0");
        return;
    }
    mal_node_copy_utf8(mal_ops_to_string(&vm->heap, mal_value_from_f64(number)), out, capacity);
}

/* lib/internal/errors.js addNumericalSeparator, applied to the String() form. */
static void mal_node_numerical_separator(const char *text, char *out, usize capacity) {
    usize length = strlen(text);
    usize start = text[0] == '-' ? 1 : 0;
    usize head = length;
    while (head >= start + 4) head -= 3;
    usize written = 0;
    for (usize i = 0; i < length && written + 2 < capacity; i++) {
        if (i >= head && (i - head) % 3 == 0) out[written++] = '_';
        out[written++] = text[i];
    }
    out[written] = '\0';
}

static void mal_node_quote_string(MalVm *vm, MalString *string, bool truncate, char *out, usize capacity) {
    usize length = mal_string_length(string);
    bool truncated = truncate && length > 28;
    MalString *shown = truncated ? mal_string_new_slice(&vm->heap, string, 0, 25) : string;
    char text[256];
    mal_node_copy_utf8(shown, text, sizeof text);
    const char *suffix = truncated ? "..." : "";
    if (strchr(text, '\'') == nullptr) {
        snprintf(out, capacity, "'%s%s'", text, suffix);
        return;
    }
    char escaped[512];
    usize written = 0;
    for (const char *c = text; *c != '\0' && written + 3 < sizeof escaped; c++) {
        if (*c == '"' || *c == '\\') escaped[written++] = '\\';
        escaped[written++] = *c;
    }
    escaped[written] = '\0';
    snprintf(out, capacity, "\"%s%s\"", escaped, suffix);
}

static bool mal_node_get_ascii(MalVm *vm, MalValue object, const char *name, MalValue *out) {
    if (mal_vm_get_property(vm, object, mal_intrinsic_string_key(vm, (const byte *) name), out)) {
        return true;
    }
    vm->completion.kind = MAL_COMPLETION_NORMAL;
    vm->completion.value = mal_value_new_undefined();
    return false;
}

static usize mal_node_put_utf8(char *out, usize at, usize capacity, u32 code) {
    char bytes[4];
    usize count = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (count == 1) bytes[0] = (char) code;
    else if (count == 2) bytes[0] = (char) (0xc0 | code >> 6), bytes[1] = (char) (0x80 | (code & 0x3f));
    else if (count == 3) {
        bytes[0] = (char) (0xe0 | code >> 12), bytes[1] = (char) (0x80 | (code >> 6 & 0x3f));
        bytes[2] = (char) (0x80 | (code & 0x3f));
    } else {
        bytes[0] = (char) (0xf0 | code >> 18), bytes[1] = (char) (0x80 | (code >> 12 & 0x3f));
        bytes[2] = (char) (0x80 | (code >> 6 & 0x3f)), bytes[3] = (char) (0x80 | (code & 0x3f));
    }
    if (at + count >= capacity) return at;
    memcpy(out + at, bytes, count);
    return at + count;
}

// lib/internal/util/inspect.js strEscape, then ERR_INVALID_ARG_VALUE's cut to 128 UTF-16 units.
void mal_node_inspect_string(MalString *string, char *out, usize capacity) {
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    bool has_single = false, has_double = false, has_backtick = false, has_template = false;
    for (usize i = 0; i < length; i++) {
        has_single |= units[i] == '\'';
        has_double |= units[i] == '"';
        has_backtick |= units[i] == '`';
        has_template |= units[i] == '$' && i + 1 < length && units[i + 1] == '{';
    }
    c16 quote = !has_single ? '\'' : !has_double ? '"' : !has_backtick && !has_template ? '`' : '\'';
    c16 inspected[128];
    usize count = 0;
    bool cut = false;
#define MAL_INSPECT_PUSH(unit) \
    do { \
        if (count == countof(inspected)) { \
            cut = true; \
            goto encode; \
        } \
        inspected[count++] = (c16) (unit); \
    } while (0)
    MAL_INSPECT_PUSH(quote);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        char escape[8] = {0};
        bool lone = unit >= 0xd800 && unit <= 0xdfff
            && !(unit <= 0xdbff && i + 1 < length && units[i + 1] >= 0xdc00 && units[i + 1] <= 0xdfff)
            && !(unit >= 0xdc00 && i > 0 && units[i - 1] >= 0xd800 && units[i - 1] <= 0xdbff);
        if (unit == '\b') strcpy(escape, "\\b");
        else if (unit == '\t') strcpy(escape, "\\t");
        else if (unit == '\n') strcpy(escape, "\\n");
        else if (unit == '\f') strcpy(escape, "\\f");
        else if (unit == '\r') strcpy(escape, "\\r");
        else if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) snprintf(escape, sizeof escape, "\\x%02X", unit);
        else if (unit == '\\') strcpy(escape, "\\\\");
        else if (unit == '\'' && quote == '\'') strcpy(escape, "\\'");
        else if (lone) snprintf(escape, sizeof escape, "\\u%x", unit);
        if (escape[0] == '\0') {
            MAL_INSPECT_PUSH(unit);
        } else {
            for (const char *c = escape; *c != '\0'; c++) MAL_INSPECT_PUSH(*c);
        }
    }
    MAL_INSPECT_PUSH(quote);
#undef MAL_INSPECT_PUSH
encode:;
    usize at = 0;
    for (usize i = 0; i < count; i++) {
        u32 code = inspected[i];
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < count && inspected[i + 1] >= 0xdc00 && inspected[i + 1] <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (u32) (inspected[++i] - 0xdc00);
        }
        at = mal_node_put_utf8(out, at, capacity, code);
    }
    if (cut && at + 3 < capacity) {
        memcpy(out + at, "...", 3);
        at += 3;
    }
    out[at] = '\0';
}

void mal_node_describe_received(MalVm *vm, MalValue value, char *out, usize capacity) {
    char text[256];
    if (mal_value_is_null(value)) {
        snprintf(out, capacity, "null");
    } else if (mal_value_is_undefined(value)) {
        snprintf(out, capacity, "undefined");
    } else if (mal_value_is_bigint(value)) {
        mal_node_copy_utf8(mal_ops_to_string(&vm->heap, value), text, sizeof text);
        snprintf(out, capacity, "type bigint (%sn)", text);
    } else if (mal_ops_is_number(value)) {
        mal_node_number_text(vm, mal_ops_number_as_f64(value), text, sizeof text);
        snprintf(out, capacity, "type number (%s)", text);
    } else if (mal_value_is_boolean(value)) {
        snprintf(out, capacity, "type boolean (%s)", mal_value_is_truthy(value) ? "true" : "false");
    } else if (mal_value_is_symbol(value)) {
        MalString *description = mal_symbol_description(mal_value_to_symbol(value));
        if (description == nullptr) text[0] = '\0';
        else mal_node_copy_utf8(description, text, sizeof text);
        snprintf(out, capacity, "type symbol (Symbol(%s))", text);
    } else if (mal_value_is_string(value)) {
        char quoted[300];
        mal_node_quote_string(vm, mal_value_to_string(value), true, quoted, sizeof quoted);
        snprintf(out, capacity, "type string (%s)", quoted);
    } else if (mal_value_is_callable(value)) {
        MalValue name = mal_value_new_undefined();
        text[0] = '\0';
        if (mal_node_get_ascii(vm, value, "name", &name) && mal_value_is_string(name)) {
            mal_node_copy_utf8(mal_value_to_string(name), text, sizeof text);
        }
        snprintf(out, capacity, "function %s", text);
    } else {
        MalValue constructor = mal_value_new_undefined();
        MalValue name = mal_value_new_undefined();
        if (mal_node_get_ascii(vm, value, "constructor", &constructor)
            && mal_value_is_truthy(constructor) && mal_value_is_object(constructor)
            && mal_node_get_ascii(vm, constructor, "name", &name)) {
            MalString *string = mal_value_is_string(name) ? mal_value_to_string(name)
                : mal_ops_to_string(&vm->heap, name);
            mal_node_copy_utf8(string, text, sizeof text);
            snprintf(out, capacity, "an instance of %s", text);
        } else {
            snprintf(out, capacity, "[Object: null prototype] {}");
        }
    }
}

static void mal_node_describe_range_received(MalVm *vm, MalValue value, char *out, usize capacity) {
    char text[256];
    if (mal_ops_is_number(value)) {
        f64 number = mal_ops_number_as_f64(value);
        mal_node_number_text(vm, number, text, sizeof text);
        if (isfinite(number) && trunc(number) == number && fabs(number) > 4294967296.0) {
            mal_node_numerical_separator(text, out, capacity);
        } else {
            snprintf(out, capacity, "%s", text);
        }
    } else if (mal_value_is_bigint(value)) {
        mal_node_copy_utf8(mal_ops_to_string(&vm->heap, value), text, sizeof text);
        i128 number = mal_bigint_value(mal_value_to_bigint(value));
        char grouped[300];
        if (number > ((i128) 1 << 32) || number < -((i128) 1 << 32)) {
            mal_node_numerical_separator(text, grouped, sizeof grouped);
        } else {
            snprintf(grouped, sizeof grouped, "%s", text);
        }
        snprintf(out, capacity, "%sn", grouped);
    } else if (mal_value_is_string(value)) {
        mal_node_quote_string(vm, mal_value_to_string(value), false, out, capacity);
    } else {
        mal_node_describe_received(vm, value, out, capacity);
    }
}

void mal_node_throw_invalid_arg_type(
    MalVm *vm, const char *name, const char *expected, MalValue actual) {
    char received[320];
    mal_node_describe_received(vm, actual, received, sizeof received);
    char message[640];
    usize name_length = strlen(name);
    if (name_length >= 9 && strcmp(name + name_length - 9, " argument") == 0) {
        snprintf(message, sizeof message, "The %s must be %s. Received %s", name, expected, received);
    } else {
        snprintf(message, sizeof message, "The \"%s\" %s must be %s. Received %s", name,
            strchr(name, '.') != nullptr ? "property" : "argument", expected, received);
    }
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_TYPE");
}

void mal_node_throw_out_of_range(MalVm *vm, const char *name, const char *range, MalValue actual) {
    char received[320];
    mal_node_describe_range_received(vm, actual, received, sizeof received);
    char message[640];
    snprintf(message, sizeof message,
        "The value of \"%s\" is out of range. It must be %s. Received %s", name, range, received);
    mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_OUT_OF_RANGE");
}

MalValue mal_node_registered_symbol(MalVm *vm, const char *key) {
    MalString *description = mal_intrinsic_ascii(vm, (const byte *) key);
    MalSymbol *symbol = mal_symbol_registry_find(&vm->symbol_registry, description);
    if (symbol == nullptr) {
        symbol = mal_symbol_registry_insert(
            &vm->symbol_registry, mal_symbol_new(&vm->heap, description));
    }
    return mal_value_from_symbol(symbol);
}

MalValue mal_node_inspect_custom_symbol(MalVm *vm) {
    return mal_node_registered_symbol(vm, "nodejs.util.inspect.custom");
}

MalValue mal_node_abort_error(MalVm *vm, MalValue cause) {
    mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "The operation was aborted", "ABORT_ERR");
    MalValue roots[] = {vm->completion.value, cause};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "name",
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "AbortError")),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "cause",
            roots[1], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return roots[0];
}

bool mal_node_validate_number(MalVm *vm, MalValue value, const char *name) {
    if (mal_ops_is_number(value)) return true;
    mal_node_throw_invalid_arg_type(vm, name, "of type number", value);
    return false;
}

bool mal_node_validate_integer(
    MalVm *vm, MalValue value, const char *name, f64 min, f64 max, f64 *out) {
    if (!mal_node_validate_number(vm, value, name)) return false;
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number) {
        mal_node_throw_out_of_range(vm, name, "an integer", value);
        return false;
    }
    if (number < min || number > max) {
        char range[96];
        snprintf(range, sizeof range, ">= %.17g && <= %.17g", min, max);
        mal_node_throw_out_of_range(vm, name, range, value);
        return false;
    }
    *out = number;
    return true;
}

static void mal_node_define_utf8(MalVm *vm, MalObject *object, const char *name, const char *text) {
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) text, strlen(text));
    if (string == nullptr) return;
    MalValue value = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, object, (const byte *) name, value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

void mal_node_throw_errno(
    MalVm *vm, int err, const char *syscall, const char *path, const char *dest) {
    const char *code = mal_posix_fs_errno_name(err);
    const char *description = mal_posix_errno_description(err);
    usize capacity = strlen(code) + strlen(description) + strlen(syscall)
        + (path == nullptr ? 0 : strlen(path)) + (dest == nullptr ? 0 : strlen(dest)) + 24;
    char *message = malloc(capacity);
    if (message == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    if (path == nullptr) {
        snprintf(message, capacity, "%s: %s, %s", code, description, syscall);
    } else if (dest == nullptr) {
        snprintf(message, capacity, "%s: %s, %s '%s'", code, description, syscall, path);
    } else {
        snprintf(message, capacity, "%s: %s, %s '%s' -> '%s'",
            code, description, syscall, path, dest);
    }
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) message, strlen(message));
    free(message);
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return;
    }
    MalValue text = mal_value_from_string(string);
    MalRootSpan root;
    mal_gc_root(&root, &text, 1);
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, text);
    mal_gc_unroot(&root);
    MalValue thrown = vm->completion.value;
    if (!mal_value_is_object(thrown)) return;
    // The completion keeps the error reachable while its properties allocate.
    MalObject *error = mal_value_to_object(thrown);
    mal_intrinsic_define_data(vm, error, (const byte *) "errno", mal_value_from_i32(-err),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_node_define_utf8(vm, error, "code", code);
    mal_node_define_utf8(vm, error, "syscall", syscall);
    if (path != nullptr) mal_node_define_utf8(vm, error, "path", path);
    if (dest != nullptr) mal_node_define_utf8(vm, error, "dest", dest);
}

#endif
