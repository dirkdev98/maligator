#pragma once

#include "heap.h"
#include "object.h"
#include "value.h"

/*
 * WinterTC fetch Response (runtime layer). A status code, a Headers object, and an
 * owned UTF-8 body byte buffer (freed by a registered GC finalizer; the headers
 * MalValue is marked by a registered tracer). Non-string body types, statusText,
 * and the prototype accessors are follow-ups; the server reads the fields in C.
 */
typedef struct MalResponseObject {
    MalObject object;
    i32 status;
    MalValue headers; // a MalHeadersObject, or undefined
    byte *body;       // owned UTF-8 bytes; nullptr => empty
    usize body_len;
} MalResponseObject;

MalResponseObject *mal_response_object_new(
    MalHeap *heap, MalObject *prototype, i32 status, byte *body, usize body_len);
