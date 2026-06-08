#pragma once

#include "./defaults.h"
#include "heap.h"
#include "intrinsics.h"
#include "value.h"

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
    MAL_OP_CREATE_OBJECT,
    MAL_OP_CREATE_ARRAY,
    MAL_OP_CREATE_UNDEFINED,
    MAL_OP_CREATE_NULL,
    MAL_OP_CREATE_FUNCTION,
    MAL_OP_CREATE_ARGUMENTS_OBJECT,
    MAL_OP_LOAD_THIS,
    MAL_OP_LOAD_CAPTURED,
    MAL_OP_LOAD_GLOBAL,
    MAL_OP_LOAD_INTRINSIC,
    MAL_OP_STORE_CAPTURED,
    MAL_OP_STORE_GLOBAL,
    MAL_OP_LOAD_PROPERTY,
    MAL_OP_STORE_PROPERTY,
    MAL_OP_STORE_SUPER_PROPERTY,
    MAL_OP_LOAD_PROTOTYPE,
    MAL_OP_GET_ITERATOR,
    MAL_OP_ITERATOR_STEP,
    MAL_OP_ITERATOR_CLOSE,
    MAL_OP_DELETE_PROPERTY,
    MAL_OP_DEFINE_ACCESSOR,
    MAL_OP_DEFINE_PROPERTY,
    MAL_OP_SET_PROTOTYPE,
    MAL_OP_LOAD_UNDECLARED,
    MAL_OP_REQUIRE_COERCIBLE,
    MAL_OP_CREATE_REST_ARGUMENTS,
    MAL_OP_ARRAY_REST,
    MAL_OP_COPY_DATA_PROPERTIES,
    MAL_OP_MERGE_DATA_PROPERTIES,
    MAL_OP_CALL,
    MAL_OP_CALL_SPREAD,
    MAL_OP_CONSTRUCT,
    MAL_OP_CONSTRUCT_SPREAD,
    MAL_OP_BINARY,
    MAL_OP_UNARY,
} MalOpcode;

typedef enum MalBinaryOp {
    MAL_BIN_ADD,
    MAL_BIN_SUB,
    MAL_BIN_MUL,
    MAL_BIN_DIV,
    MAL_BIN_REM,
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
} MalUnaryOp;

typedef enum MalCompletionKind {
    MAL_COMPLETION_NORMAL,
    MAL_COMPLETION_RETURN,
    MAL_COMPLETION_THROW,
} MalCompletionKind;

typedef struct MalCompletion {
    MalCompletionKind kind;
    MalValue value;
} MalCompletion;

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
            f64 value;
        } create_f64;

        struct {
            i32 dst, value;
        } create_boolean;

        struct {
            i32 dst, string_index;
        } create_string;

        struct {
            i32 dst;
        } create_object;

        struct {
            i32 dst, length;
        } create_array;

        struct {
            i32 dst;
        } create_undefined;

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
        } load_this;

        struct {
            i32 dst, owner_function_index, index;
        } load_captured;

        struct {
            i32 dst, index;
        } load_global;

        struct {
            i32 dst, intrinsic;
        } load_intrinsic;

        struct {
            i32 src, owner_function_index, index;
        } store_captured;

        struct {
            i32 src, index;
        } store_global;

        struct {
            i32 dst, object, key;
        } load_property;

        struct {
            i32 object, key, value;
        } store_property;

        /**
         * super.x = v: the property lookup walks object (the super base)
         * while the write applies to receiver (this), per
         * OrdinarySetWithOwnDescriptor.
         */
        struct {
            i32 object, key, value, receiver;
        } store_super_property;

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
         * Spec IteratorStep + value read: the step value and a done boolean.
         */
        struct {
            i32 value_dst, done_dst, iterator, next;
        } iterator_step;

        /**
         * Spec IteratorClose for abrupt loop exits (break/return/throw).
         */
        struct {
            i32 iterator;
        } iterator_close;

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
        } define_property;

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
            i32 src;
        } require_coercible;

        struct {
            i32 dst, start_index;
        } create_rest_arguments;

        struct {
            i32 dst, src, start_index;
        } array_rest;

        struct {
            i32 dst, src, excluded_count;
            const i32 *excluded;
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
            i32 dst, callee, this_value, argument_count;
            const i32 *arguments;
        } call;

        struct {
            i32 dst, callee, argument_count;
            const i32 *arguments;
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
            i32 dst, left, right;
            MalBinaryOp op;
        } binary;

        struct {
            i32 dst, src;
            MalUnaryOp op;
        } unary;
    } as;
} MalInstruction;

