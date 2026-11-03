#include "values.h"
#include <float.h>
#include <pthread.h>
#include <stdlib.h>
static int calls;
NativeUnsigned native_unsigned_global;
const NativeUnsigned native_const_unsigned = NATIVE_MAX;
const NativeUnsigned native_const_values[2] = {NATIVE_MAX, (NativeUnsigned)1 << 100};
NativeUnsigned native_unsigned_make(uint64_t high, uint64_t low) { return ((NativeUnsigned)high << 64) | low; }
NativeOtherUnsigned native_other_make(void) { return ~(NativeOtherUnsigned)0; }
uint64_t native_unsigned_high(NativeUnsigned value) { return (uint64_t)(value >> 64); }
uint64_t native_unsigned_low(NativeUnsigned value) { return (uint64_t)value; }
NativeAlias native_alias(NativeAlias value) { return value; }
NativeUnsigned native_unsigned_add(NativeUnsigned left, NativeUnsigned right) { calls++; return left + right; }
int native_calls(void) { return calls; }
NativeSigned native_signed_min(void) { return -((NativeSigned)1 << 126) * 2; }
int native_signed_is_min(NativeSigned value) { return value == native_signed_min(); }
NativeExtended native_precise(void) { return 1.0L + LDBL_EPSILON; }
int native_is_precise(NativeExtended value) { return value == native_precise() && value != 1.0L; }
NativeRecord native_record(void) { return (NativeRecord){NATIVE_MAX, native_precise()}; }
int native_record_check(NativeRecord value) { return value.integer == NATIVE_MAX && native_is_precise(value.precise); }
NativeConstRecord native_const_record(void) { return (NativeConstRecord){NATIVE_MAX, native_precise()}; }
int native_const_record_check(NativeConstRecord value) { return value.integer == NATIVE_MAX && native_is_precise(value.precise); }
NativeChoice native_choice(void) { return (NativeChoice){.integer = NATIVE_MAX}; }
int native_choice_check(NativeChoice value) { return value.integer == NATIVE_MAX; }
void native_unsigned_out(NativeUnsigned *value) { *value = NATIVE_MAX; }
void native_unsigned_inout(NativeUnsigned *value) { ++*value; }
NativeUnsigned native_unsigned_sum(const NativeUnsigned *values, size_t count) { NativeUnsigned sum = 0; for (size_t i = 0; i < count; i++) sum += values[i]; return sum; }
NativeUnsigned *native_unsigned_array(size_t count) { NativeUnsigned *values = malloc((count == 0 ? 1 : count) * sizeof(*values)); if (values == NULL) abort(); for (size_t i = 0; i < count; i++) values[i] = i == 0 ? NATIVE_MAX : (NativeUnsigned)1 << 100; return values; }
void native_array_free(void *values) { free(values); }
NativeUnsigned native_callback(NativeUnsigned (*callback)(NativeUnsigned, void *), void *data) { return callback(NATIVE_MAX, data); }
NativeUnsigned native_with_callback(NativeUnsigned value, void (*callback)(void *), void *data) { callback(data); return value; }
typedef struct { NativeUnsigned (*callback)(NativeUnsigned, void *); void *data; NativeUnsigned result; } NativeJob;
static void *native_run(void *argument) { NativeJob *job = argument; job->result = job->callback(NATIVE_MAX, job->data); return NULL; }
int native_parallel(NativeUnsigned (*callback)(NativeUnsigned, void *), void *data, void (*release)(void *)) {
    NativeJob job = {callback, data, 0}; pthread_t thread;
    if (pthread_create(&thread, NULL, native_run, &job) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
    release(data); return job.result == NATIVE_MAX;
}
typedef struct { void (*callback)(NativeUnsigned, void *); void *data; void (*release)(void *); } NativeNotice;
static void *native_send(void *argument) { NativeNotice *job = argument; job->callback(NATIVE_MAX, job->data); job->release(job->data); return NULL; }
void native_notify(void (*callback)(NativeUnsigned, void *), void *data, void (*release)(void *)) {
    NativeNotice job = {callback, data, release}; pthread_t thread;
    if (pthread_create(&thread, NULL, native_send, &job) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}
NativeComplex native_complex_global;
NativeComplex native_complex_make(void) { NativeComplex value; __real__ value = native_precise(); __imag__ value = 2.0L + 2.0L * LDBL_EPSILON; return value; }
int native_complex_check(NativeComplex value) { return __real__ value == native_precise() && __imag__ value == 2.0L + 2.0L * LDBL_EPSILON; }
NativeComplex native_complex_identity(NativeComplex value) { return value; }
NativeVector native_vector_make(void) { return (NativeVector){2, 3, 5, 7}; }
int native_vector_sum(NativeVector value) { return value[0] + value[1] + value[2] + value[3]; }
NativeTriple native_triple_make(void) { return (NativeTriple){2, 3, 5}; }
int native_triple_sum(NativeTriple value) { return (int)(value[0] + value[1] + value[2]); }
NativeGnuVector native_gnu_make(void) { return (NativeGnuVector){2, 3, 5, 7}; }
double native_gnu_sum(NativeGnuVector value) { return value[0] + value[1] + value[2] + value[3]; }
NativeAlignedTriple native_aligned_triple(void) { return (NativeAlignedTriple){2, 3, 5}; }
int native_aligned_sum(NativeAlignedTriple value) { return native_triple_sum(value); }
NativeBits native_bits_max(void) { return ~(NativeBits)0; }
int native_bits_check(NativeBits value) { return value == native_bits_max(); }
NativeWideBits native_wide_bits_max(void) { return (NativeWideBits)~(NativeWideBits)0; }
int native_wide_bits_check(NativeWideBits value) { return value == native_wide_bits_max(); }
NativeSignedBits native_signed_bits_min(void) { return -((NativeSignedBits)1 << 63) * 2; }
int native_signed_bits_check(NativeSignedBits value) { return value == native_signed_bits_min(); }
NativeExtensionRecord native_extension_record(void) { return (NativeExtensionRecord){native_complex_make(), native_triple_make(), native_bits_max()}; }
int native_extension_record_check(NativeExtensionRecord value) { return native_complex_check(value.complex) && native_triple_sum(value.vector) == 10 && native_bits_check(value.bits); }
void native_triple_inout(NativeTriple *value) { *value += (NativeTriple){1, 2, 3}; }
void native_complex_out(NativeComplex *value) { *value = native_complex_make(); }
int native_triples_sum(const NativeTriple *values, size_t count) { int sum = 0; for (size_t i = 0; i < count; i++) sum += native_triple_sum(values[i]); return sum; }
NativeComplex native_complex_callback(NativeComplex (*callback)(NativeComplex, void *), void *data) { return callback(native_complex_make(), data); }
NativeTriple native_triple_callback(NativeTriple (*callback)(NativeTriple, void *), void *data) { return callback(native_triple_make(), data); }
