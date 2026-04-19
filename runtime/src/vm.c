#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "vm_ops.h"

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition) {
    vm->definition = definition;
    vm->globals = malloc(sizeof(MalValue) * definition->global_count);
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->definition->functions[function_index];
    callable->registers = malloc(sizeof(MalValue) * callable->function->register_count);
    callable->instruction_pointer = 0;

    return callable;
}

void mal_vm_free_callable(MalCallable *callable) {
    free(callable->registers);
    free(callable);
}

void mal_vm_run(MalVm *vm, MalCallable *callable) {
    while (callable->instruction_pointer < callable->function->instruction_count) {
        auto instruction = callable->function->instructions[callable->instruction_pointer++];

        switch (instruction.opcode) {
            case MAL_OP_CREATE_NUMBER:
                mal_op_create_number(callable, &instruction);
                break;
            case MAL_OP_BINARY:
                mal_op_binary(callable, &instruction);
                break;
            case MAL_OP_RETURN: {
                for (i32 i = 0; i < callable->function->register_count; i++) {
                    printf("Register %d:: ", i);

                    mal_value_debug(callable->registers[i]);
                    printf("\n");
                }
            }
        }
    }
}
