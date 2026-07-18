#pragma once

#include "mal_zlib.h"
#include "object.h"

typedef struct MalNodeZlibObject {
    MalObject object;
    MalZlibStream *handle;
} MalNodeZlibObject;
