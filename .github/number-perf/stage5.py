from pathlib import Path

def once(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new, 1)

number_path = Path("runtime/src/builtin_number.c")
s = number_path.read_text()
s = once(s, '#include "ecma_whitespace.h"\n', '#include "ecma_whitespace.h"\n#include "function_object.h"\n')
a = s.index('static MalValue mal_builtin_number_prototype_to_locale_string(')
b = s.index('static MalValue mal_builtin_number_prototype_to_fixed(', a)
s = s[:a] + 'static MalValue mal_builtin_number_prototype_to_locale_string(\n    MalVm *vm,\n    MalValue this_value,\n    const MalValue *args,\n    i32 arg_count,\n    MalValue new_target,\n    MalValue callee\n) {\n    (void) new_target;\n    f64 number;\n    if (!mal_builtin_number_this(vm, this_value, &number)) {\n        return mal_value_new_undefined();\n    }\n    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();\n    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();\n#if MAL_INTL_HAS_NUMBER_FORMAT\n    if (mal_value_is_undefined(locales) && mal_value_is_undefined(options) &&\n        mal_value_is_native_function_object(callee)) {\n        return mal_intl_number_to_locale_string_cached(\n            vm, number, mal_value_to_native_function_object(callee));\n    }\n#else\n    (void) callee;\n#endif\n    return mal_intl_number_to_locale_string(vm, number, locales, options);\n}\n\n' + s[b:]
s = once(s, '    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_number_prototype_to_locale_string);\n', '    MalValue locale_slots[1] = {mal_value_new_undefined()};\n    MalNativeFunctionObject *to_locale_string =\n        mal_native_function_object_new_with_slots_arity(\n            &vm->heap,\n            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),\n            mal_intrinsic_ascii(vm, "toLocaleString"),\n            0,\n            mal_builtin_number_prototype_to_locale_string,\n            locale_slots,\n            1\n        );\n    mal_intrinsic_define_data(\n        vm,\n        prototype,\n        "toLocaleString",\n        mal_value_from_native_function_object(to_locale_string),\n        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE\n    );\n')
number_path.write_text(s)

header_path = Path("runtime/src/builtin_intl.h")
h = header_path.read_text()
h = once(h, 'MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options);\n', 'MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options);\n\n#if MAL_INTL_HAS_NUMBER_FORMAT\n/** Reuse the hidden default NumberFormat owned by a Number method object. */\nMalValue mal_intl_number_to_locale_string_cached(\n    MalVm *vm,\n    f64 number,\n    MalNativeFunctionObject *cache_owner\n);\n#endif\n')
header_path.write_text(h)

intl_path = Path("runtime/src/builtin_intl.c")
i = intl_path.read_text()
marker = '#if MAL_INTL_HAS_NUMBER_FORMAT\nstatic void intl_install_number_format'
replacement = '#if MAL_INTL_HAS_NUMBER_FORMAT\n' + 'MalValue mal_intl_number_to_locale_string_cached(\n    MalVm *vm,\n    f64 number,\n    MalNativeFunctionObject *cache_owner\n) {\n    MalValue formatter = mal_native_function_object_get_slot(cache_owner, 0);\n    if (!mal_value_is_intl_object(formatter) ||\n        mal_value_to_intl_object(formatter)->kind != MAL_INTL_NUMBER_FORMAT) {\n        MalValue ctor_args[2] = {\n            mal_value_new_undefined(),\n            mal_value_new_undefined(),\n        };\n        formatter = intl_number_format_constructor(\n            vm,\n            mal_value_new_undefined(),\n            ctor_args,\n            2,\n            mal_value_new_undefined(),\n            mal_value_new_undefined()\n        );\n        if (!mal_value_is_intl_object(formatter)) {\n            return mal_value_new_undefined();\n        }\n        mal_native_function_object_set_slot(cache_owner, 0, formatter);\n    }\n    return intl_number_format_value(\n        vm, mal_value_to_intl_object(formatter), number);\n}\n\n' + 'static void intl_install_number_format'
i = once(i, marker, replacement)
intl_path.write_text(i)
