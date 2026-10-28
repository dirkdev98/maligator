#pragma once

#include "./defaults.h"
#include "gc.h"
#include "heap.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "intern_store.h"
#include "perf_stats.h"
#include "profile.h"
#include "shape.h"
#include "value.h"
#include "generated/known_primordials.inc"

#define MAL_COROUTINE_POOL_CLASS_COUNT 14
#define MAL_TINY_STRING_CACHE_CAPACITY 256
#define MAL_SMALL_UINT_STRING_CACHE_CAPACITY 1024
#define MAL_SMALL_BIGINT_CACHE_MIN (-128)
#define MAL_SMALL_BIGINT_CACHE_CAPACITY 384
#define MAL_SHAPE_COPY_CACHE_CAPACITY 64

static_assert((MAL_TINY_STRING_CACHE_CAPACITY
               & (MAL_TINY_STRING_CACHE_CAPACITY - 1)) == 0,
              "tiny string cache capacity must be a power of two");
static_assert((MAL_SHAPE_COPY_CACHE_CAPACITY
               & (MAL_SHAPE_COPY_CACHE_CAPACITY - 1)) == 0,
              "shape copy cache capacity must be a power of two");

typedef enum MalOpcode {
#define BYTECODE_OPERATION(name) MAL_OP_##name,
#include "generated/bytecode_operations.inc"
#undef BYTECODE_OPERATION
    MAL_OP_COUNT,
} MalOpcode;

typedef enum MalBuiltinError {
#define MAL_KNOWN_BUILTIN_ERROR(name, prototype, message) MAL_BUILTIN_ERROR_##name,
#include "generated/known_builtin_errors.inc"
#undef MAL_KNOWN_BUILTIN_ERROR
    MAL_BUILTIN_ERROR_COUNT,
} MalBuiltinError;

/** Exact builtin dispatch order generated from the canonical compiler registry. */
typedef enum MalDirectBuiltinOp {
#define MAL_DIRECT_BUILTIN_OP(operation) operation,
#include "generated/primordial_registry.inc"
} MalDirectBuiltinOp;

typedef enum MalGuardedBuiltinCallOp {
    MAL_GUARDED_BUILTIN_MAP_GET,
    MAL_GUARDED_BUILTIN_MAP_SET,
    MAL_GUARDED_BUILTIN_MAP_HAS,
    MAL_GUARDED_BUILTIN_MAP_DELETE,
    MAL_GUARDED_BUILTIN_SET_ADD,
    MAL_GUARDED_BUILTIN_SET_HAS,
    MAL_GUARDED_BUILTIN_SET_DELETE,
    MAL_GUARDED_BUILTIN_ARRAY_PUSH,
    MAL_GUARDED_BUILTIN_ARRAY_AT,
    MAL_GUARDED_BUILTIN_NUMBER_TO_FIXED,
    MAL_GUARDED_BUILTIN_NUMBER_TO_EXPONENTIAL,
    MAL_GUARDED_BUILTIN_NUMBER_TO_PRECISION,
    MAL_GUARDED_BUILTIN_NUMBER_IS_NAN,
    MAL_GUARDED_BUILTIN_NUMBER_IS_FINITE,
    MAL_GUARDED_BUILTIN_NUMBER_IS_INTEGER,
    MAL_GUARDED_BUILTIN_NUMBER_IS_SAFE_INTEGER,
    MAL_GUARDED_BUILTIN_BOOLEAN_CALL,
    MAL_GUARDED_BUILTIN_BOOLEAN_VALUE_OF,
    MAL_GUARDED_BUILTIN_BOOLEAN_TO_STRING,
    MAL_GUARDED_BUILTIN_ARRAY_POP,
    MAL_GUARDED_BUILTIN_ARRAY_SHIFT,
    MAL_GUARDED_BUILTIN_ARRAY_UNSHIFT,
    MAL_GUARDED_BUILTIN_WEAK_MAP_GET,
    MAL_GUARDED_BUILTIN_WEAK_MAP_HAS,
    MAL_GUARDED_BUILTIN_WEAK_MAP_DELETE,
    MAL_GUARDED_BUILTIN_WEAK_SET_HAS,
    MAL_GUARDED_BUILTIN_WEAK_SET_DELETE,
    MAL_GUARDED_BUILTIN_WEAK_MAP_SET,
    MAL_GUARDED_BUILTIN_WEAK_SET_ADD,
} MalGuardedBuiltinCallOp;

/** Packed literal-template tags; mirrored by src/compiler/core/semantic-lowering.ts. */
typedef enum MalLiteralTemplateTag {
    MAL_LITERAL_NULL,
    MAL_LITERAL_FALSE,
    MAL_LITERAL_TRUE,
    MAL_LITERAL_I32,
    MAL_LITERAL_F64,
    MAL_LITERAL_STRING,
    MAL_LITERAL_BIGINT,
    MAL_LITERAL_HOLE,
    MAL_LITERAL_ARRAY,
    MAL_LITERAL_OBJECT,
    MAL_LITERAL_KEY,
    MAL_LITERAL_UNDEFINED,
} MalLiteralTemplateTag;

typedef enum MalBinaryOp {
    MAL_BIN_ADD,
    MAL_BIN_SUB,
    MAL_BIN_MUL,
    MAL_BIN_DIV,
    MAL_BIN_REM,
    MAL_BIN_POW,
    MAL_BIN_BIT_AND,
    MAL_BIN_BIT_OR,
    MAL_BIN_BIT_XOR,
    MAL_BIN_SHL,
    MAL_BIN_SHR,
    MAL_BIN_USHR,
    MAL_BIN_LT,
    MAL_BIN_LTE,
    MAL_BIN_GT,
    MAL_BIN_GTE,
    MAL_BIN_EQ,
    MAL_BIN_NEQ,
    MAL_BIN_STRICT_EQ,
    MAL_BIN_STRICT_NEQ,
    MAL_BIN_IN,
    MAL_BIN_INSTANCEOF,
} MalBinaryOp;

typedef enum MalUnaryOp {
    MAL_UNARY_NOT,
    MAL_UNARY_NEGATE,
    MAL_UNARY_PLUS,
    MAL_UNARY_BIT_NOT,
    MAL_UNARY_TYPEOF,
    // ToNumeric plus the `++`/`--` step: the update-expression coercion keeps a
    // BigInt as a BigInt (unlike unary `+`, which throws) and then adds the
    // unit of the operand's own numeric type.
    MAL_UNARY_TO_NUMERIC,
    MAL_UNARY_INCREMENT,
    MAL_UNARY_DECREMENT,
    MAL_UNARY_TO_STRING,
} MalUnaryOp;

typedef enum MalTypeofResult {
    MAL_TYPEOF_UNDEFINED,
    MAL_TYPEOF_OBJECT,
    MAL_TYPEOF_BOOLEAN,
    MAL_TYPEOF_NUMBER,
    MAL_TYPEOF_STRING,
    MAL_TYPEOF_SYMBOL,
    MAL_TYPEOF_BIGINT,
    MAL_TYPEOF_FUNCTION,
    MAL_TYPEOF_RESULT_COUNT,
} MalTypeofResult;

typedef enum MalCompletionKind {
    MAL_COMPLETION_NORMAL,
    MAL_COMPLETION_RETURN,
    MAL_COMPLETION_THROW,
} MalCompletionKind;

typedef struct MalCompletion {
    MalCompletionKind kind;
    MalValue value;
} MalCompletion;

#define MAL_VALUE_OPERAND_UNDEFINED (-1)
#define MAL_VALUE_OPERAND_NULL (-2)
#define MAL_VALUE_OPERAND_FALSE (-3)
#define MAL_VALUE_OPERAND_TRUE (-4)
#define MAL_VALUE_OPERAND_STRING_BASE (-5)
#define MAL_VALUE_OPERAND_MAX_PAYLOAD 0x0fffffff
#define MAL_VALUE_OPERAND_STRING_MIN (MAL_VALUE_OPERAND_STRING_BASE - MAL_VALUE_OPERAND_MAX_PAYLOAD)
#define MAL_VALUE_OPERAND_I28_BASE (-0x20000000)
#define MAL_VALUE_OPERAND_I28_MIN (MAL_VALUE_OPERAND_I28_BASE - MAL_VALUE_OPERAND_MAX_PAYLOAD)

// CALL_REST_ARGUMENTS flags. The arguments-object form forwards an unmapped `arguments`
// and builds that object, not an Array, when the call cannot forward the frame.
#define MAL_REST_FORWARD_APPLY 1
#define MAL_REST_FORWARD_ARGUMENTS_OBJECT 2

