#include "vm.h"
MalValue mal_known_native_mal_builtin_weak_ref_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_ref_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_ref_prototype_deref(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_ref_prototype_deref(vm, receiver, args, count, target, callee);
}
