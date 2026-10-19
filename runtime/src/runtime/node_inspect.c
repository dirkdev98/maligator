#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "node_inspect.h"

#if MAL_NODE

#include "array_buffer_object.h"
#include "array_object.h"
#include "ascii.h"
#include "builtin_bigint.h"
#include "builtin_error.h"
#include "date_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "map_object.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "primitive_wrapper_object.h"
#include "promise_object.h"
#include "property_iter.h"
#include "property_store.h"
#include "proxy_object.h"
#include "set_object.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define UTIL_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue inspect_finish(MalVm *vm, MalTextBuffer *builder) {
    if (builder->status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(builder);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Formatted output exceeds the string length limit");
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_text_buffer_finish(&vm->heap, builder));
}

typedef enum UtilStyle : u8 {
    UTIL_STYLE_NONE,
    UTIL_STYLE_SPECIAL,
    UTIL_STYLE_NUMBER,
    UTIL_STYLE_BIGINT,
    UTIL_STYLE_BOOLEAN,
    UTIL_STYLE_UNDEFINED,
    UTIL_STYLE_NULL,
    UTIL_STYLE_STRING,
    UTIL_STYLE_SYMBOL,
    UTIL_STYLE_DATE,
    UTIL_STYLE_REGEXP,
    UTIL_STYLE_NAME,
    UTIL_STYLE_MODULE,
} UtilStyle;

static const char *const util_style_names[] = {
    "", "special", "number", "bigint", "boolean", "undefined", "null", "string",
    "symbol", "date", "regexp", "name", "module",
};

static const char *const util_style_defaults[] = {
    nullptr, "cyan", "yellow", "yellow", "yellow", "grey", "bold", "green",
    "green", "magenta", "red", nullptr, "underline",
};

typedef struct UtilColor {
    const char *name;
    u8 open;
    u8 close;
    bool alias;
} UtilColor;

static const UtilColor util_colors[] = {
    {"reset", 0, 0, false}, {"bold", 1, 22, false}, {"dim", 2, 22, false},
    {"italic", 3, 23, false}, {"underline", 4, 24, false}, {"blink", 5, 25, false},
    {"inverse", 7, 27, false}, {"hidden", 8, 28, false}, {"strikethrough", 9, 29, false},
    {"doubleunderline", 21, 24, false}, {"black", 30, 39, false}, {"red", 31, 39, false},
    {"green", 32, 39, false}, {"yellow", 33, 39, false}, {"blue", 34, 39, false},
    {"magenta", 35, 39, false}, {"cyan", 36, 39, false}, {"white", 37, 39, false},
    {"bgBlack", 40, 49, false}, {"bgRed", 41, 49, false}, {"bgGreen", 42, 49, false},
    {"bgYellow", 43, 49, false}, {"bgBlue", 44, 49, false}, {"bgMagenta", 45, 49, false},
    {"bgCyan", 46, 49, false}, {"bgWhite", 47, 49, false}, {"framed", 51, 54, false},
    {"overlined", 53, 55, false}, {"gray", 90, 39, false}, {"redBright", 91, 39, false},
    {"greenBright", 92, 39, false}, {"yellowBright", 93, 39, false},
    {"blueBright", 94, 39, false}, {"magentaBright", 95, 39, false},
    {"cyanBright", 96, 39, false}, {"whiteBright", 97, 39, false},
    {"bgGray", 100, 49, false}, {"bgRedBright", 101, 49, false},
    {"bgGreenBright", 102, 49, false}, {"bgYellowBright", 103, 49, false},
    {"bgBlueBright", 104, 49, false}, {"bgMagentaBright", 105, 49, false},
    {"bgCyanBright", 106, 49, false}, {"bgWhiteBright", 107, 49, false},
    {"grey", 90, 39, true}, {"blackBright", 90, 39, true}, {"bgGrey", 100, 49, true},
    {"bgBlackBright", 100, 49, true}, {"faint", 2, 22, true}, {"crossedout", 9, 29, true},
    {"strikeThrough", 9, 29, true}, {"crossedOut", 9, 29, true}, {"conceal", 8, 28, true},
    {"swapColors", 7, 27, true}, {"swapcolors", 7, 27, true},
    {"doubleUnderline", 21, 24, true},
};

#define UTIL_COMPACT_TRUE (-1)
#define UTIL_EXTRAS_OBJECT 0
#define UTIL_EXTRAS_ARRAY 1

enum {
    UTIL_ROOT_STYLES,
    UTIL_ROOT_COLORS,
    UTIL_ROOT_INSPECT,
    UTIL_ROOT_OPTIONS,
    UTIL_ROOT_COUNT,
};

typedef struct UtilCircular {
    MalObject *object;
    i32 index;
} UtilCircular;

typedef struct UtilEntry {
    usize offset;
    usize length;
    usize width;
} UtilEntry;

typedef struct UtilEntries {
    UtilEntry *items;
    usize count;
    usize capacity;
    UtilEntry inline_items[8];
} UtilEntries;

typedef struct UtilCtx {
    MalVm *vm;
    MalTextBuffer *out;
    MalTextBuffer scratch;
    MalObject **seen;
    usize seen_count;
    usize seen_capacity;
    UtilCircular *circular;
    usize circular_count;
    usize circular_capacity;
    MalValue roots[UTIL_ROOT_COUNT];
    MalRootSpan root;
    f64 depth;
    f64 max_array_length;
    f64 max_string_length;
    f64 break_length;
    i32 compact;
    i32 indentation;
    i32 current_depth;
    u8 getters;
    bool show_hidden;
    bool colors;
    bool custom_inspect;
    bool sorted;
    bool failed;
} UtilCtx;

static bool util_fmt_value(UtilCtx *ctx, MalValue value, i32 recurse);

static void util_ascii(UtilCtx *ctx, const char *ascii) {
    mal_text_buffer_append_ascii(ctx->out, (const byte *) ascii);
}

static void util_unit(UtilCtx *ctx, c16 unit) {
    mal_text_buffer_push(ctx->out, unit);
}

static void util_spaces(MalTextBuffer *out, i32 count) {
    for (i32 i = 0; i < count; i++) mal_text_buffer_push(out, ' ');
}

static void util_u64(UtilCtx *ctx, u64 value) {
    char text[32];
    snprintf(text, sizeof text, "%llu", (unsigned long long) value);
    util_ascii(ctx, text);
}

static void util_append_slice(
    MalTextBuffer *destination, const MalTextBuffer *source, usize offset, usize length) {
    if (length == 0) return;
    if (source->utf16) {
        mal_text_buffer_append_units(destination, (const c16 *) source->data + offset, length);
    } else {
        mal_text_buffer_append_latin1(destination, (const u8 *) source->data + offset, length);
    }
}

static MalKey util_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static bool util_own_data(MalValue object, MalKey key, MalValue *out) {
    if (!mal_value_is_object(object) || mal_value_is_proxy_object(object)) return false;
    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(object), key);
    if (!lookup.present || (lookup.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) return false;
    *out = lookup.desc.value;
    return true;
}

static bool util_color_pair(UtilCtx *ctx, UtilStyle style, u32 *open, u32 *close) {
    MalVm *vm = ctx->vm;
    const char *color = util_style_defaults[style];
    MalValue styles = ctx->roots[UTIL_ROOT_STYLES];
    if (mal_value_is_object(styles)) {
        MalValue name;
        if (!util_own_data(styles, util_key(vm, util_style_names[style]), &name)
            || !mal_value_is_string(name)) {
            return false;
        }
        MalValue pair;
        if (!util_own_data(ctx->roots[UTIL_ROOT_COLORS],
                mal_key_from_value(name), &pair)) {
            return false;
        }
        MalValue first, second;
        if (!util_own_data(pair, mal_key_index(0), &first)
            || !util_own_data(pair, mal_key_index(1), &second)
            || !mal_ops_is_number(first) || !mal_ops_is_number(second)) {
            return false;
        }
        *open = (u32) mal_ops_number_as_f64(first);
        *close = (u32) mal_ops_number_as_f64(second);
        return true;
    }
    if (color == nullptr) return false;
    for (usize i = 0; i < countof(util_colors); i++) {
        if (strcmp(util_colors[i].name, color) == 0) {
            *open = util_colors[i].open;
            *close = util_colors[i].close;
            return true;
        }
    }
    return false;
}

static i32 util_style_begin(UtilCtx *ctx, UtilStyle style) {
    if (!ctx->colors || style == UTIL_STYLE_NONE) return -1;
    u32 open, close;
    if (!util_color_pair(ctx, style, &open, &close)) return -1;
    char text[16];
    snprintf(text, sizeof text, "\x1b[%um", open);
    util_ascii(ctx, text);
    return (i32) close;
}

static void util_style_end(UtilCtx *ctx, i32 close) {
    if (close < 0) return;
    char text[16];
    snprintf(text, sizeof text, "\x1b[%dm", close);
    util_ascii(ctx, text);
}

static void util_styled(UtilCtx *ctx, const char *ascii, UtilStyle style) {
    i32 close = util_style_begin(ctx, style);
    util_ascii(ctx, ascii);
    util_style_end(ctx, close);
}

static usize util_width(const UtilCtx *ctx, usize offset, usize length) {
    if (!ctx->colors) return length;
    usize width = 0;
    for (usize i = offset; i < offset + length; i++) {
        c16 unit = mal_text_buffer_code_unit_at(ctx->out, i);
        if (unit == 0x1b && i + 1 < offset + length
            && mal_text_buffer_code_unit_at(ctx->out, i + 1) == '[') {
            usize j = i + 2;
            while (j < offset + length && mal_text_buffer_code_unit_at(ctx->out, j) != 'm') j++;
            i = j;
            continue;
        }
        width++;
    }
    return width;
}

static bool util_entries_push(UtilEntries *entries, UtilEntry entry) {
    if (entries->items == nullptr) {
        entries->items = entries->inline_items;
        entries->capacity = countof(entries->inline_items);
    }
    if (entries->count == entries->capacity) {
        usize capacity = entries->capacity * 2;
        UtilEntry *items = malloc(capacity * sizeof(UtilEntry));
        if (items == nullptr) return false;
        memcpy(items, entries->items, entries->count * sizeof(UtilEntry));
        if (entries->items != entries->inline_items) free(entries->items);
        entries->items = items;
        entries->capacity = capacity;
    }
    entries->items[entries->count++] = entry;
    return true;
}

static void util_entries_dispose(UtilEntries *entries) {
    if (entries->items != nullptr && entries->items != entries->inline_items) {
        free(entries->items);
    }
}

static const char *util_meta(c16 unit, char *scratch) {
    switch (unit) {
        case '\b': return "\\b";
        case '\t': return "\\t";
        case '\n': return "\\n";
        case '\f': return "\\f";
        case '\r': return "\\r";
        case '\'': return "\\'";
        case '\\': return "\\\\";
        default:
            snprintf(scratch, 8, "\\x%02X", (unsigned) unit);
            return scratch;
    }
}

// Node's strEscape: quote selection prefers ' then " then ` so the chosen quote never needs escaping.
static void util_escape_units(MalTextBuffer *out, const c16 *units, usize length) {
    bool single = false, dbl = false, back = false, template_start = false;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit == '\'') single = true;
        else if (unit == '"') dbl = true;
        else if (unit == '`') back = true;
        else if (unit == '$' && i + 1 < length && units[i + 1] == '{') template_start = true;
    }
    c16 quote = '\'';
    if (single) {
        if (!dbl) quote = '"';
        else if (!back && !template_start) quote = '`';
    }
    mal_text_buffer_push(out, quote);
    usize last = 0;
    char scratch[16];
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if ((unit == '\'' && quote == '\'') || unit == '\\' || unit < 32
            || (unit > 126 && unit < 160)) {
            mal_text_buffer_append_units(out, units + last, i - last);
            mal_text_buffer_append_ascii(out, (const byte *) util_meta(unit, scratch));
            last = i + 1;
        } else if (unit >= 0xd800 && unit <= 0xdfff) {
            if (unit <= 0xdbff && i + 1 < length && units[i + 1] >= 0xdc00
                && units[i + 1] <= 0xdfff) {
                i++;
                continue;
            }
            mal_text_buffer_append_units(out, units + last, i - last);
            snprintf(scratch, sizeof scratch, "\\u%x", (unsigned) unit);
            mal_text_buffer_append_ascii(out, (const byte *) scratch);
            last = i + 1;
        }
    }
    mal_text_buffer_append_units(out, units + last, length - last);
    mal_text_buffer_push(out, quote);
}

