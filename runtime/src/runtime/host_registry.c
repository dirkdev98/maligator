#include "host_registry.h"

#include <string.h>

#include "mal_assets.h"

#if MAL_NODE
#include "node_assert_strict.h"
#include "node_async_hooks.h"
#include "node_buffer.h"
#include "node_child_process.h"
#include "node_cluster.h"
#include "node_crypto.h"
#include "node_diagnostics_channel.h"
#include "node_dns.h"
#include "node_domain.h"
#include "node_events.h"
#include "node_fs.h"
#include "node_http.h"
#include "node_https.h"
#include "node_http2.h"
#include "node_inspector.h"
#include "node_module_api.h"
#include "node_net.h"
#include "node_os.h"
#include "node_path.h"
#include "node_perf_hooks.h"
#include "node_process.h"
#include "node_querystring.h"
#include "node_readline.h"
#include "node_sqlite.h"
#include "node_stream.h"
#include "node_string_decoder.h"
#include "node_tls.h"
#include "node_timers_promises.h"
#include "node_tty.h"
#include "node_url.h"
#include "node_util.h"
#include "node_v8.h"
#include "node_vm.h"
#include "node_worker_threads.h"
#include "node_zlib.h"
#endif

#define MATCH_INSTALLER(symbol) \
    if (length == sizeof(#symbol) - 1 && memcmp(name, #symbol, length) == 0) return symbol

MalHostInstaller mal_host_resolve_installer(const char *name, usize length) {
    MATCH_INSTALLER(mal_host_install_maligator);
#if MAL_NODE
    MATCH_INSTALLER(mal_host_install_process);
    MATCH_INSTALLER(mal_host_install_node_assert);
    MATCH_INSTALLER(mal_host_install_node_assert_strict);
    MATCH_INSTALLER(mal_host_install_node_async_hooks);
    MATCH_INSTALLER(mal_host_install_node_buffer);
    MATCH_INSTALLER(mal_host_install_node_child_process);
    MATCH_INSTALLER(mal_host_install_node_cluster);
    MATCH_INSTALLER(mal_host_install_node_crypto);
    MATCH_INSTALLER(mal_host_install_node_diagnostics_channel);
    MATCH_INSTALLER(mal_host_install_node_dns);
    MATCH_INSTALLER(mal_host_install_node_domain);
    MATCH_INSTALLER(mal_host_install_node_events);
    MATCH_INSTALLER(mal_host_install_node_fs);
    MATCH_INSTALLER(mal_host_install_node_fs_promises);
    MATCH_INSTALLER(mal_host_install_node_http);
    MATCH_INSTALLER(mal_host_install_node_https);
    MATCH_INSTALLER(mal_host_install_node_http2);
    MATCH_INSTALLER(mal_host_install_node_inspector);
    MATCH_INSTALLER(mal_host_install_node_module);
    MATCH_INSTALLER(mal_host_install_node_net);
    MATCH_INSTALLER(mal_host_install_node_os);
    MATCH_INSTALLER(mal_host_install_node_path);
    MATCH_INSTALLER(mal_host_install_node_perf_hooks);
    MATCH_INSTALLER(mal_host_install_node_querystring);
    MATCH_INSTALLER(mal_host_install_node_readline);
    MATCH_INSTALLER(mal_host_install_node_sqlite);
    MATCH_INSTALLER(mal_host_install_node_stream);
    MATCH_INSTALLER(mal_host_install_node_string_decoder);
    MATCH_INSTALLER(mal_host_install_node_tls);
    MATCH_INSTALLER(mal_host_install_node_timers_promises);
    MATCH_INSTALLER(mal_host_install_node_tty);
    MATCH_INSTALLER(mal_host_install_node_url);
    MATCH_INSTALLER(mal_host_install_node_util);
    MATCH_INSTALLER(mal_host_install_node_v8);
    MATCH_INSTALLER(mal_host_install_node_vm);
    MATCH_INSTALLER(mal_host_install_node_worker_threads);
    MATCH_INSTALLER(mal_host_install_node_zlib);
#endif
    return nullptr;
}
