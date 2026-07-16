#include "builtin_error.h"

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "object_ops.h"
#include "property_store.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/** Unforgeable markers backing the [[ErrorData]] and captured-stack slots. */
#if MAL_REALMS
#define MAL_ERROR_DATA_MARKER(vm) ((vm)->error_data_marker)
#define MAL_ERROR_STACK_MARKER(vm) ((vm)->error_stack_marker)
#else
static MalValue mal_error_data_marker = MAL_VALUE_UNDEFINED;
static MalValue mal_error_stack_marker = MAL_VALUE_UNDEFINED;
#define MAL_ERROR_DATA_MARKER(vm) ((void) (vm), mal_error_data_marker)
#define MAL_ERROR_STACK_MARKER(vm) ((void) (vm), mal_error_stack_marker)
#endif

static bool mal_builtin_error_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static MalKey mal_error_data_key(MalVm *vm) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = MAL_ERROR_DATA_MARKER(vm)};
}

static MalKey mal_error_stack_key(MalVm *vm) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = MAL_ERROR_STACK_MARKER(vm)};
}

static void mal_error_mark_error_data(MalVm *vm, MalObject *error) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_new_boolean(true), MAL_PROPERTY_NONE);
    mal_object_define_own(error, mal_error_data_key(vm), &desc);
}

static bool mal_error_has_error_data(MalVm *vm, MalObject *object) {
    if (mal_value_is_undefined(MAL_ERROR_DATA_MARKER(vm))) {
        return false;
    }
    MalPropertyLookup lookup = mal_object_get_own(object, mal_error_data_key(vm));
    return lookup.present;
}

bool mal_builtin_value_has_error_data(MalVm *vm, MalValue value) {
    return mal_value_is_object(value) && mal_error_has_error_data(vm, mal_value_to_object(value));
}

/**
 * Capture the current call stack at construction and stash its id on the error
 * under the private stack key; the .stack getter formats it lazily. Skipped when
 * debug info is stripped (no file table) — that is the --strip-debug behavior,
 * and keeps the throw-heavy test262 batch at zero capture cost — and before the
 * marker is minted (errors created during early intrinsics init).
 */
static void mal_error_capture_stack(MalVm *vm, MalObject *error) {
    if (mal_value_is_undefined(MAL_ERROR_STACK_MARKER(vm)) || vm->definition->file_count == 0) {
        return;
    }
    MalStackTrace *trace = mal_vm_capture_stack(vm);
    i32 id = mal_vm_store_stack_trace(vm, trace);
    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_from_i32(id), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(error, mal_error_stack_key(vm), &desc);
}

/**
 * Spec ToString that can invoke user-defined ToPrimitive/toString/valueOf and
 * therefore can throw (Symbol argument, abrupt conversion). On a pending throw
 * it returns false and leaves vm->completion set.
 */
static bool mal_error_to_string(MalVm *vm, MalValue value, MalString **out) {
    // ToPrimitive(value, string) for objects: @@toPrimitive, else the
    // OrdinaryToPrimitive order toString -> valueOf (string hint).
    if (mal_value_is_object(value)) {
        MalValue exotic;
        if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE), &exotic)) {
            return false;
        }
        if (!mal_value_is_nil(exotic)) {
            if (!mal_value_is_callable(exotic)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol.toPrimitive is not a function");
                return false;
            }
            MalValue hint = mal_value_from_string(mal_intrinsic_ascii(vm, "string"));
            MalCompletion result = mal_vm_call_value(vm, exotic, value, &hint, 1);
            if (result.kind != MAL_COMPLETION_NORMAL) {
                return false;
            }
            if (mal_value_is_object(result.value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return false;
            }
            value = result.value;
        } else {
            const byte *methods[2] = {"toString", "valueOf"};
            bool converted = false;
            for (i32 i = 0; i < 2 && !converted; i++) {
                MalValue method;
                if (!mal_vm_get_property(vm, value, mal_intrinsic_string_key(vm, methods[i]), &method)) {
                    return false;
                }
                if (mal_value_is_callable(method)) {
                    MalCompletion result = mal_vm_call_value(vm, method, value, nullptr, 0);
                    if (result.kind != MAL_COMPLETION_NORMAL) {
                        return false;
                    }
                    if (!mal_value_is_object(result.value)) {
                        value = result.value;
                        converted = true;
                    }
                }
            }
            if (!converted) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert object to primitive value");
                return false;
            }
        }
    }

    // ToString proper: a Symbol is not convertible.
    if (mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
        return false;
    }

    *out = mal_ops_to_string(&vm->heap, value);
    return true;
}

