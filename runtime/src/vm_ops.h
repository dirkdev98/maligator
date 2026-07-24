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
 * Speculative-call-inlining guard: whether `callee` is a plain function object with the
 * given function index — the candidate the call site was inlined against. A miss deopts to
 * the real call (so a reassigned global, a bound/native/proxy callee, or any other function
 * simply takes the un-inlined path). The heap-type test is inline; the index accessor is the
 * only out-of-line bit and is reached only when the type already matched.
 */
static inline bool mal_vm_callee_has_index(MalValue callee, i32 function_index) {
    return mal_value_is_heap_type(callee, MAL_HEAP_FUNCTION_OBJECT) &&
           mal_function_object_function_index((const MalFunctionObject *) mal_value_to_heap(callee)) ==
               function_index;
}

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

// Build an unmapped arguments object over `args`; shared by the interpreter op
// and compiled code. `callee` is exposed only in sloppy mode (strict poisons it).
MalValue mal_create_arguments_object(
    MalVm *vm, const MalValue *args, i32 arg_count, MalValue callee, bool strict
);

void mal_op_load_this(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_new_target(MalCallable *callable, const MalInstruction *instruction);

void mal_op_load_callee(MalCallable *callable, const MalInstruction *instruction);

void mal_op_call(MalCallable *callable, const MalInstruction *instruction);

void mal_op_call_spread(MalCallable *callable, const MalInstruction *instruction);

void mal_op_construct(MalCallable *callable, const MalInstruction *instruction);

void mal_op_construct_spread(MalCallable *callable, const MalInstruction *instruction);

/**
 * `super(...args)`: [[Construct]] the parent forwarding the derived
 * constructor's new.target, then bind the result as `this`. The parent comes
 * from registers[parent], the arguments from the array in registers[arguments_array].
 */
void mal_op_construct_super(MalCallable *callable, const MalInstruction *instruction);

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
    if (!mal_ops_is_number(left) || !mal_ops_is_number(right)) {
        return false;
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
    return mal_vm_typeof_result(value) == expected;
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

void mal_op_store_property(MalCallable *callable, const MalInstruction *instruction);
void mal_op_store_property_static(MalCallable *callable, const MalInstruction *instruction);

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
 * out-of-line re-resolve. A shape is immutable and never freed, so a cached
 * (shape -> slot) is valid for the life of the site. Zero-initialized
 * (shape == nullptr, poly_count == 0) means empty — the overflow is inline (no
 * heap allocation), so there is nothing to free on teardown.
 *
 * Fields are grouped 8-byte members first, then the u32 slots, then the byte
 * flags, so the site carries no interior padding.
 */
typedef struct MalInlineCache {
    union {
        const struct MalShape *shape;
        // Exact current-realm primitive prototype for a primitive-value entry.
        const struct MalObject *prototype;
    };
    MalValue key; // the exact key value cached — a computed-key site (o[k]) varies
    // `value` caches a resolved property value for the two protector-gated modes:
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
    MalValue value;
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
    };
#else
    const struct MalObject *obj;
#endif
    // Polymorphic overflow, stored SoA (parallel `poly_shape[i]` / `poly_slot[i]`):
    // plain-object data-slot alternates for `key` beyond the primary. `poly_count`
    // entries are live. `poly_count == 0` is a monomorphic site; `megamorphic` marks
    // a site that saw more than MAL_IC_POLY_EXTRA+1 shapes and stops accumulating (a
    // future megamorphic stub cache serves those). Only valid for a MAL_HEAP_OBJECT
    // receiver whose access key equals `key`.
    const struct MalShape *poly_shape[MAL_IC_POLY_EXTRA];
    u32 slot;
    u32 poly_slot[MAL_IC_POLY_EXTRA];
    u8 prim_kind;
    u8 poly_count;
    // MAL_IC_MODE_INHERITED_VALUE: an exotic/ordinary receiver whose exact heap
    // type, own shape, empty overflow state, and direct watched prototype guard a
    // resolved inherited data value. `obj` is that direct prototype.
    u8 mode;
    u8 receiver_type;
    bool megamorphic;
} MalInlineCache;

// One per property-access site; keep it at/under 80 bytes.
static_assert(sizeof(MalInlineCache) <= 80, "MalInlineCache outgrew 80 bytes");

/** Return an already-allocated interpreter cache entry without filling or allocating. */
static inline MalInlineCache *mal_vm_interp_ic_existing(
    MalCallable *callable, i32 instruction_index
) {
    MalInlineCache *caches = callable->vm->interp_ic[callable->function_index];
    return caches != nullptr ? &caches[instruction_index] : nullptr;
}

// `slot` sentinel marking a protector-gated value entry (`value` holds the result,
// there is no object slot). A real shape slot is a small inline index.
#define MAL_IC_VALUE_SLOT UINT32_MAX

#define MAL_IC_MODE_SHAPE 0u
#define MAL_IC_MODE_INHERITED_VALUE 1u
#define MAL_IC_MODE_PRIMITIVE_VALUE 2u
#define MAL_IC_MODE_STRING_LENGTH 3u
#define MAL_IC_MODE_ARRAY_LENGTH 4u

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
// also thrashes the single site cache. Load-only for now (megamorphic stores are
// rarer and still resolve out-of-line). Direct-mapped: a collision just re-resolves
// and overwrites, so a stale/absent entry is only a perf miss, never wrong.
#define MAL_STUB_CACHE_BITS 10
#define MAL_STUB_CACHE_SIZE (1u << MAL_STUB_CACHE_BITS)

typedef struct MalStubEntry {
    const struct MalShape *shape;
    MalValue key;
    u32 slot;
} MalStubEntry;

/** Direct-mapped index for (shape, key) in the stub cache. */
static inline u32 mal_stub_hash(const struct MalShape *shape, MalValue key) {
    u64 h = ((u64) (uptr) shape >> 4) * 2654435761u ^ ((u64) key * 1099511628211u >> 13);
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

/** Max object shapes a consolidated region caches before it stops accumulating and the
 * overflow (megamorphic) accesses stay on the per-site IC path. */
#define MAL_OBJECT_REGION_MAX_SHAPES 4u

/**
 * Consolidated-object-region shape match (native backend): the index of `shape` among the
 * region's `count` cached variant shapes, or -1. Called once per region entry; a hit means
 * every access in the run reads its slot from `slots[hit * k + i]` with no per-access shape
 * check. Shapes are interned/stable (the property IC relies on the same pointer identity),
 * so this needs no epoch guard — the cache holds only shapes/keys/slots, never a collectable
 * object pointer.
 */
static inline int mal_vm_object_region_variant(const MalShape *shape, const MalShape *const *shapes,
                                               u32 count) {
    for (u32 i = 0; i < count; i++) {
        if (shapes[i] == shape) {
            return (int) i;
        }
    }
    return -1;
}

/**
 * Add `o`'s current shape as a new region variant on the slow path (after the run's per-site
 * ICs resolved). Succeeds — appending the shape, its per-site `slots`, and the shared `keys`,
 * and returning the new variant index — iff there is room (`*count < max`) and every site
 * monomorphically resolved a plain data slot on this shape. Else returns -1 (the run keeps
 * taking the per-site IC path). A load site records a shape data slot and a store site only a
 * default-writable one (see mal_vm_op_{load,store}_property_ic), so `slot != MAL_IC_VALUE_SLOT`
 * on the matched shape makes the region's direct read / barriered overwrite sound; the shape
 * guard (shape encodes attrs) keeps it so.
 */
int mal_vm_object_region_add_variant(const MalObject *o, const MalInlineCache *const *ics, u32 k,
                                     const MalShape **shapes, u32 *slots, MalValue *keys, u32 *count, u32 max);

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

/**
 * Monomorphic shape-slot read of `object[key]` via the site's inline cache. Returns
 * true and writes *out on a hit (cached shape + key resolving to a real data slot);
 * false on any miss (different shape, computed-key mismatch, or a value-slot/accessor
 * entry), which the caller resolves via the out-of-line IC op (poly / mega / refill). A
 * data-slot hit reads `slots[slot]` and runs NO user code, so a region access omits the
 * throwCheck on the hit path. Mirrors the shape/key/slot gate in mal_vm_op_load_property_ic;
 * a zero-initialized cache has shape==null so it misses.
 */
static inline bool mal_vm_object_try_load(const MalObject *object, MalValue key, const MalInlineCache *ic,
                                          MalValue *out) {
    if (ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        mal_perf_ic_load_mono_hit();
        *out = object->slots[ic->slot];
        return true;
    }
    return false;
}

/**
 * Guarded inherited data-property value hit. The fill path admits only immortal
 * exact keys and a watched prototype chain, and only receivers with no overflow
 * table. Thus shape + null-overflow prove no own shadow, exact prototype proves
 * realm/chain identity, and the monotonic protector proves the holder and chain
 * have not been patched or reparented. Proxy receivers are never filled.
 */
static inline bool mal_vm_inherited_try_load(MalValue receiver, MalValue key,
                                             const MalInlineCache *ic, MalValue *out) {
    if (ic->mode != MAL_IC_MODE_INHERITED_VALUE || !mal_primitive_method_protector ||
        key != ic->key || !mal_value_is_object(receiver)) {
        return false;
    }
    const MalObject *object = mal_value_to_object(receiver);
    if ((u8) object->header.type != ic->receiver_type || object->shape != ic->shape ||
        object->prototype != ic->obj || object->overflow != nullptr) {
        return false;
    }
    *out = ic->value;
    mal_perf_ic_load_inherited_hit();
    return true;
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

/**
 * Protector/type-gated value and exotic-length entries. Fill sites admit only
 * immortal exact keys, so identity is stable and a computed-key site cannot use
 * a result cached for equal-looking collectable or alternating keys. Length is
 * read from the receiver on every hit; only the resolution is cached.
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

/** Apply only a proven, nonallocating property-load cache hit. */
static inline bool mal_vm_property_try_load(MalVm *vm, MalValue receiver, MalValue key,
                                            const MalInlineCache *ic, MalValue *out) {
    MalObject *object = mal_vm_as_object(receiver);
    return (object != nullptr && mal_vm_object_try_load(object, key, ic, out)) ||
        mal_vm_inherited_try_load(receiver, key, ic, out) ||
        mal_vm_watched_try_load(receiver, key, ic, out) ||
        mal_vm_special_try_load(vm, receiver, key, ic, out);
}

/**
 * Monomorphic shape-slot overwrite of an existing writable data slot (barriered).
 * Returns true when applied; false (miss / value-slot / accessor / read-only / fresh
 * key) leaves the store to the general [[Set]]. A successful overwrite runs no user
 * code. The gc write-barrier (old value) + card (old->young) are required for the
 * generational collector and fold out when it is off.
 */
static inline bool mal_vm_object_try_store(MalObject *object, MalValue key, MalValue value,
                                           const MalInlineCache *ic) {
    if (ic->mode == MAL_IC_MODE_SHAPE && object->shape == ic->shape && key == ic->key &&
        ic->slot != MAL_IC_VALUE_SLOT) {
        mal_perf_ic_store_mono_hit();
        mal_gc_write_barrier(object->slots[ic->slot]);
        object->slots[ic->slot] = value;
        mal_gc_card(&object->header, value);
        return true;
    }
    return false;
}

/** Apply only a proven existing writable-slot store, including both GC barriers. */
static inline bool mal_vm_property_try_store(MalValue receiver, MalValue key, MalValue value,
                                             const MalInlineCache *ic) {
    MalObject *object = mal_vm_as_object(receiver);
    return object != nullptr && mal_vm_object_try_store(object, key, value, ic);
}

/**
 * Barriered overwrite of a known data slot — the fast store in a consolidated object
 * region, where the region's shape guard has already established that `slot` is a
 * writable data slot on this object's shape (so this runs no user code).
 */
static inline void mal_vm_object_slot_store(MalObject *object, u32 slot, MalValue value) {
    mal_gc_write_barrier(object->slots[slot]);
    object->slots[slot] = value;
    mal_gc_card(&object->header, value);
}

static inline MalValue mal_vm_array_fast_load(MalVm *vm, MalValue object_value, MalValue key_value, MalInlineCache *ic) {
    if (mal_value_is_int32(key_value) && mal_value_is_heap_type(object_value, MAL_HEAP_ARRAY_OBJECT)) {
        i32 index = mal_value_to_i32(key_value);
        MalValue out;
        if (index >= 0 &&
            mal_array_object_dense_get((const MalArrayObject *) mal_value_to_heap(object_value), (u32) index, &out)) {
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
    i64 i = (i64) index;
    if ((f64) i == index && i >= 0 && i <= UINT32_MAX) {
        return mal_array_object_dense_get(arr, (u32) i, out);
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
    i64 i = (i64) index;
    if ((f64) i == index && i >= 0 && i <= UINT32_MAX) {
        u32 k = (u32) i;
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
 * The with-object stack is per-activation and supplied by the caller (the
 * interpreter frame's `with_objects`, or the compiled frame's rooted slots), so
 * these helpers take it as (objects, count). `with_enter` only validates the
 * with-expression (nil → false + pending TypeError); the caller does the push.
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
    MalValue *registers, i32 resume_ip, bool is_async_generator);

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
    MalVm *vm, i32 function_index, MalValue this_value, MalEnv *env, MalValue *registers,
    MalValue *out_promise);

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
