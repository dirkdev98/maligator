#pragma once

#include "./defaults.h"
#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h" // mal_function_object_function_index, for the call guard
#include "object_ops.h"
#include "perf_stats.h"
#include "table.h"
#include "value_ops.h" // mal_ops_number_value, for the numeric-index fast paths
#include "vm.h"

/**
 * Runtime admission for compiler facts backed by semantic epochs. Generated code
 * names the dependencies it consumes; this is the one compatibility bridge from
 * those names to the legacy protectors and per-VM epoch storage. Locked-world
 * dependencies disappear before emission and therefore never call this helper.
 *
 * `primitive-methods` and `watched-methods` currently share one invalidation path,
 * but keep distinct bits so the compiler contract does not inherit that runtime
 * implementation detail. The activity snapshot lets a region validate all of its
 * dependencies with one comparison after a potentially reentrant operation.
 */
typedef enum MalSemanticDependencyMask {
    MAL_SEMANTIC_DEPENDENCY_PRIMITIVE_METHODS = 1 << 0,
    MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS = 1 << 1,
    MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS = 1 << 2,
} MalSemanticDependencyMask;

static inline bool mal_vm_semantic_dependencies_hold(
    const MalVm *vm, u8 dependencies
) {
    const u8 watched =
        MAL_SEMANTIC_DEPENDENCY_PRIMITIVE_METHODS |
        MAL_SEMANTIC_DEPENDENCY_WATCHED_METHODS;
    if ((dependencies & watched) != 0 &&
        (!mal_primitive_method_protector ||
         vm->semantic_epochs.watched_methods == 0)) {
        return false;
    }
    if ((dependencies & MAL_SEMANTIC_DEPENDENCY_ARRAY_ELEMENTS) != 0 &&
        (!mal_array_elements_protector ||
         vm->semantic_epochs.array_elements == 0)) {
        return false;
    }
    return true;
}

static inline bool mal_vm_semantic_dependencies_admit(
    const MalVm *vm, u8 dependencies, u64 *activity_epoch_out
) {
    if (!mal_vm_semantic_dependencies_hold(vm, dependencies)) return false;
    if (activity_epoch_out == nullptr) return true;
    *activity_epoch_out = vm->semantic_epochs.activity;
    return *activity_epoch_out != 0;
}

static inline bool mal_vm_semantic_dependencies_validate(
    const MalVm *vm, u8 dependencies, u64 activity_epoch
) {
    return activity_epoch != 0 &&
        activity_epoch == vm->semantic_epochs.activity &&
        mal_vm_semantic_dependencies_hold(vm, dependencies);
}

/**
 * Speculative-call-inlining guard: whether `callee` is a plain function object with the
 * given function index — the candidate the call site was inlined against. A miss deopts to
 * the real call (so a reassigned global, a bound/native/proxy callee, or any other function
 * simply takes the un-inlined path). The heap-type test is inline; the index accessor is the
 * only out-of-line bit and is reached only when the type already matched.
 */
static inline bool mal_vm_callee_has_index(MalVm *vm, MalValue callee, i32 function_index) {
    if (!mal_value_is_heap_type(callee, MAL_HEAP_FUNCTION_OBJECT)) return false;
    const MalFunctionObject *function = (const MalFunctionObject *) mal_value_to_heap(callee);
    if (mal_function_object_function_index(function) != function_index) return false;
#if MAL_REALMS
    return function->realm == nullptr || function->realm == vm->current_realm;
#else
    (void) vm;
    return true;
#endif
}

/**
 * Normalize a value into a property key, converting canonical numeric strings
 * to index keys and non-key values through ToString.
 */
bool mal_vm_value_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

bool mal_vm_to_property_key(MalVm *vm, MalValue value, MalKey *key_out);

/**
 * Read a resolved descriptor's value, invoking accessor getters with the
 * original receiver. Returns false when the getter threw; the throw
 * completion is left on the vm for the caller to propagate.
 */
bool mal_vm_desc_read(MalVm *vm, MalPropertyDesc desc, MalValue receiver, MalValue *out);

/**
 * CreateListFromArrayLike for Function/Reflect call seams. Small lists reuse the
 * caller-provided storage; larger lists are malloc-owned and must be freed by
 * the caller when the returned pointer differs from `inline_items`.
 */
bool mal_vm_create_list_from_array_like(
    MalVm *vm, MalValue list, MalValue *inline_items, i32 inline_capacity,
    MalValue **items_out, i32 *count_out);

/**
 * Spec [[OwnPropertyKeys]] over an object, including Proxy traps and the engine's
 * Array, TypedArray, String-wrapper, and module-namespace exotic own keys. The
 * returned dense array contains String/Symbol key values in property order.
 */
bool mal_vm_own_property_keys(MalVm *vm, MalValue object, MalValue *keys_out);

/**
 * Spec [[GetOwnProperty]] over an object, including Proxy traps and exotic own
 * descriptors. A clean miss returns true with *present_out false.
 */
bool mal_vm_get_own_property(
    MalVm *vm, MalValue object, MalKey key, bool *present_out, MalPropertyDesc *desc_out);

/** Spec IsExtensible over ordinary and Proxy objects. */
bool mal_vm_is_extensible_object(MalVm *vm, MalValue object, bool *extensible_out);

/** Spec IsArray: recurse through Proxy targets and throw for a revoked Proxy. */
bool mal_vm_is_array(MalVm *vm, MalValue value, bool *is_array_out);

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
 * Add already-coerced primitives, throwing RangeError when a string result would
 * exceed the engine's UTF-16 length limit. Preserves an existing pending throw.
 */
MalValue mal_vm_add(MalVm *vm, MalValue left, MalValue right);

/**
 * Spec OrdinaryHasInstance: non-callable targets answer false, bound
 * functions unwrap to their target, then the value's prototype chain is
 * walked looking for target.prototype. Shared by the instanceof operator
 * and %Function.prototype%[Symbol.hasInstance].
 */
bool mal_vm_ordinary_has_instance(MalVm *vm, MalValue target, MalValue value);

/**
 * Spec IsConstructor: bound functions defer to their target, proxies retain the
 * [[Construct]] slot fixed at creation (including after revocation), native
 * functions consult their [[Construct]] flag, and ordinary script functions are
 * constructors iff non-generator/non-async.
 */
bool mal_vm_is_constructor(MalVm *vm, MalValue value);

