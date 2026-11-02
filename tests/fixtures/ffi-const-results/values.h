#pragma once
#include <stddef.h>

typedef struct __attribute__((aligned(64))) Immutable {
    const int code;
    struct { const int value; int writable; } nested;
    const int samples[2];
    struct { const int promoted; };
} Immutable;
typedef struct Before { const int value; } Before;

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
