#pragma once

#include "defaults.h"

/** Load and execute ordered development wire images in a fresh host VM. */
int mal_dev_run_wires(
    const char *const *wire_paths,
    int wire_count,
    const char *asset_manifest_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node);
