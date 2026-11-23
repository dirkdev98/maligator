#include "personality.h"

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
static bool personality_begin(MalVm *vm, bool node) {
    if (vm->host_personality_installed) return false;
    vm->host_personality_installed = true;
    vm->host_node = node;
    return true;
}

// The event loop's timers stay global and follow Node, returning Timeout objects; the
// API classes install by use (web_surface.h). An isolate without a host event loop,
// such as an installer test, gets no timers.
static void personality_web(MalVm *vm) {
    if (!personality_begin(vm, false) || mal_host(vm) == nullptr) return;
    mal_host_timers_install(vm, personality_global(vm));
}

static void personality_node(MalVm *vm) {
    if (!personality_begin(vm, true)) return;
    mal_host_install_node_console_hooks(vm, nullptr, 0, nullptr);
    if (mal_host(vm) == nullptr) return;
    mal_host_timers_install(vm, personality_global(vm));
    mal_node_immediates_install(vm, personality_global(vm));
}

void mal_host_install_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    personality_web(vm);
}

void mal_host_install_node_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    personality_node(vm);
}

void mal_host_install_node_console_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    vm->console_node_hooks = &node_console_hooks;
}

MalHostInstaller mal_runtime_image_personality(
    const MalRuntimeImage *program, MalHostInstaller selected) {
    if (selected == mal_host_install_node_web_personality) return selected;
    for (i32 i = 0; i < program->host_install_count; i++) {
        MalHostInstaller installer = program->host_installs[i].installer;
        if (installer == mal_host_install_node_web_personality) return installer;
        if (installer == mal_host_install_web_personality) selected = installer;
    }
    return selected;
}
