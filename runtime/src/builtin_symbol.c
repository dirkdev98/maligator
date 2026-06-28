#include "builtin_symbol.h"

#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "heap_symbol.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Spec ToString driven through the full ToPrimitive(string) protocol: objects
 * consult @@toPrimitive (hint "string") and otherwise OrdinaryToPrimitive in
 * the order toString -> valueOf; a Symbol primitive (whether passed directly or
 * produced by ToPrimitive) is not convertible and throws a TypeError.
 *
 * Returns the resulting string, or nullptr when a TypeError/propagated throw is
 * pending in vm->completion (the caller must return undefined).
 */
static MalString *mal_builtin_symbol_to_string(MalVm *vm, MalValue value) {
    if (mal_value_is_object(value)) {
        MalValue exotic;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
            return nullptr;
        }

        if (!mal_value_is_nil(exotic)) {
            if (!mal_value_is_callable(exotic)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
                return nullptr;
            }
            MalValue hint = mal_value_from_string(mal_intrinsic_ascii(vm, "string"));
            MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint, 1);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                vm->completion = result;
                return nullptr;
            }
            if (mal_value_is_object(result.value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return nullptr;
            }
            value = result.value;
        } else {
            // OrdinaryToPrimitive(input, "string"): toString before valueOf.
            const byte *methods[2] = {"toString", "valueOf"};
            bool converted = false;
            for (i32 i = 0; i < 2 && !converted; i++) {
                MalValue method;
                if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
                    return nullptr;
                }
                if (mal_value_is_callable(method)) {
                    MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
                    if (result.kind != MAL_COMPLETION_NORMAL) {
                        vm->completion = result;
                        return nullptr;
                    }
                    if (!mal_value_is_object(result.value)) {
                        value = result.value;
                        converted = true;
                    }
                }
            }
            if (!converted) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return nullptr;
            }
        }
    }

    // ToString proper: a Symbol value is not convertible.
    if (mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
        return nullptr;
    }

    return mal_ops_to_string(&vm->heap, value);
}

static MalValue mal_builtin_symbol_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol is not a constructor");
        return mal_value_new_undefined();
    }

    MalString *description = nullptr;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        description = mal_builtin_symbol_to_string(vm, args[0]);
        if (description == nullptr) {
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

    MalSymbol *symbol = mal_builtin_symbol_this(vm, this_value);
    if (symbol == nullptr) {
        return mal_value_new_undefined();
    }

    MalString *description = mal_symbol_description(symbol);
    MalValue text = mal_value_from_string(mal_intrinsic_ascii(vm, "Symbol("));
    if (description != nullptr) {
        text = mal_ops_add(&vm->heap, text, mal_value_from_string(description));
    }

    return mal_ops_add(&vm->heap, text, mal_value_from_string(mal_intrinsic_ascii(vm, ")")));
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

    MalString *key = mal_builtin_symbol_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (key == nullptr) {
        return mal_value_new_undefined();
    }
    MalKey registry_key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(key)};

    MalTableLookup lookup = mal_table_lookup(vm->symbol_registry, registry_key);
    if (lookup.present) {
        return mal_table_entry_value(vm->symbol_registry, lookup.entry);
    }

    MalSymbol *symbol = mal_symbol_new(&vm->heap, key);
    symbol->registered = true;

    void *entry = mal_table_upsert_entry(vm->symbol_registry, registry_key);
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
 * Create a well-known symbol, store it in its intrinsic slot, and expose it
 * as a non-writable non-configurable property on the Symbol constructor.
 */
static void mal_builtin_symbol_well_known(
    MalVm *vm,
    MalObject *constructor,
    MalIntrinsic slot,
    const byte *property_name,
    const byte *description
) {
    MalSymbol *symbol = mal_symbol_new(&vm->heap, mal_intrinsic_ascii(vm, description));
    vm->intrinsics[slot] = mal_value_from_symbol(symbol);
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

    MalPropertyDesc description_desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "get description"),
            mal_builtin_symbol_prototype_description_getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "description"), &description_desc);

    // Symbol.prototype[Symbol.toStringTag] = "Symbol"
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Symbol")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);
}
