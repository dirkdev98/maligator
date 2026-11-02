#include "values.h"

Immutable immutable_fixed = {77, {78, 79}, {80, 81}, {82}};
Immutable a_make(int seed) {
    Immutable value = {seed, {seed + 1, seed + 2}, {seed + 3, seed + 4}, {seed + 5}};
    return value;
}
Before z_make_before(int seed) { return (Before){seed + 10}; }
int immutable_visit(int seed, int (*callback)(Immutable, void *), void *data) {
    return callback(a_make(seed), data) + seed;
}
void immutable_notify(int seed, void (*callback)(Immutable, void *), void *data,
    void (*release)(void *)) {
    callback(a_make(seed), data);
    release(data);
}
