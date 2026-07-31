#pragma once

#include "./defaults.h"
#include "gc.h"
#include "heap.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "value.h"

#define MAL_COROUTINE_POOL_CLASS_COUNT 14

typedef enum MalOpcode {
    MAL_OP_MOVE,
    MAL_OP_RETURN,
    MAL_OP_THROW,
    MAL_OP_CATCH,
    MAL_OP_TRY_BEGIN,
    MAL_OP_TRY_END,
    MAL_OP_JUMP_IF,
    MAL_OP_JUMP,
    MAL_OP_CREATE_NUMBER,
    MAL_OP_CREATE_F64,
    MAL_OP_CREATE_BOOLEAN,
    MAL_OP_CREATE_STRING,
    MAL_OP_CREATE_BIGINT,
    MAL_OP_CREATE_OBJECT,
    MAL_OP_CREATE_OBJECT_SHAPED,
    MAL_OP_CREATE_ARRAY,
    MAL_OP_CREATE_MODULE_NAMESPACE,
    MAL_OP_CREATE_UNDEFINED,
    MAL_OP_CREATE_EMPTY,
    MAL_OP_CREATE_NULL,
    MAL_OP_CREATE_FUNCTION,
    MAL_OP_CREATE_ARGUMENTS_OBJECT,
    MAL_OP_LOAD_ARGUMENT_COUNT,
    MAL_OP_LOAD_ARGUMENT,
    MAL_OP_LOAD_THIS,
    MAL_OP_LOAD_NEW_TARGET,
    MAL_OP_LOAD_CALLEE,
    MAL_OP_LOAD_CAPTURED,
    MAL_OP_LOAD_GLOBAL,
    MAL_OP_LOAD_INTRINSIC,
    MAL_OP_STORE_CAPTURED,
    MAL_OP_STORE_GLOBAL,
    MAL_OP_LOAD_PROPERTY,
    MAL_OP_STORE_PROPERTY,
    MAL_OP_TO_PROPERTY_KEY,
    MAL_OP_STORE_SUPER_PROPERTY,
    MAL_OP_LOAD_SUPER_PROPERTY,
    MAL_OP_LOAD_PROTOTYPE,
    MAL_OP_GET_ITERATOR,
    MAL_OP_GET_ASYNC_ITERATOR,
    MAL_OP_ITERATOR_NEXT,
    MAL_OP_ITERATOR_STEP,
    MAL_OP_ITERATOR_CLOSE,
    MAL_OP_FOR_IN_KEYS,
    MAL_OP_GENERATOR_START,
    MAL_OP_YIELD,
    MAL_OP_ASYNC_START,
    MAL_OP_AWAIT,
    MAL_OP_DELETE_PROPERTY,
    MAL_OP_DEFINE_ACCESSOR,
    MAL_OP_DEFINE_PROPERTY,
    MAL_OP_SET_FUNCTION_NAME,
    MAL_OP_CREATE_PRIVATE_NAME,
    MAL_OP_DEFINE_PRIVATE,
    MAL_OP_LOAD_PRIVATE,
    MAL_OP_STORE_PRIVATE,
    MAL_OP_HAS_PRIVATE,
    MAL_OP_SET_PROTOTYPE,
    MAL_OP_LOAD_UNDECLARED,
    MAL_OP_LOAD_GLOBAL_PROPERTY,
    MAL_OP_STORE_GLOBAL_PROPERTY,
    MAL_OP_CREATE_TEMPLATE_OBJECT,
    MAL_OP_WITH_ENTER,
    MAL_OP_WITH_EXIT,
    MAL_OP_WITH_GET,
    MAL_OP_WITH_RESOLVE_BASE,
    MAL_OP_WITH_SET,
    MAL_OP_IS_EMPTY,
    MAL_OP_THROW_IF_TDZ,
    MAL_OP_REQUIRE_COERCIBLE,
    MAL_OP_CHECK_SUPER_CLASS,
    MAL_OP_CREATE_REST_ARGUMENTS,
    MAL_OP_ARRAY_REST,
    MAL_OP_COPY_DATA_PROPERTIES,
    MAL_OP_MERGE_DATA_PROPERTIES,
    MAL_OP_CALL,
    MAL_OP_CALL_SPREAD,
    MAL_OP_CONSTRUCT,
    MAL_OP_CONSTRUCT_SPREAD,
    MAL_OP_CONSTRUCT_SUPER,
    MAL_OP_BINARY,
    MAL_OP_UNARY,
    // Per-iteration loop environments (CreatePerIterationEnvironment). A loop whose
    // lexical head bindings are captured by closures gets a fresh env per iteration
    // so each closure sees its own binding. ENV_PUSH enters the scope (new env,
    // parent = current); ENV_COPY replaces the current env with a sibling (parent =
    // current->parent) copying the bindings forward for the next iteration; ENV_POP
    // restores the enclosing env on loop exit. All mutate the activation's current
    // capture env (callable->env / the compiled `env` local).
    MAL_OP_ENV_PUSH,
    MAL_OP_ENV_COPY,
    MAL_OP_ENV_POP,
    // Speculative-call-inlining guard: dst = (callee is a function object with the cached
    // function index). Opcode additions are append-only to keep prior numeric values stable
    // for the serialized wire format. Must stay in lockstep with serialize-vm's opcode list.
    MAL_OP_GUARD_FUNCTION_INDEX,
    MAL_OP_INSTANTIATE_LITERAL_TEMPLATE,
    MAL_OP_LOAD_PROPERTY_STATIC,
    MAL_OP_STORE_PROPERTY_STATIC,
    MAL_OP_INIT_GLOBAL_VARS,
    MAL_OP_CREATE_PRIVATE_NAMES,
    MAL_OP_INIT_PRIVATE_FIELDS,
    MAL_OP_TYPEOF_COMPARE,
    MAL_OP_TERMINAL_YIELD,
    MAL_OP_CONSTRUCT_SUPER_EXPLICIT,
    MAL_OP_SET_THIS,
    MAL_OP_LOAD_STATIC_ARGUMENT,
} MalOpcode;