static void util_fmt_string(UtilCtx *ctx, MalString *string, bool styled) {
    usize length = mal_string_length(string);
    usize shown = length;
    if ((f64) length > ctx->max_string_length) {
        shown = ctx->max_string_length < 0 ? 0 : (usize) ctx->max_string_length;
    }
    const c16 *units = mal_string_code_units(string);
    UtilStyle style = styled ? UTIL_STYLE_STRING : UTIL_STYLE_NONE;
    if (ctx->compact != UTIL_COMPACT_TRUE && shown > 16
        && (f64) shown > ctx->break_length - ctx->indentation - 4) {
        usize start = 0;
        for (usize i = 0; i < shown; i++) {
            if (units[i] != '\n' && i + 1 != shown) continue;
            if (start != 0) {
                util_ascii(ctx, " +\n");
                util_spaces(ctx->out, ctx->indentation + 2);
            }
            i32 close = util_style_begin(ctx, style);
            util_escape_units(ctx->out, units + start, i + 1 - start);
            util_style_end(ctx, close);
            start = i + 1;
        }
    } else {
        i32 close = util_style_begin(ctx, style);
        util_escape_units(ctx->out, units, shown);
        util_style_end(ctx, close);
    }
    if (shown < length) {
        usize remaining = length - shown;
        util_ascii(ctx, "... ");
        util_u64(ctx, remaining);
        util_ascii(ctx, remaining > 1 ? " more characters" : " more character");
    }
}

static void util_fmt_number(MalTextBuffer *out, MalValue value) {
    if (mal_value_is_f64(value) && mal_value_to_f64(value) == 0
        && signbit(mal_value_to_f64(value))) {
        mal_text_buffer_append_ascii(out, (const byte *) "-0");
    } else {
        mal_text_buffer_append_number(out, value);
    }
}

static bool util_fmt_bigint(MalVm *vm, MalTextBuffer *out, MalValue value) {
    MalValue text = mal_builtin_bigint_to_string_radix(vm, value, 10);
    if (!mal_value_is_string(text)) return false;
    mal_text_buffer_append_string(out, mal_value_to_string(text));
    mal_text_buffer_push(out, 'n');
    return true;
}

static void util_fmt_symbol(MalTextBuffer *out, MalValue value) {
    MalString *description = mal_symbol_description(mal_value_to_symbol(value));
    mal_text_buffer_append_ascii(out, (const byte *) "Symbol(");
    if (description != nullptr) mal_text_buffer_append_string(out, description);
    mal_text_buffer_push(out, ')');
}

static bool util_fmt_primitive(UtilCtx *ctx, MalValue value, bool styled) {
    if (mal_value_is_string(value)) {
        util_fmt_string(ctx, mal_value_to_string(value), styled);
        return true;
    }
    UtilStyle style = UTIL_STYLE_NONE;
    if (styled) {
        style = mal_ops_is_number(value) ? UTIL_STYLE_NUMBER
            : mal_value_is_bigint(value) ? UTIL_STYLE_BIGINT
            : mal_value_is_boolean(value) ? UTIL_STYLE_BOOLEAN
            : mal_value_is_undefined(value) ? UTIL_STYLE_UNDEFINED
            : mal_value_is_null(value) ? UTIL_STYLE_NULL
            : mal_value_is_symbol(value) ? UTIL_STYLE_SYMBOL : UTIL_STYLE_NONE;
    }
    i32 close = util_style_begin(ctx, style);
    bool ok = true;
    if (mal_ops_is_number(value)) {
        util_fmt_number(ctx->out, value);
    } else if (mal_value_is_bigint(value)) {
        ok = util_fmt_bigint(ctx->vm, ctx->out, value);
    } else if (mal_value_is_boolean(value)) {
        util_ascii(ctx, mal_value_to_boolean(value) ? "true" : "false");
    } else if (mal_value_is_undefined(value)) {
        util_ascii(ctx, "undefined");
    } else if (mal_value_is_null(value)) {
        util_ascii(ctx, "null");
    } else if (mal_value_is_symbol(value)) {
        util_fmt_symbol(ctx->out, value);
    } else {
        mal_text_buffer_append_string(ctx->out, mal_ops_to_string(&ctx->vm->heap, value));
    }
    util_style_end(ctx, close);
    return ok;
}

static bool util_string_is_identifier(const MalString *string) {
    usize length = mal_string_length(string);
    if (length == 0) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        bool alpha = (unit >= 'a' && unit <= 'z') || (unit >= 'A' && unit <= 'Z') || unit == '_';
        if (!alpha && !(i > 0 && unit >= '0' && unit <= '9')) return false;
    }
    return true;
}

static bool util_throwing(UtilCtx *ctx) {
    return ctx->vm->completion.kind == MAL_COMPLETION_THROW;
}

static bool util_get(UtilCtx *ctx, MalValue object, const char *name, MalValue *out) {
    if (!mal_vm_get_property(ctx->vm, object, util_key(ctx->vm, name), out)) {
        return false;
    }
    return !util_throwing(ctx);
}

static i32 util_circular_index(UtilCtx *ctx, MalObject *object, bool assign) {
    for (usize i = 0; i < ctx->circular_count; i++) {
        if (ctx->circular[i].object == object) return ctx->circular[i].index;
    }
    if (!assign) return 0;
    if (ctx->circular_count == ctx->circular_capacity) {
        usize capacity = ctx->circular_capacity == 0 ? 4 : ctx->circular_capacity * 2;
        UtilCircular *items = realloc(ctx->circular, capacity * sizeof(UtilCircular));
        if (items == nullptr) return 0;
        ctx->circular = items;
        ctx->circular_capacity = capacity;
    }
    i32 index = (i32) ctx->circular_count + 1;
    ctx->circular[ctx->circular_count++] = (UtilCircular) {object, index};
    return index;
}

typedef struct UtilKeys {
    MalValue *items;
    usize count;
    usize capacity;
    MalRootSpan root;
    bool rooted;
} UtilKeys;

static bool util_keys_push(UtilKeys *keys, MalValue key) {
    if (keys->count == keys->capacity) {
        usize capacity = keys->capacity == 0 ? 8 : keys->capacity * 2;
        MalValue *items = realloc(keys->items, capacity * sizeof(MalValue));
        if (items == nullptr) return false;
        if (keys->rooted) mal_gc_unroot(&keys->root);
        keys->items = items;
        keys->capacity = capacity;
        mal_gc_root(&keys->root, keys->items, (i32) keys->capacity);
        keys->rooted = true;
        for (usize i = keys->count; i < capacity; i++) keys->items[i] = mal_value_new_undefined();
    }
    keys->items[keys->count++] = key;
    return true;
}

static void util_keys_unshift(UtilKeys *keys, MalValue key) {
    if (!util_keys_push(keys, key)) return;
    memmove(keys->items + 1, keys->items, (keys->count - 1) * sizeof(MalValue));
    keys->items[0] = key;
}

static void util_keys_dispose(UtilKeys *keys) {
    if (keys->rooted) mal_gc_unroot(&keys->root);
    free(keys->items);
}

static bool util_keys_has(const UtilKeys *keys, const char *name) {
    for (usize i = 0; i < keys->count; i++) {
        if (mal_value_is_string(keys->items[i])
            && mal_string_equals_ascii(mal_value_to_string(keys->items[i]), (const byte *) name)) {
            return true;
        }
    }
    return false;
}

static void util_keys_remove(UtilKeys *keys, const char *name) {
    for (usize i = 0; i < keys->count; i++) {
        if (mal_value_is_string(keys->items[i])
            && mal_string_equals_ascii(mal_value_to_string(keys->items[i]), (const byte *) name)) {
            memmove(keys->items + i, keys->items + i + 1, (keys->count - i - 1) * sizeof(MalValue));
            keys->items[--keys->count] = mal_value_new_undefined();
            return;
        }
    }
}

static void util_collect_keys(UtilCtx *ctx, MalObject *object, UtilKeys *keys, bool skip_indices) {
    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc desc;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL || (skip_indices && key.kind == MAL_KEY_INDEX)) continue;
        if (!ctx->show_hidden && (desc.flags & MAL_PROPERTY_ENUMERABLE) == 0) continue;
        MalValue name = key.kind == MAL_KEY_INDEX
            ? mal_value_from_string(mal_ops_to_string(&ctx->vm->heap, key.value)) : key.value;
        util_keys_push(keys, name);
    }
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_SYMBOL_OWN_PROPERTY_ORDER);
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) continue;
        if (!ctx->show_hidden && (desc.flags & MAL_PROPERTY_ENUMERABLE) == 0) continue;
        util_keys_push(keys, key.value);
    }
}

static bool util_has_in_chain(MalObject *object, MalObject *prototype) {
    for (MalObject *current = mal_object_get_prototype(object); current != nullptr;
         current = mal_object_get_prototype(current)) {
        if (current == prototype) return true;
        if (mal_value_is_proxy_object(mal_value_from_object(current))) return false;
    }
    return false;
}

// Node's getConstructorName without the `<Complex prototype>` suffixes; null means a null prototype.
static MalString *util_constructor_name(UtilCtx *ctx, MalObject *object, bool *null_prototype) {
    MalVm *vm = ctx->vm;
    MalKey constructor_key = util_key(vm, "constructor");
    MalKey prototype_key = util_key(vm, "prototype");
    *null_prototype = false;
    bool first = true;
    MalObject *first_prototype = nullptr;
    for (MalObject *current = object; current != nullptr;) {
        if (mal_value_is_proxy_object(mal_value_from_object(current))) break;
        MalPropertyLookup lookup = mal_object_get_own(current, constructor_key);
        if (lookup.present && (lookup.desc.flags & MAL_PROPERTY_ACCESSOR) == 0
            && mal_value_is_callable(lookup.desc.value)) {
            MalString *name = mal_vm_callable_name(vm, lookup.desc.value);
            MalValue prototype;
            if (name != nullptr && mal_string_length(name) > 0
                && util_own_data(lookup.desc.value, prototype_key, &prototype)
                && mal_value_is_object(prototype)
                && util_has_in_chain(object, mal_value_to_object(prototype))) {
                return name;
            }
        }
        current = mal_object_get_prototype(current);
        if (first) {
            first_prototype = current;
            first = false;
        }
    }
    if (first_prototype == nullptr && !first) {
        *null_prototype = true;
        return nullptr;
    }
    return mal_intrinsic_ascii(vm, (const byte *) "Object");
}

static bool util_string_equal(const MalString *left, const MalString *right) {
    if (left == nullptr || right == nullptr) return false;
    usize length = mal_string_length(left);
    return length == mal_string_length(right)
        && memcmp(mal_string_code_units(left), mal_string_code_units(right),
            length * sizeof(c16)) == 0;
}

static bool util_string_is(const MalString *string, const char *ascii) {
    return string != nullptr && mal_string_equals_ascii(string, (const byte *) ascii);
}

typedef struct UtilNames {
    MalString *constructor;
    MalString *tag;
    bool null_prototype;
} UtilNames;

