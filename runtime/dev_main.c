#include "dev_runner.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char development_wires_command[] = "--maligator-internal-run-wires";
static const char development_wires_assets_command[] = "--maligator-internal-run-wires-assets";

int main(int argc, char **argv) {
    const char *worker_manifest_path = nullptr;
    if (argc >= 3 && strcmp(argv[1], "--maligator-internal-workers") == 0) {
        worker_manifest_path = argv[2];
        argv[2] = argv[0];
        argv += 2;
        argc -= 2;
    }
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program.malw> [program arguments...]\n", argv[0]);
        return 2;
    }

    if (strcmp(argv[1], "-e") == 0 || strcmp(argv[1], "--eval") == 0) {
        if (argc < 3) {
            fprintf(stderr, "%s requires a script argument\n", argv[1]);
            return 2;
        }
        int argument_offset = argc > 3 && strcmp(argv[3], "--") == 0 ? 4 : 3;
        if (argument_offset == 3 && argc > 3 && argv[3][0] == '-' && argv[3][1] != '\0') {
            fprintf(stderr, "unsupported development runtime option: %s\n", argv[3]);
            return 2;
        }
        int program_argc = argc - argument_offset + 1;
        char **program_argv = malloc((size_t) program_argc * sizeof(char *));
        if (program_argv == nullptr) return 2;
        program_argv[0] = argv[0];
        for (int i = 1; i < program_argc; i++)
            program_argv[i] = argv[argument_offset + i - 1];
        int code = mal_dev_run_eval(argv[2], argv[1], program_argc, program_argv,
            MAL_WEB_PLATFORM != 0, MAL_NODE != 0, worker_manifest_path);
        free(program_argv);
        return code;
    }
    if (argv[1][0] == '-' && strcmp(argv[1], development_wires_command) != 0 &&
        strcmp(argv[1], development_wires_assets_command) != 0) {
        fprintf(stderr, "unsupported development runtime option: %s\n", argv[1]);
        return 2;
    }

    int wire_count = 1;
    int wire_offset = 1;
    int entry_offset = 0;
    const char *asset_manifest_path = nullptr;
    if (strcmp(argv[1], development_wires_command) == 0) {
        if (argc < 4) return 2;
        wire_count = atoi(argv[2]);
        entry_offset = 3;
        wire_offset = 4;
        if (wire_count < 1 || wire_offset + wire_count > argc) return 2;
    } else if (strcmp(argv[1], development_wires_assets_command) == 0) {
        if (argc < 5) return 2;
        wire_count = atoi(argv[2]);
        asset_manifest_path = argv[3];
        entry_offset = 4;
        wire_offset = 5;
        if (wire_count < 1 || wire_offset + wire_count > argc) return 2;
    }

    // Hide the development images from process.argv. The loaded definition supplies
    // its retained source entry for the script slot.
    int program_argc = argc - wire_offset - wire_count + 1;
    char **program_argv = malloc((size_t) program_argc * sizeof(char *));
    if (program_argv == nullptr) {
        return 2;
    }
    program_argv[0] = argv[0];
    for (int i = 1; i < program_argc; i++) {
        program_argv[i] = argv[wire_offset + wire_count + i - 1];
    }

    int code = mal_dev_run_wires(
        (const char *const *) &argv[wire_offset], wire_count,
        asset_manifest_path,
        entry_offset > 0 ? argv[entry_offset] : nullptr,
        program_argc, program_argv, MAL_WEB_PLATFORM != 0, MAL_NODE != 0, worker_manifest_path);
    free(program_argv);
    return code;
}
