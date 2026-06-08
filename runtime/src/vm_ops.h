#pragma once

#include "./defaults.h"
#include "table.h"
#include "vm.h"

/**
 * Normalize a value into a property key, converting canonical numeric strings
 * to index keys and non-key values through ToString.
 */
bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

/**
 * Read a resolved descriptor's value, invoking accessor getters with the
 * original receiver. Returns false when the getter threw; the throw
 * completion is left on the vm for the caller to propagate.
 */
bool mal_vm_desc_read(MalVm *vm, MalPropertyDesc desc, MalValue receiver, MalValue *out);

/**
 * Spec-flavored Get(receiver, key) over any value: nil receivers throw,
 * primitives resolve against their prototype intrinsics (string length and
 * index reads answered by the string itself), synthetic properties and
 * accessors are honored. Returns false when something threw; the missing
 * property reads as undefined.
 */
bool mal_vm_get_property(MalVm *vm, MalValue object_value, MalKey key, MalValue *out);

/**
 * Spec OrdinaryHasInstance: non-callable targets answer false, bound
 * functions unwrap to their target, then the value's prototype chain is
 * walked looking for target.prototype. Shared by the instanceof operator
 * and %Function.prototype%[Symbol.hasInstance].
 */
bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value);

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

void mal_op_load_this(MalCallable *callable, MalInstruction *instruction);

void mal_op_call(MalCallable *callable, MalInstruction *instruction);

void mal_op_call_spread(MalCallable *callable, MalInstruction *instruction);

void mal_op_construct(MalCallable *callable, MalInstruction *instruction);

void mal_op_construct_spread(MalCallable *callable, MalInstruction *instruction);

void mal_op_throw(MalCallable *callable, MalInstruction *instruction);

void mal_op_catch(MalCallable *callable, MalInstruction *instruction);

void mal_op_binary(MalCallable *callable, MalInstruction *instruction);

void mal_op_unary(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_intrinsic(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_captured(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_captured(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_super_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_prototype(MalCallable *callable, MalInstruction *instruction);

void mal_op_get_iterator(MalCallable *callable, MalInstruction *instruction);

void mal_op_iterator_step(MalCallable *callable, MalInstruction *instruction);

void mal_op_iterator_close(MalCallable *callable, MalInstruction *instruction);

void mal_op_delete_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_accessor(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction);

void mal_op_require_coercible(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_rest_arguments(MalCallable *callable, MalInstruction *instruction);

void mal_op_array_rest(MalCallable *callable, MalInstruction *instruction);

void mal_op_copy_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_merge_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction);
