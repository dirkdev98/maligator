#ifndef FFI_CALLBACK_RESULTS_H
#define FFI_CALLBACK_RESULTS_H
#include <stddef.h>
typedef struct ResultResource ResultResource;
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
#endif
