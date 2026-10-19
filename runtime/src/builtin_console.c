#include "builtin_console.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "builtin_date.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "map_object.h"
#include "set_object.h"
#include "array_object.h"
#include "monotonic_clock.h"
#include "object_ops.h"
#include "property_iter.h"
#include "text_buffer.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#if MAL_NODE
#include "function_object.h"
#include "runtime/node_inspect.h"
#include "runtime/node_module.h"
#endif

#define CONSOLE_VISIBLE (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static void console_plain_value(MalVm *vm, MalTextBuffer *out, MalValue value, bool quote_strings);

static void console_plain_object(MalVm *vm, MalTextBuffer *out, MalValue value) {
    if (mal_value_is_array_object(value)) {
        MalArrayObject *array = mal_value_to_array_object(value);
        u32 length = mal_array_object_length(array);
        mal_text_buffer_append_ascii(out, (const byte *) "[ ");
        for (u32 index = 0; index < length; index++) {
            if (index > 0) mal_text_buffer_append_ascii(out, (const byte *) ", ");
            MalPropertyResolution resolution = mal_object_resolve_property(
                (MalObject *) array, mal_key_index(index));
            console_plain_value(vm, out,
                resolution.found ? resolution.desc.value : mal_value_new_undefined(), true);
        }
        mal_text_buffer_append_ascii(out, (const byte *) " ]");
        return;
    }
    if (mal_value_is_callable(value)) {
        MalString *name = mal_vm_callable_name(vm, value);
        mal_text_buffer_append_ascii(out, (const byte *) "[Function: ");
        if (name != nullptr && mal_string_length(name) > 0) {
            mal_text_buffer_append_string(out, name);
        } else {
            mal_text_buffer_append_ascii(out, (const byte *) "anonymous");
        }
        mal_text_buffer_push(out, ']');
        return;
    }
    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    mal_text_buffer_append_ascii(out, (const byte *) "{ ");
    MalKey key;
    MalPropertyDesc desc;
    bool first = true;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL) continue;
        if (!first) mal_text_buffer_append_ascii(out, (const byte *) ", ");
        first = false;
        mal_text_buffer_append_string(out, mal_ops_to_string(&vm->heap, key.value));
        mal_text_buffer_append_ascii(out, (const byte *) ": ");
        console_plain_value(vm, out, desc.value, true);
    }
    mal_text_buffer_append_ascii(out, (const byte *) (first ? "}" : " }"));
}

static void console_plain_value(MalVm *vm, MalTextBuffer *out, MalValue value, bool quote_strings) {
    if (mal_value_is_string(value)) {
        if (quote_strings) mal_text_buffer_push(out, '"');
        mal_text_buffer_append_string(out, mal_value_to_string(value));
        if (quote_strings) mal_text_buffer_push(out, '"');
        return;
    }
    if (mal_value_is_object(value)) {
        console_plain_object(vm, out, value);
        return;
    }
    mal_text_buffer_append_string(out, mal_ops_to_string(&vm->heap, value));
}

// The console whose state and streams the running method uses; methods save and restore it.
static MAL_ISOLATE_LOCAL MalValue console_receiver = MAL_VALUE_UNDEFINED;

static MalValue console_state_symbol(MalVm *vm);

static MalObject *console_holder(MalVm *vm) {
    return mal_value_is_object(console_receiver) ? mal_value_to_object(console_receiver)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_CONSOLE]);
}

static bool console_state_value(MalVm *vm, MalObject *holder, const char *field, MalValue *out) {
    MalPropertyLookup state = mal_object_get_own(holder, mal_key_from_value(console_state_symbol(vm)));
    if (!state.present || !mal_value_is_object(state.desc.value)) return false;
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(state.desc.value),
        mal_intrinsic_string_key(vm, (const byte *) field));
    if (!found.present) return false;
    *out = found.desc.value;
    return true;
}

static MalValue console_resolve(MalVm *vm, MalValue this_value) {
    MalValue stream;
    if (mal_value_is_object(this_value)
        && console_state_value(vm, mal_value_to_object(this_value), "stdout", &stream)) {
        return this_value;
    }
    return mal_value_new_undefined();
}

static bool console_instance_stream(MalVm *vm, FILE *stream, MalValue *out) {
    if (!mal_value_is_object(console_receiver)) return false;
    return console_state_value(vm, mal_value_to_object(console_receiver),
        stream == stderr ? "stderr" : "stdout", out);
}

#if MAL_NODE
static bool console_node(const MalVm *vm) {
    return vm->host_node;
}

