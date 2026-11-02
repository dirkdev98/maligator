#pragma once
#include <stddef.h>
#include <stdint.h>

typedef struct __attribute__((aligned(64))) Immutable {
    const int code;
    struct { const int value; int writable; } nested;
    const int samples[2];
    struct { const int promoted; };
} Immutable;
typedef struct Before { const int value; } Before;
typedef struct __attribute__((aligned(64))) ImmutableToken { const int token; int detail; } ImmutableToken;
ImmutableToken immutable_token_make(int seed);
ImmutableToken immutable_token_borrow(void);
void immutable_token_destroy(ImmutableToken value);
int immutable_token_destroyed(void);
int immutable_token_destroy_sum(void);
uintptr_t immutable_token_address(const ImmutableToken *value);
int immutable_token_consume(ImmutableToken value);
int immutable_token_with_callback(ImmutableToken value, void (*callback)(void *), void *data);
void immutable_token_set(ImmutableToken *value, int detail);
int immutable_token_array(const ImmutableToken *values, size_t count);
void immutable_token_visit(int seed, void (*callback)(ImmutableToken, void *), void *data);

extern Immutable immutable_fixed;
Immutable a_make(int seed);
int a_take_before(Before value);
Before z_make_before(int seed);
int z_take(Immutable value);
void immutable_out(Immutable *value);
void immutable_inout(Immutable *value);
int immutable_array(const Immutable *values, size_t count);
Immutable immutable_callback_result(Immutable (*callback)(void));
int immutable_visit(int seed, int (*callback)(Immutable, void *), void *data);
void immutable_notify(int seed, void (*callback)(Immutable, void *), void *data,
    void (*release)(void *));
