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

// Stable development entry point. The compiler writes a relocatable VM image and
// this process loads it directly, avoiding generated-C compilation and relinking
// after every source edit while retaining the normal host/event-loop contract.

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

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program.malw> [program arguments...]\n", argv[0]);
        return 2;
    }

    setvbuf(stdout, nullptr, _IOLBF, 0);
    MalLoadedDefinition *loaded = load_definition(argv[1]);
    if (loaded == nullptr) {
        return 2;
    }

    // Hide the development image from process.argv. The process installer still
    // inserts its stable <compiled> script slot, so users observe the same argv
    // layout as an AOT binary.
    int program_argc = argc - 1;
    char **program_argv = malloc((size_t) program_argc * sizeof(char *));
    if (program_argv == nullptr) {
        mal_vm_loaded_definition_free(loaded);
        return 2;
    }
    program_argv[0] = argv[0];
    for (int i = 1; i < program_argc; i++) {
        program_argv[i] = argv[i + 1];
    }

    MalVm vm;
    mal_vm_init(&vm, mal_loaded_definition_get(loaded));
    mal_host_attach(&vm);
#if MAL_WEB_PLATFORM || MAL_NODE
    MalObject *global_this = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install(&vm, global_this);
#endif
#if MAL_NODE
    mal_node_immediates_install(&vm, global_this);
#endif
#if MAL_WEB_PLATFORM
    mal_fetch_install(&vm, global_this);
    mal_web_globals_install(&vm, global_this);
    mal_url_install(&vm, global_this);
    mal_events_install(&vm, global_this);
    mal_readable_stream_install(&vm, global_this);
#endif

    MalHostLaunchContext launch = {.argc = program_argc, .argv = program_argv};
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
        mal_node_immediates_free(&vm);
        mal_node_crypto_free(&vm);
#endif
        mal_host_timers_free(&vm);
        mal_host_detach(&vm);
        mal_vm_free(&vm);
    }
    free(program_argv);
    mal_vm_loaded_definition_free(loaded);
    return code;
}
