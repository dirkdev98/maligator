#include "vm_ops.h"

#include <stdlib.h>

#include "array_object.h"
#include "function_object.h"
#include "object_ops.h"
#include "value_ops.h"

void mal_op_move(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.move.dst] = callable->registers[instruction->as.move.src];
}

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction) {
    const MalStringConstant *constant = &callable->vm->definition->string_constants[instruction->as.create_string.string_index];
    MalString *string = mal_string_new_external(&callable->vm->heap, constant->code_units, constant->length);
    callable->registers[instruction->as.create_string.dst] = mal_value_from_string(string);
}

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_undefined.dst] = mal_value_new_undefined();
}

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction) {
    MalFunctionObject *function = mal_function_object_new(
        &callable->vm->heap,
        nullptr,
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
    MalValue callee = callable->registers[instruction->as.call.callee];
    i32 dst = instruction->as.call.dst;

    if (mal_value_is_function_object(callee)) {
        MalValue *arguments = malloc(sizeof(MalValue) * instruction->as.call.argument_count);
        for (i32 i = 0; i < instruction->as.call.argument_count; i++) {
            arguments[i] = callable->registers[instruction->as.call.arguments[i]];
        }

        i32 function_index = mal_function_object_function_index(mal_value_to_function_object(callee));
        i32 caller_frame_index = callable->vm->frame_count - 1;
        mal_vm_push_function_frame(
            callable->vm,
            function_index,
            arguments,
            instruction->as.call.argument_count,
            dst,
            caller_frame_index
        );
        free(arguments);

        return;
    }

    if (mal_value_is_native_function_object(callee)) {
        MalValue *arguments = malloc(sizeof(MalValue) * instruction->as.call.argument_count);
        for (i32 i = 0; i < instruction->as.call.argument_count; i++) {
            arguments[i] = callable->registers[instruction->as.call.arguments[i]];
        }

        MalNativeFunctionCallback callback = mal_native_function_object_callback(
            mal_value_to_native_function_object(callee)
        );
        callable->registers[dst] = callback(
            callable->vm,
            mal_value_new_undefined(),
            arguments,
            instruction->as.call.argument_count
        );
        free(arguments);

        return;
    }

    callable->registers[dst] = mal_value_new_undefined();
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

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction) {
    callable->vm->globals[instruction->as.store_global.index] = callable->registers[instruction->as.store_global.src];
}

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.load_global.dst] = callable->vm->globals[instruction->as.load_global.index];
}

void mal_op_jump(MalCallable *callable, MalInstruction *instruction) {
    callable->instruction_pointer = instruction->as.jump.target_ip;
}

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction) {
    if (mal_value_is_truthy(callable->registers[instruction->as.jump_if.cond])) {
        callable->instruction_pointer = instruction->as.jump_if.target_ip;
    }
}
