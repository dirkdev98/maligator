#pragma once

#include "./defaults.h"
#include "vm.h"

void mal_op_move(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_call(MalCallable *callable, MalInstruction *instruction);

void mal_op_binary(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction);
