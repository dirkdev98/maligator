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
 * mal_vm_get_property with an explicit receiver passed to accessor getters,
 * implementing the spec [[Get]](P, Receiver). Used by Reflect.get.
 */
bool mal_vm_get_property_with_receiver(MalVm *vm, MalValue object_value, MalKey key, MalValue receiver, MalValue *out);

/**
 * Spec HasProperty(O, P) over an object: synthetic properties plus the ordinary
 * prototype chain. Backs the `in` operator and Reflect.has.
 */
bool mal_vm_has_property(MalVm *vm, MalValue object_value, MalKey key);

/**
 * Spec [[Set]] returning the boolean success (no throw on plain rejection); a
 * throwing user setter propagates via vm->completion. Backs Reflect.set.
 */
bool mal_vm_set_property(MalVm *vm, MalValue target, MalKey key, MalValue value, MalValue receiver);

/**
 * Spec [[Delete]] returning the boolean success. Backs the delete operator and
 * Reflect.deleteProperty.
 */
bool mal_vm_delete_property(MalVm *vm, MalValue object_value, MalKey key);

/**
 * Spec ToNumber with full ToPrimitive(number) for objects (@@toPrimitive, else
 * valueOf → toString). Throws TypeError on BigInt/Symbol (or a non-primitive
 * ToPrimitive result) and returns false; otherwise writes the number.
 */
bool mal_vm_to_number(MalVm *vm, MalValue value, f64 *out);

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

void mal_op_create_bigint(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction);
void mal_op_create_module_namespace(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction);
void mal_op_create_empty(MalCallable *callable, MalInstruction *instruction);
void mal_op_throw_if_tdz(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_this(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_new_target(MalCallable *callable, MalInstruction *instruction);

void mal_op_call(MalCallable *callable, MalInstruction *instruction);

void mal_op_call_spread(MalCallable *callable, MalInstruction *instruction);

void mal_op_construct(MalCallable *callable, MalInstruction *instruction);

void mal_op_construct_spread(MalCallable *callable, MalInstruction *instruction);

/**
 * `super(...args)`: [[Construct]] the parent forwarding the derived
 * constructor's new.target, then bind the result as `this`. The parent comes
 * from registers[parent], the arguments from the array in registers[arguments_array].
 */
void mal_op_construct_super(MalCallable *callable, MalInstruction *instruction);

void mal_op_throw(MalCallable *callable, MalInstruction *instruction);

void mal_op_catch(MalCallable *callable, MalInstruction *instruction);

void mal_op_binary(MalCallable *callable, MalInstruction *instruction);

/**
 * Value-returning core of a binary operator, shared by mal_op_binary and the
 * compiled-function backend. Throws (via vm->completion) on bad `in`/
 * `instanceof` operands or BigInt domain errors, returning undefined.
 */
MalValue mal_vm_binary_op(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right);

void mal_op_unary(MalCallable *callable, MalInstruction *instruction);

/**
 * Value-returning core of a unary operator, shared by mal_op_unary and the
 * compiled-function backend. Unary `+` on a BigInt throws via vm->completion.
 */
MalValue mal_vm_unary_op(MalVm *vm, MalUnaryOp op, MalValue value);

void mal_op_store_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_global(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_intrinsic(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_captured(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_captured(MalCallable *callable, MalInstruction *instruction);

/**
 * Read/write a captured binding by walking the environment chain to the owning
 * activation. Shared by the load/store-captured ops and the compiled backend.
 */
MalValue mal_vm_load_captured(MalEnv *env, i32 owner_function_index, i32 index);

void mal_vm_store_captured(MalEnv *env, i32 owner_function_index, i32 index, MalValue value);

void mal_op_load_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_property(MalCallable *callable, MalInstruction *instruction);

/**
 * Value-returning Get / completion-signalling Set with an already-evaluated key
 * value, shared by the load/store-property ops and the compiled backend. A load
 * returns undefined and a store signals through vm->completion on a throw; the
 * compiled caller passes its statically-known strictness to the store.
 */
MalValue mal_vm_op_load_property(MalVm *vm, MalValue object_value, MalValue key_value);

void mal_vm_op_store_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict);

/**
 * Value-returning object/array/closure construction, shared by the create ops
 * and the compiled backend. create_function captures `creation_env` (the
 * creating frame's environment) so the closure resolves captured bindings.
 */
MalValue mal_vm_op_create_object(MalVm *vm);

MalValue mal_vm_op_create_array(MalVm *vm, i32 length);

MalValue mal_vm_op_create_function(MalVm *vm, i32 function_index, MalEnv *creation_env);

/**
 * Define an own data property (the object-literal / define-semantics path),
 * shared by MAL_OP_DEFINE_PROPERTY and the compiled backend. Like the op, this
 * cannot run user code, so it never leaves a pending throw.
 */
void mal_vm_op_define_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool enumerable);

/**
 * Throw "<name> is not defined" (ReferenceError), shared by MAL_OP_LOAD_UNDECLARED
 * and the compiled backend; sets vm->completion to THROW.
 */
void mal_vm_op_load_undeclared(MalVm *vm, i32 name_string_index);

/**
 * Resolve (creating if absent) a function's `.prototype` object — the parent of
 * instances built by [[Construct]]. Exposed for mal_vm_construct_value.
 */
MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

void mal_op_store_super_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_prototype(MalCallable *callable, MalInstruction *instruction);

void mal_op_get_iterator(MalCallable *callable, MalInstruction *instruction);

void mal_op_get_async_iterator(MalCallable *callable, MalInstruction *instruction);

void mal_op_iterator_next(MalCallable *callable, MalInstruction *instruction);

void mal_op_iterator_step(MalCallable *callable, MalInstruction *instruction);

void mal_op_iterator_close(MalCallable *callable, MalInstruction *instruction);

void mal_op_for_in_keys(MalCallable *callable, MalInstruction *instruction);

void mal_op_delete_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_accessor(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_private_name(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_has_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction);

void mal_op_require_coercible(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_rest_arguments(MalCallable *callable, MalInstruction *instruction);

void mal_op_array_rest(MalCallable *callable, MalInstruction *instruction);

void mal_op_copy_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_merge_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction);
