#pragma once

#include "mal_zlib.h"
#include "object.h"

typedef struct MalNodeZlibObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalZlibStream *handle;
    MalValue input;
    MalValue callback;
    /* The empty Buffer that flush() and params() write; its identity selects marker_flush. */
    MalValue marker;
    usize chunk_size;
    usize input_offset;
    double bytes_written;
    u32 format;
    i32 flush;
    i32 finish_flush;
    i32 chunk_flush;
    i32 marker_flush;
    i32 pending_level;
    bool encode;
    bool has_pending_level;
    bool finishing;
    bool pumping;
} MalNodeZlibObject;
