#include <stdio.h>

#include "vm.h"
static const MalInstruction mal_function_0_instructions[] = {
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 1 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 1 } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 0 } },
    { .opcode = MAL_OP_JUMP_IF, .as.jump_if = { .cond = 0, .target_ip = 7 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 10 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 2 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_JUMP, .as.jump = { .target_ip = 10 } },
    { .opcode = MAL_OP_CREATE_NUMBER, .as.create_number = { .dst = 0, .value = 3 } },
    { .opcode = MAL_OP_STORE_GLOBAL, .as.store_global = { .src = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 0, .index = 0 } },
    { .opcode = MAL_OP_LOAD_GLOBAL, .as.load_global = { .dst = 1, .index = 1 } },
    { .opcode = MAL_OP_BINARY, .as.binary = { .dst = 2, .left = 0, .right = 1, .op = MAL_BIN_ADD } },
    { .opcode = MAL_OP_CREATE_UNDEFINED, .as.create_undefined = { .dst = 1 } },
    { .opcode = MAL_OP_RETURN, .as.ret = { .value = 1 } },
};

static const MalFunction mal_functions[] = {
    {
        .parameter_count = 0,
        .register_count = 3,
        .captured_count = 0,
        .instruction_count = 17,
        .instructions = mal_function_0_instructions,
    },
};

const MalVmDefinition mal_vm_definition = {
    .function_count = 1,
    .functions = mal_functions,
    .global_count = 2,
};

int main(void) {
    MalVm vm;

    mal_vm_init(&vm, &mal_vm_definition);
    auto callable = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, callable);

    printf("\n");

    return 0;
}
