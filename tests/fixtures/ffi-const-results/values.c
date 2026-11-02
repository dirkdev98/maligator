#include "values.h"
#include <stdlib.h>
#include <string.h>

Immutable immutable_fixed = {77, {78, 79}, {80, 81}, {82}, {{83, 84}, {85, 86}}};
Immutable a_make(int seed) {
    Immutable value = {seed, {seed + 1, seed + 2}, {seed + 3, seed + 4}, {seed + 5}, {{seed + 6, seed + 7}, {seed + 8, seed + 9}}};
    return value;
}
static int taken;
int immutable_taken(void) { return taken; }
int a_take_before(Before value) { taken++; return value.value; }
int z_take(Immutable value) {
    taken++;
    return value.code + value.nested.value + value.nested.writable + value.samples[0] + value.samples[1] + value.promoted + value.points[0].value + value.points[0].writable + value.points[1].value + value.points[1].writable;
}
int immutable_array(const Immutable *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(Immutable) != 0) abort();
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += z_take(values[index]);
    return sum;
}
int immutable_bits_take(ImmutableBits value) { taken++; return (int)value.code + value.payload; }
void immutable_out(Immutable *value) {
    if ((uintptr_t)value % _Alignof(Immutable) != 0) abort();
    Immutable native = a_make(21);
    memcpy(value, &native, sizeof(native));
    taken++;
}
void immutable_inout(Immutable *value) {
    if ((uintptr_t)value % _Alignof(Immutable) != 0) abort();
    value->nested.writable += 100;
    taken++;
}
void immutable_array_out(Immutable (*value)[2]) {
    if ((uintptr_t)value % _Alignof(ImmutablePair) != 0) abort();
    Immutable native[2] = { a_make(31), a_make(41) };
    memcpy(value, native, sizeof(native));
}
void immutable_pair_out(ImmutablePair *value) { immutable_array_out(value); }
void immutable_pair_inout(ImmutablePair *value) {
    if ((uintptr_t)value % _Alignof(ImmutablePair) != 0) abort();
    (*value)[0].nested.writable += 100;
    (*value)[1].nested.writable += 200;
    taken++;
}
void immutable_numbers_out(ImmutableNumbers *value) {
    const int native[2] = {17, 23};
    memcpy(value, native, sizeof(native));
}
void immutable_grid_out(ImmutableGrid *value) {
    const int native[2][2] = {{2, 3}, {5, 7}};
    memcpy(value, native, sizeof(native));
}
void immutable_grid_inout(ImmutableGrid *value) {
    if ((*value)[0][0] != 11 || (*value)[0][1] != 13 || (*value)[1][0] != 17 || (*value)[1][1] != 19) abort();
    taken++;
}
Before z_make_before(int seed) { return (Before){seed + 10}; }
static int token_destroyed;
static int token_destroy_sum;
ImmutableToken immutable_token_make(int seed) { return (ImmutableToken){seed, seed + 1}; }
ImmutableToken immutable_token_borrow(void) { return (ImmutableToken){99, 100}; }
void immutable_token_destroy(ImmutableToken value) { token_destroyed++; token_destroy_sum += value.token; }
int immutable_token_destroyed(void) { return token_destroyed; }
int immutable_token_destroy_sum(void) { return token_destroy_sum; }
uintptr_t immutable_token_address(const ImmutableToken *value) { return (uintptr_t)value; }
int immutable_token_consume(ImmutableToken value) { return value.token + value.detail; }
int immutable_token_array(const ImmutableToken *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(ImmutableToken) != 0) abort();
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += immutable_token_consume(values[index]);
    return sum;
}
int immutable_token_with_callback(ImmutableToken value, void (*callback)(void *), void *data) { callback(data); return value.token + value.detail; }
void immutable_token_set(ImmutableToken *value, int detail) { value->detail = detail; }
void immutable_token_visit(int seed, void (*callback)(ImmutableToken, void *), void *data) { callback(immutable_token_make(seed), data); }
void immutable_token_out(int seed, ImmutableToken *value) {
    if ((uintptr_t)value % _Alignof(ImmutableToken) != 0) abort();
    ImmutableToken native = immutable_token_make(seed);
    memcpy(value, &native, sizeof(native));
}
void immutable_token_out_visit(int seed, ImmutableToken *value, void (*callback)(void *), void *data) { immutable_token_out(seed, value); callback(data); }
int immutable_visit(int seed, int (*callback)(Immutable, void *), void *data) {
    return callback(a_make(seed), data) + seed;
}
void immutable_notify(int seed, void (*callback)(Immutable, void *), void *data,
    void (*release)(void *)) {
    callback(a_make(seed), data);
    release(data);
}