// Node's console colors only a TTY whose color depth exceeds two colors.
static bool console_colors(MalVm *vm, FILE *stream) {
    MalValue instance_stream;
    if (console_instance_stream(vm, stream, &instance_stream)) {
        MalValue mode = mal_value_new_undefined();
        (void) console_state_value(vm, mal_value_to_object(console_receiver), "colorMode", &mode);
        if (mal_value_is_boolean(mode)) return mal_value_to_boolean(mode);
        MalValue tty;
        if (!mal_value_is_object(instance_stream)
            || !mal_vm_get_property(vm, instance_stream, mal_intrinsic_string_key(vm, (const byte *) "isTTY"), &tty)
            || vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        return mal_value_is_truthy(tty);
    }
    if (!isatty(fileno(stream))) return false;
    const char *force = getenv("FORCE_COLOR");
    if (force != nullptr) return strcmp(force, "0") != 0 && strcmp(force, "false") != 0;
    if (getenv("NODE_DISABLE_COLORS") != nullptr || getenv("NO_COLOR") != nullptr) return false;
    const char *term = getenv("TERM");
    return term == nullptr || strcmp(term, "dumb") != 0;
}
#endif

static bool console_format(MalVm *vm, FILE *stream, MalTextBuffer *out, const MalValue *args, i32 argc) {
#if MAL_NODE
    if (console_node(vm)) {
        MalValue options = mal_value_new_undefined();
        if (mal_value_is_object(console_receiver)) {
            (void) console_state_value(vm, mal_value_to_object(console_receiver), "inspectOptions", &options);
        }
        return mal_node_util_format_into(vm, out, options, console_colors(vm, stream), args, argc);
    }
#endif
    (void) stream;
    for (i32 i = 0; i < argc; i++) {
        if (i > 0) mal_text_buffer_push(out, ' ');
        console_plain_value(vm, out, args[i], false);
    }
    return true;
}

static MalValue console_state_symbol(MalVm *vm) {
    MalString *key = mal_intrinsic_ascii(vm, (const byte *) "maligator.console.state");
    MalSymbol *symbol = mal_symbol_registry_find(&vm->symbol_registry, key);
    if (symbol == nullptr) {
        symbol = mal_symbol_registry_insert(&vm->symbol_registry, mal_symbol_new(&vm->heap, key));
    }
    return mal_value_from_symbol(symbol);
}

static void console_set(MalObject *object, MalKey key, MalValue value, MalPropertyFlags flags) {
    MalPropertyDesc desc = {.flags = flags, .value = value};
    (void) mal_object_define_own(object, key, &desc);
}

static MalObject *console_state(MalVm *vm, const char *field) {
    MalObject *console = console_holder(vm);
    MalKey key = mal_key_from_value(console_state_symbol(vm));
    MalPropertyLookup state = mal_object_get_own(console, key);
    MalValue state_value;
    if (!state.present || !mal_value_is_object(state.desc.value)) {
        state_value = mal_value_from_object(mal_intrinsic_new_object(vm));
        console_set(console, key, state_value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    } else {
        state_value = state.desc.value;
    }
    if (field == nullptr) return mal_value_to_object(state_value);
    MalKey field_key = mal_intrinsic_string_key(vm, (const byte *) field);
    MalPropertyLookup found = mal_object_get_own(mal_value_to_object(state_value), field_key);
    if (found.present && mal_value_is_object(found.desc.value)) return mal_value_to_object(found.desc.value);
    MalObject *table = mal_object_new(&vm->heap, nullptr);
    console_set(mal_value_to_object(state_value), field_key, mal_value_from_object(table), CONSOLE_VISIBLE);
    return table;
}

static i32 console_indent(MalVm *vm) {
    MalPropertyLookup found = mal_object_get_own(console_state(vm, nullptr),
        mal_intrinsic_string_key(vm, (const byte *) "indent"));
    return found.present && mal_ops_is_number(found.desc.value)
        ? (i32) mal_ops_number_as_f64(found.desc.value) : 0;
}

static void console_set_indent(MalVm *vm, i32 indent) {
    console_set(console_state(vm, nullptr), mal_intrinsic_string_key(vm, (const byte *) "indent"),
        mal_value_from_i32(indent < 0 ? 0 : indent), CONSOLE_VISIBLE);
}

static void console_write_stream(MalVm *vm, MalValue stream, MalString *string) {
    MalValue roots[2] = {stream, mal_value_from_string(string)};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue ignore = mal_value_new_boolean(true);
    (void) console_state_value(vm, console_holder(vm), "ignoreErrors", &ignore);
    MalValue write;
    if (mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "write"), &write)
        && vm->completion.kind != MAL_COMPLETION_THROW) {
        (void) mal_vm_call_value(vm, write, roots[0], &roots[1], 1);
    }
    bool ignore_errors = !mal_value_is_boolean(ignore) || mal_value_to_boolean(ignore);
    if (vm->completion.kind == MAL_COMPLETION_THROW && ignore_errors) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    }
    mal_gc_unroot(&root);
}

