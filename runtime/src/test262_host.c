#include "test262_host.h"

#include "array_buffer_object.h"
#include "builtin_eval.h"
#include "gc.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "value.h"
#include "vm.h"

#if MAL_REALMS

static MalValue mal_test262_create_realm(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
);

static MalValue mal_test262_eval_script(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;

    MalValue source = arg_count > 0 ? args[0] : mal_value_new_undefined();
    MalRealm *realm = mal_vm_callee_realm(vm, callee);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &source, 1);
    mal_gc_native_rooted_begin(vm);
    MalCompletion completion = mal_realm_eval_script(vm, realm, source);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return completion.value;
}

static MalValue mal_test262_gc(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    mal_gc_collect(vm);
    return mal_value_new_undefined();
}

static MalValue mal_test262_detach_array_buffer(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    if (arg_count < 1 || !mal_value_is_array_buffer_object(args[0])) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "$262.detachArrayBuffer requires an ArrayBuffer");
        return mal_value_new_undefined();
    }

    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(args[0]);
    if (buffer->shared) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "$262.detachArrayBuffer cannot detach a SharedArrayBuffer");
        return mal_value_new_undefined();
    }

    mal_array_buffer_object_detach(buffer);
    return mal_value_new_null();
}

void mal_test262_install(MalVm *vm) {
    MalObject *global = mal_value_to_object(mal_realm_global(vm->current_realm));
    MalObject *host = mal_intrinsic_new_object(vm);
    MalValue host_value = mal_value_from_object(host);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;

    // Publish first so the partially initialized host remains a realm root.
    mal_intrinsic_define_data(vm, global, "$262", host_value, flags);
    mal_intrinsic_define_data(vm, host, "global", mal_realm_global(vm->current_realm), flags);
    mal_intrinsic_define_method_n(vm, host, "createRealm", 0, mal_test262_create_realm);
    mal_intrinsic_define_method_n(vm, host, "evalScript", 1, mal_test262_eval_script);
    mal_intrinsic_define_method_n(vm, host, "gc", 0, mal_test262_gc);
    mal_intrinsic_define_method_n(
        vm,
        host,
        "detachArrayBuffer",
        1,
        mal_test262_detach_array_buffer);
}

static void mal_test262_install_realm(MalVm *vm, void *data) {
    (void) data;
    mal_test262_install(vm);
}

static MalValue mal_test262_create_realm(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    MalRealm *realm = mal_realm_create(vm, mal_test262_install_realm, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalPropertyLookup host = mal_object_get_own(
        mal_value_to_object(mal_realm_global(realm)),
        mal_intrinsic_string_key(vm, "$262"));
    return host.present ? host.desc.value : mal_value_new_undefined();
}

#else

void mal_test262_install(MalVm *vm) {
    (void) vm;
}

#endif
