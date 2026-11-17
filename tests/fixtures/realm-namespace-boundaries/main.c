#include <stdio.h>
#include "function_object.h"
#include "gc.h"
#include "object.h"
#include "perf_stats.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static bool get(MalVm *vm, const byte *name, MalValue *out) {
    return mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS],
        mal_intrinsic_string_key(vm, name), out);
}

static MalCompletion invoke(MalVm *vm, MalValue callee, const MalValue *args, i32 count) {
    MalExactScriptCall exact;
    if (!mal_vm_prepare_builtin_callback(vm, callee, &exact))
        return mal_vm_call_value(vm, callee, MAL_VALUE_UNDEFINED, args, count);
    vm->exact_script_call = &exact;
    MalCompletion result = mal_vm_call_builtin_callback(
        vm, callee, MAL_VALUE_UNDEFINED, args, count);
    vm->exact_script_call = exact.previous;
    return result;
}

static bool number_result(MalCompletion result, f64 expected) {
    return result.kind == MAL_COMPLETION_NORMAL && mal_ops_is_number(result.value) &&
        mal_ops_number_as_f64(result.value) == expected;
}

static bool check_realms(MalVm *vm) {
    MalValue roots[4] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalRealm *initial = vm->current_realm;
    bool ok = false;
    if (!get(vm, "realmProbe", &roots[0]) ||
        !get(vm, "realmReplaceNumber", &roots[2])) goto done;
    i32 probe = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    i32 replace = mal_function_object_function_index(mal_value_to_function_object(roots[2]));
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    mal_realm_switch(vm, owned);
    roots[1] = mal_vm_op_create_function(vm, probe, nullptr);
    roots[2] = mal_vm_op_create_function(vm, replace, nullptr);
    mal_realm_switch(vm, initial);
    MalValue argument = mal_value_from_i32(7);
    if (!number_result(invoke(vm, roots[0], &argument, 1), 8) ||
        !number_result(invoke(vm, roots[1], &argument, 1), 8) ||
        vm->current_realm != initial ||
        mal_perf_stats.primordial_binding_guard_admissions == 0) goto done;
    mal_gc_collect(vm);
    if (invoke(vm, roots[2], nullptr, 0).kind != MAL_COMPLETION_NORMAL ||
        !number_result(invoke(vm, roots[1], &argument, 1), 7) ||
        !number_result(invoke(vm, roots[0], &argument, 1), 8) ||
        vm->current_realm != initial ||
        mal_perf_stats.primordial_binding_guard_rejections == 0) goto done;
    argument = vm->intrinsics[MAL_INTRINSIC_SYMBOL_ITERATOR];
    MalCompletion thrown = invoke(vm, roots[1], &argument, 1);
    roots[3] = thrown.value;
    if (thrown.kind != MAL_COMPLETION_THROW || !mal_value_is_object(roots[3]) ||
        mal_object_prototype(mal_value_to_object(roots[3])) !=
            mal_value_to_object(owned->intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]) ||
        vm->current_realm != initial) goto done;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

