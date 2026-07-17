#pragma once

#include "heap.h"
#include "object.h"
#include "value.h"

/*
 * WinterTC fetch Response (runtime layer). A status code, a Headers object, and an
 * owned body byte buffer (freed by a registered GC finalizer). Traced fields keep
 * the Headers object and lazy Body stream alive; the server reads the bytes in C.
 */
typedef struct MalResponseObject {
    MalObject object;
    i32 status;
    MalValue headers; // a MalHeadersObject, or undefined
    byte *body;       // owned bytes; nullptr => null body
    usize body_len;
    MalValue body_stream; // lazily-created ReadableStream, or undefined
} MalResponseObject;

MalResponseObject *mal_response_object_new(
    MalHeap *heap, MalObject *prototype, i32 status, byte *body, usize body_len);
