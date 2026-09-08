#include "vm.h"
MalValue mal_known_native_mal_intrinsic_cjs_require_callback(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_intrinsic_cjs_require_callback(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_intrinsic_species_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_intrinsic_species_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_intrinsic_function_prototype_callback(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_intrinsic_function_prototype_callback(vm, receiver, args, count, target, callee);
}
