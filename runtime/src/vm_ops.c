#include "vm_ops.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "function_object.h"
#include "heap_string.h"
#include "object_ops.h"
#include "value_ops.h"

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
    MalFunctionObject *function = mal_function_object_new(
        &callable->vm->heap,
        mal_value_to_object(callable->vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        instruction->as.create_function.function_index
    );

    callable->registers[instruction->as.create_function.dst] = mal_value_from_function_object(function);
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

    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, this_value, arguments, argument_count, true);

    if (mal_value_is_function_object(resolution.callee)) {
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            resolution.this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        // The callback may push frames and realloc the frame array, which
        // invalidates `callable`. Snapshot what we need and re-resolve the
        // frame afterwards.
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, resolution.this_value, resolution.args, resolution.arg_count);
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a function");
    }

    free(resolution.owned_args);
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

    // The bound this is ignored when constructing.
    MalBoundResolution resolution = mal_bound_function_object_resolve(callee, mal_value_new_undefined(), arguments, argument_count, false);

    if (mal_value_is_function_object(resolution.callee)) {
        // Create this from the callee's prototype property.
        MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
        MalPropertyLookup lookup = mal_object_get_own(
            (MalObject *) mal_value_to_function_object(resolution.callee),
            mal_intrinsic_string_key(vm, "prototype")
        );
        if (lookup.present && mal_value_is_object(lookup.desc.value)) {
            prototype = mal_value_to_object(lookup.desc.value);
        }

        MalValue this_value = mal_value_from_object(mal_object_new(&vm->heap, prototype));
        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(resolution.callee));
        mal_vm_push_function_frame(
            vm,
            function_index,
            this_value,
            resolution.args,
            resolution.arg_count,
            dst,
            vm->frame_count - 1
        );
        vm->frames[vm->frame_count - 1].is_construct = true;
    } else if (mal_value_is_native_function_object(resolution.callee)) {
        // Construct and call behave the same for the native constructors.
        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(resolution.callee)
        );
        i32 caller_frame_index = vm->frame_count - 1;
        MalValue result = callback(vm, mal_value_new_undefined(), resolution.args, resolution.arg_count);
        vm->frames[caller_frame_index].registers[dst] = result;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a constructor");
    }

    free(resolution.owned_args);
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

static void mal_vm_load_from_prototype_slot(MalCallable *callable, MalIntrinsic prototype_slot, MalKey key, i32 dst) {
    MalPropertyResolution resolution = mal_object_resolve_property(
        mal_value_to_object(callable->vm->intrinsics[prototype_slot]),
        key
    );
    callable->registers[dst] = resolution.found ? resolution.desc.value : mal_value_new_undefined();
}

static bool mal_vm_value_is_number(MalValue value) {
    return mal_value_is_int32(value) || mal_value_is_f64_or_nan(value) || value == MAL_VALUE_NEGATIVE_ZERO;
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

    // Primitive receivers resolve against their prototype intrinsic, with
    // string length and index reads answered by the string itself.
    if (!mal_value_is_object(object_value)) {
        if (mal_value_is_string(object_value)) {
            MalString *string = mal_value_to_string(object_value);
            if (mal_array_key_is_length(key)) {
                callable->registers[dst] = mal_value_from_i32((i32) mal_string_length(string));
                return;
            }

            if (key.kind == MAL_KEY_INDEX) {
                i32 index = mal_value_to_i32(key.value);
                if (index >= 0 && (usize) index < mal_string_length(string)) {
                    // The borrowed code units stay alive with the source string.
                    callable->registers[dst] = mal_value_from_string(
                        mal_string_new_external(&callable->vm->heap, mal_string_code_units(string) + index, 1)
                    );
                } else {
                    callable->registers[dst] = mal_value_new_undefined();
                }
                return;
            }

            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_STRING_PROTOTYPE, key, dst);
            return;
        }

        if (mal_vm_value_is_number(object_value)) {
            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_NUMBER_PROTOTYPE, key, dst);
            return;
        }

        if (mal_value_is_boolean(object_value)) {
            mal_vm_load_from_prototype_slot(callable, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, key, dst);
            return;
        }

        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    if (mal_value_is_array_object(object_value) && mal_array_key_is_length(key)) {
        callable->registers[dst] = mal_value_from_i32((i32) mal_array_object_length(mal_value_to_array_object(object_value)));
        return;
    }

    if (mal_value_is_callable(object_value)) {
        if (mal_array_key_is_length(key)) {
            callable->registers[dst] = mal_value_from_i32(mal_vm_callable_length(callable->vm, object_value));
            return;
        }

        if (mal_vm_key_is_name(key)) {
            MalString *name = mal_vm_callable_name(callable->vm, object_value);
            callable->registers[dst] = name != nullptr ? mal_value_from_string(name) : mal_value_new_undefined();
            return;
        }
    }

    MalPropertyResolution resolution = mal_object_resolve_property(mal_value_to_object(object_value), key);
    if (!resolution.found) {
        callable->registers[dst] = mal_value_new_undefined();
        return;
    }

    callable->registers[dst] = resolution.desc.value;
}

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction) {
    MalValue object_value = callable->registers[instruction->as.store_property.object];
    MalValue key_value = callable->registers[instruction->as.store_property.key];
    MalValue value = callable->registers[instruction->as.store_property.value];

    if (mal_value_is_nil(object_value)) {
        mal_vm_throw_error(callable->vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot set properties of null or undefined");
        return;
    }

    MalKey key;
    // Stores on other primitives are silently ignored, like sloppy mode.
    if (!mal_value_is_object(object_value) || !mal_vm_value_to_property_key(callable->vm, key_value, &key)) {
        return;
    }

    if (mal_value_is_array_object(object_value)) {
        mal_array_object_store(mal_value_to_array_object(object_value), key, value);
        return;
    }

    mal_object_set(mal_value_to_object(object_value), key, value);
}

void mal_op_jump(MalCallable *callable, MalInstruction *instruction) {
    callable->instruction_pointer = instruction->as.jump.target_ip;
}

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_truthy(callable->registers[instruction->as.jump_if.cond])) {
        callable->instruction_pointer = instruction->as.jump_if.target_ip;
    }
}
