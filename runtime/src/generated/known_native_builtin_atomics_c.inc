#include "vm.h"
MalValue mal_known_native_mal_atomics_add(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_add(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_and(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_and(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_compare_exchange(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_compare_exchange(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_exchange(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_exchange(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_is_lock_free(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_is_lock_free(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_load(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_load(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_notify(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_notify(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_or(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_or(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_pause(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_pause(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_store(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_store(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_sub(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_sub(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_wait(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_wait(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_wait_async(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_wait_async(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_atomics_xor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_atomics_xor(vm, receiver, args, count, target, callee);
}
