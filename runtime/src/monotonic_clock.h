#pragma once

#include "defaults.h"

/** CLOCK_MONOTONIC expressed as nanoseconds. */
u64 mal_monotonic_now_ns(void);

/** CLOCK_PROCESS_CPUTIME_ID expressed as nanoseconds. Matches ITIMER_PROF cadence. */
u64 mal_process_cpu_now_ns(void);