// Node's getPrefix: "Ctor(size) [tag] " or "[fallback(size): null prototype] ".
static void util_write_prefix(UtilCtx *ctx, const UtilNames *names, const char *fallback, i64 size) {
    char size_text[32] = "";
    if (size >= 0) snprintf(size_text, sizeof size_text, "(%lld)", (long long) size);
    bool has_tag = names->tag != nullptr && mal_string_length(names->tag) > 0;
    if (names->null_prototype) {
        util_unit(ctx, '[');
        util_ascii(ctx, fallback);
        util_ascii(ctx, size_text);
        util_ascii(ctx, ": null prototype] ");
        if (has_tag && !util_string_is(names->tag, fallback)) {
            util_unit(ctx, '[');
            mal_text_buffer_append_string(ctx->out, names->tag);
            util_ascii(ctx, "] ");
        }
        return;
    }
    mal_text_buffer_append_string(ctx->out, names->constructor);
    util_ascii(ctx, size_text);
    util_unit(ctx, ' ');
    if (has_tag && !util_string_equal(names->constructor, names->tag)) {
        mal_text_buffer_truncate(ctx->out, ctx->out->length - 1);
        util_ascii(ctx, " [");
        mal_text_buffer_append_string(ctx->out, names->tag);
        util_ascii(ctx, "] ");
    }
}

static bool util_prefix_is_plain(const UtilNames *names, const char *fallback) {
    return !names->null_prototype && util_string_is(names->constructor, fallback)
        && (names->tag == nullptr || mal_string_length(names->tag) == 0
            || util_string_is(names->tag, fallback));
}

static bool util_is_class(MalVm *vm, MalValue function) {
    if (!mal_value_is_function_object(function)) return false;
    i32 index = mal_function_object_function_index(mal_value_to_function_object(function));
    return index >= 0 && index < vm->runtime_image->function_count
        && vm->runtime_image->functions[index].is_class_constructor;
}

static const char *util_function_type(MalVm *vm, MalValue function) {
    if (mal_value_is_native_function_object(function)) {
        return mal_native_function_object_is_async(mal_value_to_native_function_object(function))
            ? "AsyncFunction" : "Function";
    }
    if (!mal_value_is_function_object(function)) return "Function";
    i32 index = mal_function_object_function_index(mal_value_to_function_object(function));
    if (index < 0 || index >= vm->runtime_image->function_count) return "Function";
    switch (vm->runtime_image->functions[index].kind) {
        case MAL_FUNCTION_KIND_GENERATOR: return "GeneratorFunction";
        case MAL_FUNCTION_KIND_ASYNC: return "AsyncFunction";
        case MAL_FUNCTION_KIND_ASYNC_GENERATOR: return "AsyncGeneratorFunction";
        default: return "Function";
    }
}

static bool util_write_function_base(UtilCtx *ctx, MalValue function, const UtilNames *names) {
    MalVm *vm = ctx->vm;
    bool has_tag = names->tag != nullptr && mal_string_length(names->tag) > 0;
    MalValue name;
    if (util_is_class(vm, function)) {
        util_ascii(ctx, "[class ");
        MalValue own_name;
        if (util_own_data(function, util_key(vm, "name"), &own_name)
            && mal_value_is_string(own_name) && mal_string_length(mal_value_to_string(own_name)) > 0) {
            mal_text_buffer_append_string(ctx->out, mal_value_to_string(own_name));
        } else {
            util_ascii(ctx, "(anonymous)");
        }
        if (!names->null_prototype && !util_string_is(names->constructor, "Function")) {
            util_ascii(ctx, " [");
            mal_text_buffer_append_string(ctx->out, names->constructor);
            util_unit(ctx, ']');
        }
        if (has_tag && !util_string_equal(names->constructor, names->tag)) {
            util_ascii(ctx, " [");
            mal_text_buffer_append_string(ctx->out, names->tag);
            util_unit(ctx, ']');
        }
        if (names->null_prototype) {
            util_ascii(ctx, " extends [null prototype]");
        } else {
            MalObject *parent = mal_object_get_prototype(mal_value_to_object(function));
            MalValue super_name;
            if (parent != nullptr && util_get(ctx, mal_value_from_object(parent), "name", &super_name)
                && mal_value_is_string(super_name) && mal_string_length(mal_value_to_string(super_name)) > 0) {
                util_ascii(ctx, " extends ");
                mal_text_buffer_append_string(ctx->out, mal_value_to_string(super_name));
            }
            if (util_throwing(ctx)) return false;
        }
        util_unit(ctx, ']');
        return true;
    }
    const char *type = util_function_type(vm, function);
    util_unit(ctx, '[');
    util_ascii(ctx, type);
    if (names->null_prototype) util_ascii(ctx, " (null prototype)");
    if (!util_get(ctx, function, "name", &name)) return false;
    if (mal_value_is_string(name) && mal_string_length(mal_value_to_string(name)) == 0) {
        util_ascii(ctx, " (anonymous)");
    } else {
        util_ascii(ctx, ": ");
        if (mal_value_is_string(name)) {
            mal_text_buffer_append_string(ctx->out, mal_value_to_string(name));
        } else if (!util_fmt_primitive(ctx, name, false)) {
            return false;
        }
    }
    util_unit(ctx, ']');
    if (!names->null_prototype && !util_string_is(names->constructor, type)) {
        util_unit(ctx, ' ');
        mal_text_buffer_append_string(ctx->out, names->constructor);
    }
    if (has_tag && !util_string_equal(names->constructor, names->tag)) {
        util_ascii(ctx, " [");
        mal_text_buffer_append_string(ctx->out, names->tag);
        util_unit(ctx, ']');
    }
    return true;
}

static i64 util_index_of(const c16 *units, usize length, const c16 *needle, usize needle_length, usize from) {
    if (needle_length == 0) return (i64) from;
    for (usize i = from; i + needle_length <= length; i++) {
        if (memcmp(units + i, needle, needle_length * sizeof(c16)) == 0) return (i64) i;
    }
    return -1;
}

static i64 util_index_of_ascii(const c16 *units, usize length, const char *needle, usize from) {
    usize needle_length = strlen(needle);
    for (usize i = from; i + needle_length <= length; i++) {
        usize j = 0;
        while (j < needle_length && units[i + j] == (c16) needle[j]) j++;
        if (j == needle_length) return (i64) i;
    }
    return -1;
}

static bool util_string_contains(const MalString *haystack, const MalString *needle) {
    return util_index_of(mal_string_code_units(haystack), mal_string_length(haystack),
        mal_string_code_units(needle), mal_string_length(needle), 0) >= 0;
}

static void util_append_indented(UtilCtx *ctx, const c16 *units, usize length) {
    usize last = 0;
    for (usize i = 0; i < length; i++) {
        if (units[i] != '\n' || ctx->indentation == 0) continue;
        mal_text_buffer_append_units(ctx->out, units + last, i + 1 - last);
        util_spaces(ctx->out, ctx->indentation);
        last = i + 1;
    }
    mal_text_buffer_append_units(ctx->out, units + last, length - last);
}

static bool util_write_error_base(UtilCtx *ctx, MalValue error, const UtilNames *names, UtilKeys *keys) {
    MalVm *vm = ctx->vm;
    MalValue roots[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool ok = false;
    if (!util_get(ctx, error, "name", &roots[0]) || !util_get(ctx, error, "message", &roots[1])
        || !util_get(ctx, error, "stack", &roots[2])) {
        goto done;
    }
    MalString *name = mal_value_is_nil(roots[0]) ? mal_intrinsic_ascii(vm, (const byte *) "Error")
        : mal_value_is_string(roots[0]) ? mal_value_to_string(roots[0]) : nullptr;
    if (name == nullptr) {
        if (!mal_vm_to_string(vm, roots[0], &name)) goto done;
    }
    roots[0] = mal_value_from_string(name);
    MalString *stack;
    if (mal_value_is_string(roots[2]) && mal_string_length(mal_value_to_string(roots[2])) > 0) {
        stack = mal_value_to_string(roots[2]);
    } else if (!mal_value_is_nil(roots[2]) && !mal_value_is_string(roots[2])
        && !(mal_value_is_boolean(roots[2]) && !mal_value_to_boolean(roots[2]))) {
        if (!mal_vm_to_string(vm, roots[2], &stack)) goto done;
    } else {
        MalTextBuffer text = {0};
        MalString *message = nullptr;
        if (!mal_value_is_undefined(roots[1]) && !mal_vm_to_string(vm, roots[1], &message)) goto done;
        mal_text_buffer_append_string(&text, name);
        if (message != nullptr && mal_string_length(message) > 0) {
            if (mal_string_length(name) > 0) mal_text_buffer_append_ascii(&text, (const byte *) ": ");
            mal_text_buffer_append_string(&text, message);
        }
        stack = mal_text_buffer_finish(&vm->heap, &text);
    }
    roots[3] = mal_value_from_string(stack);
    if (!ctx->show_hidden && keys->count > 0) {
        static const char *const duplicates[] = {"name", "message", "stack"};
        for (usize i = 0; i < countof(duplicates); i++) {
            if (!util_keys_has(keys, duplicates[i])) continue;
            MalValue field = i == 0 ? roots[0] : i == 1 ? roots[1] : roots[2];
            if (!mal_value_is_string(field) || util_string_contains(stack, mal_value_to_string(field))) {
                util_keys_remove(keys, duplicates[i]);
            }
        }
    }
    MalValue errors;
    if (mal_value_is_object(error) && !util_keys_has(keys, "cause")) {
        MalPropertyResolution cause = mal_object_resolve_property(
            mal_value_to_object(error), util_key(vm, "cause"));
        if (cause.found) util_keys_push(keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "cause")));
    }
    if (util_own_data(error, util_key(vm, "errors"), &errors) && mal_value_is_array_object(errors)
        && !util_keys_has(keys, "errors")) {
        util_keys_push(keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "errors")));
    }

    const c16 *units = mal_string_code_units(stack);
    usize length = mal_string_length(stack);
    usize name_length = mal_string_length(name);
    usize skip = 0;
    bool rewrite = false;
    usize head_start = ctx->out->length;
    if (names->null_prototype || (name_length >= 5
            && util_index_of_ascii(mal_string_code_units(name), name_length, "Error", name_length - 5) >= 0
            && length >= name_length
            && memcmp(units, mal_string_code_units(name), name_length * sizeof(c16)) == 0
            && (length == name_length || units[name_length] == ':' || units[name_length] == '\n'))) {
        MalTextBuffer *saved = ctx->out;
        MalTextBuffer prefix = {0};
        ctx->out = &prefix;
        util_write_prefix(ctx, names, "Error", -1);
        ctx->out = saved;
        if (prefix.length > 0) mal_text_buffer_truncate(&prefix, prefix.length - 1);
        MalString *prefix_string = mal_text_buffer_finish(&vm->heap, &prefix);
        if (!util_string_equal(prefix_string, name)) {
            rewrite = true;
            skip = names->null_prototype ? 0 : name_length;
            mal_text_buffer_append_string(ctx->out, prefix_string);
            if (names->null_prototype) {
                util_ascii(ctx, ": ");
            } else if (!util_string_contains(prefix_string, name)) {
                util_ascii(ctx, " [");
                mal_text_buffer_append_string(ctx->out, name);
                util_unit(ctx, ']');
            }
        }
    }
    i64 position = -1;
    if (mal_value_is_string(roots[1]) && mal_string_length(mal_value_to_string(roots[1])) > 0) {
        MalString *message = mal_value_to_string(roots[1]);
        i64 found = util_index_of(units, length, mal_string_code_units(message),
            mal_string_length(message), 0);
        if (found > 0) position = found + (i64) mal_string_length(message);
    }
    bool has_frames = util_index_of_ascii(units, length, "\n    at",
        position < 0 ? 0 : (usize) position) >= 0;
    if (!has_frames) {
        if (rewrite) {
            usize written = ctx->out->length - head_start;
            MalTextBuffer *out = ctx->out;
            mal_text_buffer_truncate(&ctx->scratch, 0);
            util_append_slice(&ctx->scratch, out, head_start, written);
            mal_text_buffer_truncate(out, head_start);
            util_unit(ctx, '[');
            util_append_slice(out, &ctx->scratch, 0, written);
        } else {
            util_unit(ctx, '[');
        }
    }
    util_append_indented(ctx, units + skip, length - skip);
    if (!has_frames) util_unit(ctx, ']');
    ok = true;
done:
    mal_gc_unroot(&root);
    return ok;
}

