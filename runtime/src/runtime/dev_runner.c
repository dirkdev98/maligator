#include "dev_runner.h"

#include "vm.h"
#include "perf_stats.h"
#include "vm_load.h"

#include <stdio.h>
#include <stdlib.h>

#include "web_events_object.h"
#include "web_fetch.h"
#include "host.h"
#include "host_registry.h"
#include "node_crypto.h"
#include "node_immediate.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"
#include "web_globals.h"

static u8 *read_file(const char *path, usize *length_out) {
    FILE *file = fopen(path, "rb");
    if (file == nullptr) {
        perror("fopen");
        return nullptr;
    }
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return nullptr;
    }
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return nullptr;
    }
    u8 *buffer = malloc((size_t) length);
    if (buffer == nullptr || fread(buffer, 1, (size_t) length, file) != (size_t) length) {
        fclose(file);
        free(buffer);
        return nullptr;
    }
    fclose(file);
    *length_out = (usize) length;
    return buffer;
}

static MalLoadedDefinition *load_definition(const char *path) {
    usize length = 0;
    u8 *buffer = read_file(path, &length);
    if (buffer == nullptr) {
        return nullptr;
    }
    const char *error = "ok";
    MalLoadedDefinition *loaded = mal_vm_load_definition_with_host_resolver(
        buffer, length, &error, mal_host_resolve_installer);
    free(buffer);
    if (loaded == nullptr) {
        fprintf(stderr, "could not load development image %s: %s\n", path, error);
    }
    return loaded;
}

int mal_dev_run_wire(
    const char *wire_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    MalLoadedDefinition *loaded = load_definition(wire_path);
    if (loaded == nullptr) {
        return 2;
    }

    MalVm vm;
    mal_vm_init(&vm, mal_loaded_definition_get(loaded));
    mal_host_attach(&vm);
#if MAL_WEB_PLATFORM || MAL_NODE
    MalObject *global_this = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    if (web_platform || node) {
        mal_host_timers_install(&vm, global_this);
    }
#endif
#if MAL_NODE
    if (node) {
        mal_node_immediates_install(&vm, global_this);
    }
#else
    (void) node;
#endif
#if MAL_WEB_PLATFORM
    if (web_platform) {
        mal_fetch_install(&vm, global_this);
        mal_web_globals_install(&vm, global_this);
        mal_url_install(&vm, global_this);
        mal_events_install(&vm, global_this);
        mal_readable_stream_install(&vm, global_this);
    }
#else
    (void) web_platform;
#endif

    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);

    MalCallable *callable = mal_vm_create_callable(&vm, 0);
    mal_perf_stats_reset();
    mal_vm_run(&vm, callable);
    mal_host_run_event_loop(&vm);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        mal_vm_free_callable(callable);
#if MAL_NODE
        if (node) {
            mal_node_immediates_free(&vm);
            mal_node_crypto_free(&vm);
        }
#endif
#if MAL_WEB_PLATFORM || MAL_NODE
        if (web_platform || node) {
            mal_host_timers_free(&vm);
        }
#endif
        mal_host_detach(&vm);
        mal_vm_free(&vm);
    }
    mal_vm_loaded_definition_free(loaded);
    return code;
}
