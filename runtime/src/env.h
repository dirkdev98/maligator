#pragma once

#include "./defaults.h"

typedef struct MalEnv MalEnv;

struct MalEnv {
    MalEnv* parent;
};
