#pragma once

#include "./defaults.h"
#include "table.h"
#include "vm.h"

/**
 * Normalize a value into a property key, converting canonical numeric strings
 * to index keys and non-key values through ToString.
 */
bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

void mal_op_move(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_f64(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_boolean(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_call(MalCallable *callable, MalInstruction *instruction);

void mal_op_construct(MalCallable *callable, MalInstruction *instruction);

void mal_op_throw(MalCallable *callable, MalInstruction *instruction);

void mal_op_catch(MalCallable *callable, MalInstruction *instruction);

void mal_op_binary(MalCallable *callable, MalInstruction *instruction);

void mal_op_unary(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_intrinsic(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction);