/** Packed literal-template stream tags; mirrored by src/ir.ts. */
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

typedef struct MalInstruction {
    MalOpcode opcode;

    union {
        struct {
            i32 dst, src;
        } move;

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
            // Side data: [count, string-constant indices..., value registers...].
            i32 dst, data_offset, shape_cache_index;
        } create_object_shaped;

        struct {
            i32 dst, length;
        } create_array;

        struct {
            i32 dst, template_offset;
        } instantiate_literal_template;

        struct {
            // Side data: [count, name string indices..., global slots...].
            i32 dst, data_offset;
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

        struct {
            i32 dst, index;
        } load_global;

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

            // Object literal `__proto__:` definitions ignore values that are
            // neither object nor null; class extends wiring always applies.
            bool literal;
        } set_prototype;

        struct {
            i32 dst, name_string_index;
        } load_undeclared;

        struct {
            // Sloppy-mode read of an otherwise-unresolved name: the global object
            // property `name_string_index`, or ReferenceError if it is absent.
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
 * into MalVmDefinition.source_positions). Sorted ascending by start_ip; a frame's
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
    // Non-null only when resuming a suspended compiled coroutine (generator/
    // async): the coroutine object whose saved frame the body restores and whose
    // instruction_pointer selects the resume label. Null on every ordinary call,
    // construct, and program-entry invocation; non-coroutine functions ignore it.
    struct MalGeneratorObject *resume_state
);

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

