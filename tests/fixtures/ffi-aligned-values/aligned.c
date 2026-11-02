#include "aligned.h"

AlignedPair aligned_values[2] = {{1, 2}, {3, 4}};
AlignedHuge aligned_huge_values[1] = {{5, 6}};

uintptr_t aligned_address(const AlignedPair *values, size_t count) {
    (void)count;
    return (uintptr_t)values;
}
uintptr_t aligned_huge_address(const AlignedHuge *values, size_t count) {
    (void)count;
    return (uintptr_t)values;
}
int aligned_sum(const AlignedPair *values, size_t count) {
    int sum = 0;
    for (size_t i = 0; i < count; i++) sum += values[i].x + values[i].y;
    return sum;
}
AlignedPair aligned_echo(AlignedPair value) { return value; }
int aligned_apply(AlignedPair value, int (*callback)(AlignedPair, void *), void *data) {
    return callback(value, data) + value.x;
}
AlignedPair aligned_transform(int value, AlignedPair (*callback)(int, void *), void *data) {
    return callback(value, data);
}
void aligned_notify(AlignedPair value, void (*callback)(AlignedPair, void *),
    void *data, void (*release)(void *)) {
    callback(value, data);
    release(data);
}
