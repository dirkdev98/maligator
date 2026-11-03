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
typedef long double _Complex NativeComplex;
typedef int NativeVector __attribute__((ext_vector_type(4)));
typedef float NativeTriple __attribute__((ext_vector_type(3)));
typedef double NativeGnuVector __attribute__((vector_size(32)));
typedef float NativeAlignedTriple __attribute__((ext_vector_type(3), aligned(64)));
typedef unsigned _BitInt(127) NativeBits;
typedef _BitInt(65) NativeSignedBits;
#if __BITINT_MAXWIDTH__ >= 256
typedef unsigned _BitInt(256) NativeWideBits;
#else
typedef unsigned _BitInt(128) NativeWideBits;
#endif
typedef struct NativeExtensionRecord { NativeComplex complex; NativeTriple vector; NativeBits bits; } NativeExtensionRecord;
#define NATIVE_COMPLEX_ONE ((NativeComplex)1)
#define NATIVE_TRIPLE_ONE ((NativeTriple){1, 2, 3})
extern NativeComplex native_complex_global;
NativeComplex native_complex_make(void);
int native_complex_check(NativeComplex value);
NativeComplex native_complex_identity(NativeComplex value);
NativeVector native_vector_make(void);
int native_vector_sum(NativeVector value);
NativeTriple native_triple_make(void);
int native_triple_sum(NativeTriple value);
NativeGnuVector native_gnu_make(void);
double native_gnu_sum(NativeGnuVector value);
NativeAlignedTriple native_aligned_triple(void);
int native_aligned_sum(NativeAlignedTriple value);
NativeBits native_bits_max(void);
int native_bits_check(NativeBits value);
NativeWideBits native_wide_bits_max(void);
int native_wide_bits_check(NativeWideBits value);
NativeSignedBits native_signed_bits_min(void);
int native_signed_bits_check(NativeSignedBits value);
NativeExtensionRecord native_extension_record(void);
int native_extension_record_check(NativeExtensionRecord value);
void native_triple_inout(NativeTriple *value);
void native_complex_out(NativeComplex *value);
int native_triples_sum(const NativeTriple *values, size_t count);
NativeComplex native_complex_callback(NativeComplex (*callback)(NativeComplex, void *), void *data);
NativeTriple native_triple_callback(NativeTriple (*callback)(NativeTriple, void *), void *data);
