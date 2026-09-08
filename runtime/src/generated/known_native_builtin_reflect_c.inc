#include "vm.h"
MalValue mal_known_native_mal_reflect_apply(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_apply(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_construct(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_construct(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_define_property(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_define_property(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_delete_property(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_delete_property(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_get(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_get_own_property_descriptor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_get_own_property_descriptor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_get_prototype_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_get_prototype_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_has(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_has(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_is_extensible(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_is_extensible(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_own_keys(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_own_keys(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_prevent_extensions(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_prevent_extensions(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_set(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_reflect_set_prototype_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_reflect_set_prototype_of(vm, receiver, args, count, target, callee);
}
