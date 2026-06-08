#include "vm_ops.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "builtin_array.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap_string.h"
#include "object_ops.h"
#include "property_iter.h"
#include "value_ops.h"

static MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out);

static bool mal_vm_string_to_array_index(MalString *string, i32 *index_out) {
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);

    if (length == 0) {
        return false;
    }

    if (length > 1 && code_units[0] == '0') {
        return false;
    }

    u64 value = 0;
    for (usize i = 0; i < length; i++) {
        c16 code_unit = code_units[i];
        if (code_unit < '0' || code_unit > '9') {
            return false;
        }

        value = value * 10 + (u64) (code_unit - '0');
        if (value > INT32_MAX) {
            return false;
        }
    }

    *index_out = (i32) value;
    return true;
}

static bool mal_vm_string_to_property_key(MalValue value, MalKey *key_out) {
    i32 index = 0;
    if (mal_vm_string_to_array_index(mal_value_to_string(value), &index)) {
        *key_out = (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(index)};
        return true;
    }

    *key_out = (MalKey) {.kind = MAL_KEY_STRING, .value = value};
    return true;
}

bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out) {
    if (mal_value_is_int32(value) && mal_value_to_i32(value) >= 0) {
        *key_out = (MalKey) {.kind = MAL_KEY_INDEX, .value = value};
        return true;
    }

    if (mal_value_is_string(value)) {
        return mal_vm_string_to_property_key(value, key_out);
    }

    if (mal_value_is_symbol(value)) {
        *key_out = (MalKey) {.kind = MAL_KEY_SYMBOL, .value = value};
        return true;
    }

    return mal_vm_string_to_property_key(
        mal_value_from_string(mal_ops_to_string(&vm->heap, value)),
        key_out
    );
}

bool mal_vm_desc_read(MalVm *vm, MalPropertyDesc desc, MalValue receiver, MalValue *out) {
    if (!(desc.flags & MAL_PROPERTY_ACCESSOR)) {
        *out = desc.value;
        return true;
    }

    if (!mal_value_is_callable(desc.getter)) {
        // Set-only accessors read as undefined.
        *out = mal_value_new_undefined();
        return true;
    }

    MalCompletion completion = mal_vm_call_value(vm, desc.getter, receiver, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return false;
    }

    *out = completion.value;
    return true;
}

void mal_op_move(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.move.dst] = callable->registers[instruction->as.move.src];
}

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_create_f64(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_f64.dst] = mal_value_from_f64_convert_nan(instruction->as.create_f64.value);
}

void mal_op_create_boolean(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_boolean.dst] = mal_value_new_boolean(instruction->as.create_boolean.value != 0);
}

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction) {
    const MalStringConstant *constant = &callable->vm->definition->string_constants[instruction->as.create_string.string_index];
    MalString *string = mal_string_new_external(&callable->vm->heap, constant->code_units, constant->length);
    callable->registers[instruction->as.create_string.dst] = mal_value_from_string(string);
}

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction) {
    MalObject *object = mal_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    callable->registers[instruction->as.create_object.dst] = mal_value_from_object(object);
}

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction) {
    MalArrayObject *array = mal_array_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(array, (u32) instruction->as.create_array.length);
    callable->registers[instruction->as.create_array.dst] = mal_value_from_array_object(array);
}

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
}

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_null.dst] = mal_value_new_null();
}

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction) {
    // Generator function objects inherit %GeneratorFunction.prototype%.
    i32 function_index = instruction->as.create_function.function_index;
    MalIntrinsic prototype_slot =
        callable->vm->definition->functions[function_index].kind == MAL_FUNCTION_KIND_GENERATOR
            ? MAL_INTRINSIC_GENERATOR_FUNCTION_PROTOTYPE
            : MAL_INTRINSIC_FUNCTION_PROTOTYPE;

    MalFunctionObject *function = mal_function_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[prototype_slot]),
        instruction->as.create_function.function_index
    );
    function->creation_env = callable->env;

    callable->registers[instruction->as.create_function.dst] = mal_value_from_function_object(function);
}

void mal_op_load_captured(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = mal_value_new_undefined();
    for (MalEnv *env = callable->env; env != nullptr; env = env->parent) {
        if (env->function_index == instruction->as.load_captured.owner_function_index) {
            value = env->slots[instruction->as.load_captured.index];
            break;
        }
    }

    callable->registers[instruction->as.load_captured.dst] = value;
}

