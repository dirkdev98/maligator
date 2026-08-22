from pathlib import Path


def once(text: str, old: str, new: str) -> str:
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new, 1)


number_path = Path("runtime/src/builtin_number.c")
number = number_path.read_text()
number = once(
    number,
    '#include "ecma_whitespace.h"\n',
    '#include "ecma_whitespace.h"\n#include "function_object.h"\n',
)
start = number.index("static MalValue mal_builtin_number_prototype_to_locale_string(")
end = number.index("static MalValue mal_builtin_number_prototype_to_fixed(", start)
number = (
    number[:start]
    + '''static MalValue mal_builtin_number_prototype_to_locale_string(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
#if MAL_INTL_HAS_NUMBER_FORMAT
    if (mal_value_is_undefined(locales) && mal_value_is_undefined(options) &&
        mal_value_is_native_function_object(callee)) {
        return mal_intl_number_to_locale_string_cached(
            vm, number, mal_value_to_native_function_object(callee));
    }
#else
    (void) callee;
#endif
    return mal_intl_number_to_locale_string(vm, number, locales, options);
}

'''
    + number[end:]
)
number = once(
    number,
    '    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_number_prototype_to_locale_string);\n',
    '''#if MAL_INTL_HAS_NUMBER_FORMAT
    MalValue locale_slots[1] = {mal_value_new_undefined()};
    MalNativeFunctionObject *to_locale_string =
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "toLocaleString"),
            0,
            mal_builtin_number_prototype_to_locale_string,
            locale_slots,
            1
        );
    mal_intrinsic_define_data(
        vm,
        prototype,
        "toLocaleString",
        mal_value_from_native_function_object(to_locale_string),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE
    );
#else
    mal_intrinsic_define_method_n(
        vm,
        prototype,
        "toLocaleString",
        0,
        mal_builtin_number_prototype_to_locale_string
    );
#endif
''',
)
number_path.write_text(number)

header_path = Path("runtime/src/builtin_intl.h")
header = header_path.read_text()
header = once(
    header,
    "MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options);\n",
    '''MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options);

#if MAL_INTL_HAS_NUMBER_FORMAT
/** Reuse the hidden default NumberFormat owned by a Number method object. */
MalValue mal_intl_number_to_locale_string_cached(
    MalVm *vm,
    f64 number,
    MalNativeFunctionObject *cache_owner
);
#endif
''',
)
header_path.write_text(header)

intl_path = Path("runtime/src/builtin_intl.c")
intl = intl_path.read_text()
marker = "#if MAL_INTL_HAS_NUMBER_FORMAT\nstatic void intl_install_number_format"
replacement = '''#if MAL_INTL_HAS_NUMBER_FORMAT
MalValue mal_intl_number_to_locale_string_cached(
    MalVm *vm,
    f64 number,
    MalNativeFunctionObject *cache_owner
) {
    MalValue formatter = mal_native_function_object_get_slot(cache_owner, 0);
    if (!mal_value_is_intl_object(formatter) ||
        mal_value_to_intl_object(formatter)->kind != MAL_INTL_NUMBER_FORMAT) {
        MalValue constructor_args[2] = {
            mal_value_new_undefined(),
            mal_value_new_undefined(),
        };
        formatter = intl_number_format_constructor(
            vm,
            mal_value_new_undefined(),
            constructor_args,
            2,
            mal_value_new_undefined(),
            mal_value_new_undefined()
        );
        if (!mal_value_is_intl_object(formatter)) {
            return mal_value_new_undefined();
        }
        mal_native_function_object_set_slot(cache_owner, 0, formatter);
    }
    return intl_number_format_value(
        vm, mal_value_to_intl_object(formatter), number);
}

static void intl_install_number_format'''
intl = once(intl, marker, replacement)
intl_path.write_text(intl)
