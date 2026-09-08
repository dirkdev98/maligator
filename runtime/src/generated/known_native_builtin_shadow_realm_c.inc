#include "vm.h"
MalValue mal_known_native_mal_builtin_shadow_realm_constructor(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REALMS)
    return mal_builtin_shadow_realm_constructor(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_shadow_realm_evaluate(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REALMS)
    return mal_builtin_shadow_realm_evaluate(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
MalValue mal_known_native_mal_builtin_shadow_realm_import_value(MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalValue target, MalValue callee) {
#if (MAL_REALMS)
    return mal_builtin_shadow_realm_import_value(vm, receiver, args, count, target, callee);
#else
    (void) receiver; (void) args; (void) count; (void) target; (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Known native operation is unavailable");
    return mal_value_new_undefined();
#endif
}
