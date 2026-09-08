#include "vm.h"
MalValue mal_known_native_mal_builtin_bigint_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_bigint_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_bigint_as_int_n(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_bigint_as_int_n(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_bigint_as_uint_n(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_bigint_as_uint_n(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_bigint_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_bigint_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_bigint_prototype_value_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_bigint_prototype_value_of(vm, receiver, args, count, target, callee);
}
