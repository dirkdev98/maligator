#include "vm.h"
MalValue mal_known_native_mal_builtin_proxy_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_proxy_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_proxy_revocable(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_proxy_revocable(vm, receiver, args, count, target, callee);
}
