#include "vm.h"
MalValue mal_known_native_mal_builtin_number_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_is_finite(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_is_finite(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_is_integer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_is_integer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_is_nan(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_is_nan(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_is_safe_integer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_is_safe_integer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_to_exponential(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_to_exponential(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_to_fixed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_to_fixed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_to_locale_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_to_locale_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_to_precision(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_to_precision(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_number_prototype_value_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_number_prototype_value_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_global_is_finite(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_global_is_finite(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_global_is_nan(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_global_is_nan(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_parse_float(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_parse_float(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_parse_int(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_parse_int(vm, receiver, args, count, target, callee);
}