typedef struct MalInstruction {
    MalOpcode opcode;

    union {
        struct {
            i32 dst, src;
        } move;

        struct {
            i32 dst, receiver, value;
        } base_construct_result;

        struct {
            i32 value;
        } ret;

        struct {
            i32 value;
        } thrown;

        struct {
            i32 dst;
        } caught;

        struct {
            i32 cond, target_ip;
        } jump_if;

        struct {
            i32 target_ip;
        } jump;

        struct {
            i32 dst, value;
        } create_number;

        struct {
            i32 dst;
            u32 bits_low, bits_high;
        } create_f64;

        struct {
            i32 dst, value;
        } create_boolean;

        struct {
            i32 dst, string_index;
        } create_string;

        struct {
            i32 dst, bigint_index;
        } create_bigint;

        struct {
            i32 dst;
        } create_object;

        struct {
            i32 dst, new_target, constructor_slot_reserve;
        } create_base_construct_receiver;

        struct {
            // Side data: [count, string-constant indices..., value registers...].
            i32 dst, data_offset, shape_cache_index;
        } create_object_shaped;

        struct {
            i32 dst, length;
        } create_array;

        struct {
            i32 dst, template_offset, cache_slot;
        } instantiate_literal_template;

        struct {
            i32 dst, needle, from_index, data_offset;
        } query_static_data;

        struct {
            // Side data: [count, name string indices..., global slots...].
            i32 dst, data_offset, cache_slot;
        } create_module_namespace;

        struct {
            // Build (once, caching in global slot `cache_slot`) a tagged-template
            // strings object. Side data: [count, cooked indices..., raw indices...].
            // A cooked index of -1 encodes an invalid escape sequence.
            i32 dst, cache_slot, data_offset;
        } create_template_object;

        struct {
            // `with (obj)`: ToObject([object]) and push onto the frame with-stack.
            i32 object;
        } with_enter;

        struct {
            // Pop the innermost with-object.
            i32 unused;
        } with_exit;

        struct {
            // [dst] = with-object value for the name, or the EMPTY sentinel on a
            // miss (so the compiler falls back to the static binding).
            i32 dst, name_string_index;
        } with_get;

        struct {
            // [dst] = the with-object that provides the name (the reference base),
            // or the EMPTY sentinel on a miss. Captures the base without reading the
            // value so an assignment resolves the reference before evaluating the RHS.
            i32 dst, name_string_index;
        } with_resolve_base;

        struct {
            // [found] = whether a with-object provided the name (and was written
            // [value]); false → the compiler falls back to the static store.
            i32 found, value, name_string_index;
        } with_set;

        struct {
            // [dst] = ([src] is the EMPTY sentinel).
            i32 dst, src;
        } is_empty;

        struct {
            i32 dst;
        } create_undefined;

        struct {
            i32 dst;
        } create_empty;

        struct {
            i32 dst;
        } create_null;

        struct {
            i32 dst, function_index;
        } create_function;

        struct {
            i32 dst;
        } create_arguments_object;

        struct {
            i32 dst;
        } load_argument_count;

        struct {
            i32 dst, index;
        } load_argument;

        struct {
            i32 dst, direct, fallback, index;
        } load_static_argument;

        struct {
            i32 dst;
        } load_this;

        struct {
            i32 dst;
        } load_new_target;

        struct {
            i32 dst;
        } load_callee;

        struct {
            i32 dst, owner_function_index, index;
        } load_captured;

        struct {
            i32 dst, callee, function_index;
        } guard_function_index;

        // Side data keeps both destinations inside the packed instruction ABI.
        struct {
            i32 dst, success, object, data_offset;
        } probe_read;

        struct { i32 dst; } read_service_epoch;
        struct { i32 dst, epoch; } guard_service_epoch;

        struct {
            i32 dst, callee, function_index, data_offset;
        } guard_base_constructor_layout;

        struct {
            i32 dst, index;
        } load_global;

        struct {
            i32 dst, index;
        } load_global_index;

        struct {
            i32 dst, intrinsic;
        } load_intrinsic;

        struct {
            i32 src, owner_function_index, index;
        } store_captured;

        // ENV_PUSH / ENV_COPY (scope_id = the synthetic per-iteration loop-scope id;
        // slot_count = number of captured loop-head bindings). ENV_POP needs neither.
        struct {
            i32 scope_id, slot_count;
        } env_scope;

        struct {
            i32 src, index;
        } store_global;

        struct {
            i32 dst, object, key, ic_index;
        } load_property;

        struct {
            i32 object, key, value, ic_index;
        } store_property;

        struct {
            i32 dst, object, string_index, ic_index;
        } load_property_static;

        struct {
            // Side data: [string_index, candidate_count, (function, shape, slot)...].
            i32 dst, object, data_offset, ic_index;
        } load_property_static_known_own_slot;

        struct {
            // Side data: [string_index, candidate_count, (function, shape, slot)...].
            i32 object, value, data_offset, ic_index;
        } store_property_static_known_own_slot;

        struct {
            // Side data: candidate_count pairs of (function, shape cache row).
            i32 dst, object, data_offset, candidate_count;
        } select_shape_case;

        struct {
            // Side data: [string_index, ic_index, slot_count, slots...].
            i32 dst, object, shape_case, data_offset;
        } load_property_static_shape_case;

        struct {
            i32 object, value, string_index, ic_index;
        } store_property_static;

        struct {
            i32 dst, object, key;
        } to_property_key;

        /**
         * super.x = v: the property lookup walks object (the super base)
         * while the write applies to receiver (this), per
         * OrdinarySetWithOwnDescriptor.
         */
        struct {
            i32 object, key, value, receiver;
        } store_super_property;

        /**
         * super.x: read from object (the super base) but call any getter with
         * receiver (this) — the thisValue of the Super Reference.
         */
        struct {
            i32 dst, object, key, receiver;
        } load_super_property;

        /**
         * The object's [[Prototype]]; null for non-objects and chain ends.
         */
        struct {
            i32 dst, object;
        } load_prototype;

        /**
         * Spec GetIterator: iterator object and its cached next method land
         * in two registers (the IteratorRecord).
         */
        struct {
            i32 iterator_dst, next_dst, source;
        } get_iterator;

        /**
         * GetIterator(source, async): the async iterator object + cached next
         * (or the sync iterator wrapped so next returns a promise). Same shape
         * as get_iterator; used by for-await-of.
         */
        struct {
            i32 iterator_dst, next_dst, source;
        } get_async_iterator;

        /**
         * Call the iterator's cached next() and leave the RAW result (a promise,
         * for async iteration) in result_dst — for-await-of awaits it before
         * unpacking. (Sync iteration uses iterator_step, which unpacks inline.)
         */
        struct {
            i32 result_dst, iterator, next;
        } iterator_next;

        /**
         * Spec IteratorStep + value read: the step value and a done boolean.
         */
        struct {
            i32 value_dst, done_dst, iterator, next;
        } iterator_step;

        /**
         * Spec IteratorClose. `normal` selects the normal-completion variant
         * (mal_vm_iterator_close_normal: propagates return()'s throw and throws
         * TypeError on a non-object result) used after a destructuring pattern
         * finishes without exhausting the iterator. The default (false) is the
         * abrupt-completion variant for break/return/throw loop exits, which
         * preserves any pending throw and swallows return()'s own errors.
         */
        struct {
            i32 iterator;
            bool normal;
        } iterator_close;

        /**
         * for-in head: collect the enumerable string property keys of source
         * (own + inherited, with shadowing) into a fresh array in dst, which
         * the loop then iterates with the ordinary iterator protocol.
         */
        struct {
            i32 dst, source;
        } for_in_keys;

        /** Whether for-in key `key` from array `keys` is still a property of `object`. */
        struct {
            i32 dst, object, key, keys;
        } for_in_has;

        /**
         * yield <src>: suspend the generator frame, leaving src as the yielded
         * value. On resume, the sent value lands in value_dst and the resume
         * mode (next / throw / return) in mode_dst, which the compiler-emitted
         * dispatch following the yield consults.
         */
        struct {
            i32 yielded_src, value_dst, mode_dst;
        } yield;

        /**
         * A synchronous yield whose continuation is only ordinary completion.
         * The yielded result remains done:false, but there is no resume point.
         */
        struct {
            i32 yielded_src;
        } terminal_yield;

        /**
         * await <src>: suspend the async-function frame on the value in
         * awaited_src. The runtime resolves it to a promise and resumes the
         * frame when it settles — fulfilled delivers the value in value_dst
         * with a NEXT mode in mode_dst, rejected delivers the reason with a
         * THROW mode — reusing the yield resume-dispatch the compiler emits.
         */
        struct {
            i32 awaited_src, value_dst, mode_dst;
        } await;

        struct {
            i32 dst, object, key;
        } delete_property;

        struct {
            i32 object, key, accessor;
            bool is_setter;
            bool enumerable;
        } define_accessor;

        struct {
            i32 object, key, value;
            bool enumerable;
            bool writable;
            bool configurable;
        } define_property;

        struct {
            // SetFunctionName([func], [key]): name an anonymous function/class value
            // from a computed property key (string → the key, symbol → "[desc]"/"").
            // prefix: 0 none, 1 "get ", 2 "set " (accessor NamedEvaluation prefix).
            i32 func, key;
            u8 prefix;
        } set_function_name;

        /**
         * Private class members are keyed by per-class-evaluation hidden
         * symbols. create_private_name mints one; the others take the symbol
         * in key and operate own-only (no prototype walk). define_private
         * installs (throws on re-install), load/store require presence
         * (TypeError otherwise), has_private answers the `#x in o` brand check.
         */
        struct {
            i32 dst;
        } create_private_name;

        struct {
            // Side data: [count, captured slot indices...]. All slots belong to
            // owner_function_index and receive freshly minted private symbols.
            i32 owner_function_index, data_offset;
        } create_private_names;

        struct {
            i32 object, key, value;
        } define_private;

        struct {
            // Side data: [count, key registers...]. Installs undefined-valued
            // private fields in order and stops on the first duplicate stamp.
            i32 object, data_offset;
        } init_private_fields;

        struct {
            i32 dst, object, key;
        } load_private;

        struct {
            i32 object, key, value;
        } store_private;

        struct {
            i32 dst, object, key;
        } has_private;

        struct {
            i32 object, prototype;

            // Object literal `__proto__:` property definitions ignore values that are
            // neither object nor null; class extends wiring always applies.
            bool literal;
        } set_prototype;

        struct {
            i32 dst, name_string_index;
        } load_undeclared;

        struct {
            i32 dst, name_string_index;
        } load_global_property;

        struct {
            // Write `src` to the global object property `name_string_index`
            // (created if absent) — a script `var`/`function` binding. Declaration
            // mode preserves an existing property and creates a non-configurable
            // var property when absent.
            i32 src, name_string_index;
            bool declaration;
            bool declaration_configurable;
        } store_global_property;

        struct {
            // Side data: [count, name string indices...]. Each property is
            // declaration-initialized to undefined with the shared configurability.
            i32 data_offset;
            bool declaration_configurable;
        } init_global_vars;

        struct {
            i32 name_string_index, index;
            bool immutable, check_only;
        } declare_global_lexical;

        struct {
            i32 dst, name_string_index;
            u8 query;
        } global_binding_query;

        struct {
            // Throw ReferenceError if `src` holds the uninitialized sentinel (the
            // binding named by name_string_index is still in its TDZ).
            i32 src, name_string_index;
        } throw_if_tdz;

        struct {
            i32 src;
        } require_coercible;

        struct {
            i32 parent;
        } check_super_class;

        struct {
            i32 dst, start_index;
        } create_rest_arguments;

        struct {
            i32 dst, src, start_index;
        } array_rest;

		struct {
			i32 dst, src;
		} create_array_from_iterable;

        struct {
            // Side data: [count, excluded key registers...].
            i32 dst, src, data_offset;
        } copy_data_properties;

        /**
         * Object spread `{...src}`: merge src's own enumerable properties into
         * the target object with CreateDataProperty semantics. nil sources are
         * a no-op (unlike destructuring rest).
         */
        struct {
            i32 target, src;
        } merge_data_properties;

        struct {
            // callee/this_value and side data entries are tagged value operands:
            // non-negative registers or negative primitive/string immediates.
            i32 dst, callee, this_value, data_offset;
        } call;

        /** Locked canonical Math calls after exact Number proof and twin erasure. */
        struct {
            i32 dst, src, operation;
        } math_unary_number;

        struct {
            i32 dst, left, right, operation;
        } math_binary_number;

        struct {
            i32 dst, this_value, data_offset, operation;
        } call_known;

        struct {
            i32 dst, data_offset;
        } precise_number_sum;

        struct {
            i32 dst, prefix_length, part;
            u32 following_quasi_length;
        } string_concat_length;

        struct {
            i32 dst, data_offset;
        } concat_strings;

        struct {
            i32 dst;
            MalBuiltinError error;
        } builtin_error;

        struct {
            i32 dst, left, right;
            // Six option bits share the locale index word to preserve the 20-byte opcode ABI.
            u32 locale_options;
        } prepared_string_compare;

        struct {
            // callee and side data use the same tagged value operands as call.
            i32 dst, callee, data_offset;
        } construct;

        /**
         * Calls with spread arguments take a materialized arguments array.
         */
        struct {
            i32 dst, callee, this_value, arguments_array;
        } call_spread;

        struct {
            // Side data retains [iterable, prefix count, prefix registers] within the opcode ABI.
            i32 dst, callee, this_value, data_offset;
        } call_spread_iterable;

        // Side data: [receiver, start, MAL_REST_FORWARD_* flags, state, prefix count, prefix].
        struct {
            i32 dst, callee, this_value, data_offset;
        } call_rest_arguments;

        struct {
            i32 dst, callee, arguments_array;
        } construct_spread;

        struct {
            i32 dst, parent, arguments_array;
        } construct_super;

        struct {
            i32 dst, parent, arguments_array, new_target;
        } construct_super_explicit;

        struct {
            i32 value;
        } set_this;

        struct {
            i32 dst, left, right;
            MalBinaryOp op;
        } binary;

        struct {
            i32 dst, src;
            MalUnaryOp op;
        } unary;

        struct {
            i32 dst, src;
            MalTypeofResult expected;
            bool negated;
        } typeof_compare;
    } as;
} MalInstruction;

_Static_assert(sizeof(MalInstruction) == 20, "MalInstruction must remain densely packed");

/**
 * Probe kinds are private, named, indexed, getter and setter. Named, getter and
 * setter probes carry a string constant and a property cache row in their side data.
 */
static inline bool mal_vm_probe_read_kind_named(u8 kind) {
    return kind == 1 || kind == 3 || kind == 4;
}

/**
 * Statically known protected instruction range. While the instruction pointer
 * is inside [start_ip, end_ip), a throw unwinds to handler_ip.
 */
typedef struct MalExceptionHandler {
    i32 start_ip;
    i32 end_ip;
    i32 handler_ip;
} MalExceptionHandler;

/**
 * Debug-info: one run in a function's position table. Instructions in
 * [start_ip, next entry's start_ip) map to source position `pos_id` (an index
 * into MalRuntimeImage.source_positions). Sorted ascending by start_ip; a frame's
 * position is the last entry with start_ip <= its instruction pointer.
 */
typedef struct MalLineEntry {
    i32 start_ip;
    i32 pos_id;
} MalLineEntry;

/**
 * Debug-info: a decoded source position (1-based line, 0-based column).
 *
 * When the position is code the inliner copied from another function, the chain
 * fields describe the inline frame it stands for: `inlined_function_index` is
 * the function the code came from (>= 0), and `caller_pos_id` is the position in
 * the caller where it was inlined (itself possibly another inline node). A
 * physical position leaves both at -1. The stack formatter walks this chain so a
 * single physical frame prints as one logical frame per inline level.
 */
typedef struct MalSourcePos {
    i32 line;
    i32 column;
    i32 inlined_function_index;
    i32 caller_pos_id;
} MalSourcePos;

/**
 * Calling a generator function runs its parameter prologue eagerly, then the
 * MAL_OP_GENERATOR_START prologue instruction suspends and returns a generator
 * object instead of running the body.
 */
typedef enum MalFunctionKind {
    MAL_FUNCTION_KIND_NORMAL,
    MAL_FUNCTION_KIND_GENERATOR,
    MAL_FUNCTION_KIND_ASYNC,
    MAL_FUNCTION_KIND_ASYNC_GENERATOR,
} MalFunctionKind;

typedef struct MalVm MalVm;
typedef struct MalEnv MalEnv;

struct MalGeneratorObject;

/**
 * A function lowered directly to C by the native backend. When set on a
 * MalFunction, an ordinary call invokes this instead of interpreting the
 * bytecode (the bytecode is still emitted as a fallback and for `new`). The
 * shape mirrors a native callback plus the creation environment for captures;
 * args point at the caller-marshaled region, and a throw is signalled through
 * vm->completion (the returned value is then ignored).
 */
typedef MalValue (*MalCompiledFunction)(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalEnv *env,
    // The invoked function object, for a sloppy-mode `arguments.callee` (the
    // compiled frame carries no callee otherwise). Undefined for the top-level
    // entry. Strict functions ignore it (their callee is poisoned).
    MalValue callee,
    // Backend-private entry state. A suspended compiled coroutine receives its
    // MalGeneratorObject. A compiler-proven ordinary direct call may instead use
    // it as a native-argument entry tag. Runtime calls, constructs, and program
    // entry pass null.
    void *entry_state
);

typedef f64 (*MalNumericSortComparator)(
    MalVm *vm, MalValue this_value, f64 left, f64 right, MalEnv *env, MalValue callee);

typedef f64 (*MalNumericReduceCallback)(
    MalVm *vm, MalValue this_value, f64 accumulator, f64 value, f64 index,
    MalValue receiver, MalEnv *env, MalValue callee);

/** Sorts Number values with one comparator compiled in; `keys` holds 2 * count doubles. */
typedef void (*MalNumericSortKernel)(MalValue *values, MalValue *scratch, f64 *keys, u32 count);

/** Program-local table bases used by a native overlay attached after a splice. */
typedef struct MalNativeProgramRelocation {
    i32 function_base;
    i32 global_base;
    i32 string_base;
    i32 bigint_base;
    i32 literal_template_base;
    /**
     * Absolute slots of the image's imported globals, in import-table order; their
     * aliases are not contiguous, so they cannot be expressed as a base.
     */
    const i32 *global_imports;
} MalNativeProgramRelocation;

enum {
    MAL_ARGUMENT_SNAPSHOT_SOURCE_COUNT = -1,
    MAL_ARGUMENT_SNAPSHOT_SOURCE_SCRATCH = -2,
};

/** One operation in a function's cycle-safe argument snapshot entry plan. */
typedef struct MalArgumentSnapshotMove {
    /** Negative means save source to scratch; the eventual destination is ~this. */
    i32 destination;
    /** Raw argument index, count sentinel, or scratch sentinel. */
    i32 source;
} MalArgumentSnapshotMove;

typedef struct MalClosureCaptureValue {
    i32 owner_function_index;
    i32 captured_index;
} MalClosureCaptureValue;

// Shared cold construction metadata; native entries retain their own proven layout.
typedef struct MalClosureCaptureLayout {
    const i32 *owners;
    const MalClosureCaptureValue *values;
    i32 value_count;
} MalClosureCaptureLayout;

