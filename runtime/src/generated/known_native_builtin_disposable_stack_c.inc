#include "vm.h"
MalValue mal_known_native_mal_builtin_add_disposable_resource(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_add_disposable_resource(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_dispose_resources(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_dispose_resources(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_new_dispose_capability(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_new_dispose_capability(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_adopt(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_adopt(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_defer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_defer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_dispose_async(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_dispose_async(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_disposed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_disposed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_move(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_move(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_async_disposable_stack_use(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_async_disposable_stack_use(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_adopt(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_adopt(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_defer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_defer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_dispose(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_dispose(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_disposed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_disposed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_move(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_move(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_disposable_stack_use(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_disposable_stack_use(vm, receiver, args, count, target, callee);
}
