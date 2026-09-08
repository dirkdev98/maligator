#include "vm.h"
MalValue mal_known_native_mal_async_function_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_async_function_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_agen_function_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_agen_function_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_agen_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_agen_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_agen_return(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_agen_return(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_agen_throw(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_agen_throw(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_async_iterator_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_async_iterator_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_async_iterator_prototype_async_dispose(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_async_iterator_prototype_async_dispose(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_agen_async_iterator(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_agen_async_iterator(vm, receiver, args, count, target, callee);
}
