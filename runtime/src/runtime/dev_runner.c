#include "dev_runner.h"

#include "compiler_native.h"
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
#include "node_immediate.h"
#include "web_host_timer.h"
#include "web_readable_stream_object.h"
#include "web_url_object.h"
#include "web_globals.h"
#include "personality.h"
#include "workers.h"
#include "worker_manifest.h"

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

static MalLoadedRuntimeImage *load_runtime_image(const MalDevelopmentImage *image) {
    const char *error = "ok";
    MalLoadedRuntimeImage *loaded = mal_runtime_image_load_with_host_resolver(
        image->bytes, image->length, &error, mal_host_resolve_installer);
    if (loaded == nullptr) {
        fprintf(stderr, "could not load development image %s: %s\n", image->label, error);
    }
    return loaded;
}

static bool attach_overlay(
    MalVm *vm,
    const MalDevelopmentImage *image,
    const MalRuntimeImage *program,
    const MalNativeProgramRelocation *relocation) {
    if (image->overlay == nullptr) return true;
    if (mal_native_overlay_attach_fragment(vm, image->overlay, program->function_count, relocation)) {
        return true;
    }
    fprintf(stderr, "native code does not match development image %s\n", image->label);
    return false;
}

int mal_dev_run_wires(
    const char *const *wire_paths,
    int wire_count,
    const char *asset_manifest_path,
    const char *entry_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node,
    const char *worker_manifest_path) {
    if (wire_count < 1) return 2;
    MalDevelopmentImage *images = calloc((usize) wire_count, sizeof(MalDevelopmentImage));
    if (images == nullptr) return 2;
    int code = 2;
    for (int index = 0; index < wire_count; index++) {
        u8 *bytes = read_file(wire_paths[index], &images[index].length);
        if (bytes == nullptr) goto done;
        images[index].bytes = bytes;
        images[index].label = wire_paths[index];
    }
    code = mal_dev_run_images(images, wire_count, asset_manifest_path, entry_path, argc, argv,
        web_platform, node, worker_manifest_path);
done:
    for (int index = 0; index < wire_count; index++) free((u8 *) images[index].bytes);
    free(images);
    return code;
}

int mal_dev_run_images(
    const MalDevelopmentImage *images,
    int wire_count,
    const char *asset_manifest_path,
    const char *entry_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node,
    const char *worker_manifest_path) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    if (wire_count < 1) return 2;
    MalLoadedRuntimeImage *loaded = load_runtime_image(&images[0]);
    if (loaded == nullptr) {
        return 2;
    }
    MalDevelopmentAssets *development_assets = nullptr;
    MalRuntimeImage root_program = *mal_loaded_runtime_image_get(loaded);
    if (asset_manifest_path != nullptr) {
        const char *asset_error = "unknown error";
        development_assets = mal_development_assets_load(asset_manifest_path, &asset_error);
        if (development_assets == nullptr) {
            fprintf(stderr, "could not load development assets %s: %s\n",
                asset_manifest_path, asset_error);
            mal_loaded_runtime_image_free(loaded);
            return 2;
        }
        root_program.assets = mal_development_assets_get(
            development_assets, &root_program.asset_count);
    }

    MalVm vm;
    mal_vm_init(&vm, &root_program);
    const MalNativeProgramRelocation root_relocation = {0};
    if (!attach_overlay(&vm, &images[0], vm.runtime_image, &root_relocation)) {
        mal_vm_free(&vm);
        mal_development_assets_free(development_assets);
        mal_loaded_runtime_image_free(loaded);
        return 2;
    }
    if (mal_host_attach(&vm) == nullptr) {
        mal_vm_free(&vm);
        mal_development_assets_free(development_assets);
        mal_loaded_runtime_image_free(loaded);
        return 2;
    }
    if (worker_manifest_path != nullptr && !mal_worker_manifest_register(&vm, worker_manifest_path)) {
        mal_host_detach(&vm);
        mal_vm_free(&vm);
        mal_development_assets_free(development_assets);
        mal_loaded_runtime_image_free(loaded);
        return 2;
    }
    mal_runtime_personality_install(&vm, web_platform, node);

    MalHostLaunchContext launch = {
        .argc = argc,
        .argv = argv,
        .script_path = entry_path != nullptr ? entry_path : root_program.entry_path,
    };
    if (development_assets != nullptr) {
        mal_host_install_maligator(&vm, nullptr, 0, &launch);
    }
    mal_perf_stats_reset();
    MalCallable **callables = calloc((usize) wire_count, sizeof(MalCallable *));
    if (callables == nullptr) {
        mal_host_detach(&vm);
        mal_vm_free(&vm);
        mal_development_assets_free(development_assets);
        mal_loaded_runtime_image_free(loaded);
        return 2;
    }
    for (int index = 0; index < wire_count; index++) {
        i32 entry = 0;
		const MalRuntimeImage *program = vm.runtime_image;
        if (index > 0) {
            MalLoadedRuntimeImage *fragment = load_runtime_image(&images[index]);
            if (fragment == nullptr) {
                vm.completion.kind = MAL_COMPLETION_THROW;
                break;
            }
            program = mal_loaded_runtime_image_get(fragment);
            const MalNativeProgramRelocation relocation = {
                .function_base = vm.runtime_image->function_count,
                .global_base = vm.runtime_image->global_count,
                .string_base = vm.runtime_image->string_constant_count,
                .bigint_base = vm.runtime_image->bigint_constant_count,
                .literal_template_base = vm.runtime_image->literal_template_data_count,
            };
            entry = mal_vm_splice_runtime_image(&vm, program);
            if (entry < 0) {
                mal_loaded_runtime_image_free(fragment);
                break;
            }
            mal_vm_retain_loaded_runtime_image(&vm, fragment);
            if (!attach_overlay(&vm, &images[index], program, &relocation)) {
                vm.completion.kind = MAL_COMPLETION_THROW;
                break;
            }
        }
        if (index == 0) mal_vm_run_host_installs(&vm, &launch);
        else mal_vm_run_program_host_installs(&vm, program, &launch);
        if (vm.completion.kind == MAL_COMPLETION_THROW) break;
        callables[index] = mal_vm_create_callable(&vm, entry);
        mal_vm_run(&vm, callables[index]);
        if (vm.completion.kind == MAL_COMPLETION_THROW) break;
    }
    mal_host_run_event_loop(&vm);
    int code = mal_host_finish_process(&vm, vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
    mal_workers_shutdown(&vm);

    if (getenv("MAL_GC_AT_EXIT") != nullptr) mal_gc_collect(&vm);
    for (int index = 0; index < wire_count; index++) {
        if (callables[index] != nullptr) mal_vm_free_callable(callables[index]);
    }
#if MAL_NODE
    if (node) mal_node_immediates_free(&vm);
#endif
#if MAL_WEB_PLATFORM || MAL_NODE
    if (web_platform || node) mal_host_timers_free(&vm);
#endif
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    free(callables);
    mal_development_assets_free(development_assets);
    mal_loaded_runtime_image_free(loaded);
    return code;
}