static void console_emit(MalVm *vm, FILE *stream, MalTextBuffer *line) {
    i32 indent = console_indent(vm);
    MalTextBuffer indented = {0};
    MalTextBuffer *source = line;
    if (indent > 0) {
        for (i32 i = 0; i < indent; i++) mal_text_buffer_push(&indented, ' ');
        for (usize i = 0; i < line->length; i++) {
            c16 unit = mal_text_buffer_code_unit_at(line, i);
            mal_text_buffer_push(&indented, unit);
            if (unit == '\n') {
                for (i32 j = 0; j < indent; j++) mal_text_buffer_push(&indented, ' ');
            }
        }
        mal_text_buffer_dispose(line);
        source = &indented;
    }
    mal_text_buffer_push(source, '\n');
    MalString *string = mal_text_buffer_finish(&vm->heap, source);
    MalValue instance_stream;
    if (console_instance_stream(vm, stream, &instance_stream)) {
        console_write_stream(vm, instance_stream, string);
        return;
    }
    usize byte_len;
    byte *bytes = mal_string_to_utf8(string, &byte_len);
    if (bytes != nullptr) {
        fwrite(bytes, 1, byte_len, stream);
        free(bytes);
    }
}

static MalValue console_print(MalVm *vm, FILE *stream, const MalValue *args, i32 argc) {
    MalTextBuffer line = {0};
    if (!console_format(vm, stream, &line, args, argc)) {
        mal_text_buffer_dispose(&line);
        return mal_value_new_undefined();
    }
    console_emit(vm, stream, &line);
    return mal_value_new_undefined();
}

#define CONSOLE_METHOD(name) \
    static MalValue name##_body(MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee); \
    static MalValue name(MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        MalValue saved = console_receiver; \
        console_receiver = console_resolve(vm, this_value); \
        MalValue result = name##_body(vm, this_value, args, argc, new_target, callee); \
        console_receiver = saved; \
        return result; \
    } \
    static MalValue name##_global(MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee) { \
        MalValue saved = console_receiver; \
        console_receiver = mal_value_new_undefined(); \
        MalValue result = name##_body(vm, this_value, args, argc, new_target, callee); \
        console_receiver = saved; \
        return result; \
    } \
    static MalValue name##_body(MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, \
        MalValue new_target, MalValue callee)

#define CONSOLE_UNUSED (void) this_value; (void) new_target; (void) callee

CONSOLE_METHOD(console_log) {
    CONSOLE_UNUSED;
    return console_print(vm, stdout, args, argc);
}

CONSOLE_METHOD(console_error) {
    CONSOLE_UNUSED;
    return console_print(vm, stderr, args, argc);
}

CONSOLE_METHOD(console_trace) {
    CONSOLE_UNUSED;
    MalTextBuffer line = {0};
    mal_text_buffer_append_ascii(&line, (const byte *) "Trace");
    if (argc > 0) {
        mal_text_buffer_append_ascii(&line, (const byte *) ": ");
        if (!console_format(vm, stderr, &line, args, argc)) {
            mal_text_buffer_dispose(&line);
            return mal_value_new_undefined();
        }
    }
    MalStackTrace *trace = mal_vm_capture_stack(vm);
    if (trace != nullptr) {
        mal_text_buffer_append_string(&line, mal_vm_format_stack_frames(vm, trace));
        mal_vm_free_stack_trace(trace);
    }
    console_emit(vm, stderr, &line);
    return mal_value_new_undefined();
}

CONSOLE_METHOD(console_assert) {
    CONSOLE_UNUSED;
    if (argc > 0 && mal_value_is_truthy(args[0])) return mal_value_new_undefined();
    MalTextBuffer line = {0};
    mal_text_buffer_append_ascii(&line, (const byte *) "Assertion failed");
    if (argc > 1) {
        if (mal_value_is_string(args[1])) {
            mal_text_buffer_append_ascii(&line, (const byte *) ": ");
        } else {
            mal_text_buffer_push(&line, ' ');
        }
        if (!console_format(vm, stderr, &line, args + 1, argc - 1)) {
            mal_text_buffer_dispose(&line);
            return mal_value_new_undefined();
        }
    }
    console_emit(vm, stderr, &line);
    return mal_value_new_undefined();
}