/**
 * InstallErrorCause(O, options): when `options` is an object with an own-or-
 * inherited "cause", copy it to a non-enumerable own "cause" data property.
 * Returns false on a pending throw (Get is observable).
 */
static bool mal_error_install_cause(MalVm *vm, MalObject *error, MalValue options) {
    if (!mal_value_is_object(options)) {
        return true;
    }

    MalKey cause_key = mal_intrinsic_string_key(vm, "cause");
    if (!mal_vm_has_property(vm, options, cause_key)) {
        // HasProperty itself does not throw here, but a pending throw from a
        // proxy/getter trap would surface via vm->completion.
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return false;
        }
        return true;
    }

    MalValue cause;
    if (!mal_vm_get_property(vm, options, cause_key, &cause)) {
        return false;
    }

    mal_intrinsic_define_data(vm, error, "cause", cause, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return true;
}

/**
 * Allocate an error object backed by the given prototype slot, with the
 * message (when defined) stored as an own non-enumerable property and the
 * cause (when present in options) installed.
 */
static MalValue mal_builtin_error_make(MalVm *vm, MalIntrinsic prototype_slot, const MalValue *args, i32 arg_count) {
    MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[prototype_slot]));
    mal_error_mark_error_data(vm, error);
    mal_error_capture_stack(vm, error);

    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *message_string;
        if (!mal_error_to_string(vm, args[0], &message_string)) {
            return mal_value_new_undefined();
        }
        mal_intrinsic_define_data(vm, error, "message", mal_value_from_string(message_string), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    if (arg_count >= 2) {
        if (!mal_error_install_cause(vm, error, args[1])) {
            return mal_value_new_undefined();
        }
    }

    return mal_value_from_object(error);
}

// Error constructors behave identically when called and when constructed, so
// plain native callbacks cover both paths.
static MalValue mal_builtin_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_type_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_range_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_reference_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_syntax_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_uri_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_eval_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE, args, arg_count);
}

/**
 * AggregateError differs from the other errors: its first argument is an
 * iterable of errors (collected into the own `errors` array property), the
 * second argument is the message, and the third is the options bag. The spec
 * order is: ToString(message) -> InstallErrorCause(options) -> IterableToList.
 */
static MalValue mal_builtin_aggregate_error_make(MalVm *vm, MalValue errors_value, MalValue message_value, MalValue options_value) {
    MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_AGGREGATE_ERROR_PROTOTYPE]));
    mal_error_mark_error_data(vm, error);
    mal_error_capture_stack(vm, error);

    if (!mal_value_is_undefined(message_value)) {
        MalString *message_string;
        if (!mal_error_to_string(vm, message_value, &message_string)) {
            return mal_value_new_undefined();
        }
        mal_intrinsic_define_data(vm, error, "message", mal_value_from_string(message_string), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    if (!mal_error_install_cause(vm, error, options_value)) {
        return mal_value_new_undefined();
    }

    // IterableToList(errors) into a fresh array.
    MalArrayObject *list = mal_intrinsic_new_array(vm, 0);
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, errors_value, &record)) {
        return mal_value_new_undefined(); // not iterable: propagate the pending throw
    }
    i32 index = 0;
    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            break;
        }
        mal_array_object_store(list, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index++)}, item);
    }

    // AggregateError "errors": { writable: true, enumerable: false, configurable: true }.
    mal_intrinsic_define_data(vm, error, "errors", mal_value_from_array_object(list), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return mal_value_from_object(error);
}

static MalValue mal_builtin_aggregate_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_aggregate_error_make(
        vm,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined(),
        arg_count >= 3 ? args[2] : mal_value_new_undefined()
    );
}

MalValue mal_builtin_new_aggregate_error(MalVm *vm, MalValue errors) {
    return mal_builtin_aggregate_error_make(vm, errors, mal_value_new_undefined(), mal_value_new_undefined());
}

/**
 * Error.isError(arg): true iff arg is an object carrying the [[ErrorData]]
 * marker (i.e. produced by one of the Error constructors above). A plain object
 * that merely inherits from Error.prototype is not an error.
 */
static MalValue mal_builtin_error_is_error(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(arg)) {
        return mal_value_new_boolean(false);
    }
    return mal_value_new_boolean(mal_error_has_error_data(vm, mal_value_to_object(arg)));
}

/**
 * Get(O, name) walking the prototype chain, then ToString the non-undefined
 * result (which can throw on a Symbol). Returns false on a pending throw, and
 * sets *out to NULL when the property is undefined/absent.
 */
