#include "vm.h"

#include <stdio.h>
#include <stdlib.h>

#include "function_object.h"
#include "intrinsics.h"
#include "vm_ops.h"

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition) {
    vm->definition = definition;
    vm->globals = malloc(sizeof(MalValue) * definition->global_count);
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;

    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    mal_heap_init(&vm->heap, 0);
    for (i32 i = 0; i < definition->global_count; i++) {
        vm->globals[i] = mal_value_new_undefined();
    }
    for (i32 i = 0; i < MAL_INTRINSIC_COUNT; i++) {
        vm->intrinsics[i] = mal_value_new_undefined();
    }
    mal_intrinsics_init(vm);
}

void mal_vm_free(MalVm *vm) {
    for (i32 i = 0; i < vm->frame_count; i++) {
        free(vm->frames[i].registers);
        free(vm->frames[i].arguments);
    }

    free(vm->frames);
    free(vm->globals);
    mal_heap_free(&vm->heap);

    vm->definition = nullptr;
    vm->globals = nullptr;
    vm->frames = nullptr;
    vm->frame_count = 0;
    vm->frame_capacity = 0;
}

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index) {
    MalCallable *callable = malloc(sizeof(MalCallable));

    callable->vm = vm;
    callable->function = &vm->definition->functions[function_index];
    callable->registers = malloc(sizeof(MalValue) * callable->function->register_count);
    callable->arguments = nullptr;
    callable->argument_count = 0;
    callable->this_value = mal_value_new_undefined();
    callable->arguments_object = mal_value_new_undefined();
    callable->instruction_pointer = 0;
    callable->return_register = -1;
    callable->caller_frame_index = -1;

    return callable;
}

void mal_vm_free_callable(MalCallable *callable) {
    free(callable->registers);
    free(callable->arguments);
    free(callable);
}

void mal_vm_push_function_frame(
    MalVm *vm,
    i32 function_index,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    i32 return_register,
    i32 caller_frame_index
) {
    if (vm->frame_count == vm->frame_capacity) {
        vm->frame_capacity = vm->frame_capacity == 0 ? 8 : vm->frame_capacity * 2;
        vm->frames = realloc(vm->frames, sizeof(MalVmFrame) * vm->frame_capacity);
    }

    const MalFunction *function = &vm->definition->functions[function_index];
    MalVmFrame *frame = &vm->frames[vm->frame_count++];

    frame->vm = vm;
    frame->function = function;
    frame->registers = malloc(sizeof(MalValue) * function->register_count);
    frame->arguments = arg_count > 0 ? malloc(sizeof(MalValue) * arg_count) : nullptr;
    frame->argument_count = arg_count;
    frame->this_value = this_value;
    frame->arguments_object = mal_value_new_undefined();
    frame->instruction_pointer = 0;
    frame->return_register = return_register;
    frame->caller_frame_index = caller_frame_index;

    for (i32 i = 0; i < function->register_count; i++) {
        frame->registers[i] = mal_value_new_undefined();
    }

    for (i32 i = 0; i < function->parameter_count; i++) {
        frame->registers[i] = i < arg_count ? args[i] : mal_value_new_undefined();
    }

    for (i32 i = 0; i < arg_count; i++) {
        frame->arguments[i] = args[i];
    }
}

static void mal_vm_run_until_frame_count(MalVm *vm, i32 target_frame_count) {
    while (vm->frame_count > target_frame_count && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalVmFrame *frame = &vm->frames[vm->frame_count - 1];
        auto instruction = frame->function->instructions[frame->instruction_pointer++];

        switch (instruction.opcode) {
            case MAL_OP_MOVE:
                mal_op_move(frame, &instruction);
                break;

            case MAL_OP_CREATE_NUMBER:
                mal_op_create_number(frame, &instruction);
                break;
            case MAL_OP_CREATE_BOOLEAN:
                mal_op_create_boolean(frame, &instruction);
                break;
            case MAL_OP_CREATE_STRING:
                mal_op_create_string(frame, &instruction);
                break;
            case MAL_OP_CREATE_OBJECT:
                mal_op_create_object(frame, &instruction);
                break;
            case MAL_OP_CREATE_ARRAY:
                mal_op_create_array(frame, &instruction);
                break;
            case MAL_OP_CREATE_UNDEFINED:
                mal_op_create_undefined(frame, &instruction);
                break;
            case MAL_OP_CREATE_FUNCTION:
                mal_op_create_function(frame, &instruction);
                break;
            case MAL_OP_CREATE_ARGUMENTS_OBJECT:
                mal_op_create_arguments_object(frame, &instruction);
                break;
            case MAL_OP_BINARY:
                mal_op_binary(frame, &instruction);
                break;

            case MAL_OP_STORE_GLOBAL:
                mal_op_store_global(frame, &instruction);
                break;
            case MAL_OP_LOAD_GLOBAL:
                mal_op_load_global(frame, &instruction);
                break;
            case MAL_OP_LOAD_INTRINSIC:
                mal_op_load_intrinsic(frame, &instruction);
                break;
            case MAL_OP_LOAD_PROPERTY:
                mal_op_load_property(frame, &instruction);
                break;
            case MAL_OP_STORE_PROPERTY:
                mal_op_store_property(frame, &instruction);
                break;

            case MAL_OP_LOAD_CAPTURED:
                frame->registers[instruction.as.load_captured.dst] = mal_value_new_undefined();
                break;
            case MAL_OP_STORE_CAPTURED:
                break;

            case MAL_OP_CALL:
                mal_op_call(frame, &instruction);
                break;

            case MAL_OP_JUMP:
                mal_op_jump(frame, &instruction);
                break;
            case MAL_OP_JUMP_IF:
                mal_op_jump_if(frame, &instruction);
                break;

            case MAL_OP_RETURN: {
                MalValue return_value = frame->registers[instruction.as.ret.value];
                i32 return_register = frame->return_register;
                i32 caller_frame_index = frame->caller_frame_index;
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_RETURN, .value = return_value};

                free(frame->registers);
                free(frame->arguments);
                vm->frame_count--;

                if (caller_frame_index >= 0) {
                    vm->frames[caller_frame_index].registers[return_register] = vm->completion.value;
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = vm->completion.value};
                } else {
                    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = vm->completion.value};
                }
                break;
            }
        }
    }
}

void mal_vm_run(MalVm *vm, MalCallable *callable) {
    mal_vm_push_function_frame(
        vm,
        (i32) (callable->function - vm->definition->functions),
        mal_value_new_undefined(),
        nullptr,
        0,
        -1,
        -1
    );
    mal_vm_run_until_frame_count(vm, 0);
    mal_value_debug(vm->completion.value);
    printf(" returned \n");
}

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (mal_value_is_native_function_object(callee)) {
        MalNativeFunctionCallback callback = mal_native_function_object_callback(mal_value_to_native_function_object(callee));
        MalValue value = callback(vm, this_value, args, arg_count);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return vm->completion;
        }
        return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
    }

    if (!mal_value_is_function_object(callee)) {
        return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }

    i32 target_frame_count = vm->frame_count;
    mal_vm_push_function_frame(
        vm,
        mal_function_object_function_index(mal_value_to_function_object(callee)),
        this_value,
        args,
        arg_count,
        -1,
        -1
    );
    mal_vm_run_until_frame_count(vm, target_frame_count);
    return vm->completion;
}
