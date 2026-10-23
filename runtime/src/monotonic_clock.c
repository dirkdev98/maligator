#include "monotonic_clock.h"

#include <time.h>

u64 mal_monotonic_now_ns(void) {
#if defined(__APPLE__)
    // Darwin derives CLOCK_MONOTONIC from the wall clock and boot time through two libc
    // calls; the raw clock counts the same time, sleep included, from the commpage.
    return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
#else
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
#endif
}

#if !defined(__wasi__)
u64 mal_process_cpu_now_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &now);
    return (u64) now.tv_sec * 1000000000ull + (u64) now.tv_nsec;
}
#endif
