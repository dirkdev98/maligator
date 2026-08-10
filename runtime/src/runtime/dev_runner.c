#include "dev_runner.h"

#include "development_assets.h"
#include "vm.h"
#include "perf_stats.h"
#include "vm_load.h"

#include <stdio.h>
#include <stdlib.h>

#include "web_events_object.h"
#include "web_fetch.h"
#include "host.h"
#include "host_registry.h"
#include "mal_assets.h"
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

int mal_dev_run_wires(
    const char *const *wire_paths,
    int wire_count,
    const char *asset_manifest_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    if (wire_count < 1) return 2;
    MalLoadedDefinition *loaded = load_definition(wire_paths[0]);
    if (loaded == nullptr) {
        return 2;
    }
    MalDevelopmentAssets *development_assets = nullptr;
    MalVmDefinition root_definition = *mal_loaded_definition_get(loaded);
    if (asset_manifest_path != nullptr) {
        const char *asset_error = "unknown error";
        development_assets = mal_development_assets_load(asset_manifest_path, &asset_error);
        if (development_assets == nullptr) {
            fprintf(stderr, "could not load development assets %s: %s\n",
                asset_manifest_path, asset_error);
            mal_vm_loaded_definition_free(loaded);
            return 2;
        }
        root_definition.assets = mal_development_assets_get(
            development_assets, &root_definition.asset_count);
    }

    MalVm vm;
    mal_vm_init(&vm, &root_definition);
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
        mal_events_install(&vm, global_this);
        mal_web_globals_install(&vm, global_this);
        mal_url_install(&vm, global_this);
        mal_readable_stream_install(&vm, global_this);
    }
#else
    (void) web_platform;
#endif

    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    if (development_assets != nullptr) {
        mal_host_install_maligator(&vm, nullptr, 0, &launch);
    }
    mal_perf_stats_reset();
    MalCallable **callables = calloc((usize) wire_count, sizeof(MalCallable *));
    if (callables == nullptr) {
        mal_development_assets_free(development_assets);
        mal_vm_loaded_definition_free(loaded);
        return 2;
    }
    for (int index = 0; index < wire_count; index++) {
        i32 entry = 0;
        const MalVmDefinition *definition = vm.definition;
        if (index > 0) {
            MalLoadedDefinition *fragment = load_definition(wire_paths[index]);
            if (fragment == nullptr) {
                vm.completion.kind = MAL_COMPLETION_THROW;
                break;
            }
            definition = mal_loaded_definition_get(fragment);
            entry = mal_vm_splice_definition(&vm, definition);
            if (entry < 0) {
                mal_vm_loaded_definition_free(fragment);
                break;
            }
            mal_vm_retain_loaded_definition(&vm, fragment);
        }
        if (index == 0) mal_vm_run_host_installs(&vm, &launch);
        else mal_vm_run_definition_host_installs(&vm, definition, &launch);
        if (vm.completion.kind == MAL_COMPLETION_THROW) break;
        callables[index] = mal_vm_create_callable(&vm, entry);
        mal_vm_run(&vm, callables[index]);
        if (vm.completion.kind == MAL_COMPLETION_THROW) break;
    }
    mal_host_run_event_loop(&vm);
    int code = vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0;

    if (getenv("MAL_GC_AT_EXIT") != nullptr) {
        mal_gc_collect(&vm);
        for (int index = 0; index < wire_count; index++) {
            if (callables[index] != nullptr) mal_vm_free_callable(callables[index]);
        }
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
    free(callables);
    mal_development_assets_free(development_assets);
    mal_vm_loaded_definition_free(loaded);
    return code;
}
