#include "personality.h"

#include "atomics_async.h"
#include "builtin_console.h"
#include "host.h"
#include "intrinsics.h"
#include "node_immediate.h"
#include "node_inspect.h"
#include "node_module.h"
#include "web_host_timer.h"

static const MalConsoleNodeHooks node_console_hooks = {
    .format_into = mal_node_util_format_into,
    .inspect_into = mal_node_util_inspect_into,
    .throw_code = mal_node_throw_code,
    .format = mal_console_node_format,
    .dir = mal_console_node_dir,
    .table = mal_console_node_table,
};

static MalObject *personality_global(MalVm *vm) {
    return mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
}

// A host driver may already have applied the personality its image lists.
static bool personality_begin(MalVm *vm, bool web_platform, bool node) {
    if (vm->host_web_platform || vm->host_node) return false;
    vm->host_web_platform = web_platform;
    vm->host_node = node;
    return true;
}

// The event loop's timers stay global and follow Node, returning Timeout objects; the
// API classes install by use (web_surface.h). An isolate without a host event loop,
// such as an installer test, gets no timers.
static void personality_web(MalVm *vm) {
    if (!personality_begin(vm, true, false) || mal_host(vm) == nullptr) return;
    mal_host_timers_install_node(vm, personality_global(vm));
}

static void personality_node(MalVm *vm, bool web_platform) {
    if (!personality_begin(vm, web_platform, true)) return;
    vm->console_node_hooks = &node_console_hooks;
    if (mal_host(vm) == nullptr) return;
    mal_host_timers_install_node(vm, personality_global(vm));
    mal_node_immediates_install(vm, personality_global(vm));
}

void mal_runtime_personality_install(MalVm *vm, bool web_platform, bool node) {
    mal_atomics_async_install(vm, false);
    if (node) personality_node(vm, web_platform);
    else if (web_platform) personality_web(vm);
}

void mal_host_install_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    personality_web(vm);
}

void mal_host_install_node_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    personality_node(vm, false);
}

void mal_host_install_node_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    personality_node(vm, true);
}