void mal_op_store_captured(MalCallable *callable, MalInstruction *instruction) {
    for (MalEnv *env = callable->env; env != nullptr; env = env->parent) {
        if (env->function_index == instruction->as.store_captured.owner_function_index) {
            env->slots[instruction->as.store_captured.index] = callable->registers[instruction->as.store_captured.src];
            return;
        }
    }
}

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction) {
    if (!mal_value_is_undefined(callable->arguments_object)) {
        callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
        return;
    }

    MalArrayObject *arguments = mal_array_object_new(&callable->vm->heap, nullptr);
    mal_array_object_set_length(arguments, callable->argument_count);

    for (i32 i = 0; i < callable->argument_count; i++) {
        mal_object_set(
            (MalObject *) arguments,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)},
            callable->arguments[i]
        );
    }

    callable->arguments_object = mal_value_from_array_object(arguments);
    callable->registers[instruction->as.create_arguments_object.dst] = callable->arguments_object;
}

void mal_op_load_this(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_this.dst] = callable->this_value;
}

/**
 * Shared call dispatch: bound resolution, then script frame push or native
 * invocation. The result register lives on the frame that was current when
 * the dispatch started.
 */
static void mal_vm_call_dispatch(MalVm *vm, MalValue callee, MalValue this_value, const MalValue *arguments, i32 argument_count, i32 dst) {
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, arguments, argument_count, true);

    if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            mal_value_to_function_object(resolution.callee)->creation_env,
            resolution.this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
        vm->frames[vm->frame_count - 1].callee = resolution.callee;
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        // The callback may push frames and realloc the frame array, which
        // invalidates any frame pointers. Snapshot what we need and
        // re-resolve the frame afterwards.
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, resolution.this_value, resolution.args, resolution.arg_count, mal_value_new_undefined());
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
    }

    free(resolution.owned_args);
}

/**
 * Shared construct dispatch, mirroring mal_vm_call_dispatch.
 */
static void mal_vm_construct_dispatch(MalVm *vm, MalValue callee, const MalValue *arguments, i32 argument_count, i32 dst) {
    // The bound this is ignored when constructing.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), arguments, argument_count, false);

    if (mal_value_is_function_object(resolution.callee)) {
        i32 callee_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        if (vm->definition->functions[callee_index].kind != MAL_FUNCTION_KIND_NORMAL) {
            // Generators (and other non-normal kinds) are not constructors.
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
            free(resolution.owned_args);
            return;
        }

        // Create this from the callee's prototype property.
        MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        MalValue prototype_value = mal_vm_function_prototype(vm, resolution.callee);
        if (mal_value_is_object(prototype_value)) {
            prototype = mal_value_to_object(prototype_value);
        }

        MalValue this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            mal_value_to_function_object(resolution.callee)->creation_env,
            this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
        vm->frames[vm->frame_count - 1].is_construct = true;
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        // Native constructors allocate their own this; new_target carries the
        // construct-ness signal.
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count, resolution.callee);
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
    }

    free(resolution.owned_args);
}

/**
 * Materialize a spread-call arguments array into a malloc'd argument list.
 */
static MalValue *mal_vm_spread_arguments(MalVm *vm, MalValue array_value, i32 *count_out) {
    *count_out = 0;
    if (!mal_value_is_array_object(array_value)) {
        return nullptr;
    }

    u32 length = mal_array_object_length(mal_value_to_array_object(array_value));
    MalValue *arguments = length > 0 ? malloc(sizeof(MalValue) * length) : nullptr;
    for (u32 i = 0; i < length; i++) {
        arguments[i] = mal_value_new_undefined();
        mal_builtin_array_try_get(vm, array_value, i, &arguments[i]);
    }

    *count_out = (i32) length;
    return arguments;
}

void mal_op_call(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call.callee];
    MalValue this_value = callable->registers[instruction->as.call.this_value];
    i32 dst = instruction->as.call.dst;
    i32 argument_count = instruction->as.call.argument_count;

    MalValue *arguments = malloc(sizeof(MalValue) * argument_count);
    for (i32 i = 0; i < argument_count; i++) {
        arguments[i] = callable->registers[instruction->as.call.arguments[i]];
    }

    mal_vm_call_dispatch(vm, callee, this_value, arguments, argument_count, dst);
    free(arguments);
}

void mal_op_call_spread(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.call_spread.callee];
    MalValue this_value = callable->registers[instruction->as.call_spread.this_value];
    MalValue arguments_array = callable->registers[instruction->as.call_spread.arguments_array];
    i32 dst = instruction->as.call_spread.dst;

    i32 argument_count;
    MalValue *arguments = mal_vm_spread_arguments(vm, arguments_array, &argument_count);

    mal_vm_call_dispatch(vm, callee, this_value, arguments, argument_count, dst);
    free(arguments);
}

void mal_op_construct(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct.callee];
    i32 dst = instruction->as.construct.dst;
    i32 argument_count = instruction->as.construct.argument_count;

    MalValue *arguments = malloc(sizeof(MalValue) * argument_count);
    for (i32 i = 0; i < argument_count; i++) {
        arguments[i] = callable->registers[instruction->as.construct.arguments[i]];
    }

    mal_vm_construct_dispatch(vm, callee, arguments, argument_count, dst);
    free(arguments);
}

