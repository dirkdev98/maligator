#include "vm.h"
MalValue mal_known_native_mal_builtin_json_is_raw_json(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_json_is_raw_json(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_json_parse(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_json_parse(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_json_raw_json(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_json_raw_json(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_json_stringify(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_json_stringify(vm, receiver, args, count, target, callee);
}
