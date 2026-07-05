#pragma once

#include "heap.h"
#include "object.h"

/*
 * WinterTC fetch Request (runtime layer). `method` and `url` are set as own data
 * properties at construction (so a handler reads request.method / request.url
 * directly); an optional owned body buffer backs later .text()/.json() accessors.
 */
typedef struct MalRequestObject {
    MalObject object;
    byte *body; // owned bytes; nullptr => no body
    usize body_len;
} MalRequestObject;

MalRequestObject *mal_request_object_new(MalHeap *heap, MalObject *prototype);