static bool check_clock_realms(MalVm *vm) {
    MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalRealm *initial = vm->current_realm;
    bool ok = false;
    if (!get(vm, "realmClock", &roots[0]) ||
        !get(vm, "realmReplaceClock", &roots[2])) goto done;
    i32 clock = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    i32 replace = mal_function_object_function_index(mal_value_to_function_object(roots[2]));
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    mal_realm_switch(vm, owned);
    roots[1] = mal_vm_op_create_function(vm, clock, nullptr);
    roots[2] = mal_vm_op_create_function(vm, replace, nullptr);
    mal_realm_switch(vm, initial);
    if (!number_result(invoke(vm, roots[0], nullptr, 0), 1) ||
        !number_result(invoke(vm, roots[1], nullptr, 0), 1) ||
        vm->current_realm != initial) goto done;
    mal_gc_collect(vm);
    if (invoke(vm, roots[2], nullptr, 0).kind != MAL_COMPLETION_NORMAL ||
        !number_result(invoke(vm, roots[1], nullptr, 0), 0) ||
        !number_result(invoke(vm, roots[0], nullptr, 0), 1) ||
        vm->current_realm != initial) goto done;
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

static bool check_utc_realms(MalVm *vm) {
    MalValue roots[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalRealm *initial = vm->current_realm;
    bool ok = false;
    if (!get(vm, "realmUTC", &roots[0]) ||
        !get(vm, "realmReplaceUTC", &roots[2])) goto done;
    i32 utc = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    i32 replace = mal_function_object_function_index(mal_value_to_function_object(roots[2]));
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    mal_realm_switch(vm, owned);
    roots[1] = mal_vm_op_create_function(vm, utc, nullptr);
    roots[2] = mal_vm_op_create_function(vm, replace, nullptr);
    mal_realm_switch(vm, initial);
    MalValue year = mal_value_from_i32(2024);
    if (!number_result(invoke(vm, roots[0], &year, 1), 1704067200000.0) ||
        !number_result(invoke(vm, roots[1], &year, 1), 1704067200000.0) ||
        vm->current_realm != initial) goto done;
    mal_gc_collect(vm);
    if (invoke(vm, roots[2], nullptr, 0).kind != MAL_COMPLETION_NORMAL ||
        !number_result(invoke(vm, roots[1], &year, 1), 31) ||
        !number_result(invoke(vm, roots[0], &year, 1), 1704067200000.0) ||
        vm->current_realm != initial) goto done;
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

static bool check_parse_realms(MalVm *vm) {
    MalValue roots[5] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalRealm *initial = vm->current_realm;
    bool ok = false;
    if (!get(vm, "realmParse", &roots[0]) ||
        !get(vm, "realmReplaceParse", &roots[2]) ||
        !get(vm, "realmParseText", &roots[3])) goto done;
    i32 parse = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    i32 replace = mal_function_object_function_index(mal_value_to_function_object(roots[2]));
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    mal_realm_switch(vm, owned);
    roots[1] = mal_vm_op_create_function(vm, parse, nullptr);
    roots[2] = mal_vm_op_create_function(vm, replace, nullptr);
    mal_realm_switch(vm, initial);
    u64 admissions = mal_perf_stats.primordial_binding_guard_admissions;
    if (!number_result(invoke(vm, roots[0], &roots[3], 1), 1582979696789.0) ||
        !number_result(invoke(vm, roots[1], &roots[3], 1), 1582979696789.0) ||
        mal_perf_stats.primordial_binding_guard_admissions <= admissions ||
        vm->current_realm != initial) goto done;
    mal_gc_collect(vm);
    MalValue symbol = vm->intrinsics[MAL_INTRINSIC_SYMBOL_ITERATOR];
    MalCompletion thrown = invoke(vm, roots[1], &symbol, 1);
    roots[4] = thrown.value;
    if (thrown.kind != MAL_COMPLETION_THROW || !mal_value_is_object(roots[4]) ||
        mal_object_prototype(mal_value_to_object(roots[4])) !=
            mal_value_to_object(owned->intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]) ||
        vm->current_realm != initial) goto done;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    if (invoke(vm, roots[2], nullptr, 0).kind != MAL_COMPLETION_NORMAL ||
        !number_result(invoke(vm, roots[1], &roots[3], 1), 79) ||
        !number_result(invoke(vm, roots[0], &roots[3], 1), 1582979696789.0) ||
        vm->current_realm != initial) goto done;
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

static bool check_number_conversion_realms(
    MalVm *vm, const byte *name, const byte *replacement, const byte *text_name,
    bool integer, f64 expected, f64 replaced
) {
    MalValue roots[5] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalRealm *initial = vm->current_realm;
    bool ok = false;
    if (!get(vm, name, &roots[0]) || !get(vm, replacement, &roots[2]) ||
        !get(vm, text_name, &roots[3])) goto done;
    i32 parse = mal_function_object_function_index(mal_value_to_function_object(roots[0]));
    i32 replace = mal_function_object_function_index(mal_value_to_function_object(roots[2]));
    MalRealm *owned = mal_realm_create(vm, nullptr, nullptr);
    mal_realm_switch(vm, owned);
    roots[1] = mal_vm_op_create_function(vm, parse, nullptr);
    roots[2] = mal_vm_op_create_function(vm, replace, nullptr);
    mal_realm_switch(vm, initial);
    MalValue args[2] = {roots[3], mal_value_from_i32(10)};
    i32 count = integer ? 2 : 1;
    u64 admissions = mal_perf_stats.primordial_binding_guard_admissions;
    if (!number_result(invoke(vm, roots[0], args, count), expected) ||
        !number_result(invoke(vm, roots[1], args, count), expected) ||
        mal_perf_stats.primordial_binding_guard_admissions <= admissions ||
        vm->current_realm != initial) goto done;
    mal_gc_collect(vm);
    for (i32 index = 0; index < count; index++) {
        args[0] = roots[3];
        args[1] = mal_value_from_i32(10);
        args[index] = vm->intrinsics[MAL_INTRINSIC_SYMBOL_ITERATOR];
        MalCompletion thrown = invoke(vm, roots[1], args, count);
        roots[4] = thrown.value;
        if (thrown.kind != MAL_COMPLETION_THROW || !mal_value_is_object(roots[4]) ||
            mal_object_prototype(mal_value_to_object(roots[4])) !=
                mal_value_to_object(owned->intrinsics[MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE]) ||
            vm->current_realm != initial) goto done;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = MAL_VALUE_UNDEFINED};
    }
    args[0] = roots[3];
    args[1] = mal_value_from_i32(10);
    if (invoke(vm, roots[2], nullptr, 0).kind != MAL_COMPLETION_NORMAL ||
        !number_result(invoke(vm, roots[1], args, count), replaced) ||
        !number_result(invoke(vm, roots[0], args, count), expected) ||
        vm->current_realm != initial) goto done;
    ok = true;
done:
    mal_realm_switch(vm, initial);
    mal_gc_unroot(&span);
    return ok;
}

static void run_entry(MalVm *vm) {
    MalCallable *entry = mal_vm_create_callable(vm, 0);
    mal_vm_run(vm, entry);
    mal_vm_free_callable(entry);
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    run_entry(&vm);
    bool ok = vm.completion.kind == MAL_COMPLETION_NORMAL &&
        check_realms(&vm) && check_clock_realms(&vm) && check_utc_realms(&vm);
    mal_vm_free(&vm);
    if (ok) {
        mal_vm_init(&vm, &mal_runtime_image);
        run_entry(&vm);
        ok = vm.completion.kind == MAL_COMPLETION_NORMAL && check_parse_realms(&vm);
        mal_vm_free(&vm);
    }
    for (i32 index = 0; ok && index < 2; index++) {
        mal_vm_init(&vm, &mal_runtime_image);
        run_entry(&vm);
        ok = vm.completion.kind == MAL_COMPLETION_NORMAL && check_number_conversion_realms(
            &vm, index ? "realmParseInt" : "realmParseFloat",
            index ? "realmReplaceParseInt" : "realmReplaceParseFloat",
            "realmNumberText",
            index != 0, index ? 42 : 42.5, index ? 67 : 61);
        mal_vm_free(&vm);
    }
    if (ok) {
        mal_vm_init(&vm, &mal_runtime_image);
        run_entry(&vm);
        ok = vm.completion.kind == MAL_COMPLETION_NORMAL && check_number_conversion_realms(
            &vm, "realmConvertNumber", "realmReplaceConversion", "realmConversionText",
            false, 42.5, 73);
        mal_vm_free(&vm);
    }
    if (!ok) { fputs("realm-namespace-boundaries failure\n", stderr); return 1; }
    puts("realm-namespace-boundaries PASS");
    return 0;
}
