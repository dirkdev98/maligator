#include "vm.h"
MalValue mal_known_native_mal_builtin_aggregate_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_aggregate_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_capture_stack_trace(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_capture_stack_trace(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_is_error(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_is_error(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_prepare_stack_trace_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_NODE && MAL_PRIMORDIALS_LOCKED)
    return mal_builtin_error_prepare_stack_trace_getter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_error_prepare_stack_trace_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_NODE && MAL_PRIMORDIALS_LOCKED)
    return mal_builtin_error_prepare_stack_trace_setter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_error_stack_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_stack_getter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_stack_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_stack_setter(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_prototype_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_error_prototype_to_string(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_error_stack_trace_limit_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_NODE && MAL_PRIMORDIALS_LOCKED)
    return mal_builtin_error_stack_trace_limit_getter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_error_stack_trace_limit_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_NODE && MAL_PRIMORDIALS_LOCKED)
    return mal_builtin_error_stack_trace_limit_setter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_eval_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_eval_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_range_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_range_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_reference_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_reference_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_suppressed_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_suppressed_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_syntax_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_syntax_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_type_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_type_error_constructor(vm, receiver, args, count, target, callee);
}
MalValue mal_known_native_mal_builtin_uri_error_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
    return mal_builtin_uri_error_constructor(vm, receiver, args, count, target, callee);
}