CONSOLE_METHOD(console_dir) {
    CONSOLE_UNUSED;
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
#if MAL_NODE
    if (console_node(vm)) {
        MalTextBuffer line = {0};
        MalNodeInspectOptions options = {
            .options = argc > 1 ? args[1] : mal_value_new_undefined(),
            .colors = console_colors(vm, stdout),
            .dir = true,
        };
        if (!mal_node_util_inspect_into(vm, &line, value, &options)) {
            mal_text_buffer_dispose(&line);
            return mal_value_new_undefined();
        }
        console_emit(vm, stdout, &line);
        return mal_value_new_undefined();
    }
#endif
    return console_print(vm, stdout, &value, 1);
}

CONSOLE_METHOD(console_group) {
    CONSOLE_UNUSED;
    if (argc > 0) console_print(vm, stdout, args, argc);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue step = mal_value_from_i32(2);
    (void) console_state_value(vm, console_holder(vm), "groupIndentation", &step);
    console_set_indent(vm, console_indent(vm) + (mal_ops_is_number(step) ? (i32) mal_ops_number_as_f64(step) : 2));
    return mal_value_new_undefined();
}

CONSOLE_METHOD(console_group_end) {
    CONSOLE_UNUSED;
    (void) args;
    (void) argc;
    MalValue step = mal_value_from_i32(2);
    (void) console_state_value(vm, console_holder(vm), "groupIndentation", &step);
    console_set_indent(vm, console_indent(vm) - (mal_ops_is_number(step) ? (i32) mal_ops_number_as_f64(step) : 2));
    return mal_value_new_undefined();
}

static bool console_label(MalVm *vm, const MalValue *args, i32 argc, MalValue *out) {
    if (argc < 1 || mal_value_is_undefined(args[0])) {
        *out = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "default"));
        return true;
    }
    MalString *label;
    if (!mal_vm_to_string(vm, args[0], &label)) return false;
    *out = mal_value_from_string(label);
    return true;
}

static void console_label_line(MalVm *vm, FILE *stream, MalValue label, const char *suffix) {
    MalTextBuffer line = {0};
    mal_text_buffer_append_string(&line, mal_value_to_string(label));
    mal_text_buffer_append_ascii(&line, (const byte *) suffix);
    console_emit(vm, stream, &line);
}

