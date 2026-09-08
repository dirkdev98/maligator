#include "vm.h"
MalValue mal_known_native_mal_builtin_map_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_group_by(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_group_by(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_clear(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_clear(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_delete(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_delete(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_entries(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_entries(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_for_each(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_for_each(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_get(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_get_or_insert(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_get_or_insert(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_get_or_insert_computed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_get_or_insert_computed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_has(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_has(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_keys(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_keys(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_set(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_size_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_size_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_map_prototype_values(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_map_prototype_values(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_delete(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_delete(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_get(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_get_or_insert(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_get_or_insert(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_get_or_insert_computed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_get_or_insert_computed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_has(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_has(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_weak_map_prototype_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_weak_map_prototype_set(vm, receiver, args, count, target, callee);
}
