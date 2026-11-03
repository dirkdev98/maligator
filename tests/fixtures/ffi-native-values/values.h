#pragma once
#include <stddef.h>
#include <stdint.h>
typedef __int128 NativeSigned;
typedef unsigned __int128 NativeUnsigned;
typedef unsigned __int128 NativeOtherUnsigned;
typedef long double NativeExtended;
typedef NativeUnsigned NativeAlias;
typedef struct NativeRecord { NativeUnsigned integer; NativeExtended precise; } NativeRecord;
typedef struct NativeConstRecord { const NativeUnsigned integer; const NativeExtended precise; } NativeConstRecord;
typedef union NativeChoice { NativeUnsigned integer; NativeExtended precise; } NativeChoice;
#define NATIVE_MAX ((NativeUnsigned)~(NativeUnsigned)0)
#define NATIVE_ONE ((NativeExtended)1.0L)
extern NativeUnsigned native_unsigned_global;
extern const NativeUnsigned native_const_unsigned;
extern const NativeUnsigned native_const_values[2];
NativeUnsigned native_unsigned_make(uint64_t high, uint64_t low);
NativeOtherUnsigned native_other_make(void);
uint64_t native_unsigned_high(NativeUnsigned value);
uint64_t native_unsigned_low(NativeUnsigned value);
NativeAlias native_alias(NativeAlias value);
NativeUnsigned native_unsigned_add(NativeUnsigned left, NativeUnsigned right);
int native_calls(void);
NativeSigned native_signed_min(void);
int native_signed_is_min(NativeSigned value);
NativeExtended native_precise(void);
int native_is_precise(NativeExtended value);
NativeRecord native_record(void);
int native_record_check(NativeRecord value);
NativeConstRecord native_const_record(void);
int native_const_record_check(NativeConstRecord value);
NativeChoice native_choice(void);
int native_choice_check(NativeChoice value);
void native_unsigned_out(NativeUnsigned *value);
void native_unsigned_inout(NativeUnsigned *value);
NativeUnsigned native_unsigned_sum(const NativeUnsigned *values, size_t count);
NativeUnsigned *native_unsigned_array(size_t count);
void native_array_free(void *values);
NativeUnsigned native_callback(NativeUnsigned (*callback)(NativeUnsigned, void *), void *data);
NativeUnsigned native_with_callback(NativeUnsigned value, void (*callback)(void *), void *data);
int native_parallel(NativeUnsigned (*callback)(NativeUnsigned, void *), void *data, void (*release)(void *));
void native_notify(void (*callback)(NativeUnsigned, void *), void *data, void (*release)(void *));
