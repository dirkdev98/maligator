#include "dev_runner.h"

#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <program.malw> [program arguments...]\n", argv[0]);
        return 2;
    }

    // Hide the development image from process.argv. The process installer still
    // inserts its stable <compiled> script slot, matching an AOT binary.
    int program_argc = argc - 1;
    char **program_argv = malloc((size_t) program_argc * sizeof(char *));
    if (program_argv == nullptr) {
        return 2;
    }
    program_argv[0] = argv[0];
    for (int i = 1; i < program_argc; i++) {
        program_argv[i] = argv[i + 1];
    }

    int code = mal_dev_run_wire(
        argv[1], program_argc, program_argv, MAL_WEB_PLATFORM != 0, MAL_NODE != 0);
    free(program_argv);
    return code;
}
