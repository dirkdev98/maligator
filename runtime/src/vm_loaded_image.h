#pragma once

#include "vm_load.h"

typedef struct MalLoadArenaBlock {
    struct MalLoadArenaBlock *next;
    usize size;
    usize used;
    _Alignas(16) u8 data[];
} MalLoadArenaBlock;

struct MalLoadedRuntimeImage {
    MalLoadArenaBlock *arena;
    MalRuntimeImage runtime_image;
};
