#pragma once

#include "./defaults.h"
#include "gc.h"
#include "heap.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * Per-AsyncLocalStorage mutable identity. Context frames retain this cell, not
 * the public wrapper object, so receiver checks and lookups are pointer-fast.
 */
typedef struct MalAsyncLocalStorageState {
    MalHeapHeader header;
    u64 generation;
    MalValue default_value;
    MalValue name;
    bool enabled;
} MalAsyncLocalStorageState;

/** Immutable persistent-map entry for one AsyncLocalStorage store binding. */
typedef struct MalAsyncContext {
    MalHeapHeader header;
    struct MalAsyncContext *parent;
    MalAsyncLocalStorageState *storage;
    MalValue store;
    u64 generation;
    bool has_store;
} MalAsyncContext;

/** Captured context carried by AsyncResource. */
typedef struct MalAsyncResourceState {
    MalHeapHeader header;
    MalAsyncContext *context;
} MalAsyncResourceState;

/** Mutable private state for the disposable object returned by withScope(). */
typedef struct MalAsyncRunScopeState {
    MalHeapHeader header;
    MalAsyncLocalStorageState *storage;
    MalValue previous_store;
    bool disposed;
} MalAsyncRunScopeState;

static_assert(
    sizeof(MalAsyncLocalStorageState) == 40,
    "AsyncLocalStorage identity must remain a 40-byte GC cell");
static_assert(
    sizeof(MalAsyncContext) == (sizeof(void *) == 8 ? 48 : 40),
    "AsyncLocalStorage context must retain its pointer-width-specific immutable GC cell layout");
static_assert(
    sizeof(MalAsyncResourceState) == (sizeof(void *) == 8 ? 16 : 8),
    "AsyncResource state must retain its pointer-width-specific GC cell layout");
static_assert(
    sizeof(MalAsyncRunScopeState) == (sizeof(void *) == 8 ? 32 : 24),
    "AsyncLocalStorage RunScope state must retain its pointer-width-specific GC cell layout");

/**
 * A scoped context switch. Both sides are rooted through the existing C root-span
 * chain, so a collection inside the callback cannot reclaim the context restored
 * on exit. Root spans are already fiber-local across scheduler switches.
 */
typedef struct MalAsyncContextScope {
    MalAsyncContext *previous;
    MalValue roots[2];
    MalRootSpan root;
} MalAsyncContextScope;

MalAsyncLocalStorageState *mal_async_local_storage_state_new(MalVm *vm);
MalAsyncResourceState *mal_async_resource_state_new(MalVm *vm);
MalAsyncRunScopeState *mal_async_run_scope_state_new(
    MalVm *vm,
    MalAsyncLocalStorageState *storage,
    MalValue previous_store
);

MalValue mal_async_internal_value(MalHeapHeader *cell);
MalAsyncLocalStorageState *mal_async_local_storage_state_from_value(MalValue value);
MalAsyncResourceState *mal_async_resource_state_from_value(MalValue value);
MalAsyncRunScopeState *mal_async_run_scope_state_from_value(MalValue value);

MalAsyncContext *mal_async_context_capture(const MalVm *vm);
MalAsyncContext *mal_async_context_push(
    MalVm *vm,
    MalAsyncLocalStorageState *storage,
    MalValue store,
    bool has_store
);
bool mal_async_context_lookup(
    const MalVm *vm,
    const MalAsyncLocalStorageState *storage,
    MalValue *store
);

void mal_async_context_scope_enter(
    MalVm *vm, MalAsyncContextScope *scope, MalAsyncContext *context);
void mal_async_context_scope_exit(MalVm *vm, MalAsyncContextScope *scope);

/**
 * Return a callable that preserves the caller-provided `this` and arguments but
 * runs under `context`. Host APIs use this when a callback is stored inside an
 * EventEmitter listener list whose eventual emit happens under a resource-wide
 * context rather than the callback registration context.
 */
MalValue mal_async_context_bind_callback(
    MalVm *vm, MalValue callback, MalAsyncContext *context);