typedef struct MalFunction {
    /*
     * Pointer-sized fields lead the structure, followed by the i32 metadata and
     * packed flags. Functions live for the VM's lifetime and large programs can
     * carry thousands of them, so avoiding the former pointer-alignment holes is
     * worthwhile. All producers use named fields; this is not a wire-format ABI.
     */
    const MalArgumentSnapshotMove *argument_snapshot_plan;
    const i32 *mapped_argument_slots;
    const MalClosureCaptureLayout *closure_captures;
    const MalInstruction *instructions;
    const i32 *instruction_data;
    /** Flat [ip, root_count, roots..., clear_count, clears...] sorted by IP. */
    const i32 *gc_safepoints;
    const MalExceptionHandler *handlers;
    MalCompiledFunction compiled;
    const MalLineEntry *positions;
#if MAL_PROFILE
    /** Profile-only dense site id parallel to instructions. */
    const i32 *profile_site_ids;
#endif

    i32 name_string_index;
    MalFunctionKind kind;
    i32 parameter_count;

    /** Number of leading raw-argument snapshot instructions run at frame entry. */
    i32 argument_snapshot_count;

    i32 argument_snapshot_plan_count;

    /** Captured binding slot per mapped argument index; empty for unmapped functions. */
    i32 mapped_argument_count;

    /**
     * Function.prototype.length: formal parameters before the first default
     * or rest parameter. parameter_count keeps the full formal count for the
     * calling convention.
     */
    i32 length;

    i32 register_count;
    i32 captured_count;
    /** -1 retains the dynamic chain; otherwise the immutable external-owner layout. */
    i32 closure_capture_owner_count;
    /** -1 never retains; INT32_MAX always retains nonempty input; otherwise the
     * largest static index whose absence requires the supplied argument slice. */
    i32 argument_retention_limit;

    /** Dense VM-owned inline-cache rows used by this function's property sites. */
    i32 property_ic_count;
    /** Dense VM-owned shape memo rows used by this function's shaped literals. */
    i32 literal_shape_count;
    i32 instruction_count;
    i32 instruction_data_count;

    i32 gc_safepoint_count;

    i32 handler_count;

    /**
     * Debug-info (stack traces). file_index points into MalRuntimeImage.files;
     * positions is a run-length position table (position_count entries) mapping
     * instruction pointers to source positions. position_count is 0 / positions
     * is nullptr for stripped builds.
     */
    i32 file_index;
    i32 position_count;

    bool strict;
    /** Whether any activation can retain supplied arguments after entry. */
    bool needs_arguments;
    bool mapped_arguments;
    /** False for loader-provided metadata that cannot prove semantic completeness. */
    bool gc_safepoints_trusted;

    /**
     * A derived class constructor. Its `this` is uninitialized (the EMPTY
     * sentinel) until super() binds it, so the construct site allocates no eager
     * `this` and reads of `this` before super() throw ReferenceError.
     */
    bool is_derived_constructor;

    /**
     * A class constructor (base or derived). Its `prototype` property is
     * non-writable (MakeConstructor with writablePrototype = false), unlike a
     * normal function's writable prototype.
     */
    bool is_class_constructor;

    /** Hidden ordinary-object slot capacity reserved before base constructor entry. */
    u8 constructor_slot_reserve;

    /**
     * Whether the function owns a `prototype` property. False for methods,
     * getters, setters and arrows (not constructors); true for normal functions,
     * class constructors and generators. Async (non-generator) functions are
     * excluded separately by kind.
     */
    bool has_prototype;
} MalFunction;

static_assert(sizeof(MalFunction) <= (MAL_PROFILE ? 168 : 160),
              "function metadata outgrew its packed layout");

typedef struct MalPreparedValue {
    struct MalPreparedValue *next;
    char *identity;
    char *data;
    MalValue value;
} MalPreparedValue;

// Prepared data uses the same export-slot ABI as ordinary native modules.
typedef struct MalHostInstallSlot {
    const char *name;
    i32 slot;
    const char *data;
} MalHostInstallSlot;

/**
 * Engine-neutral launch context threaded to every host installer. Alongside the
 * process command line, a host driver may expose the compiled program's source
 * entry so Node's script argv slot preserves ordinary entrypoint detection.
 */
typedef struct MalHostLaunchContext {
    int argc;
    char **argv;
    const char *script_path;
} MalHostLaunchContext;

/**
 * A host installer fills the given global slots for one `node:*` built-in (or
 * the global `process`). Engine-neutral: it takes the VM, the slot table, and
 * the launch context (the process command line). Defined in the native
 * host-module layer; the compiler emits a direct reference to it for each
 * reached built-in. A null pointer (an unresolved installer in a from-wire
 * program) is skipped, leaving the slots at their init value (undefined).
 */
typedef void (*MalHostInstaller)(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);

/**
 * One entry of a program's host-install manifest: the installer to run and the
 * slots it fills. Emitted only for host built-ins / `process` actually reached
 * (dead-code elimination), so an ordinary program's manifest is empty and no
 * host symbol is referenced.
 */
typedef struct MalHostInstall {
    MalHostInstaller installer;
    const MalHostInstallSlot *slots;
    i32 slot_count;
} MalHostInstall;

/** Wire tags of RuntimeModuleLink kinds in src/compiler/target/runtime-image.ts. */
typedef enum MalModuleLinkKind {
    MAL_MODULE_LINK_BINDING = 0,
    MAL_MODULE_LINK_NAMESPACE = 1,
    MAL_MODULE_LINK_CJS = 2,
} MalModuleLinkKind;

/**
 * A module binding, namespace cache slot, or CommonJS module one image of a
 * relocatable program shares with another, identified by module path, kind and
 * export name. An import's slot is never written by its own image: the splice
 * aliases it to the slot an earlier image published, so the binding stays live.
 */
typedef struct MalModuleLink {
    const char *module;
    const char *name;
    i32 kind;
    /** Image-local global slot, or CommonJS module id for MAL_MODULE_LINK_CJS. */
    i32 slot;
    /** Absolute slot or module id an import resolved to; written by the splice. */
    i32 target;
} MalModuleLink;

/** Exports published by the images spliced into one VM, keyed by link identity. */
typedef struct MalModuleLinkRegistry {
    const MalModuleLink **entries;
    i32 *targets;
    i32 count;
    i32 capacity;
    /** Open-addressed indices into entries, -1 when empty; a power of two in size. */
    i32 *table;
    i32 table_size;
} MalModuleLinkRegistry;

/** One immutable regular file in a configured executable asset. */
typedef struct MalAssetFile {
    const char *path;
    const u8 *data;
    /** Development manifests use an immutable external snapshot instead of data. */
    const char *source_path;
    usize length;
} MalAssetFile;

/** A named file or directory captured by maligator.build.ts. */
typedef struct MalAsset {
    const char *name;
    const char *hash;
    const char *version;
    bool directory;
    i32 file_count;
    const MalAssetFile *files;
} MalAsset;

/**
 * VM-local shape requested by a guarded own-slot load. The descriptor contains
 * only portable indices; mal_vm_init/splice interns the actual MalShape pointer
 * into the referenced function's literal-shape cache.
 */
typedef struct MalPrecompiledLiteralShape {
    i32 function_index;
    i32 shape_cache_index;
    i32 key_count;
    const i32 *key_string_indices;
} MalPrecompiledLiteralShape;

/** A class constructor's predicted instance layout, admitted per receiver by class_layout.c. */
typedef struct MalClassLayoutDesc {
    i32 key_count;
    i32 method_count;
    /** Own keys in slot order: a string constant index, or ~slot for a module-private name global. */
    const i32 *keys;
    /** Method name string constant index and expected function index, pairwise. */
    const i32 *methods;
} MalClassLayoutDesc;

typedef struct MalRuntimeImage {
    i32 function_count;
    const MalFunction *functions;

    /** Compiled functions keep live values in C locals, so collections scan native
     * stacks. Precise images (Wasm, bytecode wires) publish shadow-frame roots. */
    bool conservative_stack_roots;

    /** Populate split generated tables before their first use. */
    void (*initialize_generated_data)(void);

    /**
     * Immortal string constants baked into the program image (static storage,
     * EXTERNAL code units). Hashes are computed lazily by mal_string_hash, so the
     * array is not const. CREATE_STRING and property-key loads hand back a pointer
     * to one of these instead of allocating per execution.
     */
    i32 string_constant_count;
    MalString *string_constants;

    /**
     * Immortal bigint constants, likewise baked into the image with their
     * 128-bit value emitted at compile time. CREATE_BIGINT hands back a pointer.
     */
    i32 bigint_constant_count;
    MalBigInt *bigint_constants;

    /** Packed immutable static-data literal templates (MalLiteralTemplateTag). */
    i32 literal_template_data_count;
    const u32 *literal_template_data;

    /** Deduplicated literal shapes needed before guarded own-slot execution. */
    i32 precompiled_literal_shape_count;
    const MalPrecompiledLiteralShape *precompiled_literal_shapes;

    /** Layouts compiled class-member sites address by ordinal; only a root image has any. */
    i32 class_layout_count;
    const MalClassLayoutDesc *class_layouts;

    i32 global_count;

    /** Source entry retained for Node-compatible process.argv[1]. */
    const char *entry_path;

    /**
     * CommonJS module table: cjs_module_function_indices[id] is the function
     * index of module `id`'s wrapper — `function (module, exports, require,
     * __filename, __dirname) { …module body… }`. mal_vm_cjs_require runs a
     * wrapper once on first require and caches its `module.exports`. Zero/null
     * for programs with no CommonJS modules.
     */
    i32 cjs_module_count;
    const i32 *cjs_module_function_indices;

    /**
     * Debug-info tables for stack traces. files[function->file_index] is a source
     * path already prefixed `compiled://` (rendered verbatim into trace frames);
     * source_positions[pos_id] decodes a function position-table entry to a
     * line/column. Both are zero/null for stripped builds (e.g. the test262
     * batch), in which case traces carry function names only.
     */
    i32 file_count;
    const char *const *files;
    i32 source_position_count;
    const MalSourcePos *source_positions;
#if MAL_PROFILE
    /** Number of dense operation sites in this exact generated program. */
    i32 profile_site_count;
#endif

    /** Immutable configured assets baked into this native executable. */
    i32 asset_count;
    const MalAsset *assets;

    /**
     * Host-install manifest (see MalHostInstall). Run by mal_vm_run_host_installs
     * after VM init / host attach and before execution. Zero/null for an ordinary
     * program and for a from-wire program (whose installer pointers are
     * unresolved), so both run no installers.
     */
    i32 host_install_count;
    const MalHostInstall *host_installs;

    /**
     * Links of an image of a relocatable program (see MalModuleLink). CommonJS
     * import ids follow the image's own modules: cjs_module_count..+N. Zero/null
     * for a whole program.
     */
    i32 module_import_count;
    MalModuleLink *module_imports;
    i32 module_export_count;
    const MalModuleLink *module_exports;
} MalRuntimeImage;

/**
 * A CommonJS module's registry slot. `module_object` is its `module` object
 * (with the `exports` property); `loaded` is set true the moment loading begins
 * — before the wrapper runs — so a circular `require` returns the partial
 * `module.exports` rather than re-entering the wrapper. A throwing wrapper
 * clears the slot so a later require retries evaluation with a fresh object.
 */
typedef struct MalCjsModuleSlot {
    MalValue module_object;
    bool loaded;
    /** Absolute id of the earlier image's module this entry imports, else -1. */
    i32 alias;
} MalCjsModuleSlot;

// Shared atomic binding slots, grouped by activation or per-iteration identity.
// Compact closures retain selected owners without their parent links. Active
// frames root the lexical chain explicitly; fallback environments own the chain.
typedef struct MalEnv {
    MalHeapHeader header;
    // Active frames root lexical links; compact closures retain selected slots only.
    bool compact_parent;
    // Consecutive nonnegative owners ending at null/tag; zero means unproved.
    u16 compact_chain_length;
    struct MalEnv *parent;
    // Capture-scope id this env satisfies for LOAD/STORE_CAPTURED matching. >= 0
    // is a function index (the activation's own captured slots); < 0 is a synthetic
    // per-iteration loop-scope id (see the ENV_PUSH/COPY/POP ops) that never
    // collides with a function index.
    i32 function_index;
    // Number of MalValue slots; self-describing so the GC can trace any env
    // (including synthetic-id per-iteration envs) without a function lookup.
    i32 slot_count;
#if defined(__wasi__)
    MalValue slots[];
#else
    _Atomic(MalValue) slots[];
#endif
} MalEnv;

#if !defined(__wasi__)
static_assert(sizeof(_Atomic(MalValue)) == sizeof(MalValue),
    "captured slots must retain the MalValue cell layout");
static_assert(alignof(_Atomic(MalValue)) == alignof(MalValue),
    "captured slots must retain the MalValue alignment");
#endif

// function_index sentinel marking an object environment record: a `with` scope.
// slots[0] holds the with-object. Distinct from any function index (>= 0) and any
// synthetic loop-scope id (small negatives, decremented per loop), so LOAD/STORE_
// CAPTURED never match it — only the WITH_* ops walk the chain looking for it. A
// with scope on the env chain (rather than a frame-local stack) is what lets a
// closure created inside `with` capture the with-object via its creation_env.
#define MAL_ENV_WITH_OBJECT (-2147483647 - 1)

// An inline closure display is owned by the function stored in parent; it is not
// a separately allocated GC cell. The payload holds a layout pointer then scopes.
#define MAL_ENV_CAPTURE_VECTOR (-2147483647)
#define MAL_ENV_CAPTURE_VALUES (-2147483646)

// Both inline display kinds use parent as their containing function, not a scope.
static inline bool mal_env_is_capture_display(const MalEnv *env) {
    return env->function_index == MAL_ENV_CAPTURE_VECTOR ||
        env->function_index == MAL_ENV_CAPTURE_VALUES;
}

// A single selected owner fits in the closure's environment pointer. Its tag
// makes it a terminal reference: the owner's lexical parent may already be dead.
static_assert(alignof(MalEnv) >= 2, "single-owner capture tag requires aligned environments");

static inline bool mal_env_is_single_owner(const MalEnv *env) {
    return ((uptr) env & (uptr) 1) != 0;
}

static inline MalEnv *mal_env_untag_single_owner(const MalEnv *env) {
    return (MalEnv *) ((uptr) env & ~(uptr) 1);
}

// owner is a non-null, untagged slot-storage cell.
static inline MalEnv *mal_env_tag_single_owner(MalEnv *owner) {
    return (MalEnv *) ((uptr) owner | (uptr) 1);
}

static inline const i32 *mal_env_capture_layout(const MalEnv *env) {
    return ((const i32 *const *)(const void *) env->slots)[0];
}