void mal_op_construct_spread(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue callee = callable->registers[instruction->as.construct_spread.callee];
    MalValue arguments_array = callable->registers[instruction->as.construct_spread.arguments_array];
    i32 dst = instruction->as.construct_spread.dst;

    i32 argument_count;
    MalValue *arguments = mal_vm_spread_arguments(vm, arguments_array, &argument_count);

    mal_vm_construct_dispatch(vm, callee, arguments, argument_count, dst);
    free(arguments);
}

void mal_op_throw(MalCallable *callable, MalInstruction *instruction) {
    callable->vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = callable->registers[instruction->as.thrown.value],
    };
}

void mal_op_catch(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.caught.dst] = callable->vm->completion.value;
    callable->vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

void mal_op_binary(MalCallable *callable, MalInstruction *instruction) {
    auto left = callable->registers[instruction->as.binary.left];
    auto right = callable->registers[instruction->as.binary.right];

    switch (instruction->as.binary.op) {
        case MAL_BIN_ADD:
            callable->registers[instruction->as.binary.dst] = mal_ops_add(&callable->vm->heap, left, right);
            break;
        case MAL_BIN_SUB:
            callable->registers[instruction->as.binary.dst] = mal_ops_subtract(left, right);
            break;
        case MAL_BIN_MUL:
            callable->registers[instruction->as.binary.dst] = mal_ops_multiply(left, right);
            break;
        case MAL_BIN_DIV:
            callable->registers[instruction->as.binary.dst] = mal_ops_divide(left, right);
            break;
        case MAL_BIN_REM:
            callable->registers[instruction->as.binary.dst] = mal_ops_remainder(left, right);
            break;
        case MAL_BIN_POW:
            callable->registers[instruction->as.binary.dst] = mal_ops_exponentiate(left, right);
            break;
        case MAL_BIN_BIT_AND:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_and(left, right);
            break;
        case MAL_BIN_BIT_OR:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_or(left, right);
            break;
        case MAL_BIN_BIT_XOR:
            callable->registers[instruction->as.binary.dst] = mal_ops_bit_xor(left, right);
            break;
        case MAL_BIN_SHL:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_left(left, right);
            break;
        case MAL_BIN_SHR:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_right(left, right);
            break;
        case MAL_BIN_USHR:
            callable->registers[instruction->as.binary.dst] = mal_ops_shift_right_unsigned(left, right);
            break;
        case MAL_BIN_LT:
            callable->registers[instruction->as.binary.dst] = mal_ops_less_than(left, right);
            break;
        case MAL_BIN_LTE:
            callable->registers[instruction->as.binary.dst] = mal_ops_less_equal(left, right);
            break;
        case MAL_BIN_GT:
            callable->registers[instruction->as.binary.dst] = mal_ops_greater_than(left, right);
            break;
        case MAL_BIN_GTE:
            callable->registers[instruction->as.binary.dst] = mal_ops_greater_equal(left, right);
            break;
        case MAL_BIN_EQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_equal(left, right);
            break;
        case MAL_BIN_NEQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_not_equal(left, right);
            break;
        case MAL_BIN_STRICT_EQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_strict_equal(left, right);
            break;
        case MAL_BIN_STRICT_NEQ:
            callable->registers[instruction->as.binary.dst] = mal_ops_strict_not_equal(left, right);
            break;
        case MAL_BIN_IN: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot use 'in' operator on a non-object");
                break;
            }

            MalKey key;
            if (!mal_vm_value_to_property_key(callable->vm, left, &key)) {
                callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(false);
                break;
            }

            MalValue synthetic;
            bool found = mal_vm_resolve_synthetic_property(callable->vm, right, key, &synthetic) ||
                mal_object_resolve_property(mal_value_to_object(right), key).found;
            callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(found);
            break;
        }
        case MAL_BIN_INSTANCEOF: {
            if (!mal_value_is_object(right)) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not an object");
                break;
            }

            // Spec InstanceofOperator: a callable @@hasInstance method takes
            // the decision (the default lives on Function.prototype).
            MalValue method;
            if (!mal_vm_get_property(callable->vm, right, mal_intrinsic_symbol_key(callable->vm, MAL_INTRINSIC_SYMBOL_HAS_INSTANCE), &method)) {
                break;
            }

            if (mal_value_is_callable(method)) {
                MalCompletion completion = mal_vm_call_value(callable->vm, method, right, &left, 1);
                if (completion.kind == MAL_COMPLETION_NORMAL) {
                    callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(mal_value_is_truthy(completion.value));
                }
                break;
            }

            if (!mal_value_is_callable(right)) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Right-hand side of 'instanceof' is not callable");
                break;
            }

            callable->registers[instruction->as.binary.dst] = mal_value_new_boolean(
                mal_vm_ordinary_has_instance(callable->vm, right, left)
            );
            break;
        }
    }
}