static bool mal_builtin_error_get_string(MalVm *vm, MalObject *error, const byte *name, MalString **out) {
    MalValue value;
    if (!mal_vm_get_property(vm, mal_value_from_object(error), mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        *out = nullptr;
        return true;
    }
    return mal_error_to_string(vm, value, out);
}

static MalValue mal_builtin_error_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    // 1-2. If Type(this) is not Object, throw a TypeError.
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Error.prototype.toString called on non-object");
        return mal_value_new_undefined();
    }

    MalObject *error = mal_value_to_object(this_value);

    // 3-4. name: Get(O, "name"); if undefined use "Error", else ToString(name).
    MalString *name;
    if (!mal_builtin_error_get_string(vm, error, "name", &name)) {
        return mal_value_new_undefined();
    }
    if (name == nullptr) {
        name = mal_intrinsic_ascii(vm, "Error");
    }

    // 5-6. message: Get(O, "message"); if undefined use "", else ToString(msg).
    MalString *message;
    if (!mal_builtin_error_get_string(vm, error, "message", &message)) {
        return mal_value_new_undefined();
    }

    if (message == nullptr || mal_string_length(message) == 0) {
        return mal_value_from_string(name);
    }
    if (mal_string_length(name) == 0) {
        return mal_value_from_string(message);
    }

    usize name_length = mal_string_length(name);
    usize message_length = mal_string_length(message);
    usize total_length;
    usize bytes;
    if (!mal_checked_size_add(name_length, 2, MAL_STRING_MAX_CODE_UNITS, &total_length) ||
        !mal_checked_size_add(
            total_length, message_length, MAL_STRING_MAX_CODE_UNITS, &total_length) ||
        !mal_checked_size_multiply(sizeof(c16), total_length, SIZE_MAX, &bytes)) {
        mal_builtin_error_throw_string_length(vm);
        return mal_value_new_undefined();
    }
    c16 *code_units = malloc(bytes);
    if (code_units == nullptr) {
        mal_builtin_error_throw_string_length(vm);
        return mal_value_new_undefined();
    }

    memcpy(code_units, mal_string_code_units(name), (usize) sizeof(c16) * name_length);
    code_units[name_length] = ':';
    code_units[name_length + 1] = ' ';
    memcpy(code_units + name_length + 2, mal_string_code_units(message), (usize) sizeof(c16) * message_length);

    MalString *result = mal_string_new_copy(&vm->heap, code_units, total_length);
    free(code_units);
    return mal_value_from_string(result);
}

/**
 * get Error.prototype.stack (error-stack-accessor proposal):
 *   1. If this is not an Object, throw a TypeError.
 *   2. If this has no [[ErrorData]] slot, return undefined.
 *   3. Otherwise return an implementation-defined stack string.
 */
static MalValue mal_builtin_error_stack_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Error.prototype.stack getter called on non-object");
        return mal_value_new_undefined();
    }
    MalObject *error = mal_value_to_object(this_value);
    if (!mal_error_has_error_data(vm, error)) {
        return mal_value_new_undefined();
    }

    // The trace id stashed at construction (absent when debug info was stripped,
    // or for errors created before the marker was minted).
    MalPropertyLookup lookup = mal_object_get_own(error, mal_error_stack_key(vm));
    MalStackTrace *trace =
        lookup.present ? mal_vm_stored_stack_trace(vm, mal_value_to_i32(lookup.desc.value)) : nullptr;

    // Header line: the error's "Name: message" (Error.prototype.toString).
    MalValue header = mal_builtin_error_prototype_to_string(
        vm, this_value, nullptr, 0, mal_value_new_undefined(), mal_value_new_undefined()
    );
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    MalValue result = header;
    if (trace != nullptr) {
        MalString *frames = mal_vm_format_stack_frames(vm, trace);
        result = mal_vm_add(vm, header, mal_value_from_string(frames));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    // The getter has no observable side effect (it does not install an own
    // "stack" property): the spec getter just returns a string, and a test
    // relies on a foreign-new-target error's property access still finding no
    // accessor. The caller can memoize via `.stack =` (the setter) if desired.
    // Reformatting per read is acceptable — .stack is a slow path by design.
    return result;
}

/**
 * set Error.prototype.stack(value): create/overwrite an own data property
 * "stack" on the receiver (matching the proposal's implementation-defined
 * behavior of installing the value as an own property).
 */
static MalValue mal_builtin_error_stack_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Error.prototype.stack setter called on non-object");
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(mal_value_to_object(this_value), mal_intrinsic_string_key(vm, "stack"), &desc);
    return mal_value_new_undefined();
}

