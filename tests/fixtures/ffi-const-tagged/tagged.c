#include "tagged.h"
#include <stdlib.h>
#include <string.h>

static int calls;
int tagged_calls(void) { return calls; }
ConstTagged tagged_make(unsigned kind, int seed) {
    switch (kind) {
    case 0: return (ConstTagged){{kind}, seed};
    case 1: return (ConstTagged){{kind}, seed, {.integer = seed + 1}};
    case 2: return (ConstTagged){{kind}, seed, {.point = {seed + 1, seed + 2}}};
    case 3: return (ConstTagged){{kind}, seed, {.samples = {seed + 1, seed + 2}}};
    default: return (ConstTagged){{7}, seed};
    }
}
int tagged_take(ConstTagged value) {
    calls++;
    switch (value.kind) {
    case 0: return value.id;
    case 1: return value.id + value.payload.integer;
    case 2: return value.id + value.payload.point.value + value.payload.point.writable;
    case 3: return value.id + value.payload.samples[0] + value.payload.samples[1];
    default: abort();
    }
}
void tagged_out(ConstTagged *value) {
    if ((uintptr_t)value % _Alignof(ConstTagged) != 0) abort();
    ConstTagged native = tagged_make(2, 11);
    memcpy(value, &native, sizeof(native));
}
void tagged_inout(ConstTagged *value) {
    if ((uintptr_t)value % _Alignof(ConstTagged) != 0 || value->kind != 2) abort();
    value->payload.point.writable += 100;
}
int tagged_sum(const ConstTagged *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(ConstTagged) != 0) abort();
    int sum = 0;
    for (size_t i = 0; i < count; i++) sum += tagged_take(values[i]);
    return sum;
}
int tagged_pair(ConstTaggedPair value) { return value.id + tagged_take(value.values[0]) + tagged_take(value.values[1]); }
void tagged_pair_inout(ConstTagged (*value)[2]) { tagged_inout(&(*value)[0]); tagged_inout(&(*value)[1]); }
int tagged_visit(ConstTagged value, int (*callback)(ConstTagged, void *), void *data) { return callback(value, data); }
void tagged_notify(ConstTagged value, void (*callback)(ConstTagged, void *), void *data, void (*release)(void *)) {
    callback(value, data);
    release(data);
}
