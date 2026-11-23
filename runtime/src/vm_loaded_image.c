#include "vm_loaded_image.h"

#include <stdlib.h>

const MalRuntimeImage *mal_loaded_runtime_image_get(const MalLoadedRuntimeImage *loaded) {
    return &loaded->runtime_image;
}

void mal_loaded_runtime_image_free(MalLoadedRuntimeImage *loaded) {
    if (loaded == nullptr) {
        return;
    }
    MalLoadArenaBlock *block = loaded->arena;
    while (block != nullptr) {
        MalLoadArenaBlock *next = block->next;
        free(block);
        block = next;
    }
    free(loaded);
}
