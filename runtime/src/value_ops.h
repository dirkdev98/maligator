#pragma once

#include "./defaults.h"
#include "value.h"
#include "env.h"
#include "thread.h"

MalResult mal_ops_add(MalThread *thread, MalEnv *env, MalValue *out, MalValue left, MalValue right);
