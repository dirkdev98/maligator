#include "vm.h"
MalValue mal_known_native_mal_builtin_fin_reg_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_fin_reg_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_fin_reg_register(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_fin_reg_register(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_fin_reg_unregister(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_fin_reg_unregister(vm, receiver, args, count, target, callee);
}
