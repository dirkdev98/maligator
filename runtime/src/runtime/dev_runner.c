#include "dev_runner.h"

#include "atomics_async.h"
#include "builtin_error.h"
#include "compiler_native.h"
#include "vm.h"
#include "perf_stats.h"
#include "promise_object.h"
#include "vm_load.h"

#include <stdio.h>
#include <stdlib.h>

#include "web_events_object.h"
#include "web_fetch.h"
#include "host.h"
#include "host_registry.h"
#include "mal_bridge.h"
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

static bool image_entry_settled(MalVm *vm, void *data) {
    (void) data;
    return !mal_value_is_promise_object(vm->entry_async_promise) ||
        mal_value_to_promise_object(vm->entry_async_promise)->state != MAL_PROMISE_PENDING;
}

static MalLoadedRuntimeImage *load_runtime_image(
    const MalDevelopmentImage *images, MalDevelopmentImage *owned_images, int index) {
    const MalDevelopmentImage *image = &images[index];
    const char *error = "ok";
    MalLoadedRuntimeImage *loaded = mal_runtime_image_load_with_host_resolver(
        image->bytes, image->length, &error, mal_host_resolve_installer);
    if (owned_images != nullptr) {
        free((void *) owned_images[index].bytes);
        owned_images[index].bytes = nullptr;
    }
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
    if (mal_native_overlay_attach_fragment(vm, image->overlay, program, relocation)) {
        return true;
    }
    fprintf(stderr, "native code does not match development image %s\n", image->label);
    return false;
}

static int run_images(
    const MalDevelopmentImage *baked_images,
    MalDevelopmentImage *owned_images,
    int wire_count,
    const MalAsset *assets,
    i32 asset_count,
    const char *entry_path,
    int argc,
    char **argv,
    const char *worker_manifest_path) {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    if (wire_count < 1) return 2;
    const MalDevelopmentImage *images = owned_images != nullptr ? owned_images : baked_images;
    MalLoadedRuntimeImage **loaded_images = calloc((usize) wire_count, sizeof(*loaded_images));
    if (loaded_images == nullptr) return 2;
    int code = 2;
    MalHostInstaller personality = nullptr;
    bool node_error_hooks = false;
    MalHostInstall *root_installs = nullptr;
    for (int index = 0; index < wire_count; index++) {
        loaded_images[index] = load_runtime_image(images, owned_images, index);
        if (loaded_images[index] == nullptr) goto free_images;
        const MalRuntimeImage *program = mal_loaded_runtime_image_get(loaded_images[index]);
        personality = mal_runtime_image_personality(program, personality);
        node_error_hooks = node_error_hooks || mal_runtime_image_selects_node_error_hooks(program);
    }
    MalRuntimeImage root_program = *mal_loaded_runtime_image_get(loaded_images[0]);
    if (root_program.module_import_count > 0) {
        fprintf(stderr, "development image %s imports from no earlier image\n", images[0].label);
        goto free_images;
    }
    if (assets != nullptr) {
        root_program.assets = assets;
        root_program.asset_count = asset_count;
    }
    if (node_error_hooks &&
        !mal_runtime_image_include_node_error_hooks(&root_program, &root_installs)) {
        fprintf(stderr, "could not prepare development image host installs\n");
        goto free_images;
    }

    MalVm vm;
    mal_vm_init(&vm, &root_program);
    const MalNativeProgramRelocation root_relocation = {0};
    if (!attach_overlay(&vm, &images[0], vm.runtime_image, &root_relocation)) {
        mal_vm_free(&vm);
        goto free_images;
    }
    if (mal_host_attach(&vm) == nullptr) {
        mal_vm_free(&vm);
        goto free_images;
    }
    if (worker_manifest_path != nullptr && !mal_worker_manifest_register(&vm, worker_manifest_path)) {
        mal_host_detach(&vm);
        mal_vm_free(&vm);
        goto free_images;
    }
    mal_atomics_async_install(&vm, false);

    MalHostLaunchContext launch = {
        .argc = argc,
        .argv = argv,
        .script_path = entry_path != nullptr ? entry_path : root_program.entry_path,
    };
    if (personality != nullptr) personality(&vm, nullptr, 0, &launch);
#if MAL_DEVELOPMENT_API
    // Tool hosts reach their application bridge through the internal `mal` global.
    mal_host_install_maligator(&vm, nullptr, 0, &launch);
#endif
    mal_perf_stats_reset();
    MalCallable **callables = calloc((usize) wire_count, sizeof(MalCallable *));
    if (callables == nullptr) {
        mal_host_detach(&vm);
        mal_vm_free(&vm);
        goto free_images;
    }
    for (int index = 0; index < wire_count; index++) {
        i32 entry = 0;
        const MalRuntimeImage *program = vm.runtime_image;
        if (index > 0) {
            program = mal_loaded_runtime_image_get(loaded_images[index]);
            const MalNativeProgramRelocation relocation = {
                .function_base = vm.runtime_image->function_count,
                .global_base = vm.runtime_image->global_count,
                .string_base = vm.runtime_image->string_constant_count,
                .bigint_base = vm.runtime_image->bigint_constant_count,
                .literal_template_base = vm.runtime_image->literal_template_data_count,
            };
            entry = mal_vm_splice_runtime_image(&vm, program);
            if (entry < 0) {
                mal_vm_report_uncaught(&vm);
                break;
            }
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
        if (index + 1 < wire_count) {
            // Later images may import what this one's top-level await initializes,
            // so they evaluate once it settles, in the application host's order.
            mal_host_run_event_loop_until(&vm, image_entry_settled, nullptr);
            if (!mal_vm_check_entry_evaluation(&vm)) break;
            vm.entry_async_promise = mal_value_new_undefined();
        }
    }
    mal_host_run_event_loop(&vm);
    code = mal_host_finish_process(&vm, vm.completion.kind == MAL_COMPLETION_THROW ? 1 : 0);
    mal_workers_shutdown(&vm);

    if (getenv("MAL_GC_AT_EXIT") != nullptr) mal_gc_collect(&vm);
    for (int index = 0; index < wire_count; index++) {
        if (callables[index] != nullptr) mal_vm_free_callable(callables[index]);
    }
    mal_host_timers_free(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    free(callables);
free_images:
    free(root_installs);
    for (int index = 0; index < wire_count; index++) {
        if (loaded_images[index] != nullptr) mal_loaded_runtime_image_free(loaded_images[index]);
    }
    free(loaded_images);
    return code;
}

int mal_dev_run_wires(
    const char *const *wire_paths,
    int wire_count,
    const char *entry_path,
    int argc,
    char **argv,
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
    code = run_images(nullptr, images, wire_count, nullptr, 0, entry_path, argc, argv,
        worker_manifest_path);
done:
    for (int index = 0; index < wire_count; index++) free((void *) images[index].bytes);
    free(images);
    return code;
}

int mal_dev_run_images(
    const MalDevelopmentImage *images,
    int wire_count,
    const MalAsset *assets,
    i32 asset_count,
    const char *entry_path,
    int argc,
    char **argv,
    const char *worker_manifest_path) {
    return run_images(images, nullptr, wire_count, assets, asset_count, entry_path, argc, argv,
        worker_manifest_path);
}
