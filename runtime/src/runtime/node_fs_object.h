#pragma once

#include "object.h"

/** node:fs/promises FileHandle with an internal, GC-owned descriptor. */
typedef struct MalNodeFsFileHandleObject {
    MalObject object;
    MalObjectStorage object_storage;
    int fd;
} MalNodeFsFileHandleObject;
