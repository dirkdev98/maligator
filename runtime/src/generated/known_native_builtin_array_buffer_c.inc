#include "vm.h"
MalValue mal_known_native_mal_builtin_array_buffer_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_is_view(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_is_view(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_byte_length_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_byte_length_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_detached_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_detached_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_immutable_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_immutable_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_max_byte_length_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_max_byte_length_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_resizable_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_resizable_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_resize(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_resize(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_slice(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_slice(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_slice_to_immutable(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_slice_to_immutable(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_transfer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_transfer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_transfer_to_fixed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_transfer_to_fixed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_array_buffer_transfer_to_immutable(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_array_buffer_transfer_to_immutable(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_shared_array_buffer_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_shared_array_buffer_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_shared_array_buffer_byte_length_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_shared_array_buffer_byte_length_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_shared_array_buffer_grow(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_shared_array_buffer_grow(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_shared_array_buffer_growable_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_shared_array_buffer_growable_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_shared_array_buffer_max_byte_length_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_shared_array_buffer_max_byte_length_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_shared_array_buffer_slice(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_shared_array_buffer_slice(vm, receiver, args, count, target, callee);
}
