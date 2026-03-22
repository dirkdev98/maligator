#pragma once

#include "./defaults.h"
#include "value.h"

typedef enum MalResult {
    MAL_NORMAL = 0,

    // Abrupt completions

    MAL_BREAK = 1,
    MAL_CONTINUE = 2,
    MAL_RETURN = 4,
    MAL_THROW = 8
} MalResult;

#define MAL_REG_CAP 2048
#define MAL_RESULT_RETURN(result, value)  do {  \
    thread->return_result = result;             \
    thread->return_value = value;               \
    return; } while(0);

typedef struct MalThread {
    i32 register_base;

    MalValue return_value;
    MalResult return_result;

    MalValue registers[MAL_REG_CAP];
} MalThread;

void mal_thread_init(MalThread *thread);

/**
 * Offset the register_base by caller_reg_count, and reset the next callee_reg_count slots to undefined.
 */
void mal_thread_base_push(MalThread *thread, i32 caller_reg_count, i32 callee_reg_count);

void mal_thread_base_pop(MalThread *thread, i32 caller_reg_count);

MalValue mal_thread_get(MalThread *thread, i32 register_index);

void mal_thread_set(MalThread *thread, i32 register_index, MalValue value);
