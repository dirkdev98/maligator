#include "node_vm.h"

#if MAL_NODE

#include <stdio.h>
#include <stdlib.h>

#include "array_object.h"
#include "builtin_eval.h"
#include "function_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "node_buffer.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

enum { VM_SLOT_CONTEXT_BRAND, VM_SLOT_SCRIPT_BRAND, VM_SLOT_COUNT };

static MalValue vm_slot(MalValue callee, i32 slot) {
    return mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), slot);
}

static MalValue vm_arg(const MalValue *args, i32 argc, i32 index) {
    return index < argc ? args[index] : mal_value_new_undefined();
}

static MalKey vm_brand_key(MalValue brand) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = brand};
}

static MalValue vm_private_state(MalValue object, MalValue brand) {
    if (!mal_value_is_object(object)) return mal_value_new_undefined();
    MalPropertyLookup lookup =
        mal_object_get_own(mal_value_to_object(object), vm_brand_key(brand));
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void vm_define_private_state(MalValue object, MalValue brand, MalValue state) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(state, MAL_PROPERTY_NONE);
    mal_object_define_own(mal_value_to_object(object), vm_brand_key(brand), &desc);
}

#if !MAL_REALMS
static void vm_throw_requires_realms(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, "node:vm contexts require engine.realms");
}
#endif

static bool vm_require_object(MalVm *vm, MalValue value) {
    if (mal_value_is_object(value)) return true;
    mal_node_throw_invalid_arg_type(vm, "object", "of type object", value);
    return false;
}

// Returns the spliced script entry, or -1 with a pending throw.
static i32 vm_compile_code(MalVm *vm, MalValue code) {
    MalString *source = nullptr;
    if (!mal_vm_to_string(vm, code, &source)) return -1;
    return mal_vm_compile_script(vm, mal_value_from_string(source));
}

#if MAL_REALMS
static MalValue node_vm_collect_garbage(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    mal_gc_collect(vm);
    return mal_value_new_undefined();
}

static void node_vm_install_context(MalVm *vm, void *data) {
    (void) data;
    if (!vm->node_v8_expose_gc) return;
    MalObject *global = mal_value_to_object(mal_realm_global(vm->current_realm));
    mal_intrinsic_define_method_n(
        vm, global, "gc", 0, node_vm_collect_garbage);
}

static MalRealm *vm_context_realm(MalVm *vm, MalValue callee, MalValue sandbox) {
    MalValue global = vm_private_state(sandbox, vm_slot(callee, VM_SLOT_CONTEXT_BRAND));
    if (!mal_value_is_object(global)) return nullptr;
    for (MalRealm *realm = vm->realms; realm != nullptr; realm = realm->next) {
        if (mal_ops_same_value(mal_realm_global(realm), global)) return realm;
    }
    return nullptr;
}

// The sandbox only references its realm's global; realms are VM-lifetime roots,
// so the association never keeps the sandbox itself alive.
static MalRealm *vm_contextify(MalVm *vm, MalValue callee, MalValue sandbox) {
    MalRealm *existing = vm_context_realm(vm, callee, sandbox);
    if (existing != nullptr) return existing;
    MalValue roots[] = {sandbox, vm_slot(callee, VM_SLOT_CONTEXT_BRAND)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalRealm *realm = mal_realm_create(vm, node_vm_install_context, nullptr);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root);
        return nullptr;
    }
    vm_define_private_state(roots[0], roots[1], mal_realm_global(realm));
    mal_gc_unroot(&root);
    return realm;
}

static MalRealm *vm_require_context(MalVm *vm, MalValue callee, MalValue value) {
    if (!vm_require_object(vm, value)) return nullptr;
    MalRealm *realm = vm_context_realm(vm, callee, value);
    if (realm == nullptr) {
        mal_node_throw_invalid_arg_type(vm, "contextifiedObject", "an vm.Context", value);
    }
    return realm;
}

enum { SYNC_FROM, SYNC_TO, SYNC_SNAPSHOT, SYNC_KEYS, SYNC_KEY, SYNC_VALUE, SYNC_ROOT_COUNT };

