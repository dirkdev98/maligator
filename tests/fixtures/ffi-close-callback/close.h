#ifndef FFI_CLOSE_H
#define FFI_CLOSE_H
#include <stddef.h>
typedef struct CloseBase { int tag; } CloseBase;
typedef struct CloseState {
    CloseBase base;
    unsigned char *bytes;
    size_t length;
} CloseState;
typedef struct CloseOther { int tag; } CloseOther;
void close_now(CloseBase *handle, void (*done)(CloseBase *));
void close_later(CloseBase *handle, void (*done)(CloseBase *));
void close_foreign(CloseBase *handle, void (*done)(CloseBase *));
void close_after_vm(CloseBase *handle, void (*done)(CloseBase *));
void close_data(CloseBase *handle, void (*done)(void *, int), void *data);
void close_flush(void);
int close_read(CloseBase *handle);
void close_visit(CloseBase *handle, void (*visit)(CloseBase *, void *), void *data);
void close_lend(void (*visit)(CloseBase *, void *), void *data);
int close_status(CloseBase *handle, void (*done)(CloseBase *));
void close_wrong(CloseBase *handle, void (*done)(CloseOther *));
void close_missing(CloseBase *handle, void (*done)(int));
CloseBase *close_reused_open(void);
void close_reused_set(CloseBase *handle, void (*callback)(CloseBase *));
void close_reused_emit(void);
void close_reused_after_vm(CloseBase *handle, void (*done)(CloseBase *));
void close_with_error(CloseBase *handle, void (*before)(void *), void *data, void (*done)(CloseBase *));
void close_and_listen(CloseBase *handle, void (*done)(CloseBase *), void (*listener)(CloseBase *));
void close_block(void);
void close_wait_blocked(void);
void close_unblock(void);
void close_view_set(CloseState *handle, void (*callback)(CloseBase *));
void close_expect_worker(void);
void close_worker_wait_started(void);
void close_unblock_later(void);
void close_worker_after_vm(CloseBase *handle, void (*done)(CloseBase *));
#endif