CONSOLE_METHOD(console_count) {
    CONSOLE_UNUSED;
    MalValue label;
    if (!console_label(vm, args, argc, &label)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &label, 1);
    MalObject *counts = console_state(vm, "counts");
    MalKey key = mal_key_from_value(label);
    MalPropertyLookup found = mal_object_get_own(counts, key);
    f64 count = (found.present && mal_ops_is_number(found.desc.value)
        ? mal_ops_number_as_f64(found.desc.value) : 0) + 1;
    console_set(counts, key, mal_value_from_f64(count), CONSOLE_VISIBLE);
    char text[48];
    snprintf(text, sizeof text, ": %.0f", count);
    console_label_line(vm, stdout, label, text);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

CONSOLE_METHOD(console_count_reset) {
    CONSOLE_UNUSED;
    MalValue label;
    if (!console_label(vm, args, argc, &label)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &label, 1);
    MalObject *counts = console_state(vm, "counts");
    if (mal_object_get_own(counts, mal_key_from_value(label)).present) {
        (void) mal_object_delete_own(counts, mal_key_from_value(label));
    } else {
        MalTextBuffer line = {0};
        mal_text_buffer_append_ascii(&line, (const byte *) "Warning: Count for '");
        mal_text_buffer_append_string(&line, mal_value_to_string(label));
        mal_text_buffer_append_ascii(&line, (const byte *) "' does not exist");
        console_emit(vm, stderr, &line);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static f64 console_now_ms(void) {
    return (f64) mal_monotonic_now_ns() / 1e6;
}

CONSOLE_METHOD(console_time) {
    CONSOLE_UNUSED;
    MalValue label;
    if (!console_label(vm, args, argc, &label)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &label, 1);
    MalObject *timers = console_state(vm, "timers");
    MalKey key = mal_key_from_value(label);
    if (!mal_object_get_own(timers, key).present) {
        console_set(timers, key, mal_value_from_f64(console_now_ms()), CONSOLE_VISIBLE);
    }
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

// Node's formatTime: milliseconds below a second, seconds below a minute, then m:ss.mmm.
static void console_format_time(char *text, usize capacity, f64 ms) {
    if (ms >= 60000) {
        f64 hours = floor(ms / 3600000);
        ms = fmod(ms, 3600000);
        f64 minutes = floor(ms / 60000);
        f64 seconds = fmod(ms, 60000) / 1000;
        char fixed[32];
        snprintf(fixed, sizeof fixed, "%06.3f", seconds);
        if (hours > 0) snprintf(text, capacity, "%.0f:%02.0f:%s (h:mm:ss.mmm)", hours, minutes, fixed);
        else snprintf(text, capacity, "%.0f:%s (m:ss.mmm)", minutes, fixed);
    } else if (ms >= 1000) {
        snprintf(text, capacity, "%.3fs", ms / 1000);
    } else {
        snprintf(text, capacity, "%.3f", ms);
        char *end = text + strlen(text) - 1;
        while (*end == '0') *end-- = '\0';
        if (*end == '.') *end = '\0';
        strncat(text, "ms", capacity - strlen(text) - 1);
    }
}

static MalValue console_time_report(
    MalVm *vm, const MalValue *args, i32 argc, bool end) {
    MalValue label;
    if (!console_label(vm, args, argc, &label)) return mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, &label, 1);
    MalObject *timers = console_state(vm, "timers");
    MalKey key = mal_key_from_value(label);
    MalPropertyLookup found = mal_object_get_own(timers, key);
    if (!found.present || !mal_ops_is_number(found.desc.value)) {
        MalTextBuffer line = {0};
        mal_text_buffer_append_ascii(&line, (const byte *) "Warning: No such label '");
        mal_text_buffer_append_string(&line, mal_value_to_string(label));
        mal_text_buffer_append_ascii(&line, (const byte *) (end
            ? "' for console.timeEnd()" : "' for console.timeLog()"));
        console_emit(vm, stderr, &line);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    char text[96] = ": ";
    console_format_time(text + 2, sizeof text - 2, console_now_ms() - mal_ops_number_as_f64(found.desc.value));
    if (end) (void) mal_object_delete_own(timers, key);
    MalTextBuffer line = {0};
    mal_text_buffer_append_string(&line, mal_value_to_string(label));
    mal_text_buffer_append_ascii(&line, (const byte *) text);
    if (!end && argc > 1) {
        mal_text_buffer_push(&line, ' ');
        if (!console_format(vm, stdout, &line, args + 1, argc - 1)) {
            mal_text_buffer_dispose(&line);
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
    }
    console_emit(vm, stdout, &line);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

CONSOLE_METHOD(console_time_end) {
    CONSOLE_UNUSED;
    return console_time_report(vm, args, argc, true);
}

CONSOLE_METHOD(console_time_log) {
    CONSOLE_UNUSED;
    return console_time_report(vm, args, argc, false);
}

#if MAL_NODE
typedef struct ConsoleList {
    MalValue *items;
    usize count;
    usize capacity;
    MalRootSpan root;
    bool rooted;
} ConsoleList;

static void console_list_push(ConsoleList *list, MalValue value) {
    if (list->count == list->capacity) {
        usize capacity = list->capacity == 0 ? 16 : list->capacity * 2;
        MalValue *items = realloc(list->items, capacity * sizeof(MalValue));
        if (items == nullptr) return;
        if (list->rooted) mal_gc_unroot(&list->root);
        for (usize i = list->count; i < capacity; i++) items[i] = mal_value_new_undefined();
        list->items = items;
        list->capacity = capacity;
        mal_gc_root(&list->root, list->items, (i32) capacity);
        list->rooted = true;
    }
    list->items[list->count++] = value;
}

static void console_list_dispose(ConsoleList *list) {
    if (list->rooted) mal_gc_unroot(&list->root);
    free(list->items);
}

static void console_own_keys(MalVm *vm, MalValue object, ConsoleList *keys) {
    MalObject *target = mal_value_to_object(object);
    bool array = mal_value_is_array_object(object);
    if (array) {
        u32 length = mal_array_object_length(mal_value_to_array_object(object));
        for (u32 i = 0; i < length; i++) {
            MalPropertyResolution found = mal_object_resolve_property(target, mal_key_index(i));
            if (found.found && found.own) {
                console_list_push(keys, mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i))));
            }
        }
    }
    MalPropertyIter iter;
    MalKey key;
    MalPropertyDesc desc;
    mal_property_iter_init(&iter, target, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL || (array && key.kind == MAL_KEY_INDEX)) continue;
        console_list_push(keys, key.kind == MAL_KEY_INDEX
            ? mal_value_from_string(mal_ops_to_string(&vm->heap, key.value)) : key.value);
    }
}

static MalKey console_key(MalValue name) {
    if (mal_value_is_string(name)) {
        MalString *string = mal_value_to_string(name);
        usize length = mal_string_length(string);
        const c16 *units = mal_string_code_units(string);
        u64 index = 0;
        bool numeric = length > 0 && length <= 10 && (units[0] != '0' || length == 1);
        for (usize i = 0; numeric && i < length; i++) {
            if (units[i] < '0' || units[i] > '9') numeric = false;
            else index = index * 10 + (u64) (units[i] - '0');
        }
        if (numeric && index < 0xffffffffull) return mal_key_index((u32) index);
    }
    return mal_key_from_value(name);
}

static bool console_cell(MalVm *vm, MalValue value, MalValue *out) {
    MalTextBuffer text = {0};
    MalNodeInspectOptions options = {.options = mal_value_new_undefined(), .table_cell = true};
    if (!mal_node_util_inspect_into(vm, &text, value, &options)) {
        mal_text_buffer_dispose(&text);
        return false;
    }
    *out = mal_value_from_string(mal_text_buffer_finish(&vm->heap, &text));
    return true;
}

static usize console_width(MalValue cell) {
    if (!mal_value_is_string(cell)) return 0;
    MalString *string = mal_value_to_string(cell);
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize width = 0;
    for (usize i = 0; i < length; i++) {
        if (units[i] == 0x1b && i + 1 < length && units[i + 1] == '[') {
            while (i < length && units[i] != 'm') i++;
            continue;
        }
        if (units[i] >= 0xdc00 && units[i] <= 0xdfff) continue;
        width++;
    }
    return width;
}

static void console_repeat(MalTextBuffer *out, const char *piece, usize count) {
    for (usize i = 0; i < count; i++) {
        usize byte_len = strlen(piece);
        usize consumed = 0;
        while (consumed < byte_len) {
            u32 code = 0;
            u8 lead = (u8) piece[consumed];
            usize size = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
            code = size == 1 ? lead : lead & (0xff >> (size + 1));
            for (usize k = 1; k < size; k++) code = (code << 6) | ((u8) piece[consumed + k] & 0x3f);
            mal_text_buffer_push(out, (c16) code);
            consumed += size;
        }
    }
}

static void console_divider(MalTextBuffer *out, const usize *widths, usize columns,
    const char *left, const char *middle, const char *right) {
    console_repeat(out, left, 1);
    for (usize c = 0; c < columns; c++) {
        if (c > 0) console_repeat(out, middle, 1);
        console_repeat(out, "─", widths[c] + 2);
    }
    console_repeat(out, right, 1);
}

static void console_row(MalTextBuffer *out, const MalValue *cells, const usize *widths, usize columns) {
    console_repeat(out, "│ ", 1);
    for (usize c = 0; c < columns; c++) {
        if (c > 0) console_repeat(out, " │ ", 1);
        if (mal_value_is_string(cells[c])) mal_text_buffer_append_string(out, mal_value_to_string(cells[c]));
        for (usize i = console_width(cells[c]); i < widths[c]; i++) mal_text_buffer_push(out, ' ');
    }
    console_repeat(out, " │", 1);
}

// Node's console.table: an index column, one column per property, and a Values column for primitives.
static MalValue console_table_print(MalVm *vm, MalValue data, MalValue properties) {
    ConsoleList head = {0}, grid = {0}, rows = {0}, scratch = {0};
    bool map = mal_value_is_map_object(data), set = mal_value_is_set_object(data);
    usize row_count = 0;
    bool ok = true;
    if (map || set) {
        console_list_push(&head, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "(iteration index)")));
        if (map) console_list_push(&head, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "Key")));
        console_list_push(&head, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "Values")));
        MalValue pair[2] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
        MalRootSpan pair_root;
        mal_gc_root(&pair_root, pair, 2);
        if (map) {
            MalMapStorage *storage = mal_map_object_storage(mal_value_to_map_object(data));
            MalMapIter iter;
            mal_map_iter_init(&iter, storage);
            while (ok && mal_map_iter_next(&iter, &pair[0], &pair[1])) {
                console_list_push(&scratch, pair[0]);
                console_list_push(&scratch, pair[1]);
            }
        } else {
            MalSetIter iter;
            mal_set_iter_init(&iter, mal_set_object_storage(mal_value_to_set_object(data)));
            while (mal_set_iter_next(&iter, &pair[0])) console_list_push(&scratch, pair[0]);
        }
        mal_gc_unroot(&pair_root);
        usize step = map ? 2 : 1;
        row_count = scratch.count / step;
        for (usize r = 0; ok && r < row_count; r++) {
            MalValue cell;
            ok = console_cell(vm, mal_value_from_i32((i32) r), &cell);
            if (ok) console_list_push(&grid, cell);
            for (usize s = 0; ok && s < step; s++) {
                ok = console_cell(vm, scratch.items[r * step + s], &cell);
                if (ok) console_list_push(&grid, cell);
            }
        }
    } else {
        console_own_keys(vm, data, &rows);
        row_count = rows.count;
        bool primitives = false;
        console_list_push(&head, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "(index)")));
        for (usize r = 0; ok && r < row_count; r++) {
            MalValue item;
            ok = mal_vm_get_property(vm, data, console_key(rows.items[r]), &item)
                && vm->completion.kind != MAL_COMPLETION_THROW;
            if (!ok) break;
            console_list_push(&scratch, item);
            if (!mal_value_is_object(item) && mal_value_is_undefined(properties)) {
                primitives = true;
                continue;
            }
            ConsoleList keys = {0};
            if (mal_value_is_array_object(properties)) console_own_keys(vm, properties, &keys);
            else if (mal_value_is_object(item)) console_own_keys(vm, item, &keys);
            for (usize k = 0; k < keys.count; k++) {
                MalValue key = keys.items[k];
                if (mal_value_is_array_object(properties)) {
                    ok = mal_vm_get_property(vm, properties, console_key(key), &key);
                    if (!ok || !mal_value_is_string(key)) continue;
                }
                bool known = false;
                for (usize h = 1; h < head.count; h++) {
                    if (mal_string_equals(mal_value_to_string(head.items[h]), mal_value_to_string(key))) known = true;
                }
                if (!known) console_list_push(&head, key);
            }
            console_list_dispose(&keys);
        }
        usize property_columns = head.count;
        if (primitives) console_list_push(&head, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "Values")));
        for (usize r = 0; ok && r < row_count; r++) {
            console_list_push(&grid, rows.items[r]);
            MalValue item = scratch.items[r];
            for (usize h = 1; ok && h < property_columns; h++) {
                MalValue cell = mal_value_new_undefined();
                if (mal_value_is_object(item)) {
                    MalPropertyResolution found = mal_object_resolve_property(
                        mal_value_to_object(item), console_key(head.items[h]));
                    if (found.found && found.own) {
                        MalValue value;
                        ok = mal_vm_get_property(vm, item, console_key(head.items[h]), &value)
                            && console_cell(vm, value, &cell);
                    }
                }
                console_list_push(&grid, cell);
            }
            if (primitives) {
                MalValue cell = mal_value_new_undefined();
                if (!mal_value_is_object(item)) ok = ok && console_cell(vm, item, &cell);
                console_list_push(&grid, cell);
            }
        }
    }
    if (ok && vm->completion.kind != MAL_COMPLETION_THROW) {
        usize columns = head.count;
        usize *widths = calloc(columns, sizeof(usize));
        if (widths != nullptr) {
            for (usize c = 0; c < columns; c++) widths[c] = console_width(head.items[c]);
            for (usize r = 0; r < row_count; r++) {
                for (usize c = 0; c < columns; c++) {
                    usize width = console_width(grid.items[r * columns + c]);
                    if (width > widths[c]) widths[c] = width;
                }
            }
            MalTextBuffer out = {0};
            console_divider(&out, widths, columns, "┌", "┬", "┐");
            mal_text_buffer_push(&out, '\n');
            console_row(&out, head.items, widths, columns);
            mal_text_buffer_push(&out, '\n');
            console_divider(&out, widths, columns, "├", "┼", "┤");
            mal_text_buffer_push(&out, '\n');
            for (usize r = 0; r < row_count; r++) {
                console_row(&out, grid.items + r * columns, widths, columns);
                mal_text_buffer_push(&out, '\n');
            }
            console_divider(&out, widths, columns, "└", "┴", "┘");
            console_emit(vm, stdout, &out);
            free(widths);
        }
    }
    console_list_dispose(&head);
    console_list_dispose(&grid);
    console_list_dispose(&rows);
    console_list_dispose(&scratch);
    return mal_value_new_undefined();
}
#endif