static bool vm_copy_properties(MalVm *vm, MalValue *roots) {
    if (!mal_vm_own_property_keys(vm, roots[SYNC_FROM], &roots[SYNC_KEYS])) return false;
    MalArrayObject *keys = mal_value_to_array_object(roots[SYNC_KEYS]);
    for (u32 i = 0; i < mal_array_object_length(keys); i++) {
        mal_array_object_dense_get(keys, i, &roots[SYNC_KEY]);
        MalKey key = mal_key_from_value(roots[SYNC_KEY]);
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, roots[SYNC_FROM], key, &present, &desc)) return false;
        if (!present) continue;
        if (mal_value_is_undefined(roots[SYNC_SNAPSHOT])) {
            if (!(desc.flags & MAL_PROPERTY_ENUMERABLE)) continue;
            if (!mal_vm_get_property(vm, roots[SYNC_FROM], key, &roots[SYNC_VALUE])) return false;
        } else {
            if (desc.flags & MAL_PROPERTY_ACCESSOR) continue;
            MalPropertyLookup before =
                mal_object_get_own(mal_value_to_object(roots[SYNC_SNAPSHOT]), key);
            if (before.present && mal_ops_same_value(before.desc.value, desc.value)) continue;
            roots[SYNC_VALUE] = desc.value;
        }
        mal_vm_set_property(vm, roots[SYNC_TO], key, roots[SYNC_VALUE], roots[SYNC_TO]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    }
    return true;
}

static bool vm_snapshot_data_properties(MalVm *vm, MalValue *roots) {
    if (!mal_vm_own_property_keys(vm, roots[SYNC_FROM], &roots[SYNC_KEYS])) return false;
    MalArrayObject *keys = mal_value_to_array_object(roots[SYNC_KEYS]);
    for (u32 i = 0; i < mal_array_object_length(keys); i++) {
        mal_array_object_dense_get(keys, i, &roots[SYNC_KEY]);
        MalKey key = mal_key_from_value(roots[SYNC_KEY]);
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, roots[SYNC_FROM], key, &present, &desc)) return false;
        if (!present || (desc.flags & MAL_PROPERTY_ACCESSOR)) continue;
        MalPropertyDesc copy = mal_intrinsic_data_desc(desc.value, MAL_PROPERTY_NONE);
        mal_object_define_own(mal_value_to_object(roots[SYNC_SNAPSHOT]), key, &copy);
    }
    return true;
}

// Approximates Node's contextified global, where the sandbox itself is the global
// object: the sandbox's own enumerable properties are copied onto the realm global
// before the run, and globals the run created or reassigned (compared against a
// snapshot, so untouched built-ins stay out) are copied back afterwards, even when
// the script throws. Getters, deletions and lexical declarations do not sync.
static MalValue vm_run_in_context(MalVm *vm, MalRealm *realm, MalValue sandbox, i32 entry) {
    MalValue roots[SYNC_ROOT_COUNT + 1];
    for (i32 i = 0; i < SYNC_ROOT_COUNT + 1; i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalValue global = mal_realm_global(realm);

    roots[SYNC_FROM] = sandbox;
    roots[SYNC_TO] = global;
    if (!vm_copy_properties(vm, roots)) goto done;
    roots[SYNC_FROM] = global;
    roots[SYNC_SNAPSHOT] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    if (!vm_snapshot_data_properties(vm, roots)) goto done;

    MalRealm *caller_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, realm);
    roots[SYNC_ROOT_COUNT] = mal_vm_run_script_entry(vm, entry);
    mal_vm_realm_switch_to(vm, caller_realm);
    MalCompletion run = vm->completion;
    if (run.kind == MAL_COMPLETION_THROW) {
        roots[SYNC_ROOT_COUNT] = run.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }

    roots[SYNC_TO] = sandbox;
    if (!vm_copy_properties(vm, roots)) goto done;
    if (run.kind == MAL_COMPLETION_THROW) {
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[SYNC_ROOT_COUNT]};
        goto done;
    }
    result = roots[SYNC_ROOT_COUNT];

done:
    mal_gc_unroot(&root);
    return result;
}
#endif