static const byte *mal_vm_typeof_tag(MalValue value) {
    if (mal_value_is_undefined(value)) {
        return "undefined";
    }
    if (mal_value_is_null(value)) {
        return "object";
    }
    if (mal_value_is_boolean(value)) {
        return "boolean";
    }
    if (mal_value_is_string(value)) {
        return "string";
    }
    if (mal_value_is_symbol(value)) {
        return "symbol";
    }
    if (mal_value_is_callable(value)) {
        return "function";
    }
    if (mal_value_is_object(value)) {
        return "object";
    }

    return "number";
}

void mal_op_unary(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = callable->registers[instruction->as.unary.src];
    i32 dst = instruction->as.unary.dst;

    switch (instruction->as.unary.op) {
        case MAL_UNARY_NOT:
            callable->registers[dst] = mal_value_new_boolean(!mal_value_is_truthy(value));
            break;
        case MAL_UNARY_NEGATE:
            if (mal_value_is_int32(value) && mal_value_to_i32(value) != 0 && mal_value_to_i32(value) != INT32_MIN) {
                callable->registers[dst] = mal_value_from_i32(-mal_value_to_i32(value));
            } else {
                // Keeps -0 and -INT32_MIN exact by going through f64.
                callable->registers[dst] = mal_value_from_f64_convert_nan(-mal_ops_to_number(value));
            }
            break;
        case MAL_UNARY_PLUS:
            callable->registers[dst] = mal_ops_number_value(mal_ops_to_number(value));
            break;
        case MAL_UNARY_BIT_NOT:
            callable->registers[dst] = mal_ops_bit_xor(value, mal_value_from_i32(-1));
            break;
        case MAL_UNARY_TYPEOF: {
            const byte *tag = mal_vm_typeof_tag(value);
            usize length = 0;
            while (tag[length] != '\0') {
                length++;
            }
            callable->registers[dst] = mal_value_from_string(mal_string_new_ascii(&callable->vm->heap, tag, length));
            break;
        }
    }
}

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction) {
    callable->vm->globals[instruction->as.store_global.index] = callable->registers[instruction->as.store_global.src];
}

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_global.dst] = callable->vm->globals[instruction->as.load_global.index];
}

void mal_op_load_intrinsic(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_intrinsic.dst] = callable->vm->intrinsics[instruction->as.load_intrinsic.intrinsic];
}

static bool mal_vm_key_is_prototype(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    static const byte expected[] = "prototype";
    if (mal_string_length(string) != lengthof(expected)) {
        return false;
    }

    const c16 *code_units = mal_string_code_units(string);
    for (usize i = 0; i < lengthof(expected); i++) {
        if (code_units[i] != (c16) expected[i]) {
            return false;
        }
    }

    return true;
}

/**
 * Whether a function object is a generator (its definition's kind).
 */
static bool mal_vm_function_is_generator(MalVm *vm, MalValue function_value) {
    if (!mal_value_is_function_object(function_value)) {
        return false;
    }

    i32 index = mal_function_object_function_index(mal_value_to_function_object(function_value));
    return vm->definition->functions[index].kind == MAL_FUNCTION_KIND_GENERATOR;
}

/**
 * Script functions get their prototype property created lazily on first use.
 * Ordinary functions get the spec-mandated constructor back reference and an
 * %Object.prototype%-backed object; generator functions get a
 * %GeneratorPrototype%-backed object with no constructor.
 */
static MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value) {
    MalObject *function = mal_value_to_object(function_value);
    MalKey key = mal_intrinsic_string_key(vm, "prototype");

    MalPropertyLookup lookup = mal_object_get_own(function, key);
    if (lookup.present) {
        return lookup.desc.value;
    }

    bool is_generator = mal_vm_function_is_generator(vm, function_value);
    MalObject *parent = mal_value_to_object(
        vm->intrinsics[is_generator ? MAL_INTRINSIC_GENERATOR_PROTOTYPE : MAL_INTRINSIC_OBJECT_PROTOTYPE]
    );
    MalObject *prototype = mal_object_new(&vm->heap, parent);
    if (!is_generator) {
        mal_intrinsic_define_data(vm, prototype, "constructor", function_value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_from_object(prototype), MAL_PROPERTY_WRITABLE);
    mal_object_define_own(function, key, &desc);
    return desc.value;
}

static bool mal_vm_key_is_name(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    const c16 *code_units = mal_string_code_units(string);
    return mal_string_length(string) == 4 &&
        code_units[0] == 'n' &&
        code_units[1] == 'a' &&
        code_units[2] == 'm' &&
        code_units[3] == 'e';
}

static bool mal_vm_value_is_number(MalValue value) {
    return mal_value_is_int32(value) || mal_value_is_f64_or_nan(value) || value == MAL_VALUE_NEGATIVE_ZERO;
}

/**
 * Resolve the synthetic properties that have no backing slot in the ordinary
 * property tables: array length, callable length/name, and the lazily
 * materialized script function prototype. Shared by load, `in`, and delete so
 * the three operators agree on what exists.
 */
static bool mal_vm_resolve_synthetic_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *value_out) {
    if (mal_value_is_array_object(object_value) && mal_array_key_is_length(key)) {
        *value_out = mal_value_from_i32((i32) mal_array_object_length(mal_value_to_array_object(object_value)));
        return true;
    }

    if (mal_value_is_callable(object_value)) {
        if (mal_array_key_is_length(key)) {
            *value_out = mal_value_from_i32(mal_vm_callable_length(vm, object_value));
            return true;
        }

        if (mal_vm_key_is_name(key)) {
            MalString *name = mal_vm_callable_name(vm, object_value);
            *value_out = name != nullptr ? mal_value_from_string(name) : mal_value_new_undefined();
            return true;
        }

        if (mal_value_is_function_object(object_value) && mal_vm_key_is_prototype(key)) {
            *value_out = mal_vm_function_prototype(vm, object_value);
            return true;
        }
    }

    return false;
}

