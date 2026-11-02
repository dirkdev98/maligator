#include "watch.h"
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern size_t mal_gc_process_bytes(void);
static int counter;
static bool armed;
int watch_value(void) { return WATCH_VALUE; }
int watch_next(void) { return ++counter; }
static void retired(void) {
    assert(mal_gc_process_bytes() == 0);
    fputs("ffi watch host retired\n", stderr);
}
void watch_arm_exit(void) {
    if (armed) return;
    armed = true;
    fprintf(stderr, "ffi watch host pid %ld\n", (long)getpid());
    fprintf(stderr, "ffi watch host value %d\n", watch_value());
    fflush(stderr);
    if (atexit(retired) != 0) abort();
}