static MalValue vm_run_entry_in_context_arg(
    MalVm *vm, MalValue callee, MalValue context, i32 entry, bool create) {
#if MAL_REALMS
    MalRealm *realm = create ? vm_contextify(vm, callee, context)
                             : vm_require_context(vm, callee, context);
    if (realm == nullptr) return mal_value_new_undefined();
    return vm_run_in_context(vm, realm, context, entry);
#else
    (void) callee;
    (void) context;
    (void) entry;
    (void) create;
    vm_throw_requires_realms(vm);
    return mal_value_new_undefined();
#endif
}

// Node's runInNewContext/createContext default the sandbox to a fresh object.
static bool vm_new_context_object(MalVm *vm, MalValue *context) {
    if (mal_value_is_undefined(*context)) {
        *context = mal_value_from_object(mal_intrinsic_new_object(vm));
        return true;
    }
    return vm_require_object(vm, *context);
}

static MalValue node_vm_run_in_this_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    i32 entry = vm_compile_code(vm, vm_arg(args, argc, 0));
    if (entry < 0) return mal_value_new_undefined();
    return mal_vm_run_script_entry(vm, entry);
}

static MalValue node_vm_run_in_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue roots[] = {vm_arg(args, argc, 0), vm_arg(args, argc, 1)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
#if MAL_REALMS
    if (vm_require_context(vm, callee, roots[1]) == nullptr) goto done;
#endif
    i32 entry = vm_compile_code(vm, roots[0]);
    if (entry < 0) goto done;
    result = vm_run_entry_in_context_arg(vm, callee, roots[1], entry, false);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_vm_run_in_new_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue roots[] = {vm_arg(args, argc, 0), vm_arg(args, argc, 1)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    if (!vm_new_context_object(vm, &roots[1])) goto done;
    i32 entry = vm_compile_code(vm, roots[0]);
    if (entry < 0) goto done;
    result = vm_run_entry_in_context_arg(vm, callee, roots[1], entry, true);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_vm_create_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue context = vm_arg(args, argc, 0);
    MalRootSpan root;
    mal_gc_root(&root, &context, 1);
    MalValue result = mal_value_new_undefined();
    if (!vm_new_context_object(vm, &context)) goto done;
#if MAL_REALMS
    if (vm_contextify(vm, callee, context) == nullptr) goto done;
    result = context;
#else
    (void) callee;
    vm_throw_requires_realms(vm);
#endif
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_vm_is_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue value = vm_arg(args, argc, 0);
    if (!vm_require_object(vm, value)) return mal_value_new_undefined();
#if MAL_REALMS
    return mal_value_new_boolean(vm_context_realm(vm, callee, value) != nullptr);
#else
    (void) callee;
    return mal_value_new_boolean(false);
#endif
}

static MalValue node_vm_compile_function(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue code = vm_arg(args, argc, 0);
    MalValue params = vm_arg(args, argc, 1);
    MalValue options = vm_arg(args, argc, 2);
    if (!mal_value_is_string(code)) {
        mal_node_throw_invalid_arg_type(vm, "code", "of type string", code);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(params) && !mal_value_is_array_object(params)) {
        mal_node_throw_invalid_arg_type(vm, "params", "an instance of Array", params);
        return mal_value_new_undefined();
    }
    u32 param_count = mal_value_is_undefined(params)
        ? 0
        : mal_array_object_length(mal_value_to_array_object(params));
    MalValue *pieces = calloc((usize) param_count + 1, sizeof(MalValue));
    if (pieces == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    for (u32 i = 0; i <= param_count; i++) pieces[i] = mal_value_new_undefined();
    MalValue roots[] = {code, params, options, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalRootSpan pieces_root;
    mal_gc_root(&pieces_root, pieces, (i32) param_count + 1);
    MalValue result = mal_value_new_undefined();

    for (u32 i = 0; i < param_count; i++) {
        mal_array_object_dense_get(mal_value_to_array_object(roots[1]), i, &pieces[i]);
        if (!mal_value_is_string(pieces[i])) {
            char name[32];
            snprintf(name, sizeof name, "params[%u]", i);
            mal_node_throw_invalid_arg_type(vm, name, "of type string", pieces[i]);
            goto done;
        }
    }
    pieces[param_count] = roots[0];

    if (mal_value_is_object(roots[2])
        && !mal_vm_get_property(
            vm, roots[2], mal_intrinsic_string_key(vm, "parsingContext"), &roots[3])) {
        goto done;
    }
#if MAL_REALMS
    MalRealm *caller_realm = vm->current_realm;
    MalRealm *realm = caller_realm;
    if (!mal_value_is_undefined(roots[3])) {
        realm = vm_require_context(vm, callee, roots[3]);
        if (realm == nullptr) goto done;
    }
    mal_vm_realm_switch_to(vm, realm);
#else
    (void) callee;
    if (!mal_value_is_undefined(roots[3])) {
        vm_throw_requires_realms(vm);
        goto done;
    }
#endif
    result = mal_vm_construct_function(
        vm, pieces, (i32) param_count + 1, MAL_DYNAMIC_FUNCTION_NORMAL,
        mal_value_new_undefined(), vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR]);
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, caller_realm);
#endif

done:
    mal_gc_unroot(&pieces_root);
    mal_gc_unroot(&root);
    free(pieces);
    return result;
}

static MalValue node_vm_script_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor Script cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {new_target, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    i32 entry = vm_compile_code(vm, vm_arg(args, argc, 0));
    if (entry < 0) goto done;
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, roots[0], MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        goto done;
    }
    roots[1] = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    vm_define_private_state(
        roots[1], vm_slot(callee, VM_SLOT_SCRIPT_BRAND), mal_value_from_f64((f64) entry));
    result = roots[1];
done:
    mal_gc_unroot(&root);
    return result;
}

