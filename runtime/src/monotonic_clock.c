#include "monotonic_clock.h"

#include <time.h>

#if defined(__APPLE__)
#include <mach/mach_time.h>

// Nanoseconds per tick as a whole part and a 64-bit binary fraction, so a read
// multiplies instead of dividing by the runtime timebase.
static u64 mal_monotonic_whole_ns;
static u64 mal_monotonic_fraction_ns;

// Set before any thread can read the clock, so readers never see half a ratio.
__attribute__((constructor)) static void mal_monotonic_timebase_init(void) {
    mach_timebase_info_data_t timebase;
    if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) {
        timebase = (mach_timebase_info_data_t) {.numer = 1, .denom = 1};
    }
    mal_monotonic_whole_ns = timebase.numer / timebase.denom;
    mal_monotonic_fraction_ns =
        (u64) (((unsigned __int128) (timebase.numer % timebase.denom) << 64) / timebase.denom);
}
#endif

u64 mal_monotonic_now_ns(void) {
#if defined(__APPLE__)
    // CLOCK_MONOTONIC_RAW counts these ticks, sleep included, but its libc wrapper
    // costs more than the read. The truncated fraction loses under a nanosecond.
    u64 ticks = mach_continuous_time();
    return ticks * mal_monotonic_whole_ns +
        (u64) (((unsigned __int128) ticks * mal_monotonic_fraction_ns) >> 64);
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
