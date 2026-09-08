#include "vm.h"
MalValue mal_known_native_mal_builtin_function_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_function_prototype_apply(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_prototype_apply(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_throw_type_error(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_throw_type_error(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_function_prototype_bind(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_prototype_bind(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_function_prototype_call(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_prototype_call(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_function_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_function_prototype_has_instance(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_function_prototype_has_instance(vm, receiver, args, count, target, callee);
}
