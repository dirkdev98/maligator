#include <stdio.h>

#include "value.h"
#include "value_ops.h"
#include "vm.h"

static const MalInstruction mal_function_0_instructions[] = {
    {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 0, .value = 1}},
    {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 1, .value = 2}},
    {.opcode = MAL_OP_CREATE_NUMBER, .as.create_number = {.dst = 2, .value = 3}},
    {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 3, .left = 1, .right = 2, .op = MAL_BIN_MUL}},
    {.opcode = MAL_OP_BINARY, .as.binary = {.dst = 1, .left = 0, .right = 3, .op = MAL_BIN_ADD}},
    {.opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = {.dst = 3}},
    {.opcode = MAL_OP_RETURN, .as.ret = {.value = 3}},
};

static const MalFunction mal_functions[] = {
    {
        .parameter_count = 0,
        .register_count = 4,
        .captured_count = 0,
        .instruction_count = 7,
        .instructions = mal_function_0_instructions,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 1,
    .functions = mal_functions,
    .global_count = 0,
};

int main(void) {
    auto i = mal_value_from_i32(1500);
    printf("\n");

    return 0;
}
