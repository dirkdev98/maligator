#pragma once

#include "mal_zlib.h"
#include "object.h"

typedef struct MalNodeZlibObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalZlibStream *handle;
    MalValue input;
    MalValue callback;
    usize chunk_size;
    usize input_offset;
    bool finishing;
    bool pumping;
} MalNodeZlibObject;
