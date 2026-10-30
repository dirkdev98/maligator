#pragma once

#include "heap.h"
#include "object.h"
#include "value.h"

struct MalFetchHead;

/*
 * WinterTC fetch Request (runtime layer): the internal slots behind the prototype
 * getters, plus an optional owned body buffer that backs the lazy Body stream.
 * A Request served by Mal.serve keeps a copy of its parsed request head in `source`
 * and builds `method`, `url` and `headers` from it on first read, so those slots
 * are only valid through the accessors in web_fetch.c.
 */
typedef struct MalRequestObject {
    MalObject object;
    MalObjectStorage object_storage;
    byte *body; // owned bytes; nullptr => no body
    usize body_len;
    MalValue body_stream; // lazily-created ReadableStream, or undefined
    MalValue method;
    MalValue url;
    MalValue headers;
    MalValue referrer;
    MalValue referrer_policy;
    MalValue mode;
    MalValue credentials;
    MalValue cache;
    MalValue redirect;
    MalValue integrity;
    struct MalFetchHead *source; // raw heap buffer, freed by the finalizer
} MalRequestObject;

MalRequestObject *mal_request_object_new(MalHeap *heap, MalObject *prototype);
