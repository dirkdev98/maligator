#pragma once

#include "./defaults.h"

typedef enum MalExecutorClass {
    MAL_EXECUTOR_IO,
    MAL_EXECUTOR_DNS,
    MAL_EXECUTOR_CRYPTO,
    MAL_EXECUTOR_GC,
    MAL_EXECUTOR_CLASS_COUNT,
} MalExecutorClass;

typedef struct MalExecutorClient {
    struct MalExecutorClientState *state;
} MalExecutorClient;

typedef void (*MalExecutorRun)(void *data);
typedef void (*MalExecutorDiscard)(void *data);

// Payloads contain no language values; collector jobs bind their own heap context explicitly.
bool mal_executor_client_init(MalExecutorClient *client, MalExecutorClass kind,
    usize concurrency, usize queue_capacity);
// Success owns the payload through run or discard; must_run jobs survive client teardown.
bool mal_executor_submit(MalExecutorClient *client, MalExecutorRun run,
    MalExecutorDiscard discard, void *data, usize queued_bytes, usize working_bytes, bool must_run);
// Cancellation removes only queued work and returns its payload to the caller.
bool mal_executor_cancel(MalExecutorClient *client, void *data);
// Teardown discards ordinary queued work and drains accepted cleanup jobs on native workers.
void mal_executor_client_shutdown(MalExecutorClient *client);
void mal_executor_client_free(MalExecutorClient *client);
usize mal_executor_client_workers(MalExecutorClient *client);
usize mal_executor_client_queued(MalExecutorClient *client);
