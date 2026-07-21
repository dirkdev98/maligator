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

static MalValue assert_fail(MalVm *vm, const byte *message) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message);
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
