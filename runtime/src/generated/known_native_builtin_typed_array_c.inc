#include "vm.h"
MalValue mal_known_native_mal_ta_ctor_bigint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_bigint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_biguint64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_biguint64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_float32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_float32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_float64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_float64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_int16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_int16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_int32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_int32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_int8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_int8(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_typed_array_abstract_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_typed_array_abstract_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_from(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_from(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_at(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_at(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_get_buffer(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_get_buffer(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_get_byte_length(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_get_byte_length(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_get_byte_offset(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_get_byte_offset(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_copy_within(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_copy_within(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_entries(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_entries(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_every(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_every(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_fill(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_fill(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_filter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_filter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_find(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_find(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_find_index(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_find_index(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_find_last(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_find_last(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_find_last_index(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_find_last_index(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_for_each(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_for_each(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_includes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_includes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_index_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_index_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_join(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_join(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_keys(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_keys(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_last_index_of(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_last_index_of(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_get_length(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_get_length(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_map(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_map(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_reduce(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_reduce(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_reduce_right(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_reduce_right(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_reverse(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_reverse(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_set(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_slice(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_slice(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_some(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_some(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_typed_array_sort(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_typed_array_sort(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_subarray(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_subarray(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_to_locale_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_to_locale_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_to_reversed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_to_reversed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_typed_array_to_sorted(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_typed_array_to_sorted(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_values(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_values(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_with(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_with(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_get_to_string_tag(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_get_to_string_tag(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_uint16(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_uint16(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_uint32(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_uint32(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_uint8(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_uint8(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_from_base64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_from_base64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_from_hex(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_from_hex(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_set_from_base64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_set_from_base64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_set_from_hex(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_set_from_hex(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_to_base64(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_to_base64(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_to_hex(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_to_hex(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ta_ctor_uint8_clamped(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ta_ctor_uint8_clamped(vm, receiver, args, count, target, callee);
}