static bool util_is_error(MalVm *vm, MalValue value) {
    if (mal_builtin_value_has_error_data(vm, value)) return true;
    return util_has_in_chain(mal_value_to_object(value),
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
}

static bool util_fmt_property(
    UtilCtx *ctx, MalValue object, i32 recurse, MalValue key, i32 extras) {
    MalVm *vm = ctx->vm;
    MalKey property_key = mal_key_from_value(key);
    if (mal_value_is_string(key)) {
        MalString *string = mal_value_to_string(key);
        usize length = mal_string_length(string);
        const c16 *units = mal_string_code_units(string);
        bool index = length > 0 && length <= 10 && (units[0] != '0' || length == 1);
        u64 number = 0;
        for (usize i = 0; index && i < length; i++) {
            if (units[i] < '0' || units[i] > '9') index = false;
            else number = number * 10 + (u64) (units[i] - '0');
        }
        if (index && number < 0xffffffffull) property_key = mal_key_index((u32) number);
    }
    MalPropertyDesc desc = {0};
    bool enumerable = true;
    bool own = false;
    if (!mal_value_is_proxy_object(object)) {
        MalPropertyResolution resolution = mal_object_resolve_property(
            mal_value_to_object(object), property_key);
        if (resolution.found && resolution.own) {
            desc = resolution.desc;
            own = true;
            enumerable = (desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
        }
    }
    MalValue value = mal_value_new_undefined();
    if (!own) {
        if (!mal_vm_get_property(vm, object, property_key, &value) || util_throwing(ctx)) return false;
        desc.value = value;
        desc.flags = 0;
        enumerable = false;
    }
    if (extras == UTIL_EXTRAS_OBJECT) {
        if (mal_value_is_symbol(key)) {
            i32 close = util_style_begin(ctx, UTIL_STYLE_SYMBOL);
            util_fmt_symbol(ctx->out, key);
            util_style_end(ctx, close);
        } else if (util_string_is(mal_value_to_string(key), "__proto__")) {
            util_ascii(ctx, "['__proto__']");
        } else if (!enumerable) {
            util_unit(ctx, '[');
            mal_text_buffer_append_string(ctx->out, mal_value_to_string(key));
            util_unit(ctx, ']');
        } else if (util_string_is_identifier(mal_value_to_string(key))) {
            i32 close = util_style_begin(ctx, UTIL_STYLE_NAME);
            mal_text_buffer_append_string(ctx->out, mal_value_to_string(key));
            util_style_end(ctx, close);
        } else {
            i32 close = util_style_begin(ctx, UTIL_STYLE_STRING);
            MalString *string = mal_value_to_string(key);
            util_escape_units(ctx->out, mal_string_code_units(string), mal_string_length(string));
            util_style_end(ctx, close);
        }
        util_ascii(ctx, ": ");
    }
    if ((desc.flags & MAL_PROPERTY_ACCESSOR) == 0) {
        if (mal_value_is_undefined(desc.value)) {
            util_styled(ctx, "undefined", UTIL_STYLE_UNDEFINED);
            return true;
        }
        MalValue rooted = desc.value;
        MalRootSpan root;
        mal_gc_root(&root, &rooted, 1);
        i32 diff = ctx->compact != UTIL_COMPACT_TRUE || extras != UTIL_EXTRAS_OBJECT ? 2 : 3;
        ctx->indentation += diff;
        bool ok = util_fmt_value(ctx, rooted, recurse);
        ctx->indentation -= diff;
        mal_gc_unroot(&root);
        return ok;
    }
    bool has_getter = mal_value_is_callable(desc.getter);
    bool has_setter = mal_value_is_callable(desc.setter);
    if (!has_getter) {
        util_styled(ctx, has_setter ? "[Setter]" : "undefined",
            has_setter ? UTIL_STYLE_SPECIAL : UTIL_STYLE_UNDEFINED);
        return true;
    }
    const char *label = has_setter ? "Getter/Setter" : "Getter";
    bool call = ctx->getters == 1 || (ctx->getters == 2 && !has_setter)
        || (ctx->getters == 3 && has_setter);
    if (!call) {
        char text[24];
        snprintf(text, sizeof text, "[%s]", label);
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        return true;
    }
    MalCompletion completion = mal_vm_call_value(vm, desc.getter, object, nullptr, 0);
    char text[24];
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
        snprintf(text, sizeof text, "[%s:", label);
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        util_ascii(ctx, " <Inspection threw (");
        MalValue thrown = completion.value;
        MalRootSpan thrown_root;
        mal_gc_root(&thrown_root, &thrown, 1);
        ctx->indentation += 2;
        bool formatted = util_fmt_value(ctx, thrown, recurse);
        ctx->indentation -= 2;
        mal_gc_unroot(&thrown_root);
        if (!formatted) return false;
        util_ascii(ctx, ")>");
        util_styled(ctx, "]", UTIL_STYLE_SPECIAL);
        return true;
    }
    MalValue result = completion.value;
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    ctx->indentation += 2;
    bool ok = true;
    if (mal_value_is_object(result)) {
        snprintf(text, sizeof text, "[%s]", label);
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        util_unit(ctx, ' ');
        ok = util_fmt_value(ctx, result, recurse);
    } else {
        snprintf(text, sizeof text, "[%s:", label);
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        util_unit(ctx, ' ');
        ok = util_fmt_primitive(ctx, result, true);
        util_styled(ctx, "]", UTIL_STYLE_SPECIAL);
    }
    ctx->indentation -= 2;
    mal_gc_unroot(&root);
    return ok;
}

typedef enum UtilKind : u8 {
    UTIL_KIND_OBJECT,
    UTIL_KIND_ARRAY,
    UTIL_KIND_TYPED_ARRAY,
    UTIL_KIND_SET,
    UTIL_KIND_MAP,
    UTIL_KIND_ARRAY_BUFFER,
    UTIL_KIND_PROMISE,
    UTIL_KIND_WEAK,
} UtilKind;

static i32 util_compare_entries(const UtilCtx *ctx, const UtilEntry *left, const UtilEntry *right) {
    usize length = left->length < right->length ? left->length : right->length;
    for (usize i = 0; i < length; i++) {
        c16 a = mal_text_buffer_code_unit_at(ctx->out, left->offset + i);
        c16 b = mal_text_buffer_code_unit_at(ctx->out, right->offset + i);
        if (a != b) return a < b ? -1 : 1;
    }
    return left->length < right->length ? -1 : left->length > right->length ? 1 : 0;
}

static void util_sort_entries(const UtilCtx *ctx, UtilEntry *items, usize count) {
    for (usize i = 1; i < count; i++) {
        UtilEntry entry = items[i];
        usize j = i;
        while (j > 0 && util_compare_entries(ctx, &items[j - 1], &entry) > 0) {
            items[j] = items[j - 1];
            j--;
        }
        items[j] = entry;
    }
}

static bool util_element_is_numeric(MalValue value, UtilKind kind, usize index) {
    if (kind == UTIL_KIND_TYPED_ARRAY) return true;
    if (!mal_value_is_array_object(value)) return false;
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(value), mal_key_index((u32) index));
    if (!resolution.found || !resolution.own || (resolution.desc.flags & MAL_PROPERTY_ACCESSOR) != 0) {
        return false;
    }
    return mal_ops_is_number(resolution.desc.value) || mal_value_is_bigint(resolution.desc.value);
}

// Node's groupArrayElements: returns the column count, or 0 to keep one entry per line.
static usize util_group_columns(
    UtilCtx *ctx, const UtilEntries *entries, usize output_length, usize *line_widths) {
    usize total = 0, max_length = 0;
    for (usize i = 0; i < output_length; i++) {
        usize width = entries->items[i].width;
        total += width + 2;
        if (width > max_length) max_length = width;
    }
    f64 actual_max = (f64) max_length + 2;
    if (!(actual_max * 3 + ctx->indentation < ctx->break_length
            && ((f64) total / actual_max > 5 || max_length <= 6))) {
        return 0;
    }
    f64 average_bias = sqrt(actual_max - (f64) total / (f64) entries->count);
    f64 biased_max = fmax(actual_max - 3 - average_bias, 1);
    f64 columns = floor(sqrt(2.5 * biased_max * (f64) output_length) / biased_max + 0.5);
    columns = fmin(columns, floor((ctx->break_length - ctx->indentation) / actual_max));
    columns = fmin(columns, (f64) ctx->compact * 4);
    columns = fmin(columns, 15);
    if (columns <= 1) return 0;
    usize count = (usize) columns;
    for (usize i = 0; i < count; i++) {
        usize line = 0;
        for (usize j = i; j < output_length; j += count) {
            if (entries->items[j].width > line) line = entries->items[j].width;
        }
        line_widths[i] = line + 2;
    }
    return count;
}

static void util_reduce(
    UtilCtx *ctx, MalValue value, UtilKind kind, UtilEntries *entries, usize entries_start,
    usize head_length, usize base_length, bool base_newline, i32 extras, i32 recurse,
    const char *close_brace) {
    MalTextBuffer *out = ctx->out;
    usize count = entries->count;
    if (ctx->compact != UTIL_COMPACT_TRUE) {
        usize columns = 0;
        usize output_length = count;
        usize line_widths[16];
        if (ctx->compact >= 1 && extras == UTIL_EXTRAS_ARRAY && count > 6) {
            if (ctx->max_array_length < (f64) count) output_length--;
            columns = util_group_columns(ctx, entries, output_length, line_widths);
        }
        if (ctx->compact >= 1 && columns == 0 && ctx->current_depth - recurse < ctx->compact) {
            usize total = count + ctx->indentation + (head_length - base_length) + base_length + 10 + count;
            bool fits = (f64) (total + count) <= ctx->break_length;
            for (usize i = 0; fits && i < count; i++) {
                total += entries->items[i].width;
                if ((f64) total > ctx->break_length) fits = false;
            }
            if (fits && !base_newline) {
                bool newline = false;
                for (usize i = entries_start; !newline && i < out->length; i++) {
                    newline = mal_text_buffer_code_unit_at(out, i) == '\n';
                }
                if (!newline) {
                    util_unit(ctx, ' ');
                    util_ascii(ctx, close_brace);
                    return;
                }
            }
        }
        mal_text_buffer_truncate(&ctx->scratch, 0);
        util_append_slice(&ctx->scratch, out, entries_start, out->length - entries_start);
        mal_text_buffer_truncate(out, entries_start);
        if (columns > 0) {
            bool pad_start = true;
            for (usize i = 0; i < count; i++) {
                if (!util_element_is_numeric(value, kind, i)) {
                    pad_start = false;
                    break;
                }
            }
            for (usize i = 0; i < output_length; i += columns) {
                util_unit(ctx, i == 0 ? '\n' : ',');
                if (i != 0) util_unit(ctx, '\n');
                util_spaces(out, ctx->indentation + 2);
                usize max = i + columns < output_length ? i + columns : output_length;
                for (usize j = i; j < max; j++) {
                    UtilEntry *entry = &entries->items[j];
                    usize pad = line_widths[j - i] - 2 - entry->width;
                    if (pad_start) util_spaces(out, (i32) pad);
                    util_append_slice(out, &ctx->scratch, entry->offset - entries_start, entry->length);
                    if (j + 1 < max) {
                        util_ascii(ctx, ", ");
                        if (!pad_start) util_spaces(out, (i32) pad);
                    }
                }
            }
            if (output_length < count) {
                UtilEntry *entry = &entries->items[output_length];
                util_ascii(ctx, ",\n");
                util_spaces(out, ctx->indentation + 2);
                util_append_slice(out, &ctx->scratch, entry->offset - entries_start, entry->length);
            }
        } else {
            for (usize i = 0; i < count; i++) {
                util_unit(ctx, i == 0 ? '\n' : ',');
                if (i != 0) util_unit(ctx, '\n');
                util_spaces(out, ctx->indentation + 2);
                UtilEntry *entry = &entries->items[i];
                util_append_slice(out, &ctx->scratch, entry->offset - entries_start, entry->length);
            }
        }
        util_unit(ctx, '\n');
        util_spaces(out, ctx->indentation);
        util_ascii(ctx, close_brace);
        return;
    }
    usize total = count;
    bool fits = (f64) (total + count) <= ctx->break_length;
    for (usize i = 0; fits && i < count; i++) {
        total += entries->items[i].width;
        if ((f64) total > ctx->break_length) fits = false;
    }
    if (fits && !base_newline) {
        util_unit(ctx, ' ');
        util_ascii(ctx, close_brace);
        return;
    }
    mal_text_buffer_truncate(&ctx->scratch, 0);
    util_append_slice(&ctx->scratch, out, entries_start, out->length - entries_start);
    mal_text_buffer_truncate(out, entries_start);
    bool short_open = base_length == 0 && head_length == 1;
    for (usize i = 0; i < count; i++) {
        if (i == 0) {
            if (short_open) {
                util_unit(ctx, ' ');
            } else {
                util_unit(ctx, '\n');
                util_spaces(out, ctx->indentation + 2);
            }
        } else {
            util_ascii(ctx, ",\n");
            util_spaces(out, ctx->indentation + 2);
        }
        UtilEntry *entry = &entries->items[i];
        util_append_slice(out, &ctx->scratch, entry->offset - entries_start, entry->length);
    }
    util_unit(ctx, ' ');
    util_ascii(ctx, close_brace);
}

