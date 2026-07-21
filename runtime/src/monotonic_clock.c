#include "monotonic_clock.h"

#include <time.h>

u64 mal_monotonic_now_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
}
