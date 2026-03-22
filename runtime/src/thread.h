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
#define MAL_RESULT_RETURN(result, value) \
    thread->return_result = result;      \
    thread->return_value = value;      \
    return;

typedef struct MalThread {
    MalValue registers[MAL_REG_CAP];
    MalValue return_value;
    MalResult return_result;
} MalThread;