static void util_entry_begin(UtilCtx *ctx, UtilEntries *entries, usize *start) {
    util_ascii(ctx, entries->count == 0 ? " " : ", ");
    *start = ctx->out->length;
}

static bool util_entry_end(UtilCtx *ctx, UtilEntries *entries, usize start) {
    usize length = ctx->out->length - start;
    return util_entries_push(entries, (UtilEntry) {start, length, util_width(ctx, start, length)});
}

static void util_remaining(UtilCtx *ctx, UtilEntries *entries, u64 remaining, const char *unit) {
    usize start;
    util_entry_begin(ctx, entries, &start);
    util_ascii(ctx, "... ");
    util_u64(ctx, remaining);
    util_unit(ctx, ' ');
    util_ascii(ctx, "more ");
    util_ascii(ctx, unit);
    if (remaining > 1) util_unit(ctx, 's');
    util_entry_end(ctx, entries, start);
}

static bool util_fmt_array_entries(UtilCtx *ctx, MalValue value, i32 recurse, UtilEntries *entries) {
    MalArrayObject *array = mal_value_to_array_object(value);
    u32 length = mal_array_object_length(array);
    f64 limit = fmax(0, fmin(ctx->max_array_length, (f64) length));
    usize shown = 0;
    u32 index = 0;
    while (index < length && (f64) shown < limit) {
        MalPropertyResolution resolution = mal_object_resolve_property(
            (MalObject *) array, mal_key_index(index));
        usize start;
        if (!resolution.found || !resolution.own) {
            u32 holes = 0;
            while (index < length) {
                resolution = mal_object_resolve_property((MalObject *) array, mal_key_index(index));
                if (resolution.found && resolution.own) break;
                holes++;
                index++;
            }
            util_entry_begin(ctx, entries, &start);
            char text[48];
            snprintf(text, sizeof text, "<%u empty item%s>", holes, holes > 1 ? "s" : "");
            util_styled(ctx, text, UTIL_STYLE_UNDEFINED);
            util_entry_end(ctx, entries, start);
            shown++;
            continue;
        }
        util_entry_begin(ctx, entries, &start);
        MalValue key = mal_value_from_i32((i32) index);
        if (index > INT32_MAX) key = mal_value_from_f64((f64) index);
        if (!util_fmt_property(ctx, value, recurse,
                mal_value_from_string(mal_ops_to_string(&ctx->vm->heap, key)), UTIL_EXTRAS_ARRAY)) {
            return false;
        }
        util_entry_end(ctx, entries, start);
        shown++;
        index++;
    }
    if (index < length) util_remaining(ctx, entries, length - index, "item");
    return true;
}

static bool util_fmt_typed_entries(UtilCtx *ctx, MalValue value, UtilEntries *entries) {
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    u32 length = mal_typed_array_object_is_out_of_bounds(array) ? 0 : mal_typed_array_object_length(array);
    f64 limit = fmax(0, fmin(ctx->max_array_length, (f64) length));
    u32 shown = (u32) limit;
    for (u32 i = 0; i < shown; i++) {
        usize start;
        util_entry_begin(ctx, entries, &start);
        MalValue element = mal_typed_array_object_get(ctx->vm, array, i);
        if (!util_fmt_primitive(ctx, element, true)) return false;
        util_entry_end(ctx, entries, start);
    }
    if (shown < length) util_remaining(ctx, entries, length - shown, "item");
    return true;
}

static bool util_fmt_collection_entries(
    UtilCtx *ctx, MalValue value, i32 recurse, UtilEntries *entries, bool map) {
    usize size = map ? mal_map_object_size(mal_value_to_map_object(value))
        : mal_set_object_size(mal_value_to_set_object(value));
    f64 limit = fmax(0, fmin(ctx->max_array_length, (f64) size));
    usize shown = 0;
    MalValue pair[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, pair, 2);
    bool ok = true;
    ctx->indentation += 2;
    if (map) {
        MalMapStorage *storage = mal_map_object_storage(mal_value_to_map_object(value));
        mal_map_storage_pin(storage);
        MalMapIter iter;
        mal_map_iter_init(&iter, storage);
        while ((f64) shown < limit && mal_map_iter_next(&iter, &pair[0], &pair[1])) {
            usize start;
            util_entry_begin(ctx, entries, &start);
            if (!util_fmt_value(ctx, pair[0], recurse)) { ok = false; break; }
            util_ascii(ctx, " => ");
            if (!util_fmt_value(ctx, pair[1], recurse)) { ok = false; break; }
            util_entry_end(ctx, entries, start);
            shown++;
        }
        mal_map_storage_unpin(storage);
    } else {
        MalSetStorage *storage = mal_set_object_storage(mal_value_to_set_object(value));
        mal_set_storage_pin(storage);
        MalSetIter iter;
        mal_set_iter_init(&iter, storage);
        while ((f64) shown < limit && mal_set_iter_next(&iter, &pair[0])) {
            usize start;
            util_entry_begin(ctx, entries, &start);
            if (!util_fmt_value(ctx, pair[0], recurse)) { ok = false; break; }
            util_entry_end(ctx, entries, start);
            shown++;
        }
        mal_set_storage_unpin(storage);
    }
    ctx->indentation -= 2;
    mal_gc_unroot(&root);
    if (ok && shown < size) util_remaining(ctx, entries, size - shown, "item");
    return ok;
}

static void util_fmt_array_buffer_entry(UtilCtx *ctx, MalValue value, UtilEntries *entries) {
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(value);
    usize start;
    util_entry_begin(ctx, entries, &start);
    if (buffer->detached) {
        util_styled(ctx, "(detached)", UTIL_STYLE_SPECIAL);
        util_entry_end(ctx, entries, start);
        return;
    }
    util_styled(ctx, "[Uint8Contents]", UTIL_STYLE_SPECIAL);
    util_ascii(ctx, ": <");
    u32 length = buffer->byte_length;
    u32 shown = (f64) length > ctx->max_array_length ? (u32) fmax(0, ctx->max_array_length) : length;
    static const char digits[] = "0123456789abcdef";
    for (u32 i = 0; i < shown; i++) {
        if (i > 0) util_unit(ctx, ' ');
        util_unit(ctx, (c16) digits[buffer->data[i] >> 4]);
        util_unit(ctx, (c16) digits[buffer->data[i] & 15]);
    }
    if (shown < length) {
        util_ascii(ctx, " ... ");
        util_u64(ctx, length - shown);
        util_ascii(ctx, length - shown > 1 ? " more bytes" : " more byte");
    }
    util_unit(ctx, '>');
    util_entry_end(ctx, entries, start);
}

static bool util_fmt_boxed_base(UtilCtx *ctx, MalValue value, const UtilNames *names, bool styled) {
    MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(value);
    static const char *const types[] = {"String", "Number", "Boolean", "Symbol", "BigInt"};
    static const UtilStyle styles[] = {
        UTIL_STYLE_STRING, UTIL_STYLE_NUMBER, UTIL_STYLE_BOOLEAN, UTIL_STYLE_SYMBOL, UTIL_STYLE_BIGINT,
    };
    const char *type = types[wrapper->kind];
    i32 close = styled ? util_style_begin(ctx, styles[wrapper->kind]) : -1;
    util_unit(ctx, '[');
    util_ascii(ctx, type);
    if (names->null_prototype) {
        util_ascii(ctx, " (null prototype)");
    } else if (!util_string_is(names->constructor, type)) {
        util_ascii(ctx, " (");
        mal_text_buffer_append_string(ctx->out, names->constructor);
        util_unit(ctx, ')');
    }
    util_ascii(ctx, ": ");
    bool colors = ctx->colors;
    ctx->colors = false;
    bool ok = util_fmt_primitive(ctx, wrapper->primitive_data, false);
    ctx->colors = colors;
    util_unit(ctx, ']');
    if (names->tag != nullptr && mal_string_length(names->tag) > 0
        && !util_string_equal(names->tag, names->constructor)) {
        util_ascii(ctx, " [");
        mal_text_buffer_append_string(ctx->out, names->tag);
        util_unit(ctx, ']');
    }
    util_style_end(ctx, close);
    return ok;
}

