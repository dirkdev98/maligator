#include "node_module.h"

#if MAL_NODE

#include <string.h>
#include "gc.h"
#include "vm_ops.h"

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
#include "node_dgram.h"
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
    const MalRuntimeImage *image = vm->runtime_image;
    for (i32 i = 0; i < image->source_builtin_provider_count; i++) {
        const MalSourceBuiltinProvider provider = image->source_builtin_providers[i];
        if (!mal_string_equals_ascii(name, provider.id)) continue;
        MalValue cached = mal_node_module_get_cached(vm, provider.id);
        if (!mal_value_is_undefined(cached)) return cached;
        for (i32 entry = 0; entry < provider.import_count; entry++) {
            const MalSourceBuiltinImport *import = &provider.imports[entry];
            MalValue dependency = mal_node_module_get_builtin(vm, mal_intrinsic_ascii(vm, (const byte *) import->module_id));
            if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
            if (mal_value_is_undefined(dependency)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "source builtin dependency is unavailable");
                return mal_value_new_undefined();
            }
            MalHostInstallSlot slot = {.name = import->name, .slot = import->slot};
            mal_node_module_publish(vm, import->module_id, &slot, 1, dependency);
        }
        // Function creation stamps the active realm; module state lives in that realm's globals.
        MalValue factory = mal_vm_op_create_function(vm, provider.function_index, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
        MalRootSpan root;
        mal_gc_root(&root, &factory, 1);
        MalCompletion result = mal_vm_call_value(vm, factory, mal_value_new_undefined(), nullptr, 0);
        mal_gc_unroot(&root);
        if (result.kind == MAL_COMPLETION_THROW) {
            vm->completion = result;
            return mal_value_new_undefined();
        }
        mal_node_module_publish(vm, provider.id, nullptr, 0, result.value);
        return result.value;
    }
    return mal_value_new_undefined();
}

void mal_host_install_node_builtin_loader(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) slots;
    (void) count;
    (void) launch;
    vm->node_builtin_loader = mal_node_module_get_builtin;
}

#endif