static bool mal_vm_get_from_prototype_slot(MalVm *vm, MalIntrinsic prototype_slot, MalValue receiver, MalKey key, MalValue *out) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(vm->intrinsics[prototype_slot]),
        key
    );
    if (!resolution.found) {
        *out = mal_value_new_undefined();
        return true;
    }

    return mal_vm_desc_read(vm, resolution.desc, receiver, out);
}

bool mal_vm_get_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *out) {
    *out = mal_value_new_undefined();

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return false;
    }

    // Primitive receivers resolve against their prototype intrinsic, with
    // string length and index reads answered by the string itself.
    if (!mal_value_is_object(object_value)) {
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key)) {
                *out = mal_value_from_i32((i32) mal_string_length(string));
                return true;
            }

            if (key.kind == MAL_KEY_INDEX) {
                i32 index = mal_value_to_i32(key.value);
                if (index >= 0 && (usize) index < mal_string_length(string)) {
                    // The borrowed code units stay alive with the source string.
                    *out = mal_value_from_string(
                        mal_string_new_external(&vm->heap, mal_string_code_units(string) + index, 1)
                    );
                }
                return true;
            }

            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_STRING_PROTOTYPE, object_value, key, out);
        }

        if (mal_vm_value_is_number(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_NUMBER_PROTOTYPE, object_value, key, out);
        }

        if (mal_value_is_boolean(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, object_value, key, out);
        }

        if (mal_value_is_symbol(object_value)) {
            return mal_vm_get_from_prototype_slot(vm, MAL_INTRINSIC_SYMBOL_PROTOTYPE, object_value, key, out);
        }

        return true;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, object_value, key, &synthetic)) {
        *out = synthetic;
        return true;
    }

    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (!resolution.found) {
        return true;
    }

    return mal_vm_desc_read(vm, resolution.desc, object_value, out);
}

bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value) {
    // Bound functions defer to their wrapped target.
    while (mal_value_is_bound_function_object(target)) {
        target = mal_value_to_bound_function_object(target)->target;
    }

    if (!mal_value_is_callable(target)) {
        return false;
    }

    // Non-object values answer false before the prototype read.
    if (!mal_value_is_object(value)) {
        return false;
    }

    MalKey key = mal_intrinsic_string_key(vm, "prototype");
    MalValue prototype_value = mal_value_new_undefined();
    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(vm, target, key, &synthetic)) {
        prototype_value = synthetic;
    } else if (mal_value_is_object(target)) {
        MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(target), key);
        if (resolution.found) {
            prototype_value = resolution.desc.value;
        }
    }

    if (!mal_value_is_object(prototype_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function has non-object prototype in instanceof check");
        return false;
    }

    MalObject *prototype = mal_value_to_object(prototype_value);
    for (MalObject *walk = mal_object_get_prototype(mal_value_to_object(value));
         walk != nullptr;
         walk = mal_object_get_prototype(walk)) {
        if (walk == prototype) {
            return true;
        }
    }

    return false;
}

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.load_property.object];
    MalValue key_value = callable->registers[instruction->as.load_property.key];
    i32 dst = instruction->as.load_property.dst;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    MalValue value;
    if (mal_vm_get_property(callable->vm, object_value, key, &value)) {
        callable->registers[dst] = value;
    }
}

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_property.object];
    MalValue key_value = callable->registers[instruction->as.store_property.key];
    MalValue value = callable->registers[instruction->as.store_property.value];
    bool strict = callable->function->strict;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // Primitives never grow own properties; strict assignments throw.
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    // Accessor properties anywhere on the prototype chain take the write.
    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        if (!mal_value_is_callable(resolution.desc.setter)) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
            }
            return;
        }

        MalCompletion completion = mal_vm_call_value(callable->vm, resolution.desc.setter, object_value, &value, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            callable->vm->completion = completion;
        }
        return;
    }

    // Callable length and name are synthetic and non-writable; the prototype
    // slot stays writable through the ordinary set below.
    if (mal_value_is_callable(object_value) &&
        (mal_array_key_is_length(key) || mal_vm_key_is_name(key))) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
        }
        return;
    }

    bool stored;
    if (mal_value_is_array_object(object_value)) {
        stored = mal_array_object_store(mal_value_to_array_object(object_value), key, value);
    } else {
        stored = mal_object_set(mal_value_to_object(object_value), key, value);
    }

    if (!stored && strict) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
    }
}

