#ifndef FFI_ASYNC_CALLBACKS_H
#define FFI_ASYNC_CALLBACKS_H
#include <stddef.h>
typedef int (*AsyncCallback)(int value, void *data);
typedef int (*AsyncPlainCallback)(int value);
typedef struct AsyncPair { int x; int y; } AsyncPair;
typedef struct AsyncResource AsyncResource;
typedef int (*AsyncResourceCallback)(AsyncResource *resource);
int async_apply(int count, AsyncCallback callback, void *data);
int async_parallel(int count, AsyncCallback callback, void *data);
int async_plain(int count, AsyncPlainCallback callback);
void async_void(int count, void (*callback)(int, void *), void *data);
AsyncPair async_record(int value, AsyncPair (*callback)(int, void *), void *data);
char *async_owned(AsyncCallback callback, void *data);
void async_free(void *value);
AsyncResource *async_resource(AsyncCallback callback, void *data);
void async_resource_destroy(AsyncResource *value);
void async_outputs(AsyncCallback callback, void *data, char **text);
int async_live(void);
int async_touch(unsigned char *bytes, size_t length, AsyncCallback callback, void *data);
void async_shutdown(AsyncCallback callback, void *data);
char *async_shutdown_owned(AsyncCallback callback, void *data);
AsyncResource *async_shutdown_resource(AsyncCallback callback, void *data);
void async_shutdown_outputs(AsyncCallback callback, void *data, char **text);
void async_wait_entered(void);
void async_bytes_count(long long count, void (*callback)(const unsigned char *, long long, void *), void *data);
int async_register(int mode, AsyncCallback callback, void *data, void (*release)(void *));
int async_register_lookup(int mode, AsyncResourceCallback callback, void *data, void (*release)(void *));
void *async_resource_data(AsyncResource *resource);
int async_resource_value(AsyncResource *resource);
int async_registered_call(int value);
void async_registered_clear(void);
int async_registered_count(void);
void async_notify(void (*callback)(int, void *), void *data, void (*release)(void *));
int async_release_after(int value, AsyncCallback callback, void *data, void (*release)(void *));
int async_release_buffer(AsyncCallback callback, void *data, void (*release)(void *), const unsigned char *bytes, size_t length);
void async_retained_arm_shutdown(void);
void async_retained_wait(void);
#endif
