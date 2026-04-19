#pragma once

#include "./defaults.h"
#include "value.h"

typedef enum MalOpcode {
    MAL_OP_MOVE,
    MAL_OP_RETURN,
    MAL_OP_JUMP_IF,
    MAL_OP_JUMP,
    MAL_OP_CREATE_NUMBER,
    MAL_OP_CREATE_UNDEFINED,
    MAL_OP_CREATE_FUNCTION,
    MAL_OP_LOAD_CAPTURED,
    MAL_OP_LOAD_GLOBAL,
    MAL_OP_STORE_CAPTURED,
    MAL_OP_STORE_GLOBAL,
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
} MalBinaryOp;

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
            i32 dst;
        } create_undefined;

        struct {
            i32 dst, function_index;
        } create_function;

        struct {
            i32 dst, owner_function_index, index;
        } load_captured;

        struct {
            i32 dst, index;
        } load_global;

        struct {
            i32 src, owner_function_index, index;
        } store_captured;

        struct {
            i32 src, index;
        } store_global;

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

    i32 instruction_count;
    const MalInstruction *instructions;
} MalFunction;

typedef struct MalVmDefinition {
    i32 function_count;
    const MalFunction *functions;

    i32 global_count;
} MalVmDefinition;

typedef struct MalVm {
    const MalVmDefinition *definition;

    MalValue *globals;

    // TODO: We probably want a callstack here, instead of recursing on the C callstack.
} MalVm;

typedef struct MalCallable {
    MalVm *vm;
    const MalFunction *function;
    MalValue *registers;

    i32 instruction_pointer;
} MalCallable;

void mal_vm_init(MalVm *vm, const MalVmDefinition *definition);

MalCallable *mal_vm_create_callable(MalVm *vm, i32 function_index);

void mal_vm_free_callable(MalCallable *callable);

void mal_vm_run(MalVm *vm, MalCallable *callable);
