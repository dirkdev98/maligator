#include "vm.h"
MalValue mal_known_native_mal_builtin_generator_function_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_generator_function_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_generator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_generator_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_generator_return(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_generator_return(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_generator_throw(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_generator_throw(vm, receiver, args, count, target, callee);
}
