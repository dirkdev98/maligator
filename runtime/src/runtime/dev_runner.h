#pragma once

#include "defaults.h"

/** Load and execute one development wire image in a fresh host VM. */
int mal_dev_run_wire(
    const char *wire_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node);
