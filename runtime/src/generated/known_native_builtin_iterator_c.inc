#include "vm.h"
MalValue mal_known_native_mal_builtin_array_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_iterator_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_iterator_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_set_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_set_iterator_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_string_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_string_iterator_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_iterator_prototype_dispose(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_iterator_prototype_dispose(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_iterator_prototype_iterator(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_iterator_prototype_iterator(vm, receiver, args, count, target, callee);
}
