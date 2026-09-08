#include "vm.h"
MalValue mal_known_native_mal_promise_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_all(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_all(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_all_keyed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_all_keyed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_all_settled(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_all_settled(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_all_settled_keyed(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_all_settled_keyed(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_any(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_any(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_prototype_catch(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_prototype_catch(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_prototype_finally(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_prototype_finally(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_prototype_then(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_prototype_then(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_race(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_race(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_reject_static(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_reject_static(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_resolve_static(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_resolve_static(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_try(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_try(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_promise_with_resolvers(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_promise_with_resolvers(vm, receiver, args, count, target, callee);
}
