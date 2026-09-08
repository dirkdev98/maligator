#include "vm.h"
MalValue mal_known_native_mal_ih_proto_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_proto_next(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_proto_return(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_proto_return(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_concat(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_concat(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_from(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_from(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_chunks(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_chunks(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_ctor_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_ctor_get(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_ctor_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_ctor_set(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_drop(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_drop(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_every(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_every(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_filter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_filter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_find(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_find(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_flatmap(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_flatmap(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_for_each(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_for_each(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_includes(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_includes(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_join(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_join(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_map(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_map(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_reduce(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_reduce(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_some(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_some(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_take(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_take(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_to_array(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_to_array(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_ih_method_windows(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_ih_method_windows(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_tag_get(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_tag_get(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_tag_set(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_tag_set(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_zip(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_zip(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_iterator_zip_keyed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_iterator_zip_keyed(vm, receiver, args, count, target, callee);
}
