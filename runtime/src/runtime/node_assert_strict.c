#include "node_assert_strict.h"

#if MAL_NODE

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value_ops.h"
#include "vm_ops.h"

#define NODE_ASSERT_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

static MalValue assert_fail(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
    return mal_value_new_undefined();
}

static MalValue assert_ok(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc >= 1 && mal_value_is_truthy(args[0])) {
        return mal_value_new_undefined();
    }
    MalValue message = argc >= 2 && mal_value_is_string(args[1])
        ? args[1]
        : mal_value_from_string(mal_intrinsic_ascii(
            vm, "The expression evaluated to a falsy value"));
    MalRootSpan root;
    mal_gc_root(&root, &message, 1);
    mal_vm_throw_error_value(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue assert_equal(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc >= 2 && mal_ops_same_value(args[0], args[1])) {
        return mal_value_new_undefined();
    }
    return assert_fail(vm, (const byte *) "Expected values to be strictly equal");
}

static bool assert_json_equal(MalVm *vm, MalValue left, MalValue right) {
    MalValue roots[4] = {
        vm->intrinsics[MAL_INTRINSIC_JSON], left, right,
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);
    MalValue stringify;
    bool available = mal_vm_get_property(
        vm, roots[0], mal_intrinsic_string_key(vm, (const byte *) "stringify"),
        &stringify);
    if (!available || !mal_value_is_callable(stringify)) {
        mal_gc_unroot(&root);
        return false;
    }
    MalCompletion first = mal_vm_call_value(vm, stringify, roots[0], &roots[1], 1);
    if (first.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return false;
    }
    roots[3] = first.value;
    MalCompletion second = mal_vm_call_value(vm, stringify, roots[0], &roots[2], 1);
    bool equal = second.kind != MAL_COMPLETION_THROW
        && mal_value_is_string(roots[3]) && mal_value_is_string(second.value)
        && mal_string_equals(
            mal_value_to_string(roots[3]), mal_value_to_string(second.value));
    mal_gc_unroot(&root);
    return equal;
}

static MalValue assert_deep_equal(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc >= 2 && assert_json_equal(vm, args[0], args[1])) {
        return mal_value_new_undefined();
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return assert_fail(vm, (const byte *) "Expected values to be deeply equal");
}

static MalValue assert_match(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    if (argc < 2) {
        return assert_fail(vm, (const byte *) "Expected string to match regular expression");
    }
    MalValue roots[3] = {args[0], args[1], mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    bool found = mal_vm_get_property(
        vm, roots[1], mal_intrinsic_string_key(vm, (const byte *) "test"),
        &roots[2]);
    if (!found || !mal_value_is_callable(roots[2])) {
        mal_gc_unroot(&root);
        return assert_fail(vm, (const byte *) "The second argument must be a RegExp");
    }
    MalCompletion tested = mal_vm_call_value(vm, roots[2], roots[1], roots, 1);
    bool matched = tested.kind != MAL_COMPLETION_THROW
        && mal_value_is_truthy(tested.value);
    mal_gc_unroot(&root);
    if (tested.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    if (!matched) {
        return assert_fail(vm, (const byte *) "Expected string to match regular expression");
    }
    return mal_value_new_undefined();
}

static MalValue assertion_error_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    MalValue roots[] = {
        argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_from_string(mal_intrinsic_ascii(vm, "Assertion failed")),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (mal_value_is_object(roots[0])) {
        mal_vm_get_property(
            vm, roots[0], mal_intrinsic_string_key(vm, "message"), &roots[1]);
    }
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalCompletion completion = mal_vm_construct_value_with_target(
        vm, vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], roots + 1, 1, target);
    roots[2] = completion.value;
    if (completion.kind != MAL_COMPLETION_THROW && mal_value_is_object(roots[2])) {
        MalObject *error = mal_value_to_object(roots[2]);
        mal_object_set(error, mal_intrinsic_string_key(vm, "name"),
            mal_value_from_string(mal_intrinsic_ascii(vm, "AssertionError")));
        mal_object_set(error, mal_intrinsic_string_key(vm, "code"),
            mal_value_from_string(mal_intrinsic_ascii(vm, "ERR_ASSERTION")));
        static const char *option_names[] = {"actual", "expected", "operator"};
        for (usize i = 0; i < countof(option_names); i++) {
            MalValue value = mal_value_new_undefined();
            if (mal_value_is_object(roots[0])
                && mal_vm_get_property(
                    vm, roots[0],
                    mal_intrinsic_string_key(vm, (const byte *) option_names[i]),
                    &value)) {
                mal_object_set(error,
                    mal_intrinsic_string_key(
                        vm, (const byte *) option_names[i]), value);
            }
        }
    }
    MalValue result = roots[2];
    mal_gc_unroot(&root);
    return result;
}

void mal_host_install_node_assert(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[] = {
            mal_value_from_native_function_object(
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, "ok"), 0, assert_ok)),
            mal_value_from_object(mal_object_new(
                &vm->heap, mal_value_to_object(
                    vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]))),
            mal_value_new_undefined(),
        };
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        module = roots[0];
        MalNativeFunctionObject *assertion_error =
            mal_native_function_object_new_arity(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, "AssertionError"), 1,
                assertion_error_constructor);
        mal_native_function_object_set_constructor(assertion_error);
        roots[2] = mal_value_from_native_function_object(assertion_error);
        mal_intrinsic_define_data(
            vm, (MalObject *) assertion_error, "prototype", roots[1],
            MAL_PROPERTY_NONE);
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[1]), "constructor", roots[2],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        MalObject *object = mal_value_to_object(roots[0]);
        mal_intrinsic_define_data(
            vm, object, "ok", roots[0], NODE_ASSERT_VISIBLE);
        mal_intrinsic_define_data(
            vm, object, "AssertionError", roots[2], NODE_ASSERT_VISIBLE);
        mal_intrinsic_define_method_n(
            vm, object, "equal", 2, assert_equal);
        mal_intrinsic_define_method_n(
            vm, object, "strictEqual", 2, assert_equal);
        mal_intrinsic_define_method_n(
            vm, object, "deepEqual", 2, assert_deep_equal);
        mal_intrinsic_define_method_n(
            vm, object, "deepStrictEqual", 2, assert_deep_equal);
        mal_intrinsic_define_method_n(
            vm, object, "match", 2, assert_match);
        vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_MODULE] = roots[0];
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

void mal_host_install_node_assert_strict(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_STRICT_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "equal", 2, assert_equal);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "deepEqual", 2,
            assert_deep_equal);
        mal_intrinsic_define_method_n(
            vm, mal_value_to_object(module), (const byte *) "match", 2, assert_match);
        vm->intrinsics[MAL_INTRINSIC_NODE_ASSERT_STRICT_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