static inline MalEnv **mal_env_capture_scopes(MalEnv *env) {
    return (MalEnv **)(void *) env->slots + 1;
}

static inline const MalClosureCaptureValue *mal_env_capture_values_layout(const MalEnv *env) {
    return ((const MalClosureCaptureValue *const *)(const void *) env->slots)[0];
}

MalEnv *mal_vm_capture_owner(MalEnv *env, i32 owner_function_index);
// owners is sorted and unique; missing bindings are represented by null entries.
bool mal_vm_capture_owners(MalEnv *env, const i32 *owners, i32 count, MalEnv **scopes);

// Native code knows the ordinal in its immutable capture layout. A local scope
// can precede that display, and dynamic callers can supply a different shape;
// preserve nearest-binding identity and use the general resolver on mismatch.
static inline MalEnv *mal_vm_capture_owner_at(MalEnv *env, i32 owner_function_index, i32 capture_index) {
    for (; env != nullptr; env = env->parent) {
        if (mal_env_is_single_owner(env)) {
            MalEnv *owner = mal_env_untag_single_owner(env);
            return owner->function_index == owner_function_index ? owner : nullptr;
        }
        if (env->function_index == MAL_ENV_CAPTURE_VALUES) return nullptr;
        if (env->function_index == owner_function_index) return env;
        if (env->function_index == MAL_ENV_CAPTURE_VECTOR) {
            if (capture_index >= 0 && capture_index < env->slot_count &&
                    mal_env_capture_layout(env)[capture_index] == owner_function_index) {
                return mal_env_capture_scopes(env)[capture_index];
            }
            return mal_vm_capture_owner(env, owner_function_index);
        }
    }
    return nullptr;
}

/*
 * Compiled frames keep their stack-trace record on their own C stack, and a capture
 * finds it by walking frame-pointer chains, so a call stores nothing into the VM.
 * Wasm cannot walk its stack and profile builds sample call-site ids from the rows,
 * so those builds keep one row per call in vm->native_frames instead.
 */
#if !defined(__wasi__) && !MAL_PROFILE && (defined(__APPLE__) || defined(__linux__)) && \
    (defined(__aarch64__) || defined(__x86_64__))
#define MAL_NATIVE_FRAME_WALK 1
#else
#define MAL_NATIVE_FRAME_WALK 0
#endif

#if defined(__APPLE__)
#define MAL_COMPILED_TEXT_SECTION "__TEXT,__mal_js,regular,pure_instructions"
#else
// A C-identifier name makes the linker define __start_/__stop_ bounds for it.
#define MAL_COMPILED_TEXT_SECTION "mal_js_text"
#endif

struct MalCompiledFrameDesc;

/**
 * A compiled function's stack-trace record: the running function and its current
 * entry in the function's position table, written statement by statement so
 * generated code never names an image-wide position id. A hidden record (negative
 * function index) belongs to a function whose interpreted frame represents it.
 * A capture orders these records against interpreted frames; see
 * mal_vm_capture_stack.
 */
typedef struct MalNativeFrame {
#if MAL_NATIVE_FRAME_WALK
    /** Identifies the record a walk found at its function's frame offset. */
    const struct MalCompiledFrameDesc *desc;
#endif
    i32 function_index;
    i32 position_entry;
#if MAL_PROFILE
    i32 site_id;
#endif
} MalNativeFrame;

#if MAL_NATIVE_FRAME_WALK
/** A generated function that owns a frame record; its layout is learned on first entry. */
typedef struct MalCompiledFrameDesc {
    const void *code;
    /** The record's offset from the function's frame pointer; zero until registered. */
    _Atomic(i32) frame_offset;
} MalCompiledFrameDesc;

void mal_compiled_frame_register(MalCompiledFrameDesc *desc, i32 frame_offset);
#endif

static inline bool mal_native_frame_hidden(const MalNativeFrame *frame) {
    return frame->function_index < 0;
}

/** One captured frame: the function and its source position (pos_id, -1 = none). */
typedef struct MalStackFrameRecord {
    i32 function_index;
    i32 pos_id;
} MalStackFrameRecord;

/**
 * A captured stack trace: a flat list of frames (top first), plus — for async
 * stitching — the parent async trace (the awaiting context, null when none). An
 * Error stores one at construction (looked up by a recyclable id), formatted
 * lazily by the .stack getter; console.trace formats one immediately.
 */
typedef struct MalStackTrace {
    i32 frame_count;
    struct MalStackTrace *async_parent;
    /** Logical frames to omit and retain when an explicit V8-style capture is read. */
    i32 frame_skip;
    i32 frame_limit;
    /** Coallocated frame records, ordered top first. */
    MalStackFrameRecord frames[];
} MalStackTrace;

// Opaque loaded runtime image (vm_load.h); the VM retains the ones it splices
// for `eval` so their arenas outlive the spliced functions.
typedef struct MalLoadedRuntimeImage MalLoadedRuntimeImage;

typedef struct {
    i32 name_string_index;
    // Negative slots track object-record var declarations for redeclaration checks.
    i32 global_index;
    bool immutable;
} MalGlobalBinding;

typedef struct {
    MalGlobalBinding *bindings;
    i32 count;
    i32 capacity;
    /** Changes whenever a binding is added or removed; global property caches compare it. */
    u32 generation;
} MalGlobalEnvironment;

#if MAL_REALMS
/**
 * A realm: isolated global slots and intrinsics (%Object.prototype%, the error
 * prototypes, …). Realms are plain malloc-owned metadata, NOT GC cells. Every
 * realm is linked into the VM's singly linked `realms` list so the collector can
 * scan each realm's roots and teardown can free its globals buffer and metadata.
 * The VM's `globals` and `intrinsics` pointers alias the current realm, keeping
 * the engine-wide indexed access paths unchanged. Created via mal_realm_new; the
 * whole list is freed by mal_realm_free_all.
 */
typedef struct MalRealm {
    MalGlobalEnvironment global_environment;
    MalValue *globals;
    MalValue intrinsics[MAL_INTRINSIC_COUNT];
    struct MalRealm *next;
} MalRealm;

// Allocate a realm's globals at the VM's shared global capacity, pre-fill its
// active globals and intrinsics to `undefined` (so it is safe to scan the instant
// it is linked), and link it into vm->realms. Internal to the engine's own realm
// bookkeeping — this is not the language-level createRealm.
MalRealm *mal_realm_new(MalVm *vm);

// Free every realm's globals and metadata and null the list head. Call at teardown
// once the collector can no longer scan these roots.
void mal_realm_free_all(MalVm *vm);

// Make `realm` the current realm, updating the four views of "current" together:
// vm->current_realm, the globals/intrinsics aliases, and vm->heap.current_realm
// (the cache function-object init stamps from). The single choke point for
// entering a realm — no caller should assign these fields independently.
void mal_realm_switch(MalVm *vm, MalRealm *realm);

/** Called while a newly created realm is current so an embedding can install it. */
typedef void (*MalRealmInstaller)(MalVm *vm, void *data);

/**
 * Create a fresh realm in `vm`, optionally running an embedding installer while
 * it is current. The caller's realm is current again when this returns, including
 * when intrinsic initialization or the installer leaves a pending throw.
 */
MalRealm *mal_realm_create(MalVm *vm, MalRealmInstaller installer, void *data);

/** Return the realm's global object. */
MalValue mal_realm_global(const MalRealm *realm);
#endif

#define MAL_GLOBAL_PROPERTY_CACHE_BITS 10
#define MAL_GLOBAL_PROPERTY_CACHE_SIZE (1u << MAL_GLOBAL_PROPERTY_CACHE_BITS)

#define MAL_INTERP_CALL_CACHE_BITS 10
#define MAL_INTERP_CALL_CACHE_SIZE (1u << MAL_INTERP_CALL_CACHE_BITS)

/**
 * One entry in the interpreter's bounded direct-mapped call cache. The callee
 * value is an unrooted identity guard, not an owning reference: heap_epoch must
 * match before it is trusted, closing the freed-cell/reuse ABA hole. Function
 * rows are always re-derived from callee_function_index because eval can realloc
 * the runtime image's function table.
 */
typedef struct MalInterpCallCacheEntry {
    MalValue callee;
    i32 caller_function_index;
    i32 call_ip;
    i32 callee_function_index;
    u32 heap_epoch;
} MalInterpCallCacheEntry;

/**
 * A VM-owned direct-mapped cache for global-object own dictionary entries. It
 * retains entry identity, never a property value; users validate every field and
 * re-read the descriptor before taking a fast path.
 */
typedef struct MalGlobalPropertyCacheEntry {
    const MalValue *realm_intrinsics;
    const struct MalObject *global_object;
    MalTable *table;
    void *entry;
    u64 table_handle_epoch;
    i32 string_index;
    /**
     * Nonzero once a load proved the name has no lexical binding at
     * `binding_generation` and resolves to this data entry: the entry's exact
     * key word, which also encodes liveness and property flags.
     */
    u32 binding_generation;
    u64 data_key;
} MalGlobalPropertyCacheEntry;

/**
 * Per-VM versions of broad semantic assumptions used by compiled proof regions.
 * Every word starts at one and saturates to zero on theoretical u64 exhaustion;
 * zero is permanently fail-closed. The JavaScript heap has one mutator today, so
 * ordinary accesses are sufficient. A future multi-mutator VM must make bumps
 * release operations and region snapshots acquire operations.
 */
#define MAL_WATCHED_LOOKUP_CACHE_CAPACITY 16

typedef struct MalWatchedLookupEntry {
    const struct MalObject *prototype;
    MalValue key;
    MalValue value;
} MalWatchedLookupEntry;

typedef struct MalForInSnapshot {
    const void *keys;
    const struct MalShape *shape;
} MalForInSnapshot;

/** Every semantic epoch starts here; zero is the exhausted state. */
#define MAL_SEMANTIC_EPOCH_INITIAL UINT64_C(1)

typedef struct MalSemanticEpochs {
    /** Advanced by every semantic-family invalidation; future re-entry dirty test. */
    u64 activity;
    /** Inherited integer-index behaviour of watched Array/Object prototypes. */
    u64 array_elements;
    /** Resolved values on watched builtin prototypes/constructors/namespaces. */
    u64 watched_methods;
} MalSemanticEpochs;

// Callback facts borrow the rooted builtin arguments. Function indices survive
// eval relocating the metadata table; previous is scoped to the current fiber.
typedef struct MalExactScriptCall {
    struct MalExactScriptCall *previous;
    MalValue callee;
    i32 function_index;
    MalCompiledFunction compiled_callback;
    MalNumericSortComparator numeric_sort_comparator;
    MalNumericSortKernel numeric_sort_kernel;
    MalEnv *env;
    MalNumericReduceCallback numeric_reduce_callback;
} MalExactScriptCall;

enum { MAL_LITERAL_CACHE_CAPACITY = 32, MAL_LITERAL_CACHE_MAX_WORDS = 16384 };

typedef struct {
    i32 slot;
#if MAL_REALMS
    MalRealm *realm;
#endif
} MalLiteralCacheEntry;

typedef struct MalShapeCopyCacheEntry {
    MalShape *source_shape;
    MalShapeAppendPlan append_plan;
    u8 source_slots[MAL_SHAPE_MAX_INLINE_SLOTS];
    u8 count;
    bool identity_projection;
} MalShapeCopyCacheEntry;

