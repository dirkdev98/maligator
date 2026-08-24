#include "builtin_symbol.h"

#include <string.h>

#include "checked_size.h"
#include "gc.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "heap_symbol.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_builtin_symbol_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol is not a constructor");
        return mal_value_new_undefined();
    }

    MalString *description = nullptr;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        if (!mal_vm_to_string(vm, args[0], &description)) {
            return mal_value_new_undefined();
        }
    }

    return mal_value_from_symbol(mal_symbol_new(&vm->heap, description));
}

/**
 * thisSymbolValue (20.4.3): a Symbol primitive, or a Symbol wrapper object whose
 * [[SymbolData]] is unwrapped. Anything else is a TypeError.
 */
static MalSymbol *mal_builtin_symbol_this(MalVm *vm, MalValue this_value) {
    if (mal_value_is_symbol(this_value)) {
        return mal_value_to_symbol(this_value);
    }

    if (mal_value_is_primitive_wrapper(this_value)) {
        MalPrimitiveWrapperObject *wrapper = mal_value_to_primitive_wrapper(this_value);
        if (wrapper->kind == MAL_PRIMITIVE_WRAPPER_SYMBOL) {
            return mal_value_to_symbol(wrapper->primitive_data);
        }
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a symbol");
    return nullptr;
}

static MalValue mal_builtin_symbol_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalValue symbol_root = this_value;
    MalRootSpan root_span;
    mal_gc_root(&root_span, &symbol_root, 1);

    MalSymbol *symbol = mal_builtin_symbol_this(vm, symbol_root);
    if (symbol == nullptr) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }

    MalString *description = mal_symbol_description(symbol);
    if (description == nullptr) {
        MalValue result = mal_value_from_string(mal_intrinsic_ascii(vm, "Symbol()"));
        mal_gc_unroot(&root_span);
        return result;
    }

    usize description_length = mal_string_length(description);
    usize length;
    if (!mal_checked_size_add(
            description_length, 8, MAL_STRING_MAX_CODE_UNITS, &length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }

    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * length,
        MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    static const byte prefix[] = "Symbol(";
    for (usize i = 0; i < sizeof(prefix) - 1; i++) {
        code_units[i] = prefix[i];
    }
    symbol = mal_builtin_symbol_this(vm, symbol_root);
    description = mal_symbol_description(symbol);
    memcpy(
        code_units + sizeof(prefix) - 1,
        mal_string_code_units(description),
        sizeof(c16) * description_length);
    code_units[length - 1] = ')';

    MalValue result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_symbol_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    // thisSymbolValue: step 5 returns the [[SymbolData]] itself — the UNWRAPPED
    // symbol — not the receiver. For a Symbol-wrapper object `this_value` is the
    // wrapper, so returning it (instead of the symbol) made valueOf/@@toPrimitive
    // hand back the object. (Shared by Symbol.prototype[@@toPrimitive].)
    MalSymbol *symbol = mal_builtin_symbol_this(vm, this_value);
    if (symbol == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_symbol(symbol);
}

static MalValue mal_builtin_symbol_for(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    MalString *key;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &key)) {
        return mal_value_new_undefined();
    }
    MalKey registry_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(key)};

    MalTableLookup lookup = mal_table_lookup(vm->symbol_registry, registry_key);
    if (lookup.present) {
        return mal_table_entry_value(vm->symbol_registry, lookup.entry);
    }

    MalSymbol *symbol = mal_symbol_new(&vm->heap, key);
    symbol->registered = true;

    void *entry = mal_table_upsert_entry(vm->symbol_registry, registry_key, nullptr);
    mal_table_entry_set_value(vm->symbol_registry, entry, mal_value_from_symbol(symbol));

    return mal_value_from_symbol(symbol);
}

static MalValue mal_builtin_symbol_key_for(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.keyFor expects a symbol");
        return mal_value_new_undefined();
    }

    MalSymbol *symbol = mal_value_to_symbol(value);
    if (!symbol->registered) {
        return mal_value_new_undefined();
    }

    // Registered symbols carry their registry key as the description.
    return mal_value_from_string(mal_symbol_description(symbol));
}

static MalValue mal_builtin_symbol_prototype_description_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalSymbol *symbol = mal_builtin_symbol_this(vm, this_value);
    if (symbol == nullptr) {
        return mal_value_new_undefined();
    }

    MalString *description = mal_symbol_description(symbol);
    if (description == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_string(description);
}

/**
 * Ensure a well-known symbol exists in its agent-shared intrinsic slot, then
 * expose it as a non-writable non-configurable property on this realm's fresh
 * Symbol constructor.
 */
static void mal_builtin_symbol_well_known(
    MalVm *vm,
    MalObject *constructor,
    MalIntrinsic slot,
    const byte *property_name,
    const byte *description
) {
    if (mal_value_is_undefined(vm->intrinsics[slot])) {
        MalSymbol *symbol = mal_symbol_new(&vm->heap, mal_intrinsic_ascii(vm, description));
        vm->intrinsics[slot] = mal_value_from_symbol(symbol);
    }
    mal_intrinsic_define_data(vm, constructor, property_name, vm->intrinsics[slot], MAL_PROPERTY_NONE);
}

void mal_builtin_symbol_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Symbol"),
        0,
        mal_builtin_symbol_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_SYMBOL_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_SYMBOL_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_ITERATOR, "iterator", "Symbol.iterator");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR, "asyncIterator", "Symbol.asyncIterator");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG, "toStringTag", "Symbol.toStringTag");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_HAS_INSTANCE, "hasInstance", "Symbol.hasInstance");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE, "toPrimitive", "Symbol.toPrimitive");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_SPECIES, "species", "Symbol.species");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_IS_CONCAT_SPREADABLE, "isConcatSpreadable", "Symbol.isConcatSpreadable");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_MATCH, "match", "Symbol.match");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_MATCH_ALL, "matchAll", "Symbol.matchAll");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_REPLACE, "replace", "Symbol.replace");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_SEARCH, "search", "Symbol.search");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_SPLIT, "split", "Symbol.split");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_UNSCOPABLES, "unscopables", "Symbol.unscopables");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_DISPOSE, "dispose", "Symbol.dispose");
    mal_builtin_symbol_well_known(vm, (MalObject *) constructor, MAL_INTRINSIC_SYMBOL_ASYNC_DISPOSE, "asyncDispose", "Symbol.asyncDispose");

    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "for", 1, mal_builtin_symbol_for);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "keyFor", 1, mal_builtin_symbol_key_for);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_symbol_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_symbol_prototype_value_of);

    // Symbol.prototype[Symbol.toPrimitive] answers with the symbol itself (the
    // spec's brand check matches valueOf). Defined with arity 1 ("hint") and as
    // a non-writable, non-enumerable, configurable property per the spec.
    MalNativeFunctionObject *to_primitive = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "[Symbol.toPrimitive]"),
        1,
        mal_builtin_symbol_prototype_value_of
    );
    MalPropertyDesc to_primitive_desc = mal_intrinsic_data_desc(
        mal_value_from_native_function_object(to_primitive),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &to_primitive_desc);

    mal_intrinsic_define_getter(
        vm, prototype, "description", "get description",
        mal_builtin_symbol_prototype_description_getter, MAL_PROPERTY_CONFIGURABLE);

    // Symbol.prototype[Symbol.toStringTag] = "Symbol"
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Symbol")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);
}
