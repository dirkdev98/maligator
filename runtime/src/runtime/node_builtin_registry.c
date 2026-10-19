#include "node_module.h"

#if MAL_NODE

#include "ascii.h"
#include "node_assert_strict.h"
#include "node_buffer.h"
#include "node_child_process.h"
#include "node_console.h"
#include "node_crypto.h"
#include "node_diagnostics_channel.h"
#include "node_dns.h"
#include "node_fs.h"
#include "node_legacy.h"
#include "node_http.h"
#include "node_module_api.h"
#include "node_net.h"
#include "node_os.h"
#include "node_path.h"
#include "node_perf_hooks.h"
#include "node_process.h"
#include "node_querystring.h"
#include "node_stream.h"
#include "node_tls.h"
#include "node_url.h"
#include "node_util.h"
#include "node_v8.h"
#include "node_vm.h"
#include "node_worker_threads.h"
#include "node_async_hooks.h"
#include "node_cluster.h"
#include "node_domain.h"
#include "node_events.h"
#include "node_http2.h"
#include "node_https.h"
#include "node_inspector.h"
#include "node_readline.h"
#include "node_sqlite.h"
#include "node_string_decoder.h"
#include "node_timers_promises.h"
#include "node_tty.h"
#include "node_zlib.h"


MalValue mal_node_module_get_builtin(MalVm *vm, MalString *name) {
    static const struct {
        const char *id;
        MalHostInstaller install;
        bool accepts_bare;
    } builtins[] = {
#include "generated/node_builtin_installers.inc"
    };
    for (usize i = 0; i < countof(builtins); i++) {
        const char *id = builtins[i].id;
        if (!mal_string_equals_ascii(name, id) &&
            (!builtins[i].accepts_bare || !mal_string_equals_ascii(name, id + 5))) continue;
        MalValue cached = mal_node_module_get_cached(vm, id);
        if (!mal_value_is_undefined(cached)) return cached;
        builtins[i].install(vm, nullptr, 0, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        return mal_node_module_get_cached(vm, id);
    }
    return mal_value_new_undefined();
}


#endif
