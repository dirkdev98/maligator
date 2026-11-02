#include <stddef.h>
#include <stdint.h>

typedef struct __attribute__((aligned(64))) AlignedPair {
    int x;
    int y;
} AlignedPair;
typedef struct __attribute__((aligned(65536))) AlignedHuge {
    int x;
    int y;
} AlignedHuge;

extern AlignedPair aligned_values[2];
extern AlignedHuge aligned_huge_values[1];
uintptr_t aligned_address(const AlignedPair *values, size_t count);
uintptr_t aligned_huge_address(const AlignedHuge *values, size_t count);
int aligned_sum(const AlignedPair *values, size_t count);
AlignedPair aligned_echo(AlignedPair value);
int aligned_apply(AlignedPair value, int (*callback)(AlignedPair, void *), void *data);
AlignedPair aligned_transform(int value, AlignedPair (*callback)(int, void *), void *data);
void aligned_notify(AlignedPair value, void (*callback)(AlignedPair, void *),
    void *data, void (*release)(void *));
