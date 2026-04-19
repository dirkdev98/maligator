#include "vm_ops.h"

#include "value_ops.h"

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction) {
    callable->registers[instruction->as.create_number.dst] = mal_value_from_i32(instruction->as.create_number.value);
}

void mal_op_binary(MalCallable *callable, MalInstruction *instruction) {
    auto left = callable->registers[instruction->as.binary.left];
    auto right = callable->registers[instruction->as.binary.right];

    switch (instruction->as.binary.op) {
        case MAL_BIN_ADD:
            callable->registers[instruction->as.binary.dst] = mal_ops_add(left, right);
            break;
        case MAL_BIN_MUL:
            callable->registers[instruction->as.binary.dst] = mal_ops_multiply(left, right);
            break;
    }
}
