#pragma once

#include "./defaults.h"
#include "heap.h"
#include "intrinsics.h"
#include "value.h"

typedef enum MalOpcode {
    MAL_OP_MOVE,
    MAL_OP_RETURN,
    MAL_OP_JUMP_IF,
    MAL_OP_JUMP,
    MAL_OP_CREATE_NUMBER,
    MAL_OP_CREATE_BOOLEAN,
    MAL_OP_CREATE_STRING,
    MAL_OP_CREATE_OBJECT,
    MAL_OP_CREATE_ARRAY,
    MAL_OP_CREATE_UNDEFINED,
    MAL_OP_CREATE_FUNCTION,
    MAL_OP_CREATE_ARGUMENTS_OBJECT,
    MAL_OP_LOAD_CAPTURED,
    MAL_OP_LOAD_GLOBAL,
    MAL_OP_LOAD_INTRINSIC,
    MAL_OP_STORE_CAPTURED,
    MAL_OP_STORE_GLOBAL,
    MAL_OP_LOAD_PROPERTY,
    MAL_OP_STORE_PROPERTY,
    MAL_OP_CALL,
    MAL_OP_BINARY,
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
} MalBinaryOp;

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
            i32 cond, target_ip;
        } jump_if;

        struct {
            i32 target_ip;
        } jump;

        struct {
            i32 dst, value;
        } create_number;

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
            i32 dst, function_index;
        } create_function;

        struct {
            i32 dst;
        } create_arguments_object;

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

        struct {
            i32 dst, callee, this_value, argument_count;
            const i32 *arguments;
        } call;

        struct {
            i32 dst, left, right;
            MalBinaryOp op;
        } binary;
    } as;
} MalInstruction;

typedef struct MalFunction {
    i32 parameter_count;
    i32 register_count;
    i32 captured_count;
    bool strict;

    i32 instruction_count;
    const MalInstruction *instructions;
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

typedef struct MalVm {
    const MalVmDefinition *definition;

    MalHeap heap;
    MalValue *globals;
    MalValue intrinsics[MAL_INTRINSIC_COUNT];
    MalCompletion completion;

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
