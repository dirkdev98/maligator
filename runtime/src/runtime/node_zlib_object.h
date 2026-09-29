#pragma once

#include "mal_zlib.h"
#include "object.h"

typedef struct MalNodeZlibObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalZlibStream *handle;
} MalNodeZlibObject;
