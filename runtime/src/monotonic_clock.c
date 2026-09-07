#include "monotonic_clock.h"

#include <time.h>

u64 mal_monotonic_now_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
}

#if !defined(__wasi__)
u64 mal_process_cpu_now_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &now);
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
}
#endif
