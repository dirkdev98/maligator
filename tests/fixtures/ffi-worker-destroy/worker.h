#ifndef WORKER_H
#define WORKER_H
#include <stdbool.h>

typedef struct WorkerResource WorkerResource;
typedef struct RetryResource RetryResource;
typedef struct ReusedResource ReusedResource;
WorkerResource *worker_open(int value);
int worker_value(WorkerResource *resource);
int worker_close(WorkerResource *resource);
void worker_watch(WorkerResource *resource, void (*callback)(int, void *), void *data, void (*release)(void *));
void worker_watch_direct(WorkerResource *resource, void (*callback)(int, void *), void *data, void (*release)(void *));
ReusedResource *worker_reused_open(int value);
ReusedResource *worker_reused_alias(void);
int worker_reused_value(ReusedResource *resource);
void worker_reused_close(ReusedResource *resource);
void worker_reused_listen(ReusedResource *resource, void (*callback)(ReusedResource *));
void worker_reused_emit(ReusedResource *resource);
RetryResource *worker_retry_open(int attempts);
int worker_retry_left(RetryResource *resource);
bool worker_retry_close(RetryResource *resource);
int worker_live(void);
void worker_hold(void);
void worker_unblock_later(void);
void worker_wait_started(void);
void worker_wait_finished(void);
void worker_expect_clean_shutdown(void);
#endif