CONSOLE_METHOD(console_table) {
    CONSOLE_UNUSED;
#if MAL_NODE
    if (console_node(vm) && argc > 0 && mal_value_is_object(args[0])) {
        return console_table_print(vm, args[0], argc > 1 ? args[1] : mal_value_new_undefined());
    }
#endif
    return console_print(vm, stdout, args, argc > 0 ? 1 : 0);
}

CONSOLE_METHOD(console_noop) {
    CONSOLE_UNUSED;
    (void) vm;
    (void) args;
    (void) argc;
    return mal_value_new_undefined();
}

static const struct {
    const char *name;
    MalNativeFunctionCallback callback;
    MalNativeFunctionCallback global;
} console_methods[] = {
    {"log", console_log, console_log_global},
    {"info", console_log, console_log_global},
    {"debug", console_log, console_log_global},
    {"warn", console_error, console_error_global},
    {"error", console_error, console_error_global},
    {"dir", console_dir, console_dir_global},
    {"dirxml", console_log, console_log_global},
    {"table", console_table, console_table_global},
    {"trace", console_trace, console_trace_global},
    {"group", console_group, console_group_global},
    {"groupCollapsed", console_group, console_group_global},
    {"groupEnd", console_group_end, console_group_end_global},
    {"count", console_count, console_count_global},
    {"countReset", console_count_reset, console_count_reset_global},
    {"time", console_time, console_time_global},
    {"timeEnd", console_time_end, console_time_end_global},
    {"timeLog", console_time_log, console_time_log_global},
    {"assert", console_assert, console_assert_global},
    {"clear", console_noop, console_noop_global},
    {"profile", console_noop, console_noop_global},
    {"profileEnd", console_noop, console_noop_global},
    {"timeStamp", console_noop, console_noop_global},
};

