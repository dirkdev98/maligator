#include "development_assets.h"

#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct AssetReader {
    const u8 *cursor;
    const u8 *end;
    bool failed;
} AssetReader;

struct MalDevelopmentAssets {
    i32 count;
    MalAsset *assets;
};

static u8 asset_u8(AssetReader *reader) {
    if (reader->cursor == reader->end) {
        reader->failed = true;
        return 0;
    }
    return *reader->cursor++;
}

static u32 asset_u32(AssetReader *reader) {
    u32 value = 0;
    for (int offset = 0; offset < 32; offset += 8) {
        value |= (u32) asset_u8(reader) << offset;
    }
    return value;
}

static usize asset_usize(AssetReader *reader) {
    u64 low = asset_u32(reader);
    u64 high = asset_u32(reader);
    u64 value = low | (high << 32);
    if (value > SIZE_MAX) {
        reader->failed = true;
        return 0;
    }
    return (usize) value;
}

static char *asset_string(AssetReader *reader) {
    u32 length = asset_u32(reader);
    if (reader->failed || (usize) (reader->end - reader->cursor) < (usize) length) {
        reader->failed = true;
        return nullptr;
    }
    char *value = malloc((usize) length + 1);
    if (value == nullptr) {
        reader->failed = true;
        return nullptr;
    }
    memcpy(value, reader->cursor, length);
    value[length] = '\0';
    if (memchr(value, '\0', length) != nullptr) {
        free(value);
        reader->failed = true;
        return nullptr;
    }
    reader->cursor += length;
    return value;
}

static u8 *asset_read_file(const char *path, usize *out_length) {
    FILE *file = fopen(path, "rb");
    if (file == nullptr || fseek(file, 0, SEEK_END) != 0) {
        if (file != nullptr) fclose(file);
        return nullptr;
    }
    long length = ftell(file);
    if (length < 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return nullptr;
    }
    u8 *bytes = malloc((usize) length);
    if (bytes == nullptr || fread(bytes, 1, (usize) length, file) != (usize) length) {
        free(bytes);
        fclose(file);
        return nullptr;
    }
    fclose(file);
    *out_length = (usize) length;
    return bytes;
}

void mal_development_assets_free(MalDevelopmentAssets *assets) {
    if (assets == nullptr) return;
    for (i32 asset_index = 0; asset_index < assets->count; asset_index++) {
        MalAsset *asset = &assets->assets[asset_index];
        free((void *) asset->name);
        free((void *) asset->hash);
        free((void *) asset->version);
        for (i32 file_index = 0; file_index < asset->file_count; file_index++) {
            const MalAssetFile *file = &asset->files[file_index];
            free((void *) file->path);
            free((void *) file->source_path);
        }
        free((void *) asset->files);
    }
    free(assets->assets);
    free(assets);
}

MalDevelopmentAssets *mal_development_assets_load(const char *path, const char **out_error) {
    usize length = 0;
    u8 *bytes = asset_read_file(path, &length);
    if (bytes == nullptr) {
        if (out_error != nullptr) *out_error = "could not read manifest";
        return nullptr;
    }
    AssetReader reader = {.cursor = bytes, .end = bytes + length};
    if (length < 12 || memcmp(reader.cursor, "MALA", 4) != 0) {
        if (out_error != nullptr) *out_error = "invalid manifest header";
        free(bytes);
        return nullptr;
    }
    reader.cursor += 4;
    u32 version = asset_u32(&reader);
    u32 count = asset_u32(&reader);
    if (version != 1 || count > INT32_MAX) reader.failed = true;

    MalDevelopmentAssets *result = calloc(1, sizeof(MalDevelopmentAssets));
    if (result == nullptr) reader.failed = true;
    if (!reader.failed) {
        result->count = (i32) count;
        result->assets = calloc(count, sizeof(MalAsset));
        if (count != 0 && result->assets == nullptr) reader.failed = true;
    }
    for (u32 asset_index = 0; !reader.failed && asset_index < count; asset_index++) {
        MalAsset *asset = &result->assets[asset_index];
        asset->name = asset_string(&reader);
        asset->hash = asset_string(&reader);
        asset->version = asset_string(&reader);
        u8 directory = asset_u8(&reader);
        u32 file_count = asset_u32(&reader);
        if (directory > 1 || file_count > INT32_MAX) reader.failed = true;
        asset->directory = directory != 0;
        asset->file_count = (i32) file_count;
        MalAssetFile *files = calloc(file_count, sizeof(MalAssetFile));
        asset->files = files;
        if (file_count != 0 && files == nullptr) reader.failed = true;
        for (u32 file_index = 0; !reader.failed && file_index < file_count; file_index++) {
            files[file_index].path = asset_string(&reader);
            files[file_index].source_path = asset_string(&reader);
            files[file_index].length = asset_usize(&reader);
            files[file_index].data = nullptr;
        }
    }
    if (reader.cursor != reader.end) reader.failed = true;
    free(bytes);
    if (reader.failed) {
        if (out_error != nullptr) *out_error = "malformed manifest";
        mal_development_assets_free(result);
        return nullptr;
    }
    return result;
}

const MalAsset *mal_development_assets_get(
    const MalDevelopmentAssets *assets, i32 *out_count) {
    *out_count = assets->count;
    return assets->assets;
}