void mal_op_move(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_number(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_f64(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_boolean(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_string(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_bigint(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_object(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_object_shaped(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_array(MalCallable *callable, const MalInstruction *instruction);
void mal_op_instantiate_literal_template(MalCallable *callable, const MalInstruction *instruction);
void mal_op_create_module_namespace(MalCallable *callable, const MalInstruction *instruction);
void mal_op_create_template_object(MalCallable *callable, const MalInstruction *instruction);
void mal_op_with_enter(MalCallable *callable, const MalInstruction *instruction);
void mal_op_with_exit(MalCallable *callable, const MalInstruction *instruction);
void mal_op_with_get(MalCallable *callable, const MalInstruction *instruction);
void mal_op_with_resolve_base(MalCallable *callable, const MalInstruction *instruction);
void mal_op_with_set(MalCallable *callable, const MalInstruction *instruction);
void mal_op_is_empty(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_undefined(MalCallable *callable, const MalInstruction *instruction);
void mal_op_create_empty(MalCallable *callable, const MalInstruction *instruction);
void mal_op_throw_if_tdz(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_null(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_function(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_arguments_object(MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_argument_count(MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_argument(MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_static_argument(MalCallable *callable, const MalInstruction *instruction);

// Build an arguments object over `args`; a non-empty map aliases indexed
// properties to captured formal bindings. Shared by both execution backends.
MalValue mal_create_arguments_object(
    MalVm *vm, const MalValue *args, i32 arg_count, MalValue callee, MalEnv *env,
    bool mapped, i32 mapped_argument_count, const i32 *mapped_argument_slots
);

void mal_op_load_this(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_new_target(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_callee(MalCallable *callable, const MalInstruction *instruction);

void mal_op_call(MalCallable *callable, const MalInstruction *instruction);
void mal_op_call_builtin(MalCallable *callable, const MalInstruction *instruction);

void mal_op_call_spread(MalCallable *callable, const MalInstruction *instruction);

void mal_op_call_spread_iterable(
    MalCallable *callable, const MalInstruction *instruction);

void mal_op_construct(MalCallable *callable, const MalInstruction *instruction);

void mal_op_construct_spread(MalCallable *callable, const MalInstruction *instruction);

/**
 * `super(...args)`: [[Construct]] the parent forwarding the derived
 * constructor's new.target, then bind the result as `this`. The parent comes
 * from registers[parent], the arguments from the array in registers[arguments_array].
 */
void mal_op_construct_super(MalCallable *callable, const MalInstruction *instruction);

void mal_op_construct_super_explicit(MalCallable *callable, const MalInstruction *instruction);

void mal_op_set_this(MalCallable *callable, const MalInstruction *instruction);

void mal_op_throw(MalCallable *callable, const MalInstruction *instruction);

void mal_op_catch(MalCallable *callable, const MalInstruction *instruction);

void mal_op_binary(MalCallable *callable, const MalInstruction *instruction);

/**
 * Portable-interpreter fast path for a binary operation over two boxed Numbers.
 * It performs no coercion and returns false for every other operand/operator, so
 * the caller can preserve the generic operation's observable fallback exactly.
 */
static inline bool mal_vm_try_binary_number_fast(
    MalBinaryOp op, MalValue left, MalValue right, MalValue *out
) {
    if (op == MAL_BIN_ADD && mal_value_is_int32(left) && mal_value_is_int32(right)) {
        i64 result = (i64) mal_value_to_i32(left) + (i64) mal_value_to_i32(right);
        MAL_PERF_COUNT(binary_number_arithmetic_hits);
        *out = result >= INT32_MIN && result <= INT32_MAX
            ? mal_value_from_i32((i32) result)
            : mal_ops_number_value((f64) result);
        return true;
    }

    if (op == MAL_BIN_SUB && mal_value_is_int32(left) && mal_value_is_int32(right)) {
        i64 result = (i64) mal_value_to_i32(left) - (i64) mal_value_to_i32(right);
        MAL_PERF_COUNT(binary_number_arithmetic_hits);
        *out = result >= INT32_MIN && result <= INT32_MAX
            ? mal_value_from_i32((i32) result)
            : mal_ops_number_value((f64) result);
        return true;
    }

    if (op == MAL_BIN_MUL && mal_value_is_int32(left) && mal_value_is_int32(right)) {
        i32 l = mal_value_to_i32(left);
        i32 r = mal_value_to_i32(right);
        MAL_PERF_COUNT(binary_number_arithmetic_hits);
        if ((l == 0 || r == 0) && ((l < 0) != (r < 0))) {
            *out = MAL_VALUE_NEGATIVE_ZERO;
            return true;
        }
        i64 result = (i64) l * (i64) r;
        *out = result >= INT32_MIN && result <= INT32_MAX
            ? mal_value_from_i32((i32) result)
            : mal_ops_number_value((f64) result);
        return true;
    }

    if (op >= MAL_BIN_LT && op <= MAL_BIN_STRICT_NEQ &&
        mal_value_is_int32(left) && mal_value_is_int32(right)) {
        i32 l = mal_value_to_i32(left);
        i32 r = mal_value_to_i32(right);
        bool result;
        switch (op) {
            case MAL_BIN_LT: result = l < r; break;
            case MAL_BIN_LTE: result = l <= r; break;
            case MAL_BIN_GT: result = l > r; break;
            case MAL_BIN_GTE: result = l >= r; break;
            case MAL_BIN_EQ:
            case MAL_BIN_STRICT_EQ: result = l == r; break;
            case MAL_BIN_NEQ:
            case MAL_BIN_STRICT_NEQ: result = l != r; break;
            default: return false;
        }
        MAL_PERF_COUNT(binary_number_comparison_hits);
        if (op == MAL_BIN_STRICT_EQ || op == MAL_BIN_STRICT_NEQ) {
            MAL_PERF_COUNT(interpreter_strict_direct_hits);
        }
        *out = mal_value_new_boolean(result);
        return true;
    }

    if (!mal_ops_is_number(left) || !mal_ops_is_number(right)) {
        return false;
    }

    if (op == MAL_BIN_BIT_AND && mal_value_is_int32(left) && mal_value_is_int32(right)) {
        MAL_PERF_COUNT(binary_number_bitwise_hits);
        *out = mal_value_from_i32(mal_value_to_i32(left) & mal_value_to_i32(right));
        return true;
    }

    f64 l = mal_ops_number_as_f64(left);
    f64 r = mal_ops_number_as_f64(right);
    switch (op) {
        case MAL_BIN_ADD:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(l + r);
            return true;
        case MAL_BIN_SUB:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(l - r);
            return true;
        case MAL_BIN_MUL:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(l * r);
            return true;
        case MAL_BIN_DIV:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(l / r);
            return true;
        case MAL_BIN_REM:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(mal_number_remainder(l, r));
            return true;
        case MAL_BIN_POW:
            MAL_PERF_COUNT(binary_number_arithmetic_hits);
            *out = mal_ops_number_value(mal_number_exponentiate(l, r));
            return true;
        case MAL_BIN_BIT_AND:
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            *out = mal_value_from_i32(mal_ops_number_to_i32(l) & mal_ops_number_to_i32(r));
            return true;
        case MAL_BIN_BIT_OR:
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            *out = mal_value_from_i32(mal_ops_number_to_i32(l) | mal_ops_number_to_i32(r));
            return true;
        case MAL_BIN_BIT_XOR:
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            *out = mal_value_from_i32(mal_ops_number_to_i32(l) ^ mal_ops_number_to_i32(r));
            return true;
        case MAL_BIN_SHL: {
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            u32 result = (u32) mal_ops_number_to_i32(l) << (mal_ops_number_to_i32(r) & 0x1F);
            *out = mal_value_from_i32(mal_ops_u32_to_i32(result));
            return true;
        }
        case MAL_BIN_SHR:
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            *out = mal_value_from_i32(
                mal_ops_number_to_i32(l) >> (mal_ops_number_to_i32(r) & 0x1F));
            return true;
        case MAL_BIN_USHR: {
            MAL_PERF_COUNT(binary_number_bitwise_hits);
            u32 result = (u32) mal_ops_number_to_i32(l) >> (mal_ops_number_to_i32(r) & 0x1F);
            *out = result <= INT32_MAX ? mal_value_from_i32((i32) result) : mal_ops_number_value((f64) result);
            return true;
        }
        case MAL_BIN_LT:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l < r);
            return true;
        case MAL_BIN_LTE:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l <= r);
            return true;
        case MAL_BIN_GT:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l > r);
            return true;
        case MAL_BIN_GTE:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l >= r);
            return true;
        case MAL_BIN_EQ:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l == r);
            return true;
        case MAL_BIN_STRICT_EQ:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            MAL_PERF_COUNT(interpreter_strict_direct_hits);
            *out = mal_value_new_boolean(l == r);
            return true;
        case MAL_BIN_NEQ:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            *out = mal_value_new_boolean(l != r);
            return true;
        case MAL_BIN_STRICT_NEQ:
            MAL_PERF_COUNT(binary_number_comparison_hits);
            MAL_PERF_COUNT(interpreter_strict_direct_hits);
            *out = mal_value_new_boolean(l != r);
            return true;
        case MAL_BIN_IN:
        case MAL_BIN_INSTANCEOF:
            return false;
    }
    return false;
}

/**
 * Strict equality is a pure leaf unless two distinct strings need a content
 * comparison. That comparison may flatten cons strings, so it retains the
 * synchronized generic boundary.
 */
static inline bool mal_vm_try_binary_strict_fast(
    MalBinaryOp op, MalValue left, MalValue right, MalValue *out
) {
    if (op != MAL_BIN_STRICT_EQ && op != MAL_BIN_STRICT_NEQ) {
        return false;
    }
    if (left != right && mal_value_is_string(left) && mal_value_is_string(right)) {
        MAL_PERF_COUNT(interpreter_strict_string_fallbacks);
        return false;
    }

    bool equal = mal_ops_strict_equal_bool(left, right);
    MAL_PERF_COUNT(interpreter_strict_direct_hits);
    *out = mal_value_new_boolean(op == MAL_BIN_STRICT_EQ ? equal : !equal);
    return true;
}

static inline void mal_perf_binary_number_fallback(MalBinaryOp op) {
    switch (op) {
        case MAL_BIN_ADD:
        case MAL_BIN_SUB:
        case MAL_BIN_MUL:
        case MAL_BIN_DIV:
        case MAL_BIN_REM:
        case MAL_BIN_POW:
            MAL_PERF_COUNT(binary_number_arithmetic_fallbacks);
            return;
        case MAL_BIN_LT:
        case MAL_BIN_LTE:
        case MAL_BIN_GT:
        case MAL_BIN_GTE:
        case MAL_BIN_EQ:
        case MAL_BIN_NEQ:
        case MAL_BIN_STRICT_EQ:
        case MAL_BIN_STRICT_NEQ:
            MAL_PERF_COUNT(binary_number_comparison_fallbacks);
            return;
        case MAL_BIN_BIT_AND:
        case MAL_BIN_BIT_OR:
        case MAL_BIN_BIT_XOR:
        case MAL_BIN_SHL:
        case MAL_BIN_SHR:
        case MAL_BIN_USHR:
            MAL_PERF_COUNT(binary_number_bitwise_fallbacks);
            return;
        case MAL_BIN_IN:
        case MAL_BIN_INSTANCEOF:
            MAL_PERF_COUNT(binary_number_other_fallbacks);
            return;
    }
}

/**
 * Value-returning core of a binary operator, shared by mal_op_binary and the
 * compiled-function backend. Throws (via vm->completion) on bad `in`/
 * `instanceof` operands or BigInt domain errors, returning undefined.
 */
MalValue mal_vm_binary_op(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right);

void mal_op_unary(MalCallable *callable, const MalInstruction *instruction);

/**
 * Value-returning core of a unary operator, shared by mal_op_unary and the
 * compiled-function backend. Unary `+` on a BigInt throws via vm->completion.
 */
MalValue mal_vm_unary_op(MalVm *vm, MalUnaryOp op, MalValue value);

/** Classify a value using the exact result categories of the typeof operator. */
MalTypeofResult mal_vm_typeof_result(MalValue value);

/** Non-allocating canonical typeof predicate used by both execution backends. */
static inline bool mal_vm_typeof_compare(MalValue value, MalTypeofResult expected) {
    switch (expected) {
        case MAL_TYPEOF_UNDEFINED:
            return mal_value_is_undefined(value);
        case MAL_TYPEOF_OBJECT: {
            if (mal_value_is_null(value)) {
                return true;
            }
            MalValue value_class = value & MAL_VALUE_CLASS_MASK;
            if (value_class == MAL_VALUE_ARRAY) {
                return true;
            }
            return value_class == MAL_VALUE_OBJECT && !mal_value_is_callable(value);
        }
        case MAL_TYPEOF_BOOLEAN:
            return mal_value_is_boolean(value);
        case MAL_TYPEOF_NUMBER:
            return mal_ops_is_number(value);
        case MAL_TYPEOF_STRING:
            return mal_value_is_string(value);
        case MAL_TYPEOF_SYMBOL:
            return mal_value_is_symbol(value);
        case MAL_TYPEOF_BIGINT:
            return mal_value_is_bigint(value);
        case MAL_TYPEOF_FUNCTION:
            return mal_value_is_callable(value);
        case MAL_TYPEOF_RESULT_COUNT:
            return false;
    }
    return false;
}

void mal_op_typeof_compare(MalCallable *callable, const MalInstruction *instruction);

void mal_op_store_global(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_global(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_intrinsic(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_captured(MalCallable *callable, const MalInstruction *instruction);
void mal_op_guard_function_index(MalCallable *callable, const MalInstruction *instruction);

void mal_op_store_captured(MalCallable *callable, const MalInstruction *instruction);

void mal_op_env_push(MalCallable *callable, const MalInstruction *instruction);
void mal_op_env_copy(MalCallable *callable, const MalInstruction *instruction);
void mal_op_env_pop(MalCallable *callable);

/**
 * Read/write a captured binding by walking the environment chain to the owning
 * activation. Shared by the load/store-captured ops and the compiled backend.
 */
MalValue mal_vm_load_captured(MalEnv *env, i32 owner_function_index, i32 index);

void mal_vm_store_captured(MalEnv *env, i32 owner_function_index, i32 index, MalValue value);

void mal_op_load_property(MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_property_static(MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_property_static_known_own_slot_fallback(
    MalCallable *callable, const MalInstruction *instruction);
void mal_op_load_property_static_shape_case_fallback(
    MalCallable *callable, const MalInstruction *instruction);

void mal_op_store_property(MalCallable *callable, const MalInstruction *instruction);
void mal_op_store_property_static(MalCallable *callable, const MalInstruction *instruction);
void mal_op_store_property_static_known_own_slot_fallback(
    MalCallable *callable, const MalInstruction *instruction);

/**
 * Value-returning Get / completion-signalling Set with an already-evaluated key
 * value, shared by the load/store-property ops and the compiled backend. A load
 * returns undefined and a store signals through vm->completion on a throw; the
 * compiled caller passes its statically-known strictness to the store.
 */
MalValue mal_vm_op_load_property(MalVm *vm, MalValue object_value, MalValue key_value);

void mal_vm_op_store_property(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict);

// Extra polymorphic shapes cached inline for one fixed-key object-property site
// (beyond the monomorphic primary) before it is treated as megamorphic. 3 extra +
// the primary = a 4-way site, matching the common "handful of shapes" case.
#define MAL_IC_POLY_EXTRA 3

/**
 * Inline cache for a single property-access site. The primary entry (shape/slot,
 * or a protector-gated special entry) is the monomorphic fast path; a fixed-key
 * object site that sees more than one shape accumulates the alternates in the
 * inline polymorphic overflow (`poly_shape`/`poly_slot`), checked right after the
 * primary so a 2-4-shape site stays on the inline fast path instead of an
 * out-of-line re-resolve. A shape is immutable and shares the owning VM/heap
 * lifetime with these cache rows, so a cached (shape -> slot) remains valid for
 * the life of the site. Zero-initialized
 * (shape == nullptr, poly_count == 0) means empty — the overflow is inline (no
 * heap allocation), so there is nothing to free on teardown.
 *
 * Shape slots fit in one byte (the runtime caps inline shapes at 64). The shared
 * polymorphic payload packs either three byte-sized slots or one 64-bit
 * deep-chain fallback epoch. This keeps the full typed site in 72 bytes without
 * reducing four-way polymorphism.
 */
typedef struct MalInlineCache {
    union {
        const struct MalShape *shape;
        // Exact current-realm primitive prototype for a primitive-value entry.
        const struct MalObject *prototype;
    };
    // Exact VM-lifetime string atom cached. A computed-key site (o[k]) may vary;
    // its slow probe canonicalizes collectable strings before comparing here.
    MalValue key;
    // `value` caches a resolved property value for protector-gated modes and
    // dependency-registered inherited rows:
    //  - primitive-method: `mode == MAL_IC_MODE_PRIMITIVE_VALUE` — `value` is
    //    `key` on that primitive kind's (unmodified) prototype chain.
    //  - watched-intrinsic own property: `prim_kind` 0 and `slot == MAL_IC_VALUE_SLOT`
    //    — `value` is `key`'s own value on a watched intrinsic (String, Math, …),
    //    which lives in the overflow table (no shape slot).
    // Both value modes are valid only while `mal_primitive_method_protector`
    // holds. Under MAL_REALMS a primitive-method entry is additionally tagged
    // with its exact realm; `prototype` guards the current intrinsic in all builds.
    // A plain object-shape entry has `prim_kind` 0 and a real `slot` (uses
    // object->slots).
    union {
        MalValue value;
        // MAL_IC_MODE_INHERITED_TABLE: generation of the holder's entry handle.
        u64 table_handle_epoch;
    };
    // For a value-slot entry (`slot == MAL_IC_VALUE_SLOT`), the exact watched
    // object the value belongs to. Shape is NOT a unique discriminator — the
    // typed-array constructors (and other same-layout intrinsics) share one
    // shape yet hold different overflow-table values (e.g. BYTES_PER_ELEMENT), so
    // a polymorphic site reading `.BYTES_PER_ELEMENT` off different constructors
    // would false-hit on shape+key alone. Watched intrinsics are immortal, so this
    // pointer is stable (never freed/reused — no ABA). Under MAL_REALMS this
    // storage is the realm tag for primitive-method entries; the modes are
    // mutually exclusive. NULL for other entries.
#if MAL_REALMS
    union {
        const struct MalObject *obj;
        const MalRealm *realm;
        void *entry;
    };
#else
    union {
        const struct MalObject *obj;
        void *entry;
    };
#endif
    // Polymorphic overflow, stored SoA (parallel `poly_shape[i]` / `poly_slot[i]`)
    // for own-slot modes. A transition-store entry uses `poly_shape[0]` for its
    // exact child shape. In inherited modes the same pointer storage retains
    // exact prototype objects: [0] is the receiver's first prototype and [1] is
    // the resolved holder. Missing mode either retains a short all-shaped chain
    // here (polymorphic across equal-layout prototype objects) or one exact
    // deep/dictionary first prototype. Exact identity matters because equal
    // receiver shapes do not imply equal prototype objects or dictionary state.
    union {
        const struct MalShape *poly_shape[MAL_IC_POLY_EXTRA];
        const struct MalObject *proto_object[MAL_IC_POLY_EXTRA];
    };
    u8 slot;
    byte poly_data[8];
    u8 prim_kind;
    u8 poly_count;
    // In inherited modes, receiver shape + null overflow guard own absence.
    // A positive dependency-registered value row has poly_count > 0; exact
    // first-prototype identity plus eager chain invalidation keeps its cached value
    // sound at arbitrary depth. The poly_count == 0 value row retains the watched
    // built-in protector fallback. Slot/table rows are the global-epoch fallback.
    u8 mode;
    u8 receiver_type;
    bool megamorphic;
} MalInlineCache;

// One per property-access site; 10% smaller than the former 80-byte row.
static_assert(sizeof(MalInlineCache) == 72, "MalInlineCache must stay 72 bytes");

static inline u8 mal_ic_poly_slot(const MalInlineCache *ic, u8 index) {
    return ic->poly_data[index];
}

static inline void mal_ic_set_poly_slot(MalInlineCache *ic, u8 index, u32 slot) {
    if (slot >= UINT8_MAX) abort();
    ic->poly_data[index] = (u8) slot;
}

/** Packed deep-chain fallback epoch in the first eight payload bytes. */
static inline u64 mal_ic_unpack_prototype_epoch(const MalInlineCache *ic) {
    u64 epoch = 0;
    for (u8 i = 0; i < 8; i++) {
        epoch |= (u64) ic->poly_data[i] << (i * 8);
    }
    return epoch;
}

u64 mal_ic_recorded_prototype_epoch(const MalInlineCache *ic);

static inline void mal_ic_set_recorded_prototype_epoch(MalInlineCache *ic, u64 epoch) {
    for (u8 i = 0; i < 8; i++) {
        ic->poly_data[i] = (byte) (epoch >> (i * 8));
    }
}

// `slot` sentinel marking a protector-gated value entry (`value` holds the result,
// there is no object slot). A real shape slot is a small inline index.
#define MAL_IC_VALUE_SLOT UINT8_MAX

#define MAL_IC_MODE_SHAPE 0u
#define MAL_IC_MODE_INHERITED_VALUE 1u
#define MAL_IC_MODE_PRIMITIVE_VALUE 2u
#define MAL_IC_MODE_STRING_LENGTH 3u
#define MAL_IC_MODE_ARRAY_LENGTH 4u
#define MAL_IC_MODE_INHERITED_SLOT 5u
#define MAL_IC_MODE_INHERITED_TABLE 6u
#define MAL_IC_MODE_MISSING 7u
#define MAL_IC_MODE_TRANSITION 8u

#define MAL_IC_MISSING_SHAPE_CHAIN 0u
#define MAL_IC_MISSING_EXACT_CHAIN 1u

// Primitive kinds for MAL_IC_MODE_PRIMITIVE_VALUE (0 = not cacheable).
enum {
    MAL_PRIM_KIND_STRING = 1,
    MAL_PRIM_KIND_NUMBER,
    MAL_PRIM_KIND_BOOLEAN,
    MAL_PRIM_KIND_SYMBOL,
    MAL_PRIM_KIND_BIGINT,
};

static inline u8 mal_vm_primitive_method_kind(MalValue value) {
    if (mal_value_is_string(value)) return MAL_PRIM_KIND_STRING;
    // +/-Infinity and -0 have dedicated static tags rather than the f64 tag.
    if (mal_value_is_int32(value) || mal_value_is_f64_or_nan(value) ||
        value == MAL_VALUE_NEGATIVE_ZERO || value == MAL_VALUE_POSITIVE_INFINITY ||
        value == MAL_VALUE_NEGATIVE_INFINITY) {
        return MAL_PRIM_KIND_NUMBER;
    }
    if (mal_value_is_boolean(value)) return MAL_PRIM_KIND_BOOLEAN;
    if (mal_value_is_symbol(value)) return MAL_PRIM_KIND_SYMBOL;
    if (mal_value_is_bigint(value)) return MAL_PRIM_KIND_BIGINT;
    return 0;
}

static inline MalIntrinsic mal_vm_primitive_method_proto_slot(u8 kind) {
    switch (kind) {
        case MAL_PRIM_KIND_STRING: return MAL_INTRINSIC_STRING_PROTOTYPE;
        case MAL_PRIM_KIND_NUMBER: return MAL_INTRINSIC_NUMBER_PROTOTYPE;
        case MAL_PRIM_KIND_BOOLEAN: return MAL_INTRINSIC_BOOLEAN_PROTOTYPE;
        case MAL_PRIM_KIND_SYMBOL: return MAL_INTRINSIC_SYMBOL_PROTOTYPE;
        default: return MAL_INTRINSIC_BIGINT_PROTOTYPE;
    }
}

// Megamorphic stub cache: a shared, per-VM, direct-mapped (shape, key) -> data slot
// table consulted when a per-site cache has gone megamorphic (saw more shapes than
// the inline N-way holds). It scales to any number of shapes and bounds the
// megamorphic worst case — an O(1) probe instead of a per-access shape search that
// also thrashes the single site cache. Loads accept any data slot; stores additionally
// require the cached attributes to be default-writable. Direct-mapped: a collision
// just re-resolves and overwrites, so a stale/absent entry is only a perf miss.
#define MAL_STUB_CACHE_BITS 10
#define MAL_STUB_CACHE_SIZE (1u << MAL_STUB_CACHE_BITS)

typedef struct MalPropertyStubEntry {
    const struct MalShape *shape;
    MalValue key;
    u32 slot;
    u8 attrs;
} MalPropertyStubEntry;

static_assert(sizeof(MalPropertyStubEntry) == 24,
              "property stub entry must stay in three words");

/** Direct-mapped index for (shape, key) in the stub cache. */
static inline u32 mal_stub_hash(const struct MalShape *shape, MalValue key) {
    // Heap size classes make nearby shapes share many low address bits. Avalanche
    // the full pointer/key mix before masking so those layouts do not collapse
    // onto one direct-mapped row.
    u64 h = ((u64) (uptr) shape >> 4) ^ ((u64) key * UINT64_C(0x9e3779b97f4a7c15));
    h ^= h >> 30;
    h *= UINT64_C(0xbf58476d1ce4e5b9);
    h ^= h >> 27;
    h *= UINT64_C(0x94d049bb133111eb);
    h ^= h >> 31;
    return (u32) h & (MAL_STUB_CACHE_SIZE - 1u);
}

/**
 * Inline-cached property load/store miss handlers. Generated code and the
 * interpreter first probe plain-object slots and guarded value/length entries;
 * everything else falls through here for polymorphic probes, generic semantics,
 * and cache refill. Stores remain limited to plain shaped data slots.
 */
MalValue mal_vm_op_load_property_ic(MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic);

void mal_vm_op_store_property_ic(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict, MalInlineCache *ic);

typedef struct MalPropertyCachePool {
    MalInlineCache *sites;
} MalPropertyCachePool;

/** Address a lazily allocated dense property cache entry. */
static inline MalInlineCache *mal_vm_property_ic_at(
    MalCallable *callable, i32 ic_index
) {
    mal_vm_ensure_function_caches(
        callable->vm, callable->function_index);
    MalInlineCache *caches =
        callable->vm->property_cache[callable->function_index].sites;
    return &caches[ic_index];
}

/** Lazily allocate the shared megamorphic property stub array. */
MalPropertyStubEntry *mal_vm_property_stub_cache(MalVm *vm);

/**
 * Inline dense-array index access for the native backend (emit-c), so a `obj[i]`
 * read/write of a dense array is a direct vector load/store rather than a nested
 * runtime call. A non-array object, a non-int32 key, or a dense miss falls back to
 * the inline-cached op (which handles every other case identically). At -O2 the
 * C compiler inlines the dense check into the caller; the fallback call survives only
 * on the slow path. These mirror the runtime fast paths in mal_vm_op_store_property_keyed
 * / mal_vm_get_property_with_receiver, so the interpreter and native backends agree.
 */
/**
 * Plain-object (`MAL_HEAP_OBJECT`) guard for a property-access region: returns the
 * object pointer, or null for any non-plain-object receiver (array/function/primitive
 * wrapper/…), which then takes the general IC path. Like mal_vm_as_array, the guard is
 * sound across a whole region even past a call/allocation — the heap type is invariant,
 * the collector is non-moving, and the object register keeps it rooted.
 */
static inline MalObject *mal_vm_as_object(MalValue v) {
    return mal_value_is_heap_type(v, MAL_HEAP_OBJECT) ? (MalObject *) mal_value_to_heap(v) : nullptr;
}

/** Return the exact precompiled literal-shape case for a plain object, or -1. */
static inline i32 mal_vm_select_shape_case(
    MalVm *vm, MalValue receiver, i32 candidate_count, const i32 *candidates
) {
    MAL_PERF_COUNT(shape_case_probes);
    MalObject *object = mal_vm_as_object(receiver);
    if (object == nullptr) {
        MAL_PERF_COUNT(shape_case_fallbacks);
        return -1;
    }
    for (i32 index = 0; index < candidate_count; index++) {
        i32 function_index = candidates[index * 2];
        i32 shape_cache_index = candidates[index * 2 + 1];
        if (function_index < 0 ||
            function_index >= vm->definition->function_count ||
            shape_cache_index < 0 ||
            shape_cache_index >=
                vm->definition->functions[function_index].literal_shape_count) {
            continue;
        }
        MalShape **row = vm->literal_shape_cache[function_index];
        MalShape *shape = row == nullptr ? nullptr : row[shape_cache_index];
        if (shape != nullptr && object->shape == shape) {
            MAL_PERF_COUNT(shape_case_hits);
            return index;
        }
    }
    MAL_PERF_COUNT(shape_case_fallbacks);
    return -1;
}

/** Read the slot licensed by a preceding, still-live exact shape case. */
static inline bool mal_vm_try_load_shape_case(
    MalValue receiver,
    i32 shape_case,
    i32 slot_count,
    const i32 *slots,
    MalValue *out
) {
    MAL_PERF_COUNT(shape_case_load_probes);
    if (shape_case < 0 || shape_case >= slot_count) {
        MAL_PERF_COUNT(shape_case_load_fallbacks);
        return false;
    }
    MalObject *object = mal_vm_as_object(receiver);
    if (object == nullptr) {
        MAL_PERF_COUNT(shape_case_load_fallbacks);
        return false;
    }
    i32 slot = slots[shape_case];
    if (slot < 0 || (u32) slot >= object->shape->inline_count) {
        MAL_PERF_COUNT(shape_case_load_fallbacks);
        return false;
    }
    *out = object->slots[slot];
    MAL_PERF_COUNT(shape_case_load_hits);
    return true;
}

static inline bool mal_vm_object_try_load_static(
    const MalObject *object, const MalInlineCache *ic, MalValue *out
);

/** Warm one empty property IC from portable compiler-certified shape rows. */
static inline void mal_vm_seed_known_own_slot_ic(
    MalVm *vm,
    MalInlineCache *ic,
    MalValue key,
    i32 candidate_count,
    const i32 *candidates
) {
    if (ic->key != 0) return;
    for (i32 index = 0; index < candidate_count; index++) {
        i32 shape_function_index = candidates[index * 3];
        i32 shape_cache_index = candidates[index * 3 + 1];
        i32 slot = candidates[index * 3 + 2];
        if (shape_function_index < 0 ||
            shape_function_index >= vm->definition->function_count ||
            shape_cache_index < 0 ||
            shape_cache_index >=
                vm->definition->functions[shape_function_index].literal_shape_count ||
            slot < 0 || slot >= UINT8_MAX) {
            continue;
        }
        MalShape **row = vm->literal_shape_cache[shape_function_index];
        MalShape *shape = row == nullptr ? nullptr : row[shape_cache_index];
        if (shape == nullptr || (u32) slot >= shape->inline_count) continue;
        if (ic->shape == nullptr) {
            ic->shape = shape;
            ic->key = key;
            ic->slot = (u8) slot;
            ic->prim_kind = 0;
            ic->poly_count = 0;
            ic->mode = MAL_IC_MODE_SHAPE;
            ic->receiver_type = 0;
            ic->megamorphic = false;
#if MAL_REALMS
            ic->realm = nullptr;
#else
            ic->obj = nullptr;
#endif
            continue;
        }
        bool duplicate = ic->shape == shape;
        for (u8 candidate = 0; !duplicate && candidate < ic->poly_count; candidate++) {
            duplicate = ic->poly_shape[candidate] == shape;
        }
        if (duplicate || ic->poly_count >= MAL_IC_POLY_EXTRA) continue;
        ic->poly_shape[ic->poly_count] = shape;
        mal_ic_set_poly_slot(ic, ic->poly_count, (u32) slot);
        ic->poly_count++;
    }
}

/**
 * Exact shaped-literal own-slot read shared by compiled and interpreted output.
 * Referenced source rows are normally pre-instantiated at VM initialization or
 * splice time; lazy literal creation remains a defensive fallback. Every miss
 * retains the ordinary static-property IC operation.
 */
static inline bool mal_vm_try_load_known_own_slots(
    MalVm *vm,
    MalValue receiver,
    MalInlineCache *ic,
    i32 candidate_count,
    const i32 *candidates,
    MalValue *out
) {
    MAL_PERF_COUNT(known_own_slot_load_probes);
    MalObject *object = mal_vm_as_object(receiver);
    if (object != nullptr && mal_vm_object_try_load_static(object, ic, out)) {
        MAL_PERF_COUNT(known_own_slot_load_hits);
        return true;
    }
    if (object != nullptr) {
        for (i32 index = 0; index < candidate_count; index++) {
            i32 shape_function_index = candidates[index * 3];
            i32 shape_cache_index = candidates[index * 3 + 1];
            i32 slot = candidates[index * 3 + 2];
            MalShape **row = vm->literal_shape_cache[shape_function_index];
            MalShape *expected = row == nullptr ? nullptr : row[shape_cache_index];
            if (expected == nullptr || object->shape != expected) continue;
            *out = object->slots[slot];
            MAL_PERF_COUNT(known_own_slot_load_hits);
            return true;
        }
    }
    MAL_PERF_COUNT(known_own_slot_load_fallbacks);
    return false;
}

/**
 * Monomorphic shape-slot read of `object[key]` via the site's inline cache. Returns
 * true and writes *out on a primary or bounded-polymorphic shape hit. A miss
 * (unknown shape, computed-key mismatch, or value-slot/accessor entry) goes to
 * the out-of-line mega/refill path. A data-slot hit reads `slots[slot]` and runs
 * no user code, so a region access omits the throw check on the hit path. A
 * zero-initialized cache has shape==null and poly_count==0, so it misses.
 */
static inline bool mal_vm_object_try_load(const MalObject *object, MalValue key, const MalInlineCache *ic,
                                          MalValue *out) {
    if (ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        mal_perf_ic_load_mono_hit();
        *out = object->slots[ic->slot];
        return true;
    }
    if (ic->mode == MAL_IC_MODE_SHAPE && ic->poly_count > 0 && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        for (u8 i = 0; i < ic->poly_count; i++) {
            if (object->shape == ic->poly_shape[i]) {
                MAL_PERF_COUNT(ic_load_poly_hits);
                *out = object->slots[mal_ic_poly_slot(ic, i)];
                return true;
            }
        }
    }
    return false;
}

/**
 * Static-name variant of mal_vm_object_try_load. The instruction owns one cache
 * and can only ever fill it for its baked-in name, so the cached key is already
 * the site's key. Passing it back through the common inline probe lets the C
 * optimizer erase the otherwise-redundant key equality from the hit path.
 */
static inline bool mal_vm_object_try_load_static(const MalObject *object,
                                                 const MalInlineCache *ic, MalValue *out) {
    return mal_vm_object_try_load(object, ic->key, ic, out);
}

static inline bool mal_vm_local_inherited_value_try_load_static(
    const MalObject *object, const MalInlineCache *ic, MalValue *out
) {
    if (object == nullptr || ic->mode != MAL_IC_MODE_INHERITED_VALUE ||
        ic->poly_count == 0 || object->shape != ic->shape ||
        object->prototype != ic->proto_object[0] || object->overflow != nullptr) {
        return false;
    }
    *out = ic->value;
    mal_perf_ic_load_inherited_hit();
    return true;
}

/**
 * Static-name loop probe for one watched inherited value. The compiler admits the
 * protector once at function entry and supplies its family epoch; any intervening
 * JavaScript mutation bumps that epoch and makes this probe fail closed.
 */
static inline bool mal_vm_local_watched_inherited_value_try_load_static(
    const MalVm *vm, u64 watched_methods_epoch, MalValue receiver,
    const MalInlineCache *ic, MalValue *out
) {
    if (watched_methods_epoch == 0 ||
        watched_methods_epoch != vm->semantic_epochs.watched_methods ||
        ic->mode != MAL_IC_MODE_INHERITED_VALUE || ic->poly_count != 0 ||
        !mal_value_is_object(receiver)) {
        return false;
    }
    const MalObject *object = (const MalObject *) mal_value_to_heap(receiver);
    if ((u8) object->header.type != ic->receiver_type || object->shape != ic->shape ||
        object->prototype != ic->obj || object->overflow != nullptr) {
        return false;
    }
    *out = ic->value;
    mal_perf_ic_load_inherited_hit();
    return true;
}

/**
 * Static-name proof for a watched primitive method inside compiled optimistic
 * regions. The function-entry snapshot is zero unless the legacy protector was
 * live; every later watched-method mutation bumps the family epoch. Exact Realm
 * and prototype identity keep a cache row from crossing intrinsic families.
 *
 * `expected_kind` is supplied by compiler metadata for the fused builtin
 * protocol. The receiver is deliberately not inspected here: a region may
 * process many primitive values under the same licensed method row, and its
 * per-operation brand proof/check remains separate.
 */
static inline bool mal_vm_local_watched_primitive_value_try_load_static(
    const MalVm *vm, u64 watched_methods_epoch, u8 expected_kind,
    const MalInlineCache *ic, MalValue *out
) {
    if (watched_methods_epoch == 0 ||
        watched_methods_epoch != vm->semantic_epochs.watched_methods ||
        ic->mode != MAL_IC_MODE_PRIMITIVE_VALUE || ic->prim_kind != expected_kind
#if MAL_REALMS
        || ic->realm != vm->current_realm
#endif
    ) {
        return false;
    }
    MalIntrinsic slot = mal_vm_primitive_method_proto_slot(expected_kind);
    if (ic->prototype != (const MalObject *) mal_value_to_heap(vm->intrinsics[slot])) {
        return false;
    }
    *out = ic->value;
    mal_perf_ic_load_primitive_hit();
    return true;
}

/** Guarded inherited data-property slot/entry hit, plus the watched-value fallback. */
static inline bool mal_vm_inherited_try_load(MalValue receiver, MalValue key,
                                              const MalInlineCache *ic, MalValue *out) {
    if (key != ic->key) {
        return false;
    }

    if (ic->mode == MAL_IC_MODE_INHERITED_VALUE) {
        if (ic->poly_count > 0) {
            if (!mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT)) {
                return false;
            }
            const MalObject *object = (const MalObject *) mal_value_to_heap(receiver);
            if (object->shape != ic->shape ||
                object->prototype != ic->proto_object[0] ||
                object->overflow != nullptr) {
                return false;
            }
            *out = ic->value;
            mal_perf_ic_load_inherited_hit();
            return true;
        }
        if (!mal_primitive_method_protector || !mal_value_is_object(receiver)) {
            return false;
        }
        const MalObject *object = (const MalObject *) mal_value_to_heap(receiver);
        if ((u8) object->header.type != ic->receiver_type || object->shape != ic->shape ||
            object->prototype != ic->obj || object->overflow != nullptr) {
            return false;
        }
        *out = ic->value;
        mal_perf_ic_load_inherited_hit();
        return true;
    }

    if (ic->mode == MAL_IC_MODE_MISSING) {
        if (!mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT)) {
            return false;
        }
        const MalObject *object = mal_value_to_object(receiver);
        if (object->shape != ic->shape || object->overflow != nullptr) {
            return false;
        }
        if (ic->receiver_type == MAL_IC_MISSING_EXACT_CHAIN) {
            if (ic->poly_count > 0) {
                if (object->prototype != ic->proto_object[0]) {
                    return false;
                }
            } else {
                if (object->prototype != ic->proto_object[0] ||
                    mal_prototype_chain_epoch == 0 ||
                    mal_prototype_chain_epoch != mal_ic_recorded_prototype_epoch(ic)) {
                    return false;
                }
            }
        } else {
            const MalObject *cursor = object;
            for (u8 depth = 0; depth < ic->poly_count; depth++) {
                cursor = cursor->prototype;
                if (cursor == nullptr || cursor->header.type != MAL_HEAP_OBJECT ||
                    cursor->shape != ic->poly_shape[depth] ||
                    cursor->overflow != nullptr) {
                    return false;
                }
            }
            if (cursor->prototype != nullptr) {
                return false;
            }
        }
        *out = mal_value_new_undefined();
        MAL_PERF_COUNT(ic_load_missing_hits);
        return true;
    }

    if ((ic->mode != MAL_IC_MODE_INHERITED_SLOT &&
         ic->mode != MAL_IC_MODE_INHERITED_TABLE) ||
        !mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT)) {
        return false;
    }

    const MalObject *object = mal_value_to_object(receiver);
    if (object->shape != ic->shape || object->overflow != nullptr) {
        return false;
    }
    const MalObject *holder;
    if (ic->poly_count > 0) {
        if (object->prototype != ic->proto_object[0]) {
            return false;
        }
        holder = ic->proto_object[1];
    } else {
        if (object->prototype != ic->proto_object[0] ||
            mal_prototype_chain_epoch == 0 ||
            mal_prototype_chain_epoch != mal_ic_recorded_prototype_epoch(ic)) {
            return false;
        }
        holder = ic->proto_object[1];
    }

    if (ic->mode == MAL_IC_MODE_INHERITED_SLOT) {
        *out = holder->slots[ic->slot];
    } else {
        if (holder->overflow == nullptr || !mal_table_entry_matches(
                holder->overflow, ic->entry, ic->table_handle_epoch,
                mal_key_from_value(key))) {
            return false;
        }
        MalPropertyDesc desc = mal_property_entry_desc(holder->overflow, ic->entry);
        if (desc.flags & MAL_PROPERTY_ACCESSOR) {
            return false;
        }
        *out = desc.value;
    }
    mal_perf_ic_load_inherited_hit();
    return true;
}

static inline bool mal_vm_inherited_try_load_static(MalValue receiver,
                                                     const MalInlineCache *ic, MalValue *out) {
    return mal_vm_inherited_try_load(receiver, ic->key, ic, out);
}

/** Guarded own-value hit for watched built-ins whose properties live in overflow tables. */
static inline bool mal_vm_watched_try_load(MalValue receiver, MalValue key,
                                           const MalInlineCache *ic, MalValue *out) {
    if (!mal_primitive_method_protector || ic->mode != MAL_IC_MODE_SHAPE ||
        ic->slot != MAL_IC_VALUE_SLOT || ic->prim_kind != 0 || key != ic->key ||
        !mal_value_is_object(receiver) || mal_value_to_object(receiver) != ic->obj) {
        return false;
    }
    *out = ic->value;
    MAL_PERF_COUNT(ic_load_watched_hits);
    return true;
}

static inline bool mal_vm_watched_try_load_static(MalValue receiver,
                                                   const MalInlineCache *ic, MalValue *out) {
    return mal_vm_watched_try_load(receiver, ic->key, ic, out);
}

/**
 * Protector/type-gated value and exotic-length entries. Fill sites admit only
 * VM-lifetime canonical string atoms, so identity is stable and a computed-key
 * site cannot use a result cached for an alternating key. Length is read from
 * the receiver on every hit; only the resolution is cached.
 */
static inline bool mal_vm_special_try_load(MalVm *vm, MalValue receiver, MalValue key,
                                           const MalInlineCache *ic, MalValue *out) {
    if (key != ic->key) {
        return false;
    }
    if (ic->mode == MAL_IC_MODE_PRIMITIVE_VALUE) {
        if (!mal_primitive_method_protector ||
            mal_vm_primitive_method_kind(receiver) != ic->prim_kind
#if MAL_REALMS
            || ic->realm != vm->current_realm
#endif
        ) {
            return false;
        }
        MalIntrinsic slot = mal_vm_primitive_method_proto_slot(ic->prim_kind);
        if (ic->prototype != (const MalObject *) mal_value_to_heap(vm->intrinsics[slot])) {
            return false;
        }
        *out = ic->value;
        mal_perf_ic_load_primitive_hit();
        return true;
    }
    if (ic->mode == MAL_IC_MODE_STRING_LENGTH && mal_value_is_string(receiver)) {
        *out = mal_value_from_i32((i32) mal_value_to_string(receiver)->length);
        mal_perf_ic_load_string_length_hit();
        return true;
    }
    if (ic->mode == MAL_IC_MODE_ARRAY_LENGTH &&
        mal_value_is_heap_type(receiver, MAL_HEAP_ARRAY_OBJECT)) {
        const MalArrayObject *array = (const MalArrayObject *) mal_value_to_heap(receiver);
        *out = mal_ops_number_value((f64) array->length);
        mal_perf_ic_load_array_length_hit();
        return true;
    }
    return false;
}

static inline bool mal_vm_special_try_load_static(MalVm *vm, MalValue receiver,
                                                   const MalInlineCache *ic, MalValue *out) {
    return mal_vm_special_try_load(vm, receiver, ic->key, ic, out);
}

/** Apply only a proven, nonallocating property-load cache hit. */
static inline bool mal_vm_property_try_load(MalVm *vm, MalValue receiver, MalValue key,
                                            const MalInlineCache *ic, MalValue *out) {
    if (ic->mode == MAL_IC_MODE_INHERITED_VALUE ||
        ic->mode == MAL_IC_MODE_INHERITED_SLOT ||
        ic->mode == MAL_IC_MODE_INHERITED_TABLE ||
        ic->mode == MAL_IC_MODE_MISSING) {
        return mal_vm_inherited_try_load(receiver, key, ic, out);
    }
    MalObject *object = mal_vm_as_object(receiver);
    return (object != nullptr && mal_vm_object_try_load(object, key, ic, out)) ||
        mal_vm_watched_try_load(receiver, key, ic, out) ||
        mal_vm_special_try_load(vm, receiver, key, ic, out);
}

/** Static-name property probe: the site identity supplies the key guard. */
static inline bool mal_vm_property_try_load_static(MalVm *vm, MalValue receiver,
                                                   const MalInlineCache *ic, MalValue *out) {
    if (ic->mode == MAL_IC_MODE_INHERITED_VALUE ||
        ic->mode == MAL_IC_MODE_INHERITED_SLOT ||
        ic->mode == MAL_IC_MODE_INHERITED_TABLE ||
        ic->mode == MAL_IC_MODE_MISSING) {
        return mal_vm_inherited_try_load_static(receiver, ic, out);
    }
    MalObject *object = mal_vm_as_object(receiver);
    return (object != nullptr && mal_vm_object_try_load_static(object, ic, out)) ||
        mal_vm_watched_try_load_static(receiver, ic, out) ||
        mal_vm_special_try_load_static(vm, receiver, ic, out);
}

/**
 * Monomorphic shape-slot overwrite or proven fresh-property shape transition.
 * Returns true when applied; false leaves the store to the general [[Set]].
 * Successful hits run no user code. Existing-slot overwrites need the SATB
 * write barrier; both paths card new references for the generational collector.
 */
static inline bool mal_vm_object_try_store(MalObject *object, MalValue key, MalValue value,
                                           const MalInlineCache *ic) {
    if (ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        mal_perf_ic_store_mono_hit();
        if (mal_object_note_prototype_mutation(object)) {
            MAL_PERF_COUNT(prototype_epoch_define_invalidations);
        }
        mal_gc_write_barrier(object->slots[ic->slot]);
        object->slots[ic->slot] = value;
        mal_gc_card(&object->header, value);
        return true;
    }
    if (ic->mode == MAL_IC_MODE_SHAPE && ic->poly_count > 0 && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        for (u8 i = 0; i < ic->poly_count; i++) {
            if (object->shape == ic->poly_shape[i]) {
                MAL_PERF_COUNT(ic_store_poly_hits);
                u8 slot = mal_ic_poly_slot(ic, i);
                if (mal_object_note_prototype_mutation(object)) {
                    MAL_PERF_COUNT(prototype_epoch_define_invalidations);
                }
                mal_gc_write_barrier(object->slots[slot]);
                object->slots[slot] = value;
                mal_gc_card(&object->header, value);
                return true;
            }
        }
    }
    // The slow fill proved that the ordinary prototype chain permits creating
    // this own property and registered the cache row against every prototype.
    // Structural mutations eagerly invalidate it, leaving an O(1) hit guard.
    if (ic->mode == MAL_IC_MODE_TRANSITION && object->shape == ic->shape &&
        key == ic->key && object->prototype == ic->obj &&
        object->overflow == nullptr && object->extensible) {
        const MalShape *child = ic->poly_shape[0];
        u32 old_count = object->shape->inline_count;
        if (object->watched_method_proto) {
            mal_invalidate_primitive_method_protector();
        }
        if (mal_object_note_prototype_mutation(object)) {
            MAL_PERF_COUNT(prototype_epoch_define_invalidations);
        }
        mal_object_grow_slots(object, old_count, child->inline_count);
        object->slots[ic->slot] = value;
        object->shape = (MalShape *) child;
        mal_gc_card(&object->header, value);
        mal_gc_card(&object->header, key);
        MAL_PERF_COUNT(ic_store_transition_hits);
        return true;
    }
    return false;
}

static inline bool mal_vm_object_try_store_static(MalObject *object, MalValue value,
                                                  const MalInlineCache *ic) {
    return mal_vm_object_try_store(object, ic->key, value, ic);
}

/** Apply only a proven writable-slot overwrite or fresh-property transition. */
static inline bool mal_vm_property_try_store(MalValue receiver, MalValue key, MalValue value,
                                             const MalInlineCache *ic) {
    MalObject *object = mal_vm_as_object(receiver);
    return object != nullptr && mal_vm_object_try_store(object, key, value, ic);
}

/** Static-name store probe: the site identity supplies the key guard. */
static inline bool mal_vm_property_try_store_static(MalValue receiver, MalValue value,
                                                    const MalInlineCache *ic) {
    MalObject *object = mal_vm_as_object(receiver);
    return object != nullptr && mal_vm_object_try_store_static(object, value, ic);
}

/**
 * Barriered overwrite of a known data slot — the fast store in a consolidated object
 * region, where the region's shape guard has already established that `slot` is a
 * writable data slot on this object's shape (so this runs no user code).
 */
static inline void mal_vm_object_slot_store(MalObject *object, u32 slot, MalValue value) {
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_define_invalidations);
    }
    mal_gc_write_barrier(object->slots[slot]);
    object->slots[slot] = value;
    mal_gc_card(&object->header, value);
}

/** Exact shaped-literal writable-slot overwrite with the ordinary store as fallback. */
static inline bool mal_vm_try_store_known_own_slots(
    MalVm *vm,
    MalValue receiver,
    MalValue value,
    MalInlineCache *ic,
    i32 candidate_count,
    const i32 *candidates
) {
    MAL_PERF_COUNT(known_own_slot_store_probes);
    MalObject *object = mal_vm_as_object(receiver);
    if (object != nullptr && mal_vm_object_try_store_static(object, value, ic)) {
        MAL_PERF_COUNT(known_own_slot_store_hits);
        return true;
    }
    if (object != nullptr) {
        for (i32 index = 0; index < candidate_count; index++) {
            i32 shape_function_index = candidates[index * 3];
            i32 shape_cache_index = candidates[index * 3 + 1];
            i32 slot = candidates[index * 3 + 2];
            MalShape **row = vm->literal_shape_cache[shape_function_index];
            MalShape *expected = row == nullptr ? nullptr : row[shape_cache_index];
            if (expected == nullptr || object->shape != expected) continue;
            mal_vm_object_slot_store(object, (u32) slot, value);
            MAL_PERF_COUNT(known_own_slot_store_hits);
            return true;
        }
    }
    MAL_PERF_COUNT(known_own_slot_store_fallbacks);
    return false;
}

static inline bool mal_vm_array_try_load(const MalArrayObject *arr, f64 index, MalValue *out);
static inline bool mal_vm_array_try_store(MalArrayObject *arr, f64 index, MalValue value);

static inline MalValue mal_vm_array_fast_load(MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic) {
    if ((mal_value_is_int32(key_value) || mal_value_is_f64(key_value)) &&
        mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT)) {
        f64 index = mal_value_is_int32(key_value)
            ? (f64) mal_value_to_i32(key_value)
            : mal_value_to_f64(key_value);
        MalValue out;
        if (mal_vm_array_try_load(
                (const MalArrayObject *) mal_value_to_heap(object_value), index, &out)) {
            return out;
        }
    }
    // Inline the monomorphic object-shape hit so a repeat `o.k` read is a shape +
    // key compare and a slot load in the caller, not an out-of-line call. The
    // value-slot (watched-intrinsic) and miss cases defer to mal_vm_op_load_property_ic,
    // which also refills the cache.
    MalValue out;
    if (mal_vm_property_try_load(vm, object_value, key_value, ic, &out)) {
        return out;
    }
    // Everything past the monomorphic hit (polymorphic overflow, megamorphic stub
    // probe, and the miss/refill) lives in mal_vm_op_load_property_ic, out of line:
    // keeping this inline fast path tiny stops the poly/mega logic from bloating
    // every compiled property site (which regressed the monomorphic hot path).
    return mal_vm_op_load_property_ic(vm, object_value, key_value, ic);
}

static inline void mal_vm_array_fast_store(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, bool strict, MalInlineCache *ic) {
    if ((mal_value_is_int32(key_value) || mal_value_is_f64(key_value)) &&
        mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT)) {
        f64 index = mal_value_is_int32(key_value)
            ? (f64) mal_value_to_i32(key_value)
            : mal_value_to_f64(key_value);
        if (mal_vm_array_try_store(
                (MalArrayObject *) mal_value_to_heap(object_value), index, value)) {
            return;
        }
    }
    // Inline the monomorphic object-shape hit (mirrors the top of
    // mal_vm_op_store_property_ic): a repeat `o.k = v` overwrite of an existing default
    // (writable) data slot is a barriered slot store in the caller. Everything else
    // (miss, value-slot, accessor, fresh key) defers.
    if (mal_vm_property_try_store(object_value, key_value, value, ic)) {
        return;
    }
    // Polymorphic overflow + miss/refill live out of line in mal_vm_op_store_property_ic
    // (see the load fast path for why the inline path stays monomorphic-only).
    mal_vm_op_store_property_ic(vm, object_value, key_value, value, strict, ic);
}

/**
 * Guarded-access-region primitives (native backend, Phase 1). A run of `arr[i]`
 * accesses on the same array register within a basic block hoists one array guard
 * (`mal_vm_as_array`) instead of re-testing the heap type at every access, then each
 * access attempts a dense hit via `try_load`/`try_store`. A dense hit returns a value
 * already stored in the vector (load) or writes one (store) — it runs NO user code, so
 * the emitted region omits the per-access `completion.kind` throw check on the hit path
 * (only the miss fallback, which routes to the proto chain / a setter, keeps it).
 *
 * The hoisted guard is sound across the whole region even past a call/allocation: an
 * array object's heap type never changes, the collector is non-moving (so the raw
 * `MalArrayObject*` stays valid), and the array register keeps the object rooted. Each
 * access still re-reads `elements`/`dense_count`/`length` fresh, so an intervening store
 * or user callback that grows/reshapes the array is observed correctly.
 */
static inline MalArrayObject *mal_vm_as_array(MalValue v) {
    return mal_value_is_heap_type(v, MAL_HEAP_ARRAY_OBJECT) ? (MalArrayObject *) mal_value_to_heap(v)
                                                            : nullptr;
}

/**
 * Attempt a dense-vector read of `arr[index]`. Returns true and writes *out on a hit
 * (in-range, non-hole); false when the index is not a valid array index or misses the
 * dense region (the caller then takes the general path). Never runs user code.
 */
static inline bool mal_vm_array_try_load(const MalArrayObject *arr, f64 index, MalValue *out) {
    if (index >= 0 && index < (f64) UINT32_MAX) {
        u32 i = (u32) index;
        if ((f64) i == index) {
            return mal_array_object_dense_get(arr, i, out);
        }
    }
    return false;
}

/** A successful dense own-element lookup proves `index in array`; every miss must
 * use the general path because a hole can still be supplied by the prototype. */
static inline bool mal_vm_array_try_has(const MalArrayObject *arr, f64 index) {
    if (arr && index >= 0 && index < (f64) UINT32_MAX) {
        u32 i = (u32) index;
        return (f64) i == index && mal_array_object_dense_has(arr, i);
    }
    return false;
}

/**
 * Attempt a dense-vector store of `arr[index] = value`. Returns true when applied
 * (an overwrite of a present element — own data shadows any inherited setter — or a
 * fresh index under the fast-elements protector on the default %Array.prototype% with
 * a writable length); false when the general [[Set]] is required. Never runs user code.
 * Mirrors the dense arms of mal_vm_array_fast_store_index exactly.
 */
static inline bool mal_vm_array_try_store(MalArrayObject *arr, f64 index, MalValue value) {
    if (index >= 0 && index < (f64) UINT32_MAX) {
        u32 k = (u32) index;
        if ((f64) k != index) {
            return false;
        }
        if (mal_array_object_dense_has(arr, k)) {
            mal_array_object_dense_store(arr, k, value);
            return true;
        }
        if (!arr->dense_deopted && mal_array_elements_protector && arr->object.extensible &&
            arr->length_writable && arr->object.prototype == mal_array_prototype_object) {
            if (mal_array_object_dense_store(arr, k, value) == MAL_ARRAY_DENSE_APPLIED) {
                if (k >= arr->length) {
                    arr->length = k + 1;
                }
                return true;
            }
        }
    }
    return false;
}

/** Reserve the final capacity of a compiler-proven pristine indexed-fill Array. */
bool mal_vm_try_fresh_dense_indexed_fill_reserve(MalVm *vm, MalValue array_value, u32 needed);

/**
 * Numeric-index variants of the fast load/store, for an `obj[i]` site whose index
 * the native backend holds as a raw f64 (number-rep). They take the index UNBOXED
 * so a dense-array access does not box it into a MalValue only for the boxed fast
 * path to unbox it again — the boxing round-trip that dominates a tight
 * element-access loop. The dense test accepts any array index (integral, 0..2^32-1);
 * anything else (a non-array object, a fractional/out-of-range index, a dense miss)
 * boxes the index once and defers to the boxed fast path, which is observably
 * identical (`mal_ops_number_value` canonicalizes exactly as the interpreter's key
 * boxing, so `obj[0]`-on-a-plain-object still services the monomorphic object IC).
 */
static inline MalValue mal_vm_array_fast_load_index(MalVm *vm, MalValue object_value, f64 index,
                                                    MalInlineCache *ic) {
    MalArrayObject *array = mal_vm_as_array(object_value);
    MalValue out;
    if (array != nullptr && mal_vm_array_try_load(array, index, &out)) {
        return out;
    }
    return mal_vm_array_fast_load(vm, object_value, mal_ops_number_value(index), ic);
}

static inline void mal_vm_array_fast_store_index(MalVm *vm, MalValue object_value, f64 index, MalValue value,
                                                 bool strict, MalInlineCache *ic) {
    MalArrayObject *array = mal_vm_as_array(object_value);
    if (array != nullptr && mal_vm_array_try_store(array, index, value)) {
        return;
    }
    mal_vm_array_fast_store(vm, object_value, mal_ops_number_value(index), value, strict, ic);
}

/**
 * Non-calling dense Array-values step shared by native code and interpreter dispatch.
 * The actual iterator record proves the observed @@iterator and captured next method
 * are still the builtins. Length and dense storage are read fresh on every step; a
 * hole or non-array target misses so the generic path performs the prototype-aware Get.
 */
static inline bool mal_vm_iterator_try_dense_array_step(
    const MalIteratorRecord *record, MalValue *value_out, bool *done_out
) {
    if (mal_value_is_iterator_object(record->iterator) &&
        mal_value_is_native_function_object(record->next_method) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(record->next_method)) ==
            mal_array_iterator_next_callback) {
        MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
        if (iterator->kind == MAL_ITERATOR_ARRAY_VALUES &&
            mal_value_is_heap_type(iterator->target, MAL_HEAP_ARRAY_OBJECT)) {
            if (iterator->done) {
                *value_out = mal_value_new_undefined();
                *done_out = true;
                return true;
            }
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
    return false;
}

/** Resolve the immutable portion of the dense Array-values iterator fast path.
 * The iterator record has already observed @@iterator and captured `next`, so a
 * successful result remains valid for that record's lifetime. The iterator and
 * next MalValues must remain rooted while the raw cursor is used. */
static inline MalIteratorObject *mal_vm_iterator_dense_array_cursor(
    const MalIteratorRecord *record
) {
    if (mal_value_is_iterator_object(record->iterator) &&
        mal_value_is_native_function_object(record->next_method) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(record->next_method)) ==
            mal_array_iterator_next_callback) {
        MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
        if (iterator->kind == MAL_ITERATOR_ARRAY_VALUES &&
            mal_value_is_heap_type(iterator->target, MAL_HEAP_ARRAY_OBJECT)) {
            return iterator;
        }
    }
    return nullptr;
}

/**
 * Non-calling step after `mal_vm_iterator_dense_array_cursor` validated the
 * iterator record. Length and dense storage are still read fresh on every step;
 * a hole misses so the generic path performs the prototype-aware Get.
 */
static inline bool mal_vm_iterator_try_dense_array_cursor_step(
    MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    if (iterator->done) {
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }
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
    return false;
}

/** Step a compiler-retained cursor, falling back only for sparse/prototype Get. */
static inline bool mal_vm_iterator_step_dense_array_cursor(
    MalVm *vm, MalIteratorObject *cursor, const MalIteratorRecord *record,
    MalValue *value_out, bool *done_out
) {
    if (mal_vm_iterator_try_dense_array_cursor_step(cursor, value_out, done_out)) {
        return true;
    }
    return mal_vm_iterator_step(vm, record, value_out, done_out);
}

/** Inline iterator step for native code, with the complete protocol as fallback. */
static inline bool mal_vm_iterator_step_fast(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out) {
    if (mal_vm_iterator_try_dense_array_step(record, value_out, done_out)) {
        return true;
    }
    return mal_vm_iterator_step(vm, record, value_out, done_out);
}

void mal_op_to_property_key(MalCallable *callable, const MalInstruction *instruction);

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
 * Clone a compiler-emitted ordinary stack object into one managed cell before
 * it escapes through a return. On OOM, leaves an allocation-error completion.
 */
MalValue mal_vm_materialize_stack_object(MalVm *vm, const struct MalObject *source);

/** Successful stack-object return materializations (benchmark telemetry). */
u64 mal_vm_stack_object_materialization_count(void);

/**
 * Create a plain object directly in `shape` (built from the literal's static
 * keys) with `count` inline slots filled from `values` in key order. The
 * Both backends cache the immutable shape per literal site. See
 * mal_vm_create_object_shaped in vm_ops.c.
 */
MalValue mal_vm_create_object_shaped(MalVm *vm, struct MalShape *shape, const MalValue *values, u32 count);

MalValue mal_vm_op_create_array(MalVm *vm, i32 length);
MalValue mal_vm_instantiate_literal_template(MalVm *vm, i32 template_offset);

MalValue mal_vm_op_create_function(MalVm *vm, i32 function_index, MalEnv *creation_env);

/**
 * Define an own data property (the object-literal / define-semantics path),
 * shared by MAL_OP_DEFINE_PROPERTY and the compiled backend. Like the op, this
 * cannot run user code, so it never leaves a pending throw.
 */
void mal_vm_op_define_property(MalVm *vm, MalValue object_value, MalValue key_value,
                               MalValue value, bool enumerable, bool writable,
                               bool configurable);

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

/**
 * ClassDefinitionEvaluation heritage check: throw a TypeError unless `parent` is
 * null or a constructor whose `prototype` is an object or null.
 */
void mal_vm_op_check_super_class(MalVm *vm, MalValue parent);

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

/** Write or declaration-initialize a global object property. */
void mal_vm_op_store_global_property(
    MalVm *vm, i32 name_string_index, MalValue value, bool strict,
    bool declaration, bool declaration_configurable
);

/** Declaration-initialize a batch of global `var` properties to undefined. */
void mal_vm_op_init_global_vars(
    MalVm *vm, i32 count, const i32 *name_string_indices, bool declaration_configurable
);

/** Read `object`'s internal [[Prototype]] slot (null if none); never throws. */
MalValue mal_vm_op_load_prototype(MalVm *vm, MalValue object_value);

/** SetFunctionName: install the "name" data property (prefix 0=none, 1=get, 2=set). */
void mal_vm_op_set_function_name(MalVm *vm, MalValue func, MalValue key, u8 prefix);

/** Build (or return the cached) tagged-template strings object for one site. */
MalValue mal_vm_op_create_template_object(
    MalVm *vm, i32 cache_slot, i32 count, const i32 *cooked_indices, const i32 *raw_indices
);

/** Build a module namespace exotic object from (name-constant, export-slot) pairs. */
MalValue mal_vm_op_create_module_namespace(
    MalVm *vm, i32 count, const i32 *name_indices, const i32 *slots
);

/**
 * Object rest/spread destructuring: copy source's own enumerable properties (minus
 * `excluded_keys`) onto a fresh object. A source getter / excluded-key ToPropertyKey
 * can throw (sets vm->completion); callers check the completion.
 */
MalValue mal_vm_op_copy_data_properties(
    MalVm *vm, MalValue source, const MalValue *excluded_keys, i32 excluded_count
);

/** A fresh unique private name (hidden private symbol); never throws. */
MalValue mal_vm_op_create_private_name(MalVm *vm);

/** Mint fresh private names directly into captured slots of the class evaluator. */
void mal_vm_op_create_private_names(
    MalVm *vm, MalEnv *env, i32 owner_function_index, i32 count, const i32 *captured_indices
);

/** AddPrivateName: install a private element on a new instance; dup install throws. */
void mal_vm_op_define_private(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value);

/** Install an ordered run of undefined-valued private instance fields. */
void mal_vm_op_init_private_fields(
    MalVm *vm, MalValue object_value, i32 count, const MalValue *keys
);

/** PrivateGet; an unbranded receiver throws (sets vm->completion). */
MalValue mal_vm_op_load_private(MalVm *vm, MalValue object_value, MalValue key_value);

/** PrivateSet; the name must already be installed on the receiver, else throws. */
void mal_vm_op_store_private(MalVm *vm, MalValue object_value, MalValue key_value, MalValue value);

/** Ergonomic brand check `#x in obj`; a non-object receiver throws. */
MalValue mal_vm_op_has_private(MalVm *vm, MalValue object_value, MalValue key_value);

/**
 * Spread call `f(...args)` for the native backend: marshal the array onto the
 * value stack (RangeError on overflow) and dispatch, returning the completion.
 */
MalCompletion mal_vm_op_call_spread(
    MalVm *vm, MalValue callee, MalValue this_value, MalValue arguments_array
);

/**
 * Single-spread call `f(...iterable)`: observe the iterable protocol, marshal a
 * proven builtin dense Array directly, and materialize every other case.
 */
MalCompletion mal_vm_op_call_spread_iterable(
    MalVm *vm, MalValue callee, MalValue this_value, MalValue iterable
);

/** Spread construct `new C(...args)` for the native backend; see call_spread. */
MalCompletion mal_vm_op_construct_spread(MalVm *vm, MalValue callee, MalValue arguments_array);

/** `super.p = v` / `super[k] = v`: write to `receiver` via the super base descriptor. */
void mal_vm_op_store_super_property(
    MalVm *vm, MalValue object_value, MalValue key_value, MalValue value, MalValue receiver, bool strict
);

/**
 * `super.p` / `super[k]`: read from the super base but call any getter with the
 * caller's `this` (GetThisValue), not the base — ECMA-262 SuperProperty
 * evaluation (the thisValue component of the Super Reference is used).
 */
MalValue mal_vm_op_load_super_property(
    MalVm *vm, MalValue base, MalValue key_value, MalValue receiver
);

/**
 * `super(...args)`: construct `parent` with the derived new.target and BindThisValue
 * the result. `current_this` is the (EMPTY) binding; on success *this_out is the
 * bound `this`. Returns the completion (a throw on double-super / no new.target /
 * parent throw).
 */
MalCompletion mal_vm_op_construct_super(
    MalVm *vm, MalValue parent, MalValue arguments_array, MalValue new_target,
    MalValue current_this, MalValue *this_out
);

/** GetThisBinding for a derived constructor: ReferenceError if `this` is unbound. */
MalValue mal_vm_op_get_this(MalVm *vm, MalValue this_value);

/** Derived-constructor RETURN: non-object → bound `this`; returning pre-super throws. */
MalValue mal_vm_op_derived_construct_return(MalVm *vm, MalValue value, MalValue this_value);

/**
 * `with` statement support, shared by the interpreter op and the native backend.
 * Active objects are represented by per-activation object-environment nodes in
 * the ordinary environment chain, so the frame needs no parallel with-object
 * vector. `with_enter` validates the expression and returns the new environment.
 * `with_get`/`with_resolve_base` return the EMPTY sentinel on a miss so the caller
 * falls back to the static binding; `with_set` returns whether a binding was found.
 */
MalEnv *mal_vm_op_with_enter(MalVm *vm, MalEnv *parent, MalValue object);
MalValue mal_vm_op_with_get(MalVm *vm, MalEnv *env, i32 name_string_index);
MalValue mal_vm_op_with_resolve_base(MalVm *vm, MalEnv *env, i32 name_string_index);
bool mal_vm_op_with_set(MalVm *vm, MalEnv *env, i32 name_string_index, MalValue value);

/**
 * Resolve (creating if absent) a function's `.prototype` object — the parent of
 * instances built by [[Construct]]. Exposed for mal_vm_construct_value.
 */
MalValue mal_vm_function_prototype(MalVm *vm, MalValue function_value);

void mal_op_store_super_property(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_super_property(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_prototype(MalCallable *callable, const MalInstruction *instruction);

void mal_op_get_iterator(MalCallable *callable, const MalInstruction *instruction);

void mal_op_get_async_iterator(MalCallable *callable, const MalInstruction *instruction);

void mal_op_iterator_next(MalCallable *callable, const MalInstruction *instruction);

void mal_op_iterator_step(MalCallable *callable, const MalInstruction *instruction);

void mal_op_iterator_close(MalCallable *callable, const MalInstruction *instruction);

void mal_op_for_in_keys(MalCallable *callable, const MalInstruction *instruction);

// for-in enumeration key array for `source`; shared by the interpreter op and
// compiled code. On a proxy-trap exception sets vm->completion (caller checks).
MalValue mal_for_in_keys(MalVm *vm, MalValue source);

void mal_op_delete_property(MalCallable *callable, const MalInstruction *instruction);

void mal_op_define_accessor(MalCallable *callable, const MalInstruction *instruction);

void mal_op_define_property(MalCallable *callable, const MalInstruction *instruction);
void mal_op_set_function_name(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_private_name(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_private_names(MalCallable *callable, const MalInstruction *instruction);

void mal_op_define_private(MalCallable *callable, const MalInstruction *instruction);

void mal_op_init_private_fields(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_private(MalCallable *callable, const MalInstruction *instruction);

void mal_op_store_private(MalCallable *callable, const MalInstruction *instruction);

void mal_op_has_private(MalCallable *callable, const MalInstruction *instruction);

void mal_op_set_prototype(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_undeclared(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_global_property(MalCallable *callable, const MalInstruction *instruction);

void mal_op_store_global_property(MalCallable *callable, const MalInstruction *instruction);

void mal_op_init_global_vars(MalCallable *callable, const MalInstruction *instruction);

void mal_op_require_coercible(MalCallable *callable, const MalInstruction *instruction);
void mal_op_check_super_class(MalCallable *callable, const MalInstruction *instruction);

void mal_op_create_rest_arguments(MalCallable *callable, const MalInstruction *instruction);

// Rest-parameter array from `args[start..]`; shared by the interpreter op and
// compiled code.
MalValue mal_create_rest_arguments(MalVm *vm, const MalValue *args, i32 arg_count, i32 start);

void mal_op_array_rest(MalCallable *callable, const MalInstruction *instruction);

// Array-destructuring rest from `source[start..]`; shared by the interpreter op
// and compiled code. On null/undefined source or a throwing read sets
// vm->completion (caller checks).
MalValue mal_array_rest(MalVm *vm, MalValue source, u32 start);

void mal_op_copy_data_properties(MalCallable *callable, const MalInstruction *instruction);

void mal_op_merge_data_properties(MalCallable *callable, const MalInstruction *instruction);

// ---------------------------------------------------------------------------
// Compiled coroutines (native-backend generators & async). These have no
// interpreter counterpart: the interpreter drives GENERATOR_START/YIELD/AWAIT/
// RETURN inline in its dispatch loop, whereas a compiled coroutine is a single
// C function that suspends by returning and resumes by re-entry.
// ---------------------------------------------------------------------------

// Allocate a compiled coroutine's heap register buffer (all undefined). Sized by
// the backend to cover registers + the with-object stack + a self-reference slot;
// owned by the coroutine object once GENERATOR_START/ASYNC_START adopts it, then
// returned to the VM's bounded buffer pool on completion.
MalValue *mal_coroutine_alloc_registers(MalVm *vm, i32 slot_count);

// GENERATOR_START: build the generator instance (prototype from callee.prototype,
// else the intrinsic generator/async-generator prototype), adopt `registers` as
// its suspended frame at `resume_ip`, and leave it SUSPENDED_START. Returns the
// generator; the compiled body hands it back to the caller.
MalGeneratorObject *mal_vm_op_generator_start_compiled(
    MalVm *vm, MalValue callee, i32 function_index, MalValue this_value, MalEnv *env,
    MalValue *registers, const MalValue *arguments, i32 argument_count,
    bool retain_arguments, i32 resume_ip, bool is_async_generator);

/** Resolve the instance prototype used when a generator activation starts. */
MalObject *mal_vm_generator_instance_prototype(
    MalVm *vm, MalValue callee, bool is_async_generator);

// YIELD (compiled): record the yielded value, resume registers, and resume IP on
// the coroutine, save the current env, mark SUSPENDED_YIELD, and (for an async
// generator) settle the front request. The compiled body then returns.
void mal_vm_op_yield_compiled(
    MalVm *vm, MalGeneratorObject *generator, MalValue yielded, i32 value_dst,
    i32 mode_dst, i32 resume_ip, MalEnv *env);

// TERMINAL_YIELD (compiled): preserve a final done:false result while completing
// the generator. The emitted caller unlinks its root frame, then releases storage.
void mal_vm_op_terminal_yield_compiled(
    MalVm *vm, MalGeneratorObject *generator, MalValue yielded);

// Coroutine RETURN (compiled): mark COMPLETED (before freeing, so the finalizer's
// suspended-only free avoids a double-free), free the register buffer, and route
// the value — async generator / async settle their promise, a plain generator
// leaves it in a NORMAL completion for the .next() driver.
void mal_vm_op_coroutine_return_compiled(MalVm *vm, MalGeneratorObject *generator, MalValue value);

// ASYNC_START (compiled): create the result promise + hidden async state, adopt
// `registers` as the state's suspended frame, and return the state (its result
// promise in *out_promise). Unlike GENERATOR_START the body does not suspend
// here — it keeps running until the first await / return / throw.
MalGeneratorObject *mal_vm_op_async_start_compiled(
    MalVm *vm, MalValue callee, i32 function_index, MalValue this_value, MalEnv *env,
    MalValue *registers, const MalValue *arguments, i32 argument_count,
    bool retain_arguments, MalValue *out_promise);

// AWAIT (compiled): record the resume registers, resume point, and env on the
// async state, mark it suspended, then hook the settlement continuation on the
// awaited value (mal_async_function_await). Shared by async functions and async
// generators; the compiled body returns immediately after.
void mal_vm_op_await_compiled(
    MalVm *vm, MalGeneratorObject *state, MalValue awaited, i32 value_dst, i32 mode_dst,
    i32 resume_ip, MalEnv *env);

// Coroutine uncaught throw (compiled): the body threw past its own handlers. Mark
// COMPLETED and free the register buffer; a plain generator leaves the THROW
// completion for its .next() caller, while an async function rejects its result
// promise (the async body's implicit try/catch). vm->completion.value is the
// pending exception. `generator` is null when a generator's parameter prologue
// throws before GENERATOR_START has created it — the throw then propagates
// synchronously and `registers` (the orphaned buffer) is released here.
void mal_vm_op_coroutine_throw_compiled(MalVm *vm, MalGeneratorObject *generator, MalValue *registers);
