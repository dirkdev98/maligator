#include "vm.h"
MalValue mal_known_native_regexp_string_iterator_next(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_string_iterator_next(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_legacy_getter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_legacy_getter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_legacy_input_setter(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_legacy_input_setter(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_escape(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_escape(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_dot_all(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_dot_all(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_exec(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_exec(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_flags(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_flags(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_global(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_global(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_has_indices(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_has_indices(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_ignore_case(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_ignore_case(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_multiline(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_multiline(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_source(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_source(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_sticky(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_sticky(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_test(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_test(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_to_string(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_to_string(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_unicode(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_unicode(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_get_unicode_sets(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_get_unicode_sets(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_match(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_match(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_match_all(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_match_all(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_replace(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_replace(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_search(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_search(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_regexp_proto_split(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REGEXP)
    return regexp_proto_split(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
