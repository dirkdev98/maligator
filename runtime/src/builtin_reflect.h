#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Install the %Reflect% namespace object (the spec's well-known Reflect object)
 * and its method properties. Reflect's operations are thin wrappers over the
 * same internal methods the operators and Object.* builtins use, so they share
 * one source of truth for [[Get]]/[[Set]]/[[Delete]]/[[DefineOwnProperty]]/etc.
 */
void mal_builtin_reflect_install(MalVm *vm);
