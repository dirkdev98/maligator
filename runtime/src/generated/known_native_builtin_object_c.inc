#include "vm.h"
MalValue mal_known_native_mal_builtin_object_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_assign(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_assign(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_create(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_create(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_define_properties(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_define_properties(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_define_property(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_define_property(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_entries(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_entries(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_freeze(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_freeze(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_from_entries(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_from_entries(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_get_own_property_descriptor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_get_own_property_descriptor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_get_own_property_descriptors(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_get_own_property_descriptors(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_get_own_property_names(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_get_own_property_names(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_get_own_property_symbols(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_get_own_property_symbols(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_get_prototype_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_get_prototype_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_group_by(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_group_by(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_has_own(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_has_own(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_is(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_is(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_is_extensible(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_is_extensible(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_is_frozen(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_is_frozen(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_is_sealed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_is_sealed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_keys(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_keys(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prevent_extensions(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prevent_extensions(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_define_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_define_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_define_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_define_setter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_lookup_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_lookup_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_lookup_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_lookup_setter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_proto_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_proto_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_proto_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_proto_setter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_has_own_property(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_has_own_property(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_is_prototype_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_is_prototype_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_property_is_enumerable(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_property_is_enumerable(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_to_locale_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_to_locale_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_prototype_value_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_prototype_value_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_seal(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_seal(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_set_prototype_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_set_prototype_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_object_values(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_object_values(vm, receiver, args, count, target, callee);
}
