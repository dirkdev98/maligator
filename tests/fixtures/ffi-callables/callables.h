#include <stddef.h>
#include "private.h"

typedef struct { double x; double y; } CallablePoint;
typedef int (*CallableInt)(int);
typedef double (*CallableDouble)(double);
typedef CallablePoint (*CallablePoints)(CallablePoint, CallablePoint);
typedef const char *(*CallableText)(int);
typedef int (*CallableApply)(int, CallableInt);
typedef int (*CallableBytes)(const unsigned char *, size_t);
typedef int (*CallableFixed)(int, int);
typedef int (*CallableOut)(int, int *);
typedef CallableInt (*CallableFactory)(int);
typedef int (*CallableVariadic)(int, ...);
#if defined(__x86_64__)
#define CALLABLE_ABI __attribute__((ms_abi))
#else
#define CALLABLE_ABI
#endif
typedef int (CALLABLE_ABI *CallableAbi)(int);

CallableInt callable_choose(int mode);
int (*callable_anon(int mode))(int);
CallableInt callable_from_point(CallablePoint point);
CallableDouble callable_double(void);
CallablePoints callable_point(void);
CallableText callable_text(void);
CallableApply callable_apply(void);
CallableBytes callable_bytes(void);
CallableFixed callable_fixed(void);
CallableOut callable_out(void);
CallableFactory callable_factory(void);
CallableAbi callable_abi(void);
int (CALLABLE_ABI *callable_abi_anon(void))(int);
CallableVariadic callable_variadic(void);