typedef struct MalFunction {
    i32 name_string_index;
    MalFunctionKind kind;
    i32 parameter_count;

    /** Number of leading raw-argument snapshot instructions run at frame entry. */
    i32 argument_snapshot_count;

    i32 argument_snapshot_plan_count;
    const MalArgumentSnapshotMove *argument_snapshot_plan;

    /** Captured binding slot per mapped argument index; empty for unmapped functions. */
    i32 mapped_argument_count;
    const i32 *mapped_argument_slots;

    /**
     * Function.prototype.length: formal parameters before the first default
     * or rest parameter. parameter_count keeps the full formal count for the
     * calling convention.
     */
    i32 length;

    i32 register_count;
    i32 captured_count;
    bool strict;

    /** Whether any activation can retain supplied arguments after entry. */
    bool needs_arguments;
    /** -1 never retains; INT32_MAX always retains nonempty input; otherwise the
     * largest static index whose absence requires the supplied argument slice. */
    i32 argument_retention_limit;
    bool mapped_arguments;

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

    /**
     * Whether the function owns a `prototype` property. False for methods,
     * getters, setters and arrows (not constructors); true for normal functions,
     * class constructors and generators. Async (non-generator) functions are
     * excluded separately by kind.
     */
    bool has_prototype;

    /** Dense VM-owned inline-cache rows used by this function's property sites. */
    i32 property_ic_count;
    /** Dense VM-owned shape memo rows used by this function's shaped literals. */
    i32 literal_shape_count;
    i32 instruction_count;
    const MalInstruction *instructions;
    i32 instruction_data_count;
    const i32 *instruction_data;

    i32 handler_count;
    const MalExceptionHandler *handlers;

    /**
     * Native-backend entry point, or nullptr when the function is interpreted.
     */
    MalCompiledFunction compiled;

    /**
     * Debug-info (stack traces). file_index points into MalVmDefinition.files;
     * positions is a run-length position table (position_count entries) mapping
     * instruction pointers to source positions. position_count is 0 / positions
     * is nullptr for stripped builds.
     */
    i32 file_index;
    i32 position_count;
    const MalLineEntry *positions;
} MalFunction;

/**
 * One host export's destination: the export/global name and the global slot the
 * installer writes its value into. The engine-neutral installer ABI (below): an
 * installer receives its slot table and matches names to decide what to build
 * where, keeping Node-specific names out of the shared intrinsic tables.
 */
typedef struct MalHostInstallSlot {
    const char *name;
    i32 slot;
} MalHostInstallSlot;

/**
 * Engine-neutral launch context threaded to every host installer: the process
 * command line exactly as `main` received it (argc/argv). A host built-in that
 * needs it — currently only `process`, for `process.argv` / `process.argc` —
 * reads it; the others ignore it. Engine-only embeddings (the test262 runner)
 * and from-wire runs still pass one, but their manifests are empty or carry
 * unresolved installers, so it is never consulted there.
 *
 * Deliberately only the command line, no compiled-entry field: `process.argv[1]`
 * (the "script" slot) is a compile-time artifact the runtime driver knows nothing
 * about — the fixed driver `main` cannot see the entry module baked into
 * `mal_vm_definition`. The `process` installer therefore synthesizes a stable
 * placeholder for that slot itself rather than the driver threading one through
 * here, keeping this ABI to argc/argv alone and engine-neutral.
 */
typedef struct MalHostLaunchContext {
    int argc;
    char **argv;
} MalHostLaunchContext;

/**
 * A host installer fills the given global slots for one `node:*` built-in (or
 * the global `process`). Engine-neutral: it takes the VM, the slot table, and
 * the launch context (the process command line). Defined in the native
 * host-module layer; the compiler emits a direct reference to it for each
 * reached built-in. A null pointer (an unresolved installer in a from-wire
 * definition) is skipped, leaving the slots at their init value (undefined).
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

/** One immutable regular file in a configured executable asset. */
typedef struct MalAssetFile {
    const char *path;
    const u8 *data;
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

typedef struct MalVmDefinition {
    i32 function_count;
    const MalFunction *functions;

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

    i32 global_count;

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

    /** Immutable configured assets baked into this native executable. */
    i32 asset_count;
    const MalAsset *assets;

    /**
     * Host-install manifest (see MalHostInstall). Run by mal_vm_run_host_installs
     * after VM init / host attach and before execution. Zero/null for an ordinary
     * program and for a from-wire definition (whose installer pointers are
     * unresolved), so both run no installers.
     */
    i32 host_install_count;
    const MalHostInstall *host_installs;
} MalVmDefinition;

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
} MalCjsModuleSlot;

/**
 * Heap-allocated captured-variable storage. One node per activation of a
 * function with captured slots; closures keep their defining chain reachable
 * through MalFunctionObject.creation_env. A GC cell (MAL_HEAP_ENV): the
 * collector marks envs reachable via creation_env, interpreter/compiled frame
 * envs, and parent chains, and sweeps the rest. The header must stay first.
 */
typedef struct MalEnv {
    MalHeapHeader header;
    struct MalEnv *parent;
    // Capture-scope id this env satisfies for LOAD/STORE_CAPTURED matching. >= 0
    // is a function index (the activation's own captured slots); < 0 is a synthetic
    // per-iteration loop-scope id (see the ENV_PUSH/COPY/POP ops) that never
    // collides with a function index.
    i32 function_index;
    // Number of MalValue slots; self-describing so the GC can trace any env
    // (including synthetic-id per-iteration envs) without a function lookup.
    i32 slot_count;
    MalValue slots[];
} MalEnv;

