#include "vm.h"
MalValue mal_known_native_mal_builtin_decode_uri(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_decode_uri(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_decode_uri_component(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_decode_uri_component(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_encode_uri(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_encode_uri(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_encode_uri_component(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_encode_uri_component(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_escape(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_escape(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_unescape(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_unescape(vm, receiver, args, count, target, callee);
}