void mal_op_store_super_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_super_property.object];
    MalValue key_value = callable->registers[instruction->as.store_super_property.key];
    MalValue value = callable->registers[instruction->as.store_super_property.value];
    MalValue receiver = callable->registers[instruction->as.store_super_property.receiver];
    bool strict = callable->function->strict;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    // OrdinarySetWithOwnDescriptor: the super base chain provides the
    // controlling descriptor, the write applies to the receiver.
    if (mal_value_is_object(object_value)) {
        MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);

        if (resolution.found && (resolution.desc.flags & MAL_PROPERTY_ACCESSOR)) {
            if (!mal_value_is_callable(resolution.desc.setter)) {
                if (strict) {
                    mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set property which has only a getter");
                }
                return;
            }

            MalCompletion completion = mal_vm_call_value(callable->vm, resolution.desc.setter, receiver, &value, 1);
            if (completion.kind != MAL_COMPLETION_NORMAL) {
                callable->vm->completion = completion;
            }
            return;
        }

        if (resolution.found && !(resolution.desc.flags & MAL_PROPERTY_WRITABLE)) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
            }
            return;
        }
    }

    if (!mal_value_is_object(receiver)) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot create property on a primitive");
        }
        return;
    }

    MalObject *receiver_object = mal_value_to_object(receiver);
    MalPropertyLookup own = mal_object_get_own(receiver_object, key);
    if (own.present) {
        bool rejected = (own.desc.flags & MAL_PROPERTY_ACCESSOR) ||
            !(own.desc.flags & MAL_PROPERTY_WRITABLE);
        if (rejected) {
            if (strict) {
                mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read only property");
            }
            return;
        }

        own.desc.value = value;
        mal_object_define_own(receiver_object, key, &own.desc);
        return;
    }

    if (!mal_object_is_extensible(receiver_object)) {
        if (strict) {
            mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot add property to a non-extensible object");
        }
        return;
    }

    // CreateDataProperty on the receiver, ignoring its inherited properties.
    mal_property_set_value(mal_object_properties(receiver_object), key, value);
}

void mal_op_get_iterator(MalCallable *callable, MalInstruction *instruction) {
    MalValue source = callable->registers[instruction->as.get_iterator.source];

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(callable->vm, source, &record)) {
        return;
    }

    callable->registers[instruction->as.get_iterator.iterator_dst] = record.iterator;
    callable->registers[instruction->as.get_iterator.next_dst] = record.next_method;
}

void mal_op_iterator_step(MalCallable *callable, MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_step.iterator],
        .next_method = callable->registers[instruction->as.iterator_step.next],
    };

    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(callable->vm, &record, &value, &done)) {
        return;
    }

    callable->registers[instruction->as.iterator_step.value_dst] = value;
    callable->registers[instruction->as.iterator_step.done_dst] = mal_value_new_boolean(done);
}

void mal_op_iterator_close(MalCallable *callable, MalInstruction *instruction) {
    MalIteratorRecord record = {
        .iterator = callable->registers[instruction->as.iterator_close.iterator],
        .next_method = mal_value_new_undefined(),
    };

    mal_vm_iterator_close(callable->vm, &record);
}

static MalValue mal_vm_for_in_key_string(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }

    return key.value;
}

void mal_op_for_in_keys(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.for_in_keys.source];

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    // for-in over null/undefined performs no iteration.
    if (mal_value_is_nil(source)) {
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // Strings expose their characters as enumerable index properties; without a
    // wrapper object we synthesize the index keys directly.
    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)},
                mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) i)))
            );
            count++;
        }
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // Numbers, booleans, and symbols have no enumerable own properties.
    if (!mal_value_is_object(source)) {
        callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
        return;
    }

    // EnumerateObjectProperties: walk the prototype chain visiting each string
    // key once. A key seen on a nearer object shadows the same key further up,
    // even when the nearer one is non-enumerable, so the shadow set records
    // every own key regardless of enumerability. A throwaway object reuses the
    // table's key equality for the set.
    MalObject *seen = mal_intrinsic_new_object(vm);
    MalPropertyDesc marker = mal_intrinsic_data_desc(mal_value_new_undefined(), 0);

    for (MalObject *current = mal_value_to_object(source); current != nullptr;
         current = mal_object_get_prototype(current)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, current, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            // Symbol keys are not enumerated by for-in.
            if (key.kind == MAL_KEY_SYMBOL) {
                continue;
            }

            if (mal_object_get_own(seen, key).present) {
                continue;
            }
            mal_object_define_own(seen, key, &marker);

            if (!(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
                continue;
            }

            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)},
                mal_vm_for_in_key_string(vm, key)
            );
            count++;
        }
    }

    callable->registers[instruction->as.for_in_keys.dst] = mal_value_from_array_object(result);
}