typedef struct MalVm {
    // Generated code reaches these on every call and throw check; leading the struct
    // keeps each access within a load's immediate offset.
    MalCompletion completion;
    /**
     * Lowest safe C-stack address (the real stack bottom plus a safety margin), or 0
     * when the platform stack bounds could not be queried. A compiled-function entry
     * whose frame is below this throws a RangeError before the C stack is actually
     * exhausted — robust to per-frame size, unlike the fixed depth counter alone
     * (which stays as a backstop). The stack grows down, so "below" means a smaller
     * address.
     */
    uptr stack_limit;
    /**
     * The limit compiled entries compare against. It holds stack_limit except while
     * a conservative image's poll is pending: its calls skip return polls, so a
     * request raises the isolate's word and the next entry services the safepoint.
     * A precise image points at its own word, since its roots are only published
     * at polls. See mal_vm_sync_entry_stack_limit.
     */
#if defined(__wasi__)
    uptr *entry_stack_limit;
    uptr own_entry_stack_limit;
#else
    _Atomic(uptr) *entry_stack_limit;
    _Atomic(uptr) own_entry_stack_limit;
#endif
    /** Highest address of the OS thread stack the isolate was created on, or zero
     * when unknown; the main fiber's conservative root scan ends here. */
    uptr native_stack_top;

    /**
     * Native (compiled-backend) call frames, for stack traces — see
     * MalNativeFrame. Each compiled entry pushes its own row, so the row count is
     * also the compiled nesting depth: interpreted recursion is bounded by the
     * value stack, compiled recursion by MAL_NATIVE_CALL_DEPTH_LIMIT rows. The
     * array is allocated once at that capacity and never moves, so a running entry
     * keeps a pointer to its own row.
     */
    MalNativeFrame *native_frames;
    i32 native_frame_count;
    i32 native_frame_capacity;
    /** Innermost compiled-function root frame; a field, not a thread-local, so
     * generated prologues and epilogues need no thread-local lookup. */
    struct MalRootFrame *root_frame_head;
    /** Interpreted-frame entry counter; see MalVmFrame.enter_seq. */
    u64 frame_seq;

#if !MAL_REALMS
    MalValue known_primordial_values[MAL_KNOWN_PRIMORDIAL_COUNT];
#endif
    const MalRuntimeImage *runtime_image;

    /** Initial immutable string table retained for native code's direct constants. */
    const MalString *initial_string_constants;
    i32 initial_string_constant_count;

    /**
     * VM-owned, mutable runtime image that `runtime_image` points at. Initialized
     * as a shallow copy of the input image with its function / string-constant /
     * bigint-constant / literal-template / CommonJS module tables relocated into
     * growable VM-owned
     * storage (the
     * instruction, handler, and code-unit data the rows point at stays in place —
     * static, or a loader arena). Runtime eval splices more functions, globals,
     * and constants in via mal_vm_splice_runtime_image without disturbing the const
     * `vm->runtime_image->...` access paths. The *_capacity fields size that growth.
     */
    MalRuntimeImage live_runtime_image;
    /**
     * Per function: the compiled entry of a strict ordinary callee, which receives
     * `this` unchanged, or nullptr. Generic dispatch reads this dense table before the
     * function's metadata row; see mal_vm_refresh_call_entry.
     */
    MalCompiledFunction *call_entries;
    i32 function_capacity;
    i32 string_capacity;
    i32 bigint_capacity;
    i32 literal_template_capacity;
    i32 cjs_module_capacity;
    i32 file_capacity;
    i32 source_position_capacity;
    i32 global_capacity;
#if !MAL_REALMS
    MalGlobalEnvironment global_environment;
#endif

    /** Lazily atomized debug filenames, indexed with live_runtime_image.files. */
    MalString **file_string_atoms;

    /**
     * Runtime-image-local CommonJS ids are rebased at the require seam. Runtime
     * splices remain interpreted, so the active frame identifies which module
     * table segment an id belongs to without rewriting numeric operands.
     */
    i32 *function_cjs_module_bases;

    /**
     * Per-function, VM-owned property-site caches shared by compiled and
     * interpreted execution. Dense rows are allocated with the VM so compiled
     * function entry needs only one indexed pointer load.
     * Consolidated native property regions hang their aggregate cache from the
     * leading site's parallel region row.
     */
    struct MalPropertyCachePool *property_cache;

    /** Per-function dense shaped-literal memo rows, shared by both backends. */
    struct MalShape ***literal_shape_cache;

    /** One admitted receiver layout per root-image class layout, by ordinal. */
    struct MalClassLayoutCell *class_cells;
    i32 class_cell_count;

    /**
     * Canonical property atom for each runtime-image string constant. This keeps
     * static property instructions and shaped literals identity-stable even
     * when eval splices a duplicate string constant from another image.
     */
    struct MalString **string_constant_atoms;

    /**
     * Megamorphic shaped-property stub cache: a shared, direct-mapped (shape, key)
     * -> slot/attributes table probed when a load or store site's inline N-way
     * cache has gone megamorphic. Allocated at VM init, zero-initialized (empty).
     * See MalPropertyStubEntry / mal_stub_hash in vm_ops.h.
     */
    struct MalPropertyStubEntry *property_stub;

    /**
     * Shared inherited-property stub rows. Unlike the shape-only own-property
     * table, every full cache row is registered against its exact prototype
     * chain and is invalidated eagerly on mutation.
     */
    struct MalInlineCache *inherited_property_stub;

    /**
     * Static names that no property on a builtin prototype chain answers, by the
     * chain's intrinsic prototype slot. Valid while the primitive-method protector
     * holds, since that protector fails on any change to a watched prototype.
     */
    struct MalBuiltinMissingRow *builtin_missing_rows;

    /** Process launch context retained for host modules loaded from portable wire. */
    MalHostLaunchContext launch;

    /** Shared final shape for CreateIterResultObject's `{ value, done }` layout. */
    struct MalShape *iterator_result_shape;

    /** Canonical RegExp instance layout: the sole shaped `lastIndex` property. */
    struct MalShape *regexp_instance_shape;

    /** Shared final named-property layouts for RegExp match/indices arrays. */
    struct MalShape *regexp_result_shape;
    struct MalShape *regexp_result_indices_shape;
    struct MalShape *regexp_indices_shape;

    /** Non-owning normalized object-spread plans keyed by immutable shapes. */
    MalShapeCopyCacheEntry shape_copy_cache[MAL_SHAPE_COPY_CACHE_CAPACITY];

    /** Shared EventEmitter plus `{ encrypted, readable, writable }` socket layout. */
    MalShapeAppendPlan node_http_socket_append_plan;

    /** Canonical node:http IncomingMessage layout before/after dispatch fields. */
    MalShapeAppendPlan node_http_readable_state_append_plan;
    MalShapeAppendPlan node_http_incoming_message_source_append_plan;
    MalShapeAppendPlan node_http_incoming_message_dispatch_append_plan;

    /** Prototype shapes guarding direct construction of canonical HTTP streams. */
    struct MalShape *node_http_object_prototype_shape;
    struct MalShape *node_http_event_emitter_prototype_shape;
    struct MalShape *node_http_stream_prototype_shape;
    struct MalShape *node_http_readable_prototype_shape;
    struct MalShape *node_http_incoming_message_prototype_shape;
    struct MalShape *node_http_server_response_prototype_shape;
    usize node_http_object_prototype_properties;
    usize node_http_event_emitter_prototype_properties;
    usize node_http_stream_prototype_properties;
    usize node_http_readable_prototype_properties;
    usize node_http_incoming_message_prototype_properties;
    usize node_http_server_response_prototype_properties;

    /** Canonical node:http ServerResponse parent/constructor/dispatch layouts. */
    MalShapeAppendPlan node_http_server_response_root_append_plan;
    MalShapeAppendPlan node_http_server_response_constructor_append_plan;
    MalShapeAppendPlan node_http_server_response_dispatch_append_plan;

    struct MalShape *node_url_instance_shape;

    /** Canonical null-prototype `{ changes, lastInsertRowid }` result layout. */
    struct MalShape *node_sqlite_run_result_shape;

    /** Bounded plain interpreted-function call cache; see vm_ops.c. */
    MalInterpCallCacheEntry *interp_call_cache;

    /** Bounded cache indexed by runtime-image string index; see vm_ops.c. */
    MalGlobalPropertyCacheEntry *global_property_cache;

    /** Innermost generated-code proof for a native builtin's script callback. */
    MalExactScriptCall *exact_script_call;

    MalHeap heap;
    /** Per-isolate collector cycle, worklists, remembered set, and statistics. */
    MalGcState *gc;
    /** Isolate-wide private symbol backing captured Error stacks. Rooted even
     * before any Error exists or a realm retains it. */
    MalValue error_stack_marker;
#if MAL_REALMS
    /** Current-realm globals; aliases current_realm->globals and is not owned here. */
    MalValue *globals;
    /**
     * Intrinsics of the current realm. Aliases current_realm->intrinsics (which
     * lives inline in the realm), so `vm->intrinsics[slot]` reads/writes the
     * active realm's table unchanged. Not owned here.
     */
    MalValue *intrinsics;
    // The realm created at init, before intrinsic initialization; owns the
    // initial globals and intrinsics. Held so teardown and default-realm logic
    // can find it directly.
    MalRealm *initial_realm;
    // The realm the globals and intrinsics pointers currently alias.
    MalRealm *current_realm;
    // Head of the singly linked list of all realms, for GC root scanning and
    // teardown (see mal_realm_new / mal_realm_free_all).
    MalRealm *realms;
#else
    MalValue *globals;
    MalValue intrinsics[MAL_INTRINSIC_COUNT];
#endif
    MalLiteralCacheEntry literal_cache_entries[MAL_LITERAL_CACHE_CAPACITY];
    u32 literal_cache_count;
    u32 literal_cache_cursor;
    /** Preallocated, permanently rooted exception used when allocation cannot continue. */
    MalValue allocation_error;

    // Present without MAL_NODE so Node and non-Node runtimes share one MalVm layout,
    // and with it the compiled eval-compiler overlay objects built against vm.h.
    /**
     * Current immutable AsyncLocalStorage binding chain. It belongs to the
     * executing fiber and is captured by async resources at creation time.
     */
    struct MalAsyncContext *async_context;
    /** Whether node:v8 requested explicit GC exposure for future VM contexts. */
    bool node_v8_expose_gc;

    /**
     * PromiseJobs microtask queue (singly-linked FIFO). Settling a promise and
     * Promise.prototype.then append jobs here; the top-level loop drains them to
     * empty at a baseline frame count. See microtask.h.
     */
    struct MalJob *job_head;
    struct MalJob *job_tail;
    /** Reclaimable isolate-owned blocks backing queued, active, and free jobs. */
    struct MalJobBlock *job_blocks;
    struct MalJobBlock *job_active_block;
    /** Completely idle blocks retained for reuse; bounded by the microtask layer. */
    u32 job_idle_block_count;

    /**
     * The job currently being run by the microtask drain, unlinked from the queue
     * but still holding live MalValues (its handler, argument, and capabilities)
     * that the handler may settle after a collection. Traced as a root so those
     * values survive a GC triggered while the handler runs. Null when idle.
     */
    struct MalJob *active_job;

    /** Cleared, untraced pending-reaction nodes retained for reuse. */
    struct MalPromiseReaction *reaction_pool;
    u32 reaction_pool_count;
    /** Reclaimable blocks backing active and pooled Promise reaction nodes. */
    struct MalPromiseReactionBlock *reaction_blocks;
    struct MalPromiseReactionBlock *reaction_active_block;

    /**
     * Byte-bounded, untraced size-class pools of cleared suspendable-frame value
     * buffers and their retained-byte totals. Classes are indexed directly; the
     * final class is the largest capacity permitted by the per-buffer policy.
     */
    struct MalCoroutineBuffer *coroutine_buffer_pools[MAL_COROUTINE_POOL_CLASS_COUNT];
    usize coroutine_buffer_pool_class_bytes[MAL_COROUTINE_POOL_CLASS_COUNT];
    usize coroutine_buffer_pool_bytes;
    u32 coroutine_buffer_pool_count;

    /** Cleared async-generator request nodes retained for reuse. */
    struct MalAsyncGeneratorRequest *async_generator_request_pool;
    u32 async_generator_request_pool_count;

    /** Cleared FinalizationRegistry registration cells retained for reuse. */
    struct MalFinRegCell *finalization_registry_cell_pool;
    u32 finalization_registry_cell_pool_count;

    /**
     * [[KeptObjects]]: WeakRef targets observed (constructed or deref'd) since the
     * last microtask checkpoint, held strongly so a target cannot be reclaimed
     * partway through a synchronous turn (deref must stay stable within a job).
     * Traced as a root; emptied at each checkpoint (ClearKeptObjects).
     */
    MalValue *kept_objects;
    i32 kept_count;
    i32 kept_capacity;

    /**
     * Runtime `eval` / `new Function` (eval Phase 4). `compiler_fn` is the baked
     * compiler's published `__compile(source) -> Uint8Array`, captured into this
     * rooted slot on first eval (then deleted off globalThis). It closes over the
     * whole baked compiler environment, so tracing it as a root keeps that alive.
     * `loaded_images` retains each distinct program spliced at runtime (the baked
     * compiler plus compiler-cache misses): the spliced functions reference
     * their instruction data in-place in these arenas, freed as a unit at teardown.
     */
    MalValue compiler_fn;
    bool compiler_installed;
    MalNativeProgramRelocation compiler_native_relocation;
    MalLoadedRuntimeImage **loaded_images;
    i32 loaded_image_count;
    i32 loaded_image_capacity;

    /**
     * Promises that rejected while unhandled (no reject handler attached at
     * rejection time). Reported at the microtask checkpoint unless a handler was
     * attached before then (re-checked via [[PromiseIsHandled]]). A growable
     * array of promise values; traced as a root.
     */
    MalValue *unhandled_rejections;
    i32 unhandled_count;
    i32 unhandled_capacity;

    /**
     * The result promise of an async program entry (a top-level-await module),
     * recorded at its ASYNC_START since it has no caller register. After the
     * microtask drain, a rejected entry promise means the module failed to
     * evaluate, which the entry turns into a non-zero exit. Undefined otherwise.
     */
    MalValue entry_async_promise;
    // Workers fail on uncaught asynchronous errors and forward the reason to their parent.
    bool errors_forwarded;
    // The pending throw was already printed as uncaught, so the event loop only stops.
    bool uncaught_reported;

    MalSymbolRegistry symbol_registry;
    // Shapes and caches borrow these canonical pointers for the VM lifetime.
    MalAtomStore atoms;
    MalNativeSourceCache native_source_cache;

    /**
     * Direct pointers for measured request-hot atom names. The atom table owns
     * and roots the strings; this array only removes repeated content probes.
     */
    MalString *hot_intrinsic_keys[MAL_HOT_KEY_COUNT];

    /**
     * Direct-mapped by the address of the caller's name, which is nearly always a
     * literal. Entries are still content-validated because a reused buffer can
     * hold another name; the atom table owns the strings.
     */
    MalAsciiAtomCacheEntry ascii_atom_cache[MAL_ASCII_ATOM_CACHE_CAPACITY];

    /** Shape positions of static names, filled by mal_object_get_own_static. */
    MalStaticSlotCacheEntry static_slot_cache[MAL_STATIC_SLOT_CACHE_CAPACITY];

    /** Compiled programs of literal-like RegExp sources, owned by builtin_regexp.c. */
    struct MalRegExpTemplates *regexp_templates;
    /**
     * RegExp.prototype's match, matchAll, replace, search, and split methods by the
     * prototype they were read from; trusted only while watched methods are intact.
     */
    struct {
        const struct MalObject *prototype;
        MalValue method;
    } regexp_protocol_methods[5];
    /** Inline caches for mal_vm_get_static, keyed by literal address. */
    struct MalStaticLoadSites *static_load_sites;
    /** JSON.parse's keys by source bytes and last record shape, owned by builtin_json.c. */
    struct MalJsonKeyCache *json_key_cache;
    /** JSON.stringify's escaped-key plans by shape, owned by builtin_json.c. */
    struct MalJsonPlanCache *json_plan_cache;

    /**
     * Data properties that iteration protocols inherit through watched built-in
     * prototypes, keyed by the receiver's prototype. Entries are consulted only
     * while mal_primitive_method_protector holds; the prototype keeps each value
     * reachable.
     */
    MalWatchedLookupEntry watched_lookup_cache[MAL_WATCHED_LOOKUP_CACHE_CAPACITY];

    /**
     * Lazily interned Latin-1 one-code-unit strings. The atom table owns and roots
     * each populated entry; direct indexing removes allocation and content probes
     * from character extraction, iteration, RegExp, and string-spread paths.
     */
    MalString *code_unit_strings[256];
    /** Root-locale case conversions of atoms, as atoms; see mal_builtin_string_case_known. */
    struct {
        MalString *input;
        MalString *result;
        bool upper;
    } string_case_cache[128];

    /**
     * Contiguous register/argument storage for non-suspendable frames. Each such
     * frame carves a window [stack_base, stack_base+slots); return pops it by
     * restoring value_stack_size. Fixed capacity — overflow throws a RangeError
     * ("Maximum call stack size exceeded") — so it never reallocates and the
     * register/argument pointers held by live frames stay valid. Generator and
     * (later) async activations live on the heap instead, since they outlive the
     * synchronous stack across suspends, and so do not use this.
     */
    MalValue *value_stack;
    i32 value_stack_size;
    i32 value_stack_capacity;

    struct MalVmFrame *frames;
    i32 frame_count;
    i32 frame_capacity;

    // Saturation makes every prepared-prefix comparison miss instead of wrapping.
    u64 service_epoch;

    /** Active nested Proxy meta-object dispatches; bounds recursive Proxy chains. */
    i32 proxy_dispatch_depth;

    /**
     * Count of active *un-rooted* native builtin invocations on the C stack. A
     * builtin holds MalValue scratch in C locals the root scan cannot enumerate, so
     * the collector must not run while any are active — the safepoint poll is gated
     * on this being zero. A builtin that has rooted all such scratch lifts its own
     * contribution for the rooted region via mal_gc_native_rooted_begin/end, so the
     * collector can run inside it (preventing unbounded heap growth in long callback
     * loops). Compiled-backend frames are NOT counted here: each publishes a
     * MalRootFrame, so the collector can scan their registers and run inside them.
     */
    i32 gc_native_frames;

#if MAL_PROFILE
    /** Last source site published by either backend; profile attribution is O(1). */
    i32 profile_current_site_id;
#endif

    /**
     * Captured stack traces, indexed by recyclable id. The private property on
     * the owning object releases its slot when that object is finalized; the
     * parallel free-list preserves stable ids for live captures.
     */
    MalStackTrace **captured_traces;
    i32 *captured_trace_free_next;
    i32 captured_trace_count;
    i32 captured_trace_capacity;
    i32 captured_trace_free_head;
    i32 captured_trace_live_count;

    /**
     * CommonJS module registry, sized to program->cjs_module_count (null when
     * the program has none). Each slot caches a module's `module` object after
     * (and during) its first require, so require() returns `module.exports` live.
     */
    MalCjsModuleSlot *cjs_registry;

    /** Module exports of every image of a relocatable program spliced so far. */
    MalModuleLinkRegistry module_links;

    /**
     * Fibers (see docs/decisions/03-wave-0-host-architecture.md). This MalVm is the *isolate*: it owns the
     * heap + globals, and one or more fibers execute on it (one at a time on this
     * thread). `current_fiber` is the running one — its per-execution slice
     * (value stack, frames, completion, GC root chains, stack limit) is live in
     * the fields above and is swapped out to the fiber on a context switch.
     * `fibers_head` links every live fiber so the collector can enumerate the
     * suspended ones' saved roots. Both null until mal_fiber_init_main runs.
     */
    struct MalFiber *current_fiber;
    struct MalFiber *fibers_head;

    /**
     * Opaque host context (the "host" layer: reactor, timers, later threads/clock),
     * attached by mal_host_attach. The engine never dereferences it — host-layer
     * code casts it back via mal_host(vm). Null for an engine-only embedding (e.g.
     * the bare test262 runner). See host.h.
     */
    void *host;
    bool host_web_platform;
    bool host_node;
    /* Node's console formatting, registered by the runtime personality (see builtin_console.h). */
    const struct MalConsoleNodeHooks *console_node_hooks;

    // Application fragments share prepared exports for the lifetime of this isolate.
    MalPreparedValue *prepared_values;

    /** Runtime modules reached by this isolate register their teardown here. */
    void (*runtime_cleanups[16])(MalVm *vm);
    usize runtime_cleanup_count;

    /**
     * Lazily allocated strong roots for repeated 2-4-unit concatenations. Keep
     * this tail-only so enabling the optimization does not perturb offsets of
     * the VM's established hot fields.
     */
    struct MalString **tiny_string_cache;

    /** Lazily allocated canonical decimal strings for int32 values 0..1023. */
    struct MalString **small_uint_string_cache;
    /** One past the largest populated uint slot; bounds every GC root scan. */
    u16 small_uint_string_cache_scan_limit;

    /** Lazily allocated immutable BigInt cells for values -128 through 255. */
    struct MalBigInt **small_bigint_cache;

    /** C-stack-linked receivers currently being joined, used to terminate array cycles. */
    struct MalArrayJoinFrame *array_join_frames;

    /** Tail-only semantic versions: do not perturb established hot VM offsets. */
    MalSemanticEpochs semantic_epochs;
    /** The last non-atom string converted to a property key and its atom. */
    struct {
        const struct MalString *string;
        struct MalString *atom;
        u32 heap_epoch;
    } key_atom_cache;
    /**
     * For-in key arrays built from one plain object's own shape, by array address.
     * Every key array overwrites its slot when created, so a stale entry for a
     * collected array cannot match a later key array at the same address.
     */
    MalForInSnapshot for_in_snapshots[4];
    /** %ArrayIteratorPrototype%.next's behaviour for for-in key Arrays, unreachable from JavaScript. */
    MalValue for_in_iterator_next;
    /**
     * Shapes reached by installing a run of private elements, keyed by the source
     * shape and first name. Shapes are immortal and their transitions immutable, so
     * an entry whose tail names match stays exact.
     */
    struct {
        const struct MalShape *source;
        struct MalShape *final;
    } private_append_cache[128];
} MalVm;

