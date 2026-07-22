#include "vm.h"

#include <stdio.h>

#include "builtin_eval.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

#if !MAL_REALMS
#error "realm_test_main.c requires MAL_REALMS"
#endif

extern const MalVmDefinition mal_vm_definition;

typedef struct RealmFixture {
    MalValue probe;
} RealmFixture;

static MalRealm *g_realm_two;

static MalValue realm_probe(
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
    return mal_value_new_boolean(
        vm->current_realm == g_realm_two &&
        vm->globals == g_realm_two->globals &&
        vm->intrinsics == g_realm_two->intrinsics);
}

static void install_realm_fixture(MalVm *vm, void *raw_fixture) {
    RealmFixture *fixture = raw_fixture;
    MalNativeFunctionObject *probe = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "realmProbe"),
        realm_probe);
    fixture->probe = mal_value_from_native_function_object(probe);
    vm->globals[0] = fixture->probe;
}

static MalValue own_data_property(MalVm *vm, MalValue object, const byte *name) {
    MalPropertyLookup lookup =
        mal_object_get_own(mal_value_to_object(object), mal_intrinsic_string_key(vm, name));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static bool has_own_property(MalVm *vm, MalValue object, const byte *name) {
    return mal_object_get_own(
        mal_value_to_object(object), mal_intrinsic_string_key(vm, name)).present;
}

static MalValue own_index_property(MalValue object, i32 index) {
    MalPropertyLookup lookup = mal_object_get_own(
        mal_value_to_object(object),
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)});
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static bool realm_is_current(const MalVm *vm, const MalRealm *realm) {
    return vm->current_realm == realm &&
        vm->globals == realm->globals &&
        vm->intrinsics == realm->intrinsics &&
        vm->heap.current_realm == realm;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);

    MalRealm *realm_one = vm.initial_realm;
    MalValue global_one = mal_realm_global(realm_one);
    RealmFixture fixture = {.probe = mal_value_new_undefined()};
    MalRealm *realm_two = mal_realm_create(&vm, install_realm_fixture, &fixture);
    g_realm_two = realm_two;
    MalValue global_two = mal_realm_global(realm_two);

    MalValue object_ctor_one = realm_one->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    MalValue object_ctor_two = realm_two->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR];
    MalValue array_ctor_one = realm_one->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    MalValue array_ctor_two = realm_two->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR];
    MalValue error_ctor_one = realm_one->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR];
    MalValue error_ctor_two = realm_two->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR];
    MalValue object_proto_one = realm_one->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue object_proto_two = realm_two->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE];
    MalValue array_proto_one = realm_one->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue array_proto_two = realm_two->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    MalValue function_proto_one = realm_one->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE];
    MalValue function_proto_two = realm_two->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE];
    MalValue error_proto_one = realm_one->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE];
    MalValue error_proto_two = realm_two->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE];

    bool symbols_shared = true;
    for (i32 slot = MAL_INTRINSIC_SYMBOL_ITERATOR;
         slot <= MAL_INTRINSIC_SYMBOL_UNSCOPABLES;
         slot++) {
        symbols_shared = symbols_shared &&
            realm_one->intrinsics[slot] == realm_two->intrinsics[slot];
    }

    mal_realm_switch(&vm, realm_one);
    MalValue symbol_for_one = own_data_property(
        &vm, realm_one->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], "for");
    mal_realm_switch(&vm, realm_two);
    MalValue symbol_for_two = own_data_property(
        &vm, realm_two->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], "for");
    mal_realm_switch(&vm, realm_one);

    MalValue registry_key = mal_value_from_string(mal_intrinsic_ascii(&vm, "realm-test-key"));
    MalRootSpan registry_key_root;
    mal_gc_root(&registry_key_root, &registry_key, 1);
    MalCompletion symbol_one = mal_vm_call_value(
        &vm, symbol_for_one, mal_value_new_undefined(), &registry_key, 1);
    bool symbol_one_ok = symbol_one.kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_symbol(symbol_one.value);
    MalCompletion symbol_two = mal_vm_call_value(
        &vm, symbol_for_two, mal_value_new_undefined(), &registry_key, 1);
    bool registry_shared = symbol_one_ok &&
        symbol_two.kind == MAL_COMPLETION_NORMAL &&
        symbol_two.value == symbol_one.value &&
        vm.current_realm == realm_one;
    mal_gc_unroot(&registry_key_root);

    MalCompletion probe_call = mal_vm_call_value(
        &vm, fixture.probe, mal_value_new_undefined(), nullptr, 0);
    bool cross_realm_call = probe_call.kind == MAL_COMPLETION_NORMAL &&
        probe_call.value == mal_value_new_boolean(true) &&
        vm.current_realm == realm_one;

    MalCompletion construct = mal_vm_construct_value(&vm, object_ctor_two, nullptr, 0);
    bool cross_realm_construct = construct.kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_object(construct.value) &&
        mal_object_get_prototype(mal_value_to_object(construct.value)) ==
            mal_value_to_object(object_proto_two) &&
        vm.current_realm == realm_one;

    bool enough_globals = vm.definition->global_count >= 3;
    bool globals_isolate = false;
    bool cross_realm_identity = false;
    MalValue shared_object = mal_value_new_undefined();
    if (enough_globals) {
        realm_one->globals[1] = mal_value_from_i32(11);
        realm_two->globals[1] = mal_value_from_i32(22);
        globals_isolate = realm_one->globals[1] == mal_value_from_i32(11) &&
            realm_two->globals[1] == mal_value_from_i32(22);

        shared_object = mal_value_from_object(mal_object_new(
            &vm.heap, mal_value_to_object(object_proto_one)));
        realm_one->globals[2] = shared_object;
        mal_realm_switch(&vm, realm_two);
        realm_two->globals[2] = realm_one->globals[2];
        mal_realm_switch(&vm, realm_one);
        cross_realm_identity = realm_two->globals[2] == shared_object &&
            realm_one->globals[2] == shared_object;
    }

    MalValue eval_sources[6];
    for (i32 i = 0; i < 6; i++) {
        eval_sources[i] = mal_value_new_undefined();
    }
    MalRootSpan eval_sources_root;
    mal_gc_root(&eval_sources_root, eval_sources, 6);
    eval_sources[0] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.realmOneOnly = 11;"
        "globalThis.realmTag = 1;"
        "globalThis.evalSequence = 1;"
        "globalThis.evalObject = {};"
        "globalThis.evalArray = [];"
        "globalThis.evalFunction = function () { return [globalThis.realmTag, {}, []]; };"
        "101"));
    eval_sources[1] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.realmTwoOnly = 22;"
        "globalThis.realmTag = 2;"
        "globalThis.evalSequence = 2;"
        "globalThis.evalObject = {};"
        "globalThis.evalArray = [];"
        "globalThis.evalFunction = function () {"
        "globalThis.realmTwoCalls = (globalThis.realmTwoCalls || 0) + 1;"
        "return [globalThis.realmTag, {}, []];"
        "};"
        "202"));
    eval_sources[2] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.evalSequence = globalThis.evalSequence * 10 + 3;"
        "globalThis.evalSequence"));
    eval_sources[3] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.evalSequence = globalThis.evalSequence * 10 + 4;"
        "globalThis.evalSequence"));
    eval_sources[4] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.evalHeld = { owner: 1 };"
        "globalThis.evalHeld"));
    eval_sources[5] = mal_value_from_string(mal_intrinsic_ascii(
        &vm,
        "globalThis.evalHeld = [{ owner: 2 }];"
        "globalThis.evalHeld"));

    MalCompletion eval_results[6];
    bool eval_aliases_restored = true;
    for (i32 i = 0; i < 6; i++) {
        MalRealm *target = i % 2 == 0 ? realm_one : realm_two;
        // Keep stress-at-every-safepoint out of the self-hosted compiler, but
        // collect at both API boundaries where every C-held value is rooted.
        mal_gc_collect(&vm);
        vm.gc_native_frames++;
        eval_results[i] = mal_realm_eval_script(&vm, target, eval_sources[i]);
        vm.gc_native_frames--;
        mal_gc_collect(&vm);
        eval_aliases_restored = eval_aliases_restored && realm_is_current(&vm, realm_one);
    }

    MalValue eval_object_one = own_data_property(&vm, global_one, "evalObject");
    MalValue eval_object_two = own_data_property(&vm, global_two, "evalObject");
    MalValue eval_array_one = own_data_property(&vm, global_one, "evalArray");
    MalValue eval_array_two = own_data_property(&vm, global_two, "evalArray");
    MalValue eval_function_one = own_data_property(&vm, global_one, "evalFunction");
    MalValue eval_function_two = own_data_property(&vm, global_two, "evalFunction");
    MalValue eval_held_one = eval_results[4].value;
    MalValue eval_held_two = eval_results[5].value;
    if (enough_globals) {
        realm_one->globals[1] = eval_held_one;
        realm_two->globals[1] = eval_held_two;
    }

    bool eval_completions =
        eval_results[0].kind == MAL_COMPLETION_NORMAL &&
        eval_results[0].value == mal_value_from_i32(101) &&
        eval_results[1].kind == MAL_COMPLETION_NORMAL &&
        eval_results[1].value == mal_value_from_i32(202) &&
        eval_results[2].kind == MAL_COMPLETION_NORMAL &&
        eval_results[2].value == mal_value_from_i32(13) &&
        eval_results[3].kind == MAL_COMPLETION_NORMAL &&
        eval_results[3].value == mal_value_from_i32(24) &&
        eval_results[4].kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_object(eval_held_one) &&
        eval_results[5].kind == MAL_COMPLETION_NORMAL &&
        mal_value_is_array_object(eval_held_two);
    bool eval_global_isolation =
        own_data_property(&vm, global_one, "realmOneOnly") == mal_value_from_i32(11) &&
        !has_own_property(&vm, global_two, "realmOneOnly") &&
        own_data_property(&vm, global_two, "realmTwoOnly") == mal_value_from_i32(22) &&
        !has_own_property(&vm, global_one, "realmTwoOnly") &&
        own_data_property(&vm, global_one, "realmTag") == mal_value_from_i32(1) &&
        own_data_property(&vm, global_two, "realmTag") == mal_value_from_i32(2);
    bool eval_splices_isolate = eval_aliases_restored &&
        own_data_property(&vm, global_one, "evalSequence") == mal_value_from_i32(13) &&
        own_data_property(&vm, global_two, "evalSequence") == mal_value_from_i32(24);
    bool eval_objects_use_target_prototypes =
        mal_value_is_object(eval_object_one) &&
        mal_object_get_prototype(mal_value_to_object(eval_object_one)) ==
            mal_value_to_object(object_proto_one) &&
        mal_value_is_object(eval_object_two) &&
        mal_object_get_prototype(mal_value_to_object(eval_object_two)) ==
            mal_value_to_object(object_proto_two) &&
        mal_value_is_array_object(eval_array_one) &&
        mal_object_get_prototype(mal_value_to_object(eval_array_one)) ==
            mal_value_to_object(array_proto_one) &&
        mal_value_is_array_object(eval_array_two) &&
        mal_object_get_prototype(mal_value_to_object(eval_array_two)) ==
            mal_value_to_object(array_proto_two);
    bool eval_functions_use_target_realms =
        mal_value_is_function_object(eval_function_one) &&
        mal_object_get_prototype(mal_value_to_object(eval_function_one)) ==
            mal_value_to_object(function_proto_one) &&
        mal_value_to_function_object(eval_function_one)->realm == realm_one &&
        mal_value_is_function_object(eval_function_two) &&
        mal_object_get_prototype(mal_value_to_object(eval_function_two)) ==
            mal_value_to_object(function_proto_two) &&
        mal_value_to_function_object(eval_function_two)->realm == realm_two;

    MalCompletion evaluated_call = {
        .kind = MAL_COMPLETION_THROW,
        .value = mal_value_new_undefined(),
    };
    if (mal_value_is_function_object(eval_function_two)) {
        evaluated_call = mal_vm_call_value(
            &vm, eval_function_two, mal_value_new_undefined(), nullptr, 0);
    }
    MalValue evaluated_call_value = evaluated_call.value;
    MalRootSpan evaluated_call_root;
    mal_gc_root(&evaluated_call_root, &evaluated_call_value, 1);
    mal_gc_collect(&vm);
    MalValue evaluated_call_object = mal_value_new_undefined();
    MalValue evaluated_call_array = mal_value_new_undefined();
    bool evaluated_call_is_array = mal_value_is_array_object(evaluated_call_value);
    if (evaluated_call_is_array) {
        evaluated_call_object = own_index_property(evaluated_call_value, 1);
        evaluated_call_array = own_index_property(evaluated_call_value, 2);
    }
    bool evaluated_cross_realm_call =
        evaluated_call.kind == MAL_COMPLETION_NORMAL &&
        evaluated_call_is_array &&
        mal_object_get_prototype(mal_value_to_object(evaluated_call_value)) ==
            mal_value_to_object(array_proto_two) &&
        own_index_property(evaluated_call_value, 0) == mal_value_from_i32(2) &&
        mal_value_is_object(evaluated_call_object) &&
        mal_object_get_prototype(mal_value_to_object(evaluated_call_object)) ==
            mal_value_to_object(object_proto_two) &&
        mal_value_is_array_object(evaluated_call_array) &&
        mal_object_get_prototype(mal_value_to_object(evaluated_call_array)) ==
            mal_value_to_object(array_proto_two) &&
        own_data_property(&vm, global_two, "realmTwoCalls") == mal_value_from_i32(1) &&
        !has_own_property(&vm, global_one, "realmTwoCalls") &&
        realm_is_current(&vm, realm_one);

    MalValue dates[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan dates_root;
    mal_gc_root(&dates_root, dates, 2);
    MalCompletion date_one = mal_vm_construct_value(
        &vm, realm_one->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR], nullptr, 0);
    dates[0] = date_one.value;
    MalCompletion date_two = mal_vm_construct_value(
        &vm, realm_two->intrinsics[MAL_INTRINSIC_DATE_CONSTRUCTOR], nullptr, 0);
    dates[1] = date_two.value;
    MalString *to_string_name = mal_intrinsic_ascii(&vm, "toString");
    MalValue to_string_key = mal_value_new_undefined();
    for (i32 i = 0; i < vm.definition->string_constant_count; i++) {
        if (mal_string_equals(&vm.definition->string_constants[i], to_string_name)) {
            to_string_key = mal_value_from_string(&vm.definition->string_constants[i]);
            break;
        }
    }
    MalInlineCache date_method_cache = {0};
    MalValue date_method_one = mal_vm_op_load_property_ic(
        &vm, dates[0], to_string_key, &date_method_cache);
    MalValue date_method_one_hit = mal_vm_op_load_property_ic(
        &vm, dates[0], to_string_key, &date_method_cache);
    MalValue date_method_two = mal_vm_op_load_property_ic(
        &vm, dates[1], to_string_key, &date_method_cache);
    bool cross_realm_date_cache = date_one.kind == MAL_COMPLETION_NORMAL &&
        date_two.kind == MAL_COMPLETION_NORMAL && mal_value_is_string(to_string_key) &&
        date_method_cache.mode == MAL_IC_MODE_INHERITED_VALUE &&
        date_method_one == date_method_one_hit && date_method_one != date_method_two &&
        date_method_two == own_data_property(
            &vm, realm_two->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE], "toString");

    MalInlineCache primitive_method_cache = {0};
    mal_realm_switch(&vm, realm_one);
    MalValue primitive_method_one = mal_vm_array_fast_load(
        &vm, mal_value_from_i32(1), to_string_key, &primitive_method_cache);
    MalValue primitive_method_one_hit = mal_vm_array_fast_load(
        &vm, mal_value_from_i32(2), to_string_key, &primitive_method_cache);
    mal_realm_switch(&vm, realm_two);
    MalValue primitive_method_two = mal_vm_array_fast_load(
        &vm, mal_value_from_i32(3), to_string_key, &primitive_method_cache);
    mal_realm_switch(&vm, realm_one);
    MalValue primitive_method_one_again = mal_vm_array_fast_load(
        &vm, mal_value_from_i32(4), to_string_key, &primitive_method_cache);
    bool cross_realm_primitive_cache =
        primitive_method_cache.mode == MAL_IC_MODE_PRIMITIVE_VALUE &&
        primitive_method_one == primitive_method_one_hit &&
        primitive_method_one == primitive_method_one_again &&
        primitive_method_one != primitive_method_two &&
        primitive_method_one == own_data_property(
            &vm, realm_one->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE], "toString") &&
        primitive_method_two == own_data_property(
            &vm, realm_two->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE], "toString") &&
        realm_is_current(&vm, realm_one);

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"realm records are distinct", realm_one != realm_two},
        {"primitive method cache is realm-exact", cross_realm_primitive_cache},
        {"global objects are distinct", global_one != global_two},
        {"global slot arrays are distinct", realm_one->globals != realm_two->globals},
        {"intrinsic arrays are distinct", realm_one->intrinsics != realm_two->intrinsics},
        {"Object constructor and prototype are distinct",
         object_ctor_one != object_ctor_two && object_proto_one != object_proto_two},
        {"Array constructor and prototype are distinct",
         array_ctor_one != array_ctor_two && array_proto_one != array_proto_two},
        {"Error constructor and prototype are distinct",
         error_ctor_one != error_ctor_two && error_proto_one != error_proto_two},
        {"well-known symbols are isolate-wide", symbols_shared},
        {"Symbol.for registry is isolate-wide", registry_shared},
        {"realm-two probe is a stamped native function",
         mal_value_is_native_function_object(fixture.probe) &&
             mal_value_to_native_function_object(fixture.probe)->realm == realm_two},
        {"realm-two intrinsic natives are stamped",
         mal_value_is_native_function_object(object_ctor_two) &&
             mal_value_to_native_function_object(object_ctor_two)->realm == realm_two &&
         mal_value_is_native_function_object(array_ctor_two) &&
             mal_value_to_native_function_object(array_ctor_two)->realm == realm_two &&
         mal_value_is_native_function_object(error_ctor_two) &&
             mal_value_to_native_function_object(error_ctor_two)->realm == realm_two},
        {"cross-realm function call enters and restores", cross_realm_call},
        {"cross-realm construction enters and restores", cross_realm_construct},
        {"fixture provides global slots", enough_globals},
        {"global slot values are isolated", globals_isolate},
        {"object identity round-trips across realms", cross_realm_identity},
        {"realm-targeted eval completion values are preserved", eval_completions},
        {"realm-targeted eval global properties are isolated", eval_global_isolation},
        {"alternating eval splices preserve globals and current aliases", eval_splices_isolate},
        {"evaluated objects and arrays use target-realm prototypes",
         eval_objects_use_target_prototypes},
        {"evaluated functions use target-realm prototypes and stamps",
         eval_functions_use_target_realms},
        {"evaluated cross-realm call enters, creates, and restores",
         evaluated_cross_realm_call},
        {"inherited Date method cache separates direct prototypes by realm",
         cross_realm_date_cache},
    };

    mal_gc_unroot(&dates_root);
    mal_gc_unroot(&evaluated_call_root);
    mal_gc_unroot(&eval_sources_root);
    mal_gc_collect(&vm);
    bool realms_survive_gc = vm.initial_realm == realm_one &&
        vm.current_realm == realm_one &&
        mal_realm_global(realm_one) == global_one &&
        mal_realm_global(realm_two) == global_two &&
        realm_one->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR] == object_ctor_one &&
        realm_two->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR] == object_ctor_two &&
        (!enough_globals ||
         (realm_one->globals[2] == shared_object && realm_two->globals[2] == shared_object));
    bool eval_results_survive_gc = enough_globals &&
        realm_one->globals[1] == eval_held_one &&
        realm_two->globals[1] == eval_held_two &&
        own_data_property(&vm, global_one, "evalHeld") == eval_held_one &&
        own_data_property(&vm, global_two, "evalHeld") == eval_held_two &&
        mal_value_is_object(eval_held_one) &&
        mal_object_get_prototype(mal_value_to_object(eval_held_one)) ==
            mal_value_to_object(object_proto_one) &&
        mal_value_is_array_object(eval_held_two) &&
        mal_object_get_prototype(mal_value_to_object(eval_held_two)) ==
            mal_value_to_object(array_proto_two);

    int check_count = (int) (sizeof(checks) / sizeof(checks[0]));
    int total = check_count + 2;
    int passed = 0;
    for (int i = 0; i < check_count; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("realm CHECK FAIL: %s\n", checks[i].name);
        }
    }
    if (realms_survive_gc) {
        passed++;
    } else {
        printf("realm CHECK FAIL: both realms survive forced GC\n");
    }
    if (eval_results_survive_gc) {
        passed++;
    } else {
        printf("realm CHECK FAIL: evaluated slot/property results survive forced GC\n");
    }
    printf("realm PASS %d/%d\n", passed, total);

    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
