#include "vm.h"
MalValue mal_known_native_mal_builtin_data_view_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_data_view_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_buffer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_buffer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_byte_length(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_byte_length(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_byte_offset(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_byte_offset(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_bigint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_bigint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_biguint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_biguint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_float16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_float16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_float32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_float32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_float64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_float64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_int16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_int16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_int32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_int32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_int8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_int8(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_uint16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_uint16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_uint32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_uint32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_get_uint8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_get_uint8(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_bigint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_bigint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_biguint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_biguint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_float16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_float16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_float32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_float32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_float64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_float64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_int16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_int16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_int32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_int32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_int8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_int8(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_uint16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_uint16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_uint32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_uint32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_dv_set_uint8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_dv_set_uint8(vm, receiver, args, count, target, callee);
}