// function_index sentinel marking an object environment record: a `with` scope.
// slots[0] holds the with-object. Distinct from any function index (>= 0) and any
// synthetic loop-scope id (small negatives, decremented per loop), so LOAD/STORE_
// CAPTURED never match it — only the WITH_* ops walk the chain looking for it. A
// with scope on the env chain (rather than a frame-local stack) is what lets a
// closure created inside `with` capture the with-object via its creation_env.
#define MAL_ENV_WITH_OBJECT (-2147483647 - 1)

/**
 * A native-backend (compiled) call frame, tracked only for stack traces. The
 * interpreter's frames live in MalVm.frames; compiled functions run on the C
 * stack and are not there, so each compiled invocation records a lightweight
 * frame here (pushed in mal_vm_enter_compiled, popped in mal_vm_leave_compiled).
 * The compiled function writes its current source position into `pos_id` as it
 * runs (statement-granular). `hidden` is set when the function bailed to the
 * interpreter — its interpreted frame then represents it, so a capture skips the
 * duplicate. A capture orders this stack against the interpreted frames by
 * `enter_seq`.
 */
typedef struct MalNativeFrame {
    i32 function_index;
    i32 pos_id;
    u64 enter_seq;
    bool hidden;
} MalNativeFrame;

/** One captured frame: the function and its source position (pos_id, -1 = none). */
typedef struct MalStackFrameRecord {
    i32 function_index;
    i32 pos_id;
} MalStackFrameRecord;

/**
 * A captured stack trace: a flat list of frames (top first), plus — for async
 * stitching — the parent async trace (the awaiting context, null when none). An
 * Error stores one at construction (looked up by id), formatted lazily by the
 * .stack getter; console.trace formats one immediately.
 */
typedef struct MalStackTrace {
    i32 frame_count;
    MalStackFrameRecord *frames;
    struct MalStackTrace *async_parent;
    /** Logical frames to omit and retain when an explicit V8-style capture is read. */
    i32 frame_skip;
    i32 frame_limit;
} MalStackTrace;

// Opaque loaded definition (vm_load.h); the VM retains the ones it splices at
// runtime for `eval` so their arenas outlive the spliced functions.
typedef struct MalLoadedDefinition MalLoadedDefinition;

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
 * the definition's function table.
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
} MalGlobalPropertyCacheEntry;

/** One isolate-wide handle cache for adjacent ordinary Map get/set operations. */
typedef struct MalMapGetSetCacheEntry {
    MalValue collection;
    MalValue canonical_key;
    MalTable *table;
    void *entry;
    u64 table_handle_epoch;
} MalMapGetSetCacheEntry;

