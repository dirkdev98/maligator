#include "vm.h"
MalValue mal_known_native_mal_builtin_configure_deferred_namespace(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_configure_deferred_namespace(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_direct_eval(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_direct_eval(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_dynamic_import(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_dynamic_import(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_evaluate_module_sync(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_evaluate_module_sync(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_eval(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_eval(vm, receiver, args, count, target, callee);
}