static i32 vm_script_entry(MalVm *vm, MalValue receiver, MalValue callee, const char *method) {
    MalValue state = vm_private_state(receiver, vm_slot(callee, VM_SLOT_SCRIPT_BRAND));
    if (!mal_ops_is_number(state)) {
        char message[96];
        snprintf(message, sizeof message, "Script.prototype.%s called on an incompatible receiver", method);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return -1;
    }
    return (i32) mal_ops_number_as_f64(state);
}

static MalValue node_vm_script_run_in_this_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    i32 entry = vm_script_entry(vm, receiver, callee, "runInThisContext");
    if (entry < 0) return mal_value_new_undefined();
    return mal_vm_run_script_entry(vm, entry);
}

static MalValue node_vm_script_run_in_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    i32 entry = vm_script_entry(vm, receiver, callee, "runInContext");
    if (entry < 0) return mal_value_new_undefined();
    return vm_run_entry_in_context_arg(vm, callee, vm_arg(args, argc, 0), entry, false);
}

static MalValue node_vm_script_run_in_new_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    i32 entry = vm_script_entry(vm, receiver, callee, "runInNewContext");
    if (entry < 0) return mal_value_new_undefined();
    MalValue context = vm_arg(args, argc, 0);
    MalRootSpan root;
    mal_gc_root(&root, &context, 1);
    MalValue result = mal_value_new_undefined();
    if (vm_new_context_object(vm, &context)) {
        result = vm_run_entry_in_context_arg(vm, callee, context, entry, true);
    }
    mal_gc_unroot(&root);
    return result;
}

static MalValue node_vm_script_create_cached_data(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    if (vm_script_entry(vm, receiver, callee, "createCachedData") < 0) {
        return mal_value_new_undefined();
    }
    return mal_node_buffer_from_owned_bytes(vm, nullptr, 0);
}

static MalValue node_vm_create_script(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue script_constructor = vm_slot(callee, VM_SLOT_COUNT);
    return node_vm_script_constructor(vm, mal_value_new_undefined(), args, argc,
        script_constructor, script_constructor);
}

enum {
    INSTALL_MODULE,
    INSTALL_CONTEXT_BRAND,
    INSTALL_SCRIPT_BRAND,
    INSTALL_SCRIPT_CTOR,
    INSTALL_SCRIPT_PROTO,
    INSTALL_TEMP,
    INSTALL_ROOT_COUNT,
};

