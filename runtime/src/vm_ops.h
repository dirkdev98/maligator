#pragma once

#include "./defaults.h"
#include "array_object.h"
#include "builtin_iterator.h"
#include "object_ops.h"
#include "table.h"
#include "vm.h"

/**
 * Normalize a value into a property key, converting canonical numeric strings
 * to index keys and non-key values through ToString.
 */
bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

/**
 * Spec ToPropertyKey (7.1.19): ToPrimitive(value, string) — running the object's
 * @@toPrimitive / valueOf / toString exactly once — then ToString unless the
 * result is a Symbol. For reflective builtins that convert a key a single time;
 * the bytecode access path keeps mal_vm_value_to_property_key. Returns false on
 * an abrupt completion.
 */
bool mal_vm_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

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
 * CanonicalNumericIndexString (7.1.21): whether a string key is the canonical
 * string form of a Number (so a TypedArray treats it as an integer-index key).
 */
bool mal_vm_string_is_canonical_numeric_index(MalVm *vm, MalString *string);

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
 * Hint passed to ToPrimitive (spec OrdinaryToPrimitive): "default" and "number"
 * try valueOf before toString, "string" tries toString first. A @@toPrimitive
 * method receives the hint string.
 */
typedef enum MalToPrimitiveHint {
    MAL_TO_PRIMITIVE_DEFAULT,
    MAL_TO_PRIMITIVE_NUMBER,
    MAL_TO_PRIMITIVE_STRING,
} MalToPrimitiveHint;

/**
 * Spec ToPrimitive(input, hint). A non-object passes through unchanged. An
 * object is converted via @@toPrimitive (given the hint string) else
 * OrdinaryToPrimitive (valueOf/toString ordered by hint). Returns false and
 * leaves a pending throw completion on a non-callable @@toPrimitive, a
 * non-primitive result, a thrown method, or when no method yields a primitive.
 */
bool mal_vm_to_primitive(MalVm *vm, MalValue value, MalToPrimitiveHint hint, MalValue *out);

/**
 * Spec ToNumber with full ToPrimitive(number) for objects (@@toPrimitive, else
 * valueOf → toString). Throws TypeError on BigInt/Symbol (or a non-primitive
 * ToPrimitive result) and returns false; otherwise writes the number.
 */
bool mal_vm_to_number(MalVm *vm, MalValue value, f64 *out);

/**
 * Spec ToString with ToPrimitive(string) for objects. Throws TypeError on a
 * Symbol (or a non-primitive ToPrimitive result) and returns false; otherwise
 * writes the resulting string.
 */
bool mal_vm_to_string(MalVm *vm, MalValue value, MalString **out);

/**
 * Spec ToNumeric: ToPrimitive(number) then, if the primitive is a BigInt, keep
 * it; else ToNumber. The result is either a Number value or a BigInt value.
 * Throws (returns false) on a Symbol operand or a thrown coercion method.
 */
bool mal_vm_to_numeric(MalVm *vm, MalValue value, MalValue *out);

/**
 * Spec OrdinaryHasInstance: non-callable targets answer false, bound
 * functions unwrap to their target, then the value's prototype chain is
 * walked looking for target.prototype. Shared by the instanceof operator
 * and %Function.prototype%[Symbol.hasInstance].
 */
bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value);

/**
 * Spec IsConstructor: bound functions defer to their target, a proxy to its
 * target chain, native functions consult their [[Construct]] flag, ordinary
 * script functions are constructors iff non-generator/non-async. Mirrors the
 * pragmatic check Reflect.construct uses.
 */
bool mal_vm_is_constructor(MalVm *vm, MalValue value);

