#pragma once

#include <stdatomic.h>

#include "defaults.h"
#include "mal_regexp.h"

typedef struct MalRegExpEngine {
    typeof(&mal_regexp_compile) compile;
    typeof(&mal_regexp_retain) retain;
    typeof(&mal_regexp_release) release;
    typeof(&mal_regexp_scratch_delta) scratch_delta;
    typeof(&mal_regexp_exec) exec_utf16;
    typeof(&mal_regexp_exec_latin1) exec_latin1;
    typeof(&mal_regexp_collect_fast) collect_fast;
    typeof(&mal_regexp_copy_captures) copy_captures;
    typeof(&mal_regexp_capture_name_count) capture_name_count;
    typeof(&mal_regexp_capture_name) capture_name;
} MalRegExpEngine;

extern _Atomic(const MalRegExpEngine *) mal_regexp_engine;
[[noreturn]] void mal_regexp_missing_engine(void);

static inline const MalRegExpEngine *mal_regexp_require_engine(void) {
    const MalRegExpEngine *engine = atomic_load_explicit(&mal_regexp_engine, memory_order_relaxed);
    if (__builtin_expect(engine == nullptr, 0)) mal_regexp_missing_engine();
    return engine;
}

struct MalVm;
struct MalHostInstallSlot;
struct MalHostLaunchContext;

void mal_host_install_regexp(struct MalVm *vm, const struct MalHostInstallSlot *slots,
    i32 count, const struct MalHostLaunchContext *launch);
