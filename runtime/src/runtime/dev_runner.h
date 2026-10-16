#pragma once

#include "defaults.h"

typedef struct MalNativeOverlay MalNativeOverlay;

/** One serialized image of a development program, in evaluation order. */
typedef struct MalDevelopmentImage {
    const u8 *bytes;
    usize length;
    /** Names the image in load errors. */
    const char *label;
    /** Native code for the image's functions, or nullptr to interpret it. */
    const MalNativeOverlay *overlay;
} MalDevelopmentImage;

/** Load and execute ordered development images in a fresh host VM. */
int mal_dev_run_images(
    const MalDevelopmentImage *images,
    int image_count,
    const char *asset_manifest_path,
    const char *entry_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node,
    const char *worker_manifest_path);

/** Load and execute ordered development wire images in a fresh host VM. */
int mal_dev_run_wires(
    const char *const *wire_paths,
    int wire_count,
    const char *asset_manifest_path,
    const char *entry_path,
    int argc,
    char **argv,
    bool web_platform,
    bool node,
    const char *worker_manifest_path);
