#pragma once

#include "intrinsics.h"

typedef enum MalDisposeKind : u8 {
    MAL_DISPOSE_SYNC,
    MAL_DISPOSE_ASYNC,
    MAL_DISPOSE_ASYNC_FROM_SYNC,
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
    bool has_async_resource;
    bool async_has_error;
    bool async_needs_await;
    bool async_has_awaited;
    MalValue async_error;
    MalValue async_result_promise;
    MalValue async_realm_anchor;
} MalDisposableStackObject;

void mal_builtin_disposable_stack_install(MalVm *vm);

void mal_disposable_stack_async_resume(
    MalVm *vm,
    MalValue stack,
    MalValue result_promise,
    MalValue realm_anchor,
    bool is_reject,
    MalValue argument
);
