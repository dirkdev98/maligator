#include "regexp_engine.h"

static const MalRegExpEngine regexp_engine = {
    .compile = mal_regexp_compile,
    .retain = mal_regexp_retain,
    .release = mal_regexp_release,
    .scratch_delta = mal_regexp_scratch_delta,
    .exec_utf16 = mal_regexp_exec,
    .exec_latin1 = mal_regexp_exec_latin1,
    .collect_fast = mal_regexp_collect_fast,
    .copy_captures = mal_regexp_copy_captures,
    .capture_name_count = mal_regexp_capture_name_count,
    .capture_name = mal_regexp_capture_name,
};

// The installer reference pulls in this archive member. Static embedders can
// enter the VM without running host installers, so publish it at process startup.
__attribute__((constructor)) static void regexp_register_engine(void) {
    atomic_store_explicit(&mal_regexp_engine, &regexp_engine, memory_order_relaxed);
}

void mal_host_install_regexp(struct MalVm *vm, const struct MalHostInstallSlot *slots,
    i32 count, const struct MalHostLaunchContext *launch) {
    (void) vm;
    (void) slots;
    (void) count;
    (void) launch;
    regexp_register_engine();
}