static inline u32 mal_static_slot_cache_index(const MalShape *shape, const byte *name) {
    return (u32) ((((uptr) name ^ ((uptr) shape >> 4)) * 0x9E3779B97F4A7C15ull) >> 32) &
        (MAL_STATIC_SLOT_CACHE_CAPACITY - 1);
}

/**
 * mal_object_get_own for a string literal `name`, which the runtime keeps reading
 * from objects of a few recurring shapes. Like mal_intrinsic_static_string_key, it
 * identifies the name by its address. Native glue reads such fields many times per
 * call, so a cached shape position resolves without a call.
 */
static inline MalPropertyLookup mal_object_get_own_static(
    MalVm *vm, const MalObject *object, const byte *name
) {
    const MalShape *shape = object->shape;
    const MalStaticSlotCacheEntry *entry =
        &vm->static_slot_cache[mal_static_slot_cache_index(shape, name)];
    if (entry->name == name && entry->shape == shape && entry->index >= 0) {
        const MalShapeProp *prop = &shape->props[entry->index];
        return (MalPropertyLookup) {
            .present = true,
            .entry = nullptr,
            .desc = {
                .flags = (MalPropertyFlags) prop->attrs,
                .value = mal_object_field_load(object, prop->slot),
                .getter = mal_value_new_undefined(),
                .setter = mal_value_new_undefined(),
            },
        };
    }
    return mal_object_get_own_static_resolve(vm, object, name);
}

/** Every engine heap is the unique inline heap of one MalVm. */
static inline MalVm *mal_vm_from_heap(MalHeap *heap) {
    return (MalVm *) ((byte *) heap - offsetof(MalVm, heap));
}

/** Lazily materialize one function's property and shaped-literal cache rows. */
void mal_vm_ensure_function_caches(MalVm *vm, i32 function_index);

#if MAL_REALMS
/**
 * Enter `target` realm if it is not already current. The predicted same-realm
 * comparison makes an in-realm call (the overwhelming common case) a single branch
 * with no switch; the actual switch runs only at a genuine realm boundary. `nullptr`
 * is treated as "no change" so a stamp that was never assigned cannot null out the
 * active realm. This is the one lever call/construct seams pull to cross into (and
 * back out of) a callee's realm.
 */
static inline void mal_vm_realm_switch_to(MalVm *vm, MalRealm *target) {
    if (target != nullptr && target != vm->current_realm) {
        mal_realm_switch(vm, target);
    }
}

/**
 * The realm to enter for a resolved (post-bound) callee — its stamped owning realm.
 * Only plain script and native function objects carry one; a value that reaches a
 * call seam without resolving to one of those (a proxy forwarded here, say) stays in
 * the caller's realm until its own target/trap runs, so this returns the current
 * realm for it. Deliberately NOT GetFunctionRealm: no bound/proxy unwrapping (bound
 * targets are already resolved before this is consulted) and no exotic fallback.
 */
MalRealm *mal_vm_callee_realm(MalVm *vm, MalValue callee);
bool mal_vm_owns_realm(const MalVm *vm, const MalRealm *realm);

/**
 * GetFunctionRealm (ECMA-262 10.2.2): resolve a callable's owning realm through
 * any interleaved bound-function and Proxy wrappers. A revoked Proxy fails with
 * a pending TypeError created in the current realm. Values without a stamped
 * function realm fall back to the current realm.
 */
bool mal_vm_get_function_realm(MalVm *vm, MalValue callable, MalRealm **realm_out);
#endif

/**
 * GetPrototypeFromConstructor (ECMA-262 10.1.14): read constructor.prototype
 * through the normal MOP and return it when it is an object. Otherwise use the
 * named intrinsic from the constructor's realm. In a realms-disabled build the
 * fallback remains the current VM intrinsic, preserving the former behavior.
 * The helper never switches the current realm.
 */
bool mal_vm_get_prototype_from_constructor(
    MalVm *vm,
    MalValue constructor,
    MalIntrinsic intrinsic_default_proto,
    MalObject **prototype_out
);

/**
 * Lift this native builtin's GC suppression once it has made every MalValue it
 * holds live across an allocation reachable from a root (a MalRootSpan, the value
 * stack, or a live managed object). Between begin/end the collector may run — so a
 * long allocating callback loop (map/filter/reduce/...) can reclaim instead of
 * growing the heap without bound.
 *
 * Mechanism: gc_native_frames counts active *un-rooted* native frames; the
 * safepoint poll collects only when it is zero. A builtin is always entered
 * through a call seam that incremented the counter, so on entry it is >= 1.
 * `begin` removes this frame's contribution; if no other un-rooted native is
 * active the counter reaches zero and collection is enabled. If an outer un-rooted
 * native is still on the stack the counter stays >= 1 and collection remains
 * suppressed (that outer frame's scratch is not safe) — correct, just no relief in
 * that nested case. Must be balanced (route every exit, including throw, through
 * `end`); the worst case of an imbalance is extra suppression, never an unsafe
 * collection.
 */
static inline void mal_gc_native_rooted_begin(MalVm *vm) {
    vm->gc_native_frames--;
}

static inline void mal_gc_native_rooted_end(MalVm *vm) {
    vm->gc_native_frames++;
}

/**
 * Roots the receiver, new.target, callee, and argument buffer handed to a callee across a
 * GC-able call so a collection inside it cannot reclaim them. Two cases need this:
 *
 *  - native builtins: the receiver and new.target arrive as plain C locals (the
 *    caller keeps only the value-stack args live, not the receiver), and a bound
 *    call's args live in a malloc'd buffer off the value stack;
 *  - compiled constructors: the instance is freshly allocated *in the dispatcher*
 *    (mal_object_new) and exists only as `this_value` until the body stores it
 *    somewhere — no other root holds it, so a collection inside the body would
 *    sweep it. (Interpreted constructors are safe: the instance lives in the
 *    pushed frame's this_value, which the root scan covers.)
 *
 * Declare on the dispatcher's C stack so the spans outlive the call; balance
 * begin/end across every exit.
 */
typedef struct MalCalleeRoots {
    MalRootSpan receiver_span;
    MalRootSpan args_span;
    MalValue receiver_slots[3];
} MalCalleeRoots;

static inline void mal_gc_callee_roots_begin(
    MalCalleeRoots *roots, MalValue this_value, MalValue new_target, MalValue callee,
    const MalValue *args, i32 arg_count
) {
    roots->receiver_slots[0] = this_value;
    roots->receiver_slots[1] = new_target;
    roots->receiver_slots[2] = callee;
    MalIsolateLocals *isolate = mal_isolate_locals();
    roots->receiver_span = (MalRootSpan) {
        .slots = roots->receiver_slots, .count = 3, .prev = isolate->root_span_head};
    // Cast away const: the collector only reads (shades) these slots.
    roots->args_span = (MalRootSpan) {
        .slots = (MalValue *) args, .count = arg_count, .prev = &roots->receiver_span};
    isolate->root_span_head = &roots->args_span;
}

static inline void mal_gc_callee_roots_end(MalCalleeRoots *roots) {
    mal_isolate_locals()->root_span_head = roots->receiver_span.prev;
}

/**
 * Cap on nested compiled-function calls in row builds, whose rows are allocated
 * once at this depth. Each level holds a real C frame (the compiled function plus
 * the dispatch helper), so this is kept well below what an 8 MiB stack tolerates
 * while staying far deeper than any realistic non-tail recursion. Walked frames
 * are bounded by the stack limit alone.
 */
#define MAL_NATIVE_CALL_DEPTH_LIMIT 6000
static_assert(MAL_NATIVE_CALL_DEPTH_LIMIT <= UINT16_MAX, "MalVmFrame.native_depth is 16 bits");

void mal_vm_throw_stack_overflow(MalVm *vm);

static inline uptr mal_vm_entry_stack_limit(const MalVm *vm) {
#if defined(__wasi__)
    return *vm->entry_stack_limit;
#else
    return atomic_load_explicit(vm->entry_stack_limit, memory_order_relaxed);
#endif
}

/** Point compiled entries at the right limit word and load the running stack's limit. */
void mal_vm_sync_entry_stack_limit(MalVm *vm);
/** An entry below its limit: false after an overflow or termination, else polls serviced. */
bool mal_vm_enter_compiled_limit(MalVm *vm);
/** Allocate the frame rows or report the overflow; the entry's row when it proceeds. */
MalNativeFrame *mal_vm_enter_compiled_slow(MalVm *vm, i32 function_index);

#if UINTPTR_MAX != UINT64_MAX || (!defined(__aarch64__) && !defined(__x86_64__))
uptr mal_vm_native_stack_address(void);
#else
static inline uptr mal_vm_native_stack_address(void) {
    uptr address;
    // A frame pointer can sit above a large caller's locals; the guard needs its SP.
#if defined(__aarch64__)
    __asm__ volatile("mov %0, sp" : "=r" (address) : : "memory");
#else
    __asm__ volatile("mov %%rsp, %0" : "=r" (address) : : "memory");
#endif
    return address;
}
#endif

