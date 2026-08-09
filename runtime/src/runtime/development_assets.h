#pragma once

#include "vm.h"

typedef struct MalDevelopmentAssets MalDevelopmentAssets;

/** Load the compact external-asset manifest emitted by the development CLI. */
MalDevelopmentAssets *mal_development_assets_load(const char *path, const char **out_error);

const MalAsset *mal_development_assets_get(
    const MalDevelopmentAssets *assets, i32 *out_count);

void mal_development_assets_free(MalDevelopmentAssets *assets);