static void mal_builtin_error_define_stack_accessor(MalVm *vm, MalObject *prototype) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "get stack"), 0, mal_builtin_error_stack_getter
        )),
        .setter = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "set stack"), 1, mal_builtin_error_stack_setter
        )),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "stack"), &desc);
}

void mal_vm_throw_error(MalVm *vm, MalIntrinsic prototype_slot, const byte *message) {
    mal_vm_throw_error_value(vm, prototype_slot, mal_value_from_string(mal_intrinsic_ascii(vm, message)));
}

void mal_vm_throw_error_value(MalVm *vm, MalIntrinsic prototype_slot, MalValue message) {
    // Build the error object directly so internal throws never re-enter the
    // observable ToString/cause machinery (the message is already a string).
    MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[prototype_slot]));
    mal_error_mark_error_data(vm, error);
    mal_error_capture_stack(vm, error);
    if (!mal_value_is_undefined(message)) {
        mal_intrinsic_define_data(vm, error, "message", message, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = mal_value_from_object(error),
    };
}

void mal_vm_throw_allocation_error(MalVm *vm) {
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = vm->allocation_error,
    };
}

MalValue mal_vm_create_allocation_error(MalVm *vm) {
    MalObject *error = mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]));
    mal_error_mark_error_data(vm, error);
    mal_intrinsic_define_data(
        vm, error, "message", mal_value_from_string(mal_intrinsic_ascii(vm, "Out of memory")),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    error->extensible = false;
    return mal_value_from_object(error);
}

static MalObject *mal_builtin_error_install_kind(
    MalVm *vm,
    const byte *name,
    MalIntrinsic constructor_slot,
    MalIntrinsic prototype_slot,
    MalObject *parent_prototype,
    MalObject *constructor_prototype,
    i32 constructor_length,
    MalNativeFunctionCallback constructor_callback
) {
    MalObject *prototype = mal_object_new(&vm->heap, parent_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        constructor_prototype,
        mal_intrinsic_ascii(vm, name),
        constructor_length,
        constructor_callback
    );

    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);

    // Error.prototype: { [[Writable]]: false, [[Enumerable]]: false, [[Configurable]]: false }.
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[prototype_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[constructor_slot], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "name", mal_value_from_string(mal_intrinsic_ascii(vm, name)), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "message", mal_value_from_string(mal_intrinsic_ascii(vm, "")), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    return prototype;
}

void mal_builtin_error_install(MalVm *vm) {
    // Mint the [[ErrorData]] and captured-stack markers before any error object
    // is created. A realms build reuses the VM-owned pair for every realm.
#if MAL_REALMS
    if (mal_value_is_undefined(vm->error_data_marker)) {
        vm->error_data_marker = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    }
    if (mal_value_is_undefined(vm->error_stack_marker)) {
        vm->error_stack_marker = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    }
#else
    mal_error_data_marker = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    mal_error_stack_marker = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
#endif

    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    MalObject *error_prototype = mal_builtin_error_install_kind(
        vm,
        "Error",
        MAL_INTRINSIC_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_ERROR_PROTOTYPE,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        function_prototype,
        1,
        mal_builtin_error_constructor
    );
    mal_intrinsic_define_method_n(vm, error_prototype, "toString", 0, mal_builtin_error_prototype_to_string);
    mal_builtin_error_define_stack_accessor(vm, error_prototype);

    // Error.isError: { [[Writable]]: true, [[Enumerable]]: false, [[Configurable]]: true }.
    mal_intrinsic_define_method_n(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR]), "isError", 1, mal_builtin_error_is_error);

    // NativeError / AggregateError constructors have [[Prototype]] === %Error%
    // (the Error constructor), not %Function.prototype%.
    MalObject *error_constructor = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR]);

    mal_builtin_error_install_kind(vm, "TypeError", MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_type_error_constructor);
    mal_builtin_error_install_kind(vm, "RangeError", MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_range_error_constructor);
    mal_builtin_error_install_kind(vm, "ReferenceError", MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_reference_error_constructor);
    mal_builtin_error_install_kind(vm, "SyntaxError", MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_syntax_error_constructor);
    mal_builtin_error_install_kind(vm, "URIError", MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_uri_error_constructor);
    mal_builtin_error_install_kind(vm, "EvalError", MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE, error_prototype, error_constructor, 1, mal_builtin_eval_error_constructor);
    mal_builtin_error_install_kind(vm, "AggregateError", MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_AGGREGATE_ERROR_PROTOTYPE, error_prototype, error_constructor, 2, mal_builtin_aggregate_error_constructor);
}