/** The row count is the call depth. Rows are allocated once at MAL_NATIVE_CALL_DEPTH_LIMIT,
 * so one comparison sends both allocation and the depth limit to the slow path, and an
 * entry's row never moves while it runs. */
static inline MalNativeFrame *mal_vm_push_native_frame(
    MalVm *vm, i32 count, i32 function_index
) {
    MAL_PERF_COUNT(compiled_debug_frame_entries);
    MalNativeFrame *row = &vm->native_frames[count];
    *row = (MalNativeFrame) {
        .function_index = function_index,
        .position_entry = -1,
#if MAL_PROFILE
        .site_id = -1,
#endif
    };
    vm->native_frame_count = count + 1;
    return row;
}

/** The entry's own frame row, which publishes its source position, or nullptr after
 * recording a RangeError. A successful entry requires a matching leave. */
static inline MalNativeFrame *mal_vm_enter_compiled_row(MalVm *vm, i32 function_index) {
    MAL_PERF_COUNT(compiled_enter_calls);
    i32 count = vm->native_frame_count;
    // A zero limit admits every address.
    if (__builtin_expect(mal_vm_native_stack_address() < mal_vm_entry_stack_limit(vm) ||
                             count >= vm->native_frame_capacity, 0))
        return mal_vm_enter_compiled_slow(vm, function_index);
    return mal_vm_push_native_frame(vm, count, function_index);
}

static inline bool mal_vm_enter_compiled(MalVm *vm, i32 function_index) {
    return mal_vm_enter_compiled_row(vm, function_index) != nullptr;
}

#if MAL_NATIVE_FRAME_WALK
/** The caller-owned record of a walked frame, or nullptr after recording a RangeError. */
static inline __attribute__((always_inline)) MalNativeFrame *mal_vm_enter_compiled_frame(
    MalVm *vm, MalNativeFrame *record, MalCompiledFrameDesc *desc, i32 function_index,
    void *frame_address
) {
    MAL_PERF_COUNT(compiled_enter_calls);
    *record = (MalNativeFrame) {
        .desc = desc,
        .function_index = function_index,
        .position_entry = -1,
    };
    // Registered before the stack check: the overflow's own capture walks this frame.
    if (__builtin_expect(
            atomic_load_explicit(&desc->frame_offset, memory_order_relaxed) == 0, 0)) {
        mal_compiled_frame_register(desc, (i32) ((char *) record - (char *) frame_address));
    }
    // A zero limit admits every address.
    if (__builtin_expect(mal_vm_native_stack_address() < mal_vm_entry_stack_limit(vm), 0) &&
            !mal_vm_enter_compiled_limit(vm)) {
        return nullptr;
    }
    return record;
}
#endif

/** The innermost visible compiled JavaScript function on the running stack, or -1. */
i32 mal_vm_innermost_compiled_function(MalVm *vm);

/** Source position id of entry `entry` in a function's position table, or -1 outside it. */
static inline i32 mal_function_position_entry_id(const MalFunction *function, i32 entry) {
    return entry >= 0 && entry < function->position_count ? function->positions[entry].pos_id : -1;
}

static inline i32 mal_vm_native_frame_pos_id(const MalVm *vm, const MalNativeFrame *frame) {
    return mal_function_position_entry_id(
        &vm->runtime_image->functions[frame->function_index], frame->position_entry);
}

static inline void mal_vm_leave_compiled(MalVm *vm) {
    vm->native_frame_count--;
}
/** Compiled entries enter themselves; this cleanup pops that frame on every return. */
static inline void mal_vm_leave_compiled_scope(MalVm *const *vm) {
    mal_vm_leave_compiled(*vm);
}
// A numeric leaf cannot throw, call or poll, so only the sampling profiler sees its frame.
static inline bool mal_vm_leaf_unobserved(const MalVm *vm) {
    (void) vm;
    return !MAL_PROFILE;
}
/** A leaf needs no depth or frame row, but its caller's frame may have used the margin;
 * below the limit it takes its full entry, which reports the overflow. */
static inline bool mal_vm_leaf_stack_available(const MalVm *vm) {
    const uptr stack_limit = vm->stack_limit;
    return stack_limit == 0 || mal_vm_native_stack_address() >= stack_limit;
}


/**
 * Capture the current synchronous call stack (top frame first), merging the
 * interpreted frames with the native compiled frames in call order. The caller
 * owns the returned trace and must free it with mal_vm_free_stack_trace — except
 * that captures stored on an Error are owned by the VM's captured_traces table.
 */
MalStackTrace *mal_vm_capture_stack(MalVm *vm);

/** Free a captured trace and its async-parent chain. */
void mal_vm_free_stack_trace(MalStackTrace *trace);

/**
 * Store a captured trace in the VM's table and return its id (for stashing on an
 * Error). The VM owns it thereafter.
 */
i32 mal_vm_store_stack_trace(MalVm *vm, MalStackTrace *trace);

/** Look up a stored trace by id, or nullptr if out of range. */
MalStackTrace *mal_vm_stored_stack_trace(MalVm *vm, i32 id);

/** Release a stored trace id when its private-property owner dies or replaces it. */
void mal_vm_release_stack_trace(MalVm *vm, i32 id);

/**
 * Format a captured trace as the lines following an Error header — each frame as
 * "\n    at <name> (<file>:<line>:<column>)" (column 1-based), including any
 * async-parent frames. Returns a heap MalString the caller concatenates after
 * the "Name: message" header.
 */
MalString *mal_vm_format_stack_frames(MalVm *vm, const MalStackTrace *trace);

typedef struct MalGeneratorObject MalGeneratorObject;

typedef struct MalVmFrame {
    /*
     * Fields are grouped 8-byte members first, then the i32 cluster, then the
     * lone bool, so a per-call frame carries no interior padding (it is on the
     * interpreter's hot frame stack and embedded in every generator).
     */
    MalVm *vm;
    /**
     * Resolved (cached) pointer into vm->live_runtime_image.functions, used by the
     * hot loop. `function_index` is the source of truth: a runtime-eval splice
     * may realloc the function table and move it, so the splice re-resolves
     * `function` for every live frame from its index (and a generator resume
     * re-resolves too, in case a splice moved the table while it was suspended).
     */
    const MalFunction *function;
    MalValue *registers;
    MalValue *arguments;
    MalValue this_value;
    MalValue arguments_object;

    /**
     * The function object that was called to push this frame (undefined for the
     * top-level frame). GENERATOR_START reads its .prototype for the generator
     * instance's [[Prototype]].
     */
    MalValue callee;

    /**
     * Non-null for a generator activation: the generator object that owns this
     * frame's storage. RETURN consults it to mark the generator completed
     * rather than freeing into a caller register.
     */
    MalGeneratorObject *generator;

    /**
     * Own captured-slot node when the function has captured slots, otherwise
     * the callee's creation environment passed through for chain walks.
     */
    MalEnv *env;

    /**
     * The new.target for this activation: the constructor when invoked through
     * `new`/construct, undefined for an ordinary call. LOAD_NEW_TARGET reads it.
     */
    MalValue new_target;

    /**
     * Monotonic sequence number assigned when this frame was pushed (or a
     * generator/async frame resumed); it identifies one activation of a reused slot.
     */
    u64 enter_seq;

#if MAL_REALMS
    /**
     * The realm this activation runs in, stamped when the frame is pushed (from the
     * callee's owning realm, via the current realm at push time). The shared
     * interpreter loop re-enters this frame's realm at the top of every dispatch, so
     * a RETURN or exception unwind that exposes a caller/handler frame automatically
     * restores that frame's realm — no separate save/restore in the loop body.
     */
    MalRealm *realm;
#endif

    i32 function_index;
    i32 argument_count;

    /**
     * For a value-stack frame, the value_stack_size to restore when this frame
     * is torn down (also the base of its register/argument window). -1 marks a
     * heap-resident activation (generators/async): its registers and arguments
     * are owned heap buffers, freed on teardown rather than popped off the stack.
     */
    i32 stack_base;

    i32 instruction_pointer;
    /** Published operation IP while execution is inside a GC-capable boundary. */
    i32 gc_safepoint_ip;
    // Compiled coroutines have no interpreter caller; their storage/IP contract uses this space.
    union {
        struct {
            i32 return_register;
            i32 caller_frame_index;
        };
        struct {
            i32 compiled_register_count;
            /** One past the suspending site's entry in the function's position table. */
            i32 compiled_suspend_position_entry;
        };
    };
    bool is_compiled;
    /**
     * Construct frames replace non-object return values with this_value.
     */
    bool is_construct;
#if !MAL_NATIVE_FRAME_WALK
    /**
     * Native rows live when this frame was pushed or resumed. Both frame stacks are
     * LIFO, so native row n is older than this frame exactly when n < native_depth;
     * stack-trace capture merges the stacks by it. See mal_vm_capture_stack.
     */
    u16 native_depth;
#endif
} MalVmFrame;

static_assert(sizeof(MalVmFrame) <= (MAL_REALMS ? 144 : 136),
              "interpreter frame outgrew its packed layout");

#if MAL_NATIVE_FRAME_WALK
/*
 * A walked build keeps, after a frame stack's frames in the same allocation, the
 * frame pointer of the C function that pushed or resumed each frame. Every compiled
 * frame that activation later runs lies strictly below it and every older one at or
 * above it, so stack-trace capture merges the two stacks by it.
 */
#define mal_vm_frame_storage_bytes(capacity) \
    ((usize) (capacity) * (sizeof(MalVmFrame) + sizeof(uptr)))
#define mal_vm_frame_native_positions(vm) ((uptr *) ((vm)->frames + (vm)->frame_capacity))
// Inlined into its caller this reads the next frame up, which still orders correctly.
#define mal_vm_frame_mark_native_position(frame, vm) \
    (mal_vm_frame_native_positions(vm)[(frame) - (vm)->frames] = \
        *(const uptr *) __builtin_frame_address(0))
#else
#define mal_vm_frame_storage_bytes(capacity) ((usize) (capacity) * sizeof(MalVmFrame))
#define mal_vm_frame_mark_native_position(frame, vm) \
    ((frame)->native_depth = (u16) (vm)->native_frame_count)
#endif

typedef MalVmFrame MalCallable;

/**
 * Initialize one isolate through ordered engine, program-adoption, execution,
 * and language-state phases. Host attachment and host installs happen only
 * after this contract completes.
 */
void mal_vm_init(MalVm *vm, const MalRuntimeImage *program);

/** Register one idempotent runtime-module teardown with the owning isolate. */
bool mal_vm_register_runtime_cleanup(MalVm *vm, void (*cleanup)(MalVm *vm));

// Close native producers while their reactor and mutator-owned roots still exist.
void mal_vm_run_runtime_cleanups(MalVm *vm);

/** Process-wide loaded bytecode footprint used by benchmark telemetry. */
u64 mal_vm_loaded_instruction_count(void);
u64 mal_vm_loaded_instruction_data_count(void);

/** Native suspendable-frame allocation counters used by benchmark telemetry. */
u64 mal_coroutine_buffer_request_count(void);
u64 mal_coroutine_buffer_allocation_count(void);
u64 mal_coroutine_buffer_reuse_count(void);
u64 mal_coroutine_buffer_release_count(void);
u64 mal_coroutine_buffer_pooled_count(void);
u64 mal_coroutine_buffer_dropped_count(void);
u64 mal_coroutine_buffer_peak_retained_bytes(void);
MalValue *mal_vm_alloc_coroutine_buffer(MalVm *vm, i32 slot_count);
void mal_vm_release_coroutine_buffer(MalVm *vm, MalValue *values);
/** Skip per-slot barriers; the owning frame must be exact-shaded during active marking. */
void mal_vm_release_shaded_coroutine_buffer(MalVm *vm, MalValue *values);
void mal_vm_free_coroutine_buffer_pool(MalVm *vm);

/**
 * Run the program's host-install manifest: for each reached `node:*` built-in
 * / `process`, call its installer to fill the export global slots. Call after
 * mal_vm_init (and, for a host program, after mal_host_attach) and before running
 * the entry — the compiled program reads those slots via LOAD_GLOBAL. `launch`
 * carries the process command line for the installers that need it (`process`);
 * pass the driver's own argc/argv. A no-op when the manifest is empty (every
 * ordinary program) or an installer is unresolved (a from-wire program), so it
 * is safe to call unconditionally.
 */
static inline void mal_vm_run_program_host_installs(
    MalVm *vm, const MalRuntimeImage *program, const MalHostLaunchContext *launch) {
    for (i32 i = 0; i < program->host_install_count; i++) {
        const MalHostInstall *install = &program->host_installs[i];
        if (install->installer != nullptr) {
#if MAL_PROFILE && MAL_PERF_STATS
            u8 previous_profile_category = vm->heap.profile_native_category;
            vm->heap.profile_native_category = MAL_PROFILE_SITE_RUNTIME_HOST;
#endif
            install->installer(vm, install->slots, install->slot_count, launch);
#if MAL_PROFILE && MAL_PERF_STATS
            vm->heap.profile_native_category = previous_profile_category;
#endif
        }
    }
}

static inline void mal_vm_run_host_installs(MalVm *vm, const MalHostLaunchContext *launch) {
    if (launch != nullptr) vm->launch = *launch;
    mal_vm_run_program_host_installs(vm, vm->runtime_image, launch);
}

void mal_vm_free(MalVm *vm);

/**
 * Append a loaded runtime image's functions, globals, and string/bigint constants
 * to the running VM, rebasing every internal reference (function indices, global
 * slots, string/bigint constant indices) by the current table sizes, and return
 * the function-index base the spliced functions start at — so the caller can
 * invoke the spliced entry via mal_vm_create_callable(vm, base). The base
 * program's existing state (globals, constants) is untouched. Backs runtime
 * eval / the Function constructor.
 *
 * Consumes `loaded`: the spliced functions reference its instruction/constant
 * data in place (rebased), so the caller must keep `loaded` alive for the VM's
 * lifetime and must not splice or run it again. Must be called at a baseline
 * (no live frames) — it may realloc the function table, which would dangle a
 * running frame's function pointer.
 */