void mal_op_move(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_number(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_f64(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_boolean(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_string(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_bigint(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_object(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_object_shaped(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_array(MalCallable *callable, MalInstruction *instruction);
void mal_op_create_module_namespace(MalCallable *callable, MalInstruction *instruction);
void mal_op_create_template_object(MalCallable *callable, MalInstruction *instruction);
void mal_op_with_enter(MalCallable *callable, MalInstruction *instruction);
void mal_op_with_exit(MalCallable *callable, MalInstruction *instruction);
void mal_op_with_get(MalCallable *callable, MalInstruction *instruction);
void mal_op_with_resolve_base(MalCallable *callable, MalInstruction *instruction);
void mal_op_with_set(MalCallable *callable, MalInstruction *instruction);
void mal_op_is_empty(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_undefined(MalCallable *callable, MalInstruction *instruction);
void mal_op_create_empty(MalCallable *callable, MalInstruction *instruction);
void mal_op_throw_if_tdz(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_null(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_function(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_arguments_object(MalCallable *callable, MalInstruction *instruction);

// Build an unmapped arguments object over `args`; shared by the interpreter op
// and compiled code. `callee` is exposed only in sloppy mode (strict poisons it).
MalValue mal_create_arguments_object(
    MalVm *vm, const MalValue *args, i32 arg_count, MalValue callee, bool strict
);

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

void mal_op_env_push(MalCallable *callable, MalInstruction *instruction);
void mal_op_env_copy(MalCallable *callable, MalInstruction *instruction);
void mal_op_env_pop(MalCallable *callable);

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
 * Monomorphic inline cache for a single property-access site: the shape last seen
 * there and the slot the property occupied in it. A shape is immutable and never
 * freed, so on a later access whose object has the same shape the slot is still
 * valid — the property read/write is then a direct slot access with no key
 * conversion or shape search. Zero-initialized (shape == nullptr) means empty.
 */
typedef struct MalInlineCache {
    const struct MalShape *shape;
    MalValue key; // the exact key value cached — a computed-key site (o[k]) varies
    u32 slot;
} MalInlineCache;

/**
 * Inline-cached property load/store for the compiled backend. The fast path
 * applies only to a plain object (MAL_HEAP_OBJECT) whose own property is a
 * shaped data slot; everything else (arrays, proxies, typed arrays, prototype
 * lookups, accessors, index/symbol keys) falls through to the generic op, which
 * also refills the cache when it resolves an ownable shaped data property.
 */
MalValue mal_vm_op_load_property_ic(MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic);

void mal_vm_op_store_property_ic(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict, MalInlineCache *ic);

/**
 * Inline dense-array index access for the native backend (emit-c), so a `obj[i]`
 * read/write of a dense array is a direct vector load/store rather than a nested
 * runtime call. A non-array object, a non-int32 key, or a dense miss falls back to
 * the inline-cached op (which handles every other case identically). At -O2 the
 * C compiler inlines the dense check into the caller; the fallback call survives only
 * on the slow path. These mirror the runtime fast paths in mal_vm_op_store_property_keyed
 * / mal_vm_get_property_with_receiver, so the interpreter and native backends agree.
 */
static inline MalValue mal_vm_array_fast_load(MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic) {
    if (mal_value_is_int32(key_value) && mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT)) {
        i32 index = mal_value_to_i32(key_value);
        MalValue out;
        if (index >= 0 &&
            mal_array_object_dense_get((const MalArrayObject *) mal_value_to_heap(object_value), (u32) index, &out)) {
            return out;
        }
    }
    return mal_vm_op_load_property_ic(vm, object_value, key_value, ic);
}

static inline void mal_vm_array_fast_store(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict, MalInlineCache *ic) {
    if (mal_value_is_int32(key_value) && mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT)) {
        i32 index = mal_value_to_i32(key_value);
        if (index >= 0) {
            MalArrayObject *array = (MalArrayObject *) mal_value_to_heap(object_value);
            // Overwrite of a present element — own data shadows any inherited accessor.
            if (mal_array_object_dense_has(array, (u32) index)) {
                mal_array_object_dense_store(array, (u32) index, value);
                return;
            }
            // Fresh-index store — sound only on the default %Array.prototype% with the
            // fast-elements protector up, extensible, and a writable length.
            if (!array->dense_deopted && mal_array_elements_protector &&
                array->object.extensible && array->length_writable &&
                array->object.prototype == mal_array_prototype_object) {
                if (mal_array_object_dense_store(array, (u32) index, value) == MAL_ARRAY_DENSE_APPLIED) {
                    if ((u32) index >= array->length) {
                        array->length = (u32) index + 1;
                    }
                    return;
                }
            }
        }
    }
    mal_vm_op_store_property_ic(vm, object_value, key_value, value, strict, ic);
}

/**
 * Inline iterator step for the native backend: a built-in Array-values iterator whose
 * `next` is still the original, over a real dense array, yields the next element
 * straight from the vector with no call — eliminating the iteratorStep + advance
 * dispatch the general path performs per element (the for-of / spread hot path). A
 * done state, a hole / out-of-dense index, a patched next, or any other iterator falls
 * back to the general step (observably identical). Mirrors the runtime fast path in
 * mal_builtin_iterator_array_advance. The extra C frame this adds on the slow path is
 * bounded by the native stack-overflow guard (mal_vm_enter_compiled), so deep
 * recursion through a for-of unwinds with a clean RangeError.
 */
static inline bool mal_vm_iterator_step_fast(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out) {
    if (mal_value_is_iterator_object(record->iterator) &&
        mal_value_is_native_function_object(record->next_method) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(record->next_method)) ==
            mal_array_iterator_next_callback) {
        MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
        if (iterator->kind == MAL_ITERATOR_ARRAY_VALUES &&
            mal_value_is_heap_type(iterator->target, MAL_HEAP_ARRAY_OBJECT)) {
            MalArrayObject *array = (MalArrayObject *) mal_value_to_heap(iterator->target);
            u64 index = iterator->index;
            if (index >= array->length) {
                iterator->done = true;
                *value_out = mal_value_new_undefined();
                *done_out = true;
                return true;
            }
            MalValue element;
            if (mal_array_object_dense_get(array, (u32) index, &element)) {
                iterator->index = index + 1;
                *value_out = element;
                *done_out = false;
                return true;
            }
            // Hole / beyond the dense region (still < length): fall back for the Get.
        }
    }
    return mal_vm_iterator_step(vm, record, value_out, done_out);
}

void mal_op_to_property_key(MalCallable *callable, MalInstruction *instruction);

/**
 * Object-coercibility-check the base (nil throws first, per spec) then run
 * ToPropertyKey once, returning a re-keyable value (index/string/symbol) so a
 * read-modify-write member access converts a computed key a single time.
 * Signals a throw via vm->completion. See mal_vm_op_to_property_key in vm_ops.c.
 */
MalValue mal_vm_op_to_property_key(MalVm *vm, MalValue object_value, MalValue key_value);

/**
 * Value-returning object/array/closure construction, shared by the create ops
 * and the compiled backend. create_function captures `creation_env` (the
 * creating frame's environment) so the closure resolves captured bindings.
 */
MalValue mal_vm_op_create_object(MalVm *vm);

/**
 * Create a plain object directly in `shape` (built from the literal's static
 * keys) with `count` inline slots filled from `values` in key order. The
 * compiled backend caches the shape per literal site; the interpreter rebuilds
 * it (interned, so cheap) each time. See mal_vm_create_object_shaped in vm_ops.c.
 */
MalValue mal_vm_create_object_shaped(MalVm *vm, struct MalShape *shape, const MalValue *values, u32 count);

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
 * Throw "Cannot access '<name>' before initialization" (ReferenceError) when
 * `value` is the uninitialized (TDZ) sentinel; otherwise a no-op. Shared by
 * MAL_OP_THROW_IF_TDZ and the compiled backend; sets vm->completion to THROW.
 */
void mal_vm_op_throw_if_tdz(MalVm *vm, MalValue value, i32 name_string_index);

/**
 * Throw "Cannot destructure null or undefined" (TypeError) when `value` is null
 * or undefined (RequireObjectCoercible). Shared by MAL_OP_REQUIRE_COERCIBLE and
 * the compiled backend; sets vm->completion to THROW.
 */
void mal_vm_op_require_coercible(MalVm *vm, MalValue value);

/** `delete object[key]`; returns the boolean result, strict failure throws. */
MalValue mal_vm_op_delete_property(MalVm *vm, MalValue object_value, MalValue key_value, bool strict);

/** Define a getter/setter on an object literal or class (no user code run). */
void mal_vm_op_define_accessor(
    MalVm *vm, MalValue object_value, MalValue key_value, MalValue accessor, bool enumerable, bool is_setter
);

/** Object spread `{...source}` into target; a throwing getter sets completion. */
void mal_vm_op_merge_data_properties(MalVm *vm, MalValue target_value, MalValue source);

/** Set [[Prototype]] for an object-literal `__proto__:` member or class heritage. */
void mal_vm_op_set_prototype(MalVm *vm, MalValue object_value, MalValue prototype_value, bool literal);

/**
 * Sloppy-mode read of an unresolved name: return the global object's property
 * `name_string_index`, or throw ReferenceError if it is absent.
 */
MalValue mal_vm_op_load_global_property(MalVm *vm, i32 name_string_index);

/** Write `value` to the global object property `name_string_index` (creating it). */
void mal_vm_op_store_global_property(MalVm *vm, i32 name_string_index, MalValue value);

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

// for-in enumeration key array for `source`; shared by the interpreter op and
// compiled code. On a proxy-trap exception sets vm->completion (caller checks).
MalValue mal_for_in_keys(MalVm *vm, MalValue source);

void mal_op_delete_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_accessor(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_property(MalCallable *callable, MalInstruction *instruction);
void mal_op_set_function_name(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_private_name(MalCallable *callable, MalInstruction *instruction);

void mal_op_define_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_has_private(MalCallable *callable, MalInstruction *instruction);

void mal_op_set_prototype(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_undeclared(MalCallable *callable, MalInstruction *instruction);

void mal_op_load_global_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_store_global_property(MalCallable *callable, MalInstruction *instruction);

void mal_op_require_coercible(MalCallable *callable, MalInstruction *instruction);

void mal_op_create_rest_arguments(MalCallable *callable, MalInstruction *instruction);

// Rest-parameter array from `args[start..]`; shared by the interpreter op and
// compiled code.
MalValue mal_create_rest_arguments(MalVm *vm, const MalValue *args, i32 arg_count, i32 start);

void mal_op_array_rest(MalCallable *callable, MalInstruction *instruction);

// Array-destructuring rest from `source[start..]`; shared by the interpreter op
// and compiled code. On null/undefined source or a throwing read sets
// vm->completion (caller checks).
MalValue mal_array_rest(MalVm *vm, MalValue source, u32 start);

void mal_op_copy_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_merge_data_properties(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump(MalCallable *callable, MalInstruction *instruction);

void mal_op_jump_if(MalCallable *callable, MalInstruction *instruction);