typedef struct MalVm {
    const MalVmDefinition *definition;

    /**
     * VM-owned, mutable definition that `definition` points at. Initialized as a
     * shallow copy of the program definition with its function / string-constant /
     * bigint-constant / literal-template tables relocated into growable VM-owned
     * storage (the
     * instruction, handler, and code-unit data the rows point at stays in place —
     * static, or a loader arena). Runtime eval splices more functions, globals,
     * and constants in via mal_vm_splice_definition without disturbing the const
     * `vm->definition->...` access paths. The *_capacity fields size that growth.
     */
    MalVmDefinition live_definition;
    i32 function_capacity;
    i32 string_capacity;
    i32 bigint_capacity;
    i32 literal_template_capacity;
    i32 global_capacity;

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

    /**
     * Canonical property atom for each definition string constant. This keeps
     * static property instructions and shaped literals identity-stable even
     * when eval splices a duplicate string constant from another definition.
     */
    struct MalString **string_constant_atoms;

    /**
     * Megamorphic shaped-property stub cache: a shared, direct-mapped (shape, key)
     * -> slot/attributes table probed when a load or store site's inline N-way
     * cache has gone megamorphic. Allocated at VM init, zero-initialized (empty).
     * See MalPropertyStubEntry / mal_stub_hash in vm_ops.h.
     */
    struct MalPropertyStubEntry *property_stub;

    /** Shared final shape for CreateIterResultObject's `{ value, done }` layout. */
    struct MalShape *iterator_result_shape;

    /** Canonical RegExp instance layout: the sole shaped `lastIndex` property. */
    struct MalShape *regexp_instance_shape;

    /** Shared final named-property layouts for RegExp match/indices arrays. */
    struct MalShape *regexp_result_shape;
    struct MalShape *regexp_result_indices_shape;
    struct MalShape *regexp_indices_shape;

    /** Shared EventEmitter plus `{ encrypted, readable, writable }` socket layout. */
    struct MalShape *node_http_socket_shape;

    /** Canonical node:http IncomingMessage layout before/after dispatch fields. */
    struct MalShape *node_http_readable_state_shape;
    struct MalShape *node_http_incoming_message_source_shape;
    struct MalShape *node_http_incoming_message_final_shape;

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
    struct MalShape *node_http_server_response_parent_shape;
    struct MalShape *node_http_server_response_constructor_shape;
    struct MalShape *node_http_server_response_dispatch_shape;

    /** Bounded plain interpreted-function call cache; see vm_ops.c. */
    MalInterpCallCacheEntry *interp_call_cache;

    /** Bounded cache indexed by definition string index; see vm_ops.c. */
    MalGlobalPropertyCacheEntry *global_property_cache;

    /** Ordinary Map.prototype.get -> set cache; direct collection helpers bypass it. */
    MalMapGetSetCacheEntry map_get_set_cache;

    MalHeap heap;
    /** Per-isolate collector working state (grey worklist, weak lists, remembered
     * set, stats, and — concurrent build — the SATB buffer + incremental-cycle
     * state). Allocated by mal_gc_init, freed by mal_gc_state_free. See gc.c. */
    MalGcState *gc;
#if MAL_REALMS
    /** Isolate-wide private symbols backing Error internal slots. Shared by every
     * realm and rooted directly because a realm may temporarily hold no errors. */
    MalValue error_data_marker;
    MalValue error_stack_marker;
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
    MalCompletion completion;
    /** Preallocated, permanently rooted exception used when allocation cannot continue. */
    MalValue allocation_error;

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
     * `loaded_defs` retains every definition spliced at runtime (the baked
     * compiler plus each eval'd snippet): the spliced functions reference their
     * instruction data in-place in these arenas, freed as a unit at teardown.
     */
    MalValue compiler_fn;
    bool compiler_installed;
    MalLoadedDefinition **loaded_defs;
    i32 loaded_def_count;
    i32 loaded_def_capacity;

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

    /**
     * Symbol.for registry: string key -> symbol value (inline payload).
     */
    MalTable *symbol_registry;

    /**
     * Canonical property-name strings, including compiler constants, computed
     * keys, and the fixed vocabulary handed out by mal_intrinsic_ascii. Keyed by
     * content and strongly retained for the VM lifetime so shapes, dictionaries,
     * and ICs can converge on stable pointer identity.
     */
    MalTable *atoms;

    /**
     * Direct pointers for measured request-hot atom names. The atom table owns
     * and roots the strings; this array only removes repeated content probes.
     */
    MalString *hot_intrinsic_keys[MAL_HOT_KEY_COUNT];

    /**
     * Direct-mapped fallback for repeated ASCII names outside the curated hot
     * vocabulary. Entries are content-validated; the atom table owns the strings.
     */
    MalAsciiAtomCacheEntry ascii_atom_cache[MAL_ASCII_ATOM_CACHE_CAPACITY];

    /**
     * Lazily interned Latin-1 one-code-unit strings. The atom table owns and roots
     * each populated entry; direct indexing removes allocation and content probes
     * from character extraction, iteration, RegExp, and string-spread paths.
     */
    MalString *code_unit_strings[256];

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

    /**
     * Nesting depth of native-backend (MalFunction.compiled) invocations.
     * Interpreted recursion is bounded by the value stack, but a compiled
     * function calling another runs on the real C stack with no such window, so
     * deep compiled recursion (e.g. non-tail-recursive functions) is bounded
     * here instead — exceeding MAL_NATIVE_CALL_DEPTH_LIMIT throws a RangeError
     * rather than overflowing the C stack.
     */
    i32 native_call_depth;

    /** Active nested Proxy meta-object dispatches; bounds recursive Proxy chains. */
    i32 proxy_dispatch_depth;

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

    /**
     * Native (compiled-backend) call frames, for stack traces — see
     * MalNativeFrame. Pushed/popped around every compiled invocation. A growable
     * array; capacity persists across the VM lifetime.
     */
    MalNativeFrame *native_frames;
    i32 native_frame_count;
    i32 native_frame_capacity;

    /**
     * Monotonic frame-entry counter. Each interpreted frame (push / generator
     * resume) and native frame records the value at entry, giving a total order
     * a stack-trace capture uses to interleave the two frame stacks.
     */
    u64 frame_seq;

    /**
     * Captured stack traces, indexed by id. An Error stores its capture's id (an
     * i32) under a private property; the .stack getter looks the trace up here
     * and formats it lazily. Growable, never compacted — like the symbol-registry
     * and unhandled-rejection roots it leaks until VM teardown. Freed in mal_vm_free.
     */
    MalStackTrace **captured_traces;
    i32 captured_trace_count;
    i32 captured_trace_capacity;

    /**
     * CommonJS module registry, sized to definition->cjs_module_count (null when
     * the program has none). Each slot caches a module's `module` object after
     * (and during) its first require, so require() returns `module.exports` live.
     */
    MalCjsModuleSlot *cjs_registry;

    /**
     * Fibers (see docs/roadmaps/isolate-reactor.md). This MalVm is the *isolate*: it owns the
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
} MalVm;

/** Drop the ordinary Map get/set cache without retaining its collection or key. */
void mal_vm_invalidate_map_get_set_cache(MalVm *vm);

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
    mal_gc_root(&roots->receiver_span, roots->receiver_slots, 3);
    // Cast away const: the collector only reads (shades) these slots.
    mal_gc_root(&roots->args_span, (MalValue *) args, arg_count);
}

static inline void mal_gc_callee_roots_end(MalCalleeRoots *roots) {
    mal_gc_unroot(&roots->args_span);
    mal_gc_unroot(&roots->receiver_span);
}

/**
 * Cap on nested compiled-function calls. Each level holds a real C frame (the
 * compiled function plus the dispatch helper), so this is kept well below what
 * an 8 MiB stack tolerates while staying far deeper than any realistic
 * non-tail recursion. Tail self-calls compile to in-place loops and do not
 * count against it.
 */
#define MAL_NATIVE_CALL_DEPTH_LIMIT 6000

/**
 * Enter a compiled-function invocation: throws a RangeError and returns false
 * when the native call depth limit would be exceeded, otherwise increments the
 * depth and returns true. Each successful enter must be paired with a leave.
 */
bool mal_vm_enter_compiled(MalVm *vm, i32 function_index);

/** Leave a compiled-function invocation, balancing a prior enter. */
void mal_vm_leave_compiled(MalVm *vm);

/**
 * Mark the top native frame hidden because the compiled function is bailing to
 * the interpreter (the interpreted frame represents it). Keeps a capture from
 * showing the frame twice. Emitted by the native backend at its unbox bail.
 */
void mal_vm_compiled_bailed(MalVm *vm);

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
     * Resolved (cached) pointer into vm->live_definition.functions, used by the
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
     * generator/async frame resumed). Stack-trace capture merges interpreted
     * frames with native compiled frames by this order. See mal_vm_capture_stack.
     */
    u64 enter_seq;

    /**
     * Stack of active `with` objects for this frame (innermost last), grown
     * lazily by WITH_ENTER and shrunk by WITH_EXIT. Null until the frame first
     * enters a `with`. Freed on frame teardown.
     */
    MalValue *with_objects;

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
    i32 return_register;
    i32 caller_frame_index;
    i32 with_count;
    i32 with_capacity;

    /**
     * Construct frames replace non-object return values with this_value.
     */
    bool is_construct;
} MalVmFrame;