static bool util_fmt_raw(UtilCtx *ctx, MalValue value, i32 recurse) {
    MalVm *vm = ctx->vm;
    MalObject *object = mal_value_to_object(value);
    UtilNames names = {0};
    names.constructor = util_constructor_name(ctx, object, &names.null_prototype);
    MalValue tag_roots[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    if (names.constructor != nullptr) tag_roots[1] = mal_value_from_string(names.constructor);
    MalRootSpan tag_root;
    mal_gc_root(&tag_root, tag_roots, 2);
    UtilKeys keys = {0};
    UtilEntries entries = {0};
    bool ok = false;
    MalValue symbol_tag = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (!mal_vm_get_property(vm, value, mal_key_from_value(symbol_tag), &tag_roots[0])
        || util_throwing(ctx)) {
        goto done;
    }
    if (mal_value_is_string(tag_roots[0]) && mal_string_length(mal_value_to_string(tag_roots[0])) > 0) {
        MalPropertyLookup own = mal_object_get_own(object, mal_key_from_value(symbol_tag));
        bool hide = own.present && (ctx->show_hidden || (own.desc.flags & MAL_PROPERTY_ENUMERABLE) != 0);
        names.tag = hide ? nullptr : mal_value_to_string(tag_roots[0]);
    }

    UtilKind kind = UTIL_KIND_OBJECT;
    i32 extras = UTIL_EXTRAS_OBJECT;
    usize head_start = ctx->out->length;
    usize base_length = 0;
    const char *close_brace = "}";
    bool is_array = mal_value_is_array_object(value);
    bool is_typed = mal_value_is_typed_array_object(value);
    bool is_wrapper = mal_value_is_primitive_wrapper(value);
    util_collect_keys(ctx, object, &keys, is_array || is_typed
        || (is_wrapper && mal_value_to_primitive_wrapper(value)->kind == MAL_PRIMITIVE_WRAPPER_STRING));
    bool depth_exceeded = (f64) recurse > ctx->depth;
    if (is_array && ctx->show_hidden && !util_keys_has(&keys, "length")) {
        util_keys_push(&keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "length")));
    }

    if (is_array || is_typed) {
        kind = is_array ? UTIL_KIND_ARRAY : UTIL_KIND_TYPED_ARRAY;
        extras = UTIL_EXTRAS_ARRAY;
        close_brace = "]";
        u32 length = is_array ? mal_array_object_length(mal_value_to_array_object(value))
            : mal_typed_array_object_length(mal_value_to_typed_array_object(value));
        const char *fallback = is_array ? "Array"
            : (const char *) mal_typed_array_name(mal_value_to_typed_array_object(value)->kind);
        if (!is_array || !util_prefix_is_plain(&names, "Array")) {
            util_write_prefix(ctx, &names, fallback, length);
        }
        util_unit(ctx, '[');
        if (length == 0 && keys.count == 0) {
            util_unit(ctx, ']');
            ok = true;
            goto done;
        }
    } else if (mal_value_is_set_object(value) || mal_value_is_map_object(value)) {
        bool map = mal_value_is_map_object(value);
        kind = map ? UTIL_KIND_MAP : UTIL_KIND_SET;
        usize size = map ? mal_map_object_size(mal_value_to_map_object(value))
            : mal_set_object_size(mal_value_to_set_object(value));
        util_write_prefix(ctx, &names, map ? "Map" : "Set", (i64) size);
        util_unit(ctx, '{');
        if (size == 0 && keys.count == 0) {
            util_unit(ctx, '}');
            ok = true;
            goto done;
        }
    } else if (mal_value_is_callable(value)) {
        bool alone = keys.count == 0;
        i32 close = alone ? util_style_begin(ctx, UTIL_STYLE_SPECIAL) : -1;
        if (!util_write_function_base(ctx, value, &names)) goto done;
        util_style_end(ctx, close);
        if (alone) {
            ok = true;
            goto done;
        }
        base_length = ctx->out->length - head_start;
        util_ascii(ctx, " {");
    } else if (mal_value_is_regexp_object(value)) {
        bool alone = keys.count == 0 || depth_exceeded;
        i32 close = alone ? util_style_begin(ctx, UTIL_STYLE_REGEXP) : -1;
        if (!util_prefix_is_plain(&names, "RegExp")) util_write_prefix(ctx, &names, "RegExp", -1);
        MalValue source, flags;
        if (!util_get(ctx, value, "source", &source) || !mal_value_is_string(source)) goto done;
        tag_roots[0] = source;
        if (!util_get(ctx, value, "flags", &flags) || !mal_value_is_string(flags)) goto done;
        util_unit(ctx, '/');
        mal_text_buffer_append_string(ctx->out, mal_value_to_string(tag_roots[0]));
        util_unit(ctx, '/');
        mal_text_buffer_append_string(ctx->out, mal_value_to_string(flags));
        util_style_end(ctx, close);
        if (alone) {
            ok = true;
            goto done;
        }
        base_length = ctx->out->length - head_start;
        util_ascii(ctx, " {");
    } else if (mal_value_is_date_object(value)) {
        bool alone = keys.count == 0;
        i32 close = alone ? util_style_begin(ctx, UTIL_STYLE_DATE) : -1;
        if (!util_prefix_is_plain(&names, "Date")) util_write_prefix(ctx, &names, "Date", -1);
        f64 time = mal_value_to_date_object(value)->date_value;
        if (isnan(time)) {
            util_ascii(ctx, "Invalid Date");
        } else {
            MalValue method;
            if (!util_get(ctx, vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE], "toISOString", &method)) goto done;
            MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
            if (completion.kind == MAL_COMPLETION_THROW || !mal_value_is_string(completion.value)) goto done;
            mal_text_buffer_append_string(ctx->out, mal_value_to_string(completion.value));
        }
        util_style_end(ctx, close);
        if (alone) {
            ok = true;
            goto done;
        }
        base_length = ctx->out->length - head_start;
        util_ascii(ctx, " {");
    } else if (util_is_error(vm, value)) {
        if (!util_write_error_base(ctx, value, &names, &keys)) goto done;
        if (keys.count == 0) {
            ok = true;
            goto done;
        }
        base_length = ctx->out->length - head_start;
        util_ascii(ctx, " {");
    } else if (mal_value_is_array_buffer_object(value)) {
        kind = UTIL_KIND_ARRAY_BUFFER;
        util_write_prefix(ctx, &names,
            mal_value_to_array_buffer_object(value)->shared ? "SharedArrayBuffer" : "ArrayBuffer", -1);
        util_unit(ctx, '{');
        util_keys_unshift(&keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "byteLength")));
    } else if (mal_value_is_data_view_object(value)) {
        util_write_prefix(ctx, &names, "DataView", -1);
        util_unit(ctx, '{');
        util_keys_unshift(&keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "buffer")));
        util_keys_unshift(&keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "byteOffset")));
        util_keys_unshift(&keys, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "byteLength")));
    } else if (mal_value_is_promise_object(value)) {
        kind = UTIL_KIND_PROMISE;
        util_write_prefix(ctx, &names, "Promise", -1);
        util_unit(ctx, '{');
    } else if (mal_value_is_weak_map_object(value) || mal_value_is_weak_set_object(value)) {
        kind = UTIL_KIND_WEAK;
        util_write_prefix(ctx, &names, mal_value_is_weak_map_object(value) ? "WeakMap" : "WeakSet", -1);
        util_unit(ctx, '{');
    } else if (is_wrapper) {
        bool alone = keys.count == 0;
        if (!util_fmt_boxed_base(ctx, value, &names, alone)) goto done;
        if (alone) {
            ok = true;
            goto done;
        }
        base_length = ctx->out->length - head_start;
        util_ascii(ctx, " {");
    } else {
        if (names.null_prototype || !util_prefix_is_plain(&names, "Object")) {
            util_write_prefix(ctx, &names, "Object", -1);
        }
        util_unit(ctx, '{');
        if (keys.count == 0) {
            util_unit(ctx, '}');
            ok = true;
            goto done;
        }
    }

    if (depth_exceeded) {
        mal_text_buffer_truncate(ctx->out, head_start);
        i32 close = util_style_begin(ctx, UTIL_STYLE_SPECIAL);
        if (!names.null_prototype) util_unit(ctx, '[');
        util_write_prefix(ctx, &names, "Object", -1);
        mal_text_buffer_truncate(ctx->out, ctx->out->length - 1);
        if (!names.null_prototype) util_unit(ctx, ']');
        util_style_end(ctx, close);
        ok = true;
        goto done;
    }

    recurse++;
    if (ctx->seen_count == ctx->seen_capacity) {
        usize capacity = ctx->seen_capacity == 0 ? 16 : ctx->seen_capacity * 2;
        MalObject **seen = realloc(ctx->seen, capacity * sizeof(MalObject *));
        if (seen == nullptr) goto done;
        ctx->seen = seen;
        ctx->seen_capacity = capacity;
    }
    ctx->seen[ctx->seen_count++] = object;
    ctx->current_depth = recurse;
    usize entries_start = ctx->out->length;
    bool formatted = true;
    switch (kind) {
        case UTIL_KIND_ARRAY: formatted = util_fmt_array_entries(ctx, value, recurse, &entries); break;
        case UTIL_KIND_TYPED_ARRAY: formatted = util_fmt_typed_entries(ctx, value, &entries); break;
        case UTIL_KIND_SET: formatted = util_fmt_collection_entries(ctx, value, recurse, &entries, false); break;
        case UTIL_KIND_MAP: formatted = util_fmt_collection_entries(ctx, value, recurse, &entries, true); break;
        case UTIL_KIND_ARRAY_BUFFER: util_fmt_array_buffer_entry(ctx, value, &entries); break;
        case UTIL_KIND_WEAK: {
            usize start;
            util_entry_begin(ctx, &entries, &start);
            util_styled(ctx, "<items unknown>", UTIL_STYLE_SPECIAL);
            util_entry_end(ctx, &entries, start);
            break;
        }
        case UTIL_KIND_PROMISE: {
            MalPromiseObject *promise = mal_value_to_promise_object(value);
            usize start;
            util_entry_begin(ctx, &entries, &start);
            if (promise->state == MAL_PROMISE_PENDING) {
                util_styled(ctx, "<pending>", UTIL_STYLE_SPECIAL);
            } else {
                if (promise->state == MAL_PROMISE_REJECTED) {
                    util_styled(ctx, "<rejected>", UTIL_STYLE_SPECIAL);
                    util_unit(ctx, ' ');
                }
                ctx->indentation += 2;
                formatted = util_fmt_value(ctx, promise->result, recurse);
                ctx->indentation -= 2;
            }
            util_entry_end(ctx, &entries, start);
            break;
        }
        case UTIL_KIND_OBJECT: break;
    }
    usize output_entries = entries.count;
    for (usize i = 0; formatted && i < keys.count; i++) {
        usize start;
        util_entry_begin(ctx, &entries, &start);
        formatted = util_fmt_property(ctx, value, recurse, keys.items[i], UTIL_EXTRAS_OBJECT);
        if (formatted) util_entry_end(ctx, &entries, start);
    }
    ctx->seen_count--;
    if (!formatted) goto done;

    i32 reference = util_circular_index(ctx, object, false);
    if (reference > 0) {
        mal_text_buffer_truncate(&ctx->scratch, 0);
        util_append_slice(&ctx->scratch, ctx->out, head_start, ctx->out->length - head_start);
        mal_text_buffer_truncate(ctx->out, head_start);
        char text[32];
        snprintf(text, sizeof text, "<ref *%d>", reference);
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        util_unit(ctx, ' ');
        usize shift = ctx->out->length - head_start;
        util_append_slice(ctx->out, &ctx->scratch, 0, ctx->scratch.length);
        for (usize i = 0; i < entries.count; i++) entries.items[i].offset += shift;
        entries_start += shift;
        base_length = base_length == 0 ? shift - 1 : base_length + shift;
    }
    if (ctx->sorted) {
        if (extras == UTIL_EXTRAS_OBJECT) {
            util_sort_entries(ctx, entries.items, entries.count);
        } else if (keys.count > 1) {
            util_sort_entries(ctx, entries.items + output_entries, entries.count - output_entries);
        }
        bool reordered = false;
        for (usize i = 1; i < entries.count; i++) {
            if (entries.items[i].offset < entries.items[i - 1].offset) reordered = true;
        }
        if (reordered) {
            mal_text_buffer_truncate(&ctx->scratch, 0);
            util_append_slice(&ctx->scratch, ctx->out, entries_start, ctx->out->length - entries_start);
            mal_text_buffer_truncate(ctx->out, entries_start);
            for (usize i = 0; i < entries.count; i++) {
                util_ascii(ctx, i == 0 ? " " : ", ");
                usize offset = ctx->out->length;
                util_append_slice(ctx->out, &ctx->scratch, entries.items[i].offset - entries_start,
                    entries.items[i].length);
                entries.items[i].offset = offset;
            }
        }
    }
    bool base_newline = false;
    for (usize i = head_start; i < head_start + base_length; i++) {
        if (mal_text_buffer_code_unit_at(ctx->out, i) == '\n') base_newline = true;
    }
    usize head_length = entries_start - head_start;
    util_reduce(ctx, value, kind, &entries, entries_start, head_length - (base_length > 0 ? 1 : 0),
        base_length, base_newline, extras, recurse, close_brace);
    ok = true;
done:
    util_entries_dispose(&entries);
    util_keys_dispose(&keys);
    mal_gc_unroot(&tag_root);
    return ok;
}

static bool util_is_prototype_object(UtilCtx *ctx, MalValue value) {
    MalValue constructor;
    if (!util_own_data(value, util_key(ctx->vm, "constructor"), &constructor)
        || !mal_value_is_callable(constructor)) {
        return false;
    }
    MalValue prototype;
    return util_own_data(constructor, util_key(ctx->vm, "prototype"), &prototype) && prototype == value;
}

static MalValue util_options_object(UtilCtx *ctx);

