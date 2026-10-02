#include "node_module.h"

#if MAL_NODE

#include "ascii.h"
#include "node_assert_strict.h"
#include "node_buffer.h"
#include "node_child_process.h"
#include "node_crypto.h"
#include "node_diagnostics_channel.h"
#include "node_dns.h"
#include "node_fs.h"
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
    static const struct { const char *id; MalHostInstaller install; } builtins[] = {
        {"node:assert", mal_host_install_node_assert},
        {"node:assert/strict", mal_host_install_node_assert_strict},
        {"node:buffer", mal_host_install_node_buffer},
        {"node:child_process", mal_host_install_node_child_process},
        {"node:crypto", mal_host_install_node_crypto},
        {"node:diagnostics_channel", mal_host_install_node_diagnostics_channel},
        {"node:dns", mal_host_install_node_dns},
        {"node:fs", mal_host_install_node_fs},
        {"node:fs/promises", mal_host_install_node_fs_promises},
        {"node:http", mal_host_install_node_http},
        {"node:module", mal_host_install_node_module},
        {"node:net", mal_host_install_node_net},
        {"node:os", mal_host_install_node_os},
        {"node:path", mal_host_install_node_path},
        {"node:perf_hooks", mal_host_install_node_perf_hooks},
        {"node:process", mal_host_install_process},
        {"node:querystring", mal_host_install_node_querystring},
        {"node:stream", mal_host_install_node_stream},
        {"node:stream/promises", mal_host_install_node_stream_promises},
        {"node:tls", mal_host_install_node_tls},
        {"node:url", mal_host_install_node_url},
        {"node:util", mal_host_install_node_util},
        {"node:v8", mal_host_install_node_v8},
        {"node:vm", mal_host_install_node_vm},
        {"node:worker_threads", mal_host_install_node_worker_threads},
        {"node:async_hooks", mal_host_install_node_async_hooks},
        {"node:cluster", mal_host_install_node_cluster},
        {"node:domain", mal_host_install_node_domain},
        {"node:events", mal_host_install_node_events},
        {"node:http2", mal_host_install_node_http2},
        {"node:https", mal_host_install_node_https},
        {"node:inspector", mal_host_install_node_inspector},
        {"node:readline", mal_host_install_node_readline},
        {"node:sqlite", mal_host_install_node_sqlite},
        {"node:string_decoder", mal_host_install_node_string_decoder},
        {"node:timers/promises", mal_host_install_node_timers_promises},
        {"node:tty", mal_host_install_node_tty},
        {"node:zlib", mal_host_install_node_zlib},
    };
    for (usize i = 0; i < countof(builtins); i++) {
        const char *id = builtins[i].id;
        if (!mal_string_equals_ascii(name, id) &&
            !mal_string_equals_ascii(name, id + 5)) continue;
        MalValue cached = mal_node_module_get_cached(vm, id);
        if (!mal_value_is_undefined(cached)) return cached;
        builtins[i].install(vm, nullptr, 0, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        return mal_node_module_get_cached(vm, id);
    }
    return mal_value_new_undefined();
}


#endif
