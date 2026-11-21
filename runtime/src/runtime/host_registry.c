#include "host_registry.h"

#include <string.h>

#include "../ffi/mal_ffi.h"
#include "mal_bridge.h"
#include "mal_application.h"
#include "maligator_assets.h"
#include "maligator_fs.h"
#include "maligator_http.h"
#include "mal_process.h"
#include "regexp_engine.h"
#include "unicode.h"
#include "web_surface.h"
#include "workers.h"

#if MAL_NODE
#include "node_assert_strict.h"
#include "node_async_hooks.h"
#include "node_buffer.h"
#include "node_child_process.h"
#include "node_cluster.h"
#include "node_console.h"
#include "node_crypto.h"
#include "node_diagnostics_channel.h"
#include "node_dns.h"
#include "node_domain.h"
#include "node_events.h"
#include "node_fs.h"
#include "node_legacy.h"
#include "node_http.h"
#include "node_https.h"
#include "node_http2.h"
#include "node_inspector.h"
#include "node_module.h"
#include "node_module_api.h"
#include "node_dgram.h"
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
#include "web_events_message.h"
#include "web_transform_stream.h"
#endif

// A program that links C libraries defines the real resolver in its generated registry unit.
__attribute__((weak)) MalFfiInstaller mal_ffi_resolve_installer(const char *name, size_t length) {
    (void) name;
    (void) length;
    return nullptr;
}

#define MATCH_INSTALLER(symbol) \
    if (length == sizeof(#symbol) - 1 && memcmp(name, #symbol, length) == 0) return symbol

MalHostInstaller mal_host_resolve_installer(const char *name, usize length) {
#if MAL_REGEXP
    MATCH_INSTALLER(mal_host_install_regexp);
#endif
    MATCH_INSTALLER(mal_host_install_unicode_normalization);
    MATCH_INSTALLER(mal_host_install_maligator);
    MATCH_INSTALLER(mal_host_install_maligator_application);
    MATCH_INSTALLER(mal_host_install_maligator_assets);
    MATCH_INSTALLER(mal_host_install_maligator_internal_fs);
#if MAL_WEB_PLATFORM
    // Serving needs the Fetch API objects only the web surface links.
    MATCH_INSTALLER(mal_host_install_maligator_internal_http);
#endif
    MATCH_INSTALLER(mal_host_install_maligator_process);
    MATCH_INSTALLER(mal_host_install_maligator_internal_workers);
    MATCH_INSTALLER(mal_host_install_web_events);
#if MAL_WEB_PLATFORM || MAL_NODE
    MATCH_INSTALLER(mal_host_install_web_encoding);
    MATCH_INSTALLER(mal_host_install_web_streams);
    MATCH_INSTALLER(mal_host_install_web_fetch);
    MATCH_INSTALLER(mal_host_install_web_basics);
#endif
#if MAL_TLS && MAL_ZLIB
    MATCH_INSTALLER(mal_host_install_web_fetch_client);
    MATCH_INSTALLER(mal_host_install_maligator_internal_fetch);
#endif
#if MAL_URL
    MATCH_INSTALLER(mal_host_install_web_url);
#endif
#if MAL_WEB_PLATFORM
    MATCH_INSTALLER(mal_host_install_web_performance);
    MATCH_INSTALLER(mal_host_install_web_crypto);
#endif
#if MAL_NODE
    MATCH_INSTALLER(mal_host_install_web_compression);
    MATCH_INSTALLER(mal_host_install_web_node_events);
    MATCH_INSTALLER(mal_host_install_process);
    MATCH_INSTALLER(mal_host_install_node_assert);
    MATCH_INSTALLER(mal_host_install_node_assert_strict);
    MATCH_INSTALLER(mal_host_install_node_async_hooks);
    MATCH_INSTALLER(mal_host_install_node_buffer);
    MATCH_INSTALLER(mal_host_install_node_child_process);
    MATCH_INSTALLER(mal_host_install_node_cluster);
    MATCH_INSTALLER(mal_host_install_node_console);
    MATCH_INSTALLER(mal_host_install_node_constants);
    MATCH_INSTALLER(mal_host_install_node_crypto);
    MATCH_INSTALLER(mal_host_install_node_diagnostics_channel);
    MATCH_INSTALLER(mal_host_install_node_dns);
    MATCH_INSTALLER(mal_host_install_node_dns_promises);
    MATCH_INSTALLER(mal_host_install_node_domain);
    MATCH_INSTALLER(mal_host_install_node_events);
    MATCH_INSTALLER(mal_host_install_node_fs);
    MATCH_INSTALLER(mal_host_install_node_fs_promises);
    MATCH_INSTALLER(mal_host_install_node_http);
    MATCH_INSTALLER(mal_host_install_node_https);
    MATCH_INSTALLER(mal_host_install_node_http2);
    MATCH_INSTALLER(mal_host_install_node_inspector);
    MATCH_INSTALLER(mal_host_install_node_module);
    MATCH_INSTALLER(mal_host_install_node_builtin_loader);
    MATCH_INSTALLER(mal_host_install_node_installed_builtins);
    MATCH_INSTALLER(mal_host_install_node_dgram);
    MATCH_INSTALLER(mal_host_install_node_net);
    MATCH_INSTALLER(mal_host_install_node_os);
    MATCH_INSTALLER(mal_host_install_node_path);
    MATCH_INSTALLER(mal_host_install_node_path_posix);
    MATCH_INSTALLER(mal_host_install_node_path_win32);
    MATCH_INSTALLER(mal_host_install_node_perf_hooks);
    MATCH_INSTALLER(mal_host_install_node_querystring);
    MATCH_INSTALLER(mal_host_install_node_punycode);
    MATCH_INSTALLER(mal_host_install_node_readline);
    MATCH_INSTALLER(mal_host_install_node_readline_promises);
    MATCH_INSTALLER(mal_host_install_node_sqlite);
    MATCH_INSTALLER(mal_host_install_node_stream);
    MATCH_INSTALLER(mal_host_install_node_stream_promises);
    MATCH_INSTALLER(mal_host_install_node_stream_consumers);
    MATCH_INSTALLER(mal_host_install_node_stream_web);
    MATCH_INSTALLER(mal_host_install_node_string_decoder);
    MATCH_INSTALLER(mal_host_install_node_sys);
    MATCH_INSTALLER(mal_host_install_node_tls);
    MATCH_INSTALLER(mal_host_install_node_timers);
    MATCH_INSTALLER(mal_host_install_node_timers_promises);
    MATCH_INSTALLER(mal_host_install_node_tty);
    MATCH_INSTALLER(mal_host_install_node_url);
    MATCH_INSTALLER(mal_host_install_node_util);
    MATCH_INSTALLER(mal_host_install_node_util_types);
    MATCH_INSTALLER(mal_host_install_node_v8);
    MATCH_INSTALLER(mal_host_install_node_vm);
    MATCH_INSTALLER(mal_host_install_node_worker_threads);
    MATCH_INSTALLER(mal_host_install_node_zlib);
#endif
    return mal_ffi_resolve_installer(name, length);
}