void mal_op_load_prototype(MalCallable *callable, MalInstruction *instruction) {
    MalValue value = callable->registers[instruction->as.load_prototype.object];
    MalValue result = mal_value_new_null();

    if (mal_value_is_object(value)) {
        MalObject *prototype = mal_object_get_prototype(mal_value_to_object(value));
        if (prototype != nullptr) {
            result = mal_value_from_object(prototype);
        }
    }

    callable->registers[instruction->as.load_prototype.dst] = result;
}

/**
 * Store a delete result, upgrading failures to the strict-mode TypeError.
 */
static void mal_vm_finish_delete(MalCallable *callable, i32 dst, bool deleted) {
    if (!deleted && callable->function->strict) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot delete property");
        return;
    }

    callable->registers[dst] = mal_value_new_boolean(deleted);
}

void mal_op_delete_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.delete_property.object];
    MalValue key_value = callable->registers[instruction->as.delete_property.key];
    i32 dst = instruction->as.delete_property.dst;

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert undefined or null to object");
        return;
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        callable->registers[dst] = mal_value_new_boolean(true);
        return;
    }

    if (!mal_value_is_object(object_value)) {
        // The only own properties a primitive can carry live on strings:
        // length and the in-range indices, all non-configurable.
        bool deleted = true;
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key) ||
                (key.kind == MAL_KEY_INDEX && (usize) mal_value_to_i32(key.value) < mal_string_length(string))) {
                deleted = false;
            }
        }

        mal_vm_finish_delete(callable, dst, deleted);
        return;
    }

    MalValue synthetic;
    if (mal_vm_resolve_synthetic_property(callable->vm, object_value, key, &synthetic)) {
        // Synthetic properties have no table slot to remove. Array length and
        // function prototype are non-configurable anyway; callable length and
        // name are approximated as non-deletable. TODO(delete): the spec marks
        // callable length and name configurable.
        mal_vm_finish_delete(callable, dst, false);
        return;
    }

    mal_vm_finish_delete(callable, dst, mal_object_delete_own(mal_value_to_object(object_value), key));
}

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction) {
    const MalStringConstant *constant = &callable->vm->definition->string_constants[instruction->as.load_undeclared.name_string_index];
    MalValue name = mal_value_from_string(mal_string_new_external(&callable->vm->heap, constant->code_units, constant->length));
    MalValue message = mal_ops_add(
        &callable->vm->heap,
        name,
        mal_value_from_string(mal_intrinsic_ascii(callable->vm, " is not defined"))
    );
    mal_vm_throw_error_value(callable->vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, message);
}

void mal_op_require_coercible(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_nil(callable->registers[instruction->as.require_coercible.src])) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
    }
}

void mal_op_create_rest_arguments(MalCallable *callable, MalInstruction *instruction) {
    i32 start = instruction->as.create_rest_arguments.start_index;
    i32 count = callable->argument_count > start ? callable->argument_count - start : 0;

    MalArrayObject *rest = mal_array_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(rest, (u32) count);

    for (i32 i = 0; i < count; i++) {
        mal_object_set(
            (MalObject *) rest,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(i)},
            callable->arguments[start + i]
        );
    }

    callable->registers[instruction->as.create_rest_arguments.dst] = mal_value_from_array_object(rest);
}

void mal_op_array_rest(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.array_rest.src];
    u32 start = (u32) instruction->as.array_rest.start_index;

    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return;
    }

    // Index-read approximation of the spec's iterator protocol, mirroring the
    // pattern's positional element reads (TODO(iterators)).
    u32 length;
    if (!mal_builtin_array_this_length(vm, source, &length)) {
        return;
    }

    u32 count = length > start ? length - start : 0;
    MalArrayObject *rest = mal_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])
    );
    mal_array_object_set_length(rest, count);

    for (u32 i = 0; i < count; i++) {
        // Holes read as dense undefined elements, like the array iterator
        // yields them.
        MalValue element = mal_value_new_undefined();
        if (!mal_builtin_array_try_get(vm, source, start + i, &element) &&
            vm->completion.kind == MAL_COMPLETION_THROW) {
            return;
        }

        mal_object_set(
            (MalObject *) rest,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)},
            element
        );
    }

    callable->registers[instruction->as.array_rest.dst] = mal_value_from_array_object(rest);
}

