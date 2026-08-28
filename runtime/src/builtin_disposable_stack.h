#pragma once

#include "intrinsics.h"

typedef enum MalDisposeKind : u8 {
    MAL_DISPOSE_SYNC,
    MAL_DISPOSE_ASYNC,
} MalDisposeKind;

typedef struct MalDisposableResource {
    MalValue resource_value;
    MalValue dispose_method;
    MalDisposeKind kind;
} MalDisposableResource;

typedef struct MalDisposableStackObject {
    MalObject object;
    MalDisposableResource *resources;
    usize resource_count;
    usize resource_capacity;
    bool disposed;
    bool async;
} MalDisposableStackObject;

void mal_builtin_disposable_stack_install(MalVm *vm);
