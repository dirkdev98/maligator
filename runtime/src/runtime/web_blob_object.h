#pragma once

#include "heap.h"
#include "object.h"

/* WHATWG Blob: immutable owned bytes plus a normalized ASCII MIME type. */
typedef struct MalBlobObject {
    MalObject object;
    MalObjectStorage object_storage;
    byte *bytes;
    usize length;
    char *type;
    usize type_length;
} MalBlobObject;
