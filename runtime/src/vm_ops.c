#include "vm_ops.h"

#include "value_ops.h"

void mal_op_move(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.move.dst] = callable->registers[instruction->as.move.src];
}

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_new_undefined();
}

void mal_op_binary(MalCallable *callable, MalInstruction *instruction) {
    auto left = callable->registers[instruction->as.binary.left];
    auto right = callable->registers[instruction->as.binary.right];

    switch (instruction->as.binary.op) {
        case MAL_BIN_ADD:
            callable->registers[instruction->as.binary.dst] = mal_ops_add(left, right);
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