typedef MalVmFrame MalCallable;

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition);

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
void mal_vm_free_coroutine_buffer_pool(MalVm *vm);

/**
 * Run the definition's host-install manifest: for each reached `node:*` built-in
 * / `process`, call its installer to fill the export global slots. Call after
 * mal_vm_init (and, for a host program, after mal_host_attach) and before running
 * the entry — the compiled program reads those slots via LOAD_GLOBAL. `launch`
 * carries the process command line for the installers that need it (`process`);
 * pass the driver's own argc/argv. A no-op when the manifest is empty (every
 * ordinary program) or an installer is unresolved (a from-wire definition), so it
 * is safe to call unconditionally.
 */
static inline void mal_vm_run_host_installs(MalVm *vm, const MalHostLaunchContext *launch) {
    const MalVmDefinition *definition = vm->definition;
    for (i32 i = 0; i < definition->host_install_count; i++) {
        const MalHostInstall *install = &definition->host_installs[i];
        if (install->installer != nullptr) {
            install->installer(vm, install->slots, install->slot_count, launch);
        }
    }
}

void mal_vm_free(MalVm *vm);

/**
 * Append a loaded definition's functions, globals, and string/bigint constants
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
i32 mal_vm_splice_definition(MalVm *vm, const MalVmDefinition *loaded);

/** Allocate a captured-slot environment node (parent chain + `count` slots
 * initialized to undefined) as a GC cell. Used by both the interpreter and
 * compiled code to build a function's per-activation env. May trigger a
 * collection: the caller must have rooted `parent` and any live frame slots
 * before calling (the compiled prologue publishes its root frame first). */
