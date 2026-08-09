#include "dev_runner.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char development_wires_command[] = "--maligator-internal-run-wires";
static const char development_wires_assets_command[] = "--maligator-internal-run-wires-assets";

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program.malw> [program arguments...]\n", argv[0]);
        return 2;
    }

    int wire_count = 1;
    int wire_offset = 1;
    const char *asset_manifest_path = nullptr;
    if (strcmp(argv[1], development_wires_command) == 0) {
        if (argc < 4) return 2;
        wire_count = atoi(argv[2]);
        wire_offset = 3;
        if (wire_count < 1 || wire_offset + wire_count > argc) return 2;
    } else if (strcmp(argv[1], development_wires_assets_command) == 0) {
        if (argc < 5) return 2;
        wire_count = atoi(argv[2]);
        asset_manifest_path = argv[3];
        wire_offset = 4;
        if (wire_count < 1 || wire_offset + wire_count > argc) return 2;
    }

    // Hide the development images from process.argv. The process installer still
    // inserts its stable <compiled> script slot, matching an AOT binary.
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
        program_argc, program_argv, MAL_WEB_PLATFORM != 0, MAL_NODE != 0);
    free(program_argv);
    return code;
}