/**
 * Statically known protected instruction range. While the instruction pointer
 * is inside [start_ip, end_ip), a throw unwinds to handler_ip.
 */
typedef struct MalExceptionHandler {
    i32 start_ip;
    i32 end_ip;
    i32 handler_ip;
} MalExceptionHandler;

typedef struct MalFunction {
    i32 name_string_index;
    i32 parameter_count;

    /**
     * Function.prototype.length: formal parameters before the first default
     * or rest parameter. parameter_count keeps the full formal count for the
     * calling convention.
     */
    i32 length;

    i32 register_count;
    i32 captured_count;
    bool strict;

    i32 instruction_count;
    const MalInstruction *instructions;

    i32 handler_count;
    const MalExceptionHandler *handlers;
} MalFunction;

typedef struct MalStringConstant {
    usize length;
    const c16 *code_units;
} MalStringConstant;

typedef struct MalVmDefinition {
    i32 function_count;
    const MalFunction *functions;

    i32 string_constant_count;
    const MalStringConstant *string_constants;

    i32 global_count;
} MalVmDefinition;

/**
 * Heap-allocated captured-variable storage. One node per activation of a
 * function with captured slots; closures keep their defining chain reachable
 * through MalFunctionObject.creation_env. There is no GC yet, so nodes leak
 * with the rest of the heap.
 */
typedef struct MalEnv {
    struct MalEnv *parent;
    i32 function_index;
    MalValue slots[];
} MalEnv;

typedef struct MalVm {
    const MalVmDefinition *definition;

    MalHeap heap;
    MalValue *globals;
    MalValue intrinsics[MAL_INTRINSIC_COUNT];
    MalCompletion completion;

    /**
     * Symbol.for registry: string key -> symbol value (inline payload).
     */
    MalTable *symbol_registry;

    struct MalVmFrame *frames;
    i32 frame_count;
    i32 frame_capacity;
} MalVm;

typedef struct MalVmFrame {
    MalVm *vm;
    const MalFunction *function;
    MalValue *registers;
    MalValue *arguments;
    i32 argument_count;
    MalValue this_value;
    MalValue arguments_object;

    /**
     * Own captured-slot node when the function has captured slots, otherwise
     * the callee's creation environment passed through for chain walks.
     */
    MalEnv *env;

    /**
     * Construct frames replace non-object return values with this_value.
     */
    bool is_construct;

    i32 instruction_pointer;
    i32 return_register;
    i32 caller_frame_index;
} MalVmFrame;

typedef MalVmFrame MalCallable;

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition);

void mal_vm_free(MalVm *vm);

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index);

void mal_vm_free_callable(MalCallable *callable);

void mal_vm_push_function_frame(
    MalVm *vm,
    i32 function_index,
    MalEnv *creation_env,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    i32 return_register,
    i32 caller_frame_index
);

void mal_vm_run(MalVm *vm, MalCallable *callable);

MalCompletion mal_vm_call_value(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Resolve the display name of a callable, or null for non-callables.
 */
MalString *mal_vm_callable_name(MalVm *vm, MalValue callee);

/**
 * Resolve the parameter count of a callable.
 */
i32 mal_vm_callable_length(MalVm *vm, MalValue callee);