static bool util_fmt_value(UtilCtx *ctx, MalValue value, i32 recurse) {
    if (!mal_value_is_object(value)) return util_fmt_primitive(ctx, value, true);
    MalVm *vm = ctx->vm;
    MalValue roots[2] = {value, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    bool ok = true;
    if (mal_value_is_proxy_object(value)) {
        roots[0] = mal_proxy_unwrap_target(value);
        if (!mal_value_is_object(roots[0]) || mal_value_is_proxy_object(roots[0])) {
            util_styled(ctx, "<Revoked Proxy>", UTIL_STYLE_SPECIAL);
            goto done;
        }
        util_ascii(ctx, "Proxy(");
        ok = util_fmt_value(ctx, roots[0], recurse);
        util_unit(ctx, ')');
        goto done;
    }
    MalValue target = roots[0];
    if (ctx->custom_inspect) {
        MalValue symbol = mal_node_inspect_custom_symbol(vm);
        if (!mal_vm_get_property(vm, target, mal_key_from_value(symbol), &roots[1]) || util_throwing(ctx)) {
            ok = false;
            goto done;
        }
        if (mal_value_is_callable(roots[1]) && roots[1] != ctx->roots[UTIL_ROOT_INSPECT]
            && !util_is_prototype_object(ctx, target)) {
            MalValue args[3] = {
                isinf(ctx->depth) ? mal_value_new_null() : mal_value_from_f64(ctx->depth - recurse),
                util_options_object(ctx),
                ctx->roots[UTIL_ROOT_INSPECT],
            };
            if (util_throwing(ctx)) {
                ok = false;
                goto done;
            }
            MalCompletion completion = mal_vm_call_value(vm, roots[1], value, args, 3);
            if (completion.kind == MAL_COMPLETION_THROW) {
                ok = false;
                goto done;
            }
            if (completion.value != value) {
                roots[1] = completion.value;
                if (!mal_value_is_string(roots[1])) {
                    ok = util_fmt_value(ctx, roots[1], recurse);
                } else {
                    MalString *string = mal_value_to_string(roots[1]);
                    util_append_indented(ctx, mal_string_code_units(string), mal_string_length(string));
                }
                goto done;
            }
        }
    }
    MalObject *object = mal_value_to_object(target);
    for (usize i = 0; i < ctx->seen_count; i++) {
        if (ctx->seen[i] != object) continue;
        char text[32];
        snprintf(text, sizeof text, "[Circular *%d]", util_circular_index(ctx, object, true));
        util_styled(ctx, text, UTIL_STYLE_SPECIAL);
        goto done;
    }
    ok = util_fmt_raw(ctx, target, recurse);
done:
    mal_gc_unroot(&root);
    return ok;
}

static void util_ctx_apply(UtilCtx *ctx, MalValue options) {
    if (!mal_value_is_object(options)) return;
    MalValue value;
    if (util_get(ctx, options, "showHidden", &value) && !mal_value_is_undefined(value)) {
        ctx->show_hidden = mal_value_is_truthy(value);
    }
    if (util_get(ctx, options, "depth", &value) && !mal_value_is_undefined(value)) {
        if (mal_value_is_null(value)) ctx->depth = INFINITY;
        else if (mal_ops_is_number(value)) ctx->depth = mal_ops_number_as_f64(value);
    }
    if (util_get(ctx, options, "colors", &value) && !mal_value_is_undefined(value)) {
        ctx->colors = mal_value_is_truthy(value);
    }
    if (util_get(ctx, options, "customInspect", &value) && !mal_value_is_undefined(value)) {
        ctx->custom_inspect = mal_value_is_truthy(value);
    }
    if (util_get(ctx, options, "maxArrayLength", &value) && !mal_value_is_undefined(value)) {
        if (mal_value_is_null(value)) ctx->max_array_length = INFINITY;
        else if (mal_ops_is_number(value)) ctx->max_array_length = mal_ops_number_as_f64(value);
    }
    if (util_get(ctx, options, "maxStringLength", &value) && !mal_value_is_undefined(value)) {
        if (mal_value_is_null(value)) ctx->max_string_length = INFINITY;
        else if (mal_ops_is_number(value)) ctx->max_string_length = mal_ops_number_as_f64(value);
    }
    if (util_get(ctx, options, "breakLength", &value) && mal_ops_is_number(value)) {
        ctx->break_length = mal_ops_number_as_f64(value);
    }
    if (util_get(ctx, options, "compact", &value) && !mal_value_is_undefined(value)) {
        if (mal_value_is_boolean(value)) ctx->compact = mal_value_to_boolean(value) ? UTIL_COMPACT_TRUE : 0;
        else if (mal_ops_is_number(value)) ctx->compact = (i32) fmax(0, fmin(1e6, mal_ops_number_as_f64(value)));
    }
    if (util_get(ctx, options, "sorted", &value) && !mal_value_is_undefined(value)) {
        ctx->sorted = mal_value_is_truthy(value);
    }
    if (util_get(ctx, options, "getters", &value) && !mal_value_is_undefined(value)) {
        if (mal_value_is_string(value)) {
            MalString *string = mal_value_to_string(value);
            ctx->getters = util_string_is(string, "get") ? 2 : util_string_is(string, "set") ? 3 : 0;
        } else {
            ctx->getters = mal_value_is_truthy(value) ? 1 : 0;
        }
    }
}

static void util_ctx_init(UtilCtx *ctx, MalVm *vm, MalTextBuffer *out) {
    *ctx = (UtilCtx) {
        .vm = vm,
        .out = out,
        .depth = 2,
        .max_array_length = 100,
        .max_string_length = 10000,
        .break_length = 80,
        .compact = 3,
        .custom_inspect = true,
    };
    for (usize i = 0; i < UTIL_ROOT_COUNT; i++) ctx->roots[i] = mal_value_new_undefined();
    mal_gc_root(&ctx->root, ctx->roots, UTIL_ROOT_COUNT);
    MalValue module = mal_node_module_get_cached(vm, "node:util");
    MalValue inspect;
    if (!util_own_data(module, util_key(vm, "inspect"), &inspect) || !mal_value_is_callable(inspect)) return;
    ctx->roots[UTIL_ROOT_INSPECT] = inspect;
    MalValue defaults;
    if (util_own_data(inspect, util_key(vm, "defaultOptions"), &defaults)) util_ctx_apply(ctx, defaults);
}

static void util_ctx_finish_options(UtilCtx *ctx) {
    if (!ctx->colors || !mal_value_is_object(ctx->roots[UTIL_ROOT_INSPECT])) return;
    MalValue styles, colors;
    if (util_own_data(ctx->roots[UTIL_ROOT_INSPECT], util_key(ctx->vm, "styles"), &styles)
        && util_own_data(ctx->roots[UTIL_ROOT_INSPECT], util_key(ctx->vm, "colors"), &colors)
        && mal_value_is_object(styles) && mal_value_is_object(colors)) {
        ctx->roots[UTIL_ROOT_STYLES] = styles;
        ctx->roots[UTIL_ROOT_COLORS] = colors;
    }
}

static void util_ctx_dispose(UtilCtx *ctx) {
    mal_gc_unroot(&ctx->root);
    free(ctx->seen);
    free(ctx->circular);
    mal_text_buffer_dispose(&ctx->scratch);
}

static MalValue util_stylize(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalString *text;
    if (!mal_vm_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &text)) {
        return mal_value_new_undefined();
    }
    if (argc < 2 || !mal_value_is_string(args[1])) return mal_value_from_string(text);
    MalValue rooted = mal_value_from_string(text);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    MalTextBuffer out = {0};
    UtilCtx ctx;
    util_ctx_init(&ctx, vm, &out);
    ctx.colors = true;
    util_ctx_finish_options(&ctx);
    i32 close = -1;
    for (usize i = 1; i < countof(util_style_names); i++) {
        if (util_string_is(mal_value_to_string(args[1]), util_style_names[i])) {
            close = util_style_begin(&ctx, (UtilStyle) i);
            break;
        }
    }
    mal_text_buffer_append_string(&out, text);
    util_style_end(&ctx, close);
    util_ctx_dispose(&ctx);
    mal_gc_unroot(&root);
    return inspect_finish(vm, &out);
}

static MalValue util_options_object(UtilCtx *ctx) {
    if (mal_value_is_object(ctx->roots[UTIL_ROOT_OPTIONS])) return ctx->roots[UTIL_ROOT_OPTIONS];
    MalVm *vm = ctx->vm;
    MalObject *options = mal_intrinsic_new_object(vm);
    ctx->roots[UTIL_ROOT_OPTIONS] = mal_value_from_object(options);
    MalObject *function_prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue stylize = ctx->colors
        ? mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            function_prototype, mal_intrinsic_ascii(vm, (const byte *) "stylizeWithColor"), 2, util_stylize))
        : mal_value_from_native_function_object(mal_native_function_object_new_arity(&vm->heap,
            function_prototype, mal_intrinsic_ascii(vm, (const byte *) "stylizeNoColor"), 1, util_stylize));
    mal_intrinsic_define_data(vm, options, (const byte *) "stylize", stylize, UTIL_VISIBLE);
    struct { const char *name; MalValue value; } fields[] = {
        {"showHidden", mal_value_new_boolean(ctx->show_hidden)},
        {"depth", isinf(ctx->depth) ? mal_value_new_null() : mal_value_from_f64(ctx->depth)},
        {"colors", mal_value_new_boolean(ctx->colors)},
        {"customInspect", mal_value_new_boolean(ctx->custom_inspect)},
        {"showProxy", mal_value_new_boolean(false)},
        {"maxArrayLength", mal_value_from_f64(ctx->max_array_length)},
        {"maxStringLength", mal_value_from_f64(ctx->max_string_length)},
        {"breakLength", mal_value_from_f64(ctx->break_length)},
        {"compact", ctx->compact == UTIL_COMPACT_TRUE ? mal_value_new_boolean(true)
            : ctx->compact == 0 ? mal_value_new_boolean(false) : mal_value_from_i32(ctx->compact)},
        {"sorted", mal_value_new_boolean(ctx->sorted)},
        {"getters", mal_value_new_boolean(ctx->getters != 0)},
        {"numericSeparator", mal_value_new_boolean(false)},
    };
    for (usize i = 0; i < countof(fields); i++) {
        mal_intrinsic_define_data(vm, options, (const byte *) fields[i].name, fields[i].value, UTIL_VISIBLE);
    }
    return ctx->roots[UTIL_ROOT_OPTIONS];
}

static bool util_inspect_ctx(UtilCtx *ctx, MalValue value) {
    util_ctx_finish_options(ctx);
    return util_fmt_value(ctx, value, 0);
}

bool mal_node_util_inspect_into(
    MalVm *vm, MalTextBuffer *out, MalValue value, const MalNodeInspectOptions *options) {
    UtilCtx ctx;
    util_ctx_init(&ctx, vm, out);
    if (options->dir) ctx.custom_inspect = false;
    if (options->colors) ctx.colors = true;
    util_ctx_apply(&ctx, options->options);
    if (options->assert_value) {
        ctx.compact = 0;
        ctx.custom_inspect = false;
        ctx.depth = 1000;
        ctx.max_array_length = INFINITY;
        ctx.sorted = true;
        ctx.getters = 1;
    }
    if (options->table_cell) {
        ctx.depth = 0;
        if (mal_value_is_object(value) && !mal_value_is_array_object(value)) {
            UtilKeys keys = {0};
            util_collect_keys(&ctx, mal_value_to_object(value), &keys, false);
            if (keys.count > 2) ctx.depth = -1;
            util_keys_dispose(&keys);
        }
        ctx.max_array_length = 3;
        ctx.break_length = INFINITY;
    }
    bool ok = !util_throwing(&ctx) && util_inspect_ctx(&ctx, value);
    util_ctx_dispose(&ctx);
    return ok;
}

static bool util_inspect_with(UtilCtx *parent, MalValue value, i32 mode) {
    UtilCtx ctx;
    util_ctx_init(&ctx, parent->vm, parent->out);
    ctx.show_hidden = parent->show_hidden;
    ctx.depth = parent->depth;
    ctx.colors = parent->colors;
    ctx.custom_inspect = parent->custom_inspect;
    ctx.max_array_length = parent->max_array_length;
    ctx.max_string_length = parent->max_string_length;
    ctx.break_length = parent->break_length;
    ctx.compact = parent->compact;
    ctx.sorted = parent->sorted;
    ctx.getters = parent->getters;
    if (mode == 's') {
        ctx.depth = 0;
        ctx.colors = false;
        ctx.compact = 3;
    } else if (mode == 'o') {
        ctx.show_hidden = true;
        ctx.depth = 4;
    }
    bool ok = util_inspect_ctx(&ctx, value);
    util_ctx_dispose(&ctx);
    return ok;
}