void mal_op_copy_data_properties(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue source = callable->registers[instruction->as.copy_data_properties.src];

    if (mal_value_is_nil(source)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot destructure null or undefined");
        return;
    }

    // The excluded keys land in a throwaway object so the membership checks
    // reuse the property table's key equality.
    MalObject *excluded = nullptr;
    i32 excluded_count = instruction->as.copy_data_properties.excluded_count;
    if (excluded_count > 0) {
        excluded = mal_object_new(&vm->heap, nullptr);
        for (i32 i = 0; i < excluded_count; i++) {
            MalValue key_value = callable->registers[instruction->as.copy_data_properties.excluded[i]];

            MalKey key;
            if (!mal_vm_value_to_property_key(vm, key_value, &key)) {
                return;
            }

            mal_object_set(excluded, key, mal_value_new_boolean(true));
        }
    }

    MalObject *copy = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );

    if (mal_value_is_string(source)) {
        // String sources expose their code units as own enumerable index
        // properties.
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
            if (excluded != nullptr && mal_object_get_own(excluded, key).present) {
                continue;
            }

            mal_object_set(
                copy,
                key,
                mal_value_from_string(mal_string_new_external(&vm->heap, mal_string_code_units(string) + i, 1))
            );
        }
    } else if (mal_value_is_object(source)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (excluded != nullptr && mal_object_get_own(excluded, key).present) {
                continue;
            }

            MalValue value;
            if (!mal_vm_desc_read(vm, desc, source, &value)) {
                return;
            }

            mal_object_set(copy, key, value);
        }
    }
    // Other primitives carry no own enumerable properties.

    callable->registers[instruction->as.copy_data_properties.dst] = mal_value_from_object(copy);
}

void mal_op_merge_data_properties(MalCallable *callable, MalInstruction *instruction) {
    MalVm *vm = callable->vm;
    MalValue target_value = callable->registers[instruction->as.merge_data_properties.target];
    MalValue source = callable->registers[instruction->as.merge_data_properties.src];

    // Spreading null/undefined contributes nothing.
    if (mal_value_is_nil(source)) {
        return;
    }

    MalObject *target = mal_value_to_object(target_value);

    if (mal_value_is_string(source)) {
        MalString *string = mal_value_to_string(source);
        for (usize i = 0; i < mal_string_length(string); i++) {
            MalPropertyDesc desc = mal_intrinsic_data_desc(
                mal_value_from_string(mal_string_new_external(&vm->heap, mal_string_code_units(string) + i, 1)),
                MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
            );
            mal_object_define_own(target, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}, &desc);
        }
        return;
    }

    if (!mal_value_is_object(source)) {
        return;
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(source), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        MalValue value;
        if (!mal_vm_desc_read(vm, desc, source, &value)) {
            return;
        }

        // CreateDataProperty: own enumerable data property, no inherited setters.
        MalPropertyDesc data = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(target, key, &data);
    }
}

void mal_op_define_accessor(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.define_accessor.object];
    MalValue key_value = callable->registers[instruction->as.define_accessor.key];
    MalValue accessor = callable->registers[instruction->as.define_accessor.accessor];

    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    MalObject *object = mal_value_to_object(object_value);

    // Merge into an existing own accessor so get/set pairs land in a single
    // descriptor; literal definitions are enumerable, class ones are not.
    MalPropertyFlags flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE;
    if (instruction->as.define_accessor.enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_new_undefined(), flags);
    MalPropertyLookup existing = mal_object_get_own(object, key);
    if (existing.present && (existing.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        desc = existing.desc;
    }

    if (instruction->as.define_accessor.is_setter) {
        desc.setter = accessor;
    } else {
        desc.getter = accessor;
    }

    mal_object_define_own(object, key, &desc);
}

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.define_property.object];
    MalValue key_value = callable->registers[instruction->as.define_property.key];
    MalValue value = callable->registers[instruction->as.define_property.value];

    MalKey key;
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    if (instruction->as.define_property.enumerable) {
        flags |= MAL_PROPERTY_ENUMERABLE;
    }

    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(mal_value_to_object(object_value), key, &desc);
}

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.set_prototype.object];
    MalValue prototype_value = callable->registers[instruction->as.set_prototype.prototype];

    if (!mal_value_is_object(object_value)) {
        return;
    }

    if (instruction->as.set_prototype.literal &&
        !mal_value_is_object(prototype_value) && !mal_value_is_null(prototype_value)) {
        // B.3.1: object literal `__proto__:` members ignore other values.
        return;
    }

    MalObject *prototype = mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value) : nullptr;
    mal_object_set_prototype(mal_value_to_object(object_value), prototype);
}

void mal_op_jump(MalCallable *callable, MalInstruction *instruction) {
    callable->instruction_pointer = instruction->as.jump.target_ip;
}

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_truthy(callable->registers[instruction->as.jump_if.cond])) {
        callable->instruction_pointer = instruction->as.jump_if.target_ip;
    }
}