// Like Node's bound global console methods, the global ones ignore their receiver.
static void console_define_methods(MalVm *vm, MalObject *target, bool global) {
    for (usize i = 0; i < countof(console_methods); i++) {
        mal_intrinsic_define_method_n(vm, target, (const byte *) console_methods[i].name, 0,
            global ? console_methods[i].global : console_methods[i].callback);
    }
}

void mal_builtin_console_install(MalVm *vm) {
    MalObject *console = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_CONSOLE] = mal_value_from_object(console);
    console_define_methods(vm, console, true);
}

#if MAL_NODE
static bool console_writable(MalVm *vm, MalValue stream, const char *name) {
    MalValue write = mal_value_new_undefined();
    if (mal_value_is_object(stream)
        && !mal_vm_get_property(vm, stream, mal_intrinsic_string_key(vm, (const byte *) "write"), &write)) {
        return false;
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    if (mal_value_is_callable(write)) return true;
    char message[64];
    snprintf(message, sizeof message, "Console expects a writable stream instance for %s", name);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_CONSOLE_WRITABLE_STREAM");
    return false;
}

static MalValue console_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) this_value;
    static const char *const fields[] = {
        "stdout", "stderr", "ignoreErrors", "colorMode", "inspectOptions", "groupIndentation",
    };
    MalValue roots[countof(fields) + 3];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalValue first = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue write = mal_value_new_undefined();
    if (mal_value_is_object(first)
        && !mal_vm_get_property(vm, first, mal_intrinsic_string_key(vm, (const byte *) "write"), &write)) {
        goto done;
    }
    if (mal_value_is_object(first) && !mal_value_is_callable(write)) {
        for (usize i = 0; i < countof(fields); i++) {
            if (!mal_vm_get_property(vm, first, mal_intrinsic_string_key(vm, (const byte *) fields[i]), &roots[i])
                || vm->completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
        }
    } else {
        for (i32 i = 0; i < 3 && i < argc; i++) roots[i] = args[i];
    }
    if (!console_writable(vm, roots[0], "stdout")) goto done;
    if (mal_value_is_undefined(roots[1])) roots[1] = roots[0];
    else if (!console_writable(vm, roots[1], "stderr")) goto done;
    if (mal_value_is_undefined(roots[2])) roots[2] = mal_value_new_boolean(true);
    if (mal_value_is_undefined(roots[5])) roots[5] = mal_value_from_i32(2);
    if (!mal_vm_get_property(vm, mal_value_is_undefined(new_target) ? callee : new_target,
            mal_intrinsic_string_key(vm, (const byte *) "prototype"), &roots[6])
        || vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[7] = mal_value_from_object(mal_object_new(&vm->heap, mal_value_is_object(roots[6])
        ? mal_value_to_object(roots[6]) : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[8] = mal_value_from_object(mal_intrinsic_new_object(vm));
    for (usize i = 0; i < countof(fields); i++) {
        console_set(mal_value_to_object(roots[8]), mal_intrinsic_string_key(vm, (const byte *) fields[i]),
            roots[i], CONSOLE_VISIBLE);
    }
    console_set(mal_value_to_object(roots[7]), mal_key_from_value(console_state_symbol(vm)), roots[8],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    result = roots[7];
done:
    mal_gc_unroot(&root);
    return result;
}

void mal_builtin_console_install_class(MalVm *vm) {
    MalObject *console = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_CONSOLE]);
    if (mal_object_get_own(console, mal_intrinsic_string_key(vm, (const byte *) "Console")).present) return;
    MalValue roots[2];
    MalRootSpan root;
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(&vm->heap,
        function_prototype, mal_intrinsic_ascii(vm, (const byte *) "Console"), 1, console_constructor);
    roots[0] = mal_value_from_native_function_object(constructor);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_gc_root(&root, roots, 2);
    mal_native_function_object_set_constructor(constructor);
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    console_define_methods(vm, mal_value_to_object(roots[1]), false);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype", roots[1], 0);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "constructor", roots[0],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, console, (const byte *) "Console", roots[0], CONSOLE_VISIBLE);
    mal_gc_unroot(&root);
}
#endif
