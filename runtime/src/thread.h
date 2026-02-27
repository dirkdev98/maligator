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


typedef struct MalThread {
    MalValue registers[256];
} MalThread;

