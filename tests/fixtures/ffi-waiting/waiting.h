#ifndef FFI_WAITING_H
#define FFI_WAITING_H
typedef struct WaitingPair { int x; int y; } WaitingPair;
typedef int (*WaitingInteger)(int value, void *data);
typedef WaitingPair (*WaitingRecord)(int value, void *data);
typedef int (*WaitingKeyed)(int value);
typedef void (*WaitingVoid)(int value, void *data);
void waiting_set_integer(WaitingInteger callback, void *data, void (*release)(void *));
void waiting_set_record(WaitingRecord callback, void *data, void (*release)(void *));
void waiting_set_void(WaitingVoid callback, void *data, void (*release)(void *));
void waiting_set_keyed(WaitingKeyed callback);
void waiting_clear(void);
int waiting_call_integer(int value);
int waiting_call_keyed(int value);
void waiting_start(int count, int threads, int record);
int waiting_join(void);
void waiting_cancel(void);
int waiting_canceled(void);
void waiting_expect_zero(void);
void waiting_arm_shutdown(void);
void waiting_arm_child(void);
int waiting_child_call(void);
void waiting_wait_child(void);
#endif
