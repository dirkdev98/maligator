#include "vm.h"
MalValue mal_known_native_mal_builtin_symbol_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_symbol_for(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_for(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_symbol_key_for(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_key_for(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_symbol_prototype_description_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_prototype_description_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_symbol_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_symbol_prototype_value_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_symbol_prototype_value_of(vm, receiver, args, count, target, callee);
}
