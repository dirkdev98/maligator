#include "builtin_console.h"

#include <stdio.h>
#include <stdlib.h>

#include "heap_string.h"
#include "property_iter.h"
#include "web_text_encoding.h"
#include "value_ops.h"
#include "vm.h"

static void mal_builtin_console_print_string(FILE *stream, const MalString *string) {
    usize byte_len;
    byte *bytes = mal_utf8_encode(mal_string_code_units(string), mal_string_length(string), &byte_len);
    if (bytes == nullptr) {
        return;
    }
    fwrite(bytes, 1, byte_len, stream);
    free(bytes);
}

static void mal_builtin_console_print_value(MalVm *vm, FILE *stream, MalValue value, bool quote_strings);

static void mal_builtin_console_print_object(MalVm *vm, FILE *stream, MalValue value) {
    if (mal_value_is_array_object(value)) {
        MalArrayObject *array = mal_value_to_array_object(value);
        u32 length = mal_array_object_length(array);
        fputs("[ ", stream);
        for (u32 index = 0; index < length; index++) {
            if (index > 0) {
                fputs(", ", stream);
            }
            MalPropertyResolution resolution = mal_object_resolve_property(
                (MalObject *) array,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}
            );
            mal_builtin_console_print_value(vm, stream, resolution.found ? resolution.desc.value : mal_value_new_undefined(), true);
        }
        fputs(" ]", stream);
        return;
    }

    if (mal_value_is_callable(value)) {
        MalString *name = mal_vm_callable_name(vm, value);
        fputs("[Function: ", stream);
        if (name != nullptr && mal_string_length(name) > 0) {
            mal_builtin_console_print_string(stream, name);
        } else {
            fputs("anonymous", stream);
        }
        fputc(']', stream);
        return;
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    fputs("{ ", stream);
    MalKey key;
    MalPropertyDesc desc;
    bool first = true;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }
        if (!first) {
            fputs(", ", stream);
        }
        first = false;
        mal_builtin_console_print_string(stream, mal_ops_to_string(&vm->heap, key.value));
        fputs(": ", stream);
        mal_builtin_console_print_value(vm, stream, desc.value, true);
    }
    fputs(first ? "}" : " }", stream);
}

static void mal_builtin_console_print_value(MalVm *vm, FILE *stream, MalValue value, bool quote_strings) {
    if (mal_value_is_string(value)) {
        if (quote_strings) {
            fputc('"', stream);
        }
        mal_builtin_console_print_string(stream, mal_value_to_string(value));
        if (quote_strings) {
            fputc('"', stream);
        }
        return;
    }

    if (mal_value_is_object(value)) {
        mal_builtin_console_print_object(vm, stream, value);
        return;
    }

    mal_builtin_console_print_string(stream, mal_ops_to_string(&vm->heap, value));
}

static MalValue mal_builtin_console_write(MalVm *vm, FILE *stream, const MalValue *args, i32 arg_count) {
    for (i32 i = 0; i < arg_count; i++) {
        if (i > 0) {
            fputc(' ', stream);
        }
        mal_builtin_console_print_value(vm, stream, args[i], false);
    }
    fputc('\n', stream);
    return mal_value_new_undefined();
}

static MalValue mal_builtin_console_log(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_console_write(vm, stdout, args, arg_count);
}

static MalValue mal_builtin_console_error(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_console_write(vm, stderr, args, arg_count);
}

// console.trace(...data): a "Trace" label with the formatted data, followed by
// the current call stack (Console Standard "Printer" with a stack appended).
// Written to stderr.
static MalValue mal_builtin_console_trace(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    fputs("Trace", stderr);
    if (arg_count > 0) {
        fputs(": ", stderr);
        for (i32 i = 0; i < arg_count; i++) {
            if (i > 0) {
                fputc(' ', stderr);
            }
            mal_builtin_console_print_value(vm, stderr, args[i], false);
        }
    }

    MalStackTrace *trace = mal_vm_capture_stack(vm);
    MalString *frames = mal_vm_format_stack_frames(vm, trace);
    mal_builtin_console_print_string(stderr, frames);
    mal_vm_free_stack_trace(trace);

    fputc('\n', stderr);
    return mal_value_new_undefined();
}

void mal_builtin_console_install(MalVm *vm) {
    MalObject *console = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_CONSOLE] = mal_value_from_object(console);

    mal_intrinsic_define_method_n(vm, console, "log", 0, mal_builtin_console_log);
    mal_intrinsic_define_method_n(vm, console, "info", 0, mal_builtin_console_log);
    mal_intrinsic_define_method_n(vm, console, "warn", 0, mal_builtin_console_error);
    mal_intrinsic_define_method_n(vm, console, "error", 0, mal_builtin_console_error);
    mal_intrinsic_define_method_n(vm, console, "trace", 0, mal_builtin_console_trace);
}
