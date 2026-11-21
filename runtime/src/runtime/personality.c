#include "personality.h"

#include "atomics_async.h"
#include "builtin_console.h"
#include "intrinsics.h"
#include "node_immediate.h"
#if MAL_NODE
#include "node_inspect.h"
#include "node_module.h"
#endif
#include "web_host_timer.h"

#if MAL_NODE
static const MalConsoleNodeHooks node_console_hooks = {
    .format_into = mal_node_util_format_into,
    .inspect_into = mal_node_util_inspect_into,
    .throw_code = mal_node_throw_code,
};
#endif

void mal_runtime_personality_install(MalVm *vm, bool web_platform, bool node) {
    vm->host_web_platform = web_platform;
    vm->host_node = node;
#if MAL_NODE
    vm->console_node_hooks = node ? &node_console_hooks : nullptr;
#endif
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_atomics_async_install(vm, false);
    // The event loop's timers stay global; the API classes install by use (web_surface.h).
    if (web_platform || node) {
        if (node) mal_host_timers_install_node(vm, global_this);
        else mal_host_timers_install(vm, global_this);
    }
#if MAL_NODE
    if (node) mal_node_immediates_install(vm, global_this);
#endif
}