static bool util_has_builtin_to_string(UtilCtx *ctx, MalValue value) {
    MalVm *vm = ctx->vm;
    value = mal_proxy_unwrap_target(value);
    if (!mal_value_is_object(value)) return true;
    MalValue method;
    if (!mal_vm_get_property(vm, value,
            mal_key_from_value(vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE]), &method)) {
        return false;
    }
    if (mal_value_is_callable(method)) return false;
    if (!util_get(ctx, value, "toString", &method)) return false;
    if (!mal_value_is_callable(method)) return true;
    MalKey key = util_key(vm, "toString");
    MalObject *pointer = mal_value_to_object(value);
    if (mal_object_get_own(pointer, key).present) return false;
    do {
        pointer = mal_object_get_prototype(pointer);
    } while (pointer != nullptr && !mal_object_get_own(pointer, key).present);
    if (pointer == nullptr) return true;
    MalValue constructor;
    return util_own_data(mal_value_from_object(pointer), util_key(vm, "constructor"), &constructor)
        && mal_value_is_native_function_object(constructor);
}

static bool util_call_intrinsic(MalVm *vm, MalIntrinsic intrinsic, MalValue argument, MalValue *out) {
    MalCompletion completion = mal_vm_call_value(
        vm, vm->intrinsics[intrinsic], mal_value_new_undefined(), &argument, 1);
    if (completion.kind == MAL_COMPLETION_THROW) return false;
    *out = completion.value;
    return true;
}

static bool util_format_json(UtilCtx *ctx, MalValue value) {
    MalVm *vm = ctx->vm;
    MalValue stringify;
    if (!util_get(ctx, vm->intrinsics[MAL_INTRINSIC_JSON], "stringify", &stringify)) return false;
    MalCompletion completion = mal_vm_call_value(
        vm, stringify, vm->intrinsics[MAL_INTRINSIC_JSON], &value, 1);
    if (completion.kind == MAL_COMPLETION_THROW) {
        MalValue error = completion.value;
        MalValue message;
        if (mal_value_is_object(error) && util_own_data(error, util_key(vm, "message"), &message)
            && mal_value_is_string(message)) {
            MalString *text = mal_value_to_string(message);
            if (util_index_of_ascii(mal_string_code_units(text), mal_string_length(text), "ircular", 0) >= 0) {
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
                util_ascii(ctx, "[Circular]");
                return true;
            }
        }
        return false;
    }
    if (mal_value_is_string(completion.value)) {
        mal_text_buffer_append_string(ctx->out, mal_value_to_string(completion.value));
    } else {
        util_ascii(ctx, "undefined");
    }
    return true;
}

static bool util_format_number_arg(UtilCtx *ctx, MalValue value, c16 conversion) {
    MalVm *vm = ctx->vm;
    if (mal_value_is_symbol(value)) {
        util_ascii(ctx, "NaN");
        return true;
    }
    if (mal_value_is_bigint(value) && conversion != 'f') return util_fmt_bigint(vm, ctx->out, value);
    MalValue number;
    if (conversion == 'd') {
        f64 result;
        if (!mal_vm_to_number(vm, value, &result)) return false;
        number = mal_value_from_f64(result);
    } else if (!util_call_intrinsic(vm, conversion == 'i' ? MAL_INTRINSIC_PARSE_INT
            : MAL_INTRINSIC_PARSE_FLOAT, value, &number)) {
        return false;
    }
    util_fmt_number(ctx->out, number);
    return true;
}

static bool util_format_arg(UtilCtx *ctx, MalValue value) {
    if (mal_value_is_string(value)) {
        mal_text_buffer_append_string(ctx->out, mal_value_to_string(value));
        return true;
    }
    return util_inspect_ctx(ctx, value);
}

static bool util_format_into(UtilCtx *ctx, const MalValue *args, i32 argc) {
    MalVm *vm = ctx->vm;
    i32 next = 0;
    bool join = false;
    if (argc == 1 && mal_value_is_string(args[0])) {
        mal_text_buffer_append_string(ctx->out, mal_value_to_string(args[0]));
        return true;
    }
    if (argc > 0 && mal_value_is_string(args[0])) {
        MalString *format = mal_value_to_string(args[0]);
        const c16 *units = mal_string_code_units(format);
        usize length = mal_string_length(format);
        usize last = 0;
        bool consumed = false;
        for (usize i = 0; i + 1 < length; i++) {
            if (units[i] != '%') continue;
            c16 conversion = units[++i];
            if (next + 1 != argc) {
                if (conversion == '%') {
                    mal_text_buffer_append_units(ctx->out, units + last, i - last);
                    last = i + 1;
                    consumed = true;
                    continue;
                }
                if (conversion != 's' && conversion != 'j' && conversion != 'd' && conversion != 'O'
                    && conversion != 'o' && conversion != 'i' && conversion != 'f' && conversion != 'c') {
                    continue;
                }
                mal_text_buffer_append_units(ctx->out, units + last, i - 1 - last);
                MalValue argument = args[++next];
                bool ok = true;
                switch (conversion) {
                    case 's':
                        if (mal_ops_is_number(argument)) {
                            util_fmt_number(ctx->out, argument);
                        } else if (mal_value_is_bigint(argument)) {
                            ok = util_fmt_bigint(vm, ctx->out, argument);
                        } else if (mal_value_is_symbol(argument)) {
                            util_fmt_symbol(ctx->out, argument);
                        } else if (!mal_value_is_object(argument)
                            || !util_has_builtin_to_string(ctx, argument)) {
                            if (util_throwing(ctx)) return false;
                            MalString *string;
                            ok = mal_vm_to_string(vm, argument, &string);
                            if (ok) mal_text_buffer_append_string(ctx->out, string);
                        } else {
                            ok = util_inspect_with(ctx, argument, 's');
                        }
                        break;
                    case 'j': ok = util_format_json(ctx, argument); break;
                    case 'd': case 'i': case 'f': ok = util_format_number_arg(ctx, argument, conversion); break;
                    case 'O': ok = util_inspect_with(ctx, argument, 'O'); break;
                    case 'o': ok = util_inspect_with(ctx, argument, 'o'); break;
                    default: break;
                }
                if (!ok || util_throwing(ctx)) return false;
                last = i + 1;
                consumed = true;
            } else if (conversion == '%') {
                mal_text_buffer_append_units(ctx->out, units + last, i - last);
                last = i + 1;
                consumed = true;
            }
        }
        if (consumed) {
            next++;
            join = true;
            if (last < length) mal_text_buffer_append_units(ctx->out, units + last, length - last);
        }
    }
    for (; next < argc; next++) {
        if (join) util_unit(ctx, ' ');
        join = true;
        if (!util_format_arg(ctx, args[next])) return false;
    }
    return true;
}

bool mal_node_util_format_into(
    MalVm *vm, MalTextBuffer *out, MalValue options, bool colors, const MalValue *args, i32 argc) {
    UtilCtx ctx;
    util_ctx_init(&ctx, vm, out);
    if (colors) ctx.colors = true;
    util_ctx_apply(&ctx, options);
    util_ctx_finish_options(&ctx);
    bool ok = !util_throwing(&ctx) && util_format_into(&ctx, args, argc);
    util_ctx_dispose(&ctx);
    return ok;
}

MalValue mal_node_util_inspect(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalTextBuffer out = {0};
    UtilCtx ctx;
    util_ctx_init(&ctx, vm, &out);
    if (argc > 1) {
        if (argc > 2 && !mal_value_is_undefined(args[2])) {
            ctx.depth = mal_value_is_null(args[2]) ? INFINITY
                : mal_ops_is_number(args[2]) ? mal_ops_number_as_f64(args[2]) : ctx.depth;
        }
        if (argc > 3 && !mal_value_is_undefined(args[3])) ctx.colors = mal_value_is_truthy(args[3]);
        if (mal_value_is_boolean(args[1])) ctx.show_hidden = mal_value_to_boolean(args[1]);
        else util_ctx_apply(&ctx, args[1]);
    }
    bool ok = !util_throwing(&ctx)
        && util_inspect_ctx(&ctx, argc > 0 ? args[0] : mal_value_new_undefined());
    util_ctx_dispose(&ctx);
    if (!ok) {
        mal_text_buffer_dispose(&out);
        return mal_value_new_undefined();
    }
    return inspect_finish(vm, &out);
}

static MalValue util_format_values(
    MalVm *vm, MalValue options, const MalValue *args, i32 argc) {
    MalTextBuffer out = {0};
    if (!mal_node_util_format_into(vm, &out, options, false, args, argc)) {
        mal_text_buffer_dispose(&out);
        return mal_value_new_undefined();
    }
    return inspect_finish(vm, &out);
}

MalValue mal_node_util_format(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    return util_format_values(vm, mal_value_new_undefined(), args, argc);
}

MalValue mal_node_util_format_with_options(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 1 || !mal_value_is_object(args[0])) {
        mal_node_throw_invalid_arg_type(vm, "inspectOptions", "of type object",
            argc > 0 ? args[0] : mal_value_new_undefined());
        return mal_value_new_undefined();
    }
    return util_format_values(vm, args[0], argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0);
}

void mal_node_inspect_install_tables(MalVm *vm, MalObject *inspect) {
    MalValue values[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root;
    mal_gc_root(&root, values, 3);
    mal_intrinsic_define_data(vm, inspect, (const byte *) "custom",
        mal_node_inspect_custom_symbol(vm), UTIL_VISIBLE);
    values[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *defaults = mal_value_to_object(values[0]);
    struct { const char *name; MalValue value; } fields[] = {
        {"showHidden", mal_value_new_boolean(false)}, {"depth", mal_value_from_i32(2)},
        {"colors", mal_value_new_boolean(false)}, {"customInspect", mal_value_new_boolean(true)},
        {"showProxy", mal_value_new_boolean(false)}, {"maxArrayLength", mal_value_from_i32(100)},
        {"maxStringLength", mal_value_from_i32(10000)}, {"breakLength", mal_value_from_i32(80)},
        {"compact", mal_value_from_i32(3)}, {"sorted", mal_value_new_boolean(false)},
        {"getters", mal_value_new_boolean(false)}, {"numericSeparator", mal_value_new_boolean(false)},
    };
    for (usize i = 0; i < countof(fields); i++) {
        mal_intrinsic_define_data(vm, defaults, (const byte *) fields[i].name, fields[i].value, UTIL_VISIBLE);
    }
    mal_intrinsic_define_data(vm, inspect, (const byte *) "defaultOptions", values[0], UTIL_VISIBLE);
    values[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
    for (usize i = 1; i < countof(util_style_names); i++) {
        if (util_style_defaults[i] == nullptr) continue;
        mal_intrinsic_define_data(vm, mal_value_to_object(values[0]), (const byte *) util_style_names[i],
            mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) util_style_defaults[i])), UTIL_VISIBLE);
    }
    mal_intrinsic_define_data(vm, inspect, (const byte *) "styles", values[0], UTIL_VISIBLE);
    values[0] = mal_value_from_object(mal_intrinsic_new_object(vm));
    for (usize i = 0; i < countof(util_colors); i++) {
        MalValue pair[2] = {mal_value_from_i32(util_colors[i].open), mal_value_from_i32(util_colors[i].close)};
        values[1] = mal_value_from_object((MalObject *) mal_array_object_new_from_values(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), pair, 2));
        mal_intrinsic_define_data(vm, mal_value_to_object(values[0]), (const byte *) util_colors[i].name,
            values[1], util_colors[i].alias ? MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE : UTIL_VISIBLE);
    }
    mal_intrinsic_define_data(vm, inspect, (const byte *) "colors", values[0], UTIL_VISIBLE);
    mal_gc_unroot(&root);
}


#endif /* MAL_NODE */
