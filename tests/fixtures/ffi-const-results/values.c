#include "values.h"

Immutable immutable_fixed = {77, {78, 79}, {80, 81}, {82}};
Immutable a_make(int seed) {
    Immutable value = {seed, {seed + 1, seed + 2}, {seed + 3, seed + 4}, {seed + 5}};
    return value;
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
void immutable_token_visit(int seed, void (*callback)(ImmutableToken, void *), void *data) { callback(immutable_token_make(seed), data); }
int immutable_visit(int seed, int (*callback)(Immutable, void *), void *data) {
    return callback(a_make(seed), data) + seed;
}
void immutable_notify(int seed, void (*callback)(Immutable, void *), void *data,
    void (*release)(void *)) {
    callback(a_make(seed), data);
    release(data);
}