MalEnv *mal_env_new(MalVm *vm, MalEnv *parent, i32 function_index, i32 count);

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

/**
 * Resume a suspended generator: reattach its frame, deliver the sent value to
 * the pending yield's resume register, and run until it yields, returns, or
 * throws. Afterwards the generator state distinguishes a yield (SUSPENDED_YIELD,
 * with yielded_value set) from completion (COMPLETED, with the return value in
 * vm->completion.value); a throw leaves vm->completion as THROW and marks the
 * generator COMPLETED.
 */
void mal_vm_resume_generator(MalVm *vm, MalGeneratorObject *generator, MalValue sent_value, i32 resume_mode);

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Polymorphic call-cache ways: a site accumulates up to this many distinct compiled
 * function indices or exact native callees before overflow stays on full dispatch. */
#define MAL_CALL_CACHE_WAYS 4u

/**
 * Polymorphic call-site cache for the native backend. A CALL site whose callee is a plain
 * compiled user function (not bound / native / proxy / interpreted) caches its function index.
 * A later ordinary compiled closure with that index skips the full dispatch chain in
 * mal_vm_call_value, but the body, creation environment, realm, callee, and this binding are
 * all re-derived from the current closure. Native ways remain exact-identity callback caches.
 * A zero-initialized cache has count 0, so the first call takes the slow path and fills a way.
 *
 * Exact `callee` guards are unrooted. `heap_identity` prevents reuse across VM lifetimes and
 * `epoch` prevents reuse after a sweep in one heap. Compiled family probes do not dereference
 * cached pointers and therefore remain valid hints across either boundary.
 */
typedef struct MalCallCache {
    MalValue callee[MAL_CALL_CACHE_WAYS];
    i32 function_index[MAL_CALL_CACHE_WAYS];
    u8 kind[MAL_CALL_CACHE_WAYS];
    u32 count;
    u32 epoch;
    u64 heap_identity;
} MalCallCache;

#define MAL_CALL_CACHE_COMPILED 0u
#define MAL_CALL_CACHE_NATIVE 1u

MalCompletion mal_vm_call_cached(
    MalVm *vm,
    MalCallCache *cc,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Guarded direct script-function call for native sites with an exact static target.
 * A matching live plain closure bypasses MalCallCache and generic dispatch while
 * retaining its own environment, realm, identity, and this binding. Guard misses
 * use the ordinary cached call path.
 */
MalCompletion mal_vm_call_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    i32 expected_function_index,
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
    MalCallCache *fallback_cache,
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

/**
 * mal_vm_construct_value with an explicit new.target (whose `.prototype`
 * parents the new instance), implementing the spec [[Construct]](args, newTarget).
 * Backs Reflect.construct; mal_vm_construct_value forwards with newTarget = callee.
 */
MalCompletion mal_vm_construct_value_with_target(MalVm *vm, MalValue callee, const MalValue *args, i32 arg_count, MalValue new_target);

/**
 * Resolve the display name of a callable, or null for non-callables.
 */
MalString *mal_vm_callable_name(MalVm *vm, MalValue callee);