i32 mal_vm_splice_runtime_image(MalVm *vm, const MalRuntimeImage *loaded);

/** Retain a loaded arena after a successful splice until VM teardown. */
void mal_vm_retain_loaded_runtime_image(MalVm *vm, MalLoadedRuntimeImage *loaded);

/** Allocate a captured-slot environment node (parent chain + `count` slots
 * initialized to undefined) as a GC cell. Used by both the interpreter and
 * compiled code to build a function's per-activation env. May trigger a
 * collection: the caller must have rooted `parent` and any live frame slots
 * before calling (the compiled prologue publishes its root frame first). */
MalEnv *mal_env_new(MalVm *vm, MalEnv *parent, i32 function_index, i32 count);
// Native entries with a certified closure layout already know the parent policy.
MalEnv *mal_env_new_compact(MalVm *vm, MalEnv *parent, i32 function_index, i32 count);
/**
 * A native activation's environment created after its body already ran, with slots
 * copied from `values`. They must stay rooted: the allocation may collect.
 * `compact` selects mal_env_new_compact's parent policy, otherwise mal_env_new's.
 */
MalEnv *mal_env_new_from_frame(
    MalVm *vm, MalEnv *parent, i32 function_index, i32 count, bool compact, const MalValue *values
);

// Allocate a `with` object environment record (function_index MAL_ENV_WITH_OBJECT,
// slots[0] = object) and link it onto `parent`. Pushed onto the env chain by
// WITH_ENTER so closures created in the body capture it.
MalEnv *mal_env_new_with_object(MalVm *vm, MalEnv *parent, MalValue object);

/** AddToKeptObjects: pin a WeakRef target for the rest of the current turn. */
void mal_vm_add_kept_object(MalVm *vm, MalValue value);

/** ClearKeptObjects: release the kept set at a microtask checkpoint. */
void mal_vm_clear_kept_objects(MalVm *vm);

/** Record a promise that rejected while unhandled (for the microtask checkpoint). */
void mal_vm_note_unhandled_rejection(MalVm *vm, MalValue promise);

/** Report (to stderr) any still-unhandled rejected promises, then clear the list. */
void mal_vm_report_unhandled_rejections(MalVm *vm);

/**
 * A host's process-level handler for an uncaught throw (from_rejection false) or an
 * unhandled rejection of `promise`. It returns true when it consumed the error and
 * execution continues; it may leave a new throw pending instead.
 */
typedef bool (*MalVmUncaughtHandler)(MalVm *vm, MalValue error, bool from_rejection, MalValue promise);

void mal_vm_set_uncaught_handler(MalVmUncaughtHandler handler);

/**
 * Offer the pending throw completion to the uncaught handler; when it is not consumed,
 * print it to stderr the way an uncaught throw is and keep it pending. Returns true when
 * the handler consumed it and the completion is normal again.
 */
bool mal_vm_report_uncaught(MalVm *vm);

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index);

void mal_vm_free_callable(MalCallable *callable);

/**
 * Push an activation for the given function. The caller must have placed the
 * arg_count arguments in the top arg_count slots of the value stack (the callee
 * adopts that region as its register window). Returns false without pushing when
 * the value stack would overflow (a RangeError is left pending in that case);
 * callers must not touch vm->frames[frame_count - 1] when it returns false.
 */
bool mal_vm_push_function_frame(
    MalVm *vm,
    i32 function_index,
    MalEnv *creation_env,
    MalValue this_value,
    i32 arg_count,
    i32 return_register,
    i32 caller_frame_index
);

void mal_vm_run(MalVm *vm, MalCallable *callable);
bool mal_vm_check_entry_evaluation(MalVm *vm);

/**
 * Resume a suspended generator: reattach its frame, deliver the sent value to
 * the pending yield's resume register, and run until it yields, returns, or
 * throws. Afterwards the generator state distinguishes a yield (SUSPENDED_YIELD,
 * with yielded_value set) from completion (COMPLETED, with the return value in
 * vm->completion.value); a throw leaves vm->completion as THROW and marks the
 * generator COMPLETED.
 */
void mal_vm_resume_generator(MalVm *vm, MalGeneratorObject *generator, MalValue sent_value, i32 resume_mode);

/**
 * Reject an ordinary [[Call]] entry into an ECMAScript class constructor.
 * Callers invoke this after entering (or proving they are already in) the
 * resolved callee realm and before entering either a compiled body or an
 * interpreted frame.
 */
bool mal_vm_require_ordinary_call_target(
    MalVm *vm,
    const MalFunction *function
);

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Recompute a function's call_entries row after its compiled entry changes. */
void mal_vm_refresh_call_entry(MalVm *vm, i32 function_index);

/** [[Call]] from a compiled site, with its completion left in vm->completion. An ordinary
 * compiled callee is entered as a tail call, since it owns its activation, and a plain
 * native callee is entered without the generic call's bound and proxy resolution. */
MalValue mal_vm_call_cached_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

static inline MalCompletion mal_vm_call_cached(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalValue value = mal_vm_call_cached_value(vm, callee, this_value, args, arg_count);
    return vm->completion.kind == MAL_COMPLETION_THROW
        ? vm->completion
        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};
}

/**
 * Invoke a compiler-proven native builtin target without repeating callable,
 * bound-function, callback-pointer, or call-cache dispatch. The proof erases
 * dispatch only: this seam retains the generic native call contract for Realm
 * switching, profiling, callee/argument roots, and the unrooted-native frame
 * count that builtins balance with mal_gc_native_rooted_begin/end.
 */
MalCompletion mal_vm_call_exact_native(
    MalVm *vm,
    MalNativeFunctionCallback callback,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Guarded direct script-function call for native sites with an exact static target.
 * A matching live plain closure bypasses generic dispatch while
 * retaining its own environment, realm, identity, and this binding. Guard misses
 * use the ordinary cached call path.
 */
MalCompletion mal_vm_call_direct(
    MalVm *vm,
    i32 expected_function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Exact ordinary script-function call. Generated code has proved that `callee`
 * is a plain function object for `function_index`; this path deliberately has no
 * identity/type guard and no generic fallback. It still performs every semantic
 * part of [[Call]]: realm switching, class rejection, this binding, compiled
 * stack accounting, interpreted fallback, and abrupt completion propagation.
 */
MalCompletion mal_vm_call_exact_script(
    MalVm *vm,
    i32 function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Guarded flattening of `target.call(thisArg, ...args)`. The fast path is entered
 * only when `call_method` is the retained %Function.prototype.call% object. An
 * exact script target reuses mal_vm_call_direct; other targets retain ordinary
 * cached dispatch. A method-guard miss calls the originally loaded method with
 * the original receiver and arguments.
 */
MalCompletion mal_vm_call_function_call_direct(
    MalVm *vm,
    i32 expected_function_index,
    MalValue call_method,
    MalValue target,
    const MalValue *args,
    i32 arg_count
);

/**
 * Push a bytecode frame for `function_index` and run it to completion, marshaling
 * `args` onto the top of the value stack as the callee's incoming window, and
 * returning the result (vm->completion carries a throw out). Unlike
 * mal_vm_call_value / the call dispatchers this ALWAYS interprets, ignoring
 * function->compiled: it is the bail target for a native-backend function whose
 * entry-guard speculation failed, where re-dispatching (which honors .compiled)
 * would re-enter the same compiled function and loop forever. `callee` sets
 * frame.callee (for generator .prototype); when `new_target` is an object the
 * frame runs as a construct (is_construct, for a constructor bail).
 */
MalValue mal_vm_interpret_function(
    MalVm *vm,
    i32 function_index,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalEnv *env
);

/**
 * Run a spliced direct-eval entry function (no args, global creation env) with
 * `scope_object` injected into the fresh frame's with-stack, so the eval'd code's
 * free identifiers resolve against the caller's marshaled scope. Returns the
 * script completion value; a throw is left in vm->completion. Pass undefined for
 * scope_object to run with no injected scope.
 *
 * `dirty_tracker` rides along as the with-object's second env slot (see
 * mal_vm_op_with_set): pass undefined to disable dirty tracking for this run.
 */
MalValue mal_vm_run_entry_with_scope(MalVm *vm, i32 function_index, MalValue scope_object,
                                     MalValue this_value, MalValue new_target,
                                     MalValue dirty_tracker, MalValue persistent_scope);

/**
 * `new callee(args)` as a value: allocate the instance, run the constructor
 * (compiled, interpreted, or native) to completion, and return its result (a
 * non-object body completion becomes the instance). The construct analogue of
 * mal_vm_call_value, used by the native backend's CONSTRUCT.
 */
MalCompletion mal_vm_construct_value(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count);

/**
 * Guarded direct script-function construction for native sites with an exact static
 * target. A matching live plain closure bypasses bound/proxy/native dispatch while
 * retaining its environment, realm, callee/new.target identity, and full ordinary
 * constructor semantics. Guard misses use mal_vm_construct_value unchanged.
 */
MalCompletion mal_vm_construct_direct(
    MalVm *vm,
    i32 expected_function_index,
    MalValue callee,
    const MalValue *args,
    i32 arg_count
);

/**
 * Return a CommonJS module's `module.exports`, running its wrapper exactly once
 * (lazily, on first require) and caching the result. The compiler resolves each
 * `require("specifier")` to a module id and calls this through the CJS `require`
 * native; a circular require observes the in-progress module's partial exports.
 * A throw out of the wrapper is left in vm->completion and undefined returned.
 */
MalValue mal_vm_cjs_require(MalVm *vm, i32 id);

/**
 * The `this` a callee sees after sloppy-mode substitution (undefined/null this in
 * a non-strict function becomes the global object). Pass-through for strict
 * functions. push_function_frame applies this for interpreted frames; the
 * compiled-backend call paths apply it explicitly.
 */
MalValue mal_vm_callee_this(MalVm *vm, const MalFunction *function, MalValue this_value);

// Borrows the rooted callback; preparation cannot allocate, throw, or invoke JavaScript.
bool mal_vm_prepare_builtin_callback(MalVm *vm, MalValue callback, MalExactScriptCall *exact);

/**
 * Exact script call through a generated typed callback bridge. Keep this in the
 * header: the hot Array loop then folds the proved target setup into its callback
 * seam instead of adding a runtime helper frame between the loop and adapter.
 */
static inline __attribute__((always_inline)) MalCompletion
mal_vm_call_exact_script_compiled_callback(
    MalVm *vm,
    const MalExactScriptCall *exact,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return vm->completion;
    }
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, exact->callee));
#endif

    MalValue value = exact->compiled_callback(
        vm,
        mal_vm_callee_this(vm, &vm->runtime_image->functions[exact->function_index], this_value),
        args,
        arg_count,
        MAL_VALUE_UNDEFINED,
        exact->env,
        exact->callee,
        nullptr);
    MalCompletion completion = vm->completion.kind == MAL_COMPLETION_THROW
        ? vm->completion
        : (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = value};

#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return completion;
}

static inline __attribute__((always_inline)) MalCompletion mal_vm_call_builtin_callback(
    MalVm *vm,
    MalValue callback,
    MalValue this_arg,
    const MalValue *args,
    i32 arg_count
) {
    MalExactScriptCall *exact = vm->exact_script_call;
    if (exact != nullptr && exact->callee == callback) {
        MAL_PERF_COUNT(array_iteration_exact_callback_calls);
        if (exact->compiled_callback != nullptr) {
            MAL_PERF_COUNT(array_iteration_exact_compiled_callback_calls);
            return mal_vm_call_exact_script_compiled_callback(
                vm, exact, this_arg, args, arg_count);
        }
        return mal_vm_call_exact_script(
            vm, exact->function_index, callback, this_arg, args, arg_count);
    }
    return mal_vm_call_value(vm, callback, this_arg, args, arg_count);
}


static inline __attribute__((always_inline)) bool mal_vm_call_numeric_reduce_callback(
    MalVm *vm, const MalExactScriptCall *exact, f64 accumulator, f64 value,
    f64 index, MalValue receiver, f64 *result
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, exact->callee));
#endif
    MAL_PERF_COUNT(array_iteration_numeric_reduce_calls);
    *result = exact->numeric_reduce_callback(
        vm, mal_vm_callee_this(vm, &vm->runtime_image->functions[exact->function_index], MAL_VALUE_UNDEFINED),
        accumulator, value, index, receiver, exact->env, exact->callee);
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return vm->completion.kind != MAL_COMPLETION_THROW;
}

// The callback must match the guarded function index; keep it visible to C.
static inline __attribute__((always_inline)) MalCompletion
mal_vm_call_function_call_direct_compiled(
    MalVm *vm,
    i32 expected_function_index,
    MalCompiledFunction callback,
    MalValue call_method,
    MalValue target,
    const MalValue *args,
    i32 arg_count
) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) return vm->completion;
    if (call_method == vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL] &&
        mal_value_is_native_function_object(call_method) &&
        mal_value_is_function_object(target) &&
        expected_function_index >= 0 &&
        expected_function_index < vm->runtime_image->function_count &&
        mal_function_object_function_index(mal_value_to_function_object(target)) == expected_function_index &&
        !vm->runtime_image->functions[expected_function_index].is_class_constructor) {
        const MalExactScriptCall exact = {
            .callee = target,
            .function_index = expected_function_index,
            .compiled_callback = callback,
            .env = mal_value_to_function_object(target)->creation_env,
        };
        return mal_vm_call_exact_script_compiled_callback(
            vm, &exact, arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED,
            arg_count > 1 ? args + 1 : nullptr, arg_count > 1 ? arg_count - 1 : 0);
    }
    return mal_vm_call_function_call_direct(
        vm, expected_function_index, call_method, target, args, arg_count);
}

/**
 * mal_vm_construct_value with an explicit new.target (whose `.prototype`
 * parents the new instance), implementing the spec [[Construct]](args, newTarget).
 * Backs Reflect.construct; mal_vm_construct_value forwards with newTarget = callee.
 */
MalCompletion mal_vm_construct_exact_native(MalVm *vm, MalNativeFunctionCallback callback, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target);
MalCompletion mal_vm_construct_value_with_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target);

/**
 * Resolve the display name of a callable, or null for non-callables.
 */
MalString *mal_vm_callable_name(MalVm *vm, MalValue callee);
