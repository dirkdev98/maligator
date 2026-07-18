#pragma once

#include "heap.h"
#include "object.h"
#include "value.h"

/*
 * WinterTC fetch Response (runtime layer). A status code/reason, a Headers object,
 * and an owned body byte buffer (freed by a registered GC finalizer). Traced fields
 * keep statusText, Headers, and the lazy Body stream alive; the server reads bytes
 * in C.
 */
typedef struct MalResponseObject {
    MalObject object;
    i32 status;
    MalValue status_text;
    MalValue headers; // a MalHeadersObject, or undefined
    byte *body;       // owned bytes; nullptr => null body
    usize body_len;
    MalValue body_stream; // lazily-created ReadableStream, or undefined
} MalResponseObject;

MalResponseObject *mal_response_object_new(
    MalHeap *heap, MalObject *prototype, i32 status, byte *body, usize body_len);
