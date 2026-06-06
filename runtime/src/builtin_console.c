#include "builtin_console.h"

#include <stdio.h>

#include "heap_string.h"
#include "property_iter.h"
#include "value_ops.h"
#include "vm.h"

static void mal_builtin_console_print_string(FILE *stream, const MalString *string) {
    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        c16 code_unit = code_units[i];
        if (code_unit <= 0x7F) {
            fputc((char) code_unit, stream);
        } else {
            // TODO(console): encode non-ASCII output as UTF-8.
            fprintf(stream, "\\u%04x", code_unit);
        }
    }
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

static MalValue mal_builtin_console_log(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_console_write(vm, stdout, args, arg_count);
}

static MalValue mal_builtin_console_error(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_console_write(vm, stderr, args, arg_count);
}

void mal_builtin_console_install(MalVm *vm) {
    MalObject *console = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_CONSOLE] = mal_value_from_object(console);

    mal_intrinsic_define_method(vm, console, "log", mal_builtin_console_log);
    mal_intrinsic_define_method(vm, console, "info", mal_builtin_console_log);
    mal_intrinsic_define_method(vm, console, "warn", mal_builtin_console_error);
    mal_intrinsic_define_method(vm, console, "error", mal_builtin_console_error);
}