static MalValue vm_define_function(
    MalVm *vm, MalValue *roots, MalValue target, const char *name, i32 length,
    MalNativeFunctionCallback callback, i32 extra_slots) {
    MalValue slots[VM_SLOT_COUNT + 1] = {
        roots[INSTALL_CONTEXT_BRAND], roots[INSTALL_SCRIPT_BRAND], roots[INSTALL_SCRIPT_CTOR]};
    roots[INSTALL_TEMP] = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name), length, callback,
            slots, VM_SLOT_COUNT + extra_slots));
    mal_intrinsic_define_data(vm, mal_value_to_object(target), (const byte *) name,
        roots[INSTALL_TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return roots[INSTALL_TEMP];
}

static void vm_install_module(MalVm *vm, MalValue *roots) {
    roots[INSTALL_CONTEXT_BRAND] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[INSTALL_SCRIPT_BRAND] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[INSTALL_MODULE] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalValue module = roots[INSTALL_MODULE];

    roots[INSTALL_SCRIPT_CTOR] = vm_define_function(
        vm, roots, module, "Script", 1, node_vm_script_constructor, 0);
    mal_native_function_object_set_constructor(
        mal_value_to_native_function_object(roots[INSTALL_SCRIPT_CTOR]));
    roots[INSTALL_SCRIPT_PROTO] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[INSTALL_SCRIPT_CTOR]),
        (const byte *) "prototype", roots[INSTALL_SCRIPT_PROTO], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[INSTALL_SCRIPT_PROTO]),
        (const byte *) "constructor", roots[INSTALL_SCRIPT_CTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalValue prototype = roots[INSTALL_SCRIPT_PROTO];
    vm_define_function(vm, roots, prototype, "runInThisContext", 1,
        node_vm_script_run_in_this_context, 0);
    vm_define_function(vm, roots, prototype, "runInContext", 2,
        node_vm_script_run_in_context, 0);
    vm_define_function(vm, roots, prototype, "runInNewContext", 2,
        node_vm_script_run_in_new_context, 0);
    vm_define_function(vm, roots, prototype, "createCachedData", 0,
        node_vm_script_create_cached_data, 0);

    vm_define_function(vm, roots, module, "compileFunction", 1, node_vm_compile_function, 0);
    vm_define_function(vm, roots, module, "createContext", 0, node_vm_create_context, 0);
    vm_define_function(vm, roots, module, "createScript", 2, node_vm_create_script, 1);
    vm_define_function(vm, roots, module, "isContext", 1, node_vm_is_context, 0);
    vm_define_function(vm, roots, module, "runInContext", 3, node_vm_run_in_context, 0);
    vm_define_function(vm, roots, module, "runInNewContext", 3, node_vm_run_in_new_context, 0);
    vm_define_function(vm, roots, module, "runInThisContext", 2, node_vm_run_in_this_context, 0);

    roots[INSTALL_TEMP] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    MalValue constants = roots[INSTALL_TEMP];
    mal_intrinsic_define_data(vm, mal_value_to_object(module), (const byte *) "constants",
        constants, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE | MAL_PROPERTY_ENUMERABLE);
    static const char *const constant_names[][2] = {
        {"USE_MAIN_CONTEXT_DEFAULT_LOADER", "vm_dynamic_import_main_context_default"},
        {"DONT_CONTEXTIFY", "vm_context_no_contextify"},
    };
    for (usize i = 0; i < countof(constant_names); i++) {
        MalValue symbol = mal_value_from_symbol(mal_symbol_new(
            &vm->heap, mal_intrinsic_ascii(vm, (const byte *) constant_names[i][1])));
        mal_intrinsic_define_data(vm, mal_value_to_object(constants),
            (const byte *) constant_names[i][0], symbol, MAL_PROPERTY_ENUMERABLE);
    }
}

void mal_host_install_node_vm(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:vm", slots, count)) return;
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_VM_MODULE];
    if (mal_value_is_undefined(module)) {
        MalValue roots[INSTALL_ROOT_COUNT];
        for (i32 i = 0; i < INSTALL_ROOT_COUNT; i++) roots[i] = mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, roots, INSTALL_ROOT_COUNT);
        vm_install_module(vm, roots);
        module = roots[INSTALL_MODULE];
        vm->intrinsics[MAL_INTRINSIC_NODE_VM_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, "node:vm", slots, count, module);
}

#endif /* MAL_NODE */
