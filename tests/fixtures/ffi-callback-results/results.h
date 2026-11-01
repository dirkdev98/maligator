#ifndef FFI_CALLBACK_RESULTS_H
#define FFI_CALLBACK_RESULTS_H
#include <stddef.h>
typedef struct ResultResource ResultResource;
typedef struct ResultManual ResultManual;
typedef struct ResultStateBase { int tag; } ResultStateBase;
typedef struct ResultState {
    ResultStateBase base;
    const unsigned char *bytes;
    size_t length;
    const char *text;
    size_t text_length;
} ResultState;
ResultStateBase *result_state_base(ResultState *state);
int result_state_tag(ResultStateBase *state);
ResultManual *result_manual_new(void);
void result_manual_free(ResultManual *manual);
void result_keep_manual(ResultManual *(*callback)(void *), void *data, void (*release)(void *));
void result_kept_manual_call(void);
ResultResource *result_resource_new(int value);
ResultResource *result_resource_borrow(int value);
ResultResource *result_resource_own(ResultResource *resource);
void result_resource_free(ResultResource *resource);
int result_resource_value(ResultResource *resource);
int result_resource_freed(void);
ResultResource *result_handle(ResultResource *(*callback)(int, void *), void *data);
ResultState *result_state(ResultState *(*callback)(int, void *), void *data);
void result_lend_handle(ResultResource *(*callback)(ResultResource *, void *), void *data);
void result_handles_shutdown(ResultResource *(*resource)(void *), void *resource_data,
    ResultState *(*state)(void *), void *state_data);
void result_close(ResultResource *resource, const char *(*callback)(void *), void *data);
const char *result_text(const char *(*callback)(int, void *), void *data);
const char *result_required(const char *(*callback)(int, void *), void *data);
const char *result_scoped(const char *(*callback)(int));
const char *result_counted(const char *(*callback)(int *, int, void *), void *data, size_t *length);
const unsigned char *result_bytes(const unsigned char *(*callback)(unsigned char *, int, void *), void *data, size_t *length);
const char *result_parallel(const char *(*callback)(int, void *), void *data);
void result_shutdown(const char *(*callback)(int, void *), void *data);
void result_bad_count(const char *(*callback)(int *, int, void *), void *data);
int result_scalar(int (*callback)(void));
void result_const_count(const char *(*callback)(const int *, void *), void *data);
void result_wide_count(const char *(*callback)(unsigned __int128 *, void *), void *data);
void result_retain(const char *(*callback)(int, void *), void *data, void (*release)(void *));
void result_cancel(const char *(*callback)(int *, int, void *), void *data);
void result_cancel_wait_started(void);
const char *result_retained_call(int index);
int result_retained_matches(const char *first, const char *second);
void result_retained_clear(void);
void result_replace(const char *(*callback)(int));
const char *result_replaced_call(int index);
void result_retain_bytes(const unsigned char *(*callback)(unsigned char *, int, void *), void *data, void (*release)(void *));
void result_retained_bytes_call(int index);
int result_retained_bytes_sum(int index);
void result_retained_bytes_clear(void);
void result_retained_after_vm(void);
void result_keep_resource(ResultResource *(*callback)(int, void *), void *data, void (*release)(void *));
ResultResource *result_kept_resource_call(int index);
void result_kept_resource_clear(void);
void result_keep_state(ResultState *(*callback)(int, void *), void *data, void (*release)(void *));
ResultState *result_kept_state_call(int index);
void result_kept_state_clear(void);
void result_replace_resource(ResultResource *(*callback)(int));
ResultResource *result_replaced_resource_call(int index);
void result_kept_handles_after_vm(void);
void result_replace_owned(ResultResource *owner, ResultResource *(*callback)(ResultResource *, void *), void *data);
ResultResource *result_replaced_owned_call(void);
#endif
